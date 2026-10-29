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
import { LoopReceipt } from '../src/components/LoopReceipt';

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
  // #41 format-failure fast-path: `{"r":[],"q":[]}` on a page with numbered lines is a schema failure, so the
  // page spends ONE local call and goes straight to the cloud rescue (no local complaint-retry).
  assert.equal(localCallsByPage.get(2), 1, 'format-failed page goes to cloud after one local attempt');
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

test('#46 page-wise loop: failing page 2 ships pages 1+3, notes page 2, streams progress, and Retry page stays local', async () => {
  const storage = mockFolderStorage();
  const originalExecute = LLMAdapter.execute;
  const lines: SourceLine[] = [
    mkLine(1, 1, 'English Exam — Grade 12 — Total: 22 marks'),
    ...[1, 2, 3].map(n => mkLine(n + 1, 1, `${n}. Question ${n} (2 marks)`)),
    mkLine(5, 2, 'Picture Matching'),
    ...[4, 5, 6, 7, 8].map(n => mkLine(n + 1, 2, `${n}. Look at picture ${n - 3}. (2 marks)`)),
    mkLine(11, 3, 'Reading Comprehension'),
    ...[9, 10, 11].map(n => mkLine(n + 2, 3, `${n}. Question ${n} (2 marks)`)),
  ];
  const preExtracted: ExtractedDocument = { fileName: 'starvation.pdf', lines, pages: 3, ocrUsed: false, scannedPageIndices: [], pageImages: [], pageThumbKeys: [], images: [] };
  const callLog: Array<{ role: string; label: string; text: string }> = [];
  const stageUpdates: string[] = [];
  const pageDoc = (page: number) => ({ meta: { totalPoints: 22 }, sections: [{ title: page === 3 ? 'Reading Comprehension' : 'Questions' }], questions: (page === 1 ? [1, 2, 3] : page === 2 ? [4, 5, 6, 7, 8] : [9, 10, 11]).map(number => ({ number, sectionTitle: page === 3 ? 'Reading Comprehension' : 'Questions', type: 'short', stem: `Question ${number}`, options: [], points: 2, imageIds: [] })) });
  LLMAdapter.execute = (async (req: LLMRequest): Promise<LLMResponse> => {
    callLog.push({ role: req.role, label: req.label, text: req.text });
    if (req.role !== 'read') return { rawText: '{"items":[]}', json: { items: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    const page = Number(/PAGE (\d+) SOURCE:/.exec(req.text)?.[1] || 0);
    if (page === 2 && !req.label.startsWith('Retry')) return { rawText: 'broken response', json: null, usage: { inputTokens: 10, outputTokens: 5 } };
    const doc = pageDoc(page);
    return { rawText: JSON.stringify(doc), json: doc, usage: { inputTokens: 20, outputTokens: 10 } };
  }) as typeof LLMAdapter.execute;
  try {
    const file = new File(['page-wise-loop'], 'starvation.pdf', { type: 'application/pdf' });
    const fileHash = await sha256(await file.arrayBuffer());
    const settings = { ...DEFAULT_SETTINGS, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false } };
    const doc = await runFullPipeline(file, settings, { onStageUpdate: s => stageUpdates.push(s.id), onLiveText: () => undefined }, { preExtracted, fileHash });
    assert.deepEqual(doc.questions.map(q => q.no), [1, 2, 3, 9, 10, 11]);
    assert.equal(callLog.filter(c => c.role === 'cloud').length, 0, 'no cloud anywhere');
    assert.equal(callLog.filter(c => c.role === 'read' && /PAGE 2 SOURCE:/.test(c.text)).length, 1, 'one local read per page, no retry allowance');
    for (const phase of ['map', 'parse', 'check', 'fix', 'present']) assert.ok(stageUpdates.includes(phase), phase);
    assert.ok(!stageUpdates.includes('self-review') && !stageUpdates.includes('final-fix'));
    assert.ok(doc.loop!.pages.find(p => p.page === 2)?.status === 'empty');
    assert.ok(computeAttention(doc).some(item => item.action.target === 'page-retry' && item.action.page === 2));
    const retried = await retryFailedPage(doc, 2, settings, { persist: false });
    assert.equal(retried.status, 'local ok');
    assert.deepEqual(retried.doc.questions.map(q => q.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(callLog.filter(c => c.role === 'cloud').length, 0);
    const report = parseReportForDoc(retried.doc);
    assert.equal(report.loop?.pages.length, 3);
    assert.ok(renderToStaticMarkup(React.createElement(LoopReceipt, { receipt: retried.doc.loop! })).includes('Loop receipt'));
  } finally { LLMAdapter.execute = originalExecute; storage.restore(); }
});

test('#46 all pages unreadable: the extraction shell is saved with six step receipts and attention notes, never Analysis failed', async () => {
  const storage = mockFolderStorage();
  const originalExecute = LLMAdapter.execute;
  const preExtracted: ExtractedDocument = { fileName: 'all-fail.pdf', lines: [mkLine(1, 1, '1. Question on page 1'), mkLine(2, 2, '2. Question on page 2')], pages: 2, ocrUsed: false, scannedPageIndices: [], pageImages: [], pageThumbKeys: [], images: [] };
  LLMAdapter.execute = (async () => ({ rawText: 'broken response', json: null, usage: { inputTokens: 10, outputTokens: 5 } })) as typeof LLMAdapter.execute;
  try {
    const file = new File(['all-fail'], 'all-fail.pdf', { type: 'application/pdf' });
    const fileHash = await sha256(await file.arrayBuffer());
    const doc = await runFullPipeline(file, { ...DEFAULT_SETTINGS, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false } }, { onStageUpdate: () => undefined }, { preExtracted, fileHash });
    assert.equal(doc.questions.length, 0);
    assert.equal(doc.loop!.steps.length, 6);
    assert.ok(doc.loop!.notes.length >= 2);
    assert.ok(computeAttention(doc).some(item => item.kind === 'read-failed'));
    assert.deepEqual(parseReportForDoc(doc).loop?.pages.map(p => p.status), ['empty', 'empty']);
    assert.ok(renderToStaticMarkup(React.createElement(Step5Exam, { doc, onUpdateDoc: () => undefined })).length > 0);
  } finally { LLMAdapter.execute = originalExecute; storage.restore(); }
});
