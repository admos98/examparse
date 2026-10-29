/**
 * ExamParse Follow-up #50 — Fix the input, tame the pathologies.
 * A loops (breaker, declared counts, caps, salvage + one retry, repeat_penalty) · B cloze blanks ·
 * C input hygiene (digit twin, corrupt digits, watermarks) · D difficulty score shape · E section re-read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { LLMAdapter } from '../src/providers/adapter';
import { RepetitionBreaker, REPEAT_LIMIT } from '../src/pipeline/streamBreaker';
import { parseExamMap, sectionReadVerdicts, type LoopMapReceipt } from '../src/pipeline/mapFirst';
import { fixOutputCap, MAP_OUTPUT_CAP, sectionOutputCap, parseCorrections, normalizeAuthoredDocument, reconcileAuthoredQuestions, type LoopModelCaller, type LoopModelRequest, type LoopModelResponse } from '../src/pipeline/localLoop';
import { runLocalLoop } from '../src/pipeline/localLoopRunner';
import { annotateSourceLines, latinDigits, modelFacingLines, normalizeLineDigits, isWatermarkShape, SUSPECT_DIGIT_MARK } from '../src/pipeline/lineNormalize';
import { extractionDiagnostics } from '../src/pipeline/extractionQuality';
import { buildThxDecisionBody, runLoopDecisionAudit, DIFFICULTY_LEVELS, DIFFICULTY_UNCERTAIN_BELOW } from '../src/pipeline/loopAudit';
import { scriptedLoopReader, scoreLoopEntry } from '../scripts/corpusLoop';
import { DEFAULT_SETTINGS } from '../src/store';
import type { SourceLine } from '../src/types';

const settings = { ...DEFAULT_SETTINGS, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false }, roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: undefined } } as any;
const clozeDir = 'test/fixtures/corpus/cloze-passage';
const clozeLines = (): SourceLine[] => JSON.parse(fs.readFileSync(path.join(clozeDir, 'source-lines.json'), 'utf8'));
const clozeTruth = () => JSON.parse(fs.readFileSync(path.join(clozeDir, 'truth.json'), 'utf8'));
const corrections = (rows: unknown[] = []) => ({ rawText: JSON.stringify({ corrections: rows }) });
const isMap = (req: LoopModelRequest) => req.step === 'read' && req.label.startsWith('Map ·');
const isSection = (req: LoopModelRequest) => req.step === 'read' && req.label.startsWith('Section parse ·');

// -------------------------------------------------------------------------------------------------
// A — loops can't hurt
// -------------------------------------------------------------------------------------------------
const GROUP = '{"appliesToFirst":1,"appliesToLast":8,"text":"Choose the correct answer."}';
const MAP_PREFIX = '{"meta":{},"sectionCount":1,"sections":[{"title":"Vocabulary","firstQuestion":1,"lastQuestion":8,"questionCount":8,"kind":"vocabulary"}],"instructionGroupCount":1,"instructionGroups":[';

test('A: a stub stream repeating one object ×10 is cut at the 3rd repetition and the complete prefix is salvaged', async () => {
  const frames = [MAP_PREFIX, ...Array.from({ length: 10 }, () => `${GROUP},`)].map(text => `event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
  frames.push(`event: done\ndata: ${JSON.stringify({ json: null, rawText: 'never reached', usage: { inputTokens: 1, outputTokens: 1 } })}\n\n`);
  let pulled = 0; let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (pulled >= frames.length) { controller.close(); return; } controller.enqueue(encoder.encode(frames[pulled++])); },
    cancel() { cancelled = true; },
  });
  const old = globalThis.fetch; const infos: string[] = [];
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as any;
  try {
    const response = await LLMAdapter.execute({ role: 'read' as any, system: 's', text: 't', label: 'Map · 1/1' }, {
      onDelta: () => undefined, onInfo: m => infos.push(m), detectRepetition: true, detectCountingLoop: true, salvagePartial: true,
    });
    assert.equal(response.finishReason, 'repetition-loop');
    // Cut at the 3rd repetition; "item N" counts every completed list item (1 section + 3 groups).
    assert.deepEqual(response.breaker, { kind: 'repetition', completedItems: 1 + REPEAT_LIMIT });
    // The stream was cut: the prefix + exactly 3 elements were read, the remaining 7 never pulled.
    assert.equal(response.rawText.split(GROUP).length - 1, 3);
    assert.ok(pulled <= 1 + 3 + 1, `pulled ${pulled} frames`);
    assert.equal(cancelled, true, 'reader cancelled');
    assert.ok(infos.some(m => /^stream cut — /.test(m)), infos.join(' | '));
    // Salvage compiles the complete prefix; exact duplicates are reconciled away.
    const map = parseExamMap(response)!;
    assert.equal(map.instructionGroups.length, 1);
    assert.deepEqual(map.reconciled, { truncated: 0, deduped: 2 });
  } finally { globalThis.fetch = old; }
});

test('A: the breaker hashes top-level list elements only — identical nested options never trip', () => {
  const breaker = new RepetitionBreaker();
  const q = (n: number) => `{"number":${n},"stem":"Q${n}","options":[{"key":"a","text":"True"},{"key":"b","text":"False"}]}`;
  assert.equal(breaker.push(`{"questions":[${[1, 2, 3, 4, 5].map(q).join(',')}]}`), undefined);
  const looping = new RepetitionBreaker();
  const trip = looping.push(`{"questions":[${q(1)},${q(1)},${q(1)}`);
  assert.equal(trip?.completedItems, 3);
});

test('A: map compile — declared count 3 with 9 groups keeps 3, drops exact duplicates first, receipt reconciles', () => {
  const g = (first: number, text: string) => ({ appliesToFirst: first, appliesToLast: first + 1, text });
  const [A, B, C, D, E, F, G] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((t, i) => g(i * 2 + 1, `Instruction ${t}`));
  const raw = { sectionCount: 1, sections: [{ title: 'All', firstQuestion: 1, lastQuestion: 14, questionCount: 14 }],
    instructionGroupCount: 3, instructionGroups: [A, { ...A, text: '  Instruction   A ' }, B, C, D, A, E, F, G],
    passageCount: 1, passages: [{ id: 'p1', sectionTitle: 'All', appliesToFirst: 9, appliesToLast: 13, text: 'Passage' }, { id: 'p1', sectionTitle: 'All', appliesToFirst: 9, appliesToLast: 13, text: 'Passage' }] };
  const map = parseExamMap({ rawText: JSON.stringify(raw) })!;
  assert.deepEqual(map.instructionGroups.map(x => x.text), ['Instruction A', 'Instruction B', 'Instruction C']);
  assert.equal(map.passages.length, 1);
  // groups: 2 duplicates of A dropped, then 4 beyond the declared 3 truncated; passages: 1 duplicate.
  assert.deepEqual(map.reconciled, { truncated: 4, deduped: 3 });
  // A declared sectionCount below 1 is ignored rather than wiping the map.
  assert.equal(parseExamMap({ rawText: JSON.stringify({ ...raw, sectionCount: 0 }) })!.sections.length, 1);
  // Section parse: same number + same normalized stem is a duplicate; then questionCount truncates.
  const stats = { truncated: 0, deduped: 0 };
  const doc = reconcileAuthoredQuestions(normalizeAuthoredDocument({ questions: [
    { number: 1, type: 'short', stem: 'Alpha?' }, { number: 1, type: 'short', stem: ' Alpha? ' }, { number: 2, type: 'short', stem: 'Beta?' }, { number: 3, type: 'short', stem: 'Gamma?' },
  ] }), 2, stats);
  assert.deepEqual(doc.questions.map(q => q.number), [1, 2]);
  assert.deepEqual(stats, { truncated: 1, deduped: 1 });
});

test('A: proportional output caps per call type (map / section parse / fix passes)', async () => {
  assert.equal(MAP_OUTPUT_CAP, 3000);
  assert.equal(sectionOutputCap(9), 800 + 9 * 220);
  assert.equal(fixOutputCap(0), 800); assert.equal(fixOutputCap(1), 800); assert.equal(fixOutputCap(2), 1000); assert.equal(fixOutputCap(100), 8192);
  const lines = clozeLines(); const reader = scriptedLoopReader(lines);
  const caps: Array<[string, number]> = [];
  await runLocalLoop({ lines, images: [], settings, fileHash: 'caps', modelId: 'caps', caller: async req => { caps.push([req.label, req.maxOutputTokens!]); return reader(req); } });
  const cap = (label: string) => caps.find(([l]) => l === label)?.[1];
  assert.equal(cap('Map · 1/1'), 3000);
  assert.equal(cap('Section parse · Vocabulary'), sectionOutputCap(8));
  assert.equal(cap('Section parse · Reading'), sectionOutputCap(5));
  assert.equal(cap('Section parse · Writing'), sectionOutputCap(2));
  assert.equal(cap('Self-review · 1'), fixOutputCap(15));
  const fix = caps.find(([l]) => l.startsWith('Code-verdict fix'));
  assert.ok(fix && fix[1] >= 800 && fix[1] <= 8192, JSON.stringify(caps));
});

test('A: a map pathology gets ONE retry with the complaint quoted; the note reports the cut and salvage', async () => {
  const lines = clozeLines(); const reader = scriptedLoopReader(lines);
  const mapCalls: LoopModelRequest[] = [];
  const looping: LoopModelResponse = { rawText: `${MAP_PREFIX}${GROUP},${GROUP},${GROUP}`, finishReason: 'repetition-loop', breaker: { kind: 'repetition', completedItems: 3 } };
  const receipt = await runLocalLoop({ lines, images: [], settings, fileHash: 'retry', caller: async req => {
    if (isMap(req)) { mapCalls.push(req); if (mapCalls.length === 1) return looping; }
    return reader(req);
  } });
  assert.deepEqual(mapCalls.map(r => r.label), ['Map · 1/1', 'Map · 1/1 · re-read']);
  assert.match(mapCalls[1].text, /your previous output repeated the same item; emit each item once/);
  assert.ok(receipt.notes.some(n => /Map · 1\/1: generation loop cut at item 3 — salvaged \d+ items? \(pathology: repetition\)/.test(n)), receipt.notes.join('\n'));
  assert.equal(receipt.pathologies?.[0]?.outcome, 'recovered');
  assert.equal(receipt.document.questions.length, 15, 'the clean retry wins');
});

test('A: a second pathology on the same target is marked partial — never a third attempt', async () => {
  const lines = clozeLines(); const reader = scriptedLoopReader(lines);
  let mapCalls = 0;
  const receipt = await runLocalLoop({ lines, images: [], settings, fileHash: 'twice', caller: async req => {
    if (isMap(req)) { mapCalls++; return { rawText: `${MAP_PREFIX}${GROUP},${GROUP},${GROUP}`, finishReason: 'repetition-loop', breaker: { kind: 'repetition', completedItems: 3 } }; }
    return reader(req);
  } });
  assert.equal(mapCalls, 2);
  assert.ok(receipt.notes.some(n => /second pathology on the same target — marked partial; no third attempt/i.test(n)), receipt.notes.join('\n'));
  assert.equal(receipt.pathologies?.[0]?.outcome, 'partial');
});

test('A: a fix pass cut by the breaker salvages its complete corrections and retries once', async () => {
  const lines: SourceLine[] = [{ id: 'L0001', page: 1, text: '1. What is force?' }, { id: 'L0002', page: 1, text: '2. Name a planet.' }];
  const fixed = { action: 'replace', questionNumber: 2, question: { number: 2, type: 'short', stem: 'Name a planet.', options: [], imageIds: [] } };
  const fixCalls: LoopModelRequest[] = [];
  const receipt = await runLocalLoop({ lines, images: [], settings, fileHash: 'fixcut', caller: async req => {
    if (isMap(req)) return { rawText: '{}' };
    if (req.step === 'read') return { rawText: JSON.stringify({ questions: [{ number: 1, type: 'short', stem: 'What is force?' }, { number: 2, type: 'short', stem: '' }] }) };
    if (req.step === 'code-fix') {
      fixCalls.push(req);
      if (fixCalls.length === 1) return { rawText: `{"corrections":[${JSON.stringify(fixed)},${JSON.stringify(fixed)},${JSON.stringify(fixed)}`, finishReason: 'repetition-loop', breaker: { kind: 'repetition', completedItems: 3 } };
      return corrections();
    }
    return corrections();
  } });
  assert.equal(fixCalls.length, 2, 'one retry, no third call');
  // fix cap = 400 + flagged × 300 (floor 800): Q2 plus at most one un-numbered verdict in the group.
  assert.ok([fixOutputCap(1), fixOutputCap(2)].includes(fixCalls[0].maxOutputTokens!), String(fixCalls[0].maxOutputTokens));
  assert.equal(fixCalls[1].maxOutputTokens, fixCalls[0].maxOutputTokens, 'the retry keeps the cap');
  assert.equal(receipt.document.questions.find(q => q.number === 2)?.stem, 'Name a planet.', 'salvaged correction applied (deduped to one)');
  assert.ok(receipt.notes.some(n => /Code-verdict fix · 1: generation loop cut at item 3 — salvaged 1 item/.test(n)), receipt.notes.join('\n'));
  // Without a pathology flag, an unparseable patch is still all-or-nothing.
  assert.equal(parseCorrections({ rawText: `{"corrections":[${JSON.stringify(fixed)}` }), undefined);
});

test('A: the server sends repeat_penalty 1.12 for read-role calls only, and drops it if the provider rejects it', async () => {
  const bodies: any[] = []; let reject = false;
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      const body = JSON.parse(raw); bodies.push(body);
      if (reject && 'repeat_penalty' in body) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: repeat_penalty' } })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upPort = (upstream.address() as net.AddressInfo).port;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'examparse-fu50-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as net.AddressInfo).port; await new Promise<void>(r => probe.close(() => r()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', PORT: String(port), EXAMFORGE_DATA_DIR: '', EXAMPARSE_CONFIG_FILE: path.join(root, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject_) => {
      let output = ''; const timeout = setTimeout(() => reject_(new Error(`startup timed out: ${output}`)), 20_000);
      child.stdout.on('data', c => { output += String(c); if (output.includes('ExamParse server running')) { clearTimeout(timeout); resolve(); } });
      child.stderr.on('data', c => { output += String(c); });
      child.on('exit', code => { clearTimeout(timeout); reject_(new Error(`server exited ${code}: ${output}`)); });
    });
    const providerConfig = { id: 'local', name: 'local', kind: 'openai-compatible', baseURL: `http://127.0.0.1:${upPort}/v1`, model: 'm', apiKey: '' };
    const post = (role: string) => fetch(`http://127.0.0.1:${port}/api/llm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, system: 's', text: 't', label: `${role} probe`, maxOutputTokens: 100, providerConfig }) });
    assert.equal((await post('read')).status, 200);
    assert.equal(bodies.at(-1).repeat_penalty, 1.12);
    assert.equal((await post('vision')).status, 200);
    assert.equal('repeat_penalty' in bodies.at(-1), false, 'non-read roles are untouched');
    reject = true; const before = bodies.length;
    assert.equal((await post('read')).status, 200, 'the [no-repeat-penalty] rung recovers');
    assert.equal(bodies.length - before, 2);
    assert.equal('repeat_penalty' in bodies.at(-1), false);
  } finally {
    child.kill('SIGTERM'); upstream.close(); await fsp.rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------------
// B — cloze blanks are questions
// -------------------------------------------------------------------------------------------------
test('B: cloze passage with blanks (9)–(13) becomes 5 passage-linked fillblank questions (corpus entry)', async () => {
  const score = await scoreLoopEntry('cloze-passage', clozeLines(), clozeTruth());
  assert.equal(score.questions, '15/15'); assert.equal(score.sections, '3/3');
  const blanks = score.receipt.document.questions.filter(q => q.number >= 9 && q.number <= 13);
  assert.deepEqual(blanks.map(q => q.number), [9, 10, 11, 12, 13]);
  for (const q of blanks) {
    assert.equal(q.type, 'fillblank'); assert.equal(q.passageId, 'p1');
    assert.match(q.stem, new RegExp(`\\(${q.number}\\)`), 'stem is the printed text around the blank');
  }
  assert.deepEqual(score.receipt.map?.passages[0].blanks, [9, 10, 11, 12, 13]);
  assert.equal(score.receipt.map?.sections.find(s => s.title === 'Reading')?.questionCount, 5);
  assert.ok(!score.receipt.survivingVerdicts.some(v => v.kind === 'blank-missing'));
});

test('B: blank-missing fires when the section parse drops a map-declared blank, and the fix is section-scoped', async () => {
  const lines = clozeLines(); const reader = scriptedLoopReader(lines);
  const fixInputs: string[] = [];
  const receipt = await runLocalLoop({ lines, images: [], settings, fileHash: 'drop11', caller: async req => {
    if (isSection(req)) {
      const response = await reader(req); const json = JSON.parse(response.rawText);
      json.questions = json.questions.filter((q: any) => q.number !== 11); json.questionCount = json.questions.length;
      return { rawText: JSON.stringify(json) };
    }
    if (req.step === 'code-fix') fixInputs.push(req.text);
    return reader(req);
  } });
  const verdict = receipt.codeVerdicts.find(v => v.kind === 'blank-missing');
  assert.ok(verdict, JSON.stringify(receipt.codeVerdicts));
  assert.equal(verdict!.id, 'code:blank-missing:p1:11');
  assert.deepEqual(verdict!.questionNumbers, [11]); assert.equal(verdict!.page, 1);
  assert.equal(receipt.sectionReReads, 0, '4 of 5 is not an under-count');
  assert.ok(fixInputs.some(t => t.includes('SECTION SCOPE') && t.includes('"blanks":[9,10,11,12,13]')), 'fix input carries the owning section + passage');
  // Unit: verdict uses the printed (n) line for its page and stays silent when the blank was parsed.
  const map = receipt.map as LoopMapReceipt;
  const full = normalizeAuthoredDocument({ questions: [9, 10, 11, 12, 13].map(n => ({ number: n, type: 'fillblank', stem: `(${n})`, passageId: 'p1' })) });
  assert.equal(sectionReadVerdicts(map, full, lines).filter(v => v.kind === 'blank-missing').length, 0);
});

// -------------------------------------------------------------------------------------------------
// C — input hygiene at line-build
// -------------------------------------------------------------------------------------------------
test('C: digit twin — Persian/Arabic-Indic digits → Latin, corrupt digit runs flagged, original text untouched', () => {
  assert.equal(latinDigits('سؤال ۱۲ و ٣٤'), 'سؤال 12 و 34');
  const corrupt = normalizeLineDigits('Total ۲\u0FFF۰ marks');
  assert.equal(corrupt.digitSuspect, true);
  assert.equal(corrupt.normalized, `Total ${SUSPECT_DIGIT_MARK} marks`);
  const source: SourceLine[] = [
    { id: 'L0001', page: 1, text: '۱. کدام گزینه صحیح است؟' },
    { id: 'L0002', page: 1, text: 'بارم ۲\u0FFF۰' },
    { id: 'L0003', page: 1, text: '2. Plain line' },
  ];
  const snapshot = structuredClone(source);
  const lines = annotateSourceLines(source);
  assert.deepEqual(source, snapshot, 'input array not mutated');
  assert.deepEqual(lines.map(l => l.text), snapshot.map(l => l.text), 'source.lines[].text unchanged');
  assert.equal(lines[0].normalized, '1. کدام گزینه صحیح است؟', 'Persian letters untouched, digits Latin');
  assert.equal(lines[1].digitSuspect, true);
  assert.equal(lines[2].normalized, undefined, 'no twin when nothing changes');
  assert.deepEqual(extractionDiagnostics(lines, 1, []).digitSuspectLines, ['L0002']);
});

test('C: watermark lines are tagged, kept in storage and absent from the built map prompt', async () => {
  assert.equal(isWatermarkShape('www.examsite.ir www.examsite.ir www.examsite.ir'), true);
  assert.equal(isWatermarkShape('examsite-examsite-examsite'), true);
  assert.equal(isWatermarkShape('1. Choose the correct answer.'), false);
  assert.equal(isWatermarkShape('ha ha'), false);
  const base = clozeLines();
  const lines = annotateSourceLines([...base.slice(0, 5), { id: 'L0900', page: 1, text: 'www.examsite.ir www.examsite.ir www.examsite.ir' }, ...base.slice(5)]);
  assert.equal(lines.find(l => l.id === 'L0900')?.watermark, true);
  assert.equal(modelFacingLines(lines).some(l => l.id === 'L0900'), false);
  assert.deepEqual(extractionDiagnostics(lines, 1, []).watermarkLines, ['L0900']);
  const prompts: string[] = []; const reader = scriptedLoopReader(lines);
  await runLocalLoop({ lines, images: [], settings, fileHash: 'wm', caller: async req => { prompts.push(req.text); return reader(req); } });
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every(p => !p.includes('examsite')), 'no model prompt carries the watermark');
});

test('C: model prompts read the normalized twin (Persian digits arrive Latin)', async () => {
  const lines = annotateSourceLines([{ id: 'L0001', page: 1, text: '۱. کدام گزینه صحیح است؟' }, { id: 'L0002', page: 1, text: '۲. پایتخت ایران کجاست؟' }]);
  const prompts: string[] = [];
  await runLocalLoop({ lines, images: [], settings, fileHash: 'digits', caller: async req => { prompts.push(req.text); return isMap(req) || req.step === 'read' ? { rawText: '{}' } : corrections(); } });
  assert.ok(prompts[0].includes('1. کدام گزینه'), prompts[0]);
  assert.ok(!prompts[0].includes('۱.'));
});

// -------------------------------------------------------------------------------------------------
// D — difficulty score shape (gated on a REAL llama-server capture)
// -------------------------------------------------------------------------------------------------
const capture = JSON.parse(fs.readFileSync('test/fixtures/systemone-llama-score-response.json', 'utf8'));

test('D: the score request matches the captured llama.cpp /v1/systemone shape; the legacy levels shape was a 400', () => {
  const body = buildThxDecisionBody({ name: 'Q9 difficulty', type: 'difficulty', instructions: capture.request.questions['Q9 difficulty'].instructions } as any, 'local', 'state');
  assert.deepEqual(body.questions['Q9 difficulty'], capture.request.questions['Q9 difficulty']);
  assert.deepEqual([...DIFFICULTY_LEVELS], capture.request.questions['Q9 difficulty'].criteria);
  assert.equal(capture.legacyLevelsShape.httpStatus, 400);
  assert.match(JSON.stringify(capture.legacyLevelsShape.response), /"criteria\\" must be an array of 2 to 10 levels/);
});

test('D: captured score responses parse to argmax level + distribution; top < 0.4 is uncertain', async () => {
  const provider = { id: 'llama', name: 'llama', kind: 'openai-compatible' as const, baseURL: 'http://localhost:8080/v1', apiKey: '', decideDialect: 'thx' as const, model: 'local' };
  const old = globalThis.fetch;
  try {
    const run = async (which: 'flat' | 'peaked') => {
      globalThis.fetch = (async () => ({ ok: true, status: capture[which].httpStatus, json: async () => capture[which].response })) as any;
      return (await LLMAdapter.executeDecisions({ providerConfig: provider, body: capture.request })).results[0];
    };
    const flat = await run('flat');
    assert.equal(flat.choice, '5'); assert.ok(Math.abs(flat.probability - 0.26343398170078486) < 1e-12);
    assert.deepEqual(Object.keys(flat.distribution!), ['1', '2', '3', '4', '5']);
    const peaked = await run('peaked');
    assert.equal(peaked.choice, '2'); assert.ok(peaked.probability > 0.89);
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ answers: { 'Q9 difficulty': { type: 'score', probabilities: { a: 1 } } } }) })) as any;
    await assert.rejects(LLMAdapter.executeDecisions({ providerConfig: provider, body: capture.request }), /THX score response malformed/);
  } finally { globalThis.fetch = old; }
  assert.equal(DIFFICULTY_UNCERTAIN_BELOW, 0.4);
  for (const [which, uncertain, value] of [['flat', true, 5], ['peaked', false, 2]] as const) {
    const answer = capture[which].response.answers['Q9 difficulty'];
    const distribution = Object.fromEntries(Object.entries(answer.probabilities as Record<string, number>).map(([k, p]) => [String(Number(k) + 1), p]));
    const top = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0];
    const document = normalizeAuthoredDocument({ questions: [{ number: 9, type: 'fillblank', stem: 'Asadi Tusi was a famous poet in the (9) ...... century.' }] });
    const dsettings = { ...settings, providers: [{ id: 'llama', name: 'llama', kind: 'openai-compatible', baseURL: 'http://localhost:8080/v1', apiKey: '', decideDialect: 'thx', model: 'local' }], roleMapping: { ...settings.roleMapping, decide: { providerId: 'llama', model: 'local' } } };
    const result = await runLoopDecisionAudit({ document, lines: [], images: [], settings: dsettings, fileHash: `d-${which}`, decisionCaller: async body => {
      const name = Object.keys(body.questions)[0];
      return name.endsWith('difficulty') ? { results: [{ name, probability: top[1], choice: top[0], distribution }] } : { results: [{ name, probability: .95 }] };
    } });
    assert.equal((document.questions[0] as any).difficulty?.value, value);
    assert.equal((document.questions[0] as any).difficulty?.source, 'model');
    assert.equal(Boolean((document.questions[0] as any).difficulty?.uncertain), uncertain);
    assert.equal(result.difficultyUncertain, uncertain ? 1 : 0);
  }
});

// -------------------------------------------------------------------------------------------------
// E — one automatic section re-read on an under-count
// -------------------------------------------------------------------------------------------------
const nineLines = (): SourceLine[] => [
  { id: 'L0001', page: 1, text: 'Quiz — Total 9 Marks' },
  { id: 'L0002', page: 1, text: 'Section A: Grammar (9 marks)' },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `L${String(i + 3).padStart(4, '0')}`, page: 1, text: `${i + 1}. Question number ${i + 1}? a) yes b) no` })),
];

test('E: a section parse returning 0 of 9 earns exactly one re-read; the better attempt wins and is counted', async () => {
  const lines = nineLines(); const reader = scriptedLoopReader(lines);
  const sectionCalls: LoopModelRequest[] = [];
  const receipt = await runLocalLoop({ lines, images: [], settings, fileHash: 'reread', caller: async req => {
    if (isSection(req)) { sectionCalls.push(req); if (sectionCalls.length === 1) return { rawText: '{"questionCount":0,"questions":[]}' }; }
    return reader(req);
  } });
  assert.deepEqual(sectionCalls.map(r => r.label), ['Section parse · Grammar', 'Section parse · Grammar · re-read']);
  assert.match(sectionCalls[1].text, /COMPLAINT/);
  assert.match(sectionCalls[1].text, /previous attempt returned 0 of 9 expected questions — find the missing ones, especially any passage blanks/);
  assert.match(sectionCalls[1].text, /MAP CONTRACT: .*\nSECTION SOURCE/s, 'map contract quoted, same lines');
  assert.equal(receipt.sectionReReads, 1); assert.equal(receipt.map?.sectionReReads, 1);
  assert.equal(receipt.document.questions.length, 9);
  const selfReview = receipt.steps.find(s => s.step === 'self-review')!;
  assert.ok(selfReview.calls >= 1, 're-read happens before self-review, which still runs');
});

test('E: if the re-read returns fewer, the first attempt is kept; a healthy parse is never re-read', async () => {
  const lines = nineLines(); const reader = scriptedLoopReader(lines);
  let calls = 0;
  const receipt = await runLocalLoop({ lines, images: [], settings, fileHash: 'reread-worse', caller: async req => {
    if (isSection(req)) {
      calls++;
      const json = JSON.parse((await reader(req)).rawText);
      json.questions = json.questions.slice(0, calls === 1 ? 3 : 1); json.questionCount = json.questions.length;
      return { rawText: JSON.stringify(json) };
    }
    return reader(req);
  } });
  assert.equal(calls, 2); assert.equal(receipt.sectionReReads, 1);
  assert.deepEqual(receipt.document.questions.map(q => q.number), [1, 2, 3]);
  let healthy = 0;
  const ok = await runLocalLoop({ lines, images: [], settings, fileHash: 'healthy', caller: async req => { if (isSection(req)) healthy++; return reader(req); } });
  assert.equal(healthy, 1); assert.equal(ok.sectionReReads, 0);
});
