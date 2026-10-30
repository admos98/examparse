/**
 * Folder-only persistence; localStorage holds small client settings only.
 */
import {
  AppSettings,
  ExamDoc,
  ImageAsset,
  UsageRecord,
  getDisplayName,
} from '../types';
import {
  SAFE_STORAGE_KEY,
  validateAppSettings,
  validateJsonSize,
} from '../utils/validation';
import { getExamHealth } from '../pipeline/quality';

const MAX_STORED_EXAM_BYTES = 32 * 1024 * 1024;
const MAX_STORED_CACHE_BYTES = 20 * 1024 * 1024;
const MAX_STORED_IMAGE_BYTES = 32 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

export const DEFAULT_SETTINGS: AppSettings = {
  readFormat: 'auto',
  providers: [
    {
      id: 'google-gemini',
      name: 'Google Gemini (Native)',
      kind: 'gemini',
      baseURL: 'https://generativelanguage.googleapis.com',
      apiKey: '', // Empty means use platform default GEMINI_API_KEY from server env!
      disableReasoning: true,
      structuredOutputs: true,
      extraBodyJson: '',
    },
    {
      id: '9router-local',
      name: '9Router (Local OpenAI-compatible)',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:20128/v1',
      apiKey: '',
      disableReasoning: true,
      structuredOutputs: true,
      extraBodyJson: '',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: '',
      disableReasoning: true,
      structuredOutputs: true,
      extraBodyJson: '',
    },
    {
      id: 'custom-openai',
      name: 'Custom OpenAI-Compatible',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:1234/v1',
      apiKey: '',
      disableReasoning: true,
      structuredOutputs: true,
      extraBodyJson: '',
    },
  ],
  roleMapping: {
    fast: { providerId: 'google-gemini', model: 'gemini-2.5-flash-lite' },
    standard: { providerId: 'google-gemini', model: 'gemini-2.5-flash' },
    escalation: { providerId: 'google-gemini', model: 'gemini-2.5-pro' },
    vision: { providerId: '9router-local', model: 'qwen2.5vl:7b' },
    read: { providerId: '9router-local', model: 'qwen3:4b' },
    meta: { providerId: '9router-local', model: 'qwen3:4b' },
    cloud: { providerId: 'google-gemini', model: 'gemini-2.5-pro' },
    repair: { providerId: '9router-local', model: 'qwen3:4b' },
  },
  costTable: {
    'gemini-2.5-flash-lite': {
      inputCostPerMillion: 0.1,
      outputCostPerMillion: 0.4,
    },
    'gemini-2.5-flash': { inputCostPerMillion: 0.3, outputCostPerMillion: 2.5 },
    'gemini-2.5-pro': { inputCostPerMillion: 1.25, outputCostPerMillion: 10.0 },
    'gemini-3.8-flash': {
      inputCostPerMillion: 0.15,
      outputCostPerMillion: 0.6,
    },
    'gemini-3.1-flash-lite': {
      inputCostPerMillion: 0.1,
      outputCostPerMillion: 0.4,
    },
    'gemini-4-argon': { inputCostPerMillion: 1.25, outputCostPerMillion: 10.0 },
  },
  thrift: {
    latexNormalization: false,
    maxImagesPerVisionCall: 16,
    imageMaxLongEdge: 1024,
    jpegQuality: 80,
    cacheEnabled: true,
  },
  budget: {
    maxUsdPerRun: 0.25, // display-only estimate threshold; never a parse gate
    maxOutputTokens: 16384,
  },
  // E3: executor budgets — model calls 30 (5–60 configurable), tool executions 200 (reads weigh 0.25).
  agentLimits: {
    maxModelCalls: 30,
    maxToolExecutions: 200,
  },
  // Legacy optional tools are uncalled by the six-phase local loop.
  cleanupEnabled: false,
  consensusEnabled: false,
  criticEnabled: false,
  textRepairEnabled: false,
  // #43 decision audit mode: shadow (compute + journal + report, never route) by default; never auto-promote.
  decideMode: 'shadow',
  document: {
    defaultLanguage: 'auto',
    paperSize: 'A4',
    fontSize: 'medium',
  },
  themeMode: 'system',
};

