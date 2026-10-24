/**
 * Part F2 — Deterministic Local Field Replay & Diff Summary
 *
 * Feeds the `source.lines` of a saved/exported structured exam JSON (such as
 * `English — 11_structured (2).json`) through the purely deterministic local
 * pipeline (scripted anchor model, 0 provider calls) and computes per-class
 * structural & text-shape diff counts against the exported questions/sections.
 */
import type { ExamDoc, ExamSection, Question, SourceLine } from '../types';
import {
  detectKeyTerritory,
  detectSectionHeaders,
  enumerateExpectedQuestionNos,
  extractDocumentTotals,
  normalizeForMatching,
  parsePrintedNumberFromStem,
} from './quality';
import { findIntraLineMultiNumbers, segmentDocument } from './segment';
import { assembleAndValidateQuestions } from './assemble';
import { applyLocalGates } from './gates';
import { computeShapeAudit, FORM_EXECUTION_ORDER, FORM_RULE_ID, type FormName, type ShapeAuditCounts } from './forms';
import { spanEndLine, spanStartLine } from './spans';

export interface FieldReplayPerClassDiffs {
  sectionHeadersCorrected: number;
  bogusSubheaderSectionsRemoved: number;
  inlineOptionsCarved: number;
  stemsDecontaminated: number;
  overlongPassageStemsFixed: number;
  siblingDuplicateStemsFixed: number;
  phantomSelfChildrenRemoved: number;
  typesCanonicalized: number;
  formsApplied: Record<FormName, number>;
}

export interface FieldReplayReport {
  fileName: string;
  sourceLineCount: number;
  sections: {
    exported: number;
    replayed: number;
    exportedTitles: string[];
    replayedTitles: string[];
  };
  questions: {
    exportedCount: number;
    replayedCount: number;
    exportedUniqueNos: number;
    replayedUniqueNos: number;
  };
  totalPoints: {
    exported: number | undefined;
    replayed: number | undefined;
  };
  shapeBefore: ShapeAuditCounts;
  shapeAfter: ShapeAuditCounts;
  perClassDiffs: FieldReplayPerClassDiffs;
  replayedSections: ExamSection[];
  replayedQuestions: Question[];
}

function lineNo(line: SourceLine): number {
  return Number(String(line.id).replace(/\D/g, '')) || 0;
}

function norm(s: string | undefined): string {
  return normalizeForMatching(s || '').replace(/\s+/g, ' ').trim();
}

function hasDistinctOptions(q: Question | undefined): boolean {
  const opts = q?.options || [];
  if (opts.length < 2) return false;
  const texts = opts.map(o => norm(o.text)).filter(Boolean);
  return texts.length === opts.length && new Set(texts).size === texts.length;
}

