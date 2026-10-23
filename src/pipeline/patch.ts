/**
 * Minimal-Patch Regeneration Engine (§5.4)
 * RFC 7386 JSON Merge Patch for single-question updates with diff preview.
 */
import { LLMRequest, Question, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T4_QUESTION_PATCH_SYSTEM } from './prompts';
import { sliceSourceSpans, assembleAndValidateQuestions, SpanReferenceSchema } from './assemble';
import { spanBounds } from './spans';
import { z } from 'zod';
export const QuestionMergePatchSchema = z.object({
  no: z.number().int().min(1).max(300).optional(), label: z.string().max(100).optional(),
  parentId: z.string().max(128).nullable().optional(), sectionId: z.string().max(128).nullable().optional(),
  confidence: z.number().finite().min(0).max(1).optional(), flags: z.array(z.string().max(200)).max(100).nullable().optional(),
  points: z.number().finite().min(0).max(100000).nullable().optional(),
  type: z.enum(['mcq', 'truefalse', 'short', 'long', 'fillblank', 'matching', 'multi', 'numeric', 'diagram', 'essay', 'unknown']).optional(),
  spans: z.array(SpanReferenceSchema).min(1).max(500).optional(),
  options: z.array(z.object({ key: z.string().max(30), spans: z.array(SpanReferenceSchema).max(100) }).strict()).max(30).nullable().optional(),
  rewrites: z.array(z.object({ line: z.number().int().positive(), text: z.string().max(10000) }).strict()).max(100).nullable().optional(),
}).strict();

/**
 * Apply RFC 7386 JSON Merge Patch
 */
export function applyMergePatch(target: any, patch: any): any {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return patch;
  }
  const result = { ...target };
  for (const key of Object.keys(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe merge-patch key');
    const patchVal = patch[key];
    if (patchVal === null) {
      delete result[key];
    } else if (typeof patchVal === 'object' && !Array.isArray(patchVal)) {
      result[key] = applyMergePatch(result[key] || {}, patchVal);
    } else {
      result[key] = patchVal;
    }
  }
  return result;
}

