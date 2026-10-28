/**
 * Godlike Batch 1 (Follow-up #37) — Parts B (corpus flywheel), C (answer correctness),
 * D (format probes). Part A (parent-as-item bijection) is asserted in
 * test/image-assignment-exact.test.ts alongside the #36 image table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExamDoc, Question, SourceLine } from '../src/types';
import {
  collectSpotCandidates,
  estimateAnswerSpotCheck,
  extractKeyLetterTable,
  parseAnswerLetter,
  runAnswerCorrectness,
  runAnswerSpotChecks,
  verifyLetterAnswers,
  type AnswerSpotCache,
  type SpotVerdict,
} from '../src/pipeline/answerCorrectness';
import { computeAttention } from '../src/utils/attention';
import { buildScoreboard } from '../src/pipeline/scoreboard';
import { buildCorpusEntry, diffCorpusFixes, formatCorpusFixNotes, hashQuestion } from '../src/pipeline/corpusPromote';
import { buildCoverageTable, coverageMarkdown } from '../src/pipeline/corpusCoverage';
import { columnShuffleLines, injectOcrNoise } from '../src/pipeline/corpusProbes';
import { readCorpusEntryMetas, runCorpus } from '../scripts/corpus';
import { replayFieldExport } from '../src/pipeline/fieldReplay';
import { detectKeyTerritory } from '../src/pipeline/quality';

const CORPUS_DIR = path.join(process.cwd(), 'test/fixtures/corpus');
const ACCEPTANCE_DIR = path.join(CORPUS_DIR, 'english-final-13991009pq89w65173');
const acceptanceLines = (): SourceLine[] => JSON.parse(fs.readFileSync(path.join(ACCEPTANCE_DIR, 'source-lines.json'), 'utf8'));
const fieldExportDoc = (): any => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/field-exports/English — 11_structured (2).json'), 'utf8'));

const line = (n: number, page: number, text: string): SourceLine => ({ id: `L${String(n).padStart(4, '0')}`, page, text });
const question = (partial: Partial<Question> & Pick<Question, 'id' | 'no'>): Question => ({
  label: String(partial.no),
  sectionId: 'sec_1',
  spans: [[partial.no, partial.no]],
  stem: `${partial.no}. Question ${partial.no}?`,
  type: 'mcq',
  points: 1,
  confidence: 0.9,
  images: [],
  ...partial,
});

// ============================================================================
// Part C1 — letter-answer verification (pure local, table wins)
// ============================================================================

const c1Lines: SourceLine[] = [
  line(1, 1, 'Grammar'),
  line(2, 1, '1. Pick one. a) red b) blue'),
  line(3, 1, '2. The sky is blue. a) True b) False'),
  line(4, 1, '3. Match the word.'),
  line(5, 1, '4. Pick two. a) cat b) dog'),
  line(6, 1, '5. Ambiguous item. a) yes b) no c) maybe d) never'),
  line(7, 1, '6. Manual item. a) up b) down'),
  line(10, 2, 'Answer Key'),
  line(11, 2, '1. ( b )  2. (b) False  3- d'),
  line(12, 2, '4. ( a )  5. ( c )'),
  line(13, 2, '5. ( d )'),
  line(14, 2, '6. ( a )'),
];
const c1KeyLines = new Set([10, 11, 12, 13, 14]);

function c1Questions(): Question[] {
  return [
    question({ id: 'q1', no: 1, type: 'mcq', options: [{ key: 'a', text: 'red', spans: [[2, 2]] }, { key: 'b', text: 'blue', spans: [[2, 2]] }], answer: { text: '( a )', source: 'paper' } }),
    question({ id: 'q2', no: 2, type: 'truefalse', options: [{ key: 'a', text: 'True', spans: [[3, 3]] }, { key: 'b', text: 'False', spans: [[3, 3]] }], answer: { text: 'True', source: 'paper' } }),
    question({ id: 'q3', no: 3, type: 'matching', answer: { text: 'a', source: 'paper' } }),
    question({ id: 'q4', no: 4, type: 'mcq', options: [{ key: 'a', text: 'cat', spans: [[5, 5]] }, { key: 'b', text: 'dog', spans: [[5, 5]] }], answer: { text: '( a )', source: 'paper' } }),
    question({ id: 'q5', no: 5, type: 'mcq', answer: { text: '( c )', source: 'paper' } }),
    question({ id: 'q6', no: 6, type: 'mcq', answer: { text: '( b )', source: 'manual' } }),
  ];
}

test('T3/C1: three planted letter mismatches are corrected from the key table; ambiguous key → ANSWER_CONFLICT', () => {
  const { questions, flags, stats } = verifyLetterAnswers({ questions: c1Questions(), lines: c1Lines, keyLines: c1KeyLines });
  const byId = new Map(questions.map(item => [item.id, item]));
  assert.deepEqual(stats, { checked: 4, agreed: 1, corrected: 3, conflicts: 1 });

  // The TABLE wins: answers are re-sliced key text, with before/after recorded.
  assert.equal(parseAnswerLetter(byId.get('q1')!.answer!.text), 'b');
  assert.equal(parseAnswerLetter(byId.get('q2')!.answer!.text, byId.get('q2')), 'b');
  assert.equal(parseAnswerLetter(byId.get('q3')!.answer!.text), 'd');
  const corrected = flags.filter(flag => flag.code === 'ANSWER_CORRECTED_FROM_KEY');
  assert.equal(corrected.length, 3);
  assert.match(corrected.find(flag => flag.questionId === 'q1')!.message, /was \(a\).*key says \(b\)/);
  assert.ok(byId.get('q1')!.flags?.includes('ANSWER_CORRECTED_FROM_KEY'));
  // Agreement and manual answers are untouched.
  assert.equal(byId.get('q4')!.answer!.text, '( a )');
  assert.equal(byId.get('q6')!.answer!.text, '( b )', 'manual answers are never rewritten');

  // Ambiguous key (5 → c vs d): conflict attention, answer unchanged.
  assert.equal(byId.get('q5')!.answer!.text, '( c )');
  const conflict = flags.find(flag => flag.code === 'ANSWER_CONFLICT');
  assert.ok(conflict && conflict.questionId === 'q5');
  const doc = {
    id: 'exam_c1', fileHash: 'h', createdAt: new Date(0).toISOString(), displayName: 'C1 fixture',
    meta: { language: 'en', direction: 'ltr', totalPoints: 6 },
    sections: [{ id: 'sec_1', index: 1, title: 'Grammar', spans: [[1, 7]] }],
    questions, images: [],
    source: { lines: c1Lines, pages: 2, ocrUsed: false, fileName: 'c1.pdf', expectedQuestionNos: [1, 2, 3, 4, 5, 6] },
    flags, usage: [],
  } as unknown as ExamDoc;
  const attention = computeAttention(doc).filter(item => item.kind === 'answer-conflict');
  assert.equal(attention.length, 1, 'ANSWER_CONFLICT is wired into the one attention meaning');
  assert.deepEqual(attention[0].questionIds, ['q5']);
  assert.match(attention[0].plainSentence, /\[Go\]$/);
});

test('C1: the key table sliced from the REAL acceptance key matches the printed key', () => {
  const lines = acceptanceLines();
  const { table, ambiguous } = extractKeyLetterTable(lines, detectKeyTerritory(lines).lineNos, []);
  assert.deepEqual([...ambiguous.keys()], []);
  const letter = (no: number) => table.get(no)?.letter;
  // Printed key L0243/L0245/L0253/L0259/L0302… read as a human would.
  assert.deepEqual([letter(1), letter(2), letter(3)], ['a', 'c', 'c']);
  assert.deepEqual([letter(15), letter(16), letter(17), letter(18)], ['b', 'd', 'a', 'c']);
  assert.deepEqual([letter(25), letter(26), letter(27), letter(28), letter(29), letter(30)], ['b', 'c', 'b', 'd', 'c', 'a']);
  assert.deepEqual([letter(51), letter(55), letter(58)], ['c', 'j', 'g']);
});

// ============================================================================
// Part C2 — text spot verification (one batched call, cached, silent skip)
// ============================================================================

const c2Lines: SourceLine[] = [
  line(1, 1, 'Listening'),
  line(2, 1, '7. When is the party?'),
  line(3, 1, '8. What may she bring?'),
  line(4, 1, '9. Which sport does he play?'),
  line(5, 1, '10. What is constant?'),
  line(10, 2, 'Answer Key'),
  line(11, 2, '7. It is at 6:30.'),
  line(12, 2, '8. She may bring a birthday card.'),
  line(13, 2, '9. volleyball'),
  line(14, 2, '10. A value that never changes.'),
];
const c2KeyLines = new Set([10, 11, 12, 13, 14]);
const c2Questions = (): Question[] => [
  question({ id: 'q7', no: 7, type: 'short', stem: '7. When is the party?', answer: { text: 'It starts at half past six.', source: 'paper' } }),
  question({ id: 'q8', no: 8, type: 'short', stem: '8. What may she bring?', answer: { text: 'He left his jacket on the bus.', source: 'paper' } }),
  question({ id: 'q9', no: 9, type: 'fillblank', stem: '9. He plays ______ twice a week.', answer: { text: 'football', source: 'paper' } }),
  question({ id: 'q10', no: 10, type: 'short', stem: '10. What is constant?', answer: { text: 'A value that never changes.', source: 'paper' } }),
];

test('T3/C2: scripted model verdicts route match/mismatch/key-unclear; exactly 1 call; mismatch never rewrites', async () => {
  let calls = 0;
  let prompt = '';
  const cacheStore = new Map<string, SpotVerdict>();
  const cache: AnswerSpotCache = {
    get: async key => cacheStore.get(key),
    set: async (key, value) => { cacheStore.set(key, value); },
  };
  const caller = async (req: { text: string }) => {
    calls++;
    prompt = req.text;
    return { json: { v: [[7, 'm'], [8, 'x'], [9, 'u']] }, usage: { inputTokens: 210, outputTokens: 18 } };
  };
  const result = await runAnswerSpotChecks({
    questions: c2Questions(), lines: c2Lines, keyLines: c2KeyLines,
    caller, provider: 'scripted', model: 'scripted-fast', cache,
  });
  assert.equal(calls, 1, 'budget: exactly one batched call per exam');
  assert.equal(result.stats.calls, 1);
  assert.equal(result.stats.inputTokens, 210);
  assert.equal(result.stats.candidates, 3, 'Q10 attached == key locally, never sent to the model');
  assert.equal(result.stats.localMatches, 1);
  assert.ok(!prompt.includes('[10]'), 'deterministic-first: locally-equal answers spend no tokens');
  assert.deepEqual(
    { matches: result.stats.matches, mismatches: result.stats.mismatches, unclear: result.stats.unclear },
    { matches: 1, mismatches: 1, unclear: 1 },
  );
  const mismatch = result.flags.find(flag => flag.code === 'ANSWER_TEXT_MISMATCH');
  assert.ok(mismatch && mismatch.questionId === 'q8');
  assert.match(mismatch!.message, /He left his jacket on the bus/, 'attached text shown');
  assert.match(mismatch!.message, /She may bring a birthday card/, 'key text shown');
  assert.equal(result.questions.find(item => item.id === 'q8')!.answer!.text, 'He left his jacket on the bus.', 'answers are document text: never auto-rewritten');

  // Second run: every verdict is cached per (stem+answers) hash → 0 calls.
  const cached = await runAnswerSpotChecks({
    questions: c2Questions(), lines: c2Lines, keyLines: c2KeyLines,
    caller, provider: 'scripted', model: 'scripted-fast', cache,
  });
  assert.equal(calls, 1, 'cache hit spends no new call');
  assert.equal(cached.stats.status, 'cached');
  assert.equal(cached.stats.mismatches, 1);

  // Unavailable-model path: silent skip (no flags, no changes, no throw).
  const skipped = await runAnswerSpotChecks({ questions: c2Questions(), lines: c2Lines, keyLines: c2KeyLines });
  assert.equal(skipped.stats.status, 'unavailable');
  assert.equal(skipped.stats.calls, 0);
  assert.deepEqual(skipped.flags, []);
});

test('T5/C1+C2 on the acceptance entry: 29 letter checks all agree; spot-check needs 0 calls (≤ +1 budget)', async () => {
  const exported = fieldExportDoc();
  const replay = replayFieldExport(exported);
  const lines = exported.source.lines as SourceLine[];
  const keyLines = detectKeyTerritory(lines).lineNos;
  const { candidates, localMatches } = collectSpotCandidates({ questions: replay.replayedQuestions, lines, keyLines });
  const estimate = estimateAnswerSpotCheck(candidates);
  let calls = 0;
  const result = await runAnswerCorrectness({
    questions: replay.replayedQuestions, lines, keyLines,
    spotProvider: 'scripted', spotModel: 'scripted-fast',
    spotCaller: async req => {
      calls++;
      const nos = [...req.text.matchAll(/^\[(\d+)\]/gm)].map(match => Number(match[1]));
      return { json: { v: nos.map(no => [no, 'm']) }, usage: { inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens } };
    },
  });
  assert.deepEqual(result.letter, { checked: 29, agreed: 29, corrected: 0, conflicts: 0 });
  assert.equal(candidates.length, 0, 'every short/fill answer already equals its key slice');
  assert.equal(localMatches, 18);
  assert.equal(calls, 0, 'the one allowed new call is not even needed on the acceptance entry');
  assert.equal(estimate.calls, 0);
  assert.equal(result.spot.inputTokens + result.spot.outputTokens, 0, 'new-call token count on the acceptance entry: 0');
});

test('C3: scoreboard learns answer-accuracy per (role×model) from key-table agreement', () => {
  const run = (model: string, answerAccuracy?: { checked: number; agreed: number; corrected: number; conflicts: number }): any => ({
    ts: new Date(0).toISOString(), jobId: `job-${model}`, kind: 'pipeline',
    docTraits: { pages: 6, lines: 323, expectedQs: 67, languagesDetected: ['en'], hasKeyPages: true, hasImages: 11, sectionCount: 8 },
    models: { fast: model },
    outcome: { health: { expected: 67, parsed: 67, missing: [], duplicates: [], coveragePercent: 100, state: 'green', complete: true }, calls: 3, tokens: { input: 10, output: 10 }, cost: 0.01, wallMs: 100, flagsRaised: [] },
    ladderPath: ['extract'], flagsRaised: [], userCorrections: 0,
    ...(answerAccuracy ? { answerAccuracy } : {}),
  });
  const rows = buildScoreboard([
    run('model-a', { checked: 20, agreed: 19, corrected: 1, conflicts: 0 }),
    run('model-a', { checked: 10, agreed: 8, corrected: 2, conflicts: 0 }),
    run('model-b'),
  ]);
  const a = rows.find(row => row.modelId === 'model-a')!;
  const b = rows.find(row => row.modelId === 'model-b')!;
  assert.equal(a.answerChecked, 30);
  assert.equal(a.answerAccuracy, 0.9);
  assert.equal(b.answerChecked, 0);
  assert.equal(b.answerAccuracy, null, 'no evidence is reported as null, never a faked %');
});

// ============================================================================
// Part B — corpus flywheel
// ============================================================================

function acceptanceDoc(): ExamDoc {
  const exported = fieldExportDoc();
  const replay = replayFieldExport(exported);
  return {
    id: exported.id || 'exam_acceptance',
    fileHash: exported.fileHash || '13991009pq89w65173hash',
    createdAt: new Date(0).toISOString(),
    displayName: exported.displayName || 'English — 11',
    meta: { ...(exported.meta || {}), language: 'en', direction: 'ltr', totalPoints: 48 },
    sections: replay.replayedSections,
    questions: replay.replayedQuestions,
    images: (exported.images || []).map((image: any, index: number) => ({
      id: image.id || `img_${index}`,
      page: image.page || 1,
      bbox: image.bbox || { x: 0, y: index * 40, w: 100, h: 60 },
      mime: 'image/png', sha: image.sha || `sha${index}`, width: 100, height: 60,
      blobKey: `blob_${index}`, dataUrl: 'data:image/png;base64,SHOULD_NOT_LEAK',
      label: image.label || { role: 'stem', kind: 'photo', caption: 'picture' },
    })),
    source: { lines: acceptanceLines(), pages: 8, ocrUsed: false, fileName: '13991009pq89w65173.pdf' },
    flags: [],
    usage: [{ ts: new Date(0).toISOString(), role: 'fast', provider: 'scripted', model: 'scripted-fast', inputTokens: 1, outputTokens: 1, label: 'Structure' }],
  } as ExamDoc;
}

test('T2/B1: promote builds a corpus skeleton (unreviewed truth, binary-free manifest, provenance notes)', () => {
  const doc = acceptanceDoc();
  const entry = buildCorpusEntry(doc, { now: new Date('2026-10-25T00:00:00Z') });
  assert.match(entry.slug, /^[a-z0-9-]+$/);
  assert.deepEqual(Object.keys(entry.files).sort(), ['images.json', 'notes.md', 'source-lines.json', 'truth.json']);
  const truth = JSON.parse(entry.files['truth.json']);
  assert.equal(truth.status, 'unreviewed');
  assert.deepEqual(truth.expectedNumbers, Array.from({ length: 67 }, (_, index) => index + 1));
  assert.equal(truth.totalPoints, 48);
  assert.equal(truth.sectionTitles.length, 8);
  assert.ok(Object.keys(truth.types).length >= 60, 'per-question types prefilled from the final doc');
  const manifest = entry.files['images.json'];
  assert.ok(!manifest.includes('dataUrl') && !manifest.includes('SHOULD_NOT_LEAK') && !manifest.includes('blobKey'), 'manifest carries no binaries');
  assert.match(entry.files['notes.md'], /Promoted: 2026-10-25/);
  assert.match(entry.files['notes.md'], /fast=scripted-fast/);
  assert.match(entry.files['notes.md'], /Health at promotion:/);
  const stored = JSON.parse(entry.files['source-lines.json']);
  assert.equal(stored.length, 323, 'stored source lines exported verbatim');
});

function writeEntry(dir: string, slug: string, files: Record<string, string>): void {
  const target = path.join(dir, slug);
  fs.mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(target, name), content);
}

test('T2/B2: promote round trip — unreviewed runs report-only; flipped to reviewed it gates', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-promote-'));
  try {
    const entry = buildCorpusEntry(acceptanceDoc(), { now: new Date(0) });
    // Day one after promotion, with a deliberately WRONG prefilled total: still safe.
    const wrongFiles = { ...entry.files, 'truth.json': JSON.stringify({ ...entry.truth, totalPoints: 999 }, null, 1) };
    writeEntry(tmp, entry.slug, wrongFiles);
    const reportOnly = await runCorpus({ dir: tmp, print: false, mode: 'legacy' });
    assert.equal(reportOnly.results.length, 1, 'promoted entry appears and executes');
    assert.equal(reportOnly.results[0].status, 'unreviewed');
    assert.equal(reportOnly.results[0].gated, false);
    assert.equal(reportOnly.ok, true, 'unreviewed diffs never fail the gate');
    assert.ok(reportOnly.results[0].failures.some(failure => failure.includes('total mismatch')), 'diffs are still printed/reported');

    // Human flips status to reviewed (test operation on the temp copy): now it gates.
    const reviewedWrong = { ...entry.files, 'truth.json': JSON.stringify({ ...entry.truth, totalPoints: 999, status: 'reviewed' }, null, 1) };
    writeEntry(tmp, entry.slug, reviewedWrong);
    const gatedWrong = await runCorpus({ dir: tmp, print: false, mode: 'legacy' });
    assert.equal(gatedWrong.results[0].gated, true);
    assert.equal(gatedWrong.ok, false, 'reviewed entry with wrong truth fails the gate');

    // Reviewed with correct totals and the checked-subset discipline: gates and passes.
    const reviewedFiles = { ...entry.files, 'truth.json': JSON.stringify({ ...entry.truth, status: 'reviewed', types: {} }, null, 1) };
    writeEntry(tmp, entry.slug, reviewedFiles);
    const gatedOk = await runCorpus({ dir: tmp, print: false, mode: 'legacy' });
    assert.equal(gatedOk.results[0].recall, '67/67');
    assert.equal(gatedOk.ok, true, JSON.stringify(gatedOk.results[0].failures));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('B3: field fixes are recorded with kind/question/before+after hashes (truth untouched)', () => {
  const before = acceptanceDoc();
  const edited = { ...acceptanceDoc(), questions: acceptanceDoc().questions.map(item => ({ ...item })) } as ExamDoc;
  const target = edited.questions.find(item => item.no === 25)!;
  target.stem = `${target.stem} (fixed by hand)`;
  edited.questions = edited.questions.filter(item => item.no !== 67);
  const records = diffCorpusFixes(before, edited, 'step4-edit', new Date('2026-10-25T00:00:00Z'));
  assert.equal(records.length, 2);
  const edit = records.find(record => record.questionNo === 25)!;
  assert.equal(edit.change, 'edited');
  assert.equal(edit.kind, 'step4-edit');
  assert.notEqual(edit.beforeHash, edit.afterHash);
  assert.equal(edit.beforeHash, hashQuestion(before.questions.find(item => item.no === 25)));
  const removed = records.find(record => record.questionNo === 67)!;
  assert.equal(removed.change, 'removed');
  const notes = formatCorpusFixNotes(records);
  assert.match(notes, /step4-edit · Q25/);
  assert.match(notes, /→/);
});

test('B4: coverage table generates from truth metadata and names the empty cells', () => {
  const metas = readCorpusEntryMetas(CORPUS_DIR);
  assert.ok(metas.length >= 12, `expected the full corpus, got ${metas.length}`);
  const table = buildCoverageTable(metas);
  assert.deepEqual(table.uncoveredFeatures, ['dialogue'], 'known corpus-wide gap');
  const markdown = coverageMarkdown(metas);
  assert.match(markdown, /\| iranian-national-final-en \|/);
  assert.match(markdown, /\*\*EMPTY\*\*/);
  assert.match(markdown, /Uncovered corpus-wide.*`dialogue`/);
  assert.ok(table.emptyCells.some(cell => cell.family === 'iranian-national-final-en' && cell.feature === 'dialogue'));
  assert.ok(table.emptyCells.some(cell => cell.family === 'iranian-national-final-en' && cell.feature === 'separate-key-file'));
  const readme = fs.readFileSync(path.join(CORPUS_DIR, 'README.md'), 'utf8');
  assert.ok(readme.includes('| iranian-national-final-en |'), 'committed README carries the generated table');
  assert.ok(readme.includes('Review workflow'), 'README documents the B2 workflow');
});

