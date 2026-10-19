import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { LLMRequest, LLMResponse, getDisplayName } from './src/types';
import { AppSettingsSchema, SAFE_STORAGE_KEY, isSensitiveCredentialName, validateExtraBodyJson, validateHeaders, validateJsonSize, validateProviderBaseUrl } from './src/utils/validation';
import { getExamHealth, examContentRevision } from './src/pipeline/quality';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Up to 50MB for batched image payloads
app.use(express.json({ limit: '50mb', strict: false }));

/* ------------------------------------------------------------------ */
/* Folder-backed storage (A)                                           */
/* ------------------------------------------------------------------ */
const CONFIG_FILE = process.env.EXAMPARSE_CONFIG_FILE || path.join(process.cwd(), '.examparse-storage.json');
let configuredDir: string | undefined = process.env.EXAMFORGE_DATA_DIR;
if (!configuredDir) { try { configuredDir = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).dir; } catch { /* first run */ } }
let DATA_DIR = ''; let EXAMS_DIR = ''; let IMAGES_DIR = ''; let CACHE_DIR = ''; let JOURNALS_DIR = ''; let VERSIONS_DIR = ''; let MEMORY_DIR = '';
let SETTINGS_FILE = ''; let USAGE_FILE = ''; let MONTHLY_USAGE_FILE = ''; let storageError = '';
function configureStorage(dir: string) {
  const base = path.resolve(dir);
  const buckets = ['exams', 'images', 'cache', 'journals', 'versions', 'memory'].map(name => path.join(base, name));
  fs.mkdirSync(base, { recursive: true }); fs.accessSync(base, fs.constants.R_OK | fs.constants.W_OK);
  for (const bucket of buckets) {
    if (fs.existsSync(bucket) && fs.lstatSync(bucket).isSymbolicLink()) throw new Error('Storage buckets must not be symlinks.');
    fs.mkdirSync(bucket, { recursive: true });
  }
  DATA_DIR = base; [EXAMS_DIR, IMAGES_DIR, CACHE_DIR, JOURNALS_DIR, VERSIONS_DIR, MEMORY_DIR] = buckets;
  SETTINGS_FILE = path.join(base, 'settings.json'); USAGE_FILE = path.join(base, 'usage.json'); MONTHLY_USAGE_FILE = path.join(base, 'usage-monthly.json'); storageError = '';
}
if (configuredDir) { try { configureStorage(configuredDir); } catch (error) { storageError = String(error); } }
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
app.get('/api/storage/health', (_req, res) => res.json({ mode: DATA_DIR ? 'folder' : 'unavailable', configured: Boolean(DATA_DIR), dir: DATA_DIR, error: storageError, defaultGeminiConfigured: Boolean(process.env.GEMINI_API_KEY) }));
app.post('/api/storage/config', (req, res) => {
  if (process.env.EXAMFORGE_DATA_DIR) return res.status(409).json({ error: 'Folder is configured by EXAMFORGE_DATA_DIR; restart after changing it.' });
  if (typeof req.body?.dir !== 'string' || !req.body.dir.trim() || req.body.dir.length > 4096 || req.body.dir.includes('\0')) return res.status(400).json({ error: 'A local folder path is required.' });
  try { configureStorage(req.body.dir); atomicWriteJson(CONFIG_FILE, { dir: DATA_DIR }); return res.json({ ok: true, dir: DATA_DIR }); }
  catch (error) { return res.status(400).json({ error: String(error) }); }
});
app.use('/api', (req, res, next) => {
  if (!DATA_DIR && !['/llm', '/test-connection', '/models'].includes(req.path)) return res.status(503).json({ error: 'Choose a local data folder before using ExamParse.' });
  next();
});

function assertInsideDir(res: Response, dir: string, file: string): string | null {
  const base = path.resolve(dir);
  const resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    res.status(400).json({ error: 'Path escapes data directory' });
    return null;
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) { res.status(400).json({ error: 'Symlink storage files are not allowed' }); return null; }
  return resolved;
}
function safeSegment(res: Response, value: string): boolean {
  if (!SAFE_SEGMENT.test(value || '')) {
    res.status(400).json({ error: 'Invalid path segment.' });
    return false;
  }
  return true;
}
const MAX_EXAM_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function redactSensitiveText(value: unknown, secrets: Array<string | undefined> = []): string {
  let text = String(value || 'Request failed')
    .replace(/\b(api[_-]?key|access[_-]?token|authorization|bearer)\s*["']?\s*[:= ]\s*["']?[^\s,"'&}]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1[REDACTED]');
  for (const secret of secrets) if (secret && secret.length >= 6) text = text.split(secret).join('[REDACTED]');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function collectNamedSecrets(value: unknown, sensitiveParent = false): string[] {
  if (typeof value === 'string') return sensitiveParent ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(item => collectNamedSecrets(item, sensitiveParent));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, child]) => collectNamedSecrets(child, isSensitiveCredentialName(name)));
}

function providerSecrets(config: any): Array<string | undefined> {
  const headerSecrets = Object.entries(config?.defaultHeaders || {}).filter(([name]) => isSensitiveCredentialName(name)).map(([, value]) => typeof value === 'string' ? value : undefined);
  let extraBodySecrets: string[] = [];
  try { extraBodySecrets = collectNamedSecrets(JSON.parse(config?.extraBodyJson || 'null')); } catch { /* invalid extra body is rejected before provider use */ }
  return [config?.apiKey, process.env.GEMINI_API_KEY, ...headerSecrets, ...extraBodySecrets];
}

function hasSafeJsonSize(res: Response, body: unknown, maxBytes: number): boolean {
  if (!validateJsonSize(body, maxBytes)) {
    res.status(413).json({ error: `JSON payload exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB storage limit.` });
    return false;
  }
  return true;
}

function validateStoredExam(body: any, routeId: string): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'ExamDoc object required.';
  if (body.id !== routeId) return 'Exam id must match the storage path.';
  if (!body.meta || typeof body.meta !== 'object' || !body.source || typeof body.source !== 'object') return 'Exam meta and source objects are required.';
  if (!Array.isArray(body.source.lines) || body.source.lines.length > 200_000) return 'Exam source lines are invalid or exceed the line limit.';
  if (!Array.isArray(body.questions) || body.questions.length > 5_000) return 'Exam questions are invalid or exceed the question limit.';
  if (!Array.isArray(body.images) || body.images.length > 2_000) return 'Exam images are invalid or exceed the image limit.';
  if (!Array.isArray(body.sections) || body.sections.length > 500) return 'Exam sections are invalid or exceed the section limit.';
  for (const line of body.source.lines) {
    if (!line || typeof line !== 'object' || !/^L\d{1,9}$/.test(String(line.id || '')) || !Number.isInteger(line.page) || typeof line.text !== 'string' || line.text.length > 100_000) return 'Exam source contains an invalid line.';
  }
  for (const image of body.images) {
    if (!image || typeof image !== 'object' || !SAFE_STORAGE_KEY.test(String(image.id || '')) || (image.blobKey && !SAFE_STORAGE_KEY.test(String(image.blobKey)))) return 'Exam image metadata contains an invalid storage key.';
  }
  for (const key of body.source.pageThumbKeys || []) if (!SAFE_STORAGE_KEY.test(String(key))) return 'Exam page thumbnail key is invalid.';
  return null;
}

