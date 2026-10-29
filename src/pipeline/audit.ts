/** #43 Part B — Decision Audit layer.
 *
 * The canonical `decide` role casts calibrated probability votes over a deterministic
 * audit catalogue; code routes, generative models fix, and teachers decide. The
 * decision model never authors text and never edits.
 *
 * Routing (global, visible thresholds):
 *   p >= 0.80  → pass, nothing to do
 *   p <= 0.20  → confident-wrong catch:
 *                active mode  → one scoped generative re-ask quoting the audit,
 *                                then the teacher via the attention list
 *                shadow mode  → counted + journaled + reported, never routed,
 *                                never auto-promoted (default)
 *   0.20 < p < 0.80 → audit-uncertain: report-only, unless another defect already
 *                touches the same question (noted as evidence for the teacher)
 *
 * Decisions are content-hash cached (record hash + question name + model). The layer
 * never consumes the read allowance or the repair budget. No `decide` role configured
 * → the layer is skipped and never an error.
 */
import type { AppSettings, AuditSummary, ExamDoc, ImageAsset, ProviderConfig, Question, SourceLine } from '../types';
import { sha256 } from '../utils/hash';
import { estimateTokens } from '../pipeline/memory/tokens';
import { getPipelineCache, setPipelineCache } from '../store';
import { LLMAdapter } from '../providers/adapter';
import type { CompileDefect } from './compile';
import { scopedReask } from './compile';
import type { RepairState } from './repairLoop';
import { lineNo } from './classify';

/** #52: noul bands are unchanged, NOT empirically calibrated. The synthetic-65-v1
 * SCRIPTED Check→Fix harness catches 7/7 plants with 0/67 clean-unit indictments;
 * that proves routing only, not model reliability. Field evidence: ratification hedges
 * at .55–.77; blind choices agree on 50, disagree on 2 ambiguous, flat on 6;
 * thematic sentence choices 4/4 at .97–.98. These are not per-kind ROC estimates.
 * Use `npm run calibrate:decide -- --live` before promotion. No per-kind threshold
 * adjustments are licensed without live fixture catch/false-alarm numbers in the PR. */
export const DECIDE_PASS = 0.80;
export const DECIDE_CATCH = 0.20;
export const DECIDE_TIMEOUT_MS = 30000;

export type DecisionType =
  | 'stem-faithful' | 'complete' | 'uncontaminated' | 'type-correct' | 'answer-correct'
  | 'points-plausible' | 'belongs-in-section' | 'image-belongs' | 'meta-plausible';

export interface DecisionItem {
  id: string;          // e.g. "Q3::stem-faithful" or "exam::meta-plausible"
  type: DecisionType;
  name: string;        // human name shown in journals/reports
  instructions: string; // the vote question sent to the decide model
  input: unknown;       // item-scoped evidence (sliced source text, never paraphrase)
  questionId?: string;
}

export interface DecisionVote {
  id: string;
  type: string;
  name: string;
  probability: number; // 0..1, P(item is sound)
  decision: 'pass' | 'catch' | 'uncertain';
  cached: boolean;
  latencyMs: number;
  inputTokens: number; // input-only token estimate; 0 for cache hits
  questionId?: string;
}

export interface AuditResult {
  summary: AuditSummary;
  votes: DecisionVote[];
  questions: Question[];          // potentially repaired by active-mode re-asks
  sections: ExamDoc['sections'];
  defects: CompileDefect[];       // kind 'audit-catch' survivors → the teacher
  calls: number;                  // decisions requests (outside read allowance / repair budget)
  usage: { inputTokens: number; outputTokens: number };
}

/** Content-hash cache key: record hash + question name + model. */
export async function decideCacheKey(fileHash: string, model: string, item: DecisionItem): Promise<string> {
  return await sha256(`decide:${fileHash}:${model}:${item.type}:${item.id}`);
}

function decisionOf(p: number): 'pass' | 'catch' | 'uncertain' {
  if (p >= DECIDE_PASS) return 'pass';
  if (p <= DECIDE_CATCH) return 'catch';
  return 'uncertain';
}

