/**
 * Deterministic, local-only assembly and integrity checks.
 * Models provide spans; this module is the single pure assembly funnel used by
 * fresh, cached, resumed, chunked, patched, and imported documents.
 */
import { z } from 'zod';
import { ExamDoc, ExamSection, Flag, ImageAsset, LineSpan, Question, SourceLine } from '../types';
import { normalizeForMatching, matchingView, parsePrintedNumberFromStem, detectSectionHeaders } from './quality';
import { buildQuestionTree } from '../utils/questionTree';
import { validateSemantic, semanticConfidenceDeduction, semanticIssuesFor } from './semanticValidators';
import { completeGapsRaw } from './ownership';
import { isContentJunk, isFenceProtected } from './cleanup';

export const SpanReferenceSchema = z.tuple([z.number().int().positive(), z.number().int().positive()]);
export const RawQuestionSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  no: z.number().int().positive(),
  parentId: z.string().optional(),
  sectionId: z.string().optional(),
  spans: z.array(SpanReferenceSchema),
  points: z.number().optional(),
  type: z.enum(['mcq', 'truefalse', 'short', 'long', 'fillblank', 'matching', 'multi', 'numeric', 'diagram', 'essay', 'unknown']).optional(),
  options: z.array(z.object({ key: z.string().optional(), spans: z.array(SpanReferenceSchema) })).optional(),
  answer: z.object({ spans: z.array(SpanReferenceSchema).optional() }).optional(),
  tables: z.array(z.object({ spans: z.array(SpanReferenceSchema) })).optional(),
  rewrites: z.array(z.object({ line: z.number().int().positive(), text: z.string() })).optional(),
  images: z.array(z.object({ imageId: z.string(), role: z.enum(['stem', 'option', 'table', 'decoration']).optional(), anchorLine: z.number().optional() })).optional(),
  confidence: z.number().min(0).max(1).optional(),
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
const LATIN = 'a-h';
const PERSIAN_MARKERS = 'الف|ب|پ|ت|ث|ج|چ|ح|خ|د|ذ|ر|ز|ژ|س|ش|ص|ض|ط|ظ|ع|غ|ف|ق|ک|گ|ل|م|ن|و|ه|ی';
const OPTION_MARKER = new RegExp(`(^|\\s)(?:\\(([${LATIN}])\\)|([${LATIN}])[).:]|\\((${PERSIAN_MARKERS})\\)|(${PERSIAN_MARKERS})[).:])(?=\\s|$)`, 'gim');

function findOptionMarkers(text: string): Marker[] {
  const found: Marker[] = [];
  const view = matchingView(text);
  OPTION_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPTION_MARKER.exec(view.text))) {
    const markerStart = match.index + (match[1] || '').length;
    const key = (match[2] || match[3] || match[4] || match[5] || '').toLowerCase();
    found.push({ start: view.originalOffset(markerStart), end: view.originalOffset(OPTION_MARKER.lastIndex), key });
  }
  if (found.length === 0) {
    const pairs = [...view.text.matchAll(/(?:^|[\s/])(true|false|درست|نادرست)(?=\s|$|[).:/])/g)];
    const keys = pairs.map(m => m[1]);
    if ((keys.includes('true') && keys.includes('false')) || (keys.includes('درست') && keys.includes('نادرست'))) {
      for (const m of pairs) { const start = m.index! + m[0].length - m[1].length; found.push({ start: view.originalOffset(start), end: view.originalOffset(start + m[1].length), key: m[1], display: text.slice(view.originalOffset(start), view.originalOffset(start + m[1].length)) }); }
    }
  }
  return found;
}

/** Remove only text following explicit option markers; never delete ordinary stem words that match an option. */
export function decontaminateOptionMarkup(text: string): string {
  return text.split(/\r?\n/).flatMap(line => {
    // Explicit letter markers only: a stem such as "True or false: …" must not be cut at the word "True".
    const first = findOptionMarkers(line).filter(marker => !marker.display)[0];
    if (!first) return [line];
    const stemPrefix = line.slice(0, first.start).trimEnd();
    return stemPrefix ? [stemPrefix] : [];
  }).join('\n').trim();
}

