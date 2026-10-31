/** #57/#58 — judged sample answers and rubrics for keyless descriptive (tashrihi) items.
 *
 * Rules preserved from #57 (thresholds and clauses unchanged) plus #58 corrections:
 *  - rubric arithmetic never redistributes a valid model distribution and never invents
 *    zero/negative weights; a distribution the contract cannot express at the item's precision is
 *    left unpriced/pending instead of mangled;
 *  - the writer and both judges receive the SAME addressed evidence (passage, mapped section
 *    script, one image bundle per question within the endpoint limit); missing evidence means
 *    "unjudged", never "verified";
 *  - partial/malformed output is salvaged with a nested-aware parser and each missing part gets at
 *    most ONE scoped retry; the final notes report generated / verified / uncertain / missing
 *    separately.
 */
import type { AppSettings, ExamDoc, Question, RubricCriterion } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { localProviderFor } from './localProvider';
import { salvageJsonObjects } from '../utils/jsonRepair';
import { evidenceFingerprint, rubricFingerprint } from './evidence';
import type { ImageBundle } from './evidenceBundle';

/** The tashrihi set: descriptive item types that carry no auto-gradable key. */
export const TASHRIHI_TYPES: ReadonlySet<Question['type']> = new Set<Question['type']>(['short', 'long', 'essay']);

/** Keyless descriptive item — eligible for a model sample + rubric proposal. */
export function isTashrihiQuestion(q: Question): boolean {
  return TASHRIHI_TYPES.has(q.type) && !q.answer?.text?.trim();
}

export function tashrihiItems(doc: ExamDoc): Question[] {
  return (doc.questions || []).filter(isTashrihiQuestion);
}

/** The exact single-clause judge checks (no threshold/instruction changes outside this clause). */
export const SAMPLE_ANSWER_JUDGE = 'This sample answer correctly completes the task as asked.';
export const RUBRIC_JUDGE = 'This rubric grades exactly what this task asks, at the stated points.';

/** One routing for both artifacts: ≥0.80 verified · ≤0.20 rejected · middle uncertain. */
export function judgeState(probability: number | undefined): 'verified' | 'uncertain' | 'rejected' | 'unjudged' {
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return 'unjudged';
  return probability >= 0.8 ? 'verified' : probability <= 0.2 ? 'rejected' : 'uncertain';
}

/** Decimal places actually needed to write a value exactly (bounded to avoid float noise). */
export function decimalPlaces(value: number): number {
  for (let places = 0; places <= 6; places++) {
    const scaled = value * 10 ** places;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return places;
  }
  return 7;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export interface RubricValidation { ok: boolean; reason?: string }

/**
 * Validate criteria against the item's printed points. Positive finite weights only, and the sum
 * must equal the printed total at the precision the criteria are written with.
 */
export function validateRubric(criteria: RubricCriterion[] | undefined, points?: number | null): RubricValidation {
  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 4) return { ok: false, reason: 'a rubric needs 2–4 criteria' };
  if (criteria.some(criterion => !criterion.criterion?.trim())) return { ok: false, reason: 'every criterion needs text' };
  if (criteria.some(criterion => !Number.isFinite(criterion.maxPoints) || criterion.maxPoints <= 0)) return { ok: false, reason: 'every criterion needs a positive maxPoints' };
  if (typeof points === 'number' && Number.isFinite(points) && points > 0) {
    const places = Math.max(...criteria.map(criterion => decimalPlaces(criterion.maxPoints)));
    const sum = roundTo(criteria.reduce((total, criterion) => total + criterion.maxPoints, 0), places);
    if (Math.abs(sum - points) > 1e-9) return { ok: false, reason: `criteria add up to ${sum}, not the printed ${points}` };
  }
  return { ok: true };
}

/**
 * Build 2–4 rubric criteria.
 *  - A valid model distribution (positive weights that sum to the printed points) is PRESERVED
 *    exactly — it is never redistributed to quarters.
 *  - Weights the model omitted may be filled with an even split ONLY when that split is exactly
 *    representable at the item's precision (0.5 / 4 = 0.125 is; 1 / 3 is not).
 *  - Anything else returns undefined so the caller can request adjusted criteria once, and then
 *    leave the rubric pending. Negative/zero weights are never produced.
 */
