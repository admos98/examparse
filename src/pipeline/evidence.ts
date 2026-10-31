/**
 * Follow-up #58 Part B/C — a model verdict belongs to the exact evidence it was shown.
 *
 * Every judged artifact stores the fingerprint of the material the judge saw (task, options,
 * passage, mapped listening script, addressed image bytes, key, points, instruction group).
 * If any of that changes, the verdict is STALE: it is never reused as "verified", while the
 * teacher-authored content itself is preserved and marked for reconfirmation.
 *
 * The fingerprint is synchronous and deterministic (FNV-1a 64-bit over a canonical string), so it
 * can be computed inside render/export paths without awaiting WebCrypto.
 */
import type { ExamDoc, Question, RubricCriterion } from '../types';

export interface EvidenceParts {
  stem: string;
  type: Question['type'];
  label: string;
  options: Array<[string, string]>;
  passage: string;
  script: string;
  images: Array<[string, string, string]>;
  points: number | null;
  key: string | null;
  keySource: string | null;
  instructions: string;
  rubric?: Array<[string, number | null]>;
}

function fnv64(input: string): string {
  let hash = 0xcb9a3b1a7f4c9d2dn;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Instruction-group text that shapes the task (full label ranges are used, never a bare number). */
export function instructionTextFor(doc: ExamDoc, q: Question): string {
  const groups = doc.instructionGroups || [];
  const own = groups.filter(group => q.no >= group.appliesToFirst && q.no <= group.appliesToLast).map(group => group.text || '');
  const imported = q.imported?.instructions ?? q.imported?.instructionGroups ?? q.imported?.instruction_groups;
  return [...own, typeof imported === 'string' ? imported : imported ? JSON.stringify(imported) : ''].filter(Boolean).join('\n');
}

export function evidenceParts(doc: ExamDoc, q: Question, rubric?: RubricCriterion[]): EvidenceParts {
  const passage = (doc.passages || []).find(candidate => candidate.id === q.passageId)?.text || '';
  const script = typeof q.imported?.script === 'string' ? q.imported.script : typeof q.imported?.transcript === 'string' ? q.imported.transcript : '';
  const images = (q.images || []).map(ref => {
    const image = (doc.images || []).find(candidate => candidate.id === ref.imageId);
    return [ref.imageId, ref.role, image?.sha || ''] as [string, string, string];
  });
  return {
    stem: q.stem || '',
    type: q.type,
    label: q.label || String(q.no),
    options: (q.options || []).map(option => [option.key, option.text || ''] as [string, string]),
    passage,
    script,
    images,
    points: typeof q.points === 'number' && Number.isFinite(q.points) ? q.points : null,
    // An imported key is evidence too: a key edit must invalidate a verdict made before it.
    key: q.answer?.text?.trim()
      || (q.imported?.answer_key?.correct?.length ? q.imported.answer_key.correct.join('|') : null)
      || (q.imported?.correctFillBlanks?.length ? JSON.stringify(q.imported.correctFillBlanks) : null),
    keySource: q.answer?.source || (q.imported?.answer_key?.correct?.length || q.imported?.correctFillBlanks?.length ? 'keyfile' : null),
    instructions: instructionTextFor(doc, q),
    ...(rubric ? { rubric: rubric.map(criterion => [criterion.criterion, criterion.maxPoints ?? null] as [string, number | null]) } : {}),
  };
}

/** Stable fingerprint of everything the judge must have seen (rubric content excluded). */
export function evidenceFingerprint(doc: ExamDoc, q: Question): string {
  return fnv64(JSON.stringify(evidenceParts(doc, q)));
}

/** Fingerprint for a rubric verdict: the rubric rows are part of the artifact being checked. */
export function rubricFingerprint(doc: ExamDoc, q: Question, criteria: RubricCriterion[]): string {
  return fnv64(JSON.stringify(evidenceParts(doc, q, criteria)));
}

/** Artifact-specific fingerprints: a verdict binds to both task evidence and the exact text checked. */
export function sampleFingerprint(doc: ExamDoc, q: Question, text: string): string {
  return fnv64(JSON.stringify({ evidence: evidenceParts(doc, q), sample: text }));
}

export function explanationFingerprint(doc: ExamDoc, q: Question, text: string): string {
  return fnv64(JSON.stringify({ evidence: evidenceParts(doc, q), explanation: text }));
}

export type VerdictState = 'verified' | 'uncertain' | 'rejected' | 'disagreed' | 'unjudged' | 'stale';

/**
 * Truthful state of one judged artifact in the context of the CURRENT document.
 * - no artifact ⇒ 'unjudged'
 * - artifact recorded a different evidence fingerprint ⇒ 'stale'
 * - artifact carries no fingerprint (pre-#58 document) ⇒ 'stale' unless it was never judged
 * - otherwise the stored verdict
 */
export function artifactState(doc: ExamDoc, q: Question, artifact: { judged?: 'verified' | 'uncertain' | 'rejected' | 'unjudged'; evidence?: string } | undefined, fingerprint = evidenceFingerprint(doc, q)): VerdictState {
  if (!artifact) return 'unjudged';
  if (artifact.judged === 'unjudged') return 'unjudged';
  // An unbound legacy model verdict is history only. It is not evidence that this exact artifact
  // was checked against the current task.
  if (artifact.evidence === undefined) return 'stale';
  if (artifact.evidence !== fingerprint) return 'stale';
  return artifact.judged || 'unjudged';
}

/** A model verdict may only be called verified when it matches the current evidence. */
export function verifiedForExport(doc: ExamDoc, q: Question, artifact: { judged?: string; evidence?: string } | undefined, fingerprint = evidenceFingerprint(doc, q)): boolean {
  return artifactState(doc, q, artifact as { judged?: 'verified' }, fingerprint) === 'verified';
}

/** Enrichment-level checks share the same rule (blind answer, explanation, image placement). */
export function enrichmentIsCurrent(doc: ExamDoc, q: Question): boolean {
  if (!q.enrichment?.evidence) return q.enrichment?.verification === 'unjudged';
  return q.enrichment.evidence === evidenceFingerprint(doc, q);
}

export function enrichmentState(doc: ExamDoc, q: Question): VerdictState {
  const current = enrichmentIsCurrent(doc, q);
  const stored = q.enrichment?.verification;
  if (!stored || stored === 'unjudged') return 'unjudged';
  return current ? stored : 'stale';
}

export function explanationState(doc: ExamDoc, q: Question): VerdictState {
  const check = q.enrichment?.explanationCheck;
  const stored = check?.state;
  if (!stored || stored === 'unjudged') return 'unjudged';
  if (!q.explanation || !check?.evidence) return 'stale';
  return check.evidence === explanationFingerprint(doc, q, q.explanation.text) ? stored : 'stale';
}
