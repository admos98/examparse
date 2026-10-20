import { z } from 'zod';
import type { AppSettings, ExamDoc } from '../types';

export const MAX_SOURCE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_EXAM_JSON_BYTES = 25 * 1024 * 1024;
export const MAX_SETTINGS_JSON_BYTES = 1024 * 1024;
export const SAFE_STORAGE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const spanSchema = z.tuple([z.number().int().positive().max(1_000_000), z.number().int().positive().max(1_000_000)]).refine(([start, end]) => end >= start);
const text = (max = 100_000) => z.string().max(max);

const lineSchema = z.object({ id: z.string().regex(/^L\d{1,9}$/), page: z.number().int().min(1).max(10_000), text: text(100_000), y: z.number().finite().optional() }).passthrough();
const optionSchema = z.object({ key: text(32), spans: z.array(spanSchema).max(200), text: text(100_000).optional() }).passthrough();
const imageRefSchema = z.object({ imageId: z.string().regex(SAFE_ID), role: z.enum(['stem', 'option', 'table', 'decoration']), anchorLine: z.number().int().positive().optional() }).passthrough();
const questionSchema = z.object({
  id: z.string().regex(SAFE_ID), label: text(100), no: z.number().int().min(1).max(300), parentId: z.string().regex(SAFE_ID).optional(), sectionId: z.string().regex(SAFE_ID).optional(),
  spans: z.array(spanSchema).max(500), stem: text(100_000).optional(), points: z.number().finite().min(0).max(10_000).optional(),
  type: z.enum(['mcq', 'truefalse', 'short', 'long', 'fillblank', 'matching', 'multi', 'numeric', 'diagram', 'essay', 'unknown']),
  options: z.array(optionSchema).max(30).optional(), answer: z.object({ spans: z.array(spanSchema).max(500).optional(), text: text(100_000).optional(), source: z.enum(['paper', 'keyfile', 'manual', 'ai']) }).passthrough().optional(),
  tables: z.array(z.object({ html: text(100_000), spans: z.array(spanSchema).max(500) }).passthrough()).max(100).optional(),
  images: z.array(imageRefSchema).max(100).optional(), confidence: z.number().finite().min(0).max(1), flags: z.array(text(200)).max(100).optional(),
}).passthrough();
const sectionSchema = z.object({ id: z.string().regex(SAFE_ID), index: z.number().int().positive().max(10_000), title: text(500).optional(), instructions: text(20_000).optional(), points: z.number().finite().min(0).max(100_000).optional(), passage: text(500_000).optional(), spans: z.array(spanSchema).max(1000) }).passthrough();
const imageSchema = z.object({
  id: z.string().regex(SAFE_ID), page: z.number().int().min(1).max(10_000), bbox: z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite().nonnegative(), h: z.number().finite().nonnegative() }).passthrough(),
  mime: z.string().max(100), sha: z.string().max(256), width: z.number().int().nonnegative().max(100_000), height: z.number().int().nonnegative().max(100_000), anchorLine: z.number().int().positive().optional(),
  imageFlags: z.array(text(200)).max(100).optional(), duplicateOf: z.string().regex(SAFE_ID).optional(), dHash: z.string().max(256).optional(),
  label: z.object({ role: z.enum(['stem', 'option', 'table', 'decoration']), questionRef: text(100).optional(), caption: text(500).optional(), reason: text(1000).optional(), kind: z.enum(['photo', 'diagram', 'chart', 'table', 'formula', 'handwriting', 'decoration']).optional(), needsText: z.boolean().optional() }).passthrough().optional(),
  blobKey: text(256), dataUrl: text(8 * 1024 * 1024).optional(), exportPath: text(512).optional(),
}).passthrough();
const usageSchema = z.object({ ts: text(100), role: z.enum(['fast', 'standard', 'escalation', 'vision', 'ocr', 'patch', 'agent']), provider: text(200), model: text(300), inputTokens: z.number().finite().nonnegative(), outputTokens: z.number().finite().nonnegative(), cachedTokens: z.number().finite().nonnegative().optional(), costUsd: z.number().finite().nonnegative().optional(), label: text(1000), isCachedHit: z.boolean().optional(), dedupeKey: text(300).optional() }).passthrough();

