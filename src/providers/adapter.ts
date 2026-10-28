/**
 * Unified Provider Abstraction & Adapter (§7)
 */
import { hasCountingLoop } from '../pipeline/globalRead';
import { LLMRequest, LLMResponse, ProviderConfig } from '../types';

export interface ExecuteOptions {
  onDelta?: (channel: 'output' | 'reasoning', fullText: string, chunk: string) => void;
  onInfo?: (note: string) => void;
  salvagePartial?: boolean;
  detectCountingLoop?: boolean;
}

export class CountingLoopError extends Error {
  constructor(public outputTokens: number) { super('counting loop in read stream'); }
}

export class LLMAdapter {
  /**
   * Execute an LLM call via the server proxy with auto-fallback and bisection if needed
   */
  static async execute(request: LLMRequest, opts?: ExecuteOptions): Promise<LLMResponse> {
    if (opts?.onDelta) return this.executeStreaming(request, opts);
    try {
      const response = await fetch('/api/llm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(errorData.error || `Proxy error (${response.status})`);
      }

      const data: LLMResponse = await response.json();
      return data;
    } catch (err: any) {
      // If error might be due to too many images on an OpenAI compatible endpoint, attempt bisection
      if (
        request.images &&
        request.images.length > 2 &&
        request.providerConfig?.kind === 'openai-compatible'
      ) {
        console.warn('Attempting image batch bisection after a provider request failure; error content was omitted.');
        return await this.bisectAndExecute(request);
      }

      throw err;
    }
  }

