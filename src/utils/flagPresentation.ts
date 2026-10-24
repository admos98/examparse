import type { ExamDoc, Flag } from '../types';

export const FLAG_TEMPLATES: Record<string, string> = {
  STEM_HOLLOW: 'The question text is empty; check the source.',
  STEM_OVERLONG: 'The question may contain extra text; check where it ends.',
  OPTIONS_MISSING: 'Answer choices are missing; check the source.',
  OPTION_DUPLICATE: 'Two answer choices are identical; check the choices.',
  OPTION_EMPTY: 'An answer choice is empty; check the source.',
  POINTS_MISMATCH: 'The marks do not add up to the exam total; check the marks.',
  POINTS_UNPRICED: 'No mark was found for this question; check its points.',
  POINTS_OVERFLOW: 'Printed marks conflict with the total; check the source.',
  POINTS_TOTAL_ASSERTION_FAILED: 'The marks do not match the exam total; check the marks.',
  ANSWER_ANCHOR_SUSPECT: 'The key contains instructions here, not an answer; check the key.',
  ANSWER_NUMBER_ONLY_MISSING: 'No answer text was found after the key number; check the key.',
  COVERAGE_MISSING: 'Some questions are missing; check the source.',
  COVERAGE_DUPLICATE: 'Unrelated questions share a number; check their numbering.',
  IMAGE_REF_DROPPED: 'An unavailable image reference was removed; check the source image.',
  IMAGE_ASSET_ABSENT: 'An image is absent from storage; re-import the source to restore it.',
  IMAGE_REFS_UNRESOLVED: 'An image cannot be displayed; check the source.',
  GROUP_IMAGE_DISTRIBUTION_FALLBACK: 'An image was placed by reading order; check its question.',
  GROUP_IMAGE_DISTRIBUTION_UNASSIGNED: 'A shared image still needs a question; place the image.',
  WATERMARK_STRIPPED: 'Watermark stripped',
  GAP_ABSORBED: 'Unclaimed text restored',
  ANSWER_SPAN_EXTENDED: 'Incomplete answer restored',
  ANSWER_KEY_ANCHOR_RECOVERED: 'Answer located in the key',
  INSTRUCTION_DEMOTED: 'Instructions separated from questions',
  TYPE_CORRECTED_BY_FORM: 'Question type corrected',
  GROUP_IMAGE_DISTRIBUTED: 'Image placed on its question',
  IMAGE_REF_REMAPPED: 'Image reference restored',
  PASSAGE_DETACHED: 'Reading passage separated',
  POINTS_DERIVED: 'Marks calculated from source evidence',
  SECTION_TITLE_DERIVED: 'Section title restored',
  TEXT_REPAIR_APPLIED: 'Source text repaired',
};
const CONTENT_CODE = /(?:MISSING|HOLLOW|OPTION|POINTS|UNRESOLVED|IMAGE_REF_DROPPED|IMAGE_ASSET_ABSENT|IMAGE_DISTRIBUTION|ANSWER_ANCHOR_SUSPECT|ANSWER_NUMBER_ONLY|COVERAGE|SHAPE_|STEM_OVERLONG)/;
const REPAIR_CODE = /(?:STRIPPED|ABSORBED|EXTENDED|RECOVERED|DEMOTED|CORRECTED|DISTRIBUTED|REMAPPED|DETACHED|DERIVED|REPAIR_APPLIED|COMPLETED|EXCISED)/;
export function triageFlags(flags: Flag[]) {
  const attention: Flag[] = [], repairs = new Map<string, Flag[]>(), technical: Flag[] = [];
  for (const flag of flags) {
    if ((flag.severity === 'warn' || flag.severity === 'error') && CONTENT_CODE.test(flag.code)) attention.push(flag);
    else if (flag.severity === 'info' && REPAIR_CODE.test(flag.code)) repairs.set(flag.code, [...(repairs.get(flag.code) || []), flag]);
    else technical.push(flag);
  }
  return { attention, repairs, technical };
}
export function flagSentence(flag: Flag, doc: Pick<ExamDoc, 'questions'>): string {
  const q = doc.questions.find(q => q.id === flag.questionId);
  return `${q ? `Q${q.no}: ` : 'Exam: '}${FLAG_TEMPLATES[flag.code] || flag.message}`;
}
