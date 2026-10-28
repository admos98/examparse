import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamDoc, LLMRequest, LLMResponse, SourceLine } from '../src/types';
import type { ExtractedDocument } from '../src/pipeline/extract';
import {
  PAGE_RETRY_ALLOWANCE,
  readAllowanceForPages,
  runGlobalReadStage,
  type ReadBudget,
  type ReadProposal,
} from '../src/pipeline/globalRead';
import { runFullPipeline, retryFailedPage } from '../src/pipeline';
import { LLMAdapter } from '../src/providers/adapter';
import { DEFAULT_SETTINGS } from '../src/store';
import { sha256 } from '../src/utils/hash';
import { computeAttention } from '../src/utils/attention';
import { parseReportForDoc } from '../src/utils/examExport';
import { mockFolderStorage } from './fixtures/folder-storage';

/**
 * #41 — the read stage owns its budget. Field scenario: 7-page scanned exam, read=local (always fails format),
 * cloud rescues every page. Previously pages 3–7 were starved by agentLimits.maxModelCalls.
 */

const PAGES = 7;
const LINES_PER_PAGE = 3;
const mkLine = (no: number, page: number, text: string): SourceLine => ({ id: `L${String(no).padStart(4, '0')}`, page, y: (no % LINES_PER_PAGE + 1) * 100, text });

/** Page p owns L(3p-2)..L(3p): header (furniture), numbered question stem, option line. */
function examLines(pages = PAGES): SourceLine[] {
  const lines: SourceLine[] = [];
  for (let p = 1; p <= pages; p++) {
    const a = (p - 1) * LINES_PER_PAGE + 1;
    lines.push(mkLine(a, p, `Unit ${p} — reading`));
    lines.push(mkLine(a + 1, p, `${p}. Question ${p}: choose the best word for the blank.`));
    lines.push(mkLine(a + 2, p, `a) option for question ${p}`));
  }
  return lines;
}

/** A correct page proposal computed from the owned-line range printed in the prompt. */
function validPageJson(owned: [number, number]): unknown {
  const [a, b] = owned;
  const n = Math.round(a / LINES_PER_PAGE) + 1;
  return {
    r: [[a, a, 'furniture'], [a + 1, b, 'question']],
    q: [{ n, p: [[a + 1, a + 1]], t: 'short' }],
  };
}

function parsePromptPage(text: string): { page: number; owned: [number, number] } {
  const page = Number(text.match(/Page (\d+)\/\d+\./)?.[1] || 0);
  const m = text.match(/non-ctx lines \(L(\d{4})\.\.L(\d{4})\)/);
  return { page, owned: [Number(m?.[1] || 0), Number(m?.[2] || 0)] };
}

const formatFailure = (): LLMResponse => ({ rawText: 'Sure! Here is the exam: it has questions.', json: undefined, usage: { inputTokens: 10, outputTokens: 5 } });

test('#46 local loop: a 7-page format failure never calls cloud, never exhausts a budget, and saves a shell with per-page notes', async () => {
  const storage = mockFolderStorage();
  const originalExecute = LLMAdapter.execute;
  const preExtracted: ExtractedDocument = { fileName: 'field.pdf', lines: examLines(), pages: PAGES, ocrUsed: false, scannedPageIndices: [], pageImages: [], pageThumbKeys: [], images: [] };
  const roles: string[] = [];
  LLMAdapter.execute = (async (req: LLMRequest) => {
    roles.push(req.role);
    return { rawText: 'Sure! Here is the exam: it has questions.', json: undefined, usage: { inputTokens: 10, outputTokens: 5 } };
  }) as typeof LLMAdapter.execute;
  try {
    const file = new File(['local-loop-starvation'], 'field.pdf', { type: 'application/pdf' });
    const fileHash = await sha256(await file.arrayBuffer());
    const settings = { ...DEFAULT_SETTINGS, agentLimits: { maxModelCalls: 1, maxToolExecutions: 1 }, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false } } as any;
    const doc = await runFullPipeline(file, settings, { onStageUpdate: () => undefined }, { preExtracted, fileHash });
    assert.ok(doc.loop, 'loop receipt present');
    assert.equal(doc.loop!.pages.length, PAGES);
    assert.ok(doc.loop!.notes.length >= PAGES, 'every unreadable page is a note');
    assert.ok(roles.every(role => role === 'read' || role === 'vision'), 'no cloud/repair/classify/meta role in the default path');
    assert.equal(doc.spine, undefined, 'legacy spine is not written by the loop');
    assert.ok(computeAttention(doc).some(item => item.kind === 'read-failed' && item.action.target === 'page-retry'));
    assert.equal(parseReportForDoc(doc).loop?.steps.length, 6);
  } finally { LLMAdapter.execute = originalExecute; storage.restore(); }
});