// ============================================================================
// Part D — format probes (deterministic, report-only, honestly scored)
// ============================================================================

test('T4/D1: probe fixtures are byte-reproducible from the acceptance lines and report scores', async () => {
  const source = acceptanceLines();
  const twoColumn = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'probe-two-column/source-lines.json'), 'utf8'));
  const scanned = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'probe-scanned-noise/source-lines.json'), 'utf8'));
  assert.deepEqual(twoColumn, columnShuffleLines(source), 'two-column probe regenerates exactly');
  assert.deepEqual(scanned, injectOcrNoise(source), 'scanned-noise probe regenerates exactly (seeded)');
  for (const slug of ['probe-two-column', 'probe-scanned-noise']) {
    const truth = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, slug, 'truth.json'), 'utf8'));
    assert.equal(truth.status, 'unreviewed', `${slug} is report-only until reviewed`);
    assert.deepEqual(truth.expectedNumbers, JSON.parse(fs.readFileSync(path.join(ACCEPTANCE_DIR, 'truth.json'), 'utf8')).expectedNumbers, 'truth unchanged');
  }
  const { results, ok } = await runCorpus({ only: ['probe-two-column', 'probe-scanned-noise'], print: false, mode: 'legacy' });
  assert.equal(ok, true, 'probes never gate');
  const bySlug = new Map(results.map(result => [result.exam, result]));
  // Honest measured scores on today's parser (pinned so regressions/improvements are seen).
  assert.equal(bySlug.get('probe-two-column')!.recall, '67/67');
  assert.equal(bySlug.get('probe-two-column')!.sections, '2/8');
  assert.equal(bySlug.get('probe-scanned-noise')!.recall, '63/67');
  assert.equal(bySlug.get('probe-scanned-noise')!.sections, '0/8');
  for (const result of results) {
    assert.equal(result.gated, false);
    assert.ok((result.recallRatio ?? 0) >= 0.8, `${result.exam} numbers recall stays ≥80% (D2 threshold)`);
  }
});
