import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamDoc, LLMRequest, LLMResponse, Question, SourceLine } from '../src/types';
import { assembleAndValidateQuestions, assembleAndValidateSections, extractSafeTableRows } from '../src/pipeline/assemble';
import { autoDecorateRepeatedImages, enumerateExpectedQuestionNos, evaluateCoverage, getExamHealth, computeImageQuestionHints } from '../src/pipeline/quality';
import { isSuspectStrip, mergeAdjacentImageGeometry } from '../src/pipeline/imageGeometry';
import { expandWireV2, runStructurePass } from '../src/pipeline/structure';
import { runEscalationRepair } from '../src/pipeline/repair';
import { LLMAdapter } from '../src/providers/adapter';
import { DEFAULT_SETTINGS } from '../src/store';
import { AppSettingsSchema, parseExamDocImport, redactSettingsForExport, validateExtraBodyJson, validateProviderBaseUrl, validateHeaders, validateJsonSize } from '../src/utils/validation';
import { buildExportDoc, confirmPartialExport } from '../src/utils/examExport';
import { buildQuestionTree } from '../src/utils/questionTree';

const makeLines = (texts: string[], page = 1): SourceLine[] => texts.map((text, index) => ({ id: `L${String(index + 1).padStart(4, '0')}`, page, text }));
const image = (id: string, page: number, bbox = { x: 10, y: 10, w: 80, h: 30 }, dHash = 'same') => ({
  id, page, bbox, mime: 'image/jpeg', sha: `${id}-sha`, width: 80, height: 30, anchorLine: undefined,
  imageFlags: [], blobKey: `${id}-blob`, dHash,
});

const oneQuestionWire = (no: number, line: number, points = 1) => ({ n: no, s: 'sec_1', t: 's', p: [[line, line]], v: points, c: 8 });
const response = (json: unknown, label?: string): LLMResponse => ({ json, rawText: JSON.stringify(json), finishReason: 'STOP', label, usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 } });

// (1) Expected numbering is enumerated before answer-key territory; Persian and Arabic digits normalize.
test('enumerates printed numbers before answer-key territory and normalizes digits', () => {
  const lines: SourceLine[] = [
    { id: 'L0001', page: 1, text: '۱- Question one' },
    { id: 'L0002', page: 1, text: '2) Question two' },
    { id: 'L0003', page: 2, text: 'Answer Key' },
    { id: 'L0004', page: 2, text: '۳. B' },
    { id: 'L0005', page: 2, text: '۴. C' },
  ];
  const enumerated = enumerateExpectedQuestionNos(lines);
  assert.deepEqual(enumerated.numbers, [1, 2]);
  assert.deepEqual([...enumerated.keyTerritory.lineNos], [3, 4, 5]);
  const prose = enumerateExpectedQuestionNos(makeLines(['1. Explain what an answer key is.', '2. Continue.']));
  assert.deepEqual(prose.numbers, [1, 2]);
  assert.equal(prose.keyTerritory.markerLine, undefined);
  const samePage = enumerateExpectedQuestionNos(makeLines(['1. First question', '2. Second question', 'Answer Key', '1. A']));
  assert.deepEqual(samePage.numbers, [], 'early key heading starts territory at the page first line (A3 page-position rule)');
  assert.deepEqual([...samePage.keyTerritory.lineNos], [1, 2, 3, 4]);
});

