/**
 * Follow-up #58 — the single place where ExamParse facts become destination-bank fields.
 *
 * The destination contract is NOT confirmed. The bank agent reports destination MODEL fields
 * (`Question.rubrics: RubricCriterion[]`, `answerKey.sampleAnswer`, executable
 * `correctFillBlanks`), but not the adapter's input JSON. Therefore:
 *
 *  - the default profile (`bank-v2-provisional`) emits the best-known field names AND records
 *    every unconfirmed mapping in the export report + `contract/requests.json`;
 *  - `appendix-a-1.1` is the conservative profile: only the option-key `answer_key` is written
 *    into batch.json; everything else travels losslessly in `preserved/answers.json`;
 *  - every report says `verified: false` until the real adapter + `validateImportBatch` have been
 *    run against these bytes. No code path may call an unvalidated ZIP "bank-ready".
 *
 * Nothing here executes a model proposal: `planBankAnswer` already excludes them, and the
 * provisional profile only copies `enrichment.proposedAnswer` into the non-executable
 * `preserved/answers.json` sidecar.
 */
import type { ExamDoc, Question } from '../types';
import { planBankAnswer, type BankAnswerPlan, type BlankAnswer, type AnswerProvenance } from './bankAnswers';
import { artifactState, rubricFingerprint, sampleFingerprint } from '../pipeline/evidence';

export type BankContractProfile = 'appendix-a-1.1' | 'bank-v2-provisional';

export interface ContractPending {
  question: string;
  item: string;
  kind: string;
  reason: string;
  contract_question: string;
}

export interface BankContractReport {
  profile: BankContractProfile;
  /** Always false until the real adapter + validator are run on these exact bytes. */
  verified: false;
  pending: ContractPending[];
  requests: string[];
  note: string;
}

/** The exact questions ExamParse needs answered before any compatibility claim. */
export const CONTRACT_REQUESTS: readonly string[] = [
  'Optionless fill-in-the-blank answers: exact input shape for one blank, several blanks and explicitly supplied alternatives, and how it maps to executable correctFillBlanks.',
  'Keyless fill-in-the-blank import: is a keyless item accepted on import and held at publish, or rejected? Exact gate and reason text.',
  'Descriptive sample answers: exact input shape and provenance field for source/keyfile/teacher samples, and where the bank stores them (answerKey.sampleAnswer?).',
  'Rubrics: exact input shape for criteria (precision/decimal places), how maxPoints are validated against item points, and whether Question.rubrics is accepted by the adapter input.',
  'needs_rubric and teacher confirmation: how the tag reaches the bank and what clears it; whether a teacher-edited artifact can be sent as teacher-confirmed.',
  'Claimed provenance: does the adapter accept source_type "claimed", or must ExamParse remap (opt-in) to authored?',
  'Inherited lesson provenance: is there a field for an inherited (passage-derived) lesson, or is it structured-export only?',
  'Picture options and missing assets: are option images supported, and how is a required-but-missing picture represented (flag object? placeholder asset id?)?',
  'Teacher-only listening evidence: where may a per-section script/transcript live so it is never student-visible and never audio?',
  'Multi-part exports (>50 questions): how do part-N batch JSONs resolve the shared assets manifest/files at import time?',
  'Matching, ordering and true/false wire shapes without option lists.',
  'The exact adapter invocation and validateImportBatch used by the bank, so the gate can be replayed by both sides.',
];

const CONTRACT_NOTE = 'Contract NOT verified. Run the real bank adapter + validateImportBatch on this ZIP before calling it bank-ready; pending mappings are listed in contract/requests.json.';

export interface BankRowLike {
  label?: string;
  answer_key?: { correct: string[]; grading: 'auto' } | null;
  correctFillBlanks?: Array<string | string[]>;
  sample_answer?: { text: string; source: string; provenance?: string; judged?: string };
  rubric?: { criteria: Array<{ criterion: string; maxPoints?: number }>; sourceProvenance?: string };
  tags?: string[];
}

