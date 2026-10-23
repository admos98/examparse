/**
 * Deterministic, local-only assembly and integrity checks.
 * Models provide spans; this module is the single pure assembly funnel used by
 * fresh, cached, resumed, chunked, patched, and imported documents.
 */
import { z } from 'zod';
import { ExamDoc, ExamSection, Flag, ImageAsset, LineSpan, Question, SourceLine } from '../types';
import { normalizeForMatching, matchingView, parsePrintedNumberFromStem, enumerateExpectedQuestionNos, detectSectionHeaders, exciseWatermarksWithLearned, computeLearnedWatermarks, exciseWatermarks, extractDocumentTotals } from './quality';
import { buildQuestionTree } from '../utils/questionTree';
import { validateSemantic, semanticConfidenceDeduction, semanticIssuesFor } from './semanticValidators';
import { completeGapsRaw } from './ownership';
import { isContentJunk, isFenceProtected } from './cleanup';
import { findIntraLineMultiNumbers } from './segment';

export const SpanReferenceSchema = z.tuple([z.number().int().positive(), z.number().int().positive()]);
export const RawQuestionSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  no: z.number().int().positive(),
  parentId: z.string().optional(),
  sectionId: z.string().optional(),
  spans: z.array(SpanReferenceSchema),
  charStart: z.number().int().min(0).optional(),
  charEnd: z.number().int().min(0).optional(),
  points: z.number().optional(),
  type: z.enum(['mcq', 'truefalse', 'short', 'long', 'fillblank', 'matching', 'multi', 'numeric', 'diagram', 'essay', 'unknown']).optional(),
  options: z.array(z.object({ key: z.string().optional(), spans: z.array(SpanReferenceSchema) })).optional(),
  answer: z.object({ spans: z.array(SpanReferenceSchema).optional() }).optional(),
  tables: z.array(z.object({ spans: z.array(SpanReferenceSchema) })).optional(),
  rewrites: z.array(z.object({ line: z.number().int().positive(), text: z.string() })).optional(),
  images: z.array(z.object({ imageId: z.string(), role: z.enum(['stem', 'option', 'table', 'decoration']).optional(), anchorLine: z.number().optional() })).optional(),
  confidence: z.number().min(0).max(1).optional(),
  receipt: z.object({ lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), ruleChain: z.array(z.string()), ruleConfidence: z.number().min(0).max(100) }).optional(),
  flags: z.array(z.string()).optional(),
  stemText: z.never().optional(),
  fullStem: z.never().optional(),
});

const lineNoCache = new Map<string, number>();
export function lineNoFromId(id: string): number {
  const cached = lineNoCache.get(id);
  if (cached !== undefined) return cached;
  const n = Number(id.replace(/\D/g, ''));
  const value = Number.isFinite(n) ? n : 0;
  if (lineNoCache.size < 100_000) lineNoCache.set(id, value);
  return value;
}
/**
 * Per-assembly line index. Scoped to one assembleAndValidateQuestions call (set/cleared there),
 * so in-place tag edits between calls can never serve stale text; outside a call the helpers
 * fall back to building the map per invocation.
 */
let activeLineIndex: { lines: SourceLine[]; byNo: Map<number, SourceLine>; text: Map<number, string> } | null = null;
function lineIndexFor(sourceLines: SourceLine[]): { byNo: Map<number, SourceLine>; text: Map<number, string> } {
  if (activeLineIndex && activeLineIndex.lines === sourceLines) return activeLineIndex;
  const byNo = new Map(sourceLines.map(line => [lineNoFromId(line.id), line]));
  const text = new Map(sourceLines.map(line => [lineNoFromId(line.id), line.furniture || isContentJunk(line) ? '' : line.text]));
  return { byNo, text };
}

export function normalizedSpans(spans: unknown): LineSpan[] {
  if (!Array.isArray(spans)) return [];
  const out: LineSpan[] = [];
  let lineBudget = 5_000;
  for (const span of spans) {
    let a: number; let b: number;
    if (Array.isArray(span) && span.length >= 2) { a = Number(span[0]); b = Number(span[1]); }
    else if (typeof span === 'number') { a = span; b = span; }
    else continue;
    const width = b - a + 1;
    if (Number.isInteger(a) && Number.isInteger(b) && a > 0 && b >= a && width <= 5_000 && width <= lineBudget) {
      out.push([a, b]);
      lineBudget -= width;
    }
  }
  return out;
}

export function spanLineNumbers(spans: LineSpan[]): number[] {
  const set = new Set<number>();
  for (const [start, end] of spans) for (let n = start; n <= end; n++) set.add(n);
  return [...set].sort((a, b) => a - b);
}

export function sliceSourceSpans(
  spans: LineSpan[],
  sourceLines: SourceLine[],
  rewrites?: { line: number; text: string }[]
): string {
  if (!spans || spans.length === 0) return '';
  const lineMap = lineIndexFor(sourceLines).byNo;
  const rewriteMap = new Map<number, string>((rewrites || []).map(rewrite => [rewrite.line, rewrite.text]));
  const output: string[] = [];
  for (const lineNo of spanLineNumbers(spans)) {
    const line = lineMap.get(lineNo);
    if (rewriteMap.has(lineNo)) output.push(rewriteMap.get(lineNo)!);
    else if (line && !line.furniture && !isContentJunk(line)) output.push(line.text);
  }
  return output.join('\n');
}

function sliceOptionUnion(options: any[], sourceLines: SourceLine[]): string {
  const allSpans = options.flatMap(option => normalizedSpans(option?.spans));
  return sliceSourceSpans(allSpans, sourceLines);
}

type Marker = { start: number; end: number; key: string; display?: string };
const LATIN = 'a-j';
const PERSIAN_MARKERS = 'الف|ب|پ|ت|ث|ج|چ|د|ه|و';
const PERSIAN_SERIES: readonly (readonly string[])[] = [
  ['الف', 'ب', 'ج', 'د', 'ه', 'و'],
  ['الف', 'ب', 'پ', 'ت', 'ث', 'ج', 'چ'],
];
const OPTION_MARKER = new RegExp(`(?:\\(([${LATIN}])\\)|([${LATIN}])[).:–—-]|\\((${PERSIAN_MARKERS})\\)|(${PERSIAN_MARKERS})[).:–—-])(?=\\s|$)`, 'gim');
const LEADING_OPTION_MARKER_RE = new RegExp(`^\\s*(?:\\(([${LATIN}])\\)|([${LATIN}])[).:–—-]|\\((${PERSIAN_MARKERS})\\)|(${PERSIAN_MARKERS})[).:–—-])(?:\\s+|$)`, 'i');

