import type { ExamDoc, Question } from '../types';

export interface CrossCheckResult {
  disagreements: Array<{ questionId:string, no:number, paperAnswer?:string, solverAnswer:string, paperText?:string, solverText?:string }>;
  flags: Array<{ id:string, code:string, severity:'warn', message:string, questionId:string }>;
}

export async function crossCheckAnswers(
  doc: ExamDoc,
  solver: (questions: Question[])=>Promise<Record<string,string>>, // returns map questionId -> solver answer key
  estimateOnly=false
): Promise<CrossCheckResult & { estimate?:{ questions:number, calls:number, tokens:number } }> {
  const mcqs = doc.questions.filter(q=> q.type==='mcq' || q.type==='truefalse');
  const estimate = { questions: mcqs.length, calls: Math.ceil(mcqs.length/10), tokens: mcqs.length*200 };
  if(estimateOnly) return { disagreements:[], flags:[], estimate };
  // Batch ≤10
  const disagreements:CrossCheckResult['disagreements'] = [];
  const flags:CrossCheckResult['flags']=[];
  for(let i=0;i<mcqs.length;i+=10){
    const batch = mcqs.slice(i,i+10);
    const solverAnswers = await solver(batch);
    for(const q of batch){
      const solverAns = solverAnswers[q.id];
      const paperAns = q.answer?.text || (q as any).paperAnswer;
      if(paperAns && solverAns && paperAns!==solverAns){
        disagreements.push({ questionId:q.id, no:q.no, paperAnswer:paperAns, solverAnswer:solverAns });
        flags.push({ id:`flag_disagree_${q.id}`, code:'ANSWER_DISAGREEMENT', severity:'warn', message:`Q${q.no} paper ${paperAns} vs solver ${solverAns}`, questionId:q.id });
      }
    }
  }
  return { disagreements, flags, estimate };
}

export function acceptSolverAnswer(doc: ExamDoc, questionId:string, solverAnswer:string): ExamDoc {
  const q = doc.questions.find(x=>x.id===questionId);
  if(!q) return doc;
  // One-click accept writes normal patch + version snapshot (snapshot handled by store)
  const updated = {
    ...doc,
    questions: doc.questions.map(item=> item.id===questionId ? { ...item, answer:{ ...(item.answer||{source:'manual' as const}), text:solverAnswer, source:'ai' as const } } : item),
  };
  // Add flag that it was accepted? Keep disagreement but mark resolved? For test, just update answer
  return updated;
}