  private static async executeStreaming(request: LLMRequest, opts: ExecuteOptions): Promise<LLMResponse> {
    let output = '', reasoning = '';
    const controller = new AbortController();
    try {
      const response = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }), signal: controller.signal });
      if (!response.ok) throw new Error((await response.text()).slice(0, 500) || `HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Streaming response body unavailable');
      const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = frame.match(/^event:\s*(\w+)/m)?.[1] || 'message';
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!data) continue;
          const payload = JSON.parse(data);
          if (event === 'info') opts.onInfo?.(payload.note || '');
          else if (event === 'delta') { output += payload.text || ''; if (opts.detectCountingLoop && hasCountingLoop(output)) { controller.abort(); throw new CountingLoopError(Math.ceil(output.length / 3)); } opts.onDelta?.('output', output, payload.text || ''); }
          else if (event === 'reasoning') { reasoning += payload.text || ''; opts.onDelta?.('reasoning', reasoning, payload.text || ''); }
          else if (event === 'error') throw new Error(payload.message || 'Stream error');
          else if (event === 'done') return payload as LLMResponse;
        }
      }
      throw new Error('Stream ended before done event');
    } catch (err: any) {
      if (err instanceof CountingLoopError) {
        if (opts.salvagePartial && output) return { json: null, rawText: output, reasoningText: reasoning || undefined, finishReason: 'counting-loop', usage: { inputTokens: Math.ceil(request.text.length / 3), outputTokens: Math.ceil(output.length / 3) } };
        throw err;
      }
      if (opts.salvagePartial && output) return { json: null, rawText: output, reasoningText: reasoning || undefined, finishReason: 'stream-died', usage: { inputTokens: Math.ceil(request.text.length / 3), outputTokens: Math.ceil((output.length + reasoning.length) / 3) } };
      opts.onInfo?.('stream-fallback');
      return this.execute(request);
    }
  }

  /**
   * Auto-bisect an image batch if provider limits are exceeded
   */
  private static async bisectAndExecute(request: LLMRequest): Promise<LLMResponse> {
    const images = request.images || [];
    const mid = Math.ceil(images.length / 2);
    const chunk1 = images.slice(0, mid);
    const chunk2 = images.slice(mid);

    const chunk1Ids = new Set(chunk1.map(i => i.id));
    const chunk2Ids = new Set(chunk2.map(i => i.id));

    // Slice manifest/context text in request.text to only the images in that chunk
    const sliceManifestText = (text: string, allowedIds: Set<string>): string => {
      if (text.includes('MANIFEST:')) {
        const parts = text.split('MANIFEST:');
        const header = parts[0];
        const rest = parts.slice(1).join('MANIFEST:');
        const entries = rest.split(/\n---\n|\n=====\n/);
        const filteredEntries = entries.filter(e => {
          for (const id of allowedIds) {
            if (e.includes(`Image ${id}:`) || e.includes(`"${id}"`) || e.includes(id)) {
              return true;
            }
          }
          return false;
        });
        return `${header}MANIFEST:\n${filteredEntries.join('\n---\n')}\n\nReturn JSON: {"items": [...]} for the attached ${allowedIds.size} images.`;
      }
      return text;
    };

    const text1 = sliceManifestText(request.text, chunk1Ids);
    const text2 = sliceManifestText(request.text, chunk2Ids);

    const [res1, res2] = await Promise.all([
      this.execute({ ...request, images: chunk1, text: text1 }),
      this.execute({ ...request, images: chunk2, text: text2 }),
    ]);

    // Merge array or envelope JSON responses
    let mergedJson: any = [];
    if (Array.isArray(res1.json) && Array.isArray(res2.json)) {
      mergedJson = [...res1.json, ...res2.json];
    } else if (
      res1.json &&
      res2.json &&
      typeof res1.json === 'object' &&
      typeof res2.json === 'object' &&
      (Array.isArray((res1.json as any).items) || Array.isArray((res2.json as any).items))
    ) {
      mergedJson = {
        items: [...((res1.json as any).items || []), ...((res2.json as any).items || [])],
      };
    } else if (typeof res1.json === 'object' && typeof res2.json === 'object') {
      mergedJson = { ...(res1.json as any), ...(res2.json as any) };
    } else {
      mergedJson = res1.json;
    }

    return {
      json: mergedJson,
      usage: {
        inputTokens: res1.usage.inputTokens + res2.usage.inputTokens,
        outputTokens: res1.usage.outputTokens + res2.usage.outputTokens,
        cachedTokens: (res1.usage.cachedTokens || 0) + (res2.usage.cachedTokens || 0),
      },
      rawText: `${res1.rawText}\n---\n${res2.rawText}`,
    };
  }

  /**
   * #43/#46 Decision audit transport. POSTs the OpenAI-shaped decisions request
   * ({ input, questions: [{ type, name, instructions, choices?, input?, images?} ]}) to the
   * thin /api/decisions proxy, which forwards to the provider's decisions path.
   * No streaming, no reasoning fields, 30s timeout. The model never authors text;
   * it returns calibrated probabilities for typed questions.
   */
  static async executeDecisions(params: {
    providerConfig: ProviderConfig & { model: string };
    body: { input: unknown; questions: Array<{ type: string; name: string; instructions: string; choices?: string[]; input?: unknown; images?: Array<{ id: string; mime: string; data: string }> }> };
    timeoutMs?: number;
  }): Promise<{ results: Array<{ name: string; probability: number; choice?: string }> }> {
    const { providerConfig, body, timeoutMs = 30000 } = params;
    // #46: the browser never calls a local provider directly (CORS/credentials). The thin server
    // proxy validates the typed decisions payload, including optional image pixels, and forwards it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerConfig, body }), signal: controller.signal });
      if (!response.ok) throw new Error(`Decisions endpoint HTTP ${response.status}`);
      const data = await response.json();
      if (providerConfig.decideDialect === 'thx') {
        const item = Array.isArray(body.questions) ? body.questions[0] : (() => { const [name, value] = Object.entries(body.questions as any)[0] || ['', {}]; return { name, ...(value as any) }; })();
        const itemName = item.name || Object.keys(body.questions as any)[0];
        const raw = data?.results?.[itemName] ?? data?.[itemName] ?? data?.probabilities ?? data;
        const choices = item.choices || Object.keys(item.criteria || {});
        const map = raw && typeof raw === 'object' ? raw : {};
        if (choices.length) {
          const values = map.probabilities || map;
          const choice = choices.reduce((best: string, c: string) => Number(values[c] ?? 0) > Number(values[best] ?? 0) ? c : best, choices[0] as string);
          return { results: [{ name: itemName, probability: Math.min(1, Math.max(0, Number(values[choice]) || 0)), choice }] };
        }
        const yes = Number(map.yes ?? map.Yes ?? map.probabilities?.yes);
        if (!Number.isFinite(yes)) throw new Error('THX decision response malformed');
        return { results: [{ name: itemName, probability: Math.min(1, Math.max(0, yes)) }] };
      }
      if (!data || !Array.isArray(data.results)) throw new Error('Decisions endpoint returned no results array');
      return { results: data.results.map((result: any) => ({ name: String(result.name ?? ''), probability: Math.min(1, Math.max(0, Number(result.probability) || 0)), ...(result.choice === undefined ? {} : { choice: String(result.choice) }) })) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Test connection to a configured provider
   */
  static async testConnection(providerConfig: ProviderConfig & { model?: string }): Promise<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
    sample?: string;
  }> {
    try {
      const response = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerConfig }),
      });
      const data = await response.json();
      return data;
    } catch (err: any) {
      return { ok: false, error: err.message || 'Network error reaching test endpoint' };
    }
  }

  /**
   * Fetch available models from provider
   */
  static async fetchModels(providerConfig: ProviderConfig): Promise<string[]> {
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerConfig }),
      });
      const data = await response.json();
      return data.models || [];
    } catch {
      return providerConfig.kind === 'gemini'
        ? ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.8-flash']
        : ['default-model'];
    }
  }
}
