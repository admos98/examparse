import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBulk, exportSelected } from '../src/pipeline/bulkOps';

test('D2 bulk operations set points/type/move/delete/re-slice local one Undo', ()=>{
  const doc:any = {
    id:'exam', fileHash:'h', createdAt:'', displayName:'Test', meta:{language:'en',direction:'ltr'},
    sections:[{id:'sec_1',index:1,title:'Sec1',spans:[[1,5]]},{id:'sec_2',index:1,title:'Sec2',spans:[[6,10]]}],
    questions:[
      {id:'q1',no:1,sectionId:'sec_1',type:'mcq',points:1,spans:[[1,1]],confidence:0.9,images:[]},
      {id:'q2',no:2,sectionId:'sec_1',type:'short',points:1,spans:[[2,2]],confidence:0.9,images:[]},
      {id:'q3',no:3,sectionId:'sec_1',type:'mcq',points:1,spans:[[3,3]],confidence:0.9,images:[]},
    ],
    images:[], source:{lines:[],pages:1,fileName:'f.pdf',ocrUsed:false}, flags:[], usage:[]
  };
  // set points bulk
  const r1 = applyBulk(doc, ['q1','q3'], {type:'setPoints', points:2});
  assert.equal(r1.doc.questions.find((q:any)=>q.id==='q1').points,2);
  assert.equal(r1.doc.questions.find((q:any)=>q.id==='q2').points,1);
  assert.ok(r1.undo);

  const r2 = applyBulk(doc, ['q1'], {type:'setType', qType:'essay'});
  assert.equal(r2.doc.questions.find((q:any)=>q.id==='q1').type,'essay');

  const r3 = applyBulk(doc, ['q1'], {type:'moveSection', sectionId:'sec_2'});
  assert.equal(r3.doc.questions.find((q:any)=>q.id==='q1').sectionId,'sec_2');

  const r4 = applyBulk(doc, ['q2'], {type:'delete'});
  assert.equal(r4.doc.questions.length,2);
  assert.ok(r4.doc.flags.some((f:any)=>f.code==='BULK_DELETE'));

  const r5 = applyBulk(doc, ['q1'], {type:'reSlice'});
  assert.equal(r5.doc.questions.find((q:any)=>q.id==='q1').rewrites?.length,0);

  // Export selected only JSON + print
  const exp = exportSelected(doc, ['q1','q3']);
  assert.equal(exp.json.questions.length,2);
  assert.ok(exp.printHtml.includes('Q1'));
  assert.ok(exp.printHtml.includes('Q3'));
});
