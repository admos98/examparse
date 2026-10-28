import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ExamDoc, LLMResponse, Question, SourceLine } from '../src/types';
import { sliceSourceSpans } from '../src/pipeline/spans';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { detectSectionHeaders, checkInvariantI12 } from '../src/pipeline/quality';
import { findIntraLineMultiNumbers, segmentDocument } from '../src/pipeline/segment';
import { canonicalizeForms, computeShapeAudit, FORM_RULE_ID } from '../src/pipeline/forms';
import { createToolRegistry } from '../src/pipeline/agentTools';
import { AgentRuntime, newAgentSession, runAgentTurn } from '../src/pipeline/agent';
import { DEFAULT_SETTINGS } from '../src/store';
import { replayFieldExport } from '../src/pipeline/fieldReplay';
import { runCorpus } from '../scripts/corpus';

const mkLine = (no: number, text: string, page = 1): SourceLine => ({
  id: `L${String(no).padStart(4, '0')}`,
  page,
  text,
});

type QInit = Omit<Question, 'label' | 'images'> & { label?: string; images?: Question['images'] };
const mkQ = (q: QInit): Question => ({ label: String(q.no), images: [], ...q });
const mkReply = (rawText: string): LLMResponse => ({
  rawText,
  json: null,
  usage: { inputTokens: 0, outputTokens: 0 },
});

function mkBaseDoc(lines: SourceLine[], questions: QInit[]): ExamDoc {
  return {
    id: 'exam_marvel_final',
    fileHash: 'hash_marvel_final',
    createdAt: '2026-10-23T00:00:00.000Z',
    displayName: 'Marvel Final Test',
    meta: { language: 'mixed', direction: 'rtl', totalPoints: 10 },
    sections: [{ id: 'sec_1', index: 1, title: 'Reading', spans: [[1, lines.length]] }],
    questions: questions.map(mkQ),
    images: [],
    source: { lines, pages: 1, ocrUsed: false, fileName: 'test.pdf' },
    flags: [],
    usage: [],
  };
}

// ============================================================================
// Part B — Offset-Addressed Text & Invariant I12
// ============================================================================

test('B1: OffsetSpan slicing is backward-compatible with [start,end] tuples and excises watermarks automatically', () => {
  const lines = [
    mkLine(1, '10. Choose the best answer. مرکز سنجش و پایش کیفیت آموزشی a) alpha b) beta'),
    mkLine(2, 'Second line text'),
  ];
  assert.equal(
    sliceSourceSpans([[1, 2]], lines),
    '10. Choose the best answer. a) alpha b) beta\nSecond line text',
  );
  const aIdx = lines[0].text.indexOf('alpha');
  assert.equal(
    sliceSourceSpans([{ line: 1, start: aIdx, end: aIdx + 5 }], lines),
    'alpha',
  );
  const wmSlice = sliceSourceSpans([{ line: 1, start: 0, end: aIdx + 5 }], lines);
  assert.ok(!wmSlice.includes('مرکز سنجش'));
  assert.ok(wmSlice.includes('10. Choose the best answer.'));
});

test('B2a: Q40 inline True/False regression slices options to [True, False] and stem to "40. Early humans discovered how to make fire."', () => {
  const lines = [
    mkLine(134, '39. Early humans killed the animals and ate them as their food. a) True b) False', 4),
    mkLine(135, '40. Early humans discovered how to make fire. a) True b) False', 4),
  ];
  const assembled = assembleAndValidateQuestions(
    [
      {
        id: 'q39',
        no: 39,
        spans: [[134, 134]],
        type: 'mcq',
        options: [
          { key: 'a', spans: [[134, 134]] },
          { key: 'b', spans: [[134, 134]] },
        ],
      },
      {
        id: 'q40',
        no: 40,
        spans: [[135, 135]],
        type: 'mcq',
        options: [
          { key: 'a', spans: [[135, 135]] },
          { key: 'b', spans: [[135, 135]] },
        ],
      },
    ],
    lines,
    undefined,
    { gapCompletion: false },
  );
  const q39 = assembled.questions.find(q => q.no === 39)!;
  const q40 = assembled.questions.find(q => q.no === 40)!;
  assert.equal(q39.stem, '39. Early humans killed the animals and ate them as their food.');
  assert.equal(q40.stem, '40. Early humans discovered how to make fire.');
  assert.deepEqual(q40.options?.map(o => o.text), ['True', 'False']);
  assert.equal(q40.type, 'truefalse');
});

