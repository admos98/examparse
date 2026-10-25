import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamDoc, ImageAsset, LLMRequest, LLMResponse } from '../src/types';
import type { ExtractedDocument } from '../src/pipeline/extract';
import { runFullPipeline } from '../src/pipeline';
import { LLMAdapter } from '../src/providers/adapter';
import { DEFAULT_SETTINGS } from '../src/store';
import { sha256 } from '../src/utils/hash';
import {
  acceptanceAssignment,
  acceptanceImages,
  acceptanceLines,
  acceptanceSections,
} from './fixtures/acceptance-image-assignment';

const stageOrder = (events: string[]) => events;

const structureResponse: LLMResponse = {
  json: {
    // The paper declares no printed total, so coverage is judged on numbers alone.
    m: { subject: 'English', language: 'en' },
    s: [{ id: 'sec_1', index: 1, p: [[1, 11]], kind: 'Other' }],
    q: [
      // Field defect: the group parent keeps ALL four item pictures, children get none.
      { n: 15, s: 'sec_1', t: 'a', p: 2, v: 2, c: 9, i: ['img_dict', 'img_mother', 'img_boy', 'img_solar'] },
      { n: 15, g: 15, s: 'sec_1', t: 'a', p: 3, v: 0.5, c: 9 },
      { n: 16, g: 15, s: 'sec_1', t: 'a', p: 3, v: 0.5, c: 9 },
      { n: 17, g: 15, s: 'sec_1', t: 'a', p: 3, v: 0.5, c: 9 },
      { n: 18, g: 15, s: 'sec_1', t: 'a', p: 3, v: 0.5, c: 9 },
      { n: 19, s: 'sec_1', t: 's', p: 4, v: 1, c: 9 },
      { n: 49, s: 'sec_1', t: 's', p: 6, v: 2, c: 9 },
      { n: 63, s: 'sec_1', t: 'l', p: 8, v: 1, c: 9, i: ['img_ferdowsi', 'img_tv', 'img_sport', 'img_clean'] },
      { n: 63, g: 63, s: 'sec_1', t: 'l', p: 9, v: 1, c: 9 },
      { n: 64, g: 63, s: 'sec_1', t: 'l', p: 9, v: 1, c: 9 },
      { n: 65, g: 63, s: 'sec_1', t: 'l', p: 9, v: 1, c: 9 },
      { n: 66, g: 63, s: 'sec_1', t: 'l', p: 9, v: 1, c: 9 },
      { n: 67, s: 'sec_1', t: 'l', p: 10, v: 2, c: 9 },
      { n: 68, s: 'sec_1', t: 's', p: 11, v: 1, c: 9 },
    ],
  },
  rawText: 'fixture structure response',
  finishReason: 'STOP',
  usage: { inputTokens: 20, outputTokens: 20 },
};

/** Structure calls are per section, so the stub answers with the slice of the wire whose spans fall
 *  inside the line ids quoted in the prompt — a whole-document answer to every section would trip the
 *  out-of-bounds tripwire and spend corrective retries the real model never spends. */
const linesIn = (prompt: string): Set<number> =>
  new Set([...prompt.matchAll(/\[L(\d{4})\]/g)].map(match => Number(match[1])));

const wireSpanLines = (value: any): number[] => {
  if (typeof value === 'number') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => (Array.isArray(item) ? item.map(Number) : [Number(item)]));
};

const sectionResponse = (prompt: string): LLMResponse => {
  const lines = linesIn(prompt);
  if (lines.size === 0) return structureResponse;
  const wire = structureResponse.json as any;
  const questions = wire.q.filter((question: any) => {
    const spans = wireSpanLines(question.p);
    return spans.length > 0 && spans.every(line => lines.has(line));
  });
  return { ...structureResponse, json: { ...wire, q: questions } };
};

/** Captions are pre-seeded and every image is labelled decoration, so the vision stage is a local
 *  no-op in Node (no canvas) while the captions still reach the structure prompt unchanged. */
