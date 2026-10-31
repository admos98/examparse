import type { ExamSection, ImageAsset, Question, SourceLine, SpinePageReadRecord, SpinePageReadStatus } from '../types';
import { sha256 } from '../utils/hash';
import { sliceSourceSpans } from './spans';

/** The only semantic parse made on the default path. Code validates per-page proposals and merges them arithmetically. */
export const READ_VERSION = 'global-read-v2';
export const READ_LABELS = ['furniture', 'section', 'instruction', 'question', 'continuation', 'option', 'passage', 'key', 'marks'] as const;
export type ReadLabel = typeof READ_LABELS[number];
export type ReadFormat = 'compact' | 'verbose';
export type ReadRange = [number, number, ReadLabel];

export interface ReadQuestion {
  no: number;
  spans: Array<[number, number]>;
  section?: string;
  type: Question['type'];
  optionSpans?: Array<{ key: string; spans: Array<[number, number]> }>;
  marksEvidence?: Array<[number, number]>;
  answerSpans?: Array<[number, number]>;
  imageIds?: string[];
  parentNo?: number;
}
export interface ReadSection { id: string; title: string; spans: Array<[number, number]>; headerLine?: number }
export interface MetaProposalField<T = unknown> { value: T; evidenceLine: number }
export interface ReadProposal {
  labels: Map<number, ReadLabel>;
  ranges: ReadRange[];
  questions: ReadQuestion[];
  sections: ReadSection[];
  meta: { subject?: MetaProposalField<string>; grade?: MetaProposalField<string | number>; total?: MetaProposalField<number>; date?: MetaProposalField<string> };
  answerKey: Record<string, { value?: string; spans?: Array<[number, number]> }>;
  /** #42: structural complaints produced while parsing model output (never thrown, always actionable). */
  parseComplaints?: string[];
}
export interface ReadValidation { ok: boolean; complaints: string[] }
export interface ReadCaller {
  (request: { system: string; text: string; label: string; maxOutputTokens: number; reasoningOff: true }): Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
}
/**
 * The Global Read's own call allowance (#41). Owned by the read stage and computed from the document:
 * a page may spend at most 3 calls (local attempt, local complaint-retry, cloud rescue) and 6 slack calls
 * cover the whole exam. Never drawn from `agentLimits` (that governs the Assistant executor only).
 */
export const READ_CALLS_PER_PAGE = 3;
export const READ_ALLOWANCE_SLACK = 6;
export const readAllowanceForPages = (pages: number): number => Math.max(0, pages) * READ_CALLS_PER_PAGE + READ_ALLOWANCE_SLACK;
export const readAllowanceExhaustedReason = (allowance: number): string => `read allowance exhausted (${allowance} calls)`;
export const isAllowanceExhaustedReason = (reason?: string): boolean => Boolean(reason && reason.includes('read allowance exhausted'));
/** Used by a teacher's [Retry page]: one fresh page allowance, independent of the original run. */
export const PAGE_RETRY_ALLOWANCE = READ_CALLS_PER_PAGE;

/** Shared budget shape. `calls` counts every call made against the allowance, local or cloud. */
export interface ReadBudget { calls: number; maxCalls: number }

export interface ReadPageChunk {
  page: number;
  owned: SourceLine[];
  context: SourceLine[];
}

export interface OpenQuestionCarryOver {
  no: number;
  stemPreview: string;
}

export interface PageReadCacheEntry {
  serialized: string;
  source: 'local' | 'cloud';
  format?: ReadFormat;
}

export interface PageReadCache {
  get: (key: string) => Promise<PageReadCacheEntry | string | undefined> | PageReadCacheEntry | string | undefined;
  set: (key: string, value: PageReadCacheEntry) => Promise<void> | void;
}

export interface GlobalReadResult {
  status: 'completed' | 'cached' | 'partial' | 'invalid' | 'unavailable' | 'failed';
  proposal?: ReadProposal;
  complaints: string[];
  calls: number;
  cloudCalls: number;
  /** #41: the allowance this run was given; `calls + cloudCalls` never exceeds it. */
  readAllowance: number;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
  cloudUsage: { inputTokens: number; outputTokens: number };
  serialized?: string;
  pages: SpinePageReadRecord[];
  failedPages: number[];
  pageProposals: Record<string, string>;
}

export const GLOBAL_READ_SYSTEM = `You are ExamRead. Read ONE printed exam page (sheet) and propose its line spans and questions. Reasoning is OFF. Return JSON only and never copy or author question text: code slices text from your line spans.
Output {"r":[[start,end,label]],"q":[{"n":1,"p":[[10,12]],"s":"sec1","t":"mcq","o":[["a",[[11,11]]]],"v":[[12,12]],"a":[[90,90]],"i":["img1"]}],"s":[{"id":"sec1","title":"Vocabulary","p":[[8,40]],"h":8}],"m":{"subject":{"value":"English","line":2},"grade":{"value":"12","line":3},"total":{"value":40,"line":95}},"k":{"1":{"value":"b","p":[[90,90]]}}}.
Labels are exactly furniture|section|instruction|question|continuation|option|passage|key|marks. Label ONLY this page's non-ctx lines, each line exactly once; lines marked ctx are read-only context from the previous page and must never be labelled or owned. If OPEN QUESTION FROM PREVIOUS PAGE is not "none" and top lines of this page continue that question before the next printed question number, label those top lines continuation (or option/marks) and do NOT re-open that question number in q. Give every printed question number starting on this page and its complete boundary on this page. Type is mcq|truefalse|short|long|fillblank|matching|multi|numeric|diagram|essay|unknown. v is ONLY line spans that explicitly print that question's marks; omit it when marks are not printed. Never infer/distribute points. Use PAGE IMAGES (caption + address) to attach matching page image ids in i:[id]; captions are context only. Meta fields require one evidence line each. A repeated header, footer, page number, or “continued” line is furniture, never a section or question. Use ranges economically. /no_think`;

export const GLOBAL_READ_VERBOSE_SYSTEM = `You are ExamRead. Read ONE printed exam page. Return one JSON object only. Do not copy question text; the app slices it from your boundaries. Reasoning is OFF.
Use this example: {"page":1,"sections":[{"title":"Listening","headerLine":5}],"questions":[{"number":1,"type":"truefalse","stemFrom":8,"stemTo":8,"optionsFrom":8,"optionsTo":8,"passageFrom":null,"passageTo":null,"marksLine":null,"answerLine":null,"imageIds":[]}],"answerKey":[{"number":1,"answer":"b","line":90}]}.
Never list line numbers one by one. For each question give only the first and last line of its stem and options. If a line belongs to no question, say nothing about it — the app will handle it.
For absent options or passages use null for both endpoints. Sections give printed title and headerLine. Include every printed question that starts on this page, with its number and type: mcq|truefalse|short|long|fillblank|matching|multi|numeric|diagram|essay|unknown. Give marksLine only for explicitly printed marks; do not infer points. Answer-key entries give printed number, answer, and evidence line. Add imageIds only when an image belongs to the question. Lines marked ctx belong to the previous page; never cite them. If OPEN QUESTION FROM PREVIOUS PAGE names a question, do not reopen its number. Never invent questions at regular intervals; follow printed numbers. /no_think`;

/** The read cap is page-local, for both wire formats. */
export const pageReadOutputCap = (ownedLines: number): number => Math.min(8192, 800 + ownedLines * 30);

/** A counting loop is not an exam proposal. Match delimited integers, across streaming chunks. */
export function hasCountingLoop(text: string): boolean {
  let previous = -1, run = 0;
  for (const match of text.matchAll(/\b\d+\b/g)) {
    const n = Number(match[0]);
    run = n === previous + 1 ? run + 1 : 1;
    if (run >= 40) return true;
    previous = n;
  }
  return false;
}

/** Scan only complete top-level objects inside a named array, respecting JSON strings. */
function completeArrayObjects(text: string, key: string): unknown[] {
  const start = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (!start || start.index === undefined) return [];
  const out: unknown[] = [];
  let depth = 0, begin = -1, quoted = false, escape = false;
  for (let i = start.index + start[0].length; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ']' && depth === 0) break;
    if (ch === '{') { if (depth++ === 0) begin = i; }
    if (ch === '}' && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(text.slice(begin, i + 1))); } catch { /* incomplete object */ }
    }
  }
  return out;
}

export function salvageVerbosePage(text: string): any | undefined {
  const questions = completeArrayObjects(text, 'questions');
  if (!questions.length) return undefined;
  return { sections: completeArrayObjects(text, 'sections'), questions, answerKey: completeArrayObjects(text, 'answerKey') };
}

const no = (value: unknown): number => Number(String(value ?? '').replace(/[^0-9۰-۹٠-٩]/g, '').replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))));
const lineNo = (l: SourceLine) => no(l.id);

