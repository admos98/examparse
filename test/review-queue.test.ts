import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewQueue, acceptAndNext, progress } from '../src/pipeline/reviewQueue';

test('D1 review queue ordering + accept flow', ()=>{
  const doc:any = {
    id:'exam', fileHash:'h', createdAt:'', displayName:'Test', meta:{language:'en',direction:'ltr'},
    sections:[{id:'s',index:1,title:'S',spans:[[1,10]]}],
    questions:[
      {id:'q1',no:1, confidence:0.9, flags:[], images:[]}, // rest
      {id:'q2',no:2, confidence:0.4, flags:[], images:[]}, // lowConfidence
      {id:'q3',no:3, confidence:0.9, flags:['WRONG'], images:[]}, // flag
      {id:'q4',no:4, confidence:0.9, flags:[], images:[{imageId:'img1'}]}, // unplaced
    ],
    images:[], source:{lines:[],pages:1,fileName:'f.pdf',ocrUsed:false}, flags:[], usage:[], unplacedImageIds:['img1']
  };
  const queue = buildReviewQueue(doc);
  // Ordered by need
  assert.equal(queue[0].questionId,'q2'); // lowConfidence first
  assert.equal(queue[1].questionId,'q3'); // flags
  assert.equal(queue[2].questionId,'q4'); // unplaced
  assert.equal(queue[3].questionId,'q1'); // rest

  // Keyboard nav J/K, 1-4 set points/type, A accept-and-next, E edit etc - state level test: accept clears flags
  const accepted = new Set<string>();
  let current = doc;
  current = acceptAndNext(current,'q2');
  accepted.add('q2');
  assert.equal(current.questions.find(q=>q.id==='q2')?.flags?.length,0);
  assert.ok((current.questions.find(q=>q.id==='q2') as any).reviewedAt);
  assert.equal((current.questions.find(q=>q.id==='q2') as any).reviewedBy,'teacher');

  const prog = progress(queue, accepted);
  assert.equal(prog.total,4);
  assert.equal(prog.reviewed,1);
  assert.equal(prog.pending,3);
  assert.equal(prog.text,'1 of 4 need review');
  // Reviewed flags persist after reload (simulate)
  const reloaded = JSON.parse(JSON.stringify(current));
  assert.equal(reloaded.questions.find((q:any)=>q.id==='q2').reviewedAt, (current.questions.find(q=>q.id==='q2') as any).reviewedAt);
});
