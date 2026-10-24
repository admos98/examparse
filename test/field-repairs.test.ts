import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleAndValidateQuestions, assembleAndValidateSections, parsePrintedPoints, sliceSourceSpans, trimOptionInstructionResidue } from '../src/pipeline/assemble';
import { segmentDocument } from '../src/pipeline/segment';
import { distributeGroupImages } from '../src/pipeline/groupImages';
import type { ImageAsset, Question, SourceLine } from '../src/types';

const line = (n: number, text: string, extra: Partial<SourceLine> = {}): SourceLine => ({ id: `L${String(n).padStart(4, '0')}`, page: 1, text, ...extra });

function dialogueFixture(): SourceLine[] {
  return [
    line(1, 'Listening'),
    line(2, 'Listen to the dialogue and fill in the blanks.'),
    line(3, 'A: Do you play any sports, Nick?'),
    line(4, 'B: Yes, I love playing sports. My favorite sport is 9 …….'),
    line(5, 'A: Are you on a 10 …… team?'),
    line(6, 'B: Yes. It is a lot of 11 …….'),
    line(7, 'A: How often do you 12 ……?'),
    line(8, 'B: About 13 …… times a week.'),
    line(9, 'A: Is playing video 14 …… a sport?'),
    line(10, 'B: I am not sure.'),
  ];
}

test('Part C: speaker dialogue becomes one shared parent plus fillblank children, including same-number child; instructions stay out of passage', () => {
  const lines = dialogueFixture();
  const segment = segmentDocument({ lines });
  const parentSegment = segment.segments.find(item => item.groupForm === 'dialogue');
  assert.ok(parentSegment);
  assert.equal(parentSegment?.printedNo, 9);
  assert.deepEqual(parentSegment?.childNos, [10, 11, 12, 13, 14]);
  const children = segment.segments.filter(item => item.parentSegmentId === parentSegment?.id);
  assert.equal(children.length, 5);
  assert.ok(!children.some(child => child.printedNo === 9));

  const assembled = assembleAndValidateQuestions([], lines, undefined, { gapCompletion: false, segmentReceipts: segment.segments });
  const parent = assembled.questions.find(question => !question.parentId && question.no === 9)!;
  assert.equal(parent.type, 'fillblank');
  assert.ok(parent.stem?.includes('Do you play any sports'));
  assert.ok(parent.stem?.includes('9 ……'));
  assert.ok(parent.receipt?.ruleChain.includes('dialogue-group'));
  assert.ok(!assembled.questions.some(question => question.parentId === parent.id && question.no === 9), 'no phantom same-number child');
  for (const no of [10, 11, 12, 13, 14]) {
    const child = assembled.questions.find(question => question.parentId === parent.id && question.no === no)!;
    assert.ok(child, `dialogue child ${no} exists`);
    assert.equal(child.type, 'fillblank');
    assert.ok(child.stem?.includes(`${no} ……`));
    for (const sibling of [10, 11, 12, 13, 14].filter(value => value !== no)) assert.ok(!child.stem?.includes(`${sibling} ……`));
  }
  const sections = assembleAndValidateSections([{ id: 'sec_1', index: 1, title: 'Listening', spans: [[1, 10]] }], lines, assembled.questions, []);
  assert.ok(!sections.sections[0].passage?.includes('Listen to the dialogue'));
  assert.ok(!sections.sections[0].passage?.includes('Do you play any sports'));
});

test('Part E: enumerative parent uses its governing instruction and children have disjoint sibling-free slices', () => {
  const text = '63. a) She travels by bus. 64. b) They work after school. 65. c) We study English. 66. d) He plays tennis.';
  const lines = [line(1, 'Complete the sentences with a suitable word.'), line(2, text)];
  const segmented = segmentDocument({ lines });
  const parentSegment = segmented.segments.find(item => item.groupForm === 'enumeration');
  assert.ok(parentSegment);
  assert.deepEqual(parentSegment?.childNos, [64, 65, 66]);
  assert.deepEqual(parentSegment?.parentStemLines, [1]);
  const assembled = assembleAndValidateQuestions([], lines, undefined, { gapCompletion: false, segmentReceipts: segmented.segments });
  const parent = assembled.questions.find(question => !question.parentId && question.no === 63)!;
  assert.equal(parent.stem, 'Complete the sentences with a suitable word.\n63. a) She travels by bus.');
  assert.ok(!assembled.questions.some(question => question.parentId === parent.id && question.no === 63), 'first item is the numbered root, not a phantom child');
  for (const no of [64, 65, 66]) {
    const child = assembled.questions.find(question => question.parentId === parent.id && question.no === no)!;
    assert.ok(child, `enumeration child ${no} exists`);
    assert.ok(child.stem?.includes(`${no}.`));
    for (const sibling of [64, 65, 66].filter(value => value !== no)) assert.ok(!child.stem?.includes(`${sibling}.`));
  }
});

