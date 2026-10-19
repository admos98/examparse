import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[], page=1): SourceLine[] => texts.map((t,i)=>({ id:`L${String(i+1).padStart(4,'0')}`, page, text:t }));
export const fixture = {
  id: 'separate-keyfile',
  description: 'Answer key in separate file flow',
  sourceLines: makeLines([
    'History Exam — 20 points',
    '1. When was WW2? a) 1939 b) 1945',
    '2. Who was... a) ... b) ...',
    '3. Question 3',
    '4. Question 4',
    '5. Question 5',
    '6. Question 6',
    '7. Question 7',
    '8. Question 8',
    '9. Question 9',
    '10. Question 10',
    '11. Question 11',
    '12. Question 12',
    '13. Question 13',
    '14. Question 14',
    '15. Question 15',
    '16. Question 16',
    '17. Question 17',
    '18. Question 18',
    '19. Question 19',
    '20. Question 20',
  ]),
  // Paper source has no key territory; keyfile provides answers separately
  mockKeyFileLines: makeLines([
    'Answer Key for History Exam',
    '1 A 2 B 3 C 4 D 5 A 6 B 7 C 8 D 9 A 10 B',
    '11 A 12 B 13 C 14 D 15 A 16 B 17 C 18 D 19 A 20 B',
  ]),
  mockStructureResponses: [
    {
      wire: {
        m: { subject:'History', grade:'10', totalPoints:20, language:'en' },
        s: [{ id:'sec_1', index:1, p:[[1,21]], kind:'Other' }],
        q: Array.from({length:20},(_,i)=>({ n:i+1, s:'sec_1', t:'m', p:[[i+2,i+2]], v:1, c:9 })),
      }
    }
  ],
  expected: {
    questionCount: 20,
    numbers: Array.from({length:20},(_,i)=>i+1),
    pointsTotal: 20,
    sectionCount: 1,
    titlesContain: ['Other'],
    optionBlobCount:0,
    keyFileAnswers: 20,
  }
};
export default fixture;
