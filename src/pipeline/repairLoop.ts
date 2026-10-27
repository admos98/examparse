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
import { assignImagesExact } from './imageOwnership';
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

export interface ParsedOps {
  ops: RepairOp[];
  /** Entries the parser could not read (wrong type, unknown op, missing targets). */
  rejected: number;
  /** #42: one plain-language complaint per rejected entry, named by position. */
  complaints: string[];
}

/** #42 — malformed repair output is data, never an exception. */
function shapeOfOp(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  return typeof value === 'string' ? 'text' : typeof value === 'number' ? 'a number' : typeof value === 'boolean' ? 'a boolean' : typeof value;
}

function asLinePair(value: unknown): [number, number] | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    const a = Number(String(value[0]).replace(/\D/g, ''));
    const b = Number(String(value[1]).replace(/\D/g, ''));
    if (Number.isInteger(a) && a > 0 && Number.isInteger(b) && b >= a) return [a, b];
  }
  const single = Number(String(value ?? '').replace(/\D/g, ''));
  return Number.isInteger(single) && single > 0 ? [single, single] : undefined;
}

/**
 * Strict vocabulary parse: anything outside the closed op set (or malformed) is rejected and counted.
 * #42: it never throws — every malformed entry becomes one complaint that says exactly what to return.
 */