export interface StorageBackendInfo {
  mode: 'folder' | 'unavailable';
  dir?: string;
  configured?: boolean;
  error?: string;
}
export async function getStorageBackend(): Promise<StorageBackendInfo> {
  try {
    const res = await fetch('/api/storage/health');
    if (!res.ok) throw new Error(`Storage HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    return { mode: 'unavailable', error: String(error) };
  }
}
function fireAndForgetFolder(path: string, init: RequestInit): void {
  void fetch(path, init)
    .then((res) => {
      if (!res.ok) throw new Error(`Storage HTTP ${res.status}`);
    })
    .catch((error) => {
      console.error('Folder write failed', error);
      if (typeof window !== 'undefined')
        window.dispatchEvent(
          new CustomEvent('storage-error', { detail: String(error) }),
        );
    });
}
function safeCacheSegment(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'cache';
}
function cacheBucket(key: string): string {
  return key.startsWith('journal:') ||
    key.startsWith('journalkey:') ||
    key.startsWith('agent:')
    ? 'journals'
    : 'cache';
}
function storageFailure(message: string): Error {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent('storage-error', { detail: message }));
  return new Error(message);
}
async function checkedFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`Folder storage ${url}: HTTP ${res.status}`);
    return res;
  } catch (error) {
    throw storageFailure(String(error));
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64 = ''] = dataUrl.split(',');
  const mime = head.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Persist page-render dataURLs as thumb_{fileHash}_{page} blobs; returns the keys. */
export async function savePageThumbBlobs(
  fileHash: string,
  pageImages: (string | undefined)[],
): Promise<string[]> {
  const keysOut: string[] = [];
  for (let i = 0; i < pageImages.length; i++) {
    const dataUrl = pageImages[i];
    const key = `thumb_${fileHash}_${i + 1}`;
    if (dataUrl && dataUrl.startsWith('data:')) {
      await saveImageBlob(key, dataUrlToBlob(dataUrl));
    } else if (dataUrl?.startsWith('blob:')) {
      const res = await fetch(dataUrl);
      if (!res.ok) throw storageFailure('Could not persist the in-memory page render.');
      await saveImageBlob(key, await res.blob());
    }
    keysOut.push(key);
  }
  return keysOut;
}

/** Resolve thumb keys to dataURLs (only for the given 1-based pages, when provided). */
export async function loadPageThumbDataUrls(
  pageThumbKeys: string[] | undefined,
  pages?: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pageThumbKeys || pageThumbKeys.length === 0) return out;
  const wanted = pages && pages.length > 0 ? new Set(pages) : null;
  for (let i = 0; i < pageThumbKeys.length; i++) {
    const page = i + 1;
    if (wanted && !wanted.has(page)) continue;
    const blob = await getImageBlob(pageThumbKeys[i]);
    if (blob) {
      try {
        out.set(page, await blobToDataUrl(blob));
      } catch {
        // ignore unreadable thumbs
      }
    }
  }
  return out;
}

let usageMemory: UsageRecord[] = [];
/** Folder is authoritative; usage is only mirrored in memory for synchronous UI reads. */
export async function hydrateServerStorage(): Promise<boolean> {
  const info = await getStorageBackend();
  if (info.mode !== 'folder' || !info.configured) return false;
  usageMemory = await (await checkedFetch('/api/usage')).json();
  const { hydrateCalibrationMap } = await import('../utils/budget');
  await hydrateCalibrationMap();
  return true;
}

const SETTINGS_STORAGE_KEY = 'examparse_settings_v1';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      roleMapping: {
        ...DEFAULT_SETTINGS.roleMapping,
        ...(parsed.roleMapping || {}),
      },
      costTable: { ...DEFAULT_SETTINGS.costTable, ...(parsed.costTable || {}) },
      thrift: { ...DEFAULT_SETTINGS.thrift, ...(parsed.thrift || {}) },
      budget: { ...DEFAULT_SETTINGS.budget, ...(parsed.budget || {}) },
      document: { ...DEFAULT_SETTINGS.document, ...(parsed.document || {}) },
      agentLimits: { ...DEFAULT_SETTINGS.agentLimits, ...(parsed.agentLimits || {}) },
      cleanupEnabled: typeof parsed.cleanupEnabled === 'boolean' ? parsed.cleanupEnabled : false,
      consensusEnabled: typeof parsed.consensusEnabled === 'boolean' ? parsed.consensusEnabled : false,
      criticEnabled: typeof parsed.criticEnabled === 'boolean' ? parsed.criticEnabled : false,
      textRepairEnabled: typeof parsed.textRepairEnabled === 'boolean' ? parsed.textRepairEnabled : false,
    };
    return validateAppSettings(merged);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('Failed to save settings to localStorage:', err);
  }
}

export function loadUsageLog(): UsageRecord[] {
  return [...usageMemory];
}

export function appendUsageRecord(
  record: UsageRecord,
  dedupeKey?: string,
): void {
  const effectiveKey = dedupeKey || record.dedupeKey;
  const storedRecord: UsageRecord = effectiveKey
    ? { ...record, dedupeKey: effectiveKey }
    : record;
  try {
    const records = loadUsageLog();
    if (effectiveKey) {
      // Idempotent cache accounting: at most ONE record per dedupe key;
      // re-running replaces its timestamp instead of appending.
      const idx = records.findIndex((r) => r.dedupeKey === effectiveKey);
      if (idx >= 0) records[idx] = storedRecord;
      else records.push(storedRecord);
    } else {
      records.push(storedRecord);
    }
    // Keep last 500 records (same cap as folder-mode server storage).
    const trimmed = records.slice(-500);
    usageMemory = trimmed;
  } catch (err) {
    console.warn('Failed to append usage record:', err);
  }
  fireAndForgetFolder('/api/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(storedRecord),
  });
}

export function clearUsageLog(): void {
  usageMemory = [];
  fireAndForgetFolder('/api/usage', { method: 'DELETE' });
}

/**
 * Folder persistence for Exam Documents & Image Blobs
 */
export interface SaveExamResult {
  status: 'ok' | 'PARTIAL-STORAGE';
  failedImageIds: string[];
  banner?: string;
}

async function putImageBlobQuietly(key: string, blob: Blob): Promise<void> {
  if (!SAFE_STORAGE_KEY.test(key))
    throw new Error('Invalid image storage key.');
  if (
    !(blob instanceof Blob) ||
    blob.size <= 0 ||
    blob.size > MAX_STORED_IMAGE_BYTES
  )
    throw new Error('Image blob is empty or exceeds the 32 MiB storage limit.');
  const mime = blob.type || 'image/jpeg';
  if (!ALLOWED_IMAGE_MIMES.has(mime))
    throw new Error('Unsupported image MIME type.');
  const res = await fetch(
    `/api/images/${encodeURIComponent(key)}?mime=${encodeURIComponent(mime)}`,
    { method: 'PUT', body: blob },
  );
  if (!res.ok)
    throw new Error(`Failed to save image ${key} to folder storage (HTTP ${res.status})`);
}

export async function saveExamDoc(
  doc: ExamDoc,
  expectedContentHash?: string,
  options?: { requireImages?: boolean },
): Promise<SaveExamResult> {
  const { reconcileFinalFlags, repairImageReferences } = await import('../pipeline/reviewIntegrity');
  Object.assign(doc, reconcileFinalFlags(repairImageReferences(doc)));
  // C1/C2 — invariant gate at the single save funnel. Persistence is NOT endorsement:
  // error-severity violations DEMOTE the doc to visibly PARTIAL (persisted marker + banner
  // naming violating codes/question numbers) and the save proceeds normally. The gate
  // never destroys the user's work; only true storage failures throw below.
  // C2/A2 — SOURCE_ONLY drafts (import-time, zero parsed questions) are not exams:
  // invariants describe parsed exams, so drafts skip the gate and only get image-id hygiene.
  const isSourceOnlyDraft = (doc.flags || []).some((flag) => flag.code === 'SOURCE_ONLY');
  // #46 checkers are comments, not save gates. The loop already owns its closed verdict list.
  const isLocalLoop = Boolean(doc.loop) || doc.source?.kind === 'package';
  try {
    if (isLocalLoop) {
      // Storage hygiene only; never run legacy semantic invariants or demote a loop document.
    } else if (isSourceOnlyDraft) {
      const { validateAndFixDuplicateImageIds } = await import('../pipeline/assemble');
      if (Array.isArray(doc.source?.lines)) {
        const fixed = validateAndFixDuplicateImageIds(doc);
        if (fixed.fixed && fixed.doc !== doc) {
          doc.images = fixed.doc.images;
          doc.questions = fixed.doc.questions;
          doc.flags = fixed.doc.flags;
        }
      }
    } else {
      const { validateExamInvariants, markPartialForInvariantViolations } = await import('../pipeline/quality');
      const gate = validateExamInvariants(doc);
      // No-op for clean docs; demotes (never throws) when error violations remain.
      markPartialForInvariantViolations(doc, gate.violations);
    }
  } catch (e: any) {
    // If validate not available or other error, don't block save (fail open for unrelated errors)
    console.warn('Invariant gate check failed to run:', e?.message);
  }

  // Part A — An exam save is NOT reported successful unless its image blobs are durably written.
  // Await all pending image blob writes and verify non-draft blob durability; partial failure
  // marks the save PARTIAL-STORAGE with the failed IDs named in the storage banner while keeping
  // dataUrl-free references intact in the saved ExamDoc.
  const failedImageIds: string[] = [];
  for (const img of doc.images || []) {
    const key = img.blobKey || img.sha || img.id;
    const attachedBlob = (img as any)._blob instanceof Blob ? ((img as any)._blob as Blob) : undefined;
    const inlineDataUrl = img.dataUrl?.startsWith('data:') ? img.dataUrl : undefined;
    const inlineObjectUrl = img.dataUrl?.startsWith('blob:') ? img.dataUrl : undefined;

    if (attachedBlob || inlineDataUrl || inlineObjectUrl) {
      try {
        const blob = attachedBlob
          ? attachedBlob
          : inlineDataUrl
            ? dataUrlToBlob(inlineDataUrl)
            : await (await fetch(inlineObjectUrl!)).blob();
        await putImageBlobQuietly(key, blob);
        img.blobKey = key;
        delete img.storageMissing;
      } catch (err) {
        console.warn(`PARTIAL-STORAGE: image blob write failed for ${img.id} (${key}):`, err);
        failedImageIds.push(img.id);
        img.blobKey = key;
        img.storageMissing = true;
        img.dataUrl = undefined;
      }
    } else if (!isSourceOnlyDraft) {
      const existingBlob = key ? await getReviewImageBlob(key).catch(() => undefined) : undefined;
      if (!existingBlob) {
        failedImageIds.push(img.id);
        img.storageMissing = true;
        img.dataUrl = undefined;
      } else {
        delete img.storageMissing;
      }
    }
  }

  const uniqueFailedIds = [...new Set(failedImageIds)];
  // Batch packages are committed only after every referenced image is durable.
  if (options?.requireImages && uniqueFailedIds.length) throw new Error(`Failed to store package images: ${uniqueFailedIds.join(', ')}`);
  let banner: string | undefined;
  if (uniqueFailedIds.length > 0) {
    doc.storageState = 'PARTIAL-STORAGE';
    doc.failedImageIds = uniqueFailedIds;
    banner = `PARTIAL-STORAGE: failed to store image blob(s) [${uniqueFailedIds.join(', ')}] in the local data folder. Exam metadata was saved; restore missing images from source in Step 4.`;
    doc.flags = [
      ...(doc.flags || []).filter(
        f =>
          f.code !== 'PARTIAL_STORAGE' &&
          !(
            f.code === 'IMAGE_ASSET_ABSENT' &&
            uniqueFailedIds.some(id => f.id === `flag_IMAGE_ASSET_ABSENT_${id}` || f.message.includes(id))
          ),
      ),
      {
        id: `flag_PARTIAL_STORAGE_${doc.id}`,
        code: 'PARTIAL_STORAGE',
        severity: 'warn',
        rootCauseId: 'storage_failure',
        message: banner,
      },
    ];
    Object.assign(doc, reconcileFinalFlags(doc));
  } else if (doc.storageState === 'PARTIAL-STORAGE' || doc.failedImageIds?.length || (doc.flags || []).some(f => f.code === 'PARTIAL_STORAGE')) {
    delete doc.storageState;
    delete doc.failedImageIds;
    doc.flags = (doc.flags || []).filter(f => f.code !== 'PARTIAL_STORAGE' && f.code !== 'IMAGE_ASSET_ABSENT');
    Object.assign(doc, reconcileFinalFlags(doc));
  }

  // Save doc without dataUrls to keep it compact while preserving dataUrl-free ImageAsset references
  const cleanImages: ImageAsset[] = (doc.images || []).map((img) => {
    const { dataUrl, _blob, ...rest } = img as any;
    return rest as ImageAsset;
  });

  // Stop persisting embedded page renders: convert pageImages dataURLs to
  // thumb_{fileHash}_{page} blobs and strip pageImages from the saved doc.
  let pageThumbKeys: string[] =
    doc.source?.pageThumbKeys && doc.source.pageThumbKeys.length > 0
      ? [...doc.source.pageThumbKeys]
      : [];
  if (doc.source?.pageImages?.some(url => url.startsWith('data:') || url.startsWith('blob:'))) {
    const converted = await savePageThumbBlobs(
      doc.fileHash,
      doc.source.pageImages,
    );
    if (converted.length > 0) pageThumbKeys = converted;
  }
  const { pageImages: _strippedPageImages, ...sourceRest } = (doc.source ||
    {}) as any;

  const docToSave = {
    ...doc,
    images: cleanImages,
    source: {
      ...sourceRest,
      pageThumbKeys,
    },
  };
  if (!SAFE_STORAGE_KEY.test(docToSave.id))
    throw new Error('Invalid exam storage id.');
  if (
    docToSave.images.some(
      (image) =>
        !SAFE_STORAGE_KEY.test(image.id) ||
        (Boolean(image.blobKey) && !SAFE_STORAGE_KEY.test(image.blobKey)),
    )
  )
    throw new Error('Invalid image storage key in ExamDoc.');
  if (pageThumbKeys.some((key) => !SAFE_STORAGE_KEY.test(key)))
    throw new Error('Invalid page-thumbnail storage key.');
  if (!validateJsonSize(docToSave, MAX_STORED_EXAM_BYTES))
    throw new Error('ExamDoc exceeds the 32 MiB storage limit.');

  const res = await checkedFetch(`/api/exams/${encodeURIComponent(doc.id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(expectedContentHash ? { 'If-Match': expectedContentHash } : {}),
    },
    body: JSON.stringify(docToSave),
  });
  if (!res.ok)
    throw new Error(
      `Failed to save exam to folder storage (HTTP ${res.status})`,
    );
  if (banner && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('storage-error', { detail: banner }));
  }
  // B2: dossier maintenance is deterministic, rebuilt incrementally on save
  try { await rebuildDossier(doc); } catch {}
  return {
    status: uniqueFailedIds.length > 0 ? 'PARTIAL-STORAGE' : 'ok',
    failedImageIds: uniqueFailedIds,
    ...(banner ? { banner } : {}),
  };
}

