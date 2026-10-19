import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[]): SourceLine[] => texts.map((t,i)=>({ id:`L${String(i+1).padStart(4,'0')}`, page: Math.floor(i/40)+1, text:t }));
export const fixture = {
  id: 'giant-120',
  description: 'Giant paper 120 questions scale/perf guard',
  sourceLines: makeLines([
    'Giant Exam — 120 Questions — 120 Points',
    ...Array.from({length:120}, (_,i)=> `${i+1}. Question ${i+1} content a) opt1 b) opt2 c) opt3 d) opt4`),
    'Answer Key',
    ...Array.from({length:12}, (_,i)=> Array.from({length:10},(_,j)=> `${i*10+j+1} A`).join(' ')),
  ]),
  mockStructureResponses: [
    // Simulate chunked: 3 chunks of 40 each
    {
      wire: {
        m: { subject:'General', grade:'12', totalPoints:120, language:'en' },
        s: [{ id:'sec_1', index:1, p:[[1,41]], kind:'Other' }],
        q: Array.from({length:40}, (_,i)=>({ n:i+1, s:'sec_1', t:'m', p:[[i+2,i+2]], v:1, c:9 })),
      }
    },
    {
      wire: {
        m: { subject:'General', grade:'12', totalPoints:120, language:'en' },
        s: [{ id:'sec_2', index:2, p:[[42,82]], kind:'Other' }],
        q: Array.from({length:40}, (_,i)=>({ n:i+41, s:'sec_2', t:'m', p:[[i+42,i+42]], v:1, c:9 })),
      }
    },
    {
      wire: {
        m: { subject:'General', grade:'12', totalPoints:120, language:'en' },
        s: [{ id:'sec_3', index:3, p:[[83,122]], kind:'Other' }],
        q: Array.from({length:40}, (_,i)=>({ n:i+81, s:'sec_3', t:'m', p:[[i+83,i+83]], v:1, c:9 })),
      }
    },
  ],
  expected: {
    questionCount: 120,
    numbers: Array.from({length:120},(_,i)=>i+1),
    pointsTotal: 120,
    sectionCount: 3,
    titlesContain: ['Other'],
    optionBlobCount: 0,
    phantomMissing: [],
  }
};
export default fixture;
