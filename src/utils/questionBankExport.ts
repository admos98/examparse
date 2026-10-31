import { reviewTags } from './explanationVisibility';
/** Appendix A Question Bank v1.1 export. The importer owns rejection; this exporter reports missing data. */
import JSZip from 'jszip';
import type { ExamDoc, ImageAsset, Question } from '../types';
import { sliceSourceSpans } from '../pipeline/assemble';
import { stripImagePlaceholderTokens } from '../pipeline/imagePlaceholders';
import { getReviewImageBlob, dataUrlToBlob } from '../store';
import { exportIdentity } from '../pipeline/identity';
import { curriculumLessons, hintsForLesson, emptyCurriculumHints } from '../pipeline/curriculumHints';

export interface BankExportOptions { sourceDataset: string; sourceRef?: string; includeModelDifficulty?: boolean }
export interface BankExportReport {
  questions: number; exported: number; needs_answer_key: Array<{ question: string; reason: string }>;
  untagged: number; tagged: number; asset_count: number; total_bytes: number;
  /** #57 Part C — truthful image counts: files actually emitted vs questions referencing them. */
  images_placed: number; image_references: number;
  /** #57 Part C — questions whose pixels were unavailable: exported with an explicit marker, never a token. */
  missing_assets: Array<{ question: string; image: string }>;
  image_options: string[]; notes: string[];
  package_section_receipt?: ExamDoc['source']['packageSectionReceipt'];
  enrichment_notes?: string[];
}
export type BankQuestionType = 'multiple_choice' | 'true_false' | 'short_answer' | 'long_answer' | 'fill_in_blank' | 'matching' | 'ordering';
export interface BankQuestion {
  type: BankQuestionType; title: string; stem?: string; stem_blocks?: Array<{ t: 'text'; v: string } | { t: 'img'; asset: string }>;
  options?: Array<{ key: string; text: string }>; answer_key?: { correct: string[]; grading: 'auto' } | null;
  enrichment?: Question['enrichment'];
  /** #57 Part A — verified model/teacher sample answer and rubric travel with keyless tashrihi items. */
  sample_answer?: { text: string; source: 'model' | 'teacher' };
  rubric?: { criteria: Array<{ criterion: string; maxPoints: number }> };
  label?: string; optional_group_id?: string; optional_branch?: string;
  explanation: { text: string; source: 'model' } | null; points: number | null; grade: string; subject: string;
  curriculum_hints: { chapter: string | null; lesson: string | null; topic: string | null };
  difficulty?: { value: number; source: 'model' };
  provenance: { source_type: 'official_cited' | 'authored'; source_url: null; source_ref: string | null }; tags: string[];
}
export interface BankBatch { batch_id: string; source_dataset: string; questions: BankQuestion[] }
export interface BankExport { batch: BankBatch; report: BankExportReport; zip: Uint8Array; filename: string }
/** #57 Part A — descriptive question types travel as bank long_answer; short_answer stays short_answer. */
const typeMap: Partial<Record<Question['type'], BankQuestionType>> = { mcq: 'multiple_choice', truefalse: 'true_false', fillblank: 'fill_in_blank', short: 'short_answer', long: 'long_answer', essay: 'long_answer', matching: 'matching' };
export function bankSlug(value: string): string { return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'exam'; }
export function defaultBankDataset(doc: ExamDoc): string { return bankSlug([doc.meta.subject, doc.meta.title || doc.displayName, doc.meta.year].filter(Boolean).join('-')); }
export function bankProvenance(doc: ExamDoc): BankQuestion['provenance'] {
  const meta = doc.meta as typeof doc.meta & { official?: boolean; source_type?: string; sourceType?: string };
  const official = meta.official === true || meta.source_type === 'official_cited' || meta.sourceType === 'official_cited' || /\b(?:official|national exam|final examination)\b|نهایی|هماهنگ کشوری/i.test(meta.title || '');
  const title = meta.title || doc.displayName || 'Exam';
  const session = [meta.year, meta.term].filter(Boolean).join(' ');
  return { source_type: official ? 'official_cited' : 'authored', source_url: null, source_ref: official ? [title, session].filter(Boolean).join(' — ') : null };
}
/** #57 Part E — compact physical reference per question: `<file> · p.<page> · item <label> · group <n> (<total>)`, ≤200 chars.
 * The full prose ref (imported provenance, teacher source note) remains in the structured export only;
 * source_type values are never remapped. */