export async function loadExamDoc(id: string): Promise<ExamDoc | undefined> {
  if (!SAFE_STORAGE_KEY.test(id)) return undefined;

  const res = await fetch(`/api/exams/${encodeURIComponent(id)}`);
  if (res.status === 404) return undefined;
  if (!res.ok)
    throw new Error(
      `Failed to load exam from folder storage (HTTP ${res.status})`,
    );
  const doc = (await res.json()) as ExamDoc;
  if (!doc) return undefined;
  // Verify each image blob exists in folder storage; missing blobs retain dataUrl-free references.
  const images: ImageAsset[] = await Promise.all(
    (doc.images || []).map(async (img) => {
      const key = img.blobKey || (img as any).sha;
      if (!key) return { ...img, storageMissing: true, dataUrl: undefined };
      const blob = await getReviewImageBlob(key).catch(() => undefined);
      if (!blob) {
        return { ...img, storageMissing: true, dataUrl: undefined };
      }
      const { storageMissing: _cleared, ...rest } = img;
      return {
        ...rest,
        dataUrl: `/api/images/${encodeURIComponent(key)}`,
      };
    }),
  );
  const pageImages = (doc.source?.pageThumbKeys || []).map(
    (k) => `/api/images/${k}`,
  );
  return {
    ...doc,
    images,
    source: {
      ...doc.source,
      pageImages: pageImages.length > 0 ? pageImages : doc.source?.pageImages,
    },
  };
}

