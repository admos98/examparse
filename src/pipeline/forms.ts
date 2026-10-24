/**
 * Part C — Deterministic Form Canonicalizers Registry (`src/pipeline/forms.ts`).
 *
 * Pure, deterministic, 0 model calls, 0 text invention, strictly idempotent.
 * Runs in fixed order over every assembled question after assembly and after
 * Assistant mutations. Records `form:<name>` rules in Marvel-2 provenance receipts
 * and emits `TYPE_CORRECTED_BY_FORM` whenever text shape overrides a model type hint.
 */
import { ExamDoc, ExamSection, Flag, LineSpan, OffsetSpan, Question, SourceLine } from '../types';
import { isInstructionText } from './cleanup';
import {
  isCanonicalTrueFalsePair,
  isReadTheTextInstruction,
  lineNumber,
  normalizeForMatching,
  normalizeStoredText,
  parsePrintedNumberFromStem,
} from './quality';
import {
  buildSourceLineMap,
  carveGroupChildSpans,
  carveInlineOptionsOnLine,
  carveOptionsAcrossLines,
  compressLineNumbers,
  findInlineOptionMarkers,
  isOffsetSpan,
  maskWatermarksSameLength,
  sliceSourceSpans,
  spanBounds,
  spanHasOffsets,
  spanLineNumbers,
  trimOffsetsOnLine,
} from './spans';

function foldOptionQuotes(value: string): string {
  return value.replace(/[\u0060\u2018\u2019\u02bc]/g, "'").replace(/\s{2,}/g, ' ').trim();
}

export type FormName =
  | 'TRUEFALSE'
  | 'MCQ-INLINE'
  | 'MATCHING-POOL'
  | 'WORD-BANK'
  | 'UNSCRAMBLE'
  | 'DIALOGUE'
  | 'WRITING-TOPICS';

export const FORM_EXECUTION_ORDER: readonly FormName[] = [
  'TRUEFALSE',
  'MCQ-INLINE',
  'MATCHING-POOL',
  'WORD-BANK',
  'UNSCRAMBLE',
  'DIALOGUE',
  'WRITING-TOPICS',
] as const;

export const FORM_RULE_ID: Record<FormName, string> = {
  'TRUEFALSE': 'form:truefalse',
  'MCQ-INLINE': 'form:mcq-inline',
  'MATCHING-POOL': 'form:matching-pool',
  'WORD-BANK': 'form:word-bank',
  'UNSCRAMBLE': 'form:unscramble',
  'DIALOGUE': 'form:dialogue',
  'WRITING-TOPICS': 'form:writing-topics',
};

export interface FormApplicationDelta {
  questionId: string;
  no: number;
  rules: string[];
  stemChanged: boolean;
  optionsChanged: boolean;
  typeChanged: boolean;
  oldType: Question['type'];
  newType: Question['type'];
}

export interface CanonicalizeResult {
  questions: Question[];
  sections: ExamSection[];
  flags: Flag[];
  deltas: FormApplicationDelta[];
}

export interface ShapeProblemDiagnosis {
  questionId: string;
  no: number;
  kinds: Array<'duplicate-options' | 'option-contains-stem' | 'sibling-identical-stem' | 'overlong-stem' | 'malformed-truefalse'>;
}

const BLANK_MARKER_RE = /……|\.{3,}|…{2,}|_{2,}|-{3,}|\(\s*\)|\(\s*\.+\s*\)/u;
const TF_POLE_TOKEN_RE = /^(?:true|false|درست|نادرست|صحیح|غلط)$/iu;

function normMatch(text?: string): string {
  return normalizeForMatching(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripPrintedPrefix(text: string): string {
  return normalizeStoredText(text)
    .replace(/^\s*(?:\(\d{1,3}\)|\d{1,3}\s*[.)\-:])\s*/u, '')
    .trim();
}

function cloneQuestion(q: Question): Question {
  return {
    ...q,
    spans: (q.spans || []).map(sp => (isOffsetSpan(sp) ? { ...sp } : ([sp[0], sp[1]] as [number, number]))),
    options: q.options?.map(opt => ({
      ...opt,
      spans: (opt.spans || []).map(sp => (isOffsetSpan(sp) ? { ...sp } : ([sp[0], sp[1]] as [number, number]))),
    })),
    flags: q.flags ? [...q.flags] : undefined,
    receipt: q.receipt
      ? {
          lineStart: q.receipt.lineStart,
          lineEnd: q.receipt.lineEnd,
          ruleChain: [...q.receipt.ruleChain],
          ruleConfidence: q.receipt.ruleConfidence,
        }
      : undefined,
  };
}

function cloneSection(s: ExamSection): ExamSection {
  return {
    ...s,
    spans: (s.spans || []).map(sp => (isOffsetSpan(sp) ? { ...sp } : ([sp[0], sp[1]] as [number, number]))),
  };
}

function ensureRule(q: Question, ruleId: string): void {
  const bounds = spanBounds(q.spans) || [0, 0];
  if (!q.receipt) {
    q.receipt = {
      lineStart: bounds[0],
      lineEnd: bounds[1],
      ruleChain: [ruleId],
      ruleConfidence: 95,
    };
    return;
  }
  q.receipt.lineStart = bounds[0];
  q.receipt.lineEnd = bounds[1];
  if (!q.receipt.ruleChain.includes(ruleId)) {
    q.receipt.ruleChain.push(ruleId);
  }
}

function addQuestionFlag(q: Question, code: string): void {
  const cur = q.flags || [];
  if (!cur.includes(code)) q.flags = [...cur, code];
}

function removeQuestionFlags(q: Question, codes: string[]): void {
  if (!q.flags?.length) return;
  const drop = new Set(codes);
  const next = q.flags.filter(c => !drop.has(c));
  q.flags = next.length ? next : undefined;
}

function pushUniqueFlag(flags: Flag[], flag: Flag): void {
  if (flags.some(f => f.code === flag.code && f.questionId === flag.questionId && f.message === flag.message)) return;
  flags.push(flag);
}

function applyTypeFromForm(
  q: Question,
  targetType: Question['type'],
  formName: FormName,
  flags: Flag[],
): boolean {
  if (q.type === targetType) return false;
  const prevType = q.type;
  q.type = targetType;
  if (prevType && prevType !== 'unknown') {
    addQuestionFlag(q, 'TYPE_CORRECTED_BY_FORM');
    pushUniqueFlag(flags, {
      id: `flag_TYPE_CORRECTED_BY_FORM_${q.id}_${formName}`,
      severity: 'info',
      code: 'TYPE_CORRECTED_BY_FORM',
      message: `Q${q.no}: type corrected from "${prevType}" to "${targetType}" by ${formName} form canonicalizer.`,
      questionId: q.id,
    });
  }
  return true;
}

function recalibrateConfidenceIfRepaired(q: Question, hadOptionDefect: boolean): void {
  if (!hadOptionDefect) return;
  removeQuestionFlags(q, ['OPTION_SPLIT_FAILED', 'OPTIONS_MISSING', 'OPTION_DUPLICATE', 'LOW_CONFIDENCE']);
  if (q.confidence < 0.85) {
    q.confidence = Math.min(1, Number((q.confidence + 0.35).toFixed(2)));
  }
}

function isRowSubInstructionLine(text: string): boolean {
  if (isReadTheTextInstruction(text)) return true;
  const norm = normalizeForMatching(text).trim();
  if (!norm || norm.length > 240) return false;
  const iranianSubInstructionRe = /(?:کامل\s+کنید|پاسخ\s+دهید|انتخاب\s+کنید|بنویسید|مشخص\s+کنید|پیدا\s+کنید|مرتب\s+کنید|وصل\s+کنید)/u;
  return /^(?:[الفبپتجد]\s*[).\-:]|\d{1,2}(?:\s*[./]\s*\d{1,2})?\s*\.?\s+)[\p{Script=Arabic}]/u.test(norm) && iranianSubInstructionRe.test(norm);
}

function isProsePassageLine(line: SourceLine): boolean {
  if (line.furniture || line.tag === 'key') return false;
  const norm = normalizeForMatching(line.text).trim();
  if (norm.length < 18) return false;
  if (/(?:باسمه\s*تعالی|سؤالات\s+امتحان|سوالات\s+امتحان|تاریخ\s+امتحان\s*:|مرکز\s+سنجش\s+و\s+پایش|ادامه\s*(?:ی)?\s*(?:سؤالات|سوالات)?\s*در\s+صفحه|ردیف\s+سؤالات|ردیف\s+سوالات|aee\.medu\.ir|www[.-]kanoon)/iu.test(norm)) return false;
  if (parsePrintedNumberFromStem(line.text) !== undefined) return false;
  if (isInstructionText(line.text) || isRowSubInstructionLine(line.text)) return false;
  if (/^\s*(?:[a-j]|[الفبپتثجچ])\s*[).:]/iu.test(norm)) return false;
  return true;
}

