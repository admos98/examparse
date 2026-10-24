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
  PARTIAL_STORAGE: 'One or more image blobs could not be stored locally; restore missing images from source.',
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

const CONTENT_CODE = /(?:MISSING|HOLLOW|OPTION|POINTS|UNRESOLVED|IMAGE_REF_DROPPED|IMAGE_ASSET_ABSENT|PARTIAL_STORAGE|IMAGE_DISTRIBUTION|ANSWER_ANCHOR_SUSPECT|ANSWER_NUMBER_ONLY|COVERAGE|SHAPE_|STEM_OVERLONG)/;
const REPAIR_CODE = /(?:STRIPPED|ABSORBED|EXTENDED|RECOVERED|DEMOTED|CORRECTED|DISTRIBUTED|REMAPPED|DETACHED|DERIVED|REPAIR_APPLIED|COMPLETED|EXCISED)/;

/** Per-question codes whose root cause is inherently a shared storage failure unless overridden. */
const STORAGE_ROOT_CAUSE_CODES = new Set([
  'IMAGE_REF_DROPPED',
  'IMAGE_REFS_UNRESOLVED',
  'IMAGE_UNRESOLVED',
  'UNRESOLVED_IMAGE',
]);

/** Per-question codes that share a root cause when they stem from the same parent group or section. */
const SECTION_COUPLED_CODES = new Set([
  'POINTS_UNPRICED',
  'POINTS_MISMATCH',
  'POINTS_OVERFLOW',
  'GROUP_IMAGE_DISTRIBUTION_FALLBACK',
  'GROUP_IMAGE_DISTRIBUTION_UNASSIGNED',
  'ANSWER_ANCHOR_SUSPECT',
  'ANSWER_NUMBER_ONLY_MISSING',
  'PASSAGE_DETACHED',
  'SECTION_SPAN_OUTSIDE',
]);

export interface AttentionGroup {
  id: string;
  code: string;
  rootCauseId: string;
  severity: Flag['severity'];
  summary: string;
  count: number;
  expandable: boolean;
  flags: Flag[];
  questionIds: string[];
}

export function triageFlags(flags: Flag[]) {
  const attention: Flag[] = [], repairs = new Map<string, Flag[]>(), technical: Flag[] = [];
  for (const flag of flags || []) {
    if ((flag.severity === 'warn' || flag.severity === 'error') && CONTENT_CODE.test(flag.code)) attention.push(flag);
    else if (flag.severity === 'info' && REPAIR_CODE.test(flag.code)) repairs.set(flag.code, [...(repairs.get(flag.code) || []), flag]);
    else technical.push(flag);
  }
  return { attention, repairs, technical };
}

export function flagSentence(flag: Flag, doc: Pick<ExamDoc, 'questions'>): string {
  const q = (doc.questions || []).find(item => item.id === flag.questionId);
  if (flag.code === 'PARTIAL_STORAGE' && flag.message) {
    return `${q ? `Q${q.no}: ` : 'Exam: '}${flag.message}`;
  }
  return `${q ? `Q${q.no}: ` : 'Exam: '}${FLAG_TEMPLATES[flag.code] || flag.message}`;
}

function resolveQuestionRootCauseId(
  flag: Flag,
  doc: Pick<ExamDoc, 'questions'> & Partial<Pick<ExamDoc, 'sections'>>,
): { rootCauseId: string; rootCauseLabel?: string } {
  const explicit = typeof (flag as any).rootCauseId === 'string' && (flag as any).rootCauseId.trim()
    ? (flag as any).rootCauseId.trim()
    : undefined;
  if (explicit) {
    return { rootCauseId: explicit, rootCauseLabel: explicit.replace(/_/g, ' ') };
  }
  if (STORAGE_ROOT_CAUSE_CODES.has(flag.code)) {
    return { rootCauseId: 'storage_failure', rootCauseLabel: 'one storage failure' };
  }
  const q = (doc.questions || []).find(item => item.id === flag.questionId);
  if (q?.parentId) {
    const parent = (doc.questions || []).find(item => item.id === q.parentId);
    return {
      rootCauseId: `parent_${q.parentId}`,
      rootCauseLabel: parent ? `group Q${parent.no}` : `group ${q.parentId}`,
    };
  }
  if (q?.sectionId && SECTION_COUPLED_CODES.has(flag.code)) {
    const sec = (doc.sections || []).find(item => item.id === q.sectionId);
    return {
      rootCauseId: `section_${q.sectionId}`,
      rootCauseLabel: sec?.title ? `${sec.title}` : `section ${q.sectionId}`,
    };
  }
  return { rootCauseId: `question_${flag.questionId}` };
}

