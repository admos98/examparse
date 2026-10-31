import JSZip from 'jszip';
import type { BankContractProfile, BankContractReport } from './bankContract';
import { reviewTags } from './explanationVisibility';
import type { ExamDoc, ImageAsset, Question } from '../types';
import { sliceSourceSpans } from '../pipeline/assemble';
import { stripImagePlaceholderTokens } from '../pipeline/imagePlaceholders';
import { getReviewImageBlob, dataUrlToBlob } from '../store';
import { exportIdentity } from '../pipeline/identity';
import { curriculumLessons, hintsForLesson, emptyCurriculumHints } from '../pipeline/curriculumHints';
import { AUTO_GRADED_TYPES, DESCRIPTIVE_TYPES, planBankAnswer, typeSuggestion } from './bankAnswers';
import { CONTRACT_REQUESTS, applyAnswerPlan, applyDescriptiveArtifacts, descriptiveArtifacts, emptyContractReport, preservedAnswer, type PreservedAnswer } from './bankContract';
import { artifactState, explanationState, rubricFingerprint, sampleFingerprint } from '../pipeline/evidence';
import { EXAMPARSE_FORMAT_README, type InterchangeAssetInput } from './examparseFormat';
import { buildExportDoc } from './examExport';
import { extractInlineDataImages } from './inlineImages';

/**
 * Appendix A / native question-bank export.
 *
 * #58 rules enforced here:
 *  - a source/keyfile/teacher answer is preserved by TYPE (option key, text blanks, descriptive
 *    sample) and only an option key is written into the executable `answer_key`;
 *  - `enrichment.proposedAnswer` and legacy `answer.source: 'ai'` never touch an executable field;
 *  - model sample/rubric artifacts travel only while verified against the CURRENT evidence, while
 *    teacher-confirmed artifacts always travel with their honest provenance;
 *  - every unconfirmed destination mapping is reported; the batch is never called bank-ready.
 */
export interface BankExportOptions {
  sourceDataset: string;
  sourceRef?: string;
  includeModelDifficulty?: boolean;
  /** Destination mapping profile. Default: best-known-but-unverified field names. */
  contract?: BankContractProfile;
  /** Explicit, opt-in bank-side remap only. Never automatic. */
  remapClaimedTo?: 'authored';
}
export interface BankExportReport {
  questions: number; exported: number; needs_answer_key: Array<{ question: string; reason: string }>;
  untagged: number; tagged: number; asset_count: number; total_bytes: number;
  images_placed: number; image_references: number;
  missing_assets: Array<{ question: string; image: string }>;
  unresolved_placeholders: Array<{ question: string; image: string; sha: string | null; owner: string; reason: string }>;
  image_options: string[]; notes: string[];
  package_section_receipt?: ExamDoc['source']['packageSectionReceipt'];
  enrichment_notes?: string[];
  /** #58 — destination-contract state: always `verified: false` until the real gate has run. */
  contract: BankContractReport;
  /** #58 — descriptive artifact tally: what travelled, what stayed structured-only. */
  artifacts: { verified: number; teacher: number; pending: number; stale: number };
  /** #58 — questions whose verdicts were invalidated because their evidence changed. */
  stale_verdicts: string[];
  /** #58 — lossless answer bridge file inside the ZIP (never executable by itself). */
  preserved_answers: string;
}
export type BankQuestionType = 'multiple_choice' | 'true_false' | 'short_answer' | 'long_answer' | 'fill_in_blank' | 'matching' | 'ordering';
export type BankSourceType = 'official_cited' | 'authored' | 'claimed';
export interface BankQuestion {
  type: BankQuestionType; title: string; stem?: string; stem_blocks?: Array<{ t: 'text'; v: string } | { t: 'img'; asset: string }>;
  options?: Array<{ key: string; text: string }>; answer_key?: { correct: string[]; grading: 'auto' } | null;
  /** #58 — optionless fill-in-the-blank answers, preserved as one entry per blank (alternatives as arrays). */
  correctFillBlanks?: Array<string | string[]>;
  enrichment?: Question['enrichment'];
  /** #58 — descriptive artifacts with honest provenance; source samples are non-executing. */
  sample_answer?: { text: string; source: string; provenance?: string; judged?: string };
  rubric?: { criteria: Array<{ criterion: string; maxPoints?: number }>; sourceProvenance?: string };
  label?: string; optional_group_id?: string; optional_branch?: string;
  explanation: { text: string; source: 'model' } | null; points: number | null; grade: string; subject: string;
  curriculum_hints: { chapter: string | null; lesson: string | null; topic: string | null };
  /** #58 — inherited lesson provenance travels when the bank can store it (pending contract). */
  curriculum_source?: 'keyword' | 'decision' | 'inherited';
  /** #58 — a required picture whose pixels are unavailable: explicit state, never a silent drop. */
  missing_assets?: string[];
  /** #58 — the unresolved placeholder itself (id/sha) kept as metadata, never rendered to students. */
  unresolved_placeholders?: Array<{ asset: string; sha: string | null; reason: string }>;
  /** #58 — an option that carries a picture the contract cannot represent. */
  unsupported_option_images?: string[];
  difficulty?: { value: number; source: 'model' };
  provenance: { source_type: BankSourceType; source_url: null; source_ref: string | null };
  tags: string[];
}
export interface BankBatch { batch_id: string; source_dataset: string; questions: BankQuestion[] }
export interface BankExport { batch: BankBatch; report: BankExportReport; zip: Uint8Array; filename: string }

