import type { ExamDoc } from '../../src/types';

/** In-memory /api/exams, /api/cache, /api/images for pipeline tests (#41 shares it with the read-allowance suite). */
export function mockFolderStorage() {
  const saved = new Map<string, ExamDoc>();
  const cache = new Map<string, unknown>();
  const images = new Map<string, Uint8Array>();
  const originalFetch = globalThis.fetch;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input === 'object' && input && 'method' in input ? (input as any).method : 'GET');
    const examMatch = url.match(/^\/api\/exams\/([^/?]+)/);
    if (examMatch) {
      const id = decodeURIComponent(examMatch[1]);
      if (method === 'PUT') {
        saved.set(id, JSON.parse(String(init?.body)) as ExamDoc);
        return json({ ok: true });
      }
      if (method === 'GET') {
        const doc = saved.get(id);
        return doc ? json(doc) : json({ error: 'not found' }, 404);
      }
    }
    const cacheMatch = url.match(/^\/api\/cache\/([^/?]+)/);
    if (cacheMatch) {
      const key = decodeURIComponent(cacheMatch[1]);
      if (method === 'PUT') {
        cache.set(key, JSON.parse(String(init?.body)));
        return json({ ok: true });
      }
      if (method === 'GET') {
        return cache.has(key) ? json(cache.get(key)) : json({ error: 'not found' }, 404);
      }
    }
    const imageMatch = url.match(/^\/api\/images\/([^/?]+)/);
    if (imageMatch) {
      const key = decodeURIComponent(imageMatch[1]);
      if (method === 'PUT') {
        images.set(key, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
        return json({ ok: true });
      }
      if (method === 'GET') {
        const bytes = images.get(key) || new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        return new Response(bytes as any, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      }
    }
    if (url.startsWith('/api/')) return method === 'GET' ? json({ error: 'not found' }, 404) : json({ ok: true });
    return json({ ok: true });
  }) as typeof fetch;

  return {
    saved,
    cache,
    images,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
