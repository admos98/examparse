/** #59 corrective regressions. Synthetic fixtures exercise public import/export/solver paths. */
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildExportDoc } from '../src/utils/examExport';
import { planBankAnswer, migrateLegacyAiAnswers } from '../src/utils/bankAnswers';
import { solveQuestionsWithAI } from '../src/pipeline/solver';
import { artifactState } from '../src/pipeline/evidence';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { createQuestionBankExport } from '../src/utils/questionBankExport';
import { file } from './fixtures/package-53';
import type { ExamDoc, Question } from '../src/types';

const question = (patch: Partial<Question> = {}): Question => ({
  id: 'q1', no: 1, label: '1', spans: [], stem: 'Choose.', type: 'mcq',
  options: [{ key: 'A', spans: [], text: 'one' }, { key: 'B', spans: [], text: 'two' }],
  answer: { text: 'B', source: 'paper' }, images: [], confidence: 1, ...patch,
});
const doc = (questions: Question[]): ExamDoc => ({
  id: 'exam1', fileHash: 'hash', createdAt: '2026-01-01', displayName: 'Exam',
  meta: { title: 'Exam', grade: '12', subject: 'English', language: 'en', direction: 'ltr' },
  source: { kind: 'package', lines: [], pages: 1, ocrUsed: false, fileName: 'batch.json' },
  sections: [{ id: 's1', index: 0, title: 'Section 1', spans: [] }], passages: [], questions,
  images: [], flags: [], usage: [],
});

const asPackageFiles = async (zipBytes: Uint8Array) => {
  const zip = await JSZip.loadAsync(zipBytes);
  const files: Array<any> = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const bytes = await (entry as JSZip.JSZipObject).async('uint8array');
    files.push({ name: path.split('/').pop(), webkitRelativePath: path, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type: '' });
  }
  return files;
};

test('#59 teacher answer provenance overrides imported source key; original remains in history', () => {
  const q = question({ answer: { text: 'A', source: 'manual' }, imported: { answer_key: { correct: ['B'] } } });
  const plan = planBankAnswer(q);
  assert.equal(plan.kind, 'option-key');
  if (plan.kind === 'option-key') assert.deepEqual(plan.correct, ['1']);
  assert.deepEqual(q.imported?.answer_key.correct, ['B']);
});

test('#59 old AI answer migrates out of executable answer before structured export', () => {
  const q = question({ answer: { text: 'invented', source: 'ai' }, imported: { answer_key: { correct: ['B'] } } });
  const source = doc([q]);
  migrateLegacyAiAnswers(source);
  assert.equal(q.answer?.source, 'paper');
  assert.equal(q.answer?.text, 'B');
  assert.equal(q.enrichment?.proposedAnswer?.text, 'invented');
  const exported = buildExportDoc(source);
  assert.equal(exported.questions[0].answer.text, 'B');
});

test('#59 AI Solve creates review proposal without replacing an existing source key', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    json: [{ id: 'q1', answer: 'model proposal' }], rawText: '', usage: { inputTokens: 1, outputTokens: 1 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const q = question();
    const solved = await solveQuestionsWithAI({ questions: [q], questionIdsToSolve: ['q1'], providerConfig: { id: 'p', name: 'local', model: 'm', kind: 'openai-compatible' } });
    assert.equal(solved.updatedQuestions[0].answer?.text, 'B');
    assert.equal(solved.updatedQuestions[0].enrichment?.proposedAnswer?.text, 'model proposal');
  } finally { globalThis.fetch = originalFetch; }
});

test('#59 unbound legacy verified artifact is stale, not verified', () => {
  const q = question();
  assert.equal(artifactState(doc([q]), q, { judged: 'verified' }), 'stale');
});

test('#59 package import restores descriptive sample and rubric into editable fields', async () => {
  const base = file('batch.json', JSON.stringify({ batch_id: 'samples', questions: [{
    type: 'short_answer', label: '17D', title: 'Question 17D', stem: 'Write.', points: 2,
    sample_answer: { text: 'Source sample.', source: 'paper' },
    rubric: { criteria: [{ criterion: 'Task', maxPoints: 1 }, { criterion: 'Language', maxPoints: 1 }], sourceProvenance: 'teacher' },
  }] }));
  const imported = await importQuestionPackage([base]);
  assert.equal(imported.questions[0].sampleAnswer?.text, 'Source sample.');
  assert.equal(imported.questions[0].rubric?.criteria[0].criterion, 'Task');
});