/**
 * Part B2 — Group human-facing attention flags by (flag code, root cause id).
 * Underlying `doc.flags` and Assistant's `get_open_issues` remain untouched.
 */
export function groupAttentionFlags(
  flags: Flag[],
  doc: Pick<ExamDoc, 'questions'> & Partial<Pick<ExamDoc, 'sections'>>,
): AttentionGroup[] {
  const { attention } = triageFlags(flags);
  const buckets = new Map<string, { code: string; rootCauseId: string; rootCauseLabel?: string; isExam: boolean; flags: Flag[] }>();

  for (const flag of attention) {
    if (!flag.questionId) {
      const explicit = typeof (flag as any).rootCauseId === 'string' && (flag as any).rootCauseId.trim()
        ? (flag as any).rootCauseId.trim()
        : undefined;
      const rootCauseId = explicit || (flag.code === 'IMAGE_ASSET_ABSENT' || flag.code === 'PARTIAL_STORAGE'
        ? 'storage_failure'
        : `exam_${flag.code}_${FLAG_TEMPLATES[flag.code] || flag.message}`);
      const key = `exam::${flag.code}::${rootCauseId}`;
      const existing = buckets.get(key);
      if (existing) existing.flags.push(flag);
      else buckets.set(key, { code: flag.code, rootCauseId, rootCauseLabel: 'one storage failure', isExam: true, flags: [flag] });
    } else {
      const { rootCauseId, rootCauseLabel } = resolveQuestionRootCauseId(flag, doc);
      const key = `q::${flag.code}::${rootCauseId}`;
      const existing = buckets.get(key);
      if (existing) existing.flags.push(flag);
      else buckets.set(key, { code: flag.code, rootCauseId, rootCauseLabel, isExam: false, flags: [flag] });
    }
  }

  const qById = new Map((doc.questions || []).map(q => [q.id, q]));
  const groups: AttentionGroup[] = [];

  for (const [key, bucket] of buckets) {
    const count = bucket.flags.length;
    const severity: Flag['severity'] = bucket.flags.some(f => f.severity === 'error') ? 'error' : 'warn';
    const questionIds = [...new Set(bucket.flags.map(f => f.questionId).filter((id): id is string => Boolean(id)))];

    if (bucket.isExam) {
      let summary: string;
      if (count > 1 && bucket.code === 'IMAGE_ASSET_ABSENT') {
        summary = `Exam: ${count} images absent from storage — one storage failure`;
      } else if (count > 1) {
        const base = FLAG_TEMPLATES[bucket.code] || bucket.flags[0].message;
        summary = `Exam: ${base} (×${count})`;
      } else {
        summary = flagSentence(bucket.flags[0], doc);
      }
      groups.push({
        id: key,
        code: bucket.code,
        rootCauseId: bucket.rootCauseId,
        severity,
        summary,
        count,
        expandable: false,
        flags: bucket.flags,
        questionIds: [],
      });
    } else if (count === 1) {
      groups.push({
        id: key,
        code: bucket.code,
        rootCauseId: bucket.rootCauseId,
        severity,
        summary: flagSentence(bucket.flags[0], doc),
        count: 1,
        expandable: false,
        flags: bucket.flags,
        questionIds,
      });
    } else {
      const nos = questionIds
        .map(id => qById.get(id)?.no)
        .filter((n): n is number => typeof n === 'number')
        .sort((a, b) => a - b);
      const qLabel = nos.length
        ? (nos.length <= 4 ? nos.map(n => `Q${n}`).join(', ') : `Q${nos[0]}–Q${nos[nos.length - 1]}`)
        : `${count} questions`;
      const causeSuffix = bucket.rootCauseLabel ? ` · ${bucket.rootCauseLabel}` : '';
      const base = FLAG_TEMPLATES[bucket.code] || bucket.flags[0].message;
      groups.push({
        id: key,
        code: bucket.code,
        rootCauseId: bucket.rootCauseId,
        severity,
        summary: `${qLabel} (${count} questions${causeSuffix}): ${base}`,
        count,
        expandable: true,
        flags: bucket.flags,
        questionIds,
      });
    }
  }

  return groups;
}
