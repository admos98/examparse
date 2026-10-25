/** Deterministic completeness, key-territory, and exam-health helpers. */
import { ExamDoc, ExamSection, Flag, ImageAsset, LineSpan, OffsetSpan, Question, SourceLine } from '../types';
import { buildQuestionTree } from '../utils/questionTree';
import { attentionCount as computeAttentionCount } from '../utils/attention';
import {
  MATCHING_VIEW_GUILLEMET_ORDINAL_RE,
  SHARED_FURNITURE_FAST_RE,
  SHARED_FURNITURE_LEXICON,
} from './furniture';

function spanMinLine(span: LineSpan): number {
  return Array.isArray(span) ? span[0] : (span as OffsetSpan).line;
}
function spanMaxLine(span: LineSpan): number {
  return Array.isArray(span) ? span[1] : (span as OffsetSpan).line;
}
function spanIncludesLine(span: LineSpan, n: number): boolean {
  return Array.isArray(span) ? n >= span[0] && n <= span[1] : (span as OffsetSpan).line === n;
}

/**
 * A1 — STORAGE-TIME NORMALIZATION (deterministic, zero invention):
 * NFKC → fold Arabic presentation forms (U+FE80–FEFF, U+FB50–FDFF) → tatweel removed → Arabic ي/ك→Persian ی/ک.
 * Applied to every stored SourceLine.text at extraction; matching layer already assumes it.
 */
export function normalizeStoredText(text: string): string {
  let out = text.normalize('NFKC');
  // Explicit presentation-form fold (NFKC already does most, but ensure coverage)
  out = out.replace(/[\uFE80-\uFEFF]/g, c => c.normalize('NFKC'));
  out = out.replace(/[\uFB50-\uFDFF]/g, c => c.normalize('NFKC'));
  out = out.replace(/\u0640/g, ''); // tatweel
  out = out.replace(/`/g, "'"); // backtick apostrophe normalization (e.g. won`t → won't)
  out = out.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ى/g, 'ی');
  // Do NOT lower-case or strip kanoon here; stored text keeps case but is normalized for Arabic/Persian variants.
  return out;
}

/** Matching/indexing ONLY. Never assign this result to source text or rendered fields. */
export function normalizeForMatching(text: string): string {
  const letters: Record<string, string> = { 'ي': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ؤ': 'و', 'ئ': 'ی', 'ى': 'ی' };
  const punctuation: Record<string, string> = { '؟': '?', '،': ',', '؛': ';', '«': '\"', '»': '\"', '–': '-', '—': '-' };
  return text.normalize('NFKC')
    .replace(/[\u0640\u064b-\u0652\u0670]/g, '')
    .replace(/[يكةۀأإآؤئى]/g, c => letters[c] || c)
    .replace(/[۰-۹٠-٩０-９]/g, c => String(c.charCodeAt(0) - (c >= '０' ? 0xff10 : c >= '۰' ? 0x6f0 : 0x660)))
    .replace(/[؟،؛«»–—]/g, c => punctuation[c])
    // Known glued extraction watermarks are furniture, not question content.
    .replace(/www[.-]kanoon[.-]ir/gi, '')
    .replace(/[\s\u200c\u200d]+/g, ' ').toLowerCase();
}
/** @deprecated Use normalizeForMatching. */
export const normalizeDigits = normalizeForMatching;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const MATCHING_VIEW_CACHE = new Map<string, { text: string; originalOffset: (offset: number) => number }>();
const SIMPLE_ASCII_VIEW_RE = /^[\x21-\x7e]*(?: [\x21-\x7e]+)* ?$/;

/** Offsets into the ORIGINAL, including NFKC expansions, marks and joiners. */
export function matchingView(text: string): { text: string; originalOffset: (offset: number) => number } {
  if (text.length <= 240) {
    const cached = MATCHING_VIEW_CACHE.get(text);
    if (cached) return cached;
  }
  if (SIMPLE_ASCII_VIEW_RE.test(text) && !/kanoon/i.test(text)) {
    const lower = text.toLowerCase();
    const fast = {
      text: lower,
      originalOffset: (offset: number) => (offset >= lower.length ? text.length : Math.max(0, offset)),
    };
    if (text.length <= 240) {
      if (MATCHING_VIEW_CACHE.size >= 512) MATCHING_VIEW_CACHE.clear();
      MATCHING_VIEW_CACHE.set(text, fast);
    }
    return fast;
  }
  const starts: number[] = []; const ends: number[] = []; let copy = '';
  const segments = GRAPHEME_SEGMENTER.segment(text);
  for (const part of segments) {
    const normalized = normalizeForMatching(part.segment);
    for (const c of normalized) {
      if (c === ' ' && copy.endsWith(' ')) { ends[ends.length - 1] = part.index + part.segment.length; continue; }
      for (let i = 0; i < c.length; i++) { starts.push(part.index); ends.push(part.index + part.segment.length); }
      copy += c;
    }
  }
  // Apply the lexicon across grapheme boundaries without losing original offsets.
  const watermark = /www[.-]kanoon[.-]ir/gi;
  let hit: RegExpExecArray | null;
  while ((hit = watermark.exec(copy))) {
    const n = hit[0].length; copy = copy.slice(0, hit.index) + copy.slice(hit.index + n);
    starts.splice(hit.index, n); ends.splice(hit.index, n); watermark.lastIndex = hit.index;
  }
  const view = { text: copy, originalOffset: (offset: number) => offset >= starts.length ? text.length : starts[Math.max(0, offset)] };
  if (text.length <= 240) {
    if (MATCHING_VIEW_CACHE.size >= 512) MATCHING_VIEW_CACHE.clear();
    MATCHING_VIEW_CACHE.set(text, view);
  }
  return view;
}

export function lineNumber(line: SourceLine): number {
  const n = Number(String(line.id).replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const KEY_PHRASE = /(?:راهنمای\s*تصحیح|کلید\s*پاسخ|پاسخنامه\s+تشریحی|marking guide|answer key|suggested answers|mark scheme)/;
export interface KeyTerritory { markerLine?: number; lineNos: Set<number> }

export function detectKeyTerritory(lines: SourceLine[]): KeyTerritory {
  const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  const pages = new Map<number, SourceLine[]>();
  for (const line of sorted) pages.set(line.page, [...(pages.get(line.page) || []), line]);
  let markerLine: number | undefined;
  for (const page of pages.values()) for (let i = 0; i < page.length; i++) {
    const value = normalizeForMatching(page[i].text).trim();
    if (page[i].furniture || /^\s*\d{1,3}[.)\-:]\s/.test(value)) continue;
    const phrase = KEY_PHRASE.exec(value);
    const pageStartName = i < 12 && /^پاسخنامه(?: |$)/.test(value);
    const standalone = phrase && value.length <= 120 && !value.includes('?') &&
      /^(?:(?:official|suggested) )?(?:راهنمای\s*تصحیح|کلید\s*پاسخ|پاسخنامه\s+تشریحی|marking guide|answer key|suggested answers|mark scheme)(?:$|\s*[:|\-]| for | of )/.test(value);
    if ((phrase && i < 12) || pageStartName || standalone) {
      const n = lineNumber(i < 12 ? page[0] : page[i]);
      markerLine = markerLine === undefined ? n : Math.min(markerLine, n);
    }
  }
  return { markerLine, lineNos: new Set(sorted.filter(l => markerLine !== undefined && lineNumber(l) >= markerLine).map(lineNumber)) };
}

function parseStartNumber(text: string): number | undefined {
  const value = normalizeForMatching(text);
  const direct = value.match(/^\s*(?:\((\d{1,3})\)|([0-9]{1,3})\s*[.)\-:])(?:\s+|$)(?!\d)/);
  if (direct) return Number(direct[1] || direct[2]);
  return undefined;
}
export interface ExpectedQuestions { numbers: number[]; lineByNumber: Map<number, number>; keyTerritory: KeyTerritory }

// Helper: detect if text starts with option/sub-part marker
function isOptionMarkerStart(text: string): boolean {
  const v = normalizeForMatching(text).trimStart();
  return /^(?:[a-h][).:]|\([a-h]\)|(?:الف|ب|پ|ت|ث|ج|چ|ح|خ|د|ذ|ر|ز|ژ|س|ش|ص|ض|ط|ظ|ع|غ|ف|ق|ک|گ|ل|م|ن|و|ه|ی)[).:])/.test(v);
}
function extractOptionLetter(text: string): string | undefined {
  const v = normalizeForMatching(text).trimStart();
  let m = v.match(/^([a-h])[).:]/);
  if (m) return m[1];
  m = v.match(/^\(([a-h])\)/);
  if (m) return m[1];
  m = v.match(/^(الف|ب|پ|ت|ث|ج|چ|ح|خ|د|ذ|ر|ز|ژ|س|ش|ص|ض|ط|ظ|ع|غ|ف|ق|ک|گ|ل|م|ن|و|ه|ی)[).:]/);
  if (m) return m[1];
  return undefined;
}

/**
 * Part C3 — Recognizes Persian & English "read the following text/passage" instruction lines
 * that act as hard segment boundaries before a section-owned PASSAGE block.
 */