export function normalizeOptionText(text: string): string {
  return text.replace(/`/g, "'").trim();
}

/**
 * Trim trailing duplicated fragment of parent instruction / points note from an option string
 * (e.g. `"giraffe 1/5 (یک کلمه اضافه است)"` against parent instruction `"… 1/5 (یک کلمه اضافه است)"`).
 */
export function trimOptionInstructionResidue(
  optionText: string,
  referenceInstruction: string,
): { text: string; trimmed: boolean } {
  const cleaned = normalizeOptionText(optionText);
  if (!cleaned || !referenceInstruction) return { text: cleaned, trimmed: false };
  const normRef = normalizeForMatching(referenceInstruction);
  if (!normRef) return { text: cleaned, trimmed: false };

  const view = matchingView(cleaned);
  const v = view.text;
  const candidateStarts: number[] = [];
  for (let i = 1; i < v.length; i++) {
    if ((/\s/.test(v[i - 1]) && !/\s/.test(v[i])) || v[i] === '(') {
      candidateStarts.push(i);
    }
  }

  for (const startIdx of candidateStarts) {
    const rawHead = cleaned.slice(0, view.originalOffset(startIdx)).trim();
    const rawTail = cleaned.slice(view.originalOffset(startIdx)).trim();
    if (!rawHead || !rawTail) continue;
    const normTail = normalizeForMatching(rawTail);
    if (normTail.length < 4) continue;
    const isInstructionShaped =
      /[()（）]/.test(rawTail) ||
      /(?:^|\s)\d+\s*[/٫.]\s*\d+(?:\s|$)/.test(normTail) ||
      /اضافه|بارم|نمره|\bextra\b|\bpoint/i.test(normTail) ||
      normTail.split(/\s+/).length >= 5;
    if (!isInstructionShaped) continue;

    // Direct normalized substring match OR bidi-reordered score + parenthetical match
    let matchesRef = normRef.includes(normTail);
    if (!matchesRef) {
      const scoreStripped = normTail
        .replace(/^\d+\s*[/٫.]\s*\d+\s*/, '')
        .replace(/\s*\d+\s*[/٫.]\s*\d+$/, '')
        .trim();
      const scoreMatch = normTail.match(/\d+\s*[/٫.]\s*\d+/);
      if (scoreStripped.length >= 4 && normRef.includes(scoreStripped) && (!scoreMatch || normRef.includes(scoreMatch[0]))) {
        matchesRef = true;
      }
    }
    if (matchesRef) {
      return { text: normalizeOptionText(rawHead), trimmed: true };
    }
  }
  return { text: cleaned, trimmed: false };
}

export function stripLeadingOptionMarker(text: string): string {
  if (!text) return '';
  if (!/^\s*[(（]?[a-jA-JＡ-Ｊالفبپتثجچدهو][).:）：]?/.test(text)) return normalizeOptionText(text);
  const view = matchingView(text);
  const m = LEADING_OPTION_MARKER_RE.exec(view.text);
  if (!m) return normalizeOptionText(text);
  return normalizeOptionText(text.slice(view.originalOffset(m[0].length)));
}

function selectOrderedMarkers(candidates: Marker[]): Marker[] {
  if (candidates.length < 2) return [];
  const longestContiguous = (series: readonly string[]): Marker[] => {
    let best: Marker[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].key !== series[0]) continue;
      const run: Marker[] = [candidates[i]];
      for (let j = i + 1; j < candidates.length; j++) {
        const expected = series[run.length];
        if (expected && candidates[j].key === expected) { run.push(candidates[j]); continue; }
        // A skipped/reordered marker is an incomplete option sequence, not permission to fabricate.
        if (series.includes(candidates[j].key)) run.length = 0;
        break;
      }
      if (run.length > best.length) best = run;
    }
    return best.length >= 2 ? best : [];
  };
  const latin = longestContiguous(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  if (latin.length) return latin;
  for (const series of PERSIAN_SERIES) {
    const fa = longestContiguous(series);
    if (fa.length) return fa;
  }
  return [];
}

function findOptionMarkers(text: string): Marker[] {
  if (!text || findIntraLineMultiNumbers(text).length >= 2) return [];
  const rawFound: Marker[] = [];
  const view = matchingView(text);
  OPTION_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPTION_MARKER.exec(view.text))) {
    const markerStart = match.index;
    const originalStart = view.originalOffset(markerStart);
    const originalEnd = view.originalOffset(OPTION_MARKER.lastIndex);
    const markerText = text.slice(originalStart, originalEnd);
    // Prevent a terminal word like “Sara.” from being parsed as a glued `a.` option.
    if (/\.$/.test(markerText) && originalStart > 0 && /[A-Za-z\u0600-\u06FF]/.test(text[originalStart - 1])) continue;
    const key = (match[1] || match[2] || match[3] || match[4] || '').toLowerCase();
    rawFound.push({ start: originalStart, end: originalEnd, key });
  }
  const ordered = selectOrderedMarkers(rawFound);
  if (ordered.length >= 2) return ordered;
  if (rawFound.length === 0) {
    const pairs = [...view.text.matchAll(/(?:^|[\s/])(true|false|درست|نادرست)(?=\s|$|[).:/])/g)];
    const keys = pairs.map(m => m[1]);
    if ((keys.includes('true') && keys.includes('false')) || (keys.includes('درست') && keys.includes('نادرست'))) {
      return pairs.map(m => {
        const start = m.index! + m[0].length - m[1].length;
        return { start: view.originalOffset(start), end: view.originalOffset(start + m[1].length), key: m[1], display: text.slice(view.originalOffset(start), view.originalOffset(start + m[1].length)) };
      });
    }
  }
  return [];
}

function findLineStartOptionMarker(line: string): Marker | undefined {
  if (!line || findIntraLineMultiNumbers(line).length >= 2) return undefined;
  // Speaker labels such as “B: The windows …” are prose, not a single option marker.
  if (/^\s*[A-Z]:\s+[A-Za-z]/.test(line)) return undefined;
  const view = matchingView(line);
  const m = LEADING_OPTION_MARKER_RE.exec(view.text);
  if (!m) return undefined;
  const key = (m[1] || m[2] || m[3] || m[4] || '').toLowerCase();
  const leadingWs = (line.match(/^\s*/)?.[0] || '').length;
  return { start: leadingWs, end: view.originalOffset(m[0].length), key };
}

/** Deterministic inline option splitter: returns ≥2 non-empty ordered parts with markers stripped, else []. */
export function splitInlineOptions(text: string): Array<{ key: string; text: string }> {
  if (!text) return [];
  const markers = findOptionMarkers(text);
  if (markers.length < 2) return [];
  const parts = markers.map((marker, index) => {
    const next = markers[index + 1];
    const rawBody = text.slice(marker.end, next ? next.start : text.length);
    const body = stripLeadingOptionMarker(rawBody);
    const value = marker.display && (!body || normalizeForMatching(body) === '/')
      ? normalizeOptionText(marker.display)
      : body;
    return { key: String.fromCharCode(97 + index), text: value };
  });
  return parts.length >= 2 && parts.every(p => p.text.length > 0) ? parts : [];
}

/** Remove only text following explicit option markers; never delete ordinary stem words that match an option. */
export function decontaminateOptionMarkup(text: string): string {
  return text.split(/\r?\n/).flatMap(line => {
    if (findIntraLineMultiNumbers(line).length >= 2) return [line];
    // Explicit letter markers only: a stem such as "True or false: …" must not be cut at the word "True".
    const first = findOptionMarkers(line).filter(marker => !marker.display)[0] ?? findLineStartOptionMarker(line);
    if (!first) return [line];
    const stemPrefix = line.slice(0, first.start).trimEnd();
    return stemPrefix ? [stemPrefix] : [];
  }).join('\n').trim();
}

function splitOptionTexts(options: Question['options'], sourceLines: SourceLine[], learnedWatermarks: string[] = []): { options?: Question['options']; failed: boolean; excisedCount: number; inlineSplit: boolean } {
  if (!options || options.length === 0) return { options, failed: false, excisedCount: 0, inlineSplit: false };
  // Excision is deliberately performed on the sliced union before marker detection.
  // SourceLine.text is never modified: all offsets and receipts still refer to the original extraction.
  const union = sliceOptionUnion(options, sourceLines);
  const excisedUnion = exciseWatermarksWithLearned(union, learnedWatermarks);
  const text = excisedUnion.text;
  const inlineParts = splitInlineOptions(text);
  if (inlineParts.length >= 2) {
    const ordered = [...options].sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
    const pooledSpans = normalizedSpans(ordered.flatMap(o => o.spans));
    return {
      options: inlineParts.map((part, index) => ({
        key: ordered[index]?.key && inlineParts.length === ordered.length ? ordered[index].key : part.key,
        spans: ordered[index]?.spans && inlineParts.length === ordered.length ? ordered[index].spans : pooledSpans,
        text: part.text,
      })),
      failed: false,
      excisedCount: excisedUnion.count,
      inlineSplit: true,
    };
  }
  // No inline sequence found: strip leading markers (e.g. "a. item") on distinct per-option spans;
  // NEVER fall back to duplicating a single unsplit blob across keys.
  const cleaned = options.map(opt => {
    const excised = exciseWatermarksWithLearned(opt.text || '', learnedWatermarks);
    return { ...opt, text: stripLeadingOptionMarker(excised.text) };
  });
  const distinctNonEmpty = new Set(cleaned.map(o => normalizeForMatching(o.text || '').trim()).filter(Boolean));
  if (cleaned.length >= 2 && distinctNonEmpty.size >= 2) {
    return { options: cleaned, failed: false, excisedCount: excisedUnion.count, inlineSplit: false };
  }
  return { options: [], failed: true, excisedCount: excisedUnion.count, inlineSplit: false };
}

function collapseAdjacentOptionDuplicates(options: NonNullable<Question['options']>): { options: NonNullable<Question['options']>; nonAdjacentDuplicates: string[] } {
  const kept: NonNullable<Question['options']> = [];
  const nonAdjacentDuplicates: string[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const key = normalizeOptionText(option.text || '');
    if (!key) { kept.push(option); continue; }
    if (kept.length && normalizeOptionText(kept[kept.length - 1].text || '') === key) continue;
    if (seen.has(key)) nonAdjacentDuplicates.push(key);
    seen.add(key);
    kept.push(option);
  }
  return { options: kept.map((option, index) => ({ ...option, key: String.fromCharCode(97 + index) })), nonAdjacentDuplicates };
}

function lineTextMap(sourceLines: SourceLine[]): Map<number, string> {
  return new Map(lineIndexFor(sourceLines).text);
}

export function decontaminateStem(
  stemSpans: LineSpan[],
  optionSpans: LineSpan[],
  sourceLines: SourceLine[],
  printedNo: number,
  rewrites?: { line: number; text: string }[]
): string {
  const consumed = new Set(spanLineNumbers(optionSpans));
  const textMap = lineTextMap(sourceLines);
  for (const rewrite of rewrites || []) if (textMap.has(rewrite.line)) textMap.set(rewrite.line, rewrite.text);
  const output: string[] = [];
  for (const n of spanLineNumbers(stemSpans)) {
    const line = textMap.get(n);
    if (line === undefined) continue;
    if (!consumed.has(n)) {
      output.push(line);
      continue;
    }
    // Dialogue speaker label is stem prose even when a following option union uses this line span.
    if (/^\s*[A-Z]:\s+[A-Za-z]/.test(line)) { output.push(line); continue; }
    const markers = findOptionMarkers(line);
    const firstMarker = markers[0] ?? findLineStartOptionMarker(line);
    const number = parsePrintedNumberFromStem(line);
    // Keep the stem prefix of an option line when it is this question's printed line or an
    // un-numbered continuation (gap-completed "He ___ to school. a) go b) went" lines).
    if ((number === printedNo || number === undefined) && firstMarker && line.slice(0, firstMarker.start).trim()) {
      output.push(line.slice(0, firstMarker.start).trimEnd());
    }
  }
  return decontaminateOptionMarkup(output.join('\n'));
}

function splitGroupedAnswer(text: string, questionNo: number): { text: string; unmatched: boolean } {
  const view = matchingView(text);
  const normalized = view.text;
  const matcher = /(^|\s)(\d{1,3})\s*(?:[.)]\s+|[-–—:：]\s*)/g;
  const markers: Array<{ start: number; bodyStart: number; no: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(normalized))) {
    const start = m.index + (m[1] || '').length;
    markers.push({ start, bodyStart: matcher.lastIndex, no: Number(m[2]) });
  }
  if (markers.length < 2) return { text, unmatched: false };
  const selectedIndex = markers.findIndex(marker => marker.no === questionNo);
  if (selectedIndex < 0) return { text, unmatched: true };
  const selected = markers[selectedIndex];
  const next = markers[selectedIndex + 1];
  return { text: text.slice(view.originalOffset(selected.bodyStart), next ? view.originalOffset(next.start) : text.length).trim(), unmatched: false };
}

function escapeHtmlCell(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function assembleTables(rawTables: any, sourceLines: SourceLine[], keyLines: Set<number>): { html: string; rows: string[][]; spans: LineSpan[] }[] {
  if (!Array.isArray(rawTables)) return [];
  const out: { html: string; rows: string[][]; spans: LineSpan[] }[] = [];
  for (const t of rawTables) {
    const { spans } = sanitizeQuestionSpans(normalizedSpans(t?.spans), keyLines);
    if (!spans.length) continue;
    const rows = sliceSourceSpans(spans, sourceLines)
      .split(/\r?\n/)
      .map(line => line.split(/\t| {2,}/).map(cell => cell.trim()).filter(cell => cell.length > 0))
      .filter(row => row.length > 0);
    if (!rows.length) continue;
    // Keep escaped legacy HTML for file compatibility; the renderer consumes `rows`, never this HTML.
    const html = '<table>' + rows.map(row => '<tr>' + row.map(cell => `<td>${escapeHtmlCell(cell)}</td>`).join('') + '</tr>').join('') + '</table>';
    out.push({ html, rows, spans });
  }
  return out;
}

export interface AssembleResult {
  questions: Question[];
  flags: Flag[];
  failingQuestions: { question: Question; errors: string[] }[];
}

export interface AssembleOptions {
  keyTerritoryLineNos?: number[] | Set<number>;
  imageIds?: string[];
  unresolvedImageIds?: string[];
  /** 2A: assembled sections enable PASSAGE-ATTACHMENT / SECTION-CONTAINMENT validators. */
  sections?: ExamSection[];
  /** B2: deterministic gap completion before assembly (default on; patches opt out). */
  gapCompletion?: boolean;
  /** C2: STEM_HOLLOW / OPTIONS_MISSING errors join failingQuestions (default on; patches opt out). */
  semanticErrorsToRepair?: boolean;
  /** D: 'fenced' (default) only accepts rewrites on locally garbled, number-free lines; 'open' for user patches. */
  rewritePolicy?: 'fenced' | 'open';
  /** Deterministic segmenter receipts; optional for legacy/recovery callers. */
  segmentReceipts?: Array<{ id?: string; kind?: string; startLine: number; endLine: number; printedNo?: number; childNos?: number[]; parentSegmentId?: string; charStart?: number; charEnd?: number; ruleChain?: string[]; ruleConfidence?: number }>;
}

export const REWRITE_MAX_CHARS = 140;
/** D — fence a single rewrite request against the source line. Returns a rejection reason or undefined. */
export function rewriteRejection(rewrite: { line: number; text: string }, line: SourceLine | undefined, keyLines: Set<number>, allowedLines: Set<number>): string | undefined {
  if (!line) return 'line not in source';
  if (keyLines.has(rewrite.line) || line.tag === 'key') return 'key territory';
  if (!allowedLines.has(rewrite.line)) return 'outside question spans';
  if (!line.garbled) return 'line is not locally garbled';
  if (isFenceProtected(line.text) || /\d/.test(normalizeForMatching(line.text))) return 'line carries a printed number, option marker, digits or blank';
  if (typeof rewrite.text !== 'string' || !rewrite.text.trim()) return 'empty rewrite';
  if (rewrite.text.length > REWRITE_MAX_CHARS) return `rewrite longer than ${REWRITE_MAX_CHARS} chars`;
  if (/\d/.test(normalizeForMatching(rewrite.text)) && !/\d/.test(normalizeForMatching(line.text))) return 'rewrite introduces digits';
  return undefined;
}

function flag(code: string, message: string, severity: Flag['severity'], questionId?: string, id = `flag_${code}_${questionId || 'doc'}`): Flag {
  return { id, code, message, severity, questionId };
}

function compressLineNumbers(lines: number[]): LineSpan[] {
  const out: LineSpan[] = [];
  for (const n of lines) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === n) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

function sanitizeQuestionSpans(spans: LineSpan[], keyLines: Set<number>): { spans: LineSpan[]; clipped: boolean } {
  const keptLines = spanLineNumbers(spans).filter(n => !keyLines.has(n));
  return { spans: compressLineNumbers(keptLines), clipped: keptLines.length !== spanLineNumbers(spans).length };
}

/** Restrict patched spans to actual source lines; question fields may not use answer-key lines. */
export function sanitizeSpansAgainstSource(
  spans: unknown,
  sourceLines: SourceLine[],
  keyLines: Set<number>,
  allowKeyLines = false
): { spans: LineSpan[]; clippedKeyLines: boolean; clippedMissingLines: boolean } {
  const normalized = normalizedSpans(spans);
  const allLines = spanLineNumbers(normalized);
  const sourceIds = new Set(sourceLines.map(line => lineNoFromId(line.id)).filter(n => n > 0));
  const kept = allLines.filter(n => sourceIds.has(n) && (allowKeyLines || !keyLines.has(n)));
  return {
    spans: compressLineNumbers(kept),
    clippedKeyLines: !allowKeyLines && allLines.some(n => keyLines.has(n)),
    clippedMissingLines: kept.length !== allLines.filter(n => allowKeyLines || !keyLines.has(n)).length,
  };
}

function spanCoverage(q: Question): number {
  return spanLineNumbers(q.spans).length + (q.options || []).reduce((sum, option) => sum + spanLineNumbers(option.spans).length, 0);
}
function isSubset(a: Question, b: Question): boolean {
  const bLines = new Set(spanLineNumbers([...b.spans, ...(b.options || []).flatMap(o => o.spans)]));
  const aLines = spanLineNumbers([...a.spans, ...(a.options || []).flatMap(o => o.spans)]);
  return aLines.length > 0 && aLines.every(line => bLines.has(line));
}

function marksFromAnswerKey(lines: SourceLine[], keyLines: Set<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of lines) {
    if (!keyLines.has(lineNoFromId(line.id))) continue;
    const text = normalizeForMatching(line.text);
    const rangeRe = /(?:questions?|سوال(?:ات)?|سوالات\s*شماره)\s*(\d{1,3})\s*(?:to|تا|[-–])\s*(\d{1,3})[\s\S]{0,100}?(?:each|هر\s*کدام)[\s\S]{0,24}?\(?\s*(\d+(?:\.\d+)?)\s*\)?\s*(?:marks?|points?|نمره)?/gi;
    for (const m of text.matchAll(rangeRe)) {
      const start = Number(m[1]), end = Number(m[2]), mark = Number(m[3]);
      if (!Number.isFinite(mark) || start < 1 || end < start || end - start > 150) continue;
      for (let no = start; no <= end; no++) out.set(no, mark);
    }
    const grouped = /(?:questions?|سوال(?:ات)?|سوالات\s*شماره)\s*(\d{1,3})\s*(?:and|و|،|,)\s*(\d{1,3})[\s\S]{0,60}?(?:each|هر\s*کدام)[\s\S]{0,20}?\(?\s*(\d+(?:\.\d+)?)\s*\)?/gi;
    for (const m of text.matchAll(grouped)) {
      const mark = Number(m[3]);
      if (Number.isFinite(mark)) { out.set(Number(m[1]), mark); out.set(Number(m[2]), mark); }
    }
    const single = /(?:question|سوال)\s*(\d{1,3})\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?\s*(?:marks?|points?|نمره)/gi;
    for (const m of text.matchAll(single)) {
      const mark = Number(m[2]);
      if (Number.isFinite(mark)) out.set(Number(m[1]), mark);
    }
    const trailingParen = /(?:question|سوال)\s*(\d{1,3})[\s\S]{0,100}?(\d+(?:\.\d+)?)\s*\(\s*(?:marks?|points?|نمره)/gi;
    for (const m of text.matchAll(trailingParen)) {
      const mark = Number(m[2]);
      if (Number.isFinite(mark) && mark > 0 && mark <= 20) out.set(Number(m[1]), mark);
    }
    const contextual = /(?:question|سوال)\s*(\d{1,3})[\s\S]{0,100}?(?:\(\s*(\d+(?:\.\d+)?)\s*\)\s*(?:marks?|points?|نمره)|(?<![\d.])(\d+(?:\.\d+)?)\s*(?:marks?|points?|نمره))/gi;
    for (const m of text.matchAll(contextual)) {
      const mark = Number(m[2] || m[3]);
      if (Number.isFinite(mark) && mark > 0 && mark <= 20) out.set(Number(m[1]), mark);
    }
  }
  return out;
}

function deriveAndReconcilePoints(params: {
  questions: Question[]; lines: SourceLine[]; keyLines: Set<number>; total?: number; sections?: ExamSection[];
}): { flags: Flag[]; rescaled: boolean; before?: number; after?: number } {
  const roots = params.questions.filter(question => !question.parentId);
  const keyMarks = marksFromAnswerKey(params.lines, params.keyLines);
  const sourceHeaders = detectSectionHeaders(params.lines).map(header => ({
    line: header.headerLine, title: header.title, points: parsePrintedPoints(header.rawTitle),
  }));
  const fixed = new Set<string>();
  const derived = new Set<string>();
  const flags: Flag[] = [];
  // Preserve explicitly invalid negatives for the validation/reparse boundary; never mask them with defaults.
  const unsafeExplicitPoints = new Set(roots.filter(q => !keyMarks.has(q.no) && typeof q.points === 'number' && q.points < 0).map(q => q.id));

  // Source key values outrank section totals; model-supplied values are only provisional defaults.
  for (const q of roots) {
    const keyMark = keyMarks.get(q.no);
    if (keyMark !== undefined) { q.points = keyMark; fixed.add(q.id); derived.add(q.id); }
  }
  const sections = params.sections || [];
  for (const section of sections) {
    const members = roots.filter(q => q.sectionId === section.id);
    if (!members.length) continue;
    let printedTotal = typeof section.points === 'number' && section.points > 0 ? section.points : undefined;
    if (printedTotal === undefined) {
      const first = section.spans?.length ? Math.min(...section.spans.map(span => span[0])) : undefined;
      const header = sourceHeaders.find(candidate => candidate.points !== undefined && first !== undefined && Math.abs(candidate.line - first) <= 4);
      printedTotal = header?.points;
    }
    if (printedTotal === undefined) continue;
    const unmarked = members.filter(q => !fixed.has(q.id) && !unsafeExplicitPoints.has(q.id));
    if (!unmarked.length) continue;
    const reserved = members.filter(q => fixed.has(q.id) && !unsafeExplicitPoints.has(q.id)).reduce((sum, q) => sum + (q.points || 0), 0);
    const remainder = Math.max(0, printedTotal - reserved);
    const base = Math.floor((remainder / unmarked.length) * 100) / 100;
    unmarked.forEach((q, index) => { q.points = index === unmarked.length - 1 ? Number((remainder - base * (unmarked.length - 1)).toFixed(2)) : base; fixed.add(q.id); derived.add(q.id); });
  }

  for (const q of roots) {
    if (!fixed.has(q.id)) {
      if (typeof q.points === 'number' && q.points < 0) continue;
      if (!(typeof q.points === 'number' && Number.isFinite(q.points) && q.points > 0)) q.points = 0.5;
      derived.add(q.id); // default/model candidate is the only rescalable class
      flags.push(flag('POINTS_DERIVED', `Question ${q.label}: points defaulted from document evidence (0.5 before any document-total reconciliation).`, 'info', q.id));
    }
  }
  for (const child of params.questions.filter(question => question.parentId)) child.points = 0;
  const before = Number(roots.reduce((sum, q) => sum + (q.points || 0), 0).toFixed(2));
  let rescaled = false;
  const target = params.total;
  const adjustable = roots.filter(q => derived.has(q.id) && !fixed.has(q.id));
  if (target !== undefined && target > 0 && Math.abs(before - target) > 0.51 && adjustable.length) {
    const fixedSum = roots.filter(q => !adjustable.some(item => item.id === q.id)).reduce((sum, q) => sum + (q.points || 0), 0);
    const adjustableSum = adjustable.reduce((sum, q) => sum + (q.points || 0), 0);
    const residual = Math.max(0, target - fixedSum);
    if (adjustableSum > 0) {
      const scale = residual / adjustableSum;
      adjustable.forEach(q => { q.points = Number(((q.points || 0) * scale).toFixed(2)); });
      const afterRounded = adjustable.reduce((sum, q) => sum + (q.points || 0), 0);
      const delta = Number((residual - afterRounded).toFixed(2));
      if (adjustable.length) adjustable[adjustable.length - 1].points = Number(((adjustable[adjustable.length - 1].points || 0) + delta).toFixed(2));
      rescaled = true;
      flags.push(flag('POINTS_RESCALED', `Derived question points rescaled from ${before} to ${Number(roots.reduce((sum, q) => sum + (q.points || 0), 0).toFixed(2))} to match the immutable document total ${target}; key/header-derived marks were held fixed.`, 'warn'));
    }
  }
  for (const q of params.questions) {
    const keyDerived = keyMarks.has(q.no);
    const headerDerived = fixed.has(q.id) && !keyDerived;
    const rule = keyDerived ? 'points-derived:key' : unsafeExplicitPoints.has(q.id) ? 'points-invalid-preserved' : headerDerived ? 'points-derived:header' : 'points-derived:default';
    q.receipt = { ...(q.receipt || { lineStart: q.spans[0]?.[0] || 1, lineEnd: q.spans[q.spans.length - 1]?.[1] || q.spans[0]?.[0] || 1, ruleChain: [], ruleConfidence: 85 }), ruleChain: [...(q.receipt?.ruleChain || []), rule] };
    if (rescaled && !fixed.has(q.id)) q.receipt.ruleChain.push('points-rescaled');
  }
  return { flags, rescaled, before, after: Number(roots.reduce((sum, q) => sum + (q.points || 0), 0).toFixed(2)) };
}

function parsePrintedPoints(text: string): number | undefined {
  const normalized = normalizeForMatching(text);
  const match = normalized.match(/(?:\(\s*(\d+(?:\.\d+)?)\s*(?:points?|marks?|نمره)\s*\)|(?:نمره|points?|marks?)\s*[:：]?\s*(\d+(?:\.\d+)?))/i);
  const value = Number(match?.[1] || match?.[2]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function assembleAndValidateQuestions(
  rawQuestions: any[],
  sourceLines: SourceLine[],
  totalDeclaredPoints?: number,
  options: AssembleOptions = {}
): AssembleResult {
  const previousIndex = activeLineIndex;
  const built = lineIndexFor(sourceLines);
  activeLineIndex = { lines: sourceLines, byNo: built.byNo, text: built.text };
  try {
    return assembleAndValidateQuestionsInner(rawQuestions, sourceLines, totalDeclaredPoints, options);
  } finally {
    activeLineIndex = previousIndex;
  }
}
function assembleAndValidateQuestionsInner(
  rawQuestions: any[],
  sourceLines: SourceLine[],
  totalDeclaredPoints?: number,
  options: AssembleOptions = {}
): AssembleResult {
  const questions: Question[] = [];
  const flags: Flag[] = [];
  const failingQuestions: { question: Question; errors: string[] }[] = [];
  const lineIds = sourceLines.map(l => lineNoFromId(l.id)).filter(n => n > 0);
  const minLineId = lineIds.length ? lineIds.reduce((minimum, n) => Math.min(minimum, n), Infinity) : 1;
  const maxLineId = lineIds.length ? lineIds.reduce((maximum, n) => Math.max(maximum, n), 0) : sourceLines.length;
  const keyLines = new Set(options.keyTerritoryLineNos || []);
  sourceLines.filter(l => l.furniture).forEach(l => keyLines.add(lineNoFromId(l.id)));
  const allImageIds = options.imageIds ? new Set(options.imageIds) : null;
  const sourceByNo = new Map(sourceLines.map(line => [lineNoFromId(line.id), line]));
  const questionOverlap = new Set<string>();
  const rewritePolicy = options.rewritePolicy || 'fenced';

  // B2 — gap completion + option synthesis (pure, 0 calls) before any slicing.
  let rawList: any[] = Array.isArray(rawQuestions) ? rawQuestions : [];
  // A group detected locally by the segmenter emits missing children before any assistant repair.
  // Children retain source spans/character offsets and are ordinary optional question records.
  for (const segment of options.segmentReceipts || []) {
    if (segment.kind !== 'group-parent' || !segment.childNos?.length) continue;
    const parentNo = Number(segment.printedNo);
    let parent = rawList.find(q => Number(q?.no) === parentNo && !q?.parentId);
    if (!parent && Number.isInteger(parentNo) && parentNo > 0) {
      parent = { id: `q${parentNo}`, no: parentNo, label: String(parentNo), type: 'matching', spans: [[segment.startLine, segment.endLine]], confidence: 0.85 };
      rawList.push(parent);
    }
    if (!parent) continue;
    const parentId = String(parent.id || `q${parentNo}`);
    parent.id = parentId;
    // Intra-line enumerations need a one-line parent span so its character slice remains exact;
    // parenthesized shared-pool groups instead own the full deterministic segment range.
    if (typeof segment.charStart === 'number' && typeof segment.charEnd === 'number') {
      parent.spans = [[segment.startLine, segment.startLine]];
      parent.charStart = segment.charStart;
      parent.charEnd = segment.charEnd;
    } else {
      parent.spans = normalizedSpans([...(Array.isArray(parent.spans) ? parent.spans : []), [segment.startLine, segment.endLine]]);
    }
    const explicitChildren = (options.segmentReceipts || []).filter(item => item.parentSegmentId === segment.id && item.printedNo !== undefined);
    const childNos = explicitChildren.length ? explicitChildren.map(item => Number(item.printedNo)) : (segment.childNos || []).filter(no => Number(no) !== parentNo);
    for (const no of childNos) {
      if (!Number.isInteger(no) || Number(no) <= 0 || Number(no) === parentNo) continue;
      let childSpans: LineSpan[] = [[segment.startLine, segment.endLine]];
      let charStart: number | undefined;
      let charEnd: number | undefined;
      for (let ln = segment.startLine; ln <= segment.endLine; ln++) {
        const groupLine = sourceByNo.get(ln);
        if (!groupLine) continue;
        const intra = findIntraLineMultiNumbers(groupLine.text).find(item => item.no === no);
        const parens = [...groupLine.text.matchAll(/\((\d{1,3})\)/g)].map(match => ({ no: Number(match[1]), start: match.index || 0, end: (match.index || 0) + match[0].length }));
        const markerIndex = parens.findIndex(item => item.no === no);
        const marker = markerIndex >= 0 ? parens[markerIndex] : undefined;
        const nextMarker = marker ? parens.slice(markerIndex + 1).find(item => item.no !== no) : undefined;
        const ownStart = intra?.charStart ?? marker?.end;
        const ownEnd = intra?.charEnd ?? (marker ? nextMarker?.start ?? groupLine.text.length : undefined);
        if (ownStart !== undefined && ownEnd !== undefined && groupLine.text.slice(ownStart, ownEnd).replace(/[\s.。:：)）-]/g, '')) {
          childSpans = [[ln, ln]]; charStart = ownStart; charEnd = ownEnd; break;
        }
      }
      const existingChild = rawList.find(q => Number(q?.no) === no && q?.parentId === parentId);
      if (existingChild) continue;
      const existingRoot = rawList.find(q => Number(q?.no) === no && !q?.parentId && q !== parent);
      if (existingRoot) {
        const candidateLines = spanLineNumbers(normalizedSpans(existingRoot.spans));
        const belongsToGroup = candidateLines.some(line => line >= segment.startLine && line <= segment.endLine);
        if (!belongsToGroup) continue; // preserve a distinct repeated printed number for review
        existingRoot.parentId = parentId;
        existingRoot.sectionId ||= parent.sectionId;
        existingRoot.type ||= parent.type || 'matching';
        existingRoot.points = 0;
        existingRoot.spans = childSpans;
        if (charStart !== undefined) { existingRoot.charStart = charStart; existingRoot.charEnd = charEnd; }
        else { delete existingRoot.charStart; delete existingRoot.charEnd; }
        continue;
      }
      rawList.push({ id: `${parentId}_c${no}`, no, label: String(no), parentId, sectionId: parent.sectionId,
        type: parent.type || 'matching', spans: childSpans, ...(charStart !== undefined ? { charStart, charEnd } : {}),
        points: 0, confidence: parent.confidence || 0.85 });
    }
  }
  const absorbedByKey = new Map<string, number[]>();
  const synthesizedByKey = new Map<string, number>();
  if (options.gapCompletion !== false && rawList.length) {
    const completed = completeGapsRaw(rawList, sourceLines, { keyLines: new Set(options.keyTerritoryLineNos || []), sections: options.sections });
    rawList = completed.raw;
    for (const [k, v] of completed.absorbed) absorbedByKey.set(k, v);
    for (const [k, v] of completed.synthesized) synthesizedByKey.set(k, v);
  }

  // Fix 2 — expand intra-line multi-number lines (`63. a) ... 64. b) ... 65. c) ... 66. d) ...`)
  // into parent (first number, whole task) + 1 child per additional number inheriting parent section/type.
  {
    const existingNos = new Set(rawList.map(r => Number(r?.no)).filter(n => Number.isFinite(n)));
    const expandedList: any[] = [];
    const byLineNo = lineIndexFor(sourceLines).byNo;
    rawList.forEach((item, rIdx) => {
      expandedList.push(item);
      if (!item || typeof item !== 'object' || item.parentId) return;
      const itemSpans = normalizedSpans(item.spans);
      for (const ln of spanLineNumbers(itemSpans)) {
        const srcLine = byLineNo.get(ln);
        if (!srcLine || srcLine.furniture || keyLines.has(ln)) continue;
        const multi = findIntraLineMultiNumbers(srcLine.text);
        if (multi.length < 2 || multi[0].no !== Number(item.no)) continue;
        const parentId = typeof item.id === 'string' && item.id ? item.id : `q${Number(item.no) || rIdx + 1}`;
        item.id = parentId;
        if (item.charStart === undefined && item.charEnd === undefined && itemSpans.length === 1 && itemSpans[0][0] === itemSpans[0][1]) {
          item.charStart = multi[0].charStart;
          item.charEnd = multi[0].charEnd;
        }
        for (const childItem of multi.slice(1)) {
          if (existingNos.has(childItem.no)) continue;
          existingNos.add(childItem.no);
          expandedList.push({
            id: `${parentId}_c${childItem.no}`,
            no: childItem.no,
            label: String(childItem.no),
            parentId,
            sectionId: item.sectionId,
            type: item.type || 'matching',
            spans: [[ln, ln]] as LineSpan[],
            charStart: childItem.charStart,
            charEnd: childItem.charEnd,
            points: 0,
            confidence: item.confidence,
          });
        }
      }
    });
    rawList = expandedList;
  }

  const pagesForWatermark = new Set(sourceLines.map(l=>l.page)).size;
  const learnedWatermarks = computeLearnedWatermarks(sourceLines, pagesForWatermark);
  const lineById = lineIndexFor(sourceLines).byNo;
  let watermarkExcisionCount = 0;
  rawList.forEach((rawInput, idx) => {
    const raw = rawInput && typeof rawInput === 'object' ? { ...rawInput } : {};
    const errors: string[] = [];
    const parsed = RawQuestionSchema.safeParse(raw);
    if (!parsed.success) {
      const issues: any[] = (parsed.error as any).issues || [];
      errors.push(...issues.map((e: any) => `${e.path?.join('.') || 'root'}: ${e.message}`));
    }
    if (raw.stemText || raw.fullStem || raw.questionText || (typeof raw.stem === 'string' && raw.stem.length > 30)) {
      errors.push(`Span Contract Violation: Question ${raw.label || raw.no || idx + 1} returned prohibited stem text instead of spans.`);
      delete raw.stem; delete raw.stemText; delete raw.fullStem; delete raw.questionText;
    }

    const proposedId = typeof raw.id === 'string' && raw.id ? raw.id : `q${Number(raw.no) || idx + 1}`;
    const qId = questions.some(question => question.id === proposedId) ? `${proposedId}_dup_${idx + 1}` : proposedId;
    const originalNo = Number.isFinite(Number(raw.no)) ? Number(raw.no) : idx + 1;
    const originalSpans = normalizedSpans(raw.spans);
    if (!originalSpans.length) errors.push(`Missing spans: Question ${raw.label || qId} has no valid source span references.`);
    else if (Array.isArray(raw.spans) && originalSpans.length < raw.spans.length) errors.push('One or more source spans were malformed or exceeded the safe range limit.');
    const safe = sanitizeQuestionSpans(originalSpans, keyLines);
    const spans = safe.spans;
    if (safe.clipped && spans.length === 0) {
      flags.push(flag('KEY_TERRITORY_EXCLUDED', `Question candidate ${raw.label || raw.no || qId} spanned only official answer-key lines and was excluded from question parsing.`, 'warn', qId));
      return;
    }
    if (safe.clipped) {
      errors.push('Question span touched official answer-key territory and was clipped locally.');
      flags.push(flag('QUESTION_SPAN_IN_KEY_TERRITORY', `Question ${raw.label || qId} had question spans in answer-key territory; key lines were excluded.`, 'warn', qId));
    }
    for (const [start, end] of spans) if (start < minLineId || end > maxLineId || start > end) errors.push(`Invalid span [${start}, ${end}]: outside source range [${minLineId}, ${maxLineId}]`);

    const rawOptions: NonNullable<Question['options']> = (Array.isArray(raw.options) ? raw.options : []).map((option: any, optionIdx: number) => {
      const sanitized = sanitizeQuestionSpans(normalizedSpans(option?.spans), keyLines);
      if (sanitized.clipped) flags.push(flag('OPTION_SPAN_IN_KEY_TERRITORY', `Question ${raw.label || qId} option ${option?.key || optionIdx + 1} had spans in answer-key territory; key lines were excluded.`, 'warn', qId));
      return {
        key: String(option?.key || String.fromCharCode(97 + optionIdx)),
        spans: sanitized.spans,
        text: sliceSourceSpans(sanitized.spans, sourceLines),
      };
    });
    let perQuestionWatermark = false;
    // A2: watermark excision on option slices BEFORE splitting (excision then split)
    const split = splitOptionTexts(rawOptions, sourceLines, learnedWatermarks);
    let assembledOptions = split.options || [];
    if (split.excisedCount) { watermarkExcisionCount += split.excisedCount; perQuestionWatermark = true; }
    // Also excise any residual in already-separated options (without changing source lines).
    assembledOptions = assembledOptions.map(opt => {
      const exc = exciseWatermarksWithLearned(opt.text || '', learnedWatermarks);
      if (exc.excised) { watermarkExcisionCount += exc.count; perQuestionWatermark = true; }
      return { ...opt, text: exc.text };
    });
    const duplicateResult = collapseAdjacentOptionDuplicates(assembledOptions);
    assembledOptions = duplicateResult.options;
    if (duplicateResult.nonAdjacentDuplicates.length) {
      flags.push(flag('OPTION_DUPLICATE', `Question ${raw.label || qId}: repeated non-adjacent option text retained for verifier review.`, 'warn', qId));
    }
    const optionSplitFailed = split.failed;
    if (optionSplitFailed) {
      flags.push(flag('OPTION_SPLIT_FAILED', `Question ${raw.label || qId}: option markers (${findOptionMarkers(sliceOptionUnion(rawOptions, sourceLines)).length}) did not match ${rawOptions.length} option spans; unsplit option blob discarded.`, 'warn', qId));
    }
    const effectiveType = raw.type || 'unknown';
    const optionsMissingForMcq = effectiveType === 'mcq' && assembledOptions.length < 2;
    if (optionsMissingForMcq) {
      assembledOptions = [];
      flags.push(flag('OPTIONS_MISSING', `Question ${raw.label || qId}: MCQ has no valid split options; set options=[] instead of duplicating unsplit text.`, 'warn', qId));
    }
    // D — rewrite rights: fenced by default (garbled, number-free, non-key lines inside the question only).
    const requestedRewrites: Array<{ line: number; text: string }> = Array.isArray(raw.rewrites) ? raw.rewrites.filter((r: any) => r && Number.isInteger(r.line) && typeof r.text === 'string') : [];
    const acceptedRewrites: Array<{ line: number; text: string }> = [];
    if (rewritePolicy === 'open') acceptedRewrites.push(...requestedRewrites);
    else {
      const allowed = new Set(spanLineNumbers(spans));
      for (const rewrite of requestedRewrites) {
        const reason = rewriteRejection(rewrite, lineById.get(rewrite.line), keyLines, allowed);
        if (reason) flags.push(flag('REWRITE_REJECTED', `Question ${raw.label || qId}: rewrite for L${String(rewrite.line).padStart(4, '0')} rejected (${reason}); original text kept.`, 'info', qId, `flag_REWRITE_REJECTED_${qId}_${rewrite.line}`));
        else { acceptedRewrites.push(rewrite); flags.push(flag('REWRITE_APPLIED', `Question ${raw.label || qId}: garbled L${String(rewrite.line).padStart(4, '0')} rendered from the model's rewrite; original retained for one-click revert.`, 'info', qId, `flag_REWRITE_APPLIED_${qId}_${rewrite.line}`)); }
      }
    }
    // Intra-line char offset slicing (from segmenter or multi-number child expansion)
    let resolvedCharStart: number | undefined = typeof raw.charStart === 'number' ? raw.charStart : undefined;
    let resolvedCharEnd: number | undefined = typeof raw.charEnd === 'number' ? raw.charEnd : undefined;
    if (resolvedCharStart === undefined && spans.length === 1 && spans[0][0] === spans[0][1]) {
      const singleLine = lineById.get(spans[0][0]);
      if (singleLine) {
        const matchItem = findIntraLineMultiNumbers(singleLine.text).find(it => it.no === originalNo);
        if (matchItem) { resolvedCharStart = matchItem.charStart; resolvedCharEnd = matchItem.charEnd; }
      }
    }
    const hasIntraSlice = resolvedCharStart !== undefined && resolvedCharEnd !== undefined && spans.length === 1 && spans[0][0] === spans[0][1];
    const originalStemRaw = hasIntraSlice
      ? (lineById.get(spans[0][0])?.text || '').slice(resolvedCharStart, resolvedCharEnd).trim()
      : sliceSourceSpans(spans, sourceLines, acceptedRewrites);
    const originalExc = exciseWatermarksWithLearned(originalStemRaw, learnedWatermarks);
    const originalStem = originalExc.text;
    if (originalExc.excised) { watermarkExcisionCount += originalExc.count; perQuestionWatermark = true; }
    const printedBeforeCleanup = parsePrintedNumberFromStem(originalStem) ?? originalNo;
    let stem = hasIntraSlice
      ? originalStem
      : decontaminateStem(spans, rawOptions.flatMap((o: { spans: Array<[number, number]> }) => o.spans), sourceLines, printedBeforeCleanup, acceptedRewrites);
    const stemExc = exciseWatermarksWithLearned(stem, learnedWatermarks);
    if (stemExc.excised) { stem = stemExc.text; watermarkExcisionCount += stemExc.count; perQuestionWatermark = true; }
    let optionResidueTrimmed = false;
    if (assembledOptions.length > 0 && stem.trim()) {
      assembledOptions = assembledOptions.map(opt => {
        const tr = trimOptionInstructionResidue(opt.text || '', stem);
        if (tr.trimmed) optionResidueTrimmed = true;
        return tr.trimmed ? { ...opt, text: tr.text } : opt;
      });
      if (optionResidueTrimmed) {
        flags.push(flag('OPTION_RESIDUE_TRIMMED', `Question ${raw.label || qId}: trimmed trailing parent instruction fragment from option text.`, 'info', qId));
      }
    }
    if (!stem.trim()) errors.push('Assembled stem is empty');
    const gapKey = String(raw.id || `#${idx}`);
    if (absorbedByKey.has(gapKey)) flags.push(flag('GAP_ABSORBED', `Question ${raw.label || qId}: ${absorbedByKey.get(gapKey)!.length} unclaimed line(s) after the model's anchor were absorbed locally (${absorbedByKey.get(gapKey)!.slice(0, 6).map(n => `L${String(n).padStart(4, '0')}`).join(', ')}${absorbedByKey.get(gapKey)!.length > 6 ? ', …' : ''}).`, 'info', qId));
    if (synthesizedByKey.has(gapKey)) flags.push(flag('OPTIONS_SYNTHESIZED', `Question ${raw.label || qId}: ${synthesizedByKey.get(gapKey)} option(s) split locally from printed markers the model did not return.`, 'info', qId));

    // D3 + Fix 2: validate assembled question number against printed number in first span line & stem.
    const firstSpanLineObj = spans[0]?.[0] !== undefined ? lineById.get(spans[0][0]) : undefined;
    const firstLinePrintedNo = !hasIntraSlice && firstSpanLineObj && !firstSpanLineObj.furniture
      ? parsePrintedNumberFromStem(firstSpanLineObj.text.split(/\r?\n/)[0] || '')
      : undefined;
    const spanSourceLines = spanLineNumbers(spans).map(n => lineById.get(n)).filter((l): l is SourceLine => Boolean(l));
    const childCoveredOnSpan = Boolean(raw.parentId) && enumerateExpectedQuestionNos(spanSourceLines).numbers.includes(originalNo);
    const printedNo = childCoveredOnSpan
      ? originalNo
      : (firstLinePrintedNo ?? parsePrintedNumberFromStem(stem) ?? parsePrintedNumberFromStem(originalStem));
    let no = originalNo;
    let label = String(raw.label || originalNo);
    const numberingCorrected = printedNo !== undefined && printedNo !== originalNo;
    const firstLineSlipped = !childCoveredOnSpan && firstLinePrintedNo !== undefined && firstLinePrintedNo !== originalNo;
    if (printedNo !== undefined) {
      no = printedNo;
      if (numberingCorrected || normalizeForMatching(label).replace(/[.)\s]/g, '') !== String(printedNo)) {
        label = String(printedNo);
        if (numberingCorrected) {
          flags.push(flag('NUMBERING_CORRECTED', `Question numbering corrected locally: ${originalNo} → ${printedNo}.`, 'info', qId));
        }
        if (firstLineSlipped) {
          flags.push(flag('NUMBER_SLIPPED_CORRECTED', `Question emitted ${originalNo} when first span line printed ${firstLinePrintedNo}; renumbered to ${firstLinePrintedNo}.`, 'warn', qId));
        }
      }
    }

    let answer: Question['answer'];
    if (raw.answer?.spans) {
      const answerSpans = normalizedSpans(raw.answer.spans); // answer spans may point into key territory
      let fullText = sliceSourceSpans(answerSpans, sourceLines);
      const fullExc = exciseWatermarksWithLearned(fullText, learnedWatermarks);
      if (fullExc.excised) { fullText = fullExc.text; watermarkExcisionCount += fullExc.count; perQuestionWatermark = true; }
      const segmented = splitGroupedAnswer(fullText, no);
      let segText = segmented.text;
      const segExc = exciseWatermarksWithLearned(segText, learnedWatermarks);
      if (segExc.excised) { segText = segExc.text; watermarkExcisionCount += segExc.count; perQuestionWatermark = true; }
      answer = { spans: answerSpans, text: segText, source: 'paper' };
      if (segmented.unmatched) flags.push(flag('ANSWER_SEGMENT_UNMATCHED', `Question ${label}: grouped answer line did not contain printed number ${no}; full line retained for review.`, 'info', qId));
    }

    if (perQuestionWatermark) flags.push(flag('WATERMARK_STRIPPED', `Question ${label} had watermark substrings excised from sliced text.`, 'info', qId));
    const assembledTables = assembleTables(raw.tables, sourceLines, keyLines);
    const questionImages = (Array.isArray(raw.images) ? raw.images : []).map((image: any) => ({
      imageId: String(image?.imageId || ''), role: image?.role || 'stem', anchorLine: image?.anchorLine,
    })).filter((image: any) => image.imageId);

    // Detect span overlap with any other question. This is a local confidence defect.
    const currentLines = new Set(spanLineNumbers([...spans, ...rawOptions.flatMap(option => option.spans), ...assembledTables.flatMap(table => table.spans)]));
    let overlaps = false;
    for (const other of questions) {
      // E3: same-parent siblings legitimately share spans — waive overlap
      const sameParentSiblings = raw.parentId && other.parentId && raw.parentId === other.parentId;
      const isParentChild = (raw.parentId && other.id === raw.parentId) || (other.parentId && other.parentId === qId);
      if (sameParentSiblings || isParentChild) continue;
      const otherLines = new Set(spanLineNumbers([...other.spans, ...(other.options || []).flatMap(option => option.spans), ...(other.tables || []).flatMap(table => table.spans)]));
      if ([...currentLines].some(line => otherLines.has(line))) {
        overlaps = true;
        questionOverlap.add(qId);
        if (!other.flags?.includes('SPAN_OVERLAP')) other.flags = [...(other.flags || []), 'SPAN_OVERLAP'];
        flags.push(flag('SPAN_OVERLAP', `Question ${label} overlaps source lines with ${other.label}.`, 'warn', qId));
      }
    }

    const unresolvedIds = new Set(options.unresolvedImageIds || []);
    const unknownImageRefs = allImageIds ? questionImages.filter((image: any) => !allImageIds.has(image.imageId) || unresolvedIds.has(image.imageId)) : questionImages.filter((image: any) => unresolvedIds.has(image.imageId));
    const rawConfidence = typeof raw.confidence === 'number' ? raw.confidence : 0.8;
    let confidence = rawConfidence;
    if (optionSplitFailed) confidence -= 0.3;
    if (numberingCorrected) confidence -= 0.2;
    if (answer && flags.some(f => f.code === 'ANSWER_SEGMENT_UNMATCHED' && f.questionId === qId)) confidence -= 0.15;
    // E3: waive overlap penalty when parentId set and same-parent siblings share spans
    const shouldPenalizeOverlap = overlaps && !(raw.parentId);
    if (shouldPenalizeOverlap) confidence -= 0.2;
    if (unknownImageRefs.length) confidence -= 0.2;
    if ((raw.type || 'unknown') !== 'fillblank' && stem.trim().length < 8) confidence -= 0.3;
    confidence = Math.max(0.05, Math.min(0.98, confidence));
    const questionFlags = [...(Array.isArray(raw.flags) ? raw.flags.map(String) : [])];
    if (optionSplitFailed && !questionFlags.includes('OPTION_SPLIT_FAILED')) questionFlags.push('OPTION_SPLIT_FAILED');
    if (optionsMissingForMcq && !questionFlags.includes('OPTIONS_MISSING')) questionFlags.push('OPTIONS_MISSING');
    if (firstLineSlipped && !questionFlags.includes('NUMBER_SLIPPED_CORRECTED')) questionFlags.push('NUMBER_SLIPPED_CORRECTED');
    if (optionResidueTrimmed && !questionFlags.includes('OPTION_RESIDUE_TRIMMED')) questionFlags.push('OPTION_RESIDUE_TRIMMED');
    if (unknownImageRefs.length) questionFlags.push('IMAGE_REFERENCE_UNRESOLVED');
    if (overlaps) questionFlags.push('SPAN_OVERLAP');
    if (absorbedByKey.has(gapKey) && !questionFlags.includes('GAP_ABSORBED')) questionFlags.push('GAP_ABSORBED');
    if (acceptedRewrites.length && !questionFlags.includes('REWRITE_APPLIED')) questionFlags.push('REWRITE_APPLIED');
    if (confidence < 0.6 && !questionFlags.includes('LOW_CONFIDENCE')) questionFlags.push('LOW_CONFIDENCE');
    if (confidence < 0.6) flags.push(flag('LOW_CONFIDENCE', `Question ${label} confidence calibrated to ${(confidence * 100).toFixed(0)}%.`, 'info', qId));
    if (unknownImageRefs.length) flags.push(flag('IMAGE_REFERENCE_UNRESOLVED', `Question ${label} references unresolved image(s): ${unknownImageRefs.map((i: any) => i.imageId).join(', ')}.`, 'warn', qId));

    const segmentReceipt = (options.segmentReceipts || []).find(segment =>
      (segment.printedNo === no || segment.printedNo === originalNo) && segment.startLine <= Math.max(...spanLineNumbers(spans)) && segment.endLine >= Math.min(...spanLineNumbers(spans))
    ) || (options.segmentReceipts || []).find(segment => segment.parentSegmentId && segment.printedNo === no);
    const receiptStart = Math.min(...spanLineNumbers(spans), ...rawOptions.flatMap(option => spanLineNumbers(option.spans)));
    const receiptEnd = Math.max(...spanLineNumbers(spans), ...rawOptions.flatMap(option => spanLineNumbers(option.spans)));
    const ruleChain = [...(segmentReceipt?.ruleChain || (raw.parentId ? ['multi-number-split'] : ['question-start']))];
    if (absorbedByKey.has(gapKey)) ruleChain.push('gap-absorbed');
    if (split.inlineSplit) ruleChain.push('inline-options');
    if (perQuestionWatermark) ruleChain.push('watermark-excised');
    const receipt = {
      lineStart: Number.isFinite(receiptStart) ? receiptStart : (spans[0]?.[0] || 1),
      lineEnd: Number.isFinite(receiptEnd) ? receiptEnd : (spans[spans.length - 1]?.[1] || spans[0]?.[0] || 1),
      ruleChain,
      ruleConfidence: Math.max(0, Math.min(100, Number(segmentReceipt?.ruleConfidence ?? 85))),
    };
    const question: Question = {
      id: qId,
      label,
      no,
      parentId: typeof raw.parentId === 'string' ? raw.parentId : undefined,
      sectionId: typeof raw.sectionId === 'string' ? raw.sectionId : undefined,
      spans,
      stem,
      points: typeof raw.points === 'number' ? raw.points : undefined,
      type: effectiveType,
      options: assembledOptions.length ? assembledOptions : (optionsMissingForMcq ? [] : undefined),
      answer,
      rewrites: acceptedRewrites,
      images: questionImages,
      tables: assembledTables.length ? assembledTables : undefined,
      confidence,
      receipt,
      flags: questionFlags,
    };
    questions.push(question);
    if (errors.length || confidence < 0.4) failingQuestions.push({ question, errors });
  });

  // Duplicate printed numbers: promote true span subsets to children; otherwise retain both with a review warning.
  const byNo = new Map<number, Question[]>();
  for (const q of questions) byNo.set(q.no, [...(byNo.get(q.no) || []), q]);
  for (const [no, duplicates] of byNo) {
    if (duplicates.length < 2) continue;
    const ranked = [...duplicates].sort((a, b) => spanCoverage(b) - spanCoverage(a));
    const parent = ranked[0];
    for (const child of ranked.slice(1)) {
      if (isSubset(child, parent)) {
        child.parentId = parent.id;
        child.id = child.id === parent.id ? `${parent.id}_child` : child.id;
        child.flags = [...(child.flags || []), 'GROUP_CHILDREN_SUSPECT'];
        flags.push(flag('GROUP_CHILDREN_SUSPECT', `Question ${child.label} shares printed number ${no} and spans contained by ${parent.label}; nested for review.`, 'warn', child.id));
      } else {
        flags.push(flag('NUMBERING_DUPLICATE', `Multiple questions claim printed number ${no}; all are retained for review.`, 'warn', child.id));
      }
    }
  }
  const sharedStemGroups = new Map<string, Question[]>();
  for (const q of questions) {
    if (q.spans.length !== 1 || q.spans[0][0] !== q.spans[0][1] || !q.stem) continue;
    const key = `${q.spans[0][0]}:${q.stem}`;
    sharedStemGroups.set(key, [...(sharedStemGroups.get(key) || []), q]);
  }
  for (const group of sharedStemGroups.values()) {
    if (group.length < 3) continue;
    const parent = group[0];
    for (const child of group.slice(1)) {
      child.parentId ||= parent.id;
      child.flags = [...(child.flags || []), 'GROUP_CHILDREN_SUSPECT'];
    }
    flags.push(flag('GROUP_CHILDREN_SUSPECT', `${group.length} questions share one identical single-line span/stem; nested under ${parent.label} for review.`, 'warn', parent.id));
  }

  const hierarchy = buildQuestionTree(questions);
  for (const question of questions) {
    if (!question.parentId || hierarchy.parentByChild.has(question.id)) continue;
    const isCycle = hierarchy.cycleBreaks.has(question.id);
    question.parentId = undefined;
    flags.push(flag(
      isCycle ? 'PARENT_CYCLE_REPAIRED' : 'PARENT_REFERENCE_REPAIRED',
      isCycle
        ? `Question ${question.label} had a cyclic parent link; the local relationship was broken so every question remains visible.`
        : `Question ${question.label} had a missing or self-referential parent; it was retained as a root question.`,
      'warn', question.id
    ));
  }
  // E2/E3 — points derivation: ensure every question has a number, section sums reconcile
  {
    // Build section map for derivation
    const sectionById = new Map<string, { points?: number; count: number }>();
    for (const q of questions) {
      const sid = q.sectionId || 'sec_1';
      const cur = sectionById.get(sid) || { points: undefined, count: 0 };
      cur.count++;
      sectionById.set(sid, cur);
    }
    // Populate section points from options.sections if available (E1)
    if (options.sections) {
      for (const s of options.sections as any[]) {
        const id = String(s.id || s.index || 'sec_1');
        const pts = typeof s.points === 'number' ? s.points : undefined;
        if (pts !== undefined) {
          const cur = sectionById.get(id) || { count: 0 };
          cur.points = pts;
          sectionById.set(id, cur);
        }
      }
    }
    for (const q of questions) {
      if (typeof q.points !== 'number') {
        // Try section-derived
        const sid = q.sectionId || 'sec_1';
        const sec = sectionById.get(sid);
        let derived: number | undefined;
        if (sec?.points !== undefined && sec.count > 0) {
          const per = Math.round((sec.points / sec.count) * 4) / 4;
          // Remainder handling: last item gets remainder
          const isLastInSection = questions.filter(x=> (x.sectionId||'sec_1')===sid).indexOf(q) === sec.count -1;
          if (isLastInSection) {
            const sumPrev = questions.filter(x=> (x.sectionId||'sec_1')===sid && x!==q).reduce((s,qq)=>s+(qq.points||per),0);
            derived = Number((sec.points - sumPrev).toFixed(2));
            if (derived <=0) derived = per;
          } else {
            derived = per;
          }
        } else {
          derived = 0.5;
        }
        q.points = derived;
        flags.push(flag('POINTS_DERIVED', `Q${q.no} points derived as ${derived} (E2 fallback).`, 'info', q.id));
        q.flags = [...(q.flags||[]), 'POINTS_DERIVED'];
      }
    }
    // Handle matching/group children: parent holds group total, children 0 unless per-item
    // For now ensure roots sum logic; children already handled via parentId with 0 default? Keep as is.
    // If parent has points and children have 0, no double count - invariant E3 checks roots only.
  }

  questions.sort((a, b) => a.no - b.no || Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || a.id.localeCompare(b.id));

  // 2A semantic validators (pure, 0 calls) — inside the single assembly funnel so
  // fresh/resumed/chunked/imported documents are all checked identically.
  for (const issue of validateSemantic(questions, options.sections || [], q => sliceSourceSpans(q.spans, sourceLines))) {
    flags.push(flag(issue.code, issue.message, issue.severity, issue.questionId));
    const q = questions.find(item => item.id === issue.questionId);
    if (q) {
      if (!q.flags?.includes(issue.code)) q.flags = [...(q.flags || []), issue.code];
      if (issue.severity === 'warn') q.confidence = Math.max(0.05, q.confidence - semanticConfidenceDeduction([issue]));
      if (issue.severity === 'error') {
        // C2 — error validators are wired into the escalation-repair queue, never left as decoration.
        q.confidence = Math.max(0.05, q.confidence - 0.15);
        if (options.semanticErrorsToRepair !== false) {
          const existing = failingQuestions.find(f => f.question.id === q.id);
          if (existing) existing.errors.push(issue.message); else failingQuestions.push({ question: q, errors: [issue.message] });
        }
      }
    }
  }

  const documentTotal = extractDocumentTotals(sourceLines, keyLines).documentTotal ?? totalDeclaredPoints;
  const pointDerivation = deriveAndReconcilePoints({ questions, lines: sourceLines, keyLines, total: documentTotal, sections: options.sections });
  flags.push(...pointDerivation.flags);
  if (documentTotal !== undefined && documentTotal > 0) {
    const sum = questions.filter(question => !question.parentId).reduce((acc, question) => acc + (question.points || 0), 0);
    if (Math.abs(sum - documentTotal) > 0.51) flags.push(flag('POINTS_MISMATCH', `Points sum (${sum}) does not match immutable document total (${documentTotal}); deficit ${Number((documentTotal - sum).toFixed(2))}.`, 'warn'));
  }
  const sortedNos = questions.filter(q => !q.parentId).map(q => q.no).sort((a, b) => a - b);
  for (let i = 0; i < sortedNos.length - 1; i++) if (sortedNos[i + 1] - sortedNos[i] > 1) flags.push(flag('NUMBERING_GAP', `Question numbering gap between #${sortedNos[i]} and #${sortedNos[i + 1]}.`, 'info'));
  return { questions, flags, failingQuestions };
}