function appendSectionPassage(section: ExamSection | undefined, passageText: string): void {
  const clean = normalizeStoredText(passageText).trim();
  if (!section || !clean) return;
  const existing = (section.passage || '').trim();
  if (!existing) {
    section.passage = clean;
    return;
  }
  if (normMatch(existing).includes(normMatch(clean))) return;
  section.passage = `${existing}\n\n${clean}`;
}

/**
 * Part C3 — Stem-length brake & read-the-text passage tail separator.
 * Detaches mid-section read-the-text instructions + >=3 non-numbered prose lines from a
 * question's tail onto its owning section's `passage`. Any stem still >500 chars afterward
 * receives `STEM_OVERLONG`.
 */
function applyPassageTailBrake(
  questions: Question[],
  sections: ExamSection[],
  lineMap: Map<number, SourceLine>,
  flags: Flag[],
  appliedRulesByQ: Map<string, string[]>,
): void {
  const sectionById = new Map(sections.map(s => [s.id, s]));

  for (const q of questions) {
    const qLineNos = spanLineNumbers(q.spans);
    const hasReadInstructionInTail = qLineNos.slice(1).some(ln => {
      const l = lineMap.get(ln);
      return Boolean(l && isReadTheTextInstruction(l.text));
    });
    const wasOverlong = (q.stem || '').length > 500;

    if ((wasOverlong || hasReadInstructionInTail) && qLineNos.length >= 2 && !q.spans.some(spanHasOffsets)) {
      let splitAtIdx = -1;
      for (let i = 1; i < qLineNos.length; i++) {
        const l = lineMap.get(qLineNos[i]);
        if (!l) continue;
        if (isReadTheTextInstruction(l.text)) {
          splitAtIdx = i;
          break;
        }
      }
      // If >500 chars without an explicit read-the-text line, check for a trailing prose passage run (>=3 lines, avg >=40 chars)
      // following an instruction or terminal question mark / period on the question's opening line(s).
      if (splitAtIdx < 0 && wasOverlong) {
        for (let i = 1; i < qLineNos.length; i++) {
          const curLine = lineMap.get(qLineNos[i]);
          if (!curLine) continue;
          if (isInstructionText(curLine.text) || isRowSubInstructionLine(curLine.text)) {
            let pStart = i + 1;
            while (pStart < qLineNos.length) {
              const pl = lineMap.get(qLineNos[pStart]);
              if (pl && (isInstructionText(pl.text) || isRowSubInstructionLine(pl.text))) pStart++;
              else break;
            }
            const proseLines = qLineNos.slice(pStart).map(n => lineMap.get(n)).filter((l): l is SourceLine => Boolean(l));
            if (proseLines.length >= 3 && proseLines.every(isProsePassageLine)) {
              splitAtIdx = i;
              break;
            }
          }
          const prevLine = lineMap.get(qLineNos[i - 1]);
          if (prevLine && /[?.!؟]\s*(?:\([^)]*\))?\s*$/u.test(prevLine.text.trim())) {
            const tailLines = qLineNos.slice(i).map(n => lineMap.get(n)).filter((l): l is SourceLine => Boolean(l));
            const proseRun: SourceLine[] = [];
            for (const tl of tailLines) {
              if (isProsePassageLine(tl)) proseRun.push(tl);
              else break;
            }
            const avg = proseRun.length ? proseRun.reduce((s, l) => s + l.text.length, 0) / proseRun.length : 0;
            if (proseRun.length >= 3 && avg >= 40) {
              splitAtIdx = i;
              break;
            }
          }
        }
      }

      if (splitAtIdx > 0) {
        const keepLines = qLineNos.slice(0, splitAtIdx);
        const detachedLines = qLineNos.slice(splitAtIdx);
        const proseLineNos = detachedLines.filter(ln => {
          const l = lineMap.get(ln);
          return Boolean(l && isProsePassageLine(l));
        });
        const allLines = [...lineMap.values()];
        q.spans = compressLineNumbers(keepLines);
        q.stem = sliceSourceSpans(q.spans, allLines);

        if (proseLineNos.length >= 3) {
          const passageSlice = sliceSourceSpans(compressLineNumbers(proseLineNos), allLines);
          const targetSection = (q.sectionId ? sectionById.get(q.sectionId) : undefined) || sections[0];
          appendSectionPassage(targetSection, passageSlice);
        }

        ensureRule(q, 'form:passage-tail');
        appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), 'form:passage-tail']);
      } else if (wasOverlong && qLineNos.length <= 1 && q.stem) {
        // In-memory / single-blob fallback when stem contains an embedded read-the-text newline boundary.
        const stemLines = q.stem.split(/\r?\n/);
        const boundaryIdx = stemLines.findIndex((ln, idx) => idx > 0 && isReadTheTextInstruction(ln));
        if (boundaryIdx > 0) {
          const proseAfter = stemLines.slice(boundaryIdx + 1).filter(ln => ln.trim().length >= 18 && !isInstructionText(ln));
          q.stem = stemLines.slice(0, boundaryIdx).join('\n').trim();
          if (proseAfter.length >= 3) {
            const targetSection = (q.sectionId ? sectionById.get(q.sectionId) : undefined) || sections[0];
            appendSectionPassage(targetSection, proseAfter.join('\n'));
          }
          ensureRule(q, 'form:passage-tail');
          appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), 'form:passage-tail']);
        }
      }
    }

    if ((q.stem || '').length > 500) {
      addQuestionFlag(q, 'STEM_OVERLONG');
      pushUniqueFlag(flags, {
        id: `flag_STEM_OVERLONG_${q.id}`,
        severity: 'warn',
        code: 'STEM_OVERLONG',
        message: `Q${q.no}: stem remains ${q.stem!.length} chars (>500) after local tail re-segmentation.`,
        questionId: q.id,
      });
    } else {
      removeQuestionFlags(q, ['STEM_OVERLONG']);
    }
  }
}

/**
 * Form 1: TRUEFALSE (`form:truefalse`)
 * Recognizes inline or two-pole True/False / درست/نادرست / صحیح/غلط questions, slices clean
 * stem without the marker tail, slices exact 2 options `[True, False]`, and sets `type = 'truefalse'`.
 */
