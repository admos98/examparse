/** #57 Follow-up — unit/integration acceptance for the closing batch (Parts A–E + field-proxy F). */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { importPackageFolder } from '../src/pipeline/packageBatchImport';
import { enrichPackage } from '../src/pipeline/packageEnrichment';
import { confirmTashrihi, rubricCriteria, judgeState, isTashrihiQuestion } from '../src/pipeline/packageTashrihi';
import { curriculumLessons } from '../src/pipeline/curriculumHints';
import { buildExportDoc } from '../src/utils/examExport';
import { bankProvenance, createQuestionBankExport, type BankBatch } from '../src/utils/questionBankExport';
import { computeAttention, attentionCount, attentionQuestionIds, type AttentionItem } from '../src/utils/attention';
import { IntegrityFlags } from '../src/components/IntegrityFlags';
import { Step4ReviewContent } from '../src/views/Step4Review';
import { DEFAULT_SETTINGS } from '../src/store';
import { file, png, png2 } from './fixtures/package-53';
import type { AppSettings, ExamDoc, Question } from '../src/types';

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  decideMultimodal: true,
  providers: [
    { id: 'read', name: 'writer', kind: 'openai-compatible', baseURL: 'http://localhost:1234', apiKey: '' },
    { id: 'd', name: 'judge', kind: 'openai-compatible', baseURL: 'http://localhost:8080', apiKey: '', decideDialect: 'thx' },
  ],
  roleMapping: { ...DEFAULT_SETTINGS.roleMapping, read: { providerId: 'read', model: 'writer' }, vision: { providerId: 'read', model: 'writer' }, decide: { providerId: 'd', model: 'judge' } },
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const TOKEN = /img_[0-9a-f]{16,}/i;

/** Local generative caller serving BOTH explain-stage passes (labels distinguish them). */
const generativeCaller = async (request: any) => {
  const payload = JSON.parse(request.text);
  if (String(request.label).startsWith('Package tashrihi')) {
    return {
      json: {
        corrections: payload.questions.map((q: any) => ({
          questionNumber: q.label,
          sampleAnswer: `Model sample answer for ${q.label}.`,
          rubric: [
            { criterion: `Addresses the task (${q.label})`, maxPoints: 1 },
            { criterion: 'Clear, complete language', maxPoints: 1 },
          ],
        })),
      },
      rawText: '',
    };
  }
  return { json: { corrections: payload.questions.map((q: any) => ({ questionNumber: q.label, explanation: `Because ${q.label}.` })) }, rawText: '' };
};

const baseJudge = async (body: any) => {
  const name = Object.keys(body.questions)[0];
  if (name.includes('blind-answer')) return { results: [{ name, probability: 0.9, choice: 'A' }] };
  if (name.includes('answer-proposal')) return { results: [{ name, probability: 0.9, choice: 'B' }] };
  if (name.includes('lessons')) {
    const lesson = curriculumLessons('12', 'English')[0]?.title;
    return { results: [{ name, probability: 0.9, choice: lesson, distribution: { [lesson]: 0.9, "not from this textbook's lessons": 0.1 } }] };
  }
  if (name.includes('demand')) return { results: [{ name, probability: 0.8, choice: 'recall' }] };
  if (name.includes('difficulty')) return { results: [{ name, probability: 0.6, choice: '2' }] };
  if (name.includes('reading-mode')) return { results: [{ name, probability: 0.8, choice: 'direct-finding' }] };
  return { results: [{ name, probability: 0.9 }] };
};