test('#41 fast-path: a format failure on page 1 costs exactly ONE local call, then cloud', async () => {
  const log: string[] = [];
  const lines = examLines(1);
  const result = await runGlobalReadStage({
    lines,
    caller: async req => { log.push(`local:${req.label}`); return formatFailure(); },
    cloudCaller: async req => { log.push('cloud'); const { owned } = parsePromptPage(req.text); return { rawText: '{}', json: validPageJson(owned) }; },
  });
  assert.deepEqual(log, ['local:Global Read', 'cloud']);
  assert.equal(result.pages[0].status, 'cloud ok');
  assert.equal(result.pages[0].calls, 2);
  assert.equal(result.pages[0].localComplaints?.length, 1);
});

test('#41 fast-path: an unlabelled-but-numbered page is a format failure; a content complaint still gets the local retry BEFORE cloud', async () => {
  // Format: parseable JSON, zero owned lines labelled, page has numbered lines -> straight to cloud.
  const formatLog: string[] = [];
  await runGlobalReadStage({
    lines: examLines(1),
    caller: async req => { formatLog.push('local'); return { rawText: '{"r":[],"q":[]}', json: { r: [], q: [] } }; },
    cloudCaller: async req => { formatLog.push('cloud'); return { rawText: '{}', json: validPageJson(parsePromptPage(req.text).owned) }; },
  });
  assert.deepEqual(formatLog, ['local', 'cloud']);

  // Content: a parseable proposal whose question spans overlap -> complaint -> local retry fixes it -> no cloud.
  const contentLog: string[] = [];
  const bad = { r: [[1, 1, 'furniture'], [2, 3, 'question']], q: [{ n: 1, p: [[2, 2]], t: 'short' }, { n: 2, p: [[2, 3]], t: 'short' }] };
  const good = validPageJson([1, 3]);
  const content = await runGlobalReadStage({
    lines: examLines(1),
    caller: async req => {
      contentLog.push(`local:${req.label}`);
      return contentLog.length === 1 ? { rawText: JSON.stringify(bad), json: bad } : { rawText: JSON.stringify(good), json: good };
    },
    cloudCaller: async () => { contentLog.push('cloud'); return { rawText: '{}', json: good }; },
  });
  assert.deepEqual(contentLog, ['local:Global Read', 'local:Global Read — validation retry']);
  assert.equal(content.pages[0].status, 'local ok');
  assert.equal(content.pages[0].calls, 2);
  assert.match(content.pages[0].localComplaints?.[0] || '', /attempt 1: .*overlap/);
});

test('#41 accounting: per-page and total read calls equal the local attempts + retries + cloud rescues actually made (and journaled)', async () => {
  const lines = examLines(4);
  const invoked = { local: 0, cloud: 0 };
  const journaled: string[] = [];
  let throwOnce = true;
  const good = (owned: [number, number]) => validPageJson(owned);

  const result = await runGlobalReadStage({
    lines,
    caller: async req => {
      const { page, owned } = parsePromptPage(req.text);
      invoked.local++;
      if (page === 1) return { rawText: '{}', json: good(owned) };                    // 1 call
      if (page === 2) {                                                               // content complaint (overlap), then ok: 2 calls
        if (req.label.includes('validation retry')) return { rawText: '{}', json: good(owned) };
        const overlap = { r: [[owned[0], owned[0], 'furniture'], [owned[0] + 1, owned[1], 'question']], q: [{ n: 2, p: [[owned[0] + 1, owned[0] + 1]], t: 'short' }, { n: 3, p: [[owned[0] + 1, owned[0] + 1]], t: 'short' }] };
        return { rawText: '{}', json: overlap };
      }
      if (page === 3) {                                                               // network throw, then format fail, then cloud: 2 local + 1 cloud
        if (throwOnce) { throwOnce = false; throw new Error('socket hang up'); }
        return formatFailure();
      }
      return formatFailure();                                                         // page 4: format fail -> cloud
    },
    cloudCaller: async req => { invoked.cloud++; return { rawText: '{}', json: validPageJson(parsePromptPage(req.text).owned) }; },
    onJournal: e => { journaled.push(e.label); },
  });

  const pageCalls = result.pages.map(p => p.calls);
  assert.deepEqual(pageCalls, [1, 2, 3, 2]);
  assert.equal(result.pages[2].status, 'cloud ok');
  assert.equal(result.pages[2].localComplaints?.length, 2, 'throw is recorded as local attempt 1; format fail as attempt 2');
  assert.match(result.pages[2].localComplaints?.[0] || '', /socket hang up/);

  const perPageTotal = result.pages.reduce((s, p) => s + p.calls, 0);
  assert.equal(result.calls + result.cloudCalls, perPageTotal, 'run total == sum of per-page calls');
  assert.equal(invoked.local, result.calls, 'local invocations == reported local calls (throws included)');
  assert.equal(invoked.cloud, result.cloudCalls, 'cloud invocations == reported cloud rescues');
  assert.equal(result.pages.reduce((s, p) => s + (p.cloudCalls || 0), 0), result.cloudCalls);
  assert.equal(result.pages.at(-1)?.runningCalls, perPageTotal, 'running total on the last page is the whole run');
  assert.deepEqual(result.pages.map(p => p.runningCalls), [1, 3, 6, 8]);
  // Every call that returned a response was journaled; the thrown one was not.
  assert.equal(journaled.length, invoked.local + invoked.cloud - 1);
  assert.ok(result.calls + result.cloudCalls <= result.readAllowance);
  assert.equal(result.readAllowance, readAllowanceForPages(4));
});