export function isReadTheTextInstruction(text: string): boolean {
  const norm = normalizeForMatching(text).trim();
  if (!norm || norm.length > 220) return false;
  // Never match a line carrying inline MCQ/TF option pairs.
  const optionMarkers = [...norm.matchAll(/(?:^|\s)(?:\([a-d]\)|[a-d][).:]|\((?:الف|ب|ج|د)\)|(?:الف|ب|ج|د)[).:])(?=\s|$)/gi)];
  if (optionMarkers.length >= 2) return false;
  // Strip optional leading/trailing row numbers or point totals from Iranian table rows.
  const core = norm
    .replace(/^\s*(?:\(\d{1,2}\)|\d{1,2}(?:[./]\d{1,2})?)\s*[.)\-:|]?\s*/, '')
    .replace(/\s*[|]?\s*\d{1,2}(?:[./]\d{1,2})?\s*$/, '')
    .trim();
  if (/^(?:متن(?:\s*های)?\s+زیر\s+را\s*(?:به\s+دقت\s+)?بخوان|با\s+توجه\s+به\s+متن(?:\s+زیر)?\b)/iu.test(core)) {
    return true;
  }
  if (/^(?:read\s+the\s+(?:following\s+)?(?:passage|text|article|paragraph|story|extract)s?\b|carefully\s+read\s+the\s+(?:following\s+)?(?:passage|text)\b)/iu.test(core)) {
    return true;
  }
  return false;
}

// Detect section headers for A2 & Part E1 (strict printed title headers only)
export interface SectionHeaderCandidate { title: string; headerLine: number; kind: string; start: number; rawTitle: string }
const HEADER_KEYWORDS = [
  { re: /\blistening\b/i, title: 'Listening', kind: 'Listening' },
  { re: /\bvocabulary\b|(?:^|\s)ocabulary\s+v(?:\s|$)/i, title: 'Vocabulary', kind: 'Vocabulary' },
  { re: /\bgrammar\b/i, title: 'Grammar', kind: 'Grammar' },
  { re: /\breading\b/i, title: 'Reading', kind: 'Reading' },
  { re: /\bwriting\b/i, title: 'Writing', kind: 'Writing' },
  { re: /\bspeaking\b/i, title: 'Speaking', kind: 'Speaking' },
  { re: /\buse of english\b/i, title: 'Use of English', kind: 'Other' },
  { re: /\blanguage focus\b/i, title: 'Language Focus', kind: 'Other' },
  { re: /(?:^|\s)(?:بخش\s+)?شنیداری(?:\s|$)/i, title: 'Listening', kind: 'Listening' },
  { re: /(?:^|\s)(?:بخش\s+)?واژگان(?:\s|$)/i, title: 'Vocabulary', kind: 'Vocabulary' },
  { re: /(?:^|\s)(?:دستور\s+زبان|گرامر)(?:\s|$)/i, title: 'Grammar', kind: 'Grammar' },
  { re: /(?:^|\s)(?:بخش\s+)?درک\s+مطلب(?:\s|$)/i, title: 'Reading', kind: 'Reading' },
  { re: /(?:^|\s)(?:نوشتاری|نگارش)(?:\s|$)/i, title: 'Writing', kind: 'Writing' },
  { re: /(?:^|\s)(?:بخش\s+)?گفتاری(?:\s|$)/i, title: 'Speaking', kind: 'Speaking' },
];

const ALLOWED_HEADER_TITLE_TOKEN_RE = /^(?:listening|comprehension|vocabulary|ocabulary|v|grammar|reading|writing|speaking|use|of|english|language|focus|and|&|\/|-|بخش|قسمت|شنیداری|واژگان|دستور|زبان|گرامر|درک|مطلب|نوشتاری|نگارش|گفتاری|اول|دوم|سوم|چهارم|پنجم|ششم|الف|ب|ج|د)$/iu;

function isStrictPrintedTitleHeader(rawText: string, norm: string): boolean {
  if (!norm || norm.length > 90) return false;
  if (isReadTheTextInstruction(rawText)) return false;
  if (/ردیف\s+سؤالات|ردیف\s+سوالات|راهنمای\s+تصحیح/u.test(norm)) return false;
  // Numbered questions like "25. Writing response." or "(15) ..." are never section headers.
  if (/^\s*(?:\(\d{1,3}\)|\d{1,3}\s*[.)\-:])\s+\S/u.test(norm)) return false;
  // Prose instructions ending in sentence punctuation (. ? ! ؟) without Section/Part prefix are not title headers.
  if (/[.?!؟]\s*$/u.test(norm) && !/^\s*(?:section|part|بخش)\b/iu.test(norm)) return false;

  // Strip allowed header framing: Section/Part/بخش prefix, parenthesized points/marks, pipes, and row/point numerals.
  let core = norm
    .replace(/\(\s*[^)]{0,35}(?:marks?|points?|pts?|نمره|بارم)[^)]*\)/giu, ' ')
    .replace(/\[\s*[^\]]{0,35}(?:marks?|points?|pts?|نمره|بارم)[^\]]*\]/giu, ' ')
    .replace(/^\s*(?:section|part|بخش|قسمت)\s*(?:[A-Z0-9IVX]+|اول|دوم|سوم|چهارم|پنجم|ششم|الف|ب|ج|د)?\s*[:.\-–—|]?\s*/iu, ' ')
    .replace(/[|]/g, ' ')
    .replace(/^\s*\d{1,2}(?:[./]\d{1,2})?\s+/, ' ')
    .replace(/\s+\d{1,2}(?:[./]\d{1,2})?\s*(?:points?|pts?|marks?|نمره|بارم)?\s*$/iu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!core) return false;
  const tokens = core.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return false;
  return tokens.every(tok => ALLOWED_HEADER_TITLE_TOKEN_RE.test(tok));
}

export function detectSectionHeaders(lines: SourceLine[]): SectionHeaderCandidate[] {
  const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  const candidates: SectionHeaderCandidate[] = [];
  for (const line of sorted) {
    if (line.furniture || line.tag === 'key') continue;
    const text = line.text;
    const norm = normalizeForMatching(text);
    const optionMarkers = [...norm.matchAll(/(?:^|\s)(?:\([a-d]\)|[a-d][).:]|\((?:الف|ب|ج|د)\)|(?:الف|ب|ج|د)[).:])(?=\s|$)/gi)];
    if (optionMarkers.length >= 2) continue;
    if (!isStrictPrintedTitleHeader(text, norm)) continue;

    for (const kw of HEADER_KEYWORDS) {
      if (kw.re.test(text) || kw.re.test(norm)) {
        const ln = lineNumber(line);
        candidates.push({ title: kw.title, headerLine: ln, kind: kw.kind, start: ln, rawTitle: text.trim() });
        break;
      }
    }
  }
  const dedup = new Map<number, SectionHeaderCandidate>();
  for (const c of candidates) if (!dedup.has(c.headerLine)) dedup.set(c.headerLine, c);
  return [...dedup.values()].sort((a, b) => a.headerLine - b.headerLine);
}
export function deriveSectionMapFromHeaders(lines: SourceLine[]): Array<{ title: string; headerLine: number; spanStart: number; kind: string }> {
  const headers = detectSectionHeaders(lines);
  if (!headers.length) return [];
  const sortedLines = [...lines].sort((a,b)=>lineNumber(a)-lineNumber(b));
  const lineNos = sortedLines.map(lineNumber);
  const maxLine = Math.max(...lineNos, 0);
  const minLine = Math.min(...lineNos, 1);
  const result: Array<{title:string; headerLine:number; spanStart:number; kind:string}> = [];
  for (let i=0;i<headers.length;i++) {
    const h = headers[i];
    const nextHeaderLine = headers[i+1]?.headerLine;
    const spanStart = h.headerLine;
    // spanEnd is next header -1, or maxLine
    // We return spanStart; caller will compute end
    result.push({ title: h.title, headerLine: h.headerLine, spanStart: h.headerLine, kind: h.kind });
  }
  return result;
}

