/**
 * Stage 3: Assemble & Validate Engine (§5.2 & §6.3)
 * Reconstructs question stems and options from source line spans and validates data integrity.
 */
import { z } from 'zod';
import { Flag, LineSpan, Question, SourceLine } from '../types';

/**
 * Zod schema to enforce strict span-reference contract
 * Hard-fails if any LLM response attempts to hallucinate full stem text
 */
export const SpanReferenceSchema = z.tuple([z.number().int().positive(), z.number().int().positive()]);

export const RawQuestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  no: z.number(),
  parentId: z.string().optional(),
  sectionId: z.string().optional(),
  spans: z.array(SpanReferenceSchema),
  points: z.number().optional(),
  type: z.enum([
    'mcq',
    'truefalse',
    'short',
    'long',
    'fillblank',
    'matching',
    'multi',
    'numeric',
    'diagram',
    'essay',
    'unknown',
  ]),
  options: z
    .array(
      z.object({
        key: z.string(),
        spans: z.array(SpanReferenceSchema),
      })
    )
    .optional(),
  answer: z
    .object({
      spans: z.array(SpanReferenceSchema).optional(),
    })
    .optional(),
  rewrites: z
    .array(
      z.object({
        line: z.number().int().positive(),
        text: z.string(),
      })
    )
    .optional(),
  images: z
    .array(
      z.object({
        imageId: z.string(),
        role: z.enum(['stem', 'option', 'table', 'decoration']),
        anchorLine: z.number().optional(),
      })
    )
    .optional(),
  confidence: z.number().min(0).max(1),
  flags: z.array(z.string()).optional(),
  // Disallow long free text stems to enforce zero-waste
  stemText: z.never().optional(),
  fullStem: z.never().optional(),
});

/**
 * Slice text lines for a set of [startLine, endLine] spans (1-based, inclusive)
 */
export function sliceSourceSpans(
  spans: LineSpan[],
  sourceLines: SourceLine[],
  rewrites?: { line: number; text: string }[]
): string {
  if (!spans || spans.length === 0) return '';

  const rewriteMap = new Map<number, string>();
  if (rewrites) {
    for (const r of rewrites) {
      rewriteMap.set(r.line, r.text);
    }
  }

  const chunks: string[] = [];
  for (const [start, end] of spans) {
    // 1-based inclusive indices
    const startIdx = Math.max(0, start - 1);
    const endIdx = Math.min(sourceLines.length, end);
    const lineTexts: string[] = [];

    for (let i = startIdx; i < endIdx; i++) {
      const lineNum = i + 1;
      if (rewriteMap.has(lineNum)) {
        lineTexts.push(rewriteMap.get(lineNum)!);
      } else if (sourceLines[i]) {
        // Strip leading [Lxxxx] prefix if present in the raw text
        const clean = sourceLines[i].text.replace(/^\[L\d+\]\s*/, '');
        lineTexts.push(clean);
      }
    }
    if (lineTexts.length > 0) {
      chunks.push(lineTexts.join('\n'));
    }
  }

  return chunks.join('\n');
}

export interface AssembleResult {
  questions: Question[];
  flags: Flag[];
  failingQuestions: { question: Question; errors: string[] }[];
}

