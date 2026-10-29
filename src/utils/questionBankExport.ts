/** Appendix A Question Bank v1.1 export. The importer owns rejection; this exporter reports missing data. */
import JSZip from 'jszip';
import type { ExamDoc, ImageAsset, Question } from '../types';
import { sliceSourceSpans } from '../pipeline/assemble';
import { getReviewImageBlob, dataUrlToBlob } from '../store';
import { emptyCurriculumHints } from '../pipeline/curriculumHints';

export interface BankExportOptions { sourceDataset: string; sourceRef?: string; includeModelDifficulty?: boolean }
export interface BankExportReport {
  questions: number; exported: number; needs_answer_key: Array<{ question: string; reason: string }>;
  untagged: number; tagged: number; asset_count: number; total_bytes: number;
  image_options: string[]; notes: string[];
}
export type BankQuestionType = 'multiple_choice' | 'true_false' | 'short_answer' | 'fill_in_blank' | 'matching' | 'ordering';
export interface BankQuestion {
  type: BankQuestionType; title: string; stem?: string; stem_blocks?: Array<{ t: 'text'; v: string } | { t: 'img'; asset: string }>;
  options?: Array<{ key: string; text: string }>; answer_key?: { correct: string[]; grading: 'auto' };
  explanation: null; points: number | null; grade: string; subject: string;
  curriculum_hints: { chapter: string | null; lesson: string | null; topic: string | null };
  difficulty?: { value: number; source: 'model' };
  provenance: { source_type: 'official_cited' | 'authored'; source_url: null; source_ref: string | null }; tags: string[];
}
export interface BankBatch { batch_id: string; source_dataset: string; questions: BankQuestion[] }
export interface BankExport { batch: BankBatch; report: BankExportReport; zip: Uint8Array; filename: string }
const typeMap: Partial<Record<Question['type'], BankQuestionType>> = { mcq: 'multiple_choice', truefalse: 'true_false', fillblank: 'fill_in_blank', short: 'short_answer', matching: 'matching' };
export function bankSlug(value: string): string { return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'exam'; }
export function defaultBankDataset(doc: ExamDoc): string { return bankSlug([doc.meta.subject, doc.meta.title || doc.displayName, doc.meta.year].filter(Boolean).join('-')); }
export function bankProvenance(doc: ExamDoc): BankQuestion['provenance'] {
  const meta = doc.meta as typeof doc.meta & { official?: boolean; source_type?: string; sourceType?: string };
  const official = meta.official === true || meta.source_type === 'official_cited' || meta.sourceType === 'official_cited' || /\b(?:official|national exam|final examination)\b|نهایی|هماهنگ کشوری/i.test(meta.title || '');
  const title = meta.title || doc.displayName || 'Exam';
  const session = [meta.year, meta.term].filter(Boolean).join(' ');
  return { source_type: official ? 'official_cited' : 'authored', source_url: null, source_ref: official ? [title, session].filter(Boolean).join(' — ') : null };
}
export function bankQuestions(doc: ExamDoc): Question[] {
  const all: Question[] = [], seen = new Set<string>();
  const visit = (q: Question) => { if (seen.has(q.id)) return; seen.add(q.id); all.push(q); for (const child of q.subQuestions || []) visit(child); };
  for (const question of doc.questions) visit(question);
  return all;
}
export function bankStem(doc: ExamDoc, q: Question): string { return q.stem ?? sliceSourceSpans(q.spans || [], doc.source.lines || [], q.rewrites); }
export function bankOptions(doc: ExamDoc, q: Question): Array<{ key: string; text: string }> {
  return (q.options || []).map((option, i) => ({ key: String(i + 1), text: option.text ?? sliceSourceSpans(option.spans || [], doc.source.lines || []) }));
}
const autoTypes = new Set<BankQuestionType>(['multiple_choice', 'true_false', 'fill_in_blank']);
function normalized(value: string): string { return value.trim().replace(/^[([{\s]+|[)\]}.:\s]+$/g, '').toLocaleLowerCase().replace(/\s+/g, ' '); }
function resolveAnswer(doc: ExamDoc, q: Question, options: Array<{ key: string; text: string }>): string | undefined {
  if (!q.answer || q.answer.source === 'ai') return undefined;
  const raw = q.answer.text || sliceSourceSpans(q.answer.spans || [], doc.source.lines || []);
  if (!raw?.trim() || !options.length) return undefined;
  // A doubtful/wrong answer audit must not become a confident answer key.
  const votes = doc.loop?.auditVerdicts?.filter(v => v.kind === 'answer-correct' && v.questionNumbers.includes(q.no)) || [];
  if (votes.some(v => v.probability !== undefined && v.probability < 0.8)) return undefined;
  const target = normalized(raw);
  const original = q.options || [];
  const matches = original.map((opt, i) => ({ i, key: normalized(opt.key), text: normalized(options[i].text) }))
    .filter(opt => opt.key === target || (opt.text && opt.text === target));
  if (matches.length === 1) return String(matches[0].i + 1);
  if (matches.length > 1) return undefined;
  // Letters can identify ordered options even when the stored option keys are numeric.
  if (/^[a-z]$/.test(target) && original.every(o => /^\d+$/.test(o.key))) {
    const index = target.charCodeAt(0) - 97;
    if (index < options.length) return String(index + 1);
  }
  return undefined;
}
async function realSha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable; assets cannot be safely exported.');
  const digest = await crypto.subtle.digest('SHA-256', bytes as any);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function imageExtension(bytes: Uint8Array): string {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM') return 'bmp';
  throw new Error('Unsupported or unrecognized image bytes; cannot determine the correct extension.');
}
async function defaultImageLoader(image: ImageAsset): Promise<Blob | undefined> {
  const blob = image.blobKey ? await getReviewImageBlob(image.blobKey) : undefined;
  return blob || (image.dataUrl?.startsWith('data:') ? dataUrlToBlob(image.dataUrl) : undefined);
}
export async function createQuestionBankExport(doc: ExamDoc, options: BankExportOptions, loadImage: (image: ImageAsset) => Promise<Blob | undefined> = defaultImageLoader): Promise<BankExport> {
  const sourceDataset = options.sourceDataset.trim();
  if (!sourceDataset) throw new Error('Source dataset is required.');
  const provenance = bankProvenance(doc);
  if (provenance.source_type === 'official_cited') {
    provenance.source_ref = (options.sourceRef ?? provenance.source_ref ?? '').trim();
    if (!provenance.source_ref) throw new Error('Official papers require a source reference.');
  }
  if (!globalThis.crypto?.randomUUID) throw new Error('Secure UUID generation is unavailable.');
  const questions = bankQuestions(doc);
  const report: BankExportReport = { questions: questions.length, exported: 0, needs_answer_key: [], untagged: 0, tagged: 0, asset_count: 0, total_bytes: 0, image_options: [], notes: [] };
  const assets = new Map<string, { ext: string; bytes: Uint8Array }>();
  const imageHashes = new Map<string, string>();
  const resolveAsset = async (imageId: string): Promise<string> => {
    if (imageHashes.has(imageId)) return imageHashes.get(imageId)!;
    const image = doc.images.find(img => img.id === imageId);
    if (!image) throw new Error(`Image ${imageId} is referenced but missing; restore it before export.`);
    const blob = await loadImage(image);
    if (!blob) throw new Error(`Image ${imageId} is unavailable in folder storage; restore it before export.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await realSha256(bytes); const ext = imageExtension(bytes);
    if (!assets.has(hash)) assets.set(hash, { ext, bytes });
    imageHashes.set(imageId, hash); return hash;
  };
  const batch: BankBatch = { batch_id: crypto.randomUUID(), source_dataset: sourceDataset, questions: [] };
  for (const q of questions) {
    const label = `Q${q.label || q.no}`;
    const type = typeMap[q.type] || 'short_answer';
    if (!typeMap[q.type]) report.notes.push(`${label}: ${q.type} exported as short_answer.`);
    const stem = bankStem(doc, q).trim();
    const bankOptionsForQuestion = bankOptions(doc, q);
    const optionImages = (q.images || []).filter(i => i.role === 'option');
    if (optionImages.length) {
      report.image_options.push(label);
      optionImages.forEach((image, index) => {
        const indexByAnchor = image.anchorLine == null ? -1 : (q.options || []).findIndex(opt => (opt.spans || []).some(span => Array.isArray(span) ? image.anchorLine! >= span[0] && image.anchorLine! <= span[1] : span.line === image.anchorLine));
        const option = bankOptionsForQuestion[indexByAnchor >= 0 ? indexByAnchor : index];
        if (option) option.text = [option.text, '[Image option not supported in v1]'].filter(Boolean).join(' ');
        else bankOptionsForQuestion.push({ key: String(bankOptionsForQuestion.length + 1), text: '[Image option not supported in v1]' });
      });
    }
    const hints = q.curriculumHints || emptyCurriculumHints();
    if (hints.chapter || hints.lesson || hints.topic) report.tagged++; else report.untagged++;
    const section = doc.sections.find(s => s.id === q.sectionId)?.title;
    const row: BankQuestion = { type, title: stem.slice(0, 60), explanation: null,
      points: typeof q.points === 'number' && Number.isFinite(q.points) && q.points >= 0 ? q.points : null,
      grade: doc.meta.grade || '', subject: doc.meta.subject || '', curriculum_hints: hints,
      provenance: { ...provenance }, tags: [...new Set([section, doc.meta.subject].filter((s): s is string => Boolean(s?.trim())).map(s => s.trim()))] };
    const stemImages = (q.images || []).filter(i => i.role === 'stem' || i.role === 'table');
    if (stemImages.length) {
      const blocks: NonNullable<BankQuestion['stem_blocks']> = [];
      const imgBlocks = await Promise.all(stemImages.map(async image => ({ t: 'img' as const, asset: await resolveAsset(image.imageId) })));
      const leadIn = /(?:picture|image|photo|figure|diagram)\s+(?:shown\s+)?below|(?:تصویر|شکل)\s*(?:زیر|پایین)/i.test(stem);
      if (leadIn) blocks.push(...imgBlocks, { t: 'text', v: stem }); else blocks.push({ t: 'text', v: stem }, ...imgBlocks);
      row.stem_blocks = blocks;
    } else row.stem = stem;
    if (bankOptionsForQuestion.length) row.options = bankOptionsForQuestion;
    if (autoTypes.has(type)) {
      const correct = resolveAnswer(doc, q, bankOptions(doc, q));
      if (correct) row.answer_key = { correct: [correct], grading: 'auto' };
      else report.needs_answer_key.push({ question: label, reason: 'No confident answer matched an option.' });
    }
    if (q.difficulty && q.difficulty.source === 'model' && Number.isInteger(q.difficulty.value) && q.difficulty.value >= 1 && q.difficulty.value <= 5 && (q.difficultyMode === 'active' || options.includeModelDifficulty === true)) row.difficulty = { value: q.difficulty.value, source: 'model' };
    batch.questions.push(row); report.exported++;
  }
  report.asset_count = assets.size; report.total_bytes = [...assets.values()].reduce((sum, asset) => sum + asset.bytes.length, 0);
  const slug = `${bankSlug(doc.meta.title || doc.displayName)}-batch`;
  const zip = new JSZip(); const folder = zip.folder(slug)!;
  folder.file('batch.json', JSON.stringify(batch, null, 2)); folder.file('export-report.json', JSON.stringify(report, null, 2));
  for (const [hash, asset] of assets) folder.file(`assets/${hash}.${asset.ext}`, asset.bytes);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const written = await JSZip.loadAsync(bytes);
  for (const [hash, asset] of assets) {
    const file = written.file(`${slug}/assets/${hash}.${asset.ext}`);
    if (!file || await realSha256(await file.async('uint8array')) !== hash) throw new Error(`Asset ${hash} failed post-write verification.`);
  }
  return { batch, report, zip: bytes, filename: `${slug}.zip` };
}
export function downloadQuestionBankExport(exported: BankExport): void {
  const url = URL.createObjectURL(new Blob([exported.zip as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a'); link.href = url; link.download = exported.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
