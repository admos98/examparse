/** Deterministic completeness, key-territory, and exam-health helpers. */
import { ExamDoc, ExamSection, ImageAsset, Question, SourceLine } from '../types';
import { buildQuestionTree } from '../utils/questionTree';

const DIGIT_MAP: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

export function normalizeDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, digit => DIGIT_MAP[digit] || digit);
}

export function lineNumber(line: SourceLine): number {
  const n = Number(String(line.id).replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const KEY_MARKER = /^\s*(?:(?:official|suggested)\s+)?(?:راهنمای\s*تصحیح|کلید\s*پاسخ|marking\s*guide|answer\s*key)(?:\s*(?:[:：\-–—|]\s*.{0,80}|\b(?:for|of)\b.{0,70}))?\s*$/i;

function isKeyMarker(text: string): boolean {
  const value = normalizeDigits(text).trim();
  return value.length <= 120 && !/[?؟]/.test(value) && KEY_MARKER.test(value);
}

export interface KeyTerritory {
  markerLine?: number;
  lineNos: Set<number>;
}

/** A standalone answer-key heading starts key territory at its own line, not the page start. */
export function detectKeyTerritory(lines: SourceLine[]): KeyTerritory {
  const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  let markerLine: number | undefined;
  for (const line of sorted) {
    const n = lineNumber(line);
    if (isKeyMarker(line.text)) markerLine = markerLine === undefined ? n : Math.min(markerLine, n);
  }
  const lineNos = new Set<number>();
  if (markerLine !== undefined) {
    for (const line of sorted) if (lineNumber(line) >= markerLine) lineNos.add(lineNumber(line));
  }
  return { markerLine, lineNos };
}

function parseStartNumber(text: string): number | undefined {
  const normalized = normalizeDigits(text);
  const direct = normalized.match(/^\s*(\d{1,3})\s*(?:[.)]\s+|[-–—:：]\s*)\S/);
  if (direct) return Number(direct[1]);
  // OCR may join a Persian/Arabic instruction lead-in to the printed number.
  const prefixed = normalized.match(/^\s*[\p{Script=Arabic}\p{M}\s،؛:,-]{1,100}?\s(\d{1,3})\s*(?:[.)]\s+|[-–—:：]\s*)\S/u);
  if (prefixed) return Number(prefixed[1]);
  return undefined;
}

export interface ExpectedQuestions {
  numbers: number[];
  lineByNumber: Map<number, number>;
  keyTerritory: KeyTerritory;
}

export function enumerateExpectedQuestionNos(lines: SourceLine[]): ExpectedQuestions {
  const keyTerritory = detectKeyTerritory(lines);
  const lineByNumber = new Map<number, number>();
  for (const line of lines) {
    const lineNo = lineNumber(line);
    if (keyTerritory.lineNos.has(lineNo)) continue;
    const n = parseStartNumber(line.text);
    if (n === undefined || n < 1 || n > 300) continue;
    // Keep the first occurrence; repeats are reported as model/output duplicates, not new expected items.
    if (!lineByNumber.has(n)) lineByNumber.set(n, lineNo);
  }
  return { numbers: [...lineByNumber.keys()].sort((a, b) => a - b), lineByNumber, keyTerritory };
}

export function parsePrintedNumberFromStem(stem?: string): number | undefined {
  if (!stem) return undefined;
  const match = normalizeDigits(stem).match(/^\s*(\d{1,3})\s*(?:[.)]\s+|[-–—:：]\s*|[.)]$)/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return n >= 1 && n <= 300 ? n : undefined;
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
  const coverage = evaluateCoverage(expected, doc.questions || [], doc.meta?.totalPoints);
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
