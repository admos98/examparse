import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExamDoc, ImageAsset, LLMRequest, LLMResponse, SourceLine } from '../src/types';
import type { ExtractedDocument } from '../src/pipeline/extract';
import {
  READ_OVERLAP_LINES,
  assembleReadProposal,
  buildReadChunks,
  cloudPageRead,
  mergePageProposals,
  parseReadProposal,
  runGlobalReadStage,
  validatePageProposal,
  type PageReadCache,
  type PageReadCacheEntry,
} from '../src/pipeline/globalRead';
import { computeDefects } from '../src/pipeline/defects';
import { runFullPipeline, retryFailedPage } from '../src/pipeline';
import { LLMAdapter } from '../src/providers/adapter';
import { DEFAULT_SETTINGS } from '../src/store';
import { sha256 } from '../src/utils/hash';
import { computeAttention } from '../src/utils/attention';
import { IntegrityFlags } from '../src/components/IntegrityFlags';
import { buildExportDoc, parseReportForDoc } from '../src/utils/examExport';
import { Step5Exam } from '../src/views/Step5Exam';

const mkLine = (no: number, page: number, text: string, y = 100): SourceLine => ({
  id: `L${String(no).padStart(4, '0')}`,
  page,
  y,
  text,
});

function mockFolderStorage() {
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

// ============================================================================
// Acceptance #2 — Page-chunk test: call count == page count, 30-line ctx,
//                 and cross-page open-question carry-over assembles as ONE question.
// ============================================================================

test('#40 Part A: page chunking is the ONLY mode — call count == page count, 30 ctx lines, and spanning question merges into ONE question', async () => {
  assert.equal(READ_OVERLAP_LINES, 30);

  // 3-page exam with 105 lines total (<1,200 lines — previously batched into 1 call, now strictly 3 sheet calls).
  // Page 1: L0001..L0035 (35 lines); Q1 on L0002, Q2 starts at bottom L0034..L0035 and continues onto Page 2!
  // Page 2: L0036..L0070 (35 lines); L0036..L0037 continue Q2, Q3 starts on L0038.
  // Page 3: L0071..L0105 (35 lines); Q4 starts on L0072.
  const lines: SourceLine[] = [];
  for (let n = 1; n <= 35; n++) {
    const text = n === 1
      ? 'Section A — Reading'
      : n === 2
        ? '1. What is the main idea of paragraph one?'
        : n === 34
          ? '2. Read the following two-part statement that begins at the bottom of page one'
          : n === 35
            ? 'and continues onto the top of page two:'
            : `Header/filler line ${n}`;
    lines.push(mkLine(n, 1, text, n * 20));
  }
  for (let n = 36; n <= 70; n++) {
    const text = n === 36
      ? 'Explain why the author contrasts winter and spring'
      : n === 37
        ? 'using two examples from the text.'
        : n === 38
          ? '3. Choose the word closest in meaning to "resilient".'
          : `Page two filler ${n}`;
    lines.push(mkLine(n, 2, text, (n - 35) * 20));
  }
  for (let n = 71; n <= 105; n++) {
    const text = n === 71
      ? 'Section B — Writing'
      : n === 72
        ? '4. Write a short paragraph describing your hometown.'
        : `Page three filler ${n}`;
    lines.push(mkLine(n, 3, text, (n - 70) * 20));
  }

  const chunks = buildReadChunks(lines);
  assert.equal(chunks.length, 3, 'one chunk per sheet even under 1,200 lines');
  assert.equal(chunks[0].context.length, 0);
  assert.equal(chunks[1].context.length, 30, 'page 2 carries page 1 last 30 lines');
  assert.equal(chunks[1].context[0].id, 'L0006');
  assert.equal(chunks[1].context[29].id, 'L0035');
  assert.equal(chunks[2].context.length, 30, 'page 3 carries page 2 last 30 lines');
  assert.equal(chunks[2].context[0].id, 'L0041');
  assert.equal(chunks[2].context[29].id, 'L0070');

  const prompts: string[] = [];
  const res = await runGlobalReadStage({
    lines,
    caller: async req => {
      prompts.push(req.text);
      if (prompts.length === 1) {
        return {
          rawText: '{}',
          json: {
            r: [[1, 1, 'section'], [2, 2, 'question'], [3, 33, 'furniture'], [34, 34, 'question'], [35, 35, 'continuation']],
            q: [
              { n: 1, p: [[2, 2]], s: 'sec1', t: 'short' },
              { n: 2, p: [[34, 35]], s: 'sec1', t: 'short' },
            ],
            s: [{ id: 'sec1', title: 'Section A — Reading', p: [[1, 35]], h: 1 }],
          },
        };
      }
      if (prompts.length === 2) {
        return {
          rawText: '{}',
          json: {
            r: [[36, 37, 'continuation'], [38, 38, 'question'], [39, 70, 'furniture']],
            q: [{ n: 3, p: [[38, 38]], s: 'sec1', t: 'short' }],
            s: [{ id: 'sec1', title: 'Section A — Reading', p: [[36, 70]] }],
          },
        };
      }
      return {
        rawText: '{}',
        json: {
          r: [[71, 71, 'section'], [72, 72, 'question'], [73, 105, 'furniture']],
          q: [{ n: 4, p: [[72, 72]], s: 'sec2', t: 'essay' }],
          s: [{ id: 'sec2', title: 'Section B — Writing', p: [[71, 105]], h: 71 }],
        },
      };
    },
  });

  assert.equal(res.status, 'completed');
  assert.equal(res.calls, 3, 'call count == page count');
  assert.equal(prompts.length, 3);

  // Page 1 prompt has no ctx lines and open question = none.
  assert.match(prompts[0], /OPEN QUESTION FROM PREVIOUS PAGE: none/);
  assert.doesNotMatch(prompts[0], /\] ctx /);

  // Page 2 prompt carries ONLY page 1's last 30 lines as ctx (L0006..L0035, never L0001..L0005, never L0071+).
  assert.doesNotMatch(prompts[1], /\[L0005 /);
  assert.match(prompts[1], /\[L0006 p1 y120\] ctx /);
  assert.match(prompts[1], /\[L0035 p1 y700\] ctx /);
  assert.match(prompts[1], /\[L0036 p2 y20\] Explain why/);
  assert.doesNotMatch(prompts[1], /\[L0071 /);
  // Open-question carry-over has printed number + first 40 chars of Q2 stem.
  assert.match(prompts[1], /OPEN QUESTION FROM PREVIOUS PAGE: Q2 "2\. Read the following two-part statement"/);

  // Cross-page Q2 on pages 1–2 assembled as ONE question with L0034..L0037!
  assert.ok(res.proposal);
  const assembled = assembleReadProposal(res.proposal!, lines);
  assert.equal(assembled.questions.length, 4);
  assert.deepEqual(assembled.questions.map(q => q.no), [1, 2, 3, 4]);
  const q2 = assembled.questions.find(q => q.no === 2)!;
  assert.deepEqual(q2.spans, [[34, 37]]);
  assert.match(q2.stem || '', /begins at the bottom of page one/);
  assert.match(q2.stem || '', /using two examples from the text\./);
  assert.equal(assembled.sections.length, 2, 'continued section without new header coalesced cleanly');
});

test('#40 Part A: ctx lines are strictly read-only — labelling ctx lines fails validatePageProposal, and cross-page conflicts become defects', () => {
  const p1 = [mkLine(1, 1, '1. First question'), mkLine(2, 1, '2. Second question')];
  const p2 = [mkLine(3, 2, '2. Duplicate number opened again on page 2'), mkLine(4, 2, '3. Third question')];
  const all = [...p1, ...p2];

  // Attempt to label ctx line 2 inside page 2's proposal is rejected.
  const badPage2 = parseReadProposal('', {
    r: [[2, 2, 'furniture'], [3, 4, 'question']],
    q: [{ n: 3, p: [[3, 4]], t: 'short' }],
  });
  const verdict = validatePageProposal(badPage2, p2);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.complaints.some(c => c.includes('outside the document: 2')));

  // Cross-page duplicate question number (Q2 opened on both page 1 and page 2) is NEVER silently merged;
  // it becomes a `duplicate-number` defect in Check.
  const prop1 = parseReadProposal('', {
    r: [[1, 2, 'question']],
    q: [
      { n: 1, p: [[1, 1]], t: 'short' },
      { n: 2, p: [[2, 2]], t: 'short' },
    ],
  });
  const prop2 = parseReadProposal('', {
    r: [[3, 4, 'question']],
    q: [
      { n: 2, p: [[3, 3]], t: 'short' },
      { n: 3, p: [[4, 4]], t: 'short' },
    ],
  });
  const merged = mergePageProposals(
    [
      { page: 1, owned: p1, proposal: prop1 },
      { page: 2, owned: p2, proposal: prop2 },
    ],
    all,
  );
  assert.ok(merged.proposal);
  assert.equal(merged.proposal!.questions.length, 4, 'both Q2 records preserved');
  const assembled = assembleReadProposal(merged.proposal!, all);
  const defects = computeDefects({
    doc: { questions: assembled.questions, sections: assembled.sections },
    lines: all,
    expectedNumbers: [1, 2, 3],
    keyLineNos: [],
  });
  assert.ok(defects.some(d => d.kind === 'duplicate-number' && d.id === 'duplicate-number:2'));
});

test('#40 Part A4: per-page cache re-reads ONLY modified pages and never touches unchanged pages', async () => {
  const store = new Map<string, PageReadCacheEntry>();
  const pageCache: PageReadCache = {
    get: key => store.get(key),
    set: (key, value) => { store.set(key, value); },
  };
  const makeLines = (page3Question: string): SourceLine[] => [
    mkLine(1, 1, '1. Page one question?'),
    mkLine(2, 2, '2. Page two question?'),
    mkLine(3, 3, page3Question),
  ];

  const calledPages: number[] = [];
  const caller = async (req: { text: string }) => {
    const m = req.text.match(/^Page (\d+)\/3\./m);
    const p = Number(m?.[1] || 0);
    calledPages.push(p);
    return {
      rawText: '{}',
      json: {
        r: [[p, p, 'question']],
        q: [{ n: p, p: [[p, p]], t: 'short' }],
      },
    };
  };

  // Run 1: reads all 3 pages.
  const run1 = await runGlobalReadStage({ lines: makeLines('3. Original page three question?'), model: 'qwen-local', guidance: 'g1', pageCache, caller });
  assert.equal(run1.calls, 3);
  assert.deepEqual(calledPages, [1, 2, 3]);

  // Run 2 (identical): 0 calls, full cache hit.
  calledPages.length = 0;
  const run2 = await runGlobalReadStage({ lines: makeLines('3. Original page three question?'), model: 'qwen-local', guidance: 'g1', pageCache, caller });
  assert.equal(run2.status, 'cached');
  assert.equal(run2.calls, 0);
  assert.deepEqual(calledPages, []);

  // Run 3 (only page 3 changed): pages 1 & 2 hit cache, ONLY page 3 is called.
  calledPages.length = 0;
  const run3 = await runGlobalReadStage({ lines: makeLines('3. Edited page three question?'), model: 'qwen-local', guidance: 'g1', pageCache, caller });
  assert.equal(run3.calls, 1);
  assert.deepEqual(calledPages, [3]);
});

// ============================================================================
// Acceptance #4 — Cloud locality test: cloudPageRead receives ONLY the failed
//                 page's owned lines + at most 30 ctx lines, never the whole doc.
// ============================================================================

test('#40 Part B1 / Acceptance #4: cloud locality — cloud receives ONLY failed page lines + 30 ctx lines, never whole document', async () => {
  const lines: SourceLine[] = [];
  // Page 1: 40 lines (L0001..L0040): Q1 on L0001..L0010 (closed on page 1) + Q2 on L0011..L0040 -> L0001..L0010 must NOT appear in Page 2 cloud prompt!
  for (let n = 1; n <= 40; n++) {
    const text = n === 1
      ? '1. Page 1 first secret line ALPHA_P1'
      : n === 11
        ? '2. Page 1 bottom question'
        : `Page 1 line ${n}`;
    lines.push(mkLine(n, 1, text, n * 10));
  }
  // Page 2: 10 lines (L0041..L0050) -> fails local twice, recovered by cloud!
  for (let n = 41; n <= 50; n++) lines.push(mkLine(n, 2, n === 41 ? '3. Page 2 target question' : `Page 2 detail ${n}`, (n - 40) * 10));
  // Page 3: 20 lines (L0051..L0070) -> must NOT appear in Page 2 cloud prompt!
  for (let n = 51; n <= 70; n++) lines.push(mkLine(n, 3, n === 51 ? '4. Page 3 secret line OMEGA_P3' : `Page 3 line ${n}`, (n - 50) * 10));

  const localCallsByPage = new Map<number, number>();
  const cloudPrompts: string[] = [];

  const result = await runGlobalReadStage({
    lines,
    caller: async req => {
      const page = Number(req.text.match(/^Page (\d+)\/3\./m)?.[1] || 0);
      localCallsByPage.set(page, (localCallsByPage.get(page) || 0) + 1);
      if (page === 1) {
        return {
          rawText: '{}',
          json: {
            r: [[1, 1, 'question'], [2, 10, 'continuation'], [11, 11, 'question'], [12, 40, 'continuation']],
            q: [
              { n: 1, p: [[1, 10]], t: 'short' },
              { n: 2, p: [[11, 40]], t: 'short' },
            ],
          },
        };
      }
      if (page === 2) {
        if ((localCallsByPage.get(2) || 0) === 2) {
          assert.match(req.text, /VALIDATOR COMPLAINT \(fix this exactly\):/, 'retry #2 receives verbatim validator complaint');
        }
        return { rawText: '{"r":[],"q":[]}' }; // invalid on both local attempts
      }
      return { rawText: '{}', json: { r: [[51, 51, 'question'], [52, 70, 'continuation']], q: [{ n: 4, p: [[51, 70]], t: 'short' }] } };
    },
    cloudCaller: async req => {
      cloudPrompts.push(req.text);
      return {
        rawText: '{}',
        json: { r: [[41, 41, 'question'], [42, 50, 'continuation']], q: [{ n: 3, p: [[41, 50]], t: 'short' }] },
      };
    },
  });

  assert.equal(localCallsByPage.get(1), 1);
  assert.equal(localCallsByPage.get(2), 2, 'failed page tried locally twice before cloud');
  assert.equal(localCallsByPage.get(3), 1);
  assert.equal(cloudPrompts.length, 1, 'cloud called ONLY for page 2');

  const cloudText = cloudPrompts[0];
  // Cloud never sees Page 1 lines L0001..L0010 or ANY Page 3 lines L0051..L0070!
  assert.doesNotMatch(cloudText, /ALPHA_P1/);
  assert.doesNotMatch(cloudText, /\[L0010 /);
  assert.doesNotMatch(cloudText, /OMEGA_P3/);
  assert.doesNotMatch(cloudText, /\[L0051 /);
  // Cloud sees Page 1's last 30 lines (L0011..L0040) marked ctx + Page 2's owned lines (L0041..L0050).
  assert.match(cloudText, /\[L0011 p1 y110\] ctx /);
  assert.match(cloudText, /\[L0040 p1 y400\] ctx /);
  assert.match(cloudText, /\[L0041 p2 y10\] 3\. Page 2 target question/);
  assert.match(cloudText, /VALIDATOR COMPLAINT/);

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.pages.map(p => ({ page: p.page, status: p.status })),
    [
      { page: 1, status: 'local ok' },
      { page: 2, status: 'cloud ok' },
      { page: 3, status: 'local ok' },
    ],
  );
  assert.equal(result.proposal?.questions.length, 4);

  // Direct cloudPageRead call also enforces <=30 ctx lines even if caller passes more.
  const directPrompts: string[] = [];
  const direct = await cloudPageRead({
    page: 2,
    totalPages: 3,
    owned: lines.filter(l => l.page === 2),
    context: lines.filter(l => l.page === 1), // 40 lines passed in
    caller: async req => {
      directPrompts.push(req.text);
      return {
        rawText: '{}',
        json: { r: [[41, 50, 'question']], q: [{ n: 3, p: [[41, 50]], t: 'short' }] },
      };
    },
  });
  assert.equal(direct.ok, true);
  assert.equal(directPrompts.length, 1);
  assert.doesNotMatch(directPrompts[0], /\[L0010 /);
  assert.match(directPrompts[0], /\[L0011 p1 y110\] ctx /);
});

// ============================================================================
// Acceptance #3 & #5 + Part B2/B3 + Part C1/C2 — End-to-end Starvation Test:
//   Page 2 of 3 fails (local twice, cloud once) with 5 captioned images on Page 2.
//   Shipped doc has Pages 1+3 questions (NEVER 0!), 1 read-failed item for Page 2,
//   C2 explanatory image-unplaced item, per-page parse report, Step 3 live stream,
//   and [Retry page] recovers Page 2 + places its 5 pictures without re-reading Pages 1/3!
// ============================================================================

test('#40 Acceptance #3, #5, B2, B3, C1, C2: failing page 2 of 3 ships pages 1+3 questions (never 0), emits B2 + C2 attention items, streams per-page progress, and [Retry page] recovers page 2 alone', async () => {
  const storage = mockFolderStorage();
  const originalExecute = LLMAdapter.execute;

  // 3-page exam mirroring the reported field failure:
  // Page 1: Q1..Q3 (lines 1..4)
  // Page 2: Q4..Q8 with 5 pictures (lines 5..10) -> FAILS local x2 + cloud x1!
  // Page 3: Q9..Q11 (lines 11..14)
  const lines: SourceLine[] = [
    mkLine(1, 1, 'English Exam — Grade 12 — Date: 2026-10-25 — Total: 22 marks', 40),
    mkLine(2, 1, '1. Complete the sentence with the correct verb form. (2 marks)', 100),
    mkLine(3, 1, '2. Complete the sentence with the correct preposition. (2 marks)', 200),
    mkLine(4, 1, '3. Explain the meaning of "persevere". (2 marks)', 300),

    mkLine(5, 2, 'Picture Matching — Match each picture to its word:', 50),
    mkLine(6, 2, '4. Look at picture one and write the word. (2 marks)', 120),
    mkLine(7, 2, '5. Look at picture two and write the word. (2 marks)', 220),
    mkLine(8, 2, '6. Look at picture three and write the word. (2 marks)', 320),
    mkLine(9, 2, '7. Look at picture four and write the word. (2 marks)', 420),
    mkLine(10, 2, '8. Look at picture five and write the word. (2 marks)', 520),

    mkLine(11, 3, 'Reading Comprehension', 50),
    mkLine(12, 3, '9. Why did the traveler return early? (2 marks)', 120),
    mkLine(13, 3, '10. What lesson did the villagers learn? (2 marks)', 220),
    mkLine(14, 3, '11. Summarize the ending in one sentence. (2 marks)', 320),
  ];

  const page2Images: ImageAsset[] = Array.from({ length: 5 }, (_, idx) => {
    const n = idx + 1;
    const anchorLine = 5 + n;
    return {
      id: `img_p2_${n}`,
      page: 2,
      bbox: { x: 40, y: 100 * n, w: 120, h: 80 },
      mime: 'image/jpeg',
      sha: `sha_p2_${n}`,
      width: 120,
      height: 80,
      anchorLine,
      blobKey: `blob_p2_${n}`,
      dataUrl: `/api/images/blob_p2_${n}`,
      label: { role: 'stem', kind: 'photo', caption: `Illustrated vocabulary item ${n}` },
    };
  });

  const preExtracted: ExtractedDocument = {
    fileName: 'starvation.pdf',
    lines,
    pages: 3,
    ocrUsed: false,
    scannedPageIndices: [],
    pageImages: [],
    pageThumbKeys: [],
    images: page2Images,
  };

  const callLog: Array<{ role: string; label: string; text: string }> = [];
  const stageUpdates: Array<{ id: string; status: string; message?: string }> = [];
  const liveReadInfo: string[] = [];

  LLMAdapter.execute = (async (req: LLMRequest): Promise<LLMResponse> => {
    callLog.push({ role: req.role, label: req.label, text: req.text });

    if (req.role === 'meta') {
      return {
        rawText: '{}',
        json: {
          subject: { value: 'English', line: 1 },
          grade: { value: '12', line: 1 },
          total: { value: 22, line: 1 },
          date: { value: '2026-10-25', line: 1 },
        },
        usage: { inputTokens: 20, outputTokens: 15 },
      };
    }

    if (req.role === 'read') {
      if (req.text.startsWith('Page 1/3.')) {
        return {
          rawText: '{}',
          json: {
            r: [[1, 1, 'furniture'], [2, 4, 'question']],
            q: [
              { n: 1, p: [[2, 2]], s: 's1', t: 'short', v: [[2, 2]] },
              { n: 2, p: [[3, 3]], s: 's1', t: 'short', v: [[3, 3]] },
              { n: 3, p: [[4, 4]], s: 's1', t: 'short', v: [[4, 4]] },
            ],
            s: [{ id: 's1', title: 'Part 1', p: [[1, 4]] }],
          },
          usage: { inputTokens: 50, outputTokens: 40 },
        };
      }
      if (req.text.startsWith('Page 2/3.')) {
        return { rawText: 'not valid json {{{', json: null, usage: { inputTokens: 60, outputTokens: 10 } };
      }
      if (req.text.startsWith('Page 3/3.')) {
        return {
          rawText: '{}',
          json: {
            r: [[11, 11, 'section'], [12, 14, 'question']],
            q: [
              { n: 9, p: [[12, 12]], s: 's3', t: 'short', v: [[12, 12]] },
              { n: 10, p: [[13, 13]], s: 's3', t: 'short', v: [[13, 13]] },
              { n: 11, p: [[14, 14]], s: 's3', t: 'short', v: [[14, 14]] },
            ],
            s: [{ id: 's3', title: 'Reading Comprehension', p: [[11, 14]], h: 11 }],
          },
          usage: { inputTokens: 50, outputTokens: 40 },
        };
      }
    }

    if (req.role === 'cloud') {
      if (req.label === 'Cloud · Page 2 Read') {
        return { rawText: '{"r":[],"q":[]}', json: { r: [], q: [] }, usage: { inputTokens: 60, outputTokens: 10 } };
      }
      // Cloud defect escalation during Stage 4 Repair (including `image-unplaced`!)
      return { rawText: '{"ops":[{"op":"noFix","defect":"escalated"}]}', json: { ops: [{ op: 'noFix', defect: 'escalated' }] }, usage: { inputTokens: 20, outputTokens: 10 } };
    }

    if (req.role === 'repair') {
      // Even if local repair tries to drop Page 2's unread lines as furniture, validateRepairOp rejects it!
      if (req.text.includes('unaccounted-lines')) {
        return {
          rawText: '{}',
          json: { ops: [{ op: 'dropAsFurniture', defect: 'unaccounted-lines:5-10', lines: [5, 10] }] },
          usage: { inputTokens: 30, outputTokens: 15 },
        };
      }
      return { rawText: '{"ops":[]}', json: { ops: [] }, usage: { inputTokens: 20, outputTokens: 10 } };
    }

    return { rawText: '{"items":[]}', json: { items: [] }, usage: { inputTokens: 10, outputTokens: 10 } };
  }) as typeof LLMAdapter.execute;

  try {
    const content = 'starvation-test-pdf';
    const file = new File([content], 'starvation.pdf', { type: 'application/pdf' });
    const fileHash = await sha256(await file.arrayBuffer());
    const settings = {
      ...DEFAULT_SETTINGS,
      thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false },
    };

    const doc = await runFullPipeline(
      file,
      settings,
      {
        onStageUpdate: s => stageUpdates.push({ id: s.id, status: s.status, message: s.message }),
        onLiveText: (stageId, _label, channel, fullText) => {
          if (stageId === 'read' && channel === 'info') liveReadInfo.push(fullText);
        },
      },
      { preExtracted, fileHash },
    );

    // 1. NEVER 0 questions: Pages 1 + 3 shipped intact (6 questions: 1, 2, 3, 9, 10, 11)!
    assert.equal(doc.questions.length, 6, 'shipped doc contains pages 1+3 questions, NEVER 0');
    assert.deepEqual(doc.questions.map(q => q.no), [1, 2, 3, 9, 10, 11]);

    // 2. Page 2 was tried twice locally and once via cloudPageRead, with Part C1 image captions + addresses ONLY on Page 2!
    const p1Reads = callLog.filter(c => c.role === 'read' && c.text.startsWith('Page 1/3.'));
    const p2Reads = callLog.filter(c => c.role === 'read' && c.text.startsWith('Page 2/3.'));
    const p3Reads = callLog.filter(c => c.role === 'read' && c.text.startsWith('Page 3/3.'));
    const p2Clouds = callLog.filter(c => c.role === 'cloud' && c.label === 'Cloud · Page 2 Read');
    assert.equal(p1Reads.length, 1);
    assert.equal(p2Reads.length, 2);
    assert.equal(p3Reads.length, 1);
    assert.equal(p2Clouds.length, 1);

    assert.doesNotMatch(p1Reads[0].text, /PAGE IMAGES/, 'page 1 has no images');
    assert.match(p2Reads[0].text, /PAGE IMAGES \(picture content on page 2/);
    assert.match(p2Reads[0].text, /\[img_p2_1 p2 near L0006 y100\] caption: "Illustrated vocabulary item 1"/);
    assert.match(p2Reads[0].text, /\[img_p2_5 p2 near L0010 y500\] caption: "Illustrated vocabulary item 5"/);
    assert.match(p2Reads[1].text, /VALIDATOR COMPLAINT \(fix this exactly\):/, 'local retry receives complaint verbatim');
    assert.doesNotMatch(p3Reads[0].text, /img_p2_1/, 'page 3 does not receive page 2 images');
    assert.match(p2Clouds[0].text, /Illustrated vocabulary item 5/, 'cloud page 2 read also receives page 2 captions');
    assert.doesNotMatch(p2Clouds[0].text, /\[L0011 /, 'cloud page 2 read never receives page 3 lines');

    // 3. `image-unplaced` stayed a defect through Repair → Cloud escalation!
    assert.ok(doc.spine?.repairLoop.remainingKinds.includes('image-unplaced'), 'image-unplaced survived repair -> cloud');
    assert.ok(
      callLog.some(c => c.role === 'cloud' && c.label.includes('Repair image-unplaced') && c.label.includes('escalation')),
      'image-unplaced escalated to cloud during Repair',
    );

    // 4. Page 2's lines stayed in the document as unaccounted (dropAsFurniture on failed page was rejected!).
    assert.deepEqual(doc.source.orphanLineNos, [5, 6, 7, 8, 9, 10]);

    // 5. Attention items:
    //    - ONE `read-failed` item for Page 2: "Page 2 couldn't be read — its questions are missing [Retry page] [Open page]"
    //    - Explanatory C2 `image-unplaced` item: "5 pictures couldn't be placed because page 2 couldn't be read — retry the page to place them [Retry page]"
    const attention = computeAttention(doc);
    const readFailedItems = attention.filter(i => i.kind === 'read-failed');
    assert.equal(readFailedItems.length, 1);
    assert.equal(
      readFailedItems[0].plainSentence,
      "Page 2 couldn't be read — its questions are missing [Retry page] [Open page]",
    );
    assert.equal(readFailedItems[0].action.target, 'page-retry');
    assert.equal(readFailedItems[0].action.page, 2);
    assert.equal(readFailedItems[0].secondaryAction?.target, 'source-page');
    assert.equal(readFailedItems[0].secondaryAction?.lineNo, 5);

    const imageItems = attention.filter(i => i.kind === 'image-unplaced');
    assert.equal(imageItems.length, 1);
    assert.equal(
      imageItems[0].plainSentence,
      "5 pictures couldn't be placed because page 2 couldn't be read — retry the page to place them [Retry page]",
    );
    assert.equal(imageItems[0].action.target, 'page-retry');
    assert.equal(imageItems[0].action.page, 2);

    // IntegrityFlags renders exact count and interactive [Retry page] + [Open page] buttons with 1 data-attention-kind per item.
    const flagsHtml = renderToStaticMarkup(React.createElement(IntegrityFlags, { doc }));
    assert.equal((flagsHtml.match(/data-attention-kind="/g) || []).length, attention.length);
    assert.match(flagsHtml, /Page 2 couldn&#x27;t be read — its questions are missing \[Retry page\]/);
    assert.match(flagsHtml, /\[Open page\]/);
    assert.match(flagsHtml, /5 pictures couldn&#x27;t be placed because page 2 couldn&#x27;t be read — retry the page to place them \[Retry page\]/);

    // 6. Acceptance #5: Step 3 live stream received pages completing one by one, and Parse Report has per-page status!
    assert.deepEqual(liveReadInfo, [
      'Page 1/3: local ok — 3 question(s)',
      'Page 2/3: failed — 0 question(s)',
      'Page 3/3: local ok — 3 question(s)',
    ]);
    assert.ok(stageUpdates.some(s => s.id === 'read' && s.message?.includes('Sheet 1/3')));
    assert.ok(stageUpdates.some(s => s.id === 'read' && s.message?.includes('Sheet 2/3')));
    assert.ok(stageUpdates.some(s => s.id === 'read' && s.message?.includes('Sheet 3/3')));

    const report = parseReportForDoc(doc);
    assert.deepEqual(
      report.pages?.map(p => ({ page: p.page, status: p.status })),
      [
        { page: 1, status: 'local ok' },
        { page: 2, status: 'failed' },
        { page: 3, status: 'local ok' },
      ],
    );
    assert.equal((buildExportDoc(doc).parseReport.classify as any).pageProposals, undefined, 'raw pageProposals stripped from export');

    // 7. On-demand [Retry page] re-runs ONLY Page 2 (never Pages 1 or 3), recovers Q4..Q8, and places all 5 pictures!
    const retryReadCalls: LLMRequest[] = [];
    LLMAdapter.execute = (async (req: LLMRequest): Promise<LLMResponse> => {
      if (req.role === 'read' || req.role === 'cloud') {
        retryReadCalls.push(req);
        assert.match(req.text, /^Page 2\/3\./m, 'retryFailedPage ONLY reads page 2');
        return {
          rawText: '{}',
          json: {
            r: [[5, 5, 'instruction'], [6, 10, 'question']],
            q: [
              { n: 4, p: [[6, 6]], s: 's2', t: 'short', v: [[6, 6]], i: ['img_p2_1'] },
              { n: 5, p: [[7, 7]], s: 's2', t: 'short', v: [[7, 7]], i: ['img_p2_2'] },
              { n: 6, p: [[8, 8]], s: 's2', t: 'short', v: [[8, 8]], i: ['img_p2_3'] },
              { n: 7, p: [[9, 9]], s: 's2', t: 'short', v: [[9, 9]], i: ['img_p2_4'] },
              { n: 8, p: [[10, 10]], s: 's2', t: 'short', v: [[10, 10]], i: ['img_p2_5'] },
            ],
            s: [{ id: 's2', title: 'Picture Matching', p: [[5, 10]], h: 5 }],
          },
          usage: { inputTokens: 60, outputTokens: 50 },
        };
      }
      return { rawText: '{}', json: {}, usage: { inputTokens: 5, outputTokens: 5 } };
    }) as typeof LLMAdapter.execute;

    const retried = await retryFailedPage(doc, 2, settings);
    assert.equal(retryReadCalls.length, 1, 'exactly 1 read call made for page 2 retry; pages 1 & 3 untouched');
    assert.match(retryReadCalls[0].text, /^Page 2\/3\./m, 'retryFailedPage ONLY reads page 2');
    assert.equal(retried.status, 'local ok');
    assert.equal(retried.doc.questions.length, 11);
    assert.deepEqual(retried.doc.questions.map(q => q.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(computeAttention(retried.doc).length, 0, 'all failed-page and unplaced-picture attention items cleared');
  } finally {
    LLMAdapter.execute = originalExecute;
    storage.restore();
  }
});

// ============================================================================
// Part B3 — All pages fail: ships empty document with the read-failure attention
//           item as today, and parse report states per-page status for every page.
// ============================================================================

test('#40 Part B3: when ALL pages fail, ships empty doc with read-failure attention item and per-page failed status in Parse Report', async () => {
  const storage = mockFolderStorage();
  const originalExecute = LLMAdapter.execute;

  const lines: SourceLine[] = [
    mkLine(1, 1, '1. Question on page 1'),
    mkLine(2, 2, '2. Question on page 2'),
  ];
  const preExtracted: ExtractedDocument = {
    fileName: 'all-fail.pdf',
    lines,
    pages: 2,
    ocrUsed: false,
    scannedPageIndices: [],
    pageImages: [],
    pageThumbKeys: [],
    images: [],
  };

  LLMAdapter.execute = (async (req: LLMRequest): Promise<LLMResponse> => {
    if (req.role === 'meta') {
      return { rawText: '{}', json: { subject: { value: 'Math', line: 1 }, grade: { value: '10', line: 1 } }, usage: { inputTokens: 5, outputTokens: 5 } };
    }
    return { rawText: 'broken response', json: null, usage: { inputTokens: 10, outputTokens: 5 } };
  }) as typeof LLMAdapter.execute;

  try {
    const file = new File(['all-fail'], 'all-fail.pdf', { type: 'application/pdf' });
    const fileHash = await sha256(await file.arrayBuffer());
    const doc = await runFullPipeline(
      file,
      { ...DEFAULT_SETTINGS, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false } },
      { onStageUpdate: () => undefined },
      { preExtracted, fileHash },
    );

    assert.equal(doc.questions.length, 0);
    const items = computeAttention(doc);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'read-failed');
    assert.match(items[0].plainSentence, /whole-paper read failed/i);

    const report = parseReportForDoc(doc);
    assert.deepEqual(
      report.pages?.map(p => ({ page: p.page, status: p.status })),
      [
        { page: 1, status: 'failed' },
        { page: 2, status: 'failed' },
      ],
    );

    const step5Html = renderToStaticMarkup(
      React.createElement(Step5Exam, {
        doc,
        onUpdateDoc: () => undefined,
      }),
    );
    assert.ok(step5Html.length > 0);
  } finally {
    LLMAdapter.execute = originalExecute;
    storage.restore();
  }
});
