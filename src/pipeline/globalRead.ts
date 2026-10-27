import type { ExamSection, ImageAsset, Question, SourceLine, SpinePageReadRecord, SpinePageReadStatus } from '../types';
import { sha256 } from '../utils/hash';
import { sliceSourceSpans } from './spans';

/** The only semantic parse made on the default path. Code validates per-page proposals and merges them arithmetically. */
export const READ_VERSION = 'global-read-v2';
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
  return validatePageProposal(proposal, lines, { hasOpenQuestion: false, allowKeyOnlyPage: false });
}

export function validatePageProposal(
  proposal: ReadProposal,
  ownedLines: SourceLine[],
  opts: { hasOpenQuestion?: boolean; allowKeyOnlyPage?: boolean } = {},
): ReadValidation {
  const expected = new Set(ownedLines.map(l => no(l.id)));
  const counts = new Map<number, number>();
  const complaints: string[] = [];
  for (const [a, b] of proposal.ranges) for (let n = a; n <= b; n++) counts.set(n, (counts.get(n) || 0) + 1);
  const missing = [...expected].filter(n => !counts.has(n));
  const duplicate = [...counts].filter(([n, c]) => expected.has(n) && c !== 1).map(([n]) => n);
  const outside = [...counts.keys()].filter(n => !expected.has(n));
  if (missing.length) complaints.push(`every line must be accounted for exactly once; unlabelled lines: ${missing.slice(0, 30).join(', ')}`);
  if (duplicate.length) complaints.push(`line labels overlap; multiply-labelled lines: ${duplicate.slice(0, 30).join(', ')}`);
  if (outside.length) complaints.push(`label ranges cite lines outside the document: ${outside.slice(0, 30).join(', ')}`);

  const outsideQuestionLines: number[] = [];
  for (const q of proposal.questions) {
    for (const [a, b] of q.spans) for (let n = a; n <= b; n++) if (!expected.has(n)) outsideQuestionLines.push(n);
    for (const opt of q.optionSpans || []) for (const [a, b] of opt.spans) for (let n = a; n <= b; n++) if (!expected.has(n)) outsideQuestionLines.push(n);
  }
  if (outsideQuestionLines.length) {
    complaints.push(`question spans cite lines outside this page: ${[...new Set(outsideQuestionLines)].slice(0, 30).join(', ')}`);
  }

  if (!proposal.questions.length) {
    const ownedLabels = [...proposal.labels.entries()].filter(([n]) => expected.has(n)).map(([, l]) => l);
    const hasQuestionLabel = ownedLabels.includes('question');
    const hasValidContinuation = Boolean(opts.hasOpenQuestion) && ownedLabels.some(l => l === 'continuation' || l === 'option');
    const hasKey = opts.allowKeyOnlyPage !== false && Object.keys(proposal.answerKey).length > 0 && ownedLabels.includes('key');
    if (hasQuestionLabel || (!hasValidContinuation && !hasKey)) {
      complaints.push('the proposal contains no questions');
    }
  }

  const nums = proposal.questions.map(q => q.no);
  const dupNos = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  if (dupNos.length) complaints.push(`printed question numbers must be unique; duplicates: ${dupNos.join(', ')}`);
  const claimed = new Map<number, number>();
  const parentNos = new Set(proposal.questions.map(q => q.parentNo).filter((n): n is number => typeof n === 'number' && n > 0));
  for (const q of proposal.questions) {
    if (q.parentNo && parentNos.has(q.parentNo)) continue;
    for (const [a, b] of q.spans) for (let n = a; n <= b; n++) claimed.set(n, (claimed.get(n) || 0) + 1);
  }
  const overlaps = [...claimed].filter(([, c]) => c > 1).map(([n]) => n);
  if (overlaps.length) complaints.push(`question spans overlap on lines: ${overlaps.slice(0, 30).join(', ')}`);
  return { ok: complaints.length === 0, complaints };
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
}): string {
  const firstId = params.owned[0]?.id || 'L0001';
  const lastId = params.owned.at(-1)?.id || firstId;
  const guidanceBlock = params.guidance ? `LEARNED GUIDANCE (advisory):\n${params.guidance}\n\n` : '';
  const pageHeader = `Page ${params.page}/${params.totalPages}. Label ONLY page ${params.page}'s non-ctx lines (${firstId}..${lastId}).${params.context.length ? ' Lines marked ctx are read-only overlap from the previous page; do not label or own them.' : ''}\n`;
  const carryOver = `OPEN QUESTION FROM PREVIOUS PAGE: ${formatOpenQuestionState(params.openQuestion)}\n`;
  const imageBlock = renderPageImagesBlock(params.images, params.page);
  const complaintBlock = params.complaints?.length ? `\n\nVALIDATOR COMPLAINT (fix this exactly):\n${params.complaints.join('\n')}` : '';
  return `${guidanceBlock}${pageHeader}${carryOver}${imageBlock}${renderLines(params.owned, params.context)}${complaintBlock}`;
}