export async function saveSourceFile(fileHash: string, file: File | Blob, fileName?: string): Promise<void> {
  if (!SAFE_STORAGE_KEY.test(fileHash)) return;
  try {
    const mime = file.type || 'application/octet-stream';
    const name = fileName || (file instanceof File ? file.name : 'source.bin');
    await fetch(
      `/api/sources/${encodeURIComponent(fileHash)}?mime=${encodeURIComponent(mime)}&name=${encodeURIComponent(name)}`,
      { method: 'PUT', body: file },
    );
  } catch {
    // Best-effort source retention; in-memory rawFile remains primary during active session.
  }
}

export async function getSourceFile(fileHash: string, fallbackName = 'source.pdf'): Promise<File | undefined> {
  if (!SAFE_STORAGE_KEY.test(fileHash)) return undefined;
  try {
    const res = await fetch(`/api/sources/${encodeURIComponent(fileHash)}`);
    if (!res.ok) return undefined;
    const rawHeader = res.headers.get('X-Source-Filename');
    const name = rawHeader ? decodeURIComponent(rawHeader) : fallbackName;
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
  } catch {
    return undefined;
  }
}

export async function saveImageBlob(key: string, blob: Blob): Promise<void> {
  if (!SAFE_STORAGE_KEY.test(key))
    throw new Error('Invalid image storage key.');
  if (
    !(blob instanceof Blob) ||
    blob.size <= 0 ||
    blob.size > MAX_STORED_IMAGE_BYTES
  )
    throw new Error('Image blob is empty or exceeds the 32 MiB storage limit.');
  const mime = blob.type || 'image/jpeg';
  if (!ALLOWED_IMAGE_MIMES.has(mime))
    throw new Error('Unsupported image MIME type.');

  const res = await checkedFetch(
    `/api/images/${encodeURIComponent(key)}?mime=${encodeURIComponent(mime)}`,
    {
      method: 'PUT',
      body: blob,
    },
  );
  if (!res.ok)
    throw new Error(
      `Failed to save image to folder storage (HTTP ${res.status})`,
    );
  return;
}

