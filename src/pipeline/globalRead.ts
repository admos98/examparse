import type { ExamSection, Question, SourceLine } from '../types';
import { sliceSourceSpans } from './spans';

/** The only semantic parse made on the default path. Code validates this proposal; it does not infer it. */
export const READ_VERSION = 'global-read-v1';
export const READ_LABELS = ['furniture', 'section', 'instruction', 'question', 'continuation', 'option', 'passage', 'key', 'marks'] as const;
export type ReadLabel = typeof READ_LABELS[number];
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
}
export interface ReadValidation { ok: boolean; complaints: string[] }
export interface ReadCaller {
  (request: { system: string; text: string; label: string; maxOutputTokens: number; reasoningOff: true }): Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
}
export interface ReadBudget { calls: number; units: number; maxCalls: number; maxUnits: number }
export interface GlobalReadResult {
  status: 'completed' | 'cached' | 'invalid' | 'unavailable' | 'failed';
  proposal?: ReadProposal;
  complaints: string[];
  calls: number;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
  serialized?: string;
}

export const GLOBAL_READ_SYSTEM = `You are ExamRead. Read the whole printed exam and propose the complete document in one pass. Reasoning is OFF. Return JSON only and never copy or author question text: code slices text from your line spans.
Output {"r":[[start,end,label]],"q":[{"n":1,"p":[[10,12]],"s":"sec1","t":"mcq","o":[["a",[[11,11]]] ],"v":[[12,12]],"a":[[90,90]],"i":["img1"]}],"s":[{"id":"sec1","title":"Vocabulary","p":[[8,40]],"h":8}],"m":{"subject":{"value":"English","line":2},"grade":{"value":"12","line":3},"total":{"value":40,"line":95}},"k":{"1":{"value":"b","p":[[90,90]]}}}.
Labels are exactly furniture|section|instruction|question|continuation|option|passage|key|marks. Label every requested line exactly once. Give every printed question number and its complete boundary. Type is mcq|truefalse|short|long|fillblank|matching|multi|numeric|diagram|essay|unknown. v is ONLY line spans that explicitly print that question's marks; omit it when marks are not printed. Never infer/distribute points. Meta fields require one evidence line each. A repeated header, footer, page number, or “continued” line is furniture, never a section or question. Use ranges economically. /no_think`;

const no = (value: unknown): number => Number(String(value ?? '').replace(/[^0-9۰-۹٠-٩]/g, '').replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))));
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
export function parseReadProposal(rawText: string, json?: unknown): ReadProposal {
  const value = candidate(rawText, json) || {};
  const ranges: ReadRange[] = [];
  const labels = new Map<number, ReadLabel>();
  for (const row of value.r || value.ranges || []) {
    const a = no(Array.isArray(row) ? row[0] : row.start ?? row.line);
    const b = no(Array.isArray(row) ? row[1] : row.end ?? row.start ?? row.line);
    const label = labelOf(Array.isArray(row) ? row[2] : row.label);
    if (!label || !Number.isInteger(a) || a < 1 || !Number.isInteger(b) || b < a || b - a > 10000) continue;
    ranges.push([a, b, label]);
    for (let n = a; n <= b; n++) if (!labels.has(n)) labels.set(n, label);
  }
  const questions: ReadQuestion[] = [];
  for (const row of value.q || value.questions || []) {
    const printed = no(row.n ?? row.no ?? row.number);
    const spans = spanList(row.p ?? row.spans);
    if (!Number.isInteger(printed) || printed < 1 || !spans.length) continue;
    const options = (row.o || row.options || []).map((o: any) => ({ key: String(Array.isArray(o) ? o[0] : o.key || ''), spans: spanList(Array.isArray(o) ? o[1] : o.spans) })).filter((o: any) => o.key && o.spans.length);
    questions.push({ no: printed, spans, section: row.s ?? row.section, type: typeOf(row.t ?? row.type), ...(options.length ? { optionSpans: options } : {}), ...(spanList(row.v ?? row.marksEvidence).length ? { marksEvidence: spanList(row.v ?? row.marksEvidence) } : {}), ...(spanList(row.a ?? row.answerSpans).length ? { answerSpans: spanList(row.a ?? row.answerSpans) } : {}), ...(Array.isArray(row.i ?? row.imageIds) ? { imageIds: (row.i ?? row.imageIds).map(String) } : {}), ...(no(row.g ?? row.parentNo) > 0 ? { parentNo: no(row.g ?? row.parentNo) } : {}) });
  }
  const sections: ReadSection[] = (value.s || value.sections || []).filter((s: any) => s && !Array.isArray(s)).map((s: any, i: number) => ({ id: String(s.id || `section_${i + 1}`), title: String(s.title ?? s.kind ?? '').trim(), spans: spanList(s.p ?? s.spans), ...(no(s.h ?? s.headerLine) > 0 ? { headerLine: no(s.h ?? s.headerLine) } : {}) })).filter((s: ReadSection) => s.spans.length);
  const meta: ReadProposal['meta'] = {};
  const rawMeta = value.m || value.meta || {};
  for (const key of ['subject', 'grade', 'total', 'date'] as const) {
    const field = rawMeta[key] ?? (key === 'total' ? rawMeta.totalPoints : undefined);
    if (field && typeof field === 'object' && no(field.line ?? field.evidenceLine) > 0) (meta as any)[key] = { value: field.value, evidenceLine: no(field.line ?? field.evidenceLine) };
  }
  const answerKey: ReadProposal['answerKey'] = {};
  for (const [key, entry] of Object.entries(value.k || value.answerKey || {})) answerKey[key] = typeof entry === 'object' && entry ? { value: String((entry as any).value ?? ''), spans: spanList((entry as any).p ?? (entry as any).spans) } : { value: String(entry) };
  return { labels, ranges, questions, sections, meta, answerKey };
}