export async function pageReadCacheKey(params: {
  owned: SourceLine[];
  context: SourceLine[];
  model?: string;
  guidance?: string;
  images?: ImageAsset[];
}): Promise<string> {
  const ownedSig = params.owned.map(l => `${l.id}|${l.page}|${Math.round(l.y || 0)}|${l.text}`).join('\n');
  const ctxSig = params.context.map(l => `${l.id}|${l.page}|${Math.round(l.y || 0)}|${l.text}`).join('\n');
  const guidanceHash = (await sha256(params.guidance || '')).slice(0, 16);
  const page = params.owned[0]?.page ?? 0;
  const imgSig = renderPageImagesBlock(params.images, page);
  const full = await sha256(`${READ_VERSION}\nmodel:${params.model || 'default'}\nguidance:${guidanceHash}\nimages:${imgSig}\nctx:\n${ctxSig}\nowned:\n${ownedSig}`);
  return `page-read-${READ_VERSION}-${full.slice(0, 32)}`;
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

/**
 * Re-read a single failed page via the canonical `cloud` role (`cloudPageRead`, same schema).
 * Locality boundary: ONLY that page's lines + at most 30 `ctx` lines from the previous page are sent.
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
  allowKeyOnlyPage?: boolean;
  caller: ReadCaller;
  onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void>;
}): Promise<{
  ok: boolean;
  proposal?: ReadProposal;
  complaints: string[];
  usage: { inputTokens: number; outputTokens: number };
  requestText: string;
}> {
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
  });
  const label = `Cloud · Page ${params.page} Read`;
  try {
    const response = await params.caller({
      system: GLOBAL_READ_SYSTEM,
      text: requestText,
      label,
      maxOutputTokens: 32000,
      reasoningOff: true,
    });
    if (response.usage) {
      usage.inputTokens += response.usage.inputTokens || 0;
      usage.outputTokens += response.usage.outputTokens || 0;
    }
    await params.onJournal?.({ label, rawText: response.rawText, requestText });
    const parsed = parseReadProposal(response.rawText, response.json);
    const checked = validatePageProposal(parsed, params.owned, {
      hasOpenQuestion: Boolean(params.openQuestion),
      allowKeyOnlyPage: params.allowKeyOnlyPage,
    });
    return {
      ok: checked.ok,
      proposal: checked.ok ? parsed : undefined,
      complaints: checked.complaints,
      usage,
      requestText,
    };
  } catch (err: any) {
    return {
      ok: false,
      complaints: [String(err?.message || err)],
      usage,
      requestText,
    };
  }
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
  pageCache?: PageReadCache;
  budget?: ReadBudget;
  guidance?: string;
  allowKeyOnlyPage?: boolean;
  onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void>;
}): Promise<{
  proposal?: ReadProposal;
  status: SpinePageReadStatus;
  cached: boolean;
  localCalls: number;
  cloudCalls: number;
  usage: { inputTokens: number; outputTokens: number };
  cloudUsage: { inputTokens: number; outputTokens: number };
  complaints: string[];
}> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const cloudUsage = { inputTokens: 0, outputTokens: 0 };
  const { chunk, totalPages } = params;
  const cacheKey = params.pageCache
    ? await pageReadCacheKey({
        owned: chunk.owned,
        context: chunk.context,
        model: params.model,
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
        const parsed = deserializeReadProposal(serialized);
        if (parsed && validatePageProposal(parsed, chunk.owned, { hasOpenQuestion: Boolean(params.openQuestion), allowKeyOnlyPage: params.allowKeyOnlyPage }).ok) {
          return {
            proposal: parsed,
            status: source,
            cached: true,
            localCalls: 0,
            cloudCalls: 0,
            usage,
            cloudUsage,
            complaints: [],
          };
        }
      }
    } catch { /* fall through to live page read */ }
  }

  let complaints: string[] = [];
  let localCalls = 0;
  let cloudCalls = 0;

  if (params.caller) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (params.budget && params.budget.calls >= params.budget.maxCalls) {
        complaints = ['model-call budget exhausted'];
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
      });
      try {
        const response = await params.caller({
          system: GLOBAL_READ_SYSTEM,
          text,
          label,
          maxOutputTokens: 32000,
          reasoningOff: true,
        });
        localCalls++;
        if (params.budget) params.budget.calls++;
        if (response.usage) {
          usage.inputTokens += response.usage.inputTokens || 0;
          usage.outputTokens += response.usage.outputTokens || 0;
        }
        await params.onJournal?.({ label, rawText: response.rawText, requestText: text });
        const parsed = parseReadProposal(response.rawText, response.json);
        const checked = validatePageProposal(parsed, chunk.owned, {
          hasOpenQuestion: Boolean(params.openQuestion),
          allowKeyOnlyPage: params.allowKeyOnlyPage,
        });
        if (checked.ok) {
          if (params.pageCache && cacheKey) {
            await params.pageCache.set(cacheKey, { serialized: serializeReadProposal(parsed), source: 'local' });
          }
          return {
            proposal: parsed,
            status: 'local ok',
            cached: false,
            localCalls,
            cloudCalls,
            usage,
            cloudUsage,
            complaints: [],
          };
        }
        complaints = checked.complaints;
      } catch (err: any) {
        complaints = [String(err?.message || err)];
      }
    }
  } else {
    complaints = ['no read model configured'];
  }

  if (params.cloudCaller && (!params.budget || params.budget.calls < params.budget.maxCalls)) {
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
      onJournal: params.onJournal,
    });
    cloudCalls++;
    if (params.budget) params.budget.calls++;
    cloudUsage.inputTokens += cloud.usage.inputTokens;
    cloudUsage.outputTokens += cloud.usage.outputTokens;
    if (cloud.ok && cloud.proposal) {
      if (params.pageCache && cacheKey) {
        await params.pageCache.set(cacheKey, { serialized: serializeReadProposal(cloud.proposal), source: 'cloud' });
      }
      return {
        proposal: cloud.proposal,
        status: 'cloud ok',
        cached: false,
        localCalls,
        cloudCalls,
        usage,
        cloudUsage,
        complaints: [],
      };
    }
    complaints = cloud.complaints.length ? cloud.complaints : complaints;
  }

  return {
    proposal: undefined,
    status: 'failed',
    cached: false,
    localCalls,
    cloudCalls,
    usage,
    cloudUsage,
    complaints,
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
  pageCache?: PageReadCache;
  cached?: string;
  budget?: ReadBudget;
  guidance?: string;
  onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void>;
  onPageUpdate?: (pageReport: SpinePageReadRecord, completedPages: number, totalPages: number) => void | Promise<void>;
}): Promise<GlobalReadResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const cloudUsage = { inputTokens: 0, outputTokens: 0 };

  if (params.cached) {
    const p = deserializeReadProposal(params.cached);
    if (p && validateReadProposal(p, params.lines).ok) {
      const chunks = buildReadChunks(params.lines);
      const pages: SpinePageReadRecord[] = chunks.map(c => ({
        page: c.page,
        status: 'local ok',
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
      attempts: 0,
      usage,
      cloudUsage,
      pages: [],
      failedPages: [],
      pageProposals: {},
    };
  }

  const chunks = buildReadChunks(params.lines);
  if (!chunks.length) {
    return {
      status: 'invalid',
      complaints: ['the proposal contains no questions'],
      calls: 0,
      cloudCalls: 0,
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
      pageCache: params.pageCache,
      budget: params.budget,
      guidance: params.guidance,
      allowKeyOnlyPage: chunks.length > 1 && questionsSeenSoFar > 0,
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
      ...(result.cached ? { cached: true } : {}),
      calls: result.localCalls + result.cloudCalls,
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
      complaints: allComplaints.length ? allComplaints : ['the proposal contains no questions'],
      calls,
      cloudCalls,
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
    return { id: `q_read_${q.no}_${i + 1}`, no: q.no, label: String(q.no), sectionId: q.section, spans: q.spans, stem: sliceSourceSpans(q.spans, lines), type: q.type, ...(points !== undefined ? { points } : {}), ...(options?.length ? { options } : {}), ...(answerText ? { answer: { source: 'paper' as const, text: answerText, ...(q.answerSpans ? { spans: q.answerSpans } : {}) } } : {}), images: (q.imageIds || []).map(imageId => ({ imageId, role: 'stem' as const })), confidence: 1 };
  });
  for (let i = 0; i < proposal.questions.length; i++) if (proposal.questions[i].parentNo) questions[i].parentId = questions.find(x => x.no === proposal.questions[i].parentNo && x.id !== questions[i].id)?.id;
  const sections: ExamSection[] = proposal.sections.map((s, i) => ({ id: s.id, index: i + 1, title: s.title, spans: s.spans }));
  return { questions, sections, keyLineNos: [...proposal.labels].filter(([, l]) => l === 'key' || l === 'marks').map(([n]) => n), furnitureLineNos: [...proposal.labels].filter(([, l]) => l === 'furniture').map(([n]) => n) };
}