test('B2b: descending multi-number line 63–66 slices via OffsetSpan with exact item texts despite Unicode ellipses', () => {
  const line = mkLine(224, '66. d) Clean energy… 65. c) Sport……… 64. b) Watching TV…… 63. a) Ferdowsi….');
  const intra = findIntraLineMultiNumbers(line.text);
  assert.deepEqual(intra.map(i => i.no), [63, 64, 65, 66]);
  const segs = segmentDocument({ lines: [line] }).segments;
  const assembled = assembleAndValidateQuestions(
    [{ id: 'q63', no: 63, spans: [[224, 224]], type: 'long' }],
    [line],
    undefined,
    { gapCompletion: false, segmentReceipts: segs },
  );
  assert.equal(assembled.questions.find(q => q.no === 63)?.stem, '63. a) Ferdowsi….');
  assert.equal(assembled.questions.find(q => q.no === 64)?.stem, '64. b) Watching TV……');
  assert.equal(assembled.questions.find(q => q.no === 65)?.stem, '65. c) Sport………');
  assert.equal(assembled.questions.find(q => q.no === 66)?.stem, '66. d) Clean energy…');
});

test('B2c & B3: shared-line matching children carve to distinct stems; I12 demotes rather than blocking unresolvable identical stems', () => {
  const shared = [
    mkLine(1, '(15)  (16)  (17)  (18)'),
    mkLine(2, 'a. First sentence.'),
    mkLine(3, 'b. Second sentence.'),
    mkLine(4, 'c. Third sentence.'),
    mkLine(5, 'd. Fourth sentence.'),
  ];
  const segs = segmentDocument({ lines: shared }).segments;
  const assembled = assembleAndValidateQuestions(
    [{ id: 'q15', no: 15, spans: [[1, 5]], type: 'unknown' }],
    shared,
    2,
    { gapCompletion: true, segmentReceipts: segs },
  );
  const children = assembled.questions.filter(q => q.parentId === 'q15').sort((a, b) => a.no - b.no);
  assert.deepEqual(children.map(c => c.no), [16, 17, 18]);
  assert.deepEqual(children.map(c => c.stem), ['(16)', '(17)', '(18)']);

  const unresolvableLines = [mkLine(1, 'Plain unnumbered shared prompt text without child markers')];
  const rawIdentical = [
    { id: 'p1', no: 1, spans: [[1, 1]], type: 'short', confidence: 0.9 },
    { id: 'c2', no: 2, parentId: 'p1', spans: [[1, 1]], type: 'short', confidence: 0.9 },
    { id: 'c3', no: 3, parentId: 'p1', spans: [[1, 1]], type: 'short', confidence: 0.9 },
  ];
  const demoted = assembleAndValidateQuestions(rawIdentical, unresolvableLines, 2, { gapCompletion: false });
  assert.equal(demoted.questions.length, 3);
  const c2 = demoted.questions.find(q => q.id === 'c2')!;
  const c3 = demoted.questions.find(q => q.id === 'c3')!;
  assert.ok(c2.confidence <= 0.45 && c3.confidence <= 0.45);
  assert.ok(demoted.flags.some(f => f.code === 'INVARIANT_I12_SIBLING_IDENTICAL_STEM'));
  const inv = checkInvariantI12(demoted.questions);
  assert.ok(inv.violations.some(v => v.code === 'I12'));
});

// ============================================================================
// Part C — Form Canonicalizers (6 of 6 shipped, 3 explicit tests per form = 18)
// ============================================================================

