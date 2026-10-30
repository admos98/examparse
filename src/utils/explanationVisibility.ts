import type { Question } from '../types';

/** Keep rejected prose in the local record for diagnosis, but never in user exports. */
export function exportSafeQuestion(q: Question): Question {
  const safe: Question = { ...q, ...(q.subQuestions ? { subQuestions: q.subQuestions.map(exportSafeQuestion) } : {}) };
  if (q.enrichment?.explanationCheck?.state === 'rejected') {
    delete safe.explanation;
    if (safe.imported?.explanation !== undefined) {
      const { explanation: _explanation, ...metadata } = safe.imported;
      safe.imported = metadata;
    }
  }
  return safe;
}
