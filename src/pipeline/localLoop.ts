/** Follow-up #46: model-authored JSON is the working document. Code checks and routes; it never edits content. */
import type { ExamDoc, ImageAsset, Question, SourceLine } from '../types';
import { repairTruncatedJson } from '../utils/jsonRepair';
import { normalizeGrade, normalizeSubject, normalizeDigits } from './metaRead';
import { hasCountingLoop } from './globalRead';
import { modelText } from './lineNormalize';

export { hasCountingLoop };
/** v2 = the #51 six-phase receipt (extract → map → parse → check → fix → present). v1 receipts keep parsing. */
export const LOOP_VERSION = 'local-loop-v2';
export const LOOP_OVERLAP_LINES = 30;
/** #51: the only order. Check (both checkers, comment-only) always precedes the ONE Fix pass; Present re-checks. */
export const LOOP_PHASES = ['extract', 'map', 'parse', 'check', 'fix', 'present'] as const;
export type LoopPhaseId = typeof LOOP_PHASES[number];
/** Kept as an alias so call sites read naturally; the values are the six phases. */
export type LoopStepId = LoopPhaseId;
/** Step ids written by v1 receipts (pre-#51). Legacy exports still parse and render with these. */
export type LegacyLoopStepId = 'read' | 'self-review' | 'code-check' | 'code-fix' | 'decision-audit' | 'final-fix';
export const LOOP_PHASE_NAMES: Record<LoopPhaseId, string> = {
  extract: 'Extract', map: 'Map', parse: 'Parse', check: 'Check', fix: 'Fix', present: 'Present',
};
/** @deprecated v1 name; same table. */
export const LOOP_STEP_NAMES = LOOP_PHASE_NAMES;
export const CODE_VERDICT_KINDS = ['invalid-json-remnant', 'passage-missing', 'passage-link-missing', 'passage-in-stem', 'duplicate-conflict', 'patch-unapplied', 'duplicate-number', 'missing-number', 'section-count-mismatch', 'section-range-mismatch', 'section-missing', 'blank-missing', 'empty-stem',
  'options-missing-for-type', 'points-sum-mismatch', 'image-unassigned', 'image-double-assigned', 'meta-field-implausible'] as const;
export type CodeVerdictKind = typeof CODE_VERDICT_KINDS[number];
export type LoopDecisionKind = 'stem-faithful' | 'complete' | 'uncontaminated' | 'type-correct' | 'answer-correct'
  | 'answer-letter' | 'points-plausible' | 'belongs-in-section' | 'image-belongs' | 'difficulty' | 'curriculum-hint';
export interface LoopVerdict {
  id: string;
  questionNumbers: number[];
  kind: CodeVerdictKind | LoopDecisionKind;
  message: string;
  source: 'code' | 'decision';
  probability?: number;
  choice?: string;
  imageId?: string;
  page?: number;
  routed?: boolean;
  closed?: boolean;
  /** #51: both checkers flagged the same item for the same concern — ONE verdict, both sources quoted. */
  sources?: Array<'code' | 'decision'>;
  merged?: Array<{ id: string; kind: string; source: 'code' | 'decision'; message: string; probability?: number }>;
  /** #51: an uncertain-band decision verdict shown to the fixer as a hint; it does not by itself require a change. */
  hint?: boolean;
}
export interface AuthoredQuestion {
  number: number;
  sectionTitle?: string;
  type: Question['type'];
  stem: string;
  options: Array<{ key: string; text: string; [key: string]: unknown }>;
  answer?: string;
  points?: number;
  imageIds: string[];
  passageId?: string;
  imageAssignmentReasons?: Record<string, 'order'|'model-claim'|'vision-ref'>;
  subQuestions?: AuthoredQuestion[];
  sourcePages?: number[];
  /** Model-authored extensions and advisory stemFrom/stemTo are retained, never used to slice text. */
  [key: string]: unknown;
}
export interface AuthoredDocument {
  meta: Record<string, unknown>;
  sections: Array<{ title: string; [key: string]: unknown }>;
  questions: AuthoredQuestion[];
  passages?: Array<{ id: string; sectionTitle: string; text: string; appliesToFirst?: number; appliesToLast?: number }>;
  instructionGroups?: Array<{ appliesToFirst: number; appliesToLast: number; text: string }>;
  pointsWithdrawn?: number;
}
export interface LoopPageReceipt {
  page: number; status: 'ok' | 'salvaged' | 'empty' | 'failed' | 'cached';
  calls: number; questions: number; notes: string[];
}
export interface LoopStepReceipt {
  step: LoopPhaseId | LegacyLoopStepId; name: string;
  status: 'idle' | 'running' | 'completed' | 'skipped' | 'failed' | 'cached';
  /** correctionsApplied = patches applied in this phase. verdictsCarried = raised earlier and still standing. */
  calls: number; correctionsApplied: number; verdictsRaised: number; verdictsClosed: number; verdictsCarried?: number;
  notes: string[]; inputTokens: number; outputTokens: number;
  auditProgress?: import('./loopAudit').LoopAuditProgress;
}
/** #51: collapsed call/check timeline — consecutive identical phase:event pairs are counted, not repeated. */
export interface LoopTimelineEntry { phase: LoopPhaseId; event: 'generate' | 'decide' | 'code'; count: number }
export interface LoopReceipt {
  version: 'local-loop-v1' | typeof LOOP_VERSION;
  document: AuthoredDocument;
  steps: LoopStepReceipt[];
  pages: LoopPageReceipt[];
  codeVerdicts: LoopVerdict[];
  auditVerdicts: LoopVerdict[];
  survivingVerdicts: LoopVerdict[];
  notes: string[];
  auditMode: 'shadow' | 'active' | 'skipped';
  map?: import('./mapFirst').LoopMapReceipt;
  skippedNoEvidence?: number;
  pointsWithdrawn?: number;
  /** #50 Part A: list elements dropped at compile (beyond a declared count / exact duplicates). */
  reconciled?: { truncated: number; deduped: number };
  /** #50 Part E: automatic section re-reads after an under-count. */
  sectionReReads?: number;
  /** #50 Part A: generation pathologies (breaker/cap) and how each target was salvaged. */
  pathologies?: LoopPathologyRecord[];
  decisionProvenance?: { dialect: 'jev'|'thx'; host: string };
  /** #51 Check output: code + decision verdicts merged (one verdict per item/concern), before any fix. */
  mergedVerdicts?: LoopVerdict[];
  /** #51 Present re-check economy: code is instant; decision re-votes only changed / confidently indicted items. */
  recheck?: { codeModelCalls: 0; decisionRevoted: number; decisionReused: number; changedQuestions: number[] };
  timeline?: LoopTimelineEntry[];
}
export interface LoopModelRequest {
  /** Generative calls happen only in Map (map + scoped re-map), Parse (sections / page fallback) and Fix. */
  step: 'map' | 'parse' | 'fix';
  system: string; text: string; label: string;
  /** Deliberately no small page cap: a full page of authored questions must fit. */
  maxOutputTokens?: number;
}
export interface LoopModelResponse {
  rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number };
  /** Provider finish reason; 'length'/'max_tokens' = cap, 'repetition-loop'/'counting-loop' = breaker. */
  finishReason?: string;
  breaker?: { kind: 'repetition' | 'counting'; completedItems: number };
}
export type LoopModelCaller = (request: LoopModelRequest) => Promise<LoopModelResponse>;