function validateLlmRequest(value: any): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'LLM request object required.';
  if (!['fast', 'standard', 'escalation', 'vision', 'ocr', 'patch', 'agent'].includes(value.role)) return 'Unsupported LLM role.';
  if (typeof value.system !== 'string' || value.system.length > 200_000 || typeof value.text !== 'string' || value.text.length > 25_000_000) return 'LLM prompt is invalid or exceeds the size limit.';
  if (value.label !== undefined && (typeof value.label !== 'string' || value.label.length > 500)) return 'LLM request label is invalid.';
  if (value.maxOutputTokens !== undefined && (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 65_536)) return 'LLM output token limit is invalid.';
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 64)) return 'LLM image batch exceeds the 64-image limit.';
  let imageBytes = 0;
  for (const image of value.images || []) {
    if (!image || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'].includes(image.mime) || typeof image.data !== 'string' || image.data.length > MAX_IMAGE_BYTES * 4 / 3 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return 'LLM image payload is invalid.';
    imageBytes += image.data.length * 0.75;
  }
  if (imageBytes > MAX_IMAGE_BYTES) return 'LLM image payload exceeds the 32 MiB limit.';
  const config = value.providerConfig;
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || !['gemini', 'openai-compatible'].includes(config.kind) || typeof config.model !== 'string' || config.model.length > 300 || (config.apiKey !== undefined && (typeof config.apiKey !== 'string' || config.apiKey.length > 8192))) return 'Provider configuration is invalid.';
    if (config.kind === 'openai-compatible' && !validateProviderBaseUrl(config.baseURL)) return 'Provider URL must be http(s), without credentials, query, or fragment.';
    if (!validateHeaders(config.defaultHeaders)) return 'Provider headers are invalid.';
    if (!validateExtraBodyJson(config.extraBodyJson)) return 'Provider extra body must be a bounded, safe JSON object.';
  }
  return null;
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch { return fallback; }
}
function atomicWriteFile(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteFile(file, JSON.stringify(value, null, 2));
}
app.get('/api/memory/:id', (req, res) => {
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, MEMORY_DIR, path.join(MEMORY_DIR, `${req.params.id}.json`)); if (!file) return;
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Memory not found' });
  return res.json(readJsonFile(file, null));
});
app.put('/api/memory/:id', (req,res)=>{
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, MEMORY_DIR, path.join(MEMORY_DIR, `${req.params.id}.json`)); if (!file) return;
  if (!hasSafeJsonSize(res, req.body, 32768)) return;
  atomicWriteJson(file, req.body); return res.json({ok:true});
});
app.delete('/api/memory/:id', (req,res)=>{
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, MEMORY_DIR, path.join(MEMORY_DIR, `${req.params.id}.json`)); if (!file) return;
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return res.json({ok:true});
});
app.get('/api/memory', (_req,res)=>{
  if (!fs.existsSync(MEMORY_DIR)) return res.json([]);
  const files = fs.readdirSync(MEMORY_DIR).filter(f=>f.endsWith('.json'));
  return res.json(files.map(f=>f.replace(/\.json$/,'')));
});
// Global user memory
app.get('/api/user-memory', (_req,res)=>{
  const file = path.join(DATA_DIR, 'user.json');
  if (!fs.existsSync(file)) return res.json({ preferences:{}, facts:[] });
  return res.json(readJsonFile(file, {preferences:{},facts:[]}));
});
app.put('/api/user-memory', (req,res)=>{
  const file = path.join(DATA_DIR, 'user.json');
  if (!hasSafeJsonSize(res, req.body, 8192)) return;
  atomicWriteJson(file, req.body); return res.json({ok:true});
});

function dirStats(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirStats(full);
    else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
  }
  return total;
}
function listExamFiles(): string[] {
  if (!fs.existsSync(EXAMS_DIR)) return [];
  return fs.readdirSync(EXAMS_DIR).filter(f => f.endsWith('.json')).map(f => path.join(EXAMS_DIR, f));
}
function summarizeStoredExam(doc: any): any {
  const usage = Array.isArray(doc?.usage) ? doc.usage : [];
  let health: ReturnType<typeof getExamHealth>;
  try { health = getExamHealth(doc); } catch { health = { expectedCount: doc?.questions?.length || 0, parsedCount: doc?.questions?.length || 0, missing: [], duplicates: [], pointsParsed: 0, pointDeficit: 0, unplacedImages: [], unresolvedImageRefs: [], lowConfidenceCount: 0, coveragePercent: 0, state: 'amber', complete: false }; }
  // Compute qualityScore inline (same weights as src/utils/qualityScore.ts to avoid circular import)
  let qualityScore = 0;
  try {
    const expected = health.expectedCount || 0;
    const parsed = health.parsedCount || 0;
    const coverage = expected > 0 ? Math.min(1, parsed / expected) : (parsed > 0 ? 1 : 0);
    const covScore = Math.round(coverage * 30);
    const pointsExpected = (health as any).pointsExpected;
    let ptsScore = 15;
    if (pointsExpected != null && pointsExpected > 0) { const def = Math.abs((health as any).pointDeficit || 0); ptsScore = Math.max(0, Math.round(15 - (def / pointsExpected) * 15 * 2)); }
    const qs = Array.isArray(doc.questions) ? doc.questions : [];
    let blobCount = 0; for (const q of qs) { if (Array.isArray(q.options) && q.options.length === 0 && q.text && /[a-d]\s*[\).]/.test(q.text)) blobCount++; }
    const optScore = Math.max(0, 15 - Math.min(15, blobCount * 3));
    const unplaced = (health as any).unplacedImages?.length || 0;
    const imgScore = Math.max(0, 15 - unplaced * 5);
    const dupCount = health.duplicates?.length || 0;
    const numScore = Math.max(0, 10 - dupCount * 5);
    const low = health.lowConfidenceCount || 0;
    const confScore = Math.max(0, 10 - low * 2);
    let passScore = 5; for (const q of qs) { if (q.text && /passage|reading.*text|listen/i.test(q.text) && (!q.sourceLineIds || q.sourceLineIds.length === 0)) { passScore = 0; break; } }
    qualityScore = Math.max(0, Math.min(100, covScore + ptsScore + optScore + imgScore + numScore + confScore + passScore));
  } catch { qualityScore = 0; }
  return {
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
    expectedQuestionCount: health.expectedCount,
    parsedQuestionCount: health.parsedCount,
    coveragePercent: health.coveragePercent,
    missingQuestionNos: health.missing,
    duplicateQuestionNos: health.duplicates,
    complete: health.complete,
    sectionCount: Array.isArray(doc.sections) ? doc.sections.length : 0,
    imageCount: Array.isArray(doc.images) ? doc.images.length : 0,
    ocrUsed: Boolean(doc.source?.ocrUsed),
    qualityScore,
    coveragePercent: health.coveragePercent,
    missingQuestionNos: health.missing,
    duplicateQuestionNos: health.duplicates,
    totalCostUsd: usage.reduce((a: number, u: any) => a + (u.costUsd || 0), 0),
    totalTokens: usage.reduce((a: number, u: any) => a + (u.inputTokens || 0) + (u.outputTokens || 0), 0),
  };
}
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', bin: 'application/octet-stream',
};
function imageFileForSha(sha: string): string | null {
  if (!fs.existsSync(IMAGES_DIR)) return null;
  const name = fs.readdirSync(IMAGES_DIR).find(f => f === sha || f.startsWith(`${sha}.`));
  return name ? path.join(IMAGES_DIR, name) : null;
}