export function parseRepairOps(rawText: string, json?: unknown): ParsedOps {
  const ops: RepairOp[] = [];
  const complaints: string[] = [];
  let rejected = 0;
  const reject = (message: string) => { rejected++; complaints.push(message); };
  const consume = (value: any): boolean => {
    const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray(value.ops) ? value.ops : value && typeof value === 'object' && Array.isArray(value.operations) ? value.operations : null;
    if (!list) return false;
    list.forEach((item: any, index: number) => {
      const at = `ops entry ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        reject(`${at} is ${shapeOfOp(item)} — every entry must be an object like {"op":"assignLines","defect":"…","lines":[116,124],"questionId":"q_12"}`);
        return;
      }
      const name = String(item.op || item.type || '');
      const defect = String(item.defect || item.id || '');
      const num = (v: unknown) => Number(String(v ?? '').replace(/\D/g, ''));
      switch (name) {
        case 'mergeQuestions': {
          if (item.a && item.b && item.a !== item.b) ops.push({ op: name, defect, a: String(item.a), b: String(item.b) });
          else reject(`${at} (mergeQuestions) needs two different question ids in "a" and "b"`);
          break;
        }
        case 'dropAsFurniture': {
          const lines = asLinePair(item.lines ?? item.range);
          if (lines) ops.push({ op: name, defect, lines });
          else reject(`${at} (dropAsFurniture) needs "lines": [startLine, endLine] with real line numbers`);
          break;
        }
        case 'assignLines': {
          const lines = asLinePair(item.lines ?? item.range);
          const qid = String(item.questionId || item.to || '');
          if (lines && qid) ops.push({ op: name, defect, lines, questionId: qid });
          else reject(`${at} (assignLines) needs "lines": [startLine, endLine] and the target question id in "questionId"`);
          break;
        }
        case 'setSection': {
          const line = num(item.line);
          const title = String(item.title || '').trim().slice(0, 120);
          if (Number.isInteger(line) && line > 0 && title) ops.push({ op: name, defect, line, title });
          else reject(`${at} (setSection) needs a printed "line" and a non-empty "title"`);
          break;
        }
        case 'breakQuestionAt': {
          const line = num(item.line);
          if (Number.isInteger(line) && line > 0) ops.push({ op: name, defect, line });
          else reject(`${at} (breakQuestionAt) needs the printed "line" where the next question starts`);
          break;
        }
        case 'setPointsFrom': {
          const lines = asLinePair(item.lines ?? item.range);
          if (lines) ops.push({ op: name, defect, lines, ...(item.questionId ? { questionId: String(item.questionId) } : {}) });
          else reject(`${at} (setPointsFrom) needs "lines": [startLine, endLine] holding the printed marks`);
          break;
        }
        case 'noFix':
          ops.push({ op: name, defect, ...(item.reason ? { reason: String(item.reason).slice(0, 200) } : {}) });
          break;
        default:
          reject(`${at} has op "${name}" — use exactly one of ${REPAIR_OP_NAMES.join(', ')}`);
      }
    });
    return true;
  };
  const finish = (): ParsedOps => {
    // An empty (but well-formed) envelope fixes nothing: say so instead of scoring a silent zero.
    if (!ops.length && !complaints.length) {
      complaints.push('the operations payload contained no operations — return one operation per defect id, or a noFix entry with a reason');
    }
    return { ops, rejected, complaints };
  };
  try {
    if (json !== undefined && json !== null && consume(json)) return finish();
    const text = String(rawText || '');
    // Accept the whole reply, an embedded object {"ops":[…]} or a bare array of operations — first readable wins.
    const candidates = [text.trim(), text.match(/\{[\s\S]*\}/)?.[0], text.match(/\[[\s\S]*\]/)?.[0]]
      .filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index);
    for (const candidate of candidates) {
      try {
        if (consume(JSON.parse(candidate))) return finish();
      } catch { /* try the next candidate extraction */ }
    }
    reject('the output contains no readable JSON operations object — return {"ops":[…]}, one operation per defect id');
  } catch (err: any) {
    reject(`the operations payload could not be read (${String(err?.message || err)}) — return one JSON object {"ops":[…]}`);
  }
  return { ops, rejected, complaints };
}

/** #42 — an operation's identity is its kind plus its targets; the defect id is deliberately NOT part of it. */
export function repairOpSignature(op: RepairOp): string {
  switch (op.op) {
    case 'mergeQuestions': return `mergeQuestions|${[op.a, op.b].sort().join('+')}`;
    case 'dropAsFurniture': return `dropAsFurniture|${op.lines[0]}-${op.lines[1]}`;
    case 'assignLines': return `assignLines|${op.questionId}|${op.lines[0]}-${op.lines[1]}`;
    case 'setSection': return `setSection|${op.line}|${op.title.trim().toLowerCase()}`;
    case 'breakQuestionAt': return `breakQuestionAt|${op.line}`;
    case 'setPointsFrom': return `setPointsFrom|${op.questionId || ''}|${op.lines[0]}-${op.lines[1]}`;
    case 'noFix': return `noFix|${op.defect}`;
  }
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
  /** Lines on pages whose Global Read failed (cannot be dropped or absorbed by repair). */
  failedLineNos: Set<number>;
  /** Lines dropped as furniture by accepted ops (excluded from later orphan checks). */
  furnitureDropped: Set<number>;
  defectById: Map<string, Defect>;
  seq: number;
}

export function makeRepairContext(state: RepairState, lines: SourceLine[], keyLineNos: number[], defects: Defect[], failedPages?: ReadonlySet<number> | number[]): RepairContext {
  const failedPageSet = failedPages instanceof Set ? failedPages : new Set<number>(failedPages || []);
  const failedLineNos = new Set<number>();
  if (failedPageSet.size) {
    for (const line of lines) if (failedPageSet.has(line.page)) failedLineNos.add(lineNo(line));
  }
  return {
    state,
    lines,
    lineByNo: new Map(lines.map(line => [lineNo(line), line])),
    keySet: new Set(keyLineNos),
    failedLineNos,
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
      if (nos.some(n => ctx.failedLineNos.has(n))) return { ok: false, reason: 'line belongs to a read-failed page; retry the page instead' };
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
      if (nos.some(n => ctx.failedLineNos.has(n))) return { ok: false, reason: 'line belongs to a read-failed page; retry the page instead' };
      if (nos.some(n => ctx.keySet.has(n))) return { ok: false, reason: 'lines are answer-key territory' };
      const conflict = nos.find(n => { const owner = ownerOf(ctx, n); return owner && owner.id !== target.id; });
      if (conflict !== undefined) return { ok: false, reason: `line ${conflict} already belongs to another question (overlap)` };
      return { ok: true };
    }
    case 'setSection': {
      if (!ctx.lineByNo.has(op.line)) return { ok: false, reason: 'line outside document' };
      if (ctx.failedLineNos.has(op.line)) return { ok: false, reason: 'line belongs to a read-failed page; retry the page instead' };
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
      if (nos.some(n => ctx.failedLineNos.has(n))) return { ok: false, reason: 'line belongs to a read-failed page; retry the page instead' };
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
  /** Every well-formed operation proposed this round; equals accepted + rejected + deduped (#42). */
  proposed: number;
  accepted: number;
  rejected: number;
  /** #42: identical operations (kind + targets) suppressed instead of re-validated. */
  deduped: number;
  noFix: number;
  /** #42: entries the model emitted that could not be read as operations. */
  malformed: number;
  escalatedKinds: DefectKind[];
  /** #42: kinds abandoned for the round after 10 rejections. */
  abandonedKinds: DefectKind[];
  /** #42: checked defects skipped because they lie wholly on read-failed pages. */
  droppedReadFailed: number;
  defectsAfter: number;
  receipts: string[];
}

export interface RepairLoopResult {
  status: 'completed' | 'cached' | 'skipped' | 'no-defects';
  state: RepairState;
  rounds: RepairRoundRecord[];
  calls: number;
  /** #42: proposed == accepted + rejected + deduped. */
  opsProposed: number;
  opsAccepted: number;
  opsRejected: number;
  opsDeduped: number;
  opsMalformed: number;
  escalations: number;
  /** #42: kinds abandoned for a round after 10 rejections of the same kind. */
  abandonedKinds: DefectKind[];
  /** #42: checked defects never shown to repair because they belong to read-failed pages. */
  droppedReadFailedDefects: number;
  remainingDefects: Defect[];
  usage: { inputTokens: number; outputTokens: number };
  escalationUsage: { inputTokens: number; outputTokens: number };
  furnitureDropped: number[];
}

export const REPAIR_BATCH_SIZE = 15;
export const REPAIR_MAX_ROUNDS = 3;
/** #42 — after this many rejections of one kind inside one round, that kind is abandoned for the round. */
export const REPAIR_KIND_REJECTION_CAP = 10;

/** Every printed line that lives on a read-failed page (owned by the page-retry path, not by repair). */
export function readFailedLineNos(lines: SourceLine[], failedPages?: ReadonlySet<number> | number[]): Set<number> {
  const pages = failedPages instanceof Set ? failedPages : new Set<number>(failedPages || []);
  const out = new Set<number>();
  if (!pages.size) return out;
  for (const line of lines) if (pages.has(line.page)) out.add(lineNo(line));
  return out;
}

/** #42 — a defect whose every cited line sits on a read-failed page is not repair's to fix. */
export function isReadFailedDefect(defect: Defect, failedLineNos: ReadonlySet<number>): boolean {
  return defect.lineIds.length > 0 && defect.lineIds.every(n => failedLineNos.has(n));
}

export function renderDefectEvidenceOnly(defect: Defect): string {
  const evidence = defect.evidence.map(e => `[L${String(e.line).padStart(4, '0')}] ${e.text}`).join('\n');
  return `ONE DEFECT ONLY\nDEFECT ${defect.id} (${defect.kind})\nCOMPLAINT: ${defect.detail}${defect.questionIds.length ? `\nQUESTION IDS: ${defect.questionIds.join(', ')}` : ''}${evidence ? `\nEVIDENCE:\n${evidence}` : '\nEVIDENCE: none supplied'}\nReturn at most one operation for this defect.`;
}

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
  failedPages?: number[];
  caller?: RepairCaller;
  escalationCaller?: RepairCaller;
  budget: SpineBudget;
  maxRounds?: number;
  /** Serialized prior loop outcome for identical content (0 calls on re-run). */
  cachedResult?: string;
  onJournal?: (entry: { label: string; rawText: string; requestText?: string }) => void | Promise<void>;
  onProgress?: (message: string) => void;
}): Promise<RepairLoopResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const escalationUsage = { inputTokens: 0, outputTokens: 0 };
  const base = (status: RepairLoopResult['status'], state: RepairState, remaining: Defect[], extra?: Partial<RepairLoopResult>): RepairLoopResult => ({
    status, state, rounds: [], calls: 0, opsProposed: 0, opsAccepted: 0, opsRejected: 0, opsDeduped: 0, opsMalformed: 0,
    escalations: 0, abandonedKinds: [], droppedReadFailedDefects: 0,
    remainingDefects: remaining, usage, escalationUsage, furnitureDropped: [], ...extra,
  });

  if (params.cachedResult) {
    try {
      const cached = JSON.parse(params.cachedResult);
      if (Array.isArray(cached.questions) && Array.isArray(cached.sections)) {
        return base('cached', { questions: cached.questions, sections: cached.sections }, Array.isArray(cached.remainingDefects) ? cached.remainingDefects : [], {
          rounds: cached.rounds || [], opsProposed: cached.opsProposed || 0, opsAccepted: cached.opsAccepted || 0,
          opsRejected: cached.opsRejected || 0, opsDeduped: cached.opsDeduped || 0, opsMalformed: cached.opsMalformed || 0,
          escalations: cached.escalations || 0, abandonedKinds: cached.abandonedKinds || [],
          droppedReadFailedDefects: cached.droppedReadFailedDefects || 0, furnitureDropped: cached.furnitureDropped || [],
        });
      }
    } catch { /* fall through to a live loop */ }
  }

  let currentImages: ExamDoc['images'] | undefined = params.images ? params.images.map(img => ({ ...img, ...(img.label ? { label: { ...img.label } } : {}) })) : undefined;
  const computeNow = (state: RepairState) => computeDefects({
    doc: { questions: state.questions, sections: state.sections, images: currentImages, totalPoints: params.totalPoints },
    lines: params.lines,
    expectedNumbers: params.expectedNumbers,
    expectedStarts: params.expectedStarts,
    keyLineNos: params.keyLineNos,
    accountedLineNos: [...(params.accountedLineNos || []), ...furnitureDropped],
  });

  const state: RepairState = structuredClone(params.state);
  const furnitureDropped: number[] = [];
  // #42 — defects that live wholly on read-failed pages are owned by the page-retry path: never batch them.
  const failedLineNos = readFailedLineNos(params.lines, params.failedPages);
  const repairable = (list: Defect[]) => list.filter(d => !isReadFailedDefect(d, failedLineNos));
  let defects: Defect[];
  try {
    defects = computeNow(state);
  } catch (err: any) {
    // The verifier must never kill a parse: record and leave the document exactly as assembled.
    await params.onJournal?.({ label: 'Repair loop skipped (verifier error)', rawText: String(err?.message || err) });
    return base('skipped', state, []);
  }
  const droppedAtStart = defects.length - repairable(defects).length;
  if (!params.caller && !params.escalationCaller) return base('skipped', state, defects, { droppedReadFailedDefects: droppedAtStart });
  if (!defects.length) return base('no-defects', state, []);
  // Nothing repair is allowed to touch: the pages themselves have to be retried, so spend zero calls.
  if (!repairable(defects).length) return base('no-defects', state, defects, { droppedReadFailedDefects: droppedAtStart });

  const maxRounds = Math.max(1, Math.min(params.maxRounds ?? REPAIR_MAX_ROUNDS, REPAIR_MAX_ROUNDS));
  const survival = new Map<DefectKind, number>();
  const noFixCounts = new Map<DefectKind, number>();
  const escalatedOnce = new Set<DefectKind>();
  const rounds: RepairRoundRecord[] = [];
  let calls = 0;
  let opsProposed = 0;
  let opsAccepted = 0;
  let opsRejected = 0;
  let opsDeduped = 0;
  let opsMalformed = 0;
  let escalations = 0;
  const abandonedKinds = new Set<DefectKind>();
  /** Operations already rejected this parse: never re-sent to the validator, never re-counted. */
  const rejectedSigs = new Set<string>();

  for (let round = 1; round <= maxRounds; round++) {
    const before = defects.length;
    const byKindAll = defectsByKind(defects);
    const byKind = new Map<DefectKind, Defect[]>();
    let droppedThisRound = 0;
    for (const [kind, list] of byKindAll) {
      const keep = repairable(list);
      droppedThisRound += list.length - keep.length;
      if (keep.length) byKind.set(kind, keep);
    }
    const record: RepairRoundRecord = {
      round,
      defectsBefore: before,
      byKind: Object.fromEntries([...byKindAll.entries()].map(([k, v]) => [k, v.length])),
      calls: 0, proposed: 0, accepted: 0, rejected: 0, deduped: 0, noFix: 0, malformed: 0,
      escalatedKinds: [], abandonedKinds: [], droppedReadFailed: droppedThisRound, defectsAfter: before, receipts: [],
    };
    const ctx = makeRepairContext(state, params.lines, params.keyLineNos, defects, params.failedPages);
    ctx.furnitureDropped = new Set(furnitureDropped);
    // Every kind's defects are impossible to fix right now (read-failed pages): make no calls at all.
    if (!byKind.size) {
      rounds.push(record);
      await params.onJournal?.({
        label: `Repair loop round ${round} skipped`,
        rawText: JSON.stringify({ round, defectsBefore: before, droppedReadFailed: droppedThisRound, reason: 'all remaining defects lie on read-failed pages; retry those pages instead' }),
      });
      break;
    }
    const rejectionsByKind = new Map<DefectKind, number>();
    const seenSigs = new Set<string>();

    for (const [kind, kindDefects] of byKind) {
      const shouldEscalate = !!params.escalationCaller && !escalatedOnce.has(kind)
        && ((survival.get(kind) || 0) >= 2 || (noFixCounts.get(kind) || 0) >= 2);
      const caller = shouldEscalate ? params.escalationCaller! : params.caller;
      if (!caller) continue;
      if (shouldEscalate) { escalatedOnce.add(kind); record.escalatedKinds.push(kind); escalations++; }
      const batchSize = shouldEscalate ? 1 : REPAIR_BATCH_SIZE;
      for (let i = 0; i < kindDefects.length; i += batchSize) {
        if (params.budget.calls >= params.budget.maxCalls || params.budget.units >= params.budget.maxUnits) break;
        // Cloud locality is a hard privacy/cost boundary: exactly one defect and only its cited evidence.
        const batch = kindDefects.slice(i, i + batchSize);
        const label = `Repair ${kind} (round ${round})${shouldEscalate ? ' — escalation' : ''}`;
        params.onProgress?.(`${label}: ${batch.length} defect(s)…`);
        let response;
        const requestText = shouldEscalate ? renderDefectEvidenceOnly(batch[0]) : renderDefectBatch(kind, batch, state);
        try {
          response = await caller({ system: REPAIR_OPS_SYSTEM, text: requestText, maxOutputTokens: shouldEscalate ? 2048 : 8192, label });
        } catch { continue; }
        calls++;
        record.calls++;
        params.budget.calls++;
        const bucket = shouldEscalate ? escalationUsage : usage;
        if (response.usage) { bucket.inputTokens += response.usage.inputTokens || 0; bucket.outputTokens += response.usage.outputTokens || 0; }
        await params.onJournal?.({ label, rawText: response.rawText.slice(0, 200000), requestText });
        const parsedOps = parseRepairOps(response.rawText, response.json);
        const { ops } = parsedOps;
        // #42: unreadable entries are their own bucket — they were never well-formed operations.
        record.malformed += parsedOps.rejected;
        opsMalformed += parsedOps.rejected;
        params.budget.units += parsedOps.rejected;
        if (parsedOps.complaints.length) {
          await params.onJournal?.({ label: `${label} — unreadable operations`, rawText: parsedOps.complaints.join('\n') });
        }
        const seenDefects = new Set<string>();
        const rejectKind = (reason?: string) => {
          record.rejected++;
          opsRejected++;
          rejectionsByKind.set(kind, (rejectionsByKind.get(kind) || 0) + 1);
          if (reason) record.receipts.push(`rejected ${kind}: ${reason}`);
        };
        for (const op of ops) {
          if (op.op === 'noFix') {
            record.noFix++;
            noFixCounts.set(kind, (noFixCounts.get(kind) || 0) + 1);
            continue;
          }
          record.proposed++;
          opsProposed++;
          params.budget.units++;
          const signature = repairOpSignature(op);
          // Identical to an already-rejected op this parse (or a duplicate in this batch): cost-free dedupe.
          if (rejectedSigs.has(signature) || seenSigs.has(signature)) {
            record.deduped++;
            opsDeduped++;
            continue;
          }
          seenSigs.add(signature);
          if (op.defect && seenDefects.has(op.defect)) {
            rejectedSigs.add(signature);
            rejectKind('two operations for one defect id');
            continue;
          }
          if (op.defect) seenDefects.add(op.defect);
          const verdict = validateRepairOp(op, ctx);
          if (!verdict.ok) {
            rejectedSigs.add(signature);
            rejectKind(verdict.reason);
            continue;
          }
          try {
            const receipt = applyRepairOp(op, ctx);
            record.accepted++;
            opsAccepted++;
            record.receipts.push(receipt);
          } catch {
            rejectedSigs.add(signature);
            rejectKind('the operation could not be applied');
          }
        }
        // #42: a kind the model keeps failing on stops burning calls for the rest of the round.
        if ((rejectionsByKind.get(kind) || 0) >= REPAIR_KIND_REJECTION_CAP) {
          if (!record.abandonedKinds.includes(kind)) record.abandonedKinds.push(kind);
          abandonedKinds.add(kind);
          await params.onJournal?.({
            label: `Repair ${kind} abandoned (round ${round})`,
            rawText: JSON.stringify({ kind, rejections: rejectionsByKind.get(kind), cap: REPAIR_KIND_REJECTION_CAP }),
          });
          break;
        }
      }
    }
    furnitureDropped.splice(0, furnitureDropped.length, ...ctx.furnitureDropped);
    sortQuestions(state);
    if (record.accepted > 0 && currentImages?.length) {
      try {
        const assigned = await assignImagesExact({
          questions: state.questions,
          images: currentImages,
          sourceLines: params.lines,
          failedPages: params.failedPages,
        });
        state.questions = assigned.questions;
        currentImages = assigned.images;
      } catch { /* keep state as-is */ }
    }
    const previousSignature = defectsSignature(defects);
    try { defects = computeNow(state); } catch { record.defectsAfter = before; rounds.push(record); break; }
    record.defectsAfter = defects.length;
    rounds.push(record);
    await params.onJournal?.({
      label: `Repair loop round ${round} summary`,
      rawText: JSON.stringify({ round, defectsBefore: before, proposed: record.proposed, accepted: record.accepted, rejected: record.rejected, deduped: record.deduped, malformed: record.malformed, noFix: record.noFix, abandonedKinds: record.abandonedKinds, droppedReadFailed: record.droppedReadFailed, escalatedKinds: record.escalatedKinds, defectsAfter: defects.length, receipts: record.receipts }),
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
    rounds, calls, opsProposed, opsAccepted, opsRejected, opsDeduped, opsMalformed, escalations,
    abandonedKinds: [...abandonedKinds],
    droppedReadFailedDefects: defects.length - repairable(defects).length,
    furnitureDropped: [...furnitureDropped].sort((a, b) => a - b),
  });
}

/** Serialize a loop outcome for the stage cache (identical re-run = 0 repair calls). */
export function serializeRepairLoopResult(result: RepairLoopResult): string {
  return JSON.stringify({
    questions: result.state.questions,
    sections: result.state.sections,
    rounds: result.rounds,
    opsProposed: result.opsProposed,
    opsAccepted: result.opsAccepted,
    opsRejected: result.opsRejected,
    opsDeduped: result.opsDeduped,
    opsMalformed: result.opsMalformed,
    escalations: result.escalations,
    abandonedKinds: result.abandonedKinds,
    droppedReadFailedDefects: result.droppedReadFailedDefects,
    remainingDefects: result.remainingDefects,
    furnitureDropped: result.furnitureDropped,
  });
}
