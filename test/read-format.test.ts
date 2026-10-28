import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReadProposalChecked, buildPageReadPrompt, runGlobalReadStage, GLOBAL_READ_VERBOSE_SYSTEM, hasCountingLoop, pageReadOutputCap, salvageVerbosePage } from '../src/pipeline/globalRead';
import { effectiveReadFormat, isLocalReadProvider } from '../src/pipeline/readFormat';
import { assembleReadProposal } from '../src/pipeline/globalRead';
import { compileDocument } from '../src/pipeline/compile';
import { buildScoreboard } from '../src/pipeline/scoreboard';
import type { AppSettings, SourceLine } from '../src/types';

const lines: SourceLine[] = [
  { id: 'L0001', page: 1, y: 1, text: 'Exam title' },
  { id: 'L0002', page: 1, y: 2, text: 'Listening' },
  { id: 'L0003', page: 1, y: 3, text: '1. Is the statement correct?' },
  { id: 'L0004', page: 1, y: 4, text: 'a) Yes' },
  { id: 'L0005', page: 1, y: 5, text: 'b) No' },
  { id: 'L0006', page: 1, y: 6, text: '2 points' },
  { id: 'L0020', page: 1, y: 20, text: '1. b' },
];

const compact = {
  r: [[1, 1, 'furniture'], [2, 2, 'section'], [3, 3, 'question'], [4, 5, 'option'], [6, 6, 'marks'], [20, 20, 'key']],
  q: [{ n: 1, p: [[3, 3]], s: 'sec1', t: 'truefalse', o: [['a', [[4, 4]]], ['b', [[5, 5]]]], v: [[6, 6]], i: [] }],
  s: [{ id: 'sec1', title: 'Listening', p: [[2, 6]], h: 2 }],
  k: { '1': { value: 'b', p: [[20, 20]] } },
};
const verbose = {
  page: 1,
  sections: [{ title: 'Listening', headerLine: 2 }],
  questions: [{ number: 1, type: 'truefalse', stemFrom: 3, stemTo: 3, optionsFrom: 4, optionsTo: 5, passageFrom: null, passageTo: null, marksLine: 6, answerLine: null, imageIds: [] }],
  answerKey: [{ number: 1, answer: 'b', line: 20 }],
};

test('compact and verbose formats normalize the same scripted page to the same proposal', () => {
  const c = parseReadProposalChecked('', compact, 'compact', lines).proposal;
  const v = parseReadProposalChecked('', verbose, 'verbose', lines).proposal;
  assert.deepEqual(v.questions, c.questions);
  assert.deepEqual(v.sections, c.sections);
  assert.equal(v.labels.has(1), false); // unclaimed furniture is derived by code
  assert.deepEqual(v.answerKey, c.answerKey);
});

test('verbose mode leaves unclaimed lines for compiler reconciliation without a line table', async () => {
  const source: SourceLine[] = [
    { id: 'L0001', page: 1, y: 1, text: 'Listening' },
    { id: 'L0002', page: 1, y: 2, text: '1. First part' },
    { id: 'L0003', page: 1, y: 3, text: 'continuation words' },
    { id: 'L0004', page: 1, y: 4, text: 'end of question' },
    { id: 'L0005', page: 1, y: 5, text: 'Repeated banner' },
    { id: 'L0011', page: 2, y: 1, text: 'Repeated banner' },
  ];
  const proposal = parseReadProposalChecked('', {
    page: 1, sections: [{ title: 'Listening', headerLine: 1 }],
    questions: [{ number: 1, type: 'short', stemFrom: 2, stemTo: 4, optionsFrom: null, optionsTo: null, passageFrom: null, passageTo: null, marksLine: null, answerLine: null, imageIds: [] }], answerKey: [],
  }, 'verbose', source).proposal;
  assert.deepEqual(proposal.questions[0].spans, [[2, 4]]);
  const assembled = assembleReadProposal(proposal, source);
  const compiled = await compileDocument({ questions: assembled.questions, sections: assembled.sections, lines: source, keyLineNos: assembled.keyLineNos, accountedLineNos: [...proposal.labels.keys()] });
  assert.ok(compiled.defects.some(d => d.kind === 'unaccounted-lines' && d.lineIds.includes(5)));
});

