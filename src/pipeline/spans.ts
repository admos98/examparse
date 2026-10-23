import { LineSpan, OffsetSpan, SourceLine } from '../types';
import { exciseWatermarks, lineNumber, matchingView, normalizeStoredText } from './quality';

/** Patterns matching inline institutional watermarks / running furniture at identical char length. */
const INLINE_WATERMARK_MASK_PATTERNS: RegExp[] = [
  /مرکز\s+سنجش\s+و\s+پایش\s+کیفیت\s+[آا]موزش[یى]/gu,
  /[«»"()]?\s*ادامه(?:\s*ی)?\s+(?:س[وؤ]الات\s+)?در\s+صفحه(?:\s*ی)?\s+\S+(?:\s+\S+)?\s*[«»"()]?/gu,
  /\bwww[\.-][a-z0-9-]+[\.-]ir\b/giu,
  /https?:\/\/\S*medu\.ir\S*/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
];

export interface InlineOptionMarker {
  rawKey: string;
  key: string;
  start: number;
  end: number;
  punct: string;
}

export function isOffsetSpan(span: unknown): span is OffsetSpan {
  return Boolean(
    span &&
    typeof span === 'object' &&
    !Array.isArray(span) &&
    Number.isInteger((span as OffsetSpan).line) &&
    (span as OffsetSpan).line >= 1,
  );
}

export function spanStartLine(span: LineSpan): number {
  return isOffsetSpan(span) ? span.line : span[0];
}

export function spanEndLine(span: LineSpan): number {
  return isOffsetSpan(span) ? span.line : span[1];
}

export function spanHasOffsets(span: LineSpan): span is OffsetSpan {
  return isOffsetSpan(span) && (span.start !== undefined || span.end !== undefined);
}

export function spanContainsLine(span: LineSpan, n: number): boolean {
  if (isOffsetSpan(span)) return span.line === n;
  return n >= span[0] && n <= span[1];
}

export function spansContainLine(spans: LineSpan[] | undefined, n: number): boolean {
  return (spans || []).some(span => spanContainsLine(span, n));
}

export function spanBounds(spans: LineSpan[] | undefined): [number, number] | null {
  if (!spans || spans.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const span of spans) {
    const s = spanStartLine(span);
    const e = spanEndLine(span);
    if (Number.isFinite(s)) min = Math.min(min, s);
    if (Number.isFinite(e)) max = Math.max(max, e);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null;
}

export function formatSpan(span: LineSpan): string {
  if (isOffsetSpan(span)) {
    if (span.start !== undefined || span.end !== undefined) {
      return `L${span.line}[${span.start ?? 0}..${span.end ?? ''}]`;
    }
    return `L${span.line}..L${span.line}`;
  }
  return `L${span[0]}..L${span[1]}`;
}

export function formatSpans(spans: LineSpan[] | undefined): string {
  return (spans || []).map(formatSpan).join(', ');
}

export function coerceLineSpan(raw: unknown): LineSpan | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const a = Number(raw[0]);
    const b = Number(raw[1]);
    if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a) {
      return [a, b];
    }
    return null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const line = Number(obj.line);
    if (!Number.isInteger(line) || line < 1) return null;
    const hasStart = obj.start !== undefined && obj.start !== null;
    const hasEnd = obj.end !== undefined && obj.end !== null;
    const start = hasStart ? Number(obj.start) : undefined;
    const end = hasEnd ? Number(obj.end) : undefined;
    if (start !== undefined && (!Number.isInteger(start) || start < 0)) return null;
    if (end !== undefined && (!Number.isInteger(end) || end < 0)) return null;
    if (start !== undefined && end !== undefined && end < start) return null;
    const out: OffsetSpan = { line };
    if (start !== undefined) out.start = start;
    if (end !== undefined) out.end = end;
    return out;
  }
  return null;
}