export function validateReadProposal(proposal: ReadProposal, lines: SourceLine[]): ReadValidation {
  const expected = new Set(lines.map(l => no(l.id)));
  const counts = new Map<number, number>();
  const complaints: string[] = [];
  for (const [a, b] of proposal.ranges) for (let n = a; n <= b; n++) counts.set(n, (counts.get(n) || 0) + 1);
  const missing = [...expected].filter(n => !counts.has(n));
  const duplicate = [...counts].filter(([n, c]) => expected.has(n) && c !== 1).map(([n]) => n);
  const outside = [...counts.keys()].filter(n => !expected.has(n));
  if (missing.length) complaints.push(`every line must be accounted for exactly once; unlabelled lines: ${missing.slice(0, 30).join(', ')}`);
  if (duplicate.length) complaints.push(`line labels overlap; multiply-labelled lines: ${duplicate.slice(0, 30).join(', ')}`);
  if (outside.length) complaints.push(`label ranges cite lines outside the document: ${outside.slice(0, 30).join(', ')}`);
  if (!proposal.questions.length) complaints.push('the proposal contains no questions');
  const nums = proposal.questions.map(q => q.no);
  const dupNos = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  if (dupNos.length) complaints.push(`printed question numbers must be unique; duplicates: ${dupNos.join(', ')}`);
  const claimed = new Map<number, number>();
  for (const q of proposal.questions) for (const [a, b] of q.spans) for (let n = a; n <= b; n++) claimed.set(n, (claimed.get(n) || 0) + 1);
  const overlaps = [...claimed].filter(([, c]) => c > 1).map(([n]) => n);
  if (overlaps.length) complaints.push(`question spans overlap on lines: ${overlaps.slice(0, 30).join(', ')}`);
  return { ok: complaints.length === 0, complaints };
}

export function serializeReadProposal(proposal: ReadProposal): string {
  return JSON.stringify({ v: READ_VERSION, r: proposal.ranges, q: proposal.questions, s: proposal.sections, m: proposal.meta, k: proposal.answerKey });
}
export function deserializeReadProposal(raw: string): ReadProposal | undefined { try { return parseReadProposal('', JSON.parse(raw)); } catch { return undefined; } }
const lineNo = (l: SourceLine) => no(l.id);
export const READ_OVERLAP_LINES = 10;
export function buildReadChunks(lines: SourceLine[], maxLines = 1200): Array<{ owned: SourceLine[]; context: SourceLine[] }> {
  const sorted = [...lines].sort((a, b) => lineNo(a) - lineNo(b));
  if (sorted.length <= maxLines) return [{ owned: sorted, context: [] }];
  const pages = new Map<number, SourceLine[]>();
  for (const line of sorted) pages.set(line.page, [...(pages.get(line.page) || []), line]);
  const out: Array<{ owned: SourceLine[]; context: SourceLine[] }> = []; let owned: SourceLine[] = [];
  const flush = () => { if (!owned.length) return; out.push({ owned, context: out.at(-1)?.owned.slice(-READ_OVERLAP_LINES) || [] }); owned = []; };
  for (const page of pages.values()) { if (owned.length && owned.length + page.length > maxLines) flush(); owned.push(...page); }
  flush(); return out;
}
function render(lines: SourceLine[], context: SourceLine[] = []): string {
  const ctx = new Set(context.map(lineNo));
  return [...context, ...lines].map(l => `[${l.id} p${l.page} y${Math.round(l.y || 0)}]${ctx.has(lineNo(l)) ? ' ctx' : ''} ${l.text}`).join('\n');
}

