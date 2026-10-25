/**
 * #38 AI-First Spine — Part A (global line classification) + Part B (assembly from labels).
 *
 * Division of labour (the batch's law): the MODEL decides what each line IS (furniture,
 * section header, question start, key territory, …) from content + repetition + position.
 * CODE never guesses meaning — it only validates arithmetic (every line labelled exactly
 * once, ranges inside the document) and then assembles mechanically from the labels.
 *
 * The model returns labels and section titles only — never rewritten text, never authored
 * questions (span-only discipline). Assembly below is pure line arithmetic: question-start
 * opens, following content attaches, printed numbers are read (numeral reading is arithmetic),
 * and the existing downstream machinery (assemble/gates/forms/images/points) consumes the
 * label-derived boundaries exactly as it consumed the old segmenter's.
 */
import type { SourceLine } from '../types';
import { parsePrintedNumberFromStem } from './quality';
import { findIntraLineMultiNumbers } from './segment';
import { CLASSIFY_SYSTEM, CLASSIFY_VERSION } from './prompts';

export const LINE_LABELS = [
  'furniture', 'section-header', 'instruction', 'question-start', 'continuation',
  'option', 'passage', 'answer-key', 'marks', 'blank',
] as const;
export type LineLabel = (typeof LINE_LABELS)[number];

const LABEL_SET = new Set<string>(LINE_LABELS);
const LABEL_SYNONYMS: Record<string, LineLabel> = {
  header: 'section-header', section: 'section-header', heading: 'section-header', title: 'section-header',
  question: 'question-start', start: 'question-start', q: 'question-start',
  cont: 'continuation', content: 'continuation', stem: 'continuation', text: 'continuation',
  choice: 'option', options: 'option',
  key: 'answer-key', answerkey: 'answer-key', answers: 'answer-key',
  mark: 'marks', points: 'marks', score: 'marks',
  junk: 'furniture', noise: 'furniture', pagenum: 'furniture', watermark: 'furniture',
  empty: 'blank', whitespace: 'blank',
  dialogue: 'passage', reading: 'passage',
};