export function enumerateExpectedQuestionNos(lines: SourceLine[]): ExpectedQuestions {
  const keyTerritory = detectKeyTerritory(lines);
  const lineByNumber = new Map<number, number>();
  // Detailed candidates for phantom filtering
  interface CandidateDetail { n: number; lineNo: number; pos: number; afterPreview: string; kind: 'leading'|'paren'|'dotted'|'midOption'|'midText'|'genericMulti' }
  const details: CandidateDetail[] = [];

  for (const line of lines) {
    if (line.furniture || keyTerritory.lineNos.has(lineNumber(line))) continue;
    const value = normalizeForMatching(line.text);
    const ln = lineNumber(line);
    // Leading
    const leading = parseStartNumber(value);
    if (leading !== undefined) {
      const m = value.match(/^\s*(?:\((\d{1,3})\)|([0-9]{1,3})\s*[.)\-:])/);
      if (m) {
        const afterIdx = m[0].length;
        const afterPreview = line.text.slice(afterIdx).trim().slice(0, 80); // original text preview
        // Use original line.text for afterPreview to preserve option markers
        details.push({ n: leading, lineNo: ln, pos: 0, afterPreview, kind: 'leading' });
      }
    }
    // Explicit grouped labels and dotted dialogue slots
    for (const m of value.matchAll(/\((\d{1,3})\)|(?:\.{2,}|…+)\s*(\d{1,3})\s*(?=(?:\.{2,}|…+))/g)) {
      const num = Number(m[1] || m[2]);
      if (!num) continue;
      const idx = m.index || 0;
      const afterPreview = line.text.slice(idx + m[0].length).trim().slice(0, 80);
      details.push({ n: num, lineNo: ln, pos: idx, afterPreview, kind: m[1] ? 'paren' : 'dotted' });
    }
    // Multiple printed items on one line require an option marker, avoiding prose numbers.
    for (const m of value.matchAll(/(?:^|\s)(\d{1,3})[.)]\s+(?=(?:[a-h][).:]|\([a-h]\)|(?:الف|ب|ج|د)[).])\s)/g)) {
      const num = Number(m[1]);
      const idx = m.index || 0;
      const fullMatch = m[0];
      // Simplify: use value slice for afterPreview
      const afterSlice = value.slice((m.index || 0) + m[0].length - 1).trim().slice(0, 80);
      details.push({ n: num, lineNo: ln, pos: idx, afterPreview: afterSlice, kind: 'midOption' });
    }
    // Generic mid-line numbers with question text (for genuine multi-item lines)
    // Only consider lines with at least 2 numbers to avoid prose false positives
    const genericMatches = [...value.matchAll(/(?:^|\s)(\d{1,3})[.)]\s+/g)];
    if (genericMatches.length >= 2) {
      for (const m of genericMatches) {
        const num = Number(m[1]);
        // Skip if already captured as leading or midOption (avoid duplicates)
        const existingSame = details.some(d => d.lineNo === ln && d.n === num && Math.abs(d.pos - (m.index||0)) < 5);
        if (existingSame) continue;
        const idx = m.index || 0;
        const afterIdx = idx + m[0].length;
        const afterPreview = value.slice(afterIdx).trim().slice(0, 80);
        // Only count if afterPreview looks like question text (not pure option marker? but we want question text)
        // Check it starts with letters and length > 3
        if (afterPreview.length >= 3 && !isOptionMarkerStart(afterPreview)) {
          // Ensure not just a year/page number in prose: heuristic - question text should contain at least 2 words
          if (afterPreview.split(/\s+/).length >= 2) {
            details.push({ n: num, lineNo: ln, pos: idx, afterPreview, kind: 'genericMulti' });
          }
        }
      }
    }

    // Fallback: legacy simple candidates for compatibility (without details)
    // We already pushed via details, now populate lineByNumber interim without filtering
    // We'll fill lineByNumber after filtering
  }

  // Build initial map from details (first occurrence wins)
  const tempMap = new Map<number, number>();
  const detailByNumber = new Map<number, CandidateDetail[]>();
  for (const d of details) {
    if (d.n < 1 || d.n > 300) continue;
    if (!tempMap.has(d.n)) tempMap.set(d.n, d.lineNo);
    if (!detailByNumber.has(d.n)) detailByNumber.set(d.n, []);
    detailByNumber.get(d.n)!.push(d);
  }
  // Also include legacy simple candidates for lines where details didn't capture? But we have covered all via details plus generic
  // Now apply phantom filtering for lettered sub-parts (A3.2)
  // Detect runs where numbers consecutive and each afterPreview is option marker start
  // We need to sort details by lineNo then pos
  const sortedDetails = [...details].sort((a,b)=> a.lineNo - b.lineNo || a.pos - b.pos);
  const phantomNumbers = new Set<number>();
  // Group by line proximity: check runs across consecutive details
  for (let i=0;i<sortedDetails.length;i++) {
    const run: CandidateDetail[] = [sortedDetails[i]];
    for (let j=i+1;j<sortedDetails.length;j++) {
      const prev = sortedDetails[j-1];
      const cur = sortedDetails[j];
      // Numbers must be consecutive
      if (cur.n !== prev.n + 1) break;
      // Both must have option marker style afterPreview
      // For leading, afterPreview is from line start; for midOption, afterPreview is option marker leading
      const prevIsSub = isOptionMarkerStart(prev.afterPreview);
      const curIsSub = isOptionMarkerStart(cur.afterPreview);
      if (!prevIsSub || !curIsSub) break;
      // Check option letters sequential (a->b->c... or Persian)
      const prevLetter = extractOptionLetter(prev.afterPreview);
      const curLetter = extractOptionLetter(cur.afterPreview);
      if (prevLetter && curLetter) {
        const order = 'abcdefgh';
        const pi = order.indexOf(prevLetter);
        const ci = order.indexOf(curLetter);
        if (pi >=0 && ci >=0 && ci === pi+1) {
          // Require different lines for phantom (same line multi-item is genuine)
          if (cur.lineNo !== prev.lineNo) {
            run.push(cur);
            continue;
          } else {
            break;
          }
        }
        // Also check Persian sequential? For simplicity, if both Persian, consider sequential if they appear in known order list
        const persianOrder = ['الف','ب','پ','ت','ث','ج','چ','ح','خ','د','ذ','ر','ز','ژ','س','ش','ص','ض','ط','ظ','ع','غ','ف','ق','ک','گ','ل','م','ن','و','ه','ی'];
        const pPi = persianOrder.indexOf(prevLetter);
        const pCi = persianOrder.indexOf(curLetter);
        if (pPi >=0 && pCi >=0 && pCi === pPi+1) {
          if (cur.lineNo !== prev.lineNo) {
            run.push(cur);
            continue;
          } else {
            break;
          }
        }
        // If letters not sequential but both are option markers, still consider sub-part run if numbers consecutive and on same line or consecutive lines
        // For "63. a) ... 64. b) ..." the letters a,b are sequential, we already handled. For generic, we still want to filter.
        // If letters not sequential, break run
        break;
      } else {
        // If both are option marker style but letters not extractable, still consider run if lineNos close (next line, not same)
        if (cur.lineNo !== prev.lineNo && Math.abs(cur.lineNo - prev.lineNo) <= 2) {
          run.push(cur);
          continue;
        }
        break;
      }
    }
    if (run.length >= 2) {
      // This run is sub-part group: keep first, phantom the rest
      for (let k=1;k<run.length;k++) phantomNumbers.add(run[k].n);
      // Skip ahead
      i += run.length -1;
    }
  }

  // Build final lineByNumber excluding phantoms
  const finalLineByNumber = new Map<number, number>();
  for (const [n, ln] of tempMap) {
    if (phantomNumbers.has(n)) continue;
    finalLineByNumber.set(n, ln);
  }
  // Also need to ensure we didn't miss candidates that were not in details but via legacy logic (candidates array)
  // Re-run legacy candidate collection for fallback to ensure genuine multi-item lines counted, but respecting phantom filter
  for (const line of lines) {
    if (line.furniture || keyTerritory.lineNos.has(lineNumber(line))) continue;
    const value = normalizeForMatching(line.text);
    const candidates: number[] = [];
    const leading = parseStartNumber(value); if (leading !== undefined) candidates.push(leading);
    for (const m of value.matchAll(/\((\d{1,3})\)|(?:\.{2,}|…+)(\d{1,3})(?=\.{2,}|…+)/g)) candidates.push(Number(m[1] || m[2]));
    for (const m of value.matchAll(/(?:^|\s)(\d{1,3})[.)]\s+(?=(?:[a-h][).:]|\([a-h]\)|(?:الف|ب|ج|د)[).])\s)/g)) candidates.push(Number(m[1]));
    for (const n of candidates) if (n >=1 && n<=300 && !finalLineByNumber.has(n) && !phantomNumbers.has(n)) finalLineByNumber.set(n, lineNumber(line));
  }

  return { numbers: [...finalLineByNumber.keys()].sort((a, b) => a - b), lineByNumber: finalLineByNumber, keyTerritory };
}
export function parsePrintedNumberFromStem(stem?: string): number | undefined {
  if (!stem) return undefined;
  for (const line of stem.slice(0, 240).split(/\r?\n/).slice(0, 2)) {
    const n = parseStartNumber(line); if (n !== undefined && n >= 1 && n <= 300) return n;
  }
  return undefined;
}

