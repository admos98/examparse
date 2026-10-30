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

/** Export boundary identity; internal lookup continues to use numeric grade. */
export function exportIdentity(grade: unknown, subject: unknown): { grade: string; subject: string } {
  const identity = normalizeIdentity(grade, subject);
  const subjectSlug = (identity.subject || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const n = Number(identity.grade);
  const gradeSlug = subjectSlug === 'english' && Number.isInteger(n) && n >= 7 && n <= 12
    ? `english_${gradeDisplay(n).toLowerCase().replace(/\s+/g, '_')}` : (identity.grade || '');
  return { grade: gradeSlug, subject: subjectSlug || (identity.subject || '') };
}