export interface DescriptiveArtifact {
  text?: string;
  criteria?: Array<{ criterion: string; maxPoints?: number }>;
  source: 'model' | 'teacher' | 'paper' | 'keyfile' | 'manual';
  judged?: 'verified' | 'uncertain' | 'rejected' | 'unjudged';
  current: boolean;
  evidence?: string;
  stale?: boolean;
  reconfirm?: boolean;
  priced?: boolean;
}

/** Provenance label a destination can trust: source artifacts are never labelled "model". */
export function artifactProvenance(artifact: { source: string }): string {
  return artifact.source === 'model' ? 'model' : artifact.source;
}

/**
 * Read the descriptive artifacts that may travel to the bank.
 * - teacher-confirmed: always travels (their work is never suppressed because of an old verdict)
 * - source-provided samples: travel with their honest paper/keyfile/manual provenance
 * - model artifacts: only while the stored verdict is verified against the CURRENT evidence
 */
export function descriptiveArtifacts(doc: ExamDoc, q: Question): DescriptiveArtifact[] {
  const out: DescriptiveArtifact[] = [];
  if (q.sampleAnswer) {
    const state = artifactState(doc, q, q.sampleAnswer, sampleFingerprint(doc, q, q.sampleAnswer.text));
    const teacher = q.sampleAnswer.source !== 'model';
    if (teacher || state === 'verified') {
      out.push({ text: q.sampleAnswer.text, source: q.sampleAnswer.source as DescriptiveArtifact['source'], judged: q.sampleAnswer.judged, current: teacher ? !(q.sampleAnswer.stale || q.sampleAnswer.reconfirm) : state === 'verified', evidence: q.sampleAnswer.evidence, stale: q.sampleAnswer.stale, reconfirm: q.sampleAnswer.reconfirm });
    }
  }
  if (q.rubric) {
    const state = artifactState(doc, q, q.rubric as { judged?: 'verified'; evidence?: string }, rubricFingerprint(doc, q, q.rubric.criteria));
    const teacher = q.rubric.source !== 'model';
    const priced = typeof q.points === 'number' && Number.isFinite(q.points) && q.points > 0 && q.rubric.criteria.every(c => typeof c.maxPoints === 'number' && Number.isFinite(c.maxPoints) && c.maxPoints > 0) && Math.abs(q.rubric.criteria.reduce((sum, c) => sum + (c.maxPoints || 0), 0) - q.points) < 1e-9;
    if (teacher || state === 'verified' || !priced) {
      out.push({ criteria: q.rubric.criteria.map(c => ({ criterion: c.criterion, ...(typeof c.maxPoints === 'number' ? { maxPoints: c.maxPoints } : {}) })), source: q.rubric.source as DescriptiveArtifact['source'], judged: priced ? q.rubric.judged : 'unjudged', current: priced && (teacher ? !(q.rubric.stale || q.rubric.reconfirm) : state === 'verified'), evidence: q.rubric.evidence, stale: q.rubric.stale, reconfirm: q.rubric.reconfirm, priced });
    }
  }
  // A source-provided manual answer on a descriptive item is the item's honest sample answer.
  const plan = planBankAnswer(q);
  if (plan.kind === 'descriptive' && !q.sampleAnswer && plan.source !== 'ai') {
    out.unshift({ text: plan.text, source: plan.source, current: true, judged: undefined });
  }
  return out;
}

/** Whether the item still needs a (teacher-confirmed) rubric. A sample alone never satisfies it. */
export function rubricRequirementMet(q: Question): boolean {
  return Boolean(q.rubric && q.rubric.source === 'teacher' && !q.rubric.stale && !q.rubric.reconfirm && typeof q.points === 'number' && Number.isFinite(q.points) && q.points > 0 && q.rubric.criteria.length >= 2 && q.rubric.criteria.every(c => typeof c.maxPoints === 'number' && Number.isFinite(c.maxPoints) && c.maxPoints > 0) && Math.abs(q.rubric.criteria.reduce((sum, c) => sum + (c.maxPoints || 0), 0) - q.points) < 1e-9);
}