/** Review must distinguish absent bytes from a temporary storage failure. */
export async function getReviewImageBlob(key: string): Promise<Blob | undefined> {
  if (!SAFE_STORAGE_KEY.test(key)) return undefined;
  const response = await fetch(`/api/images/${encodeURIComponent(key)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Image storage HTTP ${response.status}`);
  return response.blob();
}

export async function getImageBlob(key: string): Promise<Blob | undefined> {
  if (!SAFE_STORAGE_KEY.test(key)) return undefined;

  try {
    const res = await fetch(`/api/images/${encodeURIComponent(key)}`);
    if (!res.ok) return undefined;
    return await res.blob();
  } catch {
    return undefined;
  }
}

/**
 * Exam Library: lightweight summary of a stored exam (no blob restoration).
 */
export interface ExamSummary {
  id: string;
  sourceKind?: string;
  packageBatchImport?: boolean;
  displayName: string;
  subject?: string;
  grade?: string;
  term?: string;
  year?: string;
  createdAt: string;
  fileName: string;
  pages: number;
  questionCount: number;
  expectedQuestionCount: number;
  parsedQuestionCount: number;
  coveragePercent: number;
  missingQuestionNos: number[];
  duplicateQuestionNos: number[];
  complete: boolean;
  sectionCount: number;
  imageCount: number;
  ocrUsed: boolean;
  qualityScore?: number;
  totalCostUsd: number;
  totalTokens: number;
  fileHash?: string;
  pointsParsed?: number;
  pointsExpected?: number;
  healthState?: 'green' | 'amber' | 'red' | 'PARTIAL';
  /** Follow-up #36 C2 — the one attention count (computeAttention) for the Library health chip. */
  attentionCount?: number;
  modelUsed?: string;
}

