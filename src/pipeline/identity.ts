/** Canonical identity shared by package import and PDF projection. Unknown values are retained. */
import { normalizeGrade, normalizeSubject } from './metaRead';

export function gradeDisplay(grade: number): string {
  const suffix = grade % 100 >= 11 && grade % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[grade % 10] || 'th';
  return `${grade}${suffix} Grade`;
}
export function normalizeIdentity(grade: unknown, subject: unknown): { grade?: string; gradeDisplay?: string; subject?: string } {
  const n = normalizeGrade(grade);
  const rawGrade = grade == null ? '' : String(grade).trim();
  const rawSubject = subject == null ? '' : String(subject).trim();
  const canonicalSubject = normalizeSubject(rawSubject) || normalizeSubject(rawGrade);
  return { ...(n !== undefined ? { grade: String(n), gradeDisplay: gradeDisplay(n) } : rawGrade ? { grade: rawGrade } : {}),
    ...(canonicalSubject ? { subject: canonicalSubject } : rawSubject ? { subject: rawSubject } : {}) };
}
