import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleAndValidateQuestions, decontaminateStem, splitInlineOptions, validateAndFixDuplicateImageIds } from '../src/pipeline/assemble';
import { reconcileMetaTotal } from '../src/pipeline/quality';
import { findIntraLineMultiNumbers, segmentDocument } from '../src/pipeline/segment';
import { createLocalDraft } from '../src/pipeline/localDraft';
import type { ExamDoc, ImageAsset, SourceLine } from '../src/types';
import { runCorpus } from '../scripts/corpus';

const source = (text: string, id = 'L0001'): SourceLine => ({ id, page: 1, text });

test('field R1: watermark is excised from the sliced option union before marker splitting; stored source is unchanged', () => {
  const first = source("a) won`t he مرکز سنجش و پایش کیفیت آموزشیb) won`t they c) will they d) will he");
  const second = source('مرکز سنجش و پایش کیفیت آموزشیa) need b) strength c) happiness d) respect', 'L0002');
  const assemble = (line: SourceLine, no: number) => assembleAndValidateQuestions([
    { id: `q${no}`, no, type: 'mcq', spans: [[Number(line.id.slice(1)), Number(line.id.slice(1))]], options: ['a','b','c','d'].map(key => ({ key, spans: [[Number(line.id.slice(1)), Number(line.id.slice(1))]] })) },
  ], [line], undefined, { gapCompletion: false });
  const one = assemble(first, 1).questions[0];
  const two = assemble(second, 2).questions[0];
  assert.deepEqual(one.options?.map(option => option.text), ["won't he", "won't they", 'will they', 'will he']);
  assert.deepEqual(two.options?.map(option => option.text), ['need', 'strength', 'happiness', 'respect']);
  assert.ok(!one.options?.some(option => option.text?.includes('مرکز')));
  assert.ok(!two.options?.some(option => option.text?.includes('مرکز')));
  assert.equal(first.text, "a) won`t he مرکز سنجش و پایش کیفیت آموزشیb) won`t they c) will they d) will he");
  assert.equal(second.text, 'مرکز سنجش و پایش کیفیت آموزشیa) need b) strength c) happiness d) respect');
});

test('field R1 marker grammar: parenthesized, dotted, dashed, Persian, and incomplete/out-of-order sets', () => {
  assert.deepEqual(splitInlineOptions('(a) one b. two c) three d- four').map(option => option.text), ['one','two','three','four']);
  assert.deepEqual(splitInlineOptions('الف) one ب) two ج) three د) four').map(option => option.text), ['one','two','three','four']);
  assert.deepEqual(splitInlineOptions('a) one c) three b) two'), []);
  assert.deepEqual(splitInlineOptions('a) one b) two d) four'), []);
});

test('field R1: speaker labels stay in dialogue stems and model-reported grouped children attach to local parents', () => {
  const dialogue = source('B: she likes reading books.');
  assert.equal(decontaminateStem([[1,1]], [[1,1]], [dialogue], 9), dialogue.text);

  const lines = [source('1. (1) (2)'), source('Shared instructions for both questions.', 'L0002')];
  const assembled = assembleAndValidateQuestions([
    { id: 'q1', no: 1, spans: [[1,1]], type: 'matching' },
    { id: 'q2', no: 2, spans: [[1,1]], type: 'matching' },
  ], lines, undefined, { gapCompletion: false, segmentReceipts: [
    { id: 'S1', kind: 'group-parent', startLine: 1, endLine: 2, printedNo: 1, childNos: [1,2] },
  ] });
  const child = assembled.questions.find(question => question.no === 2);
  assert.equal(child?.parentId, 'q1');
  assert.equal(child?.points, 0);
  assert.deepEqual(child?.spans, [{ line: 1, start: 7, end: 10 }]);
  assert.equal(child?.stem, '(2)');
});

test('field R2: immutable document total beats model points; residual is allocated only to unpriced roots', () => {
  const lines: SourceLine[] = Array.from({ length: 106 }, (_, index) => source(index < 105 ? `${index + 1}. Question ${index + 1}` : 'جمع نمره: 48', `L${String(index + 1).padStart(4, '0')}`));
  const raw = Array.from({ length: 105 }, (_, index) => ({ id: `q${index + 1}`, no: index + 1, points: 0.5, type: 'short', spans: [[index + 1, index + 1]] }));
  assert.equal(raw.length * 0.5, 52.5);
  const assembled = assembleAndValidateQuestions(raw, lines, 52.5, { gapCompletion: false });
  const sum = assembled.questions.filter(question => !question.parentId).reduce((value, question) => value + (question.points || 0), 0);
  const total = reconcileMetaTotal(52.5, lines, [], assembled.questions);
  assert.equal(Number(sum.toFixed(2)), 48);
  assert.equal(total.totalPoints, 48);
  assert.ok(assembled.flags.every(flag => flag.code !== 'POINTS_OVERFLOW'));
  assert.ok(assembled.questions.every(question => question.receipt?.ruleChain.includes('points-derived:residual')));
  assert.ok(!assembled.flags.some(flag => flag.message.includes('raised to the question sum')));
});