const spanList = (value: any): Array<[number, number]> => {
  const list = Array.isArray(value) && value.length === 2 && value.every((x: any) => Number.isFinite(Number(x))) ? [value] : Array.isArray(value) ? value : [];
  return list.map((x: any) => Array.isArray(x) ? [no(x[0]), no(x[1] ?? x[0])] as [number, number] : [no(x), no(x)] as [number, number])
    .filter(([a, b]) => Number.isInteger(a) && a > 0 && Number.isInteger(b) && b >= a);
};
const typeOf = (raw: unknown): Question['type'] => {
  const v = String(raw || 'unknown').toLowerCase().replace(/[-_ ]/g, '');
  const aliases: Record<string, Question['type']> = { m: 'mcq', mcq: 'mcq', multiplechoice: 'mcq', f: 'truefalse', truefalse: 'truefalse', b: 'fillblank', fillblank: 'fillblank', s: 'short', short: 'short', l: 'long', long: 'long', essay: 'essay', a: 'matching', matching: 'matching', u: 'multi', multi: 'multi', n: 'numeric', numeric: 'numeric', d: 'diagram', diagram: 'diagram', unknown: 'unknown', '?': 'unknown' };
  return aliases[v] || 'unknown';
};
const labelOf = (raw: unknown): ReadLabel | undefined => {
  const v = String(raw || '').toLowerCase().replace(/[_ ]/g, '-');
  const aliases: Record<string, ReadLabel> = { 'section-header': 'section', 'question-start': 'question', 'answer-key': 'key', blank: 'furniture' };
  return (READ_LABELS as readonly string[]).includes(v) ? v as ReadLabel : aliases[v];
};
function candidate(rawText: string, json?: unknown): any {
  if (json && typeof json === 'object') return json;
  try { return JSON.parse(rawText.match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { return null; }
}

export const UNPARSEABLE_COMPLAINT = 'output is not a JSON object';

/** Plain-language name for a malformed JSON value — every parse complaint uses it. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return `a ${typeof value}`;
}
const clip = (value: unknown, max = 24): string => {
  if (value === undefined) return 'nothing';
  const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
/** `116–124, 130` — contiguous printed lines as ranges, never a bare number soup. */
export function formatLineRanges(nos: number[], max = 6): string {
  const sorted = [...new Set(nos.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length && out.length < max) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i];
    out.push(end === start ? String(start) : `${start}–${end}`);
    i++;
  }
  return out.join(', ');
}
/** A model field that must be a list; a wrong type becomes an actionable complaint, never a throw. */
function asList(value: unknown, path: string, complaints: string[]): any[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  complaints.push(`${path} must be a list, but it is ${shapeOf(value)} — return it as a JSON array`);
  return [];
}

export interface ReadParseResult { proposal: ReadProposal; complaints: string[] }

/** Convert the self-descriptive verbose wire shape to the canonical compact-shaped parser input. */
function normalizeVerboseProposal(raw: any, ownedLines: SourceLine[]): any {
  const lineNumbers = ownedLines.map(lineNo).sort((a, b) => a - b);
  const mark = (line: unknown, label: ReadLabel) => {
    const n = no(line);
    return n > 0 ? [n, n, label] : undefined;
  };
  const rows: any[] = [];
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).map((sec: any, i: number) => {
    const headerLine = no(sec?.headerLine);
    if (headerLine) rows.push([headerLine, headerLine, 'section']);
    const next = (raw.sections || []).map((x: any) => no(x?.headerLine)).filter((n: number) => n > headerLine).sort((a: number, b: number) => a - b)[0];
    const answerLines = (Array.isArray(raw.answerKey) ? raw.answerKey : []).map((entry: any) => no(entry?.line)).filter(Boolean);
    const sectionLines = lineNumbers.filter(n => n >= headerLine && (!next || n < next) && !answerLines.includes(n));
    const end = sectionLines.at(-1) || headerLine;
    return { id: `sec${i + 1}`, title: String(sec?.title || ''), p: headerLine ? [[headerLine, Math.max(headerLine, end)]] : [], h: headerLine };
  });
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((q: any) => {
    const range = (from: unknown, to: unknown): [number, number] | undefined => {
      if (from == null || to == null) return undefined;
      const a = no(from), b = no(to);
      return a > 0 && b >= a && b - a < 10000 ? [a, b] : undefined;
    };
    const stem = range(q?.stemFrom, q?.stemTo);
    const options = range(q?.optionsFrom, q?.optionsTo);
    const passage = range(q?.passageFrom, q?.passageTo);
    const markRange = (r: [number, number] | undefined, label: ReadLabel) => { if (r) for (let n = r[0]; n <= r[1]; n++) rows.push([n, n, label]); };
    markRange(stem, 'question'); markRange(options, 'option'); markRange(passage, 'passage');
    if (q?.marksLine != null) { const r = mark(q.marksLine, 'marks'); if (r) rows.push(r); }
    if (q?.answerLine != null) { const r = mark(q.answerLine, 'key'); if (r) rows.push(r); }
    const firstQuestionLine = stem?.[0] || options?.[0] || passage?.[0] || 0;
    const headerSection = sections.filter((sec: any) => no(sec.h) <= firstQuestionLine).sort((a: any, b: any) => no(b.h) - no(a.h))[0] || sections[0];
    // Infer option boundaries from printed keys. Wrapped option lines extend the preceding option;
    // if there are no keys, retain the whole options range as one evidence span.
    const optionSpans: Array<{ key: string; span: [number, number] }> = [];
    if (options) {
      for (const n of lineNumbers.filter(n => n >= options[0] && n <= options[1])) {
        const key = parseLeadingOptionKey(ownedLines.find(l => lineNo(l) === n)?.text || '');
        const last = optionSpans.at(-1);
        if (key || !last) optionSpans.push({ key: key || String.fromCharCode(97 + optionSpans.length), span: [n, n] });
        else last.span[1] = n;
      }
    }
    return {
      n: q?.number, t: q?.type,
      p: [stem, passage].filter(Boolean),
      o: optionSpans.map(x => [x.key, [x.span]]),
      ...(headerSection ? { s: headerSection.id } : {}),
      ...(q?.marksLine != null ? { v: [[no(q.marksLine), no(q.marksLine)]] } : {}),
      ...(q?.answerLine != null ? { a: [[no(q.answerLine), no(q.answerLine)]] } : {}),
      i: Array.isArray(q?.imageIds) ? q.imageIds : [],
    };
  });
  const answerKey: Record<string, any> = {};
  for (const entry of Array.isArray(raw.answerKey) ? raw.answerKey : []) {
    if (entry?.number != null) answerKey[String(entry.number)] = { value: String(entry.answer ?? ''), p: entry.line != null ? [[no(entry.line), no(entry.line)]] : [] };
    if (entry?.line != null) { const r = mark(entry.line, 'key'); if (r) rows.push(r); }
  }
  // Deterministically keep one label per line, preferring the most specific structural claim.
  const priority: ReadLabel[] = ['question', 'option', 'continuation', 'marks', 'key', 'section', 'furniture'];
  const byLine = new Map<number, ReadLabel>();
  for (const [a, b, label] of rows) for (let n = a; n <= b; n++) {
    const prior = byLine.get(n);
    if (!prior || priority.indexOf(label) < priority.indexOf(prior)) byLine.set(n, label);
  }
  const ranges = [...byLine].sort((a, b) => a[0] - b[0]).map(([n, label]) => [n, n, label]);
  return { r: ranges, q: questions, s: sections, k: answerKey, ...(raw.metadata ? { m: raw.metadata } : {}) };
}


/**
 * #42 — the proposal parser NEVER throws. Malformed model output is data: a null entry, a missing key,
 * a wrong type or a non-array field each becomes one plain-language complaint the model can act on
 * (named by position, e.g. "q entry 4 is null — every question entry must be an object …").
 */
