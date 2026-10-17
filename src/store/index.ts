/**
 * IndexedDB and LocalStorage State Management
 */
import { get, set, del, keys } from 'idb-keyval';
import { AppSettings, ExamDoc, ImageAsset, UsageRecord } from '../types';

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [
    {
      id: 'google-gemini',
      name: 'Google Gemini (Native)',
      kind: 'gemini',
      baseURL: 'https://generativelanguage.googleapis.com',
      apiKey: '', // Empty means use platform default GEMINI_API_KEY from server env!
    },
    {
      id: '9router-local',
      name: '9Router (Local OpenAI-compatible)',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:20128/v1',
      apiKey: '',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: '',
    },
    {
      id: 'custom-openai',
      name: 'Custom OpenAI-Compatible',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:1234/v1',
      apiKey: '',
    },
  ],
  roleMapping: {
    fast: { providerId: 'google-gemini', model: 'gemini-2.5-flash-lite' },
    standard: { providerId: 'google-gemini', model: 'gemini-2.5-flash' },
    escalation: { providerId: 'google-gemini', model: 'gemini-2.5-pro' },
    vision: { providerId: 'google-gemini', model: 'gemini-2.5-flash' },
  },
  costTable: {
    'gemini-2.5-flash-lite': { inputCostPerMillion: 0.075, outputCostPerMillion: 0.30 },
    'gemini-2.5-flash': { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 },
    'gemini-2.5-pro': { inputCostPerMillion: 1.25, outputCostPerMillion: 5.00 },
    'gemini-3.8-flash': { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 },
    'gemini-3.1-flash-lite': { inputCostPerMillion: 0.075, outputCostPerMillion: 0.30 },
    'gemini-4-argon': { inputCostPerMillion: 1.25, outputCostPerMillion: 5.00 },
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
}

export function loadUsageLog(): UsageRecord[] {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function appendUsageRecord(record: UsageRecord): void {
  try {
    const records = loadUsageLog();
    records.push(record);
    // Keep last 200 records
    const trimmed = records.slice(-200);
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('Failed to append usage record:', err);
  }
}

export function clearUsageLog(): void {
  localStorage.removeItem(USAGE_STORAGE_KEY);
}

/**
 * IndexedDB Persistence for Exam Documents & Image Blobs
 */
export async function saveExamDoc(doc: ExamDoc): Promise<void> {
  // Save doc without dataUrls to keep it compact
  const cleanImages: ImageAsset[] = doc.images.map(img => {
    const { dataUrl, ...rest } = img;
    return rest as ImageAsset;
  });

  const docToSave = {
    ...doc,
    images: cleanImages,
  };

  await set(`exam:${doc.id}`, docToSave);
}

export async function loadExamDoc(id: string): Promise<ExamDoc | undefined> {
  const doc = await get<ExamDoc>(`exam:${id}`);
  if (!doc) return undefined;

  // Restore image dataUrls from blobs
  const restoredImages: ImageAsset[] = await Promise.all(
    doc.images.map(async img => {
      const blob = await getImageBlob(img.blobKey);
      let dataUrl: string | undefined = undefined;
      if (blob) {
        dataUrl = URL.createObjectURL(blob);
      }
      return { ...img, dataUrl };
    })
  );

  return { ...doc, images: restoredImages };
}

export async function saveImageBlob(key: string, blob: Blob): Promise<void> {
  await set(`img:${key}`, blob);
}

export async function getImageBlob(key: string): Promise<Blob | undefined> {
  return await get<Blob>(`img:${key}`);
}

/**
 * Cache storage in IndexedDB
 */
export async function getPipelineCache<T>(cacheKey: string): Promise<T | undefined> {
  return await get<T>(`cache:${cacheKey}`);
}

export async function setPipelineCache<T>(cacheKey: string, value: T): Promise<void> {
  await set(`cache:${cacheKey}`, value);
}

export async function clearAllCachesAndData(): Promise<void> {
  const allKeys = await keys();
  for (const k of allKeys) {
    if (typeof k === 'string' && (k.startsWith('cache:') || k.startsWith('exam:') || k.startsWith('img:'))) {
      await del(k);
    }
  }
  clearUsageLog();
}