function applyTrueFalseForm(
  questions: Question[],
  sourceLines: SourceLine[],
  lineMap: Map<number, SourceLine>,
  flags: Flag[],
  appliedRulesByQ: Map<string, string[]>,
): void {
  for (const q of questions) {
    if (q.parentId) continue;
    // Do not touch genuine 3+ option prose MCQs.
    if ((q.options || []).length >= 3) {
      const nonTfOpts = (q.options || []).filter(o => !TF_POLE_TOKEN_RE.test(normMatch(o.text)));
      if (nonTfOpts.length >= 2) continue;
    }

    const hadDefect = Boolean(
      q.flags?.some(c => c === 'OPTION_SPLIT_FAILED' || c === 'OPTIONS_MISSING' || c === 'OPTION_DUPLICATE') ||
      ((q.options || []).length >= 2 && new Set((q.options || []).map(o => normMatch(o.text))).size < (q.options || []).length),
    );

    const allCandidateLineNos = [
      ...new Set([
        ...spanLineNumbers(q.spans),
        ...(q.options || []).flatMap(o => spanLineNumbers(o.spans)),
      ]),
    ].sort((a, b) => a - b);

    const hasTfHint =
      q.type === 'truefalse' ||
      /true|false|درست|نادرست|صحیح|غلط/iu.test(q.stem || '') ||
      (q.options || []).some(o => /true|false|درست|نادرست|صحیح|غلط/iu.test(o.text || '')) ||
      allCandidateLineNos.some(ln => /true|false|درست|نادرست|صحیح|غلط/iu.test(lineMap.get(ln)?.text || ''));
    if (!hasTfHint) continue;

    const candidateLines = allCandidateLineNos
      .map(ln => ({ lineNo: ln, text: lineMap.get(ln)?.text || '' }))
      .filter(item => item.text.trim().length > 0 && !isInstructionText(item.text) && !isRowSubInstructionLine(item.text));

    let matched = false;

    // Strategy A: Carve marker-led `a) True b) False` / `الف) درست ب) نادرست` across candidate source lines.
    if (candidateLines.length > 0) {
      const carved = carveOptionsAcrossLines(candidateLines);
      if (carved && carved.options.length === 2) {
        const slicedOpts = carved.options.map(o => ({
          key: o.key,
          spans: o.spans,
          text: sliceSourceSpans(o.spans, sourceLines),
        }));
        if (isCanonicalTrueFalsePair(slicedOpts) && carved.stemSpans.length > 0) {
          const nextStem = sliceSourceSpans(carved.stemSpans, sourceLines);
          if (stripPrintedPrefix(nextStem).length >= 2) {
            const changed =
              q.stem !== nextStem ||
              q.type !== 'truefalse' ||
              JSON.stringify(q.options) !== JSON.stringify(slicedOpts) ||
              JSON.stringify(q.spans) !== JSON.stringify(carved.stemSpans);
            q.spans = carved.stemSpans;
            q.stem = nextStem;
            q.options = slicedOpts;
            applyTypeFromForm(q, 'truefalse', 'TRUEFALSE', flags);
            recalibrateConfidenceIfRepaired(q, hadDefect);
            if (changed || !q.receipt?.ruleChain.includes(FORM_RULE_ID.TRUEFALSE)) {
              ensureRule(q, FORM_RULE_ID.TRUEFALSE);
              if (changed) appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID.TRUEFALSE]);
            }
            matched = true;
          }
        }
      }

      // Strategy B: Slash/dash/bracket tail on source line, e.g. `... [True / False]` or `(درست / نادرست)`.
      if (!matched) {
        const lastEntry = candidateLines[candidateLines.length - 1];
        const norm = normalizeStoredText(lastEntry.text);
        const masked = maskWatermarksSameLength(norm);
        const slashRe = /[\s([{-]*(true|false|درست|نادرست|صحیح|غلط)\s*(?:\/|-|–|—|\|)\s*(true|false|درست|نادرست|صحیح|غلط)[\s)\]}]*$/iu;
        const m = masked.match(slashRe);
        if (m && m.index !== undefined) {
          const fullStart = m.index;
          const pole1 = norm.slice(fullStart).match(/(true|false|درست|نادرست|صحیح|غلط)/iu);
          if (pole1 && pole1.index !== undefined) {
            const p1Start = fullStart + pole1.index;
            const p1End = p1Start + pole1[0].length;
            const rest = norm.slice(p1End);
            const pole2 = rest.match(/(true|false|درست|نادرست|صحیح|غلط)/iu);
            if (pole2 && pole2.index !== undefined) {
              const p2Start = p1End + pole2.index;
              const p2End = p2Start + pole2[0].length;
              const optSpans: Question['options'] = [
                { key: 'a', spans: [{ line: lastEntry.lineNo, start: p1Start, end: p1End }], text: norm.slice(p1Start, p1End) },
                { key: 'b', spans: [{ line: lastEntry.lineNo, start: p2Start, end: p2End }], text: norm.slice(p2Start, p2End) },
              ];
              if (isCanonicalTrueFalsePair(optSpans)) {
                const stemSpans: LineSpan[] = candidateLines.slice(0, -1).map(c => [c.lineNo, c.lineNo] as [number, number]);
                const prefixTrim = trimOffsetsOnLine(masked, 0, fullStart);
                if (prefixTrim.end > prefixTrim.start) {
                  stemSpans.push({ line: lastEntry.lineNo, start: prefixTrim.start, end: prefixTrim.end });
                }
                const nextStem = sliceSourceSpans(stemSpans, sourceLines);
                if (stripPrintedPrefix(nextStem).length >= 2) {
                  const changed =
                    q.stem !== nextStem ||
                    q.type !== 'truefalse' ||
                    JSON.stringify(q.options) !== JSON.stringify(optSpans);
                  q.spans = stemSpans;
                  q.stem = nextStem;
                  q.options = optSpans;
                  applyTypeFromForm(q, 'truefalse', 'TRUEFALSE', flags);
                  recalibrateConfidenceIfRepaired(q, hadDefect);
                  ensureRule(q, FORM_RULE_ID.TRUEFALSE);
                  if (changed) appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID.TRUEFALSE]);
                  matched = true;
                }
              }
            }
          }
        }
      }
    }

    // Strategy C: In-memory question with inline TF tail or marker-prefixed TF options (0 text invention).
    if (!matched && q.stem) {
      const carvedInline = carveInlineOptionsOnLine(spanLineNumbers(q.spans)[0] || 1, q.stem);
      if (carvedInline && carvedInline.optionSpans.length === 2 && carvedInline.stemPrefixSpan) {
        const normStemLine = normalizeStoredText(q.stem);
        const synthOpts = carvedInline.optionSpans.map(o => ({
          key: o.key,
          spans: q.spans.length ? [o.span] : [],
          text: normStemLine.slice(o.span.start ?? 0, o.span.end ?? normStemLine.length).trim(),
        }));
        const strippedStem = normStemLine.slice(carvedInline.stemPrefixSpan.start ?? 0, carvedInline.stemPrefixSpan.end ?? normStemLine.length).trim();
        if (isCanonicalTrueFalsePair(synthOpts) && stripPrintedPrefix(strippedStem).length >= 2) {
          q.stem = strippedStem;
          q.options = synthOpts;
          applyTypeFromForm(q, 'truefalse', 'TRUEFALSE', flags);
          recalibrateConfidenceIfRepaired(q, hadDefect);
          ensureRule(q, FORM_RULE_ID.TRUEFALSE);
          appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID.TRUEFALSE]);
          matched = true;
        }
      } else if ((q.options || []).length === 2) {
        const cleanedOpts = q.options!.map((o, idx) => ({
          ...o,
          key: idx === 0 ? 'a' : 'b',
          text: normalizeStoredText(o.text || '').replace(/^\s*(?:\([a-b1-2الفب]\)|[a-b1-2الفب][).:])\s*/iu, '').trim(),
        }));
        if (isCanonicalTrueFalsePair(cleanedOpts)) {
          const changed = q.type !== 'truefalse' || JSON.stringify(q.options) !== JSON.stringify(cleanedOpts);
          q.options = cleanedOpts;
          applyTypeFromForm(q, 'truefalse', 'TRUEFALSE', flags);
          recalibrateConfidenceIfRepaired(q, hadDefect);
          ensureRule(q, FORM_RULE_ID.TRUEFALSE);
          if (changed) appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID.TRUEFALSE]);
        }
      }
    }
  }
}

/**
 * Form 2: MCQ-INLINE (`form:mcq-inline`)
 * Carves >=2 inline or multi-line ordered options (`a) ... b) ... c) ... d) ...`) via offset spans,
 * strips inline options out of stems, repairs duplicated option blobs, and sets `type = 'mcq'`.
 */