// A lease prevents simultaneous assistant turns in separate tabs; human edits remain allowed.
const agentLeases = new Map<string, { owner: string; expires: number }>();
app.post('/api/agent-lock/:id', (req, res) => {
  if (!safeSegment(res, req.params.id) || !safeSegment(res, String(req.body?.owner || ''))) return;
  const current = agentLeases.get(req.params.id); const now = Date.now();
  if (current && current.expires > now && current.owner !== req.body.owner) return res.status(409).json({ error: 'Assistant is working on this exam in another tab. Try again after it finishes (abandoned leases expire in 90 seconds).' });
  agentLeases.set(req.params.id, { owner: req.body.owner, expires: now + 90000 }); return res.json({ ok: true });
});
app.delete('/api/agent-lock/:id', (req, res) => {
  if (!safeSegment(res, req.params.id)) return;
  const current = agentLeases.get(req.params.id);
  if (current && current.owner !== req.body?.owner) return res.status(409).json({ error: 'Lease owner mismatch.' });
  agentLeases.delete(req.params.id); return res.json({ ok: true });
});

app.get('/api/storage/stats', (_req, res) => res.json({ dir: DATA_DIR, buckets: Object.fromEntries([
  ['exams', EXAMS_DIR], ['images', IMAGES_DIR], ['cache', CACHE_DIR], ['journals', JOURNALS_DIR], ['memory', MEMORY_DIR], ['usage', USAGE_FILE],
].map(([name, file]) => [name, { bytes: fs.existsSync(file) ? fs.statSync(file).isDirectory() ? dirStats(file) : fs.statSync(file).size + (name === 'usage' && fs.existsSync(MONTHLY_USAGE_FILE) ? fs.statSync(MONTHLY_USAGE_FILE).size : 0) : 0,
  count: fs.existsSync(file) ? fs.statSync(file).isDirectory() ? fs.readdirSync(file).length : readJsonFile<any[]>(file, []).length : 0 }])) }));
app.delete('/api/storage/buckets/:bucket', (req, res) => {
  const dirs: Record<string, string> = { cache: CACHE_DIR, journals: JOURNALS_DIR };
  if (req.params.bucket === 'usage') { const count = readJsonFile<any[]>(USAGE_FILE, []).length; atomicWriteJson(USAGE_FILE, []); atomicWriteJson(MONTHLY_USAGE_FILE, {}); return res.json({ deleted: count }); }
  const dir = dirs[req.params.bucket]; if (!dir) return res.status(400).json({ error: 'Only cache, journals and usage can be cleared here.' });
  let deleted = 0;
  for (const name of fs.readdirSync(dir)) if (SAFE_SEGMENT.test(name.replace(/\.json$/, '')) && name.endsWith('.json')) {
    const file = assertInsideDir(res, dir, path.join(dir, name)); if (!file) return;
    if (fs.lstatSync(file).isFile()) { fs.unlinkSync(file); deleted++; }
  }
  return res.json({ deleted });
});
function versionState(doc: any) { return { questions: doc.questions, sections: doc.sections, images: doc.images, meta: doc.meta, displayName: doc.displayName, nameSource: doc.nameSource, flags: doc.flags }; }
function snapshotBeforeWrite(id: string, previous: any, next: any) {
  if (!previous || JSON.stringify(versionState(previous)) === JSON.stringify(versionState(next))) return;
  const file = path.join(VERSIONS_DIR, `${id}.json`);
  const versions = readJsonFile<any[]>(file, []);
  versions.push({ id: crypto.randomUUID(), ts: new Date().toISOString(), ...versionState(previous) });
  atomicWriteJson(file, versions.slice(-10));
}
app.get('/api/exams/:id/versions', (req, res) => {
  if (!safeSegment(res, req.params.id)) return;
  return res.json(readJsonFile(path.join(VERSIONS_DIR, `${req.params.id}.json`), []));
});
app.post('/api/exams/:id/restore/:version', (req, res) => {
  if (!safeSegment(res, req.params.id) || !safeSegment(res, req.params.version)) return;
  const file = path.join(EXAMS_DIR, `${req.params.id}.json`);
  const current = readJsonFile<any>(file, null);
  const version = readJsonFile<any[]>(path.join(VERSIONS_DIR, `${req.params.id}.json`), []).find(v => v.id === req.params.version);
  if (!current || !version) return res.status(404).json({ error: 'Version not found' });
  const { id: _id, ts: _ts, ...state } = version;
  const restored = { ...current, ...state, nameSource: version.nameSource }; snapshotBeforeWrite(req.params.id, current, restored); atomicWriteJson(file, restored);
  return res.json({ ok: true });
});
for (const method of ['get', 'put'] as const) app[method]('/api/journals/:key', (req, res) => {
  if (!safeSegment(res, req.params.key)) return;
  const file = assertInsideDir(res, JOURNALS_DIR, path.join(JOURNALS_DIR, `${req.params.key}.json`)); if (!file) return;
  if (method === 'get') return fs.existsSync(file) ? res.json(readJsonFile(file, null)) : res.status(404).json({ error: 'Journal not found' });
  if (!hasSafeJsonSize(res, req.body, MAX_CACHE_BYTES)) return;
  atomicWriteJson(file, req.body); return res.json({ ok: true });
});

app.get('/api/exams', (_req: Request, res: Response) => {
  const summaries: any[] = [];
  for (const file of listExamFiles()) {
    const doc = readJsonFile<any>(file, null);
    if (doc && doc.id) summaries.push(summarizeStoredExam(doc));
  }
  summaries.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return res.json(summaries);
});

app.get('/api/exams/:id', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, EXAMS_DIR, path.join(EXAMS_DIR, `${req.params.id}.json`));
  if (!file) return;
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Exam not found' });
  return res.json(readJsonFile(file, null));
});

