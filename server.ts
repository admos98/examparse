import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { LLMRequest, LLMResponse, getDisplayName } from './src/types';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Up to 50MB for batched image payloads
app.use(express.json({ limit: '50mb' }));

/* ------------------------------------------------------------------ */
/* Folder-backed storage (A)                                           */
/* ------------------------------------------------------------------ */
const DATA_DIR = process.env.EXAMFORGE_DATA_DIR || path.join(process.cwd(), 'data');
const EXAMS_DIR = path.join(DATA_DIR, 'exams');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
for (const d of [DATA_DIR, EXAMS_DIR, IMAGES_DIR, CACHE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

function assertInsideDir(res: Response, dir: string, file: string): string | null {
  const base = path.resolve(dir);
  const resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    res.status(400).json({ error: 'Path escapes data directory' });
    return null;
  }
  return resolved;
}
function safeSegment(res: Response, value: string): boolean {
  if (!SAFE_SEGMENT.test(value || '')) {
    res.status(400).json({ error: `Invalid path segment: ${value}` });
    return false;
  }
  return true;
}
function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
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
    sectionCount: Array.isArray(doc.sections) ? doc.sections.length : 0,
    imageCount: Array.isArray(doc.images) ? doc.images.length : 0,
    ocrUsed: Boolean(doc.source?.ocrUsed),
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

app.get('/api/storage/health', (_req: Request, res: Response) => {
  return res.json({ mode: 'folder', dir: DATA_DIR, examCount: listExamFiles().length, totalBytes: dirStats(DATA_DIR) });
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
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'ExamDoc JSON body required' });
  atomicWriteJson(file, req.body);
  return res.json({ ok: true, id: req.params.id });
});

