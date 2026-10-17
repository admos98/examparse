/**
 * IndexedDB and LocalStorage State Management
 */
import { get, set, del, keys } from 'idb-keyval';
import { AppSettings, ExamDoc, ImageAsset, UsageRecord, getDisplayName } from '../types';

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [
    {
      id: 'google-gemini',
      name: 'Google Gemini (Native)',
      kind: 'gemini',
      baseURL: 'https://generativelanguage.googleapis.com',
      apiKey: '', // Empty means use platform default GEMINI_API_KEY from server env!
      disableReasoning: true,
      extraBodyJson: '',
    },
    {
      id: '9router-local',
      name: '9Router (Local OpenAI-compatible)',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:20128/v1',
      apiKey: '',
      disableReasoning: true,
      extraBodyJson: '',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: '',
      disableReasoning: true,
      extraBodyJson: '',
    },
    {
      id: 'custom-openai',
      name: 'Custom OpenAI-Compatible',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:1234/v1',
      apiKey: '',
      disableReasoning: true,
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
    'gemini-2.5-flash-lite': { inputCostPerMillion: 0.10, outputCostPerMillion: 0.40 },
    'gemini-2.5-flash': { inputCostPerMillion: 0.30, outputCostPerMillion: 2.50 },
    'gemini-2.5-pro': { inputCostPerMillion: 1.25, outputCostPerMillion: 10.00 },
    'gemini-3.8-flash': { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 },
    'gemini-3.1-flash-lite': { inputCostPerMillion: 0.10, outputCostPerMillion: 0.40 },
    'gemini-4-argon': { inputCostPerMillion: 1.25, outputCostPerMillion: 10.00 },
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
    maxOutputTokens: 8192,
  },
  document: {
    defaultLanguage: 'auto',
    paperSize: 'A4',
    fontSize: 'medium',
  },
};


/* ------------------------------------------------------------------ */
/* Storage backend: folder (server /api/storage) or IndexedDB (A)      */
/* ------------------------------------------------------------------ */
export interface StorageBackendInfo {
  mode: 'folder' | 'browser';
  dir?: string;
}

let backendInfo: StorageBackendInfo = { mode: 'browser' };

async function probeStorageBackend(): Promise<StorageBackendInfo> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch('/api/storage/health', { signal: ctrl.signal });
      if (res.ok) {
        const j: any = await res.json().catch(() => null);
        if (j && j.mode === 'folder') {
          backendInfo = { mode: 'folder', dir: j.dir };
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Hosted preview / offline: keep the IndexedDB backend.
  }
  return backendInfo;
}

const backendReady: Promise<StorageBackendInfo> =
  typeof fetch !== 'undefined' ? probeStorageBackend() : Promise.resolve(backendInfo);

/** Resolve once the storage-backend probe has finished. */
export function getStorageBackend(): Promise<StorageBackendInfo> {
  return backendReady;
}

async function isFolderMode(): Promise<boolean> {
  return (await backendReady).mode === 'folder';
}

function fireAndForgetFolder(path: string, init: RequestInit): void {
  void backendReady
    .then(info => {
      if (info.mode !== 'folder') return;
      return fetch(path, init).catch(() => undefined);
    })
    .catch(() => undefined);
}

/** Server-safe cache file segment (cache keys may contain ':' etc.). */
function safeCacheSegment(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'cache';
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
  pageImages: (string | undefined)[]
): Promise<string[]> {
  const keysOut: string[] = [];
  for (let i = 0; i < pageImages.length; i++) {
    const dataUrl = pageImages[i];
    const key = `thumb_${fileHash}_${i + 1}`;
    if (dataUrl && dataUrl.startsWith('data:')) {
      try {
        await saveImageBlob(key, dataUrlToBlob(dataUrl));
      } catch (err) {
        console.warn(`Failed to persist page thumb ${key}:`, err);
      }
    }
    keysOut.push(key);
  }
  return keysOut;
}

