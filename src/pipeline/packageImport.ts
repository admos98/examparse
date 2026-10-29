/** Import authored and Appendix A packages without asking a model to reconstruct them. */
import type { ExamDoc, ImageAsset, Question } from '../types';
import { sha256 } from '../utils/hash';

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
  const sections: ExamDoc['sections'] = []; const sectionIds = new Map<string, string>();
  const questions: Question[] = [];
  for (let index = 0; index < batch.questions.length; index++) {
    const row = batch.questions[index];
    if (!row || typeof row !== 'object' || typeof row.type !== 'string' || (typeof row.stem !== 'string' && !Array.isArray(row.stem_blocks))) throw new Error(`Question ${index + 1} needs a type and stem or stem_blocks.`);
    const title = typeof row.title === 'string' ? row.title : '';
    const no = numberFromTitle(title, index + 1); const st = sectionTitle(title) || 'Imported questions';
    if (!sectionIds.has(st)) { const id = `section_${sections.length + 1}`; sectionIds.set(st, id); sections.push({ id, index: sections.length, title: st, spans: [] }); }
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
    const leading = stem.length - stem.trimStart().length;
    positions.forEach(p => { p.offset = Math.max(0, p.offset - leading); });
    const key = row.answer_key;
    const answer = key && Array.isArray(key.correct) && key.correct.length ? { text: key.correct.map(String).join(', '), source: 'paper' as const } : undefined;
    const { stem: _stem, stem_blocks: _blocks, options: _options, ...metadata } = row;
    questions.push({ id: `q_${index + 1}`, no, label: String(no), sectionId: sectionIds.get(st), spans: [], stem: stem.trim(), type: types[row.type] || 'unknown',
      options: Array.isArray(row.options) ? row.options.map((o: any) => ({ key: String(o.key), text: String(o.text ?? ''), spans: [] })) : [],
      ...(answer ? { answer } : {}), points: row.points == null ? null : row.points, images: refs, packageImagePositions: positions, confidence: 1, imported: structuredClone(metadata) });
  }
  // Filename assignment is explicit evidence; a duplicate asset may have multiple owners.
  for (const file of files) {
    const match = /(?:^|[\/\\])questions?[-_\s]*(\d+)(?:[-_](\d+))?(?=\.[^.]+$)/i.exec(file.webkitRelativePath || file.name);
    if (!match) continue;
    const asset = fileAssets.get((file.webkitRelativePath || file.name).toLowerCase()) || fileAssets.get(file.name.toLowerCase()); if (!asset) continue;
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : start;
    for (const q of questions) if (q.no >= start && q.no <= end && !q.images.some(r => r.imageId === asset.id)) q.images.push({ imageId: asset.id, role: 'stem' });
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
  return { id: `exam_${fileHash.slice(0, 12)}`, fileHash, createdAt: new Date().toISOString(), displayName: batch.source_dataset || batch.batch_id, meta: { title: batch.source_dataset || batch.batch_id, grade: String(batch.questions[0]?.grade ?? ''), subject: String(batch.questions[0]?.subject ?? ''), language: 'en', direction: 'ltr' }, sections, passages, questions, images,
    source: { kind: 'package', packageBatchId: batch.batch_id, packageDataset: batch.source_dataset, enrichmentStatus: 'not run', lines: [], pages: 1, ocrUsed: false, fileName: json.name }, flags: [], usage: [] };
}
