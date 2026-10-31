/** Import authored and Appendix A packages without asking a model to reconstruct them. */
import type { ExamDoc, ImageAsset, Question } from '../types';
import { sha256 } from '../utils/hash';
import { normalizeIdentity } from './identity';
import { isPackageListeningQuestion, packageListeningEvidence } from './packageListening';
import { findImagePlaceholderTokens, resolvePlaceholderSha, stripImagePlaceholderTokens } from './imagePlaceholders';
import { validateExamParseInterchange } from '../utils/examparseFormat';

export interface PackageFile { name: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; type?: string; webkitRelativePath?: string }
/** Appendix-A descriptive types (long_answer) and free-form writing variants import as our essay type. */
const types: Record<string, Question['type']> = { multiple_choice: 'mcq', true_false: 'truefalse', fill_in_blank: 'fillblank', short_answer: 'short', matching: 'matching', ordering: 'multi', long_answer: 'essay', essay: 'essay', paragraph: 'essay', writing: 'essay' };
const mimeFor = (name: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' } as Record<string, string>)[name.split('.').pop()!.toLowerCase()];
function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  return undefined;
}
function numberFromTitle(title: string, fallback: number): number {
  const match = /(?:question|\bq)\s*[-#.:]?\s*(\d+)/i.exec(title) || /^\s*(\d+)(?=[A-Za-z]|\s*[.):])/.exec(title);
  return match ? Number(match[1]) : fallback;
}
function labelFromTitle(title: string, fallback: number): string {
  return /(?:question|\bq)\s*[-#.:]?\s*(\d+[A-Za-z]?(?:[-–][A-Za-z0-9]+)?)(?![A-Za-z0-9])/i.exec(title)?.[1] || /^\s*(\d+[A-Za-z]?(?:[-–][A-Za-z0-9]+)?)(?=\s|[.):]|$)/.exec(title)?.[1] || String(fallback);
}
function sectionTitle(title: string): string | undefined {
  const range = title.match(/^(.*?\b(?:questions?|q)\s*\d+\s*[-–]\s*\d+[^\n]*)/i);
  if (range) return range[1].trim();
  // A title that is only a question title is not a section.
  if (/^(?:question|q)\s*\d+\b/i.test(title) || !title.trim()) return undefined;
  const prefix = title.match(/^(.+?)\s*[:—–-]\s*(?:question|q)\s*\d+/i);
  return prefix?.[1].trim();
}
/** Prefer explicit package groups, then repeated title suffixes, then textual markers. */
function deriveSections(batch: any): { rule: 'explicit' | 'title-suffix' | 'marker' | 'fallback'; labels: string[] } {
  const rows: any[] = batch.questions;
  const numbers = rows.map((r, i) => numberFromTitle(String(r?.title || ''), i + 1));
  const groupName = (value: any): string => typeof value === 'string' ? value.trim() : typeof value?.title === 'string' ? value.title.trim() : typeof value?.name === 'string' ? value.name.trim() : '';
  const explicit = rows.map((r, i) => {
    const own = groupName(r?.section) || groupName(r?.section_title) || groupName(r?.sectionTitle);
    if (own) return own;
    const group = Array.isArray(batch.sections) && batch.sections.find((g: any) => {
      const start = Number(g?.start ?? g?.first ?? g?.from ?? g?.firstQuestion ?? g?.first_question ?? g?.appliesToFirst);
      const end = Number(g?.end ?? g?.last ?? g?.to ?? g?.lastQuestion ?? g?.last_question ?? g?.appliesToLast ?? start);
      if (r?.section_id != null && r.section_id === g?.id) return true;
      return (Number.isFinite(start) && Number.isFinite(end) && numbers[i] >= start && numbers[i] <= end) ||
        (Array.isArray(g?.questions ?? g?.question_numbers) && (g.questions ?? g.question_numbers).some((x: any) => x === numbers[i] || (r?.id != null && x === r.id) || (typeof x === 'object' && x?.id && x.id === r?.id)));
    });
    return groupName(group);
  });
  const fill = (labels: string[]) => {
    let current = labels.find(Boolean) || 'Imported questions';
    return labels.map(label => { if (label) current = label; return current; });
  };
  if (explicit.some(Boolean)) return { rule: 'explicit', labels: fill(explicit) };
  const suffixes = rows.map(r => /^\s*(?:question|q)\s*\d+\s*[—–-]\s*(.+?)\s*$/i.exec(String(r?.title || ''))?.[1]?.trim() || '');
  const runs = suffixes.map(() => '');
  for (let i = 0; i < suffixes.length;) {
    let j = i + 1;
    while (j < suffixes.length && suffixes[i] && suffixes[j].toLocaleLowerCase() === suffixes[i].toLocaleLowerCase() && numbers[j] === numbers[j - 1] + 1) j++;
    if (suffixes[i] && j - i >= 2) for (let k = i; k < j; k++) runs[k] = suffixes[i];
    i = j;
  }
  if (runs.some(Boolean)) return { rule: 'title-suffix', labels: fill(runs) };
  const markers = rows.map(r => {
    const text = [r?.instructions, r?.stem, ...(Array.isArray(r?.stem_blocks) ? r.stem_blocks.filter((b: any) => b?.t === 'text').map((b: any) => b.v) : [])].filter(x => typeof x === 'string').join('\n');
    return /^\s*(?:section|part)\s+([A-Za-z0-9]+(?:\s*[:—–-]\s*[^\n]+)?)\s*$/im.exec(text)?.[0]?.trim() || sectionTitle(String(r?.title || '')) || '';
  });
  return markers.some(Boolean) ? { rule: 'marker', labels: fill(markers) } : { rule: 'fallback', labels: rows.map(() => 'Imported questions') };
}
function commonPrefix(a: string, b: string): string {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const prefix = a.slice(0, i);
  // Factor whole prefix blocks only, not an arbitrary shared fragment of a question.
  const boundary = Math.max(prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('\r\n\r\n'));
  return boundary >= 200 ? prefix.slice(0, boundary).trimEnd() : '';
}
export async function importQuestionPackage(files: PackageFile[]): Promise<ExamDoc> {
  const pathOf = (file: PackageFile) => (file.webkitRelativePath || file.name).replace(/\\/g, '/');
  const jsons = files.filter(f => /\.json$/i.test(f.name) && !/export-report\.json$/i.test(f.name));
  const canonicalFile = jsons.find(file => /(?:^|\/)examparse\.json$/i.test(pathOf(file)));
  if (canonicalFile) {
    let canonical: any;
    try { canonical = JSON.parse(await canonicalFile.text()); } catch { throw new Error('ExamParse interchange JSON is invalid.'); }
    const validation = validateExamParseInterchange(canonical);
    if (!validation.valid) throw new Error(`ExamParse interchange is invalid: ${validation.errors.join('; ')}`);
    const prefix = pathOf(canonicalFile).replace(/[^/]+$/, '');
    const byPath = new Map(files.map(file => [pathOf(file).toLowerCase(), file]));
    const manifestFile = byPath.get(`${prefix}assets/manifest.json`.toLowerCase()) || files.find(file => /(?:^|\/)assets\/manifest\.json$/i.test(pathOf(file)));
    const canonicalize = (value: any): any => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value;
    if (!manifestFile) {
      canonical.completeness.state = 'unverified';
      canonical.completeness.issues.push({ code: 'asset-manifest-file-missing', message: 'ZIP is missing the required assets/manifest.json sidecar; canonical asset metadata is retained.' });
    } else {
      try {
        const sidecar = JSON.parse(await manifestFile.text());
        if (JSON.stringify(canonicalize(sidecar)) !== JSON.stringify(canonicalize(canonical.assetManifest))) {
          canonical.completeness.state = 'unverified';
          canonical.completeness.issues.push({ code: 'asset-manifest-disagrees', message: 'assets/manifest.json does not match examparse.json.assetManifest; canonical JSON remains the source of truth.' });
        }
      } catch {
        canonical.completeness.state = 'unverified';
        canonical.completeness.issues.push({ code: 'asset-manifest-invalid', message: 'assets/manifest.json is not valid JSON; canonical asset metadata is retained.' });
      }
    }
    const images: ImageAsset[] = [];
    for (const record of canonical.assetManifest.assets) {
      const recordIds: string[] = Array.isArray(record.sourceIds) && record.sourceIds.length ? record.sourceIds.map(String) : [String(record.id)];
      let sourceFile: PackageFile | undefined;
      if (['available', 'unassigned'].includes(record.state) && typeof record.path === 'string' && !record.path.startsWith('/') && !record.path.split('/').includes('..')) {
        sourceFile = byPath.get(`${prefix}${record.path}`.toLowerCase()) || byPath.get(record.path.toLowerCase()) || files.find(file => pathOf(file).toLowerCase().endsWith(`/${record.path.toLowerCase()}`));
      }
      let dataUrl: string | undefined;
      let storageMissing = !['available', 'unassigned'].includes(record.state) || !record.path;
      if (sourceFile && ['available', 'unassigned'].includes(record.state)) {
        const bytes = new Uint8Array(await sourceFile.arrayBuffer());
        if (!globalThis.crypto?.subtle || await sha256(bytes) !== String(record.sha256).toLowerCase() || sniffImageMime(bytes) !== record.mime) storageMissing = true;
        else {
          let binary = ''; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
          dataUrl = `data:${record.mime};base64,${btoa(binary)}`;
        }
      } else if (['available', 'unassigned'].includes(record.state) && record.path) storageMissing = true;
      for (const id of recordIds) {
        const existing = (canonical.images || []).find((image: any) => image.id === id);
        images.push({ ...(existing || {}), id, page: existing?.page || 1, bbox: existing?.bbox || { x: 0, y: 0, w: 0, h: 0 }, mime: record.mime || existing?.mime || 'application/octet-stream', sha: record.sha256 || existing?.sha || '', width: existing?.width || 0, height: existing?.height || 0, blobKey: record.sha256 || existing?.blobKey, ...(dataUrl ? { dataUrl } : {}), ...(storageMissing ? { storageMissing: true } : {}) } as ImageAsset);
      }
      if (storageMissing) {
        record.state = 'unavailable';
        record.reason = sourceFile ? 'asset bytes failed SHA-256 or MIME verification during import' : 'asset file was not supplied with the package';
        canonical.completeness.issues.push({ code: 'asset-unavailable-on-import', message: record.reason, assetId: String(record.id) });
      }
    }
    const restored = structuredClone(canonical) as ExamDoc & { teacherOnly?: any; assetManifest?: any; completeness?: any; format?: string; formatVersion?: string; exportMeta?: any; parseReport?: any };
    const scriptRows = restored.teacherOnly?.listeningScripts || [];
    for (const script of scriptRows) {
      const matches = restored.questions.filter(question => question.id === script.questionId);
      if (matches.length === 1) matches[0].imported = { ...(matches[0].imported || {}), script: script.text, scriptNote: script.note, scriptEvidenceType: script.evidenceType };
    }
    restored.images = images;
    for (const question of restored.questions) {
      for (const reference of question.images || []) if (!images.some(image => image.id === reference.imageId)) {
        const missing = canonical.assetManifest.assets.find((asset: any) => asset.id === reference.imageId);
        if (missing) images.push({ id: missing.id, page: 1, bbox: { x: 0, y: 0, w: 0, h: 0 }, mime: missing.mime, sha: missing.sha256 || '', width: 0, height: 0, storageMissing: true } as ImageAsset);
      }
    }
    restored.images = images;
    return restored;
  }
  // #58 Part D — a >50-question native export is ONE logical package: every part-N/batch.json is
  // merged, the shared asset pool is resolved once, and a genuinely missing part is reported
  // instead of silently importing a subset.
  const partJsons = jsons
    .map(file => ({ file, match: /(?:^|\/)part-(\d+)\/batch\.json$/i.exec(pathOf(file)) }))
    .filter((entry): entry is { file: PackageFile; match: RegExpExecArray } => Boolean(entry.match))
    .map(entry => ({ file: entry.file, part: Number(entry.match[1]) }))
    .sort((a, b) => a.part - b.part);
  let json: PackageFile | undefined;
  let raw = '';
  let batch: any;
  let parts: string[] = [];
  let multipartStatus: 'complete' | 'partial-unverified' | undefined;
  if (partJsons.length) {
    const numbers = partJsons.map(entry => entry.part);
    if (new Set(numbers).size !== numbers.length) throw new Error('Multipart package contains duplicate part indices.');
    if (numbers.some(number => !Number.isInteger(number) || number < 1)) throw new Error('Multipart package part indices must be positive integers.');
    const expected = Math.max(...numbers);
    const missing = Array.from({ length: expected }, (_, index) => index + 1).filter(number => !numbers.includes(number));
    if (missing.length) throw new Error(`Multipart package is incomplete: missing part ${missing.join(', ')} of ${expected}. Nothing was imported.`);
    const parsed: Array<{ value: any; part: number }> = [];
    for (const entry of partJsons) {
      const text = await entry.file.text();
      let value: any;
      try { value = JSON.parse(text); } catch { throw new Error(`Package part ${entry.part} is not valid JSON.`); }
      if (!value || typeof value.batch_id !== 'string' || !Array.isArray(value.questions) || !value.questions.length) throw new Error(`Package part ${entry.part} needs a batch_id and a nonempty questions array.`);
      if (value.part_index != null && Number(value.part_index) !== entry.part) throw new Error(`Package path part-${entry.part} disagrees with declared part_index ${value.part_index}.`);
      parsed.push({ value, part: entry.part }); raw += text;
    }
    const baseIds = new Set(parsed.map(({ value }) => String(value.batch_id).replace(/-part-\d+$/i, '')));
    if (baseIds.size !== 1) throw new Error('Package parts do not share one batch_id; they are not the same export.');
    const declaredTotals = parsed.map(({ value }) => value.part_total ?? value.parts_total).filter((value: unknown) => value != null).map(Number);
    if (declaredTotals.some((total: number) => !Number.isInteger(total) || total < 1) || new Set(declaredTotals).size > 1) throw new Error('Multipart package parts have inconsistent declared totals.');
    const declared = declaredTotals[0];
    if (declared != null) {
      const missingDeclared = Array.from({ length: declared }, (_, index) => index + 1).filter(number => !numbers.includes(number));
      if (missingDeclared.length || numbers.some(number => number > declared)) throw new Error(`Multipart package is incomplete: missing part ${missingDeclared.join(', ') || `${declared + 1} or later`} of ${declared} (supplied ${numbers.length}). Nothing was imported.`);
      multipartStatus = 'complete';
    } else multipartStatus = 'partial-unverified'; // Older #57 parts carry no trustworthy total.
    batch = {
      ...parsed[0].value,
      batch_id: [...baseIds][0],
      questions: parsed.flatMap(({ value }) => value.questions),
      ...(parsed.some(({ value }) => Array.isArray(value.sections)) ? { sections: parsed.flatMap(({ value }) => Array.isArray(value.sections) ? value.sections : []) } : {}),
    };
    parts = partJsons.map(entry => `part-${entry.part}`);
    json = partJsons[0].file;
    } else {
    json = jsons.find(f => /(^|\/)batch\.json$/i.test(f.webkitRelativePath || f.name)) || (jsons.length === 1 ? jsons[0] : undefined);
    if (!json) throw new Error('Select one package JSON (or batch.json) together with its images.');
    raw = await json.text();
    try { batch = JSON.parse(raw); } catch { throw new Error('Package JSON is invalid.'); }
  }
  if (!batch || typeof batch.batch_id !== 'string' || !Array.isArray(batch.questions) || !batch.questions.length) throw new Error('Package must have a batch_id and a nonempty questions array.');
  // Read the ExamParse lossless bridge as well as the bank row. It is intentionally keyed by the
  // complete source label, never by bare numeric question number.
  let preservedRows: any[] = [];
  let preservedScripts: any[] = [];
  const scriptsFile = files.find(file => /(?:^|\/)preserved\/listening-scripts\.json$/i.test(pathOf(file)));
  if (scriptsFile) {
    try { const value = JSON.parse(await scriptsFile.text()); if (Array.isArray(value?.scripts)) preservedScripts = value.scripts; } catch { /* optional sidecar */ }
  }
  const preservedFile = files.find(file => /(?:^|\/)preserved\/answers\.json$/i.test(pathOf(file)));
  if (preservedFile) {
    try {
      const preserved = JSON.parse(await preservedFile.text());
      if (Array.isArray(preserved?.questions)) preservedRows = preserved.questions;
    } catch { /* an invalid optional sidecar must not discard otherwise valid bank rows */ }
  }
  const preservedFor = (label: string) => {
    const matches = preservedRows.filter(row => String(row?.label || '') === label);
    return matches.length === 1 ? matches[0] : undefined;
  }
  // Two different batch.json files that are not parts of one export would silently drop questions.
  if (!parts.length) {
    const others = jsons.filter(file => file !== json && /(?:^|\/)batch\.json$/i.test(pathOf(file)));
    if (others.length) throw new Error('Select one package at a time (several unrelated batch.json files were found).');
  }
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is required to import package images.');
  const images: ImageAsset[] = []; const byHash = new Map<string, ImageAsset>(); const fileAssets = new Map<string, ImageAsset>();
  const addAsset = async (bytes: Uint8Array, mime: string) => {
    const hash = await sha256(bytes); let asset = byHash.get(hash);
    if (!asset) {
      let data = ''; for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192));
      asset = { id: `img_${hash}`, page: 1, bbox: { x: 0, y: 0, w: 0, h: 0 }, mime, sha: hash, width: 0, height: 0, blobKey: hash, dataUrl: `data:${mime};base64,${btoa(data)}` };
      byHash.set(hash, asset); images.push(asset);
    }
    return asset;
  };
  for (const file of files) {
    const mime = mimeFor(file.name); if (!mime) continue;
    const asset = await addAsset(new Uint8Array(await file.arrayBuffer()), mime);
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    fileAssets.set(path.toLowerCase(), asset); fileAssets.set(file.name.toLowerCase(), asset);
    fileAssets.set(asset.sha.toLowerCase(), asset);
  }
  const sections: ExamDoc['sections'] = []; const derivation = deriveSections(batch);
  const structuralOwners = new Map<string, Set<string>>();
  const markStructural = (imageId: string, questionId: string) => { const owners = structuralOwners.get(imageId) || new Set<string>(); owners.add(questionId); structuralOwners.set(imageId, owners); };
  const questions: Question[] = [];
  /** #57 Part C — tokens whose asset file was absent: stripped from the stem, surfaced as flags. */
  const unresolvedImageTokens: Array<{ label: string; sha: string; questionId: string }> = [];
  for (let index = 0; index < batch.questions.length; index++) {
    const row = batch.questions[index];
    if (!row || typeof row !== 'object' || typeof row.type !== 'string' || (typeof row.stem !== 'string' && !Array.isArray(row.stem_blocks))) throw new Error(`Question ${index + 1} needs a type and stem or stem_blocks.`);
    const title = typeof row.title === 'string' ? row.title : '';
    const explicitLabel = typeof row.label === 'string' && /^\d+[A-Za-z]?(?:[-–][A-Za-z0-9]+)?$/.test(row.label.trim()) ? row.label.trim() : undefined;
    const no = explicitLabel ? Number(/^\d+/.exec(explicitLabel)![0]) : numberFromTitle(title, index + 1); const st = derivation.labels[index];
    if (!sections.length || sections[sections.length - 1].title !== st) sections.push({ id: `section_${sections.length + 1}`, index: sections.length, title: st, spans: [] });
    const refs: Question['images'] = [];
    const positions: NonNullable<Question['packageImagePositions']> = [];
    const attach = (asset?: ImageAsset) => { if (asset && !refs.some(r => r.imageId === asset.id)) refs.push({ imageId: asset.id, role: 'stem' }); };
    let stem = '';
    if (Array.isArray(row.stem_blocks)) {
      for (const block of row.stem_blocks) {
        if (block?.t === 'text' && typeof block.v === 'string') stem += block.v;
        if (block?.t === 'img' && typeof block.asset === 'string') {
          const asset = fileAssets.get(block.asset.toLowerCase()) || fileAssets.get(block.asset.split('/').pop()!.toLowerCase());
          if (!asset) throw new Error(`Missing package asset: ${block.asset}`);
          attach(asset); positions.push({ imageId: asset.id, offset: stem.length });
        }
      }
    } else {
      const pattern = /!\[[^\]]*\]\((data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+))\)/g;
      let previous = 0; let match: RegExpExecArray | null;
      while ((match = pattern.exec(row.stem))) {
        stem += row.stem.slice(previous, match.index); previous = pattern.lastIndex;
        let decoded: string; try { decoded = atob(match[3].replace(/\s/g, '')); } catch { throw new Error(`Invalid embedded image in question ${no}.`); }
        const asset = await addAsset(Uint8Array.from(decoded, c => c.charCodeAt(0)), match[2]); attach(asset); positions.push({ imageId: asset.id, offset: stem.length });
      }
      stem += row.stem.slice(previous);
    }
    // Script filenames are provenance, not instructions a student can follow.
    const originalStem = stem;
    const replacements: Array<{ start: number; end: number; length: number }> = [];
    stem = stem.replace(/Listen to[^.\n]*?\b(?:listening[^\s,]*|transcript[^\s,]*)\.md(?:\s*,?\s*Section\s+(\d+))?\s*\./gi,
      (match, section, offset) => { const clean = `Listen to the recording${section ? ` (Section ${section})` : ''}.`; replacements.push({ start: offset, end: offset + match.length, length: clean.length }); return clean; });
    for (const position of positions) {
      const original = position.offset;
      position.offset = original + replacements.reduce((delta, r) => delta + (original >= r.end ? r.length - (r.end - r.start) : original > r.start ? r.length - (original - r.start) : 0), 0);
    }
    // #57 Part C — placeholder tokens (img_<sha>, img_<sha>stem, assets/<sha>.<ext>) are REFERENCES:
    // attach the matching package asset at the token's position and strip the token from the stem.
    // The token is stripped even when its asset file is absent — it must never reach Step 4 or an export.
    const tokenHits = findImagePlaceholderTokens(stem);
    if (tokenHits.length) {
      const tokenReplacements = tokenHits.map(hit => ({ start: hit.start, end: hit.end, length: 0 }));
      const shift = (at: number) => tokenReplacements.reduce((delta, r) => delta + (at >= r.end ? r.length - (r.end - r.start) : at > r.start ? r.length - (at - r.start) : 0), 0);
      for (const position of positions) position.offset = Math.max(0, position.offset + shift(position.offset));
      for (const hit of tokenHits) {
        const sha = resolvePlaceholderSha(hit.sha, byHash.keys());
        const asset = sha ? byHash.get(sha) : undefined;
        if (asset) { attach(asset); positions.push({ imageId: asset.id, offset: Math.max(0, hit.start + shift(hit.start)) }); }
        else unresolvedImageTokens.push({ label: explicitLabel || labelFromTitle(title, no), sha: hit.sha, questionId: `q_${index + 1}` });
      }
      stem = stripImagePlaceholderTokens(stem);
    }
    for (const ref of refs) markStructural(ref.imageId, `q_${index + 1}`);
    const sourceTextLength = stem.trim().length + (Array.isArray(row.options) ? row.options.reduce((n: number, o: any) => n + String(o?.text ?? '').length, 0) : 0);
    const leading = stem.length - stem.trimStart().length;
    positions.forEach(p => { p.offset = Math.max(0, p.offset - leading); });
    const key = row.answer_key;
    const importedType = types[String(row.type || '').toLowerCase()] || 'unknown';
    const rawCorrect = key && Array.isArray(key.correct) ? key.correct.map(String) : [];
    const bankCorrect = rawCorrect.map((value: string) => {
      if (['mcq', 'matching', 'multi'].includes(importedType) && Array.isArray(row.options) && /^\d+$/.test(value)) {
        const index = Number(value) - 1;
        if (index >= 0 && index < row.options.length) return String(row.options[index].key);
      }
      if (importedType === 'truefalse' && !(row.options || []).length) {
        if (['1', 'true', 't', 'yes'].includes(value.toLowerCase())) return 'True';
        if (['2', 'false', 'f', 'no'].includes(value.toLowerCase())) return 'False';
      }
      return value;
    });
    let answer: Question['answer'] = key && !['short', 'long', 'essay'].includes(importedType) && bankCorrect.length ? { text: bankCorrect.join(', '), source: 'paper' as const } : undefined;
    const { stem: _stem, stem_blocks: _blocks, options: _options, ...metadata } = row;
    const sidecar = preservedFor(explicitLabel || labelFromTitle(title, no));
    if (sidecar?.source_history) metadata.source_history = sidecar.source_history;
    if (sidecar?.teacher_answer && typeof sidecar.teacher_answer.text === 'string' && sidecar.teacher_answer.text.trim()) answer = { text: sidecar.teacher_answer.text.trim(), source: 'manual' };
    const unresolvedForQuestion = unresolvedImageTokens.filter(hit => hit.questionId === `q_${index + 1}`).map(hit => ({ asset: `img_${hit.sha}`, sha: hit.sha, owner: explicitLabel || labelFromTitle(title, no), reason: 'pixels unavailable in package' }));
    if (unresolvedForQuestion.length) metadata.unresolved_placeholders = unresolvedForQuestion;
    const sampleRaw = row.sample_answer || row.sampleAnswer || row.answerKey?.sampleAnswer || row.answer_key?.sampleAnswer;
    const sidecarSample = Array.isArray(sidecar?.descriptive) ? sidecar.descriptive.find((artifact: any) => typeof artifact?.text === 'string') : undefined;
    let sampleText = typeof sampleRaw === 'string' ? sampleRaw : typeof sampleRaw?.text === 'string' ? sampleRaw.text : sidecarSample?.text;
    if (!sampleText && ['short', 'long', 'essay'].includes(importedType) && Array.isArray(key?.correct) && key.correct.length === 1) sampleText = String(key.correct[0]);
    const sampleSourceRaw = typeof sampleRaw === 'object' ? sampleRaw.source || sampleRaw.provenance : undefined;
    const sampleSource = ['model', 'teacher', 'paper', 'keyfile', 'manual'].includes(sampleSourceRaw) ? sampleSourceRaw : sidecarSample?.source || (sampleText ? 'paper' : undefined);
    const sampleJudgedRaw = typeof sampleRaw === 'object' ? sampleRaw.judged : sidecarSample?.judged;
    const sampleJudged = ['verified', 'uncertain', 'rejected', 'unjudged'].includes(sampleJudgedRaw) ? sampleJudgedRaw : 'unjudged';
    const rubricRaw = row.rubric || row.rubrics || row.answerKey?.rubric;
    const sidecarRubric = Array.isArray(sidecar?.descriptive) ? sidecar.descriptive.find((artifact: any) => Array.isArray(artifact?.criteria)) : undefined;
    const rubricCriteria = Array.isArray(rubricRaw?.criteria) ? rubricRaw.criteria : sidecarRubric?.criteria;
    const rubricSourceRaw = rubricRaw?.sourceProvenance || rubricRaw?.source || sidecarRubric?.source;
    const rubricSource = ['model', 'teacher', 'paper', 'keyfile', 'manual'].includes(rubricSourceRaw) ? rubricSourceRaw : undefined;
    const rubricJudgedRaw = rubricRaw?.judged || sidecarRubric?.judged;
    const rubricJudged = ['verified', 'uncertain', 'rejected', 'unjudged'].includes(rubricJudgedRaw) ? rubricJudgedRaw : 'unjudged';
    const preservedTags = Array.isArray(row.tags) ? row.tags : Array.isArray(sidecar?.review_tags) ? sidecar.review_tags : [];
    const scriptRef = originalStem.match(/[^.\n]*(?:listening|transcript)[^\n]*?\.md[^\n]*/i)?.[0]?.trim();
    if (scriptRef) metadata.provenance = { ...(metadata.provenance || {}), source_ref: [metadata.provenance?.source_ref, scriptRef].filter(Boolean).join(' — ') };
    questions.push({ id: `q_${index + 1}`, no, label: explicitLabel || labelFromTitle(title, no), sectionId: sections[sections.length - 1].id, spans: [], stem: stem.trim(), type: importedType,
      options: Array.isArray(row.options) ? row.options.map((o: any) => ({ key: String(o.key), text: String(o.text ?? ''), spans: [] })) : [],
      ...(answer ? { answer } : {}),
      ...(typeof sampleText === 'string' && sampleText.trim() ? { sampleAnswer: { text: sampleText.trim(), source: sampleSource || 'paper', judged: sampleJudged, ...(sidecarSample?.evidence ? { evidence: sidecarSample.evidence } : {}), ...(sidecarSample?.stale ? { stale: true } : {}), ...(sidecarSample?.reconfirm ? { reconfirm: true } : {}) } } : {}),
      ...(Array.isArray(rubricCriteria) && rubricSource ? { rubric: { criteria: rubricCriteria.map((criterion: any) => ({ criterion: String(criterion.criterion || criterion.text || ''), ...((criterion.maxPoints ?? criterion.points) != null && Number.isFinite(Number(criterion.maxPoints ?? criterion.points)) ? { maxPoints: Number(criterion.maxPoints ?? criterion.points) } : {}) })), source: rubricSource, judged: rubricJudged, ...(sidecarRubric?.evidence ? { evidence: sidecarRubric.evidence } : {}), ...(sidecarRubric?.stale ? { stale: true } : {}), ...(sidecarRubric?.reconfirm ? { reconfirm: true } : {}) } } : {}),
      ...(preservedTags.length ? { tags: [...new Set(preservedTags.map(String))] as string[] } : {}),
      points: row.points == null ? null : row.points, images: refs, packageImagePositions: positions, packageSourceTextLength: sourceTextLength, confidence: null as unknown as number, imported: structuredClone(metadata) });
  }
  // Only an explicit section or an unambiguous range is evidence of ownership.
  const scripts: Array<{ id: string; text: string; first?: number; last?: number }> = [];
  for (const file of files.filter(f => /^(?:listening.*|transcript.*)\.md$/i.test(f.name))) {
    const text = await file.text();
    for (const block of text.matchAll(/^##\s+Section\s+(\d+)\b([^\n]*)\n([\s\S]*?)(?=^##\s+|$(?![\s\S]))/gim)) {
      const range = /(?:questions?|q(?:uestions)?\.?|items?)\s*(\d+)\s*[-–—]\s*(?:q(?:uestions)?\.?\s*)?(\d+)/i.exec(block[2]) || /\(\s*(\d+)\s*[-–—]\s*(\d+)\s*\)/.exec(block[2]);
      scripts.push({ id: block[1], text: block[3].trim(), ...(range ? { first: Number(range[1]), last: Number(range[2]) } : {}) });
    }
  }
  const packageScriptReceipt: NonNullable<ExamDoc['source']['packageScriptReceipt']> = [];
  for (const q of questions) {
    // Do not trust an unscoped script supplied in generic metadata.
    const directTranscript = typeof q.imported?.transcript === 'string' ? q.imported.transcript : undefined;
    if (q.imported) { delete q.imported.script; delete q.imported.transcript; }
    const section = sections.find(s => s.id === q.sectionId);
    const evidence = packageListeningEvidence(q);
    if (!isPackageListeningQuestion(q, section?.title)) continue;
    const refs = [...evidence.matchAll(/\b(?:section|group)\s+(\d+)\b/gi)].map(m => m[1]);
    const explicit = [...new Set(refs)];
    let candidates = explicit.length ? (explicit.length === 1 ? scripts.filter(b => b.id === explicit[0]) : []) : scripts.filter(b => b.first != null && q.no >= b.first && q.no <= b.last!);
    if (!explicit.length && candidates.length === 0) {
      const groups = Array.isArray(batch.instructionGroups) ? batch.instructionGroups : Array.isArray(batch.instruction_groups) ? batch.instruction_groups : [];
      const memberships = groups.filter((g: any) => {
        const ids = q.instructionGroups || q.imported?.instructionGroups || q.imported?.instruction_groups || [];
        const refs = Array.isArray(ids) ? ids : [ids];
        const members = g.questions ?? g.question_numbers ?? g.members ?? [];
        return (g.id != null && refs.some((id: unknown) => String(id) === String(g.id))) ||
          (Array.isArray(members) && members.some((member: any) => String(member?.id ?? member?.label ?? member) === q.label || (q.imported?.id != null && String(member?.id ?? member) === String(q.imported.id)))) ||
          (q.no >= Number(g.appliesToFirst ?? g.start) && q.no <= Number(g.appliesToLast ?? g.end));
      });
      candidates = scripts.filter(b => b.first != null && memberships.some((g: any) => Number(g.appliesToFirst ?? g.start) >= b.first! && Number(g.appliesToLast ?? g.end) <= b.last!));
    }
    const mapped = candidates.length === 1 && candidates[0].text ? candidates[0] : undefined;
    if (mapped) q.imported = { ...q.imported, script: mapped.text };
    else if (!scripts.length && directTranscript?.trim()) q.imported = { ...q.imported, transcript: directTranscript };
    packageScriptReceipt.push({ label: q.label, sectionId: mapped?.id || null });
  }
  // Teacher-only scripts are restored by full label plus section title. Ambiguous identities are
  // deliberately left unmapped instead of selecting the last matching row.
  for (const entry of preservedScripts) {
    if (typeof entry?.label !== 'string' || typeof entry?.text !== 'string' || !entry.text.trim()) continue;
    const matches = questions.filter(q => q.label === entry.label && (!entry.sectionTitle || sections.find(section => section.id === q.sectionId)?.title === entry.sectionTitle));
    if (matches.length !== 1) continue;
    const q = matches[0];
    q.imported = { ...(q.imported || {}), script: entry.text.trim(), scriptEvidenceType: 'teacher-only-script', scriptNote: entry.note || 'Script text only; no audio evidence.' };
    const receipt = packageScriptReceipt.find(item => item.label === q.label);
    if (receipt) receipt.sectionId = q.sectionId || null;
    else packageScriptReceipt.push({ label: q.label, sectionId: q.sectionId || null });
  }
  // Filename assignment is explicit evidence; a duplicate asset may have multiple owners.
  for (const file of files) {
    const match = /(?:^|[\/\\])questions?[-_\s]*(\d+[A-Za-z]?(?:[-_][A-Za-z0-9]+)?)(?=\.[^.]+$)/i.exec(file.webkitRelativePath || file.name);
    if (!match) continue;
    const asset = fileAssets.get((file.webkitRelativePath || file.name).toLowerCase()) || fileAssets.get(file.name.toLowerCase()); if (!asset) continue;
    const label = match[1].replace(/_/g, '-');
    const range = /^(\d+)-(\d+)$/.exec(label);
    for (const q of questions) if (range ? q.no >= Number(range[1]) && q.no <= Number(range[2]) && /^\d+$/.test(q.label) : q.label.toLowerCase() === label.toLowerCase()) { if (!q.images.some(r => r.imageId === asset.id)) q.images.push({ imageId: asset.id, role: 'stem' }); markStructural(asset.id, q.id); }
  }
  for (const image of images) {
    const owners = questions.filter(q => q.images.some(ref => ref.imageId === image.id));
    if (owners.length >= 2) image.packageShared = { ownerIds: owners.map(q => q.id), structural: owners.every(q => structuralOwners.get(image.id)?.has(q.id)) };
  }
  const passages: NonNullable<ExamDoc['passages']> = [];
  // A repeated passage can only own a contiguous run in its section. A different
  // passage-length block is a hard boundary, even if the old text reappears later.
  const passageRun = (anchor: number, core: string): Question[] => {
    const sectionId = questions[anchor].sectionId;
    const compatible = (q: Question) => q.sectionId === sectionId && (!q.passageId || !!passages.find(p => p.id === q.passageId)?.text.includes(core)) && (!(q.stem || '').split(/\n\s*\n/).some(block => block.trim().length >= 200) || (q.stem || '').includes(core));
    let first = anchor, last = anchor;
    while (first > 0 && questions[first].no === questions[first - 1].no + 1 && compatible(questions[first - 1])) first--;
    while (last + 1 < questions.length && questions[last + 1].no === questions[last].no + 1 && compatible(questions[last + 1])) last++;
    return questions.slice(first, last + 1);
  };
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].passageId) continue;
    let best = '';
    for (let j = i + 1; j < questions.length; j++) { const prefix = commonPrefix(questions[i].stem || '', questions[j].stem || ''); const core = prefix.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length >= 200).sort((a,b) => b.length-a.length)[0] || prefix; if (prefix.length > best.length && passageRun(i, core).filter(q => !q.passageId && (q.stem || '').startsWith(prefix) && /^\s*\n/.test((q.stem || '').slice(prefix.length))).length >= 3) best = prefix; }
    if (!best) continue;
    const bestCore = best.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length >= 200).sort((a,b) => b.length-a.length)[0] || best;
    const group = passageRun(i, bestCore).filter(q => !q.passageId && (q.stem || '').startsWith(best) && /^\s*\n/.test((q.stem || '').slice(best.length)));
    const id = `passage_${passages.length + 1}`;
    passages.push({ id, sectionTitle: sections.find(s => s.id === group[0].sectionId)?.title || 'Imported questions', text: best });
    const min = Math.min(...group.map(q => q.no)), max = Math.max(...group.map(q => q.no));
    for (const q of passageRun(i, bestCore)) {
      if (q.sectionId === group[0].sectionId && q.no >= min && q.no <= max && !q.passageId && !group.includes(q) && !(q.stem || '').split(/\n\s*\n/).some(block => block.trim().length >= 200)) q.passageId = id;
    }
    for (const q of group) { q.passageId = id; const suffix = q.stem!.slice(best.length); const removed = best.length + suffix.length - suffix.trimStart().length; q.stem = suffix.trimStart(); q.packageImagePositions = q.packageImagePositions?.map(p => ({ ...p, offset: Math.max(0, p.offset - removed) })); }
  }
  // Some subheaders precede the same passage. Match the factored passage block even
  // when it no longer begins at offset zero, then inherit across the full run.
  for (const passage of passages) {
    const members = questions.filter(q => q.passageId === passage.id);
    if (!members.length) continue;
    const sectionId = members[0].sectionId;
    const blocks = passage.text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length >= 200).sort((a,b) => b.length - a.length);
    const core = blocks[0] || passage.text;
    if (core.length < 200) continue;
    const run = passageRun(questions.indexOf(members[0]), core);
    for (const q of run.filter(q => q.sectionId === sectionId && !q.passageId && (q.stem || '').includes(core))) {
      const stem = q.stem || ''; const at = stem.indexOf(core);
      const remainder = (stem.slice(0, at) + stem.slice(at + core.length)).trim();
      // A different passage-length block belongs to its own run.
      if (remainder.split(/\n\s*\n/).some(block => block.trim().length >= 200)) continue;
      q.passageId = passage.id;
      q.stem = remainder;
      q.packageImagePositions = q.packageImagePositions?.map(p => ({ ...p, offset: Math.max(0, p.offset <= at ? p.offset : p.offset - core.length) }));
    }
    const linked = questions.filter(q => q.passageId === passage.id);
    const min = Math.min(...linked.map(q => q.no)), max = Math.max(...linked.map(q => q.no));
    for (const q of run) if (q.sectionId === sectionId && !q.passageId && q.no >= min && q.no <= max && !(q.stem || '').split(/\n\s*\n/).some(block => block.trim().length >= 200)) q.passageId = passage.id;
  }
  const optionalGroups: NonNullable<ExamDoc['optionalGroups']> = [];
  // An announced pair of labelled ranges is stronger than adjacency and also
  // covers packages which print the instruction only on the first item.
  for (const q of questions) {
    const text = `${q.imported?.instructions || ''} ${q.stem || ''}`;
    if (!/\b(?:either|optional|choose|select)\b/i.test(text) || !/\bor\b/i.test(text)) continue;
    const ranges = [...text.matchAll(/\b(\d+)([A-Za-z])\s*[-–—]\s*(\d+)\2\b/gi)];
    if (ranges.length !== 2 || ranges[0][2].toUpperCase() === ranges[1][2].toUpperCase()) continue;
    const branches: Record<string, string[]> = {};
    for (const range of ranges) {
      const branch = range[2].toUpperCase(); const first = Number(range[1]), last = Number(range[3]);
      branches[branch] = questions.filter(item => !item.optionalGroupId && item.no >= first && item.no <= last && new RegExp(`^\\d+${branch}$`, 'i').test(item.label)).map(item => item.label);
    }
    if (Object.values(branches).some(labels => !labels.length)) continue;
    const id = `optional_${optionalGroups.length + 1}`; const memberLabels = Object.values(branches).flat();
    for (const item of questions.filter(item => memberLabels.includes(item.label))) { item.optionalGroupId = id; item.optionalBranch = Object.keys(branches).find(branch => branches[branch].includes(item.label)); }
    const total = /(?:total|each (?:branch|part))\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(text);
    optionalGroups.push({ id, rule: 'choose-one-branch', memberLabels, branches, ...(total ? { printedTotal: Number(total[1]) } : {}) });
  }
  const byBase = new Map<number, Question[]>();
  for (const q of questions.filter(q => !q.optionalGroupId)) { const m = /^(\d+)([A-Za-z])(?:[-–][A-Za-z0-9]+)?$/.exec(q.label); if (m) byBase.set(q.no, [...(byBase.get(q.no) || []), q]); }
  const paired = [...byBase.entries()].filter(([, qs]) => new Set(qs.map(q => /^(?:\d+)([A-Za-z])/.exec(q.label)![1].toUpperCase())).size === 2).sort((a,b) => a[0]-b[0]);
  for (let i = 0; i < paired.length;) {
    let j = i + 1;
    const signature = (qs: Question[]) => [...new Set(qs.map(q => /^(?:\d+)([A-Za-z])/.exec(q.label)![1].toUpperCase()))].sort().join('');
    const ruleText = (qs: Question[]) => String(qs[0].imported?.instructions || /(?:optional\s+group[^\n]*|(?:answer|choose|select)\s+either[^\n]*)/i.exec(qs[0].stem || '')?.[0] || '').trim();
    while (j < paired.length && paired[j][0] === paired[j-1][0] + 1 && signature(paired[j][1]) === signature(paired[i][1]) && paired[j][1][0].sectionId === paired[i][1][0].sectionId && ruleText(paired[j][1]) === ruleText(paired[i][1])) j++;
    const candidates = paired.slice(i,j).flatMap(([, qs]) => qs);
    const announcement = candidates.map(q => `${q.stem || ''} ${q.imported?.instructions || ''}`).join(' ');
    const announcedBranch = /(?:answer|choose|select)\s+either[\s\S]{0,200}\bor\b|optional\s+group|\b(?:all|every|complete)\b[\s\S]{0,160}\bor\b/i.test(announcement);
    const announcedPerNumber = /one per number|each number.{0,50}one|one from each pair/i.test(announcement);
    // Label pairs are only optional when under a shared instruction, or an explicit rule.
    const instruction = (q: Question) => q.imported?.instructions || (Array.isArray(q.imported?.instructionGroups) ? JSON.stringify(q.imported.instructionGroups) : '');
    const sameInstruction = candidates.every(q => q.sectionId === candidates[0].sectionId && instruction(q) === instruction(candidates[0]));
    if (announcedBranch || (sameInstruction && !!instruction(candidates[0]))) {
      const id = `optional_${optionalGroups.length + 1}`; const branches: Record<string,string[]> = {};
      for (const q of candidates) { const branch = /^(?:\d+)([A-Za-z])/.exec(q.label)![1].toUpperCase(); (branches[branch] ||= []).push(q.label); q.optionalGroupId = id; q.optionalBranch = branch; }
      const total = /(?:total|each (?:branch|part))\s*[:=]?\s*(\d+(?:\.\d+)?)/i.exec(announcement);
      optionalGroups.push({ id, rule: announcedBranch ? 'choose-one-branch' : announcedPerNumber ? 'choose-one-per-number' : 'unknown', memberLabels: candidates.map(q => q.label), branches, ...(total ? { printedTotal: Number(total[1]) } : {}) });
    }
    i = j;
  }
  const collisions = [...new Set(questions.map(q => q.no))].map(number => ({ number, labels: questions.filter(q => q.no === number).map(q => q.label) })).filter(c => c.labels.length > 1 && new Set(c.labels).size === c.labels.length);
  const fileHash = await sha256(raw + '\n' + [...fileAssets.entries()].map(([name, image]) => `${name}:${image.sha}`).sort().join('\n') + [...byHash.keys()].sort().join('\n')); 
  const originalGrade = batch.grade ?? batch.questions[0]?.grade; const originalSubject = batch.subject ?? batch.questions[0]?.subject;
  const identity = normalizeIdentity(originalGrade, originalSubject);
  const title = typeof batch.title === 'string' && batch.title.trim() ? batch.title.trim() : [identity.subject, identity.gradeDisplay || identity.grade].filter(Boolean).join(' — ') || batch.source_dataset || batch.batch_id;
  const languageSample = questions.map(q => `${q.stem || ''} ${(q.options || []).map(o => o.text || '').join(' ')}`).join(' ');
  const inferredRtl = (languageSample.match(/[\u0600-\u06ff]/g) || []).length > (languageSample.match(/[A-Za-z]/g) || []).length;
  const language = typeof batch.language === 'string' && batch.language.trim() ? batch.language : inferredRtl ? 'fa' : 'en';
  const packageSectionReceipt = { rule: derivation.rule, sections: sections.map(section => ({ title: section.title || 'Imported questions', questionNumbers: questions.filter(q => q.sectionId === section.id).map(q => q.no) })) };
  // #57 Part C — a token with no matching asset file is an explicit warning, never silent text.
  const tokenFlags = unresolvedImageTokens.map(hit => ({
    id: `package_image_token_${hit.questionId}_${hit.sha.slice(0, 12)}`,
    code: 'PACKAGE_IMAGE_TOKEN_UNRESOLVED',
    severity: 'warn' as const,
    questionId: hit.questionId,
    message: `Q${hit.label}: image placeholder token img_${hit.sha.slice(0, 12)}… had no matching asset file — the token was removed from the question text; add the file and re-import.`,
    rootCauseId: `package_image_token_${hit.questionId}_${hit.sha.slice(0, 12)}`,
  }));
  return { id: `exam_${fileHash.slice(0, 12)}`, fileHash, createdAt: new Date().toISOString(), displayName: title, meta: { title, ...identity, language, direction: batch.direction === 'rtl' || (batch.direction !== 'ltr' && /^(?:fa|ar|ur)(?:-|$)/i.test(language)) ? 'rtl' : 'ltr' }, sections, passages, optionalGroups, questions, images,
    source: { kind: 'package', ...(parts.length ? { packageParts: parts } : {}), ...(multipartStatus ? { packageMultipartStatus: multipartStatus } : {}), packageBatchId: batch.batch_id, packageJsonHash: await sha256(raw), packageDataset: batch.source_dataset, packageIdentity: { grade: originalGrade, subject: originalSubject, title: batch.title }, packageSectionReceipt, packageScriptReceipt, packageStructureReceipt: { labelsPreserved: questions.length, optionalGroups, collisions }, enrichmentStatus: 'not run', lines: [], pages: 1, ocrUsed: false, fileName: parts.length > 1 ? `${json.name} (+${parts.length - 1} parts)` : json.name }, flags: tokenFlags, usage: [] };
}