test('#59 native ZIP round-trip keeps explicit teacher answers over source history for MCQ, blanks and true/false', async () => {
  const initial = await importQuestionPackage([file('batch.json', JSON.stringify({ batch_id: 'round-trip', questions: [
    { type: 'multiple_choice', title: 'Question 1', label: '1', stem: 'Choose.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['B'] } },
    { type: 'fill_in_blank', title: 'Question 2', label: '2', stem: '___ then ___.', correctFillBlanks: [['original', 'alternate'], ['second']] },
    { type: 'true_false', title: 'Question 3', label: '3', stem: 'Statement.', answer_key: { correct: ['False'] } },
  ] }))]);
  initial.questions[0].answer = { text: 'A', source: 'manual' };
  initial.questions[1].answer = { text: 'teacher replacement', source: 'manual' };
  initial.questions[2].answer = { text: 'True', source: 'manual' };
  const first = await createQuestionBankExport(initial, { sourceDataset: 'round-trip' });
  assert.deepEqual(first.batch.questions.map(row => row.answer_key?.correct), [['1'], undefined, ['1']]);
  assert.deepEqual(first.batch.questions[1].correctFillBlanks, [['teacher replacement']]);
  const files = await asPackageFiles(first.zip);
  const reimported = await importQuestionPackage(files);
  assert.deepEqual(reimported.questions.map(q => q.answer?.text), ['A', 'teacher replacement', 'True']);
  assert.deepEqual(reimported.questions[0].imported?.source_history?.answer_key?.correct, ['B']);
  assert.deepEqual(reimported.questions[1].imported?.source_history?.correctFillBlanks, [['original', 'alternate'], ['second']]);
  const second = await createQuestionBankExport(reimported, { sourceDataset: 'round-trip' });
  assert.deepEqual(second.batch.questions.map(row => row.answer_key?.correct), [['1'], undefined, ['1']]);
  assert.deepEqual(second.batch.questions[1].correctFillBlanks, [['teacher replacement']]);
  const files2 = await asPackageFiles(second.zip);
  const twice = await importQuestionPackage(files2);
  assert.deepEqual(twice.questions.map(q => q.answer?.text), ['A', 'teacher replacement', 'True']);
});

test('#59 unresolved placeholder imported without an ImageAsset keeps owner and pending state in ZIP/report', async () => {
  const source = file('batch.json', JSON.stringify({ batch_id: 'placeholder', questions: [
    { type: 'short_answer', title: 'Question 17D', label: '17D', stem: 'Describe [img_aaaaaaaaaaaaaaaa].' },
  ] }));
  const imported = await importQuestionPackage([source]);
  assert.equal(imported.images.length, 0);
  assert.equal(imported.questions[0].images.length, 0);
  const exported = await createQuestionBankExport(imported, { sourceDataset: 'placeholder' });
  assert.equal(exported.batch.questions[0].unresolved_placeholders?.[0].asset, 'img_aaaaaaaaaaaaaaaa');
  assert.ok(exported.report.missing_assets.some(row => row.question === 'Q17D' && row.image === 'img_aaaaaaaaaaaaaaaa'));
});

test('#59 listening scripts round-trip through a teacher-only ZIP sidecar, never student batch.json', async () => {
  const source = file('batch.json', JSON.stringify({ batch_id: 'script-round-trip', questions: [
    { type: 'multiple_choice', title: 'Question 1', label: '1', stem: 'Listen to Section 1 and choose.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['A'] } },
    { type: 'multiple_choice', title: 'Question 2', label: '2', stem: 'Listen to Section 2 and choose.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['B'] } },
  ] }));
  const scripts = file('listening_scripts.md', '## Section 1 — Questions 1–1\nFirst private script.\n## Section 2 — Questions 2–2\nSecond private script.');
  const imported = await importQuestionPackage([source, scripts]);
  assert.deepEqual(imported.questions.map(q => q.imported?.script), ['First private script.', 'Second private script.']);
  const exported = await createQuestionBankExport(imported, { sourceDataset: 'script-round-trip' });
  assert.ok(!JSON.stringify(exported.batch).includes('First private script.'));
  const entries = await asPackageFiles(exported.zip);
  const reimported = await importQuestionPackage(entries);
  assert.deepEqual(reimported.questions.map(q => q.imported?.script), ['First private script.', 'Second private script.']);
  assert.deepEqual(reimported.questions.map(q => q.imported?.scriptEvidenceType), ['teacher-only-script', 'teacher-only-script']);
});