export function compactBankSourceRef(doc: ExamDoc, q: Question): string {
  const file = (doc.source.fileName || doc.displayName || 'exam').replace(/\.[^./\\]+$/, '');
  const lineNos = (q.spans || []).map(span => (Array.isArray(span) ? span[0] : span.line)).filter(n => Number.isFinite(n));
  const pages = lineNos.map(n => doc.source.lines?.[n - 1]?.page).filter(page => Number.isFinite(page));
  const firstImagePage = q.images?.length ? doc.images?.find(image => image.id === q.images[0].imageId)?.page : undefined;
  const page = pages.length ? Math.min(...pages) : (Number.isFinite(firstImagePage) ? firstImagePage : 1);
  const sectionIndex = doc.sections?.findIndex(section => section.id === q.sectionId) ?? -1;
  const group = sectionIndex >= 0 ? sectionIndex + 1 : 1;
  const total = Math.max(doc.sections?.length || 1, 1);
  // The form always survives: the file component absorbs the truncation, never the tail.
  const tail = ` · p.${page} · item ${q.label || q.no} · group ${group} (${total})`;
  const room = Math.max(1, 200 - tail.length);
  const head = file.length > room ? file.slice(0, room) : file;
  const ref = `${head}${tail}`;
  return ref.length > 200 ? ref.slice(0, 200) : ref;
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
  const report: BankExportReport = { questions: questions.length, exported: 0, needs_answer_key: [], untagged: 0, tagged: 0, asset_count: 0, total_bytes: 0, images_placed: 0, image_references: 0, missing_assets: [], image_options: [], notes: [] };
  const assets = new Map<string, { ext: string; bytes: Uint8Array; mime: string; imageIds: string[] }>();
  const imageHashes = new Map<string, string | null>();
  /** #57 Part C — resolve to the sha256 reference, or null when pixels are unavailable.
   * Missing pixels never fail the export and never leave a silent token: the caller emits an
   * explicit missing-asset marker and the report records the attention item. */
  const resolveAsset = async (imageId: string): Promise<string | null> => {
    const cached = imageHashes.get(imageId);
    if (cached !== undefined) return cached;
    const image = doc.images.find(img => img.id === imageId);
    if (!image) { imageHashes.set(imageId, null); return null; }
    let blob: Blob | undefined;
    try { blob = await loadImage(image); } catch { blob = undefined; }
    if (!blob) { imageHashes.set(imageId, null); return null; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let ext: string;
    try { ext = imageExtension(bytes); } catch { imageHashes.set(imageId, null); return null; }
    // SHA-256 is a hard requirement of the v1.1 asset contract (names are the content hash).
    const hash = await realSha256(bytes);
    if (!assets.has(hash)) assets.set(hash, { ext, bytes, mime: image.mime || `image/${ext === 'jpg' ? 'jpeg' : ext}`, imageIds: [imageId] });
    else if (!assets.get(hash)!.imageIds.includes(imageId)) assets.get(hash)!.imageIds.push(imageId);
    imageHashes.set(imageId, hash); return hash;
  };
  if (doc.source.packageSectionReceipt) report.package_section_receipt = doc.source.packageSectionReceipt;
  if (doc.source.enrichmentNotes?.length) report.enrichment_notes = doc.source.enrichmentNotes;
  const batch: BankBatch = { batch_id: crypto.randomUUID(), source_dataset: sourceDataset, questions: [] };
  for (const q of questions) {
    const label = `Q${q.label || q.no}`;
    const type = typeMap[q.type] || 'short_answer';
    if (!typeMap[q.type]) report.notes.push(`${label}: ${q.type} exported as short_answer.`);
    const passage = doc.source.kind === 'package' ? doc.passages?.find(p => p.id === q.passageId)?.text : undefined;
    // #57 Part C — placeholder tokens are never exported as text: the reference form carries the asset.
    const stem = stripImagePlaceholderTokens([passage, bankStem(doc, q).trim()].filter(Boolean).join('\n\n')).replace(/[ \t]{2,}/g, ' ').trim();
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
    const baseHints = q.curriculumHints || emptyCurriculumHints();
    const suggested = q.enrichment?.lessons?.[0];
    const selectedLesson = q.enrichment?.teacherLesson?.lesson || (doc.source.kind !== 'package' && suggested && suggested.probability >= .5 ? suggested.lesson : undefined);
    const teacher = q.enrichment?.teacherLesson && curriculumLessons(doc.meta.grade, doc.meta.subject).find(l => l.title === selectedLesson);
    const hints = teacher ? hintsForLesson(teacher) : selectedLesson ? { ...baseHints, lesson: selectedLesson } : baseHints;
    if (hints.chapter || hints.lesson || hints.topic) report.tagged++; else report.untagged++;
    const section = doc.sections.find(s => s.id === q.sectionId)?.title;
    // Student-facing bank exports omit uncertain, unjudged, and rejected explanations; structured exports retain uncertain prose with its check state.
    const row: BankQuestion = { type, title: doc.source.kind === 'package' ? `Question ${q.label}` : stem.slice(0, 60), ...(doc.source.kind === 'package' ? { label: q.label } : {}), ...(q.optionalGroupId ? { optional_group_id: q.optionalGroupId, optional_branch: q.optionalBranch } : {}), explanation: q.explanation && q.enrichment?.explanationCheck?.state === 'verified' ? q.explanation : null,
      points: typeof q.points === 'number' && Number.isFinite(q.points) && q.points >= 0 ? q.points : null,
      ...exportIdentity(doc.meta.grade, doc.meta.subject), curriculum_hints: hints,
      // #57 Part E — compact physical ref in the bank; the full prose ref stays structured-only.
      provenance: { ...provenance, source_ref: compactBankSourceRef(doc, q) }, tags: [...new Set([...reviewTags(q), section, doc.meta.subject].filter((s): s is string => Boolean(s?.trim())).map(s => s.trim()))] };
    // #57 Part A — bank export carries only verified sample answers and rubrics (uncertain stays structured-only; rejected is record-only).
    if (q.sampleAnswer?.judged === 'verified') row.sample_answer = { text: q.sampleAnswer.text, source: q.sampleAnswer.source };
    if (q.rubric?.judged === 'verified') row.rubric = { criteria: q.rubric.criteria.map(c => ({ criterion: c.criterion, maxPoints: c.maxPoints })) };
    const stemImages = (q.images || []).filter(i => i.role === 'stem' || i.role === 'table');
    if (stemImages.length) {
      const blocks: NonNullable<BankQuestion['stem_blocks']> = [];
      // #57 Part C — every referenced image becomes either a sha256 reference or an explicit
      // missing-asset marker (plus report attention); never a placeholder token, never a silent drop.
      const imgBlocks = await Promise.all(stemImages.map(async image => {
        const hash = await resolveAsset(image.imageId);
        if (hash) return { t: 'img' as const, asset: hash };
        report.missing_assets.push({ question: label, image: image.imageId });
        report.notes.push(`${label}: image ${image.imageId} has no available pixels — exported with an explicit missing-asset marker (restore it before students receive this batch).`);
        // Marker prefers the content hash so the batch string can never contain an img_<sha> token.
        const marker = doc.images.find(img => img.id === image.imageId)?.sha || image.imageId;
        return { t: 'img' as const, asset: `missing:${marker}` };
      }));
      const positions = q.packageImagePositions?.filter(p => stemImages.some(i => i.imageId === p.imageId)).sort((a, b) => a.offset - b.offset) || [];
      if (doc.source.kind === 'package' && positions.length) {
        if (passage) blocks.push({ t: 'text', v: passage + '\n\n' });
        const text = bankStem(doc, q).trim(); let at = 0; const placed = new Set<string>();
        for (const position of positions) {
          const offset = Math.max(at, Math.min(text.length, position.offset));
          if (offset > at) blocks.push({ t: 'text', v: text.slice(at, offset) });
          const idx = stemImages.findIndex(image => image.imageId === position.imageId);
          if (idx >= 0) { blocks.push(imgBlocks[idx]); placed.add(position.imageId); }
          at = offset;
        }
        if (at < text.length) blocks.push({ t: 'text', v: text.slice(at) });
        stemImages.forEach((image, i) => { if (!placed.has(image.imageId)) blocks.push(imgBlocks[i]); });
      } else {
        const leadIn = /(?:picture|image|photo|figure|diagram)\s+(?:shown\s+)?below|(?:تصویر|شکل)\s*(?:زیر|پایین)/i.test(stem);
        if (leadIn) blocks.push(...imgBlocks, { t: 'text', v: stem }); else blocks.push({ t: 'text', v: stem }, ...imgBlocks);
      }
      // Text segments keep their exact slicing offsets; only the token text itself is scrubbed.
      for (const block of blocks) if (block.t === 'text') block.v = stripImagePlaceholderTokens(block.v).replace(/[ \t]{2,}/g, ' ');
      if (blocks.some(block => block.t === 'img')) report.image_references++;
      row.stem_blocks = blocks;
    } else row.stem = stem;
    if (bankOptionsForQuestion.length) row.options = bankOptionsForQuestion;
    if (q.enrichment) row.enrichment = q.enrichment;
    if (doc.source.kind === 'package' && q.imported) {
      const importedKey = q.imported.answer_key;
      const original = Array.isArray(importedKey?.correct) ? importedKey.correct.map(String).join(', ') : undefined;
      // Honor teacher edits; never silently resurrect an imported key after it was removed.
      const current = q.answer?.source === 'ai' ? undefined : q.answer?.text;
      const answers: string[] = current === original ? (importedKey?.correct || []).map(String) : current ? [current] : [];
      const mapped = answers.map(value => {
        const i = (q.options || []).findIndex(o => normalized(o.key) === normalized(value) || normalized(o.text || '') === normalized(value));
        return i >= 0 ? String(i + 1) : undefined;
      });
      if (autoTypes.has(type) && mapped.length && mapped.every(Boolean)) row.answer_key = { correct: mapped as string[], grading: 'auto' };
      else if (autoTypes.has(type)) report.needs_answer_key.push({ question: label, reason: answers.length ? 'Answer cannot be represented as an Appendix A option key.' : 'Package has no answer key.' });
    } else if (autoTypes.has(type)) {
      const correct = resolveAnswer(doc, q, bankOptions(doc, q));
      if (correct) row.answer_key = { correct: [correct], grading: 'auto' };
      else report.needs_answer_key.push({ question: label, reason: 'No confident answer matched an option.' });
    }
    if (q.difficulty && q.difficulty.source === 'model' && Number.isInteger(q.difficulty.value) && q.difficulty.value >= 1 && q.difficulty.value <= 5 && (q.difficultyMode === 'active' || options.includeModelDifficulty === true)) row.difficulty = { value: q.difficulty.value, source: 'model' };
    batch.questions.push(row); report.exported++;
  }
  report.asset_count = assets.size;
  // #57 Part C — truthful summary: files emitted vs questions referencing them; with references
  // present, "0 images to place" is impossible because images_placed tracks the emitted pool.
  report.images_placed = assets.size;
  report.total_bytes = [...assets.values()].reduce((sum, asset) => sum + asset.bytes.length, 0);
  if (report.image_references && !report.images_placed) report.notes.push(`${report.image_references} question(s) reference image assets, but no pixels were available — every reference carries an explicit missing-asset marker.`);
  const slug = `${bankSlug(doc.meta.title || doc.displayName)}-batch`;
  const zip = new JSZip(); const folder = zip.folder(slug)!;
  if (batch.questions.length <= 50) folder.file('batch.json', JSON.stringify(batch, null, 2));
  else for (let i = 0; i < batch.questions.length; i += 50) {
    const chunk = { ...batch, batch_id: `${batch.batch_id}-part-${Math.floor(i / 50) + 1}`, questions: batch.questions.slice(i, i + 50) };
    folder.file(`part-${Math.floor(i / 50) + 1}/batch.json`, JSON.stringify(chunk, null, 2));
  }
  folder.file('export-report.json', JSON.stringify(report, null, 2));
  // #57 Part C — v1.1 asset manifest: content-addressed asset id → file, sha, mime, byte size.
  // Files only, never base64; `used_by` lists the image asset ids that reference this file.
  folder.file('assets/manifest.json', JSON.stringify({
    format: 'appendix-a-assets/1.1',
    assets: [...assets.entries()].map(([hash, asset]) => ({
      id: hash, file: `assets/${hash}.${asset.ext}`, sha256: hash, mime: asset.mime, bytes: asset.bytes.length, used_by: asset.imageIds,
    })),
  }, null, 2));
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
