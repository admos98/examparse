import type { ExamDoc, Question } from '../types';

/** Sum compulsory items and one alternative only. A printed total takes precedence. */
export function optionalPoints(doc: ExamDoc, questions: Question[]): number {
  const groups = doc.optionalGroups || [];
  const grouped = new Set(groups.flatMap(g => g.memberLabels));
  let total = questions.filter(q => !grouped.has(q.label)).reduce((sum, q) => sum + (q.points || 0), 0);
  for (const group of groups) {
    const members = questions.filter(q => group.memberLabels.includes(q.label));
    if (!members.length) continue;
    if (group.printedTotal != null && members.length === group.memberLabels.length) { total += group.printedTotal; continue; }
    if (group.rule === 'unknown') continue;
    if (group.rule === 'choose-one-branch') {
      const branch = Object.keys(group.branches)[0];
      total += members.filter(q => group.branches[branch].includes(q.label)).reduce((sum, q) => sum + (q.points || 0), 0);
    } else {
      for (const no of new Set(members.map(q => q.no))) {
        const choices = members.filter(q => q.no === no);
        const branch = choices[0]?.optionalBranch;
        total += choices.filter(q => q.optionalBranch === branch).reduce((sum, q) => sum + (q.points || 0), 0);
      }
    }
  }
  return Number(total.toFixed(2));
}
