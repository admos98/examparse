import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[]): SourceLine[] => texts.map((t, i) => ({ id:`L${String(i + 1).padStart(4, '0')}`, page: i < 11 ? 1 : 2, text: t }));
export const fixture = {
  id: 'scanned-noisy',
  description: 'Scanned OCR noisy: tatweel, ZWNJ, broken words',
  sourceLines: makeLines([
    'آزمون فارسـی', // tatweel
    '۱. سـوال اول با\u200c فاصله‌مجازی',
    '۲. سوال دوم broken wo\u200crd',
    '۳. سوال سوم',
    '۴. سوال چهارم',
    '۵. سوال پنجم',
    '۶. سوال ششم',
    '۷. سوال هفتم',
    '۸. سوال هشتم',
    '۹. سوال نهم',
    '۱۰. سوال دهم',
    'راهنمای تصحیح',
    '۱. الف ۲. ب ۳. ج',
  ]),
  mockStructureResponses: [
    {
      wire: {
        m: { subject: 'Persian', grade: '9', totalPoints: 10, language: 'fa' },
        s: [{ id:'sec_1', index:1, p:[[1,10]], kind:'Other' }],
        q: Array.from({length:10}, (_,i)=>({ n:i+1, s:'sec_1', t:'s', p:[[i+2,i+2]], v:1, c:9 })),
      }
    }
  ],
  expected: {
    questionCount: 10,
    numbers: Array.from({length:10},(_,i)=>i+1),
    pointsTotal: 10,
    sectionCount: 1,
    titlesContain: ['Other'],
    optionBlobCount: 0,
    phantomMissing: [],
  }
};
export default fixture;