test('Part E: shared-group images distribute by explicit child label or anchor, with fallback outcomes flagged', () => {
  const question = (id: string, no: number, parentId?: string, lineNo = no): Question => ({
    id, label: String(no), no, parentId, sectionId: 'sec_1', spans: [[lineNo, lineNo]], stem: '', points: 0,
    type: 'unknown', images: [], confidence: 0.9,
  });
  const parent = question('q15', 15);
  parent.receipt = { lineStart: 10, lineEnd: 12, ruleChain: ['matching-group'], ruleConfidence: 90 };
  parent.images = [
    { imageId: 'img-label', role: 'stem' },
    { imageId: 'img-anchor', role: 'stem', anchorLine: 12 },
    { imageId: 'img-order', role: 'stem' },
    { imageId: 'img-missing', role: 'stem' },
  ];
  const children = [question('q16', 16, 'q15', 10), question('q17', 17, 'q15', 11), question('q18', 18, 'q15', 12)];
  const asset = (id: string, anchorLine?: number, questionRef?: string): ImageAsset => ({
    id, page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: id,
    width: 10, height: 10, anchorLine, label: { role: 'stem', questionRef }, blobKey: id,
  });
  const result = distributeGroupImages([parent, ...children], [asset('img-label', undefined, '17'), asset('img-anchor'), asset('img-order')]);
  assert.equal(result.distributed, 3);
  assert.equal(result.fallback, 2);
  assert.equal(result.unassigned, 1);
  assert.deepEqual(result.questions.find(q => q.id === 'q15')?.images.map(ref => ref.imageId), ['img-missing']);
  assert.ok(result.questions.find(q => q.id === 'q17')?.images.some(ref => ref.imageId === 'img-label'));
  assert.ok(result.questions.find(q => q.id === 'q18')?.images.some(ref => ref.imageId === 'img-anchor'));
  assert.ok(result.flags.some(flag => flag.code === 'GROUP_IMAGE_DISTRIBUTED'));
  assert.ok(result.flags.some(flag => flag.code === 'GROUP_IMAGE_DISTRIBUTION_FALLBACK'));
  assert.ok(result.flags.some(flag => flag.code === 'GROUP_IMAGE_DISTRIBUTION_UNASSIGNED'));

  const dialogueParent = question('q20', 20);
  dialogueParent.receipt = { lineStart: 1, lineEnd: 2, ruleChain: ['dialogue-group'], ruleConfidence: 90 };
  dialogueParent.images = [{ imageId: 'img-shared', role: 'stem' }];
  const dialogueChild = question('q21', 21, 'q20', 2);
  const shared = distributeGroupImages([dialogueParent, dialogueChild], [asset('img-shared')]);
  assert.deepEqual(shared.questions.find(q => q.id === 'q20')?.images.map(ref => ref.imageId), ['img-shared']);
  assert.ok(shared.flags.some(flag => flag.code === 'GROUP_IMAGE_RETAINED_SHARED_CONTEXT'));
});

test('Part D: explicit key marks and section-header points outrank model points; remaining total uses deterministic residual allocation', () => {
  const lines = [line(1, '1 | Vocabulary (3 points)'), line(2, '1. One question'), line(3, '2. Another question'), line(4, 'Total points: 3')];
  const assembled = assembleAndValidateQuestions([
    { id: 'q1', no: 1, type: 'short', points: 77, sectionId: 'sec_1', spans: [[2, 2]] },
    { id: 'q2', no: 2, type: 'short', points: 1, sectionId: 'sec_1', spans: [[3, 3]] },
  ], lines, 99, { gapCompletion: false, sections: [{ id: 'sec_1', index: 1, title: 'Vocabulary', points: 99, spans: [[1, 4]] }] });
  const roots = assembled.questions.filter(question => !question.parentId);
  assert.deepEqual(roots.map(question => question.points), [1.5, 1.5]);
  assert.equal(roots.reduce((sum, question) => sum + (question.points || 0), 0), 3);
  assert.ok(roots.every(question => question.receipt?.ruleChain.includes('points-derived:header')));
  assert.equal(parsePrintedPoints('3 Listening 1'), undefined);
  assert.equal(parsePrintedPoints('نمره 1'), undefined);
  assert.equal(parsePrintedPoints('Part 3 (4 points)'), 4);
  assert.equal(parsePrintedPoints('Points: 5'), 5);
});

