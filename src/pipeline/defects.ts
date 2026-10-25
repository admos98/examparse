/**
 * #38 Part C — Verify. After assembly, code proves (or disproves) the document arithmetically
 * and emits a TYPED DEFECT LIST. This module invents no new judgments: it re-expresses the
 * existing invariant machinery (validateExamInvariants I-codes, evaluateCoverage, ownership
 * orphans) as defects with EVIDENCE — line addresses + sliced document text, never summaries.
 * The repair loop (Part D) consumes these defects; whatever survives goes to the teacher via
 * the existing attention function. Internal codes never surface to teachers directly.
 */
import type { ExamDoc, Question, SourceLine } from '../types';
import { evaluateCoverage, validateExamInvariants } from './quality';
import { computeOwnership } from './ownership';
import { parsePrintedNumberFromStem } from './quality';
import { lineNo } from './classify';

export const DEFECT_KINDS = [
  'unaccounted-lines',
  'duplicate-number',
  'missing-number',
  'hollow-question',
  'options-missing',
  'points-sum',
  'points-unresolved',
  'span-overlap',
  'image-ownership',
] as const;
export type DefectKind = (typeof DEFECT_KINDS)[number];

export interface DefectEvidenceLine { line: number; text: string }

export interface Defect {
  id: string;
  kind: DefectKind;
  questionIds: string[];
  lineIds: number[];
  /** Sliced document text for the cited lines (trimmed), never a paraphrase. */
  evidence: DefectEvidenceLine[];
  detail: string;
}

export interface DefectDocLike {
  questions: Question[];
  sections: ExamDoc['sections'];
  images?: ExamDoc['images'];
  totalPoints?: number;
}

const MAX_EVIDENCE_LINES = 6;
const MAX_EVIDENCE_CHARS = 140;

function ev(lines: Map<number, SourceLine>, nos: number[]): DefectEvidenceLine[] {
  return [...new Set(nos)].sort((a, b) => a - b).slice(0, MAX_EVIDENCE_LINES)
    .map(line => ({ line, text: (lines.get(line)?.text || '').slice(0, MAX_EVIDENCE_CHARS) }));
}

function questionLineNos(q: Question): number[] {
  const raw: any[] = (q as any).stemSpans || q.spans || [];
  const out: number[] = [];
  for (const span of raw) {
    if (Array.isArray(span)) { for (let n = Number(span[0]); n <= Number(span[1]); n++) out.push(n); }
    else if (span && typeof span === 'object' && Number.isInteger(span.line)) out.push(span.line);
  }
  return out;
}

