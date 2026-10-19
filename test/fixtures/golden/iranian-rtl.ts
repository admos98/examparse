import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[], page=1): SourceLine[] => texts.map((t,i)=>({ id:`L${String(i+1).padStart(4,'0')}`, page: page + Math.floor(i/20), text:t }));
export const fixture = {
  id: 'iranian-rtl',
  description: 'Iranian RTL mix: Persian/Arabic ي variants, key pages, group 15-18, lettered 63 a-d, dialogue blanks, multi-item lines, watermark',
  sourceLines: makeLines([
    'بسمه تعالی',
    'آزمون زبان انگلیسی پایه ۱۲ — نمره کل ۴۰',
    'بخش شنیداری Listening (نمره ۵)',
    '1. What is your name? a) Ali b) Reza c) Sara', // multi-item line? Actually 2-per-line simulation
    '2. Where do you live? a) Tehran b) Isfahan',
    '3. Listening dialogue: A: Hello ... B: Hi ... ۴. Fill the blank: Hello ____',
    '4. Choose correct form ...',
    '5. Grammar: He _____ to school yesterday. الف) go ب) went ج) gone',
    'Vocabulary بخش واژگان (نمره ۱۰)',
    '6. Synonym of \"happy\"? a) sad b) joyful c) angry',
    '7. www.kanoon.ir watermark should be furniture',
    '8. Vocabulary item with Arabic ي variant: علي vs علی',
    '9. Another vocab',
    '10. Vocab 10',
    '11. Vocab 11',
    '12. Vocab 12',
    '13. Vocab 13',
    '14. Vocab 14',
    // Group 15-18 as parent with enumerated children in one stem (group question)
    '15. Read the passage and answer 15–18: Passage about science. (15) What is ... (16) Where ... (17) Why ... (18) How ...',
    '19. Grammar continued',
    '20. Grammar 20',
    'Reading درک مطلب (نمره ۱۰)',
    '21. Reading passage: Long text about history... (passage kept with section)',
    '22. Q about passage',
    '23. Q about passage',
    '24. Q about passage',
    '25. Writing',
    'Dialogue blanks with … markers:',
    '60. A: How are you? …61… B: Fine …62…',
    '63. a) I am fine b) I fine c) Me fine d) Fine I am', // this is 63 with lettered subparts a-d that should NOT become 64,65,66 phantom
    // Actually 63 a-d is one question with sub-options, not 4 questions
    '64. Next real question after subparts',
    '65. Question 65',
    '66. Question 66',
    '67. Final question',
    'راهنمای تصحیح',
    '1. A 2. B 3. C 4. D 5. B 6. B 7. A 8. A 9. B 10. C',
    '11. A 12. B 13. C 14. A 15. A 16. B 17. C 18. D',
    '60. A 61. B 62. C 63. A 64. B 65. C 66. D 67. A',
  ]),
  // Scripted model responses: compact wire v2
  mockStructureResponses: [
    {
      // Single chunk covering all 67? but we will split
      wire: {
        m: { subject: 'English', grade: '12', totalPoints: 40, language: 'fa' },
        s: [
          { id: 'sec_1', index: 1, p: [[1,8]], kind: 'Listening' },
          { id: 'sec_2', index: 2, p: [[9,20]], kind: 'Vocabulary' },
          { id: 'sec_3', index: 3, p: [[21,27]], kind: 'Reading' },
        ],
        q: [
          // 1-14 normal + 15 group parent + 16-18 as children? For coverage we expect 67 numbers. Here we model group 15 as parent with 3 children g=15
          // Use v2 compact: n=number, s=section, t=type, p=spans, v=points, o=options, c=confidence
          ...Array.from({length:14}, (_,i)=>({ n:i+1, s:'sec_1', t:'m', p:[[i+4,i+4]], v:0.5, c:9 })),
          { n:15, s:'sec_2', t:'m', p:[[15,15]], v:1, c:9, g: undefined },
          { n:16, s:'sec_2', t:'m', p:[[15,15]], v:1, c:9, g:15 },
          { n:17, s:'sec_2', t:'m', p:[[15,15]], v:1, c:9, g:15 },
          { n:18, s:'sec_2', t:'m', p:[[15,15]], v:1, c:9, g:15 },
          ...Array.from({length:48}, (_,i)=>{
            const n = i+19;
            // 63 is lettered subpart case — should be one question, not 4
            return { n, s: n<=24?'sec_3':'sec_2', t:'m', p:[[15 + i +1, 15 + i +1]], v:0.5, c: n===63?6:9 };
          }),
          // 63 has confidence 6 to trigger low confidence handling
        ]
      }
    }
  ],
  expected: {
    questionCount: 67,
    numbers: Array.from({length:67}, (_,i)=>i+1),
    pointsTotal: 40,
    sectionCount: 3,
    titlesContain: ['Listening', 'Vocabulary', 'Reading'],
    optionBlobCount: 0,
    phantomMissing: [],
    keyTerritoryLines: [28,30],
    expectedMissing: [],
    imagePlacement: 0,
  }
};
export default fixture;
