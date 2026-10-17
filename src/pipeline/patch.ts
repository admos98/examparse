/**
 * Minimal-Patch Regeneration Engine (§5.4)
 * RFC 7386 JSON Merge Patch for single-question updates with diff preview.
 */
import { LLMRequest, Question, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T4_QUESTION_PATCH_SYSTEM } from './prompts';
import { sliceSourceSpans } from './assemble';

/**
 * Apply RFC 7386 JSON Merge Patch
 */
export function applyMergePatch(target: any, patch: any): any {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return patch;
  }
  const result = { ...target };
  for (const key of Object.keys(patch)) {
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
}): Promise<QuestionPatchResult> {
  const { question, sourceLines, instruction, providerConfig } = params;

  // Extract question spans + ±5 context lines around it
  let minLine = sourceLines.length;
  let maxLine = 1;
  for (const [start, end] of question.spans) {
    minLine = Math.min(minLine, start);
    maxLine = Math.max(maxLine, end);
  }

  const contextStart = Math.max(0, minLine - 6);
  const contextEnd = Math.min(sourceLines.length, maxLine + 5);

  const contextSourceSlice = sourceLines
    .slice(contextStart, contextEnd)
    .map(l => `${l.id}: ${l.text}`)
    .join('\n');

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
    maxOutputTokens: 1024,
    label: `Patch Question ${question.label || question.no}`,
    providerConfig,
  };

  const response = await LLMAdapter.execute(request);
  const patch: any = response.json || {};

  // Compute patched object
  const merged = applyMergePatch(questionSnapshot, patch);

  // Re-slice stem with newly patched spans/rewrites
  const newSpans = merged.spans || question.spans;
  const newRewrites = merged.rewrites || question.rewrites;
  const newStem = sliceSourceSpans(newSpans, sourceLines, newRewrites);

  const patchedQuestion: Question = {
    ...question,
    ...merged,
    spans: newSpans,
    stem: newStem,
    rewrites: newRewrites,
    options: merged.options
      ? merged.options.map((opt: any) => ({
          key: opt.key,
          spans: opt.spans,
          text: sliceSourceSpans(opt.spans, sourceLines),
        }))
      : question.options,
  };

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