// (2) A shared OCR line with multiple option markers is split deterministically and removed from the stem.
test('splits inline option markers and keeps option text out of stems', () => {
  const source = makeLines(['1. Which color is primary? a) red b) blue c) yellow']);
  const result = assembleAndValidateQuestions([{
    id: 'q1', no: 1, label: '1', type: 'mcq', spans: [[1, 1]], points: 1,
    options: [{ key: 'a', spans: [[1, 1]] }, { key: 'b', spans: [[1, 1]] }, { key: 'c', spans: [[1, 1]] }], confidence: 0.9,
  }], source, 1);
  assert.equal(result.questions[0].stem, '1. Which color is primary?');
  assert.deepEqual(result.questions[0].options?.map(option => option.text), ['red', 'blue', 'yellow']);
  for (const option of result.questions[0].options || []) assert.equal(result.questions[0].stem?.includes(option.text || ''), false);

  const multiline = assembleAndValidateQuestions([{
    id: 'q1', no: 1, type: 'mcq', spans: [[1, 1]],
    options: [{ key: 'a', spans: [[2, 2]] }, { key: 'b', spans: [[3, 3]] }], confidence: 0.9,
  }], makeLines(['1. Choose one.', 'a) red', 'b) blue']));
  assert.deepEqual(multiline.questions[0].options?.map(option => option.text), ['red', 'blue']);

  const ordinaryOptionWord = assembleAndValidateQuestions([{
    id: 'q1', no: 1, type: 'mcq', spans: [[1, 1]], options: [{ key: 'a', spans: [[1, 1]] }, { key: 'b', spans: [[1, 1]] }], confidence: 0.9,
  }], makeLines(['1. Option A is part of the stem. a) A b) B']));
  assert.equal(ordinaryOptionWord.questions[0].stem, '1. Option A is part of the stem.');
});

// (3) Grouped answer-key rows are clipped to the matching printed number only.
test('segments a grouped answer line to the requested question number', () => {
  const source = makeLines(['2. Solve the equation.', '1-A 2-C 3-B']);
  const result = assembleAndValidateQuestions([{
    id: 'q2', no: 2, label: '2', type: 'short', spans: [[1, 1]], answer: { spans: [[2, 2]] }, confidence: 0.9,
  }], source);
  assert.equal(result.questions[0].answer?.text, 'C');
});

test('clips option and table spans out of answer-key territory while preserving answer spans', () => {
  const source = makeLines(['1. Choose one.', 'a) A   b) B', 'Answer Key', '1. B']);
  const result = assembleAndValidateQuestions([{
    id: 'q1', no: 1, label: '1', type: 'mcq', spans: [[1, 1]],
    options: [{ key: 'a', spans: [[2, 4]] }, { key: 'b', spans: [[2, 2]] }],
    tables: [{ spans: [[3, 4]] }], answer: { spans: [[4, 4]] }, confidence: 0.9,
  }], source, undefined, { keyTerritoryLineNos: [3, 4] });
  assert.ok(result.questions[0].options?.every(option => option.spans.every(([start, end]) => end < 3)));
  assert.equal(result.questions[0].tables, undefined);
  assert.deepEqual(result.questions[0].answer?.spans, [[4, 4]]);
});

// (4) Printed numbering overrides a model-shifted sequence and is explicitly flagged.
test('corrects a shifted model number from the printed source span', () => {
  const source = makeLines(['18. Find the value of x.']);
  const result = assembleAndValidateQuestions([{ id: 'q19', no: 19, label: '19', type: 'short', spans: [[1, 1]], confidence: 0.9 }], source);
  assert.equal(result.questions[0].no, 18);
  assert.equal(result.questions[0].label, '18');
  assert.ok(result.flags.some(flag => flag.code === 'NUMBERING_CORRECTED'));
});

