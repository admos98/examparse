/**
 * Local post-assembly gates shared by the pipeline and the golden bench (Parts B/C):
 * section split at inner headers → section assembly → containment reassignment →
 * META_TOTAL reconciliation → ownership map / ORPHAN_LINES. Pure, 0 model calls.
 */
import type { ExamSection, Flag, Question, SourceLine } from '../types';
import { assembleAndValidateSections, canonicalizeSections } from './assemble';
import { computeOwnership, orphanFlag, reassignSectionsByContainment, splitSectionsAtHeaders, type OwnershipMap } from './ownership';
import { reconcileMetaTotal } from './quality';

export interface LocalGatesResult {
  questions: Question[];
  sections: ExamSection[];
  totalPoints?: number;
  flags: Flag[];
  ownership: OwnershipMap;
  splits: number;
  reassigned: number;
  ambiguous: number;
}

export function applyLocalGates(params: {
  questions: Question[];
  rawSections: any[];
  lines: SourceLine[];
  keyLines: number[] | Set<number>;
  metaTotalPoints?: number;
}): LocalGatesResult {
  const keyLines = params.keyLines instanceof Set ? [...params.keyLines] : params.keyLines;
  const flags: Flag[] = [];
  let questions = params.questions;

  // Fill undeclared section ids locally from the question's first source line.
  const sectionSplit = splitSectionsAtHeaders(params.rawSections || [], params.lines);
  for (const split of sectionSplit.splits) flags.push({ id: `flag_SECTION_SPLIT_LOCAL_${split.sectionId}_${split.atLine}`, severity: 'info', code: 'SECTION_SPLIT_LOCAL', message: `Section ${split.sectionId} contained header “${split.title}” at L${String(split.atLine).padStart(4, '0')}; split locally.` });
  questions = questions.map(question => {
    if (question.sectionId && sectionSplit.sections.some((s: any) => s.id === question.sectionId)) return question;
    const firstLine = question.spans[0]?.[0];
    const section = sectionSplit.sections.find((candidate: any) => (candidate.spans || []).some((span: any) => firstLine >= span[0] && firstLine <= span[1]));
    return section ? { ...question, sectionId: section.id } : question;
  });
  const sectionAssembly = assembleAndValidateSections(sectionSplit.sections, params.lines, questions, keyLines);
  flags.push(...sectionAssembly.flags.map((f, i) => ({ ...f, id: f.id || `flag_section_${i + 1}` })));

  const containment = reassignSectionsByContainment(questions, sectionAssembly.sections);
  questions = containment.questions;
  for (const r of containment.reassigned) flags.push({ id: `flag_SECTION_REASSIGNED_${r.questionId}`, severity: 'info', code: 'SECTION_REASSIGNED', message: `Question ${questions.find(q => q.id === r.questionId)?.label || r.questionId} moved from section ${r.from || '—'} to ${r.to} (its lines sit inside exactly that section).`, questionId: r.questionId });
  for (const a of containment.ambiguous) {
    flags.push({ id: `flag_SECTION_AMBIGUOUS_${a.questionId}`, severity: 'error', code: 'SECTION_AMBIGUOUS', message: `Question ${questions.find(q => q.id === a.questionId)?.label || a.questionId} is not contained by its section and ${a.candidates.length ? `${a.candidates.length} sections contain it (${a.candidates.join(', ')})` : 'no section contains it'}; queued for review.`, questionId: a.questionId });
    const q = questions.find(item => item.id === a.questionId);
    if (q && !q.flags?.includes('SECTION_AMBIGUOUS')) q.flags = [...(q.flags || []), 'SECTION_AMBIGUOUS'];
  }

  const canonical = canonicalizeSections(sectionAssembly.sections, questions);
  questions = canonical.questions;
  for (const f of canonical.flags) {
    if (!flags.some(existing => existing.code === f.code)) flags.push(f);
  }

  const metaTotal = reconcileMetaTotal(params.metaTotalPoints, params.lines, keyLines, questions);
  if (metaTotal.flag) flags.push({ id: `flag_${metaTotal.flag.code}`, severity: metaTotal.flag.severity, code: metaTotal.flag.code, message: metaTotal.flag.message });

  const ownership = computeOwnership({ lines: params.lines, questions, sections: canonical.sections, keyLines });
  const orphan = orphanFlag(ownership);
  if (orphan) flags.push({ id: 'flag_ORPHAN_LINES', severity: orphan.severity, code: orphan.code, message: orphan.message });

  return { questions, sections: canonical.sections, totalPoints: metaTotal.totalPoints, flags, ownership, splits: sectionSplit.splits.length, reassigned: containment.reassigned.length, ambiguous: containment.ambiguous.length };
}
