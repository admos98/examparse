/** Deterministic per-item answer-key anchors and bounded answer-span completion. */
import type { LineSpan, OffsetSpan, SourceLine } from '../types';
import { exciseWatermarks, matchingView, normalizeForMatching } from './quality';
import { foldFurnitureForms, isStandaloneFurnitureLine } from './furniture';
import { isInstructionText } from './cleanup';
import { isOffsetSpan } from './spans';

export interface PrintedAnswerAnchor {
  no: number;
  start: number;
  bodyStart: number;
}

function sourceNo(line: SourceLine): number {
  return Number(String(line.id).replace(/\D/g, '')) || 0;
}

export function printedAnswerAnchors(text: string): PrintedAnswerAnchor[] {
  const view = matchingView(text || '');
  const out: PrintedAnswerAnchor[] = [];
  const re = /(?:^|\s)(?:\((\d{1,3})\)|(\d{1,3}))\s*(?:[.)]|[-–—:：])(?!\d)\s*/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(view.text))) {
    const token = match[1] || match[2];
    const no = Number(token);
    if (!Number.isInteger(no) || no < 1 || no > 300) continue;
    const tokenStart = match.index + match[0].indexOf(token);
    out.push({ no, start: view.originalOffset(tokenStart), bodyStart: view.originalOffset(match.index + match[0].length) });
  }
  return out;
}