test('repairs parent cycles without losing questions and marks legacy cycles unhealthy', () => {
  const source = makeLines(['1. Parent question', '2. Child question']);
  const assembled = assembleAndValidateQuestions([
    { id: 'q1', no: 1, label: '1', parentId: 'q2', type: 'short', spans: [[1, 1]], confidence: 0.9 },
    { id: 'q2', no: 2, label: '2', parentId: 'q1', type: 'short', spans: [[2, 2]], confidence: 0.9 },
  ], source);
  assert.ok(assembled.flags.some(flag => flag.code === 'PARENT_CYCLE_REPAIRED'));
  const tree = buildQuestionTree(assembled.questions);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.children.size, 1);
  assert.equal(tree.roots.length + [...tree.children.values()].reduce((count, children) => count + children.length, 0), 2);

  const legacy = {
    id: 'exam_cycle', fileHash: 'hash', createdAt: '2026-01-01T00:00:00.000Z', displayName: 'Cycle',
    meta: { language: 'en', direction: 'ltr' }, sections: [], questions: [
      { id: 'q1', label: '1', no: 1, parentId: 'q2', spans: [[1, 1]], stem: source[0].text, type: 'short', images: [], confidence: 0.9 },
      { id: 'q2', label: '2', no: 2, parentId: 'q1', spans: [[2, 2]], stem: source[1].text, type: 'short', images: [], confidence: 0.9 },
    ], images: [], source: { lines: source, pages: 1, ocrUsed: false, fileName: 'cycle.pdf', expectedQuestionNos: [1, 2] }, flags: [], usage: [],
  } as ExamDoc;
  const health = getExamHealth(legacy);
  assert.equal(health.parentLinkIssueCount, 1);
  assert.equal(health.complete, false);
});

test('excludes question candidates whose spans are entirely in answer-key territory', () => {
  const source = makeLines(['1. Question one', 'Answer Key', '1. A']);
  const result = assembleAndValidateQuestions([{ id: 'key-row', no: 1, spans: [[3, 3]], type: 'short', confidence: 0.9 }], source, undefined, { keyTerritoryLineNos: [2, 3] });
  assert.equal(result.questions.length, 0);
  assert.ok(result.flags.some(flag => flag.code === 'KEY_TERRITORY_EXCLUDED'));
});

test('escalation repair clips answer-key question spans and refuses an empty repaired item', async () => {
  const originalExecute = LLMAdapter.execute;
  const source = makeLines(['1. Keep this question.', 'Answer Key', '1. A']);
  const question: Question = { id: 'q1', label: '1', no: 1, spans: [[1, 1]], stem: source[0].text, type: 'short', images: [], confidence: 0.3 };
  LLMAdapter.execute = (async (request: LLMRequest) => {
    assert.match(request.text, /\[KEY\] 1\. A/);
    return response({ items: [{ id: 'q1', patch: { spans: [[3, 3]] } }] }, request.label);
  }) as typeof LLMAdapter.execute;
  try {
    const result = await runEscalationRepair({
      failingItems: [{ question, errors: ['invalid anchor'] }], allQuestions: [question], sourceLines: source,
      keyTerritoryLineNos: [2, 3], providerConfig: { kind: 'openai-compatible', id: 'mock', name: 'Mock', model: 'mock', baseURL: 'https://example.com/v1' },
    });
    assert.equal(result.repairedQuestions.length, 0);
    assert.equal(result.rejectedCount, 1);
  } finally { LLMAdapter.execute = originalExecute; }
});

// (5) Instructions stay separate from a locally sliced multi-line passage.
test('assembles section title, local directions, points, and passage without model prose', () => {
  const source = makeLines([
    'Reading',
    'Read the passage and answer the questions. (2 points)',
    'The river begins high in the mountains and travels east.',
    'It provides clean water for farms and nearby towns.',
    '1. Where does the river begin?',
    '2. What does it provide?',
  ]);
  const questions = [1, 2].map(no => ({ id: `q${no}`, no, label: String(no), sectionId: 'sec_1', spans: [[no + 4, no + 4] as [number, number]], stem: source[no + 3].text, type: 'short' as const, points: 1, images: [], confidence: 0.9 }));
  const result = assembleAndValidateSections([{ id: 'sec_1', index: 1, title: 'Reading', spans: [[1, 6]] }], source, questions);
  assert.equal(result.sections[0].instructions, 'Read the passage and answer the questions. (2 points)');
  assert.match(result.sections[0].passage || '', /river begins high/);
  assert.match(result.sections[0].passage || '', /clean water/);
  assert.ok(!result.sections[0].passage?.includes('1. Where'));
});