function applyMcqInlineForm(
  questions: Question[],
  sourceLines: SourceLine[],
  lineMap: Map<number, SourceLine>,
  flags: Flag[],
  appliedRulesByQ: Map<string, string[]>,
): void {
  const parentIds = new Set(questions.map(q => q.parentId).filter((id): id is string => Boolean(id)));

  for (const q of questions) {
    if (q.type === 'truefalse' && isCanonicalTrueFalsePair(q.options)) continue;
    if (parentIds.has(q.id) || /\(\d{1,3}\)\s*\(\d{1,3}\)/u.test(q.stem || '')) continue;

    // Preserve B2b intra-line multi-number sub-items (`20. a) do b) does`) when no options were requested
    // and there is no prose stem between `20.` and `a)`.
    if (q.parentId && (!q.options || q.options.length === 0)) {
      const stripped = stripPrintedPrefix(q.stem || '');
      if (/^(?:\([a-d]\)|[a-d][).:])/iu.test(stripped)) continue;
    }

    const hadDefect = Boolean(
      q.flags?.some(c => c === 'OPTION_SPLIT_FAILED' || c === 'OPTIONS_MISSING' || c === 'OPTION_DUPLICATE') ||
      ((q.options || []).length >= 2 && new Set((q.options || []).map(o => normMatch(o.text))).size < (q.options || []).length) ||
      ((q.options || []).some(o => normMatch(o.text).length >= 8 && normMatch(q.stem).length >= 8 && normMatch(o.text).includes(normMatch(q.stem)))),
    );
    const stemHasInlineOpts = findInlineOptionMarkers(q.stem || '').length >= 2;
    if (
      !hadDefect &&
      !stemHasInlineOpts &&
      (q.type === 'mcq' || q.type === 'multi') &&
      (q.options || []).length >= 2 &&
      (q.options || []).every(o => Boolean(o.text && o.text.trim()))
    ) {
      ensureRule(q, FORM_RULE_ID['MCQ-INLINE']);
      continue;
    }

    const allLineNos = [
      ...new Set([
        ...spanLineNumbers(q.spans),
        ...(q.options || []).flatMap(o => spanLineNumbers(o.spans)),
      ]),
    ].sort((a, b) => a - b);

    const candidateLines = allLineNos
      .map(ln => ({ lineNo: ln, text: lineMap.get(ln)?.text || '' }))
      .filter(item => item.text.trim().length > 0 && !isInstructionText(item.text) && !isRowSubInstructionLine(item.text));

    if (candidateLines.length > 0) {
      const carved = carveOptionsAcrossLines(candidateLines);
      if (carved && carved.options.length >= 2 && carved.stemSpans.length > 0) {
        const nextStem = sliceSourceSpans(carved.stemSpans, sourceLines);
        const slicedOpts = carved.options.map(o => ({
          key: o.key,
          spans: o.spans,
          text: foldOptionQuotes(sliceSourceSpans(o.spans, sourceLines)),
        }));
        // Skip if this is actually a canonical TF pair (handled by TRUEFALSE) or a 5+ definition matching pool on a single-line item.
        if (isCanonicalTrueFalsePair(slicedOpts)) continue;
        if (slicedOpts.length >= 5 && q.type !== 'mcq' && q.type !== 'multi') continue;

        const distinctTexts = new Set(slicedOpts.map(o => normMatch(o.text)).filter(Boolean));
        if (stripPrintedPrefix(nextStem).length >= 2 && distinctTexts.size === slicedOpts.length) {
          const targetType: Question['type'] = q.type === 'multi' ? 'multi' : 'mcq';
          const changed =
            q.stem !== nextStem ||
            q.type !== targetType ||
            JSON.stringify(q.options) !== JSON.stringify(slicedOpts) ||
            JSON.stringify(q.spans) !== JSON.stringify(carved.stemSpans);
          const sharedLine = carved.options.some((opt, idx) =>
            idx > 0 && spanLineNumbers(opt.spans)[0] === spanLineNumbers(carved.options[idx - 1].spans)[0],
          ) || spanLineNumbers(carved.stemSpans).some(ln => carved.options.some(opt => spanLineNumbers(opt.spans).includes(ln)));

          if (sharedLine || hadDefect || (q.options || []).length === 0) {
            q.spans = carved.stemSpans;
            q.stem = nextStem;
            q.options = slicedOpts;
            applyTypeFromForm(q, targetType, 'MCQ-INLINE', flags);
            recalibrateConfidenceIfRepaired(q, hadDefect);
            ensureRule(q, FORM_RULE_ID['MCQ-INLINE']);
            if (changed) appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID['MCQ-INLINE']]);
            continue;
          }
        }
      }
    }

    // Fallback for in-memory questions without full sourceLines where stem or duplicate options hold inline markers.
    if (q.stem) {
      const inline = carveInlineOptionsOnLine(spanLineNumbers(q.spans)[0] || 1, q.stem);
      if (inline && inline.optionSpans.length >= 2 && inline.stemPrefixSpan) {
        const normLine = normalizeStoredText(q.stem);
        const slicedOpts = inline.optionSpans.map(o => ({
          key: o.key,
          spans: [o.span],
          text: normLine.slice(o.span.start ?? 0, o.span.end ?? normLine.length).trim(),
        }));
        const nextStem = normLine.slice(inline.stemPrefixSpan.start ?? 0, inline.stemPrefixSpan.end ?? normLine.length).trim();
        if (!isCanonicalTrueFalsePair(slicedOpts) && new Set(slicedOpts.map(o => normMatch(o.text))).size === slicedOpts.length) {
          q.stem = nextStem;
          q.options = slicedOpts;
          applyTypeFromForm(q, q.type === 'multi' ? 'multi' : 'mcq', 'MCQ-INLINE', flags);
          recalibrateConfidenceIfRepaired(q, hadDefect);
          ensureRule(q, FORM_RULE_ID['MCQ-INLINE']);
          appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID['MCQ-INLINE']]);
        }
      }
    }
  }
}

/**
 * Form 3: MATCHING-POOL (`form:matching-pool`)
 * Canonicalizes:
 * 1) Group-parent matching questions `(15) (16) (17) (18)` + shared pool `a..e` (removing self-numbered
 *    phantom children, carving disjoint child OffsetSpans, and keeping pool options on parent only per I9).
 * 2) Column A / Column B consecutive item runs (`51..54` + `B` + `a..e`, `55..58` + `B` + `f..j`).
 */
