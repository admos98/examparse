/** #43 Part A — The compiler: compile, don't reject.
 *
 * After a page proposal is parsed (#42 guarantees it never throws), the compiler
 * reconciles claim conflicts deterministically (code, bookkeeping only — no semantic
 * choices), then turns what remains into a scoped defect work list. Each defect gets
 * exactly one precise generative re-ask; invalid/declining answers fall back to the
 * cloud role once, then to the Decision Audit as evidence, then to the teacher.
 *
 * A page proposal is never discarded wholesale: compilation salvages everything
 * salvageable and only reaches `read-failed` when literally no question can be
 * salvaged from the page.
 */
import type { ExamDoc, Question, SourceLine } from '../types';
import { lineNo } from './classify';
import { computeDefects, type Defect, type DefectKind } from './defects';
import {
  applyRepairOp,
  makeRepairContext,
  parseRepairOps,
  type RepairOp,
  type RepairState,
  validateRepairOp,
} from './repairLoop';
import { sliceSourceSpans } from './spans';

export type CompileStatus = 'ok' | 'ok-reconciled' | 'partial' | 'read-failed';

export interface CompileReconciliation {
  id: string;
  kind: 'double-claim' | 'orphan-absorbed' | 'orphan-furniture' | 'question-dropped' | 'duplicate-number';
  page: number;
  lines: number[];
  questionIds: string[];
  detail: string;
}

export interface CompileDefect {
  id: string;
  kind: DefectKind;
  /** Exactly one question, or two for an inter-question boundary, or none. */
  questionIds: string[];
  lineIds: number[];
  detail: string;
  evidence: Array<{ line: number; text: string }>;
}

export interface CompileOptions {
  questions: Question[];           // assembled questions (mutated by reconciliation/re-asks)
  sections: ExamDoc['sections'];
  lines: SourceLine[];
  /** Lines accounted as furniture/section/instruction/passage/key (not question claims). */
  accountedLineNos?: number[];
  keyLineNos: number[];
  failedPages?: number[];
  /** Scoped generative re-ask (read role). One precise re-ask per defect. */
  caller?: (req: { system: string; text: string; maxOutputTokens?: number; label: string }) => Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
  cloudCaller?: (req: { system: string; text: string; maxOutputTokens?: number; label: string }) => Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
  budget?: { calls: number; units: number; maxCalls: number; maxUnits: number };
  onJournal?: (entry: { label: string; rawText: string; requestText?: string }) => void | Promise<void>;
}

export interface CompiledDocument {
  questions: Question[];
  sections: ExamDoc['sections'];
  reconciliations: CompileReconciliation[];
  defects: CompileDefect[];        // survivors → teacher
  closedDefects: CompileDefect[];  // fixed by code or by re-ask
  furnitureDropped: number[];      // lines declared furniture by code/re-ask
  pageStatus: Map<number, CompileStatus>;
  calls: number;                   // re-ask calls (read + cloud)
  usage: { inputTokens: number; outputTokens: number };
  journal: Array<{ label: string; rawText: string; requestText?: string }>;
}

const DEFAULT_BUDGET = { calls: 0, units: 0, maxCalls: 200, maxUnits: 2000 };
const MAX_EVIDENCE_CHARS = 140;
const MAX_EVIDENCE_LINES = 6;

/** Every line a question claims: stem spans, option spans, answer spans. */
function claimedNos(q: Question): number[] {
  const nos: number[] = [];
  const raw: any[] = (q as any).stemSpans || q.spans || [];
  for (const span of raw) {
    if (Array.isArray(span)) for (let n = Number(span[0]); n <= Number(span[1]); n++) nos.push(n);
    else if (span && typeof span === 'object' && Number.isInteger(span.line)) nos.push(span.line);
  }
  for (const o of q.options || []) for (const span of o.spans) if (Array.isArray(span)) for (let n = span[0]; n <= span[1]; n++) nos.push(n);
  if (q.answer?.spans) for (const span of q.answer.spans) if (Array.isArray(span)) for (let n = span[0]; n <= span[1]; n++) nos.push(n);
  return [...new Set(nos)].sort((a, b) => a - b);
}