export interface CoverageResult {
  expected: number[];
  parsedNumbers: number[];
  missing: number[];
  duplicates: number[];
  pointsParsed: number;
  pointsExpected?: number;
  pointDeficit: number;
  coveragePercent: number;
  pointsMatch: boolean;
  complete: boolean;
}
function parseEnumeratedChildNumbers(stem: string): number[] {
  const value = normalizeForMatching(stem);
  const nums: number[] = [];
  for (const m of value.matchAll(/\((\d{1,3})\)/g)) nums.push(Number(m[1]));
  // Also check for pattern "15) 16) 17)" etc?
  for (const m of value.matchAll(/(?:^|\s)(\d{1,3})[.)]\s*(?=[A-Za-z\u0600-\u06FF])/g)) {
    // This would catch "15. ..." style enumeration inside stem? Use conservatively: only if stem contains many numbers
  }
  return nums.filter(n=>n>=1&&n<=300);
}
export function evaluateCoverage(
  expectedNumbers: number[],
  questions: Array<Pick<Question, 'no' | 'stem' | 'points' | 'parentId'>> & { parentId?: string },
  totalPoints?: number
): CoverageResult {
  const expected = [...new Set(expectedNumbers)].sort((a, b) => a - b);
  const values = questions.map(q => parsePrintedNumberFromStem(q.stem) ?? Number((q as any).no)).filter(n => Number.isFinite(n) && n >= 1 && n <= 300);
  const counts = new Map<number, number>();
  for (const n of values) counts.set(n, (counts.get(n) || 0) + 1);
  // Also consider group parent enumeration: if parent has children, its stem may enumerate child numbers (15)(16)(17)(18)
  // For coverage, if a parent's stem enumerates numbers that match children nos, we consider those children covered even if child stems thin
  // Build set of child numbers via parentId
  const childNumbers = new Set<number>();
  const parentIds = new Set<string>();
  for (const q of questions) if ((q as any).parentId) { childNumbers.add(Number((q as any).no)); parentIds.add((q as any).parentId); }
  // For each parent, parse its stem enumerated numbers, if they correspond to expected missing numbers and children exist for them, add to parsed
  for (const q of questions) {
    if (!parentIds.has((q as any).id)) continue;
    const enumerated = parseEnumeratedChildNumbers(q.stem || '');
    for (const n of enumerated) if (!counts.has(n) && childNumbers.has(n)) counts.set(n, 1);
    // Also, if parent enumerates numbers and we have children for them, we can consider parent's own number already counted
    // For health, parent with children should satisfy coverage for its enumerated child numbers when children exist
    // So add enumerated child numbers to counts if child exists
    for (const n of enumerated) {
      if (expected.includes(n) && childNumbers.has(n) && !counts.has(n)) {
        counts.set(n, 1);
      }
    }
  }
  const parsedNumbers = [...counts.keys()].sort((a, b) => a - b);
  const missing = expected.filter(n => !counts.has(n));
  const duplicates = [...counts].filter(([n, count]) => {
    if (count <= 1) return false;
    const matches = questions.filter(q => (parsePrintedNumberFromStem(q.stem) ?? Number(q.no)) === n);
    const roots = matches.filter(q => !q.parentId);
    // A parent plus its own children is one structural item, not duplicate content.
    return !(roots.length === 1 && (roots[0] as any).id && matches.every(q => q === roots[0] || q.parentId === (roots[0] as any).id));
  }).map(([n]) => n).sort((a, b) => a - b);
  const pointsParsed = Number(questions.reduce((sum, q) => sum + (Number((q as any).points) || 0), 0).toFixed(2));
  const pointDeficit = totalPoints === undefined ? 0 : Number((totalPoints - pointsParsed).toFixed(2));
  const pointsMatch = totalPoints === undefined || Math.abs(pointDeficit) <= 0.51;
  const coveragePercent = expected.length === 0 ? 100 : Math.max(0, ((expected.length - missing.length) / expected.length) * 100);
  return {
    expected, parsedNumbers, missing, duplicates, pointsParsed,
    pointsExpected: totalPoints, pointDeficit, coveragePercent, pointsMatch,
    complete: missing.length === 0 && duplicates.length === 0 && pointsMatch,
  };
}

/** C1 — META_TOTAL cross-check sources, in priority order. */
export interface DocumentTotals {
  totalLine?: { value: number; line: number };
  keyPage?: { value: number; line: number };
  sectionSum?: { value: number; headers: number };
  /** Winner: total-points line (last occurrence in exam territory) > key page > section header sum. */
  documentTotal?: number;
  source?: 'total-line' | 'key-page' | 'section-sum';
}

const TOTAL_LINE_RE = /(?:جمع\s*(?:کل\s*)?نمر(?:ه|ات)|نمره\s*کل|بارم\s*کل|total\s*(?:points|marks|score)?|out\s*of)\s*[:：=]?\s*(\d{1,3}(?:[.,]\d{1,2})?)/i;
const TOTAL_LINE_TRAILING_RE = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:نمره|points?|marks?)\s*(?:کل|total)?\s*$/i;
function parseTotalValue(text: string): number | undefined {
  const v = normalizeForMatching(text);
  if (!/(?:جمع|نمره\s*کل|بارم\s*کل|total|out of)/i.test(v)) return undefined;
  // "Choose one out of four options" is an instruction, not a total: a bare "out of" needs a score word or a very short line.
  if (!/(?:جمع|نمره\s*کل|بارم\s*کل|total)/i.test(v) && v.length > 30 && !/\b(?:score|marks?|points?|grade)\b/i.test(v)) return undefined;
  const m = v.match(TOTAL_LINE_RE) || v.match(TOTAL_LINE_TRAILING_RE);
  const n = m ? Number(m[1].replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 300 ? n : undefined;
}
function parseHeaderPoints(text: string): number | undefined {
  const v = normalizeForMatching(text);
  // Explicit score evidence only. A bare trailing digit or "نمره 1" can be a question/page/column number.
  if (/(?:row|question|questions|ردیف|سوالات?)\s*[:：]?\s*(?:number|no\.?|شماره)?[\s\S]{0,35}(?:marks?|points?|نمره)/i.test(v)) return undefined;
  const m = v.match(/\(\s*(\d+(?:\.\d+)?)\s*(?:points?|marks?|نمره)\s*\)|(?:points?|marks?|نمره)\s*[:=：]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:points?|marks?)\b/i);
  const n = Number(m?.[1] || m?.[2] || m?.[3]);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : undefined;
}

export function extractDocumentTotals(lines: SourceLine[], keyLines: Set<number> | number[] = []): DocumentTotals {
  const keys = keyLines instanceof Set ? keyLines : new Set(keyLines);
  const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  const out: DocumentTotals = {};
  for (const line of sorted) {
    if (line.furniture) continue;
    const n = lineNumber(line);
    if (parsePrintedNumberFromStem(line.text) !== undefined) continue; // "12. Total the following..." is a question
    const value = parseTotalValue(line.text);
    if (value === undefined) continue;
    if (keys.has(n)) { if (!out.keyPage) out.keyPage = { value, line: n }; }
    else out.totalLine = { value, line: n }; // last occurrence wins
  }
  const headers = detectSectionHeaders(sorted).filter(h => !keys.has(h.headerLine));
  const pts = headers.map(h => parseHeaderPoints(h.rawTitle)).filter((v): v is number => v !== undefined);
  if (headers.length >= 2 && pts.length === headers.length) out.sectionSum = { value: Number(pts.reduce((a, b) => a + b, 0).toFixed(2)), headers: headers.length };
  const winner = out.totalLine ? ['total-line', out.totalLine.value] as const : out.keyPage ? ['key-page', out.keyPage.value] as const : out.sectionSum ? ['section-sum', out.sectionSum.value] as const : undefined;
  if (winner) { out.source = winner[0]; out.documentTotal = winner[1]; }
  return out;
}

export interface MetaTotalReconciliation {
  totalPoints?: number;
  flag?: { code: 'META_TOTAL_CORRECTED' | 'META_TOTAL_UNCHECKED'; severity: 'info' | 'warn'; message: string };
  totals: DocumentTotals;
}
/** C1 — source-declared total wins; question-point mismatches are reported, never repaired by changing the total. */
export function reconcileMetaTotal(metaTotal: number | undefined, lines: SourceLine[], keyLines: Set<number> | number[], _questions: Array<{ points?: number; parentId?: string }> = []): MetaTotalReconciliation {
  const totals = extractDocumentTotals(lines, keyLines);
  let total = metaTotal;
  let flag: MetaTotalReconciliation['flag'];
  if (totals.documentTotal !== undefined) {
    if (metaTotal === undefined || Math.abs(metaTotal - totals.documentTotal) > 0.01) {
      total = totals.documentTotal;
      flag = { code: 'META_TOTAL_CORRECTED', severity: 'info', message: `Total points ${metaTotal === undefined ? 'were missing' : `${metaTotal} (model)`} → ${totals.documentTotal} from the document's ${totals.source === 'total-line' ? 'total-points line' : totals.source === 'key-page' ? 'answer-key total' : 'section header sum'}.` };
    }
  } else {
    flag = { code: 'META_TOTAL_UNCHECKED', severity: 'info', message: `No total-points line, key total or complete section header points found; meta total ${metaTotal ?? '—'} is unchecked.` };
  }
  return { totalPoints: total, flag, totals };
}

export interface ExamHealth {
  expectedCount: number;
  parsedCount: number;
  missing: number[];
  duplicates: number[];
  pointsParsed: number;
  pointsExpected?: number;
  pointDeficit: number;
  unplacedImages: ImageAsset[];
  missingBlobImages?: ImageAsset[];
  unresolvedImageRefs: string[];
  attentionCount?: number;
  lowConfidenceCount: number;
  parentLinkIssueCount?: number;
  coveragePercent: number;
  state: 'green' | 'amber' | 'red';
  complete: boolean;
  /** C2 survivors: questions still carrying error-severity validator flags after repair. */
  hollowQuestions: Array<{ id: string; label: string; code: string }>;
  /** B3 orphan lines (persisted by the pipeline; recomputed lazily by callers that need exactness). */
  orphanLines: number;
  /**
   * Marvel Batch 6 Fix 1c: shape-audit counts from the LAST canonicalization pass, as persisted on
   * the doc. `undefined` for docs parsed before the final pass existed.
   */
  shapeAudit?: { optionIncludesStem: number; duplicateSiblingStems: number; overlongStems: number };
  /**
   * Marvel Batch 6 Fix 4: stems still over the 500-char brake after final re-detachment — text is
   * kept verbatim (never truncated/invented) and the question is named here for review.
   */
  stemOverlong: Array<{ id: string; no: number; label: string; length: number }>;
}

