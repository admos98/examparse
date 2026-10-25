import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assembleAndValidateQuestions, assembleAndValidateSections } from '../src/pipeline/assemble';
import { answerTextForSpans, extendIncompleteAnswer } from '../src/pipeline/answerKey';
import { prepareReviewDocument, reconcileFinalFlags, repairImageReferences } from '../src/pipeline/reviewIntegrity';
import { canonicalizeForms } from '../src/pipeline/forms';
import { distributeGroupImages } from '../src/pipeline/groupImages';
import { getExamHealth, normalizeForMatching } from '../src/pipeline/quality';
import { triageFlags } from '../src/utils/flagPresentation';
import { IntegrityFlags } from '../src/components/IntegrityFlags';
import { runTextRepairStage } from '../src/pipeline/textRepair';
import type { ExamDoc, Flag, ImageAsset, Question, SourceLine } from '../src/types';

const line = (n: number, text: string, page = 1): SourceLine => ({ id: `L${String(n).padStart(4, '0')}`, text, page });
const q = (no: number, parentId?: string): Question => ({ id: `q${no}`, no, label: String(no), parentId, sectionId: 's1', spans: [[no, no]], stem: `${no}. Text`, type: 'unknown', points: 0, confidence: 1, images: [] });
const image = (id: string, page = 1, y = 0): ImageAsset => ({ id, page, bbox: { x: 0, y, w: 20, h: 20 }, width: 20, height: 20, mime: 'image/png', sha: id, blobKey: `blob_${id}` });
const doc = (questions: Question[] = [q(1)]): ExamDoc => ({ id: 'exam', fileHash: 'hash', createdAt: '', displayName: 'Test', nameSource: 'ai', meta: { title: 'Test', language: 'en', direction: 'ltr', totalPoints: 48 }, source: { lines: [], pages: 1, ocrUsed: false, fileName: 'fixture.txt', expectedQuestionNos: questions.map(q => q.no) }, questions, sections: [], images: [], flags: [], usage: [] } as ExamDoc);
const flag = (code: string, severity: Flag['severity'], questionId?: string): Flag => ({ id: code, code, severity, questionId, message: `${code} detail` });

test('T1: Q14 trailing mark furniture is removed; instruction-only Q50 is empty and suspect', () => {
  const lines = [line(1, '14. Question'), line(2, '50. Question'), line(3, '14. games\n۲ نمره (./۵) صحیح پاسخ هر…'), line(4, 'همکار محترم در این بخش ( سوال 50 ) با توجه به رعایت Topic Sentence نمره لحاظ گردد .')];
  const result = assembleAndValidateQuestions([
    { ...q(14), spans: [[1, 1]], answer: { spans: [[3, 3]] } },
    { ...q(50), spans: [[2, 2]], answer: { spans: [[4, 4]] } },
  ], lines, undefined, { keyTerritoryLineNos: [3, 4], gapCompletion: false });
  assert.equal(result.questions.find(q => q.no === 14)?.answer?.text, 'games');
  assert.equal(result.questions.find(q => q.no === 50)?.answer, undefined);
  assert.ok(result.flags.some(f => f.code === 'ANSWER_ANCHOR_SUSPECT' && f.questionId === 'q50'));
  assert.ok(result.questions.every(q => !normalizeForMatching(q.answer?.text || '').includes('نمره')));
});

test('T1: extensions stop at item, mark parenthetical, or section; instructions cannot extend', () => {
  for (const barrier of ['15. other answer', '(./۵) نمره', 'Writing', 'هر پاسخ صحیح ./۵ نمره']) {
    const lines = [line(1, '14. He lives in'), line(2, barrier), line(3, 'the next item.')];
    const spans = [{ line: 1, start: 4, end: lines[0].text.length }];
    const result = extendIncompleteAnswer(spans, lines, new Set([1, 2, 3]));
    assert.equal(result.extended, false, barrier);
    assert.deepEqual(result.spans, spans);
  }
  const lines = [line(1, 'Read the passage and'), line(2, 'answer every question.')];
  assert.equal(extendIncompleteAnswer([[1, 1]], lines, new Set([1, 2])).extended, false);
  assert.equal(answerTextForSpans([[1, 1]], [line(1, '(./۵) نمره')]), '');
  assert.equal(answerTextForSpans([[1, 1]], [line(1, '(42)')]), '(42)', 'a numeric answer is not automatically mark furniture');
});