// ───────────────────────────── Part A — sample answers + rubrics route through the judge ────
test('#57A tashrihi sample answers and rubrics generate, judge, and route (verified · uncertain · rejected) with teacher-only promotion', async () => {
  const rows = [
    { type: 'short_answer', title: 'Question 1', stem: 'Write a topic sentence about honesty.', points: 2, grade: '12', subject: 'English' },
    { type: 'essay', title: 'Question 2', stem: 'Write a paragraph about the traveller.', points: 4, grade: '12', subject: 'English' },
    { type: 'short_answer', title: 'Question 3', stem: 'Complete the clause.', points: 2, grade: '12', subject: 'English' },
    { type: 'multiple_choice', title: 'Question 4', stem: 'Pick one.', options: [{ key: 'A', text: 'One' }, { key: 'B', text: 'Two' }], answer_key: { correct: ['A'] }, points: 1, grade: '12', subject: 'English' },
  ];
  const imported = await importQuestionPackage([file('batch.json', JSON.stringify({ batch_id: 'tashrihi-route', questions: rows }))]);
  assert.ok(imported.questions.slice(0, 3).every(isTashrihiQuestion));
  assert.equal(imported.questions[3].type, 'mcq');
  const artifactProbability: Record<string, number> = { q_1: 0.9, q_2: 0.5, q_3: 0.1 };
  const out = await enrichPackage(imported, settings, {
    explanationCaller: generativeCaller,
    decisionCaller: async body => {
      const name = Object.keys(body.questions)[0];
      if (name.includes('sample-answer-check') || name.includes('rubric-check')) {
        return { results: [{ name, probability: artifactProbability[name.split(' ')[0]] ?? 0.9 }] };
      }
      if (name.includes('blind-answer')) return { results: [{ name, probability: 0.9, choice: 'A' }] };
      return baseJudge(body);
    },
  });
  // Judge routing: ≥0.80 verified · ≤0.20 rejected · middle uncertain — same clause for both artifacts.
  assert.deepEqual(out.questions.slice(0, 3).map(q => q.sampleAnswer?.judged), ['verified', 'uncertain', 'rejected']);
  assert.deepEqual(out.questions.slice(0, 3).map(q => q.rubric?.judged), ['verified', 'uncertain', 'rejected']);
  // maxPoints sum to the item's points exactly.
  assert.deepEqual(out.questions[0].rubric!.criteria.map(c => c.maxPoints), [1, 1]);
  assert.deepEqual(out.questions[1].rubric!.criteria.map(c => c.maxPoints), [2, 2]);
  for (const question of out.questions.slice(0, 3)) {
    const sum = question.rubric!.criteria.reduce((total, criterion) => total + (criterion.maxPoints ?? 0), 0);
    assert.equal(sum, question.points);
  }
  // Structured export: verified + uncertain travel; rejected is record-only (suppressed).
  const structured = buildExportDoc(out);
  assert.equal(structured.questions[0].sampleAnswer.judged, 'verified');
  assert.equal(structured.questions[1].sampleAnswer.judged, 'uncertain');
  assert.equal(structured.questions[2].sampleAnswer, undefined, 'rejected sample suppressed from the structured export');
  assert.equal(structured.questions[2].rubric, undefined, 'rejected rubric suppressed from the structured export');
  assert.ok(structured.questions.slice(0, 3).every((q: any) => q.tags.includes('needs_rubric')));
  assert.ok(!structured.questions[3].tags.includes('needs_rubric'));
  // Bank export: only verified artifacts; short_answer stays, essay travels as long_answer.
  const bank = await createQuestionBankExport(out, { sourceDataset: 'tashrihi' });
  assert.equal(bank.batch.questions[0].sample_answer?.text, 'Model sample answer for 1.');
  assert.ok(bank.batch.questions[0].rubric);
  assert.equal(bank.batch.questions[1].sample_answer, undefined, 'uncertain sample is structured-only');
  assert.equal(bank.batch.questions[1].rubric, undefined, 'uncertain rubric is structured-only');
  assert.equal(bank.batch.questions[2].sample_answer, undefined, 'rejected sample never exports');
  assert.equal(bank.batch.questions[0].type, 'short_answer');
  assert.equal(bank.batch.questions[1].type, 'long_answer');
  assert.ok(bank.batch.questions.slice(0, 3).every(q => q.tags.includes('needs_rubric')));
  // Teacher confirmation is the ONLY promotion: provenance flips, tag clears, bank follows.
  const confirmed: ExamDoc = { ...out, questions: out.questions.map(q => (q.id === 'q_1' ? confirmTashrihi(q, 'Teacher wording.', [{ criterion: 'Answers the prompt', maxPoints: 1 }, { criterion: 'Well developed', maxPoints: 1 }]) : q)) };
  assert.equal(confirmed.questions[0].sampleAnswer?.source, 'teacher');
  assert.equal(confirmed.questions[0].sampleAnswer?.text, 'Teacher wording.');
  assert.equal(confirmed.questions[0].rubric?.source, 'teacher');
  assert.ok(!confirmed.questions[0].tags?.includes('needs_rubric'));
  const confirmedBank = await createQuestionBankExport(confirmed, { sourceDataset: 'tashrihi' });
  assert.equal(confirmedBank.batch.questions[0].sample_answer?.source, 'teacher');
  assert.ok(!confirmedBank.batch.questions[0].tags.includes('needs_rubric'));
  assert.ok(confirmedBank.batch.questions[1].tags.includes('needs_rubric'), 'unconfirmed model artifacts keep the tag');
  assert.ok(out.source.enrichmentNotes!.some(n => /sample answers & rubrics: 3 of 3/.test(n)));
  assert.ok(out.source.enrichmentNotes!.some(n => /sample & rubric checks: 2 verified · 2 uncertain · 2 rejected/.test(n)));
  // Helper contracts.
  assert.equal(judgeState(0.8), 'verified');
  assert.equal(judgeState(0.2), 'rejected');
  assert.equal(judgeState(0.5), 'uncertain');
  assert.equal(rubricCriteria([{ criterion: 'a', maxPoints: 0 }, { criterion: 'b', maxPoints: 0 }], 3)!.reduce((s, c) => s + (c.maxPoints ?? 0), 0), 3);
});