test('field R2: source section-header points divide exactly with the final-item remainder; model points are ignored', () => {
  const lines = [
    source('1 | Vocabulary (2 points)'),
    source('1. one', 'L0002'), source('2. two', 'L0003'), source('3. three', 'L0004'), source('جمع نمره: 2', 'L0005'),
  ];
  const assembled = assembleAndValidateQuestions([1,2,3].map(no => ({ id: `q${no}`, no, sectionId: 'sec_1', points: no === 1 ? -1 : 77, spans: [[no + 1,no + 1]], type: 'short' })), lines, 99, {
    gapCompletion: false,
    sections: [{ id: 'sec_1', index: 1, title: 'Vocabulary', points: 99, spans: [[1,5]] }],
  });
  assert.deepEqual(assembled.questions.map(question => question.points), [0.66,0.66,0.68]);
  assert.ok(assembled.questions.every(question => question.receipt?.ruleChain.includes('points-derived:header')));
  assert.ok(assembled.flags.some(flag => flag.code === 'MODEL_POINTS_IGNORED'), 'out-of-range model points are demoted, not allowed to block the question');
  assert.equal(assembled.questions.reduce((sum, question) => sum + (question.points || 0), 0), 2);
});

test('field R3: descending intra-line numbering is emitted as an ascending parent plus children', () => {
  const text = '66. d) Clean energy… 65. c) Sport……… 64. b) Watching TV…… 63. a) Ferdowsi….';
  assert.deepEqual(findIntraLineMultiNumbers(text).map(item => item.no), [63,64,65,66]);
  const res = segmentDocument({ lines: [source(text)] });
  const parent = res.segments.find(segment => segment.kind === 'group-parent');
  assert.equal(parent?.printedNo, 63);
  assert.deepEqual(parent?.childNos, [64,65,66]);
  assert.deepEqual(res.segments.filter(segment => segment.parentSegmentId === parent?.id).map(segment => segment.printedNo).sort(), [64,65,66]);
});

test('field R4: duplicate pre-extracted ids are re-minted sequentially without _dup suffixes on import drafts', () => {
  const image = (id: string, page: number): ImageAsset => ({ id, page, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: `${id}-${page}`, width: 10, height: 10, blobKey: `${id}-${page}` });
  const base: ExamDoc = {
    id: 'exam_test', fileHash: 'test', createdAt: 'now', displayName: 'test', meta: { language: 'en', direction: 'ltr' },
    sections: [], questions: [], images: [image('img_010',1), image('img_010',2), image('img_011',3), image('img_010_dup2',4)],
    source: { lines: [source('Q1','L0001')], pages: 4, ocrUsed: false, fileName: 'x.pdf' }, flags: [], usage: [],
  };
  const fixed = validateAndFixDuplicateImageIds(base);
  assert.deepEqual(fixed.doc.images.map(item => item.id), ['img_010','img_012','img_011','img_013']);
  assert.ok(fixed.doc.images.every(item => !/_dup\d+$/.test(item.id)));
  const draft = createLocalDraft({ lines: base.source.lines, pages: 4, ocrUsed: false, fileName: 'x.pdf', images: base.images, scannedPageIndices: [], pageImages: [] }, 'test-hash');
  assert.equal(new Set(draft.images.map(item => item.id)).size, draft.images.length);
  assert.ok(draft.images.every(item => !/_dup\d+$/.test(item.id)));
});

test('field corpus acceptance hard gate: English final passes 67/67, 8/8, 48, 12/12, shape 0/0/0 and both groups pre-assistant', async () => {
  const { results, ok } = await runCorpus({ strict: true, print: false, mode: 'legacy' });
  const exam = results.find(result => result.exam === 'english-final-13991009pq89w65173');
  assert.equal(ok, true, JSON.stringify(exam?.failures));
  assert.equal(exam?.recall, '67/67');
  assert.equal(exam?.sections, '8/8');
  assert.equal(exam?.total, '48');
  assert.equal(exam?.spotChecks, '12/12');
  assert.equal(exam?.shapeAuditLabel, '0/0/0');
  assert.equal(exam?.duplicateImageIds, 0);
  assert.equal(exam?.preAssistantChildren, '15:16,17,18;63:64,65,66');
});