export const ExamDocImportSchema = z.object({
  id: z.string().regex(SAFE_ID), fileHash: text(256), createdAt: text(100), displayName: text(300).optional(), nameSource: z.enum(['ai', 'manual']).optional(),
  meta: z.object({ title: text(500).optional(), subject: text(300).optional(), grade: text(300).optional(), school: text(500).optional(), term: text(200).optional(), year: text(100).optional(), durationMinutes: z.number().finite().nonnegative().optional(), totalPoints: z.number().finite().nonnegative().optional(), language: text(30), direction: z.enum(['ltr', 'rtl']), headerLines: z.array(spanSchema).max(100).optional() }).passthrough(),
  sections: z.array(sectionSchema).max(500), questions: z.array(questionSchema).max(5000), images: z.array(imageSchema).max(2000).optional(),
  source: z.object({ lines: z.array(lineSchema).max(200_000), pages: z.number().int().min(0).max(10_000), ocrUsed: z.boolean(), fileName: text(512), pageImages: z.array(text(8 * 1024 * 1024)).max(10_000).optional(), pageThumbKeys: z.array(text(256)).max(10_000).optional(), expectedQuestionNos: z.array(z.number().int().min(1).max(300)).max(300).optional(), keyTerritoryLineNos: z.array(z.number().int().positive().max(1_000_000)).max(200_000).optional() }).passthrough(),
  flags: z.array(z.object({ id: text(256), severity: z.enum(['info', 'warn', 'error']), code: text(200), message: text(10_000), questionId: z.string().regex(SAFE_ID).optional() }).passthrough()).max(10_000).optional(),
  usage: z.array(usageSchema).max(500).optional(),
}).passthrough();

function safeJsonObject(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => safeJsonObject(item, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 500 && entries.every(([key, child]) => !['__proto__', 'prototype', 'constructor'].includes(key) && safeJsonObject(child, depth + 1));
}

export function validateExtraBodyJson(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > 65_536) return false;
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && safeJsonObject(parsed));
  } catch { return false; }
}

export function validateProviderBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function validateHeaders(value: unknown): value is Record<string, string> {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 50 && entries.every(([name, headerValue]) => /^[A-Za-z0-9-]{1,80}$/.test(name) && typeof headerValue === 'string' && headerValue.length <= 4000 && !/[\r\n]/.test(headerValue));
}

const selection = z.object({ providerId: z.string().regex(SAFE_ID), model: text(300).min(1) });
const providerSchema = z.object({
  id: z.string().regex(SAFE_ID), name: text(200).min(1), kind: z.enum(['gemini', 'openai-compatible']), baseURL: z.string().refine(validateProviderBaseUrl, 'Must be an http(s) URL without credentials, query, or fragment'),
  apiKey: text(8192), defaultHeaders: z.record(z.string(), text(4000)).optional(), disableReasoning: z.boolean().optional(), structuredOutputs: z.boolean().optional(), extraBodyJson: text(65_536).optional(),
}).passthrough().superRefine((provider, ctx) => {
  if (!validateHeaders(provider.defaultHeaders)) ctx.addIssue({ code: 'custom', path: ['defaultHeaders'], message: 'Invalid HTTP headers.' });
  if (provider.extraBodyJson?.trim()) {
    try {
      const parsed = JSON.parse(provider.extraBodyJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !safeJsonObject(parsed)) throw new Error('unsafe object');
    } catch { ctx.addIssue({ code: 'custom', path: ['extraBodyJson'], message: 'Must be a bounded, safe JSON object.' }); }
  }
});
export const AppSettingsSchema = z.object({
  providers: z.array(providerSchema).min(1).max(50),
  roleMapping: z.object({ fast: selection, standard: selection, escalation: selection, vision: selection, agent: selection.optional(), critic: selection.optional(), consensus: selection.optional() }),
  costTable: z.record(z.string(), z.object({ inputCostPerMillion: z.number().finite().nonnegative(), outputCostPerMillion: z.number().finite().nonnegative() })),
  thrift: z.object({ latexNormalization: z.boolean(), maxImagesPerVisionCall: z.number().int().min(1).max(64), imageMaxLongEdge: z.number().int().min(64).max(8192), jpegQuality: z.number().int().min(1).max(100), cacheEnabled: z.boolean() }),
  budget: z.object({ maxUsdPerRun: z.number().finite().nonnegative(), maxOutputTokens: z.number().int().min(256).max(65_536) }),
  agentLimits: z.object({ maxModelCalls: z.number().int().min(1).max(100).optional(), maxToolExecutions: z.number().int().min(1).max(200).optional() }).optional(),
  assistantMonthlySoftCapUsd: z.number().finite().nonnegative().optional(),
  uiLanguage: z.enum(['fa', 'en']).optional(),
  defaultExamMode: z.enum(['exam', 'review']).optional(), livePanel: z.boolean().optional(),
  themeTokens: z.object({ primary: z.string().max(80).optional(), background: z.string().max(80).optional(), foreground: z.string().max(80).optional() }).strict().optional(),
  document: z.object({ defaultLanguage: z.enum(['auto', 'ltr', 'rtl']), paperSize: z.enum(['A4', 'Letter']), fontSize: z.enum(['small', 'medium', 'large']) }),
}).passthrough().superRefine((settings, ctx) => {
  const providerIds = new Set(settings.providers.map(provider => provider.id));
  for (const [role, selected] of Object.entries(settings.roleMapping)) if (!providerIds.has(selected.providerId)) ctx.addIssue({ code: 'custom', path: ['roleMapping', role], message: 'Role references an unknown provider.' });
});