function splitOptionTexts(options: Question['options'], sourceLines: SourceLine[]): { options?: Question['options']; failed: boolean } {
  if (!options || options.length === 0) return { options, failed: false };
  const text = sliceOptionUnion(options, sourceLines);
  const markers = findOptionMarkers(text);
  if (markers.length < 2) return { options, failed: false };
  if (markers.length !== options.length) return { options, failed: true };
  const segments = markers.map((marker, index) => {
    const next = markers[index + 1];
    const body = text.slice(marker.end, next ? next.start : text.length).trim();
    return marker.display && (!body || normalizeForMatching(body) === '/') ? marker.display : body;
  });
  const ordered = [...options].sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
  return {
    options: ordered.map((option, index) => ({ ...option, text: segments[index] })),
    failed: false,
  };
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
    const markers = findOptionMarkers(line);
    const number = parsePrintedNumberFromStem(line);
    // Keep the stem prefix of an option line when it is this question's printed line or an
    // un-numbered continuation (gap-completed "He ___ to school. a) go b) went" lines).
    if ((number === printedNo || number === undefined) && markers.length > 0 && line.slice(0, markers[0].start).trim()) {
      output.push(line.slice(0, markers[0].start).trimEnd());
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
  const questionOverlap = new Set<string>();
  const rewritePolicy = options.rewritePolicy || 'fenced';

  // B2 — gap completion + option synthesis (pure, 0 calls) before any slicing.
  let rawList: any[] = Array.isArray(rawQuestions) ? rawQuestions : [];
  const absorbedByKey = new Map<string, number[]>();
  const synthesizedByKey = new Map<string, number>();
  if (options.gapCompletion !== false && rawList.length) {
    const completed = completeGapsRaw(rawList, sourceLines, { keyLines: new Set(options.keyTerritoryLineNos || []), sections: options.sections });
    rawList = completed.raw;
    for (const [k, v] of completed.absorbed) absorbedByKey.set(k, v);
    for (const [k, v] of completed.synthesized) synthesizedByKey.set(k, v);
  }

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
    const split = splitOptionTexts(rawOptions, sourceLines);
    let assembledOptions = split.options || [];
    const optionSplitFailed = split.failed;
    if (optionSplitFailed) {
      flags.push(flag('OPTION_SPLIT_FAILED', `Question ${raw.label || qId}: option markers (${findOptionMarkers(sliceOptionUnion(rawOptions, sourceLines)).length}) did not match ${rawOptions.length} option spans; original option text retained.`, 'warn', qId));
    }
    // D — rewrite rights: fenced by default (garbled, number-free, non-key lines inside the question only).
    const lineById = new Map(sourceLines.map(line => [lineNoFromId(line.id), line]));
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
    const originalStem = sliceSourceSpans(spans, sourceLines, acceptedRewrites);
    const printedBeforeCleanup = parsePrintedNumberFromStem(originalStem) ?? originalNo;
    const stem = decontaminateStem(spans, rawOptions.flatMap((o: { spans: Array<[number, number]> }) => o.spans), sourceLines, printedBeforeCleanup, acceptedRewrites);
    if (!stem.trim()) errors.push('Assembled stem is empty');
    const gapKey = String(raw.id || `#${idx}`);
    if (absorbedByKey.has(gapKey)) flags.push(flag('GAP_ABSORBED', `Question ${raw.label || qId}: ${absorbedByKey.get(gapKey)!.length} unclaimed line(s) after the model's anchor were absorbed locally (${absorbedByKey.get(gapKey)!.slice(0, 6).map(n => `L${String(n).padStart(4, '0')}`).join(', ')}${absorbedByKey.get(gapKey)!.length > 6 ? ', …' : ''}).`, 'info', qId));
    if (synthesizedByKey.has(gapKey)) flags.push(flag('OPTIONS_SYNTHESIZED', `Question ${raw.label || qId}: ${synthesizedByKey.get(gapKey)} option(s) split locally from printed markers the model did not return.`, 'info', qId));

    // D3: printed source numbering is authoritative over a model's shifted label/no.
    const printedNo = parsePrintedNumberFromStem(stem) ?? parsePrintedNumberFromStem(originalStem);
    let no = originalNo;
    let label = String(raw.label || originalNo);
    const numberingCorrected = printedNo !== undefined && printedNo !== originalNo;
    if (printedNo !== undefined) {
      no = printedNo;
      if (numberingCorrected || normalizeForMatching(label).replace(/[.)\s]/g, '') !== String(printedNo)) {
        label = String(printedNo);
        if (numberingCorrected) flags.push(flag('NUMBERING_CORRECTED', `Question numbering corrected locally: ${originalNo} → ${printedNo}.`, 'info', qId));
      }
    }

    let answer: Question['answer'];
    if (raw.answer?.spans) {
      const answerSpans = normalizedSpans(raw.answer.spans); // answer spans may point into key territory
      const fullText = sliceSourceSpans(answerSpans, sourceLines);
      const segmented = splitGroupedAnswer(fullText, no);
      answer = { spans: answerSpans, text: segmented.text, source: 'paper' };
      if (segmented.unmatched) flags.push(flag('ANSWER_SEGMENT_UNMATCHED', `Question ${label}: grouped answer line did not contain printed number ${no}; full line retained for review.`, 'info', qId));
    }

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
    if (unknownImageRefs.length) questionFlags.push('IMAGE_REFERENCE_UNRESOLVED');
    if (overlaps) questionFlags.push('SPAN_OVERLAP');
    if (absorbedByKey.has(gapKey) && !questionFlags.includes('GAP_ABSORBED')) questionFlags.push('GAP_ABSORBED');
    if (acceptedRewrites.length && !questionFlags.includes('REWRITE_APPLIED')) questionFlags.push('REWRITE_APPLIED');
    if (confidence < 0.6 && !questionFlags.includes('LOW_CONFIDENCE')) questionFlags.push('LOW_CONFIDENCE');
    if (confidence < 0.6) flags.push(flag('LOW_CONFIDENCE', `Question ${label} confidence calibrated to ${(confidence * 100).toFixed(0)}%.`, 'info', qId));
    if (unknownImageRefs.length) flags.push(flag('IMAGE_REFERENCE_UNRESOLVED', `Question ${label} references unresolved image(s): ${unknownImageRefs.map((i: any) => i.imageId).join(', ')}.`, 'warn', qId));

    const question: Question = {
      id: qId,
      label,
      no,
      parentId: typeof raw.parentId === 'string' ? raw.parentId : undefined,
      sectionId: typeof raw.sectionId === 'string' ? raw.sectionId : undefined,
      spans,
      stem,
      points: typeof raw.points === 'number' ? raw.points : undefined,
      type: raw.type || 'unknown',
      options: assembledOptions.length ? assembledOptions : undefined,
      answer,
      rewrites: acceptedRewrites,
      images: questionImages,
      tables: assembledTables.length ? assembledTables : undefined,
      confidence,
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

  if (totalDeclaredPoints !== undefined && totalDeclaredPoints > 0) {
    const sum = questions.reduce((acc, question) => acc + (question.points || 0), 0);
    if (Math.abs(sum - totalDeclaredPoints) > 0.51) flags.push(flag('POINTS_MISMATCH', `Points sum (${sum}) does not match header total (${totalDeclaredPoints}); deficit ${Number((totalDeclaredPoints - sum).toFixed(2))}.`, 'warn'));
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
  questions: Question[],
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
    const passage = areaLines.map(line => line.text.trim()).filter(Boolean).join('\n').trim();
    const storedPassage = passage.split(/\r?\n/).length >= 2 || passage.length >= 120 ? passage : undefined;

    const pointHeader = headerLines.find(line => parseSectionPoints(line.text) !== undefined);
    const points = typeof section?.points === 'number' ? section.points : pointHeader ? parseSectionPoints(pointHeader.text) : undefined;
    const sectionQuestions = questions.filter(q => q.sectionId === id);
    const sectionSum = sectionQuestions.reduce((sum, q) => sum + (q.points || 0), 0);
    if (points !== undefined && Math.abs(points - sectionSum) > 0.51) flags.push(flag('SECTION_POINTS_MISMATCH', `Section ${indexValue} question points sum (${sectionSum}) differs from header points (${points}).`, 'info'));
    return { id, index: indexValue, title, instructions: trimmed.text || undefined, points, passage: storedPassage, spans };
  });
  return { sections: provisional, flags };
}

