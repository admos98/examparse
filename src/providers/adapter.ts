/**
 * Unified Provider Abstraction & Adapter (§7)
 */
import { hasCountingLoop } from '../pipeline/globalRead';
import { RepetitionBreaker, type BreakerTrip } from '../pipeline/streamBreaker';
import { LLMRequest, LLMResponse, ProviderConfig } from '../types';

export interface ExecuteOptions {
  onDelta?: (channel: 'output' | 'reasoning', fullText: string, chunk: string) => void;
  onInfo?: (note: string) => void;
  salvagePartial?: boolean;
  detectCountingLoop?: boolean;
  /** #50 Part A: abort when the same top-level JSON element completes 3 times. */
  detectRepetition?: boolean;
}

export class CountingLoopError extends Error {
  constructor(public outputTokens: number) { super('counting loop in read stream'); }
}
export class RepetitionLoopError extends Error {
  constructor(public trip: BreakerTrip) { super(`repetition loop in read stream (same item ×${trip.repeats} at item ${trip.completedItems})`); }
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
      // Image bundles are addressed evidence. A failed request is reported as failed; silently
      // splitting it would change the task, lose cross-image context, and violate endpoint limits.
      throw err;
    }
  }

  private static async executeStreaming(request: LLMRequest, opts: ExecuteOptions): Promise<LLMResponse> {
    let output = '', reasoning = '';
    const controller = new AbortController();
    const breaker = opts.detectRepetition ? new RepetitionBreaker() : undefined;
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
          else if (event === 'delta') {
            output += payload.text || '';
            if (opts.detectCountingLoop && hasCountingLoop(output)) { controller.abort(); throw new CountingLoopError(Math.ceil(output.length / 3)); }
            const trip = breaker?.push(payload.text || '');
            if (trip) { controller.abort(); reader.cancel().catch(() => undefined); throw new RepetitionLoopError(trip); }
            opts.onDelta?.('output', output, payload.text || '');
          }
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
      if (err instanceof RepetitionLoopError) {
        opts.onInfo?.(`stream cut — ${err.message}`);
        if (opts.salvagePartial && output) return { json: null, rawText: output, reasoningText: reasoning || undefined, finishReason: 'repetition-loop', breaker: { kind: 'repetition', completedItems: err.trip.completedItems }, usage: { inputTokens: Math.ceil(request.text.length / 3), outputTokens: Math.ceil(output.length / 3) } };
        throw err;
      }
      if (opts.salvagePartial && output) return { json: null, rawText: output, reasoningText: reasoning || undefined, finishReason: 'stream-died', usage: { inputTokens: Math.ceil(request.text.length / 3), outputTokens: Math.ceil((output.length + reasoning.length) / 3) } };
      opts.onInfo?.('stream-fallback');
      return this.execute(request);
    }
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
  }): Promise<{ results: Array<{ name: string; probability: number; choice?: string; distribution?: Record<string, number> }> }> {
    const { providerConfig, body, timeoutMs = 30000 } = params;
    // #46: the browser never calls a local provider directly (CORS/credentials). The thin server
    // proxy validates the typed decisions payload, including optional image pixels, and forwards it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerConfig, body }), signal: controller.signal });
      if (!response.ok) throw new Error(`Decisions endpoint HTTP ${response.status}`);
      const data = await response.json();
      return LLMAdapter.parseDecisionResponse(providerConfig, body, data);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shared decoder for the browser proxy and the report-only direct calibration CLI. */
  static parseDecisionResponse(providerConfig: ProviderConfig, body: any, data: any): {
    results: Array<{ name: string; probability: number; choice?: string; distribution?: Record<string, number> }>
  } {
      if (providerConfig.decideDialect === 'thx') {
        const item = Array.isArray(body.questions) ? body.questions[0] : (() => { const [name, value] = Object.entries(body.questions as any)[0] || ['', {}]; return { name, ...(value as any) }; })();
        const itemName = item.name || Object.keys(body.questions as any)[0];
        const raw = data?.answers?.[itemName] ?? data?.results?.[itemName] ?? data?.[itemName] ?? data?.probabilities ?? data;
        const choices = item.choices || item.levels || Object.keys(item.criteria || {});
        const map = raw && typeof raw === 'object' ? raw : {};
        const validNumber = (value: unknown) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
        const values = map.probabilities && typeof map.probabilities === 'object' ? map.probabilities : map;
        // #50 Part D: llama.cpp's native score (tools/server/server-decision.cpp, proven by the captured
        // fixture test/fixtures/systemone-llama-score-response.json): criteria is an ARRAY of level
        // descriptions and probabilities are keyed by the 0-based level index "0".."n-1". The returned
        // level is 1-based (index + 1); a missing/partial distribution is malformed, never guessed.
        if (item.type === 'score' && Array.isArray(item.criteria)) {
          const n = item.criteria.length;
          const keys = Array.from({ length: n }, (_, i) => String(i));
          if (n < 2 || !keys.every(k => validNumber(values[k]))) throw new Error('THX score response malformed');
          const probs = keys.map(k => Math.min(1, Math.max(0, Number(values[k]))));
          const best = probs.reduce((b, p, i) => p > probs[b] ? i : b, 0);
          return { results: [{ name: itemName, probability: probs[best], choice: String(best + 1), distribution: Object.fromEntries(probs.map((p, i) => [String(i + 1), p])) }] };
        }
        if (choices.length || item.type === 'choice' || item.type === 'score') {
          const candidates = choices.length ? choices : Object.keys(values).filter(c => validNumber(values[c]));
          const available = candidates.filter((c: string) => values[c] !== undefined && validNumber(values[c]));
          const answer = typeof map.answer === 'string' ? map.answer : typeof map.choice === 'string' ? map.choice : undefined;
          const choice = available.length ? available.reduce((best: string, c: string) => Number(values[c]) > Number(values[best]) ? c : best, available[0]) : answer;
          const rawProbability = choice !== undefined ? (values[choice] ?? map.probability) : map.probability;
          const probability = Number(rawProbability);
          if (!choice || !validNumber(rawProbability)) throw new Error('THX decision response malformed');
          return { results: [{ name: itemName, probability: Math.min(1, Math.max(0, probability)), choice, ...(available.length ? { distribution: Object.fromEntries(available.map((c: string) => [c, Math.min(1, Math.max(0, Number(values[c])))])) } : {}) }] };
        }
        const rawYes = values.yes ?? values.Yes ?? map.noul ?? map.probability;
        const yes = Number(rawYes);
        if (!validNumber(rawYes)) throw new Error('THX decision response malformed');
        return { results: [{ name: itemName, probability: Math.min(1, Math.max(0, yes)) }] };
      }
      if (!data || !Array.isArray(data.results)) throw new Error('Decisions endpoint returned no results array');
      return { results: data.results.filter((result: any) => result && result.probability !== null && result.probability !== undefined && result.probability !== '' && Number.isFinite(Number(result.probability))).map((result: any) => ({ name: String(result.name ?? ''), probability: Math.min(1, Math.max(0, Number(result.probability))), ...(result.choice === undefined ? {} : { choice: String(result.choice) }), ...(result.distribution && typeof result.distribution === 'object' ? { distribution: result.distribution } : {}) })) };
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
