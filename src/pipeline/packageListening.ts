import type { Question } from '../types';

/** Use the same evidence to classify listening items at import and at judging. */
export function packageListeningEvidence(q: Question, sectionTitle?: string): string {
  const metadata = q.imported;
  return [sectionTitle, q.stem, metadata?.title, metadata?.instructions,
    typeof metadata?.section === 'string' ? metadata.section : undefined,
    metadata?.section_title, metadata?.sectionTitle, metadata?.provenance?.source_ref]
    .filter(value => typeof value === 'string').join(' ');
}

export function isPackageListeningQuestion(q: Question, sectionTitle?: string): boolean {
  return /\b(?:listen|listening|audio|recording|transcript)\b|شنید/i.test(packageListeningEvidence(q, sectionTitle));
}
