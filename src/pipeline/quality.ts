/** Deterministic completeness, key-territory, and exam-health helpers. */
import { ExamDoc, ExamSection, ImageAsset, Question, SourceLine } from '../types';
import { buildQuestionTree } from '../utils/questionTree';

/** Matching/indexing ONLY. Never assign this result to source text or rendered fields. */
export function normalizeForMatching(text: string): string {
  const letters: Record<string, string> = { 'ي': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ؤ': 'و', 'ئ': 'ی', 'ى': 'ی' };
  const punctuation: Record<string, string> = { '؟': '?', '،': ',', '؛': ';', '«': '"', '»': '"', '–': '-', '—': '-' };
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
export function enumerateExpectedQuestionNos(lines: SourceLine[]): ExpectedQuestions {
  const keyTerritory = detectKeyTerritory(lines);
  const lineByNumber = new Map<number, number>();
  for (const line of lines) {
    if (line.furniture || keyTerritory.lineNos.has(lineNumber(line))) continue;
    const value = normalizeForMatching(line.text);
    const candidates: number[] = [];
    const leading = parseStartNumber(value); if (leading !== undefined) candidates.push(leading);
    // Explicit grouped labels and dotted dialogue slots are not years, times or fractions.
    for (const m of value.matchAll(/\((\d{1,3})\)|(?:\.{2,}|…+)(\d{1,3})(?=\.{2,}|…+)/g)) candidates.push(Number(m[1] || m[2]));
    // Multiple printed items on one line require an option marker, avoiding prose numbers.
    for (const m of value.matchAll(/(?:^|\s)(\d{1,3})[.)]\s+(?=(?:[a-h][).:]|\([a-h]\)|(?:الف|ب|ج|د)[).])\s)/g)) candidates.push(Number(m[1]));
    for (const n of candidates) if (n >= 1 && n <= 300 && !lineByNumber.has(n)) lineByNumber.set(n, lineNumber(line));
  }
  return { numbers: [...lineByNumber.keys()].sort((a, b) => a - b), lineByNumber, keyTerritory };
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

export function evaluateCoverage(
  expectedNumbers: number[],
  questions: Array<Pick<Question, 'no' | 'stem' | 'points'>>,
  totalPoints?: number
): CoverageResult {
  const expected = [...new Set(expectedNumbers)].sort((a, b) => a - b);
  const values = questions.map(q => parsePrintedNumberFromStem(q.stem) ?? Number(q.no)).filter(n => Number.isFinite(n) && n >= 1 && n <= 300);
  const counts = new Map<number, number>();
  for (const n of values) counts.set(n, (counts.get(n) || 0) + 1);
  const parsedNumbers = [...counts.keys()].sort((a, b) => a - b);
  const missing = expected.filter(n => !counts.has(n));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([n]) => n).sort((a, b) => a - b);
  const pointsParsed = questions.reduce((sum, q) => sum + (Number(q.points) || 0), 0);
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
  const coverage = evaluateCoverage(expected, contentQuestions, doc.meta?.totalPoints);
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
    expectedCount: expected.length || coverage.parsedNumbers.length,
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