/** One whole-paper call when it fits. A failed validation gets one retry containing the complaint verbatim. */
export async function runGlobalReadStage(params: { lines: SourceLine[]; caller?: ReadCaller; cached?: string; budget?: ReadBudget; maxLinesPerCall?: number; guidance?: string; onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void> }): Promise<GlobalReadResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  if (params.cached) { const p = deserializeReadProposal(params.cached); if (p && validateReadProposal(p, params.lines).ok) return { status: 'cached', proposal: p, serialized: params.cached, complaints: [], calls: 0, attempts: 0, usage }; }
  if (!params.caller) return { status: 'unavailable', complaints: ['no read model configured'], calls: 0, attempts: 0, usage };
  const chunks = buildReadChunks(params.lines, params.maxLinesPerCall);
  let complaints: string[] = []; let calls = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const proposals: ReadProposal[] = []; let failed = '';
    for (let i = 0; i < chunks.length; i++) {
      if (params.budget && params.budget.calls >= params.budget.maxCalls) return { status: 'failed', complaints: ['model-call budget exhausted'], calls, attempts: attempt, usage };
      const complaint = attempt > 1 ? `\n\nVALIDATOR COMPLAINT (fix this exactly):\n${complaints.join('\n')}` : '';
      const text = `${params.guidance ? `LEARNED GUIDANCE (advisory):\n${params.guidance}\n\n` : ''}${chunks.length > 1 ? `Part ${i + 1}/${chunks.length}. Lines marked ctx are read-only overlap; do not label or own them.\n` : ''}${render(chunks[i].owned, chunks[i].context)}${complaint}`;
      try {
        const response = await params.caller({ system: GLOBAL_READ_SYSTEM, text, label: attempt === 1 ? 'Global Read' : 'Global Read — validation retry', maxOutputTokens: 32000, reasoningOff: true });
        calls++; if (params.budget) params.budget.calls++;
        if (response.usage) { usage.inputTokens += response.usage.inputTokens || 0; usage.outputTokens += response.usage.outputTokens || 0; }
        await params.onJournal?.({ label: attempt === 1 ? 'Global Read' : 'Global Read — validation retry', rawText: response.rawText, requestText: text });
        proposals.push(parseReadProposal(response.rawText, response.json));
      } catch (err: any) { failed = String(err?.message || err); break; }
    }
    if (failed) return { status: 'failed', complaints: [failed], calls, attempts: attempt, usage };
    const merged: ReadProposal = { labels: new Map(), ranges: [], questions: [], sections: [], meta: {}, answerKey: {} };
    proposals.forEach((p, i) => {
      const owned = new Set(chunks[i].owned.map(lineNo));
      for (const [a, b, label] of p.ranges) {
        const accepted = Array.from({ length: b - a + 1 }, (_, x) => a + x).filter(n => owned.has(n));
        for (const n of accepted) { merged.labels.set(n, label); merged.ranges.push([n, n, label]); }
      }
      merged.questions.push(...p.questions.filter(q => q.spans.some(([a]) => owned.has(a))));
      merged.sections.push(...p.sections.filter(s => s.spans.some(([a]) => owned.has(a))));
      Object.assign(merged.meta, p.meta); Object.assign(merged.answerKey, p.answerKey);
    });
    const checked = validateReadProposal(merged, params.lines); complaints = checked.complaints;
    if (checked.ok) return { status: 'completed', proposal: merged, serialized: serializeReadProposal(merged), complaints: [], calls, attempts: attempt, usage };
  }
  return { status: 'invalid', complaints, calls, attempts: 2, usage };
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
    return { id: `q_read_${q.no}_${i + 1}`, no: q.no, label: String(q.no), sectionId: q.section, spans: q.spans, stem: sliceSourceSpans(q.spans, lines), type: q.type, ...(points !== undefined ? { points } : {}), ...(options?.length ? { options } : {}), ...(answerText ? { answer: { source: 'paper' as const, text: answerText, ...(q.answerSpans ? { spans: q.answerSpans } : {}) } } : {}), images: (q.imageIds || []).map(imageId => ({ imageId, role: 'stem' as const })), confidence: 1 };
  });
  for (let i = 0; i < proposal.questions.length; i++) if (proposal.questions[i].parentNo) questions[i].parentId = questions.find(x => x.no === proposal.questions[i].parentNo && x.id !== questions[i].id)?.id;
  const sections: ExamSection[] = proposal.sections.map((s, i) => ({ id: s.id, index: i + 1, title: s.title, spans: s.spans }));
  return { questions, sections, keyLineNos: [...proposal.labels].filter(([, l]) => l === 'key' || l === 'marks').map(([n]) => n), furnitureLineNos: [...proposal.labels].filter(([, l]) => l === 'furniture').map(([n]) => n) };
}
