import type { ExamDoc } from '../types';

export function stemHashSet(doc:ExamDoc): Set<string> {
  // question stem first-40-chars hash set
  return new Set(doc.questions.map(q=> (q.stem||'').slice(0,40).toLowerCase().trim()).filter(s=>s.length>5));
}

export function jaccard(a:Set<string>, b:Set<string>):number {
  const inter = [...a].filter(x=> b.has(x)).length;
  const union = new Set([...a,...b]).size;
  return union===0?0:inter/union;
}

export function findPossibleDuplicates(target:ExamDoc, library:ExamDoc[]): Array<{ examId:string, displayName:string, similarity:number, exact:boolean }>{
  const targetHash = target.fileHash;
  const targetSet = stemHashSet(target);
  const results:Array<{examId:string,displayName:string,similarity:number,exact:boolean}>=[];
  for(const other of library){
    if(other.id===target.id) continue;
    if(other.fileHash===targetHash){
      results.push({ examId:other.id, displayName:other.displayName, similarity:1, exact:true });
      continue;
    }
    const otherSet = stemHashSet(other);
    const sim = jaccard(targetSet, otherSet);
    if(sim>=0.85) results.push({ examId:other.id, displayName:other.displayName, similarity: Math.round(sim*100)/100, exact:false });
  }
  return results;
}