export function spanLineNumbers(spans: LineSpan[] | undefined): number[] {
  const out = new Set<number>();
  for (const span of spans || []) {
    if (isOffsetSpan(span)) {
      if (Number.isInteger(span.line) && span.line >= 1) out.add(span.line);
      continue;
    }
    if (!Array.isArray(span) || span.length < 2) continue;
    const [start, end] = span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || start < 1) continue;
    for (let n = start; n <= end; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function compressLineNumbers(numbers: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(numbers)].filter(n => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/**
 * Filter spans against a line predicate while preserving OffsetSpan `{ line, start, end }`
 * entries intact rather than flattening them back into whole-line `[line, line]` tuples.
 */
export function filterSpansByLines(
  spans: LineSpan[] | undefined,
  allowed: (lineNo: number) => boolean,
): LineSpan[] {
  const out: LineSpan[] = [];
  for (const raw of spans || []) {
    const span = coerceLineSpan(raw);
    if (!span) continue;
    if (isOffsetSpan(span)) {
      if (allowed(span.line)) {
        const copy: OffsetSpan = { line: span.line };
        if (span.start !== undefined) copy.start = span.start;
        if (span.end !== undefined) copy.end = span.end;
        out.push(copy);
      }
      continue;
    }
    const [start, end] = span;
    let runStart: number | null = null;
    for (let n = start; n <= end; n++) {
      if (allowed(n)) {
        if (runStart === null) runStart = n;
      } else if (runStart !== null) {
        out.push([runStart, n - 1]);
        runStart = null;
      }
    }
    if (runStart !== null) out.push([runStart, end]);
  }
  return out;
}

export function clipSpansBeforeLine(
  spans: unknown,
  minLine: number,
  maxLine: number,
  stopBeforeLine = Infinity,
): LineSpan[] {
  if (!Array.isArray(spans)) return [];
  const out: LineSpan[] = [];
  for (const raw of spans) {
    const span = coerceLineSpan(raw);
    if (!span) continue;
    if (isOffsetSpan(span)) {
      if (span.line >= minLine && span.line <= maxLine && span.line < stopBeforeLine) {
        out.push({ ...span });
      }
      continue;
    }
    const start = Math.max(minLine, span[0]);
    const end = Math.min(maxLine, stopBeforeLine - 1, span[1]);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
      out.push([start, end]);
    }
  }
  return out;
}

/**
 * Replaces inline watermarks with equal-length spaces so regex character indices on the
 * masked string map 1-to-1 to raw `line.text` character offsets (preserving byte-invariance).
 */
const MASK_WATERMARK_FAST_RE = /مرکز|kanoon|medu|https?:|ادامه|گاج|خیلی|صفحه|[\uFB50-\uFDFF\uFE70-\uFEFF]/i;

export function maskWatermarksSameLength(rawLine: string): string {
  if (!MASK_WATERMARK_FAST_RE.test(rawLine)) return rawLine;
  let masked = rawLine;
  if (/[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(masked)) {
    const view = matchingView(masked);
    if (/مرکز|kanoon|medu|https?:|ادامه|گاج|خیلی|صفحه/i.test(view.text)) {
      const chars = masked.split('');
      for (const pattern of INLINE_WATERMARK_MASK_PATTERNS) {
        const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
        const copy = new RegExp(pattern.source, flags);
        for (const m of view.text.matchAll(copy)) {
          if (m.index === undefined) continue;
          const s = view.originalOffset(m.index);
          const e = view.originalOffset(m.index + m[0].length);
          for (let i = s; i < e && i < chars.length; i++) chars[i] = ' ';
        }
      }
      masked = chars.join('');
    }
  }
  for (const pattern of INLINE_WATERMARK_MASK_PATTERNS) {
    masked = masked.replace(pattern, m => ' '.repeat(m.length));
  }
  return masked;
}

/**
 * Single offset-aware line slicer: slices `[start, end)` on `rawLineText` directly
 * (preserving byte-exact source characters when no watermark is excised),
 * then excises any inline watermarks inside that slice.
 */
export function sliceNormalizedLineByOffsets(
  rawLineText: string,
  start?: number,
  end?: number,
): { text: string; removedWatermark: number } {
  const s = start !== undefined ? Math.max(0, Math.min(rawLineText.length, start)) : 0;
  const e = end !== undefined ? Math.max(s, Math.min(rawLineText.length, end)) : rawLineText.length;
  const rawSlice = rawLineText.slice(s, e);
  const excised = exciseWatermarks(rawSlice);
  return {
    text: excised.excised ? excised.text : rawSlice,
    removedWatermark: excised.count,
  };
}

const SOURCE_LINE_MAP_CACHE = new WeakMap<readonly SourceLine[], Map<number, SourceLine>>();

export function buildSourceLineMap(sourceLines: SourceLine[]): Map<number, SourceLine> {
  const cached = SOURCE_LINE_MAP_CACHE.get(sourceLines);
  if (cached) return cached;
  const lineMap = new Map<number, SourceLine>();
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i];
    lineMap.set(lineNumber(line) || (i + 1), line);
  }
  SOURCE_LINE_MAP_CACHE.set(sourceLines, lineMap);
  return lineMap;
}

/**
 * Unified offset-aware source span slicer (Part B1).
 * Watermark excision, inline option carving, multi-number sub-items, group children,
 * and grouped answer slicing all flow through this single function.
 */
export function sliceSourceSpansWithMeta(
  spans: LineSpan[] | undefined,
  sourceLines: SourceLine[],
  opts?: { skipLine?: (line: SourceLine, lineNo: number) => boolean },
): { text: string; removedWatermarks: number; lineTexts: string[] } {
  if (!spans || spans.length === 0) return { text: '', removedWatermarks: 0, lineTexts: [] };
  const lineMap = buildSourceLineMap(sourceLines);
  const seenSlices = new Set<string>();
  const lineTexts: string[] = [];
  let removedWatermarks = 0;

  for (const raw of spans) {
    const span = coerceLineSpan(raw);
    if (!span) continue;
    if (isOffsetSpan(span)) {
      const key = `${span.line}:${span.start ?? ''}:${span.end ?? ''}`;
      if (seenSlices.has(key)) continue;
      seenSlices.add(key);
      const line = lineMap.get(span.line);
      if (!line) continue;
      if (opts?.skipLine?.(line, span.line)) continue;
      const sliced = sliceNormalizedLineByOffsets(line.text, span.start, span.end);
      removedWatermarks += sliced.removedWatermark;
      if (sliced.text.length > 0) lineTexts.push(sliced.text);
      continue;
    }

    const [start, end] = span;
    for (let n = start; n <= end; n++) {
      const key = `${n}::`;
      if (seenSlices.has(key)) continue;
      seenSlices.add(key);
      const line = lineMap.get(n);
      if (!line) continue;
      if (opts?.skipLine?.(line, n)) continue;
      const sliced = sliceNormalizedLineByOffsets(line.text);
      removedWatermarks += sliced.removedWatermark;
      if (sliced.text.length > 0) lineTexts.push(sliced.text);
    }
  }

  return {
    text: lineTexts.join('\n').trim(),
    removedWatermarks,
    lineTexts,
  };
}

export function sliceSourceSpans(spans: LineSpan[] | undefined, sourceLines: SourceLine[]): string {
  return sliceSourceSpansWithMeta(spans, sourceLines).text;
}

const PERSIAN_OPTION_KEY_MAP: Record<string, string> = {
  'الف': 'a',
  'ب': 'b',
  'ج': 'c',
  'د': 'd',
  'ه': 'e',
  'هـ': 'e',
  '1': 'a',
  '2': 'b',
  '3': 'c',
  '4': 'd',
  '۱': 'a',
  '۲': 'b',
  '۳': 'c',
  '۴': 'd',
};

export function canonicalOptionKey(raw: string): string {
  const clean = normalizeStoredText(raw).replace(/[()[\].:\-–—\s]/g, '');
  if (PERSIAN_OPTION_KEY_MAP[clean]) return PERSIAN_OPTION_KEY_MAP[clean];
  return clean.toLowerCase() || 'a';
}

/**
 * Finds inline option markers in `rawLineText` via `matchingView(masked)` so fullwidth/Persian/Arabic
 * variants are recognized while returned `{ start, end }` are exact character offsets in `rawLineText`.
 */
export function findInlineOptionMarkers(rawLineText: string): InlineOptionMarker[] {
  const masked = maskWatermarksSameLength(rawLineText);
  const view = matchingView(masked);
  const markers: InlineOptionMarker[] = [];

  // Match inline or line-leading markers on `view.text` (lowercased/normalized) and map back to `rawLineText`.
  const re = /(?:^|[\s؛;،,/|])(?:\(([a-j1-4]|الف|ب|ج|د|ه)\)|([a-j1-4]|الف|ب|ج|د|ه)([):])|([a-j]|الف|ب|ج|د|ه)(\.))(?=\s|\p{L}|\p{N}|["'«(])/gu;
  for (const match of view.text.matchAll(re)) {
    const normKey = match[1] || match[2] || match[4] || '';
    const punct = match[1] ? '()' : (match[3] || match[5] || ')');
    if (!normKey) continue;
    const full = match[0];
    const leadTrim = full.match(/^[\s؛;،,/|]+/)?.[0].length ?? 0;
    const viewStart = (match.index ?? 0) + leadTrim;
    const viewEnd = (match.index ?? 0) + full.length;
    const start = view.originalOffset(viewStart);
    const end = view.originalOffset(viewEnd);
    const rawSliceKey = masked.slice(start, end).replace(/[()[\].:\-–—\s]/g, '');
    markers.push({
      rawKey: rawSliceKey || normKey,
      key: canonicalOptionKey(normKey),
      start,
      end,
      punct,
    });
  }

  // Also catch line-leading `f . ` with space before dot (e.g. `f . When you get money...`).
  const leadingSpacedDot = view.text.match(/^\s*([a-j])\s+(\.)(?=\s+\S)/u);
  if (leadingSpacedDot && markers.length === 0) {
    const normKey = leadingSpacedDot[1];
    const leadWs = leadingSpacedDot[0].match(/^\s*/)?.[0].length ?? 0;
    const start = view.originalOffset(leadWs);
    const end = view.originalOffset(leadingSpacedDot[0].length);
    markers.push({
      rawKey: masked.slice(start, end).replace(/[()[\].:\-–—\s]/g, '') || normKey,
      key: canonicalOptionKey(normKey),
      start,
      end,
      punct: '.',
    });
  }

  // Guard: 2-turn uppercase speaker dialogue (`A: ... B: ...` with colons, no C:) is dialogue, NOT MCQ options.
  if (
    markers.length === 2 &&
    markers[0].rawKey === 'A' &&
    markers[1].rawKey === 'B' &&
    markers[0].punct === ':' &&
    markers[1].punct === ':'
  ) {
    const aBody = masked.slice(markers[0].end, markers[1].start).trim();
    const bBody = masked.slice(markers[1].end).trim();
    const isTf = /^(?:true|false|درست|نادرست|صحیح|غلط)$/i.test(aBody) && /^(?:true|false|درست|نادرست|صحیح|غلط)$/i.test(bBody);
    if (!isTf) return [];
  }

  return markers;
}

const OPTION_ALPHABET = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

export function selectOrderedOptionMarkers(
  markers: InlineOptionMarker[],
  opts?: { allowMidAlphabetStart?: boolean },
): InlineOptionMarker[] {
  if (markers.length < 2) return [];
  let best: InlineOptionMarker[] = [];

  for (let i = 0; i < markers.length; i++) {
    const startIdx = OPTION_ALPHABET.indexOf(markers[i].key);
    if (startIdx < 0) continue;
    if (startIdx > 0 && !opts?.allowMidAlphabetStart) continue;

    const seq: InlineOptionMarker[] = [markers[i]];
    let wantIdx = startIdx + 1;
    for (let j = i + 1; j < markers.length && wantIdx < OPTION_ALPHABET.length; j++) {
      if (markers[j].key === OPTION_ALPHABET[wantIdx]) {
        seq.push(markers[j]);
        wantIdx++;
      }
    }
    const minLen = startIdx === 0 ? 2 : 3;
    if (seq.length >= minLen && seq.length > best.length) {
      best = seq;
    }
  }
  return best;
}

/** Trim leading/trailing whitespace by advancing `start` and retreating `end` on `norm`. */
export function trimOffsetsOnLine(norm: string, start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, Math.min(norm.length, start));
  let e = Math.max(s, Math.min(norm.length, end));
  while (s < e && /\s/u.test(norm[s])) s++;
  while (e > s && /\s/u.test(norm[e - 1])) e--;
  return { start: s, end: e };
}

export interface CarvedInlineLineResult {
  stemPrefixSpan?: OffsetSpan;
  optionSpans: Array<{ key: string; span: OffsetSpan }>;
}

/**
 * Carves a single source line containing >= 2 ordered inline option markers (or binary slash TF pairs)
 * into an optional pre-marker stem `OffsetSpan` plus disjoint option `OffsetSpan`s (Part B2a).
 */
export function carveInlineOptionsOnLine(
  lineNo: number,
  rawLineText: string,
  opts?: { allowMidAlphabetStart?: boolean },
): CarvedInlineLineResult | null {
  const masked = maskWatermarksSameLength(rawLineText);
  const ordered = selectOrderedOptionMarkers(findInlineOptionMarkers(rawLineText), opts);
  if (ordered.length >= 2) {
    const optionSpans: Array<{ key: string; span: OffsetSpan }> = [];
    for (let i = 0; i < ordered.length; i++) {
      const cur = ordered[i];
      const nextStart = ordered[i + 1] ? ordered[i + 1].start : rawLineText.length;
      const trimmed = trimOffsetsOnLine(masked, cur.end, nextStart);
      if (trimmed.end <= trimmed.start) return null;
      optionSpans.push({
        key: cur.key,
        span: { line: lineNo, start: trimmed.start, end: trimmed.end },
      });
    }

    let stemPrefixSpan: OffsetSpan | undefined;
    const prefixTrim = trimOffsetsOnLine(masked, 0, ordered[0].start);
    if (prefixTrim.end > prefixTrim.start) {
      stemPrefixSpan = { line: lineNo, start: prefixTrim.start, end: prefixTrim.end };
    }

    return { stemPrefixSpan, optionSpans };
  }

  // Binary True/False or درست/نادرست slash pair on a shared line (`True / False`, `درست/نادرست`, `... (True / False)`).
  const tfSlashRe = /(?:^|[\s(])((?:true|false|درست|نادرست|صحیح|غلط))\s*[/|]\s*((?:true|false|درست|نادرست|صحیح|غلط))(?:\s*\))?\s*$/iu;
  const tfMatch = masked.match(tfSlashRe);
  if (tfMatch && tfMatch.index !== undefined) {
    const fullStart = tfMatch.index + (tfMatch[0].match(/^[\s(]*/)?.[0].length ?? 0);
    const firstWord = tfMatch[1];
    const secondWord = tfMatch[2];
    const firstIdx = masked.indexOf(firstWord, fullStart);
    const secondIdx = masked.indexOf(secondWord, firstIdx + firstWord.length);
    if (firstIdx >= 0 && secondIdx > firstIdx && firstWord.toLowerCase() !== secondWord.toLowerCase()) {
      const prefixEnd = masked[tfMatch.index] === '(' ? tfMatch.index : fullStart;
      const prefixTrim = trimOffsetsOnLine(masked, 0, prefixEnd);
      return {
        stemPrefixSpan: prefixTrim.end > prefixTrim.start ? { line: lineNo, start: prefixTrim.start, end: prefixTrim.end } : undefined,
        optionSpans: [
          { key: 'a', span: { line: lineNo, start: firstIdx, end: firstIdx + firstWord.length } },
          { key: 'b', span: { line: lineNo, start: secondIdx, end: secondIdx + secondWord.length } },
        ],
      };
    }
  }

  return null;
}

/**
 * Carves inline or multi-line option blocks across a list of candidate lines into
 * disjoint per-option `LineSpan[]` (using `OffsetSpan` whenever >=2 markers share a line,
 * or stripping leading `a)` marker via `OffsetSpan` on single-option lines).
 */
export function carveOptionsAcrossLines(
  lines: Array<{ lineNo: number; text: string }>,
  opts?: { allowMidAlphabetStart?: boolean },
): {
  stemSpans: LineSpan[];
  options: Array<{ key: string; spans: LineSpan[] }>;
} | null {
  type Anchor = {
    key: string;
    lineIdx: number;
    lineNo: number;
    rawLen: number;
    rawText: string;
    masked: string;
    markerStart: number;
    bodyStart: number;
  };

  const allAnchors: Anchor[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const { lineNo, text } = lines[idx];
    const masked = maskWatermarksSameLength(text);
    const markers = findInlineOptionMarkers(text);
    for (const m of markers) {
      allAnchors.push({
        key: m.key,
        lineIdx: idx,
        lineNo,
        rawLen: text.length,
        rawText: text,
        masked,
        markerStart: m.start,
        bodyStart: m.end,
      });
    }
  }

  if (allAnchors.length < 2) {
    // Fallback for binary True/False or درست/نادرست slash pair on one of the candidate lines.
    for (let idx = lines.length - 1; idx >= 0; idx--) {
      const inline = carveInlineOptionsOnLine(lines[idx].lineNo, lines[idx].text, opts);
      if (inline && inline.optionSpans.length === 2) {
        const stemSpans: LineSpan[] = [];
        for (let pre = 0; pre < idx; pre++) {
          const ln = lines[pre].lineNo;
          const prev = stemSpans[stemSpans.length - 1];
          if (prev && !isOffsetSpan(prev) && prev[1] + 1 === ln) prev[1] = ln;
          else stemSpans.push([ln, ln]);
        }
        if (inline.stemPrefixSpan) stemSpans.push(inline.stemPrefixSpan);
        return {
          stemSpans,
          options: inline.optionSpans.map(o => ({ key: o.key, spans: [o.span] })),
        };
      }
    }
    return null;
  }

  // Select ordered sequence across all candidate lines (e.g. a, b on line 1 + c, d on line 2).
  let chosen: Anchor[] = [];
  for (let i = 0; i < allAnchors.length; i++) {
    const startIdx = OPTION_ALPHABET.indexOf(allAnchors[i].key);
    if (startIdx < 0) continue;
    if (startIdx > 0 && !opts?.allowMidAlphabetStart) continue;
    const seq: Anchor[] = [allAnchors[i]];
    let wantIdx = startIdx + 1;
    for (let j = i + 1; j < allAnchors.length && wantIdx < OPTION_ALPHABET.length; j++) {
      if (allAnchors[j].key === OPTION_ALPHABET[wantIdx]) {
        seq.push(allAnchors[j]);
        wantIdx++;
      }
    }
    const minLen = startIdx === 0 ? 2 : 3;
    if (seq.length >= minLen && seq.length > chosen.length) {
      chosen = seq;
    }
  }

  if (chosen.length < 2) return null;

  // Guard against 2-turn speaker dialogue across two lines (`A: ...\nB: ...`).
  if (
    chosen.length === 2 &&
    chosen[0].lineIdx !== chosen[1].lineIdx &&
    /^\s*A\s*:/u.test(chosen[0].rawText) &&
    /^\s*B\s*:/u.test(chosen[1].rawText)
  ) {
    return null;
  }

  // Stem spans = all lines before `chosen[0].lineIdx` + any prefix before `chosen[0].markerStart`.
  const stemSpans: LineSpan[] = [];
  for (let idx = 0; idx < chosen[0].lineIdx; idx++) {
    const ln = lines[idx].lineNo;
    const prev = stemSpans[stemSpans.length - 1];
    if (prev && !isOffsetSpan(prev) && prev[1] + 1 === ln) prev[1] = ln;
    else stemSpans.push([ln, ln]);
  }
  const firstPrefix = trimOffsetsOnLine(chosen[0].masked, 0, chosen[0].markerStart);
  if (firstPrefix.end > firstPrefix.start) {
    stemSpans.push({ line: chosen[0].lineNo, start: firstPrefix.start, end: firstPrefix.end });
  }

  const options: Array<{ key: string; spans: LineSpan[] }> = [];
  for (let i = 0; i < chosen.length; i++) {
    const cur = chosen[i];
    const next = chosen[i + 1];
    const spans: LineSpan[] = [];

    if (next && next.lineIdx === cur.lineIdx) {
      const seg = trimOffsetsOnLine(cur.masked, cur.bodyStart, next.markerStart);
      if (seg.end <= seg.start) return null;
      spans.push({ line: cur.lineNo, start: seg.start, end: seg.end });
    } else {
      const firstSeg = trimOffsetsOnLine(cur.masked, cur.bodyStart, cur.rawLen);
      if (firstSeg.end > firstSeg.start) {
        spans.push({ line: cur.lineNo, start: firstSeg.start, end: firstSeg.end });
      }
      const endLineIdx = next ? next.lineIdx : lines.length;
      for (let li = cur.lineIdx + 1; li < endLineIdx; li++) {
        const ln = lines[li].lineNo;
        spans.push([ln, ln]);
      }
      if (next && next.lineIdx > cur.lineIdx) {
        const leadOnNext = trimOffsetsOnLine(next.masked, 0, next.markerStart);
        if (leadOnNext.end > leadOnNext.start) {
          spans.push({ line: next.lineNo, start: leadOnNext.start, end: leadOnNext.end });
        }
      }
      if (spans.length === 0) return null;
    }

    options.push({ key: cur.key, spans });
  }

  return { stemSpans, options };
}

/**
 * Carves shared-line group/matching child markers (e.g. `(15)  (16)  (17)  (18)` or `16. ... 17. ...`)
 * into disjoint per-child `OffsetSpan`s so sibling children can never share identical stems (Part B2c).
 */
export function carveGroupChildSpans(
  groupLines: Array<{ lineNo: number; text: string }>,
  parentNo: number,
  childNos: number[],
): Map<number, OffsetSpan> {
  const result = new Map<number, OffsetSpan>();
  const validNos = new Set<number>([parentNo, ...childNos.filter(n => n !== parentNo)]);
  const childSet = new Set<number>(childNos.filter(n => n !== parentNo));
  if (childSet.size === 0) return result;

  for (const { lineNo, text } of groupLines) {
    const masked = maskWatermarksSameLength(text);
    const view = matchingView(masked);
    const markers: Array<{ no: number; start: number; end: number }> = [];
    const re = /\((\d{1,3})\)|(?:^|\s)(\d{1,3})\s*[.)-](?=\s|\p{L}|\p{N}|$)/gu;
    for (const m of view.text.matchAll(re)) {
      const rawDigits = m[1] || m[2] || '';
      const no = Number(rawDigits);
      if (!validNos.has(no)) continue;
      const leadWs = m[0].match(/^\s+/)?.[0].length ?? 0;
      markers.push({
        no,
        start: view.originalOffset((m.index ?? 0) + leadWs),
        end: view.originalOffset((m.index ?? 0) + m[0].length),
      });
    }
    if (markers.length === 0) continue;

    for (let i = 0; i < markers.length; i++) {
      const cur = markers[i];
      if (!childSet.has(cur.no) || result.has(cur.no)) continue;
      const nextStart = markers[i + 1] ? markers[i + 1].start : text.length;
      const trimmed = trimOffsetsOnLine(masked, cur.start, nextStart);
      if (trimmed.end > trimmed.start) {
        result.set(cur.no, { line: lineNo, start: trimmed.start, end: trimmed.end });
      }
    }
  }

  return result;
}

/**
 * Carves a grouped answer-key line (e.g. `1. (a)  2. (c)  3. (c)` or `51- c  55- j`)
 * into the exact `OffsetSpan` belonging to `questionNo` (Part B1/B2).
 */
export function carveGroupedAnswerSpans(
  spans: LineSpan[],
  sourceLines: SourceLine[],
  questionNo: number,
): LineSpan[] {
  if (!Number.isFinite(questionNo) || spans.length === 0) return spans;
  const lineMap = buildSourceLineMap(sourceLines);
  const candidateLineNos = spanLineNumbers(spans);
  if (candidateLineNos.length === 0) return spans;

  for (const lineNo of candidateLineNos) {
    const line = lineMap.get(lineNo);
    if (!line) continue;
    const masked = maskWatermarksSameLength(line.text);
    const view = matchingView(masked);
    const matches = [...view.text.matchAll(/(?:^|\s|\()(\d{1,3})\s*(?:[.)\-:–—]|\))\s*/gu)]
      .map(m => {
        const leadWs = m[0].match(/^\s+/)?.[0].length ?? 0;
        return {
          no: Number(m[1]),
          start: view.originalOffset((m.index ?? 0) + leadWs),
          bodyStart: view.originalOffset((m.index ?? 0) + m[0].length),
        };
      })
      .filter(m => Number.isFinite(m.no) && m.no >= 1 && m.no <= 300);

    const distinctNos = new Set(matches.map(m => m.no));
    if (distinctNos.size < 2) continue;

    const hitIdx = matches.findIndex(m => m.no === questionNo);
    if (hitIdx < 0) continue;
    const hit = matches[hitIdx];
    const nextStart = matches[hitIdx + 1] ? matches[hitIdx + 1].start : line.text.length;
    let bodyEnd = nextStart;
    // Strip trailing key-row point totals merged at end of line (e.g. `5. False (b) 6. True (a) 2`).
    if (!matches[hitIdx + 1]) {
      const trailingScore = masked.slice(hit.bodyStart, bodyEnd).match(/\s+[\d۰-۹٠-٩]+(?:\s*\/\s*[\d۰-۹٠-٩]+)?\s*$/u);
      if (trailingScore && masked.slice(hit.bodyStart, bodyEnd - trailingScore[0].length).trim().length > 0) {
        bodyEnd -= trailingScore[0].length;
      }
    }
    const trimmed = trimOffsetsOnLine(masked, hit.bodyStart, bodyEnd);
    if (trimmed.end > trimmed.start) {
      return [{ line: lineNo, start: trimmed.start, end: trimmed.end }];
    }
  }

  return spans;
}
