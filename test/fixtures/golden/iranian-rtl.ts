import type { SourceLine } from '../../../src/types';

type FixtureRow = { text: string; questionNo?: number; key?: true };

const questionRow = (questionNo: number, text: string): FixtureRow => ({ questionNo, text: `${questionNo}. ${text}` });
const questionText = (questionNo: number): string => {
  if (questionNo === 1) return 'What is your name? a) Ali b) Reza c) Sara.';
  if (questionNo === 2) return 'Where do you live? a) Tehran b) Isfahan.';
  if (questionNo === 3) return 'Listening dialogue: A: Hello. B: Hi.';
  if (questionNo === 4) return 'Fill the blank: Hello ____.';
  if (questionNo === 5) return 'Grammar: He _____ to school yesterday. الف) go ب) went ج) gone.';
  if (questionNo === 6) return 'Synonym of happy? a) sad b) joyful c) angry.';
  if (questionNo === 7) return 'Vocabulary item near the kanoon.ir watermark.';
  if (questionNo === 8) return 'Vocabulary item with Arabic ي variant: علي vs علی.';
  if (questionNo === 15) return 'Read the science passage for the grouped questions 15 through 18.';
  if (questionNo >= 16 && questionNo <= 18) return `Passage sub-question ${questionNo}.`;
  if (questionNo === 21) return 'Reading passage: Long text about history.';
  if (questionNo >= 22 && questionNo <= 24) return `Question about the reading passage ${questionNo}.`;
  if (questionNo === 25) return 'Writing response.';
  if (questionNo === 60) return 'Dialogue blank item one.';
  if (questionNo === 61 || questionNo === 62) return `Dialogue blank item ${questionNo}.`;
  if (questionNo === 63) return 'Choose the correct response: a) I am fine b) I fine c) Me fine d) Fine I am.';
  if (questionNo >= 64) return `Next real question after the lettered options: ${questionNo}.`;
  return `Persian/English mixed examination question ${questionNo}.`;
};

const rows: FixtureRow[] = [
  { text: 'بسمه تعالی' },
  { text: 'آزمون زبان انگلیسی پایه ۱۲ — نمره کل ۴۰' },
  { text: 'بخش شنیداری Listening (نمره ۵)' },
  ...Array.from({ length: 5 }, (_, index) => questionRow(index + 1, questionText(index + 1))),
  { text: 'Vocabulary بخش واژگان (نمره ۱۰)' },
  ...Array.from({ length: 15 }, (_, index) => questionRow(index + 6, questionText(index + 6))),
  { text: 'Reading درک مطلب (نمره ۱۰)' },
  ...Array.from({ length: 47 }, (_, index) => questionRow(index + 21, questionText(index + 21))),
  { text: 'راهنمای تصحیح', key: true },
  { text: '1. A 2. B 3. C 4. D 5. B 6. B 7. A 8. A 9. B 10. C', key: true },
  { text: '11. A 12. B 13. C 14. A 15. A 16. B 17. C 18. D', key: true },
  { text: '60. A 61. B 62. C 63. A 64. B 65. C 66. D 67. A', key: true },
];

const questionLineByNo = new Map<number, number>();
rows.forEach((row, index) => {
  if (row.questionNo !== undefined) questionLineByNo.set(row.questionNo, index + 1);
});

const sourceLines: SourceLine[] = rows.map((row, index) => ({
  id: `L${String(index + 1).padStart(4, '0')}`,
  // Keep the key on a dedicated page. The production key-territory guard intentionally
  // treats an early key heading as a page-level boundary.
  page: row.key ? 5 : 1 + Math.floor(index / 20),
  text: row.text,
}));

export const fixture = {
  id: 'iranian-rtl',
  description: 'Iranian RTL mix: Persian/Arabic ي variants, dedicated key page, grouped passage questions, dialogue blanks, and lettered options.',
  sourceLines,
  // Scripted model response: compact wire v2 with every synthetic printed number anchored to its source line.
  mockStructureResponses: [
    {
      wire: {
        m: { subject: 'English', grade: '12', totalPoints: 40, language: 'fa' },
        s: [
          { id: 'sec_1', index: 1, p: [[1, questionLineByNo.get(5)!]], kind: 'Listening' },
          { id: 'sec_2', index: 2, p: [[questionLineByNo.get(6)! - 1, questionLineByNo.get(20)!]], kind: 'Vocabulary' },
          { id: 'sec_3', index: 3, p: [[questionLineByNo.get(21)! - 1, questionLineByNo.get(67)!]], kind: 'Reading' },
        ],
        q: Array.from({ length: 67 }, (_, index) => {
          const questionNo = index + 1;
          const line = questionLineByNo.get(questionNo)!;
          return { n: questionNo, s: questionNo <= 5 ? 'sec_1' : questionNo <= 20 ? 'sec_2' : 'sec_3', t: 'm', p: [[line, line]], v: 40 / 67, c: questionNo === 63 ? 6 : 9 };
        }),
      },
    },
  ],
  expected: {
    questionCount: 67,
    numbers: Array.from({ length: 67 }, (_, index) => index + 1),
    pointsTotal: 40,
    sectionCount: 3,
    titlesContain: ['Listening', 'Vocabulary', 'Reading'],
    optionBlobCount: 0,
    phantomMissing: [],
    imagePlacement: 0,
  },
};

export default fixture;
