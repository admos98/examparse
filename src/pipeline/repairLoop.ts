/**
 * #38 Part D — the bounded AI repair loop.
 *
 * Code finds arithmetic defects (Part C); a model proposes fixes from a CLOSED operation
 * vocabulary; code validates every operation's preconditions before applying it, then
 * re-verifies. The model never writes question text — operations only move/merge/drop
 * printed lines or read printed marks evidence. Local role first; a defect kind that
 * survives 2 local rounds (or gets noFix twice) is sent ONCE to the escalation role.
 * Max 3 rounds. Everything is journaled; classify + repair share the executor budgets.
 * Whatever survives goes to the teacher through the single attention function — defect
 * kinds are internal vocabulary and never become attention items themselves.
 */
import type { ExamDoc, Question, SourceLine } from '../types';
import { computeDefects, defectsByKind, defectsSignature, type Defect, type DefectKind } from './defects';
import { lineNo, readMarksEvidence, type SpineBudget } from './classify';
import { sliceSourceSpans } from './spans';
import { parsePrintedNumberFromStem } from './quality';
import { REPAIR_OPS_SYSTEM } from './prompts';

export type RepairOp =
  | { op: 'mergeQuestions'; defect: string; a: string; b: string }
  | { op: 'dropAsFurniture'; defect: string; lines: [number, number] }
  | { op: 'assignLines'; defect: string; lines: [number, number]; questionId: string }
  | { op: 'setSection'; defect: string; line: number; title: string }
  | { op: 'breakQuestionAt'; defect: string; line: number }
  | { op: 'setPointsFrom'; defect: string; lines: [number, number]; questionId?: string }
  | { op: 'noFix'; defect: string; reason?: string };

export const REPAIR_OP_NAMES = ['mergeQuestions', 'dropAsFurniture', 'assignLines', 'setSection', 'breakQuestionAt', 'setPointsFrom', 'noFix'] as const;

export interface ParsedOps { ops: RepairOp[]; rejected: number }

function asLinePair(value: unknown): [number, number] | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    const a = Number(String(value[0]).replace(/\D/g, ''));
    const b = Number(String(value[1]).replace(/\D/g, ''));
    if (Number.isInteger(a) && a > 0 && Number.isInteger(b) && b >= a) return [a, b];
  }
  const single = Number(String(value ?? '').replace(/\D/g, ''));
  return Number.isInteger(single) && single > 0 ? [single, single] : undefined;
}

/** Strict vocabulary parse: anything outside the closed op set (or malformed) is rejected and counted. */
export function parseRepairOps(rawText: string, json?: unknown): ParsedOps {
  const ops: RepairOp[] = [];
  let rejected = 0;
  const consume = (value: any): boolean => {
    const list = Array.isArray(value) ? value : Array.isArray(value?.ops) ? value.ops : Array.isArray(value?.operations) ? value.operations : null;
    if (!list) return false;
    for (const item of list) {
      if (!item || typeof item !== 'object') { rejected++; continue; }
      const name = String(item.op || item.type || '');
      const defect = String(item.defect || item.id || '');
      const num = (v: unknown) => Number(String(v ?? '').replace(/\D/g, ''));
      switch (name) {
        case 'mergeQuestions': {
          if (item.a && item.b && item.a !== item.b) ops.push({ op: name, defect, a: String(item.a), b: String(item.b) });
          else rejected++;
          break;
        }
        case 'dropAsFurniture': {
          const lines = asLinePair(item.lines ?? item.range);
          if (lines) ops.push({ op: name, defect, lines }); else rejected++;
          break;
        }
        case 'assignLines': {
          const lines = asLinePair(item.lines ?? item.range);
          const qid = String(item.questionId || item.to || '');
          if (lines && qid) ops.push({ op: name, defect, lines, questionId: qid }); else rejected++;
          break;
        }
        case 'setSection': {
          const line = num(item.line);
          const title = String(item.title || '').trim().slice(0, 120);
          if (Number.isInteger(line) && line > 0 && title) ops.push({ op: name, defect, line, title }); else rejected++;
          break;
        }
        case 'breakQuestionAt': {
          const line = num(item.line);
          if (Number.isInteger(line) && line > 0) ops.push({ op: name, defect, line }); else rejected++;
          break;
        }
        case 'setPointsFrom': {
          const lines = asLinePair(item.lines ?? item.range);
          if (lines) ops.push({ op: name, defect, lines, ...(item.questionId ? { questionId: String(item.questionId) } : {}) }); else rejected++;
          break;
        }
        case 'noFix':
          ops.push({ op: name, defect, ...(item.reason ? { reason: String(item.reason).slice(0, 200) } : {}) });
          break;
        default:
          rejected++;
      }
    }
    return true;
  };
  if (json && consume(json)) return { ops, rejected };
  const candidate = String(rawText || '').match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try { if (consume(JSON.parse(candidate))) return { ops, rejected }; } catch { /* no salvage for ops: strictness is the point */ }
  }
  return { ops, rejected };
}