/** Enumerate stored exams WITHOUT restoring image blobs, newest first. */
export async function listExamSummaries(): Promise<ExamSummary[]> {
  const res = await fetch('/api/exams');
  if (!res.ok)
    throw new Error(
      `Failed to list exams from folder storage (HTTP ${res.status})`,
    );
  return (await res.json()) as ExamSummary[];
}

/**
 * Delete one exam. Frees only image blobs (img:{blobKey}) that no remaining
 * exam references. Never touches the global usage log or other exams.
 * In folder mode the server performs the same orphan sweep.
 */
export async function deleteExam(id: string): Promise<void> {
  if (!SAFE_STORAGE_KEY.test(id)) throw new Error('Invalid exam storage id.');

  await checkedFetch(`/api/exams/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return;
}

/** Delete only pipeline cache entries (cache:*); exams, blobs, and usage log are untouched. */
export async function clearPipelineCaches(): Promise<void> {
  await checkedFetch('/api/cache', { method: 'DELETE' });
  return;
}

/**
 * Cache storage
 */
export async function getPipelineCache<T>(
  cacheKey: string,
): Promise<T | undefined> {
  if (!cacheKey || cacheKey.length > 2048) return undefined;

  try {
    const res = await fetch(
      `/api/${cacheBucket(cacheKey)}/${safeCacheSegment(cacheKey)}`,
    );
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

export async function setPipelineCache<T>(
  cacheKey: string,
  value: T,
): Promise<void> {
  if (!cacheKey || cacheKey.length > 2048)
    throw new Error('Invalid cache key.');
  if (!validateJsonSize(value ?? null, MAX_STORED_CACHE_BYTES))
    throw new Error('Pipeline cache entry exceeds the 20 MiB storage limit.');

  await checkedFetch(
    `/api/${cacheBucket(cacheKey)}/${safeCacheSegment(cacheKey)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value ?? null),
    },
  );
  return;
}


