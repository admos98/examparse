import type { ExamDoc, ImageAsset, Question } from '../types';
import { exportSafeQuestion } from './explanationVisibility';
import { migrateLegacyAiAnswers } from './bankAnswers';

/** Standalone ExamParse interchange contract. Increment only for incompatible semantic changes. */
export const EXAMPARSE_FORMAT = 'examparse.interchange' as const;
export const EXAMPARSE_FORMAT_VERSION = '1.0.0' as const;
export const EXAMPARSE_ASSET_MANIFEST_FORMAT = 'examparse.assets' as const;
export const EXAMPARSE_FORMAT_README = `# ExamParse standalone interchange v1.0.0

This is a complete ExamParse document. It requires no bank application, database, service, credential, or model call. The root of examparse.json is the ordinary ExamDoc plus format, formatVersion, assetManifest, completeness, teacherOnly, and exportMeta.

Question identity uses id plus exact printed label, section/parent, and optional-branch identity; numeric no is only ordering and may repeat. Unknown values remain unknown. Unpriced points are absent/null, never inferred to fit a total.

assets/manifest.json equals examparse.json.assetManifest. assets/<sha256>.<ext> contains actual bundled pixels; path is package-relative, SHA-256 is over actual bytes, and MIME/extension come from the byte signature. Missing/corrupt pixels stay as unavailable records with owners and reason. Unassigned pixels are retained. Inline base64 is never serialized into JSON.

questions[].answer is source/keyfile evidence bound to addressable key-tagged lines or an explicit teacher save. Model/raw-reader answers are non-executable enrichment proposals. Teacher-only source history and review records remain in the document. teacherOnly.boundary is not-student-safe: this is not a student payload. listeningScripts are teacher-only text, not audio or proof of a recording.

completeness records unresolved types, keys, points, optional-group rules, assets, and multipart receipts. Legacy batch.json files are lossy projections; legacy-projection.json identifies known losses and the canonical JSON.

Schema: schemas/examparse-interchange-1.0.0.schema.json in the ExamParse repository. Full format notes: docs/examparse-interchange-v1.md.
`;

export interface ExamParseAssetRecord {
  id: string;
  sha256: string | null;
  mime: string;
  path: string | null;
  state: 'available' | 'unavailable' | 'unassigned' | 'reference-only';
  references: Array<{ questionId: string; label: string; location: 'stem' | 'option' | 'table' | 'decoration'; optionId?: string; offset?: number }>;
  reason?: string;
}
export interface ExamParseInterchange extends Omit<ExamDoc, 'images'> {
  format: typeof EXAMPARSE_FORMAT;
  formatVersion: typeof EXAMPARSE_FORMAT_VERSION;
  images: Array<Omit<ImageAsset, 'dataUrl' | '_blob'> & { exportPath: string | null }>;
  assetManifest: { format: typeof EXAMPARSE_ASSET_MANIFEST_FORMAT; version: typeof EXAMPARSE_FORMAT_VERSION; root: string; assets: ExamParseAssetRecord[] };
  completeness: { state: 'complete' | 'partial' | 'unverified'; issues: Array<{ code: string; message: string; questionId?: string; assetId?: string }> };
  teacherOnly: {
    boundary: 'not-student-safe';
    description: string;
    fieldPaths: string[];
    listeningScripts: Array<{ questionId: string; label: string; sectionId: string | null; sectionTitle: string | null; text: string; evidenceType: 'teacher-only-script'; note: string }>;
  };
}

export interface InterchangeAssetInput { sha256: string; path: string; mime: string; bytes: number; assetId?: string; ownerQuestionId?: string; location?: 'stem' | 'option'; optionIndex?: number; offset?: number }