app.put('/api/exams/:id', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, EXAMS_DIR, path.join(EXAMS_DIR, `${req.params.id}.json`));
  if (!file) return;
  const validationError = validateStoredExam(req.body, req.params.id);
  if (validationError) return res.status(400).json({ error: validationError });
  if (!hasSafeJsonSize(res, req.body, MAX_EXAM_BYTES)) return;
  const previous = readJsonFile<any>(file, null);
  const expected = req.header('If-Match');
  if (expected && (!previous || createHash('sha256').update(examContentRevision(previous)).digest('hex') !== expected)) return res.status(409).json({ error: 'Human edits changed this exam; assistant mutation was not applied. Re-observe before retrying.' });
  snapshotBeforeWrite(req.params.id, previous, req.body);
  atomicWriteJson(file, req.body);
  return res.json({ ok: true, id: req.params.id });
});

app.post('/api/exams/:id/usage', (req, res) => {
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, EXAMS_DIR, path.join(EXAMS_DIR, `${req.params.id}.json`)); if (!file) return;
  const doc = readJsonFile<any>(file, null); if (!doc) return res.status(404).json({ error: 'Exam not found' });
  if (req.body?.role !== 'agent' || typeof req.body?.label !== 'string' || !hasSafeJsonSize(res, req.body, 32768)) return res.status(400).json({ error: 'Invalid agent usage record' });
  doc.usage = [...(doc.usage || []), req.body].slice(-500); atomicWriteJson(file, doc); return res.json({ ok: true });
});

app.delete('/api/exams/:id', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, EXAMS_DIR, path.join(EXAMS_DIR, `${req.params.id}.json`));
  if (!file) return;
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const versionsFile = path.join(VERSIONS_DIR, `${req.params.id}.json`); if (fs.existsSync(versionsFile)) fs.unlinkSync(versionsFile);
  // Orphan-sweep images by scanning remaining exam files (image blobKeys + page thumb keys).
  const referenced = new Set<string>();
  for (const f of listExamFiles()) {
    const doc = readJsonFile<any>(f, null);
    for (const img of doc?.images || []) { if (img.blobKey) referenced.add(img.blobKey); if (img.sha) referenced.add(img.sha); }
    for (const k of doc?.source?.pageThumbKeys || []) referenced.add(k);
    for (const version of readJsonFile<any[]>(path.join(VERSIONS_DIR, `${doc?.id}.json`), [])) for (const image of version.images || []) if (image.blobKey) referenced.add(image.blobKey);
  }
  if (fs.existsSync(IMAGES_DIR)) {
    for (const name of fs.readdirSync(IMAGES_DIR)) {
      const sha = name.replace(/\.[^.]+$/, '');
      if (!referenced.has(sha) && !referenced.has(name)) {
        try { fs.unlinkSync(path.join(IMAGES_DIR, name)); } catch { /* ignore */ }
      }
    }
  }
  return res.json({ ok: true, id: req.params.id });
});

app.get('/api/images/:sha', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.sha)) return;
  const file = imageFileForSha(req.params.sha);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Image not found' });
  const checked = assertInsideDir(res, IMAGES_DIR, file);
  if (!checked) return;
  const ext = path.extname(file).replace('.', '').toLowerCase();
  res.type(IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream');
  return res.sendFile(checked);
});

app.put('/api/images/:sha', express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.sha)) return;
  const mime = String(req.query.mime || 'application/octet-stream');
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'].includes(mime)) return res.status(415).json({ error: 'Unsupported image MIME type.' });
  let ext = mime.includes('/') ? mime.split('/')[1] : 'bin';
  ext = ext.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'bin';
  if (ext === 'jpg') ext = 'jpeg';
  const file = assertInsideDir(res, IMAGES_DIR, path.join(IMAGES_DIR, `${req.params.sha}.${ext}`));
  if (!file) return;
  if (fs.existsSync(IMAGES_DIR)) {
    for (const name of fs.readdirSync(IMAGES_DIR)) {
      if ((name === req.params.sha || name.startsWith(`${req.params.sha}.`)) && path.join(IMAGES_DIR, name) !== file) {
        try { fs.unlinkSync(path.join(IMAGES_DIR, name)); } catch { /* ignore */ }
      }
    }
  }
  const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  atomicWriteFile(file, body);
  return res.json({ ok: true, sha: req.params.sha, bytes: body.length });
});

app.delete('/api/images/:sha', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.sha)) return;
  const file = imageFileForSha(req.params.sha);
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
  return res.json({ ok: true, sha: req.params.sha });
});

app.get('/api/cache/:key', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.key)) return;
  const file = assertInsideDir(res, CACHE_DIR, path.join(CACHE_DIR, `${req.params.key}.json`));
  if (!file) return;
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Cache entry not found' });
  return res.json(readJsonFile(file, null));
});
app.put('/api/cache/:key', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.key)) return;
  const file = assertInsideDir(res, CACHE_DIR, path.join(CACHE_DIR, `${req.params.key}.json`));
  if (!file) return;
  if (!hasSafeJsonSize(res, req.body ?? null, MAX_CACHE_BYTES)) return;
  atomicWriteJson(file, req.body ?? null);
  return res.json({ ok: true, key: req.params.key });
});
app.delete('/api/cache/:key', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.key)) return;
  const file = assertInsideDir(res, CACHE_DIR, path.join(CACHE_DIR, `${req.params.key}.json`));
  if (!file) return;
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return res.json({ ok: true, key: req.params.key });
});
app.delete('/api/cache', (_req: Request, res: Response) => {
  if (fs.existsSync(CACHE_DIR)) {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      try { fs.unlinkSync(path.join(CACHE_DIR, name)); } catch { /* ignore */ }
    }
  }
  return res.json({ ok: true });
});

app.get('/api/settings', (_req: Request, res: Response) => {
  if (!fs.existsSync(SETTINGS_FILE)) return res.json(null);
  return res.json(readJsonFile(SETTINGS_FILE, null));
});
app.put('/api/settings', (req: Request, res: Response) => {
  const parsed = AppSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Settings payload failed validation; provider secrets were not logged.' });
  if (!hasSafeJsonSize(res, parsed.data, 2 * 1024 * 1024)) return;
  atomicWriteJson(SETTINGS_FILE, parsed.data);
  return res.json({ ok: true });
});

