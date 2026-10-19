import type { ExamDoc } from '../types';

export interface ReviewItem {
  questionId: string;
  no: number;
  reason: 'lowConfidence' | 'flag' | 'unplacedImage' | 'rest';
  priority: number;
}

export function buildReviewQueue(doc: ExamDoc): ReviewItem[] {
  const items: ReviewItem[] = [];
  const unplacedIds = new Set((doc as any).unplacedImageIds || []);
  for(const q of doc.questions){
    let reason: ReviewItem['reason'] = 'rest';
    let priority = 99;
    if(q.confidence < 0.5){ reason='lowConfidence'; priority=1; }
    else if((q.flags||[]).length>0){ reason='flag'; priority=2; }
    else if(q.images?.some(img=> unplacedIds.has(img.imageId))){ reason='unplacedImage'; priority=3; }
    items.push({ questionId:q.id, no:q.no, reason, priority });
  }
  // Order by need: low confidence -> flags -> unplaced images -> rest, then by no
  return items.sort((a,b)=> a.priority - b.priority || a.no - b.no);
}

export function acceptAndNext(doc: ExamDoc, questionId:string, reviewer='teacher'): ExamDoc {
  // Clears flags locally, recorded as reviewedAt/by in doc — audit trail
  const now = new Date().toISOString();
  return {
    ...doc,
    questions: doc.questions.map(q=> q.id===questionId ? { ...q, flags:[], reviewedAt: now, reviewedBy: reviewer } as any : q),
    flags: doc.flags.filter(f=> (f as any).questionId!==questionId),
  };
}

export function progress(queue: ReviewItem[], accepted: Set<string>): { total:number, reviewed:number, pending:number, text:string } {
  const total = queue.length;
  const reviewed = [...accepted].filter(id=> queue.some(q=>q.questionId===id)).length;
  const pending = total - reviewed;
  return { total, reviewed, pending, text: `${reviewed} of ${total} need review` };
}