export function normalizeLineLabel(raw: unknown): LineLabel | undefined {
  const word = String(raw ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (LABEL_SET.has(word)) return word as LineLabel;
  return LABEL_SYNONYMS[word.replace(/-/g, '')] || LABEL_SYNONYMS[word];
}

export interface ClassifyRange { start: number; end: number; label: LineLabel }
export interface Classification {
  labels: Map<number, LineLabel>;
  sectionTitles: Map<number, string>;
  ranges: ClassifyRange[];
}

export function lineNo(line: SourceLine): number {
  return Number(String(line.id).replace(/\D/g, ''));
}

// ---------------------------------------------------------------------------
// Wire parsing + validation (Part A3 output discipline; Part C's schema gate)
// ---------------------------------------------------------------------------

export interface ParsedClassificationWire {
  ranges: ClassifyRange[];
  sectionTitles: Map<number, string>;
  /** Wire-level problems (unknown label, inverted range, …) — non-fatal entries are dropped. */
  problems: string[];
}

/** Tolerant parse: strict JSON {r:[[s,e,label]…], s:{line:title}} first, then object rows, then salvage. */
export function parseClassification(rawText: string, json?: unknown): ParsedClassificationWire {
  const ranges: ClassifyRange[] = [];
  const sectionTitles = new Map<number, string>();
  const problems: string[] = [];
  const pushRange = (s: unknown, e: unknown, labelRaw: unknown) => {
    const start = Number(String(s ?? '').replace(/\D/g, ''));
    const end = e === undefined || e === null || e === '' ? start : Number(String(e).replace(/\D/g, ''));
    const label = normalizeLineLabel(labelRaw);
    if (!Number.isInteger(start) || start <= 0 || !Number.isInteger(end) || end < start) { problems.push(`bad range ${String(s)}-${String(e)}`); return; }
    if (!label) { problems.push(`unknown label ${String(labelRaw)}`); return; }
    if (end - start > 5000) { problems.push(`oversized range ${start}-${end}`); return; }
    ranges.push({ start, end, label });
  };
  const consume = (value: any): boolean => {
    if (!value || typeof value !== 'object') return false;
    const list = Array.isArray(value) ? value : Array.isArray(value.r) ? value.r : Array.isArray(value.ranges) ? value.ranges : Array.isArray(value.v) ? value.v : null;
    if (!list) return false;
    for (const item of list) {
      if (Array.isArray(item)) {
        // [start,end,label] | [line,label]
        if (typeof item[1] === 'string' && normalizeLineLabel(item[1])) pushRange(item[0], item[0], item[1]);
        else pushRange(item[0], item[1], item[2]);
      } else if (item && typeof item === 'object') {
        pushRange(item.start ?? item.s ?? item.line ?? item.l, item.end ?? item.e, item.label ?? item.t ?? item.kind);
      }
    }
    const titles = value.s || value.sections || value.titles;
    if (titles && typeof titles === 'object') {
      for (const [k, v] of Object.entries(titles)) {
        const n = Number(String(k).replace(/\D/g, ''));
        if (Number.isInteger(n) && n > 0 && typeof v === 'string' && v.trim()) sectionTitles.set(n, v.trim().slice(0, 120));
      }
    }
    return list.length > 0;
  };
  if (json && consume(json)) return { ranges, sectionTitles, problems };
  const text = String(rawText || '');
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try { if (consume(JSON.parse(candidate))) return { ranges, sectionTitles, problems }; } catch { /* salvage below */ }
    for (const m of candidate.matchAll(/\[\s*"?L?(\d{1,5})"?\s*,\s*"?L?(\d{1,5})"?\s*,\s*"?([a-z-]+)"?\s*\]/gi)) pushRange(m[1], m[2], m[3]);
    if (!ranges.length) for (const m of candidate.matchAll(/\[\s*"?L?(\d{1,5})"?\s*,\s*"?([a-z-]+)"?\s*\]/gi)) pushRange(m[1], m[1], m[2]);
  }
  // Last resort: "L0040-L0052: passage" text lines.
  if (!ranges.length) {
    for (const m of text.matchAll(/L?(\d{1,5})(?:\s*[-–]\s*L?(\d{1,5}))?\s*[:=]\s*([a-z-]+)/gi)) pushRange(m[1], m[2] ?? m[1], m[3]);
  }
  return { ranges, sectionTitles, problems };
}

export interface ClassificationValidation {
  ok: boolean;
  problems: string[];
  labels: Map<number, LineLabel>;
}

/**
 * Expand ranges over the owned line set and check arithmetic: every expected line labelled
 * exactly once, nothing outside the document, at least one question-start. This is the
 * "fails Part C validation" gate of Part B3 (twice → legacy fallback).
 */
export function validateClassification(
  wire: ParsedClassificationWire,
  expectedLineNos: number[],
): ClassificationValidation {
  const expected = new Set(expectedLineNos);
  const labels = new Map<number, LineLabel>();
  const problems: string[] = [...wire.problems];
  for (const range of wire.ranges) {
    for (let n = range.start; n <= range.end; n++) {
      if (!expected.has(n)) { problems.push(`line ${n} is not in the document`); continue; }
      if (labels.has(n) && labels.get(n) !== range.label) problems.push(`line ${n} labelled twice (${labels.get(n)} vs ${range.label})`);
      labels.set(n, range.label);
    }
  }
  const missing = expectedLineNos.filter(n => !labels.has(n));
  if (missing.length) problems.push(`${missing.length} line(s) unlabelled: ${missing.slice(0, 12).join(', ')}`);
  const starts = [...labels.values()].filter(l => l === 'question-start').length;
  if (!starts) problems.push('no question-start lines at all');
  const hardProblems = problems.filter(p => !p.startsWith('unknown label') && !p.startsWith('bad range') && !p.startsWith('oversized'));
  return { ok: hardProblems.length === 0 && missing.length === 0 && starts > 0, problems, labels };
}