export function getExamHealth(doc: ExamDoc): ExamHealth {
  const expected = doc.source?.expectedQuestionNos || enumerateExpectedQuestionNos(doc.source?.lines || []).numbers;
  const sourceLines = doc.source?.lines || [];
  const contentQuestions = (doc.questions || []).filter(q => !q.spans?.length || !sourceLines.length || q.spans.some(sp => sourceLines.some(l => !l.furniture && spanIncludesLine(sp, lineNumber(l)))));
  // Check for group coverage via facts: if user has accepted group representation, we adjust expected
  // Look for flag or fact that marks group coverage
  // We will check doc.flags or doc.source? For now, check doc as any for groupCoverageFacts
  let effectiveExpected = [...expected];
  // If doc has user facts indicating group representation, filter expected accordingly
  const groupFacts = (doc as any).userFacts || (doc as any).groupCoverage || [];
  // Also check dossier-style facts would be in doc?
  // Simpler: check flags with code GROUP_COVERAGE_ACCEPTED
  const groupAcceptedFlags = (doc.flags || []).filter(f => f.code === 'GROUP_COVERAGE_ACCEPTED');
  for (const flag of groupAcceptedFlags) {
    // flag message may contain "15-18" or similar
    const m = flag.message.match(/(\d+)[-_](\d+)/);
    if (m) {
      const start = Number(m[1]); const end = Number(m[2]);
      // If group parent exists and enumerates these numbers, we can consider them covered
      // Remove missing that are inside group range if parent exists?
      // We'll just filter expected to exclude those numbers that are inside accepted group and have parent with children?
      // Actually we want health to not list them as missing while keeping questions unchanged
      // So we filter expected: remove numbers that are within accepted group ranges and have a parent enumerating them
      const toRemove = new Set<number>();
      for (let n=start+1;n<=end;n++) toRemove.add(n);
      effectiveExpected = effectiveExpected.filter(n => !toRemove.has(n));
    }
    // Also handle single group parent id
    if ((flag as any).groupParentId) {
      // legacy
    }
  }
  // Also check for coverage adjustments stored in doc.coverageOverrides (added via accept_group_representation)
  const overrides = (doc as any).coverageOverrides as Set<number> | number[] | undefined;
  if (overrides) {
    const set = new Set(Array.isArray(overrides) ? overrides : [...overrides]);
    effectiveExpected = effectiveExpected.filter(n => !set.has(n));
  }
  const coverage = evaluateCoverage(effectiveExpected, contentQuestions as any, doc.meta?.totalPoints);
  const referenced = new Set<string>();
  const unresolved = new Set<string>();
  for (const q of doc.questions || []) {
    for (const image of q.images || []) {
      referenced.add(image.imageId);
      const asset = (doc.images || []).find(img => img.id === image.imageId);
      if (!asset || !asset.dataUrl) unresolved.add(image.imageId);
    }
  }
  for (const img of doc.images || []) {
    const ref = img.label?.questionRef;
    if (ref && (doc.questions || []).some(q => q.id === ref || q.label === ref || String(q.no) === ref)) referenced.add(img.id);
  }
  const missingBlobImages = (doc.images || []).filter(img => Boolean(img.storageMissing) && img.label?.role !== 'decoration' && img.label?.kind !== 'decoration');
  const unplacedImages = (doc.images || []).filter(img => !img.storageMissing && !referenced.has(img.id) && img.label?.role !== 'decoration' && img.label?.kind !== 'decoration');
  // Follow-up #36 C1/C2 — the ONE human-action count (same function the UI/Assistant read).
  const attentionCount = computeAttentionCount(doc);
  const lowConfidenceCount = (doc.questions || []).filter(q => q.confidence < 0.6).length;
  const hasCoverageProblem = coverage.missing.length > 0 || !coverage.pointsMatch;
  const hasQuestions = (doc.questions || []).length > 0;
  const hierarchy = buildQuestionTree(doc.questions || []);
  const parentLinkIssueCount = hierarchy.cycleBreaks.size + hierarchy.orphanedParents.size;
  const hollowQuestions = (doc.questions || []).flatMap(q => (q.flags || []).filter(code => code === 'STEM_HOLLOW' || code === 'OPTIONS_MISSING' || code === 'SECTION_AMBIGUOUS').map(code => ({ id: q.id, label: q.label, code })));
  const orphanLines = (doc.source?.orphanLineNos || []).length;
  // Fix 4: stems over the brake are named whether or not the parse-time snapshot survived an edit.
  const stemOverlong = (doc.questions || [])
    .filter(q => (q.stem || '').length > 500)
    .map(q => ({ id: q.id, no: q.no, label: q.label || String(q.no), length: (q.stem || '').length }));
  const shapeAudit = doc.source?.finalShapeAudit;
  const complete = hasQuestions && coverage.complete && unplacedImages.length === 0 && missingBlobImages.length === 0 && unresolved.size === 0 && parentLinkIssueCount === 0 && hollowQuestions.length === 0;
  const state = coverage.expected.length > 0 && coverage.coveragePercent < 80
    ? 'red'
    : complete ? 'green' : 'amber';
  return {
    expectedCount: effectiveExpected.length || coverage.parsedNumbers.length,
    parsedCount: new Set(coverage.parsedNumbers).size,
    missing: coverage.missing,
    duplicates: coverage.duplicates,
    pointsParsed: coverage.pointsParsed,
    pointsExpected: coverage.pointsExpected,
    pointDeficit: coverage.pointDeficit,
    unplacedImages,
    missingBlobImages,
    unresolvedImageRefs: [...unresolved],
    attentionCount,
    lowConfidenceCount,
    parentLinkIssueCount,
    coveragePercent: coverage.coveragePercent,
    state: hasCoverageProblem && coverage.expected.length > 0 && coverage.coveragePercent < 80 ? 'red' : state,
    complete,
    hollowQuestions,
    orphanLines,
    shapeAudit,
    stemOverlong,
  };
}

export function isQuestionSpanKeySafe(spans: LineSpan[], keyLineNos: Set<number>): boolean {
  return spans.every(sp => {
    const start = spanMinLine(sp);
    const end = spanMaxLine(sp);
    for (let n = start; n <= end; n++) if (keyLineNos.has(n)) return false;
    return true;
  });
}

/** Geometric image hints are deterministic; model labels may confirm or explain a reassignment. */
export function computeImageQuestionHints(
  images: ImageAsset[],
  questions: Array<Pick<Question, 'id' | 'no' | 'label' | 'parentId' | 'spans'> & Pick<Question, 'options' | 'tables'>>,
  sourceLines: SourceLine[]
): Record<string, { questionRef: string; group: string; page: number }> {
  const lineByNo = new Map(sourceLines.map(line => [lineNumber(line), line]));
  const pageBounds = new Map<number, { start: number; end: number }>();
  for (const line of sourceLines) {
    const n = lineNumber(line);
    const bounds = pageBounds.get(line.page);
    pageBounds.set(line.page, bounds ? { start: Math.min(bounds.start, n), end: Math.max(bounds.end, n) } : { start: n, end: n });
  }
  const sortedQuestions = [...questions].sort((a, b) => a.no - b.no);
  const spansFor = (q: typeof sortedQuestions[number]) => [...q.spans, ...(q.options || []).flatMap(option => option.spans), ...(q.tables || []).flatMap(table => table.spans)];
  const pageEndFor = (q: typeof sortedQuestions[number], page: number, upperBound: number) => {
    const bounds = pageBounds.get(page);
    if (!bounds) return -Infinity;
    let maximum = -Infinity;
    for (const sp of spansFor(q)) {
      const start = spanMinLine(sp);
      const end = spanMaxLine(sp);
      const candidate = Math.min(end, bounds.end, upperBound);
      if (candidate >= Math.max(start, bounds.start)) maximum = Math.max(maximum, candidate);
    }
    return maximum;
  };
  const hasSpanOnPage = (q: typeof sortedQuestions[number], targetPage: number) => {
    for (const sp of spansFor(q)) {
      const start = spanMinLine(sp);
      const end = spanMaxLine(sp);
      for (let n = start; n <= end; n++) {
        if (lineByNo.get(n)?.page === targetPage) return true;
      }
    }
    return false;
  };
  const hints: Record<string, { questionRef: string; group: string; page: number }> = {};
  for (const img of images) {
    if (!img.anchorLine) continue;
    const line = lineByNo.get(img.anchorLine);
    // Geometry assignment is strict same-page (±0 pages) only; cross-page requires vision.
    if (line && line.page !== img.page) continue;
    const page = img.page;
    const samePageQuestions = sortedQuestions.filter(q => hasSpanOnPage(q, page));
    if (!samePageQuestions.length) continue;
    let candidates = samePageQuestions.filter(q => spansFor(q).some(sp => spanIncludesLine(sp, img.anchorLine!)));
    // Prefer the parent group when it owns the containing range.
    const parentCandidate = candidates.find(q => !q.parentId);
    if (parentCandidate) candidates = [parentCandidate];
    if (!candidates.length) {
      const preceding = samePageQuestions.filter(q => !q.parentId)
        .map(q => ({ q, line: pageEndFor(q, page, img.anchorLine!) }))
        .filter(item => Number.isFinite(item.line))
        .sort((a, b) => b.line - a.line)[0]?.q;
      if (preceding) candidates = [preceding];
    }
    const chosen = candidates[0];
    if (!chosen) continue;
    hints[img.id] = { questionRef: chosen.label || String(chosen.no), group: chosen.label || String(chosen.no), page };
  }
  return hints;
}

export function autoDecorateRepeatedImages(images: ImageAsset[]): ImageAsset[] {
  const pagesByHash = new Map<string, Set<number>>();
  for (const image of images) {
    const hash = image.dHash || image.sha;
    if (!hash) continue;
    const pages = pagesByHash.get(hash) || new Set<number>();
    pages.add(image.page);
    pagesByHash.set(hash, pages);
  }
  return images.map(image => {
    const hash = image.dHash || image.sha;
    const pageCount = hash ? pagesByHash.get(hash)?.size || 0 : 0;
    if (pageCount < 3) return image;
    return {
      ...image,
      label: {
        ...(image.label || {}), role: 'decoration', kind: 'decoration',
        caption: image.label?.caption || 'Repeated page logo',
        reason: image.label?.reason || `Same visual element repeats on ${pageCount} pages.`,
      },
    };
  });
}

