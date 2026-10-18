/** Same Iranian printed set, independently spelled with Arabic/Persian letters/digits. */
const base = [
  'ردیف | سؤالات | نمره',
  'شنیداری',
  '(15) (16) (17) (18)',
  '۳۱. واژه می‌شود؛ کدام؟',
  '63. a) Original … 64. b) ORIGINAL',
  'Dialogue: ...9.......',
  'گفتگو ……۹……',
  'Years 1399, 2024; time 6:30; fraction 1/5; decimal 1.5',
];
export const printedSet = [9, 15, 16, 17, 18, 31, 63, 64];
export const trilingualFixtures = [
  { name: 'Persian', questions: base, key: 'راهنمای تصحیح' },
  {
    name: 'Arabic spelling U064A U0643',
    questions: base.map((s) =>
      s.replaceAll('ی', 'ي').replaceAll('ک', 'ك').replace('۳۱', '٣١'),
    ),
    key: 'راهنماي تصحيح',
  },
  {
    name: 'English',
    questions: base.map((s) => s.replace('۳۱', '31')),
    key: 'Answer Key',
  },
  {
    name: 'Mixed',
    questions: base.map((s) => s.replace('۳۱', '٣١')),
    key: 'Language exam | کلید پاسخ',
  },
  {
    name: 'Tatweel diacritics',
    questions: base.map((s) => s.replace('کدام', 'کَـدام')),
    key: 'راهنـمَاي تَصحِيح',
  },
  {
    name: 'Fullwidth',
    questions: base.map((s) => s.replace('۳۱', '３１')),
    key: 'Mark Scheme',
  },
  { name: 'ZWNJ', questions: base, key: 'پاسخنامه تشریحی' },
];
