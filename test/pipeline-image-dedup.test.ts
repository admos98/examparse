import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamDoc, ImageAsset, LLMRequest, LLMResponse, SourceLine } from '../src/types';
import type { ExtractedDocument } from '../src/pipeline/extract';
import { runFullPipeline } from '../src/pipeline';
import { LLMAdapter } from '../src/providers/adapter';
import { DEFAULT_SETTINGS } from '../src/store';
import { sha256 } from '../src/utils/hash';

const sourceLines: SourceLine[] = [
  { id: 'L0001', page: 1, text: 'Two-page image reference exam — 2 points' },
  { id: 'L0002', page: 1, text: '1. Identify the page-one diagram.' },
  { id: 'L0003', page: 2, text: '2. Identify the page-two diagram.' },
  { id: 'L0004', page: 3, text: 'Answer Key' },
  { id: 'L0005', page: 3, text: '1 A 2 B' },
];

const duplicateAssets: ImageAsset[] = [
  {
    id: 'duplicate_asset', page: 1, bbox: { x: 10, y: 10, w: 80, h: 60 }, mime: 'image/png', sha: 'page-one-sha', width: 80, height: 60,
    anchorLine: 2, blobKey: 'page_one_image', dataUrl: '/api/images/page_one_image', label: { role: 'decoration', kind: 'decoration' },
  },
  {
    id: 'duplicate_asset', page: 2, bbox: { x: 10, y: 10, w: 80, h: 60 }, mime: 'image/png', sha: 'page-two-sha', width: 80, height: 60,
    anchorLine: 3, blobKey: 'page_two_image', dataUrl: '/api/images/page_two_image', label: { role: 'decoration', kind: 'decoration' },
  },
];

const structureResponse: LLMResponse = {
  json: {
    m: { subject: 'Science', totalPoints: 2, language: 'en' },
    s: [{ id: 'sec_1', index: 1, p: [[1, 3]], kind: 'Other' }],
    q: [
      { n: 1, s: 'sec_1', t: 's', p: [[2, 2]], v: 1, c: 9, i: ['duplicate_asset'] },
      { n: 2, s: 'sec_1', t: 's', p: [[3, 3]], v: 1, c: 9, i: ['duplicate_asset'] },
    ],
  },
  rawText: 'fixture wire response',
  finishReason: 'STOP',
  usage: { inputTokens: 20, outputTokens: 20 },
};

test('pipeline saves page-aware image-id repairs for duplicate extraction assets', async () => {
  const file = new File(['duplicate image pipeline fixture'], 'duplicate-images.txt', { type: 'text/plain' });
  const fileHash = await sha256(await file.arrayBuffer());
  const extracted: ExtractedDocument = {
    lines: sourceLines,
    pages: 3,
    ocrUsed: false,
    fileName: file.name,
    images: duplicateAssets,
    scannedPageIndices: [],
    pageImages: [],
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  const originalExecute = LLMAdapter.execute;
  const originalFetch = globalThis.fetch;
  let savedDoc: ExamDoc | undefined;

  LLMAdapter.execute = (async (_request: LLMRequest) => structureResponse) as typeof LLMAdapter.execute;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    if (url.startsWith('/api/images/')) return new Response(new Blob(['fixture image'], { type: 'image/png' }));
    if (url.startsWith('/api/exams/')) {
      if (method === 'GET') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      if (method === 'PUT') {
        savedDoc = JSON.parse(String(init?.body)) as ExamDoc;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (url.startsWith('/api/memory/')) {
      if (method === 'GET') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('/api/cache/') || url.startsWith('/api/journals/')) {
      if (method === 'GET') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/usage') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ error: `Unexpected pipeline storage route ${method} ${url}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const result = await runFullPipeline(file, settings, { onStageUpdate: () => undefined }, { preExtracted: extracted, fileHash });
    assert.equal(new Set(result.images.map(image => image.id)).size, 2, 'returned document has unique image IDs');
    assert.ok(result.flags.some(flag => flag.code === 'IMAGE_ID_DUPLICATE' && flag.severity === 'warn'));

    const imageIdOnPage = (page: number) => result.images.find(image => image.page === page)?.id;
    assert.equal(result.questions.find(question => question.no === 1)?.images[0]?.imageId, imageIdOnPage(1));
    assert.equal(result.questions.find(question => question.no === 2)?.images[0]?.imageId, imageIdOnPage(2));
    assert.notEqual(imageIdOnPage(1), imageIdOnPage(2), 'page-two reference is not left pointing at page-one asset');

    assert.ok(savedDoc, 'pipeline persisted a document');
    assert.deepEqual(savedDoc.images.map(image => image.id), result.images.map(image => image.id));
    assert.deepEqual(
      savedDoc.questions.map(question => question.images.map(reference => reference.imageId)),
      result.questions.map(question => question.images.map(reference => reference.imageId)),
      'the saved document receives the validator result, not the pre-fix arrays',
    );
  } finally {
    LLMAdapter.execute = originalExecute;
    globalThis.fetch = originalFetch;
  }
});