const safeMime = (value: unknown): string => typeof value === 'string' && /^image\/[A-Za-z0-9.+-]+$/.test(value) ? value : 'application/octet-stream';
const isDataUri = (value: string): boolean => /^data:image\/[\w.+-]+;base64,/i.test(value);
const safeRelativeAssetPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.startsWith('\\') && !/^[a-z]:/i.test(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const stripBinaryText = (value: string): string => isDataUri(value) ? '[inline image omitted; see pending asset record and use the self-contained ZIP export]' : value;
function sanitize(value: any): any {
  if (typeof value === 'string') return stripBinaryText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (['dataUrl', '_blob', 'blobKey', 'localUrl', 'localURL', 'pageImages', 'pageThumbKeys'].includes(key)) continue;
    out[key] = sanitize(child);
  }
  return out;
}
function flattenQuestions(questions: Question[]): Question[] { return questions.flatMap(question => [question, ...flattenQuestions(question.subQuestions || [])]); }
function getOwnerReferences(doc: ExamDoc, image: ImageAsset): ExamParseAssetRecord['references'] {
  const refs: ExamParseAssetRecord['references'] = [];
  for (const q of flattenQuestions(doc.questions || [])) {
    for (const [index, ref] of (q.images || []).entries()) if (ref.imageId === image.id) {
      const position = q.packageImagePositions?.find(item => item.imageId === image.id);
      const optionIndex = ref.role === 'option' && image.anchorLine != null
        ? (q.options || []).findIndex(option => (option.spans || []).some(span => Array.isArray(span) ? image.anchorLine! >= span[0] && image.anchorLine! <= span[1] : span.line === image.anchorLine))
        : -1;
      refs.push({ questionId: q.id, label: q.label || String(q.no), location: ref.role, ...(optionIndex >= 0 ? { optionId: `${q.id}:option:${optionIndex + 1}` } : {}), ...(position ? { offset: position.offset } : {}) });
    }
    for (const [optionIndex, option] of (q.options || []).entries()) {
      const dynamic = option as typeof option & { imageId?: string; images?: Array<{ imageId?: string; id?: string }> };
      const ids = [dynamic.imageId, ...(dynamic.images || []).map(value => value.imageId || value.id)].filter(Boolean);
      if (ids.includes(image.id)) refs.push({ questionId: q.id, label: q.label || String(q.no), location: 'option', optionId: `${q.id}:option:${optionIndex + 1}` });
    }
  }
  return refs;
}

/**
 * Produce the versioned full ExamParse document. Question keys and review artifacts remain
 * teacher-only fields on the single ExamDoc representation; this registry documents that boundary
 * instead of copying their values into a second competing object.
 */