app.delete('/api/exams/:id', (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.id)) return;
  const file = assertInsideDir(res, EXAMS_DIR, path.join(EXAMS_DIR, `${req.params.id}.json`));
  if (!file) return;
  if (fs.existsSync(file)) fs.unlinkSync(file);
  // Orphan-sweep images by scanning remaining exam files (image blobKeys + page thumb keys).
  const referenced = new Set<string>();
  for (const f of listExamFiles()) {
    const doc = readJsonFile<any>(f, null);
    for (const img of doc?.images || []) { if (img.blobKey) referenced.add(img.blobKey); if (img.sha) referenced.add(img.sha); }
    for (const k of doc?.source?.pageThumbKeys || []) referenced.add(k);
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

app.put('/api/images/:sha', express.raw({ type: () => true, limit: '32mb' }), (req: Request, res: Response) => {
  if (!safeSegment(res, req.params.sha)) return;
  const mime = String(req.query.mime || 'application/octet-stream');
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
  atomicWriteJson(SETTINGS_FILE, req.body ?? null);
  return res.json({ ok: true });
});

app.get('/api/usage', (_req: Request, res: Response) => {
  return res.json(readJsonFile<any[]>(USAGE_FILE, []));
});
app.post('/api/usage', (req: Request, res: Response) => {
  const current = readJsonFile<any[]>(USAGE_FILE, []);
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const next = [...current, ...incoming.filter(Boolean)].slice(-500);
  atomicWriteJson(USAGE_FILE, next);
  return res.json({ ok: true, count: next.length });
});
app.put('/api/usage', (req: Request, res: Response) => {
  const next = (Array.isArray(req.body) ? req.body : []).slice(-500);
  atomicWriteJson(USAGE_FILE, next);
  return res.json({ ok: true, count: next.length });
});
app.delete('/api/usage', (_req: Request, res: Response) => {
  atomicWriteJson(USAGE_FILE, []);
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
    console.warn('extraBodyJson is invalid JSON; ignoring it:', err?.message || err);
    return {};
  }
}

/**
 * Single thin proxy route POST /api/llm (§7)
 */
app.post('/api/llm', async (req: Request, res: Response) => {
  const payload: LLMRequest = req.body;
  const { role, system, text, images, jsonSchema, maxOutputTokens, label, providerConfig } = payload;

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
        responseMimeType: 'application/json',
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

      const startTime = Date.now();
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
        response_format: { type: 'json_object' },
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
        if (disableReasoning) {
          if (PARSE_ROLES.has(role)) {
            body.reasoning = { effort: 'none', exclude: true };
            body.reasoning_effort = 'none';
          } else if (role === 'standard') {
            body.reasoning = { effort: 'low', exclude: true };
          }
        }
        // Extra body JSON is merged LAST on the primary rung: user keys win.
        Object.assign(body, extraBody);
        return body;
      };

      // 400-fallback ladder: at most 2 retries, only for reasoning/thinking-related 400s.
      let upstreamResponse: globalThis.Response | null = null;
      let upstreamBodyText = '';
      let ladderSuffix = '';
      for (let attempt = 0; attempt <= 2; attempt++) {
        const attemptBody = buildAttemptBody(attempt as 0 | 1 | 2);
        ladderSuffix = attempt === 1 ? ' [r-min]' : attempt === 2 ? ' [r-off]' : '';
        upstreamResponse = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(attemptBody),
          signal: AbortSignal.timeout(180_000),
        });
        upstreamBodyText = await upstreamResponse.text();
        if (upstreamResponse.ok) break;
        const canLadder =
          disableReasoning ||
          'reasoning' in attemptBody ||
          'reasoning_effort' in attemptBody ||
          'thinking' in attemptBody ||
          'enable_thinking' in attemptBody;
        if (
          upstreamResponse.status !== 400 ||
          attempt >= 2 ||
          !canLadder ||
          !REASONING_400_RE.test(upstreamBodyText)
        ) {
          return res.status(upstreamResponse.status).json({
            error: `Provider error (${upstreamResponse.status}): ${upstreamBodyText}`,
          });
        }
        console.warn(
          `LLM ladder: ${label || role} rung ${attempt} rejected (400, reasoning-related); retrying rung ${attempt + 1}...`
        );
      }

      if (!upstreamResponse || !upstreamResponse.ok) {
        return res.status(502).json({
          error: `Provider error: ${upstreamBodyText.slice(0, 300)}`,
        });
      }

      const data: any = parseUpstreamBody(upstreamBodyText);
      if (!data) {
        return res.status(502).json({
          error: `Provider returned non-JSON response: ${upstreamBodyText.slice(0, 300)}`,
        });
      }

      const effectiveLabel = label ? `${label}${ladderSuffix}` : undefined;
      if (ladderSuffix) {
        console.log(`LLM ladder: ${effectiveLabel} succeeded via rung${ladderSuffix}`);
      }

      const rawContent = data.choices?.[0]?.message?.content;
      const rawText = typeof rawContent === 'string' ? rawContent : rawContent != null ? JSON.stringify(rawContent) : '';
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
        finishReason,
      };

      return res.json(result);
    }
  } catch (err: any) {
    console.error('LLM proxy call error:', err?.message || err);
    return res.status(500).json({
      error: err?.message || 'Internal proxy error during LLM execution',
    });
  }
});

/**
 * Test connection endpoint
 */
app.post('/api/test-connection', async (req: Request, res: Response) => {
  const { providerConfig } = req.body;
  const kind = providerConfig?.kind || 'gemini';

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
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const latencyMs = Date.now() - t0;
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ ok: true, latencyMs, count: data.data?.length || 0 });
      } else {
        const text = await resp.text();
        return res.status(resp.status).json({ ok: false, error: `HTTP ${resp.status}: ${text}` });
      }
    }
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'Connection failed' });
  }
});

/**
 * Fetch models endpoint
 */
app.post('/api/models', async (req: Request, res: Response) => {
  const { providerConfig } = req.body;
  const kind = providerConfig?.kind || 'gemini';

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
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
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
      error: err.message,
    });
  }
});

/**
 * Start Server with Vite Middleware in Development
 */
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