test('A2: repaired key section marks handle reversed and ordinary RTL parentheticals without leaking across headers', () => {
  const lines = [line(1, '25. Q'), line(2, '26. Q'), line(3, '27. Q'),
    line(4, 'هر پاسخ صحیح ) ۵ (./ نمره'), line(5, '25. B 26. C'), line(6, 'Writing'), line(7, '27. A')];
  const result = assembleAndValidateQuestions([q(25), q(26), q(27)].map((item, i) => ({ ...item, spans: [[i + 1, i + 1]] })), lines, 2, { keyTerritoryLineNos: [4, 5, 6, 7], gapCompletion: false });
  assert.equal(result.questions.find(q => q.no === 25)?.points, 0.5);
  assert.equal(result.questions.find(q => q.no === 26)?.points, 0.5);
  assert.equal(result.questions.find(q => q.no === 27)?.points, 1);
  const corpus: SourceLine[] = JSON.parse(fs.readFileSync('test/fixtures/corpus/english-final-13991009pq89w65173/source-lines.json', 'utf8'));
  assert.match(normalizeForMatching(corpus.find(line => line.id === 'L0258')!.text), /هر پاسخ صحیح.*5.*نمره/);
});

test('A2: inline (./۵) and standalone 1 نمره statements are per-item evidence', () => {
  const lines = [line(1, '1. Q'), line(2, '2. Q'), line(3, '1. A (./۵) نمره'), line(4, '1 نمره'), line(5, '2. B')];
  const result = assembleAndValidateQuestions([q(1), q(2)], lines, 1.5, { keyTerritoryLineNos: [3, 4, 5], gapCompletion: false });
  assert.deepEqual(result.questions.map(q => q.points), [0.5, 1]);
});

test('A3: lettered Writing topics force the grouped Q63 parent to long', () => {
  const parent = { ...q(63), stem: 'Write about these topics: a) Ferdowsi', type: 'matching' as const };
  const children = [64, 65, 66].map((no, index) => ({ ...q(no, parent.id), stem: `${String.fromCharCode(98 + index)}) A topic` }));
  const result = canonicalizeForms({ questions: [parent, ...children], sourceLines: [], sections: [{ id: 's1', index: 1, title: 'Writing', spans: [] }] });
  assert.equal(result.questions.find(q => q.id === parent.id)?.type, 'long');
  assert.ok(result.questions[0].receipt?.ruleChain.includes('form:writing-topics'));
});

test('A4: completed text repair has no disabled skippedReason', async () => {
  const result = await runTextRepairStage({ enabled: true, lines: [{ ...line(1, 'متن‌ مشکوک برای اصلاح'), garbled: true }], caller: async () => ({ json: { r: [] } }), provider: 'fixture', model: 'fixture' });
  assert.equal(result.stats.calls, 1);
  assert.match(result.stats.status, /^completed/);
  assert.equal(result.stats.skippedReason, undefined);
});

test('T3: the Step4 data seam restores unplaced assets and drops truly absent images with flags', async () => {
  const input = doc(); input.images = [image('img_001'), image('absent')];
  const reads: string[] = [];
  const result = await prepareReviewDocument(input, async key => { reads.push(key); return key === 'blob_img_001' ? new Blob(['png'], { type: 'image/png' }) : undefined; }, () => 'data:image/png;base64,cG5n');
  assert.deepEqual(reads.sort(), ['blob_absent', 'blob_img_001']);
  const tray = getExamHealth(result).unplacedImages;
  assert.equal(tray.length, 1); assert.match(tray[0].dataUrl!, /^data:image/);
  assert.ok(result.flags.some(f => f.code === 'IMAGE_ASSET_ABSENT'));
  assert.equal(input.images.length, 2, 'pure; no mutation of incoming draft');
  await assert.rejects(prepareReviewDocument(input, async () => { throw new Error('storage offline'); }));
});

test('T3: dangling references remap via blob identity or page+anchor; otherwise drop with flag', () => {
  const input = doc(); input.images = [{ ...image('new'), anchorLine: 10 }];
  input.source.lines = [line(10, '1. Question', 1)];
  input.questions[0].images = [{ imageId: 'old', role: 'stem', anchorLine: 10 }, { imageId: 'lost', role: 'stem' }];
  const repaired = repairImageReferences(input);
  assert.deepEqual(repaired.questions[0].images.map(ref => ref.imageId), ['new']);
  assert.ok(repaired.flags.some(f => f.code === 'IMAGE_REF_DROPPED'));
  const previous = [{ ...image('old'), blobKey: input.images[0].blobKey }];
  assert.equal(repairImageReferences(input, previous).questions[0].images[0].imageId, 'new');
});

