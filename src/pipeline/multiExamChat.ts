// F3 Multi-exam chat scope: exam picker + All exams read-only scope answered from dossiers/summaries ONLY
import type { ExamDoc } from '../types';
import type { Dossier } from './dossier';

export function answerLibraryQuestion(query:string, dossiers: Dossier[]): string {
  const q = query.toLowerCase();
  if(q.includes('incomplete') || q.includes('missing')){
    const incomplete = dossiers.filter(d=> d.healthSnapshot.state!=='green');
    return `Found ${incomplete.length} incomplete exams: ${incomplete.map(d=>d.identity.title).join(', ') || 'none'}`;
  }
  if(q.includes('unplaced images')){
    const withUnplaced = dossiers.filter(d=> d.healthSnapshot.unplacedImages>0);
    return `Exams with unplaced images: ${withUnplaced.map(d=>`${d.identity.title} (${d.healthSnapshot.unplacedImages})`).join(', ') || 'none'}`;
  }
  if(q.includes('which exams') || q.includes('list exams')){
    return `You have ${dossiers.length} exams: ${dossiers.map(d=>d.identity.title).join(', ')}`;
  }
  return `I can answer from dossiers/summaries only. Try "which exams are incomplete?" or "find exams with unplaced images". For deep-dive, open Assistant for a specific exam.`;
}
