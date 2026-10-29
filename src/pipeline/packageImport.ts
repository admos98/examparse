/** Import authored and Appendix A packages without asking a model to reconstruct them. */
import type { ExamDoc, ImageAsset, Question } from '../types';
import { sha256 } from '../utils/hash';
import { normalizeIdentity } from './identity';

export interface PackageFile { name: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; type?: string; webkitRelativePath?: string }
const types: Record<string, Question['type']> = { multiple_choice: 'mcq', true_false: 'truefalse', fill_in_blank: 'fillblank', short_answer: 'short', matching: 'matching', ordering: 'multi' };
const mimeFor = (name: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' } as Record<string, string>)[name.split('.').pop()!.toLowerCase()];
function numberFromTitle(title: string, fallback: number): number {
  const match = /(?:question|\bq)\s*[-#.:]?\s*(\d+)/i.exec(title) || /^\s*(\d+)\s*[.):]/.exec(title);
  return match ? Number(match[1]) : fallback;
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
  const jsons = files.filter(f => /\.json$/i.test(f.name) && !/export-report\.json$/i.test(f.name));
  const json = jsons.find(f => /(^|\/)batch\.json$/i.test(f.webkitRelativePath || f.name)) || (jsons.length === 1 ? jsons[0] : undefined);
  if (!json) throw new Error('Select one package JSON (or batch.json) together with its images.');
  const raw = await json.text(); let batch: any;
  try { batch = JSON.parse(raw); } catch { throw new Error('Package JSON is invalid.'); }
  if (!batch || typeof batch.batch_id !== 'string' || !Array.isArray(batch.questions) || !batch.questions.length) throw new Error('Package must have a batch_id and a nonempty questions array.');
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
  for (let index = 0; index < batch.questions.length; index++) {
    const row = batch.questions[index];
    if (!row || typeof row !== 'object' || typeof row.type !== 'string' || (typeof row.stem !== 'string' && !Array.isArray(row.stem_blocks))) throw new Error(`Question ${index + 1} needs a type and stem or stem_blocks.`);
    const title = typeof row.title === 'string' ? row.title : '';
    const no = numberFromTitle(title, index + 1); const st = derivation.labels[index];
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
    for (const ref of refs) markStructural(ref.imageId, `q_${index + 1}`);
    const sourceTextLength = stem.trim().length + (Array.isArray(row.options) ? row.options.reduce((n: number, o: any) => n + String(o?.text ?? '').length, 0) : 0);
    const leading = stem.length - stem.trimStart().length;
    positions.forEach(p => { p.offset = Math.max(0, p.offset - leading); });
    const key = row.answer_key;
    const answer = key && Array.isArray(key.correct) && key.correct.length ? { text: key.correct.map(String).join(', '), source: 'paper' as const } : undefined;
    const { stem: _stem, stem_blocks: _blocks, options: _options, ...metadata } = row;
    questions.push({ id: `q_${index + 1}`, no, label: String(no), sectionId: sections[sections.length - 1].id, spans: [], stem: stem.trim(), type: types[row.type] || 'unknown',
      options: Array.isArray(row.options) ? row.options.map((o: any) => ({ key: String(o.key), text: String(o.text ?? ''), spans: [] })) : [],
      ...(answer ? { answer } : {}), points: row.points == null ? null : row.points, images: refs, packageImagePositions: positions, packageSourceTextLength: sourceTextLength, confidence: 1, imported: structuredClone(metadata) });
  }
  // Filename assignment is explicit evidence; a duplicate asset may have multiple owners.
  for (const file of files) {
    const match = /(?:^|[\/\\])questions?[-_\s]*(\d+)(?:[-_](\d+))?(?=\.[^.]+$)/i.exec(file.webkitRelativePath || file.name);
    if (!match) continue;
    const asset = fileAssets.get((file.webkitRelativePath || file.name).toLowerCase()) || fileAssets.get(file.name.toLowerCase()); if (!asset) continue;
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : start;
    for (const q of questions) if (q.no >= start && q.no <= end) { if (!q.images.some(r => r.imageId === asset.id)) q.images.push({ imageId: asset.id, role: 'stem' }); markStructural(asset.id, q.id); }
  }
  for (const image of images) {
    const owners = questions.filter(q => q.images.some(ref => ref.imageId === image.id));
    if (owners.length >= 2) image.packageShared = { ownerIds: owners.map(q => q.id), structural: owners.every(q => structuralOwners.get(image.id)?.has(q.id)) };
  }
  const passages: NonNullable<ExamDoc['passages']> = [];
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].passageId) continue;
    let best = '';
    for (let j = i + 1; j < questions.length; j++) { const prefix = commonPrefix(questions[i].stem || '', questions[j].stem || ''); if (prefix.length > best.length && questions.filter(q => !q.passageId && (q.stem || '').startsWith(prefix + '\n')).length >= 3) best = prefix; }
    if (!best) continue;
    const group = questions.filter(q => !q.passageId && (q.stem || '').startsWith(best + '\n'));
    const id = `passage_${passages.length + 1}`;
    passages.push({ id, sectionTitle: sections.find(s => s.id === group[0].sectionId)?.title || 'Imported questions', text: best });
    for (const q of group) { q.passageId = id; const suffix = q.stem!.slice(best.length); const removed = best.length + suffix.length - suffix.trimStart().length; q.stem = suffix.trimStart(); q.packageImagePositions = q.packageImagePositions?.map(p => ({ ...p, offset: Math.max(0, p.offset - removed) })); }
  }
  const fileHash = await sha256(raw + '\n' + [...fileAssets.entries()].map(([name, image]) => `${name}:${image.sha}`).sort().join('\n') + [...byHash.keys()].sort().join('\n')); 
  const originalGrade = batch.grade ?? batch.questions[0]?.grade; const originalSubject = batch.subject ?? batch.questions[0]?.subject;
  const identity = normalizeIdentity(originalGrade, originalSubject);
  const title = typeof batch.title === 'string' && batch.title.trim() ? batch.title.trim() : [identity.subject, identity.gradeDisplay || identity.grade].filter(Boolean).join(' — ') || batch.source_dataset || batch.batch_id;
  const packageSectionReceipt = { rule: derivation.rule, sections: sections.map(section => ({ title: section.title || 'Imported questions', questionNumbers: questions.filter(q => q.sectionId === section.id).map(q => q.no) })) };
  return { id: `exam_${fileHash.slice(0, 12)}`, fileHash, createdAt: new Date().toISOString(), displayName: title, meta: { title, ...identity, language: 'en', direction: 'ltr' }, sections, passages, questions, images,
    source: { kind: 'package', packageBatchId: batch.batch_id, packageDataset: batch.source_dataset, packageIdentity: { grade: originalGrade, subject: originalSubject, title: batch.title }, packageSectionReceipt, enrichmentStatus: 'not run', lines: [], pages: 1, ocrUsed: false, fileName: json.name }, flags: [], usage: [] };
}