export function parseReadProposalChecked(rawText: string, json?: unknown, format: ReadFormat = 'compact', ownedLines: SourceLine[] = []): ReadParseResult {
  const complaints: string[] = [];
  const ranges: ReadRange[] = [];
  const labels = new Map<number, ReadLabel>();
  const questions: ReadQuestion[] = [];
  const sections: ReadSection[] = [];
  const meta: ReadProposal['meta'] = {};
  const answerKey: ReadProposal['answerKey'] = {};
  const result = (): ReadParseResult => ({ proposal: { labels, ranges, questions, sections, meta, answerKey, parseComplaints: complaints }, complaints });
  try {
    let value = candidate(rawText, json);
    if (format === 'verbose' && value && typeof value === 'object' && !Array.isArray(value)) value = normalizeVerboseProposal(value, ownedLines);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      complaints.push(`${UNPARSEABLE_COMPLAINT} — return one JSON object with the keys r, q, s, m and k and nothing else`);
      return result();
    }

    asList(value.r ?? value.ranges, 'r (line labels)', complaints).forEach((row, index) => {
      const at = `r entry ${index + 1}`;
      if (!row || typeof row !== 'object') {
        complaints.push(`${at} is ${shapeOf(row)} — every line-label entry must be [startLine, endLine, label]`);
        return;
      }
      const a = no(Array.isArray(row) ? row[0] : row.start ?? row.line);
      const b = no(Array.isArray(row) ? row[1] : row.end ?? row.start ?? row.line);
      const rawLabel = Array.isArray(row) ? row[2] : row.label;
      const label = labelOf(rawLabel);
      if (!label) {
        complaints.push(`${at} has label ${clip(rawLabel, 20)} — use exactly one of ${READ_LABELS.join('|')}`);
        return;
      }
      if (!Number.isInteger(a) || a < 1 || !Number.isInteger(b) || b < a || b - a > 10000) {
        complaints.push(`${at} (${label}) has unusable lines — each entry must be [startLine, endLine, label] with real line numbers and start ≤ end`);
        return;
      }
      ranges.push([a, b, label]);
      for (let n = a; n <= b; n++) if (!labels.has(n)) labels.set(n, label);
    });

    asList(value.q ?? value.questions, 'q (questions)', complaints).forEach((row, index) => {
      const at = `q entry ${index + 1}`;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        complaints.push(`${at} is ${shapeOf(row)} — every question entry must be an object with the printed number "n" and line spans "p"`);
        return;
      }
      const printed = no(row.n ?? row.no ?? row.number);
      const spans = spanList(row.p ?? row.spans);
      if (!Number.isInteger(printed) || printed < 1) {
        complaints.push(`${at} has no printed question number — set "n" to the number printed on the sheet`);
        return;
      }
      if (!spans.length) {
        complaints.push(`q entry ${index + 1} (question ${printed}) has no usable line spans — set "p" to [[startLine, endLine]] on this page`);
        return;
      }
      const optionSpans: Array<{ key: string; spans: Array<[number, number]> }> = [];
      asList(row.o ?? row.options, `q entry ${index + 1} (question ${printed}) options`, complaints).forEach((option, optionIndex) => {
        const key = String((Array.isArray(option) ? option[0] : option && typeof option === 'object' ? (option as any).key : '') ?? '').trim();
        const spansOfOption = spanList(Array.isArray(option) ? option[1] : option && typeof option === 'object' ? (option as any).spans : undefined);
        if (!key || !spansOfOption.length) {
          complaints.push(`q entry ${index + 1} (question ${printed}) option ${optionIndex + 1} is ${shapeOf(option)} without a usable key and line span — every option must be ["a", [[line, line]]]`);
          return;
        }
        optionSpans.push({ key: key.slice(0, 8), spans: spansOfOption });
      });
      const section = typeof (row.s ?? row.section) === 'string' ? String(row.s ?? row.section) : undefined;
      const marksEvidence = spanList(row.v ?? row.marksEvidence);
      const answerSpans = spanList(row.a ?? row.answerSpans);
      const imageIds = Array.isArray(row.i ?? row.imageIds) ? (row.i ?? row.imageIds).map(String) : [];
      const parentNo = no(row.g ?? row.parentNo);
      questions.push({
        no: printed,
        spans,
        ...(section ? { section } : {}),
        type: typeOf(row.t ?? row.type),
        ...(optionSpans.length ? { optionSpans } : {}),
        ...(marksEvidence.length ? { marksEvidence } : {}),
        ...(answerSpans.length ? { answerSpans } : {}),
        ...(imageIds.length ? { imageIds } : {}),
        ...(parentNo > 0 ? { parentNo } : {}),
      });
    });

    asList(value.s ?? value.sections, 's (sections)', complaints).forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        complaints.push(`s entry ${index + 1} is ${shapeOf(row)} — every section entry must be an object with a "title" and line spans "p"`);
        return;
      }
      const spans = spanList(row.p ?? row.spans);
      if (!spans.length) {
        const title = String(row.title ?? row.kind ?? '').trim();
        complaints.push(`s entry ${index + 1}${title ? ` ("${clip(title, 40)}")` : ''} has no usable line spans — set "p" to [[startLine, endLine]]`);
        return;
      }
      const headerLine = no(row.h ?? row.headerLine);
      sections.push({
        id: String(row.id || `section_${index + 1}`),
        title: String(row.title ?? row.kind ?? '').trim(),
        spans,
        ...(headerLine > 0 ? { headerLine } : {}),
      });
    });

    const rawMeta = value.m ?? value.meta;
    if (rawMeta !== undefined && rawMeta !== null && (typeof rawMeta !== 'object' || Array.isArray(rawMeta))) {
      complaints.push(`m (metadata) is ${shapeOf(rawMeta)} — it must be an object such as {"subject":{"value":"English","line":2}}`);
    } else if (rawMeta && typeof rawMeta === 'object') {
      for (const key of ['subject', 'grade', 'total', 'date'] as const) {
        const field = (rawMeta as any)[key] ?? (key === 'total' ? (rawMeta as any).totalPoints : undefined);
        if (field === undefined || field === null) continue;
        if (typeof field !== 'object' || Array.isArray(field)) {
          complaints.push(`meta.${key} is ${shapeOf(field)} — every metadata field must be {"value": …, "line": <printed evidence line>}`);
          continue;
        }
        const evidenceLine = no(field.line ?? field.evidenceLine);
        if (!(evidenceLine > 0)) {
          complaints.push(`meta.${key} has no evidence line — set "line" to the printed line the ${key} was read from`);
          continue;
        }
        (meta as any)[key] = { value: field.value, evidenceLine };
      }
    }

    const rawKey = value.k ?? value.answerKey;
    if (rawKey !== undefined && rawKey !== null && (typeof rawKey !== 'object' || Array.isArray(rawKey))) {
      complaints.push(`k (answer key) is ${shapeOf(rawKey)} — it must be an object keyed by printed question number, e.g. {"3":{"value":"b","p":[[90,90]]}}`);
    } else if (rawKey && typeof rawKey === 'object') {
      for (const [key, entry] of Object.entries(rawKey)) {
        if (entry === null || entry === undefined) {
          complaints.push(`k["${key}"] is ${shapeOf(entry)} — every answer-key entry must be "b" or {"value":"b","p":[[line,line]]}`);
          continue;
        }
        if (typeof entry === 'object') {
          const entryValue = String((entry as any).value ?? '');
          const entrySpans = spanList((entry as any).p ?? (entry as any).spans);
          if (!entryValue.trim() && !entrySpans.length) {
            complaints.push(`k["${key}"] has neither a value nor line spans — give the printed answer text in "value" or the answer line in "p"`);
            continue;
          }
          answerKey[key] = { value: entryValue, spans: entrySpans };
          continue;
        }
        answerKey[key] = { value: String(entry) };
      }
    }
    return result();
  } catch (err: any) {
    // Last resort: a thrown exception during parse is itself the bug; it becomes one complaint.
    complaints.push(`the proposal could not be read (${String(err?.message || err)}) — return one JSON object with the keys r, q, s, m and k`);
    return result();
  }
}

export function parseReadProposal(rawText: string, json?: unknown, format: ReadFormat = 'compact', ownedLines: SourceLine[] = []): ReadProposal {
  return parseReadProposalChecked(rawText, json, format, ownedLines).proposal;
}

export function validateReadProposal(proposal: ReadProposal, lines: SourceLine[]): ReadValidation {
  return validatePageProposal(proposal, lines, { hasOpenQuestion: false, allowKeyOnlyPage: false });
}

export const NO_QUESTIONS_COMPLAINT = 'the proposal contains no questions';

/** True when the model returned a JSON object at all (format), independent of what it labelled (content). */
export function readOutputParses(rawText: string, json?: unknown): boolean {
  const value = candidate(rawText, json);
  return Boolean(value) && typeof value === 'object';
}

const toLatinDigits = (text: string): string => text.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
/** A printed question-number line such as `12. …`, `(3) …` or `4) …`. */
export const isNumberedLine = (text: string): boolean => /^\s*\(?\d{1,3}\s*[.)]\s+\S/.test(toLatinDigits(text || ''));

/**
 * #41 format failure = the model cannot speak the schema: unparseable output, "no questions" on a page,
 * or no owned line labelled at all on a page that plainly has numbered lines. Content complaints
 * (overlaps, gaps, boundaries) are NOT format failures and still get the local complaint-retry.
 */
export function isFormatFailure(input: { parses: boolean; complaints: string[]; owned: SourceLine[]; proposal: ReadProposal }): boolean {
  if (!input.parses) return true;
  if (input.complaints.includes(NO_QUESTIONS_COMPLAINT)) return true;
  const ownedNos = input.owned.map(lineNo);
  const nothingLabelled = ownedNos.length > 0 && ownedNos.every(n => !input.proposal.labels.has(n));
  return nothingLabelled && input.owned.some(l => isNumberedLine(l.text));
}

/** Plain-language page failure (flag + attention). An exhausted page says the exam was only partially read. */
export function pageReadFailedMessage(page: number, reason?: string): string {
  if (isAllowanceExhaustedReason(reason)) {
    return `Page ${page} couldn't be read — the exam was only partially read because of the call budget; its questions are missing.`;
  }
  return `Page ${page} couldn't be read — its questions are missing.`;
}

/** Contiguous ranges inside one question's spans (used to name a question in a complaint). */
function questionSpanText(q: ReadQuestion): string {
  const nos: number[] = [];
  for (const [a, b] of q.spans) for (let n = a; n <= b; n++) nos.push(n);
  return formatLineRanges(nos, 3) || 'no lines';
}

/**
 * Arithmetic page validation. #42: every complaint names the questions (or labels) involved — a bare
 * line list forces the model to re-derive the conflict, and it never does.
 */
export function validatePageProposal(
  proposal: ReadProposal,
  ownedLines: SourceLine[],
  opts: { hasOpenQuestion?: boolean; allowKeyOnlyPage?: boolean; allowUnclaimed?: boolean } = {},
): ReadValidation {
  try {
    return validatePageProposalUnsafe(proposal, ownedLines, opts);
  } catch (err: any) {
    return {
      ok: false,
      complaints: [`the page proposal could not be checked (${String(err?.message || err)}) — return the JSON shape from the instructions, with one label per owned line`],
    };
  }
}