/** A1: Image ID uniqueness — reassign sequentially in (page, y, x) order, updating refs. */
export function reassignImageIdsSequential(doc: ExamDoc): ExamDoc {
  if (!doc.images || doc.images.length === 0) return doc;
  // Sort by page, y, x
  const sorted = [...doc.images].sort((a,b)=>{
    if (a.page !== b.page) return a.page - b.page;
    const ay = (a as any).y ?? a.bbox?.y ?? 0;
    const by = (b as any).y ?? b.bbox?.y ?? 0;
    if (ay !== by) return ay - by;
    const ax = a.bbox?.x ?? 0;
    const bx = b.bbox?.x ?? 0;
    return ax - bx;
  });
  const mapping = new Map<string,string>();
  sorted.forEach((img, idx)=>{
    const newId = `img_${String(idx+1).padStart(3,'0')}`;
    mapping.set(img.id, newId);
  });
  const newImages = doc.images.map(img=> ({ ...img, id: mapping.get(img.id) || img.id }));
  const newQuestions = doc.questions.map(q=> ({
    ...q,
    images: q.images.map(ref=> ({ ...ref, imageId: mapping.get(ref.imageId) || ref.imageId }))
  }));
  // Also need to update vision labels hints? But we handle via mapping
  // Update image labels where relevant? Keep as is but id changed
  const newDoc = { ...doc, images: newImages, questions: newQuestions };
  // Also update image.label.questionRef if it references old id? No, it references question id, not image id
  return newDoc;
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
  if (duplicates.length === 0) return { doc, fixed: false, duplicates: [] };

  const duplicateIds = new Set(duplicates);
  const reservedIds = new Set(doc.images.map(image => image.id));
  const nextOccurrenceById = new Map<string, number>();
  const allocatedIds = new Set<string>();
  const occurrencesByOriginalId = new Map<string, RenamedImageOccurrence[]>();

  const images = doc.images.map((image, index) => {
    const occurrence = (nextOccurrenceById.get(image.id) || 0) + 1;
    nextOccurrenceById.set(image.id, occurrence);
    let id = image.id;
    if (duplicateIds.has(image.id) && occurrence > 1) {
      let suffix = occurrence;
      id = `${image.id}_dup${suffix}`;
      while (reservedIds.has(id) || allocatedIds.has(id)) {
        suffix += 1;
        id = `${image.id}_dup${suffix}`;
      }
    }
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
      if (!duplicateIds.has(reference.imageId)) return reference;
      const occurrences = occurrencesByOriginalId.get(reference.imageId);
      if (!occurrences?.length) return reference;
      const image = chooseImageOccurrence(occurrences, question, reference.anchorLine, pageByLine);
      return { ...reference, imageId: image.image.id };
    }),
  }));

  const flags: Flag[] = [
    ...doc.flags,
    {
      id: `flag_image_duplicate_${duplicates.map(id => id.replace(/[^A-Za-z0-9_-]/g, '_')).join('_')}`,
      code: 'IMAGE_ID_DUPLICATE',
      severity: 'warn',
      message: `Duplicate imageId(s) detected: ${duplicates.join(', ')}. Renamed with page-aware question-reference updates.`,
    },
  ];

  return { doc: { ...doc, images, questions, flags }, fixed: true, duplicates };
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
