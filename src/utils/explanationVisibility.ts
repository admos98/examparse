import type { Question } from '../types';

/** #57 — keyless auto-graded items never silently keep their key: they carry
 * answer_key_needs_review with or without a checker proposal until a teacher saves a key. */
const AUTO_GRADED: ReadonlySet<Question['type']> = new Set<Question['type']>(['mcq', 'fillblank', 'matching']);

export function needsAnswerKeyReview(q: Question): boolean {
  return AUTO_GRADED.has(q.type)
    && !q.answer?.text?.trim()
    && !(q.type === 'matching' && !q.options?.length) // shared pool items borrow the parent's key
    && !q.subQuestions?.length;
}

export function reviewTags(q: Question): string[] {
  const derived = [
    ...(q.enrichment?.verification === 'disagreed' ? ['answer_key_needs_review'] : q.enrichment?.verification === 'uncertain' ? ['manual_review'] : []),
    // #57 Part A — a model sample/rubric awaiting teacher confirmation; clears on confirm (source flips).
    ...((q.sampleAnswer?.source === 'model' || q.rubric?.source === 'model') ? ['needs_rubric'] : []),
    // #57 Part B — package items stay flagged until a teacher enters (or adopts) a key.
    ...(q.imported && needsAnswerKeyReview(q) ? ['answer_key_needs_review'] : []),
  ];
  return [...new Set([...(Array.isArray(q.imported?.tags) ? q.imported.tags.filter((t: unknown): t is string => typeof t === 'string') : []), ...(q.tags || []), ...derived])];
}

/** Keep rejected prose in the local record for diagnosis, but never in user exports. */
export function exportSafeQuestion(q: Question): Question {
  const safe: Question = { ...q, tags: reviewTags(q), ...(q.subQuestions ? { subQuestions: q.subQuestions.map(exportSafeQuestion) } : {}) };
  if (q.enrichment?.explanationCheck?.state === 'rejected') {
    delete safe.explanation;
    if (safe.imported?.explanation !== undefined) {
      const { explanation: _explanation, ...metadata } = safe.imported;
      safe.imported = metadata;
    }
  }
  // #57 Part A — rejected sample answers and rubrics are record-only: suppressed from both exports.
  if (q.sampleAnswer?.judged === 'rejected') delete safe.sampleAnswer;
  if (q.rubric?.judged === 'rejected') delete safe.rubric;
  return safe;
}
