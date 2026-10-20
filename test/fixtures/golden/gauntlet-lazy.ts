import type { SourceLine } from '../../../src/types';

/**
 * F1 — GOLDEN GAUNTLET. An Iranian-layout exam parsed by a deliberately DUMB scripted
 * model: every question span is a lazy ONE-LINE anchor (options/continuations unclaimed),
 * meta.totalPoints is wrong (25 vs the printed 20), one section span swallows two headers,
 * two questions are filed in the wrong section, and the model returns no options at all.
 *
 * Deterministic gap completion + option synthesis + local gates must still yield:
 * 0 STEM_HOLLOW · every MCQ ≥2 options · orphan rate 0 · totalPoints == 20 ·
 * sections == the 4 printed headers · coverage green (or honest partial).
 */

type Row = { text: string; page: number; questionNo?: number; key?: true; header?: string };

const rows: Row[] = [
  // ---- page 1: front matter, Listening, Vocabulary ----
  { page: 1, text: 'بسمه تعالی' },
  { page: 1, text: 'دبیرستان نمونه — آزمون نوبت اول — زبان انگلیسی پایه دهم' },
  { page: 1, text: 'نام و نام خانوادگی: ................ شماره کلاس: ......' },
  { page: 1, text: 'بخش شنیداری Listening (نمره ۴)', header: 'Listening' },
  { page: 1, text: 'به مکالمه گوش دهید و جاهای خالی را کامل کنید.' },
  { page: 1, text: '1. Tom: Where is the post office? Sara: It is ______ the bank.', questionNo: 1 },
  { page: 1, text: 'a) next to b) between c) under d) behind' },
  { page: 1, text: '2. The train leaves at ______ in the morning.', questionNo: 2 },
  { page: 1, text: 'a) seven b) eleven c) nine d) ten' },
  { page: 1, text: '3. Listen and write the missing word:', questionNo: 3 },
  { page: 1, text: 'The weather in Shiraz is usually ______ in spring.' },
  { page: 1, text: '4. True or false: the speaker lives in a big city.', questionNo: 4 },
  { page: 1, text: 'a) True b) False' },
  { page: 1, text: 'Vocabulary واژگان (نمره ۶)', header: 'Vocabulary' },
  { page: 1, text: 'گزینه درست را انتخاب کنید.' },
  { page: 1, text: '5. A person who writes books for a living is called', questionNo: 5 },
  { page: 1, text: 'an ______.' },
  { page: 1, text: 'a) author' },
  { page: 1, text: 'b) actor' },
  { page: 1, text: 'c) engineer' },
  { page: 1, text: 'd) farmer' },
  { page: 1, text: '6. The opposite of "generous" is ______.', questionNo: 6 },
  { page: 1, text: 'الف) selfish ب) kind ج) brave د) honest' },
  { page: 1, text: 'www-kanoon-ir' },
  { page: 1, text: '۱' },
  // ---- page 2: Vocabulary continued, Grammar ----
  { page: 2, text: 'دبیرستان نمونه — آزمون نوبت اول — زبان انگلیسی پایه دهم' },
  { page: 2, text: '7. Match the words with their definitions: a device that shows the time', questionNo: 7 },
  { page: 2, text: 'a) clock b) mirror c) ladder d) basket' },
  { page: 2, text: '8. Fill in the blank with a suitable word from the box:', questionNo: 8 },
  { page: 2, text: 'My grandmother always tells us interesting ______ about the past.' },
  { page: 2, text: '(stories / mountains / tickets / hobbies)' },
  { page: 2, text: '9. Write the Persian meaning of the underlined word: She is very polite.', questionNo: 9 },
  { page: 2, text: '10. Odd one out:', questionNo: 10 },
  { page: 2, text: 'a) apple b) banana c) carrot d) orange' },
  { page: 2, text: 'Grammar گرامر (نمره ۵)', header: 'Grammar' },
  { page: 2, text: 'با توجه به قواعد دستوری گزینه صحیح را انتخاب کنید.' },
  { page: 2, text: '11. They ______ football every Friday afternoon.', questionNo: 11 },
  { page: 2, text: 'a) play b) plays c) playing d) played' },
  { page: 2, text: '12. My brother is ______ than me.', questionNo: 12 },
  { page: 2, text: 'a) tall b) taller c) tallest d) the tall' },
  { page: 2, text: '13. Put the words in the correct order:', questionNo: 13 },
  { page: 2, text: 'yesterday / went / to / the / museum / we' },
  { page: 2, text: '......................................................' },
  { page: 2, text: '14. Choose the correct question tag: She can swim, ______?', questionNo: 14 },
  { page: 2, text: 'a) can she b) cannot she c) can\'t she d) does she' },
  { page: 2, text: '15. There ______ a lot of people at the party last night.', questionNo: 15 },
  { page: 2, text: 'a) was b) were c) is d) are' },
  { page: 2, text: 'www-kanoon-ir' },
  { page: 2, text: '۲' },
  // ---- page 3: Reading ----
  { page: 3, text: 'دبیرستان نمونه — آزمون نوبت اول — زبان انگلیسی پایه دهم' },
  { page: 3, text: 'Reading درک مطلب (نمره ۵)', header: 'Reading' },
  { page: 3, text: 'متن زیر را بخوانید و به سوالات پاسخ دهید.' },
  { page: 3, text: 'Ali lives in a small village near the mountains. Every morning he walks' },
  { page: 3, text: 'to school with his friends. After school he helps his father on the farm.' },
  { page: 3, text: 'In the evening he reads books about animals because he wants to be a vet.' },
  { page: 3, text: '16. Where does Ali live?', questionNo: 16 },
  { page: 3, text: 'a) in a big city b) near the sea c) in a small village d) in a school' },
  { page: 3, text: '17. What does Ali do after school?', questionNo: 17 },
  { page: 3, text: 'He ______________________________.' },
  { page: 3, text: '18. Ali wants to be a doctor.', questionNo: 18 },
  { page: 3, text: 'a) True b) False' },
  { page: 3, text: '19. Why does Ali read books about animals?', questionNo: 19 },
  { page: 3, text: 'Because ________________________________.' },
  { page: 3, text: '20. Find a word in the text that means "a person who treats sick animals".', questionNo: 20 },
  { page: 3, text: '________________' },
  { page: 3, text: 'جمع نمره: ۲۰' },
  { page: 3, text: 'موفق باشید' },
  { page: 3, text: 'www-kanoon-ir' },
  { page: 3, text: '۳' },
  // ---- page 4: key ----
  { page: 4, text: 'راهنمای تصحیح', key: true },
  { page: 4, text: '1. A 2. C 3. warm 4. B 5. A 6. A 7. A 8. stories 9. مودب 10. C', key: true },
  { page: 4, text: '11. A 12. B 13. We went to the museum yesterday. 14. C 15. B', key: true },
  { page: 4, text: '16. C 17. helps his father on the farm 18. B 19. because he wants to be a vet 20. vet', key: true },
];

