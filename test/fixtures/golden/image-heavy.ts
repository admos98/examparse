import type { SourceLine } from '../../../src/types';
const makeLines = (texts: string[]): SourceLine[] => texts.map((t, i) => ({ id:`L${String(i + 1).padStart(4, '0')}`, page: i < 10 ? 1 : 2, text: t }));
export const fixture = {
  id: 'image-heavy',
  description: 'Image-heavy: fragmented strips, orphan, repeated logo',
  sourceLines: makeLines([
    'Biology Exam — Grade 12 — 20 points',
    'Section Diagrams',
    '1. Label the cell [IMAGE img_001 near line 3]',
    '2. Identify organ [IMAGE img_002 near line 4]',
    '3. Diagram of heart [IMAGE img_003 strip frag 1]',
    '4. Continued heart [IMAGE img_004 strip frag 2] — same diagram fragmented',
    '5. Plant cell [IMAGE img_005]',
    '6. Question with repeated logo www.kanoon.ir at top (furniture)',
    '7. Question 7',
    '8. Question 8',
    'Answer Key',
    '1 A 2 B 3 C 4 D 5 A 6 B 7 C 8 D',
  ]),
  mockStructureResponses: [
    {
      wire: {
        m: { subject:'Biology', grade:'12', totalPoints:20, language:'en' },
        s: [{ id:'sec_1', index:1, p:[[1,9]], kind:'Other' }],
        q: Array.from({length:8},(_,i)=>({ n:i+1, s:'sec_1', t:'d', p:[[i+3,i+3]], v:2.5, c:9, i: i<5?[`img_00${i+1}`]:[] })),
      }
    }
  ],
  // Mock images: 5 strips where 3+4 are same diagram fragmented, should merge
  mockImages: [
    { id:'img_001', page:1, bbox:{x:10,y:10,w:100,h:100}, sha:'sha1', dHash:'aaaa', anchorLine:3, blobKey:'blob1' },
    { id:'img_002', page:1, bbox:{x:10,y:30,w:100,h:100}, sha:'sha2', dHash:'bbbb', anchorLine:4, blobKey:'blob2' },
    { id:'img_003', page:1, bbox:{x:10,y:50,w:100,h:20}, sha:'sha3', dHash:'cccc', anchorLine:5, blobKey:'blob3', imageFlags:['IMAGE_SUSPECT_STRIP'] },
    { id:'img_004', page:1, bbox:{x:10,y:71,w:100,h:20}, sha:'sha4', dHash:'cccc', anchorLine:5, blobKey:'blob4', imageFlags:['IMAGE_SUSPECT_STRIP'] }, // same dHash should merge with img_003
    { id:'img_005', page:1, bbox:{x:10,y:90,w:100,h:100}, sha:'sha5', dHash:'dddd', anchorLine:6, blobKey:'blob5' },
    { id:'img_006', page:1, bbox:{x:0,y:0,w:200,h:20}, sha:'logo-sha', dHash:'logo', anchorLine:1, blobKey:'logo-blob', label:{ role:'decoration', kind:'decoration', reason:'Repeated header logo' } },
  ],
  expected: {
    questionCount: 8,
    numbers: [1,2,3,4,5,6,7,8],
    pointsTotal: 20,
    sectionCount: 1,
    titlesContain: ['Other'],
    optionBlobCount: 0,
    // After merging strips, image count 6 -> 5 (3+4 merge), orphan 0, logo decorated
    imagePlacement: 0,
  }
};
export default fixture;