export function assembleAndValidateQuestions(
  rawQuestions: any[],
  sourceLines: SourceLine[],
  totalDeclaredPoints?: number
): AssembleResult {
  const questions: Question[] = [];
  const flags: Flag[] = [];
  const failingQuestions: { question: Question; errors: string[] }[] = [];

  const totalLines = sourceLines.length;
  const claimedSpans: { qId: string; span: LineSpan; parentId?: string }[] = [];

  for (let idx = 0; idx < rawQuestions.length; idx++) {
    const raw = rawQuestions[idx];
    const errors: string[] = [];

    // 1. Zod schema validation
    const parsed = RawQuestionSchema.safeParse(raw);
    if (!parsed.success) {
      const issues: any[] = (parsed.error as any).issues || (parsed.error as any).errors || [];
      errors.push(...issues.map((e: any) => `${e.path?.join('.') || 'root'}: ${e.message}`));
    }

    const qId = raw.id || `q_${idx + 1}`;

    // Hard-fail contract enforcement: model must never return long free text fields
    if (raw.stemText || raw.fullStem || raw.questionText || (raw.stem && typeof raw.stem === 'string' && raw.stem.length > 30)) {
      errors.push(`Span Contract Violation: Question ${raw.label || qId} returned prohibited free text instead of span references.`);
      // Strip forbidden text to enforce app-side slicing only
      delete raw.stem;
      delete raw.stemText;
      delete raw.fullStem;
      delete raw.questionText;
    }

    const spans: LineSpan[] = Array.isArray(raw.spans) ? raw.spans : [];
    if (spans.length === 0) {
      errors.push(`Missing spans: Question ${raw.label || qId} has no source span references.`);
    }

    // 2. Validate range bounds [1, totalLines], start <= end
    for (const [start, end] of spans) {
      if (start < 1 || end > totalLines || start > end) {
        errors.push(`Invalid span [${start}, ${end}]: out of source range [1, ${totalLines}]`);
      }
    }

    // 3. Assemble stem locally from spans + rewrites
    const stem = sliceSourceSpans(spans, sourceLines, raw.rewrites);
    if (!stem.trim()) {
      errors.push('Assembled stem is empty');
    }

    // 4. Assemble options locally
    const assembledOptions = (raw.options || []).map((opt: any) => {
      const optSpans: LineSpan[] = Array.isArray(opt.spans) ? opt.spans : [];
      for (const [s, e] of optSpans) {
        if (s < 1 || e > totalLines || s > e) {
          errors.push(`Option ${opt.key} invalid span [${s}, ${e}]`);
        }
      }
      return {
        key: opt.key || 'a',
        spans: optSpans,
        text: sliceSourceSpans(optSpans, sourceLines),
      };
    });

    // 5. Assemble answer locally
    let assembledAnswer = undefined;
    if (raw.answer && raw.answer.spans) {
      assembledAnswer = {
        spans: raw.answer.spans,
        text: sliceSourceSpans(raw.answer.spans, sourceLines),
        source: 'paper' as const,
      };
    }

    // 6. Check rewrite limit: Warn if total rewrite chars > 25% of question source chars
    if (raw.rewrites && raw.rewrites.length > 0) {
      const originalSourceSlice = sliceSourceSpans(spans, sourceLines);
      const totalRewriteChars = raw.rewrites.reduce((acc: number, r: any) => acc + (r.text?.length || 0), 0);
      if (originalSourceSlice.length > 0 && totalRewriteChars > originalSourceSlice.length * 0.25) {
        flags.push({
          id: `flag_${flags.length + 1}`,
          severity: 'warn',
          code: 'EXCESSIVE_REWRITE',
          message: `Question ${raw.label || qId}: Rewrites exceed 25% of source characters.`,
          questionId: qId,
        });
      }
    }

    // 7. Check span overlap with previous questions
    for (const currentSpan of spans) {
      for (const claimed of claimedSpans) {
        // Group stems are allowed to share spans with sub-questions via parentId
        if (claimed.qId === raw.parentId || claimed.parentId === qId) continue;
        const [s1, e1] = currentSpan;
        const [s2, e2] = claimed.span;
        if (Math.max(s1, s2) <= Math.min(e1, e2)) {
          flags.push({
            id: `flag_${flags.length + 1}`,
            severity: 'warn',
            code: 'SPAN_OVERLAP',
            message: `Question ${raw.label || qId} overlaps source lines [${Math.max(s1, s2)}, ${Math.min(e1, e2)}] with ${claimed.qId}`,
            questionId: qId,
          });
        }
      }
      claimedSpans.push({ qId, span: currentSpan, parentId: raw.parentId });
    }

    // 8. Confidence check (< 0.6 is marked)
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.8;
    if (confidence < 0.6) {
      flags.push({
        id: `flag_${flags.length + 1}`,
        severity: 'info',
        code: 'LOW_CONFIDENCE',
        message: `Question ${raw.label || qId} parsed with low confidence (${(confidence * 100).toFixed(0)}%)`,
        questionId: qId,
      });
    }

    const questionObj: Question = {
      id: qId,
      label: raw.label || String(raw.no || idx + 1),
      no: typeof raw.no === 'number' ? raw.no : idx + 1,
      parentId: raw.parentId,
      sectionId: raw.sectionId,
      spans,
      stem,
      points: typeof raw.points === 'number' ? raw.points : undefined,
      type: raw.type || 'short',
      options: assembledOptions.length > 0 ? assembledOptions : undefined,
      answer: assembledAnswer,
      rewrites: raw.rewrites || [],
      images: raw.images || [],
      confidence,
      flags: raw.flags || [],
    };

    questions.push(questionObj);

    if (errors.length > 0 || confidence < 0.4) {
      failingQuestions.push({ question: questionObj, errors });
    }
  }

  // 9. Total points sanity check
  if (totalDeclaredPoints !== undefined && totalDeclaredPoints > 0) {
    const pointsSum = questions.reduce((acc, q) => acc + (q.points || 0), 0);
    if (Math.abs(pointsSum - totalDeclaredPoints) > 0.01) {
      flags.push({
        id: `flag_${flags.length + 1}`,
        severity: 'warn',
        code: 'POINTS_MISMATCH',
        message: `Points sum (${pointsSum}) does not match header total (${totalDeclaredPoints})`,
      });
    }
  }

  // 10. Numbering gaps check
  const sortedNos = questions
    .filter(q => !q.parentId)
    .map(q => q.no)
    .sort((a, b) => a - b);
  for (let i = 0; i < sortedNos.length - 1; i++) {
    if (sortedNos[i + 1] - sortedNos[i] > 1) {
      flags.push({
        id: `flag_${flags.length + 1}`,
        severity: 'info',
        code: 'NUMBERING_GAP',
        message: `Question numbering gap between #${sortedNos[i]} and #${sortedNos[i + 1]}`,
      });
    }
  }

  return { questions, flags, failingQuestions };
}