function clampProbability(p: unknown): number {
  const n = Number(p);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function makeVote(item: DecisionItem, p: number, cached: boolean, latencyMs: number, batchInputTokens: number): DecisionVote {
  return {
    id: item.id, type: item.type, name: item.name, probability: p,
    decision: decisionOf(p), cached, latencyMs,
    // input tokens are reported once at summary level (input-only estimate);
    // per-vote they stay 0 so summary.inputTokens is not multiplied.
    inputTokens: 0, ...(item.questionId ? { questionId: item.questionId } : {}),
  };
}

/** Every line a question claims: stem, options, answer. */
function questionNos(q: Question): number[] {
  const nos: number[] = [];
  const raw: any[] = (q as any).stemSpans || q.spans || [];
  for (const span of raw) {
    if (Array.isArray(span)) for (let n = Number(span[0]); n <= Number(span[1]); n++) nos.push(n);
    else if (span && typeof span === 'object' && Number.isInteger(span.line)) nos.push(span.line);
  }
  for (const o of q.options || []) for (const span of o.spans) if (Array.isArray(span)) for (let n = span[0]; n <= span[1]; n++) nos.push(n);
  if (q.answer?.spans) for (const span of q.answer.spans) if (Array.isArray(span)) for (let n = span[0]; n <= span[1]; n++) nos.push(n);
  return [...new Set(nos.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
}

function stemNos(q: Question): number[] {
  const raw: any[] = (q as any).stemSpans || q.spans || [];
  const nos: number[] = [];
  for (const span of raw) {
    if (Array.isArray(span)) for (let n = Number(span[0]); n <= Number(span[1]); n++) nos.push(n);
    else if (span && typeof span === 'object' && Number.isInteger(span.line)) nos.push(span.line);
  }
  return [...new Set(nos.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
}

function sliceLinesText(lines: SourceLine[], nos: number[]): string {
  const sorted = [...new Set(nos.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  return sorted.map(n => {
    const l = lines.find(x => lineNo(x) === n);
    return l ? `[L${lineNo(l)}] ${(l.text || '').trim()}` : `L${n}`;
  }).join(' ').slice(0, 1500);
}

/** Deterministic audit catalogue — one vote target per question/section/image/exam aspect. */
export function buildDecisionCatalogue(params: {
  doc: { questions: Question[]; sections: ExamDoc['sections']; images: ImageAsset[]; totalPoints?: number; meta?: ExamDoc['meta'] };
  lines: SourceLine[];
}): DecisionItem[] {
  const { doc, lines } = params;
  const items: DecisionItem[] = [];
  for (const q of doc.questions) {
    const stem = stemNos(q);
    const all = questionNos(q);
    const qRef = `Q${q.no}`;
    items.push({
      id: `${qRef}::stem-faithful`, type: 'stem-faithful', name: `${qRef} stem-faithful`, questionId: q.id,
      instructions: 'Does the printed question text match its claimed source lines exactly, with nothing added, dropped, or reordered?',
      input: { no: q.no, stem: q.stem, sourceLines: sliceLinesText(lines, stem) },
    });
    items.push({
      id: `${qRef}::complete`, type: 'complete', name: `${qRef} complete`, questionId: q.id,
      instructions: 'Does the question carry everything its printed type requires (options for multiple-choice / true-false / matching / multi-answer)?',
      input: { no: q.no, type: q.type, optionCount: (q.options || []).length, sourceLines: sliceLinesText(lines, all) },
    });
    items.push({
      id: `${qRef}::uncontaminated`, type: 'uncontaminated', name: `${qRef} uncontaminated`, questionId: q.id,
      instructions: 'Does the question avoid text that belongs to another question or to a reading passage?',
      input: { no: q.no, sourceLines: sliceLinesText(lines, all) },
    });
    items.push({
      id: `${qRef}::type-correct`, type: 'type-correct', name: `${qRef} type-correct`, questionId: q.id,
      instructions: 'Is the question type consistent with its structure (options only for choice types; a stem for every question)?',
      input: { no: q.no, type: q.type, optionCount: (q.options || []).length, sourceLines: sliceLinesText(lines, all) },
    });
    items.push({
      id: `${qRef}::answer-correct`, type: 'answer-correct', name: `${qRef} answer-correct`, questionId: q.id,
      instructions: 'If a printed answer letter exists, does it match one of the option keys?',
      input: { no: q.no, answer: q.answer?.text, optionKeys: (q.options || []).map(o => o.key) },
    });
    items.push({
      id: `${qRef}::points-plausible`, type: 'points-plausible', name: `${qRef} points-plausible`, questionId: q.id,
      instructions: 'Are the printed points plausible: a positive number consistent with the section and the paper total?',
      input: { no: q.no, points: q.points, totalPoints: doc.totalPoints, sourceLines: sliceLinesText(lines, all) },
    });
  }
  for (const s of doc.sections) {
    items.push({
      id: `section-${s.index}::belongs-in-section`, type: 'belongs-in-section',
      name: `Section ${s.index} ${s.title || ''} belongs-in-section`,
      instructions: 'Do all questions assigned to this section belong under this header?',
      input: { index: s.index, title: s.title, questionNos: doc.questions.filter(q => q.sectionId === s.id).map(q => q.no) },
    });
  }
  for (const img of doc.images) {
    if (img.label?.role === 'decoration' || img.label?.kind === 'decoration' || img.duplicateOf) continue;
    items.push({
      id: `image-${img.id}::image-belongs`, type: 'image-belongs', name: `Image ${img.id} image-belongs`,
      instructions: 'Is this image correctly paired with the question it is anchored to?',
      input: { imageId: img.id, page: img.page, anchorLine: img.anchorLine, caption: img.label?.caption },
    });
  }
  items.push({
    id: 'exam::meta-plausible', type: 'meta-plausible', name: 'Exam meta-plausible',
    instructions: 'Are the exam metadata (subject, grade, printed total points) plausible for this paper?',
    input: { subject: doc.meta?.subject, grade: doc.meta?.grade, totalPoints: doc.totalPoints },
  });
  return items;
}

function decideProviderFor(settings: AppSettings): { provider: ProviderConfig; model: string } | undefined {
  const selection = settings.roleMapping.decide;
  if (!selection) return undefined;
  const provider = settings.providers.find(p => p.id === selection.providerId) || settings.providers[0];
  if (!provider) return undefined;
  return { provider, model: selection.model };
}

async function defaultDecideCaller(provider: ProviderConfig, model: string) {
  return async (body: { input: unknown; questions: DecisionItem[] }) => {
    return await LLMAdapter.executeDecisions({ providerConfig: { ...provider, model }, body, timeoutMs: DECIDE_TIMEOUT_MS });
  };
}

export async function runDecisionAudit(params: {
  doc: { questions: Question[]; sections: ExamDoc['sections']; images: ImageAsset[]; totalPoints?: number; meta?: ExamDoc['meta'] };
  lines: SourceLine[];
  settings: AppSettings;
  fileHash: string;
  /** Decisions endpoint caller (defaults to LLMAdapter.executeDecisions). */
  decisionCaller?: (body: { input: unknown; questions: DecisionItem[] }) => Promise<{ results: Array<{ name: string; probability: number; choice?: string }> }>;
  /** Scoped generative re-ask for active-mode catches (read role). */
  caller?: (req: { system: string; text: string; maxOutputTokens?: number; label: string }) => Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
  cloudCaller?: (req: { system: string; text: string; maxOutputTokens?: number; label: string }) => Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
  keyLineNos?: number[];
  failedPages?: number[];
  existingDefects?: Array<{ questionIds: string[] }>;
  onJournal?: (entry: { label: string; rawText: string; requestText?: string }) => void | Promise<void>;
}): Promise<AuditResult> {
  const { doc, lines, settings, fileHash, keyLineNos = [], failedPages = [], existingDefects = [], onJournal } = params;
  const questions = [...doc.questions];
  const sections = [...doc.sections];
  const votes: DecisionVote[] = [];
  const defects: CompileDefect[] = [];
  let calls = 0; let catches = 0; let uncertain = 0; let latencySum = 0;
  let batchInputTokens = 0;

  const resolved = decideProviderFor(settings);
  const mode = settings.decideMode ?? 'shadow';

  const skippedSummary: AuditSummary = {
    mode: 'skipped', skipReason: 'no decide role',
    decisions: 0, catches: 0, uncertain: 0,
    meanLatencyMs: 0, inputTokens: 0, estimatedCostUsd: 0,
  };
  if (!resolved) {
    return { summary: skippedSummary, votes, questions, sections, defects, calls: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  const { provider, model } = resolved;

  const catalogue = buildDecisionCatalogue({ doc, lines });
  const failedLineNos = new Set<number>();
  for (const line of lines) if (failedPages.includes(line.page)) failedLineNos.add(lineNo(line));

  // --- Content-hash cache: record hash + question name + model (cache hits cost nothing). ---
  const unresolved: DecisionItem[] = [];
  for (const item of catalogue) {
    const key = await decideCacheKey(fileHash, model, item);
    let cached: { probability: number } | undefined;
    try { cached = await getPipelineCache<{ probability: number }>(key); } catch { cached = undefined; }
    if (cached?.probability !== undefined) {
      const p = clampProbability(cached.probability);
      const vote = makeVote(item, p, true, 0, 0);
      latencySum += vote.latencyMs;
      votes.push(vote);
    } else unresolved.push(item);
  }

  // --- One OpenAI-shaped decisions request for everything uncached (no streaming, 30s timeout). ---
  let transportError: string | undefined;
  if (unresolved.length) {
    const requestBody = {
      input: { exam: fileHash.slice(0, 12), lines: lines.length, questions: doc.questions.length, sections: doc.sections.length, images: doc.images.length },
      // results are matched back by item id, so the id travels as the vote name.
      questions: unresolved.map(item => ({ ...item, name: item.id })),
    };
    const start = Date.now();
    try {
      const data = await (params.decisionCaller || await defaultDecideCaller(provider, model))(requestBody);
      const batchLatencyMs = Date.now() - start;
      batchInputTokens = estimateTokens(JSON.stringify(requestBody));
      calls = 1;
        const byName = new Map<string, number>();
      for (const result of data.results || []) byName.set(String(result.name), clampProbability(result.probability));
      for (const item of unresolved) {
        const p = byName.get(item.id);
        if (p === undefined) {
          // The endpoint returned no verdict for this item: treat as uncertain, never as a catch.
          const vote = makeVote(item, 0.5, false, Date.now() - start, 0);
          latencySum += vote.latencyMs;
          votes.push(vote);
        } else {
          const vote = makeVote(item, p, false, batchLatencyMs, batchInputTokens);
          latencySum += vote.latencyMs;
          votes.push(vote);
          try { await setPipelineCache(await decideCacheKey(fileHash, model, item), { probability: p }); } catch { /* cache writes are best-effort */ }
        }
      }
    } catch (err: any) {
      transportError = String(err?.message || err);
      const batchLatencyMs = Date.now() - start;
      // A decisions endpoint meltdown is maximum uncertainty: vote uncertain,
      // never a catch, so no defects and no teacher attention are manufactured.
      for (const item of unresolved) {
        const vote = makeVote(item, 0.5, false, batchLatencyMs, 0);
        latencySum += vote.latencyMs;
        votes.push(vote);
      }
    }
  }

  // --- Probability routing. ---
  const state: RepairState = { questions, sections };
  const reaskBudget = { calls: 0, units: 0, maxCalls: 20, maxUnits: 200 };

  for (const vote of votes) {
    const item = catalogue.find(i => i.id === vote.id)!;
    const detail = `Decision audit (p=${vote.probability.toFixed(2)}): ${item.type} — ${item.instructions}`;
    await onJournal?.({ label: `Decision Audit · ${vote.type} · ${vote.name}`, rawText: `${detail} → ${vote.decision}${vote.cached ? ' (cached)' : ''}`, requestText: undefined });

    if (vote.decision === 'pass') continue;

    if (vote.decision === 'catch') {
      catches++;
      if (mode === 'shadow') {
        await onJournal?.({ label: 'Decision Audit · shadow — not routed', rawText: `catch ${vote.name} (p=${vote.probability.toFixed(2)}) is not routed in shadow mode`, requestText: undefined });
        continue;
      }
      // Active: one precise scoped generative re-ask quoting the audit, then the teacher.
      const qId = vote.questionId;
      if (!qId) continue;
      const q = state.questions.find(x => x.id === qId);
      if (!q) continue;
      const lineIds = questionNos(q);
      const defect: CompileDefect = {
        id: `audit-${vote.id}`, kind: 'audit-catch', questionIds: [qId], lineIds, detail,
        evidence: lineIds.map(n => ({ line: n, text: (lines.find(x => lineNo(x) === n)?.text || '').slice(0, 140) })),
      };
      const questionLines = lines.filter(l => lineIds.includes(lineNo(l))).sort((a, b) => lineNo(a) - lineNo(b));
      const blockNos = new Set(lineIds);
      const contextLines: SourceLine[] = [];
      for (const n of blockNos) for (let o = n - 5; o <= n + 5; o++) {
        const l = lines.find(x => lineNo(x) === o);
        if (l && !blockNos.has(lineNo(l))) contextLines.push(l);
      }
      contextLines.sort((a, b) => lineNo(a) - lineNo(b));

      const result = await scopedReask({
        defect, questionLines, contextLines, state, lines,
        keyLineNos, failedLineNos, caller: params.caller, cloudCaller: params.cloudCaller,
        onJournal, budget: reaskBudget,
      });
      if (!result.closed) defects.push(defect); // survived the re-ask → the teacher
    }

    if (vote.decision === 'uncertain') {
      uncertain++;
      const touched = Boolean(vote.questionId) && existingDefects.some(d => d.questionIds.includes(vote.questionId!));
      await onJournal?.({ label: 'Decision Audit · audit-uncertain', rawText: `uncertain ${vote.name} (p=${vote.probability.toFixed(2)})${touched ? ' — question already has a compile/repair defect; noted as evidence' : ''}`, requestText: undefined });
    }
  }

  const rate = settings.costTable[model]?.inputCostPerMillion;
  const summary: AuditSummary = {
    mode,
    decisions: votes.length,
    catches,
    uncertain,
    meanLatencyMs: votes.length ? Math.round(latencySum / votes.length) : 0,
    inputTokens: batchInputTokens,
    estimatedCostUsd: batchInputTokens > 0 && typeof rate === 'number' ? Number(((batchInputTokens / 1_000_000) * rate).toFixed(6)) : 0,
    ...(transportError ? { transportError } : {}),
    ...(mode === 'shadow' ? { agreementByItem: buildAgreementByItem(votes, existingDefects) } : {}),
  };
  return {
    summary, votes, questions: state.questions, sections: state.sections, defects,
    calls, usage: { inputTokens: batchInputTokens, outputTokens: 0 },
  };
}

function buildAgreementByItem(votes: DecisionVote[], existingDefects: Array<{ questionIds: string[] }>): AuditSummary['agreementByItem'] {
  const out: Record<string, { agreements: number; decisions: number; rate: number }> = {};
  for (const vote of votes) {
    const touched = Boolean(vote.questionId) && existingDefects.some(d => d.questionIds.includes(vote.questionId as string));
    const agree = (vote.decision === 'catch') === touched;
    const cur = out[vote.id] || { agreements: 0, decisions: 0, rate: 0 };
    cur.decisions++; if (agree) cur.agreements++; cur.rate = cur.agreements / cur.decisions;
    out[vote.id] = cur;
  }
  return out;
}
