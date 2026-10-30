/** Deliberately simple shape checks, not semantic or model judgments. */
import type { Question } from '../types';

export function stemEndsMidWordOrSentence(q: Question): boolean {
  const stem = (q.stem || '').trim();
  return /(?:\p{L}-|\.{3}|…|\b(?:the|a|an|of|to|with|because|and|or|if|when|which|that|is|are)\s*)$/iu.test(stem);
}
export function hasEmptyOrPlaceholderOption(q: Question): boolean {
  return (q.options || []).some(o => !o.text?.trim() || /^(?:\[?\s*(?:missing|placeholder|tbd|todo)\s*\]?|[-_.?…]{2,})$/i.test(o.text.trim()));
}
export function referencesAbsentMaterial(q: Question, passage?: string): boolean {
  const stem = q.stem || '';
  return (/\b(?:the|this|above|following)\s+(?:reading\s+)?(?:passage|text|paragraph)\b/i.test(stem) && !passage && !stem.split(/\n\s*\n/).some(block => block.trim().length >= 200)) ||
    (/\b(?:picture|image|photo|illustration|diagram)\b/i.test(stem) && !q.images.length) ||
    (/\b(?:the|this|above|following)\s+(?:table|chart)\b/i.test(stem) && !q.tables?.length && !q.images.length);
}
export function markedlyShorterThanSource(q: Question, passage?: string): boolean {
  const length = (q.stem || '').length + (passage || '').length + (q.options || []).reduce((sum, o) => sum + (o.text || '').length, 0);
  return typeof q.packageSourceTextLength === 'number' && q.packageSourceTextLength >= 40 && length < q.packageSourceTextLength * .6;
}
export function hasCompletenessCorroboration(q: Question, passage?: string): boolean {
  return stemEndsMidWordOrSentence(q) || hasEmptyOrPlaceholderOption(q) || referencesAbsentMaterial(q, passage) || markedlyShorterThanSource(q, passage);
}
