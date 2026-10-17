/**
 * Unified Provider Abstraction & Adapter (§7)
 */
import { LLMRequest, LLMResponse, ProviderConfig } from '../types';

export class LLMAdapter {
  /**
   * Execute an LLM call via the server proxy with auto-fallback and bisection if needed
   */
  static async execute(request: LLMRequest): Promise<LLMResponse> {
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
        console.warn('Attempting image batch bisection due to failure:', err.message);
        return await this.bisectAndExecute(request);
      }

      throw err;
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

    const [res1, res2] = await Promise.all([
      this.execute({ ...request, images: chunk1 }),
      this.execute({ ...request, images: chunk2 }),
    ]);

    // Merge array JSON responses (like image labeling)
    let mergedJson: any = [];
    if (Array.isArray(res1.json) && Array.isArray(res2.json)) {
      mergedJson = [...res1.json, ...res2.json];
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