export const emptyAuthoredDocument = (): AuthoredDocument => ({ meta: {}, sections: [], questions: [] });
export const newLoopReceipt = (): LoopReceipt => ({
  version: LOOP_VERSION, document: emptyAuthoredDocument(),
  steps: LOOP_PHASES.map(step => ({ step, name: LOOP_PHASE_NAMES[step], status: 'idle', calls: 0,
    correctionsApplied: 0, verdictsRaised: 0, verdictsClosed: 0, verdictsCarried: 0, notes: [], inputTokens: 0, outputTokens: 0 })),
  pages: [], codeVerdicts: [], auditVerdicts: [], survivingVerdicts: [], mergedVerdicts: [], notes: [], auditMode: 'skipped', timeline: [],
});
// ---------------------------------------------------------------------------------------------
// #51 Part B — one merged verdict list (Check), one fix pass batched by section (Fix).
// ---------------------------------------------------------------------------------------------
/** Same-concern equivalence between the code list and the decision catalogue. Not new kinds: it only
 * decides when "both checkers flag the same item for the same kind" so they count as ONE verdict. */
export const VERDICT_CONCERN: Partial<Record<CodeVerdictKind | LoopDecisionKind, string>> = {
  'empty-stem': 'stem', 'stem-faithful': 'stem',
  'options-missing-for-type': 'complete', 'passage-missing': 'complete', 'passage-link-missing': 'complete', 'complete': 'complete',
  'passage-in-stem': 'contamination', 'uncontaminated': 'contamination',
  'section-range-mismatch': 'section', 'belongs-in-section': 'section',
  'image-unassigned': 'image', 'image-double-assigned': 'image', 'image-belongs': 'image',
};
const concernKey = (v: LoopVerdict): string => {
  const concern = VERDICT_CONCERN[v.kind] || v.kind;
  return concern === 'image' && v.imageId ? `image:${v.imageId}` : `${concern}:${[...new Set(v.questionNumbers)].sort((a, b) => a - b).join(',')}`;
};
/** Merge code verdicts with FLAGGING decision verdicts (p below the pass line). Where both flag the same
 * item for the same concern the result is one verdict that keeps the decision probability and quotes both. */
export function mergeVerdicts(code: LoopVerdict[], decision: LoopVerdict[], passAt: number): LoopVerdict[] {
  const flags = decision.filter(v => (v.probability ?? 1) < passAt);
  const byKey = new Map<string, LoopVerdict[]>();
  for (const v of code) { const k = concernKey(v); byKey.set(k, [...(byKey.get(k) || []), v]); }
  const absorbed = new Set<string>();
  const merged: LoopVerdict[] = [];
  for (const d of flags) {
    const twins = (byKey.get(concernKey(d)) || []).filter(c => !absorbed.has(c.id) && (c.questionNumbers.length || c.imageId));
    if (!twins.length) { merged.push(d); continue; }
    twins.forEach(c => absorbed.add(c.id));
    merged.push({ ...d, sources: ['code', 'decision'],
      merged: [...twins.map(c => ({ id: c.id, kind: c.kind, source: 'code' as const, message: c.message })), { id: d.id, kind: d.kind, source: 'decision' as const, message: d.message, probability: d.probability }],
      message: `${twins.map(c => c.message).join(' ')} The decision audit agrees (probability sound ${(d.probability ?? 0).toFixed(2)}).` });
  }
  return [...code.filter(c => !absorbed.has(c.id)), ...merged];
}
const HINT_PHRASE: Partial<Record<LoopDecisionKind, string>> = {
  'stem-faithful': 'faithful to the printed stem', complete: 'complete', uncontaminated: "free of another question's material",
  'type-correct': 'typed correctly', 'answer-correct': 'answered correctly', 'answer-letter': 'naming the right answer option',
  'points-plausible': 'carrying plausible points', 'belongs-in-section': 'in the right section', 'image-belongs': 'attached to the right image',
};
/** Plain-language teacher sentence for a decision verdict (the attention list never shows raw prompts). */
export function plainDecisionSentence(v: LoopVerdict, catchAt = 0.2): string {
  const what = HINT_PHRASE[v.kind as LoopDecisionKind] || v.kind;
  const who = v.imageId ? `Image ${v.imageId}` : v.questionNumbers.map(n => `Q${n}`).join(', ') || 'This item';
  const p = v.probability ?? 0.5;
  return p <= catchAt ? `The audit judges ${who} likely not ${what} (sound p=${p.toFixed(2)}).` : `The audit is unsure whether ${who} is ${what} (sound p=${p.toFixed(2)}).`;
}
/** "the audit is unsure whether Q14 is complete — check it while you're here" */
export function hintMessage(v: LoopVerdict): string {
  const what = HINT_PHRASE[v.kind as LoopDecisionKind] || v.kind;
  const who = v.imageId ? `image ${v.imageId}` : v.questionNumbers.map(n => `Q${n}`).join(', ') || 'this item';
  return `Hint: the audit is unsure whether ${who} is ${what} (p=${(v.probability ?? 0.5).toFixed(2)}) — check it while you're here; change it only if the source shows a defect.`;
}
/** Shared Check → Fix routing law. Calibration plants defects at this boundary (after compile). */
export function fixRouting(code: LoopVerdict[], decisions: LoopVerdict[], active: boolean, catchAt = 0.20, passAt = 0.80) {
  const merged = mergeVerdicts(code, decisions, passAt);
  const scope = active ? merged.filter(v => v.source === 'code' || v.sources?.includes('code') || (v.source === 'decision' && (v.probability ?? 1) <= catchAt)) : code;
  const hints = active ? merged.filter(v => v.source === 'decision' && !v.sources && (v.probability ?? 1) > catchAt && (v.probability ?? 1) < passAt).map(v => ({ ...v, hint: true })) : [];
  return { merged, scope, hints };
}
/** Fix batches: by section, ≤ maxQuestions flagged numbers each; every verdict travels once with its
 * questions. Document-level verdicts (no numbers) ride in the first batch. Hints join only batches that
 * already exist — a hint never causes a call on its own. */