/** Lossless sidecar entry: everything ExamParse knows about one answer, regardless of contract. */
export interface PreservedAnswer {
  questionId?: string; sectionId?: string; label: string;
  type: string;
  kind: BankAnswerPlan['kind'];
  answer: unknown;
  teacher_answer?: { text: string; source: 'manual' };
  source_history?: { answer_key?: unknown; correctFillBlanks?: unknown; correct_fill_blanks?: unknown; answer?: unknown };
  provenance: AnswerProvenance | null;
  executable: boolean;
  pending_reason?: string;
  proposal?: string;
  descriptive?: DescriptiveArtifact[];
  needs_rubric: boolean;
  review_tags: string[];
  unresolved_placeholders?: Array<{ asset: string; sha: string | null; reason: string }>;
  sample_confirmation?: unknown;
  rubric_confirmation?: unknown;
}

export function preservedAnswer(doc: ExamDoc, q: Question, tags: string[]): PreservedAnswer {
  const plan = planBankAnswer(q);
  const descriptive = descriptiveArtifacts(doc, q);
  return {
    questionId: q.id, ...(q.sectionId ? { sectionId: q.sectionId } : {}),
    label: q.label || String(q.no),
    type: q.type,
    kind: plan.kind,
    answer:
      plan.kind === 'option-key' ? { optionIndices: plan.correct, optionKeys: plan.optionKeys }
      : plan.kind === 'text-blanks' ? { blanks: plan.blanks }
      : plan.kind === 'true-false' ? { value: plan.value }
      : plan.kind === 'descriptive' ? { text: plan.text }
      : null,
    ...(q.answer?.source === 'manual' && q.answer.text?.trim() ? { teacher_answer: { text: q.answer.text.trim(), source: 'manual' as const } } : {}),
    ...(q.imported ? { source_history: q.imported.source_history || {
      ...(q.imported.answer_key !== undefined ? { answer_key: q.imported.answer_key } : {}),
      ...(q.imported.correctFillBlanks !== undefined ? { correctFillBlanks: q.imported.correctFillBlanks } : {}),
      ...(q.imported.correct_fill_blanks !== undefined ? { correct_fill_blanks: q.imported.correct_fill_blanks } : {}),
      ...(q.imported.answer !== undefined ? { answer: q.imported.answer } : {}),
    } } : {}),
    provenance: 'source' in plan ? (plan.source as AnswerProvenance) : null,
    executable: plan.kind === 'option-key' || plan.kind === 'true-false' || plan.kind === 'text-blanks',
    ...(plan.kind === 'keyless' ? { pending_reason: plan.reason } : {}),
    ...(plan.kind === 'keyless' && plan.proposal ? { proposal: plan.proposal } : {}),
    ...(descriptive.length ? { descriptive } : {}),
    ...(Array.isArray(q.imported?.unresolved_placeholders) ? { unresolved_placeholders: q.imported.unresolved_placeholders } : {}),
    needs_rubric: Boolean(q.imported) && !rubricRequirementMet(q) && ['short', 'long', 'essay'].includes(q.type),
    review_tags: tags,
  };
}

function pending(report: BankContractReport, q: Question, item: string, kind: string, reason: string, contractQuestion: number): void {
  report.pending.push({ question: `Q${q.label || q.no}`, item, kind, reason, contract_question: CONTRACT_REQUESTS[contractQuestion] });
}

function blankWireForm(blank: BlankAnswer): string[] {
  // Always an array per blank: `[[accept...], [accept...]]` keeps blanks and alternatives
  // distinguishable, so nothing is collapsed into a single ambiguous string.
  return [...blank.accept];
}

/**
 * Apply the answer facts to one bank row under a named profile, recording every unconfirmed
 * mapping. This is the only function that writes executable answer fields.
 */
