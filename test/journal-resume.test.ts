import test from 'node:test';
import assert from 'node:assert/strict';
import type { LLMRequest, LLMResponse, SourceLine } from '../src/types';

const cache = new Map<string, any>();
const calls: LLMRequest[] = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (path === '/api/storage/health') return new Response(JSON.stringify({ mode: 'folder', dir: '/test' }), { status: 200 });
  if (path.startsWith('/api/cache/')) {
    const key = decodeURIComponent(path.slice('/api/cache/'.length));
    if (init?.method === 'PUT') {
      cache.set(key, JSON.parse(String(init.body || 'null')));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (init?.method === 'DELETE') { cache.delete(key); return new Response('{}', { status: 200 }); }
    if (!cache.has(key)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(cache.get(key)), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const { runStructurePass } = await import('../src/pipeline/structure');
const { LLMAdapter } = await import('../src/providers/adapter');

const response = (json: unknown, label?: string): LLMResponse => ({
  json, rawText: JSON.stringify(json), finishReason: 'STOP', label,
  usage: { inputTokens: 80, outputTokens: 20, cachedTokens: 0 },
});

// Resume uses the journal, tags key lines on continuation, and marks complete only after coverage is satisfied.
test('journal resume continues from raw partial output and completes only full printed-number coverage', async () => {
  const journalKey = 'resume-fixture';
  const journalCacheKey = 'journal_structure_resume-fixture';
  cache.set(journalCacheKey, {
    updatedAt: new Date().toISOString(), complete: false,
    calls: [{
      ts: new Date().toISOString(), label: 'Structure Pass',
      rawText: JSON.stringify({
        m: { totalPoints: 2 }, s: [{ id: 'sec_1', index: 1, p: [[1, 4]], kind: 'Other' }],
        q: [{ n: 1, s: 'sec_1', t: 's', p: [[1, 1]], v: 1, c: 9 }],
      }),
      finishReason: 'length', usage: { inputTokens: 100, outputTokens: 90 }, complete: true,
    }],
  });
  const sourceLines: SourceLine[] = [
    { id: 'L0001', page: 1, text: '1. First question' },
    { id: 'L0002', page: 1, text: '2. Second question' },
    { id: 'L0003', page: 1, text: 'Answer Key' },
    { id: 'L0004', page: 1, text: '1. A 2. B' },
  ];
  const originalExecute = LLMAdapter.execute;
  LLMAdapter.execute = (async (request: LLMRequest) => {
    calls.push(request);
    assert.match(request.text, /\[L0004\] \[KEY\] 1\. A 2\. B/);
    return response({ m: { totalPoints: 2 }, s: [{ id: 'sec_1', index: 1, p: [[1, 4]], kind: 'Other' }], q: [{ n: 2, s: 'sec_1', t: 's', p: [[2, 2]], v: 1, c: 9 }] }, request.label);
  }) as typeof LLMAdapter.execute;
  try {
    const result = await runStructurePass({
      sourceLines, images: [], languageHint: 'en', latexEnabled: false,
      providerConfig: { kind: 'openai-compatible', id: 'mock', name: 'Mock', model: 'gpt-4o', baseURL: 'https://example.com/v1' },
      maxBudgetTokens: 8192, journalEnabled: true, journalKey,
    });
    assert.equal(calls.length, 1);
    assert.equal(result.rawQuestions.length, 2);
    assert.equal(result.jsonNull, false);
    assert.ok(result.flags?.some(flag => flag.code === 'RESUMED_FROM_JOURNAL'));
    const saved = cache.get(journalCacheKey);
    assert.equal(saved.complete, true);
    assert.equal(saved.calls.length, 2);
  } finally {
    LLMAdapter.execute = originalExecute;
    globalThis.fetch = previousFetch;
  }
});