export function serializeClassification(classification: Classification): string {
  const ranges: ClassifyRange[] = [];
  const sorted = [...classification.labels.entries()].sort((a, b) => a[0] - b[0]);
  for (const [n, label] of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.label === label && last.end === n - 1) last.end = n;
    else ranges.push({ start: n, end: n, label });
  }
  return JSON.stringify({ v: 1, version: CLASSIFY_VERSION, r: ranges.map(r => [r.start, r.end, r.label]), s: Object.fromEntries(classification.sectionTitles) });
}

export function deserializeClassification(serialized: string): Classification | undefined {
  try {
    const parsed = JSON.parse(serialized);
    const wire = parseClassification('', parsed);
    if (!wire.ranges.length) return undefined;
    const labels = new Map<number, LineLabel>();
    for (const r of wire.ranges) for (let n = r.start; n <= r.end; n++) labels.set(n, r.label);
    return { labels, sectionTitles: wire.sectionTitles, ranges: wire.ranges };
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Chunking: whole document in one call when it fits; page-boundary splits otherwise.
// ---------------------------------------------------------------------------

export interface ClassifyChunk {
  index: number;
  /** Lines this chunk OWNS (labels accepted only for these). */
  owned: SourceLine[];
  /** Read-only overlap from the previous chunk (context only, labels ignored). */
  context: SourceLine[];
}

export const CLASSIFY_OVERLAP_LINES = 10;
export const DEFAULT_CLASSIFY_MAX_LINES = 500;

export function buildClassifyChunks(lines: SourceLine[], maxLinesPerCall = DEFAULT_CLASSIFY_MAX_LINES, overlap = CLASSIFY_OVERLAP_LINES): ClassifyChunk[] {
  const sorted = [...lines].sort((a, b) => lineNo(a) - lineNo(b));
  if (sorted.length <= maxLinesPerCall) return [{ index: 0, owned: sorted, context: [] }];
  const byPage = new Map<number, SourceLine[]>();
  for (const line of sorted) byPage.set(line.page, [...(byPage.get(line.page) || []), line]);
  const chunks: ClassifyChunk[] = [];
  let current: SourceLine[] = [];
  const flush = () => {
    if (!current.length) return;
    const prev = chunks[chunks.length - 1];
    chunks.push({
      index: chunks.length,
      owned: current,
      context: prev ? prev.owned.slice(-overlap) : [],
    });
    current = [];
  };
  for (const pageLines of byPage.values()) {
    // Never split mid-page; an oversized single page still goes whole (page boundary rule).
    if (current.length && current.length + pageLines.length > maxLinesPerCall) flush();
    current.push(...pageLines);
  }
  flush();
  return chunks;
}

export function renderClassifyChunk(chunk: ClassifyChunk, localTags?: Map<number, string>): string {
  const row = (line: SourceLine, ctx: boolean) => {
    const n = lineNo(line);
    const y = line.y !== undefined ? Math.round(line.y) : 0;
    const tag = localTags?.get(n);
    return `[${line.id} p${line.page} y${y}${tag ? ` ${tag.toUpperCase()}` : ''}]${ctx ? ' ctx' : ''} ${line.text}`;
  };
  const first = chunk.owned[0]?.id || '-';
  const last = chunk.owned[chunk.owned.length - 1]?.id || '-';
  return `LABEL lines ${first}..${last} (${chunk.owned.length} lines). Lines marked ctx are read-only context from the previous part — do not label them.\n${[
    ...chunk.context.map(line => row(line, true)),
    ...chunk.owned.map(line => row(line, false)),
  ].join('\n')}`;
}

// ---------------------------------------------------------------------------
// The classify stage (calls the model; cache + journal via callbacks)
// ---------------------------------------------------------------------------

export interface ClassifyCaller {
  (req: { system: string; text: string; maxOutputTokens?: number; label: string }): Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }>;
}

export interface SpineBudget {
  calls: number;
  units: number;
  maxCalls: number;
  maxUnits: number;
}

export interface ClassifyStageResult {
  status: 'completed' | 'cached' | 'unavailable' | 'invalid' | 'failed';
  classification?: Classification;
  /** Raw serialized classification (journaled + cached verbatim). */
  serialized?: string;
  calls: number;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
  problems: string[];
  reason?: string;
}

export async function runClassifyStage(params: {
  lines: SourceLine[];
  caller?: ClassifyCaller;
  /** Serialized classification (or {invalid:true}) served from the caller's stage cache. */
  cached?: string | { invalid: true; problems?: string[] };
  /** Optional simple map cache (tests / embedding): key = content hash computed by caller. */
  cache?: Map<string, string>;
  cacheKey?: string;
  maxLinesPerCall?: number;
  localTags?: Map<number, string>;
  budget?: SpineBudget;
  /** Raw response journaling (resumable stream journal): one entry per model call. */
  onJournal?: (entry: { label: string; rawText: string }) => void | Promise<void>;
  onProgress?: (message: string) => void;
}): Promise<ClassifyStageResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const lineNos = params.lines.map(lineNo).sort((a, b) => a - b);

  if (params.cached && typeof params.cached === 'object' && params.cached.invalid) {
    return { status: 'invalid', calls: 0, attempts: 0, usage, problems: params.cached.problems || ['classification previously failed validation for this exact content'], reason: 'cached invalid classification' };
  }
  const fromCache = (serialized: string | undefined): Classification | undefined => {
    if (!serialized) return undefined;
    const classification = deserializeClassification(serialized);
    if (!classification) return undefined;
    const validation = validateClassification({ ranges: classification.ranges, sectionTitles: classification.sectionTitles, problems: [] }, lineNos);
    return validation.ok ? classification : undefined;
  };
  if (typeof params.cached === 'string') {
    const hit = fromCache(params.cached);
    if (hit) return { status: 'cached', classification: hit, serialized: params.cached, calls: 0, attempts: 0, usage, problems: [] };
  }
  if (params.cache && params.cacheKey) {
    const hit = fromCache(params.cache.get(params.cacheKey));
    if (hit) return { status: 'cached', classification: hit, serialized: params.cache.get(params.cacheKey), calls: 0, attempts: 0, usage, problems: [] };
  }
  if (!params.caller) return { status: 'unavailable', calls: 0, attempts: 0, usage, problems: [], reason: 'no classify provider configured' };

  const chunks = buildClassifyChunks(params.lines, params.maxLinesPerCall);
  let calls = 0;
  let lastProblems: string[] = [];
  // Two validation attempts total (Part B3: output failing validation twice → fallback).
  for (let attempt = 1; attempt <= 2; attempt++) {
    const merged = new Map<number, LineLabel>();
    const titles = new Map<number, string>();
    const wires: ParsedClassificationWire[] = [];
    let callFailed: string | undefined;
    for (const chunk of chunks) {
      if (params.budget && params.budget.calls >= params.budget.maxCalls) { callFailed = 'model-call budget exhausted'; break; }
      const label = chunks.length > 1 ? `Classify lines (${chunk.index + 1}/${chunks.length})` : 'Classify lines';
      params.onProgress?.(`${label}: ${chunk.owned.length} lines${attempt > 1 ? ' (retry)' : ''}…`);
      try {
        const response = await params.caller({
          system: CLASSIFY_SYSTEM,
          text: renderClassifyChunk(chunk, params.localTags),
          maxOutputTokens: Math.min(32000, Math.max(4096, chunk.owned.length * 24)),
          label,
        });
        calls++;
        if (params.budget) params.budget.calls++;
        if (response.usage) { usage.inputTokens += response.usage.inputTokens || 0; usage.outputTokens += response.usage.outputTokens || 0; }
        await params.onJournal?.({ label, rawText: response.rawText.slice(0, 200000) });
        wires.push(parseClassification(response.rawText, response.json));
      } catch (err: any) {
        callFailed = err?.message || String(err);
        break;
      }
    }
    if (callFailed) return { status: 'failed', calls, attempts: attempt, usage, problems: [callFailed], reason: callFailed };
    // Merge: labels accepted only for each chunk's OWNED lines (overlap is read-only).
    let chunkIdx = 0;
    for (const wire of wires) {
      const ownedSet = new Set(chunks[chunkIdx].owned.map(lineNo));
      for (const range of wire.ranges) for (let n = range.start; n <= range.end; n++) if (ownedSet.has(n)) merged.set(n, range.label);
      for (const [n, title] of wire.sectionTitles) if (ownedSet.has(n)) titles.set(n, title);
      chunkIdx++;
    }
    const validation = validateClassification(
      { ranges: [...merged.entries()].map(([start, label]) => ({ start, end: start, label })), sectionTitles: titles, problems: wires.flatMap(w => w.problems) },
      lineNos,
    );
    if (validation.ok) {
      const classification: Classification = { labels: validation.labels, sectionTitles: titles, ranges: [] };
      classification.ranges = JSON.parse(serializeClassification(classification)).r.map((r: any) => ({ start: r[0], end: r[1], label: r[2] }));
      const serialized = serializeClassification(classification);
      if (params.cache && params.cacheKey) params.cache.set(params.cacheKey, serialized);
      return { status: 'completed', classification, serialized, calls, attempts: attempt, usage, problems: validation.problems };
    }
    lastProblems = validation.problems;
  }
  return { status: 'invalid', calls, attempts: 2, usage, problems: lastProblems, reason: `classification failed validation twice: ${lastProblems.slice(0, 3).join('; ')}` };
}

