/**
 * Part B — DETERMINISTIC SEGMENTATION FIRST (THE INVERSION)
 * Pure module: input = exam-territory lines (post-cleanup tags, key territory excluded)
 * output = candidate segments covering 100% of exam-territory lines.
 * No model calls.
 */
import { OffsetSpan, SourceLine } from '../types';
import { detectSectionHeaders, isReadTheTextInstruction, lineNumber, parsePrintedNumberFromStem, normalizeForMatching, normalizeStoredText, matchingView } from './quality';
import { isInstructionText, isBarePageNumber } from './cleanup';
import { headerAnchors, isSkippedLine, classifyLines } from './ownership';
import { carveGroupChildSpans } from './spans';

export type SegmentKind = 'question'|'group-parent'|'passage'|'instruction'|'header'|'unknown';

export interface IntraLineItem {
  no: number;
  marker: string;
  charStart: number;
  charEnd: number;
}

export interface Segment {
  id: string; // S1..Sn
  kind: SegmentKind;
  startLine: number;
  endLine: number;
  printedNo?: number;
  childNos?: number[];
  parentSegmentId?: string;
  charStart?: number;
  charEnd?: number;
  /** Unified Part B1 sub-line offset span for multi-number & shared-line group children. */
  offsetSpan?: OffsetSpan;
  sectionHint: string;
  lines: number[]; // inclusive line numbers
  sectionId?: string;
  /** Deterministic rule provenance for the segment, independent of the model. */
  ruleChain?: string[];
  ruleConfidence?: number;
  /** Explicit shared-context group subtype used by local canonicalization. */
  groupForm?: 'dialogue' | 'enumeration' | 'matching';
  /** Governing instruction line(s) used only as the enumerative parent's shared stem. */
  parentStemLines?: number[];
}

const INTRA_LINE_PERSIAN = 'الف|ب|پ|ت|ث|ج|چ|د|ه|و';
const INTRA_LINE_MULTI_RE = new RegExp(
  `(^|\\s)(?:\\((\\d{1,3})\\)|(\\d{1,3})\\s*[.):-])\\s*(?:\\(([a-j])\\)|([a-j])[).:]|\\((${INTRA_LINE_PERSIAN})\\)|(${INTRA_LINE_PERSIAN})[).:])(?=\\s|$)`,
  'gi',
);

/**
 * Deterministic intra-line splitter: detects lines containing ≥2 ascending `N. x)` occurrences
 * (e.g. `63. a) Ferdowsi…. 64. b) Watching TV…… 65. c) Sport……… 66. d) Clean energy…`)
 * and returns exact UTF-16 `[charStart, charEnd]` offsets into `text`.
 */
const INTRA_LINE_FAST_RE = /(?:^|\s)(?:\([0-9۰-۹٠-٩０-９]{1,3}\)|[0-9۰-۹٠-٩０-９]{1,3}\s*[.):-])\s*(?:\([a-jالفبپتثجچدهو]\)|[a-jالفبپتثجچدهو][).:])/i;

export function findIntraLineMultiNumbers(text: string): IntraLineItem[] {
  const rawStr = text || '';
  if (!rawStr || !INTRA_LINE_FAST_RE.test(rawStr)) return [];
  const view = matchingView(rawStr);
  const raw: Array<{ no: number; marker: string; origStart: number }> = [];
  INTRA_LINE_MULTI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTRA_LINE_MULTI_RE.exec(view.text))) {
    const no = Number(m[2] || m[3]);
    const marker = (m[4] || m[5] || m[6] || m[7] || '').toLowerCase();
    if (!Number.isInteger(no) || no < 1 || no > 300 || !marker) continue;
    const normStart = m.index + (m[1] || '').length;
    raw.push({ no, marker, origStart: view.originalOffset(normStart) });
  }
  if (raw.length < 2) return [];
  const ascending = raw.every((item, index) => index === 0 || item.no > raw[index - 1].no);
  const descending = raw.every((item, index) => index === 0 || item.no < raw[index - 1].no);
  if (!ascending && !descending) return [];
  const sourceOrdered = raw.map((item, index) => ({
    no: item.no,
    marker: item.marker,
    charStart: index === 0 && !rawStr.slice(0, item.origStart).trim() ? 0 : item.origStart,
    charEnd: index + 1 < raw.length ? raw[index + 1].origStart : rawStr.length,
  }));
  // Papers may lay out a numbered row right-to-left (e.g. 66, 65, 64, 63).
  // Logical parent/child order remains ascending while each offset still slices its original item.
  return sourceOrdered.sort((a, b) => a.no - b.no);
}