/** Resolve thumb keys to dataURLs (only for the given 1-based pages, when provided). */
export async function loadPageThumbDataUrls(
  pageThumbKeys: string[] | undefined,
  pages?: number[]
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

/** On app mount in folder mode the server is the source of truth for settings/usage/calibration. */
export async function hydrateServerStorage(): Promise<boolean> {
  const info = await backendReady;
  if (info.mode !== 'folder') return false;
  try {
    const settingsRes = await fetch('/api/settings');
    if (settingsRes.ok) {
      const serverSettings = await settingsRes.json().catch(() => null);
      if (serverSettings) {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(serverSettings));
      }
    }
    const usageRes = await fetch('/api/usage');
    if (usageRes.ok) {
      const serverUsage = await usageRes.json().catch(() => null);
      if (Array.isArray(serverUsage)) {
        localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(serverUsage));
      }
    }
    const calRes = await fetch('/api/cache/calibration');
    if (calRes.ok) {
      const calibration = await calRes.json().catch(() => null);
      if (calibration && typeof calibration === 'object') {
        localStorage.setItem('examparse_calibration_v1', JSON.stringify(calibration));
      }
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------- Migration (A) ------------------------- */
export interface MigrationResult {
  examsCopied: number;
  imagesCopied: number;
  cachesCopied: number;
  folderExamCount: number;
  verified: boolean;
}

/** Count exams still held in IndexedDB (browser storage), regardless of active backend. */
export async function countBrowserExams(): Promise<number> {
  const allKeys = await keys();
  return allKeys.filter(k => typeof k === 'string' && k.startsWith('exam:')).length;
}

/**
 * Copy exams, image/thumb blobs, pipeline caches, settings and usage from
 * IndexedDB/localStorage to the folder backend. Verifies counts and NEVER
 * deletes the browser copy.
 */
export async function migrateBrowserToFolder(): Promise<MigrationResult> {
  const info = await backendReady;
  if (info.mode !== 'folder') throw new Error('Folder storage is not active');
  const allKeys = await keys();
  const examKeys = allKeys.filter((k): k is string => typeof k === 'string' && k.startsWith('exam:'));
  const imgKeys = allKeys.filter((k): k is string => typeof k === 'string' && k.startsWith('img:'));
  const cacheKeys = allKeys.filter((k): k is string => typeof k === 'string' && k.startsWith('cache:'));

  let examsCopied = 0;
  for (const k of examKeys) {
    const doc = await get<ExamDoc>(k);
    if (doc) {
      await saveExamDoc(doc);
      examsCopied++;
    }
  }
  let imagesCopied = 0;
  for (const k of imgKeys) {
    const blob = await get<Blob>(k);
    if (blob) {
      await saveImageBlob(k.slice('img:'.length), blob);
      imagesCopied++;
    }
  }
  let cachesCopied = 0;
  for (const k of cacheKeys) {
    const value = await get(k);
    if (value !== undefined) {
      await setPipelineCache(k.slice('cache:'.length), value);
      cachesCopied++;
    }
  }
  // Settings + usage (server copies).
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loadSettings()),
    });
    await fetch('/api/usage', { method: 'DELETE' });
    const usage = loadUsageLog();
    if (usage.length > 0) {
      await fetch('/api/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(usage),
      });
    }
  } catch {
    // Settings/usage copy is best-effort; exam verification below is authoritative.
  }

  const folderSummaries = await listExamSummaries();
  return {
    examsCopied,
    imagesCopied,
    cachesCopied,
    folderExamCount: folderSummaries.length,
    verified: folderSummaries.length === examsCopied,
  };
}