function validatePageProposalUnsafe(
  proposal: ReadProposal,
  ownedLines: SourceLine[],
  opts: { hasOpenQuestion?: boolean; allowKeyOnlyPage?: boolean; allowUnclaimed?: boolean },
): ReadValidation {
  const expected = new Set((ownedLines || []).map(l => no(l.id)));
  const ranges: ReadRange[] = (Array.isArray(proposal?.ranges) ? proposal.ranges : [])
    .filter((row): row is ReadRange => Array.isArray(row) && row.length >= 3);
  const questions: ReadQuestion[] = (Array.isArray(proposal?.questions) ? proposal.questions : [])
    .filter((q): q is ReadQuestion => Boolean(q) && typeof q === 'object' && Array.isArray(q.spans));
  const labels = proposal?.labels instanceof Map ? proposal.labels : new Map<number, ReadLabel>();
  const counts = new Map<number, number>();
  const claims = new Map<number, string[]>();
  const complaints: string[] = [];
  for (const [a, b, label] of ranges) {
    for (let n = a; n <= b; n++) {
      counts.set(n, (counts.get(n) || 0) + 1);
      const list = claims.get(n);
      const text = `${label} ${a}–${b}`;
      if (list) { if (list.length < 3) list.push(text); } else claims.set(n, [text]);
    }
  }
  const missing = opts.allowUnclaimed ? [] : [...expected].filter(n => !counts.has(n));
  const duplicate = [...counts].filter(([n, c]) => expected.has(n) && c !== 1).map(([n]) => n);
  const outside = [...counts.keys()].filter(n => !expected.has(n));
  if (missing.length) complaints.push(`every line must be accounted for exactly once; unlabelled lines: ${missing.slice(0, 30).join(', ')} — label every owned line and never label ctx lines`);
  if (duplicate.length) {
    const detail = duplicate.slice(0, 4).map(n => `line ${n} is claimed by ${(claims.get(n) || []).join(' and ')}`).join('; ');
    complaints.push(`line labels overlap; multiply-labelled lines: ${duplicate.slice(0, 30).join(', ')} — ${detail}; each line belongs to exactly one label`);
  }
  if (outside.length) complaints.push(`label ranges cite lines outside the document: ${outside.slice(0, 30).join(', ')}`);

  const outsideQuestionLines: number[] = [];
  const outsideByQuestion = new Map<number, number[]>();
  for (const q of questions) {
    const cited: number[] = [];
    for (const [a, b] of q.spans) for (let n = a; n <= b; n++) if (!expected.has(n)) cited.push(n);
    for (const opt of q.optionSpans || []) for (const [a, b] of opt.spans) for (let n = a; n <= b; n++) if (!expected.has(n)) cited.push(n);
    if (cited.length) {
      outsideQuestionLines.push(...cited);
      outsideByQuestion.set(no(q.no), cited);
    }
  }
  if (outsideQuestionLines.length) {
    const detail = [...outsideByQuestion.entries()].slice(0, 4)
      .map(([no, nos]) => `question ${no} cites ${formatLineRanges(nos, 3)}`)
      .join('; ');
    complaints.push(`question spans cite lines outside this page: ${[...new Set(outsideQuestionLines)].slice(0, 30).join(', ')} — ${detail}; this page owns only lines ${formatLineRanges([...expected], 3)}`);
  }

  if (!questions.length) {
    const ownedLabels = [...labels.entries()].filter(([n]) => expected.has(n)).map(([, l]) => l);
    const hasQuestionLabel = ownedLabels.includes('question');
    const hasValidContinuation = Boolean(opts.hasOpenQuestion) && ownedLabels.some(l => l === 'continuation' || l === 'option');
    // #42 — an answer-key page is a real page: key/marks content (plus furniture) with 0 questions is fine.
    const keyOnlyContent = ownedLabels.some(l => l === 'key' || l === 'marks')
      && ownedLabels.every(l => l === 'key' || l === 'marks' || l === 'furniture');
    const hasKeyedAnswerMap = Object.keys(proposal?.answerKey || {}).length > 0 && ownedLabels.includes('key');
    const hasKey = opts.allowKeyOnlyPage !== false && (keyOnlyContent || hasKeyedAnswerMap);
    if (hasQuestionLabel || (!hasValidContinuation && !hasKey)) {
      complaints.push(NO_QUESTIONS_COMPLAINT);
    }
  }

  const nums = questions.map(q => q.no);
  const dupNos = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  if (dupNos.length) {
    const detail = dupNos.slice(0, 4).map(no => {
      const spans = questions.filter(q => q.no === no).map(questionSpanText).join(' and ');
      return `question number ${no} is opened at ${spans}`;
    }).join('; ');
    complaints.push(`printed question numbers must be unique; duplicates: ${dupNos.slice(0, 12).join(', ')} — ${detail}; keep one question per printed number and label continued lines continuation`);
  }
  const claimed = new Map<number, number[]>();
  const parentNos = new Set(questions.map(q => q.parentNo).filter((n): n is number => typeof n === 'number' && n > 0));
  for (const q of questions) {
    if (q.parentNo && parentNos.has(q.parentNo)) continue;
    for (const [a, b] of q.spans) for (let n = a; n <= b; n++) claimed.set(n, [...(claimed.get(n) || []), no(q.no)]);
  }
  const overlaps = [...claimed].filter(([, owners]) => owners.length > 1).map(([n]) => n);
  if (overlaps.length) {
    const linesByPair = new Map<string, number[]>();
    for (const [n, owners] of claimed) {
      if (owners.length < 2) continue;
      for (let i = 0; i < owners.length; i++) for (let j = i + 1; j < owners.length; j++) {
        const key = [owners[i], owners[j]].sort((x, y) => x - y).join('|');
        linesByPair.set(key, [...(linesByPair.get(key) || []), n]);
      }
    }
    const detail = [...linesByPair.entries()].slice(0, 4)
      .map(([key, nos]) => {
        const [a, b] = key.split('|');
        return `questions ${a} and ${b} both claim line(s) ${formatLineRanges(nos, 4)}`;
      })
      .join('; ');
    complaints.push(`question spans overlap on lines: ${overlaps.slice(0, 30).join(', ')} — ${detail}; each line belongs to exactly one question`);
  }
  return { ok: complaints.length === 0, complaints };
}

export interface ReadCheck extends ReadValidation {
  proposal: ReadProposal;
  /** Did the model return a JSON object at all (format), independent of what it labelled? */
  parses: boolean;
  /** Structural parse complaints (wrong shape), separate from content validation complaints. */
  parseComplaints: string[];
}

/**
 * #42 — the single seam where model output becomes a verdict. It never throws: parse problems,
 * validation problems and even an unexpected exception all come back as plain-language complaints.
 */
export function checkReadOutput(
  rawText: string,
  json: unknown,
  ownedLines: SourceLine[],
  opts: { hasOpenQuestion?: boolean; allowKeyOnlyPage?: boolean; format?: ReadFormat; allowUnclaimed?: boolean } = {},
): ReadCheck {
  const parses = readOutputParses(rawText, json);
  let parsed: ReadProposal;
  let parseComplaints: string[];
  try {
    const result = parseReadProposalChecked(rawText, json, opts.format || 'compact', ownedLines);
    parsed = result.proposal;
    parseComplaints = result.complaints;
  } catch (err: any) {
    parsed = parseReadProposal('', undefined);
    parseComplaints = [`the proposal could not be read (${String(err?.message || err)}) — return one JSON object with the keys r, q, s, m and k`];
  }
  let checked: ReadValidation;
  try {
    checked = validatePageProposal(parsed, ownedLines, { ...opts, allowUnclaimed: opts.allowUnclaimed || opts.format === 'verbose' });
  } catch (err: any) {
    checked = { ok: false, complaints: [`the page proposal could not be checked (${String(err?.message || err)}) — return the JSON shape from the instructions`] };
  }
  const complaints = [...new Set([...parseComplaints, ...checked.complaints].filter(Boolean))];
  return { proposal: parsed, parses, ok: checked.ok && parseComplaints.length === 0, complaints, parseComplaints };
}

export function serializeReadProposal(proposal: ReadProposal): string {
  return JSON.stringify({ v: READ_VERSION, r: proposal.ranges, q: proposal.questions, s: proposal.sections, m: proposal.meta, k: proposal.answerKey });
}
export function deserializeReadProposal(raw: string): ReadProposal | undefined { try { return parseReadProposal('', JSON.parse(raw)); } catch { return undefined; } }

/** Context overlap from the previous page: always 30 read-only lines, never owned by the current page. */
export const READ_OVERLAP_LINES = 30;

/**
 * Page chunking is the ONLY mode: one call per page (sheet).
 * Owned lines = that page's lines; context = the last 30 lines of the previous page (`ctx`).
 */
export function buildReadChunks(lines: SourceLine[]): ReadPageChunk[] {
  const sorted = [...lines].sort((a, b) => a.page - b.page || lineNo(a) - lineNo(b));
  const byPage = new Map<number, SourceLine[]>();
  for (const line of sorted) {
    const list = byPage.get(line.page);
    if (list) list.push(line);
    else byPage.set(line.page, [line]);
  }
  const out: ReadPageChunk[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const owned = [...(byPage.get(page) || [])].sort((a, b) => lineNo(a) - lineNo(b));
    if (!owned.length) continue;
    const prevOwned = out.at(-1)?.owned || [];
    out.push({ page, owned, context: prevOwned.slice(-READ_OVERLAP_LINES) });
  }
  return out;
}

function renderLines(lines: SourceLine[], context: SourceLine[] = []): string {
  const ctx = new Set(context.map(lineNo));
  return [...context, ...lines].map(l => `[${l.id} p${l.page} y${Math.round(l.y || 0)}]${ctx.has(lineNo(l)) ? ' ctx' : ''} ${l.text}`).join('\n');
}