const typeMap: Partial<Record<Question['type'], BankQuestionType>> = { mcq: 'multiple_choice', truefalse: 'true_false', fillblank: 'fill_in_blank', short: 'short_answer', long: 'long_answer', essay: 'long_answer', matching: 'matching', multi: 'ordering' };
export function bankSlug(value: string): string { return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'exam'; }
export function defaultBankDataset(doc: ExamDoc): string { return bankSlug([doc.meta.subject, doc.meta.title || doc.displayName, doc.meta.year].filter(Boolean).join('-')); }

/**
 * Honest provenance. `source_type` is never inferred from a title: only an explicit document
 * field or the imported row's own provenance counts. A claimed source stays claimed unless the
 * caller opts in to a remap.
 */
export function bankProvenance(doc: ExamDoc, question?: Question, options?: Pick<BankExportOptions, 'remapClaimedTo'>): BankQuestion['provenance'] {
  const meta = doc.meta as typeof doc.meta & { official?: boolean; source_type?: string; sourceType?: string; provenance?: { source_type?: string; source_ref?: string } };
  const importedType = typeof question?.imported?.provenance?.source_type === 'string' ? question.imported.provenance.source_type : undefined;
  const metaType = meta.provenance?.source_type || meta.source_type || meta.sourceType;
  // A document-level read of imported rows is evidence only when every row agrees.
  const rowTypes = question ? [] : [...new Set((doc.questions || []).map(row => row.imported?.provenance?.source_type).filter((value: unknown): value is string => value === 'official_cited' || value === 'claimed' || value === 'authored'))];
  let sourceType: BankSourceType = importedType === 'official_cited' || importedType === 'claimed' ? importedType
    : metaType === 'official_cited' || metaType === 'claimed' ? metaType
    : meta.official === true ? 'official_cited'
    : rowTypes.length === 1 ? rowTypes[0] as BankSourceType
    : 'authored';
  if (sourceType === 'claimed' && options?.remapClaimedTo) sourceType = options.remapClaimedTo;
  const importedRef = typeof question?.imported?.provenance?.source_ref === 'string' && question.imported.provenance.source_ref.trim() ? question.imported.provenance.source_ref.trim() : undefined;
  const metaRef = typeof meta.provenance?.source_ref === 'string' && meta.provenance.source_ref.trim() ? meta.provenance.source_ref.trim() : undefined;
  // A title is not a citation: an official paper needs an explicitly supplied reference.
  return { source_type: sourceType, source_url: null, source_ref: importedRef || metaRef || null };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return undefined;
}

/**
 * Compact physical reference: `<file|teacher ref> · p.<page> · item <label> · group <n> (<total>)`.
 * Only components that are actually known are printed — an unknown page/group is omitted, never
 * replaced with a fabricated `p.1`/section index. An explicit teacher reference is never discarded.
 */