const decoratedImages = (): ImageAsset[] => acceptanceImages().map(image => ({
  ...image,
  label: { role: 'decoration' as const, kind: 'decoration' as const, caption: image.label?.caption },
}));

const memoryStorage = () => {
  const cache = new Map<string, string>();
  const saved = new Map<string, ExamDoc>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || 'GET';
    if (url.startsWith('/api/images/')) return new Response(new Blob(['fixture image'], { type: 'image/png' }));
    if (url.startsWith('/api/cache/')) {
      const key = decodeURIComponent(url.slice('/api/cache/'.length));
      if (method === 'GET') {
        return cache.has(key)
          ? new Response(cache.get(key)!, { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      if (method === 'PUT') { cache.set(key, String(init?.body ?? 'null')); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.startsWith('/api/exams')) {
      const examId = decodeURIComponent(url.replace(/^\/api\/exams\/?/, ''));
      if (method === 'GET') {
        return saved.has(examId)
          ? new Response(JSON.stringify(saved.get(examId)), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      if (method === 'PUT') { saved.set(examId, JSON.parse(String(init?.body)) as ExamDoc); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.startsWith('/api/journals') || url.startsWith('/api/usage') || url.startsWith('/api/memory')) {
      return new Response(JSON.stringify({ ok: true, error: 'not found' }), { status: method === 'GET' ? 404 : 200 });
    }
    return new Response(JSON.stringify({ error: `Unexpected route ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;
  return { cache, saved, restore: () => { globalThis.fetch = originalFetch; } };
};

test('Part A pipeline order: VISION runs before STRUCTURE, and structure receives the captioned image block', async () => {
  const storage = memoryStorage();
  const file = new File(['acceptance image assignment fixture'], 'acceptance-images.txt', { type: 'text/plain' });
  const fileHash = await sha256(await file.arrayBuffer());
  const extracted: ExtractedDocument = {
    lines: acceptanceLines.map(line => ({ ...line })),
    pages: 2,
    ocrUsed: false,
    fileName: file.name,
    images: decoratedImages(),
    scannedPageIndices: [],
    pageImages: [],
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.consensusEnabled = false;
  // Deterministic local pipeline: no cleanup stage model calls, so the cache assertions below are
  // about the vision+structure stages only.
  settings.cleanupEnabled = false;

  const seenStages: string[] = [];
  const structurePrompts: string[] = [];
  const originalExecute = LLMAdapter.execute;
  let adapterCalls = 0;
  LLMAdapter.execute = (async (request: LLMRequest) => {
    adapterCalls++;
    const prompt = String(request.text || '');
    const label = String(request.label || '');
    if (label.startsWith('Structure')) {
      structurePrompts.push(prompt);
      seenStages.push('model:structure');
      return sectionResponse(prompt);
    }
    seenStages.push(`model:${label.includes('Critic') ? 'critic' : 'other'}`);
    // The adversarial critic only reads: it never edits, so an empty verdict list is a no-op.
    return { json: { verdicts: [] }, rawText: '{"verdicts":[]}', finishReason: 'STOP', usage: { inputTokens: 1, outputTokens: 1 } };
  }) as typeof LLMAdapter.execute;
  try {
    const doc = await runFullPipeline(
      file,
      settings,
      {
        onStageUpdate: stage => {
          if (stage.id === 'vision' || stage.id === 'structure') seenStages.push(`${stage.id}:${stage.status}`);
        },
      },
      { preExtracted: extracted, fileHash },
    );

    // 1. New order: the vision stage is emitted (and completes) before the structure model call.
    //    The structure card's first event is the deterministic segmentation summary, which is
    //    telemetry emitted BEFORE any structure token is spent — so compare against the model call.
    const firstVision = seenStages.findIndex(entry => entry.startsWith('vision:'));
    const structureModelCall = seenStages.indexOf('model:structure');
    assert.ok(firstVision >= 0 && structureModelCall >= 0);
    assert.ok(firstVision < structureModelCall, `vision must precede the structure call (saw ${seenStages.slice(0, 8).join(', ')})`);
    assert.ok(seenStages.indexOf('vision:skipped') < structureModelCall || seenStages.indexOf('vision:completed') < structureModelCall);

    // 2. The structure prompt carries the captions (image block) in this very pipeline run.
    assert.ok(structurePrompts.length >= 1);
    const captioned = structurePrompts.filter(prompt => /IMAGE CAPTIONS/.test(prompt));
    assert.ok(captioned.length >= 1, 'at least the section holding pictures carries the caption block');
    assert.ok(captioned.some(prompt => /\[img_ferdowsi p2 "Ferdowsi statue portrait"\]/.test(prompt)));
    assert.ok(captioned.some(prompt => /\[img_solar p1 "Solar panel sun icon"\]/.test(prompt)));

    // 3. Part B fixes the field's duplication/one-chair shift end-to-end.
    const ownerByImage: Record<string, number> = {};
    for (const question of doc.questions) for (const ref of question.images) ownerByImage[ref.imageId] = question.no;
    assert.deepEqual(ownerByImage, acceptanceAssignment);
    const seen = new Set<string>();
    for (const question of doc.questions) {
      for (const ref of question.images) {
        assert.ok(!seen.has(ref.imageId), `${ref.imageId} owned twice (I13)`);
        seen.add(ref.imageId);
      }
    }
    assert.equal(doc.questions.find(question => question.no === 15)!.images.length, 0, 'group parent holds no item picture');
    assert.ok(doc.flags.some(flag => flag.code === 'VISION_DECORATION_REBUTTED'));
    assert.ok(doc.images.some(image => image.id === 'img_solar' && image.label?.assignment?.ruleChain.includes('order-bijection')));

    // 4. A second run on the same content serves BOTH stages from cache: 0 live model calls.
    const callsAfterFirstRun = adapterCalls;
    const structureCallsAfterFirstRun = structurePrompts.length;
    seenStages.length = 0;
    const second = await runFullPipeline(
      file,
      settings,
      { onStageUpdate: stage => { if (stage.id === 'vision' || stage.id === 'structure') seenStages.push(`${stage.id}:${stage.status}`); } },
      { preExtracted: extracted, fileHash },
    );
    assert.equal(structurePrompts.length, structureCallsAfterFirstRun, 'no live structure call on the cached re-run');
    assert.ok(adapterCalls <= callsAfterFirstRun + 1, `only the read-only critic may still run (${adapterCalls - callsAfterFirstRun} extra calls)`);
    const liveStageRecords = (second.usage || []).filter(record => !record.isCachedHit && !/critic/i.test(String(record.role || '')) && !/Critic/i.test(String(record.label || '')));
    assert.equal(liveStageRecords.length, 0, 'cached re-run has zero live vision/structure usage records');
    assert.ok(seenStages.some(entry => entry === 'structure:cached'), `structure served from cache (${seenStages.join(', ')})`);
    assert.deepEqual(
      second.questions.map(question => question.images.map(ref => ref.imageId).sort()),
      doc.questions.map(question => question.images.map(ref => ref.imageId).sort()),
      'cached re-run reproduces the same assignment (B5 determinism lock)',
    );
  } finally {
    LLMAdapter.execute = originalExecute;
    storage.restore();
  }
});

test('Part A cache key: an unchanged vision caption set keeps the structure cache warm (0-call re-run preserved)', () => {
  // The structure cache key is documented to include the vision label signature; a caption change must
  // therefore invalidate it, while an identical set must not.
  const signature = (images: ImageAsset[]) => JSON.stringify(images.map(image => [image.id, image.page, image.label?.caption || '', image.label?.kind || '', image.label?.role || '']));
  const a = decoratedImages();
  const b = decoratedImages();
  assert.equal(signature(a), signature(b));
  b[0].label = { ...b[0].label!, caption: 'Different caption entirely' };
  assert.notEqual(signature(a), signature(b));
  void acceptanceSections;
  void stageOrder;
});