export function batchVerdictsBySection(doc: AuthoredDocument, scope: LoopVerdict[], hints: LoopVerdict[], sectionOf: (n: number) => string, maxQuestions = 12): Array<{ section: string; verdicts: LoopVerdict[]; hints: LoopVerdict[] }> {
  const ownerSection = (v: LoopVerdict): string | undefined => v.questionNumbers.length ? sectionOf(v.questionNumbers[0]) : undefined;
  const order: string[] = []; const bySection = new Map<string, LoopVerdict[]>(); const extras: LoopVerdict[] = [];
  for (const v of scope) {
    const section = ownerSection(v);
    if (section === undefined) { extras.push(v); continue; }
    if (!bySection.has(section)) { bySection.set(section, []); order.push(section); }
    bySection.get(section)!.push(v);
  }
  const batches: Array<{ section: string; verdicts: LoopVerdict[]; hints: LoopVerdict[]; numbers: Set<number> }> = [];
  for (const section of order) {
    let current: { section: string; verdicts: LoopVerdict[]; hints: LoopVerdict[]; numbers: Set<number> } | undefined;
    for (const v of bySection.get(section)!) {
      const nums = new Set(v.questionNumbers);
      if (!current || (current.numbers.size && [...nums].filter(n => !current!.numbers.has(n)).length + current.numbers.size > maxQuestions)) {
        current = { section, verdicts: [], hints: [], numbers: new Set() }; batches.push(current);
      }
      current.verdicts.push(v); nums.forEach(n => current!.numbers.add(n));
    }
  }
  if (extras.length) { if (batches.length) batches[0].verdicts.push(...extras); else batches.push({ section: 'Exam', verdicts: extras, hints: [], numbers: new Set() }); }
  for (const h of hints) {
    const section = ownerSection(h); if (section === undefined) continue;
    const target = batches.find(b => h.questionNumbers.some(n => b.numbers.has(n))) || batches.find(b => b.section === section && b.numbers.size < maxQuestions);
    if (target) { target.hints.push(h); h.questionNumbers.forEach(n => target.numbers.add(n)); }
  }
  void doc;
  return batches.map(({ section, verdicts, hints }) => ({ section, verdicts, hints }));
}
/** Question numbers whose authored content differs (ignoring Check's own tags), plus inserts and deletes. */
export function changedQuestionNumbers(before: AuthoredDocument, after: AuthoredDocument): number[] {
  const strip = (q: AuthoredQuestion) => { const { difficulty, difficultyMode, curriculumHints, curriculumSource, sourcePages, imageAssignmentReasons, subQuestions, ...rest } = q as any; void difficulty; void difficultyMode; void curriculumHints; void curriculumSource; void sourcePages; void imageAssignmentReasons; void subQuestions; return JSON.stringify(rest); };
  const index = (doc: AuthoredDocument) => { const m = new Map<number, string[]>(); for (const q of flatAuthoredQuestions(doc)) m.set(q.number, [...(m.get(q.number) || []), strip(q)]); return m; };
  const a = index(before), b = index(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(n => JSON.stringify(a.get(n) || []) !== JSON.stringify(b.get(n) || [])).sort((x, y) => x - y);
}
// ---------------------------------------------------------------------------------------------
// #50 Part A — loops can't hurt: proportional caps, pathology classification, one retry, salvage.
// ---------------------------------------------------------------------------------------------
/** Map call cap (tokens). */
export const MAP_OUTPUT_CAP = 3000;
/** Section parse cap: 800 + expected questions × 220. */
export const sectionOutputCap = (expectedQuestions: number): number => Math.min(16384, 800 + Math.max(0, Math.ceil(expectedQuestions)) * 220);
/** Fix-pass cap: 400 + flagged items × 300, floor 800, ceiling 8192. */
export const fixOutputCap = (flaggedItems: number): number => Math.min(8192, Math.max(800, 400 + Math.max(0, Math.ceil(flaggedItems)) * 300));
export type LoopPathologyKind = 'repetition' | 'counting' | 'cap';
export interface LoopPathologyRecord { label: string; kind: LoopPathologyKind; cutAtItem?: number; salvaged: number; retried: boolean; outcome: 'recovered' | 'partial' }
export function responsePathology(response: LoopModelResponse): LoopPathologyKind | undefined {
  const reason = String(response.finishReason || '').toLowerCase();
  if (reason === 'repetition-loop' || response.breaker?.kind === 'repetition') return 'repetition';
  if (reason === 'counting-loop' || response.breaker?.kind === 'counting') return 'counting';
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max-tokens') return 'cap';
  return undefined;
}
export function pathologyComplaint(kind: LoopPathologyKind, cap?: number): string {
  if (kind === 'repetition') return 'your previous output repeated the same item; emit each item once';
  if (kind === 'counting') return 'your previous output fell into a counting loop; emit each item once and stop';
  return `your previous output hit the output cap${cap ? ` of ${cap} tokens` : ''} before finishing; emit each item once, compactly`;
}
export function pathologyNote(label: string, kind: LoopPathologyKind, cutAtItem: number | undefined, salvaged: number, cap?: number): string {
  const what = kind === 'repetition' ? 'repetition' : kind === 'counting' ? 'counting loop' : `output cap${cap ? ` ${cap} tokens` : ''}`;
  return `${label}: generation loop cut at item ${cutAtItem ?? salvaged + 1} — salvaged ${salvaged} item${salvaged === 1 ? '' : 's'} (pathology: ${what}).`;
}
/**
 * ONE retry per target on a generation pathology (breaker/cap), with the complaint quoted, at the same
 * model. `extraComplaint` lets a caller fold another reason (e.g. a section under-count) into that same
 * single retry. A second pathology marks the target partial — never a third attempt. The better attempt
 * (by `count`) wins; the retry replaces the first attempt only if it is strictly better.
 */
export async function callWithOneRetry<T>(opts: {
  label: string; text: string; cap?: number;
  call: (label: string, text: string) => Promise<LoopModelResponse>;
  parse: (response: LoopModelResponse) => T; count: (value: T) => number;
  extraComplaint?: (value: T, response: LoopModelResponse) => string | undefined;
  onNote: (message: string) => void; onPathology?: (record: LoopPathologyRecord) => void;
  first?: LoopModelResponse;
}): Promise<{ value: T; response: LoopModelResponse; attempts: number; retriedFor: Array<'pathology' | 'extra'>; partial: boolean; usedRetry: boolean }> {
  const firstResponse = opts.first ?? await opts.call(opts.label, opts.text);
  const firstValue = opts.parse(firstResponse);
  const firstKind = responsePathology(firstResponse);
  const complaints: string[] = []; const retriedFor: Array<'pathology' | 'extra'> = [];
  if (firstKind) { opts.onNote(pathologyNote(opts.label, firstKind, firstResponse.breaker?.completedItems, opts.count(firstValue), opts.cap)); complaints.push(pathologyComplaint(firstKind, opts.cap)); retriedFor.push('pathology'); }
  const extra = opts.extraComplaint?.(firstValue, firstResponse);
  if (extra) { complaints.push(extra); retriedFor.push('extra'); }
  if (!complaints.length) return { value: firstValue, response: firstResponse, attempts: 1, retriedFor, partial: false, usedRetry: false };
  let second: LoopModelResponse;
  try { second = await opts.call(`${opts.label} · re-read`, `COMPLAINT ABOUT YOUR PREVIOUS ATTEMPT: ${complaints.join('; ')}.\n\n${opts.text}`); }
  catch (error) {
    opts.onNote(`${opts.label} · re-read skipped — ${errorMessage(error)}; first attempt kept.`);
    if (firstKind) opts.onPathology?.({ label: opts.label, kind: firstKind, cutAtItem: firstResponse.breaker?.completedItems, salvaged: opts.count(firstValue), retried: true, outcome: 'partial' });
    return { value: firstValue, response: firstResponse, attempts: 2, retriedFor, partial: Boolean(firstKind), usedRetry: false };
  }
  const secondValue = opts.parse(second);
  const secondKind = responsePathology(second);
  if (secondKind) opts.onNote(`${pathologyNote(`${opts.label} · re-read`, secondKind, second.breaker?.completedItems, opts.count(secondValue), opts.cap)} Second pathology on the same target — marked partial; no third attempt.`);
  const useSecond = opts.count(secondValue) > opts.count(firstValue) || (!secondKind && opts.count(secondValue) === opts.count(firstValue) && Boolean(firstKind));
  const partial = Boolean(secondKind) && Boolean(firstKind || useSecond);
  if (firstKind || secondKind) opts.onPathology?.({ label: opts.label, kind: (firstKind || secondKind)!, cutAtItem: (firstKind ? firstResponse : second).breaker?.completedItems, salvaged: opts.count(useSecond ? secondValue : firstValue), retried: true, outcome: partial ? 'partial' : 'recovered' });
  return useSecond ? { value: secondValue, response: second, attempts: 2, retriedFor, partial, usedRetry: true } : { value: firstValue, response: firstResponse, attempts: 2, retriedFor, partial, usedRetry: false };
}
/** Whitespace/NFKC-normalized text for duplicate detection (never written back). */
export const dedupeText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? '')).normalize('NFKC').replace(/\s+/g, ' ').trim();
/** Drop exact duplicates (by key), then truncate beyond a declared count. Stats are accumulated. */
export function reconcileList<T>(items: T[], declared: unknown, key: (item: T) => string, stats: { truncated: number; deduped: number }, minDeclared = 0): T[] {
  const seen = new Set<string>(); const out: T[] = [];
  for (const item of items) { const k = key(item); if (seen.has(k)) { stats.deduped++; continue; } seen.add(k); out.push(item); }
  const n = declared === null || declared === undefined || declared === '' ? NaN : Number(declared);
  if (Number.isInteger(n) && n >= minDeclared && out.length > n) { stats.truncated += out.length - n; out.length = n; }
  return out;
}
/** Section-parse compile: same number + same normalized stem is a duplicate; then the declared questionCount. */
export function reconcileAuthoredQuestions(doc: AuthoredDocument, declaredCount: unknown, stats: { truncated: number; deduped: number }): AuthoredDocument {
  doc.questions = reconcileList(doc.questions, declaredCount, q => `${q.number}\u0000${dedupeText(q.stem)}`, stats);
  return doc;
}
export const errorMessage = (error: unknown): string => String((error as any)?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as any : {};
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const number = (value: unknown): number | undefined => {
  const n = Number(normalizeDigits(text(value)).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
const questionNumber = (value: unknown): number | undefined => {
  const n = number(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};
const sectionTitle = (value: unknown): string => text(value).trim();
const sectionKey = (value: unknown): string => sectionTitle(value).normalize('NFKC').toLocaleLowerCase();
const TYPES: Question['type'][] = ['mcq', 'truefalse', 'short', 'long', 'fillblank', 'matching', 'multi', 'numeric', 'diagram', 'essay', 'unknown'];
function questionType(value: unknown): Question['type'] {
  const v = text(value).toLowerCase().replace(/[\s_-]/g, '');
  const aliases: Record<string, Question['type']> = { multiplechoice: 'mcq', choice: 'mcq', trueorfalse: 'truefalse', tf: 'truefalse', fillintheblank: 'fillblank', shortanswer: 'short', longanswer: 'long', freeresponse: 'long', multipleanswer: 'multi' };
  return aliases[v] || TYPES.find(t => t === v) || 'unknown';
}
/** Normalize aliases without discarding the model's object or rewriting its authored text. */
export function normalizeAuthoredQuestion(raw: unknown, page?: number): AuthoredQuestion | undefined {
  const q = object(raw);
  const no = questionNumber(q.number ?? q.no ?? q.questionNumber);
  if (no === undefined) return undefined;
  const options = Array.isArray(q.options) ? q.options.map((o: any, i: number) => typeof o === 'string'
    ? { key: String.fromCharCode(97 + i), text: o }
    : { ...object(o), key: text(o?.key ?? o?.label) || String.fromCharCode(97 + i), text: text(o?.text ?? o?.value) })
    : q.options && typeof q.options === 'object' ? Object.entries(q.options).map(([key, value]) => ({ key, text: text(value) })) : [];
  const answer = q.answer ?? q.answerText ?? q.answerLetter;
  const points = number(q.points ?? q.marks);
  const images = q.imageIds ?? q.images;
  const result: AuthoredQuestion = {
    ...q, number: no, sectionTitle: sectionTitle(q.sectionTitle ?? q.section), type: questionType(q.type),
    stem: text(q.stem ?? q.stemText ?? q.questionText), options,
    imageIds: Array.isArray(images) ? [...new Set(images.map((x: any) => text(typeof x === 'string' ? x : x?.imageId ?? x?.id)).filter(Boolean))] as string[] : [],
  };
  if (answer !== undefined && answer !== null) result.answer = text(typeof answer === 'object' ? answer.text ?? answer.letter ?? answer.value : answer);
  else delete result.answer;
  if (points !== undefined && points >= 0) result.points = points; else delete result.points;
  if (Array.isArray(q.subQuestions)) result.subQuestions = q.subQuestions.map((child: unknown) => normalizeAuthoredQuestion(child, page)).filter(Boolean) as AuthoredQuestion[];
  if (page !== undefined) result.sourcePages = [page];
  return result;
}
export function flatAuthoredQuestions(doc: AuthoredDocument): AuthoredQuestion[] {
  const visit = (questions: AuthoredQuestion[]): AuthoredQuestion[] => questions.flatMap(q => [q, ...visit(q.subQuestions || [])]);
  return visit(doc.questions);
}
export function normalizeAuthoredDocument(raw: unknown): AuthoredDocument {
  const value = object(raw);
  const meta = { ...object(value.meta), ...object(value.metadata) };
  for (const key of ['subject', 'grade', 'totalPoints', 'durationMinutes', 'pages', 'title', 'school', 'year', 'term', 'date']) {
    if (meta[key] === undefined && value[key] !== undefined) meta[key] = value[key];
  }
  if (meta.totalPoints === undefined && meta.total !== undefined) meta.totalPoints = meta.total;
  return {
    meta,
    passages: Array.isArray(value.passages) ? value.passages.filter((p:any)=>p && p.text).map((p:any,i:number)=>({id:text(p.id)||`passage_${i+1}`,sectionTitle:sectionTitle(p.sectionTitle),text:text(p.text)})) : [],
    sections: (Array.isArray(value.sections) ? value.sections : []).map((s: any) => typeof s === 'string' ? { title: s } : { ...object(s), title: sectionTitle(s?.title ?? s?.sectionTitle) }).filter((s: any) => s.title),
    questions: (Array.isArray(value.questions) ? value.questions : Array.isArray(raw) ? raw : []).map((q: unknown) => normalizeAuthoredQuestion(q)).filter(Boolean) as AuthoredQuestion[],
  };
}

/** Complete objects only; a cut-off scalar or half-written question is never invented into data. */
export function completeObjects(raw: string, key: string): unknown[] {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(raw);
  if (!match) return [];
  const out: unknown[] = []; let depth = 0, start = -1, quoted = false, escaped = false;
  for (let i = match.index + match[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === ']' && depth === 0) break;
    if (c === '{' && depth++ === 0) start = i;
    if (c === '}' && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* remnant */ }
    }
  }
  return out;
}
export function parseLoopJson(response: LoopModelResponse): { value: unknown; salvaged: boolean } {
  const raw = (response.rawText || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (raw) {
    try { return { value: JSON.parse(raw), salvaged: false }; } catch { /* salvage below */ }
    const prefix = repairTruncatedJson(raw);
    const questions = completeObjects(raw, 'questions');
    if (questions.length) return { value: { ...object(prefix), questions, sections: completeObjects(raw, 'sections') }, salvaged: true };
    if (prefix !== null) return { value: prefix, salvaged: true };
  }
  if (response.json !== undefined && response.json !== null) return { value: response.json, salvaged: Boolean(raw) };
  return { value: null, salvaged: Boolean(raw) };
}
export interface PageReadResult { document: AuthoredDocument; receipt: LoopPageReceipt; usage: { inputTokens: number; outputTokens: number } }
export function pageFromResponse(response: LoopModelResponse, page: number, cached = false): PageReadResult {
  const parsed = parseLoopJson(response);
  const doc = normalizeAuthoredDocument(parsed.value);
  for (const q of flatAuthoredQuestions(doc)) q.sourcePages = [page];
  const rawQuestions = object(parsed.value).questions;
  const remnant = (parsed.salvaged && doc.questions.length > 0) || (Array.isArray(rawQuestions) && rawQuestions.length !== doc.questions.length);
  const notes: string[] = [];
  if (remnant) notes.push(`Page ${page}: invalid JSON remnant; ${doc.questions.length} complete question object(s) salvaged.`);
  if (!doc.questions.length) notes.push(`Page ${page}: no complete question objects${parsed.value === null ? ' (unreadable model output)' : ''}.`);
  return { document: doc, receipt: { page, status: cached ? 'cached' : remnant ? 'salvaged' : doc.questions.length ? 'ok' : 'empty', calls: cached ? 0 : 1,
    questions: doc.questions.length, notes }, usage: response.usage || { inputTokens: 0, outputTokens: 0 } };
}
const appendText = (a: string, b: string): string => !b || a === b || a.endsWith(b) ? a : a ? `${a}\n${b}` : b;
/** Later pages continue the same number + section. Same-page/different-section duplicates remain visible to CHECK. */
export function mergePageReads(pages: AuthoredDocument[]): AuthoredDocument {
  const result = emptyAuthoredDocument();
  for (const page of pages) {
    for (const [key, value] of Object.entries(page.meta)) if (result.meta[key] === undefined && value !== undefined && value !== null && value !== '') result.meta[key] = value;
    result.passages ||= [];
    for (const passage of page.passages || []) { if (!result.passages.some(p=>p.id===passage.id)) result.passages.push({...passage}); }
    for (const section of page.sections) {
      const old = result.sections.find(s => sectionKey(s.title) === sectionKey(section.title));
      if (old) Object.assign(old, { ...section, ...Object.fromEntries(Object.entries(old).filter(([, v]) => v !== undefined)) });
      else result.sections.push({ ...section });
    }
    for (const q of page.questions) {
      const incomingPage = q.sourcePages?.[0];
      const old = result.questions.find(x => x.number === q.number && sectionKey(x.sectionTitle) === sectionKey(q.sectionTitle) && (incomingPage === undefined || !x.sourcePages?.includes(incomingPage)));
      if (!old) { result.questions.push(structuredClone(q)); continue; }
      old.stem = appendText(old.stem, q.stem);
      for (const option of q.options) {
        const prior = old.options.find(o => o.key === option.key);
        if (prior) prior.text = appendText(prior.text, option.text); else old.options.push({ ...option });
      }
      if (old.answer === undefined) old.answer = q.answer;
      if (old.points === undefined) old.points = q.points;
      old.imageIds = [...new Set([...old.imageIds, ...q.imageIds])];
      old.sourcePages = [...new Set([...(old.sourcePages || []), ...(q.sourcePages || [])])];
      if (q.subQuestions?.length) old.subQuestions = mergePageReads([{ meta: {}, sections: [], questions: old.subQuestions || [] }, { meta: {}, sections: [], questions: q.subQuestions }]).questions;
      for (const [key, value] of Object.entries(q)) if (old[key] === undefined) old[key] = value;
    }
  }
  return result;
}

export type Correction = { action: 'replace' | 'insert' | 'delete' | 'mergeDuplicates'; questionNumber: number; question?: AuthoredQuestion; sectionTitle?: string; pointsWithdrawn?: boolean; passages?: Array<{id:string;sectionTitle:string;text:string}> };
export function parseCorrections(response: LoopModelResponse, options: { salvage?: boolean } = {}): Correction[] | undefined {
  // Patch output is all-or-nothing when unparseable. Unlike READ, never apply a guessed partial patch.
  // #50: a response explicitly CUT by the breaker/cap salvages its COMPLETE correction objects only.
  let value: unknown = response.json;
  if (response.rawText?.trim()) {
    try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
    catch {
      if (!options.salvage) return undefined;
      const raw = response.rawText;
      const seen = new Set<string>();
      const corrections = completeObjects(raw, 'corrections').filter(row => { const k = dedupeText(row); if (seen.has(k)) return false; seen.add(k); return true; });
      value = { corrections, passages: completeObjects(raw, 'passages'), ...(object(repairTruncatedJson(raw)).meta ? { meta: object(repairTruncatedJson(raw)).meta } : {}) };
    }
  }
  const rows = object(value).corrections;
  if (!Array.isArray(rows)) return undefined;
  const result: Correction[] = [];
  const passages = Array.isArray(object(value).passages) ? object(value).passages.filter((p:any)=>p?.text).map((p:any,i:number)=>({id:text(p.id)||`passage_${i+1}`,sectionTitle:sectionTitle(p.sectionTitle),text:text(p.text)})) : [];
  for (const row of rows) {
    const r = object(row); const no = questionNumber(r.questionNumber ?? r.number ?? r.no);
    const action = r.action ?? r.op ?? (r.delete ? 'delete' : 'replace');
    if (no === undefined || !['replace', 'insert', 'delete', 'mergeDuplicates'].includes(action)) continue;
    const question = action === 'delete' ? undefined : normalizeAuthoredQuestion(r.question ?? r.correctedQuestion ?? r.object);
    if (action !== 'delete' && !question) continue;
    result.push({ action, questionNumber: no, question, pointsWithdrawn: (r.question ?? r.correctedQuestion ?? r.object)?.points === null, passages, sectionTitle: r.sectionTitle === undefined ? undefined : sectionTitle(r.sectionTitle) });
  }
  return result;
}
function replaceInTree(questions: AuthoredQuestion[], correction: Correction): { questions: AuthoredQuestion[]; changed: boolean } {
  let changed = false;
  const next: AuthoredQuestion[] = [];
  for (const q of questions) {
    const matches = q.number === correction.questionNumber && (correction.sectionTitle === undefined || sectionKey(q.sectionTitle) === sectionKey(correction.sectionTitle));
    if (matches) { next.push(structuredClone(correction.question!)); changed = true; }
    else {
      const child = correction.question?.subQuestions ? null : replaceInTree(q.subQuestions || [], correction);
      if (child?.changed) { next.push({ ...q, subQuestions: child.questions }); changed = true; } else next.push(q);
    }
  }
  return { questions: next, changed };
}
function deleteInTree(questions: AuthoredQuestion[], correction: Correction): { questions: AuthoredQuestion[]; changed: boolean } {
  let changed = false; const next: AuthoredQuestion[] = [];
  for (const q of questions) {
    if (q.number === correction.questionNumber && (correction.sectionTitle === undefined || sectionKey(q.sectionTitle) === sectionKey(correction.sectionTitle))) { changed = true; continue; }
    const child = deleteInTree(q.subQuestions || [], correction);
    next.push(child.changed ? { ...q, subQuestions: child.questions } : q); changed ||= child.changed;
  }
  return { questions: next, changed };
}
/** The sole automatic content-writing funnel. Full objects only, addressed by printed number. */
export function applyCorrections(doc: AuthoredDocument, corrections: Correction[]): { document: AuthoredDocument; applied: number; notes: string[] } {
  let next = structuredClone(doc); let applied = 0; const notes: string[] = [];
  for (const correction of corrections) {
    if(correction.passages?.length){ next.passages ||= []; for(const p of correction.passages) if(!next.passages.some(x=>x.id===p.id)) next.passages.push(p); }
    const matches = flatAuthoredQuestions(next).filter(q => q.number === correction.questionNumber && (correction.sectionTitle === undefined || sectionKey(q.sectionTitle) === sectionKey(correction.sectionTitle)));
    if (correction.action === 'mergeDuplicates') {
      const sameNo=flatAuthoredQuestions(next).filter(q=>q.number===correction.questionNumber);
      const keep=correction.question;
      if(sameNo.length>=2 && keep){ const first=sameNo[0]; const replacement={...structuredClone(keep),number:correction.questionNumber,sectionTitle:keep.sectionTitle||first.sectionTitle}; const dropped=new Set(sameNo.slice(1)); const prune=(rows:AuthoredQuestion[]):AuthoredQuestion[]=>rows.filter(q=>!dropped.has(q)).map(q=>({...q,subQuestions:prune(q.subQuestions||[])})); next.questions=prune(next.questions); const old=flatAuthoredQuestions(next).find(q=>q.number===correction.questionNumber); if(old) Object.assign(old,replacement); applied++; } else notes.push(`Could not merge duplicate question ${correction.questionNumber}; teacher review required.`); continue;
    }
    if (correction.action === 'insert' && matches.length) { notes.push(`Insert for existing question ${correction.questionNumber} ignored; use replace.`); continue; }
    if (correction.action !== 'insert' && !matches.length) { notes.push(`Correction ignored: question ${correction.questionNumber} does not exist.`); continue; }
    if (matches.length > 1 && correction.sectionTitle === undefined) {
      const tokens=(v:string)=>new Set(v.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]); const target=tokens(correction.question?.stem||''); const score=(q:AuthoredQuestion)=>{const t=tokens(q.stem);let n=0;for(const x of target)if(t.has(x))n++;return n/Math.max(1,target.size+t.size-n)}; const ranked=[...matches].sort((a,b)=>score(b)-score(a));
      if(target.size && (ranked.length===1 || score(ranked[0])-score(ranked[1])>=0.12)) { correction.sectionTitle=ranked[0].sectionTitle; }
      else { notes.push(`Two questions numbered ${correction.questionNumber} disagree — pick the right one (records: ${matches.map(q=>`${q.sectionTitle||'untitled'}: ${q.stem.slice(0,80)}`).join(' | ')}).`); continue; }
    }
    if (correction.action === 'delete') {
      const removed = deleteInTree(next.questions, correction); next.questions = removed.questions;
      if (removed.changed) applied++;
    } else if (correction.action === 'insert') {
      next.questions.push(structuredClone(correction.question!)); applied++;
      const title = correction.question!.sectionTitle;
      if (title && !next.sections.some(s => sectionKey(s.title) === sectionKey(title))) next.sections.push({ title });
    } else {
      const old = matches[0];
      const replacement = { ...structuredClone(correction.question!), sectionTitle: correction.question!.sectionTitle || old.sectionTitle, sourcePages: correction.question!.sourcePages || old.sourcePages };
      const replaced = replaceInTree(next.questions, { ...correction, question: replacement });
      next.questions = replaced.questions; if (replaced.changed) applied++;
      const title = replacement.sectionTitle;
      if (title && !next.sections.some(s => sectionKey(s.title) === sectionKey(title))) next.sections.push({ title });
    }
  }
  // Ordering is presentation, not a content edit. Preserve the order of duplicate records.
  next.questions.sort((a, b) => a.number - b.number);
  return { document: next, applied, notes };
}

/** Deterministic image bookkeeping: page + document order are primary; model claims only break ties. */
export function assignAuthoredImages(doc: AuthoredDocument, images: ImageAsset[], lines: SourceLine[], map?: import('./mapFirst').LoopMapReceipt): void {
  const qs=flatAuthoredQuestions(doc), oldClaims=new Map(qs.map(q=>[q.number,[...q.imageIds]]));
  for(const q of qs) { q.imageIds=[]; q.imageAssignmentReasons={}; }
  const used=new Set<string>();
  const orderedImages=images.map((image,index)=>({image,index})).filter(x=>!x.image.duplicateOf).sort((a,b)=>a.image.page-b.image.page||a.index-b.index).map(x=>x.image);
  for(const image of orderedImages){
    const hint = map?.images.find(i => i.imageId === image.id && i.status !== 'disputed');
    const eligible=(page:number)=>qs.filter(q=>{const pages=questionSourcePages(q,lines);const content=`${q.stem} ${q.options.map(o=>o.text).join(' ')}`;return (pages.includes(page)||q.sourcePages?.includes(page)) && (/\b(picture|image|diagram|figure|photo|illustration)\b/i.test(content)||oldClaims.get(q.number)?.length||Number(image.label?.questionRef?.replace(/^Q/i,''))===q.number || hint?.aboutQuestion === q.number);});
    let candidates=eligible(image.page); if(!candidates.length)candidates=eligible(image.page-1).concat(eligible(image.page+1));
    const available=candidates.filter(q=>q.imageIds.length===0);
    const owner=available.find(q=>oldClaims.get(q.number)?.includes(image.id)) || available.find(q=>hint?.aboutQuestion === q.number) || available.find(q=>hint?.sectionTitle && sectionKey(q.sectionTitle) === sectionKey(hint.sectionTitle)) || available[0];
    if(owner&&!used.has(image.id)){owner.imageIds.push(image.id);const ref=Number(image.label?.questionRef?.replace(/^Q/i,''));owner.imageAssignmentReasons![image.id]=oldClaims.get(owner.number)?.includes(image.id)?'model-claim':ref===owner.number?'vision-ref':'order';used.add(image.id);}
  }
}

/** Conservative source-prefix check: only an explicit numbered source question can prove a
 * nonempty authored stem was cut off mid-sentence. No language-model vote is needed. */
export function sourceProvesTruncatedStem(q: AuthoredQuestion, lines: SourceLine[]): boolean {
  if (q.stem.trim().length < 12 || /[.?!…؟]$/.test(q.stem.trim())) return false;
  return lines.some(line => {
    const match = /^\s*(\d+)[.)]\s+(.+)$/.exec(normalizeDigits(line.text));
    if (!match || Number(match[1]) !== q.number) return false;
    const source = match[2].replace(/\s+[a-d]\)\s.*$/i, '').replace(/\s*\[[\d.]+\]\s*$/, '').trim();
    return source.startsWith(q.stem.trim()) && source.length - q.stem.trim().length >= 4 && /[.?!؟]$/.test(source);
  });
}
export function checkAuthoredDocument(doc: AuthoredDocument, images: ImageAsset[], remnants: LoopVerdict[] = [], lines: SourceLine[] = []): LoopVerdict[] {
  const verdicts: LoopVerdict[] = [...remnants];
  const questions = flatAuthoredQuestions(doc);
  const add = (kind: CodeVerdictKind, numbers: number[], message: string, extra: Partial<LoopVerdict> = {}) => verdicts.push({ id: `code:${kind}:${numbers.join(',') || extra.imageId || 'exam'}`, kind, questionNumbers: numbers, message, source: 'code', ...extra });
  const byNumber = new Map<number, AuthoredQuestion[]>();
  for (const q of questions) byNumber.set(q.number, [...(byNumber.get(q.number) || []), q]);
  for (const [no, matches] of byNumber) if (matches.length > 1) {
    const norm=(v:string)=>v.toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]+/gu,' ').trim();
    const conflict=matches.length===2 && norm(matches[0].stem)===norm(matches[1].stem) && (matches[0].type!==matches[1].type || matches[0].answer!==matches[1].answer);
    if(conflict) add('duplicate-conflict',[no],`Question ${no} has stem-identical records with conflicting type or answer; merge into one corrected question. Both records: ${JSON.stringify(matches)}.`);
    else add('duplicate-number', [no], `Question ${no} appears ${matches.length} times. Check whether these are duplicates or separate sections.`);
  }
  const max = Math.max(0, ...questions.map(q => q.number));
  // Pathology guard: a malformed absurd number must not allocate an unbounded gap list.
  const scanMax = Math.min(max, 1000);
  for (let no = 1; no <= scanMax; no++) if (!byNumber.has(no)) add('missing-number', [no], `Question ${no} is missing between 1 and the document's highest number (${max}).`);
  if (max > scanMax) add('missing-number', [], `The highest authored number (${max}) is implausibly large; gap checking was bounded at ${scanMax}.`);
  for (const q of questions) {
    const passage=(doc.passages||[]).find(p=>(p.id===q.passageId || sectionKey(p.sectionTitle)===sectionKey(q.sectionTitle)) && sectionKey(p.sectionTitle)===sectionKey(q.sectionTitle));
    if (q.passageId && !(doc.passages || []).some(p => p.id === q.passageId)) add('passage-missing', [q.number], `Question ${q.number} links passage ${q.passageId}, but the passage body is absent.`, { page: q.sourcePages?.[0] });
    if (passage && q.stem.length>300 && passage.text.length>100 && q.stem.includes(passage.text.slice(0,100))) add('passage-in-stem',[q.number],`Question ${q.number} duplicates passage text in its stem.`);
    if (!q.passageId && (/\b(passage|paragraph|text above|second line)\b/i.test(q.stem) || /reading/i.test(q.sectionTitle||'')) && !(doc.passages||[]).some(p=>sectionKey(p.sectionTitle)===sectionKey(q.sectionTitle))) add('passage-missing',[q.number],`Question ${q.number} refers to a passage but no passage is attached.`,{page:q.sourcePages?.[0]});
    if (sourceProvesTruncatedStem(q, lines)) add('empty-stem', [q.number], `Question ${q.number} has source-proven truncated question text.`);
    if (!q.stem.trim() && !q.subQuestions?.length) add('empty-stem', [q.number], `Question ${q.number} has no question text.`);
    if (['mcq', 'multi', 'truefalse', 'matching'].includes(q.type) && q.options.length < 2 && !q.subQuestions?.length) add('options-missing-for-type', [q.number], `Question ${q.number} is ${q.type} but its answer choices are missing or incomplete.`);
  }
  const total = number(doc.meta.totalPoints);
  const parentIds = new Set(questions.filter(q => q.subQuestions?.length).map(q => q.number));
  const sum = questions.filter(q => !parentIds.has(q.number)).reduce((s, q) => s + (q.points || 0), 0);
  if (total !== undefined && Math.abs(sum - total) > 0.001) add('points-sum-mismatch', [], `Printed question points add up to ${sum}, not the exam total ${total}.`);
  const owners = new Map<string, number[]>();
  for (const q of questions) for (const id of q.imageIds) owners.set(id, [...(owners.get(id) || []), q.number]);
  for (const image of images) {
    if (image.duplicateOf) continue;
    const assigned = owners.get(image.id) || [];
    if (!assigned.length) add('image-unassigned', [], `Image ${image.id} on page ${image.page} has not been assigned to a question.`, { imageId: image.id, page: image.page });
    if (new Set(assigned).size > 1) add('image-double-assigned', assigned, `Image ${image.id} is assigned to more than one question (${assigned.join(', ')}).`, { imageId: image.id, page: image.page });
  }
  if (doc.meta.grade !== undefined && normalizeGrade(doc.meta.grade) === undefined) add('meta-field-implausible', [], `Grade “${text(doc.meta.grade)}” is not a recognised grade from 1 to 12.`);
  if (doc.meta.subject !== undefined && !normalizeSubject(doc.meta.subject)) add('meta-field-implausible', [], `Subject “${text(doc.meta.subject)}” is not in the subject lexicon; re-read the header.`);
  if (total !== undefined) {
    if (total <= 0) add('meta-field-implausible', [], 'The exam total must be positive.');
    for (const field of ['durationMinutes', 'pages']) if (number(doc.meta[field]) === total) add('meta-field-implausible', [], `Exam total ${total} equals ${field === 'pages' ? 'the page count' : 'the duration'}; it may have read the wrong header field.`);
  }
  return verdicts;
}