test('Part D: key-item marks aggregate once at a grouped root, while overflow is loud and total remains exact', () => {
  const lines = [
    line(1, '15. Match the items.'), line(2, '16. First item.'), line(3, '17. Second item.'), line(4, '18. Third item.'),
    line(5, 'Each correct answer is 0.5 marks.', { tag: 'key' }),
    line(6, '15. A 16. B 17. C 18. D', { tag: 'key' }),
    line(7, 'Total points: 2', { tag: 'key' }),
  ];
  const raw = [
    { id: 'q15', no: 15, type: 'matching', spans: [[1, 1]] },
    ...[16, 17, 18].map((no, index) => ({ id: `q15_${no}`, no, parentId: 'q15', type: 'matching', spans: [[index + 2, index + 2]] })),
  ];
  const groupSegmentId = 'G15';
  const groupSegments = [
    { id: groupSegmentId, kind: 'group-parent', startLine: 1, endLine: 4, printedNo: 15, childNos: [16, 17, 18], groupForm: 'matching' as const, ruleChain: ['matching-group'] },
    ...[16, 17, 18].map((no, index) => ({
      id: `${groupSegmentId}_c${no}`, kind: 'question', parentSegmentId: groupSegmentId, startLine: index + 2, endLine: index + 2,
      printedNo: no, offsetSpan: { line: index + 2, start: 0, end: lines[index + 1].text.length }, ruleChain: ['matching-group-child'],
    })),
  ];
  const grouped = assembleAndValidateQuestions(raw, lines, 2, { keyTerritoryLineNos: [5, 6, 7], gapCompletion: false, segmentReceipts: groupSegments });
  assert.equal(grouped.questions.find(question => question.id === 'q15')?.points, 2);
  assert.ok(grouped.questions.filter(question => question.parentId).every(question => question.points === 0));
  assert.equal(grouped.questions.filter(question => !question.parentId).reduce((sum, question) => sum + (question.points || 0), 0), 2);

  const overflowLines = [
    line(1, '1. Q1'), line(2, '2. Q2'),
    line(3, 'Each correct answer is 1 mark.', { tag: 'key' }),
    line(4, '1. A 2. B', { tag: 'key' }),
    line(5, 'Total points: 1', { tag: 'key' }),
  ];
  const overflow = assembleAndValidateQuestions([1, 2].map(no => ({ id: `q${no}`, no, points: 50, type: 'short', spans: [[no, no]] })), overflowLines, 88, { keyTerritoryLineNos: [3, 4, 5], gapCompletion: false });
  const sum = overflow.questions.filter(question => !question.parentId).reduce((value, question) => value + (question.points || 0), 0);
  assert.equal(sum, 1);
  assert.ok(overflow.flags.some(flag => flag.code === 'POINTS_OVERFLOW' && flag.severity === 'error'));

  const centLines = [
    line(1, '1. Q1'), line(2, '2. Q2'), line(3, '3. Q3'), line(4, '4. Q4'),
    line(5, 'Each correct answer is 1 mark.', { tag: 'key' }),
    line(6, '1. A 2. B 3. C 4. D', { tag: 'key' }),
    line(7, 'Total points: 0.02', { tag: 'key' }),
  ];
  const centOverflow = assembleAndValidateQuestions([1, 2, 3, 4].map(no => ({ id: `q${no}`, no, points: 100, type: 'short', spans: [[no, no]] })), centLines, 99, { keyTerritoryLineNos: [5, 6, 7], gapCompletion: false });
  const centRoots = centOverflow.questions.filter(question => !question.parentId);
  assert.deepEqual(centRoots.map(question => question.points), [0.01, 0.01, 0, 0]);
  assert.ok(centRoots.every(question => (question.points || 0) >= 0));
  assert.equal(centRoots.reduce((value, question) => value + (question.points || 0), 0), 0.02);
  assert.ok(centOverflow.flags.some(flag => flag.code === 'POINTS_OVERFLOW' && flag.severity === 'error'));
});

