// F1 Proactive (silent-by-default) suggestions: top ≤3 from health+dossier as dismissible chips
import type { ExamDoc } from '../types';
import { getExamHealth } from './quality';
import { computeQualityScore } from '../utils/qualityScore';

export interface Chip { id:string, label:string, action:string, tool?:string, dismissible:true }

export function computeSuggestions(doc: ExamDoc): Chip[] {
  const health = getExamHealth(doc);
  const quality = computeQualityScore(doc);
  const chips: Chip[] = [];
  if(health.missing.length>0) chips.push({ id:'missing', label:`${health.missing.length} questions missing — Run remediation`, action:'retry_missing_questions', tool:'retry_missing_questions', dismissible:true });
  if(health.unplacedImages.length>0) chips.push({ id:'unplaced', label:`${health.unplacedImages.length} images unplaced — Review`, action:'place_images', tool:'assign_image', dismissible:true });
  if(quality.total<80) chips.push({ id:'quality', label:`Quality ${quality.total} — See why`, action:'explain_score', dismissible:true });
  return chips.slice(0,3);
}

export function explainScoreDetail(q: ReturnType<typeof computeQualityScore>): string {
  return `Coverage ${q.coverage}/30, Points ${q.points}/15, Options ${q.optionsCleanliness}/15, Images ${q.imagePlacement}/15, Numbering ${q.numbering}/10, Confidence ${q.confidence}/10, Passage ${q.passage}/5 = Total ${q.total}/100`;
}