/** Projection for the existing PAPERWORK UI. Empty spans mean model-authored text, not sliced source. */
export function projectAuthoredDocument(doc: AuthoredDocument): { questions: Question[]; sections: ExamDoc['sections']; meta: Partial<ExamDoc['meta']> } {
  const titles = [...new Set([...doc.sections.map(s => s.title), ...flatAuthoredQuestions(doc).map(q => q.sectionTitle || '').filter(Boolean)])];
  const sections = titles.map((title, index) => {
    const authored = doc.sections.find(s => sectionKey(s.title) === sectionKey(title));
    return { id: `loop_section_${index + 1}`, index: index + 1, title, spans: [], ...(authored?.instructions ? { instructions: text(authored.instructions) } : {}), ...((doc.passages||[]).find(p=>sectionKey(p.sectionTitle)===sectionKey(title)) ? {passage:(doc.passages||[]).find(p=>sectionKey(p.sectionTitle)===sectionKey(title))!.text} : {}), ...(number(authored?.points) !== undefined ? { points: number(authored?.points) } : {}) };
  });
  const questions: Question[] = [];
  const visit = (q: AuthoredQuestion, parentId?: string) => {
    const id = `loop_q_${q.number}${parentId ? `_child_${questions.length + 1}` : questions.some(x => x.no === q.number) ? `_duplicate_${questions.length + 1}` : ''}`;
    const section = sections.find(s => sectionKey(s.title) === sectionKey(q.sectionTitle));
    const projected: Question = {
      id, no: q.number, label: text(q.label) || String(q.no ?? q.number), type: q.type, stem: q.stem,
      spans: [], options: q.options.map(o => ({ key: o.key, text: o.text, spans: [] })), images: q.imageIds.map(imageId => ({ imageId, role: 'stem' })), confidence: 1,
      ...(section ? { sectionId: section.id } : {}), ...(parentId ? { parentId } : {}),
      ...(q.points !== undefined ? { points: q.points } : {}),
      ...(q.passageId ? { passageId: q.passageId } : {}),
      ...((doc.instructionGroups || []).some(g => q.number >= g.appliesToFirst && q.number <= g.appliesToLast) ? { instructionGroups: (doc.instructionGroups || []).filter(g => q.number >= g.appliesToFirst && q.number <= g.appliesToLast).map(g => g.text) } : {}),
      ...(q.difficulty ? { difficulty: q.difficulty as Question['difficulty'], difficultyMode: q.difficultyMode as Question['difficultyMode'] } : {}),
      ...(q.curriculumHints ? { curriculumHints: q.curriculumHints as Question['curriculumHints'], curriculumSource: q.curriculumSource as Question['curriculumSource'] } : {}),
      ...(q.answer !== undefined ? { answer: { text: q.answer, source: 'paper' as const } } : {}),
      ...(Array.isArray(q.wordBank) ? { wordBank: q.wordBank.map(text) } : {}),
    };
    questions.push(projected);
    for (const child of q.subQuestions || []) visit(child, id);
  };
  for (const q of doc.questions) visit(q);
  const meta: Partial<ExamDoc['meta']> = {};
  for (const key of ['title', 'subject', 'grade', 'school', 'term', 'year'] as const) if (doc.meta[key] !== undefined) meta[key] = text(doc.meta[key]);
  for (const key of ['totalPoints', 'durationMinutes'] as const) { const n = number(doc.meta[key]); if (n !== undefined) meta[key] = n; }
  return { questions, sections, meta };
}