app.get('/api/usage/monthly', (_req, res) => res.json(readJsonFile<Record<string, number>>(MONTHLY_USAGE_FILE, {})));
app.get('/api/usage', (_req: Request, res: Response) => {
  return res.json(readJsonFile<any[]>(USAGE_FILE, []));
});
app.post('/api/usage', (req: Request, res: Response) => {
  const current = readJsonFile<any[]>(USAGE_FILE, []);
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  if (incoming.length > 500) return res.status(413).json({ error: 'Usage batch exceeds the 500-record limit.' });
  if (!hasSafeJsonSize(res, incoming, 2 * 1024 * 1024)) return;
  if (incoming.some(record => !record || typeof record !== 'object' || typeof record.label !== 'string' || record.label.length > 1000 || typeof record.provider !== 'string' || record.provider.length > 200 || typeof record.model !== 'string' || record.model.length > 300)) return res.status(400).json({ error: 'Usage records failed validation.' });
  const totals = readJsonFile<Record<string, number>>(MONTHLY_USAGE_FILE, {});
  for (const record of incoming) {
    const month = String(record.ts || '').slice(0, 7);
    if (record.role !== 'agent' || !/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(record.costUsd) || record.costUsd < 0) continue;
    const previous = record.dedupeKey ? current.find(r => r.dedupeKey === record.dedupeKey && r.role === 'agent' && String(r.ts).slice(0, 7) === month) : undefined;
    totals[month] = Math.max(0, (totals[month] || 0) + record.costUsd - (previous?.costUsd || 0));
  }
  atomicWriteJson(MONTHLY_USAGE_FILE, totals);
  const next = [...current];
  for (const record of incoming.filter(Boolean)) {
    if (record?.dedupeKey) {
      const index = next.findIndex((item: any) => item?.dedupeKey === record.dedupeKey);
      if (index >= 0) next[index] = record;
      else next.push(record);
    } else next.push(record);
  }
  const trimmed = next.slice(-500);
  atomicWriteJson(USAGE_FILE, trimmed);
  return res.json({ ok: true, count: trimmed.length });
});
app.put('/api/usage', (req: Request, res: Response) => {
  if (!Array.isArray(req.body) || req.body.length > 500) return res.status(400).json({ error: 'Usage payload must be an array of at most 500 records.' });
  if (!hasSafeJsonSize(res, req.body, 2 * 1024 * 1024)) return;
  const next = req.body;
  atomicWriteJson(USAGE_FILE, next);
  return res.json({ ok: true, count: next.length });
});
app.delete('/api/usage', (_req: Request, res: Response) => {
  atomicWriteJson(USAGE_FILE, []); atomicWriteJson(MONTHLY_USAGE_FILE, {});
  return res.json({ ok: true });
});



const REASONING_400_RE = /reasoning|thinking|enable_thinking|unsupported/i;
const PARSE_ROLES = new Set(['fast', 'vision', 'ocr', 'escalation', 'patch']);

