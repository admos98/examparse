/**
 * Deterministic, local-only assembly and integrity checks.
 * Models provide spans; this module is the single pure assembly funnel used by
 * fresh, cached, resumed, chunked, patched, and imported documents.
 */
import { z } from 'zod';
import { ExamSection, Flag, LineSpan, Question, SourceLine } from '../types';
import { normalizeDigits, parsePrintedNumberFromStem } from './quality';
import { buildQuestionTree } from '../utils/questionTree';

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

export function lineNoFromId(id: string): number {
  const n = Number(id.replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
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
  const lineMap = new Map(sourceLines.map(line => [lineNoFromId(line.id), line]));
  const rewriteMap = new Map<number, string>((rewrites || []).map(rewrite => [rewrite.line, rewrite.text]));
  const output: string[] = [];
  for (const lineNo of spanLineNumbers(spans)) {
    const line = lineMap.get(lineNo);
    if (rewriteMap.has(lineNo)) output.push(rewriteMap.get(lineNo)!);
    else if (line) output.push(line.text.replace(/^\[L\d+\]\s*/, ''));
  }
  return output.join('\n');
}

function sliceOptionUnion(options: any[], sourceLines: SourceLine[]): string {
  const allSpans = options.flatMap(option => normalizedSpans(option?.spans));
  return sliceSourceSpans(allSpans, sourceLines);
}

type Marker = { start: number; end: number; key: string };
const LATIN = 'a-h';
const PERSIAN_MARKERS = 'الف|ب|پ|ت|ث|ج|چ|ح|خ|د|ذ|ر|ز|ژ|س|ش|ص|ض|ط|ظ|ع|غ|ف|ق|ک|گ|ل|م|ن|و|ه|ی';
const OPTION_MARKER = new RegExp(`(^|\\s)(?:\\(([${LATIN}])\\)|([${LATIN}])[).:]|\\((${PERSIAN_MARKERS})\\)|(${PERSIAN_MARKERS})[).:])(?=\\s|$)`, 'gim');

function findOptionMarkers(text: string): Marker[] {
  const found: Marker[] = [];
  OPTION_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPTION_MARKER.exec(text))) {
    const markerStart = match.index + (match[1] || '').length;
    const key = (match[2] || match[3] || match[4] || match[5] || '').toLowerCase();
    found.push({ start: markerStart, end: OPTION_MARKER.lastIndex, key });
  }
  return found;
}

/** Remove only text following explicit option markers; never delete ordinary stem words that match an option. */
export function decontaminateOptionMarkup(text: string): string {
  return text.split(/\r?\n/).flatMap(line => {
    const first = findOptionMarkers(line)[0];
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
    return text.slice(marker.end, next ? next.start : text.length).trim();
  });
  const ordered = [...options].sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
  return {
    options: ordered.map((option, index) => ({ ...option, text: segments[index] })),
    failed: false,
  };
}

function lineTextMap(sourceLines: SourceLine[]): Map<number, string> {
  return new Map(sourceLines.map(line => [lineNoFromId(line.id), line.text.replace(/^\[L\d+\]\s*/, '')]));
}

function decontaminateStem(
  stemSpans: LineSpan[],
  optionSpans: LineSpan[],
  sourceLines: SourceLine[],
  printedNo: number
): string {
  const consumed = new Set(spanLineNumbers(optionSpans));
  const textMap = lineTextMap(sourceLines);
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
    if (number === printedNo && markers.length > 0 && line.slice(0, markers[0].start).trim()) {
      output.push(line.slice(0, markers[0].start).trimEnd());
    }
  }
  return decontaminateOptionMarkup(output.join('\n'));
}

