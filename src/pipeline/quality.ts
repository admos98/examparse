/** Deterministic completeness, key-territory, and exam-health helpers. */
import { ExamDoc, ExamSection, ImageAsset, Question, SourceLine } from '../types';
import { buildQuestionTree } from '../utils/questionTree';

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

/** Offsets into the ORIGINAL, including NFKC expansions, marks and joiners. */
export function matchingView(text: string): { text: string; originalOffset: (offset: number) => number } {
  const starts: number[] = []; const ends: number[] = []; let copy = '';
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
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
  return { text: copy, originalOffset: offset => offset >= starts.length ? text.length : starts[Math.max(0, offset)] };
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

// Detect section headers for A2
export interface SectionHeaderCandidate { title: string; headerLine: number; kind: string; start: number; rawTitle: string }
const HEADER_KEYWORDS = [
  { re: /listening/i, title: 'Listening', kind: 'Listening' },
  { re: /vocabulary/i, title: 'Vocabulary', kind: 'Vocabulary' },
  { re: /grammar/i, title: 'Grammar', kind: 'Grammar' },
  { re: /reading/i, title: 'Reading', kind: 'Reading' },
  { re: /writing/i, title: 'Writing', kind: 'Writing' },
  { re: /use of english/i, title: 'Use of English', kind: 'Other' },
  { re: /language focus/i, title: 'Language Focus', kind: 'Other' },
  { re: /شنیداری|بخش شنیداری/i, title: 'Listening', kind: 'Listening' },
  { re: /واژگان/i, title: 'Vocabulary', kind: 'Vocabulary' },
  { re: /دستور زبان|گرامر/i, title: 'Grammar', kind: 'Grammar' },
  { re: /درک مطلب/i, title: 'Reading', kind: 'Reading' },
  { re: /نوشتاری|نگارش/i, title: 'Writing', kind: 'Writing' },
];
export function detectSectionHeaders(lines: SourceLine[]): SectionHeaderCandidate[] {
  const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  const candidates: SectionHeaderCandidate[] = [];
  for (const line of sorted) {
    if (line.furniture) continue;
    const text = line.text;
    const norm = normalizeForMatching(text);
    // Iranian layout: row-numbered header like "2 | Vocabulary | 4" or "ردیف ... Listening ..."
    // Check for pipe-separated header with known keyword
    for (const kw of HEADER_KEYWORDS) {
      if (kw.re.test(text) || kw.re.test(norm)) {
        // Heuristic: header lines are short (<80 chars) and contain keyword, not a question
        // Also check for row-number pattern: contains '|' or is near top of section
        const isQuestionLine = /^\s*(?:\(\d+\)|\d+[.)])\s+/.test(norm) && norm.length > 30;
        if (isQuestionLine) continue;
        // Also check if line is like "Section 1 Listening" etc.
        // Use isSectionHeading helper logic
        const ln = lineNumber(line);
        candidates.push({ title: kw.title, headerLine: ln, kind: kw.kind, start: ln, rawTitle: text.trim() });
        break;
      }
    }
  }
  // Deduplicate by headerLine and kind (keep first per line)
  const dedup = new Map<number, SectionHeaderCandidate>();
  for (const c of candidates) if (!dedup.has(c.headerLine)) dedup.set(c.headerLine, c);
  return [...dedup.values()].sort((a,b)=>a.headerLine-b.headerLine);
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
    for (const m of value.matchAll(/\((\d{1,3})\)|(?:\.{2,}|…+)(\d{1,3})(?=\.{2,}|…+)/g)) {
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
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([n]) => n).sort((a, b) => a - b);
  const pointsParsed = questions.reduce((sum, q) => sum + (Number((q as any).points) || 0), 0);
  const pointDeficit = totalPoints === undefined ? 0 : Number((totalPoints - pointsParsed).toFixed(2));
  const pointsMatch = totalPoints === undefined || Math.abs(pointDeficit) <= 0.51;
  const coveragePercent = expected.length === 0 ? 100 : Math.max(0, ((expected.length - missing.length) / expected.length) * 100);
  return {
    expected, parsedNumbers, missing, duplicates, pointsParsed,
    pointsExpected: totalPoints, pointDeficit, coveragePercent, pointsMatch,
    complete: missing.length === 0 && duplicates.length === 0 && pointsMatch,
  };
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
  unresolvedImageRefs: string[];
  lowConfidenceCount: number;
  parentLinkIssueCount?: number;
  coveragePercent: number;
  state: 'green' | 'amber' | 'red';
  complete: boolean;
}