test('auto selects verbose for local endpoints, compact for remote, and explicit choice wins', () => {
  const provider = (id: string, baseURL: string, name = id) => ({ id, name, kind: 'openai-compatible' as const, baseURL, apiKey: '' });
  const base = { providers: [provider('lan', 'http://192.168.1.4:11434', 'Ollama')], roleMapping: { fast: { providerId: 'lan', model: 'x' }, standard: { providerId: 'lan', model: 'x' }, escalation: { providerId: 'lan', model: 'x' }, vision: { providerId: 'lan', model: 'x' }, read: { providerId: 'lan', model: 'x' } } } as AppSettings;
  assert.equal(isLocalReadProvider(base.providers[0]), true);
  assert.equal(effectiveReadFormat(base), 'verbose');
  const remote = { ...base, providers: [provider('remote', 'https://api.example.test/v1')], roleMapping: { ...base.roleMapping, read: { providerId: 'remote', model: 'x' } } };
  assert.equal(effectiveReadFormat(remote), 'compact');
  assert.equal(effectiveReadFormat({ ...base, readFormat: 'compact' }), 'compact');
  assert.equal(effectiveReadFormat({ ...remote, readFormat: 'verbose' }), 'verbose');
});

test('verbose prompt includes explicit anti-template instruction', () => {
  const prompt = buildPageReadPrompt({ page: 1, totalPages: 1, owned: lines, context: [], format: 'verbose' });
  assert.match(prompt, /Never list line numbers one by one/);
});

test('page report records the actual verbose format and its output-token receipt', async () => {
  const result = await runGlobalReadStage({
    lines,
    format: 'verbose',
    caller: async request => {
      assert.match(request.text, /"stemFrom"/);
      return { rawText: JSON.stringify(verbose), json: verbose, usage: { inputTokens: 100, outputTokens: 321 } };
    },
  });
  assert.equal(result.pages[0].format, 'verbose');
  assert.equal(result.pages[0].outputTokens, 321);
});

test('read-model scoreboard keeps page outcomes split by format', () => {
  const run: any = {
    docTraits: { languagesDetected: ['en'], lines: 80, hasImages: 0 }, models: { read: 'qwen-local-4b' },
    outcome: { health: { coveragePercent: 100, parsed: 2 }, cost: 0 }, flagsRaised: [], ladderPath: [],
    readPageOutcomes: [
      { format: 'verbose', outcome: 'ok' }, { format: 'verbose', outcome: 'partial' },
      { format: 'compact', outcome: 'failed' },
    ],
  };
  const row = buildScoreboard([run]).find(item => item.role === 'read');
  assert.deepEqual(row?.readPageOutcomes, {
    verbose: { ok: 1, okReconciled: 0, partial: 1, failed: 0 },
    compact: { ok: 0, okReconciled: 0, partial: 0, failed: 1 },
  });
});


test('verbose v2 schema contains no enumerated line-number array', () => {
  const prompt = buildPageReadPrompt({ page: 1, totalPages: 1, owned: lines, context: [], format: 'verbose' });
  const example = JSON.parse(GLOBAL_READ_VERBOSE_SYSTEM.match(/Use this example: (\{[^\n]+\})\./)![1]);
  const visit = (value: any, key = '') => {
    if (Array.isArray(value)) { assert.ok(!/line|span|range/i.test(key)); value.forEach(x => visit(x)); }
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => visit(v, k));
  };
  visit(example);
  assert.doesNotMatch(prompt, /furnitureLines|stemLines|optionLines|continuationLines/);
  assert.match(prompt, /Never list line numbers one by one/);
});

test('page cap uses owned lines, both formats', async () => {
  assert.equal(pageReadOutputCap(40), 2000);
  for (const format of ['compact', 'verbose'] as const) {
    const source = Array.from({ length: 40 }, (_, i) => ({ id: `L${String(i + 1).padStart(4, '0')}`, page: 1, y: i, text: `${i + 1}. test` }));
    await runGlobalReadStage({ lines: source, format, caller: async req => {
      assert.equal(req.maxOutputTokens, 2000);
      return { rawText: JSON.stringify(format === 'verbose' ? verbose : compact), json: format === 'verbose' ? verbose : compact };
    } });
  }
});

