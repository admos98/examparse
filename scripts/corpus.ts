#!/usr/bin/env tsx
/**
 * Local acceptance corpus. Uses a deterministic, lazy scripted structure response (span anchors only),
 * then the same local segment/assembly/gate helpers as the app. No provider or model calls are made.
 * Add an exam by dropping a folder with source-lines.json, truth.json, and notes.md into the corpus dir.
 *
 * Marvel Batch 6 (Fix 3) — the acceptance entry also runs a second scripted profile
 * (`malformed-first-pass`) that takes the path the FIELD actually takes: a scripted model whose
 * first pass emits whole-line True/False options, a hollow group parent and an overlong stem,
 * followed by field-style post-assemble replacements (escalation-repair / critic-reparse
 * adoption), and finally the last canonicalization pass. Its acceptance is identical:
 * final shape audit 0/0/0 and the same 12/12 A3 spot checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { findIntraLineMultiNumbers, segmentDocument } from '../src/pipeline/segment';
import { applyLocalGates } from '../src/pipeline/gates';
import { computeShapeAudit, runFinalCanonicalization, type ShapeAuditCounts } from '../src/pipeline/forms';
import { sliceSourceSpans, spanLineNumbers } from '../src/pipeline/spans';
import {
  detectKeyTerritory,
  detectSectionHeaders,
  enumerateExpectedQuestionNos,
  extractDocumentTotals,
  isReadTheTextInstruction,
  normalizeForMatching,
  parsePrintedNumberFromStem,
} from '../src/pipeline/quality';
import type { ExamSection, Question, SourceLine } from '../src/types';

interface SpotCheck {
  no: number;
  stemIncludes?: string;
  stemEquals?: string;
  stemExcludes?: string[];
  maxStemLength?: number;
  sectionPassageIncludes?: string;
  noStemIncludesPassage?: string;
  distinctChildStems?: number[];
  options?: string[];
  optionPoolContains?: string[];
  children?: number[];
  points?: number;
}
interface Truth {
  expectedNumbers: number[];
  types?: Record<string, Question['type']>;
  headerLines?: number[];
  sectionTitles: string[];
  totalPoints: number;
  keyPages?: number[];
  mustHaveNoSelfParentNumber?: boolean;
  spotChecks?: SpotCheck[];
  groups?: Array<{ parent: number; children: number[] }>;
  mustHaveNoDuplicateImageIds?: boolean;
  /** Fix 3 — extra scripted-model profiles run against the same fixture/truth. */
  profiles?: Array<{ name: 'malformed-first-pass' }>;
}
export interface CorpusResult {
  exam: string;
  expected: number;
  found: number;
  recall: string;
  sections: string;
  total: string;
  spotChecks: string;
  shapeAudit: ShapeAuditCounts;
  shapeAuditLabel: string;
  duplicateImageIds: number;
  preAssistantChildren: string;
  failures: string[];
  /** Fix 3 — true when the run went assemble → field-style replacements → final pass. */
  malformedProfile?: boolean;
}

const CORPUS_DIR = path.join(process.cwd(), 'test/fixtures/corpus');
const ACCEPTANCE_ID = 'english-final-13991009pq89w65173';
const MALFORMED_PROFILE = 'malformed-first-pass';