export function rubricCriteria(raw: unknown, points?: number | null): RubricCriterion[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return undefined;
  const criteria: RubricCriterion[] = [];
  for (const row of raw) {
    const value = row as Record<string, unknown> | null;
    const criterion = typeof value?.criterion === 'string' && value.criterion.trim()
      ? value.criterion.trim()
      : typeof value?.text === 'string' && value.text.trim() ? value.text.trim() : '';
    if (!criterion) return undefined;
    const rawPoints = Number(value?.maxPoints ?? value?.points);
    criteria.push({ criterion, maxPoints: Number.isFinite(rawPoints) ? rawPoints : NaN });
  }
  // Negative weights are malformed output, never silently repaired into a distribution.
  if (criteria.some(criterion => Number.isFinite(criterion.maxPoints) && criterion.maxPoints < 0)) return undefined;
  const hasPrintedPoints = typeof points === 'number' && Number.isFinite(points) && points > 0;
  const allPositive = criteria.every(criterion => Number.isFinite(criterion.maxPoints) && criterion.maxPoints > 0);
  const noneSupplied = criteria.every(criterion => !Number.isFinite(criterion.maxPoints) || criterion.maxPoints === 0);
  if (!allPositive && !noneSupplied) return undefined; // mixed positive/zero is malformed
  if (allPositive) {
    if (!hasPrintedPoints) return criteria;
    // Preserve the model's own distribution when it is valid for the printed total.
    if (validateRubric(criteria, points).ok) return criteria;
    // A distribution that does not add up is never left half-repaired: either an EXACT even split
    // is representable at this item's precision, or the rubric stays pending (no invented weights).
    const even = exactEvenSplit(criteria.map(criterion => criterion.criterion), points!, 4);
    return even && validateRubric(even, points).ok ? even : undefined;
  }
  if (!hasPrintedPoints) return undefined; // weights are required when the item is unpriced
  const even = exactEvenSplit(criteria.map(criterion => criterion.criterion), points!, 4);
  return even && validateRubric(even, points).ok ? even : undefined;
}

/** An even split that is EXACTLY representable (0.5/4 = 0.125 yes; 1/3 no ⇒ undefined). */
function exactEvenSplit(texts: string[], total: number, places: number): RubricCriterion[] | undefined {
  const per = roundTo(total / texts.length, places);
  if (roundTo(per * texts.length, places) !== roundTo(total, places)) return undefined;
  const split = texts.map((criterion, index) => ({
    criterion,
    maxPoints: index === texts.length - 1 ? roundTo(total - per * (texts.length - 1), places) : per,
  }));
  return split.some(criterion => criterion.maxPoints <= 0) ? undefined : split;
}

/** Whether an artifact still awaits teacher confirmation (model-proposed, not yet promoted). */
export function awaitingTeacherConfirmation(q: Question): boolean {
  return q.sampleAnswer?.source === 'model' || q.rubric?.source === 'model';
}

/**
 * #58 — the ONLY promotion. A teacher save:
 *  - stores their text (edited or newly written) with `source: 'teacher'`;
 *  - drops the model verdict instead of pretending the teacher's text was re-verified;
 *  - clears the ACTIVE needs_rubric only when a valid rubric is actually present (a sample alone
 *    never satisfies the rubric requirement);
 *  - keeps the old probability as history.
 */