export function formatOpenQuestionState(open?: OpenQuestionCarryOver): string {
  if (!open) return 'none';
  return `Q${open.no} "${open.stemPreview}"`;
}

export function renderPageImagesBlock(images: ImageAsset[] | undefined, page: number): string {
  const onPage = (images || []).filter(
    img => img.page === page && !img.duplicateOf && img.label?.role !== 'decoration' && img.label?.kind !== 'decoration',
  );
  if (!onPage.length) return '';
  const rows = onPage.map(img => {
    const near = img.anchorLine ? ` near L${String(img.anchorLine).padStart(4, '0')}` : '';
    const y = img.bbox ? ` y${Math.round(img.bbox.y)}` : '';
    const caption = img.label?.caption ? ` caption: "${img.label.caption}"` : ' caption: (uncaptioned)';
    return `[${img.id} p${img.page}${near}${y}]${caption}`;
  });
  return `PAGE IMAGES (picture content on page ${page} — reference matching image ids in question "i":[...]; never author text from captions):\n${rows.join('\n')}\n`;
}

export function buildPageReadPrompt(params: {
  page: number;
  totalPages: number;
  owned: SourceLine[];
  context: SourceLine[];
  openQuestion?: OpenQuestionCarryOver;
  images?: ImageAsset[];
  guidance?: string;
  complaints?: string[];
  format?: ReadFormat;
}): string {
  const firstId = params.owned[0]?.id || 'L0001';
  const lastId = params.owned.at(-1)?.id || firstId;
  const guidanceBlock = params.guidance ? `LEARNED GUIDANCE (advisory):\n${params.guidance}\n\n` : '';
  const pageHeader = params.format === 'verbose'
    ? `Page ${params.page}/${params.totalPages}. Read this page's printed structure; cite only its own line numbers (${firstId}..${lastId}).${params.context.length ? ' Lines marked ctx are read-only overlap from the previous page and must not be claimed.' : ''}\n`
    : `Page ${params.page}/${params.totalPages}. Label ONLY page ${params.page}'s non-ctx lines (${firstId}..${lastId}).${params.context.length ? ' Lines marked ctx are read-only overlap from the previous page; do not label or own them.' : ''}\n`;
  const carryOver = `OPEN QUESTION FROM PREVIOUS PAGE: ${formatOpenQuestionState(params.openQuestion)}\n`;
  const imageBlock = params.format === 'verbose'
    ? renderPageImagesBlock(params.images, params.page).replace('question "i":[...]', 'question imageIds:[]')
    : renderPageImagesBlock(params.images, params.page);
  const complaintBlock = params.complaints?.length ? `\n\nVALIDATOR COMPLAINT (fix this exactly):\n${params.complaints.join('\n')}` : '';
  const instructions = params.format === 'verbose' ? `${GLOBAL_READ_VERBOSE_SYSTEM}\n\n` : '';
  return `${instructions}${guidanceBlock}${pageHeader}${carryOver}${imageBlock}${renderLines(params.owned, params.context)}${complaintBlock}`;
}

export async function pageReadCacheKey(params: {
  owned: SourceLine[];
  context: SourceLine[];
  model?: string;
  format?: ReadFormat;
  guidance?: string;
  images?: ImageAsset[];
}): Promise<string> {
  const ownedSig = params.owned.map(l => `${l.id}|${l.page}|${Math.round(l.y || 0)}|${l.text}`).join('\n');
  const ctxSig = params.context.map(l => `${l.id}|${l.page}|${Math.round(l.y || 0)}|${l.text}`).join('\n');
  const guidanceHash = (await sha256(params.guidance || '')).slice(0, 16);
  const page = params.owned[0]?.page ?? 0;
  const imgSig = renderPageImagesBlock(params.images, page);
  const wireVersion = params.format === 'verbose' ? 'verbose-v2' : READ_VERSION;
  const full = await sha256(`${wireVersion}\nformat:${params.format || 'compact'}\nmodel:${params.model || 'default'}\nguidance:${guidanceHash}\nimages:${imgSig}\nctx:\n${ctxSig}\nowned:\n${ownedSig}`);
  return `page-read-${wireVersion}-${full.slice(0, 32)}`;
}

function maxQuestionLineOnPage(q: ReadQuestion): number {
  const ends: number[] = [];
  for (const [, b] of q.spans) ends.push(b);
  for (const opt of q.optionSpans || []) for (const [, b] of opt.spans) ends.push(b);
  for (const [, b] of q.marksEvidence || []) ends.push(b);
  return ends.length ? Math.max(...ends) : -1;
}

/**
 * Determine the open question left at the bottom of a validated page (printed number + first 40 chars of stem),
 * or undefined ("none") when the page closed all questions before ending.
 */
export function openQuestionAfterPage(
  proposal: ReadProposal,
  ownedLines: SourceLine[],
  allLines: SourceLine[],
  incomingOpen?: OpenQuestionCarryOver,
): OpenQuestionCarryOver | undefined {
  const sortedOwned = [...ownedLines].sort((a, b) => lineNo(a) - lineNo(b));
  if (proposal.questions.length > 0) {
    let lastQ = proposal.questions[0];
    let lastEnd = maxQuestionLineOnPage(lastQ);
    for (const q of proposal.questions.slice(1)) {
      const end = maxQuestionLineOnPage(q);
      if (end >= lastEnd) { lastQ = q; lastEnd = end; }
    }
    const trailingBlocking = sortedOwned
      .map(lineNo)
      .filter(n => n > lastEnd)
      .some(n => {
        const l = proposal.labels.get(n);
        return l === 'section' || l === 'passage' || l === 'key';
      });
    if (trailingBlocking) return undefined;
    const stemPreview = sliceSourceSpans(lastQ.spans, allLines).replace(/\s+/g, ' ').trim().slice(0, 40);
    return { no: lastQ.no, stemPreview };
  }
  if (incomingOpen) {
    const nonFurniture = sortedOwned
      .map(l => proposal.labels.get(lineNo(l)))
      .filter((l): l is ReadLabel => Boolean(l) && l !== 'furniture');
    if (nonFurniture.length > 0 && nonFurniture.every(l => l === 'continuation' || l === 'option' || l === 'marks')) {
      return incomingOpen;
    }
  }
  return undefined;
}

function toContiguousSpans(nos: number[]): Array<[number, number]> {
  const sorted = [...new Set(nos)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && last[1] === n - 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

function coalesceSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const nos: number[] = [];
  for (const [a, b] of spans) for (let n = a; n <= b; n++) nos.push(n);
  return toContiguousSpans(nos);
}

function parseLeadingOptionKey(text: string): string | undefined {
  const m = (text || '').trim().match(/^(?:\(\s*([a-hA-Hالف-ی])\s*\)|([a-hA-Hالف-ی])[).:])\s+/);
  return (m?.[1] || m?.[2] || '').toLowerCase() || undefined;
}

/**
 * Deterministically merge per-page proposals (code = arithmetic):
 *  - Line label ownership is disjoint by construction (each page owns only its sheet's lines).
 *  - Top-of-page `continuation` (and continued `option`/`marks`) lines attach to the open question
 *    carried over from the previous page so a question spanning pages becomes ONE question.
 *  - Conflicts across pages (a question number opened twice, or spans overlapping) stay intact so
 *    Global Check (`computeDefects`) surfaces them as defects, never silent merges.
 *  - Unread (`failed`) pages contribute nothing, leaving their lines unaccounted in the document.
 */
