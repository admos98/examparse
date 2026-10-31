/** #57 Part A — judged sample answers and rubrics for keyless descriptive (tashrihi) items.
 *
 * The local generative role (read) writes a model sample answer and a 2–4 criterion rubric in the
 * same explain-stage batching as explanations (≤4 per call, salvage + one retry). The decision
 * judge then grades each artifact with a single clause; routing is ≥0.80 verified · ≤0.20
 * rejected (suppressed from exports, record-only) · middle uncertain (structured export only).
 * Teacher confirmation in Step 4 is the ONLY promotion: it flips `source` to 'teacher' and clears
 * the needs_rubric tag. Nothing about grading behaviour changes until that click.
 */
import type { AppSettings, ExamDoc, Question, RubricCriterion } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { localProviderFor } from './localProvider';

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

/** Build 2–4 rubric criteria. When the item has points, maxPoints are distributed to sum to them
 * exactly (even split, remainder on the last); without points the model's positive maxPoints stand. */
export function rubricCriteria(raw: unknown, points?: number | null): RubricCriterion[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return undefined;
  const criteria: RubricCriterion[] = [];
  for (const row of raw) {
    const value = row as Record<string, unknown> | null;
    const criterion = typeof value?.criterion === 'string' && value.criterion.trim()
      ? value.criterion.trim()
      : typeof value?.text === 'string' && value.text.trim() ? value.text.trim() : '';
    if (!criterion) return undefined;
    const maxPoints = Number(value?.maxPoints ?? value?.points);
    criteria.push({ criterion, maxPoints: Number.isFinite(maxPoints) && maxPoints > 0 ? maxPoints : 0 });
  }
  if (typeof points === 'number' && Number.isFinite(points) && points > 0) {
    const even = Math.round((points / criteria.length) * 4) / 4;
    criteria.forEach((criterion, index) => {
      criterion.maxPoints = index === criteria.length - 1
        ? Math.round((points - even * (criteria.length - 1)) * 100) / 100
        : even;
    });
  } else if (!criteria.every(criterion => criterion.maxPoints > 0)) {
    return undefined;
  }
  return criteria;
}

/** Whether an artifact still awaits teacher confirmation (model-proposed, not yet promoted). */
export function awaitingTeacherConfirmation(q: Question): boolean {
  return q.sampleAnswer?.source === 'model' || q.rubric?.source === 'model';
}

/** #57 Part A — the ONLY promotion: provenance flips to 'teacher' (teacher edits win) and the
 * needs_rubric tag clears. Pure so Step 4 and the acceptance tests share one implementation. */
export function confirmTashrihi(question: Question, sampleText?: string, criteria?: RubricCriterion[]): Question {
  return {
    ...question,
    ...(question.sampleAnswer ? {
      sampleAnswer: {
        ...question.sampleAnswer,
        ...(sampleText?.trim() ? { text: sampleText.trim() } : {}),
        source: 'teacher' as const,
      },
    } : {}),
    ...(question.rubric ? {
      rubric: {
        ...question.rubric,
        ...(criteria && criteria.length >= 2 ? { criteria } : {}),
        source: 'teacher' as const,
      },
    } : {}),
    tags: (question.tags || []).filter(tag => tag !== 'needs_rubric'),
  };
}

/** Structured-export rule: rejected artifacts are record-only, everything else travels. */
export function exportableTashrihi<T extends { judged?: string } | undefined>(artifact: T): T | undefined {
  return artifact && artifact.judged === 'rejected' ? undefined : artifact;
}

const TASHRIHI_SYSTEM = 'Write model sample answers and grading rubrics for descriptive exam tasks in the exam language. For each question write sampleAnswer — a model answer that completes the task as asked (one sentence for a topic-sentence task, a whole paragraph for a paragraph task) — and rubric — 2 to 4 grading criteria, each a short criterion with maxPoints that add up to the question points when points are given. Use only the question, passage and listening script: no outside facts, no invented material. Return JSON only: {"corrections":[{"questionNumber":"55A","sampleAnswer":"...","rubric":[{"criterion":"...","maxPoints":1}]}]}. Use the exact label supplied as questionNumber. /no_think';