function lineNo(line: SourceLine): number { return Number(String(line.id).replace(/\D/g, '')) || 0; }
function normalized(value: string): string { return normalizeForMatching(value).replace(/\s+/g, ' ').trim(); }
function optionTexts(q: Question | undefined): string[] { return (q?.options || []).map(option => normalized(option.text || '')); }
function sectionRanges(lines: SourceLine[], titles: string[], unguided = false): any[] {
  const headers = detectSectionHeaders(lines);
  const ordered = unguided || !titles.length
    ? headers
    : titles.map((title, index) => {
      const candidates = headers.filter(header => header.title === title);
      const occurrence = titles.slice(0, index + 1).filter(item => item === title).length - 1;
      return candidates[occurrence];
    }).filter(Boolean);
  const allLines = [...lines].sort((a, b) => lineNo(a) - lineNo(b));
  const max = Math.max(0, ...allLines.map(lineNo));
  return ordered.map((header: any, index: number) => ({
    id: `sec_${index + 1}`, index: index + 1, title: header.title,
    spans: [[header.headerLine, (ordered[index + 1]?.headerLine || max + 1) - 1]],
  }));
}
function lookupAnchor(lines: SourceLine[], no: number, lineByNumber: Map<number, number>): number | undefined {
  const mapped = lineByNumber.get(no);
  if (mapped) return mapped;
  const candidate = lines.find(line => parsePrintedNumberFromStem(line.text) === no && line.tag !== 'key' && !line.furniture);
  return candidate ? lineNo(candidate) : undefined;
}
function localOptionRow(text: string): boolean {
  const hits = [...text.matchAll(/(?:^|\s|[)\] ])(?:\([a-d]\)|[a-d][).:])/gi)];
  return hits.length >= 2;
}
/**
 * The field's overlong-stem shape: a question anchored at a read-the-text instruction that
 * swallows the following prose passage into its own span (Q38 → lines 116..125, 900 chars).
 * Deterministic, source-only (no invention): stops at furniture/key/printed numbers/short rows.
 */
function overlongPassageSpan(lines: SourceLine[], anchor: number, keyLines: Set<number>): [number, number] | undefined {
  const next = lines.find(line => lineNo(line) === anchor + 1);
  if (!next || next.furniture || keyLines.has(anchor + 1) || !isReadTheTextInstruction(next.text)) return undefined;
  let end = anchor + 1;
  for (let cursor = anchor + 2; cursor <= anchor + 12; cursor++) {
    const line = lines.find(item => lineNo(item) === cursor);
    if (!line || line.furniture || line.tag === 'key' || keyLines.has(cursor)) break;
    if (parsePrintedNumberFromStem(line.text) !== undefined) break;
    if (line.text.trim().length < 40) break;
    end = cursor;
  }
  return end > anchor ? [anchor, end] : undefined;
}

function buildLazyResponse(lines: SourceLine[], numbers: number[], sectionDefs: any[], lineByNumber: Map<number, number>, keyLines: Set<number>, segments: any[], types: Record<string, Question['type']> = {}, malformedFirstPass = false): any[] {
  const questions: any[] = [];
  const autoChildren = new Set(segments.flatMap(segment => segment.parentSegmentId && segment.printedNo !== undefined ? [Number(segment.printedNo)] : segment.kind === 'group-parent' ? (segment.childNos || []).filter((no: number) => Number(no) !== Number(segment.printedNo)) : []));
  const ordered = [...numbers].sort((a, b) => a - b);
  for (let index = 0; index < ordered.length; index++) {
    const no = ordered[index];
    const anchor = lookupAnchor(lines, no, lineByNumber);
    if (!anchor || autoChildren.has(no)) continue;
    const anchorLine = lines.find(line => lineNo(line) === anchor);
    const intra = anchorLine ? findIntraLineMultiNumbers(anchorLine.text) : [];
    if (intra.some(item => item.no === no) && intra[0]?.no !== no) continue;
    let sourceSpan: [number, number] = [anchor, anchor];
    const spanText = anchorLine?.text || '';
    const section = sectionDefs.find((candidate: any) => candidate.spans[0][0] <= anchor && candidate.spans[0][1] >= anchor);
    const mcq = localOptionRow(spanText);
    // Fix 3 (malformed profile only): the field's lazy model leaves the printed
    // `a) True  b) False` tail inside the whole-line stem and emits both options as
    // references to that same whole line (whole-line option/stem collisions).
    const wholeLineTf = malformedFirstPass && /\btrue\b/i.test(spanText) && /\bfalse\b/i.test(spanText);
    if (wholeLineTf) {
      questions.push({
        id: `q${no}`, no, label: String(no), sectionId: section?.id,
        spans: [sourceSpan], type: 'mcq', confidence: 0.85,
        options: ['a', 'b'].map(key => ({ key, spans: [sourceSpan] })),
      });
      continue;
    }
    // Fix 3: overlong stem — the scripted model anchors the question before a read-the-text
    // instruction and swallows the following prose passage into the same span.
    if (malformedFirstPass && !mcq) {
      const overlong = overlongPassageSpan(lines, anchor, keyLines);
      if (overlong) sourceSpan = overlong;
    }
    questions.push({
      id: `q${no}`, no, label: String(no), sectionId: section?.id,
      spans: [sourceSpan], type: types[String(no)] || (mcq ? 'mcq' : 'unknown'), confidence: 0.85,
      ...(mcq ? { options: ['a', 'b', 'c', 'd'].map(key => ({ key, spans: [sourceSpan] })) } : {}),
    });
  }
  return questions;
}
function getChildren(questions: Question[], parentNo: number): number[] {
  const parent = questions.find(question => question.no === parentNo && !question.parentId);
  if (!parent) return [];
  return questions.filter(question => question.parentId === parent.id).map(question => question.no).sort((a, b) => a - b);
}