const SETTINGS_STORAGE_KEY = 'examparse_settings_v1';
const USAGE_STORAGE_KEY = 'examparse_usage_log_v1';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      roleMapping: { ...DEFAULT_SETTINGS.roleMapping, ...(parsed.roleMapping || {}) },
      costTable: { ...DEFAULT_SETTINGS.costTable, ...(parsed.costTable || {}) },
      thrift: { ...DEFAULT_SETTINGS.thrift, ...(parsed.thrift || {}) },
      budget: { ...DEFAULT_SETTINGS.budget, ...(parsed.budget || {}) },
      document: { ...DEFAULT_SETTINGS.document, ...(parsed.document || {}) },
    };
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
  // Write-through to the folder backend (server is source of truth when reachable).
  fireAndForgetFolder('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

export function loadUsageLog(): UsageRecord[] {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function appendUsageRecord(record: UsageRecord, dedupeKey?: string): void {
  const effectiveKey = dedupeKey || record.dedupeKey;
  const storedRecord: UsageRecord = effectiveKey ? { ...record, dedupeKey: effectiveKey } : record;
  try {
    const records = loadUsageLog();
    if (effectiveKey) {
      // Idempotent cache accounting: at most ONE record per dedupe key;
      // re-running replaces its timestamp instead of appending.
      const idx = records.findIndex(r => r.dedupeKey === effectiveKey);
      if (idx >= 0) records[idx] = storedRecord;
      else records.push(storedRecord);
    } else {
      records.push(storedRecord);
    }
    // Keep last 200 records
    const trimmed = records.slice(-200);
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(trimmed));
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
  localStorage.removeItem(USAGE_STORAGE_KEY);
  fireAndForgetFolder('/api/usage', { method: 'DELETE' });
}

/**
 * IndexedDB Persistence for Exam Documents & Image Blobs
 */
export async function saveExamDoc(doc: ExamDoc): Promise<void> {
  // Save doc without dataUrls to keep it compact
  const cleanImages: ImageAsset[] = (doc.images || []).map(img => {
    const { dataUrl, ...rest } = img;
    return rest as ImageAsset;
  });

  // Stop persisting embedded page renders: convert pageImages dataURLs to
  // thumb_{fileHash}_{page} blobs and strip pageImages from the saved doc.
  let pageThumbKeys: string[] =
    doc.source?.pageThumbKeys && doc.source.pageThumbKeys.length > 0 ? [...doc.source.pageThumbKeys] : [];
  if (doc.source?.pageImages && doc.source.pageImages.length > 0) {
    const converted = await savePageThumbBlobs(doc.fileHash, doc.source.pageImages);
    if (converted.length > 0) pageThumbKeys = converted;
  }
  const { pageImages: _strippedPageImages, ...sourceRest } = (doc.source || {}) as any;

  const docToSave = {
    ...doc,
    images: cleanImages,
    source: {
      ...sourceRest,
      pageThumbKeys,
    },
  };

  if (await isFolderMode()) {
    const res = await fetch(`/api/exams/${encodeURIComponent(doc.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(docToSave),
    });
    if (!res.ok) throw new Error(`Failed to save exam to folder storage (HTTP ${res.status})`);
    return;
  }
  await set(`exam:${doc.id}`, docToSave);
}

export async function loadExamDoc(id: string): Promise<ExamDoc | undefined> {
  if (await isFolderMode()) {
    const res = await fetch(`/api/exams/${encodeURIComponent(id)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Failed to load exam from folder storage (HTTP ${res.status})`);
    const doc = (await res.json()) as ExamDoc;
    if (!doc) return undefined;
    // In folder mode image dataUrl is the server URL string (no blob fetch).
    const images: ImageAsset[] = (doc.images || []).map(img => ({
      ...img,
      dataUrl: img.blobKey || (img as any).sha ? `/api/images/${img.blobKey || (img as any).sha}` : undefined,
    }));
    const pageImages = (doc.source?.pageThumbKeys || []).map(k => `/api/images/${k}`);
    return {
      ...doc,
      images,
      source: {
        ...doc.source,
        pageImages: pageImages.length > 0 ? pageImages : doc.source?.pageImages,
      },
    };
  }

  const doc = await get<ExamDoc>(`exam:${id}`);
  if (!doc) return undefined;

  // Restore image dataUrls from blobs
  const restoredImages: ImageAsset[] = await Promise.all(
    (doc.images || []).map(async img => {
      const blob = img.blobKey ? await getImageBlob(img.blobKey) : undefined;
      let dataUrl: string | undefined = undefined;
      if (blob) {
        dataUrl = URL.createObjectURL(blob);
      }
      return { ...img, dataUrl };
    })
  );

  // Restore page renders from thumb blobs when present (legacy docs keep pageImages).
  let pageImages = doc.source?.pageImages;
  if (!pageImages && doc.source?.pageThumbKeys && doc.source.pageThumbKeys.length > 0) {
    const resolved: string[] = [];
    for (const k of doc.source.pageThumbKeys) {
      const blob = await getImageBlob(k);
      resolved.push(blob ? URL.createObjectURL(blob) : '');
    }
    if (resolved.some(u => u)) pageImages = resolved;
  }

  return { ...doc, images: restoredImages, source: { ...doc.source, pageImages } };
}

export async function saveImageBlob(key: string, blob: Blob): Promise<void> {
  if (await isFolderMode()) {
    const mime = blob.type || 'application/octet-stream';
    const res = await fetch(`/api/images/${encodeURIComponent(key)}?mime=${encodeURIComponent(mime)}`, {
      method: 'PUT',
      body: blob,
    });
    if (!res.ok) throw new Error(`Failed to save image to folder storage (HTTP ${res.status})`);
    return;
  }
  await set(`img:${key}`, blob);
}

export async function getImageBlob(key: string): Promise<Blob | undefined> {
  if (await isFolderMode()) {
    try {
      const res = await fetch(`/api/images/${encodeURIComponent(key)}`);
      if (!res.ok) return undefined;
      return await res.blob();
    } catch {
      return undefined;
    }
  }
  return await get<Blob>(`img:${key}`);
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
  sectionCount: number;
  imageCount: number;
  ocrUsed: boolean;
  totalCostUsd: number;
  totalTokens: number;
}

/** Enumerate stored exams WITHOUT restoring image blobs, newest first. */
export async function listExamSummaries(): Promise<ExamSummary[]> {
  if (await isFolderMode()) {
    const res = await fetch('/api/exams');
    if (!res.ok) throw new Error(`Failed to list exams from folder storage (HTTP ${res.status})`);
    return (await res.json()) as ExamSummary[];
  }
  const allKeys = await keys();
  const examKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith('exam:')
  );
  const docs = await Promise.all(examKeys.map(k => get<ExamDoc>(k)));
  const summaries: ExamSummary[] = [];
  for (const doc of docs) {
    if (!doc || !doc.id) continue;
    const usage = Array.isArray(doc.usage) ? doc.usage : [];
    summaries.push({
      id: doc.id,
      displayName: getDisplayName(doc),
      subject: doc.meta?.subject,
      grade: doc.meta?.grade,
      term: doc.meta?.term,
      year: doc.meta?.year,
      createdAt: doc.createdAt,
      fileName: doc.source?.fileName || '',
      pages: doc.source?.pages || 0,
      questionCount: Array.isArray(doc.questions) ? doc.questions.length : 0,
      sectionCount: Array.isArray(doc.sections) ? doc.sections.length : 0,
      imageCount: Array.isArray(doc.images) ? doc.images.length : 0,
      ocrUsed: Boolean(doc.source?.ocrUsed),
      totalCostUsd: usage.reduce((acc, u) => acc + (u.costUsd || 0), 0),
      totalTokens: usage.reduce((acc, u) => acc + (u.inputTokens || 0) + (u.outputTokens || 0), 0),
    });
  }
  summaries.sort((a, b) => {
    const ta = Date.parse(b.createdAt) || 0;
    const tb = Date.parse(a.createdAt) || 0;
    return ta - tb;
  });
  return summaries;
}

/**
 * Delete one exam. Frees only image blobs (img:{blobKey}) that no remaining
 * exam references. Never touches the global usage log or other exams.
 * In folder mode the server performs the same orphan sweep.
 */
export async function deleteExam(id: string): Promise<void> {
  if (await isFolderMode()) {
    await fetch(`/api/exams/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return;
  }
  const doc = await get<ExamDoc>(`exam:${id}`);
  const ownBlobKeys = new Set<string>(
    (doc?.images || []).map(img => img.blobKey).filter((k): k is string => Boolean(k))
  );
  for (const k of doc?.source?.pageThumbKeys || []) ownBlobKeys.add(k);
  await del(`exam:${id}`);
  if (ownBlobKeys.size === 0) return;

  const allKeys = await keys();
  const remainingExamKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith('exam:')
  );
  const referenced = new Set<string>();
  for (const k of remainingExamKeys) {
    const other = await get<ExamDoc>(k);
    for (const img of other?.images || []) {
      if (img.blobKey) referenced.add(img.blobKey);
    }
    for (const tk of other?.source?.pageThumbKeys || []) referenced.add(tk);
  }
  for (const blobKey of ownBlobKeys) {
    if (!referenced.has(blobKey)) {
      await del(`img:${blobKey}`);
    }
  }
}

/** Delete only pipeline cache entries (cache:*); exams, blobs, and usage log are untouched. */
export async function clearPipelineCaches(): Promise<void> {
  if (await isFolderMode()) {
    await fetch('/api/cache', { method: 'DELETE' });
    return;
  }
  const allKeys = await keys();
  for (const k of allKeys) {
    if (typeof k === 'string' && k.startsWith('cache:')) {
      await del(k);
    }
  }
}

/**
 * Cache storage
 */
export async function getPipelineCache<T>(cacheKey: string): Promise<T | undefined> {
  if (await isFolderMode()) {
    try {
      const res = await fetch(`/api/cache/${safeCacheSegment(cacheKey)}`);
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch {
      return undefined;
    }
  }
  return await get<T>(`cache:${cacheKey}`);
}

export async function setPipelineCache<T>(cacheKey: string, value: T): Promise<void> {
  if (await isFolderMode()) {
    await fetch(`/api/cache/${safeCacheSegment(cacheKey)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value ?? null),
    });
    return;
  }
  await set(`cache:${cacheKey}`, value);
}

export async function clearAllCachesAndData(): Promise<void> {
  if (await isFolderMode()) {
    try {
      const summaries = await listExamSummaries();
      for (const s of summaries) {
        await deleteExam(s.id);
      }
      await clearPipelineCaches();
      await fetch('/api/usage', { method: 'DELETE' }).catch(() => undefined);
    } catch {
      // fall through to local cleanup
    }
    try { localStorage.removeItem(USAGE_STORAGE_KEY); } catch { /* ignore */ }
    return;
  }
  const allKeys = await keys();
  for (const k of allKeys) {
    if (typeof k === 'string' && (k.startsWith('cache:') || k.startsWith('exam:') || k.startsWith('img:'))) {
      await del(k);
    }
  }
  clearUsageLog();
}
