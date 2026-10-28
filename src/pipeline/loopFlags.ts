import type { ExamDoc, Flag } from '../types';
import type { LoopReceipt } from './localLoop';
export function loopFlags(receipt: LoopReceipt, doc: Pick<ExamDoc, 'questions'>): Flag[] {
  const flags: Flag[] = receipt.survivingVerdicts.map((v, index) => {
    const questionId = doc.questions.find(q => v.questionNumbers.includes(q.no))?.id;
    const code = ({ 'empty-stem': 'STEM_HOLLOW', 'options-missing-for-type': 'OPTIONS_MISSING', 'points-sum-mismatch': 'POINTS_MISMATCH', 'image-unassigned': 'IMAGE_UNPLACED', 'image-double-assigned': 'IMAGE_ORDER_SUSPECT', 'meta-field-implausible': 'META_MISSING', 'duplicate-number': 'COVERAGE_DUPLICATE', 'missing-number': 'COVERAGE_MISSING' } as Record<string, string>)[v.kind] || (v.source === 'decision' ? 'AUDIT_CATCH' : 'LOOP_VERDICT');
    return { id: `loop_verdict_${index}`, code, severity: 'warn', message: v.message, ...(questionId ? { questionId } : {}), ...(v.imageId ? { imageId: v.imageId } : {}), rootCauseId: v.id };
  });
  for (const [index, message] of receipt.notes.entries()) flags.push({ id: `loop_note_${index}`, code: 'LOOP_NOTE', severity: 'info', message, rootCauseId: `loop_note_${index}` });
  return flags;
}