/** Extract the first balanced JSON value ({...} or [...]) starting at/after `fromIndex`. String-aware brace scan. */
function extractBalancedJsonValue(text: string, fromIndex = 0): string | null {
  let start = -1;
  for (let i = fromIndex; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') { start = i; break; }
  }
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Extract the first balanced {...} object (string-aware brace scan). */
function extractBalancedJsonObject(text: string): string | null {
  const idx = text.indexOf('{');
  if (idx < 0) return null;
  const value = extractBalancedJsonValue(text, idx);
  return value && value.startsWith('{') ? value : null;
}

/** Strip <think>...</think> blocks; strip a leading unclosed <think> only if a { or [ follows later. */
function stripThinkBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const leading = out.match(/^\s*<think[^>]*>/i);
  if (leading && !/<\/think>/i.test(out)) {
    const afterTag = out.slice(leading[0].length);
    const bracketIdx = afterTag.search(/[\{\[]/);
    if (bracketIdx >= 0) {
      out = afterTag.slice(bracketIdx);
    }
  }
  return out;
}

/** Salvage-parse model content: direct parse, fence parse, then think-strip + first balanced JSON value. */
function parseModelContent(rawText: string): any {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  try {
    const cleaned = trimmed.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
    if (cleaned !== trimmed) {
      try { return JSON.parse(cleaned); } catch { /* fall through to salvage */ }
    }
  } catch { /* fall through */ }
  const stripped = stripThinkBlocks(trimmed);
  const balanced = extractBalancedJsonValue(stripped);
  if (balanced) {
    try { return JSON.parse(balanced); } catch { /* fall through */ }
  }
  return null;
}

/** Aggregate an SSE `data:` stream into a synthetic chat completion. Returns null if no SSE chunks. */
function aggregateSseCompletion(text: string): any | null {
  let content = '';
  let finishReason: string | undefined;
  let usage: any;
  let saw = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk: any;
    try { chunk = JSON.parse(payload); } catch { continue; }
    saw = true;
    const choice = chunk.choices?.[0];
    const deltaContent = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
    if (typeof deltaContent === 'string') content += deltaContent;
    else if (Array.isArray(deltaContent)) {
      for (const part of deltaContent) {
        if (typeof part === 'string') content += part;
        else if (part && typeof part.text === 'string') content += part.text;
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  if (!saw) return null;
  return {
    choices: [{ message: { content }, finish_reason: finishReason || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/** Parse an upstream body: strict JSON, then SSE aggregation, then first balanced {...} object. */
function parseUpstreamBody(bodyText: string): any | null {
  try { return JSON.parse(bodyText); } catch { /* fall through */ }
  const sse = aggregateSseCompletion(bodyText);
  if (sse) return sse;
  const balanced = extractBalancedJsonObject(bodyText);
  if (balanced) {
    try { return JSON.parse(balanced); } catch { /* fall through */ }
  }
  return null;
}

/** Parse per-provider Extra body JSON. Invalid / non-object JSON is ignored with a warning, never throws. */
function parseExtraBody(extraBodyJson: unknown): Record<string, any> {
  if (typeof extraBodyJson !== 'string' || !extraBodyJson.trim()) return {};
  try {
    const parsed = JSON.parse(extraBodyJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn('extraBodyJson is not a JSON object; ignoring it.');
    return {};
  } catch (err: any) {
    console.warn('Provider extra body is invalid JSON; details were omitted.');
    return {};
  }
}

/**
 * Single thin proxy route POST /api/llm (§7)
 */
app.post('/api/llm', async (req: Request, res: Response) => {
  const validationError = validateLlmRequest(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const payload: LLMRequest = req.body;
  const budgetId = payload.providerConfig?.agentBudgetId;
  if (budgetId && !DATA_DIR) return res.status(503).json({ error: 'Choose a local folder before starting an assistant turn.' });
  if (budgetId && !SAFE_SEGMENT.test(budgetId)) return res.status(400).json({ error: 'Invalid assistant budget id' });
  if (budgetId && payload.images?.length) return res.status(400).json({ error: 'Assistant cannot initiate OCR or vision.' });
  const consumeAgentCall = () => {
    if (!budgetId) return;
    const file = path.join(JOURNALS_DIR, `agent_budget_${budgetId}.json`);
    const budget = readJsonFile(file, { calls: 0, maxOutputTokens: payload.maxOutputTokens || 1024 });
    if (budget.calls >= 6) throw new Error('Assistant model-call bound reached (6); stopped safely.');
    budget.calls++; atomicWriteJson(file, budget);
  };
  if (budgetId) {
    const budget = readJsonFile(path.join(JOURNALS_DIR, `agent_budget_${budgetId}.json`), { maxOutputTokens: payload.maxOutputTokens || 1024 });
    payload.maxOutputTokens = Math.min(payload.maxOutputTokens || 1024, budget.maxOutputTokens);
  }
  const { role, system, text, images, jsonSchema, maxOutputTokens, label, providerConfig, stream } = payload;

  const kind = providerConfig?.kind || 'gemini';
  const model = providerConfig?.model || (role === 'escalation' ? 'gemini-2.5-pro' : 'gemini-2.5-flash');

  try {
    if (kind === 'gemini') {
      const apiKey = providerConfig?.apiKey?.trim() || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(400).json({
          error: 'No Gemini API key found. Please set GEMINI_API_KEY in environment or configure it in Settings.',
        });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      // Prepare parts
      const parts: any[] = [];
      if (images && images.length > 0) {
        for (const img of images) {
          parts.push({
            inlineData: {
              mimeType: img.mime,
              data: img.data,
            },
          });
        }
      }
      parts.push({ text });

      const config: any = {
        systemInstruction: system,
        temperature: 0,
        ...(role === 'agent' ? {} : { responseMimeType: 'application/json' }),
      };
      if (maxOutputTokens) {
        config.maxOutputTokens = maxOutputTokens;
      }
      if (jsonSchema) {
        config.responseSchema = jsonSchema;
      }
      // Disable thinking overhead for Flash / Flash-Lite models; Pro models have a provider minimum.
      const modelLower = model.toLowerCase();
      if (modelLower.includes('flash')) {
        config.thinkingConfig = { thinkingBudget: 0 };
      } else if (modelLower.includes('pro')) {
        config.thinkingConfig = { thinkingBudget: 128 };
      }

      if (stream) {
        const geminiAbort = new AbortController();
        const geminiTimer = setTimeout(() => geminiAbort.abort(), 300_000);
        config.abortSignal = geminiAbort.signal;
        res.on('close', () => { if (!res.writableEnded) geminiAbort.abort(); clearTimeout(geminiTimer); });
        res.status(200); res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders?.();
        const emit = (event: string, data: any) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        let rawText = ''; let finalChunk: any = null;
        try {
          consumeAgentCall();
          const streamResult: any = await (ai.models as any).generateContentStream({ model, contents: { parts }, config });
          for await (const chunk of streamResult) {
            finalChunk = chunk;
            const delta = typeof chunk.text === 'string' ? chunk.text : '';
            if (delta) { rawText += delta; emit('delta', { text: delta }); }
          }
          const parsed = parseModelContent(rawText); const meta = finalChunk?.usageMetadata || {};
          emit('done', { json: parsed, ...(label ? { label } : {}), rawText, finishReason: parsed === null ? (finalChunk?.candidates?.[0]?.finishReason || 'PARSE_ERROR') : (finalChunk?.candidates?.[0]?.finishReason || 'STOP'), usage: { inputTokens: meta.promptTokenCount || Math.ceil(text.length / 3), outputTokens: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0) || Math.ceil(rawText.length / 3), cachedTokens: meta.cachedContentTokenCount || 0 } });
          res.end(); clearTimeout(geminiTimer);
        } catch (streamErr: any) { emit('error', { message: redactSensitiveText(streamErr?.message || 'Gemini stream failed', providerSecrets(providerConfig)) }); res.end(); clearTimeout(geminiTimer); }
        return;
      }

      const startTime = Date.now();
      consumeAgentCall();
      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config,
      });

      const rawText = response.text || '';
      const parsedJson: any = parseModelContent(rawText);

      const inputTokens = response.usageMetadata?.promptTokenCount || Math.ceil(text.length / 3);
      const candidatesTokens = response.usageMetadata?.candidatesTokenCount || 0;
      const thoughtsTokens = (response.usageMetadata as any)?.thoughtsTokenCount || 0;
      const outputTokens = (candidatesTokens + thoughtsTokens) || Math.ceil(rawText.length / 3);
      const cachedTokens = response.usageMetadata?.cachedContentTokenCount || 0;
      const realFinishReason = response.candidates?.[0]?.finishReason || 'STOP';
      const finishReason = parsedJson === null ? (realFinishReason || 'PARSE_ERROR') : realFinishReason;

      const result: LLMResponse = {
        json: parsedJson,
        ...(label ? { label } : {}),
        usage: {
          inputTokens,
          outputTokens,
          cachedTokens,
        },
        rawText,
        finishReason,
      };

      return res.json(result);
    } else {
      // OpenAI-compatible endpoint
      const baseURL = (providerConfig?.baseURL || 'http://localhost:20128/v1').replace(/\/+$/, '');
      const apiKey = providerConfig?.apiKey?.trim() || '';

      const userContent: any[] = [];
      if (images && images.length > 0) {
        for (const img of images) {
          userContent.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mime};base64,${img.data}`,
            },
          });
        }
      }
      userContent.push({
        type: 'text',
        text,
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(providerConfig?.defaultHeaders || {}),
      };

      const baseBody: any = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        ...((providerConfig as any)?.structuredOutputs === false ? {} : { response_format: { type: 'json_object' } }),
      };
      if (maxOutputTokens) {
        baseBody.max_tokens = maxOutputTokens;
      }

      // Reasoning kill-switch (per-provider, default on) + Extra body JSON merged last.
      const disableReasoning = (providerConfig as any)?.disableReasoning !== false;
      const extraBody = parseExtraBody((providerConfig as any)?.extraBodyJson);
      const buildAttemptBody = (rung: 0 | 1 | 2): any => {
        if (rung === 1) {
          const body = buildAttemptBody(0);
          delete body.reasoning;
          delete body.thinking;
          delete body.enable_thinking;
          body.reasoning_effort = 'minimal';
          return body;
        }
        if (rung === 2) {
          const body = buildAttemptBody(0);
          delete body.reasoning;
          delete body.reasoning_effort;
          delete body.thinking;
          delete body.enable_thinking;
          return body;
        }
        const body: any = { ...baseBody };
        if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
        if (disableReasoning) {
          if (PARSE_ROLES.has(role)) {
            body.reasoning = { effort: 'none', exclude: true };
            body.reasoning_effort = 'none';
          } else if (role === 'standard') {
            body.reasoning = { effort: 'low', exclude: true };
          }
        }
        // Extra body JSON is merged last; null explicitly removes a provider field.
        for (const [key, value] of Object.entries(extraBody)) {
          if (value === null) delete body[key];
          else body[key] = value;
        }
        return body;
      };

      if (stream) {
        const streamAbort = new AbortController();
        const streamTimer = setTimeout(() => streamAbort.abort(), 300_000);
        res.on('close', () => { if (!res.writableEnded) streamAbort.abort(); clearTimeout(streamTimer); });
        const dropped = new Set<string>(); let swapMax = false; let reasoningRung: 0 | 1 | 2 = 0; const suffixes: string[] = [];
        let upstream: globalThis.Response | null = null;
        for (let i = 0; i < 5; i++) {
          const body = buildAttemptBody(reasoningRung);
          for (const field of dropped) delete body[field];
          if (swapMax && 'max_tokens' in body) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
          consumeAgentCall();
          upstream = await fetch(`${baseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: streamAbort.signal });
          if (upstream.ok) break;
          const errBody = await upstream.text(); let rung = '';
          if (upstream.status === 400 && reasoningRung < 2 && REASONING_400_RE.test(errBody) && ['reasoning','reasoning_effort','thinking','enable_thinking'].some(k => k in body)) { reasoningRung = (reasoningRung + 1) as 1 | 2; rung = reasoningRung === 1 ? '[r-min]' : '[r-off]'; }
          else if (upstream.status === 400 && !dropped.has('response_format') && /response_format|json[_ -]?mode|structured/i.test(errBody) && 'response_format' in body) { dropped.add('response_format'); rung = '[no-rf]'; }
          else if (upstream.status === 400 && !dropped.has('temperature') && /temperature/i.test(errBody) && 'temperature' in body) { dropped.add('temperature'); rung = '[no-temp]'; }
          else if (upstream.status === 400 && !dropped.has('max_tokens') && /max_tokens|max_completion_tokens/i.test(errBody) && 'max_tokens' in body) { swapMax = true; rung = '[mt-swap]'; }
          else if (upstream.status === 400 && !dropped.has('stream_options') && /stream_options/i.test(errBody) && 'stream_options' in body) { dropped.add('stream_options'); rung = '[no-stream-options]'; }
          if (!rung || i === 4) { clearTimeout(streamTimer); return res.status(upstream.status).json({ error: `Provider error (${upstream.status}): ${redactSensitiveText(errBody, providerSecrets(providerConfig))}` }); }
          suffixes.push(rung);
        }
        if (!upstream?.ok) return res.status(502).json({ error: 'Provider stream failed' });
        res.status(200); res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders?.();
        const emit = (event: string, data: any) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        for (const rung of suffixes) emit('info', { note: `Compatibility fallback ${rung}` });
        let content = '', reasoning = '', finish = 'stop'; let usage: any = null; const nativeTools: any[] = [];
        const effectiveLabel = label ? `${label}${suffixes.join('')}` : undefined;
        try {
          const ct = upstream.headers.get('content-type') || '';
          if (!ct.includes('text/event-stream')) {
            const bodyText = await upstream.text(); const d: any = parseUpstreamBody(bodyText);
            if (!d) throw new Error('Provider returned a non-JSON response.');
            const msg = d.choices?.[0]?.message || {}; content = typeof msg.content === 'string' ? msg.content : msg.content == null ? '' : JSON.stringify(msg.content);
            reasoning = msg.reasoning_content || msg.reasoning || ''; usage = d.usage; finish = d.choices?.[0]?.finish_reason || 'stop';
            if (content) emit('delta', { text: content });
            if (reasoning) emit('reasoning', { text: reasoning });
          } else {
            const reader = upstream.body!.getReader(); const decoder = new TextDecoder(); let buf = '';
            while (true) {
              const { value, done } = await reader.read(); if (done) break; buf += decoder.decode(value, { stream: true });
              let pos; while ((pos = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, pos); buf = buf.slice(pos + 2);
                const dat = frame.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('');
                if (!dat || dat === '[DONE]') continue;
                let chunk: any; try { chunk = JSON.parse(dat); } catch { continue; }
                if (chunk.usage) usage = chunk.usage;
                const choice = chunk.choices?.[0]; if (!choice) continue;
                if (choice.finish_reason) finish = choice.finish_reason;
                const delta = choice.delta || {};
                for (const part of delta.tool_calls || []) { const index = part.index || 0; nativeTools[index] ||= { function: { name: '', arguments: '' } }; nativeTools[index].function.name += part.function?.name || ''; nativeTools[index].function.arguments += part.function?.arguments || ''; }
                const textDelta = typeof delta.content === 'string' ? delta.content : '';
                const reasonDelta = delta.reasoning_content || delta.reasoning || '';
                if (textDelta) { content += textDelta; emit('delta', { text: textDelta }); }
                if (reasonDelta) { reasoning += reasonDelta; emit('reasoning', { text: reasonDelta }); }
              }
            }
          }
          const rawText = content || reasoning; const json = parseModelContent(rawText);
          emit('done', { json, ...(nativeTools.length ? { tool_calls: nativeTools.filter(Boolean) } : {}), ...(effectiveLabel ? { label: effectiveLabel } : {}), rawText, ...(reasoning ? { reasoningText: reasoning } : {}), finishReason: json === null ? finish : finish || 'stop', usage: { inputTokens: usage?.prompt_tokens || Math.ceil(text.length / 3), outputTokens: usage?.completion_tokens || Math.ceil((content.length + reasoning.length) / 3), cachedTokens: usage?.prompt_tokens_details?.cached_tokens || 0 } });
          res.end(); clearTimeout(streamTimer);
        } catch (streamError: any) { emit('error', { message: redactSensitiveText(streamError?.message || 'Upstream stream failed', providerSecrets(providerConfig)) }); res.end(); clearTimeout(streamTimer); }
        return;
      }

      // Independent, cumulative 400 compatibility fallbacks; at most five requests.
      let upstreamResponse: globalThis.Response | null = null;
      let upstreamBodyText = '';
      const dropped = new Set<string>();
      let swapMaxTokens = false;
      let reasoningRung: 0 | 1 | 2 = 0;
      const suffixes: string[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const attemptBody = buildAttemptBody(reasoningRung);
        for (const bit of dropped) delete attemptBody[bit];
        if (swapMaxTokens && 'max_tokens' in attemptBody) { attemptBody.max_completion_tokens = attemptBody.max_tokens; delete attemptBody.max_tokens; }
        consumeAgentCall();
        upstreamResponse = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST', headers,
          body: JSON.stringify(attemptBody),
          signal: AbortSignal.timeout(180_000),
        });
        upstreamBodyText = await upstreamResponse.text();
        if (upstreamResponse.ok) break;
        if (upstreamResponse.status !== 400) break;
        let rung: string | undefined;
        if (reasoningRung < 2 && REASONING_400_RE.test(upstreamBodyText) &&
            ['reasoning','reasoning_effort','thinking','enable_thinking'].some(k => k in attemptBody)) {
          reasoningRung = (reasoningRung + 1) as 1 | 2;
          rung = reasoningRung === 1 ? '[r-min]' : '[r-off]';
        } else if (!dropped.has('response_format') && /response_format|json[_ -]?mode|structured/i.test(upstreamBodyText) && 'response_format' in attemptBody) {
          dropped.add('response_format'); rung = '[no-rf]';
        } else if (!dropped.has('temperature') && /temperature/i.test(upstreamBodyText) && 'temperature' in attemptBody) {
          dropped.add('temperature'); rung = '[no-temp]';
        } else if (!dropped.has('max_tokens') && /max_tokens|max_completion_tokens/i.test(upstreamBodyText) && 'max_tokens' in attemptBody) {
          swapMaxTokens = true; rung = '[mt-swap]';
        } else if (!dropped.has('stream_options') && /stream_options/i.test(upstreamBodyText) && 'stream_options' in attemptBody) {
          dropped.add('stream_options'); rung = '[no-stream-options]';
        }
        if (!rung || attempt === 4) break;
        suffixes.push(rung);
        console.warn(`LLM ladder: ${label || role} rejected; retrying ${rung}...`);
      }
      const ladderSuffix = suffixes.join('');
      if (!upstreamResponse || !upstreamResponse.ok) {
        return res.status(upstreamResponse?.status || 502).json({
          error: `Provider error (${upstreamResponse?.status || 502}): ${redactSensitiveText(upstreamBodyText, providerSecrets(providerConfig))}`,
        });
      }

      const data: any = parseUpstreamBody(upstreamBodyText);
      if (!data) {
        return res.status(502).json({
          error: 'Provider returned a non-JSON response.'
        });
      }

      const effectiveLabel = label ? `${label}${ladderSuffix}` : undefined;
      if (ladderSuffix) {
        console.log(`LLM ladder: ${effectiveLabel} succeeded via rung${ladderSuffix}`);
      }

      const message = data.choices?.[0]?.message || {};
      const rawContent = message.content;
      const reasoningText = typeof (message.reasoning_content ?? message.reasoning) === 'string' ? (message.reasoning_content ?? message.reasoning) : '';
      const rawText = typeof rawContent === 'string' && rawContent.length > 0 ? rawContent : rawContent != null && typeof rawContent !== 'string' ? JSON.stringify(rawContent) : reasoningText;
      const parsedJson: any = parseModelContent(rawText);

      const usage = data.usage || {};
      const rawFinishReason = data.choices?.[0]?.finish_reason || 'stop';
      const finishReason = parsedJson === null ? (rawFinishReason || 'PARSE_ERROR') : rawFinishReason;
      const result: LLMResponse = {
        json: parsedJson,
        ...(effectiveLabel ? { label: effectiveLabel } : {}),
        usage: {
          inputTokens: usage.prompt_tokens || Math.ceil(text.length / 3),
          outputTokens: usage.completion_tokens || Math.ceil(rawText.length / 3),
          cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
        },
        rawText,
        ...(reasoningText ? { reasoningText } : {}),
        ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
        finishReason,
      };

      return res.json(result);
    }
  } catch (err: any) {
    console.error('[LLM proxy] Provider request failed; sensitive diagnostic details were omitted.');
    return res.status(500).json({
      error: redactSensitiveText(err?.message || 'Internal proxy error during LLM execution', providerSecrets(providerConfig)),
    });
  }
});

/**
 * Test connection endpoint
 */
app.post('/api/test-connection', async (req: Request, res: Response) => {
  const { providerConfig } = req.body || {};
  const kind = providerConfig?.kind || 'gemini';
  if (!['gemini', 'openai-compatible'].includes(kind)) return res.status(400).json({ ok: false, error: 'Unsupported provider type.' });
  if (kind === 'openai-compatible' && !validateProviderBaseUrl(providerConfig?.baseURL)) return res.status(400).json({ ok: false, error: 'Provider URL must be http(s), without credentials, query, or fragment.' });
  if (!validateHeaders(providerConfig?.defaultHeaders)) return res.status(400).json({ ok: false, error: 'Provider headers are invalid.' });
  if (providerConfig?.apiKey !== undefined && (typeof providerConfig.apiKey !== 'string' || providerConfig.apiKey.length > 8192)) return res.status(400).json({ ok: false, error: 'Provider API key field is invalid.' });

  try {
    if (kind === 'gemini') {
      const apiKey = providerConfig?.apiKey?.trim() || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(400).json({ ok: false, error: 'No Gemini API key provided' });
      }
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const t0 = Date.now();
      const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: 'ping',
        config: { maxOutputTokens: 5, temperature: 0 },
      });
      const latencyMs = Date.now() - t0;
      return res.json({ ok: true, latencyMs, sample: resp.text?.trim() });
    } else {
      const baseURL = (providerConfig?.baseURL || '').replace(/\/+$/, '');
      const apiKey = providerConfig?.apiKey?.trim() || '';
      const t0 = Date.now();
      const resp = await fetch(`${baseURL}/models`, {
        headers: { ...(providerConfig?.defaultHeaders || {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      });
      const latencyMs = Date.now() - t0;
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ ok: true, latencyMs, count: data.data?.length || 0 });
      } else {
        const text = await resp.text();
        return res.status(resp.status).json({ ok: false, error: `HTTP ${resp.status}: ${redactSensitiveText(text, providerSecrets(providerConfig))}` });
      }
    }
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: redactSensitiveText(err?.message || 'Connection failed', providerSecrets(providerConfig)) });
  }
});