export function buildExamParseInterchange(docInput: ExamDoc, writtenAssets: Map<string, InterchangeAssetInput> = new Map()): ExamParseInterchange {
  const doc = migrateLegacyAiAnswers(structuredClone(docInput));
  const issues: ExamParseInterchange['completeness']['issues'] = [];
  const assets = (doc.images || []).map(image => {
    const refs = getOwnerReferences(doc, image);
    const file = writtenAssets.get(image.id);
    const hasInline = (image.dataUrl || '').startsWith('data:');
    const state: ExamParseAssetRecord['state'] = !refs.length ? 'unassigned' : file ? 'available' : image.storageMissing ? 'unavailable' : 'reference-only';
    if (!refs.length) issues.push({ code: 'asset-unassigned', message: `Image ${image.id} has no question or option owner.`, assetId: image.id });
    if (state !== 'available') issues.push({ code: state === 'unassigned' ? 'asset-unassigned' : 'asset-unavailable', message: `Image ${image.id} has no verified self-contained pixel file in this export.`, assetId: image.id });
    const mime = safeMime(file?.mime || image.mime);
    const sha = file?.sha256 || (typeof image.sha === 'string' && /^[a-f0-9]{64}$/i.test(image.sha) ? image.sha : null);
    return {
      id: image.id, sha256: sha, mime,
      path: file?.path || null, state, references: refs,
      ...(!file ? { reason: hasInline ? 'pixels must be materialized by the self-contained ZIP writer; this JSON export contains references only' : 'pixels were not included with this JSON export' } : {}),
    } satisfies ExamParseAssetRecord;
  });
  const knownImageIds = new Set((doc.images || []).map(image => image.id));
  const extraByHash = new Map<string, ExamParseAssetRecord>();
  for (const [ownerKey, file] of writtenAssets) {
    if (!file.ownerQuestionId || !file.location || knownImageIds.has(ownerKey)) continue;
    const id = file.assetId || `asset_${file.sha256}`;
    const record = extraByHash.get(file.sha256) || { id, sha256: file.sha256, mime: safeMime(file.mime), path: file.path, state: 'available' as const, references: [] as ExamParseAssetRecord['references'] };
    record.references.push({ questionId: file.ownerQuestionId, label: doc.questions.find(question => question.id === file.ownerQuestionId)?.label || String(doc.questions.find(question => question.id === file.ownerQuestionId)?.no || ''), location: file.location, ...(file.optionIndex != null ? { optionId: `${file.ownerQuestionId}:option:${file.optionIndex + 1}` } : {}), ...(file.offset != null ? { offset: file.offset } : {}) });
    extraByHash.set(file.sha256, record);
  }
  assets.push(...extraByHash.values());
  // Inline option pictures are never serialized as base64 text. The ZIP writer materializes them;
  // a JSON-only export records the affected option as pending instead of claiming pixels exist.
  for (const q of flattenQuestions(doc.questions || [])) {
    for (const [index, option] of (q.options || []).entries()) {
      if (typeof option.text !== 'string' || !isDataUri(option.text)) continue;
      const ownerKey = `${q.id}:option${index + 1}`;
      if (![...writtenAssets.keys()].some(key => key.startsWith(ownerKey))) {
        const pendingId = `pending_${q.id}_option_${index + 1}`;
        option.imageRefs = [...new Set([...(option.imageRefs || []), pendingId])];
        const mime = /^data:(image\/[\w.+-]+);base64,/i.exec(option.text)?.[1] || 'application/octet-stream';
        assets.push({ id: pendingId, sha256: null, mime: safeMime(mime), path: null, state: 'reference-only', references: [{ questionId: q.id, label: q.label || String(q.no), location: 'option', optionId: `${q.id}:option:${index + 1}` }], reason: 'inline option pixels are omitted from JSON-only export; use the native ZIP for a real file and SHA-256' });
        issues.push({ code: 'inline-option-image-pending', message: `Question ${q.label} option ${index + 1} contains inline image bytes not materialized in this JSON-only export. Export the ZIP to include pixels.`, questionId: q.id });
      }
      option.text = '[inline option image omitted; see option imageRefs]';
    }
    if (typeof q.stem === 'string') {
      const matches = [...q.stem.matchAll(/data:(image\/[\w.+-]+);base64,[A-Za-z0-9+/=\s]+/gi)];
      matches.forEach((match, index) => {
        const ownerKey = `${q.id}:inline:${index + 1}`;
        if (writtenAssets.has(ownerKey)) return;
        const pendingId = `pending_${q.id}_stem_${index + 1}`;
        const mime = match[1] || 'application/octet-stream';
        q.images = [...(q.images || []), { imageId: pendingId, role: 'stem' }];
        q.packageImagePositions = [...(q.packageImagePositions || []), { imageId: pendingId, offset: match.index || 0 }];
        assets.push({ id: pendingId, sha256: null, mime: safeMime(mime), path: null, state: 'reference-only', references: [{ questionId: q.id, label: q.label || String(q.no), location: 'stem', offset: match.index || 0 }], reason: 'inline stem pixels are omitted from JSON-only export; use the native ZIP for a real file and SHA-256' });
        issues.push({ code: 'inline-stem-image-pending', message: `Question ${q.label} contains inline image bytes not materialized in this JSON-only export. Export the ZIP to include pixels.`, questionId: q.id });
      });
    }
  }
  const safeQuestions = doc.questions.map(q => exportSafeQuestion(q, doc));
  const safeById = new Map(flattenQuestions(safeQuestions).map(question => [question.id, question]));
  for (const q of flattenQuestions(doc.questions || [])) {
    const safe = safeById.get(q.id); if (!safe) continue;
    for (const [index, option] of (safe.options || []).entries()) {
      const dynamic = option as typeof option & { imageId?: string; images?: Array<{ imageId?: string; id?: string }> };
      const authoredRefs = [dynamic.imageId, ...(dynamic.images || []).map(value => value.imageId || value.id), ...(option.imageRefs || [])].filter((value): value is string => typeof value === 'string' && Boolean(value));
      const inline = [...writtenAssets.entries()].filter(([key, file]) => key.startsWith(`${q.id}:option${index + 1}`) && file.ownerQuestionId === q.id && file.location === 'option');
      option.imageRefs = [...new Set([...authoredRefs, ...inline.map(([, file]) => file.assetId || `asset_${file.sha256}`)])];
      if (!option.imageRefs.length) delete option.imageRefs;
    }
    for (const [key, file] of writtenAssets) if (key.startsWith(`${q.id}:inline`) && file.ownerQuestionId === q.id && file.location === 'stem') {
      safe.images = [...(safe.images || []), { imageId: file.assetId || `asset_${file.sha256}`, role: 'stem' } as any];
      safe.packageImagePositions = [...(safe.packageImagePositions || []), { imageId: file.assetId || `asset_${file.sha256}`, offset: file.offset ?? 0 }];
    }
  }
  for (const q of safeQuestions) {
    if (/data:image\/[\w.+-]+;base64,/i.test(JSON.stringify(q))) issues.push({ code: 'inline-image-scrubbed', message: `Question ${q.label} contained inline image data; it was scrubbed from interchange JSON.`, questionId: q.id });
  }
  const listeningScripts = flattenQuestions(safeQuestions).flatMap((q: Question) => {
    const source = q.imported as Record<string, any> | undefined;
    const script = typeof source?.script === 'string' ? source.script : typeof source?.transcript === 'string' ? source.transcript : '';
    if (!script.trim()) return [];
    const section = doc.sections.find(item => item.id === q.sectionId);
    return [{ questionId: q.id, label: q.label || String(q.no), sectionId: q.sectionId || null, sectionTitle: section?.title || null, text: script.trim(), evidenceType: 'teacher-only-script' as const, note: String(source?.scriptNote || 'Script text only; not audio and not independent proof of the original recording.') }];
  });
  const cleanImages = (doc.images || []).map(image => { const { dataUrl: _dataUrl, _blob: _blob, ...rest } = image as any; const file = writtenAssets.get(image.id); const mime = safeMime(file?.mime || image.mime); const hash = file?.sha256 || image.sha; return { ...rest, mime, exportPath: file?.path || null, ...(hash ? { sha: hash } : {}) }; });
  const structuralQuestions = safeQuestions.map((question: Question) => { const clean = structuredClone(question); const imported = clean.imported as Record<string, any> | undefined; if (imported && (imported.script || imported.transcript)) { delete imported.script; delete imported.transcript; delete imported.scriptNote; delete imported.scriptEvidenceType; } return clean; });
  const safeExam = sanitize({ ...doc, questions: structuralQuestions, images: cleanImages });
  for (const question of flattenQuestions(doc.questions || [])) {
    if (question.points == null) issues.push({ code: 'points-unpriced', message: `Question ${question.label || question.no} has no evidenced point value.`, questionId: question.id });
    if (question.type === 'unknown') issues.push({ code: 'question-type-unknown', message: `Question ${question.label || question.no} has an unresolved type.`, questionId: question.id });
    if (question.enrichment?.proposedAnswer) issues.push({ code: 'answer-proposal-pending', message: `Question ${question.label || question.no} has a non-authoritative answer proposal awaiting review.`, questionId: question.id });
    if (['mcq', 'truefalse', 'fillblank', 'numeric'].includes(question.type) && !question.answer) issues.push({ code: 'grading-key-pending', message: `Question ${question.label || question.no} has no authoritative source or teacher grading key.`, questionId: question.id });
    if (question.optionalGroupId && doc.optionalGroups?.find((group: NonNullable<ExamDoc['optionalGroups']>[number]) => group.id === question.optionalGroupId)?.rule === 'unknown') issues.push({ code: 'optional-group-rule-unknown', message: `Question ${question.label || question.no} belongs to an optional group whose scoring rule is unknown.`, questionId: question.id });
  }
  if (doc.source.packageMultipartStatus === 'partial-unverified') issues.push({ code: 'multipart-partial-unverified', message: 'Legacy multipart completeness cannot be established from declared metadata.' });
  if (doc.partial || doc.source.enrichmentStatus === 'partial') issues.push({ code: 'exam-partial', message: 'The saved review document contains incomplete or unresolved work.' });
  const state = issues.some(issue => issue.code === 'multipart-partial-unverified') ? 'unverified' : issues.length ? 'partial' : 'complete';
  const manifestByKey = new Map<string, ExamParseAssetRecord & { sourceIds: string[] }>();
  for (const record of assets) {
    const key = record.sha256 ? `sha:${record.sha256}` : `id:${record.id}`;
    const prior = manifestByKey.get(key);
    const sourceId = record.id;
    if (prior) {
      prior.sourceIds.push(sourceId);
      for (const ref of record.references) if (!prior.references.some(existing => JSON.stringify(existing) === JSON.stringify(ref))) prior.references.push(ref);
      if (prior.state === 'reference-only' && record.state === 'available') { prior.state = 'available'; prior.path = record.path; prior.mime = record.mime; }
      if (prior.state === 'unavailable' && record.state === 'available') { prior.state = 'available'; prior.path = record.path; prior.mime = record.mime; }
      if (record.reason && !prior.reason) prior.reason = record.reason;
    } else manifestByKey.set(key, { ...record, id: record.sha256 ? `asset_${record.sha256}` : record.id, sourceIds: [sourceId] });
  }
  const manifestAssets = [...manifestByKey.values()].map(record => ({ ...record, state: record.references.length ? (record.path ? 'available' as const : record.state === 'unavailable' ? 'unavailable' as const : 'reference-only' as const) : 'unassigned' as const, sourceIds: [...new Set(record.sourceIds)] }));
  return {
    ...safeExam, format: EXAMPARSE_FORMAT, formatVersion: EXAMPARSE_FORMAT_VERSION,
    assetManifest: { format: EXAMPARSE_ASSET_MANIFEST_FORMAT, version: EXAMPARSE_FORMAT_VERSION, root: '.', assets: manifestAssets },
    completeness: { state, issues },
    teacherOnly: {
      boundary: 'not-student-safe',
      description: 'This full interchange document contains source keys, teacher work, answer history, model proposals, checks, and scripts. It is not a student payload.',
      fieldPaths: ['questions[].answer', 'questions[].sampleAnswer', 'questions[].rubric', 'questions[].enrichment', 'questions[].explanation', 'questions[].imported', 'source.lines', 'teacherOnly.listeningScripts'],
      listeningScripts,
    },
  };
}