function stemNos(q: Question): number[] {
  const raw: any[] = (q as any).stemSpans || q.spans || [];
  const nos: number[] = [];
  for (const span of raw) {
    if (Array.isArray(span)) for (let n = Number(span[0]); n <= Number(span[1]); n++) nos.push(n);
    else if (span && typeof span === 'object' && Number.isInteger(span.line)) nos.push(span.line);
  }
  return [...new Set(nos)].sort((a, b) => a - b);
}

function numberOf(q: Question): number { return Number(q.no) || 0; }

function pageOfLine(lines: SourceLine[], n: number): number | undefined {
  return lines.find(l => lineNo(l) === n)?.page;
}

function lineTextOf(lines: SourceLine[], n: number): string {
  return (lines.find(l => lineNo(l) === n)?.text || '').trim();
}

function completeness(q: Question): { lines: number; options: number } {
  return { lines: stemNos(q).length, options: (q.options || []).length };
}

function contiguousRuns(nos: number[]): Array<[number, number]> {
  const sorted = [...new Set(nos.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

function setSpans(q: Question, nos: number[], lines: SourceLine[]): void {
  const sorted = [...new Set(nos.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const spans: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = spans[spans.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else spans.push([n, n]);
  }
  q.spans = spans as any;
  (q as any).stemSpans = spans;
  q.stem = sliceSourceSpans(spans as any, lines).trim();
}

/** Remove one line from every span of a question (stem, options, answer) and coalesce. */
function removeLineFromQuestion(q: Question, n: number, lines: SourceLine[]): void {
  setSpans(q, stemNos(q).filter(m => m !== n), lines);
  for (const o of q.options || []) {
    const nos: number[] = [];
    for (const span of o.spans) if (Array.isArray(span)) for (let m = span[0]; m <= span[1]; m++) if (m !== n) nos.push(m);
    o.spans = contiguousRuns(nos) as any;
  }
  if (q.answer?.spans) {
    const nos: number[] = [];
    for (const span of q.answer.spans) if (Array.isArray(span)) for (let m = span[0]; m <= span[1]; m++) if (m !== n) nos.push(m);
    q.answer.spans = contiguousRuns(nos) as any;
  }
}

function evidence(lines: SourceLine[], nos: number[]): CompileDefect['evidence'] {
  return [...new Set(nos)].sort((a, b) => a - b).slice(0, MAX_EVIDENCE_LINES)
    .map(n => ({ line: n, text: lineTextOf(lines, n).slice(0, MAX_EVIDENCE_CHARS) }));
}

function asDefect(id: string, kind: DefectKind, questionIds: string[], lineIds: number[], detail: string, lines: SourceLine[]): CompileDefect {
  return { id, kind, questionIds, lineIds: [...new Set(lineIds)].sort((a, b) => a - b), detail, evidence: evidence(lines, lineIds) };
}

/**
 * The defect re-ask prompt: ONLY the scoped question's lines (±5 context lines),
 * the defect stated plainly, and the closed set of acceptable answer shapes
 * (the repair op vocabulary). Nothing else from the document is sent.
 */
export function compileDefectPrompt(params: {
  defect: CompileDefect;
  questionLines: SourceLine[];   // the scoped question's lines (or both sides of a boundary)
  contextLines: SourceLine[];    // ±5 read-only context, never claimed
  label: string;
}): string {
  const { defect, questionLines, contextLines, label } = params;
  const qBlock = questionLines.map(l => `[${l.id}] ${l.text}`).join('\n') || '(no source lines)';
  const ctxBlock = contextLines.length
    ? `\nCONTEXT (read only, never claim or relabel):\n${contextLines.map(l => `[${l.id}] ${l.text}`).join('\n')}`
    : '';
  const first = defect.lineIds[0]; const last = defect.lineIds[defect.lineIds.length - 1];
  const shapes = [
    `{"op":"assignLines","defect":"${defect.id}","lines":[${first},${last}],"questionId":"<question id>"} — make these lines part of that question.`,
    `{"op":"dropAsFurniture","defect":"${defect.id}","lines":[${first},${last}]} — the lines are page furniture, not exam content.`,
    `{"op":"breakQuestionAt","defect":"${defect.id}","line":${first}} — a new printed question starts at the first line.`,
    `{"op":"noFix","defect":"${defect.id}","reason":"..."} — you cannot fix this from the evidence.`,
  ].join('\n• ');
  return `ONE DEFECT ONLY — fix exactly this defect, nothing else. (${label})

DEFECT ${defect.id} (${defect.kind})
PROBLEM: ${defect.detail}

QUESTION LINES:
${qBlock}${ctxBlock}

Answer with exactly one operation from this closed vocabulary (JSON only, {"ops":[...]}):
• ${shapes}

Code validates preconditions before applying anything; you never write question text.
Return at most one operation for this defect.`;
}

/**
 * One precise generative re-ask for a single defect. Returns whether the defect was
 * closed by a validated operation. Used by the compiler and (via the same machinery)
 * by the Decision Audit for its confident-wrong catches.
 */
export async function scopedReask(params: {
  defect: CompileDefect;
  questionLines: SourceLine[];
  contextLines: SourceLine[];
  state: RepairState;
  lines: SourceLine[];
  keyLineNos: number[];
  failedLineNos: Set<number>;
  caller?: CompileOptions['caller'];
  cloudCaller?: CompileOptions['cloudCaller'];
  onJournal?: CompileOptions['onJournal'];
  budget?: { calls: number; units: number; maxCalls: number; maxUnits: number };
}): Promise<{ closed: boolean; calls: number; usage: { inputTokens: number; outputTokens: number }; complaints: string[] }> {
  const budget = params.budget || DEFAULT_BUDGET;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  const complaints: string[] = [];
  const ctx = makeRepairContext(params.state, params.lines, params.keyLineNos, [params.defect as any], []);
  ctx.failedLineNos = params.failedLineNos;

  const attempt = async (caller: CompileOptions['caller'] | undefined, reason: string): Promise<boolean> => {
    if (!caller) return false;
    if (budget.calls >= budget.maxCalls) return false;
    calls++; budget.calls++;
    const requestText = compileDefectPrompt({ defect: params.defect, questionLines: params.questionLines, contextLines: params.contextLines, label: `${params.defect.id} ${reason}` });
    let response;
    try { response = await caller({ system: 'You are ExamCompile. Return JSON only.', text: requestText, maxOutputTokens: 2048, label: `Compile · re-ask ${params.defect.id}` }); }
    catch (err: any) { complaints.push(`${reason} call failed: ${String(err?.message || err)}`); return false; }
    if (response.usage) { usage.inputTokens += response.usage.inputTokens || 0; usage.outputTokens += response.usage.outputTokens || 0; }
    await params.onJournal?.({ label: `Compile · re-ask ${params.defect.id}`, rawText: response.rawText, requestText });
    const parsed = parseRepairOps(response.rawText, response.json);
    for (const complaint of parsed.complaints) complaints.push(complaint);
    for (const op of parsed.ops) {
      if (op.op === 'noFix') continue; // declining → not a fix; try cloud, then the teacher
      const verdict = validateRepairOp(op, ctx);
      if (!verdict.ok) { complaints.push(`rejected ${op.op}: ${verdict.reason}`); continue; }
      try { applyRepairOp(op, ctx); return true; } catch (err: any) { complaints.push(`could not apply ${op.op}: ${String(err?.message || err)}`); }
    }
    return false;
  };

  const closed = await attempt(params.caller, 'local') || await attempt(params.cloudCaller, 'cloud');
  return { closed, calls, usage, complaints };
}

/**
 * Compile a parsed proposal: deterministic reconciliation, then one scoped re-ask
 * per remaining defect, in document order.
 */
export async function compileDocument(options: CompileOptions): Promise<CompiledDocument> {
  const { questions: inputQuestions, sections: inputSections, lines, keyLineNos = [], failedPages = [], accountedLineNos = [], caller, cloudCaller, onJournal, budget: optBudget } = options;
  const budget = optBudget || DEFAULT_BUDGET;
  const journal: CompiledDocument['journal'] = [];
  const reconciliations: CompileReconciliation[] = [];
  const closedDefects: CompileDefect[] = [];
  const furnitureDropped: number[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const failedLineNos = new Set<number>();
  for (const line of lines) if ((failedPages || []).includes(line.page)) failedLineNos.add(lineNo(line));
  const accounted = new Set(accountedLineNos || []);
  let recSeq = 0;
  const record = (kind: CompileReconciliation['kind'], page: number, lineNos: number[], questionIds: string[], detail: string) => {
    recSeq++;
    reconciliations.push({ id: `compile_${recSeq}`, kind, page, lines: [...lineNos].sort((a, b) => a - b), questionIds, detail });
    journal.push({ label: `Compile · ${kind}`, rawText: detail, requestText: undefined });
  };

  const state: RepairState = { questions: [...inputQuestions], sections: [...inputSections] };
  const lineByNo = new Map(lines.map(l => [lineNo(l), l]));
  const snapshotLineNos = new Map(state.questions.map(q => [q.id, claimedNos(q)]));

  const ownerOf = (n: number): Question | undefined => state.questions.find(q => claimedNos(q).includes(n));
  const questionPage = (q: Question): number | undefined => {
    const nos = stemNos(q);
    return nos.length ? pageOfLine(lines, Math.min(...nos)) : undefined;
  };

  // ------------------------------------------------------------
  // 1. Deterministic reconciliation: a line claimed by two questions — the FIRST
  //    claim (document order) keeps it; the later claim loses those lines.
  // ------------------------------------------------------------
  const ordered = [...state.questions].map((q, i) => ({ q, i, first: Math.min(...claimedNos(q)) })).sort((a, b) => a.first - b.first || a.i - b.i);
  const claims = new Map<number, string[]>();
  for (const { q } of ordered) for (const n of claimedNos(q)) { const list = claims.get(n); if (list) list.push(q.id); else claims.set(n, [q.id]); }

  const claimsSnapshot = new Map(claims);
  for (const [n, owners] of claimsSnapshot) {
    if (owners.length < 2) continue;
    const keeper = owners[0];
    for (const loserId of owners.slice(1)) {
      const loser = state.questions.find(q => q.id === loserId);
      if (!loser) continue;
      const page = pageOfLine(lines, n) || 0;
      removeLineFromQuestion(loser, n, lines);
      record('double-claim', page, [n], [keeper, loserId],
        `line ${n} was claimed by Q${keeper} and Q${loserId}; the first claim (document order, Q${keeper}) keeps it and Q${loserId} loses it`);
    }
  }

  // ------------------------------------------------------------
  // Questions whose spans were entirely stolen by reconciliation: dropped, recorded.
  // ------------------------------------------------------------
  const emptied = state.questions.filter(q => claimedNos(q).length === 0);
  for (const q of emptied) {
    const before = snapshotLineNos.get(q.id) || [];
    const page = questionPage(q) || (before.length ? pageOfLine(lines, before[0] ?? 0) || 0 : 0);
    state.questions = state.questions.filter(x => x.id !== q.id);
    record('question-dropped', page, before, [q.id],
      `question Q${q.no} lost all of its lines to reconciliation and was dropped; its printed number Q${q.no} is now missing from the page`);
  }

  // ------------------------------------------------------------
  // 2. Duplicate printed numbers after reconciliation: keep the more complete record
  //    (more stem lines, then more options); drop the other, recorded.
  // ------------------------------------------------------------
  const byNo = new Map<number, Question[]>();
  for (const q of state.questions) {
    const n = numberOf(q);
    const list = byNo.get(n);
    if (list) list.push(q); else byNo.set(n, [q]);
  }
  for (const [no, group] of byNo) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const ca = completeness(a); const cb = completeness(b);
      if (cb.lines !== ca.lines) return cb.lines - ca.lines;
      if (cb.options !== ca.options) return cb.options - ca.options;
      return Math.min(...claimedNos(a)) - Math.min(...claimedNos(b));
    });
    const keeper = group[0];
    for (const loser of group.slice(1)) {
      const before = claimedNos(loser);
    const page = pageOfLine(lines, before[0] ?? 0) || 0;
    state.questions = state.questions.filter(x => x.id !== loser.id);
      record('duplicate-number', page, before, [keeper.id, loser.id],
        `printed number ${no} appears on ${group.length} question records; kept the more complete record Q${keeper.no} and dropped Q${loser.no}`);
    }
  }

  // ------------------------------------------------------------
  // Furniture by ≥3-page repetition: identical line text on ≥3 pages is page
  // furniture (running headers/footers/page numbers), never a claim. Code never
  // invents boundaries — it only classifies lines the document repeats everywhere.
  // ------------------------------------------------------------
  const textPages = new Map<string, Set<number>>();
  for (const line of lines) {
    const t = (line.text || '').trim();
    if (!t) continue;
    let pages = textPages.get(t);
    if (!pages) { pages = new Set(); textPages.set(t, pages); }
    pages.add(line.page);
  }
  for (const [t, pages] of textPages) {
    if (pages.size < 3) continue;
    const nos: number[] = [];
    const firstPage = pages.values().next().value as number;
    for (const line of lines) {
      if ((line.text || '').trim() !== t) continue;
      accounted.add(lineNo(line));
      nos.push(lineNo(line));
      furnitureDropped.push(lineNo(line));
    }
    record('orphan-furniture', firstPage, nos, [],
      `line text “${t.slice(0, 60)}” appears on ${pages.size} pages; treated as page furniture, not a claim`);
  }

  // ------------------------------------------------------------
  // 3. Unclaimed lines → code absorbs interior runs; everything else is a defect.
  // ------------------------------------------------------------
  const recomputeClaims = () => new Set(state.questions.flatMap(q => claimedNos(q)));
  const unclaimedRuns = (): Array<[number, number]> => {
    const claimed = recomputeClaims();
    const unclaimed: number[] = [];
    for (const line of lines) {
      const n = lineNo(line);
      if (claimed.has(n) || accounted.has(n) || failedLineNos.has(n)) continue;
      if ((line.text || '').trim().length === 0) continue;
      unclaimed.push(n);
    }
    return contiguousRuns(unclaimed);
  };

  // Absorb runs sitting between two lines of the same question, to a fixpoint.
  let absorbedAny = true;
  while (absorbedAny) {
    absorbedAny = false;
    for (const [s, e] of unclaimedRuns()) {
      const leftOwner = s > 1 ? ownerOf(s - 1) : undefined;
      const rightOwner = ownerOf(e + 1);
      if (leftOwner && rightOwner && leftOwner.id === rightOwner.id) {
        const q = leftOwner;
        const nos = [...claimedNos(q), ...Array.from({ length: e - s + 1 }, (_, i) => s + i)];
        setSpans(q, nos, lines);
        record('orphan-absorbed', pageOfLine(lines, s) || 0, Array.from({ length: e - s + 1 }, (_, i) => s + i), [q.id],
          `lines ${s}–${e} were claimed by nobody and sit between two lines of question Q${q.no}; absorbed into Q${q.no}`);
        absorbedAny = true;
      }
    }
  }

  // Remaining unclaimed runs = the defect work list.
  const workList: CompileDefect[] = [];
  let defectSeq = 0;
  const newDefect = (kind: DefectKind, questionIds: string[], lineIds: number[], detail: string): CompileDefect => {
    defectSeq++;
    const d = asDefect(`compile_${defectSeq}`, kind, questionIds, lineIds, detail, lines);
    workList.push(d);
    return d;
  };

  for (const [s, e] of unclaimedRuns()) {
    const leftOwner = s > 1 ? ownerOf(s - 1) : undefined;
    const rightOwner = ownerOf(e + 1);
    let questionIds: string[];
    if (leftOwner && rightOwner) questionIds = [leftOwner.id, rightOwner.id];
    else if (leftOwner) questionIds = [leftOwner.id];
    else if (rightOwner) questionIds = [rightOwner.id];
    else questionIds = [];
    const inside = state.questions.find(q => { const nos = stemNos(q); return nos.length > 0 && Math.min(...nos) <= s && e <= Math.max(...nos); });
    if (inside && !questionIds.includes(inside.id)) questionIds = [inside.id];
    const nos = Array.from({ length: e - s + 1 }, (_, i) => s + i);
    const qRef = questionIds.map(id => `Q${state.questions.find(x => x.id === id)?.no ?? id}`).join(' and ');
    const insideBit = inside ? ` sit inside question ${inside.no}'s range` : (questionIds.length ? ` sit between ${qRef}` : '');
    newDefect('unaccounted-lines', questionIds, nos,
      `lines ${formatRanges(nos)} are claimed by no question${insideBit} — are they part of that question, a new question, or passage?`);
  }

  // ------------------------------------------------------------
  // 4. Targeted re-asks: one precise re-ask per defect, in document order.
  // ------------------------------------------------------------
  const ctx = makeRepairContext(state, lines, keyLineNos, workList as any, []);
  ctx.failedLineNos = failedLineNos;
  const surviving: CompileDefect[] = [];
  const closedByPage = new Map<number, number>();
  const reconciledByPage = new Map<number, number>();
  for (const rec of reconciliations) reconciledByPage.set(rec.page, (reconciledByPage.get(rec.page) || 0) + 1);

  let totalCalls = 0;

  for (const defect of [...workList].sort((a, b) => a.lineIds[0] - b.lineIds[0])) {
    // Scoped lines: the scoped question's lines; for a boundary, both sides at the boundary.
    const qNos = new Set<number>();
    for (const id of defect.questionIds) {
      const q = state.questions.find(x => x.id === id);
      if (q) for (const n of stemNos(q)) qNos.add(n);
    }
    let questionLines = lines.filter(l => qNos.has(lineNo(l))).sort((a, b) => lineNo(a) - lineNo(b));
    if (questionLines.length === 0) questionLines = lines.filter(l => defect.lineIds.includes(lineNo(l)));
    // ±5 context around the whole scoped block (read-only).
    const blockNos = new Set([...questionLines.map(l => lineNo(l)), ...defect.lineIds]);
    const contextLines: SourceLine[] = [];
    for (const n of blockNos) for (let o = n - 5; o <= n + 5; o++) {
      const l = lineByNo.get(o);
      if (l && !blockNos.has(lineNo(l))) contextLines.push(l);
    }
    contextLines.sort((a, b) => lineNo(a) - lineNo(b));

    const result = await scopedReask({ defect, questionLines, contextLines, state, lines, keyLineNos, failedLineNos, caller, cloudCaller, onJournal, budget });
    totalCalls += result.calls;
    usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
    if (result.closed) {
      closedDefects.push(defect);
      closedByPage.set(defect.lineIds[0], (closedByPage.get(defect.lineIds[0]) || 0) + 1);
      continue;
    }
    surviving.push(defect);
  }

  // ------------------------------------------------------------
  // Page status.
  // ------------------------------------------------------------
  const pageStatus = new Map<number, CompileStatus>();
  const pages = new Set<number>();
  for (const line of lines) pages.add(line.page);
  const preQuestionsByPage = new Map<number, number>();
  for (const q of inputQuestions) { const p = questionPage(q); if (p !== undefined) preQuestionsByPage.set(p, (preQuestionsByPage.get(p) || 0) + 1); }
  const postQuestionsByPage = new Map<number, number>();
  for (const q of state.questions) { const p = questionPage(q); if (p !== undefined) postQuestionsByPage.set(p, (postQuestionsByPage.get(p) || 0) + 1); }
  const survivorsByPage = new Map<number, number>();
  for (const d of surviving) for (const n of d.lineIds) { const p = pageOfLine(lines, n); if (p !== undefined) survivorsByPage.set(p, (survivorsByPage.get(p) || 0) + 1); }
  for (const page of [...pages].sort((a, b) => a - b)) {
    if (failedPages.includes(page)) { pageStatus.set(page, 'read-failed'); continue; }
    const preQ = preQuestionsByPage.get(page) || 0;
    const postQ = postQuestionsByPage.get(page) || 0;
    if (preQ > 0 && postQ === 0) { pageStatus.set(page, 'read-failed'); continue; }
    if ((survivorsByPage.get(page) || 0) > 0) pageStatus.set(page, 'partial');
    else if ((closedByPage.get(page) || 0) > 0 || (reconciledByPage.get(page) || 0) > 0) pageStatus.set(page, 'ok-reconciled');
    else pageStatus.set(page, 'ok');
  }

  return {
    questions: state.questions,
    sections: state.sections,
    reconciliations,
    defects: surviving,
    closedDefects,
    furnitureDropped: [...furnitureDropped].sort((a, b) => a - b),
    pageStatus,
    calls: totalCalls,
    usage,
    journal,
  };
}

function formatRanges(nos: number[]): string {
  const sorted = [...new Set(nos.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]; let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i];
    out.push(end === start ? String(start) : `${start}–${end}`);
    i++;
  }
  return out.join(', ');
}