export function sectionRangesFromSections(sections: ExamSection[]): Array<{ id: string; index: number; title: string; start: number; end: number }> {
  return sections.flatMap(section => {
    if (!section.spans?.length) return [];
    return [{
      id: section.id,
      index: section.index,
      title: section.title || `Section ${section.index}`,
      start: Math.min(...section.spans.map(spanMinLine)),
      end: Math.max(...section.spans.map(spanMaxLine)),
    }];
  });
}

/* ─────────────────────────────────────────────────────────────────
 * A2 — WATERMARK EXCISION (applied to SLICED text, never stored lines)
 * ───────────────────────────────────────────────────────────────── */

export const WATERMARK_LEXICON = SHARED_FURNITURE_LEXICON;

const WATERMARK_FAST_RE = SHARED_FURNITURE_FAST_RE;
const PRESENTATION_FORM_RE = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;

function excisePresentationFormWatermarks(input: string): { text: string; count: number } {
  if (!PRESENTATION_FORM_RE.test(input)) return { text: input, count: 0 };
  const view = matchingView(input);
  if (!/مرکز|kanoon|medu|https?:|ادامه|صفحه|"/iu.test(view.text)) return { text: input, count: 0 };
  const spans: Array<[number, number]> = [];
  for (const re of WATERMARK_LEXICON) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const copy = new RegExp(re.source, flags);
    for (const m of view.text.matchAll(copy)) {
      if (m.index === undefined) continue;
      const rawStart = view.originalOffset(m.index);
      const rawEnd = view.originalOffset(m.index + m[0].length);
      if (rawEnd > rawStart) spans.push([rawStart, rawEnd]);
    }
  }
  const guillemetCopy = new RegExp(
    MATCHING_VIEW_GUILLEMET_ORDINAL_RE.source,
    MATCHING_VIEW_GUILLEMET_ORDINAL_RE.flags,
  );
  for (const m of view.text.matchAll(guillemetCopy)) {
    if (m.index === undefined) continue;
    const rawStart = view.originalOffset(m.index);
    const rawEnd = view.originalOffset(m.index + m[0].length);
    if (
      rawEnd > rawStart &&
      (input[rawStart] === '«' || input[rawStart] === '»') &&
      (input[rawEnd - 1] === '«' || input[rawEnd - 1] === '»')
    ) {
      spans.push([rawStart, rawEnd]);
    }
  }
  if (!spans.length) return { text: input, count: 0 };
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let out = input;
  for (let i = merged.length - 1; i >= 0; i--) {
    const [s, e] = merged[i];
    out = out.slice(0, s) + out.slice(e);
  }
  return { text: out, count: merged.length };
}

