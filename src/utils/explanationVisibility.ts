import type { ExamDoc, Question } from '../types';
import { AUTO_GRADED_TYPES, DESCRIPTIVE_TYPES, hasSourceKey } from './bankAnswers';
import { artifactState, evidenceFingerprint, rubricFingerprint, sampleFingerprint } from '../pipeline/evidence';

/**
 * #58 — keyless auto-graded items never silently keep their key: they carry
 * answer_key_needs_review until a source key or an explicit teacher save exists.
 * A legacy `answer.source: 'ai'` value is a proposal, so it does NOT count.
 */
export function needsAnswerKeyReview(q: Question): boolean {
  return AUTO_GRADED_TYPES.has(q.type)
    && !hasSourceKey(q)
    && !(q.type === 'matching' && !q.options?.length) // shared pool items borrow the parent's key
    && !q.subQuestions?.length;
}

/** A rubric is satisfied only by a teacher-confirmed rubric with valid positive criteria. */
export function hasTeacherRubric(q: Question): boolean {
  return Boolean(q.rubric && q.rubric.source === 'teacher' && !q.rubric.stale && !q.rubric.reconfirm && typeof q.points === 'number' && Number.isFinite(q.points) && q.points > 0 && q.rubric.criteria.length >= 2
    && q.rubric.criteria.every(criterion => typeof criterion.maxPoints === 'number' && Number.isFinite(criterion.maxPoints) && criterion.maxPoints > 0)
    && Math.abs(q.rubric.criteria.reduce((sum, criterion) => sum + (criterion.maxPoints ?? 0), 0) - q.points) < 1e-9);
}

/** Imported descriptive item still awaiting a rubric the teacher can stand behind. */
export function needsTeacherRubric(q: Question): boolean {
  return Boolean(q.imported) && DESCRIPTIVE_TYPES.has(q.type) && !hasTeacherRubric(q);
}

export function reviewTags(q: Question, doc?: Pick<ExamDoc, 'loop'>): string[] {
  const inherited = Array.isArray(q.imported?.tags) ? q.imported.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [];
  // Imported historical tags are source history: they stay in imported.tags, but a confirmed
  // rubric must clear the ACTIVE tag (history never blocks a genuine confirmation).
  const activeInherited = inherited.filter(tag => !(tag === 'needs_rubric' && hasTeacherRubric(q)));
  // #58 — a judge disagreement is an estimate, not proof: it ADDS a review tag and never erases
  // or rewrites a genuine source answer.
  const auditDoubt = Boolean(doc?.loop?.auditVerdicts?.some(vote => vote.kind === 'answer-correct'
    && vote.questionNumbers.includes(q.no) && typeof vote.probability === 'number' && vote.probability < 0.8));
  const derived = [
    ...(q.enrichment?.verification === 'disagreed' || auditDoubt ? ['answer_key_needs_review'] : q.enrichment?.verification === 'uncertain' ? ['manual_review'] : []),
    // A model sample/rubric awaiting teacher confirmation; clears only on a confirmed rubric.
    ...(needsTeacherRubric(q) || q.sampleAnswer?.source === 'model' ? ['needs_rubric'] : []),
    // Package items stay flagged until a source key or an explicit teacher save exists.
    ...(q.imported && needsAnswerKeyReview(q) ? ['answer_key_needs_review'] : []),
    // Legacy AI Solve values are proposals, never keys.
    ...(q.answer?.source === 'ai' && AUTO_GRADED_TYPES.has(q.type) ? ['answer_key_needs_review'] : []),
  ];
  const activeQuestionTags = (q.tags || []).filter(tag => !(tag === 'needs_rubric' && hasTeacherRubric(q)) && !(tag === 'answer_key_needs_review' && !needsAnswerKeyReview(q)));
  return [...new Set([...activeInherited, ...activeQuestionTags, ...derived])];
}

/** Keep rejected prose in the local record for diagnosis, but never in user exports. */
export function exportSafeQuestion(q: Question, doc?: ExamDoc): Question {
  const safe: Question = {
    ...q,
    tags: reviewTags(q, doc),
    ...(q.subQuestions ? { subQuestions: q.subQuestions.map(child => exportSafeQuestion(child, doc)) } : {}),
  };
  // A legacy AI value is kept (the user's work) but marked non-executable so re-import cannot
  // mistake it for a key.
  if (q.answer?.source === 'ai') safe.answer = { ...q.answer, nonExecuting: true } as Question['answer'];
  if (q.enrichment?.explanationCheck?.state === 'rejected') {
    delete safe.explanation;
    if (safe.imported?.explanation !== undefined) {
      const { explanation: _explanation, ...metadata } = safe.imported;
      safe.imported = metadata;
    }
  }
  // Rejected sample answers and rubrics are record-only: suppressed from both exports.
  if (q.sampleAnswer?.judged === 'rejected') delete safe.sampleAnswer;
  if (q.rubric?.judged === 'rejected') delete safe.rubric;
  // #58 — a verdict whose evidence changed is exported as stale (history), never as verified.
  if (doc) {
    if (safe.sampleAnswer && safe.sampleAnswer.source === 'model' && artifactState(doc, q, safe.sampleAnswer, sampleFingerprint(doc, q, safe.sampleAnswer.text)) === 'stale') safe.sampleAnswer = { ...safe.sampleAnswer, stale: true };
    if (safe.rubric && safe.rubric.source === 'model' && artifactState(doc, q, q.rubric as { judged?: 'verified'; evidence?: string }, rubricFingerprint(doc, q, q.rubric!.criteria)) === 'stale') safe.rubric = { ...safe.rubric, stale: true };
    if (safe.enrichment && q.enrichment?.evidence && q.enrichment.evidence !== evidenceFingerprint(doc, q)) safe.enrichment = { ...safe.enrichment, verification: 'unjudged' };
    // Teacher work is preserved, never deleted — a changed task asks for reconfirmation instead.
    const fingerprint = evidenceFingerprint(doc, q);
    if (safe.sampleAnswer?.source !== 'model' && safe.sampleAnswer?.evidence && safe.sampleAnswer.evidence !== fingerprint) safe.sampleAnswer = { ...safe.sampleAnswer, reconfirm: true };
    if (safe.rubric?.source !== 'model' && safe.rubric?.evidence && safe.rubric.evidence !== fingerprint) safe.rubric = { ...safe.rubric, reconfirm: true };
  }
  return safe;
}