export function confirmTashrihi(question: Question, sampleText?: string, criteria?: RubricCriterion[], evidence?: string): Question {
  const next: Question = { ...question };
  const editedSample = sampleText?.trim();
  const sampleBody = editedSample || question.sampleAnswer?.text;
  if (sampleBody?.trim()) {
    const { evidence: _evidence, ...rest } = question.sampleAnswer || ({} as NonNullable<Question['sampleAnswer']>);
    next.sampleAnswer = {
      ...rest,
      text: sampleBody.trim(),
      source: 'teacher',
      // A teacher edit is not a model verdict: keep the old probability as history, drop the
      // verdict. The CONFIRMATION-time evidence is kept so a later change can ask for a
      // reconfirmation without ever deleting the teacher's text.
      judged: 'unjudged',
      stale: false,
      ...(evidence ? { evidence } : {}),
    };
  } else if (question.sampleAnswer) delete next.sampleAnswer;
  const validCriteria = criteria && validateRubric(criteria, question.points).ok ? criteria : undefined;
  const rubricBody = validCriteria || question.rubric?.criteria;
  if (rubricBody?.length) {
    const { evidence: _evidence, ...rest } = question.rubric || ({} as NonNullable<Question['rubric']>);
    next.rubric = { ...rest, criteria: rubricBody, source: 'teacher', judged: 'unjudged', stale: false, ...(evidence ? { evidence } : {}) };
  } else if (question.rubric) delete next.rubric;
  const rubricConfirmed = Boolean(next.rubric && next.rubric.source === 'teacher' && validateRubric(next.rubric.criteria, question.points).ok);
  next.tags = (question.tags || []).filter(tag => !(tag === 'needs_rubric' && rubricConfirmed));
  return next;
}

/** Structured-export rule: rejected artifacts are record-only, everything else travels. */
export function exportableTashrihi<T extends { judged?: string } | undefined>(artifact: T): T | undefined {
  return artifact && artifact.judged === 'rejected' ? undefined : artifact;
}

const TASHRIHI_SYSTEM = 'Write model sample answers and grading rubrics for descriptive exam tasks in the exam language. For each question write sampleAnswer — a model answer that completes the task as asked (one sentence for a topic-sentence task, a whole paragraph for a paragraph task) — and rubric — 2 to 4 grading criteria, each a short criterion with maxPoints that add up to the question points when points are given (never zero or negative; use at most four decimal places). Use only the question, passage, listening script and pictures supplied: no outside facts, no invented material. Return JSON only: {"corrections":[{"questionNumber":"55A","sampleAnswer":"...","rubric":[{"criterion":"...","maxPoints":1}]}]}. Use the exact label supplied as questionNumber. /no_think';

const TASHRIHI_SAMPLE_ONLY = TASHRIHI_SYSTEM.replace('write sampleAnswer — a model answer that completes the task as asked (one sentence for a topic-sentence task, a whole paragraph for a paragraph task) — and rubric — 2 to 4 grading criteria, each a short criterion with maxPoints that add up to the question points when points are given (never zero or negative; use at most four decimal places).', 'write sampleAnswer — a model answer that completes the task as asked. Omit rubric.');
const TASHRIHI_RUBRIC_ONLY = TASHRIHI_SYSTEM.replace('write sampleAnswer — a model answer that completes the task as asked (one sentence for a topic-sentence task, a whole paragraph for a paragraph task) — and rubric — 2 to 4 grading criteria, each a short criterion with maxPoints that add up to the question points when points are given (never zero or negative; use at most four decimal places).', 'write rubric — 2 to 4 grading criteria whose maxPoints add up to the question points when given (positive only, at most four decimal places). Omit sampleAnswer.');

export type TashrihiPart = 'both' | 'sample' | 'rubric';

/**
 * Generate (or regenerate) model sample answers + rubrics for every eligible item.
 * Teacher-confirmed artifacts are never overwritten by a rerun; stale model artifacts are cleared
 * first so an unavailable/failed run cannot carry yesterday's proposal forward.
 */