function contiguousRuns(sortedNos: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const n of sortedNos) {
    const last = runs[runs.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

export function computeDefects(params: {
  doc: DefectDocLike;
  lines: SourceLine[];
  expectedNumbers: number[];
  /** Printed-number start lines from the local enumeration (arithmetic evidence for gaps). */
  expectedStarts?: Array<{ no: number; line: number }>;
  keyLineNos: number[];
  /** Classify path: lines the labels accounted as furniture/blank or section prelude (not defects). */
  accountedLineNos?: number[];
}): Defect[] {
  const defects: Defect[] = [];
  const lineByNo = new Map(params.lines.map(line => [lineNo(line), line]));
  const questions = params.doc.questions;
  const byId = new Map(questions.map(q => [q.id, q]));
  const totalPoints = params.doc.totalPoints;

  // --- Coverage-based kinds (duplicates / gaps / points sum) — existing arithmetic, reused.
  const coverage = evaluateCoverage(params.expectedNumbers, questions, totalPoints);
  const numberOf = (q: Question) => parsePrintedNumberFromStem(q.stem || '') ?? Number(q.no);
  for (const n of coverage.duplicates) {
    const matches = questions.filter(q => numberOf(q) === n);
    defects.push({
      id: `duplicate-number:${n}`,
      kind: 'duplicate-number',
      questionIds: matches.map(q => q.id),
      lineIds: matches.flatMap(q => questionLineNos(q).slice(0, 2)),
      evidence: ev(lineByNo, matches.flatMap(q => questionLineNos(q).slice(0, 2))),
      detail: `printed number ${n} appears on ${matches.length} question records`,
    });
  }
  if (coverage.missing.length) {
    const startByNo = new Map((params.expectedStarts || []).map(s => [s.no, s.line]));
    for (const n of coverage.missing) {
      const line = startByNo.get(n);
      defects.push({
        id: `missing-number:${n}`,
        kind: 'missing-number',
        questionIds: [],
        lineIds: line !== undefined ? [line] : [],
        evidence: line !== undefined ? ev(lineByNo, [line]) : [],
        detail: `printed number ${n} was enumerated in the document but no question carries it`,
      });
    }
  }
  if (totalPoints !== undefined && !coverage.pointsMatch) {
    const zeroRoots = questions.filter(q => !q.parentId && !(Number(q.points) > 0));
    defects.push({
      id: 'points-sum:total',
      kind: 'points-sum',
      questionIds: zeroRoots.slice(0, 12).map(q => q.id),
      lineIds: [],
      evidence: [],
      detail: `root points sum ${coverage.pointsParsed} ≠ printed total ${totalPoints} (deficit ${coverage.pointDeficit})`,
    });
  }

  // --- Points unresolved (only repairable when a printed total exists as evidence).
  if (totalPoints !== undefined) {
    const parentIds = new Set(questions.map(q => q.parentId).filter(Boolean) as string[]);
    for (const q of questions) {
      if (q.parentId || parentIds.has(q.id)) continue; // priced at child level
      if (Number(q.points) > 0) continue;
      const nos = questionLineNos(q);
      defects.push({
        id: `points-unresolved:${q.id}`,
        kind: 'points-unresolved',
        questionIds: [q.id],
        lineIds: nos,
        evidence: ev(lineByNo, nos),
        detail: `question ${q.no} has no printed marks assigned although the paper prints a total of ${totalPoints}`,
      });
    }
  }

  // --- Invariant-based kinds (hollow / options / image ownership) via the existing checker.
  const shim = {
    questions,
    sections: params.doc.sections,
    images: params.doc.images || [],
    meta: { totalPoints },
    source: { lines: params.lines, expectedNumbers: params.expectedNumbers, keyTerritoryLineNos: params.keyLineNos },
  } as unknown as ExamDoc;
  const report = validateExamInvariants(shim);
  for (const v of report.violations) {
    if (v.code === 'I1') {
      const q = v.questionId ? byId.get(v.questionId) : undefined;
      defects.push({
        id: `hollow-question:${v.questionId}`,
        kind: 'hollow-question',
        questionIds: v.questionId ? [v.questionId] : [],
        lineIds: q ? questionLineNos(q) : [],
        evidence: q ? ev(lineByNo, questionLineNos(q)) : [],
        detail: v.message,
      });
    } else if (v.code === 'I2') {
      const q = v.questionId ? byId.get(v.questionId) : undefined;
      defects.push({
        id: `options-missing:${v.questionId}`,
        kind: 'options-missing',
        questionIds: v.questionId ? [v.questionId] : [],
        lineIds: q ? questionLineNos(q) : [],
        evidence: q ? ev(lineByNo, questionLineNos(q)) : [],
        detail: v.message,
      });
    } else if (v.code === 'I13' || v.code === 'I6') {
      // I13 message carries the image id; find every owner for evidence.
      const imageId = v.message.match(/image (\S+?) is/)?.[1] || v.message.match(/(\S+) is not a document image/)?.[1];
      const owners = imageId ? questions.filter(q => (q.images || []).some(ref => ref.imageId === imageId)) : [];
      const id = `image-ownership:${imageId || v.questionId || 'unknown'}`;
      if (!defects.some(d => d.id === id)) {
        defects.push({
          id,
          kind: 'image-ownership',
          questionIds: owners.map(q => q.id),
          lineIds: owners.flatMap(q => questionLineNos(q).slice(0, 1)),
          evidence: ev(lineByNo, owners.flatMap(q => questionLineNos(q).slice(0, 1))),
          detail: v.message,
        });
      }
    }
  }

  // --- Span overlaps (two unrelated questions claiming the same printed line).
  const ownersByLine = new Map<number, Question[]>();
  for (const q of questions) for (const n of questionLineNos(q)) ownersByLine.set(n, [...(ownersByLine.get(n) || []), q]);
  const seenPairs = new Set<string>();
  for (const [n, owners] of ownersByLine) {
    if (owners.length < 2) continue;
    for (let i = 0; i < owners.length; i++) for (let j = i + 1; j < owners.length; j++) {
      const a = owners[i];
      const b = owners[j];
      if (a.parentId === b.id || b.parentId === a.id) continue;
      if (a.parentId && a.parentId === b.parentId) continue; // group siblings share printed lines by design
      const key = [a.id, b.id].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const shared = questionLineNos(a).filter(x => questionLineNos(b).includes(x));
      defects.push({
        id: `span-overlap:${key}`,
        kind: 'span-overlap',
        questionIds: [a.id, b.id],
        lineIds: shared,
        evidence: ev(lineByNo, shared.length ? shared : [n]),
        detail: `questions ${a.no} and ${b.no} both claim printed line(s) ${shared.slice(0, 6).join(', ')}`,
      });
    }
  }

  // --- Unaccounted lines (ownership orphans ∪ label-accounted subtraction on the classify path).
  let orphanNos: number[] = [];
  try {
    orphanNos = computeOwnership({ lines: params.lines, questions, sections: params.doc.sections, keyLines: params.keyLineNos }).orphanLineNos;
  } catch { orphanNos = []; }
  if (params.accountedLineNos?.length) {
    const accounted = new Set(params.accountedLineNos);
    orphanNos = orphanNos.filter(n => !accounted.has(n));
  }
  const covered = new Set(questions.flatMap(questionLineNos));
  orphanNos = orphanNos.filter(n => !covered.has(n) && (lineByNo.get(n)?.text || '').trim().length > 0);
  for (const [s, e] of contiguousRuns([...new Set(orphanNos)].sort((a, b) => a - b))) {
    const nos: number[] = [];
    for (let n = s; n <= e; n++) nos.push(n);
    defects.push({
      id: `unaccounted-lines:${s}-${e}`,
      kind: 'unaccounted-lines',
      questionIds: [],
      lineIds: nos,
      evidence: ev(lineByNo, nos),
      detail: `${nos.length} printed line(s) belong to no question, section, key or furniture set`,
    });
  }

  const order = new Map(DEFECT_KINDS.map((k, i) => [k, i]));
  defects.sort((a, b) => (order.get(a.kind)! - order.get(b.kind)!) || a.id.localeCompare(b.id));
  return defects;
}

export function defectsSignature(defects: Defect[]): string {
  return defects.map(d => `${d.id}#${d.questionIds.join(',')}`).join('|');
}

export function defectsByKind(defects: Defect[]): Map<DefectKind, Defect[]> {
  const out = new Map<DefectKind, Defect[]>();
  for (const d of defects) out.set(d.kind, [...(out.get(d.kind) || []), d]);
  return out;
}