export interface QuestionPatchResult {
  patch: any;
  patchedQuestion: Question;
  diffSummary: string[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}

export async function regenerateQuestionPatch(params: {
  question: Question;
  sourceLines: SourceLine[];
  instruction?: string;
  providerConfig: any;
  maxOutputTokens?: number;
}): Promise<QuestionPatchResult> {
  const { question, sourceLines, instruction, providerConfig, maxOutputTokens } = params;

  // Extract question spans + ±5 context lines around it
  const bounds = spanBounds(question.spans);
  const minLine = bounds ? bounds[0] : Infinity;
  const maxLine = bounds ? bounds[1] : -Infinity;

  const idToIdxMap = new Map<number, number>();
  sourceLines.forEach((l, idx) => {
    const num = parseInt(l.id.replace(/\D/g, ''), 10);
    if (!isNaN(num)) idToIdxMap.set(num, idx);
  });

  let contextSourceSlice = '';
  if (isFinite(minLine) && isFinite(maxLine)) {
    const contextStart = Math.max(0, (idToIdxMap.get(minLine) ?? 0) - 6);
    const contextEnd = Math.min(sourceLines.length, (idToIdxMap.get(maxLine) ?? (sourceLines.length - 1)) + 6);
    contextSourceSlice = sourceLines
      .slice(contextStart, contextEnd)
      .map(l => `${l.id}: ${l.text}`)
      .join('\n');
  } else {
    // Questions with empty spans must send a page-window context (their page's lines), not an end-of-file slice
    const pageLines = sourceLines.filter(l => l.page === 1);
    contextSourceSlice = (pageLines.length > 0 ? pageLines : sourceLines.slice(0, 35))
      .map(l => `${l.id}: ${l.text}`)
      .join('\n');
  }

  const questionSnapshot = {
    id: question.id,
    label: question.label,
    no: question.no,
    type: question.type,
    points: question.points,
    spans: question.spans,
    options: question.options?.map(o => ({ key: o.key, spans: o.spans })),
    rewrites: question.rewrites,
    confidence: question.confidence,
  };

  const promptText = `QUESTION JSON:\n${JSON.stringify(questionSnapshot, null, 2)}\n\nSOURCE CONTEXT:\n${contextSourceSlice}\n\nUSER INSTRUCTION:\n${instruction || 'Review spans, fix any misdetected points, options or math rewrites for this question.'}`;

  const request: LLMRequest = {
    role: 'patch',
    system: T4_QUESTION_PATCH_SYSTEM,
    text: promptText,
    maxOutputTokens: maxOutputTokens ? Math.min(maxOutputTokens, 1024) : 1024,
    label: `Patch Question ${question.label || question.no}`,
    providerConfig,
  };

  const response = await LLMAdapter.execute(request);
  const patch: any = response.json || {};

  const patchedQuestion = applyValidatedQuestionPatch(question, patch, sourceLines);

  // Build readable diff summary
  const diffSummary: string[] = [];
  for (const key of Object.keys(patch)) {
    const oldVal = (question as any)[key];
    const newVal = (patchedQuestion as any)[key];
    diffSummary.push(`${key}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
  }

  return {
    patch,
    patchedQuestion,
    diffSummary,
    usage: response.usage,
  };
}

/** Shared RFC 7386 validator for Step 4 and assistant. Derived text is always assembled locally. */
export function applyValidatedQuestionPatch(question: Question, patch: unknown, sourceLines: SourceLine[], keyLines: number[] = []): Question {
  const parsed = QuestionMergePatchSchema.parse(patch);
  const merged = applyMergePatch(question, parsed);
  const result = assembleAndValidateQuestions([{
    id: merged.id, no: merged.no, label: merged.label, parentId: merged.parentId, sectionId: merged.sectionId,
    spans: merged.spans, points: merged.points, type: merged.type, options: merged.options?.map((o: any) => ({ key: o.key, spans: o.spans })),
    rewrites: merged.rewrites, images: merged.images, confidence: merged.confidence,
    answer: merged.answer?.spans ? { spans: merged.answer.spans } : undefined,
    tables: merged.tables?.map((t: any) => ({ spans: t.spans })),
  }], sourceLines, undefined, { keyTerritoryLineNos: keyLines, gapCompletion: false, semanticErrorsToRepair: false, rewritePolicy: 'open' });
  if (!result.questions[0] || result.failingQuestions.length) throw new Error(`Question patch refused: ${result.failingQuestions.flatMap(f => f.errors).join('; ') || 'invalid question'}`);
  return { ...result.questions[0], answer: result.questions[0].answer || question.answer };
}

export const ExamMutationSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('assign_image'), imageId: z.string(), questionId: z.string(), role: z.enum(['stem', 'option', 'table', 'decoration']) }).strict(),
  z.object({ name: z.literal('mark_image_decoration'), imageId: z.string(), reason: z.string().min(1).max(300) }).strict(),
  z.object({ name: z.literal('delete_question'), questionId: z.string() }).strict(),
  z.object({ name: z.literal('rename_exam'), value: z.string().min(1).max(200) }).strict(),
  z.object({ name: z.literal('set_meta'), meta: z.object({ subject: z.string().max(200).optional(), grade: z.string().max(100).optional(), totalPoints: z.number().finite().min(0).max(100000).optional() }).strict() }).strict(),
]);
/** Shared pure exam-mutation funnel for human editing and registry tools. Persistence/versioning is outside it. */
export function applyExamMutation(doc: import('../types').ExamDoc, input: z.infer<typeof ExamMutationSchema>): import('../types').ExamDoc {
  const op = ExamMutationSchema.parse(input);
  if ('questionId' in op && !doc.questions.some(q => q.id === op.questionId)) throw new Error('Question not found');
  if ('imageId' in op && !doc.images.some(i => i.id === op.imageId)) throw new Error('Image not found');
  switch (op.name) {
    case 'rename_exam': return { ...doc, displayName: op.value, nameSource: 'manual' };
    case 'set_meta': return { ...doc, meta: { ...doc.meta, ...op.meta } };
    case 'assign_image': return { ...doc,
      questions: doc.questions.map(q => ({ ...q, images: [...q.images.filter(i => i.imageId !== op.imageId), ...(q.id === op.questionId ? [{ imageId: op.imageId, role: op.role }] : [])] })),
      images: doc.images.map(i => i.id === op.imageId ? { ...i, label: { ...i.label, kind: undefined, role: op.role, questionRef: op.questionId } } : i) };
    case 'mark_image_decoration': return { ...doc,
      questions: doc.questions.map(q => ({ ...q, images: q.images.filter(i => i.imageId !== op.imageId) })),
      images: doc.images.map(i => i.id === op.imageId ? { ...i, label: { role: 'decoration', kind: 'decoration', reason: op.reason } } : i) };
    case 'delete_question': return { ...doc,
      questions: doc.questions.filter(q => q.id !== op.questionId).map(q => q.parentId === op.questionId ? { ...q, parentId: undefined } : q),
      images: doc.images.map(i => i.label?.questionRef === op.questionId ? { ...i, label: { ...i.label, questionRef: undefined } } : i) };
  }
}
