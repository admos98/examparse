import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[], page=1): SourceLine[] => texts.map((t,i)=>({ id:`L${String(i+1).padStart(4,'0')}`, page, text:t }));
export const fixture = {
  id: 'two-column',
  description: 'Two-column layout',
  sourceLines: makeLines([
    'Grade 11 — Physics Midterm — 30 points',
    'Column A:',
    '1. What is force? a) mass b) energy',
    '2. Newton law a) first b) second',
    '3. Energy formula a) E=mc2 b) F=ma',
    '4. Velocity a) speed b) vector',
    '5. Acceleration a) change b) constant',
    'Column B:',
    '6. Momentum a) p=mv b) p=ma',
    '7. Work a) Fd b) mv',
    '8. Power a) W/t b) Fv',
    '9. Pressure a) F/A b) mV',
    '10. Density a) m/V b) F/A',
    '11. Two-column continues',
    '12. Question 12',
    'Answer Key',
    '1 A 2 B 3 A 4 B 5 A 6 A 7 A 8 B 9 A 10 B 11 A 12 B',
  ]),
  mockStructureResponses: [
    {
      wire: {
        m: { subject:'Physics', grade:'11', totalPoints:30, language:'en' },
        s: [
          { id:'sec_1', index:1, p:[[1,7]], kind:'Other' },
          { id:'sec_2', index:2, p:[[8,13]], kind:'Other' },
        ],
        q: Array.from({length:12},(_,i)=>({ n:i+1, s: i<5?'sec_1':'sec_2', t:'m', p:[[i+3,i+3]], v:2.5, c:9 })),
      }
    }
  ],
  expected: {
    questionCount: 12,
    numbers: Array.from({length:12},(_,i)=>i+1),
    pointsTotal: 30,
    sectionCount: 2,
    titlesContain: ['Other'],
    optionBlobCount: 0,
    phantomMissing: [],
  }
};
export default fixture;