export function exciseWatermarks(text: string): { text: string; excised: boolean; count: number } {
  if (!WATERMARK_FAST_RE.test(text)) {
    const clean = /[ \t\r\n\u200c\u200d]{2}|^\s|\s$/.test(text)
      ? text.replace(/[ \u200c\u200d]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim()
      : text;
    return { text: clean, excised: false, count: 0 };
  }
  let out = text;
  let count = 0;
  const pf = excisePresentationFormWatermarks(out);
  if (pf.count > 0) {
    out = pf.text;
    count += pf.count;
  }
  for (const re of WATERMARK_LEXICON) {
    re.lastIndex = 0;
    const matches = out.match(re);
    if (matches) count += matches.length;
    out = out.replace(re, '');
  }
  if (count === 0) {
    const clean = /[ \t\r\n\u200c\u200d]{2}|^\s|\s$/.test(text)
      ? text.replace(/[ \u200c\u200d]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim()
      : text;
    return { text: clean, excised: false, count: 0 };
  }
  out = out.replace(/[ \u200c\u200d]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { text: out, excised: true, count };
}

export function exciseWatermarksWithLearned(text: string, learned: string[]): { text: string; excised: boolean; count: number } {
  if ((!learned || learned.length === 0) && !WATERMARK_FAST_RE.test(text)) {
    const clean = /[ \t\r\n\u200c\u200d]{2}|^\s|\s$/.test(text)
      ? text.replace(/[ \u200c\u200d]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim()
      : text;
    return { text: clean, excised: false, count: 0 };
  }
  let out = text;
  let count = 0;
  const pf = excisePresentationFormWatermarks(out);
  if (pf.count > 0) {
    out = pf.text;
    count += pf.count;
  }
  for (const re of WATERMARK_LEXICON) {
    re.lastIndex = 0;
    const matches = out.match(re);
    if (matches) count += matches.length;
    out = out.replace(re, '');
  }
  for (const sub of learned || []) {
    if (!sub || sub.length < 12) continue;
    const esc = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc, 'gi');
    const matches = out.match(re);
    if (matches) count += matches.length;
    out = out.replace(re, '');
  }
  if (count === 0) {
    const clean = /[ \t\r\n\u200c\u200d]{2}|^\s|\s$/.test(text)
      ? text.replace(/[ \u200c\u200d]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim()
      : text;
    return { text: clean, excised: false, count: 0 };
  }
  out = out.replace(/[ \u200c\u200d]{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { text: out, excised: true, count };
}

/** Per-doc learned excision list: substrings ≥12 chars appearing inside lines on ≥40% of pages.
 * Conservative: only learns substrings that look like watermarks (URL/kanoon/aee/مرکز/ادامه etc.),
 * otherwise returns empty. Generic English phrases that happen to repeat across pages must NOT be learned. */
export function computeLearnedWatermarks(lines: SourceLine[], pages: number): string[] {
  if (pages < 2 || lines.length < 10) return [];
  // Only consider phrases that contain watermark-indicative tokens; otherwise learning generic
  // phrases like "What is" would incorrectly strip question content (seen in Iranian fixture).
  const WATERMARK_HINT = /(?:www|kanoon|\.ir\b|aee|medu|https?:|مرکز|سنجش|پایش|کیفیت|آموزشی|ادامه\s*سوالات)/i;
  const phraseCounts = new Map<string, Set<number>>();
  for (const line of lines) {
    const t = normalizeStoredText(line.text);
    if (t.length < 12) continue;
    if (!WATERMARK_HINT.test(t)) continue;
    const words = t.split(/\s+/).filter(w => w.length >= 3);
    for (let n = 2; n <= 3 && n <= words.length; n++) {
      for (let i = 0; i <= words.length - n; i++) {
        const phrase = words.slice(i, i + n).join(' ');
        if (phrase.length < 12) continue;
        if (!WATERMARK_HINT.test(phrase)) continue;
        const set = phraseCounts.get(phrase) || new Set<number>();
        set.add(line.page);
        phraseCounts.set(phrase, set);
      }
    }
  }
  if (phraseCounts.size === 0) return [];
  const threshold = Math.ceil(pages * 0.4);
  const learned: string[] = [];
  for (const [phrase, pagesSet] of phraseCounts) {
    if (pagesSet.size >= threshold) {
      const insideCount = lines.filter(l => {
        const t = normalizeStoredText(l.text);
        const idx = t.indexOf(phrase);
        return idx > 0 && idx + phrase.length < t.length - 1;
      }).length;
      if (insideCount >= 2) learned.push(phrase);
    }
    if (learned.length >= 10) break;
  }
  return learned;
}

/* ─────────────────────────────────────────────────────────────────
 * A3 — LINE QUALITY SCORE
 * ───────────────────────────────────────────────────────────────── */
export interface LineQualityScore {
  line: number;
  score: number; // 0-100, lower = more garbled
  signals: { scriptMix: number; replacement: number; presentation: number; watermark: number; lengthOutlier: boolean };
  garbled: boolean;
}

export function computeLineQuality(lines: SourceLine[]): LineQualityScore[] {
  const out: LineQualityScore[] = [];
  const lengths = lines.map(l => l.text.length).filter(n => n > 0).sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  for (const line of lines) {
    const n = lineNumber(line);
    const text = line.text;
    const tokens = text.split(/\s+/).filter(Boolean);
    let scriptMix = 0;
    for (const tok of tokens) {
      const arabic = /[\u0600-\u06FF]/.test(tok);
      const latin = /[A-Za-z]/.test(tok);
      if (arabic && latin && tok.length >= 4) scriptMix++;
    }
    const scriptMixRatio = tokens.length ? scriptMix / tokens.length : 0;
    const replacement = (text.match(/\uFFFD/g) || []).length;
    const presentation = (text.match(/[\uFE80-\uFEFF\uFB50-\uFDFF]/g) || []).length;
    const watermark = /kanoon|www[.\-]|aee\.medu\.ir|ادامه سوالات/i.test(text) ? 1 : 0;
    const lengthOutlier = median > 0 && (text.length > median * 3 || (text.length < 5 && tokens.length === 1 && /[^\w\s]/.test(text)));
    let score = 100;
    score -= scriptMixRatio * 40;
    score -= replacement * 20;
    score -= presentation * 5;
    score -= watermark * 10;
    if (lengthOutlier) score -= 10;
    score = Math.max(0, Math.min(100, Math.round(score)));
    const garbled = score < 70 || scriptMixRatio >= 0.3 || replacement > 0;
    out.push({ line: n, score, signals: { scriptMix: scriptMixRatio, replacement, presentation, watermark, lengthOutlier }, garbled });
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────
 * C1 — HARD INVARIANTS GATE
 * ───────────────────────────────────────────────────────────────── */
export interface InvariantViolation {
  code: string; // I1..I10
  message: string;
  questionId?: string;
  severity: 'error' | 'warn';
}

export function isCanonicalTrueFalsePair(options?: Question['options']): boolean {
  if (!options || options.length !== 2) return false;
  const a = normalizeForMatching(options[0].text || '').trim().toLowerCase();
  const b = normalizeForMatching(options[1].text || '').trim().toLowerCase();
  if (!a || !b || a === b) return false;
  const tfPole = (s: string): 't' | 'f' | null => {
    if (/^(?:true|t|درست|صحیح|ص)$/iu.test(s)) return 't';
    if (/^(?:false|f|نادرست|غلط|غ)$/iu.test(s)) return 'f';
    return null;
  };
  const pa = tfPole(a);
  const pb = tfPole(b);
  return pa !== null && pb !== null && pa !== pb;
}

export function validateExamInvariants(doc: ExamDoc): { ok: boolean; violations: InvariantViolation[]; flags: Flag[] } {
  const violations: InvariantViolation[] = [];
  const flags: Flag[] = [];
  const watermarkRe = new RegExp(WATERMARK_LEXICON.map(r => r.source).join('|'), 'i');
  const questionById = new Map((doc.questions || []).map(q => [q.id, q]));

  // I1 no question with hollow stem (STEM_SUBSTANCE rules) — len<6 or matching/diagram+image or non-hollow parent waived
  for (const q of doc.questions || []) {
    if (!q.stem || q.stem.trim().length < 6) {
      const parent = q.parentId ? questionById.get(q.parentId) : undefined;
      const inheritedFromParent = Boolean(parent && parent.stem && parent.stem.trim().length >= 6);
      if (inheritedFromParent) {
        // Group children such as "(16)" inherit group context from their non-hollow parent.
      } else if (q.type === 'matching' || q.type === 'diagram') {
        // allow via images check later
      } else if ((q.images || []).length === 0) {
        violations.push({ code: 'I1', message: `Q${q.no} hollow stem`, questionId: q.id, severity: 'error' });
        flags.push({ id: `flag_I1_${q.id}`, code: 'INVARIANT_I1_HOLLOW_STEM', severity: 'error', message: `Q${q.no} has hollow stem`, questionId: q.id });
      }
    }
  }
  // I2 every mcq has ≥2 distinct options; truefalse exactly the pair
  for (const q of doc.questions || []) {
    if (q.type === 'mcq') {
      const opts = (q.options || []).filter(o => (o.text || '').trim().length >= 2);
      const distinct = new Set(opts.map(o => normalizeForMatching(o.text || ''))).size;
      if (opts.length < 2 || distinct < 2) {
        violations.push({ code: 'I2', message: `Q${q.no} mcq need ≥2 distinct options got ${opts.length}`, questionId: q.id, severity: 'error' });
        flags.push({ id: `flag_I2_${q.id}`, code: 'INVARIANT_I2_MCQ_OPTIONS', severity: 'error', message: `Q${q.no} mcq requires ≥2 distinct options`, questionId: q.id });
      }
    }
    if (q.type === 'truefalse') {
      if ((q.options || []).length !== 2) {
        violations.push({ code: 'I2', message: `Q${q.no} truefalse must have exactly 2 options`, questionId: q.id, severity: 'error' });
        flags.push({ id: `flag_I2_${q.id}`, code: 'INVARIANT_I2_TF_OPTIONS', severity: 'error', message: `Q${q.no} truefalse must carry True/False pair`, questionId: q.id });
      }
    }
  }
  // I3 no option/stem/answer contains an excisable watermark substring
  for (const q of doc.questions || []) {
    const texts = [q.stem || '', ...((q.options || []).map(o => o.text || '')), q.answer?.text || ''];
    for (const t of texts) {
      if (watermarkRe.test(t)) {
        violations.push({ code: 'I3', message: `Q${q.no} contains watermark`, questionId: q.id, severity: 'error' });
        flags.push({ id: `flag_I3_${q.id}`, code: 'INVARIANT_I3_WATERMARK', severity: 'error', message: `Q${q.no} text contains excisable watermark`, questionId: q.id });
        break;
      }
    }
    watermarkRe.lastIndex = 0;
  }
  // I4 every question's points is a NUMBER (no null/undefined)
  for (const q of doc.questions || []) {
    if (typeof q.points !== 'number' || !Number.isFinite(q.points)) {
      violations.push({ code: 'I4', message: `Q${q.no} points is not a number`, questionId: q.id, severity: 'error' });
      flags.push({ id: `flag_I4_${q.id}`, code: 'INVARIANT_I4_POINTS_NUMBER', severity: 'error', message: `Q${q.no} points must be a number`, questionId: q.id });
    }
  }
  // I5 points sum vs meta.totalPoints within 0.51
  const rootSum = (doc.questions || []).filter(q => !q.parentId).reduce((s, q) => s + (q.points || 0), 0);
  const total = doc.meta?.totalPoints;
  if (typeof total === 'number' && Math.abs(rootSum - total) > 0.51) {
    violations.push({ code: 'I5', message: `points sum ${rootSum} vs meta ${total} diff >0.51`, severity: 'error' });
    flags.push({ id: 'flag_I5', code: 'INVARIANT_I5_POINTS_SUM', severity: 'error', message: `Points sum ${rootSum} differs from meta total ${total} by >0.51` });
  }
  // I6 image ids unique; every question imageRef resolves to an asset
  const seenIds = new Set<string>();
  for (const img of doc.images || []) {
    if (seenIds.has(img.id)) {
      violations.push({ code: 'I6', message: `duplicate image id ${img.id}`, severity: 'error' });
      flags.push({ id: `flag_I6_dup_${img.id}`, code: 'INVARIANT_I6_DUP_IMAGE_ID', severity: 'error', message: `Duplicate image id ${img.id}` });
    }
    seenIds.add(img.id);
  }
  const assetIds = new Set((doc.images || []).map(i => i.id));
  for (const q of doc.questions || []) {
    for (const ref of q.images || []) {
      if (!assetIds.has(ref.imageId)) {
        violations.push({ code: 'I6', message: `Q${q.no} imageRef ${ref.imageId} does not resolve`, questionId: q.id, severity: 'error' });
        flags.push({ id: `flag_I6_${q.id}_${ref.imageId}`, code: 'INVARIANT_I6_IMAGE_REF', severity: 'error', message: `Q${q.no} references missing image ${ref.imageId}`, questionId: q.id });
      }
    }
  }
  // I7 sections ordered by index; every question's sectionId exists
  const sectionIds = new Set((doc.sections || []).map(s => s.id));
  const indices = (doc.sections || []).map(s => s.index);
  for (let i = 1; i < indices.length; i++) if (indices[i] <= indices[i - 1]) {
    violations.push({ code: 'I7', message: `sections not ordered by index`, severity: 'error' });
    flags.push({ id: 'flag_I7_order', code: 'INVARIANT_I7_SECTION_ORDER', severity: 'error', message: `Sections not ordered by index` });
    break;
  }
  for (const q of doc.questions || []) {
    if (q.sectionId && !sectionIds.has(q.sectionId)) {
      violations.push({ code: 'I7', message: `Q${q.no} sectionId ${q.sectionId} not found`, questionId: q.id, severity: 'error' });
      flags.push({ id: `flag_I7_${q.id}`, code: 'INVARIANT_I7_SECTION_EXISTS', severity: 'error', message: `Q${q.no} section ${q.sectionId} not found`, questionId: q.id });
    }
  }
  // I8 no two questions share same printed number unless one is group child of other
  const byNo = new Map<number, Question[]>();
  for (const q of doc.questions || []) {
    if (!byNo.has(q.no)) byNo.set(q.no, []);
    byNo.get(q.no)!.push(q);
  }
  for (const [no, list] of byNo) if (list.length > 1) {
    // Allow if one is parent of other
    const parentIds = new Set(list.map(q => q.id));
    const isParentChild = list.some(q => q.parentId && parentIds.has(q.parentId));
    if (!isParentChild) {
      violations.push({ code: 'I8', message: `duplicate printed number ${no} without parent-child`, severity: 'error' });
      flags.push({ id: `flag_I8_${no}`, code: 'INVARIANT_I8_DUP_NUMBER', severity: 'error', message: `Duplicate printed number ${no} without parent-child relation` });
    }
  }
  // I9 matching children share parent's option pool object (no per-child A/B pseudo-options)
  // Simplified check: if child has parentId and parent has options, child should not have own options that are pseudo A/B
  for (const q of doc.questions || []) if (q.parentId) {
    const parent = (doc.questions || []).find(p => p.id === q.parentId);
    if (parent && parent.options && q.options && q.options.length > 0) {
      // If parent has pool and child has per-child options with same keys, violation
      if (parent.options.length >= 2 && q.options.length >= 2) {
        violations.push({ code: 'I9', message: `Q${q.no} child has per-child options but parent pool exists`, questionId: q.id, severity: 'error' });
        flags.push({ id: `flag_I9_${q.id}`, code: 'INVARIANT_I9_SHARED_POOL', severity: 'error', message: `Matching child Q${q.no} should share parent pool, not per-child options`, questionId: q.id });
      }
    }
  }
  // I10 expected-coverage computed (missing list may be non-empty ONLY if doc is marked partial)
  // This invariant is informational; partial handling done at save boundary. We flag if missing non-empty and not partial.
  const expected = doc.source?.expectedQuestionNos || [];
  if (expected.length) {
    const parsedNos = new Set((doc.questions || []).filter(q => !q.parentId).map(q => q.no));
    // also children count? For group enumeration, children cover enumeration; already handled in getExamHealth but simplify
    const missing = expected.filter(n => !parsedNos.has(n));
    const isPartial = (doc as any).partial === true || doc.flags?.some(f => f.code === 'PARTIAL_EXAM');
    if (missing.length && !isPartial) {
      // Not error by itself; will become error if I10 enforced strictly? Spec says missing may be non-empty ONLY if partial.
      // So violation if not partial.
      violations.push({ code: 'I10', message: `missing expected numbers ${missing.join(',')} but not marked partial`, severity: 'warn' });
      flags.push({ id: 'flag_I10', code: 'INVARIANT_I10_COVERAGE', severity: 'warn', message: `Missing questions ${missing.join(',')} require partial marking` });
    }
  }
  // I11 question number matches printed number in its first span line (unless legitimate group/intra-line child)
  if ((doc.source?.lines || []).length > 0) {
    const srcByNo = new Map((doc.source?.lines || []).map(l => [lineNumber(l), l]));
    for (const q of doc.questions || []) {
      const firstLineNo = q.spans?.[0] ? spanMinLine(q.spans[0]) : undefined;
      if (!firstLineNo) continue;
      const firstLine = srcByNo.get(firstLineNo);
      if (!firstLine || firstLine.furniture) continue;
      const printedFirst = parseStartNumber(firstLine.text);
      if (printedFirst === undefined || printedFirst === q.no) continue;
      if (q.parentId) {
        const spanLines: SourceLine[] = [];
        for (const sp of q.spans || []) {
          const s = spanMinLine(sp);
          const e = spanMaxLine(sp);
          for (let n = s; n <= e; n++) {
            const ln = srcByNo.get(n);
            if (ln) spanLines.push(ln);
          }
        }
        const spanNos = enumerateExpectedQuestionNos(spanLines).numbers;
        if (spanNos.includes(q.no)) continue;
      }
      violations.push({ code: 'I11', message: `Q${q.no} first span line L${firstLineNo} prints ${printedFirst} !== ${q.no}`, questionId: q.id, severity: 'error' });
      flags.push({ id: `flag_I11_${q.id}`, code: 'INVARIANT_I11_NUMBER_SLIP', severity: 'error', message: `Q${q.no} first span line prints ${printedFirst}, not ${q.no}`, questionId: q.id });
    }
  }
  // I12 Part B3: fast question-only invariant check
  const i12 = checkInvariantI12(doc.questions || []);
  violations.push(...i12.violations);
  flags.push(...i12.flags);
  const ok = violations.filter(v => v.severity === 'error').length === 0;
  return { ok, violations, flags };
}

/**
 * Part B3 — Fast O(Q) check for Assembly Invariant I12:
 * - No question may reference itself as parent
 * - No two options of one question may have identical normalized text unless type is truefalse and pair is canonical
 * - No option may include its whole stem text
 * - No sibling questions may share an identical normalized stem
 */
export function checkInvariantI12(questions: Question[]): { violations: InvariantViolation[]; flags: Flag[] } {
  const violations: InvariantViolation[] = [];
  const flags: Flag[] = [];
  for (const q of questions || []) {
    if (q.parentId === q.id) {
      violations.push({ code: 'I12', message: `Q${q.no} cannot be its own parent`, questionId: q.id, severity: 'error' });
      flags.push({ id: `flag_I12_self_parent_${q.id}`, code: 'INVARIANT_I12_SELF_PARENT', severity: 'error', message: `Q${q.no} references itself as parent`, questionId: q.id });
    }
    const opts = q.options || [];
    if (opts.length >= 2) {
      if (q.type === 'truefalse' && isCanonicalTrueFalsePair(opts)) {
        // Canonical TF pair is valid by definition.
      } else {
        const normOpts = opts
          .map(o => normalizeForMatching(o.text || '').replace(/\s+/g, ' ').trim().toLowerCase())
          .filter(Boolean);
        const normStem = normalizeForMatching(q.stem || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const hasDupOpt = normOpts.length >= 2 && new Set(normOpts).size < normOpts.length;
        const optContainsWholeStem = normStem.length >= 8 && normOpts.some(t => t === normStem || t.includes(normStem));
        if (hasDupOpt || optContainsWholeStem) {
          violations.push({
            code: 'I12',
            message: hasDupOpt
              ? `Q${q.no} has identical normalized option texts`
              : `Q${q.no} option includes whole stem text`,
            questionId: q.id,
            severity: 'error',
          });
          flags.push({
            id: `flag_I12_opt_${q.id}`,
            code: 'INVARIANT_I12_DUPLICATE_OPTIONS',
            severity: 'error',
            message: `Q${q.no} options are not distinct / clean of stem`,
            questionId: q.id,
          });
        }
      }
    }
  }
  const siblingBuckets = new Map<string, Question[]>();
  for (const q of questions || []) {
    const bucketKey = q.parentId ? `parent:${q.parentId}` : `root:${q.sectionId || '__default__'}`;
    const list = siblingBuckets.get(bucketKey) || [];
    list.push(q);
    siblingBuckets.set(bucketKey, list);
  }
  for (const siblings of siblingBuckets.values()) {
    if (siblings.length < 2) continue;
    const seenStems = new Map<string, Question>();
    const flaggedSiblingIds = new Set<string>();
    for (const q of siblings) {
      const normStem = normalizeForMatching(q.stem || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!normStem) continue;
      const first = seenStems.get(normStem);
      if (first) {
        if (!flaggedSiblingIds.has(first.id)) {
          flaggedSiblingIds.add(first.id);
          violations.push({
            code: 'I12',
            message: `Q${first.no} shares identical stem with sibling Q${q.no}`,
            questionId: first.id,
            severity: 'error',
          });
          flags.push({
            id: `flag_I12_sib_${first.id}`,
            code: 'INVARIANT_I12_SIBLING_IDENTICAL_STEM',
            severity: 'error',
            message: `Q${first.no} shares an identical stem with sibling Q${q.no}`,
            questionId: first.id,
          });
        }
        flaggedSiblingIds.add(q.id);
        violations.push({
          code: 'I12',
          message: `Q${q.no} shares identical stem with sibling Q${first.no}`,
          questionId: q.id,
          severity: 'error',
        });
        flags.push({
          id: `flag_I12_sib_${q.id}`,
          code: 'INVARIANT_I12_DUPLICATE_SIBLING_STEM',
          severity: 'error',
          message: `Q${q.no} shares identical stem with sibling Q${first.no}`,
          questionId: q.id,
        });
      } else {
        seenStems.set(normStem, q);
      }
    }
  }
  return { violations, flags };
}

/** Printed numbers of the questions implicated by violations (for banners and export issues). */
export function invariantViolationQuestionNos(doc: ExamDoc, violations: InvariantViolation[]): number[] {
  const nos: number[] = [];
  for (const violation of violations) {
    if (!violation.questionId) continue;
    const question = (doc.questions || []).find(item => item.id === violation.questionId);
    if (question && typeof question.no === 'number' && !nos.includes(question.no)) nos.push(question.no);
  }
  return nos.sort((left, right) => left - right);
}

/**
 * Save-boundary demotion (C2): invariant errors NEVER reject a save. They mark the
 * document visibly PARTIAL — persisted `partial` marker plus a PARTIAL_EXAM flag that
 * names the violating codes and printed question numbers. Completeness/export
 * affordances read this marker; the user's work is always persisted.
 * Idempotent: an existing PARTIAL_EXAM flag is updated in place, never duplicated.
 */
export function markPartialForInvariantViolations(doc: ExamDoc, violations: InvariantViolation[]): ExamDoc {
  const errors = violations.filter(violation => violation.severity === 'error');
  if (errors.length === 0) return doc;
  const codes = [...new Set(errors.map(violation => violation.code))];
  const nos = invariantViolationQuestionNos(doc, errors);
  const scope = nos.length ? `questions ${nos.join(', ')}` : 'document-level checks';
  const message = `Partial exam: invariant violation(s) [${codes.join(', ')}] on ${scope}. Saved for review; export requires confirmation.`;
  const flags: Flag[] = [...(doc.flags || [])];
  const index = flags.findIndex(flag => flag.code === 'PARTIAL_EXAM');
  const demoted: Flag = {
    id: index >= 0 ? flags[index].id : 'flag_PARTIAL_EXAM',
    code: 'PARTIAL_EXAM',
    severity: 'warn',
    message,
    ...(nos.length === 1 ? { questionId: errors.find(violation => violation.questionId)?.questionId } : {}),
  };
  if (index >= 0) flags[index] = { ...flags[index], ...demoted };
  else flags.push(demoted);
  doc.flags = flags;
  doc.partial = true;
  return doc;
}

/** Stable optimistic-concurrency fingerprint; transient object URLs and usage are not exam content. */
export function examContentRevision(doc: ExamDoc): string {
  return JSON.stringify([doc.questions, doc.sections, (doc.images || []).map(({ dataUrl, ...image }) => image), doc.meta, doc.displayName, doc.nameSource, doc.flags, { lines: doc.source?.lines, expectedQuestionNos: doc.source?.expectedQuestionNos, keyTerritoryLineNos: doc.source?.keyTerritoryLineNos }]);
}
