import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVariantB, variantHash } from '../src/pipeline/variants';
import type { ExamDoc } from '../src/types';

function makeMcqDoc(): ExamDoc{
  const lines = Array.from({length:10},(_,i)=>({id:`L${String(i+1).padStart(4,'0')}`,page:1,text:`${i+1}. Q${i+1}`}))
  return {
    id:'exam_var', fileHash:'h', createdAt:'', displayName:'VarTest', meta:{language:'en',direction:'ltr'} as any,
    sections:[{id:'sec_1',index:1,title:'S',spans:[[1,10]]}],
    questions: Array.from({length:5},(_,i)=>({
      id:`q${i+1}`, label:String(i+1), no:i+1, sectionId:'sec_1', spans:[[i+1,i+1]] as any, type:'mcq' as const, confidence:0.9, images:[],
      options:[
        {key:'a', spans:[[i+1,i+1]], text:`OptA${i+1}`},
        {key:'b', spans:[[i+1,i+1]], text:`OptB${i+1}`},
        {key:'c', spans:[[i+1,i+1]], text:`OptC${i+1}`},
        {key:'d', spans:[[i+1,i+1]], text:`OptD${i+1}`},
      ],
      answer:{ text:'b', source:'paper' as const }
    })).concat([
      { id:'q6', label:'6', no:6, sectionId:'sec_1', spans:[[6,6]] as any, type:'short' as const, confidence:0.9, images:[], stem:'Short answer' } as any
    ]),
    images:[], source:{lines, pages:1, fileName:'f.pdf', ocrUsed:false}, flags:[], usage:[]
  };
}

test('D4 seeded shuffle reproducible, answer remapping verified, non-MCQ excluded, variant prints own key', ()=>{
  const doc = makeMcqDoc();
  const seed='test-seed-123';
  const v1 = generateVariantB(doc, seed);
  const v2 = generateVariantB(doc, seed);
  // Same seed => identical doc hash
  assert.equal(variantHash(v1.variant), variantHash(v2.variant));
  // Different seed => different
  const v3 = generateVariantB(doc, 'other-seed');
  assert.notEqual(variantHash(v1.variant), variantHash(v3.variant));

  // Answer remapping verified: correct TEXT invariant over all MCQs
  for(const q of v1.variant.questions.filter(q=>q.type==='mcq')){
    const orig = doc.questions.find(o=>o.id===q.id)!;
    const origCorrectText = orig.options!.find(o=>o.key===orig.answer!.text)!.text;
    const newCorrectText = q.options!.find(o=>o.key===q.answer!.text)!.text;
    assert.equal(origCorrectText, newCorrectText, `TEXT invariant for ${q.id}`);
  }

  // Non-MCQ exclusion noted
  assert.ok(v1.excluded.includes('q6'));
  assert.match(v1.note, /Excluded 1/);

  // Variant prints its own key: each variant question answer should be present and distinct
  assert.equal(v1.variant.questions.filter(q=>q.answer).length, 5);
  assert.ok(v1.variant.displayName.includes('Variant B'));
  assert.ok(v1.variant.id.includes(seed.slice(0,6)));

  // Points/sections preserved
  assert.equal(v1.variant.sections.length, doc.sections.length);
  assert.equal(v1.variant.questions.length, doc.questions.length);
});