function applyMatchingPoolForm(
  questions: Question[],
  sourceLines: SourceLine[],
  lineMap: Map<number, SourceLine>,
  flags: Flag[],
  appliedRulesByQ: Map<string, string[]>,
): Question[] {
  // 0. Never allow a question to be its own parent or duplicate its parent's printed number inside the same group.
  const byId = new Map(questions.map(q => [q.id, q]));
  // Root numbers are also checked: a phantom child can reference a parent whose id was rewritten
  // (repair/adoption/critic reparse) so `byId` misses it, while a root with the same printed number
  // still proves the child duplicates its own parent. Same-section only, to keep cross-section
  // numbering reuse legitimate.
  const rootByNo = new Map<number, Question>();
  for (const q of questions) {
    if (q.parentId) continue;
    if (!rootByNo.has(q.no)) rootByNo.set(q.no, q);
  }
  const filtered: Question[] = [];
  for (const q of questions) {
    if (q.parentId === q.id) {
      const cleaned = { ...q, parentId: undefined };
      filtered.push(cleaned);
      continue;
    }
    if (q.parentId) {
      const parent = byId.get(q.parentId);
      const sharedContextParent = Boolean(parent?.receipt?.ruleChain.some(rule => ['dialogue-group', 'enumerative-group'].includes(rule)));
      if (sharedContextParent && parent?.no === q.no) {
        // Dialogue/enumeration context groups deliberately retain a first child with the parent's number.
        filtered.push(q);
        continue;
      }
      const sameNoRoot = rootByNo.get(q.no);
      const sameNoRootIsParent = Boolean(
        sameNoRoot && sameNoRoot.id !== q.id && (
          !sameNoRoot.sectionId || !q.sectionId || sameNoRoot.sectionId === q.sectionId
        ),
      );
      if ((parent && q.no === parent.no) || sameNoRootIsParent) {
        // Drop phantom child numbered identically to its parent (e.g. child 15 under parent 15).
        const anchor = parent && q.no === parent.no ? parent : sameNoRoot!;
        ensureRule(anchor, FORM_RULE_ID['MATCHING-POOL']);
        appliedRulesByQ.set(anchor.id, [...(appliedRulesByQ.get(anchor.id) || []), FORM_RULE_ID['MATCHING-POOL']]);
        pushUniqueFlag(flags, {
          id: `flag_PHANTOM_SELF_CHILD_${q.id}`,
          severity: 'warn',
          code: 'PHANTOM_SELF_CHILD_REMOVED',
          message: `Phantom group child ${q.label || q.no} was numbered as its own parent ${anchor.label || anchor.no}; removed by the matching-pool canonicalizer.`,
          questionId: anchor.id,
        });
        continue;
      }
    }
    filtered.push(q);
  }

  const childrenByParent = new Map<string, Question[]>();
  for (const q of filtered) {
    if (!q.parentId) continue;
    childrenByParent.set(q.parentId, [...(childrenByParent.get(q.parentId) || []), q]);
  }

  // 1. Group-parent + children matching pools (e.g. Q15 -> {16, 17, 18} + a..e).
  for (const [parentId, children] of childrenByParent.entries()) {
    const parent = filtered.find(q => q.id === parentId);
    if (!parent) continue;
    if (parent.receipt?.ruleChain.includes('dialogue-group')) {
      for (const child of children) {
        if (applyTypeFromForm(child, 'fillblank', 'DIALOGUE', flags)) {
          appliedRulesByQ.set(child.id, [...(appliedRulesByQ.get(child.id) || []), FORM_RULE_ID.DIALOGUE]);
        }
        ensureRule(child, FORM_RULE_ID.DIALOGUE);
      }
      continue;
    }
    // Enumerative cloze groups have a shared instruction plus numbered item slices, not a matching pool.
    if (parent.receipt?.ruleChain.includes('enumerative-group')) continue;

    // Skip intra-line cloze groups (`63. a) ... 64. b) ...`) where parent line has intra-line multi-numbers.
    const parentLineNos = [
      ...new Set([
        ...spanLineNumbers(parent.spans),
        ...(parent.options || []).flatMap(o => spanLineNumbers(o.spans)),
      ]),
    ].sort((a, b) => a - b);

    const groupLinesAll = parentLineNos
      .map(ln => ({ lineNo: ln, text: lineMap.get(ln)?.text || '' }))
      .filter(it => it.text.trim().length > 0);

    // Stop group lines before any trailing unrelated sub-header instruction (e.g. Row 6 word-bank instruction).
    let stopIdx = groupLinesAll.length;
    for (let i = 1; i < groupLinesAll.length; i++) {
      if (isRowSubInstructionLine(groupLinesAll[i].text)) {
        stopIdx = i;
        break;
      }
    }
    const groupLines = groupLinesAll.slice(0, stopIdx);

    const carvedPool = groupLines.length > 0
      ? carveOptionsAcrossLines(groupLines, { allowMidAlphabetStart: true })
      : null;

    const hasParenthesizedGroupMarkers = groupLines.some(gl => /\(\d{1,3}\)\s*\(\d{1,3}\)/u.test(gl.text));
    const hasSharedPool = Boolean((carvedPool && carvedPool.options.length >= 3) || (parent.options && parent.options.length >= 3));
    if (!hasParenthesizedGroupMarkers && !hasSharedPool && parent.type !== 'matching') continue;

    const existingParentOptsClean =
      (parent.options || []).length >= 3 &&
      new Set((parent.options || []).map(o => normMatch(o.text)).filter(Boolean)).size === (parent.options || []).length &&
      findInlineOptionMarkers(parent.stem || '').length < 2;

    let parentChanged = false;
    if (!existingParentOptsClean && carvedPool && carvedPool.options.length >= 3 && carvedPool.stemSpans.length > 0) {
      const slicedOpts = carvedPool.options.map(o => ({
        key: o.key,
        spans: o.spans,
        text: foldOptionQuotes(sliceSourceSpans(o.spans, sourceLines)),
      }));
      const nextStem = sliceSourceSpans(carvedPool.stemSpans, sourceLines);
      if (nextStem.trim().length > 0 && new Set(slicedOpts.map(o => normMatch(o.text))).size === slicedOpts.length) {
        if (
          parent.stem !== nextStem ||
          JSON.stringify(parent.options) !== JSON.stringify(slicedOpts) ||
          JSON.stringify(parent.spans) !== JSON.stringify(carvedPool.stemSpans)
        ) {
          parentChanged = true;
        }
        parent.spans = carvedPool.stemSpans;
        parent.stem = nextStem;
        parent.options = slicedOpts;
      }
    }

    if (applyTypeFromForm(parent, 'matching', 'MATCHING-POOL', flags)) parentChanged = true;
    ensureRule(parent, FORM_RULE_ID['MATCHING-POOL']);
    if (parentChanged) {
      appliedRulesByQ.set(parent.id, [...(appliedRulesByQ.get(parent.id) || []), FORM_RULE_ID['MATCHING-POOL']]);
    }

    // Carve disjoint per-child OffsetSpans when siblings share a line or lack distinct stems (Part B2c),
    // while preserving already-distinct caption/prose stems (e.g. from split_group_children).
    const parentNormStem = normMatch(parent.stem);
    const distinctChildBodies = new Set(
      children
        .map(c => normMatch(stripPrintedPrefix(c.stem || '')))
        .filter(s => s.length >= 2 && (!parentNormStem || !s.includes(parentNormStem))),
    );
    const childrenAlreadyDistinct = distinctChildBodies.size === children.length;
    const childNos = children.map(c => c.no);
    const childSpanMap = childrenAlreadyDistinct ? new Map<number, OffsetSpan>() : carveGroupChildSpans(groupLines, parent.no, childNos);
    for (const child of children) {
      let childChanged = false;
      const carvedSpan = childSpanMap.get(child.no);
      if (carvedSpan) {
        const nextChildStem = sliceSourceSpans([carvedSpan], sourceLines);
        if (nextChildStem && (child.stem !== nextChildStem || JSON.stringify(child.spans) !== JSON.stringify([carvedSpan]))) {
          child.spans = [carvedSpan];
          child.stem = nextChildStem;
          childChanged = true;
        }
      }
      if (parent.options && parent.options.length >= 2 && child.options !== undefined) {
        child.options = undefined;
        childChanged = true;
      }
      if (applyTypeFromForm(child, 'matching', 'MATCHING-POOL', flags)) childChanged = true;
      ensureRule(child, FORM_RULE_ID['MATCHING-POOL']);
      if (childChanged) {
        appliedRulesByQ.set(child.id, [...(appliedRulesByQ.get(child.id) || []), FORM_RULE_ID['MATCHING-POOL']]);
      }
    }
  }

  // 2. Column A / Column B consecutive root-question matching runs (e.g. 51..54 + B + a..e, 55..58 + B + f..j).
  const letteredLineRe = /^\s*(?:[a-j]|[الفبپتثجچ])\s*[).:]/iu;
  const roots = filtered.filter(q => !q.parentId && !childrenByParent.has(q.id));
  const sortedSourceLineNos = [...lineMap.keys()].sort((a, b) => a - b);

  for (let i = 0; i < roots.length; i++) {
    const q = roots[i];
    // Find preceding consecutive single-line root items in the same section.
    let runStart = i;
    while (
      runStart > 0 &&
      roots[runStart - 1].sectionId === q.sectionId &&
      roots[runStart - 1].no === roots[runStart].no - 1 &&
      spanLineNumbers(roots[runStart - 1].spans).length === 1 &&
      (roots[runStart - 1].options || []).length === 0
    ) {
      runStart--;
    }
    const runItems = roots.slice(runStart, i + 1);
    if (runItems.length < 2) continue;

    // Candidate pool lines sit either inside `q.spans`/`q.options` OR immediately after `q`'s line before the next question/header.
    const qOwnLines = [
      ...new Set([
        ...spanLineNumbers(q.spans),
        ...(q.options || []).flatMap(o => spanLineNumbers(o.spans)),
      ]),
    ].sort((a, b) => a - b);
    if (qOwnLines.length === 0) continue;

    const firstQLine = qOwnLines[0];
    const nextRootFirstLine = roots[i + 1] ? (spanLineNumbers(roots[i + 1].spans)[0] ?? Infinity) : Infinity;

    const trailingWindow = sortedSourceLineNos.filter(ln => ln > firstQLine && ln < nextRootFirstLine).slice(0, 20);
    const poolLineNos: number[] = [];
    for (const ln of trailingWindow) {
      const l = lineMap.get(ln);
      if (!l || l.furniture || l.tag === 'key') continue;
      const t = l.text.trim();
      if (!t) continue;
      if (parsePrintedNumberFromStem(t) !== undefined) break;
      if (isRowSubInstructionLine(t) || isInstructionText(t) || /^\s*A\s*$/u.test(t)) {
        if (poolLineNos.length >= 3) break;
        continue;
      }
      if (/^\s*B\s*$/u.test(t)) continue;
      if (letteredLineRe.test(normalizeForMatching(t))) {
        poolLineNos.push(ln);
      } else if (poolLineNos.length >= 3) {
        break;
      }
    }

    if (poolLineNos.length < 3 || poolLineNos.length < runItems.length) continue;

    const poolEntries = poolLineNos.map(ln => ({ lineNo: ln, text: lineMap.get(ln)!.text }));
    const carvedPool = carveOptionsAcrossLines(poolEntries, { allowMidAlphabetStart: true });
    if (!carvedPool || carvedPool.options.length < 3) continue;

    const poolOptions = carvedPool.options.map(o => ({
      key: o.key,
      spans: o.spans,
      text: sliceSourceSpans(o.spans, sourceLines),
    }));
    if (new Set(poolOptions.map(o => normMatch(o.text))).size < poolOptions.length) continue;

    // Trim `q` (the last item of Column A) back to its own item line(s) before `B` / lettered pool!
    const firstPoolLine = poolLineNos[0];
    const itemOnlyLines = qOwnLines.filter(ln => {
      if (ln >= firstPoolLine) return false;
      const txt = lineMap.get(ln)?.text.trim() || '';
      if (/^\s*B\s*$/u.test(txt)) return false;
      return true;
    });
    if (itemOnlyLines.length > 0 && !q.spans.some(spanHasOffsets)) {
      q.spans = compressLineNumbers(itemOnlyLines);
      q.stem = sliceSourceSpans(q.spans, sourceLines);
    }

    for (const item of runItems) {
      const prevStem = item.stem;
      const prevOpts = JSON.stringify(item.options);
      const typeChanged = applyTypeFromForm(item, 'matching', 'MATCHING-POOL', flags);
      item.options = poolOptions.map(po => ({ ...po, spans: po.spans.map(sp => (isOffsetSpan(sp) ? { ...sp } : ([sp[0], sp[1]] as [number, number]))) }));
      removeQuestionFlags(item, ['OPTION_SPLIT_FAILED', 'OPTIONS_MISSING', 'OPTION_DUPLICATE']);
      if (item.receipt?.ruleChain) {
        item.receipt.ruleChain = item.receipt.ruleChain.filter(r => r !== FORM_RULE_ID['MCQ-INLINE']);
      }
      ensureRule(item, FORM_RULE_ID['MATCHING-POOL']);
      if (typeChanged || prevStem !== item.stem || prevOpts !== JSON.stringify(item.options)) {
        appliedRulesByQ.set(item.id, [...(appliedRulesByQ.get(item.id) || []), FORM_RULE_ID['MATCHING-POOL']]);
      }
    }
  }

  return filtered;
}