export function validateAppSettings(value: unknown): AppSettings {
  return AppSettingsSchema.parse(value) as AppSettings;
}

export function isSensitiveCredentialName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]+/).filter(Boolean);
  const sensitive = new Set(['auth', 'authorization', 'authentication', 'token', 'secret', 'credential', 'credentials', 'password', 'passwd', 'cookie', 'bearer', 'jwt', 'privatekey']);
  return words.some(word => sensitive.has(word)) || words.some((word, index) => word === 'api' && words[index + 1] === 'key') || words.some((word, index) => word === 'access' && words[index + 1] === 'token') || words.some((word, index) => word === 'refresh' && words[index + 1] === 'token') || words.some((word, index) => word === 'private' && words[index + 1] === 'key');
}

export function stripCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCredentialFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !isSensitiveCredentialName(key)).map(([key, child]) => [key, stripCredentialFields(child)]));
}

function redactSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    isSensitiveCredentialName(key) ? '' : redactSecretFields(child),
  ]));
}

function redactExtraBodyJson(value: string | undefined): string {
  if (!value) return '';
  try { return JSON.stringify(redactSecretFields(JSON.parse(value))); } catch { return ''; }
}

export function redactSettingsForExport(settings: AppSettings): object {
  const safeSettings = redactSecretFields(settings) as any;
  return {
    ...safeSettings,
    providers: settings.providers.map(provider => ({
      ...provider,
      apiKey: '',
      defaultHeaders: Object.fromEntries(Object.entries(provider.defaultHeaders || {}).filter(([name]) => !isSensitiveCredentialName(name))),
      extraBodyJson: redactExtraBodyJson(provider.extraBodyJson),
    })),
  };
}

export function parseExamDocImport(textValue: string): { doc?: ExamDoc; error?: string } {
  if (new TextEncoder().encode(textValue).length > MAX_EXAM_JSON_BYTES) return { error: `Exam JSON exceeds ${Math.round(MAX_EXAM_JSON_BYTES / 1024 / 1024)} MiB.` };
  let parsed: unknown;
  try { parsed = JSON.parse(textValue); } catch { return { error: 'Invalid JSON syntax.' }; }
  const result = ExamDocImportSchema.safeParse(parsed);
  if (!result.success) return { error: `Invalid ExamDoc format: ${result.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'document'}: ${issue.message}`).join('; ')}` };
  const value = stripCredentialFields(result.data) as any;
  const hasDuplicates = (items: any[], key: string) => new Set(items.map(item => item[key])).size !== items.length;
  if (hasDuplicates(value.source.lines, 'id')) return { error: 'Invalid ExamDoc format: duplicate source line ids.' };
  if (hasDuplicates(value.questions, 'id')) return { error: 'Invalid ExamDoc format: duplicate question ids.' };
  if (hasDuplicates(value.sections, 'id')) return { error: 'Invalid ExamDoc format: duplicate section ids.' };
  if (hasDuplicates(value.images || [], 'id')) return { error: 'Invalid ExamDoc format: duplicate image ids.' };
  const maximumLine = value.source.lines.reduce((maximum: number, line: any) => Math.max(maximum, Number(line.id.slice(1)) || 0), 0);
  const allSpans = [
    ...value.sections.flatMap((section: any) => section.spans || []),
    ...value.questions.flatMap((question: any) => [
      ...(question.spans || []), ...(question.options || []).flatMap((option: any) => option.spans || []),
      ...(question.tables || []).flatMap((table: any) => table.spans || []), ...(question.answer?.spans || []),
    ]),
  ];
  if (allSpans.some(([start, end]: [number, number]) => start < 1 || end > maximumLine || end < start)) return { error: 'Invalid ExamDoc format: one or more source spans fall outside the line-addressed source.' };
  const images = (value.images || []).map((image: any) => {
    const { dataUrl: _untrustedDataUrl, exportPath: _exportPath, ...safeImage } = image;
    return { ...safeImage, blobKey: SAFE_STORAGE_KEY.test(safeImage.blobKey || '') ? safeImage.blobKey : '' };
  });
  const { pageImages: _pageImages, ...source } = value.source;
  source.pageThumbKeys = (source.pageThumbKeys || []).filter((key: string) => SAFE_STORAGE_KEY.test(key));
  const questions = value.questions.map((question: any) => ({
    ...question,
    images: Array.isArray(question.images) ? question.images : [],
    options: Array.isArray(question.options) ? question.options : undefined,
    tables: Array.isArray(question.tables) ? question.tables : undefined,
    rewrites: Array.isArray(question.rewrites) ? question.rewrites : [],
  }));
  return { doc: { ...value, images, source, sections: value.sections || [], questions, flags: value.flags || [], usage: value.usage || [] } as ExamDoc };
}

export function validateJsonSize(value: unknown, maxBytes: number): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes; } catch { return false; }
}
