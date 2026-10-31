/** Sequential, isolated parent-folder import. Storage is injected to keep each save independent. */
import type { ExamDoc } from '../types';
import { importQuestionPackage, type PackageFile } from './packageImport';

export interface PackageBatchSummary {
  imported: number; duplicates: number; failed: number; notPackage: number;
  details: string[];
}

/** Relative path inside the user's selection (the selected folder name itself is dropped). */
function relativePath(file: PackageFile): string[] {
  const raw = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
  return raw.split('/').filter(Boolean);
}

/**
 * #58 Part D — how a picked folder maps to logical packages.
 *
 * - The selection itself is ONE package when it holds the package root directly
 *   (`batch.json`, `part-<n>/batch.json`, `assets/…`). This covers a multipart export picked at
 *   its root: part folders plus the shared asset pool are ONE exam, never three.
 * - Otherwise the first folder inside the selection is the package (`parent/exam/batch.json`):
 *   ordinary parent-folder multi-exam isolation is unchanged.
 */
export function groupPackageFiles(files: PackageFile[]): { groups: Map<string, PackageFile[]>; ignored: number } {
  const selectionIsPackage = files.some(file => {
    const parts = relativePath(file).slice(1);
    if (!parts.length) return false;
    if (parts.length === 1) return /^batch\.json$/i.test(parts[0]);
    return /^part-\d+$/i.test(parts[0]) || /^assets$/i.test(parts[0]);
  });
  const groups = new Map<string, PackageFile[]>();
  let ignored = 0;
  for (const file of files) {
    const parts = relativePath(file);
    if (!parts.length) { ignored++; continue; }
    let group: string;
    let inner: string[];
    if (selectionIsPackage) {
      inner = parts.slice(1);
      group = selectionName(files);
    } else {
      if (parts.length < 3) { ignored++; continue; }
      group = parts[1];
      inner = parts.slice(2);
    }
    // Strip the chosen parent path so content identity does not depend on folder name.
    const normalized: PackageFile = { name: file.name, webkitRelativePath: inner.join('/'), text: () => file.text(), arrayBuffer: () => file.arrayBuffer(), type: file.type };
    groups.set(group, [...(groups.get(group) || []), normalized]);
  }
  return { groups, ignored };
}

function selectionName(files: PackageFile[]): string {
  const first = relativePath(files[0] || ({ name: '' } as PackageFile))[0] || 'package';
  return first;
}

export async function importPackageFolder(files: PackageFile[], existing: ExamDoc[], save: (doc: ExamDoc) => Promise<unknown>, progress?: (message: string) => void, enrich?: (doc: ExamDoc, progress: (message: string) => void) => Promise<ExamDoc>): Promise<PackageBatchSummary> {
  const result: PackageBatchSummary = { imported: 0, duplicates: 0, failed: 0, notPackage: 0, details: [] };
  const { groups, ignored } = groupPackageFiles(files);
  if (ignored) result.details.push(`${ignored} file(s) directly in parent ignored.`);
  const pending: Array<{ name: string; doc: ExamDoc; detail: number; position: number }> = [];
  let i = 0;
  for (const [name, group] of groups) {
    progress?.(`Exam ${++i} of ${groups.size}: ${name} · import`);
    if (!group.some(f => /\.json$/i.test(f.name) && !/export-report\.json$/i.test(f.name))) { result.notPackage++; result.details.push(`${name}: not a package (no JSON); enrichment not-run.`); continue; }
    try {
      const doc = await importQuestionPackage(group);
      const packages = existing.filter(e => e.source.kind === 'package');
      if (packages.some(e => e.source.packageJsonHash === doc.source.packageJsonHash || e.fileHash === doc.fileHash)) {
        result.duplicates++; result.details.push(`${name}: already imported (duplicate); enrichment not-run.`); continue;
      }
      const collision = packages.some(e => e.source.packageBatchId === doc.source.packageBatchId);
      doc.source.packageBatchImport = true;
      await save(doc); existing.push(doc); result.imported++;
      const parts = doc.source.packageParts?.length || 1;
      result.details.push(`${name}: imported${parts > 1 ? ` (${parts} parts, ${doc.questions.length} questions)` : ''}${collision ? ' (batch ID collision; new version)' : ''}; enrichment not-run${enrich ? ' (queued)' : ' (import only)'}.`);
      pending.push({ name, doc, detail: result.details.length - 1, position: i });
    } catch (error) { result.failed++; result.details.push(`${name}: import failed — ${error instanceof Error ? error.message : String(error)}; enrichment not-run.`); }
  }
  if (enrich) for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    const prefix = `Exam ${item.position} of ${groups.size}: ${item.name} · `;
    progress?.(`${prefix}verify & enrich`);
    try {
      const next = await enrich(item.doc, message => progress?.(`${prefix}${message}`));
      await save(next);
      const status = next.source.enrichmentStatus;
      const reason = next.source.enrichmentNotes?.join('; ') || (status === 'completed' ? 'completed' : 'no decision results');
      result.details[item.detail] = result.details[item.detail].replace(/enrichment not-run.*$/, `enrichment ${status === 'completed' ? '✓' : status === 'partial' ? 'partial' : reason.includes('No decision provider configured') ? 'not-run' : 'failed'} — ${reason}.`);
    } catch (error) {
      result.details[item.detail] = result.details[item.detail].replace(/enrichment not-run.*$/, `enrichment failed — ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  return result;
}