test('T3: two parent images plus one same-page unplaced asset fill all three children; other pages never borrowed', () => {
  const parent = q(15); parent.images = [{ imageId: 'a', role: 'stem' }, { imageId: 'b', role: 'stem' }];
  const children = [16, 17, 18].map(no => q(no, parent.id));
  const result = distributeGroupImages([parent, ...children], [image('a', 2, 10), image('b', 2, 30), image('c', 2, 50), image('wrong', 3, 0)]);
  assert.deepEqual(result.questions.filter(q => q.parentId).map(q => q.images[0]?.imageId), ['a', 'b', 'c']);
  assert.equal(result.flags.length, 3);
  const missing = distributeGroupImages([parent, ...children], [image('a', 2), image('b', 2), image('wrong', 3)]);
  assert.ok(missing.flags.some(f => f.code === 'GROUP_IMAGE_DISTRIBUTION_UNASSIGNED' && f.questionId === 'q18'));
});

test('T4: screenshot stale 56-point mismatch cannot survive final 48/48; parent+children are not duplicates', () => {
  const parent = { ...q(63), points: 48 }; const child = { ...q(64, 'q63'), no: 63, stem: 'a) Topic' };
  const input = doc([parent, child]); input.flags = [{ ...flag('POINTS_MISMATCH', 'warn'), message: 'Points total 56 does not match 48.' }, { ...flag('POINTS_DERIVED', 'info'), message: 'Derived total 56.' }];
  const result = reconcileFinalFlags(input);
  assert.ok(!result.flags.some(f => f.code === 'POINTS_MISMATCH' || f.message.includes('56')));
  assert.ok(result.flags.some(f => f.code === 'POINTS_DERIVED' && f.message.includes('48')));
  assert.deepEqual(getExamHealth(result).duplicates, []);
  result.questions.push({ ...q(99), no: 63, stem: '63. Unrelated question' });
  assert.deepEqual(getExamHealth(result).duplicates, [63]);
  assert.deepEqual(reconcileFinalFlags(result).flags, reconcileFinalFlags(reconcileFinalFlags(result)).flags);
});

test('T4: triage is presentation-only; repair groups have counts and are collapsed; raw total is absent', () => {
  const input = doc(); input.flags = [flag('OPTIONS_MISSING', 'warn', 'q1'), flag('STEM_HOLLOW', 'error', 'q1'), flag('TEXT_REPAIR_REJECTED', 'warn'), ...Array.from({ length: 11 }, (_, index) => ({ ...flag('WATERMARK_STRIPPED', 'info', 'q1'), id: `watermark_${index}` }))];
  const triage = triageFlags(input.flags);
  assert.equal(triage.attention.length, 2);
  assert.ok(triage.attention.every(f => f.severity === 'error' || f.severity === 'warn'));
  assert.equal(triage.repairs.get('WATERMARK_STRIPPED')?.length, 11);
  assert.equal(triage.technical.length, 1);
  const html = renderToStaticMarkup(React.createElement(IntegrityFlags, { doc: input }));
  assert.match(html, /2 things need attention/); assert.match(html, /Watermark stripped ×11/);
  assert.match(html, /<details><summary[^>]*>WHAT THE APP ALREADY FIXED/);
  assert.match(html, /<details><summary[^>]*>TECHNICAL LOG/);
  assert.doesNotMatch(html, /<details open|Integrity Flags \(14\)/);
  // Part C (#36): the row is a plain sentence ending in the user's action, not a flag template.
  assert.match(html, /Q1 has no answer choices — add the printed options\. \[Fix\]/);
  assert.equal(input.flags.length, 14);
});

test('D1: pure instructions and sparse interior question lines cannot become passages', () => {
  const lines = [line(1, 'Writing'), line(2, '50. The risk of dying from smok'), line(3, 'ing is very high for many people who smoke every day.'), line(4, 'the continuation of the question is still part of this one item.'), line(5, 'end.')];
  const question = { ...q(50), spans: [[2, 2], [5, 5]] as [number, number][] };
  const sections = [{ id: 's1', index: 1, title: 'Writing', spans: [[1, 5]] }];
  assert.equal(assembleAndValidateSections(sections, lines, [question], []).sections[0].passage, undefined);
  const instructions = [line(1, 'Vocabulary'), line(2, 'For each of the following questions choose the correct definition.'), line(3, 'Read each definition and match each of the words with its definition.'), line(4, '51. Word')];
  const second = assembleAndValidateSections([{ id: 's1', index: 1, title: 'Vocabulary', spans: [[1, 4]] }], instructions, [{ ...q(51), spans: [[4, 4]] }], []);
  assert.equal(second.sections[0].passage, undefined);
});