function textForSpans(spans: LineSpan[], lines: SourceLine[]): string {
  const byNo = new Map(lines.map(line => [sourceNo(line), line]));
  const chunks: string[] = [];
  for (const span of spans) {
    if (isOffsetSpan(span)) {
      const line = byNo.get(span.line);
      if (line && !line.furniture) chunks.push(line.text.slice(span.start ?? 0, span.end ?? line.text.length));
    } else {
      for (let n = span[0]; n <= span[1]; n++) {
        const line = byNo.get(n);
        if (line && !line.furniture) chunks.push(line.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

export function isNumberOnlyAnswer(text: string): boolean {
  const normalized = normalizeForMatching(text).replace(/[\s()[\]{}.,:;!?؛،-]/g, '');
  return /^\d{1,3}$/.test(normalized);
}

/** Carve one item's answer from a shared line; handles a line containing only one anchor too. */
export function carveAnswerAnchor(spans: LineSpan[], lines: SourceLine[], no: number): { spans: LineSpan[]; matched: boolean } {
  const byNo = new Map(lines.map(line => [sourceNo(line), line]));
  for (const span of spans) {
    const lo = isOffsetSpan(span) ? span.line : span[0];
    const hi = isOffsetSpan(span) ? span.line : span[1];
    for (let n = lo; n <= hi; n++) {
      const line = byNo.get(n);
      if (!line || line.furniture) continue;
      const anchors = printedAnswerAnchors(line.text);
      const index = anchors.findIndex(anchor => anchor.no === no);
      if (index < 0) continue;
      const anchor = anchors[index];
      const next = anchors.slice(index + 1).find(candidate => candidate.start > anchor.bodyStart);
      let start = anchor.bodyStart;
      let end = next?.start ?? line.text.length;
      if (isOffsetSpan(span)) {
        const allowedStart = span.start ?? 0;
        const allowedEnd = span.end ?? line.text.length;
        if (anchor.start < allowedStart || anchor.start >= allowedEnd) continue;
        start = Math.max(start, allowedStart);
        end = Math.min(end, allowedEnd);
      }
      return { spans: end > start ? [{ line: n, start, end }] : [], matched: true };
    }
  }
  return { spans, matched: false };
}

/** Find the exact printed answer anchor for an item, never borrowing a sibling answer. */
export function findAnswerKeySpan(lines: SourceLine[], keyLines: Set<number>, no: number): LineSpan[] | undefined {
  if (!keyLines.size) return undefined;
  const sorted = [...lines].sort((a, b) => sourceNo(a) - sourceNo(b));
  for (const line of sorted) {
    if (!keyLines.has(sourceNo(line)) || line.tag === 'junk' || line.furniture) continue;
    const anchors = printedAnswerAnchors(line.text);
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index];
      if (anchor.no !== no) continue;
      const next = anchors.slice(index + 1).find(candidate => candidate.start > anchor.bodyStart);
      const end = next?.start ?? line.text.length;
      const spans: LineSpan[] = end > anchor.bodyStart ? [{ line: sourceNo(line), start: anchor.bodyStart, end }] : [];
      const answer = textForSpans(spans, lines);
      if (!answer || isNumberOnlyAnswer(answer)) continue;
      const extended = extendIncompleteAnswer(spans, lines, keyLines);
      const finalText = textForSpans(extended.spans, lines);
      if (finalText && !isNumberOnlyAnswer(finalText)) return extended.spans;
    }
  }
  return undefined;
}

function hasSentenceEnd(text: string): boolean {
  return /[.!?؟](?:["'”’)}\]]*)\s*$/u.test(text.trim());
}

function isIncompleteTail(text: string): boolean {
  const value = normalizeForMatching(text).trim();
  if (!value || hasSentenceEnd(text)) return false;
  return /(?:\b(?:and|or|but|because|which|that|who|whom|whose|to|of|in|on|at|with|for|from|by|as|is|are|was|were|be|been|being|has|have|had|the|a|an|this|these|those|than|into|over|under|after|before|when|while|if|although|such|very|too|not)|[,;:])\s*$/iu.test(value);
}

/** All offsets remain in the original source's coordinate space. */
function nextAnchorStart(text: string, from: number): number | undefined {
  const view = matchingView(text);
  const barriers = [...printedAnswerAnchors(text).map(anchor => anchor.start)];
  const re = /(?:\(?[\d./]+\)?\s*نمره|[()]\s*(?:[./][\d./]+|\d+[./][\d./]+)\s*[()]|[()]\s*\d+\s*[()]\s*نمره|هر\s*پاسخ\s*صحیح|(?:listening|vocabulary|grammar|reading|writing)\b|راهنمای\s*تصحیح)/giu;
  for (const match of view.text.matchAll(re)) barriers.push(view.originalOffset(match.index!));
  return barriers.filter(offset => offset >= from).sort((a, b) => a - b)[0];
}

export function isKeyInstruction(text: string): boolean {
  const value = normalizeForMatching(text).replace(/^\s*\d+\s*[.)-]?\s*/, '');
  return (/\s/.test(value.trim()) && isInstructionText(value)) || /^(?:هر\s*(?:پاسخ|کدام)|همکار|در\s*این\s*بخش)/u.test(value);
}

/** Slice-time furniture removal shared by every answer path, not an export scrub. */
export function cleanAnswerText(text: string): string {
  // Drop trailing continued-page / standalone furniture lines and any immediately preceding bare page/score number line.
  const rawLines = text.split(/\r?\n/);
  while (rawLines.length > 1 && isStandaloneFurnitureLine(rawLines[rawLines.length - 1])) {
    rawLines.pop();
    if (
      rawLines.length > 1 &&
      /^\s*\d{1,2}(?:\s*[/٫.]\s*\d{1,2})?\s*$/u.test(foldFurnitureForms(rawLines[rawLines.length - 1])) &&
      /[A-Za-z\p{Script=Arabic}]{2,}/u.test(rawLines.slice(0, -1).join(' '))
    ) {
      rawLines.pop();
    }
  }
  const clean = exciseWatermarks(rawLines.join('\n')).text;
  const view = matchingView(clean);
  const furniture = /(?:\d+\s*نمره|نمره|هر\s*پاسخ\s*صحیح|[()]\s*(?:[./][\d./]+|\d+[./][\d./]+)\s*[()]|[()]\s*\d+\s*[()]\s*نمره)/u.exec(view.text);
  return (furniture ? clean.slice(0, view.originalOffset(furniture.index)) : clean).trim();
}

/** Extend a truncated answer only through the same key item, stopping at the next printed anchor. */
export function extendIncompleteAnswer(spans: LineSpan[], lines: SourceLine[], keyLines: Set<number>, maxContinuationLines = 3): { spans: LineSpan[]; extended: boolean } {
  if (!spans.length) return { spans, extended: false };
  const byNo = new Map(lines.map(line => [sourceNo(line), line]));
  const out = spans.map(span => isOffsetSpan(span) ? { ...span } : [span[0], span[1]] as [number, number]);
  let extended = false;
  const lastIndex = out.length - 1;
  const last = out[lastIndex];
  const lastNo = isOffsetSpan(last) ? last.line : last[1];
  const lastLine = byNo.get(lastNo);
  if (!lastLine || !keyLines.has(lastNo) || lastLine.furniture) return { spans: out, extended };
  let end = isOffsetSpan(last) ? (last.end ?? lastLine.text.length) : lastLine.text.length;
  const start = isOffsetSpan(last) ? (last.start ?? 0) : 0;
  let gathered = textForSpans(out, lines);
  if (!gathered || isKeyInstruction(gathered) || hasSentenceEnd(gathered)) return { spans: out, extended };

  const bound = nextAnchorStart(lastLine.text, end);
  const sameLineEnd = bound ?? lastLine.text.length;
  const existingBarrier = nextAnchorStart(lastLine.text, start);
  if (existingBarrier !== undefined && existingBarrier < end) return { spans: out, extended };
  if (sameLineEnd > end && (isIncompleteTail(gathered) || end < lastLine.text.length)) {
    if (isOffsetSpan(last)) out[lastIndex] = { ...last, end: sameLineEnd };
    else out[lastIndex] = { line: lastNo, start, end: sameLineEnd } as OffsetSpan;
    end = sameLineEnd;
    gathered = textForSpans(out, lines);
    extended = true;
    if (hasSentenceEnd(gathered) || bound !== undefined) return { spans: out, extended };
  }

  for (let offset = 1; offset <= maxContinuationLines; offset++) {
    const nextNo = lastNo + offset;
    const nextLine = byNo.get(nextNo);
    if (!nextLine || !keyLines.has(nextNo) || nextLine.furniture) break;
    const anchors = printedAnswerAnchors(nextLine.text);
    if (anchors.length || nextAnchorStart(nextLine.text, 0) !== undefined || isKeyInstruction(nextLine.text)) break;
    const nextText = nextLine.text.trim();
    if (!nextText) continue;
    if (isStandaloneFurnitureLine(nextText)) break;
    if (
      /^\s*\d{1,2}(?:\s*[/٫.]\s*\d{1,2})?\s*$/u.test(foldFurnitureForms(nextText)) &&
      /[A-Za-z\p{Script=Arabic}]{2,}/u.test(gathered)
    ) {
      break;
    }
    // A continuation line starts lower-case or with punctuation; a fresh heading/answer is a hard stop.
    if (/^\s*(?:question|q\.?\s*\d|\d{1,3}\s*[.)-]|[A-Z][^,;]{0,25}:)/iu.test(nextText)) break;
    out.push([nextNo, nextNo]);
    gathered = textForSpans(out, lines);
    extended = true;
    if (hasSentenceEnd(gathered) || !isIncompleteTail(gathered)) break;
  }
  return { spans: out, extended };
}

export function answerTextForSpans(spans: LineSpan[], lines: SourceLine[]): string {
  return cleanAnswerText(textForSpans(spans, lines));
}
