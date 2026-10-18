import type { Question } from '../types';

export interface QuestionTree {
  roots: Question[];
  children: Map<string, Question[]>;
  parentByChild: Map<string, string>;
  cycleBreaks: Set<string>;
  orphanedParents: Set<string>;
}

/** Build an acyclic, deterministic question tree; bad parent links become visible roots. */
export function buildQuestionTree(questions: Question[]): QuestionTree {
  const ids = new Set(questions.map(question => question.id));
  const parentByChild = new Map<string, string>();
  const cycleBreaks = new Set<string>();
  const orphanedParents = new Set<string>();
  const ordered = [...questions].sort((a, b) => a.no - b.no || a.id.localeCompare(b.id));

  for (const question of ordered) {
    const parentId = question.parentId;
    if (!parentId) continue;
    if (!ids.has(parentId) || parentId === question.id) {
      orphanedParents.add(question.id);
      continue;
    }
    let cursor: string | undefined = parentId;
    const visited = new Set<string>();
    let cyclic = false;
    while (cursor) {
      if (cursor === question.id || visited.has(cursor)) {
        cyclic = true;
        break;
      }
      visited.add(cursor);
      cursor = parentByChild.get(cursor);
    }
    if (cyclic) {
      cycleBreaks.add(question.id);
      continue;
    }
    parentByChild.set(question.id, parentId);
  }

  const children = new Map<string, Question[]>();
  const roots: Question[] = [];
  for (const question of ordered) {
    const parentId = parentByChild.get(question.id);
    if (parentId) children.set(parentId, [...(children.get(parentId) || []), question]);
    else roots.push(question);
  }
  return { roots, children, parentByChild, cycleBreaks, orphanedParents };
}