test('Form 1 TRUEFALSE (1/3): inline English "a) True b) False" reshapes stem & options and emits TYPE_CORRECTED_BY_FORM', () => {
  const lines = [mkLine(10, '6. Her mother said to him to call the bus station.  a) True  b) False')];
  const q = mkQ({
    id: 'q6',
    no: 6,
    spans: [[10, 10]],
    stem: lines[0].text,
    type: 'mcq',
    options: [
      { key: 'a', spans: [[10, 10]], text: lines[0].text },
      { key: 'b', spans: [[10, 10]], text: lines[0].text },
    ],
    confidence: 0.5,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'truefalse');
  assert.equal(res.questions[0].stem, '6. Her mother said to him to call the bus station.');
  assert.deepEqual(res.questions[0].options?.map(o => o.text), ['True', 'False']);
  assert.ok(res.flags.some(f => f.code === 'TYPE_CORRECTED_BY_FORM'));
});

test('Form 1 TRUEFALSE (2/3): Persian parenthesized "(درست / نادرست)" carves to ["درست", "نادرست"] without inventing text', () => {
  const lines = [mkLine(1, '۱. زمین به دور خورشید می‌چرخد. (درست / نادرست)')];
  const q = mkQ({
    id: 'q1',
    no: 1,
    spans: [[1, 1]],
    stem: lines[0].text,
    type: 'short',
    confidence: 0.7,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'truefalse');
  assert.equal(res.questions[0].stem, '۱. زمین به دور خورشید می‌چرخد.');
  assert.deepEqual(res.questions[0].options?.map(o => o.text), ['درست', 'نادرست']);
});

test('Form 1 TRUEFALSE (3/3): idempotence & provenance — second run yields 0 deltas and preserves form:truefalse', () => {
  const lines = [mkLine(5, '5. His jacket wasn’t new and expensive. a) True b) False')];
  const q = mkQ({ id: 'q5', no: 5, spans: [[5, 5]], stem: lines[0].text, type: 'unknown', confidence: 0.8 });
  const pass1 = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(pass1.deltas.length, 1);
  assert.ok(pass1.questions[0].receipt?.ruleChain.includes(FORM_RULE_ID.TRUEFALSE));
  const pass2 = canonicalizeForms({ questions: pass1.questions, sourceLines: lines });
  assert.equal(pass2.deltas.length, 0);
  assert.deepEqual(pass2.questions, pass1.questions);
});

test('Form 2 MCQ-INLINE (1/3): four options sharing one source line carve to distinct offsets and clean stem', () => {
  const lines = [mkLine(1, '25. They will buy a new house, ...? a) won`t he b) won`t they c) will they d) will he')];
  const q = mkQ({
    id: 'q25',
    no: 25,
    spans: [[1, 1]],
    stem: lines[0].text,
    type: 'short',
    confidence: 0.6,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'mcq');
  assert.equal(res.questions[0].stem, '25. They will buy a new house, ...?');
  assert.deepEqual(res.questions[0].options?.map(o => o.text), ["won't he", "won't they", 'will they', 'will he']);
});

test('Form 2 MCQ-INLINE (2/3): multi-line 2x2 option layout (a/b on L2, c/d on L3) carves all four options', () => {
  const lines = [
    mkLine(1, '41. What does "they" in line 3 refer to?'),
    mkLine(2, 'a) environments  b) humans'),
    mkLine(3, 'c) fires  d) animals'),
  ];
  const q = mkQ({
    id: 'q41',
    no: 41,
    spans: [[1, 3]],
    stem: lines.map(l => l.text).join('\n'),
    type: 'unknown',
    confidence: 0.7,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'mcq');
  assert.equal(res.questions[0].stem, '41. What does "they" in line 3 refer to?');
  assert.deepEqual(res.questions[0].options?.map(o => o.text), ['environments', 'humans', 'fires', 'animals']);
});

test('Form 2 MCQ-INLINE (3/3): watermarks inside shared option line are excised without mutating source lines', () => {
  const rawText = '35. We show our ... by being polite. a) need مرکز سنجش و پایش کیفیت آموزشی b) strength c) happiness d) respect';
  const lines = [mkLine(1, rawText)];
  const q = mkQ({ id: 'q35', no: 35, spans: [[1, 1]], stem: rawText, type: 'mcq', confidence: 0.8 });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.deepEqual(res.questions[0].options?.map(o => o.text), ['need', 'strength', 'happiness', 'respect']);
  assert.equal(lines[0].text, rawText);
});

test('Form 3 MATCHING-POOL (1/3): shared-line group (15)(16)(17)(18) + a..e pool carves distinct children and parent pool', () => {
  const lines = [
    mkLine(1, '(15)  (16)  (17)  (18)'),
    mkLine(2, 'a. First caption'),
    mkLine(3, 'b. Second caption'),
    mkLine(4, 'c. Third caption'),
    mkLine(5, 'd. Fourth caption'),
    mkLine(6, 'e. Extra caption'),
  ];
  const qs: Question[] = [
    mkQ({ id: 'q15', no: 15, spans: [[1, 6]], stem: lines.map(l => l.text).join('\n'), type: 'unknown', confidence: 0.8 }),
    mkQ({ id: 'q16', no: 16, parentId: 'q15', spans: [[1, 1]], stem: lines[0].text, type: 'unknown', confidence: 0.8 }),
    mkQ({ id: 'q17', no: 17, parentId: 'q15', spans: [[1, 1]], stem: lines[0].text, type: 'unknown', confidence: 0.8 }),
    mkQ({ id: 'q18', no: 18, parentId: 'q15', spans: [[1, 1]], stem: lines[0].text, type: 'unknown', confidence: 0.8 }),
  ];
  const res = canonicalizeForms({ questions: qs, sourceLines: lines });
  const parent = res.questions.find(q => q.id === 'q15')!;
  assert.equal(parent.type, 'matching');
  assert.equal(parent.options?.length, 5);
  assert.deepEqual(
    res.questions.filter(q => q.parentId === 'q15').map(q => q.stem),
    ['(16)', '(17)', '(18)'],
  );
});

test('Form 3 MATCHING-POOL (2/3): Column A (51..53) + Column B (a..d) consecutive root items attach shared pool', () => {
  const lines = [
    mkLine(1, 'A'),
    mkLine(2, '51. I have kept a diary.'),
    mkLine(3, '52. Plants absorb carbon dioxide.'),
    mkLine(4, '53. Don’t use up all the milk.'),
    mkLine(5, 'B'),
    mkLine(6, 'a. to take something in'),
    mkLine(7, 'b. cry suddenly'),
    mkLine(8, 'c. a daily record book'),
    mkLine(9, 'd. to finish something'),
  ];
  const qs: Question[] = [51, 52, 53].map((no, idx) =>
    mkQ({
      id: `q${no}`,
      no,
      sectionId: 'sec_1',
      spans: [[idx + 2, idx + 2]],
      stem: lines[idx + 1].text,
      type: 'short',
      confidence: 0.8,
    }),
  );
  const res = canonicalizeForms({ questions: qs, sourceLines: lines });
  for (const q of res.questions) {
    assert.equal(q.type, 'matching');
    assert.deepEqual(q.options?.map(o => o.text), [
      'to take something in',
      'cry suddenly',
      'a daily record book',
      'to finish something',
    ]);
  }
});

test('Form 3 MATCHING-POOL (3/3): phantom self-child (parent.no === child.no) is removed deterministically', () => {
  const lines = [
    mkLine(1, '(15) (16) (17)'),
    mkLine(2, 'a. One'),
    mkLine(3, 'b. Two'),
    mkLine(4, 'c. Three'),
  ];
  const qs: Question[] = [
    mkQ({ id: 'q15', no: 15, spans: [[1, 4]], stem: lines.map(l => l.text).join('\n'), type: 'matching', confidence: 0.8 }),
    mkQ({ id: 'q15_self', no: 15, parentId: 'q15', spans: [[1, 1]], stem: '(15)', type: 'matching', confidence: 0.8 }),
    mkQ({ id: 'q16', no: 16, parentId: 'q15', spans: [[1, 1]], stem: lines[0].text, type: 'matching', confidence: 0.8 }),
    mkQ({ id: 'q17', no: 17, parentId: 'q15', spans: [[1, 1]], stem: lines[0].text, type: 'matching', confidence: 0.8 }),
  ];
  const res = canonicalizeForms({ questions: qs, sourceLines: lines });
  assert.deepEqual(res.questions.map(q => q.no), [15, 16, 17]);
  assert.ok(!res.questions.some(q => q.parentId && q.no === 15));
});

test('Form 4 WORD-BANK (1/3): standalone comma-separated word bank line above blanked items sets fillblank', () => {
  const lines = [
    mkLine(1, '6 جملات زیر را با کلمات داده شده کامل کنید.'),
    mkLine(2, 'repeatedly, forever, demand, arrange'),
    mkLine(3, '19. We will need to ...... the chairs around the table.'),
  ];
  const q = mkQ({ id: 'q19', no: 19, spans: [[3, 3]], stem: lines[2].text, type: 'short', confidence: 0.8 });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'fillblank');
  assert.ok(res.questions[0].receipt?.ruleChain.includes(FORM_RULE_ID['WORD-BANK']));
});

test('Form 4 WORD-BANK (2/3): inline word bank in row instruction sets fillblank without leaking across row boundary', () => {
  const lines = [
    mkLine(1, '9 جمله زیر را با ضمیر موصولی مناسب whom, who یا which کامل کنید.'),
    mkLine(2, '31. A cheetah is an animal ...... .'),
    mkLine(3, '10 جمله شرطی زیر را با نوشتن یک جمله کامل کنید.'),
    mkLine(4, '32. If I had wings, I ...... .'),
  ];
  const qs: Question[] = [
    mkQ({ id: 'q31', no: 31, spans: [[2, 2]], stem: lines[1].text, type: 'unknown', confidence: 0.8 }),
    mkQ({ id: 'q32', no: 32, spans: [[4, 4]], stem: lines[3].text, type: 'unknown', confidence: 0.8 }),
  ];
  const res = canonicalizeForms({ questions: qs, sourceLines: lines });
  assert.equal(res.questions.find(q => q.no === 31)?.type, 'fillblank');
  assert.equal(res.questions.find(q => q.no === 32)?.type, 'unknown');
});

test('Form 4 WORD-BANK (3/3): bogus unsplit word-bank options on blanked question are cleared and type corrected', () => {
  const lines = [
    mkLine(1, 'repeatedly, forever, demand, arrange'),
    mkLine(2, '20. The ...... for organic food is increasing.'),
  ];
  const q = mkQ({
    id: 'q20',
    no: 20,
    spans: [[2, 2]],
    stem: lines[1].text,
    type: 'mcq',
    options: [
      { key: 'a', spans: [[1, 1]], text: lines[0].text },
      { key: 'b', spans: [[1, 1]], text: lines[0].text },
    ],
    confidence: 0.5,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'fillblank');
  assert.equal(res.questions[0].options, undefined);
});

test('Form 5 UNSCRAMBLE (1/3): slash fragments ending in "/." set type short and preserve verbatim order without reordering', () => {
  const raw = '59 . work / some workers / who /and teachers/ in the village / there are /.';
  const lines = [mkLine(1, raw)];
  const q = mkQ({ id: 'q59', no: 59, spans: [[1, 1]], stem: raw, type: 'unknown', confidence: 0.8 });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'short');
  assert.equal(res.questions[0].stem, raw);
  assert.ok(res.questions[0].receipt?.ruleChain.includes(FORM_RULE_ID.UNSCRAMBLE));
});

test('Form 5 UNSCRAMBLE (2/3): dash fragments ending in "- ?" match while letter-blank "h - - - - - -" is rejected', () => {
  const lines = [
    mkLine(1, '60. wrote - didn’t - a letter - the girl - she - ?'),
    mkLine(2, '22. Their grandmother is hard of h - - - - - -.'),
  ];
  const qs: Question[] = [
    mkQ({ id: 'q60', no: 60, spans: [[1, 1]], stem: lines[0].text, type: 'unknown', confidence: 0.8 }),
    mkQ({ id: 'q22', no: 22, spans: [[2, 2]], stem: lines[1].text, type: 'unknown', confidence: 0.8 }),
  ];
  const res = canonicalizeForms({ questions: qs, sourceLines: lines });
  assert.equal(res.questions.find(q => q.no === 60)?.type, 'short');
  assert.ok(res.questions.find(q => q.no === 60)?.receipt?.ruleChain.includes(FORM_RULE_ID.UNSCRAMBLE));
  assert.equal(res.questions.find(q => q.no === 22)?.type, 'unknown');
  assert.ok(!res.questions.find(q => q.no === 22)?.receipt?.ruleChain.includes(FORM_RULE_ID.UNSCRAMBLE));
});

test('Form 5 UNSCRAMBLE (3/3): leaked trailing instruction lines after "/." are clipped from stem spans', () => {
  const lines = [
    mkLine(1, '62 . be / by the teacher / the parents / called / should /.'),
    mkLine(2, 'در این قسمت فقط به یکی از بخش‌ها پاسخ دهید.'),
  ];
  const q = mkQ({
    id: 'q62',
    no: 62,
    spans: [[1, 2]],
    stem: lines.map(l => l.text).join('\n'),
    type: 'long',
    confidence: 0.8,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'short');
  assert.equal(res.questions[0].stem, lines[0].text);
});

test('Form 6 DIALOGUE (1/3): two-line "A: / B:" stem misclassified as fake a/b MCQ options is restored to short stem', () => {
  const lines = [
    mkLine(1, '10. A: How often do you exercise?'),
    mkLine(2, 'B: About twice a week.'),
  ];
  const q = mkQ({
    id: 'q10',
    no: 10,
    spans: [[1, 1]],
    stem: lines[0].text,
    type: 'mcq',
    options: [
      { key: 'a', spans: [[1, 1]], text: 'How often do you exercise?' },
      { key: 'b', spans: [[2, 2]], text: 'About twice a week.' },
    ],
    confidence: 0.6,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'short');
  assert.equal(res.questions[0].options, undefined);
  assert.equal(res.questions[0].stem, `${lines[0].text}\n${lines[1].text}`);
  assert.ok(res.questions[0].receipt?.ruleChain.includes(FORM_RULE_ID.DIALOGUE));
});

test('Form 6 DIALOGUE (2/3): genuine 4-option MCQ with "A: / B:" stem keeps mcq type and all 4 options', () => {
  const lines = [
    mkLine(1, '28. A: What is the problem?'),
    mkLine(2, 'B: The windows ...... by the boys.'),
    mkLine(3, 'a) are breaking  b) have broken  c) broke  d) have been broken'),
  ];
  const q = mkQ({
    id: 'q28',
    no: 28,
    spans: [[1, 3]],
    stem: lines.map(l => l.text).join('\n'),
    type: 'mcq',
    confidence: 0.85,
  });
  const res = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(res.questions[0].type, 'mcq');
  assert.equal(res.questions[0].options?.length, 4);
  assert.ok(!res.questions[0].receipt?.ruleChain.includes(FORM_RULE_ID.DIALOGUE));
});

test('Form 6 DIALOGUE (3/3): idempotence & provenance — second pass yields 0 deltas', () => {
  const lines = [mkLine(1, '7. A: Where is the library?'), mkLine(2, 'B: Next to the bank.')];
  const q = mkQ({
    id: 'q7',
    no: 7,
    spans: [[1, 2]],
    stem: `${lines[0].text}\n${lines[1].text}`,
    type: 'unknown',
    confidence: 0.8,
  });
  const pass1 = canonicalizeForms({ questions: [q], sourceLines: lines });
  assert.equal(pass1.questions[0].type, 'short');
  assert.ok(pass1.questions[0].receipt?.ruleChain.includes(FORM_RULE_ID.DIALOGUE));
  const pass2 = canonicalizeForms({ questions: pass1.questions, sourceLines: lines });
  assert.equal(pass2.deltas.length, 0);
});

test('C3: read-the-text instructions create hard PASSAGE boundaries and >500-char stem brake re-segments or flags STEM_OVERLONG', () => {
  const prose = [
    'When early humans hunted and collected food, they could not control their environment at all.',
    'When humans learned to make fire, however, they became skillful at changing their environment.',
    'Parts of forests were changed to lands to increase the growth of grass and feed wild animals.',
    'This improvement ended in farming and also keeping animals as reliable sources of human food.',
    'Fire also provided the means for cooking plants which were never used before in human history.',
    'After meeting the simple need for food, early humans began founding cities and living in groups.',
  ];
  const lines = [
    mkLine(1, '38. Can doing good small things show your respect to your parents? (Give an example)'),
    mkLine(2, '4 متن زیر را بخوانید و به سوالات داده شده هر قسمت پاسخ دهید. 12'),
    ...prose.map((p, idx) => mkLine(idx + 3, p)),
  ];
  const segRes = segmentDocument({ lines });
  assert.ok(segRes.segments.some(s => s.kind === 'passage' && s.startLine === 3));

  const sec = { id: 'sec_1', index: 1, title: 'Reading', spans: [[1, lines.length]] as Array<[number, number]> };
  const gluedQ38 = mkQ({
    id: 'q38',
    no: 38,
    sectionId: 'sec_1',
    spans: [[1, lines.length]],
    stem: lines.map(l => l.text).join('\n'),
    type: 'short',
    confidence: 0.8,
  });
  assert.ok((gluedQ38.stem || '').length > 500);
  const repaired = canonicalizeForms({ questions: [gluedQ38], sourceLines: lines, sections: [sec] });
  assert.equal(repaired.questions[0].stem, lines[0].text);
  assert.ok((repaired.questions[0].stem || '').length < 300);
  assert.ok((repaired.sections[0].passage || '').includes('When early humans hunted'));

  const singleLongLine = mkLine(1, `1. ${'Long single-question stem content without passage boundary. '.repeat(12)}`);
  const longQ = mkQ({ id: 'q1', no: 1, spans: [[1, 1]], stem: singleLongLine.text, type: 'essay', confidence: 0.9 });
  const flagged = canonicalizeForms({ questions: [longQ], sourceLines: [singleLongLine] });
  assert.ok(flagged.flags.some(f => f.code === 'STEM_OVERLONG'));
});

// ============================================================================
// Part D — Assistant `canonicalize_question` & Executor Confidence Floor
// ============================================================================

test('D1: canonicalize_question runs locally (0 model calls) on single question and scope="exam", and undoes via snapshot journal', async () => {
  const lines = [
    mkLine(1, '5. His jacket wasn’t new. a) True b) False'),
    mkLine(2, '6. Her mother told him to call. a) True b) False'),
  ];
  let doc = mkBaseDoc(lines, [
    {
      id: 'q5',
      no: 5,
      sectionId: 'sec_1',
      spans: [[1, 1]],
      stem: lines[0].text,
      type: 'mcq',
      points: 5,
      options: [
        { key: 'a', spans: [[1, 1]], text: lines[0].text },
        { key: 'b', spans: [[1, 1]], text: lines[0].text },
      ],
      confidence: 0.4,
    },
    {
      id: 'q6',
      no: 6,
      sectionId: 'sec_1',
      spans: [[2, 2]],
      stem: lines[1].text,
      type: 'mcq',
      points: 5,
      options: [
        { key: 'a', spans: [[2, 2]], text: lines[1].text },
        { key: 'b', spans: [[2, 2]], text: lines[1].text },
      ],
      confidence: 0.85,
    },
  ]);

  let modelCalls = 0;
  let settings = structuredClone(DEFAULT_SETTINGS);
  const snapshots = new Map<string, ExamDoc>();
  const registry = createToolRegistry({
    getDoc: () => doc,
    getSettings: () => settings,
    updateDoc: async d => { doc = d; },
    updateSettings: async s => { settings = s; },
    retryMissing: async d => d,
  });
  const runtime: AgentRuntime = {
    getDoc: () => doc,
    getSettings: () => settings,
    registry,
    snapshot: async () => {
      const id = `undo_${snapshots.size}`;
      snapshots.set(id, structuredClone(doc));
      return id;
    },
    persist: async () => {},
    model: async () => {
      modelCalls++;
      return mkReply('Done.');
    },
  };
  const undo = (undoId: string) => {
    const prev = snapshots.get(undoId);
    assert.ok(prev, `missing snapshot ${undoId}`);
    doc = structuredClone(prev!);
  };

  const diag = (await registry.diagnose_missing.execute({})) as any;
  assert.ok(diag.actionQueue.some((a: any) => a.tool === 'canonicalize_question'));

  const singleDirect = (await registry.canonicalize_question.execute({ questionId: 'q5' })) as any;
  assert.equal(singleDirect.ok, true);
  assert.equal(singleDirect.delta.changedCount, 1);
  assert.ok(singleDirect.delta.formsApplied.includes(FORM_RULE_ID.TRUEFALSE));
  assert.equal(doc.questions[0].type, 'truefalse');
  assert.deepEqual(doc.questions[0].options?.map(o => o.text), ['True', 'False']);
  assert.equal(doc.questions[1].type, 'mcq');

  doc.questions[0] = {
    ...doc.questions[0],
    type: 'mcq',
    spans: [[1, 1]],
    stem: lines[0].text,
    options: [
      { key: 'a', spans: [[1, 1]], text: lines[0].text },
      { key: 'b', spans: [[1, 1]], text: lines[0].text },
    ],
  };
  const session = newAgentSession(doc.id);
  let scriptedTurn = 0;
  runtime.model = async () => {
    scriptedTurn++;
    if (scriptedTurn === 1) {
      return mkReply('```tool\n{"name":"canonicalize_question","args":{"questionId":"q5"}}\n```');
    }
    if (scriptedTurn === 2) {
      return mkReply('```tool\n{"name":"get_exam_health","args":{}}\n```');
    }
    return mkReply('Canonicalized.');
  };
  await runAgentTurn(runtime, session, 'canonicalize q5');
  assert.equal(doc.questions[0].type, 'truefalse');
  assert.equal(doc.questions[1].type, 'truefalse');

  const firstMutEvent = session.events.find(e => e.tool?.name === 'canonicalize_question' && e.undoId);
  assert.ok(firstMutEvent?.undoId, 'mutation journal recorded undoId for canonicalize_question');

  undo(firstMutEvent!.undoId!);
  assert.equal(doc.questions[0].type, 'mcq');
  assert.equal(doc.questions[0].stem, lines[0].text);
  assert.equal(doc.questions[1].type, 'mcq');

  const examRes = (await registry.canonicalize_question.execute({ scope: 'exam' })) as any;
  assert.equal(examRes.ok, true);
  assert.equal(examRes.delta.changedCount, 2);
  assert.equal(doc.questions[0].type, 'truefalse');
  assert.equal(doc.questions[1].type, 'truefalse');
  assert.equal(modelCalls, 0);
});

test('D2: executor auto-canonicalizes shape problems on "fix it" (0 model calls) and emits one-line needs-human when below floor', async () => {
  const lines = [
    mkLine(1, '1. Early humans discovered how to make fire. a) True b) False'),
    mkLine(2, '2. Garbled shared option line with identical poles'),
  ];
  let doc = mkBaseDoc(lines, [
    {
      id: 'q1',
      no: 1,
      sectionId: 'sec_1',
      spans: [[1, 1]],
      stem: lines[0].text,
      type: 'mcq',
      points: 5,
      options: [
        { key: 'a', spans: [[1, 1]], text: lines[0].text },
        { key: 'b', spans: [[1, 1]], text: lines[0].text },
      ],
      confidence: 0.4,
    },
    {
      id: 'q2',
      no: 2,
      sectionId: 'sec_1',
      spans: [[2, 2]],
      stem: lines[1].text,
      type: 'mcq',
      points: 5,
      options: [
        { key: 'a', spans: [[2, 2]], text: 'same pole' },
        { key: 'b', spans: [[2, 2]], text: 'same pole' },
      ],
      confidence: 0.35,
      flags: ['OPTION_DUPLICATE'],
    },
  ]);

  let modelCalls = 0;
  let settings = structuredClone(DEFAULT_SETTINGS);
  const registry = createToolRegistry({
    getDoc: () => doc,
    getSettings: () => settings,
    updateDoc: async d => { doc = d; },
    updateSettings: async s => { settings = s; },
    retryMissing: async d => d,
  });
  const runtime: AgentRuntime = {
    getDoc: () => doc,
    getSettings: () => settings,
    registry,
    snapshot: async () => 'undo_0',
    persist: async () => {},
    model: async () => {
      modelCalls++;
      return mkReply('unexpected model call');
    },
  };

  const session = newAgentSession(doc.id);
  await runAgentTurn(runtime, session, 'fix it');

  assert.equal(modelCalls, 0);
  const q1 = doc.questions.find(q => q.no === 1)!;
  assert.equal(q1.type, 'truefalse');
  assert.deepEqual(q1.options?.map(o => o.text), ['True', 'False']);
  const allEventTexts = session.events.map(e => e.text || '').join('\n');
  assert.ok(allEventTexts.includes('needs-human:'), `expected needs-human in events, got:\n${allEventTexts}`);
  assert.ok(allEventTexts.includes('Q2'));
});

// ============================================================================
// Part E & Part F — Section Truth Locking Test & Field Replay
// ============================================================================

test('E1: detectSectionHeaders reproduces exact 8 headers [7,46,65,92,151,178,206,221] on 323-line extraction and ignores sub-headers', () => {
  const fixturePath = path.join(
    process.cwd(),
    'test/fixtures/corpus/english-final-13991009pq89w65173/source-lines.json',
  );
  const lines = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SourceLine[];
  assert.equal(lines.length, 323);
  const examLines = lines.filter(l => l.page <= 6);
  const headers = detectSectionHeaders(examLines);
  assert.deepEqual(headers.map(h => h.headerLine), [7, 46, 65, 92, 151, 178, 206, 221]);
  assert.deepEqual(headers.map(h => h.title), [
    'Listening',
    'Vocabulary',
    'Grammar',
    'Reading',
    'Writing',
    'Vocabulary',
    'Grammar',
    'Writing',
  ]);
  const subHeaders: SourceLine[] = [
    mkLine(1, '1 .کامل کنید جمله ی زیر را با ضمیر موصولی مناسب 9'),
    mkLine(2, '4 متن زیر رابخوانید و به سوالات داده شده هر قسمت پاسخ دهید . 12'),
    mkLine(3, 'B: she likes reading books and writing stories.'),
  ];
  assert.deepEqual(detectSectionHeaders(subHeaders), []);
});

test('F1 & F2: acceptance corpus and English — 11_structured (2).json field replay achieve 8 sections and 0/0/0 shape audit', async () => {
  const corpus = await runCorpus({ strict: true, print: false, mode: 'legacy' });
  assert.equal(corpus.ok, true);
  const acc = corpus.results.find(r => r.exam === 'english-final-13991009pq89w65173')!;
  assert.equal(acc.recall, '67/67');
  assert.equal(acc.sections, '8/8');
  assert.equal(acc.total, '48');
  assert.equal(acc.spotChecks, '12/12');
  assert.equal(acc.shapeAuditLabel, '0/0/0');
  assert.equal(acc.preAssistantChildren, '15:16,17,18;63:64,65,66');

  const exportPath = path.join(
    process.cwd(),
    'test/fixtures/field-exports/English — 11_structured (2).json',
  );
  const exportedDoc = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  const replay = replayFieldExport(exportedDoc, 'English — 11_structured (2).json');
  assert.equal(replay.sourceLineCount, 323);
  assert.equal(replay.sections.exported, 9);
  assert.equal(replay.sections.replayed, 8);
  assert.deepEqual(replay.shapeBefore, {
    optionIncludesStem: 6,
    duplicateSiblingStems: 3,
    overlongStems: 1,
  });
  assert.deepEqual(replay.shapeAfter, {
    optionIncludesStem: 0,
    duplicateSiblingStems: 0,
    overlongStems: 0,
  });
  assert.equal(replay.perClassDiffs.bogusSubheaderSectionsRemoved, 1);
  assert.equal(replay.perClassDiffs.phantomSelfChildrenRemoved, 1);
  assert.equal(replay.perClassDiffs.overlongPassageStemsFixed, 1);
  assert.equal(replay.perClassDiffs.siblingDuplicateStemsFixed, 3);
  assert.deepEqual(
    computeShapeAudit(replay.replayedQuestions),
    { optionIncludesStem: 0, duplicateSiblingStems: 0, overlongStems: 0 },
  );

  // Deep-sweep quality invariants on replayed field questions:
  // 1) Presentation-form watermarks & page-continuation footers never leak into stems/options (Q14, Q30, Q50).
  const q14 = replay.replayedQuestions.find(q => q.no === 14)!;
  const q30 = replay.replayedQuestions.find(q => q.no === 30)!;
  const q50 = replay.replayedQuestions.find(q => q.no === 50)!;
  assert.ok(!/مرکز|ﻣﺮکﺰ|اداﻣﻪ|ادامه/u.test(q14.stem || ''), `Q14 stem leaked watermark: ${q14.stem}`);
  assert.equal(q30.options?.[3]?.text, 'increases');
  assert.ok(!/مرکز|ﻣﺮکﺰ|اداﻣﻪ|ادامه/u.test(q50.stem || ''), `Q50 stem leaked watermark: ${q50.stem}`);

  // 2) RTL reversed decimal marks in the answer key (`) 5 (./`, `( 5 / 0 )`) parse as 0.5, not 5.
  const q5 = replay.replayedQuestions.find(q => q.no === 5)!;
  const q6 = replay.replayedQuestions.find(q => q.no === 6)!;
  assert.equal(q5.points, 0.5);
  assert.equal(q6.points, 0.5);

  // 3) Conjunction word-bank row (Q45–Q48) canonicalizes all 4 items to fillblank, and Q63 has no bogus OPTION_SPLIT_FAILED.
  for (const no of [45, 46, 47, 48]) {
    assert.equal(replay.replayedQuestions.find(q => q.no === no)?.type, 'fillblank', `Q${no} should be fillblank`);
  }
  const q63 = replay.replayedQuestions.find(q => q.no === 63)!;
  assert.ok(!(q63.flags || []).includes('OPTION_SPLIT_FAILED'));
});