test('counting loop detection reaches cloud without local retry', async () => {
  assert.equal(hasCountingLoop(Array.from({ length: 40 }, (_, i) => String(1600 + i)).join(',')), true);
  let local = 0, cloud = 0;
  const result = await runGlobalReadStage({ lines, format: 'verbose', caller: async () => {
    local++;
    throw Object.assign(new Error('counting loop in read stream'), { outputTokens: 120 });
  }, cloudCaller: async () => {
    cloud++;
    return { rawText: JSON.stringify(compact), json: compact, usage: { inputTokens: 10, outputTokens: 50 } };
  } });
  assert.equal(local, 1); assert.equal(cloud, 1);
  assert.equal(result.calls, 1); assert.equal(result.cloudCalls, 1);
  assert.equal(result.usage.outputTokens, 120);
  assert.equal(result.pages[0].status, 'cloud ok');
});

test('truncated question four salvages complete questions and leaves a compiler defect', async () => {
  const source = Array.from({ length: 9 }, (_, i) => ({ id: `L${String(i + 1).padStart(4, '0')}`, page: 1, y: i, text: i % 2 === 0 ? `${Math.floor(i / 2) + 1}. Question` : 'body' }));
  const q = (n: number) => ({ number: n, type: 'short', stemFrom: n * 2 - 1, stemTo: n * 2, optionsFrom: null, optionsTo: null, passageFrom: null, passageTo: null, marksLine: null, answerLine: null, imageIds: [] });
  const raw = `{"page":1,"sections":[],"questions":[${[1, 2, 3].map(n => JSON.stringify(q(n))).join(',')},{"number":4,"stemFrom":7`;
  assert.equal(salvageVerbosePage(raw)?.questions.length, 3);
  const result = await runGlobalReadStage({ lines: source, format: 'verbose', caller: async () => ({ rawText: raw, usage: { inputTokens: 50, outputTokens: 180 } }) });
  assert.equal(result.calls, 1);
  assert.equal(result.failedPages.length, 0);
  assert.equal(result.proposal?.questions.length, 3);
  const assembled = assembleReadProposal(result.proposal!, source);
  const compiled = await compileDocument({ questions: assembled.questions, sections: assembled.sections, lines: source, keyLineNos: [], accountedLineNos: [...result.proposal!.labels.keys()] });
  assert.ok(compiled.defects.length > 0);
  assert.equal(compiled.pageStatus.get(1), 'partial');
});

test('stream breaker stops a counting generation before the read cap without transport retry', async () => {
  const { LLMAdapter, CountingLoopError } = await import('../src/providers/adapter');
  const original = globalThis.fetch;
  let fetches = 0, sent = 0, cancelled = false;
  globalThis.fetch = (async () => {
    fetches++;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: `${sent},` })}\n\n`));
        if (sent > 100) controller.close();
      },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    // #46: the breaker is a pathology guard, not an abort class. With salvagePartial it returns the partial stream.
    const partial = await LLMAdapter.execute({ role: 'read', system: '', text: '', label: 'page', maxOutputTokens: 2000 }, { onDelta: () => {}, detectCountingLoop: true, salvagePartial: true });
    assert.equal(partial.finishReason, 'counting-loop');
    assert.ok(partial.rawText.length > 0);
    assert.equal(fetches, 1);
    assert.ok(sent < 100);
    // Aborting the underlying fetch stops generation even though there is no done event.
    assert.ok(cancelled || sent < 100);
  } finally { globalThis.fetch = original; }
});

test('pure enumeration with no complete question fast-paths to cloud', async () => {
  let local = 0;
  const result = await runGlobalReadStage({ lines, format: 'verbose', caller: async () => {
    local++;
    return { rawText: `{"questions":[${Array.from({ length: 60 }, (_, i) => i + 1).join(',')}` };
  }, cloudCaller: async () => ({ rawText: JSON.stringify(compact), json: compact }) });
  assert.equal(local, 1);
  assert.equal(result.cloudCalls, 1);
  assert.equal(result.pages[0].status, 'cloud ok');
});
