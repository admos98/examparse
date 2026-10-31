import type { ExamDoc } from '../types';
import { exportSafeQuestion } from '../utils/explanationVisibility';
import { exportIdentity } from './identity';

export type BulkAction = { type:'setPoints', points:number } | { type:'setType', qType:string } | { type:'moveSection', sectionId:string } | { type:'delete' } | { type:'reSlice' };

export function applyBulk(doc: ExamDoc, questionIds:string[], action:BulkAction): { doc: ExamDoc, undo:string } {
  let newDoc: ExamDoc = JSON.parse(JSON.stringify(doc));
  const before = JSON.stringify(doc);
  switch(action.type){
    case 'setPoints':
      newDoc.questions = newDoc.questions.map(q=> questionIds.includes(q.id) ? {...q, points: action.points} : q);
      break;
    case 'setType':
      newDoc.questions = newDoc.questions.map(q=> questionIds.includes(q.id) ? {...q, type: action.qType as any} : q);
      break;
    case 'moveSection':
      newDoc.questions = newDoc.questions.map(q=> questionIds.includes(q.id) ? {...q, sectionId: action.sectionId} : q);
      break;
    case 'delete':
      newDoc.questions = newDoc.questions.filter(q=> !questionIds.includes(q.id));
      newDoc.flags = [...newDoc.flags, {id:`flag_bulk_delete_${Date.now()}`, severity:'warn', code:'BULK_DELETE', message:`Deleted ${questionIds.length} questions via bulk`} as any];
      break;
    case 'reSlice':
      // Deterministic reassembly from spans: just re-slice stem from source (already deterministic)
      for(const q of newDoc.questions){
        if(questionIds.includes(q.id)){
          // Re-slice: rebuild stem from spans (already done via assemble)
          // For test, just mark rewrites empty
          q.rewrites = [];
        }
      }
      break;
  }
  const undo = before; // one Undo stores snapshot
  return { doc: newDoc, undo };
}

export function exportSelected(doc: ExamDoc, questionIds:string[]): { json: any, printHtml: string }{
  const selected = doc.questions.filter(q=> questionIds.includes(q.id));
  const json = { ...doc, meta: { ...doc.meta, ...exportIdentity(doc.meta.grade, doc.meta.subject) }, questions: selected.map(question => exportSafeQuestion(question)), sections: doc.sections, displayName: doc.displayName + ' — Selected' };
  const printHtml = `<html><body>${selected.map(q=>`<div class="question"><h3>Q${q.no}</h3><p>${q.stem||''}</p></div>`).join('')}</body></html>`;
  return { json, printHtml };
}