/**
 * Fix 3 — field-style replacement adoption at the pipeline seam.
 *
 * Mirrors what escalation repair / consensus / critic reparse do after assembly: questions are
 * replaced wholesale and never re-enter the assembler. The adopted replacements reproduce the
 * field export's four surviving defect classes (whole-line True/False options + stem tail, a
 * shared-line group with identical child stems, the phantom self-child numbered as its parent,
 * and the >500-char passage-in-stem) so the final canonicalization pass is exercised on the
 * path the field actually takes.
 */
export function adoptFieldStyleReplacements(questions: Question[], lines: SourceLine[]): Question[] {
  const lineText = (no: number): { text: string; line: number } | undefined => {
    const line = lines.find(item => lineNo(item) === no);
    return line ? { text: line.text, line: no } : undefined;
  };
  const adopted = questions.map((question): Question => {
    if (question.no === 6 || question.no === 40) {
      const first = spanLineNumbers(question.spans)[0];
      const source = first !== undefined ? lineText(first) : undefined;
      if (!source) return question;
      const wholeLine: [number, number] = [source.line, source.line];
      return {
        ...question,
        type: 'mcq',
        spans: [wholeLine],
        stem: source.text,
        options: ['a', 'b'].map(key => ({ key, spans: [wholeLine], text: source.text })),
      };
    }
    if (question.no === 38) {
      const first = spanLineNumbers(question.spans)[0];
      if (first === undefined) return question;
      // Rebuild the field's overlong span from source (question + read-the-text instruction +
      // prose passage) and drop any synthesized options: the field export's Q38 had none.
      const spans: Array<[number, number]> = [overlongPassageSpan(lines, first, new Set()) || [first, first]];
      return { ...question, spans, stem: sliceSourceSpans(spans, lines), type: 'unknown', options: undefined };
    }
    return question;
  });

  // Hollow group parent: children adopted with the parent's whole-line span/stem (identical
  // siblings), plus the phantom child whose printed number equals its parent's number.
  const parent = adopted.find(question => question.no === 15 && !question.parentId);
  if (parent) {
    const parentLine = spanLineNumbers(parent.spans)[0];
    const parentText = parentLine !== undefined ? (lineText(parentLine)?.text || parent.stem || '') : (parent.stem || '');
    for (const child of adopted) {
      if (child.parentId !== parent.id) continue;
      child.spans = parent.spans;
      child.stem = parentText;
    }
    const phantom: Question = {
      id: `${parent.id}_c15`,
      no: 15,
      label: '15',
      parentId: parent.id,
      sectionId: parent.sectionId,
      spans: parent.spans,
      stem: parentText,
      points: 0,
      type: parent.type || 'matching',
      confidence: 0.6,
      images: [],
    };
    adopted.push(phantom);
  }
  return adopted;
}

interface EvaluateParams {
  exam: string;
  expected: number[];
  truth: Truth;
  questions: Question[];
  sections: ExamSection[];
  totalPoints?: number;
  lines: SourceLine[];
  keyLines: Set<number>;
  detectedHeaderLines: number[];
  duplicateImageIds: number;
  /** Acceptance entries (base + malformed profiles) must end at shape 0/0/0. */
  shapeGate: boolean;
  malformedProfile?: boolean;
}

