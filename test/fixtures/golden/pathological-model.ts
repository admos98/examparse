import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[], page=1): SourceLine[] => texts.map((t,i)=>({ id:`L${String(i+1).padStart(4,'0')}`, page, text:t }));
export const fixture = {
  id: 'pathological-model',
  description: 'Pathological model outputs: truncated mid-span, prose preamble, v1/v2 mixing, wrong shape',
  sourceLines: makeLines([
    'Pathological Test — 15 points',
    '1. Question one',
    '2. Question two',
    '3. Question three',
    '4. Question four',
    '5. Question five',
    '6. Question six',
    '7. Question seven',
    '8. Question eight',
    '9. Question nine',
    '10. Question ten',
    '11. Question eleven',
    '12. Question twelve',
    '13. Question thirteen',
    '14. Question fourteen',
    '15. Question fifteen',
    'Answer Key',
    '1 A 2 B 3 C 4 D 5 A 6 B 7 C 8 D 9 A 10 B 11 A 12 B 13 C 14 D 15 A',
  ]),
  mockStructureResponses: [
    // First response: truncated mid-span (simulate repair path)
    {
      rawText: '{"m":{"subject":"Test","totalPoints":15},"s":[{"id":"sec_1","index":1,"p":[',
      truncated: true,
      repair: {
        m: { subject:'Test', totalPoints:15 },
        s: [{ id:'sec_1', index:1, p:[[1,16]], kind:'Other' }],
        // Only 10 of 15 due to truncation, repair should recover remaining 5 via continuation
        q: Array.from({length:10},(_,i)=>({ n:i+1, s:'sec_1', t:'s', p:[[i+2,i+2]], v:1, c:9 })),
      }
    },
    // Second response: prose preamble before JSON (should be stripped)
    {
      rawText: 'Here is the JSON you requested:\n```json\n{"m":{"subject":"Test"},"s":[{"id":"sec_1","index":1,"p":[[1,16]]}],"q":[{"n":11,"s":"sec_1","t":"s","p":[[12,12]],"v":1,"c":9},{"n":12,"s":"sec_1","t":"s","p":[[13,13]],"v":1,"c":9},{"n":13,"s":"sec_1","t":"s","p":[[14,14]],"v":1,"c":9},{"n":14,"s":"sec_1","t":"s","p":[[15,15]],"v":1,"c":9},{"n":15,"s":"sec_1","t":"s","p":[[16,16]],"v":1,"c":9}]}\n```',
      wire: {
        m:{ subject:'Test', totalPoints:15 },
        s:[{ id:'sec_1', index:1, p:[[1,16]], kind:'Other' }],
        q:[ {n:11,s:'sec_1',t:'s',p:[[12,12]],v:1,c:9},{n:12,s:'sec_1',t:'s',p:[[13,13]],v:1,c:9},{n:13,s:'sec_1',t:'s',p:[[14,14]],v:1,c:9},{n:14,s:'sec_1',t:'s',p:[[15,15]],v:1,c:9},{n:15,s:'sec_1',t:'s',p:[[16,16]],v:1,c:9} ]
      }
    },
    // Third: v1/v2 mixing (model sends questions array with v1 naming but also q)
    {
      rawText: JSON.stringify({
        meta:{ subject:'Test', totalPoints:15 },
        sections:[{ id:'sec_1', index:1, spans:[[1,16]] }],
        questions:[ { id:'q1', no:1, label:'1', type:'short', spans:[[2,2]], confidence:0.9 } ],
        q:[ {n:1,s:'sec_1',t:'s',p:[[2,2]],v:1,c:9} ]
      }),
      wire: {
        m:{ subject:'Test', totalPoints:15 },
        s:[{ id:'sec_1', index:1, p:[[1,16]], kind:'Other' }],
        q:[ {n:1,s:'sec_1',t:'s',p:[[2,2]],v:1,c:9} ]
      }
    },
    // Fourth: wrong shape — sections referencing undeclared ids, 200 questions in one response (should cap), no=0/negative
    {
      wire: {
        m:{ subject:'Test', totalPoints:15 },
        s:[{ id:'sec_1', index:1, p:[[1,16]], kind:'Other' }],
        q: [
          {n:0,s:'sec_1',t:'s',p:[[2,2]],v:1,c:9}, // invalid no should be filtered
          {n:-1,s:'sec_1',t:'s',p:[[3,3]],v:1,c:9},
          {n:2,s:'undeclared',t:'s',p:[[3,3]],v:1,c:9},
          // 200 questions attempt — assembler should handle cap
          ...Array.from({length:15},(_,i)=>({ n:i+3,s:'sec_1',t:'s',p:[[i+4,i+4]],v:1,c:9 })),
        ]
      }
    },
  ],
  expected: {
    questionCount: 15,
    numbers: Array.from({length:15},(_,i)=>i+1),
    pointsTotal: 15,
    sectionCount: 1,
    titlesContain: ['Other'],
    optionBlobCount:0,
    maxQuestionsPerResponse: 200, // ensure no crash
  }
};
export default fixture;