export function applyAnswerPlan(row: BankRowLike, q: Question, plan: BankAnswerPlan, profile: BankContractProfile, report: BankContractReport): void {
  if (plan.kind === 'option-key') {
    row.answer_key = { correct: [...plan.correct], grading: 'auto' };
    return;
  }
  if (plan.kind === 'true-false') {
    if (profile === 'appendix-a-1.1') {
      pending(report, q, 'answer', 'true-false', 'a true/false key without options has no confirmed wire shape', 10);
      return;
    }
    row.answer_key = { correct: [plan.value ? '1' : '2'], grading: 'auto' };
    pending(report, q, 'answer', 'true-false', 'true/false encoded as option index 1=true, 2=false — confirm with the adapter', 10);
    return;
  }
  if (plan.kind === 'text-blanks') {
    if (plan.ambiguity) pending(report, q, 'answer', 'fill_in_blank', plan.ambiguity, 0);
    if (profile === 'appendix-a-1.1') {
      pending(report, q, 'answer', 'fill_in_blank', 'optionless fill-in-the-blank answer preserved in preserved/answers.json; correctFillBlanks shape unconfirmed', 0);
      return;
    }
    row.correctFillBlanks = plan.blanks.map(blankWireForm);
    pending(report, q, 'answer', 'fill_in_blank', 'preserved as correctFillBlanks (alternatives as arrays); confirm blanks/alternatives shape and import gate', 0);
    return;
  }
  if (plan.kind === 'descriptive') {
    // A source-provided descriptive answer is a NON-EXECUTING sample, never an answer key.
    if (profile === 'appendix-a-1.1') {
      pending(report, q, 'sample_answer', 'descriptive', 'source sample answer preserved in preserved/answers.json; sample-answer input shape unconfirmed', 2);
      return;
    }
    row.sample_answer = { text: plan.text, source: plan.source, provenance: plan.source, judged: 'source' };
    pending(report, q, 'sample_answer', 'descriptive', 'source-provided sample answer emitted with honest provenance; confirm answerKey.sampleAnswer input shape', 2);
    return;
  }
}

/** Map verified/teacher-confirmed descriptive artifacts under the selected profile. */
export function applyDescriptiveArtifacts(row: BankRowLike, q: Question, artifacts: DescriptiveArtifact[], profile: BankContractProfile, report: BankContractReport): void {
  const sample = artifacts.find(artifact => typeof artifact.text === 'string');
  const rubric = artifacts.find(artifact => artifact.criteria?.length);
  if (sample) {
    if (profile === 'appendix-a-1.1') pending(report, q, 'sample_answer', sample.source, 'verified/teacher sample preserved in preserved/answers.json; input shape unconfirmed', 2);
    else {
      row.sample_answer = { text: sample.text!, source: sample.source, provenance: sample.source, judged: sample.judged };
      if (sample.source !== 'model') pending(report, q, 'sample_answer', sample.source, 'source/keyfile/teacher sample emitted with provenance; confirm the bank accepts non-model provenance', 2);
    }
  }
  if (rubric) {
    if (!rubric.priced) pending(report, q, 'rubric', rubric.source, 'criterion text is retained as unpriced/pending because no valid printed-point distribution is available', 3);
    else if (profile === 'appendix-a-1.1') pending(report, q, 'rubric', rubric.source, 'rubric preserved in preserved/answers.json; Question.rubrics input shape unconfirmed', 3);
    else {
      row.rubric = { criteria: rubric.criteria!.map(criterion => ({ criterion: criterion.criterion, maxPoints: criterion.maxPoints })), sourceProvenance: rubric.source };
      pending(report, q, 'rubric', rubric.source, 'rubric emitted as Question.rubrics/criteria; confirm criterion precision and points validation', 3);
    }
  }
}

export function emptyContractReport(profile: BankContractProfile): BankContractReport {
  return { profile, verified: false, pending: [], requests: [...CONTRACT_REQUESTS], note: CONTRACT_NOTE };
}