// ===== B: Dossier & Memory =====
export async function getDossier(examId: string): Promise<any | undefined> {
  if (!examId) return undefined;
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(examId)}`);
    if (!res.ok) return undefined;
    return await res.json();
  } catch { return undefined; }
}
export async function saveDossier(dossier: any): Promise<void> {
  if (!dossier?.identity?.id) return;
  await checkedFetch(`/api/memory/${encodeURIComponent(dossier.identity.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dossier),
  });
}
export async function deleteDossier(examId: string): Promise<void> {
  try { await checkedFetch(`/api/memory/${encodeURIComponent(examId)}`, { method: 'DELETE' }); } catch {}
}
export async function rebuildDossier(doc: any): Promise<any> {
  const { buildDossier } = await import('../pipeline/dossier');
  let existing: any;
  try { existing = await getDossier(doc.id); } catch {}
  const dossier = buildDossier(doc, existing);
  // Enforce ≤4KB: if over, trim ledger/notes
  let bytes = new TextEncoder().encode(JSON.stringify(dossier)).length;
  while (bytes > 4096 && dossier.ledger.length) { dossier.ledger.shift(); bytes = new TextEncoder().encode(JSON.stringify(dossier)).length; }
  while (bytes > 4096 && dossier.userNotes.length) { dossier.userNotes.shift(); bytes = new TextEncoder().encode(JSON.stringify(dossier)).length; }
  await saveDossier(dossier);
  return dossier;
}
export async function getUserMemory(): Promise<any> {
  try { const res = await fetch('/api/user-memory'); if (!res.ok) return { preferences:{}, facts:[] }; return await res.json(); } catch { return { preferences:{}, facts:[] }; }
}
export async function saveUserMemory(mem: any): Promise<void> {
  await checkedFetch('/api/user-memory', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(mem)});
}
export async function appendLedgerEntry(examId: string, entry: any): Promise<void> {
  let dossier = await getDossier(examId);
  if (!dossier) return;
  const { addLedgerEntry } = await import('../pipeline/dossier');
  dossier = addLedgerEntry(dossier, entry);
  await saveDossier(dossier);
}

export async function clearAllCachesAndData(): Promise<void> {
  const summaries = await listExamSummaries();
  for (const exam of summaries) await deleteExam(exam.id);
  await clearPipelineCaches();
  await checkedFetch('/api/storage/buckets/journals', { method: 'DELETE' });
  await checkedFetch('/api/usage', { method: 'DELETE' });
  usageMemory = [];
}