export function mergePageProposals(
  entries: Array<{ page: number; owned: SourceLine[]; proposal?: ReadProposal }>,
  allLines: SourceLine[],
): { proposal?: ReadProposal; pageProposals: Record<string, string> } {
  const byNo = new Map(allLines.map(l => [lineNo(l), l]));
  const merged: ReadProposal = { labels: new Map(), ranges: [], questions: [], sections: [], meta: {}, answerKey: {} };
  const pageProposals: Record<string, string> = {};
  const usedSectionIds = new Set<string>();
  let activeSection: ReadSection | undefined;
  let openCarry: OpenQuestionCarryOver | undefined;
  let openTargetQuestion: ReadQuestion | undefined;

  const sortedEntries = [...entries].sort((a, b) => a.page - b.page);
  for (const entry of sortedEntries) {
    const p = entry.proposal;
    if (!p) {
      openCarry = undefined;
      openTargetQuestion = undefined;
      continue;
    }
    pageProposals[String(entry.page)] = serializeReadProposal(p);
    const ownedSorted = [...entry.owned].sort((a, b) => lineNo(a) - lineNo(b));
    const ownedSet = new Set(ownedSorted.map(lineNo));

    for (const [a, b, label] of p.ranges) {
      const accepted = Array.from({ length: b - a + 1 }, (_, x) => a + x).filter(n => ownedSet.has(n));
      for (const n of accepted) {
        if (!merged.labels.has(n)) merged.labels.set(n, label);
      }
      for (const [rs, re] of toContiguousSpans(accepted)) merged.ranges.push([rs, re, label]);
    }

    // Attach top-of-page continuation lines to the previous page's open question.
    if (openCarry && openTargetQuestion) {
      const claimedOnPage = new Set<number>();
      for (const q of p.questions) {
        for (const [a, b] of q.spans) for (let n = a; n <= b; n++) claimedOnPage.add(n);
        for (const o of q.optionSpans || []) for (const [a, b] of o.spans) for (let n = a; n <= b; n++) claimedOnPage.add(n);
      }
      const contLines: number[] = [];
      const markLines: number[] = [];
      for (const line of ownedSorted) {
        const n = lineNo(line);
        const label = p.labels.get(n);
        if (label === 'furniture') continue;
        if (claimedOnPage.has(n)) break;
        if (label === 'continuation') {
          contLines.push(n);
          continue;
        }
        if (label === 'option') {
          const optKey = parseLeadingOptionKey(byNo.get(n)?.text || '');
          if (optKey) {
            openTargetQuestion.optionSpans = [...(openTargetQuestion.optionSpans || []), { key: optKey, spans: [[n, n]] }];
            if ((openTargetQuestion.type === 'unknown' || openTargetQuestion.type === 'short') && (openTargetQuestion.optionSpans?.length || 0) >= 2) {
              openTargetQuestion.type = 'mcq';
            }
          } else {
            contLines.push(n);
          }
          continue;
        }
        if (label === 'marks') {
          markLines.push(n);
          continue;
        }
        break;
      }
      if (contLines.length) {
        openTargetQuestion.spans = coalesceSpans([...openTargetQuestion.spans, ...toContiguousSpans(contLines)]);
      }
      if (markLines.length) {
        openTargetQuestion.marksEvidence = coalesceSpans([...(openTargetQuestion.marksEvidence || []), ...toContiguousSpans(markLines)]);
      }
    }

    // Merge sections deterministically without colliding IDs across pages.
    const localSecMap = new Map<string, string>();
    for (const s of p.sections) {
      const restrictedSpans = coalesceSpans(
        s.spans.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i).filter(n => ownedSet.has(n)).map(n => [n, n] as [number, number])),
      );
      if (!restrictedSpans.length) continue;
      const firstLine = restrictedSpans[0][0];
      const hasExplicitHeader = Boolean(s.headerLine && ownedSet.has(s.headerLine)) || p.labels.get(firstLine) === 'section';
      const normTitle = s.title.trim().toLowerCase();
      if (
        activeSection &&
        !hasExplicitHeader &&
        (!normTitle || normTitle === activeSection.title.trim().toLowerCase())
      ) {
        activeSection.spans = coalesceSpans([...activeSection.spans, ...restrictedSpans]);
        localSecMap.set(s.id, activeSection.id);
        continue;
      }
      let nextId = s.id || `sec_p${entry.page}`;
      if (usedSectionIds.has(nextId)) {
        let suffix = entry.page;
        while (usedSectionIds.has(`${nextId}_p${suffix}`)) suffix++;
        nextId = `${nextId}_p${suffix}`;
      }
      usedSectionIds.add(nextId);
      const clone: ReadSection = {
        id: nextId,
        title: s.title,
        spans: restrictedSpans,
        ...(s.headerLine && ownedSet.has(s.headerLine) ? { headerLine: s.headerLine } : {}),
      };
      merged.sections.push(clone);
      activeSection = clone;
      localSecMap.set(s.id, nextId);
    }

    // Merge questions — never silently merge a question number opened on two pages (becomes duplicate-number defect).
    const clonedQuestions: ReadQuestion[] = p.questions.map(q => {
      const resolvedSection = q.section && localSecMap.has(q.section)
        ? localSecMap.get(q.section)
        : q.section && usedSectionIds.has(q.section)
          ? q.section
          : activeSection?.id;
      return {
        ...q,
        spans: q.spans.map(([a, b]) => [a, b] as [number, number]),
        ...(resolvedSection ? { section: resolvedSection } : { section: undefined }),
        ...(q.optionSpans ? { optionSpans: q.optionSpans.map(o => ({ key: o.key, spans: o.spans.map(([a, b]) => [a, b] as [number, number]) })) } : {}),
        ...(q.marksEvidence ? { marksEvidence: q.marksEvidence.map(([a, b]) => [a, b] as [number, number]) } : {}),
        ...(q.answerSpans ? { answerSpans: q.answerSpans.map(([a, b]) => [a, b] as [number, number]) } : {}),
        ...(q.imageIds ? { imageIds: [...q.imageIds] } : {}),
      };
    });
    merged.questions.push(...clonedQuestions);

    for (const key of ['subject', 'grade', 'total', 'date'] as const) {
      if (!merged.meta[key] && p.meta[key]) (merged.meta as any)[key] = p.meta[key];
    }
    Object.assign(merged.answerKey, p.answerKey);

    const nextOpen = openQuestionAfterPage(p, ownedSorted, allLines, openCarry);
    openCarry = nextOpen;
    if (nextOpen && clonedQuestions.length > 0) {
      openTargetQuestion = [...clonedQuestions].reverse().find(q => q.no === nextOpen.no) || openTargetQuestion;
    } else if (!nextOpen) {
      openTargetQuestion = undefined;
    }
  }

  if (merged.questions.length === 0) return { proposal: undefined, pageProposals };
  return { proposal: merged, pageProposals };
}

/** #42 — how long a cloud rescue waits before its single transient-failure retry. */
export const CLOUD_RETRY_DELAY_MS = 5000;

/**
 * #42 — is a thrown provider error weather or refusal? A 5xx / timeout / network failure is transient
 * and earns the one retry; a 4xx (bad key, bad request) is not. Validation complaints never reach here.
 */
export function isTransientProviderError(message: unknown): boolean {
  const text = String((message as any)?.message ?? message ?? '');
  if (!text) return false;
  if (/\b(429|408|425|5\d\d)\b/.test(text)) return true;
  return /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EAI_AGAIN|ENOTFOUND|ESOCKETTIMEDOUT|socket hang up|fetch failed|network|timed?\s?out|timeout|bad gateway|service unavailable|gateway timeout|temporarily unavailable|overloaded|rate.?limit|too many requests|upstream)/i.test(text);
}

export interface CloudPageReadResult {
  ok: boolean;
  proposal?: ReadProposal;
  complaints: string[];
  usage: { inputTokens: number; outputTokens: number };
  requestText: string;
  /** #42: how many cloud calls this page actually spent (1, or 2 after a transient retry). */
  calls: number;
  attempts: number;
  /** #42: the provider/transport error text when the cloud route failed for weather reasons, not content. */
  error?: string;
}

/**
 * Re-read a single failed page via the canonical `cloud` role (`cloudPageRead`, same schema).
 * Locality boundary: ONLY that page's lines + at most 30 `ctx` lines from the previous page are sent.
 * #42: a provider/transport failure (5xx, timeout, network) waits ~5s and retries exactly once;
 * a validation failure gets zero content retries (the page is simply not good enough).
 */
export async function cloudPageRead(params: {
  page: number;
  totalPages: number;
  owned: SourceLine[];
  context: SourceLine[];
  openQuestion?: OpenQuestionCarryOver;
  images?: ImageAsset[];
  complaints?: string[];
  guidance?: string;
  format?: ReadFormat;
  allowKeyOnlyPage?: boolean;
  caller: ReadCaller;
  budget?: ReadBudget;
  /** Test seam: retry delay in ms (defaults to CLOUD_RETRY_DELAY_MS). */
  retryDelayMs?: number;
  /** Test seam: the wait function (defaults to a real timer). */
  wait?: (ms: number) => Promise<void>;
  onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void>;
}): Promise<CloudPageReadResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const context = params.context.slice(-READ_OVERLAP_LINES);
  const requestText = buildPageReadPrompt({
    page: params.page,
    totalPages: params.totalPages,
    owned: params.owned,
    context,
    openQuestion: params.openQuestion,
    images: params.images,
    guidance: params.guidance,
    complaints: params.complaints,
    format: params.format,
  });
  const label = `Cloud · Page ${params.page} Read`;
  const delay = params.retryDelayMs ?? CLOUD_RETRY_DELAY_MS;
  const wait = params.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const allowanceOpen = () => !params.budget || params.budget.calls < params.budget.maxCalls;
  let calls = 0;
  let error: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!allowanceOpen()) break;
    // Charged before the call: a request that throws is never free.
    calls++;
    if (params.budget) params.budget.calls++;
    try {
      const response = await params.caller({
        system: params.format === 'verbose' ? GLOBAL_READ_VERBOSE_SYSTEM : GLOBAL_READ_SYSTEM,
        text: requestText,
        label,
        maxOutputTokens: pageReadOutputCap(params.owned.length),
        reasoningOff: true,
      });
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens || 0;
        usage.outputTokens += response.usage.outputTokens || 0;
      }
      await params.onJournal?.({ label, rawText: response.rawText, requestText });
      const checked = checkReadOutput(response.rawText, response.json, params.owned, {
        format: params.format,
        hasOpenQuestion: Boolean(params.openQuestion),
        allowKeyOnlyPage: params.allowKeyOnlyPage,
      });
      return {
        ok: checked.ok,
        proposal: checked.ok ? checked.proposal : undefined,
        complaints: checked.complaints,
        usage,
        requestText,
        calls,
        attempts: attempt,
        // The retry succeeded, but the page record still reports the weather it flew through.
        ...(error ? { error } : {}),
      };
    } catch (err: any) {
      error = String(err?.message || err);
      if (attempt === 1 && isTransientProviderError(error)) {
        await wait(delay);
        continue;
      }
      return {
        ok: false,
        complaints: [error],
        usage,
        requestText,
        calls,
        attempts: attempt,
        error,
      };
    }
  }

  return {
    ok: false,
    complaints: [error || readAllowanceExhaustedReason(params.budget?.maxCalls ?? 0)],
    usage,
    requestText,
    calls,
    attempts: calls,
    ...(error ? { error } : {}),
  };
}

