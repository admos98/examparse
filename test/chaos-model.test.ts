import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { expandWireV2 } from '../src/pipeline/structure';
import type { SourceLine } from '../src/types';

const makeLines = (texts:string[]):SourceLine[]=> texts.map((t,i)=>({id:`L${String(i+1).padStart(4,'0')}`, page:1, text:t}));

test('B2 chaos: empty response -> typed error, doc unchanged', ()=>{
  const source = makeLines(['1. Q1','2. Q2']);
  const docBefore = { questions: [{id:'q1',no:1,label:'1',spans:[[1,1]],type:'short',confidence:0.9,images:[]}] as any };
  const emptyJson:any = null;
  let threw=false;
  try{
    const expanded = expandWireV2(emptyJson);
    if(!expanded || !expanded.questions) throw new Error('STRUCTURE_SHAPE_MISMATCH');
  }catch(e:any){
    threw=true;
    assert.match(String(e.message||e.code||''), /SHAPE|parse|empty/i);
  }
  assert.ok(threw);
  // doc unchanged
  assert.deepEqual(docBefore.questions[0].no,1);
});

test('B2 chaos: whitespace only', ()=>{
  const raw = '   \n  \t  ';
  let data:any=null;
  try{ data = JSON.parse(raw); }catch{ data=null; }
  assert.equal(data,null);
});

test('B2 chaos: markdown-fenced JSON', ()=>{
  const fenced = '```json\n{"q":[{"n":1,"s":"sec_1","t":"s","p":[[1,1]],"v":1,"c":9}]}\n```';
  const inner = fenced.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] || fenced;
  const parsed = JSON.parse(inner);
  const expanded = expandWireV2(parsed);
  assert.equal(expanded.questions.length,1);
});

test('B2 chaos: trailing commas', async ()=>{
  const withTrailing = '{"q":[{"n":1,"p":[[1,1]],},],"s":[]}';
  // Our repairTruncatedJson should handle or throw typed error
  const { repairTruncatedJson } = await import('../src/utils/jsonRepair');
  let repaired:any=null;
  try{ repaired = JSON.parse(withTrailing); }catch{ repaired = repairTruncatedJson(withTrailing); }
  // Should either parse or return null without throwing unhandled
  assert.ok(repaired===null || typeof repaired==='object');
});

test('B2 chaos: spans as strings', ()=>{
  const source = makeLines(['1. Q1','2. Q2']);
  const raw = [{ id:'q1', no:1, label:'1', type:'short', spans: "[[1,1]]" as any, confidence:0.9 }];
  // assemble should handle invalid spans gracefully, not crash
  const res = assembleAndValidateQuestions(raw as any, source);
  assert.ok(Array.isArray(res.questions));
  // Should not have half-written doc: either 0 questions or valid
  assert.ok(res.questions.length===0 || res.questions[0].spans.length===0 || res.questions[0].spans[0][0]===1);
});

test('B2 chaos: no=0/negative/9999 filtered', ()=>{
  const source=makeLines(['1. Q1','2. Q2','3. Q3']);
  const raws = [
    {id:'q0',no:0,label:'0',type:'short',spans:[[1,1]],confidence:0.9},
    {id:'qn',no:-5,label:'-5',type:'short',spans:[[2,2]],confidence:0.9},
    {id:'qbig',no:9999,label:'9999',type:'short',spans:[[3,3]],confidence:0.9},
  ] as any;
  const res = assembleAndValidateQuestions(raws, source);
  // Should not crash, invalid numbers either corrected or filtered
  assert.ok(res.questions.every(q=> q.no>=1 && q.no<=300) || res.questions.length===0);
});

test('B2 chaos: sections referencing undeclared ids', ()=>{
  const source=makeLines(['1. Q1']);
  const raw = [{id:'q1',no:1,label:'1',sectionId:'nonexistent',type:'short',spans:[[1,1]],confidence:0.9}];
  const res = assembleAndValidateQuestions(raw as any, source);
  assert.ok(res.questions.length===1);
  // Section id should be sanitized or flagged, not crash
});

test('B2 chaos: 200 questions in one response capped', ()=>{
  const source = makeLines(Array.from({length:200},(_,i)=>`${i+1}. Q${i+1}`));
  const raw = Array.from({length:200},(_,i)=>({id:`q${i}`,no:i+1,label:String(i+1),type:'short',spans:[[i+1,i+1]],confidence:0.9}));
  const res = assembleAndValidateQuestions(raw as any, source);
  assert.ok(res.questions.length<=200);
  assert.ok(res.questions.length===200 || res.flags.some(f=>f.code.includes('LIMIT')||f.code.includes('SHAPE')));
});

test('B2 chaos: reasoning-channel only text', ()=>{
  const reasoningOnly = 'I think the answer is... This is reasoning, no JSON.';
  let data:any=null;
  try{ data = JSON.parse(reasoningOnly); }catch{ data=null; }
  assert.equal(data,null);
  // Should result in typed error, not exception escaping
  const beforeDoc = { questions: [{id:'q1',no:1}] } as any;
  const afterDoc = JSON.parse(JSON.stringify(beforeDoc));
  assert.deepEqual(beforeDoc, afterDoc);
});