// ---------------------------------------------------------------------------
// Marks evidence (printed numbers only — shared with the repair loop's setPointsFrom)
// ---------------------------------------------------------------------------

function normalizeDigits(text: string): string {
  return text
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

const MARKS_PATTERNS: RegExp[] = [
  /[(\[]\s*(\d{1,3}(?:[./]\d{1,2})?)\s*(?:marks?|points?|pts?|نمره)?\s*[)\]]/i,
  /(\d{1,3}(?:[./]\d{1,2})?)\s*(?:marks?|points?|pts?|نمره)\b/i,
  /(?:marks?|points?|pts?|نمره)\s*[:=]\s*(\d{1,3}(?:[./]\d{1,2})?)/i,
];

/** First explicit printed marks value on these lines (never a guess from question numbers). */
export function readMarksEvidence(texts: string[]): number | undefined {
  for (const raw of texts) {
    const text = normalizeDigits(String(raw || ''));
    for (const pattern of MARKS_PATTERNS) {
      const m = text.match(pattern);
      if (m) {
        const value = Number(m[1].replace('/', '.'));
        if (Number.isFinite(value) && value > 0 && value <= 100) return Number(value.toFixed(2));
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Part B — mechanical assembly from labels
// ---------------------------------------------------------------------------

export interface LabelAssembly {
  rawQuestions: any[];
  sections: Array<{ id: string; title: string; spans: Array<[number, number]>; headerLine?: number }>;
  /** Segmenter-shaped receipts so vision hints + the assembler consume them unchanged. */
  segments: any[];
  /** Answer-key territory ∪ standalone marks lines (feeds key-table / points machinery). */
  keyLineNos: number[];
  furnitureLineNos: number[];
  /** Section-owned prelude lines (passage/instruction before any question) per section id. */
  sectionPreludes: Record<string, number[]>;
}

function compressSpans(sortedNos: number[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const n of sortedNos) {
    const last = spans[spans.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else spans.push([n, n]);
  }
  return spans;
}

/** Printed numbers enumerated on one line: "(15) (16) (17) (18)" or intra-line "63. a) … 64. b) …". Numeral reading = arithmetic. */
export function enumeratedNumbersOnLine(text: string): number[] {
  const intra = findIntraLineMultiNumbers(text);
  if (intra.length >= 2) return intra.map(item => item.no);
  const normalized = normalizeDigits(text);
  const paren = [...normalized.matchAll(/\((\d{1,3})\)/g)].map(m => Number(m[1]));
  const ascending = paren.filter((v, i) => i === 0 || v > paren[i - 1]);
  if (ascending.length >= 2 && ascending.length === paren.length) return ascending;
  return [];
}

const OPTION_MARKER_RE = /(?:^|[\s(])([a-j])[).:]/gi;

export function assembleFromLabels(params: {
  lines: SourceLine[];
  classification: Classification;
}): LabelAssembly {
  const sorted = [...params.lines].sort((a, b) => lineNo(a) - lineNo(b));
  const byNo = new Map(sorted.map(line => [lineNo(line), line]));
  const labelOf = (n: number): LineLabel => params.classification.labels.get(n) || 'continuation';

  const keyLineNos: number[] = [];
  const furnitureLineNos: number[] = [];
  const sections: LabelAssembly['sections'] = [];
  const sectionPreludes: Record<string, number[]> = {};
  const rawQuestions: any[] = [];
  const segments: any[] = [];
  let segmentSeq = 0;
  const nextSegId = () => `S${++segmentSeq}`;

  interface OpenQuestion {
    startLine: number;
    lineNos: number[];
    marksLineNos: number[];
    sectionId: string;
    sectionTitle: string;
    prelude: number[];
  }
  let currentSection: { id: string; title: string; headerLine?: number; firstLine: number; lastLine: number } | undefined;
  const ensureSection = (atLine: number) => {
    if (!currentSection) {
      currentSection = { id: `section_${sections.length + 1}`, title: '', firstLine: atLine, lastLine: atLine };
    }
    return currentSection;
  };
  let open: OpenQuestion | undefined;
  let preludeLines: number[] = [];

  const closeQuestion = () => {
    if (!open) return;
    const q = open;
    open = undefined;
    const lineNosSorted = [...q.lineNos].sort((a, b) => a - b);
    const spans = compressSpans(lineNosSorted);
    const startText = byNo.get(q.startLine)?.text || '';
    const enumerated = enumeratedNumbersOnLine(startText);
    const printedNo = parsePrintedNumberFromStem(startText) ?? enumerated[0];
    const id = `qc_${q.startLine}`;
    // Option placeholders: distinct printed option letters across the question's lines (the
    // assembler carves the real option spans; ≥2 markers means a choice question).
    const letters: string[] = [];
    for (const n of lineNosSorted) {
      const text = byNo.get(n)?.text || '';
      for (const m of text.matchAll(OPTION_MARKER_RE)) {
        const key = m[1].toLowerCase();
        if (!letters.includes(key)) letters.push(key);
      }
    }
    const options = letters.length >= 2 ? letters.slice(0, 10).map(key => ({ key, spans: [spans[0]] })) : undefined;
    const points = readMarksEvidence(q.marksLineNos.map(n => byNo.get(n)?.text || ''));
    const isGroup = enumerated.length >= 2 && (printedNo === undefined || enumerated.includes(printedNo));
    const parentNo = isGroup ? enumerated[0] : printedNo;
    rawQuestions.push({
      id,
      no: parentNo,
      label: parentNo !== undefined ? String(parentNo) : undefined,
      sectionId: q.sectionId,
      spans,
      ...(options && !isGroup ? { options } : {}),
      ...(points !== undefined ? { points } : {}),
      answer: [],
    });
    const parentSegId = nextSegId();
    segments.push({
      id: parentSegId,
      kind: isGroup ? 'group-parent' : 'question',
      startLine: lineNosSorted[0],
      endLine: lineNosSorted[lineNosSorted.length - 1],
      ...(parentNo !== undefined ? { printedNo: parentNo } : {}),
      ...(isGroup ? { childNos: enumerated.slice(1), groupForm: 'enumeration' as const } : {}),
      ...(isGroup && q.prelude.length ? { parentStemLines: q.prelude } : {}),
      sectionHint: q.sectionTitle,
      sectionId: q.sectionId,
      lines: lineNosSorted,
      ruleChain: ['classify-labels'],
    });
    if (isGroup) {
      for (const childNo of enumerated.slice(1)) {
        const childId = `qc_${q.startLine}_${childNo}`;
        rawQuestions.push({
          id: childId,
          no: childNo,
          label: String(childNo),
          sectionId: q.sectionId,
          parentId: id,
          spans,
          answer: [],
        });
        segments.push({
          id: nextSegId(),
          kind: 'question',
          startLine: lineNosSorted[0],
          endLine: lineNosSorted[lineNosSorted.length - 1],
          printedNo: childNo,
          parentSegmentId: parentSegId,
          sectionHint: q.sectionTitle,
          sectionId: q.sectionId,
          lines: lineNosSorted,
          ruleChain: ['classify-labels', 'group-child'],
        });
      }
    }
    if (currentSection) currentSection.lastLine = Math.max(currentSection.lastLine, lineNosSorted[lineNosSorted.length - 1]);
  };

  const closeSection = () => {
    closeQuestion();
    if (currentSection) {
      sections.push({
        id: currentSection.id,
        title: currentSection.title,
        spans: [[currentSection.firstLine, Math.max(currentSection.firstLine, currentSection.lastLine)]],
        ...(currentSection.headerLine !== undefined ? { headerLine: currentSection.headerLine } : {}),
      });
      currentSection = undefined;
    }
    preludeLines = [];
  };

  for (const line of sorted) {
    const n = lineNo(line);
    const label = labelOf(n);
    switch (label) {
      case 'furniture':
        furnitureLineNos.push(n);
        break;
      case 'blank':
        break;
      case 'section-header': {
        closeSection();
        const title = params.classification.sectionTitles.get(n) || line.text.trim();
        currentSection = { id: `section_${sections.length + 1}`, title, headerLine: n, firstLine: n, lastLine: n };
        segments.push({ id: nextSegId(), kind: 'header', startLine: n, endLine: n, sectionHint: title, sectionId: currentSection.id, lines: [n], ruleChain: ['classify-labels'] });
        break;
      }
      case 'answer-key': {
        closeQuestion();
        keyLineNos.push(n);
        break;
      }
      case 'marks': {
        if (open) open.marksLineNos.push(n);
        else keyLineNos.push(n); // standalone marks territory (totals / mark scheme)
        break;
      }
      case 'question-start': {
        closeQuestion();
        const section = ensureSection(n);
        open = { startLine: n, lineNos: [n], marksLineNos: [], sectionId: section.id, sectionTitle: section.title, prelude: preludeLines };
        preludeLines = [];
        break;
      }
      case 'instruction':
      case 'passage': {
        // Instructions and passages INTRODUCE what follows (the canonical reading layout):
        // they close the open question and become section-owned prelude — for a following
        // group they are its governing stem lines (parentStemLines). Continuation/option
        // lines, by contrast, belong to the open question.
        closeQuestion();
        const section = ensureSection(n);
        section.lastLine = Math.max(section.lastLine, n);
        (sectionPreludes[section.id] ||= []).push(n);
        preludeLines.push(n);
        segments.push({ id: nextSegId(), kind: label === 'passage' ? 'passage' : 'instruction', startLine: n, endLine: n, sectionHint: section.title, sectionId: section.id, lines: [n], ruleChain: ['classify-labels'] });
        break;
      }
      case 'continuation':
      case 'option': {
        if (open) {
          open.lineNos.push(n);
        } else {
          // Section-owned territory (passage/instruction before the next question).
          const section = ensureSection(n);
          section.lastLine = Math.max(section.lastLine, n);
          (sectionPreludes[section.id] ||= []).push(n);
          preludeLines.push(n);
          segments.push({ id: nextSegId(), kind: 'unknown', startLine: n, endLine: n, sectionHint: section.title, sectionId: section.id, lines: [n], ruleChain: ['classify-labels'] });
        }
        break;
      }
    }
  }
  closeSection();
  if (!sections.length && rawQuestions.length) {
    const allNos = rawQuestions.flatMap(q => (q.spans as Array<[number, number]>).flatMap(([s, e]) => [s, e]));
    sections.push({ id: 'section_1', title: '', spans: [[Math.min(...allNos), Math.max(...allNos)]] });
    for (const q of rawQuestions) q.sectionId = 'section_1';
  }
  return {
    rawQuestions,
    sections,
    segments,
    keyLineNos: [...new Set(keyLineNos)].sort((a, b) => a - b),
    furnitureLineNos: [...new Set(furnitureLineNos)].sort((a, b) => a - b),
    sectionPreludes,
  };
}

// ---------------------------------------------------------------------------
// Label-quality metric (Part E3): labels implied by an assembly vs truth-implied labels.
// ---------------------------------------------------------------------------

/** Coarse implied labels from an assembled document (used for the report-only agreement metric). */
export function impliedLabelsFromAssembly(params: {
  questions: Array<{ id?: string; parentId?: string; spans?: any[]; stemSpans?: any[] }>;
  sections: Array<{ spans?: any[]; headerLine?: number }>;
  keyLineNos: number[];
  lines: SourceLine[];
}): Map<number, LineLabel> {
  const labels = new Map<number, LineLabel>();
  const key = new Set(params.keyLineNos);
  const covered = new Set<number>();
  const spanNos = (spans: any[]): number[] => {
    const out: number[] = [];
    for (const span of spans || []) {
      if (Array.isArray(span)) { for (let n = Number(span[0]); n <= Number(span[1]); n++) out.push(n); }
      else if (span && typeof span === 'object' && Number.isInteger(span.line)) out.push(span.line);
    }
    return out;
  };
  for (const q of params.questions) {
    const nos = spanNos(q.spans || q.stemSpans || []);
    nos.forEach((n, i) => {
      covered.add(n);
      if (!q.parentId && i === 0) labels.set(n, 'question-start');
      else if (!labels.has(n)) labels.set(n, 'continuation');
    });
  }
  for (const s of params.sections) if (s.headerLine !== undefined) labels.set(s.headerLine, 'section-header');
  for (const line of params.lines) {
    const n = lineNo(line);
    if (key.has(n)) labels.set(n, 'answer-key');
    else if (!labels.has(n)) {
      if (!line.text.trim()) labels.set(n, 'blank');
      else if ((line as any).furniture || !covered.has(n)) labels.set(n, covered.has(n) ? 'continuation' : 'furniture');
    }
  }
  return labels;
}

const DECIDABLE: ReadonlySet<LineLabel> = new Set(['question-start', 'section-header', 'answer-key', 'furniture', 'blank']);

/** Agreement over the lines whose label the truth side can decide (starts, headers, key, furniture, blank). */
export function classificationAgreement(candidate: Map<number, LineLabel>, truthImplied: Map<number, LineLabel>): { matched: number; total: number; pct: number } {
  let matched = 0;
  let total = 0;
  for (const [n, expected] of truthImplied) {
    if (!DECIDABLE.has(expected)) continue;
    total++;
    const got = candidate.get(n);
    if (got === expected) matched++;
    // A continuation/option/passage line where truth expects content-adjacent furniture still
    // counts as a miss — furniture must stay furniture (the field failure mode).
  }
  return { matched, total, pct: total ? Number(((matched / total) * 100).toFixed(1)) : 100 };
}