// ---------------------------------------------------------------------------
// Operation context: precondition checks + mechanical application
// ---------------------------------------------------------------------------

export interface RepairState {
  questions: Question[];
  sections: ExamDoc['sections'];
}

export interface RepairContext {
  state: RepairState;
  lines: SourceLine[];
  lineByNo: Map<number, SourceLine>;
  keySet: Set<number>;
  /** Lines dropped as furniture by accepted ops (excluded from later orphan checks). */
  furnitureDropped: Set<number>;
  defectById: Map<string, Defect>;
  seq: number;
}

export function makeRepairContext(state: RepairState, lines: SourceLine[], keyLineNos: number[], defects: Defect[]): RepairContext {
  return {
    state,
    lines,
    lineByNo: new Map(lines.map(line => [lineNo(line), line])),
    keySet: new Set(keyLineNos),
    furnitureDropped: new Set<number>(),
    defectById: new Map(defects.map(d => [d.id, d])),
    seq: 0,
  };
}

function spansOf(q: Question): Array<[number, number]> {
  const raw: any[] = (q as any).stemSpans || q.spans || [];
  const out: Array<[number, number]> = [];
  for (const span of raw) {
    if (Array.isArray(span)) out.push([Number(span[0]), Number(span[1])]);
    else if (span && typeof span === 'object' && Number.isInteger(span.line)) out.push([span.line, span.line]);
  }
  return out;
}
function nosOf(q: Question): number[] {
  const out: number[] = [];
  for (const [s, e] of spansOf(q)) for (let n = s; n <= e; n++) out.push(n);
  return out;
}
function setSpans(q: Question, nos: number[], lines: SourceLine[]) {
  const sorted = [...new Set(nos)].sort((a, b) => a - b);
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
function ownerOf(ctx: RepairContext, line: number): Question | undefined {
  return ctx.state.questions.find(q => nosOf(q).includes(line));
}
function rangeNos([s, e]: [number, number]): number[] {
  const out: number[] = [];
  for (let n = s; n <= e; n++) out.push(n);
  return out;
}

export interface OpVerdict { ok: boolean; reason?: string }

/** Preconditions only — code decides legality; the model's word is never enough. */
export function validateRepairOp(op: RepairOp, ctx: RepairContext): OpVerdict {
  const { questions } = ctx.state;
  const byId = new Map(questions.map(q => [q.id, q]));
  switch (op.op) {
    case 'noFix':
      return { ok: true };
    case 'mergeQuestions': {
      const a = byId.get(op.a);
      const b = byId.get(op.b);
      if (!a || !b) return { ok: false, reason: 'merge target does not exist' };
      const na = parsePrintedNumberFromStem(a.stem || '') ?? Number(a.no);
      const nb = parsePrintedNumberFromStem(b.stem || '') ?? Number(b.no);
      const agree = na === nb || !Number.isFinite(na) || !Number.isFinite(nb) || na <= 0 || nb <= 0;
      if (!agree) return { ok: false, reason: `merged numbers disagree (${na} vs ${nb})` };
      return { ok: true };
    }
    case 'dropAsFurniture': {
      const nos = rangeNos(op.lines);
      if (nos.some(n => !ctx.lineByNo.has(n))) return { ok: false, reason: 'line outside document' };
      for (const q of questions) {
        const owned = nosOf(q);
        if (owned.length && owned.every(n => nos.includes(n))) return { ok: false, reason: `would hollow question ${q.no} completely` };
      }
      return { ok: true };
    }
    case 'assignLines': {
      const target = byId.get(op.questionId);
      if (!target) return { ok: false, reason: 'assign target does not exist' };
      const nos = rangeNos(op.lines);
      if (nos.some(n => !ctx.lineByNo.has(n))) return { ok: false, reason: 'line outside document' };
      if (nos.some(n => ctx.keySet.has(n))) return { ok: false, reason: 'lines are answer-key territory' };
      const conflict = nos.find(n => { const owner = ownerOf(ctx, n); return owner && owner.id !== target.id; });
      if (conflict !== undefined) return { ok: false, reason: `line ${conflict} already belongs to another question (overlap)` };
      return { ok: true };
    }
    case 'setSection': {
      if (!ctx.lineByNo.has(op.line)) return { ok: false, reason: 'line outside document' };
      if (ctx.keySet.has(op.line)) return { ok: false, reason: 'line is answer-key territory' };
      if (!op.title.trim()) return { ok: false, reason: 'empty section title' };
      return { ok: true };
    }
    case 'breakQuestionAt': {
      const owner = ownerOf(ctx, op.line);
      if (!owner) return { ok: false, reason: 'line is not inside any question' };
      const first = Math.min(...nosOf(owner));
      if (op.line <= first) return { ok: false, reason: 'break line is the question start itself' };
      const no = parsePrintedNumberFromStem(ctx.lineByNo.get(op.line)?.text || '');
      if (no === undefined) return { ok: false, reason: 'break line carries no printed question number' };
      return { ok: true };
    }
    case 'setPointsFrom': {
      const defect = ctx.defectById.get(op.defect);
      const targetId = op.questionId || defect?.questionIds[0];
      if (!targetId || !byId.has(targetId)) return { ok: false, reason: 'no target question for marks' };
      const nos = rangeNos(op.lines);
      if (nos.some(n => !ctx.lineByNo.has(n))) return { ok: false, reason: 'line outside document' };
      const value = readMarksEvidence(nos.map(n => ctx.lineByNo.get(n)?.text || ''));
      if (value === undefined) return { ok: false, reason: 'no printed marks evidence on those lines' };
      return { ok: true };
    }
  }
}

/** Apply a validated op by pure line arithmetic. Returns a plain receipt string. */
export function applyRepairOp(op: RepairOp, ctx: RepairContext): string {
  const { state, lines } = ctx;
  const byId = new Map(state.questions.map(q => [q.id, q]));
  switch (op.op) {
    case 'noFix':
      return 'noFix recorded';
    case 'mergeQuestions': {
      const a = byId.get(op.a)!;
      const b = byId.get(op.b)!;
      setSpans(a, [...nosOf(a), ...nosOf(b)], lines);
      a.images = [...(a.images || []), ...((b.images || []).filter(ref => !(a.images || []).some(x => x.imageId === ref.imageId)))];
      if (!a.options?.length && b.options?.length) a.options = b.options;
      if (!(a.answer?.text || '').trim() && b.answer) a.answer = b.answer;
      if (!(Number(a.points) > 0) && Number(b.points) > 0) a.points = b.points;
      for (const child of state.questions) if (child.parentId === b.id) child.parentId = a.id;
      state.questions = state.questions.filter(q => q.id !== b.id);
      return `merged ${b.id} into ${a.id}`;
    }
    case 'dropAsFurniture': {
      const nos = rangeNos(op.lines);
      for (const n of nos) ctx.furnitureDropped.add(n);
      for (const q of state.questions) {
        const owned = nosOf(q);
        if (owned.some(n => nos.includes(n))) setSpans(q, owned.filter(n => !nos.includes(n)), lines);
      }
      return `dropped lines ${op.lines[0]}-${op.lines[1]} as furniture`;
    }
    case 'assignLines': {
      const target = byId.get(op.questionId)!;
      const nos = rangeNos(op.lines).filter(n => !ctx.furnitureDropped.has(n));
      setSpans(target, [...nosOf(target), ...nos], lines);
      return `assigned lines ${op.lines[0]}-${op.lines[1]} to ${target.id}`;
    }
    case 'setSection': {
      const maxLine = Math.max(...ctx.lineByNo.keys());
      const spanTuples = (s: any): Array<[number, number]> => (Array.isArray(s.spans) ? s.spans : [])
        .map((span: any) => (Array.isArray(span) ? [Number(span[0]), Number(span[1])] as [number, number] : [span?.line ?? maxLine + 1, span?.line ?? maxLine + 1] as [number, number]));
      const following = state.sections
        .map(s => Math.min(...spanTuples(s).map(span => span[0]), maxLine + 1))
        .filter(start => start > op.line);
      const end = following.length ? Math.min(...following) - 1 : maxLine;
      const id = `sec_fix_${op.line}`;
      // Shrink any section that currently spans across the new boundary.
      for (const s of state.sections) {
        s.spans = spanTuples(s).map(([a, b]) => (a <= op.line && b >= op.line ? [a, op.line - 1] as [number, number] : [a, b] as [number, number])).filter(([a, b]) => b >= a) as any;
      }
      state.sections.push({ id, index: 0, title: op.title, spans: [[op.line, end]], questionIds: [] } as any);
      for (const q of state.questions) {
        const start = Math.min(...nosOf(q));
        if (start >= op.line && start <= end) q.sectionId = id;
      }
      refreshSections(state);
      return `section "${op.title}" starts at line ${op.line}`;
    }
    case 'breakQuestionAt': {
      const owner = ownerOf(ctx, op.line)!;
      const owned = nosOf(owner);
      const head = owned.filter(n => n < op.line);
      const tail = owned.filter(n => n >= op.line);
      const no = parsePrintedNumberFromStem(ctx.lineByNo.get(op.line)?.text || '') ?? owner.no;
      const fresh: Question = {
        id: `q_fix_${op.line}_${++ctx.seq}`,
        label: String(no),
        no,
        sectionId: owner.sectionId,
        spans: [] as any,
        stem: '',
        type: owner.type,
        points: 0,
        confidence: 0.5,
        images: [],
        answer: { source: 'paper', text: '' },
      };
      setSpans(owner, head, lines);
      setSpans(fresh, tail, lines);
      state.questions.push(fresh);
      sortQuestions(state);
      return `broke ${owner.id} at line ${op.line} (new question ${no})`;
    }
    case 'setPointsFrom': {
      const defect = ctx.defectById.get(op.defect);
      const target = byId.get(op.questionId || defect?.questionIds[0] || '')!;
      const value = readMarksEvidence(rangeNos(op.lines).map(n => ctx.lineByNo.get(n)?.text || ''))!;
      target.points = value;
      return `set points of ${target.id} to ${value} from printed marks`;
    }
  }
}

function sortQuestions(state: RepairState) {
  const firstLine = (q: Question) => Math.min(...nosOf(q), Number.MAX_SAFE_INTEGER);
  state.questions.sort((a, b) => firstLine(a) - firstLine(b));
  refreshSections(state);
}

function refreshSections(state: RepairState) {
  const startOf = (s: any) => Math.min(...(s.spans || [[Number.MAX_SAFE_INTEGER]]).map((span: any) => span[0]));
  state.sections = [...state.sections].sort((a, b) => startOf(a) - startOf(b));
  state.sections.forEach((s, i) => {
    (s as any).index = i + 1;
    (s as any).questionIds = state.questions.filter(q => q.sectionId === s.id).map(q => q.id);
  });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface RepairCaller {
  (req: { system: string; text: string; maxOutputTokens?: number; label: string }): Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
}

export interface RepairRoundRecord {
  round: number;
  defectsBefore: number;
  byKind: Partial<Record<DefectKind, number>>;
  calls: number;
  proposed: number;
  accepted: number;
  rejected: number;
  noFix: number;
  escalatedKinds: DefectKind[];
  defectsAfter: number;
  receipts: string[];
}

export interface RepairLoopResult {
  status: 'completed' | 'cached' | 'skipped' | 'no-defects';
  state: RepairState;
  rounds: RepairRoundRecord[];
  calls: number;
  opsAccepted: number;
  opsRejected: number;
  escalations: number;
  remainingDefects: Defect[];
  usage: { inputTokens: number; outputTokens: number };
  escalationUsage: { inputTokens: number; outputTokens: number };
  furnitureDropped: number[];
}

export const REPAIR_BATCH_SIZE = 15;
export const REPAIR_MAX_ROUNDS = 3;

export function renderDefectBatch(kind: DefectKind, defects: Defect[], state: RepairState): string {
  const byId = new Map(state.questions.map(q => [q.id, q]));
  const rows = defects.map(d => {
    const qRefs = d.questionIds.map(id => {
      const q = byId.get(id);
      return q ? `${id} (printed no ${q.no}: "${String(q.stem || '').replace(/\s+/g, ' ').slice(0, 80)}")` : id;
    }).join(' · ');
    const evText = d.evidence.map(e => `[L${String(e.line).padStart(4, '0')}] ${e.text}`).join('\n');
    return `DEFECT ${d.id} (${d.kind})${qRefs ? ` questions: ${qRefs}` : ''}\n  ${d.detail}${evText ? `\n${evText}` : ''}`;
  });
  return `${defects.length} defect(s) of kind "${kind}". Propose AT MOST one operation per defect id.\n\n${rows.join('\n\n')}`;
}

export async function runRepairLoop(params: {
  state: RepairState;
  lines: SourceLine[];
  expectedNumbers: number[];
  expectedStarts?: Array<{ no: number; line: number }>;
  keyLineNos: number[];
  accountedLineNos?: number[];
  totalPoints?: number;
  images?: ExamDoc['images'];
  caller?: RepairCaller;
  escalationCaller?: RepairCaller;
  budget: SpineBudget;
  maxRounds?: number;
  /** Serialized prior loop outcome for identical content (0 calls on re-run). */
  cachedResult?: string;
  onJournal?: (entry: { label: string; rawText: string }) => void | Promise<void>;
  onProgress?: (message: string) => void;
}): Promise<RepairLoopResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const escalationUsage = { inputTokens: 0, outputTokens: 0 };
  const base = (status: RepairLoopResult['status'], state: RepairState, remaining: Defect[], extra?: Partial<RepairLoopResult>): RepairLoopResult => ({
    status, state, rounds: [], calls: 0, opsAccepted: 0, opsRejected: 0, escalations: 0,
    remainingDefects: remaining, usage, escalationUsage, furnitureDropped: [], ...extra,
  });

  if (params.cachedResult) {
    try {
      const cached = JSON.parse(params.cachedResult);
      if (Array.isArray(cached.questions) && Array.isArray(cached.sections)) {
        return base('cached', { questions: cached.questions, sections: cached.sections }, [], {
          rounds: cached.rounds || [], opsAccepted: cached.opsAccepted || 0, opsRejected: cached.opsRejected || 0,
          escalations: cached.escalations || 0, furnitureDropped: cached.furnitureDropped || [],
        });
      }
    } catch { /* fall through to a live loop */ }
  }

  const computeNow = (state: RepairState) => computeDefects({
    doc: { questions: state.questions, sections: state.sections, images: params.images, totalPoints: params.totalPoints },
    lines: params.lines,
    expectedNumbers: params.expectedNumbers,
    expectedStarts: params.expectedStarts,
    keyLineNos: params.keyLineNos,
    accountedLineNos: [...(params.accountedLineNos || []), ...furnitureDropped],
  });

  const state: RepairState = structuredClone(params.state);
  const furnitureDropped: number[] = [];
  let defects: Defect[];
  try {
    defects = computeNow(state);
  } catch (err: any) {
    // The verifier must never kill a parse: record and leave the document exactly as assembled.
    await params.onJournal?.({ label: 'Repair loop skipped (verifier error)', rawText: String(err?.message || err) });
    return base('skipped', state, []);
  }
  if (!params.caller && !params.escalationCaller) return base('skipped', state, defects);
  if (!defects.length) return base('no-defects', state, []);

  const maxRounds = Math.max(1, Math.min(params.maxRounds ?? REPAIR_MAX_ROUNDS, REPAIR_MAX_ROUNDS));
  const survival = new Map<DefectKind, number>();
  const noFixCounts = new Map<DefectKind, number>();
  const escalatedOnce = new Set<DefectKind>();
  const rounds: RepairRoundRecord[] = [];
  let calls = 0;
  let opsAccepted = 0;
  let opsRejected = 0;
  let escalations = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const before = defects.length;
    const byKind = defectsByKind(defects);
    const record: RepairRoundRecord = {
      round,
      defectsBefore: before,
      byKind: Object.fromEntries([...byKind.entries()].map(([k, v]) => [k, v.length])),
      calls: 0, proposed: 0, accepted: 0, rejected: 0, noFix: 0,
      escalatedKinds: [], defectsAfter: before, receipts: [],
    };
    const ctx = makeRepairContext(state, params.lines, params.keyLineNos, defects);
    ctx.furnitureDropped = new Set(furnitureDropped);

    for (const [kind, kindDefects] of byKind) {
      const shouldEscalate = !!params.escalationCaller && !escalatedOnce.has(kind)
        && ((survival.get(kind) || 0) >= 2 || (noFixCounts.get(kind) || 0) >= 2);
      const caller = shouldEscalate ? params.escalationCaller! : params.caller;
      if (!caller) continue;
      if (shouldEscalate) { escalatedOnce.add(kind); record.escalatedKinds.push(kind); escalations++; }
      for (let i = 0; i < kindDefects.length; i += REPAIR_BATCH_SIZE) {
        if (params.budget.calls >= params.budget.maxCalls || params.budget.units >= params.budget.maxUnits) break;
        const batch = kindDefects.slice(i, i + REPAIR_BATCH_SIZE);
        const label = `Repair ${kind} (round ${round})${shouldEscalate ? ' — escalation' : ''}`;
        params.onProgress?.(`${label}: ${batch.length} defect(s)…`);
        let response;
        try {
          response = await caller({ system: REPAIR_OPS_SYSTEM, text: renderDefectBatch(kind, batch, state), maxOutputTokens: 8192, label });
        } catch { continue; }
        calls++;
        record.calls++;
        params.budget.calls++;
        const bucket = shouldEscalate ? escalationUsage : usage;
        if (response.usage) { bucket.inputTokens += response.usage.inputTokens || 0; bucket.outputTokens += response.usage.outputTokens || 0; }
        await params.onJournal?.({ label, rawText: response.rawText.slice(0, 200000) });
        const { ops, rejected } = parseRepairOps(response.rawText, response.json);
        record.rejected += rejected;
        opsRejected += rejected;
        params.budget.units += rejected;
        const seenDefects = new Set<string>();
        for (const op of ops) {
          record.proposed++;
          params.budget.units++;
          if (op.defect && seenDefects.has(op.defect)) { record.rejected++; opsRejected++; continue; }
          if (op.defect) seenDefects.add(op.defect);
          const verdict = validateRepairOp(op, ctx);
          if (!verdict.ok) { record.rejected++; opsRejected++; continue; }
          if (op.op === 'noFix') { record.noFix++; noFixCounts.set(kind, (noFixCounts.get(kind) || 0) + 1); continue; }
          try {
            const receipt = applyRepairOp(op, ctx);
            record.accepted++;
            opsAccepted++;
            record.receipts.push(receipt);
          } catch {
            record.rejected++;
            opsRejected++;
          }
        }
      }
    }
    furnitureDropped.splice(0, furnitureDropped.length, ...ctx.furnitureDropped);
    sortQuestions(state);
    const previousSignature = defectsSignature(defects);
    try { defects = computeNow(state); } catch { record.defectsAfter = before; rounds.push(record); break; }
    record.defectsAfter = defects.length;
    rounds.push(record);
    await params.onJournal?.({
      label: `Repair loop round ${round} summary`,
      rawText: JSON.stringify({ round, defectsBefore: before, accepted: record.accepted, rejected: record.rejected, noFix: record.noFix, escalatedKinds: record.escalatedKinds, defectsAfter: defects.length, receipts: record.receipts }),
    });
    // Survival bookkeeping: kinds still present after this round survived it.
    const survivingKinds = new Set(defects.map(d => d.kind));
    for (const kind of byKind.keys()) {
      if (survivingKinds.has(kind)) survival.set(kind, (survival.get(kind) || 0) + 1);
      else survival.set(kind, 0);
    }
    if (!defects.length) break;
    if (params.budget.calls >= params.budget.maxCalls || params.budget.units >= params.budget.maxUnits) break;
    // A round that changed nothing and cannot trigger escalation next round would repeat verbatim.
    const escalationPending = [...survivingKinds].some(kind => params.escalationCaller && !escalatedOnce.has(kind) && ((survival.get(kind) || 0) >= 1 || (noFixCounts.get(kind) || 0) >= 1));
    if (record.accepted === 0 && defectsSignature(defects) === previousSignature && !escalationPending && round >= 2) break;
  }

  return base('completed', state, defects, {
    rounds, calls, opsAccepted, opsRejected, escalations,
    furnitureDropped: [...furnitureDropped].sort((a, b) => a - b),
  });
}

/** Serialize a loop outcome for the stage cache (identical re-run = 0 repair calls). */
export function serializeRepairLoopResult(result: RepairLoopResult): string {
  return JSON.stringify({
    questions: result.state.questions,
    sections: result.state.sections,
    rounds: result.rounds,
    opsAccepted: result.opsAccepted,
    opsRejected: result.opsRejected,
    escalations: result.escalations,
    furnitureDropped: result.furnitureDropped,
  });
}