test('#41 exhaustion is first-class: pages past the allowance are read-failed with the reason, and attention says the exam was only partially read', async () => {
  const lines = examLines(7);
  const budget: ReadBudget = { calls: 0, maxCalls: 4 };
  const result = await runGlobalReadStage({
    lines,
    budget,
    caller: async req => { const { owned } = parsePromptPage(req.text); return { rawText: '{}', json: validPageJson(owned) }; },
  });
  assert.equal(result.status, 'partial');
  assert.equal(budget.calls, 4);
  assert.deepEqual(result.pages.map(p => p.status), ['local ok', 'local ok', 'local ok', 'local ok', 'failed', 'failed', 'failed']);
  assert.equal(result.pages[4].reason, 'read allowance exhausted (4 calls)');
  assert.equal(result.pages[4].calls, 0, 'exhausted pages are never attempted');

  const doc = {
    questions: result.proposal?.questions.map((q, i) => ({ id: `q${i}`, no: q.no, label: String(q.no), spans: q.spans, stem: 'x', type: 'short', confidence: 1, images: [] })) || [],
    sections: [],
    images: [],
    flags: result.failedPages.map(p => ({ id: `page_read_failed_${p}`, code: 'PAGE_READ_FAILED', severity: 'error', message: `Page ${p}` })),
    source: { lines },
    spine: { classify: { status: 'partial', calls: result.calls, cloudCalls: 0, readAllowance: result.readAllowance, pages: result.pages } },
  } as unknown as ExamDoc;
  const items = computeAttention(doc).filter(i => i.kind === 'read-failed');
  assert.equal(items.length, 3);
  for (const item of items) assert.match(item.plainSentence, /only partially read because of the call budget/, item.plainSentence);
});

test('#41 [Retry page] bypasses the original exhaustion: the retried page gets a fresh 3-call allowance', async () => {
  assert.equal(PAGE_RETRY_ALLOWANCE, 3);
  const lines = examLines(3);
  const pages = [
    { page: 1, status: 'local ok' as const, calls: 1, questions: 1 },
    { page: 2, status: 'local ok' as const, calls: 1, questions: 1 },
    { page: 3, status: 'failed' as const, calls: 0, questions: 0, reason: 'read allowance exhausted (4 calls)' },
  ];
  const doc = {
    questions: [1, 2].map(n => ({ id: `q${n}`, no: n, label: String(n), spans: [[(n - 1) * 3 + 2, (n - 1) * 3 + 2]], stem: `${n}. q`, type: 'short', confidence: 1, images: [] })),
    sections: [],
    images: [],
    flags: [{ id: 'page_read_failed_3', code: 'PAGE_READ_FAILED', severity: 'error', message: 'Page 3' }],
    source: { lines },
    // The original run spent its whole allowance (4 of 4) before page 3 was starved.
    spine: { classify: { status: 'partial', calls: 4, cloudCalls: 0, readAllowance: 4, pages } },
  } as unknown as ExamDoc;

  let localCount = 0;
  let cloudCount = 0;
  const settings = { ...DEFAULT_SETTINGS, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false } };
  const retried = await retryFailedPage(doc, 3, settings, {
    persist: false,
    caller: async req => { localCount++; return formatFailure(); },
    cloudCaller: async req => { cloudCount++; return { rawText: '{}', json: validPageJson(parsePromptPage(req.text).owned) }; },
  });
  assert.equal(retried.status, 'cloud ok');
  assert.equal(localCount, 1);
  assert.equal(cloudCount, 1);
  const record = retried.doc.spine?.classify?.pages?.find(p => p.page === 3);
  assert.equal(record?.status, 'cloud ok');
  assert.equal(record?.reason, undefined);
  assert.deepEqual(record?.localComplaints?.length, 1);
  assert.equal(record?.cloudCalls, 1);
  assert.equal(retried.doc.questions.length, 3);
});

test('#41 parse report carries localComplaints and running totals through the export', async () => {
  const lines = examLines(2);
  const result = await runGlobalReadStage({
    lines,
    caller: async () => formatFailure(),
    cloudCaller: async req => ({ rawText: '{}', json: validPageJson(parsePromptPage(req.text).owned) }),
  });
  const doc = { questions: [], sections: [], images: [], flags: [], source: { lines }, spine: { classify: { status: 'completed', calls: result.calls, cloudCalls: result.cloudCalls, readAllowance: result.readAllowance, pages: result.pages } } } as unknown as ExamDoc;
  const report = parseReportForDoc(doc);
  assert.equal(report.pages?.length, 2);
  assert.deepEqual(report.pages?.map(p => p.localComplaints?.length), [1, 1]);
  assert.equal(report.pages?.at(-1)?.runningCalls, 4);
  assert.equal(report.classify?.readAllowance, readAllowanceForPages(2));
});