export interface SegmentDiagnostics {
  sectionsDetected: number;
  segmentsByKind: Record<SegmentKind, number>;
  perSection: Array<{ title: string; lines: number; expected: number; segmented: number; fallback: boolean; reason?: string }>;
  fallbackSections: string[];
  coverage: number; // 0-100
}

function isRowSubInstruction(text: string): boolean {
  if (isReadTheTextInstruction(text)) return true;
  const norm = normalizeForMatching(text).trim();
  if (!norm || norm.length > 240) return false;
  const iranianSubInstructionRe = /(?:کامل\s+کنید|پاسخ\s+دهید|انتخاب\s+کنید|بنویسید|مشخص\s+کنید|پیدا\s+کنید|مرتب\s+کنید|وصل\s+کنید)/u;
  return /^(?:[الفبپتجد]\s*[).\-:]|\d{1,2}(?:\s*[./]\s*\d{1,2})?\s*\.?\s+)[\p{Script=Arabic}]/u.test(norm) && iranianSubInstructionRe.test(norm);
}

function isGroupParentLine(text: string): { isGroup: boolean; parentNo?: number; childNos: number[] } {
  const nums: number[] = [];
  for (const m of text.matchAll(/\((\d{1,3})\)/g)) nums.push(Number(m[1]));
  if (nums.length >= 2 && nums.every(n => n >= 1 && n <= 300) && /\((\d{1,3})\)\s*\((\d{1,3})\)/.test(text)) {
    return { isGroup: true, parentNo: nums[0], childNos: nums };
  }
  return { isGroup: false, childNos: [] };
}

interface NumberedBlankItem extends IntraLineItem {
  lineNo: number;
}

function findNumberedBlankItems(lines: SourceLine[]): NumberedBlankItem[] {
  const out: NumberedBlankItem[] = [];
  for (const line of lines) {
    const view = matchingView(line.text);
    const re = /(?:^|\s)(\d{1,3})\s*(?:(?:[.)-])\s*)?(?:…{2,}|\.{2,}|_{2,}|\(\s*\))/gu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(view.text))) {
      const no = Number(match[1]);
      if (!Number.isInteger(no) || no < 1 || no > 300) continue;
      const startNorm = match.index + match[0].indexOf(match[1]);
      const endNorm = match.index + match[0].length;
      const start = view.originalOffset(startNorm);
      const end = view.originalOffset(endNorm);
      out.push({ no, marker: 'blank', charStart: start, charEnd: Math.max(start, end), lineNo: lineNumber(line) });
    }
  }
  return out;
}

function isQuestionStart(line: SourceLine): number | undefined {
  if (isRowSubInstruction(line.text)) return undefined;
  const n = parsePrintedNumberFromStem(line.text);
  if (n !== undefined) return n;
  const v = normalizeForMatching(line.text).trim();
  const m = v.match(/^\(?(\d{1,3})\)?\s*[.)\-:]/);
  if (m) {
    const num = Number(m[1]);
    if (num >= 1 && num <= 300) return num;
  }
  return undefined;
}

function isPassageCandidate(line: SourceLine): boolean {
  if (line.furniture) return false;
  if (isQuestionStart(line) !== undefined) return false;
  if (isInstructionText(line.text) || isRowSubInstruction(line.text)) return false;
  if (line.tag === 'instruction' || line.tag === 'header') return false;
  const t = line.text.trim();
  if (t.length < 15) return false;
  const norm = normalizeForMatching(t);
  if (/^\s*(?:[a-j]|[الفبپتثجچ])\s*[).]/i.test(norm)) return false;
  if (/(?:باسمه\s*تعالی|سؤالات\s+امتحان|سوالات\s+امتحان|تاریخ\s+امتحان\s*:|مرکز\s+سنجش\s+و\s+پایش|ادامه\s*(?:ی)?\s*(?:سؤالات|سوالات)?\s*در\s+صفحه|ردیف\s+سؤالات|ردیف\s+سوالات|aee\.medu\.ir|www[.-]kanoon)/iu.test(norm)) return false;
  if (/^\s*\(\d+\)/.test(t)) return false;
  return true;
}