/**
 * Fetch models endpoint
 */
app.post('/api/models', async (req: Request, res: Response) => {
  const { providerConfig } = req.body || {};
  const kind = providerConfig?.kind || 'gemini';
  if (!['gemini', 'openai-compatible'].includes(kind)) return res.status(400).json({ error: 'Unsupported provider type.' });
  if (kind === 'openai-compatible' && !validateProviderBaseUrl(providerConfig?.baseURL)) return res.status(400).json({ error: 'Provider URL must be http(s), without credentials, query, or fragment.' });
  if (!validateHeaders(providerConfig?.defaultHeaders)) return res.status(400).json({ error: 'Provider headers are invalid.' });
  if (providerConfig?.apiKey !== undefined && (typeof providerConfig.apiKey !== 'string' || providerConfig.apiKey.length > 8192)) return res.status(400).json({ error: 'Provider API key field is invalid.' });

  if (kind === 'gemini') {
    return res.json({
      models: [
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-3.8-flash',
        'gemini-3.1-flash-lite',
        'gemini-4-argon',
      ],
    });
  }

  try {
    const baseURL = (providerConfig?.baseURL || '').replace(/\/+$/, '');
    const apiKey = providerConfig?.apiKey?.trim() || '';
    const resp = await fetch(`${baseURL}/models`, {
      headers: { ...(providerConfig?.defaultHeaders || {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data: any = await resp.json();
    const list = Array.isArray(data.data) ? data.data.map((m: any) => m.id) : [];
    return res.json({ models: list });
  } catch (err: any) {
    return res.json({
      models: ['default-model', 'gpt-4o-mini', 'llama-3-8b-instruct'],
      fallback: true,
      error: redactSensitiveText(err?.message, providerSecrets(providerConfig)),
    });
  }
});

// Keep parser errors bounded and non-reflective; never echo submitted JSON or credentials.
app.use((err: any, _req: Request, res: Response, next: (error?: any) => void) => {
  if (res.headersSent) return next(err);
  const status = err?.status === 413 || err?.statusCode === 413 ? 413 : 400;
  return res.status(status).json({ error: status === 413 ? 'Request payload exceeds the configured size limit.' : 'Malformed or invalid request payload.' });
});

/**
 * Start Server with Vite Middleware in Development
 */
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: ['.e2b.app'] },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve('dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ExamParse server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