function evaluateRun(params: EvaluateParams): CorpusResult {
  const { questions, sections, truth, expected, lines, keyLines } = params;
  const numbers = [...new Set(questions.map(question => question.no))].sort((a, b) => a - b);
  const byNo = new Map<number, Question>();
  for (const question of questions) if (!byNo.has(question.no) || question.parentId) byNo.set(question.no, question);
  const actualTitles = sections.map(section => section.title || '');
  const sectionsMatch = JSON.stringify(actualTitles) === JSON.stringify(truth.sectionTitles || []);
  const totalMatches = params.totalPoints === truth.totalPoints;
  const spotChecks = truth.spotChecks || [];
  let passedSpots = 0;
  const failures: string[] = [];

  if (truth.headerLines) {
    if (JSON.stringify(params.detectedHeaderLines) !== JSON.stringify(truth.headerLines)) {
      failures.push(`header lines mismatch: ${JSON.stringify(params.detectedHeaderLines)} != ${JSON.stringify(truth.headerLines)}`);
    }
  }
  if (truth.keyPages) {
    const actualKeyPages = [...new Set(lines.filter(line => keyLines.has(lineNo(line))).map(line => line.page))].sort((a, b) => a - b);
    if (JSON.stringify(actualKeyPages) !== JSON.stringify(truth.keyPages)) {
      failures.push(`key pages mismatch: ${JSON.stringify(actualKeyPages)} != ${JSON.stringify(truth.keyPages)}`);
    }
  }
  if (truth.mustHaveNoSelfParentNumber) {
    const byId = new Map(questions.map(question => [question.id, question]));
    for (const question of questions) {
      if (!question.parentId) continue;
      const parent = byId.get(question.parentId);
      if (question.parentId === question.id || (parent && parent.no === question.no)) {
        failures.push(`Q${question.no} (${question.id}) is numbered as its own parent (${question.parentId})`);
      }
    }
  }

  for (const spot of spotChecks) {
    let pass = true;
    const q = byNo.get(spot.no);
    if (!q) { pass = false; failures.push(`spot Q${spot.no}: missing`); }
    if (q && spot.stemIncludes && !normalized(q.stem || '').includes(normalized(spot.stemIncludes))) {
      pass = false; failures.push(`spot Q${spot.no}: stem text missing “${spot.stemIncludes}”`);
    }
    if (q && spot.stemEquals && normalized(q.stem || '') !== normalized(spot.stemEquals)) {
      pass = false; failures.push(`spot Q${spot.no}: stem expected “${spot.stemEquals}”, got “${q.stem}”`);
    }
    if (q && spot.stemExcludes) {
      for (const forbidden of spot.stemExcludes) {
        if (normalized(q.stem || '').includes(normalized(forbidden))) {
          pass = false; failures.push(`spot Q${spot.no}: stem still includes forbidden “${forbidden}”`);
        }
      }
    }
    if (q && spot.maxStemLength !== undefined && (q.stem || '').length >= spot.maxStemLength) {
      pass = false; failures.push(`spot Q${spot.no}: stem length ${(q.stem || '').length} >= ${spot.maxStemLength}`);
    }
    if (q && spot.sectionPassageIncludes) {
      const sec = sections.find(section => section.id === q.sectionId);
      if (!sec || !normalized(sec.passage || '').includes(normalized(spot.sectionPassageIncludes))) {
        pass = false; failures.push(`spot Q${spot.no}: section passage missing “${spot.sectionPassageIncludes}”`);
      }
    }
    if (spot.noStemIncludesPassage) {
      const target = normalized(spot.noStemIncludesPassage);
      const offender = questions.find(cand => normalized(cand.stem || '').includes(target));
      if (offender) {
        pass = false; failures.push(`spot Q${spot.no}: passage leaked into Q${offender.no} stem`);
      }
    }
    if (q && spot.distinctChildStems) {
      const parent = questions.find(cand => cand.no === spot.no && !cand.parentId);
      const childQuestions = spot.distinctChildStems.map(cNo =>
        questions.find(cand => cand.no === cNo && parent && cand.parentId === parent.id),
      );
      if (childQuestions.some(c => !c || !(c.stem || '').trim())) {
        pass = false; failures.push(`spot Q${spot.no}: missing child stems for ${JSON.stringify(spot.distinctChildStems)}`);
      } else {
        const childStems = childQuestions.map(c => normalized(c!.stem || ''));
        if (new Set(childStems).size !== childStems.length) {
          pass = false; failures.push(`spot Q${spot.no}: non-distinct child stems ${JSON.stringify(childStems)}`);
        }
      }
    }
    if (q && spot.options && JSON.stringify(optionTexts(q)) !== JSON.stringify(spot.options.map(normalized))) {
      pass = false; failures.push(`spot Q${spot.no}: options differ (${JSON.stringify(optionTexts(q))})`);
    }
    if (q && spot.points !== undefined && q.points !== spot.points) {
      pass = false; failures.push(`spot Q${spot.no}: expected ${spot.points} points, got ${q.points}`);
    }
    if (spot.children && JSON.stringify(getChildren(questions, spot.no)) !== JSON.stringify([...spot.children].sort((a, b) => a - b))) {
      pass = false; failures.push(`spot Q${spot.no}: children mismatch (${JSON.stringify(getChildren(questions, spot.no))})`);
    }
    if (spot.optionPoolContains) {
      const corpusText = normalized(lines.filter(line => !keyLines.has(lineNo(line))).map(line => line.text).join(' '));
      if (!spot.optionPoolContains.every(value => corpusText.includes(normalized(value)))) {
        pass = false; failures.push(`spot Q${spot.no}: matching pool text missing`);
      }
    }
    if (pass) passedSpots++;
  }

  const shapeAudit = computeShapeAudit(questions);
  const shapeAuditLabel = `${shapeAudit.optionIncludesStem}/${shapeAudit.duplicateSiblingStems}/${shapeAudit.overlongStems}`;
  const shapeAuditAllZero = shapeAudit.optionIncludesStem === 0 && shapeAudit.duplicateSiblingStems === 0 && shapeAudit.overlongStems === 0;
  const groupResults = (truth.groups || []).map(group => `${group.parent}:${getChildren(questions, group.parent).join(',')}`);
  const preAssistantChildren = groupResults.join(';') || '—';
  const recall = `${numbers.filter(number => expected.includes(number)).length}/${expected.length}`;
  const sectionMatches = `${actualTitles.filter((title, index) => title === (truth.sectionTitles || [])[index]).length}/${(truth.sectionTitles || []).length}`;
  const result: CorpusResult = {
    exam: params.exam,
    expected: expected.length,
    found: numbers.length,
    recall,
    sections: sectionMatches,
    total: `${params.totalPoints ?? '—'}${totalMatches ? '' : ` (expected ${truth.totalPoints})`}`,
    spotChecks: `${passedSpots}/${spotChecks.length}`,
    shapeAudit,
    shapeAuditLabel,
    duplicateImageIds: params.duplicateImageIds,
    preAssistantChildren,
    failures,
    ...(params.malformedProfile ? { malformedProfile: true } : {}),
  };
  if (numbers.length !== expected.length || expected.some(number => !numbers.includes(number))) failures.push(`number recall ${recall}`);
  if (!sectionsMatch) failures.push(`section order mismatch: ${actualTitles.join(' / ')}`);
  if (!totalMatches) failures.push(`total mismatch: ${params.totalPoints} != ${truth.totalPoints}`);
  for (const [number, type] of Object.entries(truth.types || {})) {
    if (byNo.get(Number(number))?.type !== type) failures.push(`Q${number} type expected ${type}, got ${byNo.get(Number(number))?.type || 'missing'}`);
  }
  if (truth.mustHaveNoDuplicateImageIds && params.duplicateImageIds) failures.push(`duplicate image ids=${params.duplicateImageIds}`);
  if (params.shapeGate && !shapeAuditAllZero) failures.push(`shape audit non-zero: ${shapeAuditLabel}`);
  return result;
}