function isWordBankListLine(text: string): boolean {
  const norm = normalizeStoredText(text).trim();
  if (!norm || norm.length > 140) return false;
  if (parsePrintedNumberFromStem(norm) !== undefined) return false;
  if (isInstructionText(norm) || isRowSubInstructionLine(norm)) return false;
  // Comma- or slash- or dash-separated short lexical items (3..8 items), e.g. `repeatedly, forever, demand, arrange`
  const parts = norm
    .replace(/^[([{]+|[)\]}]+$/g, '')
    .split(/\s*(?:,|،|\/|–|—|\s-\s)\s*/u)
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length < 3 || parts.length > 8) return false;
  return parts.every(p => p.length >= 1 && p.length <= 28 && !/[.?!؟]$/u.test(p));
}

function hasInlineWordBankCue(text: string, inInstruction = false): boolean {
  const norm = normalizeForMatching(text);
  // e.g. `(but, and, so, or)`, `but, and, so, or) (`, `whom, who یا which`, `با کلمات داده شده کامل کنید`
  if (/\(\s*[a-zA-Z]+(?:\s*,\s*[a-zA-Z]+){2,6}\s*\)/u.test(norm)) return true;
  if (inInstruction && /\b[a-zA-Z]{2,15}(?:\s*,\s*[a-zA-Z]{2,15}){2,6}\b/u.test(norm)) return true;
  if (/\b[a-zA-Z]+\s*,\s*[a-zA-Z]+\s+(?:یا|or)\s+[a-zA-Z]+\b/iu.test(norm)) return true;
  if (/با\s+(?:استفاده\s+از\s+)?کلمات\s+داده\s+شده|words?\s+(?:given\s+)?in\s+the\s+(?:box|bank)|from\s+the\s+word\s*bank/iu.test(norm)) return true;
  return false;
}

/**
 * Form 4: WORD-BANK (`form:word-bank`)
 * Recognizes blanked fill-in-the-blank items backed by a shared or inline word bank,
 * strips leaked trailing instructions or bogus unsplit word-bank options, and sets `type = 'fillblank'`.
 */
function applyWordBankForm(
  questions: Question[],
  sourceLines: SourceLine[],
  lineMap: Map<number, SourceLine>,
  flags: Flag[],
  appliedRulesByQ: Map<string, string[]>,
): void {
  const sortedLineNos = [...lineMap.keys()].sort((a, b) => a - b);

  for (const q of questions) {
    if (q.type === 'matching' || q.type === 'truefalse') continue;
    // Skip genuine MCQs that already have >=2 distinct valid options (unless options are an unsplit word-bank line).
    if ((q.options || []).length >= 2) {
      const optTexts = q.options!.map(o => normMatch(o.text)).filter(Boolean);
      const allDistinct = optTexts.length >= 2 && new Set(optTexts).size === optTexts.length;
      if (allDistinct) continue;
    }

    const stemText = q.stem || '';
    if (!BLANK_MARKER_RE.test(stemText)) continue;

    // Look for word-bank evidence in the stem itself or walking upward to the nearest row boundary.
    const qLines = spanLineNumbers(q.spans);
    const firstLn = qLines[0];
    let hasBankCue = hasInlineWordBankCue(stemText);

    if (!hasBankCue && firstLn !== undefined) {
      const idx = sortedLineNos.indexOf(firstLn);
      for (let k = idx - 1; k >= Math.max(0, idx - 10); k--) {
        const l = lineMap.get(sortedLineNos[k]);
        if (!l || l.furniture) continue;
        const isSubInstr = isRowSubInstructionLine(l.text);
        const isInstr = isSubInstr || isInstructionText(l.text);
        if (isWordBankListLine(l.text) || hasInlineWordBankCue(l.text, isInstr)) {
          hasBankCue = true;
          break;
        }
        // Stop at the nearest row sub-header instruction so a word bank from an earlier row cannot leak downward.
        if (isSubInstr) break;
      }
    }

    if (!hasBankCue) continue;

    let changed = false;
    // Trim any leaked trailing row instruction lines out of `q.spans`.
    if (qLines.length > 1 && !q.spans.some(spanHasOffsets)) {
      const cleanLines: number[] = [qLines[0]];
      for (let i = 1; i < qLines.length; i++) {
        const l = lineMap.get(qLines[i]);
        if (!l) continue;
        if (isRowSubInstructionLine(l.text) || isInstructionText(l.text)) break;
        cleanLines.push(qLines[i]);
      }
      if (cleanLines.length < qLines.length) {
        q.spans = compressLineNumbers(cleanLines);
        q.stem = sliceSourceSpans(q.spans, sourceLines);
        changed = true;
      }
    }

    if (q.options !== undefined) {
      q.options = undefined;
      removeQuestionFlags(q, ['OPTION_SPLIT_FAILED', 'OPTIONS_MISSING', 'OPTION_DUPLICATE']);
      changed = true;
    }

    if (applyTypeFromForm(q, 'fillblank', 'WORD-BANK', flags)) changed = true;
    ensureRule(q, FORM_RULE_ID['WORD-BANK']);
    if (changed) {
      appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID['WORD-BANK']]);
    }
  }
}

function isUnscrambleLineOrStem(text: string): boolean {
  const norm = normalizeStoredText(text).trim();
  if (!norm) return false;
  const hasRealWords = (parts: string[]) =>
    parts.filter(p => /[A-Za-z\p{Script=Arabic}]/u.test(p)).length >= 3 &&
    parts.every(p => /[A-Za-z\p{Script=Arabic}0-9,?!؟.]/u.test(p));
  const slashParts = norm.split('/').map(s => s.trim()).filter(Boolean);
  if (slashParts.length >= 4 && /\/\s*[.?!؟]\s*$/u.test(norm) && hasRealWords(slashParts)) return true;
  const dashParts = norm.split(/\s+[-–—]\s+/u).map(s => s.trim()).filter(Boolean);
  if (dashParts.length >= 4 && /(?:\/|\s[-–—])\s*[.?!؟]\s*$/u.test(norm) && hasRealWords(dashParts)) return true;
  return false;
}

/**
 * Form 5: UNSCRAMBLE (`form:unscramble`)
 * Slash- or dash-separated word fragments ending in `/.` or `/?` -> stem preserved verbatim
 * in exact printed order (NEVER reordered in code!), `type = 'short'`, `options = undefined`.
 */
function applyUnscrambleForm(
  questions: Question[],
  sourceLines: SourceLine[],
  lineMap: Map<number, SourceLine>,
  flags: Flag[],
  appliedRulesByQ: Map<string, string[]>,
): void {
  for (const q of questions) {
    const qLines = spanLineNumbers(q.spans);
    const firstLineText = qLines[0] !== undefined ? (lineMap.get(qLines[0])?.text || '') : '';
    const matchesStem = isUnscrambleLineOrStem(q.stem || '');
    const matchesFirstLine = isUnscrambleLineOrStem(firstLineText);
    if (!matchesStem && !matchesFirstLine) continue;

    let changed = false;
    // Clip any leaked non-unscramble trailing lines (e.g. closing instruction or next row header) while keeping verbatim fragment order.
    if (qLines.length > 1 && !q.spans.some(spanHasOffsets)) {
      const keepLines: number[] = [];
      for (const ln of qLines) {
        const l = lineMap.get(ln);
        if (!l) continue;
        keepLines.push(ln);
        if (/\/\s*[.?!؟]\s*$/u.test(normalizeStoredText(l.text).trim())) break;
      }
      if (keepLines.length > 0 && keepLines.length < qLines.length) {
        q.spans = compressLineNumbers(keepLines);
        q.stem = sliceSourceSpans(q.spans, sourceLines);
        changed = true;
      }
    }

    if (q.options !== undefined) {
      q.options = undefined;
      removeQuestionFlags(q, ['OPTION_SPLIT_FAILED', 'OPTIONS_MISSING', 'OPTION_DUPLICATE']);
      changed = true;
    }

    if (applyTypeFromForm(q, 'short', 'UNSCRAMBLE', flags)) changed = true;
    ensureRule(q, FORM_RULE_ID.UNSCRAMBLE);
    if (changed) {
      appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID.UNSCRAMBLE]);
    }
  }
}