/** Runtime validator for the documented v1.0.0 interchange and manifest links. */
export function validateExamParseInterchange(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['root must be an object'] };
  const root = value as any;
  if (root.format !== EXAMPARSE_FORMAT) errors.push('format must be examparse.interchange');
  if (root.formatVersion !== EXAMPARSE_FORMAT_VERSION) errors.push(`formatVersion must be ${EXAMPARSE_FORMAT_VERSION}`);
  const exam = root;
  if (typeof exam.id !== 'string' || !Array.isArray(exam.questions) || !Array.isArray(exam.sections) || !Array.isArray(exam.images)) errors.push('root document must contain id, sections, questions, and images arrays');
  const sectionIds = new Set<string>();
  for (const [index, section] of (Array.isArray(exam?.sections) ? exam.sections : []).entries()) {
    if (typeof section?.id !== 'string' || !section.id) errors.push(`sections[${index}].id is required`);
    else if (sectionIds.has(section.id)) errors.push(`duplicate section id ${section.id}`); else sectionIds.add(section.id);
  }
  const ids = new Set<string>();
  const inspectQuestion = (question: any, path: string) => {
    if (!question || typeof question.id !== 'string' || !question.id) errors.push(`${path}.id is required`);
    else if (ids.has(question.id)) errors.push(`duplicate question id ${question.id}`); else ids.add(question.id);
    if (typeof question?.label !== 'string' || !question.label) errors.push(`${path}.label is required`);
    if (question?.points !== undefined && question.points !== null && (typeof question.points !== 'number' || !Number.isFinite(question.points) || question.points < 0)) errors.push(`${path}.points must be nonnegative numeric or null`);
    if (question?.sectionId && sectionIds.size && !sectionIds.has(question.sectionId)) errors.push(`${path}.sectionId refers to missing section ${question.sectionId}`);
    if (Array.isArray(question?.subQuestions)) question.subQuestions.forEach((child: any, childIndex: number) => inspectQuestion(child, `${path}.subQuestions[${childIndex}]`));
  };
  for (const [index, question] of (Array.isArray(exam?.questions) ? exam.questions : []).entries()) {
    inspectQuestion(question, `questions[${index}]`);
  }
  if (root.assetManifest?.format !== EXAMPARSE_ASSET_MANIFEST_FORMAT || root.assetManifest?.version !== EXAMPARSE_FORMAT_VERSION || !Array.isArray(root.assetManifest?.assets)) errors.push('assetManifest format/version/assets are required');
  const assets = new Set<string>();
  for (const [index, asset] of (Array.isArray(root.assetManifest?.assets) ? root.assetManifest.assets : []).entries()) {
    if (typeof asset?.id !== 'string' || !asset.id) errors.push(`assetManifest.assets[${index}].id is required`);
    else if (assets.has(asset.id)) errors.push(`duplicate asset id ${asset.id}`); else assets.add(asset.id);
    if (!['available', 'unavailable', 'unassigned', 'reference-only'].includes(asset?.state)) errors.push(`assetManifest.assets[${index}].state is invalid`);
    if (asset?.state === 'available' && (!/^[a-f0-9]{64}$/i.test(asset.sha256 || '') || !safeRelativeAssetPath(asset.path))) errors.push(`assetManifest.assets[${index}] available path/hash is invalid`);
    if (asset?.path != null && !safeRelativeAssetPath(asset.path)) errors.push(`assetManifest.assets[${index}].path must be a safe relative path`);
    if (!Array.isArray(asset?.references)) errors.push(`assetManifest.assets[${index}].references must be an array`);
  }
  const manifestById = new Map<string, any>();
  for (const asset of Array.isArray(root.assetManifest?.assets) ? root.assetManifest.assets : []) {
    manifestById.set(asset.id, asset);
    for (const sourceId of Array.isArray(asset.sourceIds) ? asset.sourceIds : []) manifestById.set(sourceId, asset);
  }
  const knownImageIds = new Set([...(Array.isArray(root.images) ? root.images.map((image: any) => image.id) : []), ...manifestById.keys()]);
  for (const image of Array.isArray(root.images) ? root.images : []) if (image.exportPath != null) {
    const asset = manifestById.get(image.id);
    if (!safeRelativeAssetPath(image.exportPath) || !asset || asset.path !== image.exportPath || asset.sha256 !== image.sha) errors.push(`images.${image.id} exportPath/hash must resolve through assetManifest`);
  }
  const walkRefs = (question: any) => {
    for (const reference of question?.images || []) if (!knownImageIds.has(reference.imageId)) errors.push(`question ${question.label} image reference ${reference.imageId} is absent from images/assetManifest`);
    for (const option of question?.options || []) for (const ref of option?.imageRefs || []) if (!knownImageIds.has(ref)) errors.push(`question ${question.label} option image reference ${ref} is absent from images/assetManifest`);
    for (const child of question?.subQuestions || []) walkRefs(child);
  };
  for (const question of Array.isArray(root.questions) ? root.questions : []) walkRefs(question);
  for (const script of root.teacherOnly?.listeningScripts || []) if (!ids.has(script.questionId)) errors.push(`teacherOnly script references missing question ${script.questionId}`);
  if (!['complete', 'partial', 'unverified'].includes(root.completeness?.state) || !Array.isArray(root.completeness?.issues)) errors.push('completeness state/issues are required');
  if (root.teacherOnly?.boundary !== 'not-student-safe' || !Array.isArray(root.teacherOnly?.fieldPaths) || !Array.isArray(root.teacherOnly?.listeningScripts)) errors.push('teacherOnly boundary/fieldPaths/listeningScripts are required');
  if (/data:image\/[\w.+-]+;base64,/i.test(JSON.stringify(root))) errors.push('inline image data URLs are forbidden in interchange JSON');
  return { valid: errors.length === 0, errors };
}