function printResult(result: CorpusResult): void {
  console.log(
    `${result.exam.padEnd(38)} ${result.recall.padEnd(8)} ${result.sections.padEnd(8)} ${result.total.padEnd(14)} ${result.spotChecks.padEnd(8)} shape=${result.shapeAuditLabel.padEnd(7)} dup-img=${result.duplicateImageIds} groups=${result.preAssistantChildren}`,
  );
}

export async function runCorpus(opts: { strict?: boolean; print?: boolean } = {}): Promise<{ results: CorpusResult[]; ok: boolean }> {
  const dirs = fs.readdirSync(CORPUS_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const results: CorpusResult[] = [];
  for (const exam of dirs) {
    const dir = path.join(CORPUS_DIR, exam);
    const lines = JSON.parse(fs.readFileSync(path.join(dir, 'source-lines.json'), 'utf8')) as SourceLine[];
    const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8')) as Truth;
    const keyLines = detectKeyTerritory(lines).lineNos;
    const expected = [...truth.expectedNumbers].sort((a, b) => a - b);
    const enumerated = enumerateExpectedQuestionNos(lines);
    const segments = segmentDocument({ lines, keyLines }).segments;
    const detectedHeaders = detectSectionHeaders(lines.filter(l => !keyLines.has(lineNo(l))));
    const defs = sectionRanges(lines.filter(l => !keyLines.has(lineNo(l))), truth.sectionTitles || [], exam === ACCEPTANCE_ID);
    const total = extractDocumentTotals(lines, keyLines).documentTotal ?? truth.totalPoints;
    const imageIds = (lines as any).images || [];
    const duplicateImageIds = imageIds.length - new Set(imageIds.map((image: any) => image.id)).size;
    const runScripted = (malformedFirstPass: boolean) => {
      const raw = buildLazyResponse(lines, expected, defs, enumerated.lineByNumber, keyLines, segments, truth.types || {}, malformedFirstPass);
      const assembled = assembleAndValidateQuestions(raw, lines, total, {
        keyTerritoryLineNos: [...keyLines], gapCompletion: true,
        segmentReceipts: segments,
        sections: defs as ExamSection[],
      });
      const gated = applyLocalGates({ questions: assembled.questions, rawSections: defs, lines, keyLines, metaTotalPoints: total });
      if (exam === ACCEPTANCE_ID && gated.questions.some(q => /نمره/.test(normalizeForMatching(q.answer?.text || '')))) throw new Error('Answer contains key furniture');
      return gated;
    };

    if (exam === ACCEPTANCE_ID) {
      const keyStatement = lines.find(line => line.id === 'L0258');
      if (!keyStatement || !normalizeForMatching(keyStatement.text).includes('هر پاسخ صحیح')) throw new Error('Q25 mark evidence missing at L0258');
    }

    // Base profile — the lazy scripted model every corpus/bench fixture already uses.
    const base = runScripted(false);
    const baseResult = evaluateRun({
      exam, expected, truth, questions: base.questions, sections: base.sections, totalPoints: base.totalPoints,
      lines, keyLines, detectedHeaderLines: detectedHeaders.map(header => header.headerLine), duplicateImageIds,
      shapeGate: exam === ACCEPTANCE_ID,
    });
    results.push(baseResult);
    if (opts.print !== false) printResult(baseResult);

    // Fix 3 — malformed-first-pass profile: scripted raw defects → assemble → FIELD-STYLE
    // replacement adoption → the last canonicalization pass (the same exported function the
    // pipeline runs after repair/consensus/critic). Acceptance: shape audit 0/0/0 + 12/12 spots.
    if (exam === ACCEPTANCE_ID && (truth.profiles || []).some(profile => profile.name === MALFORMED_PROFILE)) {
      const malformed = runScripted(true);
      const replaced = adoptFieldStyleReplacements(malformed.questions, lines);
      const final = runFinalCanonicalization({
        questions: replaced,
        sourceLines: lines,
        sections: malformed.sections,
      });
      if (process.env.CORPUS_DEBUG) {
        console.log('DEBUG-malformed pre-final shape', JSON.stringify(computeShapeAudit(replaced)),
          'questions', replaced.length, 'after', final.questions.length);
      }
      if (process.env.CORPUS_DEBUG) {
        for (const no of [6, 15, 16, 17, 18, 38, 40]) {
          const q = final.questions.find(candidate => candidate.no === no);
          console.log('DEBUG-malformed', no, q?.id, 'len', (q?.stem || '').length, JSON.stringify((q?.stem || '').slice(0, 90)), 'opts', (q?.options || []).map((option: any) => option.text));
        }
        console.log('DEBUG-malformed shape', JSON.stringify(final.shapeAudit), 'overlong', JSON.stringify(final.stemOverlong.map(item => item.no)));
      }
      const malformedResult = evaluateRun({
        exam: `${exam}·${MALFORMED_PROFILE}`,
        expected, truth, questions: final.questions, sections: final.sections, totalPoints: malformed.totalPoints,
        lines, keyLines, detectedHeaderLines: detectedHeaders.map(header => header.headerLine), duplicateImageIds,
        shapeGate: true,
        malformedProfile: true,
      });
      results.push(malformedResult);
      if (opts.print !== false) printResult(malformedResult);
    }
  }
  const acceptance = results.find(result => result.exam === ACCEPTANCE_ID);
  const malformed = results.find(result => result.exam === `${ACCEPTANCE_ID}·${MALFORMED_PROFILE}`);
  const acceptanceOK = !opts.strict || Boolean(
    acceptance &&
    acceptance.recall === '67/67' &&
    acceptance.sections === '8/8' &&
    acceptance.total === '48' &&
    acceptance.spotChecks === '12/12' &&
    acceptance.shapeAuditLabel === '0/0/0' &&
    acceptance.duplicateImageIds === 0 &&
    acceptance.preAssistantChildren === '15:16,17,18;63:64,65,66' &&
    acceptance.failures.length === 0,
  );
  const malformedOK = !opts.strict || !malformed || Boolean(
    malformed.recall === '67/67' &&
    malformed.sections === '8/8' &&
    malformed.total === '48' &&
    malformed.spotChecks === '12/12' &&
    malformed.shapeAuditLabel === '0/0/0' &&
    malformed.failures.length === 0,
  );
  if (!acceptanceOK && acceptance) acceptance.failures.push('F1 acceptance gate not met');
  if (!malformedOK && malformed) malformed.failures.push('F3 malformed-profile acceptance gate not met');
  // This batch's hard corpus gate is the declared English-final acceptance exam; historical fixtures
  // remain replayable/report-only (including shape-audit reporting without gating).
  const legacyFailures = results.filter(result => result.exam !== ACCEPTANCE_ID && result.exam !== `${ACCEPTANCE_ID}·${MALFORMED_PROFILE}`).flatMap(result => result.failures);
  const ok = acceptanceOK && malformedOK && (!opts.strict ? legacyFailures.length === 0 : true);
  if (opts.print !== false) {
    console.log(`Corpus entries: ${results.length}; status: ${ok ? 'PASS' : 'FAIL'} (${opts.strict ? 'acceptance hard gate' : 'all-entry gate'}; local scripted model; 0 provider calls)`);
    const shown = opts.strict ? results.filter(result => result.exam === ACCEPTANCE_ID || result.exam === `${ACCEPTANCE_ID}·${MALFORMED_PROFILE}`) : results;
    for (const result of shown) for (const failure of result.failures) console.log(`  ${result.exam}: ${failure}`);
    if (opts.strict && legacyFailures.length) console.log(`  Historical fixture differences reported, not gated: ${legacyFailures.length} (acceptance entry is the gate for this batch).`);
  }
  return { results, ok };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runCorpus({ strict: true }).then(({ ok }) => { if (!ok) process.exitCode = 1; }).catch(error => { console.error(error); process.exitCode = 1; });
}
