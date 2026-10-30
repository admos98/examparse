import type { Question } from '../types';

export function reviewTags(q: Question): string[] {
  return [...new Set([...(Array.isArray(q.imported?.tags) ? q.imported.tags.filter((t: unknown): t is string => typeof t === 'string') : []), ...(q.tags || []), ...(q.enrichment?.verification === 'disagreed' ? ['answer_key_needs_review'] : q.enrichment?.verification === 'uncertain' ? ['manual_review'] : [])])];
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
  return safe;
}