test('Part F: instruction-only spans are demoted, single-anchor key slices are carved, and incomplete answers extend', () => {
  const lines = [
    line(1, 'Read the text and answer the questions below.'),
    line(2, '1. Where does the boy live?'),
    line(3, '2. What does he like?'),
    line(4, '1. He lives in'),
    line(5, 'a small blue house.'),
    line(6, '2. Reading books.', { tag: 'key' }),
    line(7, '1. He lives in the city. 2. He likes music.', { tag: 'key' }),
  ];
  const keyLines = [6, 7];
  const assembled = assembleAndValidateQuestions([
    { id: 'q1', no: 1, type: 'short', spans: [[1, 2]], answer: { spans: [[7, 7]] } },
    { id: 'q2', no: 2, type: 'fillblank', spans: [[3, 3]], answer: { spans: [[7, 7]] } },
  ], lines, undefined, { keyTerritoryLineNos: keyLines, gapCompletion: false });
  const q1 = assembled.questions.find(question => question.no === 1)!;
  const q2 = assembled.questions.find(question => question.no === 2)!;
  assert.deepEqual(q1.spans, [[2, 2]]);
  assert.ok(assembled.flags.some(flag => flag.code === 'INSTRUCTION_SPANS_DEMOTED'));
  assert.equal(q1.answer?.text, 'He lives in the city.');
  assert.equal(q2.answer?.text, 'He likes music.');

  const incomplete = assembleAndValidateQuestions([
    { id: 'q1', no: 1, type: 'short', spans: [[2, 2]], answer: { spans: [[4, 5]] } },
  ], lines, undefined, { keyTerritoryLineNos: [4, 5], gapCompletion: false });
  const extended = incomplete.questions[0].answer;
  assert.equal(extended?.text, 'He lives in\na small blue house.');
  assert.ok(incomplete.flags.some(flag => flag.code === 'ANSWER_SPAN_EXTENDED'));

  const numberOnlyLines = [line(1, '1. Q'), line(2, '17', { tag: 'key' })];
  const numberOnly = assembleAndValidateQuestions([
    { id: 'q1', no: 1, type: 'short', spans: [[1, 1]], answer: { spans: [[2, 2]] } },
  ], numberOnlyLines, undefined, { keyTerritoryLineNos: [2], gapCompletion: false });
  assert.equal(numberOnly.questions[0].answer, undefined);
  assert.ok(numberOnly.flags.some(flag => flag.code === 'ANSWER_NUMBER_ONLY_MISSING'));

  const anchoredLines = [
    line(1, '1. Match the item.'), line(2, '2. Fill in the blank.'), line(3, '3. Complete the sentence.'),
    line(4, '1. First answer. 2. Second answer. 3. Third answer.', { tag: 'key' }),
  ];
  const anchored = assembleAndValidateQuestions([
    { id: 'q1', no: 1, type: 'matching', spans: [[1, 1]] },
    { id: 'q1_c2', no: 2, parentId: 'q1', type: 'matching', spans: [[2, 2]] },
    { id: 'q3', no: 3, type: 'fillblank', spans: [[3, 3]] },
  ], anchoredLines, undefined, { keyTerritoryLineNos: [4], gapCompletion: false });
  assert.equal(anchored.questions.find(question => question.no === 2)?.answer?.text, 'Second answer.');
  assert.equal(anchored.questions.find(question => question.no === 3)?.answer?.text, 'Third answer.');
  assert.ok(anchored.flags.filter(flag => flag.code === 'ANSWER_KEY_ANCHOR_RECOVERED').length >= 2);
});

test('Part F: trim Persian parenthetical instruction residue from option tails', () => {
  const result = trimOptionInstructionResidue('giraffe. (یک تعریف اضافه است)', 'Choose the correct word. (یک تعریف اضافه است)');
  assert.deepEqual(result, { text: 'giraffe.', trimmed: true });
  assert.deepEqual(trimOptionInstructionResidue('giraffe', 'Choose the correct word.'), { text: 'giraffe', trimmed: false });
});
