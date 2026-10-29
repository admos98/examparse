/** Conservative, advisory matching against the supplied official-book digest. */
import digest from '../data/curriculum-digest-v2.json';

export interface CurriculumHints { chapter: string | null; lesson: string | null; topic: string | null }
export interface CurriculumLesson { title: string; function?: string; grammar?: string[]; writingFocus?: string; keywords: string; choiceDescription?: string }
export const emptyCurriculumHints = (): CurriculumHints => ({ chapter: null, lesson: null, topic: null });
export function curriculumLessons(grade: unknown, subject: unknown): CurriculumLesson[] {
  if (typeof subject !== 'string' || !/(english|انگلیسی)/i.test(subject) || grade == null) return [];
  const needle = String(grade).trim().toLowerCase();
  if (!needle) return [];
  const grades = Object.values(digest.grades).filter(g => g.aliases.some(alias => alias.toLowerCase() === needle));
  // Some aliases deliberately cover several grades; never guess between them.
  if (grades.length !== 1) return [];
  return Object.values(grades[0].lessons) as CurriculumLesson[];
}
export function hintsForLesson(lesson: CurriculumLesson): CurriculumHints {
  return { chapter: lesson.function || null, lesson: lesson.title || null, topic: lesson.writingFocus || lesson.grammar?.join('; ') || null };
}
export function keywordCurriculumHint(lessons: CurriculumLesson[], text: string): CurriculumHints | undefined {
  const normalized = text.toLocaleLowerCase();
  const scores = lessons.map(lesson => {
    const words = [...new Set(lesson.keywords.toLocaleLowerCase().split(',').map(w => w.trim()).filter(w => w.length >= 4))];
    const score = words.filter(word => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(normalized);
    }).length;
    return { lesson, score };
  }).sort((a, b) => b.score - a.score);
  if (!scores.length || scores[0].score < 2 || scores[0].score <= (scores[1]?.score || 0) + 1) return undefined;
  return hintsForLesson(scores[0].lesson);
}
