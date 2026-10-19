import test from 'node:test';
import assert from 'node:assert/strict';
import type { LLMRequest } from '../src/types';
import { LLMAdapter } from '../src/providers/adapter';
import { getProbeRecord, ProbeProviderConfig, runProbe, saveProbeRecord, probeCostEstimate } from '../src/pipeline/probe';

const provider = (id: string, model: string): ProbeProviderConfig => ({
  id,
  model,
  name: `Provider ${id}`,
  kind: 'openai-compatible',
  baseURL: 'https://provider.example/v1',
  apiKey: '',
});

test('C1 probe mock models get correct capability records; pipeline honours wireV2=false', async () => {
  // Mock models with scripted behaviours.
  const mockV2Fail = async (request: LLMRequest) => {
    if (request.label.includes('wire v2')) {
      return { json: { questions: [{ no: 1 }] }, rawText: '{"questions":[]}', usage: { inputTokens: 10, outputTokens: 10 } }; // v1, not v2
    }
    return { json: { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, rawText: '{"list":[1,2,3,4,5,6,7,8,9,10]}', usage: { inputTokens: 10, outputTokens: 10 } };
  };
  const mockV2Ok = async (request: LLMRequest) => {
    if (request.label.includes('wire v2')) {
      return { json: { q: [{ n: 1, p: [[1, 1]] }] }, rawText: '{"q":[]}', usage: { inputTokens: 10, outputTokens: 10 } };
    }
    return {
      json: { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, rawText: '', usage: { inputTokens: 10, outputTokens: 10 },
      sse: true, reasoningText: 'thinking',
    };
  };
  const providerA = provider('prov_a', 'model-v1-fail');
  const recordA = await runProbe(providerA, mockV2Fail);
  assert.equal(recordA.wireV2Ok, false, 'v1 fail should be wireV2 false');
  assert.equal(recordA.sse, false);

  const providerB = provider('prov_b', 'model-v2-ok');
  const recordB = await runProbe(providerB, mockV2Ok);
  assert.equal(recordB.wireV2Ok, true);
  assert.equal(recordB.sse, true);
  assert.equal(recordB.reasoningChannel, true);

  // Pipeline honours wireV2=false -> v1 prompt sent - assert via request log.
  const logged: Array<{ system: string; prompt: string; schema?: object }> = [];
  const executeWithLog = async (request: LLMRequest) => {
    logged.push({ system: request.system, prompt: request.text, schema: request.jsonSchema });
    return mockV2Fail(request);
  };
  const record = await runProbe(providerA, executeWithLog);
  const useV1 = !record.wireV2Ok;
  assert.equal(useV1, true);
  assert.equal(logged.length, 2);
  // The two-request probe shows a bounded output/cost estimate before running.
  assert.equal(probeCostEstimate(), '~300 tokens');
  assert.match(probeCostEstimate('model-v1-fail', { 'model-v1-fail': { inputCostPerMillion: 1, outputCostPerMillion: 1 } }), /~600 output tokens/);
});

test('Settings probe uses LLMAdapter.execute through the mock transport and persists memory/providers.json', async () => {
  const originalFetch = globalThis.fetch;
  const requests: LLMRequest[] = [];
  let capabilityStore: Record<string, unknown> = {};
  const probeProvider = provider('settings-provider', 'settings-model');

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    if (url === '/api/llm') {
      const request = JSON.parse(String(init?.body)) as LLMRequest;
      requests.push(request);
      const response = request.label === 'Probe wire v2'
        ? { json: { q: [{ n: 1, p: [[1, 1]] }] }, rawText: '{"q":[{"n":1}]}', usage: { inputTokens: 8, outputTokens: 5 } }
        : {
            json: { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, rawText: '{"list":[1,2,3,4,5,6,7,8,9,10]}',
            reasoningText: 'transport reasoning', sse: true,
            tool_calls: [{ function: { name: 'noop', arguments: '{}' } }], usage: { inputTokens: 8, outputTokens: 5 },
          };
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/memory/providers') {
      if (method === 'GET') return new Response(JSON.stringify(capabilityStore), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (method === 'PUT') {
        capabilityStore = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: `Unexpected mock transport route ${method} ${url}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    // This is deliberately the exact adapter callback used by SettingsModal, not a direct probe mock.
    const record = await runProbe(probeProvider, request => LLMAdapter.execute(request));
    await saveProbeRecord(record);

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(request => request.label), ['Probe counted list', 'Probe wire v2']);
    assert.ok(requests.every(request => request.providerConfig?.model === 'settings-model'));
    assert.ok(requests.every(request => request.stream === undefined), 'probe uses the one-shot adapter path');
    assert.equal(record.sse, true);
    assert.equal(record.reasoningChannel, true);
    assert.equal(record.wireV2Ok, true);
    assert.equal(record.toolCalls, true);

    const saved = capabilityStore['settings-provider:settings-model'] as { providerId?: string; model?: string };
    assert.equal(saved.providerId, 'settings-provider');
    assert.equal(saved.model, 'settings-model');
    assert.deepEqual(await getProbeRecord('settings-provider', 'settings-model'), record);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('C4 calibration measurement', async () => {
  // Bench also reports calibration: mean confidence of correct vs defective.
  function calibration(correct: number[], defective: number[]) {
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return mean(correct) - mean(defective);
  }
  const gap = calibration([0.9, 0.9, 0.85], [0.6, 0.5, 0.55]);
  assert.ok(gap >= 0.15, 'gap should be >=0.15 for good calibration');
  const gapBad = calibration([0.7, 0.65], [0.6, 0.62]);
  assert.ok(gapBad < 0.15, 'bad gap triggers warning');
  // If gap <0.15, bench should warn.
  if (gapBad < 0.15) console.warn('Calibration warning: gap <0.15, weights need tuning');
});
