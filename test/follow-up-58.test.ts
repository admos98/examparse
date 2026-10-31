/**
 * #58 final corrective repair — acceptance gates.
 * Synthetic fixtures only; mocks demonstrate control flow, never real model accuracy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { importPackageFolder } from '../src/pipeline/packageBatchImport';
import { enrichPackage } from '../src/pipeline/packageEnrichment';
import { generatePackageTashrihi, confirmTashrihi, rubricCriteria, validateRubric } from '../src/pipeline/packageTashrihi';
import { generatePackageExplanations } from '../src/pipeline/packageExplanations';
import { buildExportDoc } from '../src/utils/examExport';
import { createQuestionBankExport, compactBankSourceRef } from '../src/utils/questionBankExport';
import { planBankAnswer, migrateLegacyAiAnswers, hasSourceKey, typeSuggestion } from '../src/utils/bankAnswers';
import { salvageJsonObjects } from '../src/utils/jsonRepair';
import { computeAttention, attentionCount, quietState } from '../src/utils/attention';
import { reviewTags } from '../src/utils/explanationVisibility';
import { Step4ReviewContent } from '../src/views/Step4Review';
import { DEFAULT_SETTINGS } from '../src/store';
import { file, png, png2 } from './fixtures/package-53';
import type { AppSettings, ExamDoc, Question } from '../src/types';

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  // The test judge is a picture-capable local endpoint (the Lightning envelope accepts ≤4 images).
  decideMultimodal: true,
  providers: [
    { id: 'read', name: 'writer', kind: 'openai-compatible', baseURL: 'http://localhost:1234', apiKey: '' },
    { id: 'd', name: 'judge', kind: 'openai-compatible', baseURL: 'http://localhost:8080', apiKey: '', decideDialect: 'thx' },
  ],
  roleMapping: { ...DEFAULT_SETTINGS.roleMapping, read: { providerId: 'read', model: 'writer' }, decide: { providerId: 'd', model: 'judge' } },
};
const f = (path: string, data: string | Uint8Array) => { const base = file(path.split('/').pop()!, data); return { ...base, webkitRelativePath: path }; };
const label = (row: { label?: string }) => row.label;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const rows = () => [
  { type: 'multiple_choice', title: 'Question 1', label: '1', stem: 'Choose the word.', options: [{ key: 'A', text: 'cat' }, { key: 'B', text: 'dog' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English' },
  { type: 'true_false', title: 'Question 2', label: '2', stem: 'The sky is green.', answer_key: { correct: ['False'] }, points: 1, grade: '12', subject: 'English' },
  { type: 'fill_in_blank', title: 'Question 3', label: '3', stem: 'She said ___ .', answer_key: { correct: ['she had the money'] }, points: 1, grade: '12', subject: 'English' },
  { type: 'fill_in_blank', title: 'Question 4', label: '4', stem: 'In the ___ century they won the ___ .', correctFillBlanks: [['century', 'hundred years'], ['war']], points: 2, grade: '12', subject: 'English' },
  { type: 'short_answer', title: 'Question 5', label: '5', stem: 'Answer in one sentence: what did she have?', answer_key: { correct: ['She had the money.'] }, points: 2, grade: '12', subject: 'English' },
  { type: 'short_answer', title: 'Question 6', label: '6', stem: 'Write a topic sentence about honesty.', points: 2, grade: '12', subject: 'English' },
  { type: 'long_answer', title: 'Question 7', label: '7', stem: 'Write a paragraph about the town.', points: 4, grade: '12', subject: 'English' },
  { type: 'short_answer', title: 'Question 17D', label: '17D', stem: 'Write a paragraph about the journey.', points: 3, grade: '12', subject: 'English' },
];
const importRows = async (id: string, list: any[]) => importQuestionPackage([f('batch.json', JSON.stringify({ batch_id: id, questions: list }))]);

const generativeCaller = async (request: any) => {
  const payload = JSON.parse(request.text);
  if (String(request.label).startsWith('Package tashrihi')) {
    return { json: { corrections: payload.questions.map((q: any) => ({ questionNumber: q.label, sampleAnswer: `Model sample for ${q.label}.`, rubric: [{ criterion: 'Task addressed', maxPoints: (q.points || 2) / 2 }, { criterion: 'Language', maxPoints: (q.points || 2) / 2 }] })) }, rawText: '' };
  }
  if (String(request.label).startsWith('Package blank candidates')) {
    return { json: { candidates: payload.questions.map((q: any) => ({ questionNumber: q.label, answer: 'candidate text' })) }, rawText: '' };
  }
  return { json: { corrections: payload.questions.map((q: any) => ({ questionNumber: q.label, explanation: `Because ${q.label}.` })) }, rawText: '' };
};
const baseJudge = async (body: any) => {
  const name = Object.keys(body.questions)[0];
  if (name.includes('blind-answer')) return { results: [{ name, probability: 0.9, choice: 'A' }] };
  if (name.includes('answer-proposal')) return { results: [{ name, probability: 0.9, choice: 'B' }] };
  if (name.includes('proposal-check')) return { results: [{ name, probability: 0.9 }] };
  if (name.includes('lessons')) return { results: [{ name, probability: 0.9, choice: 'none-of-the-above' }] };
  return { results: [{ name, probability: 0.9 }] };
};

// ───────────────────── A — source answers survive by type (structured + native bank) ─────────
test('#58A source answers keep their type: option key, text blanks (with alternatives), descriptive sample', async () => {
  const doc = await importRows('answers', rows());
  // Importable even though a keyless descriptive item has no rubric.
  assert.equal(doc.questions.length, 8);
  const structured = buildExportDoc(doc);
  assert.equal(structured.questions[2].answer.text, 'she had the money');
  assert.equal(structured.questions[4].answer.text, 'She had the money.');
  assert.equal(structured.questions[3].imported.correctFillBlanks[0][0], 'century');

  const plans = doc.questions.map(question => planBankAnswer(question));
  assert.equal(plans[0].kind, 'option-key');
  assert.equal(plans[1].kind, 'true-false');
  assert.equal(plans[2].kind, 'text-blanks');
  assert.equal(plans[4].kind, 'descriptive');
  assert.equal(plans[6].kind, 'keyless');

  const bank = await createQuestionBankExport(doc, { sourceDataset: 'answers' });
  const byLabel = (value: string) => bank.batch.questions.find(row => row.label === value)!;
  assert.deepEqual(byLabel('1').answer_key, { correct: ['1'], grading: 'auto' });
  assert.deepEqual(byLabel('2').answer_key, { correct: ['2'], grading: 'auto' }, 'False maps to option 2');
  assert.deepEqual(byLabel('3').correctFillBlanks, [['she had the money']], 'optionless source key survives, not forced into an option index');
  assert.deepEqual(byLabel('4').correctFillBlanks, [['century', 'hundred years'], ['war']], 'blanks and alternatives are not collapsed');
  assert.equal(byLabel('5').sample_answer?.text, 'She had the money.');
  assert.equal(byLabel('5').sample_answer?.provenance, 'paper');
  assert.equal(byLabel('6').sample_answer, undefined);
  assert.ok(byLabel('6').tags.includes('needs_rubric'), 'needs_rubric never blocks import');
  assert.ok(byLabel('7').tags.includes('needs_rubric'));
  assert.ok(!byLabel('6').tags.includes('answer_key_needs_review'), 'a descriptive item is not an auto-graded key problem');
  // The contract state is explicit and never claims verification.
  assert.equal(bank.report.contract.verified, false);
  assert.ok(bank.report.contract.pending.length > 0);
  // Semantic type conflict: preserved source type, surfaced suggestion, no blanket rewrite.
  assert.equal(byLabel('17D').type, 'short_answer');
  assert.ok(byLabel('17D').tags.includes('type_suggestion_long_answer'));
  assert.ok(bank.report.notes.some(note => note.startsWith('Q17D: the source labels this short but the task reads as long_answer')));
  assert.equal(typeSuggestion(doc.questions[7]), 'long_answer');

  // Conservative profile writes only provable option keys into batch.json; everything else is
  // carried losslessly in the sidecar.
  const conservative = await createQuestionBankExport(doc, { sourceDataset: 'answers', contract: 'appendix-a-1.1' });
  const conservativeRow = (value: string) => conservative.batch.questions.find(row => row.label === value)!;
  assert.deepEqual(conservativeRow('1').answer_key, { correct: ['1'], grading: 'auto' });
  assert.equal(conservativeRow('3').correctFillBlanks, undefined);
  assert.equal(conservativeRow('5').sample_answer, undefined);
  const zip = await JSZip.loadAsync(conservative.zip);
  const root = conservative.filename.replace(/\.zip$/, '');
  const preserved = JSON.parse(await zip.file(`${root}/preserved/answers.json`)!.async('string'));
  assert.equal(preserved.executable, false);
  const entry = (value: string) => preserved.questions.find((row: any) => row.label === value);
  assert.deepEqual(entry('3').answer.blanks, [{ accept: ['she had the money'] }]);
  assert.deepEqual(entry('4').answer.blanks[0].accept, ['century', 'hundred years']);
  assert.deepEqual(entry('4').answer.blanks[1].accept, ['war']);
  assert.equal(entry('5').answer.text, 'She had the money.');
  assert.equal(entry('6').needs_rubric, true);
  const requests = JSON.parse(await zip.file(`${root}/contract/requests.json`)!.async('string'));
  assert.equal(requests.verified, false);
  assert.ok(requests.requests.length >= 10, 'the exact contract questions travel with the ZIP');
});

// ───────────────────── A — propose-never-execute, everywhere ─────────────────────────────────
const executableSnapshot = (doc: any) => JSON.stringify(doc.questions.map((question: any) => ({
  id: question.id,
  answer: question.answer ?? null,
  answerKey: question.imported?.answer_key ?? null,
  correctFillBlanks: question.imported?.correctFillBlanks ?? null,
  bankKey: question.answer_key ?? null,
})));

test('#58A proposals (checker, legacy AI Solve, optionless candidate) never populate an executable field', async () => {
  const list = [
    { type: 'multiple_choice', title: 'Question 1', label: '1', stem: 'Pick.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], points: 1, grade: '12', subject: 'English' },
    { type: 'fill_in_blank', title: 'Question 2', label: '2', stem: 'The ___ was closed.', points: 1, grade: '12', subject: 'English' },
    { type: 'true_false', title: 'Question 3', label: '3', stem: 'True or false: water is dry.', points: 1, grade: '12', subject: 'English' },
  ];
  const doc = await importRows('proposals', list);
  const out = await enrichPackage(doc, settings, { explanationCaller: generativeCaller, decisionCaller: baseJudge });
  const proposal = out.questions[0].enrichment?.proposedAnswer;
  assert.equal(proposal?.text, 'B');
  assert.equal(out.questions[0].answer, undefined);
  const blankCandidate = out.questions[1].enrichment?.proposedAnswer;
  assert.equal(blankCandidate?.text, 'candidate text');
  assert.equal(blankCandidate?.check?.state, 'verified');
  assert.equal(out.questions[1].answer, undefined);
  assert.equal(out.questions[1].imported?.answer_key, undefined);

  // Byte-identical executable fields with and without the proposals, in both exports.
  const baseline = structuredClone(out);
  for (const question of baseline.questions) if (question.enrichment?.proposedAnswer) delete question.enrichment.proposedAnswer;
  const strip = (row: any) => { const { enrichment: _enrichment, tags: _tags, ...rest } = row; return JSON.stringify(rest); };
  const structured = buildExportDoc(out);
  const structuredBase = buildExportDoc(baseline);
  assert.equal(executableSnapshot(structured), executableSnapshot(structuredBase));
  assert.equal(strip(structured.questions[0]), strip(structuredBase.questions[0]));
  const bank = await createQuestionBankExport(out, { sourceDataset: 'proposals' });
  const bankBase = await createQuestionBankExport(baseline, { sourceDataset: 'proposals' });
  assert.deepEqual(bank.batch.questions.map(row => row.answer_key ?? null), bankBase.batch.questions.map(row => row.answer_key ?? null));
  assert.deepEqual(bank.batch.questions.map(row => row.correctFillBlanks ?? null), [null, null, null]);
  assert.deepEqual(bank.batch.questions.map(row => row.sample_answer ?? null), [null, null, null]);
  assert.ok(bank.batch.questions[0].tags.includes('answer_key_needs_review'));
  assert.ok(bank.batch.questions[1].tags.includes('answer_key_needs_review'));
  assert.ok(bank.batch.questions[2].tags.includes('answer_key_needs_review'));

  // Legacy stored AI Solve values: migrated to a proposal, work kept, never keyed.
  const legacy = await importRows('legacy', list);
  legacy.questions[0].answer = { text: 'B', source: 'ai' } as Question['answer'];
  migrateLegacyAiAnswers(legacy);
  assert.equal(legacy.questions[0].answer?.text, 'B', 'the user’s work is not deleted');
  assert.equal(legacy.questions[0].enrichment?.proposedAnswer?.text, 'B');
  assert.equal(hasSourceKey(legacy.questions[0]), false);
  assert.ok(reviewTags(legacy.questions[0]).includes('answer_key_needs_review'));
  const legacyBank = await createQuestionBankExport(legacy, { sourceDataset: 'legacy' });
  assert.equal(legacyBank.batch.questions[0].answer_key, undefined);
  const legacyStructured = buildExportDoc(legacy);
  assert.equal(legacyStructured.questions[0].answer.nonExecuting, true);

  // An explicit teacher save is the only thing that becomes executable.
  legacy.questions[0].answer = { text: 'B', source: 'manual' };
  const savedBank = await createQuestionBankExport(legacy, { sourceDataset: 'legacy' });
  assert.deepEqual(savedBank.batch.questions[0].answer_key, { correct: ['2'], grading: 'auto' });
  assert.ok(!savedBank.batch.questions[0].tags.includes('answer_key_needs_review'));
});

// ───────────────────── B — rubric arithmetic ────────────────────────────────────────────────
test('#58B rubric arithmetic preserves a representable distribution and never invents weights', () => {
  const fractional = rubricCriteria([{ criterion: 'a', maxPoints: 0.125 }, { criterion: 'b', maxPoints: 0.125 }, { criterion: 'c', maxPoints: 0.125 }, { criterion: 'd', maxPoints: 0.125 }], 0.5)!;
  assert.deepEqual(fractional.map(criterion => criterion.maxPoints), [0.125, 0.125, 0.125, 0.125]);
  assert.ok(validateRubric(fractional, 0.5).ok);
  // A model distribution that does not add up gets an EXACT even split, never quarter-rounding.
  assert.deepEqual(rubricCriteria([{ criterion: 'a', maxPoints: 1 }, { criterion: 'b', maxPoints: 1 }], 3)!.map(criterion => criterion.maxPoints), [1.5, 1.5]);
  // 1 / 3 is not representable: pending, never 0.3333 + 0.3333 + 0.0001 or a negative last weight.
  assert.equal(rubricCriteria([{ criterion: 'a', maxPoints: 0 }, { criterion: 'b', maxPoints: 0 }, { criterion: 'c', maxPoints: 0 }], 1), undefined);
  assert.equal(rubricCriteria([{ criterion: 'a', maxPoints: -1 }, { criterion: 'b', maxPoints: 2 }], 1), undefined);
  assert.deepEqual(rubricCriteria([{ criterion: 'a', maxPoints: 0 }, { criterion: 'b', maxPoints: 0 }], 2)!.map(criterion => criterion.maxPoints), [1, 1], 'omitted weights with a printed total get an exact split');
  assert.equal(rubricCriteria([{ criterion: 'a', maxPoints: 0 }, { criterion: 'b', maxPoints: 0 }], null), undefined, 'no printed points → unpriced rubric, never invented weights');
  assert.equal(rubricCriteria([{ criterion: 'a', maxPoints: 1 }, { criterion: 'b', maxPoints: 0 }], 2), undefined, 'mixed positive/zero is malformed');
  assert.deepEqual(rubricCriteria([{ criterion: 'a', maxPoints: 2 }, { criterion: 'b', maxPoints: 2 }], 3)!.map(criterion => criterion.maxPoints), [1.5, 1.5], 'a mismatched but representable total gets an exact split, never quarters');
  const unpriced = rubricCriteria([{ criterion: 'a', maxPoints: 2 }, { criterion: 'b', maxPoints: 1 }], null)!;
  assert.deepEqual(unpriced.map(criterion => criterion.maxPoints), [2, 1]);
});

test('#58B nested truncated output is salvaged; each missing part gets one scoped retry', async () => {
  // The flat regex could never recover a complete row containing a nested rubric object.
  const truncated = '{"corrections":[{"questionNumber":"1","sampleAnswer":"A complete sample.","rubric":[{"criterion":"Point one","maxPoints":1},{"criterion":"Point two","maxPoints":1}]},{"questionNumber":"2","sampleAnswer":"Cut off mid';
  const salvaged = salvageJsonObjects(truncated);
  assert.equal(salvaged.length, 1);
  assert.equal(salvaged[0].rubric[1].maxPoints, 1);

  const doc = await importRows('salvage', [
    { type: 'short_answer', title: 'Question 1', label: '1', stem: 'Write one sentence.', points: 2, grade: '12', subject: 'English' },
    { type: 'short_answer', title: 'Question 2', label: '2', stem: 'Write another sentence.', points: 2, grade: '12', subject: 'English' },
  ]);
  const requests: any[] = [];
  const notes = await generatePackageTashrihi(doc, settings, {
    caller: async (request: any) => {
      requests.push(request);
      const payload = JSON.parse(request.text);
      if (String(request.system).includes('Omit sampleAnswer')) {
        return { json: { corrections: payload.questions.map((q: any) => ({ questionNumber: q.label, rubric: [{ criterion: 'Marked', maxPoints: 1 }, { criterion: 'Clear', maxPoints: 1 }] })) }, rawText: '' };
      }
      // First pass writes only a sample for both questions.
      return { json: { corrections: payload.questions.map((q: any) => ({ questionNumber: q.label, sampleAnswer: `Sample ${q.label}.` })) }, rawText: '' };
    },
  });
  assert.equal(requests.length, 2, 'one batch call plus exactly one rubric-only retry');
  assert.ok(doc.questions.every(question => question.sampleAnswer && question.rubric));
  assert.ok(notes.some(note => /2 sample · 2 rubric/.test(note)));
});

// ───────────────────── C — evidence payloads ───────────────────────────────────────────────
test('#58C sample/rubric/explanation judges receive the addressed bundle and mapped script, never another section', async () => {
  const sectionA = { id: 'sec-a', index: 0, title: 'Listening — Section 1', spans: [] };
  const sectionB = { id: 'sec-b', index: 1, title: 'Listening — Section 2', spans: [] };
  const sha = sha256(png);
  const doc = await importQuestionPackage([
    f('batch.json', JSON.stringify({
      batch_id: 'evidence',
      questions: [
        { type: 'short_answer', title: 'Question 1', label: '1', stem_blocks: [{ t: 'text', v: 'Look at the picture and write one sentence. ' }, { t: 'img', asset: sha }], points: 2, grade: '12', subject: 'English', section: 'Listening — Section 1' },
        { type: 'short_answer', title: 'Question 2', label: '2', stem: 'Listen to Section 2 and write a sentence.', points: 2, grade: '12', subject: 'English', section: 'Listening — Section 2' },
      ],
    })),
    f('assets/' + sha + '.png', png),
    f('listening_scripts.md', '## Section 1 — Questions 1–1\nFirst script text.\n## Section 2 — Questions 2–2\nSecond script text.'),
  ]);
  assert.ok(doc.sections.length >= 2);
  // Force the mapped section titles the importer derived so the script receipt is explicit.
  const requests: any[] = [];
  await enrichPackage(doc, settings, {
    explanationCaller: async (request: any) => { requests.push(request); return generativeCaller(request); },
    decisionCaller: async (body: any) => { requests.push({ label: 'decision', text: JSON.stringify(body) }); return baseJudge(body); },
  });
  const sampleRequest = requests.find(request => String(request.label || '').startsWith('Package tashrihi') && JSON.parse(request.text).questions.some((q: any) => q.label === '1'));
  assert.ok(sampleRequest, 'the writer drafted the picture item');
  assert.ok((sampleRequest!.images || []).length === 1, 'the picture travels with its own question');
  assert.equal(sampleRequest!.images[0].id, 'img_' + sha);
  assert.match(sampleRequest!.images[0].data, /^[A-Za-z0-9+/=]+$/, 'base64 payload without a data prefix');
  // Judge bodies for the picture item carry the same bundle.
  const sampleCheck = requests.find(request => /sample-answer-check/.test(request.text) && /Q1|"q_1 sample-answer-check"/.test(request.text));
  const sampleBody = JSON.parse(sampleCheck!.text);
  // The systemone envelope carries the addressed pixels as top-level data URLs.
  assert.ok(Array.isArray(sampleBody.images) && sampleBody.images.length === 1);
  assert.match(sampleBody.images[0], /^data:image\/png;base64,/);
  // Listening checks carry the mapped script — the right one, never the other section's.
  const scriptChecks = requests.filter(request => /rubric-check|sample-answer-check/.test(request.text));
  const withScript = scriptChecks.map(request => JSON.stringify(request.text)).filter(text => /script text/i.test(text));
  assert.ok(withScript.length > 0, 'a scripted item was checked with its script');
  for (const text of withScript) {
    const first = /First script text/.test(text);
    const second = /Second script text/.test(text);
    assert.ok(first !== second, 'never both scripts in one check');
  }
});

test('#58C missing pixels and an over-limit bundle leave the checks unjudged — no split, no guessing', async () => {
  const sha1 = sha256(png), sha2 = sha256(png2);
  const fiveImages = [png, png2, new Uint8Array([...png, 9]), new Uint8Array([...png, 8]), new Uint8Array([...png, 7])];
  const doc = await importQuestionPackage([
    f('batch.json', JSON.stringify({ batch_id: 'bundle-limit', questions: [
      { type: 'short_answer', title: 'Question 1', label: '1', stem: 'Write about the missing picture.', points: 2, grade: '12', subject: 'English' },
      { type: 'short_answer', title: 'Question 2', label: '2', stem_blocks: [{ t: 'text', v: 'Which picture is this? ' }, ...fiveImages.map(bytes => ({ t: 'img', asset: sha256(bytes) }))], points: 2, grade: '12', subject: 'English' },
    ] })),
    ...fiveImages.map(bytes => f(`assets/${sha256(bytes)}.png`, bytes)),
  ]);
  // Question 1's picture reference is removed entirely: pixels cannot be addressed.
  doc.questions[0].images = [{ imageId: 'img_missing', role: 'stem' }];
  let modelCalls = 0;
  const requests: any[] = [];
  const out = await enrichPackage(doc, { ...settings, thrift: { ...settings.thrift, maxImagesPerDecisionCall: 4 } }, {
    explanationCaller: async (request: any) => { modelCalls++; requests.push(request); return generativeCaller(request); },
    decisionCaller: async (body: any) => { modelCalls++; requests.push(body); return baseJudge(body); },
  });
  assert.ok(out.questions.every(question => question.sampleAnswer?.judged !== 'verified'), 'no picture-blind sample is verified');
  assert.ok(out.questions.every(question => question.enrichment?.verification !== 'verified'), 'no picture-blind key check is verified');
  const imageCalls = requests.filter(request => Array.isArray((request as any).images) && (request as any).images.length);
  assert.ok(imageCalls.every(request => request.images.length <= 4), 'the endpoint limit is respected');
  assert.ok(!requests.some(request => (request.images || []).length === 1 && (request.images || []).length < 5 && /bundle-limit/.test(JSON.stringify(request))), 'no per-image splitting');
  assert.ok(out.source.enrichmentNotes!.some(note => /exceed the local endpoint's 4-image limit/.test(note)));
  assert.ok(out.source.enrichmentNotes!.some(note => /unavailable/.test(note)));
  assert.ok(modelCalls > 0, 'the rest of the exam still runs');
});

test('#58C image placement is addressed with the known nearby candidates, never the whole paper', async () => {
  const sha = sha256(png);
  const doc = await importQuestionPackage([
    f('batch.json', JSON.stringify({ batch_id: 'placement', questions: [
      { type: 'short_answer', title: 'Question 1', label: '1', stem: 'Describe the picture.', points: 2, grade: '12', subject: 'English', section: 'Part A' },
      { type: 'short_answer', title: 'Question 2', label: '2', stem: 'Describe this picture.', points: 2, grade: '12', subject: 'English', section: 'Part A' },
      { type: 'short_answer', title: 'Question 4', label: '4', stem: 'A far question.', points: 2, grade: '12', subject: 'English', section: 'Part B' },
      { type: 'short_answer', title: 'Question 5', label: '5', stem: 'Another far question.', points: 2, grade: '12', subject: 'English', section: 'Part B' },
    ] })),
    f('assets/' + sha + '.png', png),
  ]);
  // One unshared picture attached to Q1, with a known page but no source answer.
  doc.images = [{ id: 'img_' + sha, page: 3, bbox: { x: 0, y: 0, w: 1, h: 1 }, mime: 'image/png', sha, width: 1, height: 1, blobKey: sha, dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}` }];
  doc.questions[0].images = [{ imageId: 'img_' + sha, role: 'stem' }];
  const placementInputs: any[] = [];
  await enrichPackage(doc, settings, {
    explanationCaller: generativeCaller,
    decisionCaller: async (body: any) => {
      const name = Object.keys(body.questions || {})[0] || '';
      if (/image-placement/.test(name)) placementInputs.push(body);
      return baseJudge(body);
    },
  });
  assert.ok(placementInputs.length > 0, 'placement is still judged when evidence exists');
  const bodyText = JSON.stringify(placementInputs[0]).replace(/\\+"/g, '"');
  assert.match(bodyText, /candidateQuestions/, 'the judge sees candidate owners');
  assert.match(bodyText, /"number":2/);
  assert.doesNotMatch(bodyText, /"number":4/, 'a far question never becomes a candidate');
  assert.doesNotMatch(bodyText, /"sourceAnswer"/, 'no source answer is invented');
  assert.ok(Array.isArray((placementInputs[0] as any).images) && (placementInputs[0] as any).images.length === 1);

  // With no neighbour and no source answer there is nothing to judge: skip, do not ask.
  const alone = await importQuestionPackage([
    f('batch.json', JSON.stringify({ batch_id: 'alone', questions: [
      { type: 'short_answer', title: 'Question 1', label: '1', stem: 'Describe the picture.', points: 2, grade: '12', subject: 'English' },
    ] })),
    f('assets/' + sha + '.png', png),
  ]);
  alone.images = doc.images;
  alone.questions[0].images = [{ imageId: 'img_' + sha, role: 'stem' }];
  let asked = false;
  const out = await enrichPackage(alone, settings, {
    explanationCaller: generativeCaller,
    decisionCaller: async (body: any) => { if (/image-placement/.test(JSON.stringify(body))) asked = true; return baseJudge(body); },
  });
  assert.equal(asked, false, 'no candidate and no answer means no fabricated placement question');
  assert.equal(out.questions[0].enrichment?.imagePlacement?.[0]?.state, 'skipped-no-evidence');
});

// ───────────────────── B — teacher durability and stale verdicts ───────────────────────────
test('#58B teacher-confirmed artifacts survive a rerun and an edited teacher artifact is not re-claimed as verified', async () => {
  const doc = await importRows('durable', [
    { type: 'short_answer', title: 'Question 1', label: '1', stem: 'Write one sentence about honesty.', points: 2, grade: '12', subject: 'English' },
    { type: 'short_answer', title: 'Question 2', label: '2', stem: 'Write one sentence about courage.', points: 2, grade: '12', subject: 'English' },
  ]);
  let out = await enrichPackage(doc, settings, { explanationCaller: generativeCaller, decisionCaller: baseJudge });
  const { evidenceFingerprint } = await import('../src/pipeline/evidence');
  out.questions[0] = confirmTashrihi(out.questions[0], 'Teacher wording one.', [{ criterion: 'Answered', maxPoints: 1 }, { criterion: 'Clear', maxPoints: 1 }], evidenceFingerprint(out, out.questions[0]));
  assert.equal(out.questions[0].sampleAnswer?.source, 'teacher');
  assert.equal(out.questions[0].sampleAnswer?.judged, 'unjudged', 'the model verdict is not re-claimed for teacher text');
  assert.equal(out.questions[0].rubric?.judged, 'unjudged', 'teacher content is not re-claimed as a model verdict');
  // A rejected model artifact that the teacher rewrites is preserved and exported.
  out.questions[1].sampleAnswer = { text: 'Rejected model text.', source: 'model', judged: 'rejected', evidence: undefined };
  out.questions[1] = confirmTashrihi(out.questions[1], 'Teacher rewrote this.', [{ criterion: 'Answered', maxPoints: 1 }, { criterion: 'Clear', maxPoints: 1 }], evidenceFingerprint(out, out.questions[1]));
  const rerun = await enrichPackage(out, settings, { explanationCaller: generativeCaller, decisionCaller: baseJudge });
  assert.equal(rerun.questions[0].sampleAnswer?.text, 'Teacher wording one.', 'teacher sample is never overwritten');
  assert.equal(rerun.questions[0].rubric?.source, 'teacher');
  assert.equal(rerun.questions[1].sampleAnswer?.text, 'Teacher rewrote this.', 'the teacher version of a rejected artifact survives');
  const bank = await createQuestionBankExport(rerun, { sourceDataset: 'durable' });
  assert.equal(bank.batch.questions[0].sample_answer?.text, 'Teacher wording one.');
  assert.equal(bank.batch.questions[1].sample_answer?.text, 'Teacher rewrote this.');
  assert.equal(bank.batch.questions[1].sample_answer?.source, 'teacher');
  assert.ok(!bank.batch.questions[0].tags.includes('needs_rubric'), 'a valid teacher rubric clears the active tag');

  // Changing the stem invalidates the model verdict; the teacher's work is preserved but marked.
  const changed = structuredClone(rerun);
  changed.questions[1].stem = 'Write a paragraph about a completely different story.';
  const changedBank = await createQuestionBankExport(changed, { sourceDataset: 'durable' });
  // Teacher sample still travels (their work), the stale MODEL verdict is gone.
  assert.equal(changedBank.batch.questions[1].sample_answer?.text, 'Teacher rewrote this.');
  const structured = buildExportDoc(changed);
  assert.equal(structured.questions[1].sampleAnswer?.reconfirm, true, 'teacher work is marked for reconfirmation, not deleted');
  const attention = computeAttention(changed);
  assert.ok(attention.some(item => item.kind === 'checks-stale' && item.plainSentence.startsWith('Q2')));
});

test('#58B an imported artifact of unknown state never becomes verified', async () => {
  const doc = await importRows('unknown', [{ type: 'short_answer', title: 'Question 1', label: '1', stem: 'Write one sentence.', points: 2, grade: '12', subject: 'English' }]);
  doc.questions[0].sampleAnswer = { text: 'Unknown provenance sample.', source: 'model', judged: 'verified' } as any;
  doc.questions[0].rubric = { criteria: [{ criterion: 'A', maxPoints: 1 }, { criterion: 'B', maxPoints: 1 }], source: 'model', judged: 'verified' } as any;
  const bank = await createQuestionBankExport(doc, { sourceDataset: 'unknown' });
  assert.equal(bank.batch.questions[0].sample_answer?.text, 'Unknown provenance sample.', 'legacy verified state is honoured');
  const changed = structuredClone(doc);
  changed.questions[0].points = 5;
  const staleBank = await createQuestionBankExport(changed, { sourceDataset: 'unknown' });
  assert.equal(staleBank.batch.questions[0].sample_answer?.text, 'Unknown provenance sample.', 'no fingerprint ⇒ legacy state, not silently dropped');
  // ...but once a fingerprint exists and the evidence changes, the verdict is not reused.
  doc.questions[0].sampleAnswer!.evidence = 'fingerprint-of-another-version';
  const mismatched = await createQuestionBankExport(doc, { sourceDataset: 'unknown' });
  assert.equal(mismatched.batch.questions[0].sample_answer, undefined, 'a verdict bound to different evidence is not exported as verified');
  assert.ok(mismatched.report.stale_verdicts.includes('Q1'));
});

// ───────────────────── D — assets, picture options, multipart round-trip ───────────────────
function buildMultipartDoc(): ExamDoc {
  const sha = sha256(png);
  const questions: Question[] = Array.from({ length: 71 }, (_, index) => ({
    id: `q_${index + 1}`,
    label: String(index + 1),
    no: index + 1,
    sectionId: 's1',
    spans: [],
    stem: `Question ${index + 1} stem.`,
    type: index % 10 === 0 ? 'short' : 'mcq',
    options: index % 10 === 0 ? [] : [{ key: 'A', text: 'one', spans: [] }, { key: 'B', text: 'two', spans: [] }],
    images: [],
    confidence: 1,
    points: 1,
    imported: index % 10 === 0 ? {} : { answer_key: { correct: ['A'] } },
  }));
  // One shared image referenced at both ends of the paper (chunk 1 and chunk 2).
  for (const index of [0, 50]) questions[index].images = [{ imageId: 'img_shared', role: 'stem' }];
  return {
    id: 'multi', fileHash: 'hash-multi', createdAt: '', displayName: 'Multipart exam',
    meta: { title: 'Multipart', subject: 'English', grade: '12', year: '1402', language: 'en', direction: 'ltr' } as ExamDoc['meta'],
    sections: [{ id: 's1', index: 0, title: 'Reading', spans: [] }],
    questions,
    images: [{ id: 'img_shared', page: 2, bbox: { x: 0, y: 0, w: 1, h: 1 }, mime: 'image/png', sha, width: 1, height: 1, blobKey: 'shared' }],
    source: { kind: 'pdf', lines: [], pages: 1, ocrUsed: false, fileName: 'multipart.pdf' } as ExamDoc['source'],
    flags: [], usage: [],
  };
}

test('#58D a >50-question export ships one asset pool, every part resolves it, and no base64 leaks', async () => {
  const doc = buildMultipartDoc();
  const exported = await createQuestionBankExport(doc, { sourceDataset: 'multipart' }, async () => new Blob([png]));
  const zip = await JSZip.loadAsync(exported.zip);
  const root = exported.filename.replace(/\.zip$/, '');
  const parts = Object.keys(zip.files).filter(path => /part-\d+\/batch\.json$/.test(path));
  assert.deepEqual(parts.sort(), [`${root}/part-1/batch.json`, `${root}/part-2/batch.json`]);
  assert.ok(zip.file(`${root}/assets/manifest.json`));
  assert.ok(zip.file(`${root}/part-1/assets-manifest.json`));
  assert.ok(zip.file(`${root}/part-2/assets-manifest.json`));
  const manifest = JSON.parse(await zip.file(`${root}/assets/manifest.json`)!.async('string'));
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].sha256, sha256(png));
  for (const part of parts) {
    const text = await zip.file(part)!.async('string');
    assert.doesNotMatch(text, /data:image\//i, 'no data URI in any batch value');
    assert.doesNotMatch(text, /base64,/i);
    assert.doesNotMatch(text, /img_[0-9a-f]{16,}/i, 'no placeholder token');
    const chunk = JSON.parse(text);
    for (const row of chunk.questions) {
      for (const block of row.stem_blocks || []) if (block.t === 'img') assert.match(block.asset, /^[0-9a-f]{64}$/);
    }
  }
  // The same export re-imported from its ROOT is one package with every question and image.
  const filesFromZip = async (prefix: string) => {
    const loaded = await JSZip.loadAsync(exported.zip);
    return Promise.all(Object.keys(loaded.files).filter(path => !loaded.files[path].dir).map(async path => {
      const bytes = new Uint8Array(await loaded.file(path)!.async('uint8array'));
      const relative = path.replace(new RegExp(`^${root}/`), '');
      return f(`${prefix}/${relative}`, /\.json$/i.test(path) ? new TextDecoder().decode(bytes) : bytes);
    }));
  };
  const rootFiles = await filesFromZip('package-root');
  const saved: ExamDoc[] = [];
  const result = await importPackageFolder(rootFiles, [], async next => { saved.push(structuredClone(next)); });
  assert.equal(result.imported, 1, 'the multipart root is ONE exam');
  assert.equal(result.notPackage, 0, 'no extra "assets" exam');
  assert.equal(saved[0].questions.length, 71);
  assert.equal(saved[0].source.packageParts?.length, 2);
  assert.equal(saved[0].images.length, 1, 'the shared asset is loaded exactly once');
  assert.ok(saved[0].questions[0].images.length === 1 && saved[0].questions[50].images.length === 1);
  assert.ok(saved[0].questions.every(question => !/img_[0-9a-f]{16,}/i.test(question.stem || '')), 'no student-facing placeholder token');

  // Selecting the parent folder is equivalent and never a partial success.
  const parentFiles = await filesFromZip('parent/package-root');
  const parentSaved: ExamDoc[] = [];
  const parentResult = await importPackageFolder(parentFiles, [], async next => { parentSaved.push(structuredClone(next)); });
  assert.equal(parentResult.imported, 1);
  assert.equal(parentSaved[0].questions.length, 71);

  // A genuinely missing part is reported, never silently imported.
  const missingPart = rootFiles.filter(item => !/(^|\/)part-2\//.test(item.webkitRelativePath || item.name));
  const missingSaved: ExamDoc[] = [];
  const missingResult = await importPackageFolder(missingPart, [], async next => { missingSaved.push(structuredClone(next)); });
  assert.equal(missingResult.imported, 0);
  assert.equal(missingSaved.length, 0);
  assert.match(missingResult.details.join(' '), /missing part 2 of 2|multipart package is incomplete/i);
});

test('#58D an unresolved placeholder stays in metadata and the report, never as a student-facing token', async () => {
  const doc = await importRows('unresolved', [
    { type: 'short_answer', title: 'Question 1', label: '1', stem: 'Look at the picture and describe it. [img_aaaaaaaaaaaaaaaa]', points: 2, grade: '12', subject: 'English' },
  ]);
  doc.images = [{ id: 'img_aaaaaaaaaaaaaaaa', page: 2, bbox: { x: 0, y: 0, w: 1, h: 1 }, mime: 'image/png', sha: 'f'.repeat(64), width: 1, height: 1, blobKey: 'missing' }];
  doc.questions[0].images = [{ imageId: 'img_aaaaaaaaaaaaaaaa', role: 'stem' }];
  const bank = await createQuestionBankExport(doc, { sourceDataset: 'unresolved' });
  const row = bank.batch.questions[0];
  assert.deepEqual(row.missing_assets, ['img_aaaaaaaaaaaaaaaa']);
  assert.deepEqual(row.unresolved_placeholders, [{ asset: 'img_aaaaaaaaaaaaaaaa', sha: 'f'.repeat(64), reason: 'pixels unavailable at export time' }]);
  const studentText = JSON.stringify(row.stem_blocks);
  assert.doesNotMatch(studentText, /missing:/, 'no missing-marker token travels in student content');
  assert.doesNotMatch(studentText, /img_aaaaaaaaaaaaaaaa/, 'the token is never rendered (it lives in metadata only)');
  assert.doesNotMatch(studentText, /\[\s*\]/, 'removing a placeholder leaves no empty brackets');
  assert.equal(row.stem_blocks![0].t === 'text' && row.stem_blocks![0].v, 'Look at the picture and describe it.');
  assert.ok(JSON.stringify(row.unresolved_placeholders).includes('img_aaaaaaaaaaaaaaaa'), 'the reference itself is retained');
  const zip = await JSZip.loadAsync(bank.zip);
  const root = bank.filename.replace(/\.zip$/, '');
  const preserved = JSON.parse(await zip.file(`${root}/preserved/answers.json`)!.async('string'));
  assert.equal(preserved.questions[0].unresolved_placeholders[0].asset, 'img_aaaaaaaaaaaaaaaa');
  const reportText = JSON.stringify(bank.report);
  assert.match(reportText, /unresolved_placeholders/);
  const manifest = JSON.parse(await zip.file(`${root}/assets/manifest.json`)!.async('string'));
  assert.equal(manifest.assets.length, 0, 'no fake asset is shipped');
});

test('#58D picture options never leak base64 and always ship their file with an explicit review state', async () => {
  const base64 = Buffer.from(png).toString('base64');
  const doc = await importQuestionPackage([f('batch.json', JSON.stringify({ batch_id: 'picture-option', questions: [{
    type: 'multiple_choice', title: 'Question 55B', label: '55B', stem: 'Which picture shows the tired pupil?',
    options: [{ key: 'A', text: 'cat' }, { key: 'B', text: `![pupil](data:image/png;base64,${base64})` }], points: 1, grade: '12', subject: 'English',
  }] }))]);
  const bank = await createQuestionBankExport(doc, { sourceDataset: 'picture-option' });
  assert.deepEqual(bank.report.image_options, ['Q55B']);
  assert.ok(bank.batch.questions[0].tags.includes('option_image_unsupported'));
  assert.deepEqual(bank.batch.questions[0].unsupported_option_images, ['2']);
  const zip = await JSZip.loadAsync(bank.zip);
  const text = await zip.file(`${bank.filename.replace(/\.zip$/, '')}/batch.json`)!.async('string');
  assert.doesNotMatch(text, /base64,/i);
  assert.doesNotMatch(text, /data:image\//i);
  const manifest = JSON.parse(await zip.file(`${bank.filename.replace(/\.zip$/, '')}/assets/manifest.json`)!.async('string'));
  assert.equal(manifest.assets.length, 1, 'the picture ships as a file even though the option cannot carry it');
  // No invented stem image.
  assert.equal(bank.batch.questions[0].stem_blocks, undefined);
});

// ───────────────────── E — truthful review, provenance and labels ──────────────────────────
test('#58E a keyless true/false and a keyless descriptive item are never "verified"', async () => {
  const doc = await importRows('truthful', [
    { type: 'true_false', title: 'Question 1', label: '1', stem: 'Water is dry.', points: 1, grade: '12', subject: 'English' },
    { type: 'short_answer', title: 'Question 55A', label: '55A', stem: 'Write one sentence.', points: 2, grade: '12', subject: 'English' },
  ]);
  const attention = computeAttention(doc);
  assert.equal(attentionCount(doc), 2, 'one row per keyless item, even before enrichment');
  assert.ok(attention.some(item => item.kind === 'keyless-auto' && item.plainSentence.startsWith('Q1')));
  assert.ok(attention.some(item => item.kind === 'tashrihi-unconfirmed' && item.plainSentence.startsWith('Q55A')));
  assert.ok(doc.questions.every(question => quietState(doc, question) === 'unchecked'));
  const html = renderToStaticMarkup(React.createElement(Step4ReviewContent, {
    examDoc: doc, settings, onUpdateDoc: () => undefined, onProceedToExamView: () => undefined,
  }));
  assert.match(html, /data-attention-chip="2"/);
  assert.doesNotMatch(html, /\d+ verified/, 'no quiet item is labelled verified when nothing passed');
  assert.equal((html.match(/data-review-question=/g) || []).length, 2, 'both items are in the visible attention list');
});

test('#58E provenance, page/group and labels are preserved — never inferred or fabricated', async () => {
  const doc = await importRows('provenance', [
    { type: 'multiple_choice', title: 'Question 53', label: '53', stem: 'Choose.', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English', provenance: { source_type: 'claimed', source_ref: 'the full prose source reference' } },
    { type: 'short_answer', title: 'Question 17C-a', label: '17C-a', stem: 'Write one sentence.', points: 2, grade: '12', subject: 'English' },
  ]);
  doc.questions[0].imported = { ...doc.questions[0].imported, page: 6, group: 14 };
  const bank = await createQuestionBankExport(doc, { sourceDataset: 'provenance' });
  const row = bank.batch.questions[0];
  assert.equal(row.provenance.source_type, 'claimed');
  assert.equal(row.provenance.source_ref, `batch · p.6 · item 53 · group 14 (1)`);
  assert.equal(bank.batch.questions[1].label, '17C-a');
  // Unknown page/group are omitted rather than invented.
  const unknown: ExamDoc = { ...doc, source: { ...doc.source, fileName: '' }, questions: [{ ...doc.questions[1], imported: {} }] };
  assert.equal(compactBankSourceRef(unknown, unknown.questions[0]).includes('p.'), false);
  // A teacher reference typed in the dialog survives into the compact reference.
  const teacherRef = await createQuestionBankExport(doc, { sourceDataset: 'provenance', sourceRef: 'Konkur 1399 · official booklet p.6' });
  assert.ok(teacherRef.batch.questions[0].provenance.source_ref!.startsWith('Konkur 1399 · official booklet p.6'));
  // Inherited lesson provenance is reported as unconfirmed instead of pretending it survived.
  doc.questions[0].curriculumSource = 'inherited';
  doc.questions[0].curriculumHints = { chapter: '3', lesson: 'Writing', topic: 'letters' };
  const inherited = await createQuestionBankExport(doc, { sourceDataset: 'provenance' });
  assert.equal(inherited.batch.questions[0].curriculum_source, 'inherited');
  assert.ok(inherited.report.contract.pending.some(entry => entry.kind === 'inherited'));
});

// ───────────────────── F — live progress ───────────────────────────────────────────────────
test('#58F the package path reports honest progress and one underlying call per request', async () => {
  const doc = await importRows('progress', [
    { type: 'multiple_choice', title: 'Question 1', label: '1', stem: 'Pick.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English' },
    { type: 'multiple_choice', title: 'Question 2', label: '2', stem: 'Pick again.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English' },
    { type: 'short_answer', title: 'Question 3', label: '3', stem: 'Write one sentence.', points: 2, grade: '12', subject: 'English' },
  ]);
  const events: any[] = [];
  let generativeCalls = 0; let decisionCalls = 0;
  await enrichPackage(doc, settings, {
    onEvent: event => events.push(event),
    explanationCaller: async (request: any) => { generativeCalls++; return generativeCaller(request); },
    decisionCaller: async (body: any) => { decisionCalls++; return baseJudge(body); },
  });
  const calls = events.filter(event => event.kind === 'call');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(event => event.planned! >= event.completed!), 'planned never lags the real count');
  assert.ok(calls.some(event => event.label && event.check));
  assert.equal(events.filter(event => event.kind === 'call').length, decisionCalls, 'one event per real decision request');
  assert.ok(generativeCalls >= 1);
  assert.ok(events.some(event => event.kind === 'phase'), 'phases are reported');
});

test('#58F parent-folder progress shows exam i of N in order and isolates failures', async () => {
  const parent = (folder: string, name: string, data: string | Uint8Array) => f(`batch-parent/${folder}/${name}`, data);
  const files = [
    parent('exam-one', 'batch.json', JSON.stringify({ batch_id: 'one', questions: [{ type: 'multiple_choice', title: 'Question 1', stem: 'Pick.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English' }] })),
    parent('exam-two', 'batch.json', JSON.stringify({ batch_id: 'two', questions: [{ type: 'multiple_choice', title: 'Question 1', stem: 'Pick.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English' }] })),
    parent('exam-broken', 'batch.json', '{not json'),
  ];
  const messages: string[] = [];
  const saved: ExamDoc[] = [];
  const result = await importPackageFolder(files, [], async doc => { saved.push(structuredClone(doc)); }, message => messages.push(message));
  assert.equal(result.imported, 2);
  assert.equal(result.failed, 1);
  assert.ok(messages.some(message => /Exam 1 of 3/.test(message)));
  assert.ok(messages.some(message => /Exam 3 of 3/.test(message)));
  assert.ok(result.details.some(detail => /exam-broken: import failed/.test(detail)));
});

test('#58F streamed output comes from the same single call (no duplicate request)', async () => {
  const doc = await importRows('stream', [{ type: 'multiple_choice', title: 'Question 1', label: '1', stem: 'Pick.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English' }]);
  const frames = [
    'event: delta\ndata: {"text":"{\\"corrections\\":["}\n\n',
    'event: delta\ndata: {"text":"{\\"questionNumber\\":\\"1\\",\\"explanation\\":\\"Because.\\"}]}"}\n\n',
    'event: done\ndata: {"json":{"corrections":[{"questionNumber":"1","explanation":"Because."}]},"rawText":"","usage":{"inputTokens":1,"outputTokens":1}}\n\n',
  ];
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const seen: string[] = [];
    await generatePackageExplanations(doc, settings, { onStream: text => seen.push(text) });
    assert.equal(fetchCalls, 1, 'streaming is the same request, not an extra one');
    assert.ok(seen.length >= 2);
    assert.ok(seen[seen.length - 1].length > seen[0].length, 'live output grows honestly');
    assert.equal(doc.questions[0].explanation?.text, 'Because.');
  } finally { globalThis.fetch = originalFetch; }
});
