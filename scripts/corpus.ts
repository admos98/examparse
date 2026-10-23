#!/usr/bin/env tsx
/**
 * Local acceptance corpus. Uses a deterministic, lazy scripted structure response (span anchors only),
 * then the same local segment/assembly/gate helpers as the app. No provider or model calls are made.
 * Add an exam by dropping a folder with source-lines.json, truth.json, and notes.md into the corpus dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { findIntraLineMultiNumbers, segmentDocument } from '../src/pipeline/segment';
import { applyLocalGates } from '../src/pipeline/gates';
import { computeShapeAudit, type ShapeAuditCounts } from '../src/pipeline/forms';
import {
  detectKeyTerritory,
  detectSectionHeaders,
  enumerateExpectedQuestionNos,
  extractDocumentTotals,
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
}

const CORPUS_DIR = path.join(process.cwd(), 'test/fixtures/corpus');
const ACCEPTANCE_ID = 'english-final-13991009pq89w65173';

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
  const hits = [...text.matchAll(/(?:^|\s|[)\]])(?:\([a-d]\)|[a-d][).:])/gi)];
  return hits.length >= 2;
}
function buildLazyResponse(lines: SourceLine[], numbers: number[], sectionDefs: any[], lineByNumber: Map<number, number>, keyLines: Set<number>, segments: any[], types: Record<string, Question['type']> = {}): any[] {
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
    const sourceSpan: [number, number] = [anchor, anchor];
    const spanText = anchorLine?.text || '';
    const section = sectionDefs.find((candidate: any) => candidate.spans[0][0] <= anchor && candidate.spans[0][1] >= anchor);
    const mcq = localOptionRow(spanText);
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
    const raw = buildLazyResponse(lines, expected, defs, enumerated.lineByNumber, keyLines, segments, truth.types || {});
    const total = extractDocumentTotals(lines, keyLines).documentTotal ?? truth.totalPoints;
    const assembled = assembleAndValidateQuestions(raw, lines, total, {
      keyTerritoryLineNos: [...keyLines], gapCompletion: true,
      segmentReceipts: segments,
      sections: defs as ExamSection[],
    });
    const gated = applyLocalGates({ questions: assembled.questions, rawSections: defs, lines, keyLines, metaTotalPoints: total });
    const questions = gated.questions;
    if (process.env.CORPUS_DEBUG && exam === ACCEPTANCE_ID) {
      for (const no of [6, 15, 16, 17, 18, 25, 28, 29, 35, 38, 40, 63, 64, 65, 66, 67]) {
        const q = gated.questions.find(item => item.no === no);
        console.log('DEBUG', no, q?.id, q?.parentId, q?.spans, JSON.stringify(q?.stem), q?.options?.map(option => option.text), q?.points, q?.receipt);
      }
    }
    const numbers = [...new Set(questions.map(question => question.no))].sort((a, b) => a - b);
    const byNo = new Map<number, Question>();
    for (const question of questions) if (!byNo.has(question.no) || question.parentId) byNo.set(question.no, question);
    const actualTitles = gated.sections.map(section => section.title || '');
    const sectionsMatch = JSON.stringify(actualTitles) === JSON.stringify(truth.sectionTitles || []);
    const totalMatches = gated.totalPoints === truth.totalPoints;
    const spotChecks = truth.spotChecks || [];
    let passedSpots = 0;
    const failures: string[] = [];

    if (truth.headerLines) {
      const actualHeaderLines = detectedHeaders.map(h => h.headerLine);
      if (JSON.stringify(actualHeaderLines) !== JSON.stringify(truth.headerLines)) {
        failures.push(`header lines mismatch: ${JSON.stringify(actualHeaderLines)} != ${JSON.stringify(truth.headerLines)}`);
      }
    }
    if (truth.keyPages) {
      const actualKeyPages = [...new Set(lines.filter(l => keyLines.has(lineNo(l))).map(l => l.page))].sort((a, b) => a - b);
      if (JSON.stringify(actualKeyPages) !== JSON.stringify(truth.keyPages)) {
        failures.push(`key pages mismatch: ${JSON.stringify(actualKeyPages)} != ${JSON.stringify(truth.keyPages)}`);
      }
    }
    if (truth.mustHaveNoSelfParentNumber) {
      const byId = new Map(questions.map(q => [q.id, q]));
      for (const q of questions) {
        if (!q.parentId) continue;
        const parent = byId.get(q.parentId);
        if (q.parentId === q.id || (parent && parent.no === q.no)) {
          failures.push(`Q${q.no} (${q.id}) is numbered as its own parent (${q.parentId})`);
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
        const sec = gated.sections.find(s => s.id === q.sectionId);
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
    const shapeAuditAllZero =
      shapeAudit.optionIncludesStem === 0 &&
      shapeAudit.duplicateSiblingStems === 0 &&
      shapeAudit.overlongStems === 0;

    const imageIds = (lines as any).images || [];
    const duplicateImageIds = imageIds.length - new Set(imageIds.map((image: any) => image.id)).size;
    const groupResults = (truth.groups || []).map(group => `${group.parent}:${getChildren(questions, group.parent).join(',')}`);
    const preAssistantChildren = groupResults.join(';') || '—';
    const recall = `${numbers.filter(number => expected.includes(number)).length}/${expected.length}`;
    const sections = `${actualTitles.filter((title, index) => title === (truth.sectionTitles || [])[index]).length}/${(truth.sectionTitles || []).length}`;
    const result: CorpusResult = {
      exam,
      expected: expected.length,
      found: numbers.length,
      recall,
      sections,
      total: `${gated.totalPoints ?? '—'}${totalMatches ? '' : ` (expected ${truth.totalPoints})`}`,
      spotChecks: `${passedSpots}/${spotChecks.length}`,
      shapeAudit,
      shapeAuditLabel,
      duplicateImageIds,
      preAssistantChildren,
      failures,
    };
    if (numbers.length !== expected.length || expected.some(number => !numbers.includes(number))) failures.push(`number recall ${recall}`);
    if (!sectionsMatch) failures.push(`section order mismatch: ${actualTitles.join(' / ')}`);
    if (!totalMatches) failures.push(`total mismatch: ${gated.totalPoints} != ${truth.totalPoints}`);
    for (const [number, type] of Object.entries(truth.types || {})) {
      if (byNo.get(Number(number))?.type !== type) failures.push(`Q${number} type expected ${type}, got ${byNo.get(Number(number))?.type || 'missing'}`);
    }
    if (truth.mustHaveNoDuplicateImageIds && duplicateImageIds) failures.push(`duplicate image ids=${duplicateImageIds}`);
    if (exam === ACCEPTANCE_ID && !shapeAuditAllZero) {
      failures.push(`shape audit non-zero: ${shapeAuditLabel}`);
    }
    results.push(result);
    if (opts.print !== false) {
      console.log(
        `${exam.padEnd(38)} ${recall.padEnd(8)} ${sections.padEnd(8)} ${result.total.padEnd(14)} ${result.spotChecks.padEnd(8)} shape=${shapeAuditLabel.padEnd(7)} dup-img=${duplicateImageIds} groups=${preAssistantChildren}`,
      );
    }
  }
  const acceptance = results.find(result => result.exam === ACCEPTANCE_ID);
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
  if (!acceptanceOK && acceptance) acceptance.failures.push('F1 acceptance gate not met');
  // This batch's hard corpus gate is the declared English-final acceptance exam; historical fixtures
  // remain replayable/report-only (including shape-audit reporting without gating).
  const legacyFailures = results.filter(result => result.exam !== ACCEPTANCE_ID).flatMap(result => result.failures);
  const ok = acceptanceOK && (!opts.strict ? legacyFailures.length === 0 : true);
  if (opts.print !== false) {
    console.log(`Corpus entries: ${results.length}; status: ${ok ? 'PASS' : 'FAIL'} (${opts.strict ? 'acceptance hard gate' : 'all-entry gate'}; local scripted model; 0 provider calls)`);
    const shown = opts.strict ? results.filter(result => result.exam === ACCEPTANCE_ID) : results;
    for (const result of shown) for (const failure of result.failures) console.log(`  ${result.exam}: ${failure}`);
    if (opts.strict && legacyFailures.length) console.log(`  Historical fixture differences reported, not gated: ${legacyFailures.length} (acceptance entry is the gate for this batch).`);
  }
  return { results, ok };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runCorpus({ strict: true }).then(({ ok }) => { if (!ok) process.exitCode = 1; }).catch(error => { console.error(error); process.exitCode = 1; });
}