export async function generatePackageTashrihi(doc: ExamDoc, settings: AppSettings, options: {
  caller?: (request: import('../types').LLMRequest) => Promise<Pick<import('../types').LLMResponse, 'json' | 'rawText'>>;
  onProgress?: (message: string) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText: string }) => Promise<void>;
  /** Addressed image bundle per question (already limited to the endpoint's capacity). */
  loadBundle?: (question: Question) => Promise<ImageBundle | undefined>;
  /** #58 Part F — live output of the same call that produces the artifacts. */
  onStream?: (text: string) => void;
} = {}): Promise<string[]> {
  for (const q of doc.questions) {
    if (q.sampleAnswer?.source !== 'teacher') delete q.sampleAnswer;
    if (q.rubric?.source !== 'teacher') delete q.rubric;
  }
  const eligible = tashrihiItems(doc);
  if (!eligible.length) return [];
  const provider = localProviderFor(settings, 'read');
  if (!provider) return [`sample answers & rubrics: 0 of ${eligible.length} tashrihi items proposed — no local generative read provider configured.`];
  const decide = settings.roleMapping.decide;
  const decisionProvider = decide && settings.providers.find(p => p.id === decide.providerId);
  if (decide && decide.model === provider.model && (decide.providerId === provider.id || (decisionProvider?.baseURL && decisionProvider.baseURL.replace(/\/+$/, '') === provider.baseURL.replace(/\/+$/, '')))) {
    return [`sample answers & rubrics: 0 of ${eligible.length} tashrihi items proposed — the read role selects the decision model.`];
  }
  const notes: string[] = [];
  let malformed = 0;
  let omittedBatches = 0;
  let failedBatches = 0;
  let skippedNoEvidence = 0;
  const noPixels: string[] = [];

  const applyRows = (rows: any[], batch: Question[], part: TashrihiPart): Set<string> => {
    const seen = new Set<string>();
    const eligibleLabels = new Set(batch.map(q => q.label));
    for (const row of rows) {
      const label = String(row?.questionNumber ?? row?.label ?? '');
      if (!eligibleLabels.has(label) || seen.has(label)) continue;
      const question = batch.find(q => q.label === label)!;
      let wrote = false;
      if (part !== 'rubric' && typeof row?.sampleAnswer === 'string' && row.sampleAnswer.trim() && !question.sampleAnswer) {
        question.sampleAnswer = { text: row.sampleAnswer.trim(), source: 'model', judged: 'unjudged', evidence: evidenceFingerprint(doc, question) };
        wrote = true;
      }
      if (part !== 'sample' && !question.rubric) {
        let criteria = rubricCriteria(row?.rubric, question.points);
        // One adjusted attempt in the SAME response when the distribution was unusable.
        if (!criteria && Array.isArray(row?.rubric) && row.rubric.length > 4) criteria = rubricCriteria(row.rubric.slice(0, 4), question.points);
        if (criteria) {
          question.rubric = { criteria, source: 'model', judged: 'unjudged', evidence: rubricFingerprint(doc, question, criteria) };
          wrote = true;
        }
      }
      if (wrote) seen.add(label);
    }
    return seen;
  };

  const run = async (batch: Question[], section: string, part: TashrihiPart = 'both'): Promise<void> => {
    const bundles = new Map<string, ImageBundle | undefined>();
    if (options.loadBundle) for (const q of batch) bundles.set(q.id, await options.loadBundle(q));
    // Evidence gate: a question whose picture cannot be addressed is not drafted from text alone.
    const usable = batch.filter(q => {
      const bundle = bundles.get(q.id);
      if (!bundle || bundle.required === 0) return true;
      if (bundle.complete) return true;
      skippedNoEvidence++;
      if (!noPixels.includes(q.label)) noPixels.push(q.label);
      return false;
    });
    if (!usable.length) return;
    const system = part === 'sample' ? TASHRIHI_SAMPLE_ONLY : part === 'rubric' ? TASHRIHI_RUBRIC_ONLY : TASHRIHI_SYSTEM;
    const usesImages = usable.filter(q => (bundles.get(q.id)?.payloads.length || 0) > 0);
    // A single addressed bundle per request: image-bearing questions are drafted alone, text-only
    // questions keep their ≤4 batch.
    const groups: Question[][] = usesImages.length ? usable.map(q => [q]) : [usable];
    for (const group of groups) {
      const text = JSON.stringify({
        language: doc.meta.language,
        section,
        questions: group.map(q => ({
          number: /^\d+$/.test(q.label) ? q.no : q.label,
          label: q.label,
          type: q.type,
          stem: q.stem,
          passage: doc.passages?.find(p => p.id === q.passageId)?.text,
          script: q.imported?.script || q.imported?.transcript,
          points: q.points,
          sampleAnswer: null,
          rubric: null,
        })),
      });
      const images = group.flatMap(q => bundles.get(q.id)?.payloads || []);
      const request: import('../types').LLMRequest = {
        role: 'read', system, text, providerConfig: provider,
        ...(images.length ? { images } : {}),
        label: `Package tashrihi · ${section}`, maxOutputTokens: Math.min(8192, Math.max(512, group.length * 320)),
      };
      options.onProgress?.(`Tashrihi · ${section}${images.length ? ' · pictures' : ''}`);
      try {
        const response = await (options.caller
          ? options.caller(request)
          : LLMAdapter.execute(request, options.onStream ? { onDelta: (_channel, fullText) => options.onStream!(fullText) } : undefined));
        let value: any = response.json;
        if (response.rawText?.trim()) {
          try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
          catch {
            // #58 — nested-aware salvage: a complete question object containing a rubric object
            // survives a truncated batch; incomplete objects are never guessed.
            value = { corrections: salvageJsonObjects(response.rawText) };
            malformed++;
          }
        }
        const rows = Array.isArray(value?.corrections) ? value.corrections : Array.isArray(value) ? value : [];
        const seen = applyRows(rows, group, part);
        if (seen.size < group.length) omittedBatches++;
        try { await options.onJournal?.({ label: request.label, rawText: response.rawText || JSON.stringify(value), requestText: JSON.stringify({ system, text }) }); } catch { /* journal best effort */ }
      } catch {
        failedBatches++;
      }
    }
  };

  // Never mix instruction groups or sections, and never send more than four items.
  const groups = new Map<string, Question[]>();
  for (const q of eligible) {
    const memberships = (doc.instructionGroups || []).map((g, i) => (q.no >= g.appliesToFirst && q.no <= g.appliesToLast ? i : -1)).filter(i => i >= 0);
    const key = JSON.stringify([q.sectionId, doc.instructionGroups || q.imported?.instructionGroups || q.imported?.instruction_groups || q.imported?.instructions || (memberships.length ? memberships : null)]);
    groups.set(key, [...(groups.get(key) || []), q]);
  }
  for (const questions of groups.values()) {
    const section = doc.sections.find(s => s.id === questions[0].sectionId)?.title || 'Section';
    for (let i = 0; i < questions.length; i += 4) {
      const batch = questions.slice(i, i + 4);
      await run(batch, section);
      // Scope the retry to the missing PART only, once, and never re-ask for a part that exists.
      const missingSample = batch.filter(q => !q.sampleAnswer);
      const missingRubric = batch.filter(q => !q.rubric);
      if (!missingSample.length && !missingRubric.length) continue;
      const onlySample = missingSample.length && !missingRubric.length;
      const onlyRubric = missingRubric.length && !missingSample.length;
      const retry = onlySample ? missingSample : onlyRubric ? missingRubric : batch.filter(q => !q.sampleAnswer || !q.rubric);
      await run(retry.slice(0, 4), section, onlySample ? 'sample' : onlyRubric ? 'rubric' : 'both');
    }
  }
  const proposed = doc.questions.filter(q => q.sampleAnswer || q.rubric).length;
  const withSample = doc.questions.filter(q => q.sampleAnswer).length;
  const withRubric = doc.questions.filter(q => q.rubric).length;
  notes.push(`sample answers & rubrics: ${proposed} of ${eligible.length} tashrihi items proposed (${withSample} sample · ${withRubric} rubric)`);
  if (skippedNoEvidence) notes.push(`sample answers & rubrics: ${skippedNoEvidence} item(s) not drafted because their picture${skippedNoEvidence > 1 ? 's were' : ' was'} unavailable (${noPixels.slice(0, 4).map(label => `Q${label}`).join(', ')}${noPixels.length > 4 ? ', …' : ''}) — no text-only guess was verified.`);
  if (proposed < eligible.length) {
    const parts = [
      ...(failedBatches ? [`generation failed for ${failedBatches} batch call(s)`] : []),
      ...(malformed ? [`${malformed} malformed response(s)`] : []),
      ...(omittedBatches ? [`${omittedBatches} batch(es) omitted or malformed items`] : []),
    ];
    notes.push(`tashrihi generation incomplete: ${parts.length ? parts.join(', ') : 'no usable rows returned'} — ${eligible.length - proposed} of ${eligible.length} items still missing after one scoped retry each.`);
  }
  return [...new Set(notes)];
}
