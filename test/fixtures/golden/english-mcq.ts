import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[], page=1): SourceLine[] => texts.map((t,i)=>({ id:`L${String(i+1).padStart(4,'0')}`, page, text:t }));
export const fixture = {
  id: 'english-mcq',
  description: 'Clean English MCQ paper 2-options-per-line',
  sourceLines: makeLines([
    'English Final Exam — Grade 10 — Total 20 Marks',
    'Section A: Vocabulary (10 marks)',
    '1. Choose correct synonym: Happy a) Sad b) Joyful',
    '2. Choose antonym: Hot a) Cold b) Warm',
    '3. Fill: She ___ to school. a) go b) goes',
    '4. MCQ a) option1 b) option2',
    '5. MCQ a) option1 b) option2',
    '6. MCQ a) option1 b) option2',
    '7. MCQ a) option1 b) option2',
    '8. MCQ a) option1 b) option2',
    '9. MCQ a) option1 b) option2',
    '10. MCQ a) option1 b) option2',
    'Section B: Grammar (10 marks)',
    '11. Grammar a) has b) have',
    '12. Grammar a) is b) are',
    '13. Grammar a) will b) would',
    '14. Grammar a) can b) could',
    '15. Grammar a) do b) does',
    '16. Grammar a) did b) done',
    '17. Grammar a) was b) were',
    '18. Grammar a) been b) being',
    '19. Grammar a) have b) has',
    '20. Grammar a) am b) is',
    'Answer Key',
    '1 B 2 A 3 B 4 A 5 B 6 A 7 B 8 A 9 B 10 A',
    '11 A 12 B 13 A 14 B 15 A 16 A 17 B 18 A 19 B 20 A',
  ]),
  mockStructureResponses: [
    {
      wire: {
        m: { subject: 'English', grade: '10', totalPoints: 20, language: 'en' },
        s: [
          { id:'sec_1', index:1, p:[[1,12]], kind:'Vocabulary' },
          { id:'sec_2', index:2, p:[[13,20]], kind:'Grammar' },
        ],
        q: Array.from({length:20}, (_,i)=>({ n:i+1, s: i<10?'sec_1':'sec_2', t:'m', p:[[i+3,i+3]], v:1, c:9, o:[['a',[i+3,i+3]],['b',[i+3,i+3]]] })),
      }
    }
  ],
  expected: {
    questionCount: 20,
    numbers: Array.from({length:20}, (_,i)=>i+1),
    pointsTotal: 20,
    sectionCount: 2,
    titlesContain: ['Vocabulary', 'Grammar'],
    optionBlobCount: 0,
    phantomMissing: [],
    imagePlacement: 0,
  }
};
export default fixture;