// ───────────────────────────── Part B — propose-never-execute (B.3 byte assertion) ───────────
test('#57B a checker proposal never touches executable key fields — exports are byte-identical without it', async () => {
  const rows = [
    { type: 'multiple_choice', title: 'Question 1', stem: 'Keyless pick one.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], grade: '12', subject: 'English', points: 1 },
    { type: 'multiple_choice', title: 'Question 2', stem: 'Keyed pick one.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
    { type: 'fill_in_blank', title: 'Question 3', stem: 'Keyless blank.', grade: '12', subject: 'English', points: 1 },
  ];
  const imported = await importQuestionPackage([file('batch.json', JSON.stringify({ batch_id: 'propose', questions: rows }))]);
  const proposalCalls: string[] = [];
  const out = await enrichPackage(imported, settings, {
    explanationCaller: generativeCaller,
    decisionCaller: async body => {
      const name = Object.keys(body.questions)[0];
      if (name.includes('answer-proposal')) { proposalCalls.push(name); return { results: [{ name, probability: 0.9, choice: 'B' }] }; }
      if (name.includes('blind-answer')) return { results: [{ name, probability: 0.9, choice: 'A' }] };
      return baseJudge(body);
    },
  });
  // The proposal exists only in the review payload; every executable field stays keyless.
  const proposed = out.questions[0];
  assert.equal(proposed.answer, undefined);
  assert.equal(proposed.imported?.answer_key, undefined);
  assert.deepEqual(proposed.enrichment?.proposedAnswer, { text: 'B', source: 'model', probability: 0.9 });
  // No proposal call for the option-less fillblank (nothing the checker can name).
  assert.ok(proposalCalls.length === 1 && proposalCalls[0].startsWith('q_1 '));
  // Item stays keyless everywhere downstream and keeps answer_key_needs_review.
  assert.ok(proposed.tags === undefined, 'tags stay derived, not stored');

  const baseline = structuredClone(out);
  delete baseline.questions[0].enrichment!.proposedAnswer;
  const stripRow = (question: any) => { const { enrichment: _enrichment, ...rest } = question; return JSON.stringify(rest); };
  const keyFields = (doc: any) => JSON.stringify(doc.questions.map((q: any) => ({
    id: q.id, answer: q.answer ?? null, answer_key: q.imported?.answer_key ?? null,
    correctFillBlanks: q.imported?.correctFillBlanks ?? null,
  })));

  // B.3 — structured: key fields byte-identical between proposed and un-proposed exports.
  const structured = buildExportDoc(out);
  const structuredBase = buildExportDoc(baseline);
  assert.equal(keyFields(structured), keyFields(structuredBase));
  assert.equal(stripRow(structured.questions[0]), stripRow(structuredBase.questions[0]));
  const { enrichment, ...structuredRest } = structured.questions[0];
  assert.ok(JSON.stringify(enrichment).includes('"proposedAnswer"'), 'proposal lives in the review payload');
  assert.ok(!JSON.stringify(structuredRest).includes('proposedAnswer'), 'no other structured field carries the proposal');
  assert.equal(structured.questions[0].answer, undefined);
  assert.ok(structured.questions[0].tags.includes('answer_key_needs_review'));

  // B.3 — bank: byte-identical executable fields; proposal only in row.enrichment.
  const bank = await createQuestionBankExport(out, { sourceDataset: 'propose' });
  const bankBase = await createQuestionBankExport(baseline, { sourceDataset: 'propose' });
  const row = bank.batch.questions[0];
  const rowBase = bankBase.batch.questions[0];
  assert.equal(row.answer_key, undefined);
  assert.equal(rowBase.answer_key, undefined);
  assert.equal(stripRow(row), stripRow(rowBase));
  assert.ok(JSON.stringify(row.enrichment).includes('"proposedAnswer"'));
  assert.ok(!JSON.stringify({ ...rowBase }).includes('proposedAnswer'));
  assert.ok(bank.report.needs_answer_key.some(entry => entry.question === 'Q1' && /no source answer key/i.test(entry.reason)));
  assert.ok(row.tags.includes('answer_key_needs_review'));

  // Attention says exactly what the teacher can do.
  const attention = computeAttention(out);
  const proposalItem = attention.find(item => item.kind === 'keyless-auto' && item.plainSentence.includes('proposes B'));
  assert.ok(proposalItem, 'the attention list surfaces "checker proposes B — adopt?"');
  assert.match(proposalItem!.plainSentence, /^Q1: checker proposes B — adopt it as the key or enter another\. \[Go\]$/);
  const noProposal = attention.filter(item => item.kind === 'keyless-auto');
  assert.ok(noProposal.some(item => item.plainSentence.includes('Q3 has no answer key')), 'keyless items without a proposal are listed too');
  // Adoption flips provenance to teacher-entered and marks the proposal adopted.
  const adopted: Question = { ...proposed, answer: { text: 'B', source: 'manual' }, enrichment: { ...proposed.enrichment!, proposedAnswer: { ...proposed.enrichment!.proposedAnswer!, adopted: true } } };
  assert.equal(adopted.answer?.source, 'manual');
  assert.equal(adopted.enrichment?.proposedAnswer?.adopted, true);
});

// ───────────────────────────── Part C — images travel (tokens → references + files) ─────────
test('#57C placeholder tokens become real asset references: import attaches, Step 4 renders pixels, bank emits files + manifest', async () => {
  const sha1 = sha256(png);
  const sha2 = sha256(png2);
  const ghost = sha256(new TextEncoder().encode('ghost-image-bytes'));
  const options = [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }];
  const rows = [
    { type: 'multiple_choice', title: 'Question 1', stem_blocks: [{ t: 'text', v: 'Which picture matches? ' }, { t: 'img', asset: sha1 }], options, answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
    { type: 'multiple_choice', title: 'Question 2', stem: `Look at the figure. img_${sha2}stem Then continue with the question.`, options, answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
    { type: 'multiple_choice', title: 'Question 3', stem: `Shared picture: img_${sha1} and a ghost token img_${ghost}stem remain in text.`, options, answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
  ];
  const doc = await importQuestionPackage([
    file('batch.json', JSON.stringify({ batch_id: 'pictures', questions: rows })),
    file(`assets/${sha1}.png`, png),
    file(`assets/${sha2}.png`, png2),
  ]);
  // Import: tokens attach their assets at the right offset and never stay in the stem.
  assert.equal(doc.questions[0].images.length, 1);
  assert.equal(doc.questions[1].images[0]?.imageId, `img_${sha2}`);
  assert.equal(doc.questions[2].images[0]?.imageId, `img_${sha1}`);
  for (const question of doc.questions) assert.ok(!TOKEN.test(question.stem || ''), `no token in ${question.label} stem`);
  assert.ok(doc.questions[1].packageImagePositions?.length === 1);
  assert.ok(doc.questions[2].packageImagePositions?.length === 1);
  const ghostFlag = doc.flags.find(flag => flag.code === 'PACKAGE_IMAGE_TOKEN_UNRESOLVED');
  assert.ok(ghostFlag && ghostFlag.questionId === 'q_3', 'a token with no asset file is an explicit warning');
  assert.ok(!TOKEN.test(ghostFlag!.message), 'even the flag text carries only a truncated digest');

  // Step 4 renders the ACTUAL image, never the token (expanded cards via the all filter).
  const html = renderToStaticMarkup(React.createElement(Step4ReviewContent, {
    examDoc: doc, settings, onUpdateDoc: () => undefined, onProceedToExamView: () => undefined,
    initialFilterType: 'all', initialExpandedSectionIds: doc.sections.map(section => section.id),
  }));
  assert.ok(!TOKEN.test(html), 'Step 4 rendered text never contains a placeholder token');
  assert.ok(html.includes('<img'), 'Step 4 renders the actual image');

  // Bank export: files named by sha256, one shared pool entry, complete manifest, truthful counts.
  const bank = await createQuestionBankExport(doc, { sourceDataset: 'pictures' }, async image => new Blob([image.sha === sha1 ? png : png2]));
  assert.equal(bank.report.images_placed, 2, 'two distinct files emitted');
  assert.equal(bank.report.image_references, 4, 'three assigned assets plus one unresolved reference are reported');
  assert.equal(bank.report.asset_count, 2);
  const refs = bank.batch.questions.flatMap(q => (q.stem_blocks || []).filter((block): block is { t: 'img'; asset: string } => block.t === 'img').map(block => block.asset));
  assert.deepEqual(refs, [sha1, sha2, sha1], 'shared asset referenced by both owners, emitted once');
  const zip = await JSZip.loadAsync(bank.zip);
  const root = bank.filename.replace(/\.zip$/, '');
  const batchRows = JSON.parse(await zip.file(`${root}/batch.json`)!.async('string')).questions;
  assert.ok(batchRows.every((row: any) => !TOKEN.test(JSON.stringify(row.stem_blocks || []))), 'no placeholder tokens in student-facing stems');
  const batchText = JSON.stringify(batchRows);
  assert.ok(!/assets\/[0-9a-f]{16,}/i.test(batchText), 'stems carry references, not file paths');
  // (c) every picture-referencing question carries its asset file in the same zip.
  for (const ref of new Set(refs)) {
    const entry = zip.file(`${root}/assets/${ref}.png`);
    assert.ok(entry, `asset file for ${ref.slice(0, 12)}… exists`);
    assert.equal(sha256(new Uint8Array(await entry!.async('uint8array'))), ref);
  }
  const manifest = JSON.parse(await zip.file(`${root}/assets/manifest.json`)!.async('string'));
  assert.equal(manifest.format, 'examparse.assets');
  assert.deepEqual(manifest.assets.map((asset: any) => asset.sha256).sort(), [sha1, sha2].sort());
  for (const asset of manifest.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(zip.file(`${root}/${asset.path}`), 'manifest file resolves inside the zip');
    assert.ok(asset.references.length >= 1);
    assert.match(asset.mime, /^image\//);
  }
});

// ───────────────────────────── Part D — attention-first screen: one set, labels, grouping ────
test('#57D header count == visible attention list; labels identify every row; quiet collapses to one searchable line', async () => {
  const rows = [
    { type: 'multiple_choice', title: 'Question 17C-a', stem: 'Keyless pick the correct option here.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], grade: '12', subject: 'English', points: 1 },
    { type: 'short_answer', title: 'Question 55B', stem: 'Write a sentence about honesty.', points: 2, grade: '12', subject: 'English' },
    { type: 'multiple_choice', title: 'Question 12', stem: 'Pick the right word.', options: [{ key: 'A', text: 'cat' }, { key: 'B', text: 'dog' }], answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
    { type: 'multiple_choice', title: 'Question 40', stem: 'Another keyed one.', options: [{ key: 'A', text: 'up' }, { key: 'B', text: 'down' }], answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
  ];
  const imported = await importQuestionPackage([file('batch.json', JSON.stringify({ batch_id: 'attention-screen', questions: rows }))]);
  const out = await enrichPackage(imported, settings, {
    explanationCaller: generativeCaller,
    decisionCaller: async body => {
      const name = Object.keys(body.questions)[0];
      if (name === 'q_1 answer-proposal') return { results: [{ name, probability: 0.9, choice: 'B' }] };
      if (name.includes('sample-answer-check') || name.includes('rubric-check')) return { results: [{ name, probability: 0.9 }] };
      if (name.includes('explanation-check')) return { results: [{ name, probability: name.startsWith('q_3 ') ? 0.1 : 0.9 }] };
      if (name.includes('blind-answer')) return { results: [{ name, probability: name.startsWith('q_3 ') ? 0.4 : 0.9, choice: 'A' }] };
      return baseJudge(body);
    },
  });
  const items = computeAttention(out);
  // The four expected states, each exactly once: proposal, tashrihi, uncertain, rejected explanation.
  assert.deepEqual([...new Set(items.map(item => item.kind))].sort(), ['answer-uncertain', 'keyless-auto', 'tashrihi-unconfirmed']);
  assert.equal(items.length, 3);
  assert.ok((items.find(item => item.kind === 'answer-uncertain')?.reasons?.length ?? 0) >= 2, 'all issues for one question are grouped');
  // Identity is the label everywhere — never the bare number.
  for (const item of items) {
    for (const questionId of item.questionIds) {
      const question = out.questions.find(q => q.id === questionId)!;
      assert.ok(item.plainSentence.startsWith(`Q${question.label}`), `"${item.plainSentence}" leads with label ${question.label}`);
    }
    assert.match(item.plainSentence, /\[(Go|Confirm|Fix|Open|Solve)\]$/);
  }
  assert.ok(items.some(item => item.plainSentence.startsWith('Q17C-a:')));
  assert.ok(items.some(item => item.plainSentence.startsWith('Q55B:')));
  // Grouped by what's needed: stable KIND_PRIORITY order.
  const priority = ['answer-conflict', 'audit-catch', 'answer-uncertain', 'keyless-auto', 'tashrihi-unconfirmed', 'image-suspect', 'image-unplaced', 'explanation-rejected', 'answer-missing', 'stem-hollow', 'options-missing', 'points-unresolved', 'metadata-missing', 'read-failed', 'loop-verdict', 'loop-note'];
  const ranks = items.map(item => priority.indexOf(item.kind));
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'rows are grouped by kind');

  // ONE number on every surface: panel, header chip, filter button, visible set.
  assert.equal(attentionCount(out), 3);
  const panelHtml = renderToStaticMarkup(React.createElement(IntegrityFlags, { doc: out }));
  assert.match(panelHtml, /data-attention-count="3"/);
  assert.equal((panelHtml.match(/data-attention-kind=/g) || []).length, 3, 'one visible item per actionable question');
  const step4Html = renderToStaticMarkup(React.createElement(Step4ReviewContent, {
    examDoc: out, settings, onUpdateDoc: () => undefined, onProceedToExamView: () => undefined,
  }));
  assert.match(step4Html, /data-attention-chip="3"/);
  assert.match(step4Html, />Needs attention \(3\)</);
  const visibleIds = [...step4Html.matchAll(/data-review-question="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(visibleIds.sort(), out.questions.filter(q => ['q_1', 'q_2', 'q_3'].includes(q.id)).map(q => q.id).sort());
  assert.ok(!visibleIds.includes(out.questions[3].id), 'the quiet item is not in the attention list');
  // Verified/quiet collapse into exactly one summary line, expandable + searchable.
  assert.match(step4Html, /1 verified · show/);
  assert.ok((step4Html.match(/data-quiet-summary=/g) || []).length === 1);
  // Header count and the visible set are the same membership (roots of items vs rendered cards).
  const rootIds = new Set(attentionQuestionIds(out));
  assert.deepEqual([...visibleIds].sort(), [...rootIds].sort());
  // Completeness never leaks into confidence: precedence is verification → demand → null.
  assert.equal(out.questions[0].confidence, 0.8, 'keyless proposal items keep null-ish confidence from votes');
  assert.equal(out.questions[0].enrichment?.completeness?.probability, 0.9);
  assert.equal(out.questions[2].confidence, 0.4, 'verification probability wins over completeness');
});

// ───────────────────────────── Part E — passage inheritance + compressed provenance ─────────
test('#57E abstained members inherit the confident passage lesson (marked, non-overriding) and bank refs compress to ≤200 chars', async () => {
  const lessons = curriculumLessons('12', 'English');
  assert.ok(lessons.length >= 2, 'grade 12 English curriculum exists');
  const passage = 'A traveller walked through the forest and met a friendly guide who told him about the old bridge. '.repeat(3).trim();
  const rows = [1, 2, 3].map(n => ({
    type: 'multiple_choice', title: `Question ${n}`, stem: `${passage}\n\nQuestion ${n}: What did the guide say?`,
    options: [{ key: 'A', text: 'bridge' }, { key: 'B', text: 'river' }], answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1,
    provenance: { source_type: 'claimed', source_ref: 'the full prose source reference stays structured-only' },
  }));
  const imported = await importQuestionPackage([file('batch.json', JSON.stringify({ batch_id: 'inherit', questions: rows }))]);
  assert.ok(imported.questions[0].passageId, 'passage factored once for the run');
  imported.questions[2].enrichment = { source: 'model', verification: 'unjudged', teacherLesson: { lesson: lessons[1].title, source: 'teacher' } };
  const out = await enrichPackage(imported, settings, {
    decisionCaller: async body => {
      const name = Object.keys(body.questions)[0];
      if (name === 'q_1 lessons') return { results: [{ name, probability: 0.7, choice: lessons[1].title, distribution: { [lessons[1].title]: 0.7, [lessons[0].title]: 0.1, "not from this textbook's lessons": 0.2 } }] };
      if (name === 'q_2 lessons') return { results: [{ name, probability: 0.45, choice: "not from this textbook's lessons", distribution: { [lessons[0].title]: 0.3, [lessons[1].title]: 0.25, "not from this textbook's lessons": 0.45 } }] };
      if (name.includes('passage-lessons')) return { results: [{ name, probability: 0.8, choice: lessons[0].title, distribution: { [lessons[0].title]: 0.8, [lessons[1].title]: 0.1, "not from this textbook's lessons": 0.1 } }] };
      if (name.includes('blind-answer')) return { results: [{ name, probability: 0.9, choice: 'A' }] };
      return baseJudge(body);
    },
  });
  // Confident individual vote wins: never overridden by the passage.
  assert.equal(out.questions[0].curriculumHints?.lesson, lessons[1].title);
  assert.equal(out.questions[0].curriculumSource, 'decision');
  // Teacher lesson always wins.
  assert.equal(out.questions[2].curriculumHints?.lesson, lessons[1].title);
  assert.notEqual(out.questions[2].curriculumSource, 'inherited');
  // Abstained member inherits the confident passage lesson, honestly marked.
  assert.equal(out.questions[1].curriculumSource, 'inherited');
  assert.equal(out.questions[1].curriculumHints?.lesson, lessons[0].title);

  // Compressed bank provenance: <file>[ · p.<page>][ · item <label>][ · group <n> (<total>)], ≤200.
  // #58 — unknown page/group are OMITTED, never replaced with a fabricated p.1/section index.
  const longName = `a-rather-long-exam-filename-${'x'.repeat(300)}.pdf`;
  const doc: ExamDoc = { ...out, source: { ...out.source, fileName: longName } };
  const bank = await createQuestionBankExport(doc, { sourceDataset: 'inherit' });
  for (const row of bank.batch.questions) {
    const ref = row.provenance.source_ref!;
    assert.ok(ref.length <= 200, `source_ref ≤200 chars (${ref.length})`);
    assert.match(ref, / · item \S+$/);
    assert.doesNotMatch(ref, / · p\.1(?: ·|$)/, 'no invented page');
  }
  assert.ok(bank.batch.questions[0].provenance.source_ref!.startsWith('a-rather-long-exam-filename-'));
  assert.ok(bank.batch.questions[0].provenance.source_ref!.length <= 200);
  // source_type values are NOT remapped: claimed stays claimed (structured), bank stays authored.
  const structured = buildExportDoc(doc);
  assert.equal(structured.questions[0].imported.provenance.source_type, 'claimed');
  assert.match(structured.questions[0].imported.provenance.source_ref, /full prose source reference/);
  // #58 — a claimed source stays claimed; the bank remap is explicit opt-in only.
  assert.equal(bankProvenance(doc).source_type, 'claimed');
  assert.equal(bank.batch.questions[0].provenance.source_type, 'claimed');
  assert.equal(bankProvenance(doc, undefined, { remapClaimedTo: 'authored' }).source_type, 'authored');
  assert.equal((await createQuestionBankExport(doc, { sourceDataset: 'inherit', remapClaimedTo: 'authored' })).batch.questions[0].provenance.source_type, 'authored');
  // The prose ref never rides the bank rows.
  assert.ok(!bank.batch.questions.some(row => /full prose source reference/.test(row.provenance.source_ref || '')));
});

// ───────────────────────────── Part F — field-proxy: unattended batch → chain-enrich ────────
/** Downstream adapter stand-in: structural problems vs expected-state notes (keyless / rubric). */
function validateImportBatch(batch: BankBatch): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const allowedTypes = new Set(['multiple_choice', 'true_false', 'short_answer', 'long_answer', 'fill_in_blank', 'matching', 'ordering']);
  batch.questions.forEach((question, index) => {
    const label = question.label || String(index + 1);
    if (!allowedTypes.has(question.type)) problems.push(`${label}: unknown type ${question.type}`);
    if ((question.stem === undefined) === (question.stem_blocks === undefined)) problems.push(`${label}: exactly one of stem / stem_blocks`);
    if (question.answer_key) {
      if (question.answer_key.grading !== 'auto' || !question.answer_key.correct.every(key => /^[1-9]\d*$/.test(key))) problems.push(`${label}: malformed answer_key`);
    } else if (['multiple_choice', 'true_false', 'fill_in_blank', 'matching'].includes(question.type)) {
      notes.push(`${label}: expected-state keyless (needs answer key)`);
    }
    if (question.provenance.source_type === 'official_cited' && !question.provenance.source_ref) problems.push(`${label}: official without source_ref`);
    if (question.provenance.source_ref && question.provenance.source_ref.length > 200) problems.push(`${label}: source_ref over 200 chars`);
    if (question.tags.includes('needs_rubric')) notes.push(`${label}: expected-state tashrihi (needs_rubric)`);
    if (question.sample_answer && typeof question.sample_answer.text !== 'string') problems.push(`${label}: malformed sample_answer`);
    if (question.rubric && (question.rubric.criteria.length < 2 || question.rubric.criteria.length > 4 || question.rubric.criteria.some(c => !((c.maxPoints ?? 0) > 0)))) problems.push(`${label}: malformed rubric`);
    if (/"judged":"rejected"/.test(JSON.stringify(question))) problems.push(`${label}: rejected artifact leaked into the bank export`);
    for (const block of question.stem_blocks || []) if (block.t === 'text' && TOKEN.test(block.v)) problems.push(`${label}: placeholder token in stem text`);
  });
  return { problems, notes };
}

test('#57F field-proxy: unattended parent-folder batch import → chain-enrich passes the Appendix-A adapter with expected-state notes only', async () => {
  const sha = sha256(png);
  const keyless = { options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], grade: '12', subject: 'English' };
  const pictureRows = [
    { type: 'multiple_choice', title: 'Question 17C-a', stem_blocks: [{ t: 'text', v: 'Which picture matches? ' }, { t: 'img', asset: sha }], ...keyless, points: 1 },
    { type: 'multiple_choice', title: 'Question 2', stem: 'Keyless without a proposal source? No — keyed.', options: keyless.options, answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
    { type: 'short_answer', title: 'Question 3', stem: 'Write a paragraph about the town.', points: 3, grade: '12', subject: 'English' },
    { type: 'short_answer', title: 'Question 4', stem: 'Write one sentence.', points: 2, grade: '12', subject: 'English' },
  ];
  const plainRows = [
    { type: 'multiple_choice', title: 'Question 1', stem: 'First unseen exam pick.', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], answer_key: { correct: ['A'] }, grade: '12', subject: 'English', points: 1 },
    { type: 'multiple_choice', title: 'Question 2', stem: 'First unseen exam keyless.', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], grade: '12', subject: 'English', points: 1 },
    { type: 'fill_in_blank', title: 'Question 3', stem: 'A keyless blank.', grade: '12', subject: 'English', points: 1 },
  ];
  const parent = (folder: string, name: string, bytes: Uint8Array | string) => {
    const base = file(name, bytes);
    return { ...base, webkitRelativePath: `field-parent/${folder}/${name}` };
  };
  const files = [
    parent('unseen-pictures', 'batch.json', JSON.stringify({ batch_id: 'unseen-pictures', questions: pictureRows })),
    parent('unseen-pictures', `assets/${sha}.png`, png),
    parent('unseen-plain', 'batch.json', JSON.stringify({ batch_id: 'unseen-plain', questions: plainRows })),
  ];
  const stored: ExamDoc[] = [];
  const progress: string[] = [];
  const result = await importPackageFolder(
    files,
    [],
    async doc => { stored.push(structuredClone(doc)); },
    message => progress.push(message),
    async (doc, notify) => {
      notify('chain-enrich');
      return enrichPackage(doc, settings, { explanationCaller: generativeCaller, decisionCaller: baseJudge });
    },
  );
  assert.equal(result.imported, 2);
  assert.equal(result.failed, 0);
  assert.ok(result.details.every(detail => /enrichment (?:✓|partial)/.test(detail)), result.details.join(' | '));
  assert.ok(progress.some(message => /chain-enrich/.test(message)));
  // Stage 1 saves the import draft; stage 2 re-saves the enriched doc — assert the final state.
  const enrichedDocs = stored.filter(doc => doc.source.enrichmentStatus === 'completed' || doc.source.enrichmentStatus === 'partial');
  assert.equal(enrichedDocs.length, 2, 'both imported exams finished chain-enrichment unattended, with honest partial states if a check abstained');

  for (const doc of enrichedDocs) {
    // (a) zero wrong-evidence verdicts — scripted sound answers spot-check clean.
    for (const question of doc.questions) {
      if (question.imported?.answer_key?.correct?.length === 1) {
        assert.equal(question.enrichment?.verification, 'verified', `${question.label} scripted verdict is sound`);
        assert.ok(question.enrichment?.imagePlacement?.every(placement => placement.state !== 'disagreed') ?? true);
      }
    }
    assert.ok(!doc.flags.some(flag => flag.code === 'PACKAGE_ENRICHMENT'), 'no disagreement/incompleteness flags fired');
    // (b) the attention screen fits one readable list with actionable rows.
    const items = computeAttention(doc);
    const panelHtml = renderToStaticMarkup(React.createElement(IntegrityFlags, { doc }));
    assert.equal((panelHtml.match(/data-attention-kind=/g) || []).length, items.length, 'one actionable row per question, with nested reasons');
    assert.ok(items.length > 0 && items.length <= 12, `attention stays scannable (${items.length} rows)`);
    for (const item of items) assert.match(item.plainSentence, /\[(Go|Confirm|Fix|Open|Solve)\]$/);
    // (c) every bank question that references a picture carries its asset file.
    const bank = await createQuestionBankExport(doc, { sourceDataset: doc.source.packageBatchId || 'field' }, async image => new Blob([image.sha === sha ? png : png2]));
    const zip = await JSZip.loadAsync(bank.zip);
    const root = bank.filename.replace(/\.zip$/, '');
    for (const question of bank.batch.questions) {
      for (const block of (question.stem_blocks || []).filter(candidate => candidate.t === 'img')) {
        if (block.t !== 'img' || block.asset.startsWith('missing:')) continue;
        assert.match(block.asset, /^[0-9a-f]{64}$/);
        const entry = zip.file(`${root}/assets/${block.asset}.png`);
        assert.ok(entry, `${question.label} references a picture that ships in the zip`);
        assert.equal(sha256(new Uint8Array(await entry!.async('uint8array'))), block.asset);
      }
    }
    if (doc.source.packageBatchId === 'unseen-pictures') {
      assert.equal(bank.report.images_placed, 1);
      assert.equal(bank.report.image_references, 1);
      const stemText = bank.batch.questions
        .flatMap(question => [...(question.stem ? [question.stem] : []), ...(question.stem_blocks || []).filter(block => block.t === 'text').map(block => (block as { t: 'text'; v: string }).v)])
        .join('\n');
      assert.ok(!TOKEN.test(stemText), 'zero placeholder tokens in any exported stem');
    }
    // (d) downstream adapter: structural clean, only expected-state notes.
    const { problems, notes } = validateImportBatch(bank.batch);
    assert.deepEqual(problems, []);
    assert.ok(notes.every(note => /expected-state/.test(note)), notes.join(' | '));
    if (doc.source.packageBatchId === 'unseen-plain') {
      assert.ok(notes.some(note => note.startsWith('2: expected-state keyless')), 'keyless MCQ noted as expected state');
      assert.ok(notes.some(note => note.startsWith('3: expected-state keyless')), 'keyless fillblank noted as expected state');
      const proposed = bank.batch.questions.find(question => question.label === '2')!;
      assert.equal(proposed.answer_key, undefined, 'the proposal never becomes a key');
      assert.equal(proposed.enrichment?.proposedAnswer?.text, 'B', 'the proposal lives only in the review payload');
      assert.ok(proposed.tags.includes('answer_key_needs_review'));
    }
    if (doc.source.packageBatchId === 'unseen-pictures') {
      assert.ok(notes.some(note => note.startsWith('3: expected-state tashrihi (needs_rubric)')), 'keyless tashrihi exported with sample+rubric and needs_rubric');
      const tashrihi = bank.batch.questions.find(question => question.label === '3')!;
      assert.equal(tashrihi.sample_answer?.text, 'Model sample answer for 3.');
      assert.equal(tashrihi.rubric!.criteria.reduce((sum, criterion) => sum + (criterion.maxPoints ?? 0), 0), 3);
      const keylessRow = bank.batch.questions.find(question => question.label === '17C-a')!;
      assert.equal(keylessRow.answer_key, undefined, 'keyless stays keyless downstream');
      // #58 — the picture travelled with the item, so the checker may propose; the proposal still
      // never becomes an executable key.
      assert.equal(keylessRow.enrichment?.proposedAnswer?.text, 'B');
      assert.equal(keylessRow.correctFillBlanks, undefined);
      assert.ok(keylessRow.tags.includes('answer_key_needs_review'));
    }
    assert.ok(doc.source.enrichmentNotes!.some(note => /^explanations: \d+ of \d+ keyed questions/.test(note)), 'outcome-first notes lead with final state');
    assert.ok(!doc.source.enrichmentNotes!.some(note => /^Explanation generation (returned|omitted|failed)/.test(note)), 'no per-section intermediate narration survives a complete run');
  }
});