/** Generate (or regenerate) model sample answers + rubrics for every eligible item.
 * Teacher-confirmed artifacts are never overwritten by a rerun; stale model artifacts are
 * cleared first so an unavailable/failed run cannot carry yesterday's proposal forward. */
export async function generatePackageTashrihi(doc: ExamDoc, settings: AppSettings, options: {
  caller?: (request: import('../types').LLMRequest) => Promise<Pick<import('../types').LLMResponse, 'json' | 'rawText'>>;
  onProgress?: (message: string) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText: string }) => Promise<void>;
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
  // #57 Part E — intermediate narration is counted here, never one line per section; it only
  // reaches the final notes when the final outcome is incomplete.
  let malformed = 0;
  let omittedBatches = 0;
  let failedBatches = 0;
  const run = async (batch: Question[], section: string) => {
    const text = JSON.stringify({
      language: doc.meta.language,
      section,
      questions: batch.map(q => ({
        number: /^\\d+$/.test(q.label) ? q.no : q.label,
        label: q.label,
        type: q.type,
        stem: q.stem,
        passage: doc.passages?.find(p => p.id === q.passageId)?.text,
        script: q.imported?.script,
        points: q.points,
        sampleAnswer: null,
        rubric: null,
      })),
    });
    const request: import('../types').LLMRequest = { role: 'read', system: TASHRIHI_SYSTEM, text, providerConfig: provider, label: `Package tashrihi · ${section}`, maxOutputTokens: Math.min(8192, Math.max(512, batch.length * 320)) };
    options.onProgress?.(`Tashrihi · ${section}`);
    try {
      const response = await (options.caller || ((r: import('../types').LLMRequest) => LLMAdapter.execute(r)))(request);
      let value: any = response.json;
      if (response.rawText?.trim()) {
        try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
        catch {
          // Salvage complete JSON objects, never guess truncated sample text or rubric rows.
          const rows: any[] = [];
          for (const m of response.rawText.matchAll(/\{[^{}]*\}/g)) { try { rows.push(JSON.parse(m[0])); } catch { /* incomplete object */ } }
          value = { corrections: rows };
          malformed++;
        }
      }
      const rows = Array.isArray(value?.corrections) ? value.corrections : [];
      const seen = new Set<string>();
      for (const row of rows) {
        const label = String(row?.questionNumber ?? row?.label ?? '');
        const matches = batch.filter(q => q.label === label);
        if (matches.length !== 1 || seen.has(label)) continue;
        const question = matches[0];
        let wrote = false;
        if (typeof row?.sampleAnswer === 'string' && row.sampleAnswer.trim()) {
          question.sampleAnswer = { text: row.sampleAnswer.trim(), source: 'model', judged: 'unjudged' };
          wrote = true;
        }
        const criteria = rubricCriteria(row?.rubric, question.points);
        if (criteria) {
          question.rubric = { criteria, source: 'model', judged: 'unjudged' };
          wrote = true;
        }
        if (wrote) seen.add(label);
      }
      if (seen.size < batch.length) omittedBatches++;
      try { await options.onJournal?.({ label: request.label, rawText: response.rawText || JSON.stringify(value), requestText: JSON.stringify({ system: TASHRIHI_SYSTEM, text }) }); } catch { /* journal best effort */ }
    } catch {
      failedBatches++;
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
      for (const q of batch.filter(q => !q.sampleAnswer && !q.rubric)) await run([q], section);
    }
  }
  const proposed = doc.questions.filter(q => q.sampleAnswer || q.rubric).length;
  // Outcome-first: one final-state line; the counted intermediate narration survives only
  // when the final outcome is incomplete (then still as ONE summary line with counts).
  notes.push(`sample answers & rubrics: ${proposed} of ${eligible.length} tashrihi items proposed`);
  if (proposed < eligible.length) {
    const parts = [
      ...(failedBatches ? [`generation failed for ${failedBatches} batch call(s)`] : []),
      ...(malformed ? [`${malformed} malformed response(s)`] : []),
      ...(omittedBatches ? [`${omittedBatches} batch(es) omitted or malformed items`] : []),
    ];
    notes.push(`tashrihi generation incomplete: ${parts.length ? parts.join(', ') : 'no usable rows returned'} — ${eligible.length - proposed} of ${eligible.length} items still missing after one retry each.`);
  }
  return [...new Set(notes)];
}