const lineNoByQuestion = new Map<number, number>();
const headerLines: Array<{ title: string; line: number }> = [];
rows.forEach((row, index) => {
  if (row.questionNo !== undefined) lineNoByQuestion.set(row.questionNo, index + 1);
  if (row.header) headerLines.push({ title: row.header, line: index + 1 });
});

const sourceLines: SourceLine[] = rows.map((row, index) => ({
  id: `L${String(index + 1).padStart(4, '0')}`,
  page: row.page,
  text: row.text,
}));

const totalLines = rows.length;
const listeningStart = headerLines[0].line;
const vocabularyStart = headerLines[1].line;
const grammarStart = headerLines[2].line;
const readingStart = headerLines[3].line;
const keyStart = rows.findIndex(r => r.key) + 1;

const points: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1 };
const types: Record<number, string> = { 3: 'b', 4: 'f', 8: 'b', 9: 's', 13: 's', 17: 's', 18: 'f', 19: 's', 20: 's' };

export const fixture = {
  id: 'gauntlet-lazy',
  description: 'Golden gauntlet: Iranian layout, scripted DUMB model with lazy one-line spans, no options, wrong meta total, one section swallowing two headers and two mis-filed questions.',
  sourceLines,
  headerTitles: headerLines.map(h => h.title),
  documentTotal: 20,
  mockStructureResponses: [
    {
      wire: {
        m: { subject: 'English', grade: '10', totalPoints: 25, language: 'fa' },
        s: [
          { id: 'sec_1', index: 1, p: [[1, vocabularyStart - 1]], kind: 'Listening' },
          // Swallows Vocabulary AND Grammar (SECTION_SPLIT_LOCAL must split it at the Grammar header).
          { id: 'sec_2', index: 2, p: [[vocabularyStart, readingStart - 1]], kind: 'Vocabulary' },
          { id: 'sec_3', index: 3, p: [[readingStart, keyStart - 1]], kind: 'Reading' },
        ],
        q: Array.from({ length: 20 }, (_, index) => {
          const n = index + 1;
          const line = lineNoByQuestion.get(n)!;
          // Mis-filed: q5 (Vocabulary) claimed for Listening, q16 (Reading) claimed for sec_2.
          const section = n === 5 ? 'sec_1' : n === 16 ? 'sec_2' : n <= 4 ? 'sec_1' : n <= 15 ? 'sec_2' : 'sec_3';
          return { n, s: section, t: types[n] || 'm', p: [[line, line]], v: points[n], c: 8 };
        }),
      },
    },
  ],
  expected: {
    questionCount: 20,
    numbers: Array.from({ length: 20 }, (_, index) => index + 1),
    pointsTotal: 20,
    language: 'fa',
    sections: 4,
    mcqNumbers: [1, 2, 4, 5, 6, 7, 10, 11, 12, 14, 15, 16, 18],
  },
  lines: totalLines,
  listeningStart,
};

export default fixture;
