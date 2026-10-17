import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { LLMRequest, LLMResponse } from './src/types';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Up to 50MB for batched image payloads
app.use(express.json({ limit: '50mb' }));

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

      const startTime = Date.now();
      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config,
      });

      const rawText = response.text || '';
      let parsedJson: any = null;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (e) {
        // Strip possible markdown fences defensively
        const cleaned = rawText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
        parsedJson = JSON.parse(cleaned);
      }

      const inputTokens = response.usageMetadata?.promptTokenCount || Math.ceil(text.length / 3);
      const outputTokens = response.usageMetadata?.candidatesTokenCount || Math.ceil(rawText.length / 3);
      const cachedTokens = response.usageMetadata?.cachedContentTokenCount || 0;

      const result: LLMResponse = {
        json: parsedJson,
        usage: {
          inputTokens,
          outputTokens,
          cachedTokens,
        },
        rawText,
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

      const requestBody: any = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      };
      if (maxOutputTokens) {
        requestBody.max_tokens = maxOutputTokens;
      }

      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({
          error: `Provider error (${response.status}): ${errText}`,
        });
      }

      const data: any = await response.json();
      const rawText = data.choices?.[0]?.message?.content || '{}';
      let parsedJson: any = null;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        const cleaned = rawText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
        parsedJson = JSON.parse(cleaned);
      }

      const usage = data.usage || {};
      const result: LLMResponse = {
        json: parsedJson,
        usage: {
          inputTokens: usage.prompt_tokens || Math.ceil(text.length / 3),
          outputTokens: usage.completion_tokens || Math.ceil(rawText.length / 3),
          cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
        },
        rawText,
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