function splitGroupedAnswer(text: string, questionNo: number): { text: string; unmatched: boolean } {
  const normalized = normalizeDigits(text);
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
  return { text: normalized.slice(selected.bodyStart, next ? next.start : normalized.length).trim(), unmatched: false };
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
  const questions: Question[] = [];
  const flags: Flag[] = [];
  const failingQuestions: { question: Question; errors: string[] }[] = [];
  const lineIds = sourceLines.map(l => lineNoFromId(l.id)).filter(n => n > 0);
  const minLineId = lineIds.length ? lineIds.reduce((minimum, n) => Math.min(minimum, n), Infinity) : 1;
  const maxLineId = lineIds.length ? lineIds.reduce((maximum, n) => Math.max(maximum, n), 0) : sourceLines.length;
  const keyLines = options.keyTerritoryLineNos instanceof Set ? options.keyTerritoryLineNos : new Set(options.keyTerritoryLineNos || []);
  const allImageIds = options.imageIds ? new Set(options.imageIds) : null;
  const questionOverlap = new Set<string>();

  (Array.isArray(rawQuestions) ? rawQuestions : []).forEach((rawInput, idx) => {
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
    const originalStem = sliceSourceSpans(spans, sourceLines, raw.rewrites);
    const printedBeforeCleanup = parsePrintedNumberFromStem(originalStem) ?? originalNo;
    const stem = decontaminateStem(spans, rawOptions.flatMap((o: { spans: Array<[number, number]> }) => o.spans), sourceLines, printedBeforeCleanup);
    if (!stem.trim()) errors.push('Assembled stem is empty');

    // D3: printed source numbering is authoritative over a model's shifted label/no.
    const printedNo = parsePrintedNumberFromStem(stem) ?? parsePrintedNumberFromStem(originalStem);
    let no = originalNo;
    let label = String(raw.label || originalNo);
    const numberingCorrected = printedNo !== undefined && printedNo !== originalNo;
    if (printedNo !== undefined) {
      no = printedNo;
      if (numberingCorrected || normalizeDigits(label).replace(/[.)\s]/g, '') !== String(printedNo)) {
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
    if (overlaps) confidence -= 0.2;
    if (unknownImageRefs.length) confidence -= 0.2;
    if ((raw.type || 'unknown') !== 'fillblank' && stem.trim().length < 8) confidence -= 0.3;
    confidence = Math.max(0.05, Math.min(0.98, confidence));
    const questionFlags = [...(Array.isArray(raw.flags) ? raw.flags.map(String) : [])];
    if (optionSplitFailed && !questionFlags.includes('OPTION_SPLIT_FAILED')) questionFlags.push('OPTION_SPLIT_FAILED');
    if (unknownImageRefs.length) questionFlags.push('IMAGE_REFERENCE_UNRESOLVED');
    if (overlaps) questionFlags.push('SPAN_OVERLAP');
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
      rewrites: Array.isArray(raw.rewrites) ? raw.rewrites : [],
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

  if (totalDeclaredPoints !== undefined && totalDeclaredPoints > 0) {
    const sum = questions.reduce((acc, question) => acc + (question.points || 0), 0);
    if (Math.abs(sum - totalDeclaredPoints) > 0.51) flags.push(flag('POINTS_MISMATCH', `Points sum (${sum}) does not match header total (${totalDeclaredPoints}); deficit ${Number((totalDeclaredPoints - sum).toFixed(2))}.`, 'warn'));
  }
  const sortedNos = questions.filter(q => !q.parentId).map(q => q.no).sort((a, b) => a - b);
  for (let i = 0; i < sortedNos.length - 1; i++) if (sortedNos[i + 1] - sortedNos[i] > 1) flags.push(flag('NUMBERING_GAP', `Question numbering gap between #${sortedNos[i]} and #${sortedNos[i + 1]}.`, 'info'));
  return { questions, flags, failingQuestions };
}

function cleanSectionTitle(value: string | undefined): string {
  return (value || '').trim()
    .replace(/^\s*\d{1,3}\s*[.)-]?\s+/, '')
    .replace(/\s+\d{1,3}\s*$/, '')
    .replace(/[|¦\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[–—-]\s*(?:ردیف|نمره|points?|marks?).*$/i, '')
    .trim();
}

function parseSectionPoints(text: string): number | undefined {
  const normalized = normalizeDigits(text);
  const match = normalized.match(/(?:\(\s*(\d+(?:\.\d+)?)\s*(?:points?|marks?|نمره)\s*\)|(?:نمره|points?|marks?)\s*[:：]?\s*(\d+(?:\.\d+)?))/i);
  const n = Number(match?.[1] || match?.[2]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isHeaderOrRowLine(text: string): boolean {
  const value = text.trim();
  return !value || /^(?:section|part|unit)\s+\d+\b/i.test(value) ||
    /^\d{1,3}\s+(?:listening|vocabulary|grammar|reading|writing)\b/i.test(value) ||
    /(?:ردیف|نمره|points?|marks?)/i.test(value) && value.length < 100 ||
    /\t| {3,}/.test(value) || /^\d{1,3}\s*[|│]/.test(value);
}

function isInstructionLine(text: string): boolean {
  return /^(?:instructions?\b|directions?\b|read\b|choose\b|select\b|listen\b|complete\b|answer\b|fill\b|match\b|write\b|دستورالعمل|به سوالات|به پرسش|گزینه)/i.test(text.trim());
}

function trimInstructions(instructions: string, title: string, allSectionTitles: string[]): { text: string; long: boolean } {
  const lines = instructions.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const clean = line.trim();
    if (kept.length > 0 && (/^\s*\d{1,3}\s*$/.test(clean) || allSectionTitles.some(t => t && t.toLowerCase() !== title.toLowerCase() && clean.toLowerCase().includes(t.toLowerCase())))) break;
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
    const sectionLines = sourceLines.filter(line => spans.some(([start, end]) => lineNoFromId(line.id) >= start && lineNoFromId(line.id) <= end));
    const headerLines = sectionLines.slice(0, 12);
    const titleRaw = typeof section?.title === 'string' ? section.title : (typeof section?.kind === 'string' ? section.kind : '');
    let title = cleanSectionTitle(titleRaw);
    if (!title || /^\d+$/.test(normalizeDigits(title))) {
      const derived = headerLines.find(line => !isHeaderOrRowLine(line.text) && !/^[\s\d.():-]+$/.test(line.text));
      title = derived ? cleanSectionTitle(derived.text) : `Section ${indexValue}`;
      flags.push(flag('SECTION_TITLE_DERIVED', `Section ${indexValue} title was derived locally as “${title}”.`, 'info'));
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