function avgLength(lines: SourceLine[]): number {
  if (!lines.length) return 0;
  return lines.reduce((s,l)=>s+l.text.length,0)/lines.length;
}

export function segmentDocument(params: {
  lines: SourceLine[];
  keyLines?: Set<number>;
  pages?: number;
}): { segments: Segment[]; diagnostics: SegmentDiagnostics } {
  const allLines = [...params.lines].sort((a,b)=>lineNumber(a)-lineNumber(b));
  const keyLines = params.keyLines || new Set<number>();
  // exam-territory lines = not key, not skipped
  const territory = allLines.filter(l => !keyLines.has(lineNumber(l)) && !isSkippedLine(l));
  const territoryNos = new Set(territory.map(lineNumber));
  // Section boundaries: header anchors + tag header
  const headers = headerAnchors(allLines).sort((a,b)=>a.headerLine-b.headerLine);
  // Build section ranges
  interface Range { start: number; end: number; title: string; kind: string; headerLine?: number }
  const ranges: Range[] = [];
  if (!headers.length) {
    const min = territory.length ? Math.min(...territory.map(lineNumber)) : 1;
    const max = territory.length ? Math.max(...territory.map(lineNumber)) : 0;
    if (territory.length) ranges.push({ start: min, end: max, title: 'preamble', kind: 'Other' });
  } else {
    const minTerr = territory.length ? Math.min(...territory.map(lineNumber)) : headers[0].headerLine;
    if (minTerr < headers[0].headerLine) {
      ranges.push({ start: minTerr, end: headers[0].headerLine-1, title: 'preamble', kind: 'preamble' });
    }
    for (let i=0;i<headers.length;i++) {
      const h = headers[i];
      const nextStart = headers[i+1]?.headerLine;
      const end = nextStart ? nextStart-1 : (territory.length ? Math.max(...territory.map(lineNumber)) : h.headerLine);
      ranges.push({ start: h.headerLine, end, title: h.title, kind: h.kind, headerLine: h.headerLine });
    }
  }
  const segments: Segment[] = [];
  let segIdx = 1;
  const mkId = () => `S${segIdx++}`;
  // Per-section expected enumeration for diagnostics
  // We'll compute expected numbers via quality enumerate, but per section mapping
  // Simple: use global enumerate then assign per range
  // For diagnostics later
  const byNo = new Map(allLines.map(l=>[lineNumber(l), l] as const));
  // Iterate ranges in order
  for (const range of ranges) {
    const linesInRange = territory.filter(l => {
      const n = lineNumber(l);
      return n >= range.start && n <= range.end;
    }).sort((a,b)=>lineNumber(a)-lineNumber(b));
    if (!linesInRange.length) continue;
    // Header segment if applicable
    const headerLineNo = range.headerLine;
    let bodyLines = linesInRange;
    if (headerLineNo && territoryNos.has(headerLineNo)) {
      const hdrLine = byNo.get(headerLineNo)!;
      segments.push({
        id: mkId(),
        kind: 'header',
        startLine: headerLineNo,
        endLine: headerLineNo,
        sectionHint: range.title,
        lines: [headerLineNo],
        sectionId: `sec_${ranges.indexOf(range)+1}`,
      });
      bodyLines = linesInRange.filter(l=>lineNumber(l)!==headerLineNo);
      if (!bodyLines.length) continue;
    }
    // Body segmentation
    // Find question starts
    // We'll walk pointer
    let cur = 0;
    // For passage detection before first question, we need first question index
    const questionIdxSet = new Set<number>();
    for (let i=0;i<bodyLines.length;i++) {
      const line = bodyLines[i];
      const isGroup = isGroupParentLine(line.text).isGroup;
      const qn = isQuestionStart(line);
      if (isGroup || qn !== undefined) questionIdxSet.add(i);
    }
    const firstQIdx = [...questionIdxSet].sort((a,b)=>a-b)[0];
    const sectionIdForRange = `sec_${ranges.indexOf(range)+1}`;
    const isReadingSection = /reading|listening|درک|شنیداری/i.test(range.title) || /reading|listening/i.test(range.kind);
    const isInstructionAt = (idx: number) =>
      (isInstructionText(bodyLines[idx].text) || isRowSubInstruction(bodyLines[idx].text)) && !questionIdxSet.has(idx);

    // Emit contiguous non-question segments (instruction / passage / unknown) over bodyLines[fromIdx .. toIdx).
    const buildNonQuestionSegments = (fromIdx: number, toIdx: number, forcePassageEligible = false): Segment[] => {
      const out: Segment[] = [];
      let p = fromIdx;
      let sawReadPrompt = forcePassageEligible;
      while (p < toIdx) {
        if (isReadTheTextInstruction(bodyLines[p].text)) sawReadPrompt = true;
        if (isInstructionAt(p)) {
          let end = p;
          while (end < toIdx && isInstructionAt(end)) {
            if (isReadTheTextInstruction(bodyLines[end].text)) sawReadPrompt = true;
            end++;
          }
          const nums = bodyLines.slice(p, end).map(lineNumber);
          out.push({
            id: mkId(),
            kind: 'instruction',
            startLine: nums[0],
            endLine: nums[nums.length - 1],
            sectionHint: range.title,
            lines: nums,
            sectionId: sectionIdForRange,
          });
          p = end;
          continue;
        }

        const passageAllowed = isReadingSection || sawReadPrompt;
        let runEnd = p;
        while (runEnd < toIdx && isPassageCandidate(bodyLines[runEnd])) runEnd++;
        const runLen = runEnd - p;
        if (passageAllowed && runLen >= 2) {
          const runLines = bodyLines.slice(p, runEnd);
          const avg = avgLength(runLines);
          const speakerTags = runLines.map(l => /^\s*([A-Z])\s*:/i.exec(l.text.trim())?.[1]?.toUpperCase()).filter(Boolean);
          const hasSpeakerDialogue = new Set(speakerTags).size >= 2;
          const blankItems = findNumberedBlankItems(runLines);
          if (hasSpeakerDialogue && blankItems.length >= 2) {
            const parentId = mkId();
            const nums = runLines.map(lineNumber);
            out.push({
              id: parentId,
              kind: 'group-parent',
              startLine: nums[0],
              endLine: nums[nums.length - 1],
              printedNo: blankItems[0].no,
              // The first printed blank is the numbered root itself; children are the remaining blanks.
              childNos: blankItems.slice(1).map(item => item.no),
              groupForm: 'dialogue',
              sectionHint: range.title,
              lines: nums,
              sectionId: sectionIdForRange,
              ruleChain: ['dialogue-group'],
            });
            const byLine = new Map<number, NumberedBlankItem[]>();
            for (const item of blankItems) byLine.set(item.lineNo, [...(byLine.get(item.lineNo) || []), item]);
            for (const item of blankItems.slice(1)) {
              const source = byNo.get(item.lineNo)!;
              const siblingsOnLine = byLine.get(item.lineNo) || [];
              const siblingIndex = siblingsOnLine.indexOf(item);
              const charStart = siblingsOnLine.length === 1 ? 0 : siblingIndex === 0 ? 0 : siblingsOnLine[siblingIndex - 1].charEnd;
              const charEnd = siblingsOnLine.length === 1 ? source.text.length : siblingIndex + 1 < siblingsOnLine.length ? siblingsOnLine[siblingIndex + 1].charStart : source.text.length;
              out.push({
                id: `${parentId}_c${item.no}_${item.lineNo}`,
                kind: 'question',
                parentSegmentId: parentId,
                startLine: item.lineNo,
                endLine: item.lineNo,
                printedNo: item.no,
                charStart,
                charEnd,
                offsetSpan: { line: item.lineNo, start: charStart, end: charEnd },
                groupForm: 'dialogue',
                sectionHint: range.title,
                lines: [item.lineNo],
                sectionId: sectionIdForRange,
                ruleChain: ['dialogue-group-child'],
              });
            }
            p = runEnd;
            continue;
          }
          if (runLen >= 3 && (avg >= 35 || sawReadPrompt)) {
            const nums = runLines.map(lineNumber);
            out.push({
              id: mkId(),
              kind: 'passage',
              startLine: nums[0],
              endLine: nums[nums.length - 1],
              sectionHint: range.title,
              lines: nums,
              sectionId: sectionIdForRange,
              ruleChain: sawReadPrompt ? ['c3:read-the-text-passage'] : ['segment:passage'],
            });
            p = runEnd;
            continue;
          }
        }

        let unkEnd = p + 1;
        while (unkEnd < toIdx && !isInstructionAt(unkEnd) && !questionIdxSet.has(unkEnd)) {
          if (passageAllowed && toIdx - unkEnd >= 3) {
            let look = unkEnd;
            let cnt = 0;
            while (look < toIdx && isPassageCandidate(bodyLines[look])) { cnt++; look++; }
            if (cnt >= 3 && (avgLength(bodyLines.slice(unkEnd, look)) >= 35 || sawReadPrompt)) break;
          }
          unkEnd++;
        }
        const unkLines = bodyLines.slice(p, unkEnd).map(lineNumber);
        out.push({
          id: mkId(),
          kind: 'unknown',
          startLine: unkLines[0],
          endLine: unkLines[unkLines.length - 1],
          sectionHint: range.title,
          lines: unkLines,
          sectionId: sectionIdForRange,
        });
        p = unkEnd;
      }
      return out;
    };

    if (firstQIdx !== undefined && firstQIdx > 0) {
      for (const s of buildNonQuestionSegments(0, firstQIdx)) segments.push(s);
      cur = firstQIdx;
    } else if (firstQIdx === undefined) {
      for (const s of buildNonQuestionSegments(0, bodyLines.length)) segments.push(s);
      continue;
    } else {
      cur = firstQIdx;
    }

    // Second pass: build question segments while honoring hard mid-section boundaries (Part C3:
    // read-the-text instructions + following >=3 prose lines become section-owned PASSAGE segments).
    const initialQuestionSegments: Segment[] = [];
    const questionIndices = [...questionIdxSet].sort((a,b)=>a-b);
    for (let qi=0; qi<questionIndices.length; qi++) {
      const idx = questionIndices[qi];
      const nextIdx = questionIndices[qi+1];
      const endIdx = nextIdx !== undefined ? nextIdx : bodyLines.length;
      const line = bodyLines[idx];
      const groupInfo = isGroupParentLine(line.text);
      const intraMulti = findIntraLineMultiNumbers(line.text);
      const qn = isQuestionStart(line);

      // Find any hard mid-section boundary inside (idx + 1 .. endIdx):
      // 1) Read-the-text instruction (Persian/English) or Iranian row sub-instruction;
      // 2) Or inside Reading/Listening, an instruction followed by >=3 prose lines.
      let qStopIdx = endIdx;
      for (let k = idx + 1; k < endIdx; k++) {
        const cand = bodyLines[k];
        if (isReadTheTextInstruction(cand.text) || isRowSubInstruction(cand.text)) {
          qStopIdx = k;
          break;
        }
        if (isReadingSection && isInstructionAt(k)) {
          let look = k + 1;
          while (look < endIdx && isInstructionAt(look)) look++;
          let proseCnt = 0;
          while (look + proseCnt < endIdx && isPassageCandidate(bodyLines[look + proseCnt])) proseCnt++;
          if (proseCnt >= 3) {
            qStopIdx = k;
            break;
          }
        }
      }

      const linesSlice = bodyLines.slice(idx, qStopIdx).map(lineNumber);
      if (intraMulti.length >= 2) {
        const parentId = mkId();
        const lineNo = lineNumber(line);
        let governingLineNo: number | undefined;
        for (let prior = idx - 1; prior >= Math.max(0, idx - 5); prior--) {
          if (questionIdxSet.has(prior)) break;
          const priorLine = bodyLines[prior];
          if (priorLine.tag === 'instruction' || isInstructionText(priorLine.text) || isRowSubInstruction(priorLine.text)) {
            governingLineNo = lineNumber(priorLine);
            break;
          }
        }
        const parentContextText = governingLineNo ? byNo.get(governingLineNo)?.text || '' : '';
        initialQuestionSegments.push({
          id: parentId,
          kind: 'group-parent',
          startLine: linesSlice[0],
          endLine: linesSlice[linesSlice.length - 1],
          printedNo: intraMulti[0].no,
          childNos: intraMulti.slice(1).map(item => item.no),
          offsetSpan: governingLineNo ? { line: governingLineNo, start: 0, end: parentContextText.length } : undefined,
          parentStemLines: governingLineNo ? [governingLineNo] : [],
          groupForm: 'enumeration',
          sectionHint: range.title,
          lines: linesSlice,
          sectionId: sectionIdForRange,
        });
        for (const childItem of intraMulti.slice(1)) {
          initialQuestionSegments.push({
            id: `${parentId}_c${childItem.no}`,
            kind: 'question',
            parentSegmentId: parentId,
            startLine: lineNo,
            endLine: lineNo,
            printedNo: childItem.no,
            charStart: childItem.charStart,
            charEnd: childItem.charEnd,
            offsetSpan: { line: lineNo, start: childItem.charStart, end: childItem.charEnd },
            sectionHint: range.title,
            lines: [lineNo],
            sectionId: sectionIdForRange,
            groupForm: 'enumeration',
          });
        }
      } else if (groupInfo.isGroup) {
        initialQuestionSegments.push({
          id: mkId(),
          kind: 'group-parent',
          startLine: linesSlice[0],
          endLine: linesSlice[linesSlice.length-1],
          printedNo: qn ?? groupInfo.parentNo,
          childNos: groupInfo.childNos,
          groupForm: 'matching',
          sectionHint: range.title,
          lines: linesSlice,
          sectionId: sectionIdForRange,
        });
      } else if (qn !== undefined) {
        initialQuestionSegments.push({
          id: mkId(),
          kind: 'question',
          startLine: linesSlice[0],
          endLine: linesSlice[linesSlice.length-1],
          printedNo: qn,
          sectionHint: range.title,
          lines: linesSlice,
          sectionId: sectionIdForRange,
        });
      }

      if (qStopIdx < endIdx) {
        const sawRead = isReadTheTextInstruction(bodyLines[qStopIdx].text);
        for (const midSeg of buildNonQuestionSegments(qStopIdx, endIdx, sawRead)) {
          initialQuestionSegments.push(midSeg);
        }
      }
    }

    // Transform for matching pool: detect consecutive single-line questions followed by lettered block >=3 (a..j)
    const letteredPattern = /^\s*(?:[a-j]|[الفبپتثجچحخهعغفقکگلمنوهی])\s*[).:]/i;
    const isColumnHeaderB = (txt: string) => /^\s*B\s*$/u.test(txt.trim());
    const transformed: Segment[] = [];
    for (let i=0;i<initialQuestionSegments.length;i++) {
      const seg = initialQuestionSegments[i];
      if (seg.kind !== 'question' || seg.lines.length <= 1) {
        transformed.push(seg);
        continue;
      }
      const suffixStartIdx = seg.lines.findIndex((ln, idxInSeg) => {
        if (idxInSeg === 0) return false;
        const l = byNo.get(ln);
        return Boolean(l && letteredPattern.test(normalizeForMatching(l.text.trimStart())));
      });
      if (suffixStartIdx > 0) {
        // Include optional standalone "B" column header line right before the lettered pool.
        let poolSplitIdx = suffixStartIdx;
        if (poolSplitIdx > 1) {
          const prevLn = seg.lines[poolSplitIdx - 1];
          const prevLine = byNo.get(prevLn);
          if (prevLine && isColumnHeaderB(prevLine.text)) poolSplitIdx -= 1;
        }
        const letteredOnly = seg.lines.slice(suffixStartIdx);
        const poolLines = seg.lines.slice(poolSplitIdx);
        const isPool = letteredOnly.length >= 3 && letteredOnly.every(ln => {
          const l = byNo.get(ln);
          return Boolean(l && letteredPattern.test(normalizeForMatching(l.text.trimStart())));
        });
        if (isPool) {
          const itemLines = seg.lines.slice(0, poolSplitIdx);
          if (itemLines.length) {
            transformed.push({ ...seg, lines: itemLines, endLine: itemLines[itemLines.length-1] });
          }
          transformed.push({
            id: mkId(),
            kind: 'group-parent',
            startLine: poolLines[0],
            endLine: poolLines[poolLines.length-1],
            printedNo: undefined,
            childNos: [],
            sectionHint: range.title,
            lines: poolLines,
            sectionId: sectionIdForRange,
          });
          continue;
        }
      }
      transformed.push(seg);
    }
    // Push transformed segments in order
    for (const s of transformed) segments.push(s);
  }

  // Assert invariants: contiguous, non-overlapping, ordered, cover 100%
  segments.sort((a,b)=>a.startLine-b.startLine || Number(Boolean(a.parentSegmentId)) - Number(Boolean(b.parentSegmentId)) || (a.charStart ?? -1) - (b.charStart ?? -1));
  // Check coverage
  const sortedTerritoryLines = territory.map(lineNumber).sort((a,b)=>a-b);
  const covered = segments.flatMap(s=>s.lines).sort((a,b)=>a-b);
  // Deduplicate coverage check: should match sortedTerritoryLines exactly (order may differ but sets should equal)
  const territorySet = new Set(sortedTerritoryLines);
  const coveredSet = new Set(covered);
  if (territorySet.size !== coveredSet.size || [...territorySet].some(n=>!coveredSet.has(n)) || [...coveredSet].some(n=>!territorySet.has(n))) {
    // Throw bug as spec says coverage hole is thrown bug, not flag
    const missing = [...territorySet].filter(n=>!coveredSet.has(n));
    const extra = [...coveredSet].filter(n=>!territorySet.has(n));
    throw new Error(`SEGMENTER_COVERAGE_BUG: missing ${missing.slice(0,5)} extra ${extra.slice(0,5)} (territory ${sortedTerritoryLines.length} covered ${coveredSet.size})`);
  }
  // Check contiguous non-overlapping ordering on non-child root segments
  const rootSegments = segments.filter(s => !s.parentSegmentId);
  for (let i=1;i<rootSegments.length;i++) if (rootSegments[i].startLine <= rootSegments[i-1].endLine) {
    throw new Error(`SEGMENTER_OVERLAP_BUG: ${rootSegments[i-1].id} [${rootSegments[i-1].startLine}-${rootSegments[i-1].endLine}] overlaps ${rootSegments[i].id} [${rootSegments[i].startLine}-${rootSegments[i].endLine}]`);
  }

  // Rule receipts are local evidence, not model confidence. Children created from enumerations
  // carry their own segmentation rule while retaining the parent's source range.
  for (const segment of segments) {
    const isChild = Boolean(segment.parentSegmentId);
    segment.ruleChain = isChild
      ? segment.groupForm === 'dialogue' ? ['dialogue-group-child'] : segment.groupForm === 'enumeration' ? ['enumerative-group-child'] : ['multi-number-split']
      : segment.groupForm === 'dialogue' ? ['dialogue-group']
      : segment.groupForm === 'enumeration' ? ['enumerative-group']
      : segment.groupForm === 'matching' ? ['matching-group']
      : segment.kind === 'group-parent' ? ['group-parent']
      : segment.kind === 'question' ? ['question-start']
      : [`segment-${segment.kind}`];
    segment.ruleConfidence = isChild ? 90 : segment.kind === 'question' || segment.kind === 'group-parent' ? 85 : 75;
  }

  // Diagnostics per section
  const diagnostics: SegmentDiagnostics = {
    sectionsDetected: ranges.length,
    segmentsByKind: { 'question':0,'group-parent':0,'passage':0,'instruction':0,'header':0,'unknown':0 },
    perSection: [],
    fallbackSections: [],
    coverage: territory.length ? (coveredSet.size/territory.length)*100 : 100,
  };
  for (const s of segments) diagnostics.segmentsByKind[s.kind]++;

  // Need expected per section: using quality enumeration mapped
  // For simplicity, compute expected numbers per range by checking lineByNumber
  // We need to import enumerateExpectedQuestionNos dynamically? Avoid circular via direct logic using parse
  // Instead compute expected per section by counting questionStarts in territory that would be expected?
  // We'll use same question start detection as expected: lines where isQuestionStart not undefined and not groupParent? But groupParent may enumerate multiple.
  // For diagnostics, use question start count vs expected (same).
  // Simplify: expected = questionIndices count per range?
  // That's same as segmented, so fallback won't trigger. To enable fallback for number-less fixture, we need actual expected that may differ.
  // Use parse groups: expected = lines where parsePrintedNumberFromStem? For number-less, expected =0 but segmented also 0 => no fallback. We need fallback to fire on number-less: but spec says fallback firing on deliberately number-less fixture and not on Iranian golden.
  // For number-less, segmented count also 0, so not >20% diff. But spec says fallback should fire on number-less fixture. How to make it fire? Maybe check non-monotonic or zero? For number-less, there are zero expected but we have no questions; should fallback? Perhaps expected vs segmented counts per section where expected is 0 but segmented is 0 not fallback. However spec says deliberately number-less fixture should fallback. Maybe they mean section with no numbers should be considered need fallback because segmenter confidence low? Could implement fallback if expected count ===0 and territory lines > 10? Then fallback.
  // Implement: if expected ===0 and segmented ===0 and territory lines in section >5, fallback = true (number-less).
  // Also check non-monotonic: printedNos in section not monotonic increasing.

  for (const range of ranges) {
    const segsInRange = segments.filter(s => s.lines.every(n=>n>=range.start && n<=range.end) || (s.startLine>=range.start && s.startLine<=range.end));
    const segQuestionCount = segsInRange.filter(s=>s.kind==='question' || s.kind==='group-parent').length;
    // Compute expected using territory lines that are question starts? For per-section expected, count question starts in range
    // But to get "expected-enumeration count", we need quality enumeration. For now approximate as same as questionStarts in territory.
    const expected = segsInRange.filter(s=>s.kind==='question').length; // placeholder
    // Instead compute expected from lineByNumber mapping: count lines in range where isQuestionStart not undefined
    const expectedReal = bodyLinesCount(range, territory, byNo);
    // Placeholder to avoid circular
    const expectedCount = expectedReal;
    const segmentedCount = segQuestionCount;
    let fallback = false;
    let reason: string | undefined;
    if (expectedCount === 0 && territory.filter(l=>lineNumber(l)>=range.start && lineNumber(l)<=range.end).length > 10) {
      fallback = true; reason = 'number-less section';
    } else if (expectedCount > 0 && Math.abs(segmentedCount - expectedCount) / expectedCount > 0.2) {
      fallback = true; reason = `count mismatch ${segmentedCount} vs expected ${expectedCount}`;
    } else {
      // check monotonic within section
      const nums = segsInRange.filter(s=>s.printedNo!==undefined).map(s=>s.printedNo!);
      for (let i=1;i<nums.length;i++) if (nums[i] <= nums[i-1]) { fallback = true; reason='non-monotonic'; break; }
    }
    diagnostics.perSection.push({ title: range.title, lines: territory.filter(l=>lineNumber(l)>=range.start && lineNumber(l)<=range.end).length, expected: expectedCount, segmented: segmentedCount, fallback, reason });
    if (fallback) diagnostics.fallbackSections.push(range.title);
  }

  return { segments, diagnostics };
}

function bodyLinesCount(range: {start:number,end:number}, territory: SourceLine[], byNo: Map<number, SourceLine>): number {
  let cnt=0;
  for (const l of territory) {
    const n = lineNumber(l);
    if (n>=range.start && n<=range.end) {
      const intra = findIntraLineMultiNumbers(l.text);
      if (intra.length >= 2) cnt += intra.length;
      else if (isQuestionStart(l) !== undefined) cnt++;
      else if (isGroupParentLine(l.text).isGroup) cnt++;
    }
  }
  return cnt;
}

// — end segment.ts — pure deterministic segmentation, 100% coverage guarantee
