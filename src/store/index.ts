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
    vision: { providerId: 'google-gemini', model: 'gemini-2.5-flash' },
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
    maxUsdPerRun: 0.25, // default hard cap
    maxOutputTokens: 16384,
  },
  document: {
    defaultLanguage: 'auto',
    paperSize: 'A4',
    fontSize: 'medium',
  },
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
export async function saveExamDoc(
  doc: ExamDoc,
  expectedContentHash?: string,
): Promise<void> {
  // Save doc without dataUrls to keep it compact
  const cleanImages: ImageAsset[] = (doc.images || []).map((img) => {
    const { dataUrl, ...rest } = img;
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
  return;
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
  // In folder mode image dataUrl is the server URL string (no blob fetch).
  const images: ImageAsset[] = (doc.images || []).map((img) => ({
    ...img,
    dataUrl:
      img.blobKey || (img as any).sha
        ? `/api/images/${img.blobKey || (img as any).sha}`
        : undefined,
  }));
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
  totalCostUsd: number;
  totalTokens: number;
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

export async function clearAllCachesAndData(): Promise<void> {
  const summaries = await listExamSummaries();
  for (const exam of summaries) await deleteExam(exam.id);
  await clearPipelineCaches();
  await checkedFetch('/api/storage/buckets/journals', { method: 'DELETE' });
  await checkedFetch('/api/usage', { method: 'DELETE' });
  usageMemory = [];
}