export function compactBankSourceRef(doc: ExamDoc, q: Question, teacherRef?: string): string {
  const explicitTeacher = teacherRef?.trim();
  const imported = (q.imported || {}) as Record<string, unknown>;
  const importedProvenance = (imported.provenance || {}) as Record<string, unknown>;
  const suppliedRef = explicitTeacher || (typeof importedProvenance.source_ref === 'string' ? importedProvenance.source_ref.trim() : '');
  const file = explicitTeacher || (doc.source.fileName || doc.displayName || 'exam').replace(/\.[^./\\]+$/, '');
  const lineNos = (q.spans || []).map(span => { const value = Array.isArray(span) ? span[0] : span.line; return typeof value === 'number' ? value : NaN; }).filter(Number.isFinite);
  const linePage = lineNos.map(n => doc.source.lines?.[n - 1]?.page).filter(page => Number.isFinite(page))[0];
  // Only a page the source actually supplied counts. A package image defaults to page 1 and a
  // section index is not the paper's group number, so neither is used to invent one.
  const referencePage = /\bpage\s*(\d+)\b/i.exec(suppliedRef)?.[1];
  const referenceGroup = /\b(?:source\s+)?group\s*(\d+)\b/i.exec(suppliedRef)?.[1];
  const page = firstNumber(linePage, imported.page, imported.source_page, imported.sourcePage, imported.printed_page, importedProvenance.page, referencePage);
  const group = firstNumber(imported.group, imported.group_no, imported.groupNo, imported.group_number, imported.section_number, imported.sectionNumber, referenceGroup);
  const total = firstNumber(imported.group_total, imported.groupTotal, imported.total_groups, imported.totalGroups, importedProvenance.group_total);
  const tail = [
    page !== undefined ? ` · p.${page}` : '',
    ` · item ${q.label || q.no}`,
    group !== undefined ? ` · group ${group}${total ? ` (${total})` : ''}` : '',
  ].join('');
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
  let blob: Blob | undefined;
  try { blob = image.blobKey ? await getReviewImageBlob(image.blobKey) : undefined; } catch { blob = undefined; }
  return blob || (image.dataUrl?.startsWith('data:') ? dataUrlToBlob(image.dataUrl) : undefined);
}

export { extractInlineDataImages } from './inlineImages';