export interface LoopPageChunk { page: number; owned: SourceLine[]; context: SourceLine[] }
export function buildLoopPages(lines: SourceLine[]): LoopPageChunk[] {
  const pages: LoopPageChunk[] = [];
  for (const page of [...new Set(lines.map(l => l.page))].sort((a, b) => a - b)) {
    const owned = lines.filter(l => l.page === page);
    pages.push({ page, owned, context: pages.at(-1)?.owned.slice(-LOOP_OVERLAP_LINES) || [] });
  }
  return pages;
}
/** #50 Part C: prompts carry the normalized twin and never a watermark line. */
export const sourceText = (lines: SourceLine[]): string => lines.filter(l => !l.watermark).map(modelText).join('\n');
export function sourcePagesText(lines: SourceLine[], pages: number[]): string {
  const wanted = new Set(pages);
  return [...wanted].sort((a, b) => a - b).map(p => `PAGE ${p}\n${sourceText(lines.filter(l => l.page === p))}`).join('\n\n');
}
export function questionSourcePages(q: AuthoredQuestion, lines: SourceLine[]): number[] {
  if (q.sourcePages?.length) return q.sourcePages;
  // Provenance fallback for imported authored objects only; never used to slice or alter text.
  const needle = q.stem.trim().split('\n')[0];
  const found = needle ? lines.find(l => l.text.includes(needle)) : undefined;
  return found ? [found.page] : [...new Set(lines.map(l => l.page))];
}
export const LOOP_READ_SYSTEM = `You are ExamParse's local reader. Read this one exam page and author its questions as full JSON objects. Return JSON only.
Use {"meta":{"subject":"...","grade":"...","totalPoints":40,"durationMinutes":90,"pages":6},"sections":[{"title":"Vocabulary","instructions":"..."}],"questions":[{"number":1,"sectionTitle":"Vocabulary","type":"mcq","stem":"full printed question text","options":[{"key":"a","text":"full choice"}],"answer":"only if a printed key supplies it","points":0.5,"imageIds":["img_1"]}]}.
Use self-descriptive keys. Include the full stem, every option, shared instructions/passages needed to understand the question, printed points only when printed, and a printed answer only when present. Never infer or distribute marks. Include every question on this page, including continuations and subQuestions. Same number + same section on a later page means continuation. The previous-page context is read-only; do not duplicate its questions. Use only supplied image ids when the picture belongs to a question. Return shared passages once in top-level passages [{id,sectionTitle,text}], link dependent questions with passageId, and never copy passage text into stems. Do not enumerate source lines. Optional stemFrom/stemTo are advisory only, never a substitute for text. Do not invent questions to fill gaps. Reasoning off. /no_think`;
export const LOOP_FIX_SYSTEM = `Fix only the questions and verdicts supplied. Use the source text, not guesswork. Verdicts come from two checkers: code (plain-language complaints) and the decision audit (probability that the item is sound); a verdict with "sources" was raised by both — treat it once. Verdicts marked "hint" are uncertain: check those questions while you are here, but change them only if the source shows a real defect. While reading each supplied question against its source, also catch what checkers can miss: wrong or incomplete text, a duplicated or missing question, or material belonging to another question. Return corrected FULL question objects by number, as {"corrections":[{"action":"replace","questionNumber":1,"question":{full object}}]}. For duplicate-conflict verdicts, include both records and source in your reasoning and return a single merged corrected object with action mergeDuplicates. You may insert a missing question or delete a duplicate using the same envelope. Do not change unflagged questions. If metadata is flagged, re-read the supplied first-page header and include corrected "meta" alongside corrections. Never infer points or answers. If printed per-question marks are absent, return points: null. For passage-missing or passage-link-missing, re-read source and return {passages:[{id,sectionTitle,text}], corrections:[{action:'replace',questionNumber,question:{...,passageId}}]}; extract passage verbatim once and link all dependent questions. Never copy passage into stem. Never return spans or patches to individual fields; nothing to fix means {"corrections":[]}. Reasoning off. /no_think`;
export function buildLoopPagePrompt(chunk: LoopPageChunk, images: ImageAsset[], guidance?: string): string {
  const context = chunk.context.length ? `PREVIOUS PAGE CONTEXT (read only; last ${LOOP_OVERLAP_LINES} lines):\n${sourceText(chunk.context)}\n\n` : '';
  const captions = images.filter(i => i.page === chunk.page && !i.duplicateOf).map(i => ({ id: i.id, caption: i.label?.caption || null, role: i.label?.role || null }));
  return `${guidance ? `${guidance}\n\n` : ''}${context}PAGE ${chunk.page} SOURCE:\n${sourceText(chunk.owned)}\n\nPAGE IMAGE CAPTIONS:\n${JSON.stringify(captions)}`;
}
export function flaggedFixInput(doc: AuthoredDocument, verdicts: LoopVerdict[], lines: SourceLine[], audit = false): string {
  const numbers = new Set(verdicts.flatMap(v => v.questionNumbers));
  const imagePages = verdicts.map(v => v.page).filter((p): p is number => p !== undefined);
  const questions = flatAuthoredQuestions(doc).filter(q => numbers.has(q.number) || (imagePages.length && questionSourcePages(q, lines).some(p => imagePages.includes(p))));
  const pages = [...new Set([...questions.flatMap(q => questionSourcePages(q, lines)), ...imagePages])];
  const metaVerdicts = verdicts.filter(v => v.kind === 'meta-field-implausible');
  if (metaVerdicts.length) pages.push(1);
  const imageIds = new Set(verdicts.map(v => v.imageId).filter(Boolean));
  const images = [...imageIds];
  return JSON.stringify({ questions, meta: metaVerdicts.length ? doc.meta : undefined, images, verdicts: verdicts.map(v => ({ questionNumbers: v.questionNumbers, kind: v.kind, message: v.hint ? hintMessage(v) : v.message, ...(v.probability !== undefined ? { probability: v.probability, choice: v.choice } : {}), ...(v.hint ? { hint: true } : {}), ...(v.merged ? { sources: v.merged.map(m => ({ source: m.source, kind: m.kind, message: m.message, ...(m.probability !== undefined ? { probability: m.probability } : {}) })) } : {}) })), ...(audit ? { instruction: 'One final patch pass. Fix only these audit-flagged items.' } : {}) })
    + `\n\nSOURCE PAGES:\n${sourcePagesText(lines, pages)}`
    + (metaVerdicts.length ? `\n\nFIRST PAGE HEADER LINES (re-read these; no separate metadata model):\n${lines.filter(l => l.page === 1 && !l.watermark).slice(0, 15).map(modelText).join('\n')}` : '');
}
/** Metadata is part of the parse object; only an explicitly flagged meta correction may change it in Fix. */
export function applyMetaCorrection(response: LoopModelResponse, doc: AuthoredDocument, verdicts: LoopVerdict[]): AuthoredDocument {
  if (!verdicts.some(v => v.kind === 'meta-field-implausible')) return doc;
  try {
    const raw = response.rawText?.trim() ? JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')) : response.json;
    const meta = normalizeAuthoredDocument({ meta: raw?.meta ?? raw?.metadata }).meta;
    return Object.keys(meta).length ? { ...doc, meta: { ...doc.meta, ...meta } } : doc;
  } catch { return doc; }
}
