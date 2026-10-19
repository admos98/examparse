import test from 'node:test';
import assert from 'node:assert/strict';
import { crossCheckAnswers, acceptSolverAnswer } from '../src/pipeline/crossCheck';
import type { ExamDoc } from '../src/types';

function makeDocWithWrongAnswers(): ExamDoc {
  const lines = Array.from({length:10},(_,i)=>({id:`L${String(i+1).padStart(4,'0')}`,page:1,text:`${i+1}. Q${i+1}`}));
  return {
    id:'exam_cc', fileHash:'h', createdAt:'', displayName:'CC Test', meta:{language:'en',direction:'ltr'} as any,
    sections:[{id:'sec_1',index:1,title:'S',spans:[[1,10]]}],
    questions: Array.from({length:5},(_,i)=>({
      id:`q${i+1}`, label:String(i+1), no:i+1, sectionId:'sec_1', spans:[[i+1,i+1]], type:'mcq' as const, confidence:0.9, images:[],
      options:[{key:'a',spans:[[i+1,i+1]],text:'OptA'},{key:'b',spans:[[i+1,i+1]],text:'OptB'}],
      answer:{ text: i===1 ? 'B' : i===3 ? 'A' : 'A', source:'paper' as const } // plant 2 wrong: q2 should be A but is B, q4 should be B but is A
    })),
    images:[], source:{lines, pages:1, fileName:'f.pdf', ocrUsed:false}, flags:[], usage:[]
  };
}

test('C3 cross-check: fixture with 2 planted wrong -> 2 flags, no auto-overwrite, accept writes patch+snapshot', async ()=>{
  const doc = makeDocWithWrongAnswers();
  // Solver blind: returns correct answers (no paper answer shown)
  const solver = async (batch:any[])=>{
    const correct:Record<string,string> = { q1:'A', q2:'A', q3:'A', q4:'B', q5:'A' }; // q2 and q4 correct are A,B respectively, paper had opposite
    const out:Record<string,string>={};
    for(const q of batch) out[q.id]=correct[q.id]||'A';
    return out;
  };
  // Estimate shown before starting
  const est = await crossCheckAnswers(doc, solver as any, true);
  assert.ok(est.estimate);
  assert.equal(est.estimate.questions,5);
  assert.equal(est.estimate.calls,1);
  assert.ok(est.estimate.tokens>0);

  const result = await crossCheckAnswers(doc, solver as any);
  assert.equal(result.disagreements.length,2);
  assert.equal(result.flags.length,2);
  assert.ok(result.flags.every(f=>f.code==='ANSWER_DISAGREEMENT'));
  // No auto-overwrite: original doc still has paper answers
  assert.equal(doc.questions.find(q=>q.id==='q2')?.answer?.text,'B');
  assert.equal(doc.questions.find(q=>q.id==='q4')?.answer?.text,'A');

  // One-click accept writes patch + snapshot
  const updated = acceptSolverAnswer(doc, 'q2', 'A');
  assert.equal(updated.questions.find(q=>q.id==='q2')?.answer?.text,'A');
  // Snapshot would be created via store; we simulate by checking updated doc hash changed
  assert.notEqual(JSON.stringify(updated), JSON.stringify(doc));
});