function hasSpeakerTurnPair(text: string): boolean {
  const norm = normalizeStoredText(text);
  const hasA = /(?:^|\n|\s|\d+\s*[.)\-:]\s*)A\s*:\s*\S/u.test(norm);
  const hasB = /(?:^|\n|\s)B\s*:\s*\S/u.test(norm);
  return hasA && hasB;
}

/**
 * Form 6: DIALOGUE (`form:dialogue`)
 * Recognizes speaker-turn `"A:"` / `"B:"` stems (including cases where a model misread `"A:"` and `"B:"`
 * as fake MCQ options `a` and `b`!). Restores full two-turn stem verbatim; sets `type` to `'short'`
 * when no real MCQ option set follows (schema uses `'short'` since `'dialogue'` is not in `Question['type']`).
 */
function applyDialogueForm(
  questions: Question[],
  sourceLines: SourceLine[],
  lineMap: Map<number, SourceLine>,
  flags: Flag[],
  appliedRulesByQ: Map<string, string[]>,
): void {
  for (const q of questions) {
    if (!q.parentId && q.receipt?.ruleChain.includes('dialogue-group')) continue;
    const allLineNos = [
      ...new Set([
        ...spanLineNumbers(q.spans),
        ...(q.options || []).flatMap(o => spanLineNumbers(o.spans)),
      ]),
    ].sort((a, b) => a - b);

    const combinedSourceText = allLineNos.map(ln => lineMap.get(ln)?.text || '').filter(Boolean).join('\n');
    const stemHasDialogue = hasSpeakerTurnPair(q.stem || '');
    const sourceHasDialogue = hasSpeakerTurnPair(combinedSourceText);
    if (!stemHasDialogue && !sourceHasDialogue) continue;

    let changed = false;

    // Check if the model falsely split `A: ...` and `B: ...` into 2 fake MCQ options!
    const fakeSpeakerOptions =
      (q.options || []).length === 2 &&
      !isCanonicalTrueFalsePair(q.options) &&
      (!stemHasDialogue && sourceHasDialogue);

    if (fakeSpeakerOptions && allLineNos.length > 0) {
      const restoredSpans = compressLineNumbers(allLineNos);
      const restoredStem = sliceSourceSpans(restoredSpans, sourceLines);
      if (hasSpeakerTurnPair(restoredStem)) {
        q.spans = restoredSpans;
        q.stem = restoredStem;
        q.options = undefined;
        removeQuestionFlags(q, ['OPTION_SPLIT_FAILED', 'OPTIONS_MISSING', 'OPTION_DUPLICATE']);
        changed = true;
      }
    }

    const hasRealOptions = (q.options || []).length >= 2 &&
      new Set((q.options || []).map(o => normMatch(o.text)).filter(Boolean)).size === (q.options || []).length;

    if (!hasRealOptions) {
      if (q.options && q.options.length > 0) {
        q.options = undefined;
        removeQuestionFlags(q, ['OPTION_SPLIT_FAILED', 'OPTIONS_MISSING', 'OPTION_DUPLICATE']);
        changed = true;
      }
      if (applyTypeFromForm(q, 'short', 'DIALOGUE', flags)) changed = true;
      ensureRule(q, FORM_RULE_ID.DIALOGUE);
    }

    if (changed) {
      appliedRulesByQ.set(q.id, [...(appliedRulesByQ.get(q.id) || []), FORM_RULE_ID.DIALOGUE]);
    }
  }
}

/**
 * Runs the full deterministic canonicalizer registry (C3 brake + 6 C2 forms in fixed order).
 * Pure & idempotent: never mutates caller inputs.
 */
export function canonicalizeForms(params: {
  questions: Question[];
  sourceLines: SourceLine[];
  sections?: ExamSection[];
  scopeQuestionIds?: Set<string>;
}): CanonicalizeResult {
  const sourceLines = params.sourceLines || [];
  const lineMap = buildSourceLineMap(sourceLines);
  const beforeById = new Map(params.questions.map(q => [q.id, q]));

  let workingQuestions = params.questions.map(cloneQuestion);
  const workingSections = (params.sections || []).map(cloneSection);
  const flags: Flag[] = [];
  const appliedRulesByQ = new Map<string, string[]>();

  // Fixed deterministic execution order: C3 passage-tail brake -> TRUEFALSE -> MCQ-INLINE -> MATCHING-POOL -> WORD-BANK -> UNSCRAMBLE -> DIALOGUE
  applyPassageTailBrake(workingQuestions, workingSections, lineMap, flags, appliedRulesByQ);
  applyTrueFalseForm(workingQuestions, sourceLines, lineMap, flags, appliedRulesByQ);
  applyMcqInlineForm(workingQuestions, sourceLines, lineMap, flags, appliedRulesByQ);
  workingQuestions = applyMatchingPoolForm(workingQuestions, sourceLines, lineMap, flags, appliedRulesByQ);
  applyWordBankForm(workingQuestions, sourceLines, lineMap, flags, appliedRulesByQ);
  applyUnscrambleForm(workingQuestions, sourceLines, lineMap, flags, appliedRulesByQ);
  applyDialogueForm(workingQuestions, sourceLines, lineMap, flags, appliedRulesByQ);

  for (const parent of workingQuestions.filter(q => !q.parentId)) {
    const section = workingSections.find(s => s.id === parent.sectionId);
    if (!/writing/i.test(section?.title || '')) continue;
    const children = workingQuestions.filter(q => q.parentId === parent.id);
    if (!children.length) continue;
    const body = [parent, ...children].map(q => q.stem || '').join('\n');
    if (!/(?:^|\s)[a-d][).]\s*\S/imu.test(body)) continue;
    applyTypeFromForm(parent, 'long', 'WRITING-TOPICS', flags);
    ensureRule(parent, FORM_RULE_ID['WRITING-TOPICS']);
    appliedRulesByQ.set(parent.id, [...(appliedRulesByQ.get(parent.id) || []), FORM_RULE_ID['WRITING-TOPICS']]);
  }

  // If scoped to specific question IDs, keep untouched questions verbatim while allowing scoped questions + their group children to update.
  if (params.scopeQuestionIds && params.scopeQuestionIds.size > 0) {
    const allowedIds = new Set<string>(params.scopeQuestionIds);
    for (const q of workingQuestions) {
      if (q.parentId && allowedIds.has(q.parentId)) allowedIds.add(q.id);
    }
    workingQuestions = workingQuestions.map(q => {
      if (allowedIds.has(q.id)) return q;
      const orig = beforeById.get(q.id);
      return orig ? cloneQuestion(orig) : q;
    });
  }

  const deltas: FormApplicationDelta[] = [];
  for (const after of workingQuestions) {
    const before = beforeById.get(after.id);
    if (!before) continue;
    if (params.scopeQuestionIds && params.scopeQuestionIds.size > 0) {
      const inScope = params.scopeQuestionIds.has(after.id) || (after.parentId !== undefined && params.scopeQuestionIds.has(after.parentId));
      if (!inScope) continue;
    }
    const stemChanged = (before.stem || '') !== (after.stem || '');
    const optionsChanged = JSON.stringify(before.options || []) !== JSON.stringify(after.options || []);
    const typeChanged = before.type !== after.type;
    const rules = [...new Set(appliedRulesByQ.get(after.id) || [])];
    if (stemChanged || optionsChanged || typeChanged || rules.length > 0) {
      deltas.push({
        questionId: after.id,
        no: after.no,
        rules,
        stemChanged,
        optionsChanged,
        typeChanged,
        oldType: before.type,
        newType: after.type,
      });
    }
  }
  // Also record removed phantom self-children as deltas on their parent when applicable.
  for (const [beforeId, beforeQ] of beforeById.entries()) {
    if (!workingQuestions.some(q => q.id === beforeId)) {
      deltas.push({
        questionId: beforeId,
        no: beforeQ.no,
        rules: [FORM_RULE_ID['MATCHING-POOL']],
        stemChanged: true,
        optionsChanged: false,
        typeChanged: false,
        oldType: beforeQ.type,
        newType: beforeQ.type,
      });
    }
  }

  return {
    questions: workingQuestions,
    sections: workingSections,
    flags,
    deltas,
  };
}