/**
 * Read a single page with the local `read` role (attempt 1, then 1 retry with validator complaint verbatim),
 * escalating ONLY that page to `cloudPageRead` if local still fails.
 */
export async function readSinglePageWithFallback(params: {
  chunk: ReadPageChunk;
  totalPages: number;
  allLines: SourceLine[];
  openQuestion?: OpenQuestionCarryOver;
  images?: ImageAsset[];
  caller?: ReadCaller;
  cloudCaller?: ReadCaller;
  model?: string;
  format?: ReadFormat;
  pageCache?: PageReadCache;
  budget?: ReadBudget;
  guidance?: string;
  allowKeyOnlyPage?: boolean;
  /** #42 test seam: delay before the single cloud transient-failure retry (defaults to 5s). */
  cloudRetryDelayMs?: number;
  /** #42 test seam: the wait function used by the cloud retry. */
  wait?: (ms: number) => Promise<void>;
  onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void>;
}): Promise<{
  proposal?: ReadProposal;
  status: SpinePageReadStatus;
  cached: boolean;
  localCalls: number;
  cloudCalls: number;
  /** #42: cloud calls spent on this page's rescue (1, or 2 after a transient retry). */
  cloudAttempts: number;
  /** #42: the provider/transport error text when the cloud route failed for weather, not content. */
  cloudError?: string;
  usage: { inputTokens: number; outputTokens: number };
  cloudUsage: { inputTokens: number; outputTokens: number };
  complaints: string[];
  /** #41: one entry per local attempt ("attempt N: …"), kept even when cloud rescued the page. */
  localComplaints: string[];
}> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const cloudUsage = { inputTokens: 0, outputTokens: 0 };
  const { chunk, totalPages } = params;
  const cacheKey = params.pageCache
    ? await pageReadCacheKey({
        owned: chunk.owned,
        context: chunk.context,
        model: params.model,
        format: params.format,
        guidance: params.guidance,
        images: params.images,
      })
    : undefined;

  if (params.pageCache && cacheKey) {
    try {
      const cachedEntry = await params.pageCache.get(cacheKey);
      const serialized = typeof cachedEntry === 'string' ? cachedEntry : cachedEntry?.serialized;
      const source = typeof cachedEntry === 'object' && cachedEntry?.source === 'cloud' ? 'cloud ok' : 'local ok';
      if (serialized) {
        // Re-validate the cached wire payload with the same never-throwing seam used for live output.
        let wire: unknown;
        try { wire = JSON.parse(serialized); } catch { wire = undefined; }
        const recheck = wire ? checkReadOutput('', wire, chunk.owned, { format: 'compact', allowUnclaimed: typeof cachedEntry === 'object' && cachedEntry?.format === 'verbose', hasOpenQuestion: Boolean(params.openQuestion), allowKeyOnlyPage: params.allowKeyOnlyPage }) : undefined;
        if (recheck?.ok) {
          const parsed = recheck.proposal;
          return {
            proposal: parsed,
            status: source,
            cached: true,
            localCalls: 0,
            cloudCalls: 0,
            cloudAttempts: 0,
            usage,
            cloudUsage,
            complaints: [],
            localComplaints: [],
          };
        }
      }
    } catch { /* fall through to live page read */ }
  }

  let complaints: string[] = [];
  const localComplaints: string[] = [];
  let localCalls = 0;
  let cloudCalls = 0;
  let cloudAttempts = 0;
  let cloudError: string | undefined;
  const allowanceOpen = () => !params.budget || params.budget.calls < params.budget.maxCalls;
  const exhausted = () => [readAllowanceExhaustedReason(params.budget?.maxCalls ?? 0)];

  if (params.caller) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!allowanceOpen()) {
        complaints = exhausted();
        break;
      }
      const label = totalPages === 1
        ? (attempt === 1 ? 'Global Read' : 'Global Read — validation retry')
        : (attempt === 1 ? `Global Read · page ${chunk.page}/${totalPages}` : `Global Read · page ${chunk.page}/${totalPages} — validation retry`);
      const text = buildPageReadPrompt({
        page: chunk.page,
        totalPages,
        owned: chunk.owned,
        context: chunk.context,
        openQuestion: params.openQuestion,
        images: params.images,
        guidance: params.guidance,
        complaints: attempt > 1 ? complaints : undefined,
        format: params.format,
      });
      // Every attempt is charged to the allowance before it is made, so a call that throws is never free.
      localCalls++;
      if (params.budget) params.budget.calls++;
      try {
        const response = await params.caller({
          system: params.format === 'verbose' ? GLOBAL_READ_VERBOSE_SYSTEM : GLOBAL_READ_SYSTEM,
          text,
          label,
          maxOutputTokens: pageReadOutputCap(chunk.owned.length),
          reasoningOff: true,
        });
        if (response.usage) {
          usage.inputTokens += response.usage.inputTokens || 0;
          usage.outputTokens += response.usage.outputTokens || 0;
        }
        await params.onJournal?.({ label, rawText: response.rawText, requestText: text });
        const checked = checkReadOutput(response.rawText, response.json, chunk.owned, {
          format: params.format,
          hasOpenQuestion: Boolean(params.openQuestion),
          allowKeyOnlyPage: params.allowKeyOnlyPage,
        });
        const parsed = checked.proposal;
        const parses = checked.parses;
        // A cut-off tail is not grounds to discard complete earlier questions.
        // Unclaimed tail lines flow into compiler reconciliation / scoped defects.
        if (!parses && params.format === 'verbose') {
          const salvaged = salvageVerbosePage(response.rawText);
          if (salvaged) {
            const partial = checkReadOutput('', salvaged, chunk.owned, { format: 'verbose', hasOpenQuestion: Boolean(params.openQuestion), allowKeyOnlyPage: params.allowKeyOnlyPage });
            if (partial.ok) return {
              proposal: partial.proposal, status: 'local ok', cached: false, localCalls, cloudCalls,
              cloudAttempts, usage, cloudUsage,
              complaints: ['read output truncated; complete questions salvaged; remaining lines require reconciliation'], localComplaints,
            };
          }
        }
        if (checked.ok) {
          if (params.pageCache && cacheKey) {
            await params.pageCache.set(cacheKey, { serialized: serializeReadProposal(parsed), source: 'local', format: params.format || 'compact' });
          }
          return {
            proposal: parsed,
            status: 'local ok',
            cached: false,
            localCalls,
            cloudCalls,
            cloudAttempts,
            usage,
            cloudUsage,
            complaints: [],
            localComplaints,
          };
        }
        complaints = checked.complaints;
        localComplaints.push(`attempt ${attempt}: ${(parses ? checked.complaints : [UNPARSEABLE_COMPLAINT, ...checked.complaints.filter(c => c !== UNPARSEABLE_COMPLAINT)]).join('; ')}`);
        // #41 fast-path: a model that cannot speak the schema gains nothing from the complaint read back.
        // Spend the call on the cloud rescue instead (only when a rescue exists; otherwise retry locally).
        if (attempt === 1 && params.cloudCaller && isFormatFailure({ parses, complaints, owned: chunk.owned, proposal: parsed })) break;
      } catch (err: any) {
        complaints = [String(err?.message || err)];
        if (err?.outputTokens) usage.outputTokens += err.outputTokens;
        localComplaints.push(`attempt ${attempt}: ${complaints[0]}`);
        if (attempt === 1 && params.cloudCaller && /counting loop in read stream/.test(complaints[0])) break;
      }
    }
  } else {
    complaints = ['no read model configured'];
  }

  if (params.cloudCaller) {
    if (!allowanceOpen()) {
      complaints = exhausted();
    } else {
      // #42: cloudPageRead charges the allowance per attempt (it may retry a transient failure once).
      const cloud = await cloudPageRead({
        page: chunk.page,
        totalPages,
        owned: chunk.owned,
        context: chunk.context,
        openQuestion: params.openQuestion,
        images: params.images,
        complaints,
        guidance: params.guidance,
        allowKeyOnlyPage: params.allowKeyOnlyPage,
        caller: params.cloudCaller,
        budget: params.budget,
        retryDelayMs: params.cloudRetryDelayMs,
        wait: params.wait,
        onJournal: params.onJournal,
      });
      cloudCalls += cloud.calls;
      cloudAttempts = cloud.attempts;
      cloudError = cloud.error;
      cloudUsage.inputTokens += cloud.usage.inputTokens;
      cloudUsage.outputTokens += cloud.usage.outputTokens;
      if (cloud.ok && cloud.proposal) {
        if (params.pageCache && cacheKey) {
          await params.pageCache.set(cacheKey, { serialized: serializeReadProposal(cloud.proposal), source: 'cloud', format: params.format || 'compact' });
        }
        return {
          proposal: cloud.proposal,
          status: 'cloud ok',
          cached: false,
          localCalls,
          cloudCalls,
          cloudAttempts,
          cloudError,
          usage,
          cloudUsage,
          complaints: [],
          localComplaints,
        };
      }
      complaints = cloud.complaints.length ? cloud.complaints : complaints;
    }
  }

  return {
    proposal: undefined,
    status: 'failed',
    cached: false,
    localCalls,
    cloudCalls,
    cloudAttempts,
    ...(cloudError ? { cloudError } : {}),
    usage,
    cloudUsage,
    complaints,
    localComplaints,
  };
}