export async function createQuestionBankExport(doc: ExamDoc, options: BankExportOptions, loadImage: (image: ImageAsset) => Promise<Blob | undefined> = defaultImageLoader): Promise<BankExport> {
  const sourceDataset = options.sourceDataset.trim();
  if (!sourceDataset) throw new Error('Source dataset is required.');
  const profile: BankContractProfile = options.contract || 'bank-v2-provisional';
  const contract = emptyContractReport(profile);
  const teacherRef = options.sourceRef?.trim();
  const docProvenance = bankProvenance(doc, undefined, options);
  if (docProvenance.source_type === 'official_cited' && !teacherRef && !docProvenance.source_ref) throw new Error('Official papers require a source reference.');
  if (!globalThis.crypto?.randomUUID) throw new Error('Secure UUID generation is unavailable.');
  const questions = bankQuestions(doc);
  const report: BankExportReport = {
    questions: questions.length, exported: 0, needs_answer_key: [], untagged: 0, tagged: 0, asset_count: 0, total_bytes: 0,
    images_placed: 0, image_references: 0, missing_assets: [], unresolved_placeholders: [], image_options: [], notes: [],
    contract, artifacts: { verified: 0, teacher: 0, pending: 0, stale: 0 }, stale_verdicts: [],
    preserved_answers: 'preserved/answers.json',
  };
  const assets = new Map<string, { ext: string; bytes: Uint8Array; mime: string; imageIds: string[] }>();
  const imageHashes = new Map<string, string | null>();
  const addAssetBytes = async (bytes: Uint8Array, mime: string, ownerKey: string): Promise<string> => {
    const ext = imageExtension(bytes);
    const hash = await realSha256(bytes);
    const actualMime = ({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' } as Record<string, string>)[ext] || 'application/octet-stream';
    if (!assets.has(hash)) assets.set(hash, { ext, bytes, mime: actualMime, imageIds: [ownerKey] });
    else if (!assets.get(hash)!.imageIds.includes(ownerKey)) assets.get(hash)!.imageIds.push(ownerKey);
    return hash;
  };
  /** Resolve to the sha256 reference, or null when pixels are unavailable. */
  const resolveAsset = async (imageId: string): Promise<string | null> => {
    const cached = imageHashes.get(imageId);
    if (cached !== undefined) return cached;
    const image = doc.images.find(img => img.id === imageId);
    if (!image) { imageHashes.set(imageId, null); return null; }
    let blob: Blob | undefined;
    try { blob = await loadImage(image); } catch { blob = undefined; }
    if (!blob) { imageHashes.set(imageId, null); return null; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try { const hash = await addAssetBytes(bytes, image.mime, imageId); imageHashes.set(imageId, hash); return hash; } catch { imageHashes.set(imageId, null); return null; }
  };
  // Bundle every saved asset, including currently unassigned images, so the canonical package
  // can report and preserve them rather than silently dropping unowned pixels.
  for (const image of doc.images || []) await resolveAsset(image.id);
  if (doc.source.packageSectionReceipt) report.package_section_receipt = doc.source.packageSectionReceipt;
  if (doc.source.enrichmentNotes?.length) report.enrichment_notes = doc.source.enrichmentNotes;
  const batch: BankBatch = { batch_id: crypto.randomUUID(), source_dataset: sourceDataset, questions: [] };
  const preserved: PreservedAnswer[] = [];
  for (const q of questions) {
    const label = `Q${q.label || q.no}`;
    const type = typeMap[q.type] || 'short_answer';
    if (!typeMap[q.type]) report.notes.push(`${label}: ${q.type} exported as short_answer.`);
    const passage = doc.source.kind === 'package' ? doc.passages?.find(p => p.id === q.passageId)?.text : undefined;
    // Inline base64 pictures become real asset references; no data URI ever survives into a value.
    const rawStem = stripImagePlaceholderTokens([passage, bankStem(doc, q).trim()].filter(Boolean).join('\n\n')).replace(/\[\s*\]|\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').trim();
    const extracted = extractInlineDataImages(rawStem);
    const stem = extracted.text.replace(/[ \t]{2,}/g, ' ').trim();
    const inlineAssets: Array<{ hash: string; offset: number }> = [];
    for (const [inlineIndex, inline] of extracted.images.entries()) inlineAssets.push({ hash: await addAssetBytes(inline.bytes, inline.mime, `${q.id}:inline:${inlineIndex + 1}`), offset: inline.offset });
    const bankOptionsForQuestion = bankOptions(doc, q);
    const unsupportedOptionImages: string[] = [];
    const optionDataImages: Array<{ optionIndex: number; hash: string }> = [];
    const optionImageOwnerKeys = new Set<string>();
    for (const [index, source] of (q.options || []).entries()) {
      const optionText = bankOptionsForQuestion[index]?.text ?? source.text ?? '';
      if (!/data:image\//i.test(optionText)) continue;
      const inline = extractInlineDataImages(optionText);
      if (!inline.images.length) { unsupportedOptionImages.push(String(index + 1)); continue; }
      for (const image of inline.images) { const owner = `${q.id}:option${index + 1}`; optionImageOwnerKeys.add(owner); optionDataImages.push({ optionIndex: index, hash: await addAssetBytes(image.bytes, image.mime, owner) }); }
      unsupportedOptionImages.push(String(index + 1));
      bankOptionsForQuestion[index] = { ...bankOptionsForQuestion[index], text: inline.text.replace(/[ \t]{2,}/g, ' ').trim() };
    }
    const optionImages = (q.images || []).filter(i => i.role === 'option');
    if (optionImages.length) {
      const available = optionImages.filter(image => doc.images.some(candidate => candidate.id === image.imageId));
      if (available.length) report.image_options.push(label);
      for (const image of available) {
        const indexByAnchor = image.anchorLine == null ? -1 : (q.options || []).findIndex(opt => (opt.spans || []).some(span => Array.isArray(span) ? image.anchorLine! >= span[0] && image.anchorLine! <= span[1] : span.line === image.anchorLine));
        const optionIndex = indexByAnchor >= 0 ? indexByAnchor : 0;
        if (!unsupportedOptionImages.includes(String(optionIndex + 1))) unsupportedOptionImages.push(String(optionIndex + 1));
        const hash = await resolveAsset(image.imageId);
        if (hash) optionDataImages.push({ optionIndex, hash });
      }
    }
    const baseHints = q.curriculumHints || emptyCurriculumHints();
    const suggested = q.enrichment?.lessons?.[0];
    const selectedLesson = q.enrichment?.teacherLesson?.lesson || (doc.source.kind !== 'package' && suggested && suggested.probability >= .5 ? suggested.lesson : undefined);
    const teacher = q.enrichment?.teacherLesson && curriculumLessons(doc.meta.grade, doc.meta.subject).find(l => l.title === selectedLesson);
    const hints = teacher ? hintsForLesson(teacher) : selectedLesson ? { ...baseHints, lesson: selectedLesson } : baseHints;
    if (hints.chapter || hints.lesson || hints.topic) report.tagged++; else report.untagged++;
    const section = doc.sections.find(s => s.id === q.sectionId)?.title;
    const suggestion = typeSuggestion(q);
    const tags = [...new Set([...reviewTags(q, doc), section, doc.meta.subject,
      ...(unsupportedOptionImages.length ? ['option_image_unsupported'] : []),
      ...(suggestion ? [`type_suggestion_${suggestion}`] : [])].filter((s): s is string => Boolean(s?.trim())).map(s => s.trim()))];
    if (suggestion) report.notes.push(`${label}: the source labels this ${q.type} but the task reads as ${suggestion} — the source type is preserved; confirm the suggestion with the teacher before changing it.`);
    // Student-facing bank exports omit uncertain, unjudged, stale and rejected explanations.
    const explanationCurrent = q.explanation && explanationState(doc, q) === 'verified';
    const row: BankQuestion = {
      type, title: doc.source.kind === 'package' ? `Question ${q.label}` : stem.slice(0, 60),
      ...(doc.source.kind === 'package' ? { label: q.label } : {}),
      ...(q.optionalGroupId ? { optional_group_id: q.optionalGroupId, optional_branch: q.optionalBranch } : {}),
      explanation: explanationCurrent ? q.explanation! : null,
      points: typeof q.points === 'number' && Number.isFinite(q.points) && q.points >= 0 ? q.points : null,
      ...exportIdentity(doc.meta.grade, doc.meta.subject), curriculum_hints: hints,
      ...(q.curriculumSource ? { curriculum_source: q.curriculumSource } : {}),
      provenance: { ...bankProvenance(doc, q, options), source_ref: compactBankSourceRef(doc, q, teacherRef) }, tags,
    };
    if (q.curriculumSource === 'inherited') contract.pending.push({ question: label, item: 'curriculum_source', kind: 'inherited', reason: 'inherited lesson provenance has no confirmed bank field', contract_question: CONTRACT_REQUESTS[6] });

    // ── answers: facts by type; proposals never participate ──────────────────────────────────
    const plan = planBankAnswer(q);
    applyAnswerPlan(row, q, plan, profile, contract);
    if (plan.kind === 'keyless' && AUTO_GRADED_TYPES.has(q.type)) {
      report.needs_answer_key.push({ question: label, reason: plan.reason });
    } else if (plan.kind === 'keyless' && DESCRIPTIVE_TYPES.has(q.type)) {
      report.notes.push(`${label}: keyless descriptive (tashrihi) item — teacher-graded, no executable key exported.`);
    }
    // ── descriptive artifacts: teacher-confirmed always; model only while verified + current ─
    const artifacts = descriptiveArtifacts(doc, q);
    for (const artifact of artifacts) {
      if (artifact.source !== 'model') { report.artifacts.teacher++; continue; }
      if (artifact.current) report.artifacts.verified++;
    }
    const staleSample = q.sampleAnswer && q.sampleAnswer.source === 'model' && artifactState(doc, q, q.sampleAnswer, sampleFingerprint(doc, q, q.sampleAnswer.text)) !== 'verified';
    const staleRubric = q.rubric && q.rubric.source === 'model' && artifactState(doc, q, q.rubric as { judged?: 'verified'; evidence?: string }, rubricFingerprint(doc, q, q.rubric.criteria)) !== 'verified';
    if (staleSample || staleRubric) {
      report.artifacts.stale++;
      report.stale_verdicts.push(label);
      report.notes.push(`${label}: model ${[staleSample ? 'sample answer' : '', staleRubric ? 'rubric' : ''].filter(Boolean).join(' + ')} not exported — the verdict is stale or unverified for the current evidence.`);
    }
    if (q.imported && DESCRIPTIVE_TYPES.has(q.type) && !(q.rubric?.source === 'teacher')) report.artifacts.pending++;
    applyDescriptiveArtifacts(row, q, artifacts, profile, contract);
    preserved.push(preservedAnswer(doc, q, tags));
    const importedUnresolved = Array.isArray(q.imported?.unresolved_placeholders) ? q.imported.unresolved_placeholders : [];
    if (importedUnresolved.length) {
      row.unresolved_placeholders = importedUnresolved.map((item: any) => ({ asset: String(item.asset || ''), sha: typeof item.sha === 'string' ? item.sha : null, reason: String(item.reason || 'pixels unavailable at export time') }));
      row.missing_assets = row.unresolved_placeholders.map(item => item.asset);
      report.image_references++;

      for (const item of row.unresolved_placeholders) {
        const unresolvedRecord = { question: label, image: item.asset, sha: item.sha, owner: String((importedUnresolved.find((value: any) => value.asset === item.asset) as any)?.owner || q.label), reason: item.reason };
        report.unresolved_placeholders.push(unresolvedRecord);
        report.missing_assets.push({ question: label, image: item.asset });
        report.notes.push(`${label}: unresolved image ${item.asset} remains pending in preserved metadata; no pixels were available.`);
      }
      preserved[preserved.length - 1] = { ...preserved[preserved.length - 1], unresolved_placeholders: row.unresolved_placeholders } as (typeof preserved)[number];
    }

    // ── stem images: one bundle per question, never a token, never a silent drop ────────────
    const stemImages = (q.images || []).filter(i => i.role === 'stem' || i.role === 'table');
    const missingForQuestion: string[] = [];
    const unresolvedForQuestion: NonNullable<BankQuestion['unresolved_placeholders']> = [];
    if (stemImages.length || inlineAssets.length) {
      const blocks: NonNullable<BankQuestion['stem_blocks']> = [];
      const imgBlocks = (await Promise.all(stemImages.map(async image => {
        const hash = await resolveAsset(image.imageId);
        if (hash) return { t: 'img' as const, asset: hash };
        // Unresolved placeholder: the reference and its sha stay in metadata + report, but no
        // broken image block (and no placeholder token) is ever rendered to a student.
        const sha = doc.images.find(img => img.id === image.imageId)?.sha || null;
        missingForQuestion.push(image.imageId);
        unresolvedForQuestion.push({ asset: image.imageId, sha, reason: 'pixels unavailable at export time' });
        report.missing_assets.push({ question: label, image: image.imageId });
        report.unresolved_placeholders.push({ question: label, image: image.imageId, sha, owner: q.label, reason: 'pixels unavailable at export time' });
        report.notes.push(`${label}: image ${image.imageId} has no available pixels — the reference is retained in metadata (unresolved_placeholders) and reported; nothing is rendered to students.`);
        return undefined;
      }))).filter((block): block is { t: 'img'; asset: string } => Boolean(block));
      const positions = [
        ...(q.packageImagePositions?.filter(p => stemImages.some(i => i.imageId === p.imageId)) || []).map(p => ({ ...p, source: 'package' as const })),
        ...inlineAssets.map((asset, index) => ({ imageId: `inline:${index}`, offset: asset.offset, source: 'inline' as const, hash: asset.hash })),
      ].sort((a, b) => a.offset - b.offset);
      if (positions.length) {
        if (passage) blocks.push({ t: 'text', v: passage + '\n\n' });
        let at = 0;
        for (const position of positions) {
          const offset = Math.max(at, Math.min(stem.length, position.offset));
          if (offset > at) blocks.push({ t: 'text', v: stem.slice(at, offset) });
          if (position.source === 'inline') blocks.push({ t: 'img', asset: position.hash });
          else {
            const idx = stemImages.findIndex(image => image.imageId === position.imageId);
            if (idx >= 0 && imgBlocks[idx]) blocks.push(imgBlocks[idx]);
          }
          at = Math.min(offset, stem.length);
        }
        if (at < stem.length) blocks.push({ t: 'text', v: stem.slice(at) });
        stemImages.forEach((image, i) => { if (!positions.some(p => p.source === 'package' && p.imageId === image.imageId)) blocks.push(imgBlocks[i]); });
      } else {
        const leadIn = /(?:picture|image|photo|figure|diagram)\s+(?:shown\s+)?below|(?:تصویر|شکل)\s*(?:زیر|پایین)/i.test(stem);
        const allImages = [...imgBlocks, ...inlineAssets.map(asset => ({ t: 'img' as const, asset: asset.hash }))];
        if (leadIn) blocks.push(...allImages, { t: 'text', v: stem }); else blocks.push({ t: 'text', v: stem }, ...allImages);
      }
      // A removed placeholder never leaves empty brackets behind in student text.
      for (const block of blocks) if (block.t === 'text') block.v = stripImagePlaceholderTokens(block.v).replace(/\[\s*\]|\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').trimEnd();
      report.image_references++;
      row.stem_blocks = blocks.filter(block => block.t === 'img' || block.v.trim());
    } else row.stem = stem;
    if (missingForQuestion.length) row.missing_assets = missingForQuestion;
    if (unresolvedForQuestion.length) {
      row.unresolved_placeholders = unresolvedForQuestion;
      preserved[preserved.length - 1] = { ...preserved[preserved.length - 1], unresolved_placeholders: unresolvedForQuestion } as (typeof preserved)[number];
    }
    if (unsupportedOptionImages.length) {
      row.unsupported_option_images = [...new Set(unsupportedOptionImages)];
      if (!report.image_options.includes(label)) report.image_options.push(label);
      report.notes.push(`${label}: option ${row.unsupported_option_images.join(', ')} carries a picture — the contract cannot represent picture options; the file ships in assets/ and the question is held for review.`);
      contract.pending.push({ question: label, item: 'option_image', kind: 'picture-option', reason: 'picture options are not representable in this contract; asset shipped, option held', contract_question: CONTRACT_REQUESTS[7] });
    }
    if (bankOptionsForQuestion.length) row.options = bankOptionsForQuestion;
    if (optionDataImages.length) {
      // Assets are already in the pool; record the ownership so nothing is lost even when the
      // destination cannot express a picture option.
      for (const entry of optionDataImages) {
        const owner = `${q.id}:option${entry.optionIndex + 1}`;
        if (!optionImageOwnerKeys.has(owner)) continue; // real ImageAsset ids already recorded by resolveAsset
        const asset = assets.get(entry.hash);
        if (asset && !asset.imageIds.includes(owner)) asset.imageIds.push(owner);
      }
    }
    if (q.enrichment) {
      const { evidence: _evidence, ...review } = q.enrichment;
      row.enrichment = review;
    }
    if (q.difficulty && q.difficulty.source === 'model' && Number.isInteger(q.difficulty.value) && q.difficulty.value >= 1 && q.difficulty.value <= 5 && (q.difficultyMode === 'active' || options.includeModelDifficulty === true)) row.difficulty = { value: q.difficulty.value, source: 'model' };
    batch.questions.push(row); report.exported++;
  }
  report.asset_count = assets.size;
  report.images_placed = assets.size;
  report.total_bytes = [...assets.values()].reduce((sum, asset) => sum + asset.bytes.length, 0);
  if (report.image_references && !report.images_placed) report.notes.push(`${report.image_references} question(s) reference image assets, but no pixels were available — every reference is retained in metadata and reported; nothing is rendered to students.`);
  if (report.missing_assets.length) contract.pending.push({ question: report.missing_assets.map(entry => entry.question).join(', '), item: 'missing_image', kind: 'missing-asset', reason: 'required pixels unavailable; owner, identity, and reason are retained in preserved metadata and the export report', contract_question: CONTRACT_REQUESTS[7] });
  const slug = `${bankSlug(doc.meta.title || doc.displayName)}-batch`;
  const zip = new JSZip(); const folder = zip.folder(slug)!;
  const interchangeAssets = new Map<string, InterchangeAssetInput>();
  for (const image of doc.images || []) {
    const hash = imageHashes.get(image.id);
    if (!hash) continue;
    const asset = assets.get(hash);
    if (!asset) continue;
    interchangeAssets.set(image.id, { sha256: hash, path: `assets/${hash}.${asset.ext}`, mime: asset.mime, bytes: asset.bytes.length });
  }
  for (const [hash, asset] of assets) for (const ownerKey of asset.imageIds) {
    const q = questions.find(question => ownerKey.startsWith(`${question.id}:`));
    const file = { sha256: hash, path: `assets/${hash}.${asset.ext}`, mime: asset.mime, bytes: asset.bytes.length };
    if (q && /^\d+$/.test(ownerKey.slice(`${q.id}:inline:`.length)) && ownerKey.startsWith(`${q.id}:inline:`)) {
      const index = Number(ownerKey.slice(`${q.id}:inline:`.length)) - 1;
      const inline = extractInlineDataImages(bankStem(doc, q)).images[index];
      interchangeAssets.set(ownerKey, { ...file, assetId: `asset_${hash}`, ownerQuestionId: q.id, location: 'stem', offset: inline?.offset ?? 0 });
    } else if (q && ownerKey.startsWith(`${q.id}:option`)) {
      const match = new RegExp(`^${q.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:option(\d+)$`).exec(ownerKey);
      interchangeAssets.set(`${ownerKey}:asset:${hash}`, { ...file, assetId: `asset_${hash}`, ownerQuestionId: q.id, location: 'option', optionIndex: match ? Number(match[1]) - 1 : undefined });
    } else if ((doc.images || []).some(image => image.id === ownerKey)) interchangeAssets.set(ownerKey, file);
  }
  const canonicalDoc = structuredClone(doc);
  const preserveHistory = (question: Question) => {
    const record = preserved.find(item => item.questionId === question.id);
    if (record?.source_history) question.imported = { ...(question.imported || {}), source_history: structuredClone(record.source_history) };
    for (const child of question.subQuestions || []) preserveHistory(child);
  };
  for (const question of canonicalDoc.questions) preserveHistory(question);
  const interchange = buildExportDoc(canonicalDoc, interchangeAssets);
  const partCount = Math.ceil(batch.questions.length / 50);
  folder.file('examparse.json', JSON.stringify(interchange, null, 2));
  folder.file('examparse-format.md', EXAMPARSE_FORMAT_README);
  if (batch.questions.length <= 50) folder.file('batch.json', JSON.stringify(batch, null, 2));
  else for (let i = 0; i < batch.questions.length; i += 50) {
    const part = Math.floor(i / 50) + 1;
    // #58 — parts declare their index/total so an incomplete folder is detected on import.
    const chunk = { ...batch, batch_id: `${batch.batch_id}-part-${part}`, part_index: part, part_total: partCount, questions: batch.questions.slice(i, i + 50) };
    folder.file(`part-${part}/batch.json`, JSON.stringify(chunk, null, 2));
  }
  folder.file('export-report.json', JSON.stringify(report, null, 2));
  folder.file('legacy-projection.json', JSON.stringify({
    format: 'examparse.legacy-projection', version: '1.0.0', lossy: true,
    canonical: 'examparse.json',
    projection: batch.questions.length <= 50 ? 'batch.json' : `part-1..part-${partCount}/batch.json`,
    knownLosses: [
      'The bank row shape is not a full ExamParse document and omits source lines, parser provenance, full review/undo history, and source-key evidence.',
      'Question labels and section/branch identities may be flattened or reduced to bank-facing fields.',
      'Unknown optional-group scoring rules, unpriced points, and pending review states are not executable grading instructions.',
      'Listening scripts, source-answer history, and evidence-bound model proposals are available only in the canonical document or explicit teacher-only sidecars.',
      'Image ownership/order/positions and unavailable pixels may not be representable by the destination row schema.',
    ],
  }, null, 2));
  folder.file('preserved/answers.json', JSON.stringify({ format: 'examparse-preserved-answers/1', executable: false, note: 'Lossless answer facts. Nothing in this file is advisory beyond the bank contract; executable fields exist only in batch.json.', questions: preserved }, null, 2));
  const listeningScripts = questions.flatMap(q => {
    const text = typeof q.imported?.script === 'string' ? q.imported.script : typeof q.imported?.transcript === 'string' ? q.imported.transcript : '';
    if (!text.trim()) return [];
    return [{ label: q.label || String(q.no), sectionTitle: doc.sections.find(section => section.id === q.sectionId)?.title || null, text: text.trim(), evidenceType: 'teacher-only-script', note: 'Script text only; not audio and not independent proof of the original recording.' }];
  });
  if (listeningScripts.length) folder.file('preserved/listening-scripts.json', JSON.stringify({ format: 'examparse-teacher-listening-evidence/1', studentFacing: false, scripts: listeningScripts }, null, 2));
  folder.file('contract/requests.json', JSON.stringify({ profile: contract.profile, verified: false, note: contract.note, requests: CONTRACT_REQUESTS, pending: contract.pending }, null, 2));
  folder.file('assets/manifest.json', JSON.stringify(interchange.assetManifest, null, 2));
  for (const [hash, asset] of assets) folder.file(`assets/${hash}.${asset.ext}`, asset.bytes);
  // Multi-part exports share ONE asset pool. Each part folder also gets a pointer manifest so a
  // part can resolve the same files relative to its own folder when the adapter reads it there.
  if (batch.questions.length > 50) {
    const parts = Math.ceil(batch.questions.length / 50);
    for (let part = 1; part <= parts; part++) folder.file(`part-${part}/assets-manifest.json`, JSON.stringify({
      format: 'appendix-a-assets/1.1', shared: true,
      assets: [...assets.entries()].map(([hash, asset]) => ({ id: hash, file: `../assets/${hash}.${asset.ext}`, sha256: hash, mime: asset.mime, bytes: asset.bytes.length })),
    }, null, 2));
  }
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