/**
 * Diagnoses shape-class problems across an `ExamDoc` for Part D (`diagnose_missing` / health / confidence floor):
 * duplicate options, option containing whole stem, sibling-identical stems, overlong stems (>500 chars),
 * and malformed True/False questions.
 */
export function detectShapeProblemQuestions(doc: ExamDoc): ShapeProblemDiagnosis[] {
  const byId = new Map<string, Set<ShapeProblemDiagnosis['kinds'][number]>>();
  const qById = new Map((doc.questions || []).map(q => [q.id, q]));
  const mark = (q: Question, kind: ShapeProblemDiagnosis['kinds'][number]) => {
    const set = byId.get(q.id) || new Set();
    set.add(kind);
    byId.set(q.id, set);
  };

  for (const q of doc.questions || []) {
    const opts = q.options || [];
    if (opts.length >= 2) {
      const normOpts = opts.map(o => normMatch(o.text)).filter(Boolean);
      if (normOpts.length >= 2 && new Set(normOpts).size < normOpts.length) {
        mark(q, 'duplicate-options');
      }
      const normStem = normMatch(q.stem);
      if (normStem.length >= 8 && normOpts.some(t => t === normStem || t.includes(normStem))) {
        mark(q, 'option-contains-stem');
      }
    }
    if ((q.stem || '').length > 500 || q.flags?.includes('STEM_OVERLONG')) {
      mark(q, 'overlong-stem');
    }
    // Malformed TF: type is truefalse without canonical pair, OR stem still carries inline `a) True b) False` tail,
    // OR 2-option canonical TF pair is mis-typed as mcq.
    const inlineTfInStem = /(?:^|\s)(?:\(?a\)?[).:]\s*true\s+\(?b\)?[).:]\s*false|\(?الف\)?[).:]\s*درست\s+\(?ب\)?[).:]\s*نادرست)/iu.test(
      normalizeStoredText(q.stem || ''),
    );
    if (inlineTfInStem) {
      mark(q, 'malformed-truefalse');
    } else if (q.type === 'truefalse' && !isCanonicalTrueFalsePair(q.options)) {
      mark(q, 'malformed-truefalse');
    } else if (q.type !== 'truefalse' && isCanonicalTrueFalsePair(q.options)) {
      mark(q, 'malformed-truefalse');
    }
  }

  // Sibling-identical stems
  const buckets = new Map<string, Question[]>();
  for (const q of doc.questions || []) {
    const key = q.parentId ? `parent:${q.parentId}` : `root:${q.sectionId || '__default__'}`;
    buckets.set(key, [...(buckets.get(key) || []), q]);
  }
  for (const siblings of buckets.values()) {
    if (siblings.length < 2) continue;
    const byStem = new Map<string, Question[]>();
    for (const q of siblings) {
      const s = normMatch(q.stem);
      if (!s) continue;
      byStem.set(s, [...(byStem.get(s) || []), q]);
    }
    for (const dupGroup of byStem.values()) {
      if (dupGroup.length < 2) continue;
      for (const q of dupGroup) mark(q, 'sibling-identical-stem');
    }
  }

  return [...byId.entries()]
    .map(([id, kinds]) => {
      const q = qById.get(id)!;
      return { questionId: id, no: q.no, kinds: [...kinds] };
    })
    .sort((a, b) => a.no - b.no);
}

/**
 * Part A4 shape audit helper:
 * (1) questions whose options include their whole stem,
 * (2) duplicate stems among siblings,
 * (3) stems > 500 chars.
 */
export interface ShapeAuditCounts {
  optionIncludesStem: number;
  duplicateSiblingStems: number;
  overlongStems: number;
}

export function computeShapeAudit(questions: Question[]): ShapeAuditCounts {
  let optionIncludesStem = 0;
  let duplicateSiblingStems = 0;
  let overlongStems = 0;

  for (const q of questions) {
    const normStem = normMatch(q.stem);
    if (normStem.length >= 6 && (q.options || []).some(o => normMatch(o.text).includes(normStem))) {
      optionIncludesStem++;
    }
    if ((q.stem || '').length > 500) {
      overlongStems++;
    }
  }

  const buckets = new Map<string, Question[]>();
  for (const q of questions) {
    const key = q.parentId ? `parent:${q.parentId}` : `root:${q.sectionId || '__default__'}`;
    buckets.set(key, [...(buckets.get(key) || []), q]);
  }
  for (const siblings of buckets.values()) {
    if (siblings.length < 2) continue;
    const seen = new Set<string>();
    for (const q of siblings) {
      const s = normMatch(q.stem);
      if (!s) continue;
      if (seen.has(s)) duplicateSiblingStems++;
      else seen.add(s);
    }
  }

  return { optionIncludesStem, duplicateSiblingStems, overlongStems };
}

/**
 * Fix 1 (Marvel Batch 6) — the SAME canonicalizer registry, run LAST.
 *
 * Assembly-time canonicalization only shapes the first pass. Escalation repair, consensus,
 * critic reparse and Assistant mutations replace questions wholesale after that, and those
 * replacements never pass through the registry. Running the identical exported
 * `canonicalizeForms` over the final question set — after every question-producing or
 * question-replacing stage — turns "canonicalization is a suggestion" into a guarantee.
 *
 * Order (no forked logic):
 *   (a) `canonicalizeForms` — the Batch-6 registry; its first entry is the C3 >500-char
 *       passage-tail brake, so (b) passage re-detachment for any stem >500 chars reuses the
 *       existing machinery unchanged.
 *   (c) shape audit over the canonicalized result (counts are surfaced by the caller on the
 *       stage card / health; remaining classes are demoted, never blocked).
 *   (d) any stem still >500 chars after re-detachment keeps its exact text (the canonicalizers
 *       never invent or truncate) and is reported as STEM_OVERLONG for the health report.
 *
 * Pure & idempotent: never mutates the caller's questions/sections.
 */
export interface FinalCanonicalizationResult {
  questions: Question[];
  sections: ExamSection[];
  flags: Flag[];
  shapeAudit: ShapeAuditCounts;
  shapeProblems: ShapeProblemDiagnosis[];
  /** Stems that remain over the 500-char brake after re-detachment (text kept verbatim). */
  stemOverlong: Array<{ questionId: string; no: number; label: string; length: number }>;
}

export function runFinalCanonicalization(params: {
  questions: Question[];
  sourceLines: SourceLine[];
  sections?: ExamSection[];
}): FinalCanonicalizationResult {
  const canonical = canonicalizeForms({
    questions: params.questions || [],
    sourceLines: params.sourceLines || [],
    sections: params.sections || [],
  });

  const questions = canonical.questions;
  const sections = canonical.sections;
  const flags: Flag[] = [...canonical.flags];

  // (c) shape audit on the final set.
  const shapeAudit = computeShapeAudit(questions);
  const shapeProblems = detectShapeProblemQuestions({ questions, sections } as ExamDoc);

  // (d) overlong stems that survived the C3 brake: keep text, keep/raise STEM_OVERLONG, report.
  const stemOverlong: FinalCanonicalizationResult['stemOverlong'] = [];
  for (const q of questions) {
    const length = (q.stem || '').length;
    // Only a stem that is STILL over the brake is a live finding; a persisted STEM_OVERLONG flag
    // that a later edit made obsolete stays as provenance but is not re-reported.
    if (length <= 500) continue;
    addQuestionFlag(q, 'STEM_OVERLONG');
    pushUniqueFlag(flags, {
      id: `flag_STEM_OVERLONG_${q.id}`,
      severity: 'warn',
      code: 'STEM_OVERLONG',
      message: `Q${q.no}: stem is ${length} chars (>500) after the final re-detachment pass; text kept verbatim and flagged for review.`,
      questionId: q.id,
    });
    stemOverlong.push({ questionId: q.id, no: q.no, label: q.label || String(q.no), length });
  }

  return { questions, sections, flags, shapeAudit, shapeProblems, stemOverlong };
}