/**
 * Page-wise Global Read stage.
 * Always executes one read per sheet (page) with 30-line read-only context overlap (`ctx`) and
 * open-question carry-over. A failed page retries locally once with verbatim validator complaint,
 * then escalates ONLY that page to `cloudPageRead`; if still failing, only that page is marked
 * `failed` while all other pages assemble normally.
 */
export async function runGlobalReadStage(params: {
  lines: SourceLine[];
  images?: ImageAsset[];
  caller?: ReadCaller;
  cloudCaller?: ReadCaller;
  model?: string;
  format?: ReadFormat;
  pageCache?: PageReadCache;
  cached?: string;
  budget?: ReadBudget;
  guidance?: string;
  /** #42 test seam: delay before the single cloud transient-failure retry (defaults to 5s). */
  cloudRetryDelayMs?: number;
  /** #42 test seam: the wait function used by the cloud retry. */
  wait?: (ms: number) => Promise<void>;
  onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void>;
  onPageUpdate?: (pageReport: SpinePageReadRecord, completedPages: number, totalPages: number) => void | Promise<void>;
}): Promise<GlobalReadResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const cloudUsage = { inputTokens: 0, outputTokens: 0 };
  const format = params.format || 'compact';

  if (params.cached) {
    const p = deserializeReadProposal(params.cached);
    if (p && validateReadProposal(p, params.lines).ok) {
      const chunks = buildReadChunks(params.lines);
      const pages: SpinePageReadRecord[] = chunks.map(c => ({
        page: c.page,
        status: 'local ok',
        format,
        outputTokens: 0,
        cached: true,
        calls: 0,
        questions: p.questions.filter(q => q.spans.some(([a]) => c.owned.some(l => lineNo(l) === a))).length,
      }));
      return {
        status: 'cached',
        proposal: p,
        serialized: params.cached,
        complaints: [],
        calls: 0,
        cloudCalls: 0,
        readAllowance: readAllowanceForPages(chunks.length),
        attempts: 0,
        usage,
        cloudUsage,
        pages,
        failedPages: [],
        pageProposals: {},
      };
    }
  }

  if (!params.caller && !params.cloudCaller) {
    return {
      status: 'unavailable',
      complaints: ['no read model configured'],
      calls: 0,
      cloudCalls: 0,
      readAllowance: 0,
      attempts: 0,
      usage,
      cloudUsage,
      pages: [],
      failedPages: [],
      pageProposals: {},
    };
  }

  const chunks = buildReadChunks(params.lines);
  // #41: the read stage owns its allowance (pages × 3 + 6). Nothing here is rationed by agentLimits.
  const readAllowance = readAllowanceForPages(chunks.length);
  const readBudget: ReadBudget = params.budget ?? { calls: 0, maxCalls: readAllowance };
  if (!chunks.length) {
    return {
      status: 'invalid',
      complaints: [NO_QUESTIONS_COMPLAINT],
      calls: 0,
      cloudCalls: 0,
      readAllowance: 0,
      attempts: 0,
      usage,
      cloudUsage,
      pages: [],
      failedPages: [],
      pageProposals: {},
    };
  }

  const entries: Array<{ page: number; owned: SourceLine[]; proposal?: ReadProposal }> = [];
  const pages: SpinePageReadRecord[] = [];
  const allComplaints: string[] = [];
  let calls = 0;
  let cloudCalls = 0;
  let maxAttempts = 0;
  let allCached = true;
  let openQuestion: OpenQuestionCarryOver | undefined;
  let questionsSeenSoFar = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = await readSinglePageWithFallback({
      chunk,
      totalPages: chunks.length,
      allLines: params.lines,
      openQuestion,
      images: params.images,
      caller: params.caller,
      cloudCaller: params.cloudCaller,
      model: params.model,
      format,
      pageCache: params.pageCache,
      budget: readBudget,
      guidance: params.guidance,
      allowKeyOnlyPage: chunks.length > 1 && questionsSeenSoFar > 0,
      cloudRetryDelayMs: params.cloudRetryDelayMs,
      wait: params.wait,
      onJournal: params.onJournal,
    });

    calls += result.localCalls;
    cloudCalls += result.cloudCalls;
    maxAttempts = Math.max(maxAttempts, result.localCalls + result.cloudCalls);
    if (!result.cached) allCached = false;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    cloudUsage.inputTokens += result.cloudUsage.inputTokens;
    cloudUsage.outputTokens += result.cloudUsage.outputTokens;

    entries.push({ page: chunk.page, owned: chunk.owned, proposal: result.proposal });
    const qCount = result.proposal?.questions.length || 0;
    questionsSeenSoFar += qCount;

    const pageRecord: SpinePageReadRecord = {
      page: chunk.page,
      status: result.status,
      format,
      outputTokens: result.usage.outputTokens + result.cloudUsage.outputTokens,
      ...(result.cached ? { cached: true } : {}),
      calls: result.localCalls + result.cloudCalls,
      cloudCalls: result.cloudCalls,
      ...(result.cloudCalls ? { cloudAttempts: result.cloudAttempts } : {}),
      ...(result.cloudError ? { cloudError: result.cloudError } : {}),
      runningCalls: calls + cloudCalls,
      localComplaints: result.localComplaints,
      questions: qCount,
      ...(result.complaints.length ? { reason: result.complaints.join('; ') } : {}),
    };
    pages.push(pageRecord);
    if (result.complaints.length) {
      allComplaints.push(...result.complaints.map(c => chunks.length > 1 ? `page ${chunk.page}: ${c}` : c));
    }

    openQuestion = result.proposal
      ? openQuestionAfterPage(result.proposal, chunk.owned, params.lines, openQuestion)
      : undefined;

    await params.onPageUpdate?.(pageRecord, i + 1, chunks.length);
  }

  const failedPages = pages.filter(p => p.status === 'failed').map(p => p.page);
  const { proposal, pageProposals } = mergePageProposals(entries, params.lines);

  if (!proposal) {
    return {
      status: 'invalid',
      complaints: allComplaints.length ? allComplaints : [NO_QUESTIONS_COMPLAINT],
      calls,
      cloudCalls,
      readAllowance,
      attempts: maxAttempts || 1,
      usage,
      cloudUsage,
      pages,
      failedPages: failedPages.length ? failedPages : chunks.map(c => c.page),
      pageProposals,
    };
  }

  const status: GlobalReadResult['status'] = failedPages.length > 0
    ? 'partial'
    : allCached
      ? 'cached'
      : 'completed';

  return {
    status,
    proposal,
    serialized: serializeReadProposal(proposal),
    complaints: allComplaints,
    calls,
    cloudCalls,
    readAllowance,
    attempts: maxAttempts,
    usage,
    cloudUsage,
    pages,
    failedPages,
    pageProposals,
  };
}

const marksNumber = (text: string): number | undefined => {
  const normalized = text.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = normalized.match(/(?:marks?|points?|pts?|نمره)\s*[:=]?\s*(\d+(?:[./]\d+)?)|[(\[]\s*(\d+(?:[./]\d+)?)\s*(?:marks?|points?|نمره)?\s*[)\]]/i);
  const value = Number((m?.[1] || m?.[2] || '').replace('/', '.'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export function assembleReadProposal(proposal: ReadProposal, lines: SourceLine[]): { questions: Question[]; sections: ExamSection[]; keyLineNos: number[]; furnitureLineNos: number[] } {
  const byNo = new Map(lines.map(l => [lineNo(l), l]));
  const questions: Question[] = proposal.questions.map((q, i) => {
    const points = q.marksEvidence?.map(([a, b]) => { for (let n = a; n <= b; n++) { const v = marksNumber(byNo.get(n)?.text || ''); if (v !== undefined) return v; } return undefined; }).find(v => v !== undefined);
    const options = q.optionSpans?.map(o => ({ key: o.key, spans: o.spans, text: sliceSourceSpans(o.spans, lines) }));
    const answerText = q.answerSpans?.length ? sliceSourceSpans(q.answerSpans, lines) : proposal.answerKey[String(q.no)]?.value;
    const answerLines = (q.answerSpans || []).flatMap(([start, end]) => Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => start + offset));
    const answerEvidence = Boolean(answerText?.trim()) && answerLines.length > 0 && answerLines.every(number => byNo.get(number)?.tag === 'key');
    return { id: `q_read_${q.no}_${i + 1}`, no: q.no, label: String(q.no), sectionId: q.section, spans: q.spans, stem: sliceSourceSpans(q.spans, lines), type: q.type, ...(points !== undefined ? { points } : {}), ...(options?.length ? { options } : {}), ...(answerText && answerEvidence ? { answer: { source: 'paper' as const, text: answerText, spans: q.answerSpans } } : {}), ...(answerText && !answerEvidence ? { enrichment: { source: 'model' as const, verification: 'unjudged' as const, proposedAnswer: { text: answerText, source: 'model' as const } } } : {}), images: (q.imageIds || []).map(imageId => ({ imageId, role: 'stem' as const })), confidence: 1 };
  });
  for (let i = 0; i < proposal.questions.length; i++) if (proposal.questions[i].parentNo) questions[i].parentId = questions.find(x => x.no === proposal.questions[i].parentNo && x.id !== questions[i].id)?.id;
  const sections: ExamSection[] = proposal.sections.map((s, i) => ({ id: s.id, index: i + 1, title: s.title, spans: s.spans }));
  return { questions, sections, keyLineNos: [...proposal.labels].filter(([, l]) => l === 'key' || l === 'marks').map(([n]) => n), furnitureLineNos: [...proposal.labels].filter(([, l]) => l === 'furniture').map(([n]) => n) };
}