function buildScriptedRawFromLines(
  lines: SourceLine[],
  sectionDefs: ExamSection[],
  keyLines: Set<number>,
  segments: ReturnType<typeof segmentDocument>['segments'],
  exportedQuestions: Question[],
): any[] {
  const enumerated = enumerateExpectedQuestionNos(lines);
  const exportedNos = exportedQuestions
    .map(q => q.no)
    .filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 300);
  const candidateNos = [...new Set([...enumerated.numbers, ...exportedNos])].sort((a, b) => a - b);

  const autoChildren = new Set(
    segments.flatMap(seg =>
      seg.parentSegmentId && seg.printedNo !== undefined
        ? [Number(seg.printedNo)]
        : seg.kind === 'group-parent'
          ? (seg.groupForm === 'dialogue' || seg.groupForm === 'enumeration'
              ? (seg.childNos || []).map(Number)
              : (seg.childNos || []).filter((no: number) => Number(no) !== Number(seg.printedNo)))
          : [],
    ),
  );

  // Preserve non-shape hint types (e.g. long/essay) when available on root items, otherwise scripted lazy anchor.
  const exportedRootByNo = new Map<number, Question>();
  for (const eq of exportedQuestions) {
    if (!eq.parentId && !exportedRootByNo.has(eq.no)) {
      exportedRootByNo.set(eq.no, eq);
    }
  }

  const raw: any[] = [];
  for (const no of candidateNos) {
    if (autoChildren.has(no)) continue;
    const mapped = enumerated.lineByNumber.get(no);
    const fallbackLine = lines.find(
      l => parsePrintedNumberFromStem(l.text) === no && l.tag !== 'key' && !l.furniture && !keyLines.has(lineNo(l)),
    );
    const anchor = mapped ?? (fallbackLine ? lineNo(fallbackLine) : undefined);
    if (!anchor) continue;
    const anchorLine = lines.find(l => lineNo(l) === anchor);
    const intra = anchorLine ? findIntraLineMultiNumbers(anchorLine.text) : [];
    if (intra.some(it => it.no === no) && intra[0]?.no !== no) continue;

    const spanText = anchorLine?.text || '';
    const inlineMcq = intra.length < 2 && [...spanText.matchAll(/(?:^|\s|[)\]])(?:\([a-d]\)|[a-d][).:])/gi)].length >= 2;
    const sec = sectionDefs.find(s => s.spans[0] && spanStartLine(s.spans[0]) <= anchor && spanEndLine(s.spans[0]) >= anchor);
    const hintType = exportedRootByNo.get(no)?.type;
    const type: Question['type'] =
      hintType === 'essay' || hintType === 'long'
        ? hintType
        : inlineMcq
          ? 'mcq'
          : 'unknown';

    const sourceSpan: [number, number] = [anchor, anchor];
    raw.push({
      id: `q${no}`,
      no,
      label: String(no),
      sectionId: sec?.id,
      spans: [sourceSpan],
      type,
      confidence: 0.85,
      ...(inlineMcq ? { options: ['a', 'b', 'c', 'd'].map(key => ({ key, spans: [sourceSpan] })) } : {}),
    });
  }
  return raw;
}

