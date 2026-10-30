/** Sequential, isolated parent-folder import. Storage is injected to keep each save independent. */
import type { ExamDoc } from '../types';
import { importQuestionPackage, type PackageFile } from './packageImport';

export interface PackageBatchSummary {
  imported: number; duplicates: number; failed: number; notPackage: number;
  details: string[];
}
export async function importPackageFolder(files: PackageFile[], existing: ExamDoc[], save: (doc: ExamDoc) => Promise<unknown>, progress?: (message: string) => void): Promise<PackageBatchSummary> {
  const result: PackageBatchSummary = { imported: 0, duplicates: 0, failed: 0, notPackage: 0, details: [] };
  const groups = new Map<string, PackageFile[]>(); let ignored = 0;
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).replace(/\\/g, '/').split('/');
    if (parts.length < 3) { ignored++; continue; }
    const group = parts[1];
    // Strip the chosen parent path so content identity does not depend on folder name.
    const normalized: PackageFile = { name: file.name, webkitRelativePath: parts.slice(2).join('/'), text: () => file.text(), arrayBuffer: () => file.arrayBuffer(), type: file.type };
    groups.set(group, [...(groups.get(group) || []), normalized]);
  }
  if (ignored) result.details.push(`${ignored} file(s) directly in parent ignored.`);
  let i = 0;
  for (const [name, group] of groups) {
    progress?.(`${++i} of ${groups.size}: ${name}`);
    if (!group.some(f => /\.json$/i.test(f.name) && !/export-report\.json$/i.test(f.name))) { result.notPackage++; result.details.push(`${name}: not a package (no JSON).`); continue; }
    try {
      const doc = await importQuestionPackage(group);
      const packages = existing.filter(e => e.source.kind === 'package');
      if (packages.some(e => e.source.packageJsonHash === doc.source.packageJsonHash || e.fileHash === doc.fileHash)) {
        result.duplicates++; result.details.push(`${name}: already imported.`); continue;
      }
      const collision = packages.some(e => e.source.packageBatchId === doc.source.packageBatchId);
      doc.source.packageBatchImport = true;
      await save(doc); existing.push(doc); result.imported++;
      result.details.push(`${name}: imported${collision ? ' (batch ID collision; new version)' : ''}.`);
    } catch (error) { result.failed++; result.details.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result;
}