function cleanSectionTitle(value: string | undefined): string {
  const original = (value || '').trim(); const view = matchingView(original);
  const start = /^\s*\d{1,3}\s*[.)-]?\s+/.exec(view.text)?.[0].length || 0;
  const suffix = /\s+\d{1,3}\s*$|\s*-\s*(?:ردیف|نمره|points?|marks?).*$/i.exec(view.text);
  return original.slice(view.originalOffset(start), suffix ? view.originalOffset(suffix.index) : original.length).replace(/[|¦\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function parseSectionPoints(text: string): number | undefined {
  const normalized = normalizeForMatching(text);
  const match = normalized.match(/(?:\(\s*(\d+(?:\.\d+)?)\s*(?:points?|marks?|نمره)\s*\)|(?:نمره|points?|marks?)\s*[:：]?\s*(\d+(?:\.\d+)?))/i);
  const n = Number(match?.[1] || match?.[2]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isHeaderOrRowLine(text: string): boolean {
  const value = normalizeForMatching(text).trim();
  return !value || /^(?:section|part|unit)\s+\d+\b/i.test(value) ||
    /^\d{1,3}\s+(?:listening|vocabulary|grammar|reading|writing)\b/i.test(value) ||
    /(?:ردیف|نمره|points?|marks?)/i.test(value) && value.length < 100 ||
    /^\d{1,3}\s*[|│]/.test(value);
}

function isInstructionLine(text: string): boolean {
  return /^(?:instructions?\b|directions?\b|read\b|choose\b|select\b|listen\b|complete\b|answer\b|fill\b|match\b|write\b|دستورالعمل|به سوالات|به پرسش|گزینه)/i.test(normalizeForMatching(text).trim());
}

function trimInstructions(instructions: string, title: string, allSectionTitles: string[]): { text: string; long: boolean } {
  const lines = instructions.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const clean = line.trim();
    if (kept.length > 0 && (/^\s*\d{1,3}\s*$/.test(normalizeForMatching(clean)) || allSectionTitles.some(t => t && normalizeForMatching(t) !== normalizeForMatching(title) && normalizeForMatching(clean).includes(normalizeForMatching(t))))) break;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return { text, long: text.length > 400 };
}

export interface AssembleSectionsResult { sections: ExamSection[]; flags: Flag[] }

export function assembleAndValidateSections(
  rawSections: any[],
  sourceLines: SourceLine[],
  questions: Question[] = [],
  keyTerritoryLineNos: number[] | Set<number> = []
): AssembleSectionsResult {
  const flags: Flag[] = [];
  const keyLines = keyTerritoryLineNos instanceof Set ? keyTerritoryLineNos : new Set(keyTerritoryLineNos);
  const raw = Array.isArray(rawSections) ? rawSections : [];
  const fallbackSpan: LineSpan[] = sourceLines.length ? [[lineNoFromId(sourceLines[0].id), lineNoFromId(sourceLines[sourceLines.length - 1].id)]] : [];
  const candidates = raw.length ? raw : [{ id: 'sec_1', index: 1, spans: fallbackSpan }];
  const firstQuestionLine = (sectionId: string) => Math.min(Infinity, ...questions.filter(q => q.sectionId === sectionId).flatMap(q => spanLineNumbers(q.spans)));
  const provisional = candidates.map((section, index) => {
    const spans = normalizedSpans(section?.spans);
    const id = String(section?.id || `sec_${index + 1}`);
    const indexValue = Number(section?.index) || index + 1;
    const sectionLines = sourceLines.filter(line => !line.furniture && spans.some(([start, end]) => lineNoFromId(line.id) >= start && lineNoFromId(line.id) <= end));
    const headerLines = sectionLines.slice(0, 12);
    const titleRaw = typeof section?.title === 'string' ? section.title : (typeof section?.kind === 'string' ? section.kind : '');
    let title = cleanSectionTitle(titleRaw);
    const genericTitles = new Set(['question group', 'section', 'part', 'page', 'question']);
    const normalizedTitle = normalizeForMatching(title);
    const isGeneric = genericTitles.has(normalizedTitle) || /^question group\s*\d*$/i.test(title) || /^section\s*\d*$/i.test(title) || /^part\s*\d*$/i.test(title);
    // A2: generic titles forbidden when header-derived title exists within ±3 lines of section start
    const allHeaders = detectSectionHeaders(sourceLines);
    const sectionStartLine = spans.length ? Math.min(...spans.map(s=>s[0])) : 0;
    const nearbyHeader = allHeaders.find(h => Math.abs(h.headerLine - sectionStartLine) <= 3);
    if (isGeneric && nearbyHeader) {
      title = nearbyHeader.title;
      flags.push(flag('SECTION_TITLE_DERIVED', `Section ${indexValue} title was derived locally as “${title}”.`, 'info'));
    } else if (!title || /^\d+$/.test(normalizeForMatching(title)) || isGeneric) {
      const derived = headerLines.find(line => !isHeaderOrRowLine(line.text) && !/^[\s\d.():-]+$/.test(normalizeForMatching(line.text)));
      if (derived) {
        title = cleanSectionTitle(derived.text);
        flags.push(flag('SECTION_TITLE_DERIVED', `Section ${indexValue} title was derived locally as “${title}”.`, 'info'));
      } else if (nearbyHeader) {
        title = nearbyHeader.title;
        flags.push(flag('SECTION_TITLE_DERIVED', `Section ${indexValue} title was derived locally as “${title}”.`, 'info'));
      } else if (isGeneric) {
        // Keep generic but flag as derived from fallback
        flags.push(flag('SECTION_TITLE_DERIVED', `Section ${indexValue} title was derived locally as “${title}”.`, 'info'));
      } else {
        title = `Section ${indexValue}`;
        flags.push(flag('SECTION_TITLE_DERIVED', `Section ${indexValue} title was derived locally as “${title}”.`, 'info'));
      }
    } else if (nearbyHeader && normalizeForMatching(title) !== normalizeForMatching(nearbyHeader.title)) {
      // Even if title is not generic but nearby header exists and title doesn't match, prefer header if within ±3 and title generic-like? For now keep original but ensure flag if we replace
      // This handles case where model invented bucket while header exists
      if (isGeneric) {
        title = nearbyHeader.title;
        flags.push(flag('SECTION_TITLE_DERIVED', `Section ${indexValue} title was derived locally as “${title}”.`, 'info'));
      }
    }
    const firstQ = firstQuestionLine(id);
    const preQuestion = sectionLines.filter(line => lineNoFromId(line.id) < firstQ);
    const inferredInstruction = preQuestion.map(line => line.text).filter(text => isInstructionLine(text)).join('\n');
    const instructionCandidate = typeof section?.instructions === 'string' ? section.instructions : inferredInstruction;
    const trimmed = trimInstructions(instructionCandidate, title, raw.map(s => cleanSectionTitle(s?.title || s?.kind)));
    if (trimmed.long) flags.push(flag('SECTION_INSTRUCTIONS_LONG', `Section ${indexValue} instructions exceed 400 characters after trimming.`, 'info'));

    const questionLineSet = new Set(questions.filter(q => q.sectionId === id).flatMap(q => spanLineNumbers([...q.spans, ...(q.options || []).flatMap(o => o.spans), ...(q.tables || []).flatMap(table => table.spans)])));
    const areaLines = sectionLines.filter(line => !questionLineSet.has(lineNoFromId(line.id)) && !keyLines.has(lineNoFromId(line.id)) && !isHeaderOrRowLine(line.text) && !isInstructionLine(line.text) && cleanSectionTitle(line.text) !== title);
    const passageRaw = areaLines.map(line => line.text.trim()).filter(Boolean).join('\n').trim();
    const passageExc = passageRaw ? exciseWatermarks(passageRaw) : { text: passageRaw, excised: false };
    const passage = passageExc.text;
    const storedPassage = passage.split(/\r?\n/).length >= 2 || passage.length >= 120 ? passage : undefined;

    const pointHeader = headerLines.find(line => parseSectionPoints(line.text) !== undefined);
    const points = typeof section?.points === 'number' ? section.points : pointHeader ? parseSectionPoints(pointHeader.text) : undefined;
    const sectionQuestions = questions.filter(q => q.sectionId === id);
    const sectionSum = sectionQuestions.reduce((sum, q) => sum + (q.points || 0), 0);
    if (points !== undefined && Math.abs(points - sectionSum) > 0.51) flags.push(flag('SECTION_POINTS_MISMATCH', `Section ${indexValue} question points sum (${sectionSum}) differs from header points (${points}).`, 'info'));
    return { id, index: indexValue, title, instructions: trimmed.text || undefined, points, passage: storedPassage, spans };
  });
  const canonical = canonicalizeSections(provisional, questions);
  return { sections: canonical.sections, flags: [...flags, ...canonical.flags] };
}

/** Fix 4 — Canonical section identity: sort by first span line, index 1..n, remap missing sectionIds, flag SECTION_ORDER_CANONICALIZED if changed. */
export function canonicalizeSections(
  sections: ExamSection[],
  questions: Question[] = [],
): { sections: ExamSection[]; questions: Question[]; changed: boolean; flags: Flag[] } {
  if (!sections.length) return { sections, questions, changed: false, flags: [] };
  const firstSpanLine = (s: ExamSection) => s.spans?.length ? Math.min(...s.spans.map(sp => sp[0])) : Infinity;
  let idChanged = false;
  const allocatedIds = new Set<string>();
  const deduped = sections.map(sec => {
    let id = sec.id || 'sec_1';
    if (allocatedIds.has(id)) {
      let suffix = 2;
      while (allocatedIds.has(`${id}_${suffix}`)) suffix++;
      id = `${id}_${suffix}`;
      idChanged = true;
    }
    allocatedIds.add(id);
    return id === sec.id ? sec : { ...sec, id };
  });

  const sorted = [...deduped].sort((a, b) => {
    const da = firstSpanLine(a);
    const db = firstSpanLine(b);
    if (da !== db) return da - db;
    return (a.index || 0) - (b.index || 0);
  });

  const orderChanged = sorted.some((s, i) => s.id !== sections[i].id || s.index !== i + 1);
  const canonical = sorted.map((s, i) => (s.index === i + 1 ? s : { ...s, index: i + 1 }));
  const validIds = new Set(canonical.map(s => s.id));

  let remappedAny = false;
  const remappedQuestions = questions.map(q => {
    if (!q.sectionId || validIds.has(q.sectionId)) return q;
    const qLine = q.spans?.[0]?.[0];
    const containing = qLine !== undefined
      ? canonical.find(s => s.spans.some(([start, end]) => qLine >= start && qLine <= end))
      : undefined;
    const nearest = containing ?? (qLine !== undefined
      ? [...canonical].sort((a, b) => Math.abs(firstSpanLine(a) - qLine) - Math.abs(firstSpanLine(b) - qLine))[0]
      : canonical[0]);
    remappedAny = true;
    return nearest ? { ...q, sectionId: nearest.id } : q;
  });

  const changed = idChanged || orderChanged || remappedAny;
  const outFlags: Flag[] = changed
    ? [flag('SECTION_ORDER_CANONICALIZED', 'Section order and 1..n indices were canonicalized locally by source span position.', 'info', undefined, 'flag_SECTION_ORDER_CANONICALIZED')]
    : [];
  return { sections: canonical, questions: remappedQuestions, changed, flags: outFlags };
}

/** A1: Image ID uniqueness — reassign sequentially in (page, y, x) order, updating refs. */
export function reassignImageIdsSequential(doc: ExamDoc): ExamDoc {
  if (!doc.images || doc.images.length === 0) return doc;
  // Sort by page, y, x with original index for stable tie-break
  const indexed = doc.images.map((img, idx) => ({ img, originalIdx: idx }));
  const sorted = [...indexed].sort((a,b)=>{
    if (a.img.page !== b.img.page) return a.img.page - b.img.page;
    const ay = (a.img as any).y ?? a.img.bbox?.y ?? 0;
    const by = (b.img as any).y ?? b.img.bbox?.y ?? 0;
    if (ay !== by) return ay - by;
    const ax = a.img.bbox?.x ?? 0;
    const bx = b.img.bbox?.x ?? 0;
    if (ax !== bx) return ax - bx;
    return a.originalIdx - b.originalIdx;
  });
  // Assign new ids sequentially to each occurrence (handles duplicate old ids)
  const newIdByOriginalIdx = new Map<number, string>();
  sorted.forEach((item, newIdx)=>{
    const newId = `img_${String(newIdx+1).padStart(3,'0')}`;
    newIdByOriginalIdx.set(item.originalIdx, newId);
  });
  const newImages = doc.images.map((img, idx)=> ({ ...img, id: newIdByOriginalIdx.get(idx)! }));
  // For question refs, map old id occurrences in order: first ref to old id maps to first new id for that old id, etc.
  const oldIdOccurrenceToNew = new Map<string, string[]>();
  sorted.forEach((item) => {
    const oldId = item.img.id;
    const newId = newIdByOriginalIdx.get(item.originalIdx)!;
    const list = oldIdOccurrenceToNew.get(oldId) || [];
    list.push(newId);
    oldIdOccurrenceToNew.set(oldId, list);
  });
  const usedCount = new Map<string, number>();
  const newQuestions = doc.questions.map(q=> ({
    ...q,
    images: q.images.map(ref=> {
      const list = oldIdOccurrenceToNew.get(ref.imageId);
      if (!list) return ref;
      const count = usedCount.get(ref.imageId) || 0;
      // Use next occurrence in round-robin; if refs exceed occurrences, cycle to first
      const newId = list[count % list.length];
      usedCount.set(ref.imageId, count+1);
      return { ...ref, imageId: newId };
    })
  }));
  return { ...doc, images: newImages, questions: newQuestions };
}
interface RenamedImageOccurrence {
  image: ImageAsset;
  index: number;
}

function pageForImageReference(
  question: Question,
  anchorLine: number | undefined,
  pageByLine: Map<number, number>
): number | undefined {
  const line = anchorLine ?? question.spans[0]?.[0];
  return line === undefined ? undefined : pageByLine.get(line);
}

function imageLabelMatchesQuestion(image: ImageAsset, question: Question): boolean {
  const reference = image.label?.questionRef;
  return reference !== undefined && (
    reference === question.id ||
    reference === question.label ||
    reference === String(question.no)
  );
}

function chooseImageOccurrence(
  occurrences: RenamedImageOccurrence[],
  question: Question,
  anchorLine: number | undefined,
  pageByLine: Map<number, number>
): RenamedImageOccurrence {
  const referencePage = pageForImageReference(question, anchorLine, pageByLine);
  const onReferencePage = referencePage === undefined
    ? occurrences
    : occurrences.filter(occurrence => occurrence.image.page === referencePage);
  const pageCandidates = onReferencePage.length > 0 ? onReferencePage : occurrences;
  const labelCandidates = pageCandidates.filter(occurrence => imageLabelMatchesQuestion(occurrence.image, question));
  const candidates = labelCandidates.length > 0 ? labelCandidates : pageCandidates;
  const targetLine = anchorLine ?? question.spans[0]?.[0];

  return [...candidates].sort((left, right) => {
    if (targetLine !== undefined) {
      const leftDistance = Math.abs((left.image.anchorLine ?? targetLine) - targetLine);
      const rightDistance = Math.abs((right.image.anchorLine ?? targetLine) - targetLine);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    }
    return left.index - right.index;
  })[0];
}

export function validateAndFixDuplicateImageIds(doc: ExamDoc): { doc: ExamDoc; fixed: boolean; duplicates: string[] } {
  const occurrenceCounts = new Map<string, number>();
  for (const image of doc.images) occurrenceCounts.set(image.id, (occurrenceCounts.get(image.id) || 0) + 1);
  const duplicates = [...occurrenceCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  const malformedSuffixIds = doc.images.filter(image => /_dup\d+$/.test(image.id)).map(image => image.id);
  const affectedIds = [...new Set([...duplicates, ...malformedSuffixIds])];
  if (affectedIds.length === 0) return { doc, fixed: false, duplicates: [] };

  const affected = new Set(affectedIds);
  const reservedIds = new Set(doc.images.map(image => image.id));
  const nextOccurrenceById = new Map<string, number>();
  const allocatedIds = new Set<string>();
  const occurrencesByOriginalId = new Map<string, RenamedImageOccurrence[]>();
  let nextNumber = doc.images.reduce((maximum, image) => {
    const match = image.id.match(/(?:^|[_-])(\d+)(?:_dup\d+)?$/);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
  const freshSequentialId = () => {
    let id = '';
    do { id = `img_${String(nextNumber++).padStart(3, '0')}`; } while (reservedIds.has(id) || allocatedIds.has(id));
    return id;
  };

  const images = doc.images.map((image, index) => {
    const occurrence = (nextOccurrenceById.get(image.id) || 0) + 1;
    nextOccurrenceById.set(image.id, occurrence);
    let id = image.id;
    if ((duplicates.includes(image.id) && occurrence > 1) || /_dup\d+$/.test(image.id)) id = freshSequentialId();
    allocatedIds.add(id);
    const renamed = { ...image, id };
    const occurrences = occurrencesByOriginalId.get(image.id) || [];
    occurrences.push({ image: renamed, index });
    occurrencesByOriginalId.set(image.id, occurrences);
    return renamed;
  });

  const pageByLine = new Map(doc.source.lines.map(line => [lineNoFromId(line.id), line.page]));
  const questions = doc.questions.map(question => ({
    ...question,
    images: question.images.map(reference => {
      if (!affected.has(reference.imageId)) return reference;
      const occurrences = occurrencesByOriginalId.get(reference.imageId);
      if (!occurrences?.length) return reference;
      const image = chooseImageOccurrence(occurrences, question, reference.anchorLine, pageByLine);
      return { ...reference, imageId: image.image.id };
    }),
  }));

  const flags: Flag[] = [
    ...doc.flags,
    {
      id: `flag_image_duplicate_${affectedIds.map(id => id.replace(/[^A-Za-z0-9_-]/g, '_')).join('_')}`,
      code: 'IMAGE_ID_DUPLICATE',
      severity: 'warn',
      message: `Duplicate or non-sequential duplicate imageId(s) detected: ${affectedIds.join(', ')}. Renamed to sequential ids with page-aware question-reference updates.`,
    },
  ];

  return { doc: { ...doc, images, questions, flags }, fixed: true, duplicates: affectedIds };
}

/** Convert legacy/imported table HTML into inert cell strings (no attributes or raw markup survive). */
export function extractSafeTableRows(html: string): string[][] {
  if (!html) return [];
  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(parsed.querySelectorAll('tr')).map(row => Array.from(row.querySelectorAll('th,td')).map(cell => cell.textContent || '')).filter(row => row.length > 0);
  }
  // Non-browser fallback: remove all tags and split only known table structure.
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<[^>]*>/g, '\t').split(/\r?\n/).map(row => row.split(/\t+/).map(cell => cell.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()).filter(Boolean)).filter(row => row.length > 0);
}