export function replayFieldExport(
  exportedDoc: Partial<ExamDoc> & { source: { lines: SourceLine[]; fileName?: string } },
  labelOverride?: string,
): FieldReplayReport {
  const lines = exportedDoc.source.lines || [];
  const exportedSections = exportedDoc.sections || [];
  const exportedQuestions = exportedDoc.questions || [];
  const exportedTotal = exportedDoc.meta?.totalPoints;

  const keyLines = detectKeyTerritory(lines).lineNos;
  const nonKeyLines = lines.filter(l => !keyLines.has(lineNo(l)));
  const headers = detectSectionHeaders(nonKeyLines);
  const maxLn = Math.max(0, ...nonKeyLines.map(lineNo));

  const sectionDefs: ExamSection[] = headers.map((h, idx) => ({
    id: `sec_${idx + 1}`,
    index: idx + 1,
    title: h.title,
    spans: [[h.headerLine, (headers[idx + 1]?.headerLine || maxLn + 1) - 1]],
  }));

  const segRes = segmentDocument({ lines, keyLines });
  const raw = buildScriptedRawFromLines(lines, sectionDefs, keyLines, segRes.segments, exportedQuestions);
  const docTotal = extractDocumentTotals(lines, keyLines).documentTotal ?? exportedTotal;

  const assembled = assembleAndValidateQuestions(raw, lines, docTotal, {
    keyTerritoryLineNos: [...keyLines],
    gapCompletion: true,
    segmentReceipts: segRes.segments,
    sections: sectionDefs,
  });

  const gated = applyLocalGates({
    questions: assembled.questions,
    rawSections: sectionDefs,
    lines,
    keyLines,
    metaTotalPoints: docTotal,
  });

  const replayedSections = gated.sections;
  const replayedQuestions = gated.questions;

  const shapeBefore = computeShapeAudit(exportedQuestions);
  const shapeAfter = computeShapeAudit(replayedQuestions);

  // Compute phantom self-children removed: exported children with `child.no === parent.no`
  const exportedById = new Map(exportedQuestions.map(q => [q.id, q]));
  let exportedSelfChildren = 0;
  for (const eq of exportedQuestions) {
    if (!eq.parentId) continue;
    const p = exportedById.get(eq.parentId);
    if (eq.parentId === eq.id || (p && p.no === eq.no)) exportedSelfChildren++;
  }
  const replayedById = new Map(replayedQuestions.map(q => [q.id, q]));
  let replayedSelfChildren = 0;
  for (const rq of replayedQuestions) {
    if (!rq.parentId) continue;
    const p = replayedById.get(rq.parentId);
    if (rq.parentId === rq.id || (p && p.no === rq.no)) replayedSelfChildren++;
  }
  const phantomSelfChildrenRemoved = Math.max(0, exportedSelfChildren - replayedSelfChildren);

  // Index by `(no, isChild)` so root and child questions align cleanly
  const expByNo = new Map<number, Question>();
  for (const eq of exportedQuestions) {
    const p = eq.parentId ? exportedById.get(eq.parentId) : undefined;
    if (p && p.no === eq.no) continue; // skip phantom self-child when indexing primary question for `no`
    if (!expByNo.has(eq.no) || eq.parentId) expByNo.set(eq.no, eq);
  }
  const repByNo = new Map<number, Question>();
  for (const rq of replayedQuestions) {
    if (!repByNo.has(rq.no) || rq.parentId) repByNo.set(rq.no, rq);
  }

  let inlineOptionsCarved = 0;
  let stemsDecontaminated = 0;
  let overlongPassageStemsFixed = 0;
  let typesCanonicalized = 0;

  for (const [no, rq] of repByNo.entries()) {
    const eq = expByNo.get(no);
    if (!eq) continue;
    if (!hasDistinctOptions(eq) && hasDistinctOptions(rq)) {
      inlineOptionsCarved++;
    } else if (
      hasDistinctOptions(rq) &&
      (eq.options || []).some(o => norm(o.text).includes(norm(rq.stem)) && norm(rq.stem).length >= 8)
    ) {
      inlineOptionsCarved++;
    }
    const eStem = norm(eq.stem);
    const rStem = norm(rq.stem);
    if (eStem !== rStem && eStem.length > rStem.length && rStem.length > 0) {
      stemsDecontaminated++;
    }
    if ((eq.stem || '').length > 500 && (rq.stem || '').length <= 500) {
      overlongPassageStemsFixed++;
    }
    if (eq.type !== rq.type) {
      typesCanonicalized++;
    }
  }

  const siblingDuplicateStemsFixed = Math.max(
    0,
    shapeBefore.duplicateSiblingStems - shapeAfter.duplicateSiblingStems,
  );

  const formsApplied: Record<FormName, number> = {
    TRUEFALSE: 0,
    'MCQ-INLINE': 0,
    'MATCHING-POOL': 0,
    'WORD-BANK': 0,
    UNSCRAMBLE: 0,
    DIALOGUE: 0,
    'WRITING-TOPICS': 0,
  };
  for (const rq of replayedQuestions) {
    const chain = rq.receipt?.ruleChain || [];
    for (const form of FORM_EXECUTION_ORDER) {
      if (chain.includes(FORM_RULE_ID[form])) {
        formsApplied[form]++;
      }
    }
  }

  const exportedTitles = exportedSections.map(s => s.title || '');
  const replayedTitles = replayedSections.map(s => s.title || '');
  const bogusSubheaderSectionsRemoved = Math.max(0, exportedSections.length - replayedSections.length);
  const maxSecLen = Math.max(exportedTitles.length, replayedTitles.length);
  let sectionHeadersCorrected = 0;
  for (let i = 0; i < maxSecLen; i++) {
    if (exportedTitles[i] !== replayedTitles[i]) sectionHeadersCorrected++;
  }

  return {
    fileName: labelOverride || exportedDoc.source.fileName || 'field-export.json',
    sourceLineCount: lines.length,
    sections: {
      exported: exportedSections.length,
      replayed: replayedSections.length,
      exportedTitles,
      replayedTitles,
    },
    questions: {
      exportedCount: exportedQuestions.length,
      replayedCount: replayedQuestions.length,
      exportedUniqueNos: new Set(exportedQuestions.map(q => q.no)).size,
      replayedUniqueNos: new Set(replayedQuestions.map(q => q.no)).size,
    },
    totalPoints: {
      exported: exportedTotal,
      replayed: gated.totalPoints,
    },
    shapeBefore,
    shapeAfter,
    perClassDiffs: {
      sectionHeadersCorrected,
      bogusSubheaderSectionsRemoved,
      inlineOptionsCarved,
      stemsDecontaminated,
      overlongPassageStemsFixed,
      siblingDuplicateStemsFixed,
      phantomSelfChildrenRemoved,
      typesCanonicalized,
      formsApplied,
    },
    replayedSections,
    replayedQuestions,
  };
}