export function getExamHealth(doc: ExamDoc): ExamHealth {
  const expected = doc.source?.expectedQuestionNos || enumerateExpectedQuestionNos(doc.source?.lines || []).numbers;
  const sourceLines = doc.source?.lines || [];
  const contentQuestions = (doc.questions || []).filter(q => !q.spans?.length || !sourceLines.length || q.spans.some(([a, b]) => sourceLines.some(l => !l.furniture && lineNumber(l) >= a && lineNumber(l) <= b)));
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
  const unplacedImages = (doc.images || []).filter(img => !referenced.has(img.id) && img.label?.role !== 'decoration' && img.label?.kind !== 'decoration');
  const lowConfidenceCount = (doc.questions || []).filter(q => q.confidence < 0.6).length;
  const hasCoverageProblem = coverage.missing.length > 0 || !coverage.pointsMatch;
  const hasQuestions = (doc.questions || []).length > 0;
  const hierarchy = buildQuestionTree(doc.questions || []);
  const parentLinkIssueCount = hierarchy.cycleBreaks.size + hierarchy.orphanedParents.size;
  const complete = hasQuestions && coverage.complete && unplacedImages.length === 0 && unresolved.size === 0 && parentLinkIssueCount === 0;
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
    unresolvedImageRefs: [...unresolved],
    lowConfidenceCount,
    parentLinkIssueCount,
    coveragePercent: coverage.coveragePercent,
    state: hasCoverageProblem && coverage.expected.length > 0 && coverage.coveragePercent < 80 ? 'red' : state,
    complete,
  };
}

export function isQuestionSpanKeySafe(spans: Array<[number, number]>, keyLineNos: Set<number>): boolean {
  return spans.every(([start, end]) => {
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
    for (const [start, end] of spansFor(q)) {
      const candidate = Math.min(end, bounds.end, upperBound);
      if (candidate >= Math.max(start, bounds.start)) maximum = Math.max(maximum, candidate);
    }
    return maximum;
  };
  const hints: Record<string, { questionRef: string; group: string; page: number }> = {};
  for (const img of images) {
    if (!img.anchorLine) continue;
    const line = lineByNo.get(img.anchorLine);
    const page = line?.page || img.page;
    let candidates = sortedQuestions.filter(q => spansFor(q).some(([start, end]) => img.anchorLine! >= start && img.anchorLine! <= end));
    // Prefer the parent group when it owns the containing range.
    const parentCandidate = candidates.find(q => !q.parentId);
    if (parentCandidate) candidates = [parentCandidate];
    if (!candidates.length) {
      const preceding = sortedQuestions.filter(q => !q.parentId)
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
      start: Math.min(...section.spans.map(s => s[0])),
      end: Math.max(...section.spans.map(s => s[1])),
    }];
  });
}

/** Stable optimistic-concurrency fingerprint; transient object URLs and usage are not exam content. */
export function examContentRevision(doc: ExamDoc): string {
  return JSON.stringify([doc.questions, doc.sections, (doc.images || []).map(({ dataUrl, ...image }) => image), doc.meta, doc.displayName, doc.nameSource, doc.flags, { lines: doc.source?.lines, expectedQuestionNos: doc.source?.expectedQuestionNos, keyTerritoryLineNos: doc.source?.keyTerritoryLineNos }]);
}