// (6) Coverage includes duplicates and point-total defects; duplicate numbers can never be green.
test('coverage reports missing, duplicate, and point-total defects', () => {
  const coverage = evaluateCoverage([1, 2, 3], [
    { no: 1, stem: '1. first', points: 1 },
    { no: 1, stem: '1. duplicate', points: 1 },
    { no: 2, stem: '2. second', points: 1 },
  ], 4);
  assert.deepEqual(coverage.missing, [3]);
  assert.deepEqual(coverage.duplicates, [1]);
  assert.equal(coverage.pointsParsed, 3);
  assert.equal(coverage.pointDeficit, 1);
  assert.equal(coverage.complete, false);
});

// (7) Compact wire-v2 expands spans and types; v1 stays accepted and tagged.
test('expands compact wire-v2 and tolerates v1 structure payloads', () => {
  const v2 = expandWireV2({
    m: { subject: 'English', totalPoints: 2 },
    s: [{ id: 'sec_1', index: 1, p: [[1, 4]], kind: 'Reading' }],
    q: [{ n: 1, s: 'sec_1', t: 'm', p: [[2, 2]], v: 1, o: [['a', [[3, 3]]]], a: [[4, 4]], c: 7 }],
  });
  assert.equal(v2.__wireFormat, 'v2');
  assert.equal(v2.questions[0].type, 'mcq');
  assert.deepEqual(v2.questions[0].spans, [[2, 2]]);
  assert.deepEqual(v2.questions[0].options[0].spans, [[3, 3]]);
  assert.equal(v2.meta.totalPoints, 2);
  const v1 = expandWireV2({ meta: {}, sections: [], questions: [{ no: 1, spans: [[1, 1]] }] });
  assert.equal(v1.__wireFormat, 'v1');
  assert.equal(v1.questions[0].no, 1);
});

// (8) Adjacent page image strips merge geometrically; suspect geometry is isolated.
test('merges adjacent same-page image strips and flags extreme strips', () => {
  const strips = [
    image('strip-a', 1, { x: 10, y: 10, w: 80, h: 40 }),
    image('strip-b', 1, { x: 11, y: 51, w: 79, h: 35 }),
    image('other-page', 2, { x: 10, y: 10, w: 80, h: 40 }),
  ];
  const groups = mergeAdjacentImageGeometry(strips, 1);
  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.assets.length > 1)?.bbox.h, 76);
  assert.equal(isSuspectStrip({ x: 0, y: 0, w: 400, h: 12 }, 1), true);
  assert.equal(isSuspectStrip({ x: 0, y: 0, w: 120, h: 60 }, 1), false);
});

// (9) Image hints are deterministic; repeated visual hashes across three pages are locally marked as decoration.
test('assigns geometric image hints and locally decorates repeated logos', () => {
  const source: SourceLine[] = [
    { id: 'L0001', page: 1, text: '1. Question one' },
    { id: 'L0002', page: 1, text: 'Question continues.' },
  ];
  const asset = { ...image('diagram', 1, { x: 1, y: 1, w: 20, h: 20 }), anchorLine: 2 };
  const hints = computeImageQuestionHints([asset], [{ id: 'q1', no: 1, label: '1', spans: [[1, 2]] }], source);
  assert.equal(hints.diagram.questionRef, '1');
  const logos = autoDecorateRepeatedImages([image('logo-1', 1), image('logo-2', 2), image('logo-3', 3)]);
  assert.ok(logos.every(item => item.label?.role === 'decoration'));
});

