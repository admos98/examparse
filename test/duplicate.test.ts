import test from 'node:test';
import assert from 'node:assert/strict';
import { stemHashSet, jaccard, findPossibleDuplicates } from '../src/pipeline/duplicateDetector';

test('D5 duplicate/similar detection Jaccard >=0.85 warn', ()=>{
  const a:any = { id:'a', fileHash:'hash_a', displayName:'Exam A', questions: Array.from({length:10},(_,i)=>({stem:`Question ${i} about photosynthesis process detailed explanation ${i}`, options:[]})) };
  const b:any = { id:'b', fileHash:'hash_b', displayName:'Exam B', questions: Array.from({length:10},(_,i)=>({stem:`Question ${i} about photosynthesis process detailed explanation ${i}`, options:[]})) }; // 100% similar
  const c:any = { id:'c', fileHash:'hash_c', displayName:'Exam C', questions: Array.from({length:10},(_,i)=>({stem:`Totally different content about math algebra ${i} unique`, options:[]})) };
  // Exact hash
  const dupExact = findPossibleDuplicates({ ...a, fileHash:'same' } as any, [{ ...b, fileHash:'same' } as any]);
  assert.equal(dupExact.length,1);
  assert.equal(dupExact[0].exact,true);
  assert.equal(dupExact[0].similarity,1);

  // Jaccard similar
  const setA = stemHashSet(a as any);
  const setB = stemHashSet(b as any);
  const sim = jaccard(setA,setB);
  assert.ok(sim>=0.85);
  const dups = findPossibleDuplicates(a as any, [b as any, c as any]);
  assert.equal(dups.length,1);
  assert.equal(dups[0].examId,'b');
  assert.ok(dups[0].similarity>=0.85);

  // c not duplicate
  const notDup = findPossibleDuplicates(c as any, [a as any]);
  assert.equal(notDup.length,0);
});
