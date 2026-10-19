import type { ExamDoc, Question } from '../types';
import { createHash } from 'node:crypto';

function seededRandom(seed:string){
  let h=0;
  for(let i=0;i<seed.length;i++) h = (h*31 + seed.charCodeAt(i)) >>>0;
  let s = h || 1;
  return ()=>{ s = (s*1664525 + 1013904223) >>>0; return s/0x100000000; };
}
function shuffleWithSeed<T>(arr:T[], seed:string):T[] {
  const rand = seededRandom(seed);
  const out=[...arr];
  for(let i=out.length-1;i>0;i--){ const j=Math.floor(rand()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}
function hashDoc(doc:ExamDoc):string{
  return createHash('sha256').update(JSON.stringify(doc.questions.map(q=>({id:q.id,no:q.no,opts:q.options?.map(o=>o.text)})))).digest('hex').slice(0,16);
}

export interface VariantResult {
  variant: ExamDoc;
  seed: string;
  remapped: number;
  excluded: string[];
  note: string;
}

export function generateVariantB(doc:ExamDoc, seed:string, opts?:{ shuffleQuestions?:boolean }):VariantResult {
  const original = doc;
  const variantQuestions: Question[] = [];
  let remapped=0;
  const excluded:string[]=[];

  for(const q of original.questions){
    if(q.type!=='mcq' || !q.options || q.options.length<2 || !q.answer?.text){
      // Non-MCQ exclusion: exclude from shuffle with note
      if(q.type!=='mcq') excluded.push(q.id);
      variantQuestions.push({ ...q, flags:[...(q.flags||[]), 'VARIANT_EXCLUDED_NON_MCQ'] });
      continue;
    }
    // For MCQ, shuffle option order with seed (seed+questionId ensures deterministic per question)
    const perQSeed = seed + ':' + q.id;
    const shuffled = shuffleWithSeed(q.options, perQSeed);
    // Remap answer key: find correct option TEXT matches pre-shuffle
    const correctText = q.options.find(o=> o.key===q.answer?.text || o.text===q.answer?.text)?.text || q.answer.text;
    // Find new key for same TEXT
    const newCorrect = shuffled.find(o=> o.text===correctText);
    if(!newCorrect){
      excluded.push(q.id);
      variantQuestions.push({ ...q, flags:[...(q.flags||[]), 'VARIANT_REMAP_FAILED'] });
      continue;
    }
    remapped++;
    variantQuestions.push({
      ...q,
      options: shuffled,
      answer: { ...q.answer, text: newCorrect.key, source:'ai' as const },
    });
  }

  let finalQuestions = variantQuestions;
  if(opts?.shuffleQuestions){
    // Shuffle within sections preserving sections, relabel numbering locally
    const bySection = new Map<string, Question[]>();
    for(const q of variantQuestions){
      const sid = q.sectionId||'default';
      if(!bySection.has(sid)) bySection.set(sid,[]);
      bySection.get(sid)!.push(q);
    }
    const newOrder:Question[]=[];
    for(const [sid, qs] of bySection){
      const shuffledQs = shuffleWithSeed(qs, seed+':section:'+sid);
      // Relabel numbering locally: assign new no sequentially within doc (preserve original numbers for audit? spec says numbering relabelled locally, spans retained)
      shuffledQs.forEach((q,i)=>{
        newOrder.push({ ...q, label: String(i+1), no: q.no }); // keep original no for audit, but label relabelled? For test, keep no
      });
    }
    finalQuestions = newOrder;
  }

  const variant: ExamDoc = {
    ...original,
    id: original.id + '_variant_B_' + seed.slice(0,6),
    displayName: original.displayName + ' — Variant B',
    questions: finalQuestions,
    // Passages/sections preserved, points/sections preserved
  };

  // Verify locally: correct TEXT must match pre-shuffle
  for(const vq of variant.questions){
    const orig = original.questions.find(o=>o.id===vq.id);
    if(!orig || orig.type!=='mcq' || !orig.answer) continue;
    const origCorrectText = orig.options?.find(o=> o.key===orig.answer?.text || o.text===orig.answer?.text)?.text || orig.answer.text;
    const variantCorrectText = vq.options?.find(o=> o.key===vq.answer?.text)?.text;
    if(origCorrectText && variantCorrectText){
      if(origCorrectText !== variantCorrectText) throw new Error(`Variant remap failed for ${vq.id}: ${origCorrectText} != ${variantCorrectText}`);
    }
  }

  return { variant, seed, remapped, excluded, note: excluded.length? `Excluded ${excluded.length} non-MCQ questions from shuffle` : 'All MCQs remapped' };
}

export function variantHash(variant:ExamDoc):string{
  return hashDoc(variant);
}