// (10) Imported/legacy table content is converted into inert text; unsafe attributes and scripts do not survive.
test('renders tables from text cells, never executable source HTML', () => {
  const rows = extractSafeTableRows('<table><tr><td onclick="steal()">safe</td><td><img src=x onerror="steal()"></td></tr></table><script>steal()</script>');
  const flattened = rows.flat().join(' ');
  assert.match(flattened, /safe/);
  assert.doesNotMatch(flattened, /onclick|onerror|script|steal\(/i);
});

// (11) Partial health survives an ExamDoc shape and lists both missing questions and orphaned assets.
test('health banner model refuses green for missing coverage and an unplaced image', () => {
  const source = makeLines(['1. One', '2. Two']);
  const doc: ExamDoc = {
    id: 'exam_test', fileHash: 'abc', createdAt: '2026-01-01T00:00:00.000Z', displayName: 'Fixture',
    meta: { language: 'en', direction: 'ltr', totalPoints: 2 },
    sections: [{ id: 'sec_1', index: 1, title: 'Section 1', spans: [[1, 2]] }],
    questions: [{ id: 'q1', label: '1', no: 1, sectionId: 'sec_1', spans: [[1, 1]], stem: '1. One', type: 'short', points: 1, images: [], confidence: 0.9 }],
    images: [{ ...image('orphan', 1), bbox: { x: 0, y: 0, w: 50, h: 50 }, blobKey: 'orphan-blob' }],
    source: { lines: source, pages: 1, ocrUsed: false, fileName: 'fixture.pdf', expectedQuestionNos: [1, 2], keyTerritoryLineNos: [] }, flags: [], usage: [],
  };
  const health = getExamHealth(doc);
  assert.deepEqual(health.missing, [2]);
  assert.equal(health.unplacedImages.length, 1);
  assert.notEqual(health.state, 'green');
  assert.equal(health.complete, false);
});

// (12) Bounded recovery after a parseable-but-incomplete first call requests only the missing printed number.
test('short-document missing-number recovery is bounded, labelled, and merges without duplicates', async () => {
  const originalExecute = LLMAdapter.execute;
  const source = makeLines(['1. First question', '2. Second question']);
  const calls: LLMRequest[] = [];
  LLMAdapter.execute = (async (request: LLMRequest) => {
    calls.push(request);
    if (calls.length === 1) return response({ m: { totalPoints: 2 }, s: [{ id: 'sec_1', index: 1, p: [[1, 2]], kind: 'Other' }], q: [oneQuestionWire(1, 1)] }, request.label);
    assert.match(request.text, /REQUIRED PRINTED QUESTIONS: 2/);
    return response({ m: { totalPoints: 2 }, s: [{ id: 'sec_1', index: 1, p: [[1, 2]], kind: 'Other' }], q: [oneQuestionWire(2, 2)] }, request.label);
  }) as typeof LLMAdapter.execute;
  try {
    const result = await runStructurePass({
      sourceLines: source, images: [], languageHint: 'en', latexEnabled: false,
      providerConfig: { kind: 'openai-compatible', id: 'mock', name: 'Mock', model: 'mock-instruct', baseURL: 'https://example.com/v1' },
      maxBudgetTokens: 4096,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.rawQuestions.length, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.recoveryCalls, 1);
    assert.ok(result.callUsage?.some(call => call.label.includes('Structure Recovery')));
    assert.equal(result.jsonNull, false);
  } finally { LLMAdapter.execute = originalExecute; }
});

test('large-document chunking marks answer-key lines and excludes key-only candidates from coverage', async () => {
  const originalExecute = LLMAdapter.execute;
  const source: SourceLine[] = [
    { id: 'L0001', page: 1, text: 'Answer Key' },
    { id: 'L0002', page: 1, text: '1. B' },
    { id: 'L0003', page: 1, text: `Notes ${'x'.repeat(120_100)}` },
  ];
  let calls = 0;
  const progress: string[] = [];
  LLMAdapter.execute = (async (request: LLMRequest) => {
    calls++;
    assert.match(request.text, /\[L0002\] \[KEY\] 1\. B/);
    return response({ m: {}, s: [], q: [{ n: 1, t: 's', p: [[2, 2]], c: 9 }] }, request.label);
  }) as typeof LLMAdapter.execute;
  try {
    const result = await runStructurePass({
      sourceLines: source, images: [], languageHint: 'en', latexEnabled: false,
      providerConfig: { kind: 'openai-compatible', id: 'mock', name: 'Mock', model: 'gpt-4o', baseURL: 'https://example.com/v1' },
      maxBudgetTokens: 16384, onProgress: message => progress.push(message),
    });
    assert.equal(calls, 1);
    assert.ok(progress.some(message => /attempt 1/i.test(message)));
    assert.equal(result.jsonNull, true);
    assert.ok(result.flags?.some(flag => flag.code === 'STRUCTURE_EMPTY'));
  } finally { LLMAdapter.execute = originalExecute; }
});

// Compatibility ladders: the adapter still returns the transport envelope and delivers SSE deltas.
test('LLM adapter preserves normal transport and live-stream delta behavior', async () => {
  const originalFetch = globalThis.fetch;
  const request: LLMRequest = { role: 'fast', system: 'Return JSON', text: '{}', label: 'transport-test' };
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ json: { ok: true }, rawText: '{"ok":true}', finishReason: 'STOP', usage: { inputTokens: 3, outputTokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const ordinary = await LLMAdapter.execute(request);
    assert.deepEqual(ordinary.json, { ok: true });

    let streamed = '';
    const done: LLMResponse = { json: { ok: true }, rawText: '{"ok":true}', finishReason: 'STOP', usage: { inputTokens: 3, outputTokens: 2 } };
    globalThis.fetch = (async () => new Response(`event: delta\ndata: ${JSON.stringify({ text: '{"ok":' })}\n\nevent: done\ndata: ${JSON.stringify(done)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
    const live = await LLMAdapter.execute(request, { onDelta: (_channel, full) => { streamed = full; } });
    assert.deepEqual(live.json, { ok: true });
    assert.equal(streamed, '{"ok":');
  } finally { globalThis.fetch = originalFetch; }
});

// Import/storage/settings validation and safe serialization tripwires.
test('validates import sizes, provider URLs, headers, extra body JSON, and default settings', () => {
  assert.equal(validateProviderBaseUrl('https://provider.example/v1'), true);
  assert.equal(validateProviderBaseUrl('javascript:alert(1)'), false);
  assert.equal(validateProviderBaseUrl('https://user:pass@provider.example/v1'), false);
  assert.equal(validateHeaders({ 'X-Trace': 'ok' }), true);
  assert.equal(validateHeaders({ 'X-Trace': 'bad\r\nInjected: yes' }), false);
  assert.equal(validateExtraBodyJson('{"enable_thinking":false}'), true);
  assert.equal(validateExtraBodyJson('{"__proto__":{"polluted":true}}'), false);
  assert.equal(AppSettingsSchema.safeParse(DEFAULT_SETTINGS).success, true);
  assert.equal(validateJsonSize({ ok: true }, 100), true);
  const raw = JSON.stringify({});
  assert.equal(parseExamDocImport(raw).doc, undefined);
});

test('imports normalize safe blobs, reject invalid spans, and exports redact provider secrets', () => {
  const imported = parseExamDocImport(JSON.stringify({
    id: 'exam_import', fileHash: 'hash', createdAt: '2026-01-01T00:00:00.000Z', displayName: 'Import',
    meta: { language: 'en', direction: 'ltr' },
    sections: [{ id: 'sec_1', index: 1, title: 'Section', spans: [[1, 1]] }],
    questions: [{ id: 'q1', label: '1', no: 1, type: 'short', spans: [[1, 1]], confidence: 0.8, secretToken: 'question-secret' }],
    images: [{ id: 'img1', page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: 'abc', width: 10, height: 10, blobKey: '../../outside', dataUrl: 'data:image/png;base64,AA==' }],
    source: { lines: [{ id: 'L0001', page: 1, text: '1. Question' }], pages: 1, ocrUsed: false, fileName: 'x.pdf', pageImages: ['data:image/png;base64,AA=='], pageThumbKeys: ['../../outside'] },
    providerConfig: { apiKey: 'import-secret' }, flags: [], usage: [],
  }));
  assert.ok(imported.doc);
  assert.equal(imported.doc?.questions[0].images.length, 0);
  assert.equal(imported.doc?.images[0].dataUrl, undefined);
  assert.equal(imported.doc?.images[0].blobKey, '');
  assert.equal(imported.doc?.source.pageImages, undefined);
  assert.deepEqual(imported.doc?.source.pageThumbKeys, []);
  assert.doesNotMatch(JSON.stringify(imported.doc), /question-secret|import-secret/);

  const invalid = JSON.parse(JSON.stringify({
    id: 'exam_import', fileHash: 'hash', createdAt: '2026-01-01T00:00:00.000Z',
    meta: { language: 'en', direction: 'ltr' }, sections: [],
    questions: [{ id: 'q1', label: '1', no: 1, type: 'short', spans: [[2, 2]], confidence: 0.8 }],
    images: [], source: { lines: [{ id: 'L0001', page: 1, text: '1. Question' }], pages: 1, ocrUsed: false, fileName: 'x.pdf' },
  }));
  assert.match(parseExamDocImport(JSON.stringify(invalid)).error || '', /outside the line-addressed source/);

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.providers[0].apiKey = 'provider-secret-value';
  settings.providers[0].defaultHeaders = { 'X-API-Key': 'header-secret-value', 'X-Trace': 'keep' };
  settings.providers[0].extraBodyJson = JSON.stringify({ auth_token: 'body-secret-value', temperature: 0.1 });
  const exportedSettings = JSON.stringify(redactSettingsForExport(settings));
  assert.doesNotMatch(exportedSettings, /provider-secret-value|header-secret-value|body-secret-value/);
  assert.match(exportedSettings, /X-Trace/);

  const partial = {
    id: 'exam_partial', fileHash: 'hash', createdAt: '2026-01-01T00:00:00.000Z', displayName: 'Partial',
    meta: { language: 'en', direction: 'ltr', totalPoints: 2 }, sections: [], questions: [], images: [],
    source: { lines: makeLines(['1. Q']), pages: 1, ocrUsed: false, fileName: 'x.pdf', expectedQuestionNos: [1] }, flags: [], usage: [],
    providerConfig: { apiKey: 'document-secret' },
  } as any as ExamDoc;
  assert.doesNotMatch(JSON.stringify(buildExportDoc(partial)), /document-secret/);
  const originalWindow = (globalThis as any).window;
  const confirmationMessages: string[] = [];
  (globalThis as any).window = { confirm: (message: string) => { confirmationMessages.push(message); return false; } };
  try {
    for (const action of ['Print / Save PDF', 'Export DOCX', 'Export']) assert.equal(confirmPartialExport(partial, action), false);
    assert.equal(confirmationMessages.length, 3);
    assert.ok(confirmationMessages.every(message => /PARTIAL/.test(message)));
  } finally { if (originalWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = originalWindow; }

  const empty = { ...partial, source: { ...partial.source, expectedQuestionNos: [] }, meta: { language: 'en', direction: 'ltr' }, questions: [] } as ExamDoc;
  assert.equal(getExamHealth(empty).complete, false, 'an empty reconstruction must never be marked complete');
});

// Current fixture output uses fewer compact keys than its fully expanded equivalent.
test('compact v2 wire shape is materially smaller than the expanded v1 payload', () => {
  const compact = { m: { subject: 'English' }, s: [{ id: 'sec_1', index: 1, p: [[1, 4]], kind: 'Reading' }], q: [{ n: 1, t: 'm', p: [[2, 2]], v: 1, o: [['a', [[3, 3]]], ['b', [[4, 4]]]], c: 8 }] };
  const expanded = { meta: { subject: 'English' }, sections: [{ id: 'sec_1', index: 1, spans: [[1, 4]], title: 'Reading' }], questions: [{ id: 'q1', label: '1', no: 1, sectionId: 'sec_1', type: 'mcq', spans: [[2, 2]], points: 1, options: [{ key: 'a', spans: [[3, 3]] }, { key: 'b', spans: [[4, 4]] }], confidence: 0.8 }] };
  const saving = (1 - JSON.stringify(compact).length / JSON.stringify(expanded).length) * 100;
  assert.ok(saving > 40, `wire-v2 savings ${saving.toFixed(1)}% should exceed 40% on this fixture`);
});
