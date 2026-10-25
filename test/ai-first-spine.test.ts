import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Question, SourceLine } from '../src/types';
import {
  assembleFromLabels, parseClassification, readMarksEvidence, runClassifyStage, validateClassification,
  type Classification, type LineLabel, type SpineBudget,
} from '../src/pipeline/classify';
import { computeDefects } from '../src/pipeline/defects';
import {
  applyRepairOp, makeRepairContext, parseRepairOps, runRepairLoop, serializeRepairLoopResult,
  validateRepairOp, type RepairState,
} from '../src/pipeline/repairLoop';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { applyLocalGates } from '../src/pipeline/gates';
import { rewrapFurniture, REFURNISH_STYLE } from '../src/pipeline/corpusProbes';
import { LLM_ROLES, type ExamDoc, type LLMRequest } from '../src/types';
import { validateLlmRequest } from '../server';
import { runFullPipeline } from '../src/pipeline';
import { LLMAdapter } from '../src/providers/adapter';
import { DEFAULT_SETTINGS } from '../src/store';
import { sha256 } from '../src/utils/hash';
import { parseReportForDoc } from '../src/utils/examExport';
import type { ExtractedDocument } from '../src/pipeline/extract';

const CORPUS = path.join(process.cwd(), 'test/fixtures/corpus');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const line = (n: number, text: string, page = 1, y = 100): SourceLine => ({ id: `L${String(n).padStart(4, '0')}`, page, y, text });
const budget = (): SpineBudget => ({ calls: 0, units: 0, maxCalls: 30, maxUnits: 200 });
const classificationOf = (entries: Array<[number, LineLabel]>, titles: Record<number, string> = {}): Classification => ({
  labels: new Map(entries),
  sectionTitles: new Map(Object.entries(titles).map(([k, v]) => [Number(k), v])),
  ranges: [],
});
const mkQuestion = (id: string, no: number, spans: Array<[number, number]>, lines: SourceLine[], extra: Partial<Question> = {}): Question => ({
  id, no, label: String(no), spans: spans as any,
  stem: lines.filter(l => spans.some(([s, e]) => { const n = Number(l.id.replace(/\D/g, '')); return n >= s && n <= e; })).map(l => l.text).join(' '),
  type: 'short', points: 1, confidence: 1, images: [], answer: { source: 'paper', text: 'x' }, ...extra,
} as Question);

// ---------------------------------------------------------------- (a) schema
test('#38 (a) classification wire: ranges parse, validation catches gaps/overlaps', () => {
  const wire = parseClassification('', { r: [[1, 2, 'furniture'], [3, 3, 'section-header'], [4, 4, 'question-start'], [5, 6, 'option']], s: { 3: 'Vocabulary' } });
  const ok = validateClassification(wire, [1, 2, 3, 4, 5, 6]);
  assert.equal(ok.ok, true, ok.problems.join('; '));
  assert.equal(ok.labels.get(4), 'question-start');
  assert.equal(wire.sectionTitles.get(3), 'Vocabulary');

  const missing = validateClassification(parseClassification('', { r: [[1, 1, 'furniture'], [3, 3, 'question-start']] }), [1, 2, 3]);
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(' '), /unlabelled/);

  const noQuestions = validateClassification(parseClassification('', { r: [[1, 3, 'furniture']] }), [1, 2, 3]);
  assert.equal(noQuestions.ok, false);
  assert.match(noQuestions.problems.join(' '), /no question-start/);

  const textual = parseClassification('L0001-L0002: passage\nL0003: question-start', undefined);
  assert.deepEqual(textual.ranges.map(r => [r.start, r.end, r.label]), [[1, 2, 'passage'], [3, 3, 'question-start']]);

  const junkLabel = parseClassification('', { r: [[1, 1, 'banana']] });
  assert.equal(junkLabel.ranges.length, 0);
  assert.match(junkLabel.problems.join(' '), /unknown label/);
});

// ---------------------------------------------------------------- (b) assembly
test('#38 (b) assembly from labels: boundaries, passage prelude, group, key/marks territory', () => {
  const lines = [
    line(1, 'SCHOOL BANNER'),
    line(2, 'Vocabulary'),
    line(3, 'Choose the best answer.'),
    line(4, '1. Happy means …'),
    line(5, 'a) Sad b) Joyful'),
    line(6, 'Read the story first.'),
    line(7, 'A short story line one.'),
    line(8, '2. Why did Ana leave?'),
    line(9, 'Because the text wrapped here.'),
    line(10, '(3) (4)'),
    line(11, 'a) first picture sentence'),
    line(12, 'b) second picture sentence'),
    line(13, 'Answer Key'),
    line(14, '1 b 2 because of the rain'),
    line(15, 'Total: 6 marks'),
  ];
  const classification = classificationOf([
    [1, 'furniture'], [2, 'section-header'], [3, 'instruction'], [4, 'question-start'], [5, 'option'],
    [6, 'instruction'], [7, 'passage'], [8, 'question-start'], [9, 'continuation'],
    [10, 'question-start'], [11, 'option'], [12, 'option'],
    [13, 'answer-key'], [14, 'answer-key'], [15, 'marks'],
  ], { 2: 'Vocabulary' });
  const result = assembleFromLabels({ lines, classification });

  assert.deepEqual(result.furnitureLineNos, [1]);
  assert.deepEqual(result.keyLineNos, [13, 14, 15], 'answer-key + standalone marks lines form key territory');
  assert.deepEqual(result.sections.map(s => s.title), ['Vocabulary']);
  assert.equal(result.sections[0].headerLine, 2);
  assert.deepEqual(result.rawQuestions.map(q => q.no), [1, 2, 3, 4], 'group line yields parent 3 + child 4');
  const [q1, q2, parent, child] = result.rawQuestions;
  assert.deepEqual(q1.spans, [[4, 5]]);
  assert.deepEqual(q1.options.map((o: any) => o.key), ['a', 'b']);
  assert.deepEqual(q2.spans, [[8, 9]], 'continuation attaches; passage stays section-owned');
  assert.deepEqual(result.sectionPreludes['section_1'], [3, 6, 7]);
  assert.equal(child.parentId, parent.id);
  const groupSeg = result.segments.find(s => s.kind === 'group-parent');
  assert.deepEqual(groupSeg.childNos, [4]);
  // readMarksEvidence is arithmetic over printed marks only.
  assert.equal(readMarksEvidence(['Total: 6 marks']), 6);
  assert.equal(readMarksEvidence(['3. A question [2.5]']), 2.5);
  assert.equal(readMarksEvidence(['12. Just a number']), undefined);
});

// ---------------------------------------------------------------- (c) op preconditions
test('#38 (c) repair ops: illegal operations are rejected by code, legal ones apply', () => {
  const lines = [
    line(1, '1. First question stem.'),
    line(2, '2. Second question stem.'),
    line(3, '2. Second question repeated.'),
    line(4, '3. Third question stem. [4]'),
    line(5, 'A stray printed line.'),
  ];
  const state: RepairState = {
    questions: [mkQuestion('q1', 1, [[1, 1]], lines), mkQuestion('q2a', 2, [[2, 2]], lines), mkQuestion('q2b', 2, [[3, 3]], lines), mkQuestion('q3', 3, [[4, 4]], lines)],
    sections: [{ id: 's1', index: 1, title: '', spans: [[1, 5]], questionIds: [] } as any],
  };
  const defects = [{ id: 'duplicate-number:2', kind: 'duplicate-number' as const, questionIds: ['q2a', 'q2b'], lineIds: [2, 3], evidence: [], detail: 'dup' }];
  const ctx = makeRepairContext(state, lines, [], defects as any);

  assert.equal(validateRepairOp({ op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q1', b: 'q3' }, ctx).ok, false, 'different printed numbers cannot merge');
  assert.equal(validateRepairOp({ op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q2a', b: 'q2b' }, ctx).ok, true);
  assert.equal(validateRepairOp({ op: 'assignLines', defect: 'x', lines: [2, 2], questionId: 'q1' }, ctx).ok, false, 'overlap creation rejected');
  assert.equal(validateRepairOp({ op: 'assignLines', defect: 'x', lines: [5, 5], questionId: 'q3' }, ctx).ok, true);
  assert.equal(validateRepairOp({ op: 'breakQuestionAt', defect: 'x', line: 2 }, ctx).ok, false, 'cannot break at a question start');
  assert.equal(validateRepairOp({ op: 'setPointsFrom', defect: 'duplicate-number:2', lines: [5, 5] }, ctx).ok, false, 'no printed marks on that line');
  assert.equal(validateRepairOp({ op: 'setPointsFrom', defect: 'duplicate-number:2', lines: [4, 4] }, ctx).ok, true);
  assert.equal(validateRepairOp({ op: 'dropAsFurniture', defect: 'x', lines: [1, 1] }, ctx).ok, false, 'would hollow q1');
  assert.equal(validateRepairOp({ op: 'dropAsFurniture', defect: 'x', lines: [5, 5] }, ctx).ok, true);
  assert.equal(validateRepairOp({ op: 'assignLines', defect: 'x', lines: [99, 99], questionId: 'q1' }, ctx).ok, false, 'line outside document');

  const parsed = parseRepairOps('', { ops: [
    { op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q2a', b: 'q2b' },
    { op: 'rewriteStem', defect: 'x', text: 'authored text must never pass' },
    { op: 'deleteQuestion', defect: 'x' },
  ] });
  assert.equal(parsed.ops.length, 1);
  assert.equal(parsed.rejected, 2, 'anything outside the closed vocabulary is rejected+counted');

  applyRepairOp({ op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q2a', b: 'q2b' }, ctx);
  assert.equal(state.questions.length, 3);
  assert.deepEqual(state.questions.map(q => q.no).sort(), [1, 2, 3]);
});

// ---------------------------------------------------------------- (d) loop termination + escalation
test('#38 (d) repair loop: fixes a duplicate, escalates once after two noFix rounds, respects budget', async () => {
  const lines = [
    line(1, '1. First question stem here.'),
    line(2, '2. Second question stem here.'),
    line(3, '2. Second question stem repeated.'),
    line(4, '3. Third question stem here.'),
  ];
  const mkState = (): RepairState => ({
    questions: [mkQuestion('q1', 1, [[1, 1]], lines), mkQuestion('q2a', 2, [[2, 2]], lines), mkQuestion('q2b', 2, [[3, 3]], lines), mkQuestion('q3', 3, [[4, 4]], lines)],
    sections: [{ id: 's1', index: 1, title: '', spans: [[1, 4]], questionIds: [] } as any],
  });

  // Local model fixes the duplicate by merging.
  const fixed = await runRepairLoop({
    state: mkState(), lines, expectedNumbers: [1, 2, 3], keyLineNos: [], budget: budget(),
    caller: async req => {
      assert.match(req.text, /DEFECT duplicate-number:2/);
      return { rawText: '', json: { ops: [{ op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q2a', b: 'q2b' }] }, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  });
  assert.equal(fixed.status, 'completed');
  assert.equal(fixed.opsAccepted, 1);
  assert.ok(!fixed.remainingDefects.some(d => d.kind === 'duplicate-number'), 'duplicate gone after re-verify');
  assert.deepEqual(fixed.state.questions.map(q => q.no), [1, 2, 3]);

  // Local model never fixes → escalation called exactly once; loop terminates within 3 rounds.
  let escalations = 0;
  const stubborn = await runRepairLoop({
    state: mkState(), lines, expectedNumbers: [1, 2, 3], keyLineNos: [], budget: budget(),
    caller: async () => ({ rawText: '', json: { ops: [{ op: 'noFix', defect: 'duplicate-number:2', reason: 'cannot tell' }] }, usage: { inputTokens: 1, outputTokens: 1 } }),
    escalationCaller: async () => {
      escalations++;
      return { rawText: '', json: { ops: [{ op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q2a', b: 'q2b' }] }, usage: { inputTokens: 2, outputTokens: 2 } };
    },
  });
  assert.equal(escalations, 1, 'escalation happens once per surviving kind');
  assert.equal(stubborn.escalations, 1);
  assert.ok(stubborn.rounds.length <= 3, 'bounded to 3 rounds');
  assert.ok(!stubborn.remainingDefects.some(d => d.kind === 'duplicate-number'));

  // Budget exhaustion stops calls.
  const capped = budget();
  capped.maxCalls = 1;
  const cappedRun = await runRepairLoop({
    state: mkState(), lines, expectedNumbers: [1, 2, 3], keyLineNos: [], budget: capped,
    caller: async () => ({ rawText: '', json: { ops: [{ op: 'noFix', defect: 'duplicate-number:2' }] }, usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  assert.equal(capped.calls, 1);
  assert.equal(cappedRun.calls, 1);
});

// ---------------------------------------------------------------- (e) classify fallback paths
test('#38 (e) classify unavailable/invalid outcomes (pipeline falls back to the legacy segmenter)', async () => {
  const lines = [line(1, '1. A question.'), line(2, 'a) x b) y')];
  const unavailable = await runClassifyStage({ lines });
  assert.equal(unavailable.status, 'unavailable');

  const invalid = await runClassifyStage({
    lines,
    budget: budget(),
    caller: async () => ({ rawText: '{"q":[]}', json: { q: [] }, usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.attempts, 2, 'two validation attempts before fallback');
  assert.equal(invalid.calls, 2);

  const cachedInvalid = await runClassifyStage({ lines, cached: { invalid: true, problems: ['earlier'] } });
  assert.equal(cachedInvalid.status, 'invalid');
  assert.equal(cachedInvalid.calls, 0);
});

// ---------------------------------------------------------------- (f) role parity
test('#38 (f) classify + repair roles pass the server whitelist parity', () => {
  assert.ok(LLM_ROLES.includes('classify'));
  assert.ok(LLM_ROLES.includes('repair'));
  for (const role of ['classify', 'repair'] as const) {
    assert.equal(validateLlmRequest({ role, system: 's', text: 't', label: 'l' }), null, `${role} accepted by server validator`);
  }
  assert.notEqual(validateLlmRequest({ role: 'sort-lines', system: 's', text: 't', label: 'l' }), null, 'bogus role still rejected');
});

// ---------------------------------------------------------------- (g) caches: identical re-run = 0 calls
test('#38 (g) identical re-run costs 0 classify and 0 repair calls', async () => {
  const lines = [line(1, 'Header'), line(2, '1. A question stem.'), line(3, 'a) x b) y')];
  const cache = new Map<string, string>();
  let calls = 0;
  const caller = async () => {
    calls++;
    return { rawText: '', json: { r: [[1, 1, 'section-header'], [2, 2, 'question-start'], [3, 3, 'option']], s: { 1: 'Header' } }, usage: { inputTokens: 3, outputTokens: 2 } };
  };
  const first = await runClassifyStage({ lines, caller, cache, cacheKey: 'k1', budget: budget() });
  assert.equal(first.status, 'completed');
  assert.equal(calls, 1);
  const second = await runClassifyStage({ lines, caller, cache, cacheKey: 'k1', budget: budget() });
  assert.equal(second.status, 'cached');
  assert.equal(calls, 1, 'no second classify call');

  // Repair loop result cache: a serialized completed outcome replays with 0 calls.
  const dupLines = [line(1, '1. One.'), line(2, '2. Two.'), line(3, '2. Two again.')];
  const mkDup = (): RepairState => ({
    questions: [mkQuestion('q1', 1, [[1, 1]], dupLines), mkQuestion('q2a', 2, [[2, 2]], dupLines), mkQuestion('q2b', 2, [[3, 3]], dupLines)],
    sections: [{ id: 's1', index: 1, title: '', spans: [[1, 3]], questionIds: [] } as any],
  });
  const run1 = await runRepairLoop({
    state: mkDup(), lines: dupLines, expectedNumbers: [1, 2], keyLineNos: [], budget: budget(),
    caller: async () => ({ rawText: '', json: { ops: [{ op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q2a', b: 'q2b' }] }, usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  assert.equal(run1.calls >= 1, true);
  const run2 = await runRepairLoop({
    state: mkDup(), lines: dupLines, expectedNumbers: [1, 2], keyLineNos: [], budget: budget(),
    cachedResult: serializeRepairLoopResult(run1),
    caller: async () => { throw new Error('must not be called on cache hit'); },
  });
  assert.equal(run2.status, 'cached');
  assert.equal(run2.calls, 0);
  assert.deepEqual(run2.state.questions.map(q => q.no), run1.state.questions.map(q => q.no));
});

// ---------------------------------------------------------------- Part E1: mock paper through the spine
test('#38 E1 field mock exam: authored labels assemble to the printed truth (65 questions, 4 sections, 40 total)', () => {
  const dir = path.join(CORPUS, 'mock-born-digital');
  const lines = readJson(path.join(dir, 'source-lines.json')) as SourceLine[];
  const truth = readJson(path.join(dir, 'truth.json'));
  const labelsJson = readJson(path.join(dir, 'labels.json'));
  const classification: Classification = {
    labels: new Map(Object.entries(labelsJson.labels).map(([k, v]) => [Number(k), v as LineLabel])),
    sectionTitles: new Map(Object.entries(labelsJson.sectionTitles).map(([k, v]) => [Number(k), v as string])),
    ranges: [],
  };
  const assembly = assembleFromLabels({ lines, classification });
  const numbers = [...new Set(assembly.rawQuestions.map(q => q.no))].sort((a, b) => a - b);
  assert.deepEqual(numbers, truth.expectedNumbers, 'every printed number 1..65 exactly once set-wide from labels alone');
  assert.deepEqual(assembly.sections.map(s => s.title), ['Vocabulary', 'Grammar', 'Reading', 'Writing']);
  const furnitureExpected = Object.values(labelsJson.labels).filter(l => l === 'furniture').length;
  assert.equal(assembly.furnitureLineNos.length, furnitureExpected, 'repeated headers/footers stayed furniture');
  assert.ok(assembly.keyLineNos.length >= 1 && lines[assembly.keyLineNos[0] - 1].text.includes('Total marks: 40'), 'printed total lives in marks territory');

  // Through the real downstream machinery (assemble → gates), then the Part C verifier.
  const assembled = assembleAndValidateQuestions(assembly.rawQuestions, lines, 40, {
    keyTerritoryLineNos: assembly.keyLineNos, gapCompletion: true,
    segmentReceipts: assembly.segments, sections: assembly.sections as any,
  });
  const gated = applyLocalGates({ questions: assembled.questions, rawSections: assembly.sections, lines, keyLines: assembly.keyLineNos, metaTotalPoints: 40 });
  const defects = computeDefects({
    doc: { questions: gated.questions, sections: gated.sections, totalPoints: gated.totalPoints },
    lines, expectedNumbers: truth.expectedNumbers, keyLineNos: assembly.keyLineNos,
    accountedLineNos: [...assembly.furnitureLineNos, ...Object.values(assembly.sectionPreludes).flat()],
  });
  const kinds = new Set(defects.map(d => d.kind));
  assert.ok(!kinds.has('duplicate-number'), `no duplicates (Field Report #12 had 43): ${[...kinds].join(', ')}`);
  assert.ok(!kinds.has('missing-number'), 'no missing printed numbers');
  assert.ok(!kinds.has('span-overlap'), 'no span overlaps');
});

// ---------------------------------------------------------------- Part E2: held-out furniture probe
test('#38 E2 held-out furniture probe: unseen page furniture stays furniture, questions/sections hold', () => {
  const baseLines = readJson(path.join(CORPUS, 'english-mcq', 'source-lines.json')) as SourceLine[];
  const baseTruth = readJson(path.join(CORPUS, 'english-mcq', 'truth.json'));
  const wrapped = rewrapFurniture(baseLines);
  const probeLines = readJson(path.join(CORPUS, 'probe-refurnished', 'source-lines.json')) as SourceLine[];
  assert.deepEqual(wrapped, probeLines, 'probe fixture is the deterministic generator output');

  // Scripted stand-in for a competent classify model: GENERAL cues only (page-edge position,
  // printed numbers, option markers, "Section …" and answer-key content). It has never seen
  // the probe's furniture wording — the assembly must hold under it.
  const standInClassify = (ls: SourceLine[]): Classification => {
    const labels = new Map<number, LineLabel>();
    const titles = new Map<number, string>();
    let inKey = false;
    for (const l of ls) {
      const n = Number(l.id.replace(/\D/g, ''));
      const text = l.text.trim();
      if ((l.y !== undefined && (l.y <= 30 || l.y >= 740))) { labels.set(n, 'furniture'); continue; }
      if (/^answer key$/i.test(text)) { inKey = true; labels.set(n, 'answer-key'); continue; }
      if (inKey) { labels.set(n, 'answer-key'); continue; }
      const section = text.match(/^Section\s+\w+:\s*([^(]+)/i);
      if (section) { labels.set(n, 'section-header'); titles.set(n, section[1].trim()); continue; }
      if (/total\s+\d+\s+marks/i.test(text) && !/^\d+\./.test(text)) { labels.set(n, 'marks'); continue; }
      if (/^\d+\./.test(text)) { labels.set(n, 'question-start'); continue; }
      labels.set(n, 'continuation');
    }
    return { labels, sectionTitles: titles, ranges: [] };
  };

  const assembly = assembleFromLabels({ lines: wrapped, classification: standInClassify(wrapped) });
  const numbers = [...new Set(assembly.rawQuestions.map(q => q.no))].sort((a, b) => a - b);
  assert.deepEqual(numbers, baseTruth.expectedNumbers, 'same 20 questions under unseen furniture');
  assert.deepEqual(assembly.sections.map(s => s.title), baseTruth.sectionTitles);
  const inserted = wrapped.filter(l => l.text === REFURNISH_STYLE.header || l.text.startsWith('Star Academy — assessment paper'));
  assert.ok(inserted.length >= 2);
  for (const l of inserted) {
    assert.ok(assembly.furnitureLineNos.includes(Number(l.id.replace(/\D/g, ''))), `${l.id} ("${l.text.slice(0, 24)}…") stayed furniture`);
  }
  // Key territory = the printed-total marks line + Answer Key + its 2 rows.
  assert.equal(assembly.keyLineNos.length, 4, 'answer key + marks territory intact');
});

// ---------------------------------------------------------------- end-to-end: primary path
test('#38 end-to-end: pipeline takes the classify path (no structure call), report carries provenance, re-run costs 0 spine calls', async () => {
  const dir = path.join(CORPUS, 'mock-born-digital');
  const lines = readJson(path.join(dir, 'source-lines.json')) as SourceLine[];
  const labelsJson = readJson(path.join(dir, 'labels.json'));
  // Compress the authored ground-truth labels into the classify wire format — this stands in
  // for a competent local model answering the ONE global call.
  const sortedLabels = Object.entries(labelsJson.labels).map(([k, v]) => [Number(k), v as string] as const).sort((a, b) => a[0] - b[0]);
  const ranges: Array<[number, number, string]> = [];
  for (const [n, label] of sortedLabels) {
    const last = ranges[ranges.length - 1];
    if (last && last[2] === label && last[1] === n - 1) last[1] = n;
    else ranges.push([n, n, label]);
  }
  const classifyJson = { r: ranges, s: labelsJson.sectionTitles };

  const cache = new Map<string, string>();
  const saved = new Map<string, ExamDoc>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || 'GET';
    if (url.startsWith('/api/cache/')) {
      const key = decodeURIComponent(url.slice('/api/cache/'.length));
      if (method === 'GET') return cache.has(key) ? new Response(cache.get(key)!, { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      if (method === 'PUT') { cache.set(key, String(init?.body ?? 'null')); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.startsWith('/api/exams')) {
      const examId = decodeURIComponent(url.replace(/^\/api\/exams\/?/, ''));
      if (method === 'GET') return saved.has(examId) ? new Response(JSON.stringify(saved.get(examId)), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      if (method === 'PUT') { saved.set(examId, JSON.parse(String(init?.body)) as ExamDoc); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.startsWith('/api/journals') || url.startsWith('/api/usage') || url.startsWith('/api/memory')) return new Response(JSON.stringify({ ok: true, error: 'not found' }), { status: method === 'GET' ? 404 : 200 });
    return new Response(JSON.stringify({ error: `Unexpected route ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;

  const rolesSeen: string[] = [];
  const labelsSeen: string[] = [];
  const originalExecute = LLMAdapter.execute;
  LLMAdapter.execute = (async (request: LLMRequest) => {
    rolesSeen.push(String(request.role));
    labelsSeen.push(String(request.label || ''));
    if (request.role === 'classify') return { json: classifyJson, rawText: JSON.stringify(classifyJson), finishReason: 'STOP', usage: { inputTokens: 100, outputTokens: 50 } };
    if (request.role === 'repair') return { json: { ops: [] }, rawText: '{"ops":[]}', finishReason: 'STOP', usage: { inputTokens: 5, outputTokens: 2 } };
    return { json: { verdicts: [] }, rawText: '{"verdicts":[]}', finishReason: 'STOP', usage: { inputTokens: 1, outputTokens: 1 } };
  }) as typeof LLMAdapter.execute;

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.cleanupEnabled = false;
  settings.consensusEnabled = false;
  const file = new File(['born digital mock'], 'mock.pdf', { type: 'application/pdf' });
  const fileHash = await sha256(await file.arrayBuffer());
  const extracted: ExtractedDocument = { lines, pages: 6, ocrUsed: false, fileName: file.name, images: [], scannedPageIndices: [], pageImages: [] };

  try {
    const doc = await runFullPipeline(file, settings, { onStageUpdate: () => undefined }, { preExtracted: extracted, fileHash });
    assert.ok(rolesSeen.includes('classify'), 'classify role was called');
    assert.ok(!labelsSeen.some(l => l.startsWith('Structure')), `no structure model call on the classify path (saw: ${labelsSeen.join(', ')})`);
    assert.equal(doc.spine?.classify.status, 'completed');
    assert.ok(!doc.flags.some(f => f.code === 'CLASSIFY_FALLBACK'), 'no fallback flag on the primary path');
    const numbers = [...new Set(doc.questions.map(q => q.no))].sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 65 }, (_, i) => i + 1), 'the shipped 106-question failure is now exactly the printed 65');
    assert.equal(doc.sections.length, 4, `real sections only (got ${doc.sections.map(s => s.title).join(' / ')})`);
    assert.ok(['no-defects', 'completed', 'cached'].includes(doc.spine?.repairLoop.status || ''), `repair loop ran (${doc.spine?.repairLoop.status})`);
    const report = parseReportForDoc(doc);
    assert.equal(report.classify?.status, 'completed');
    assert.ok(report.repairLoop, 'parse report carries the repair summary');

    // Identical re-run: classify + repair served from cache (0 spine calls).
    const classifyCallsAfterFirst = rolesSeen.filter(r => r === 'classify').length;
    const repairCallsAfterFirst = rolesSeen.filter(r => r === 'repair').length;
    const second = await runFullPipeline(file, settings, { onStageUpdate: () => undefined }, { preExtracted: extracted, fileHash });
    assert.equal(rolesSeen.filter(r => r === 'classify').length, classifyCallsAfterFirst, '0 classify calls on identical re-run');
    assert.equal(rolesSeen.filter(r => r === 'repair').length, repairCallsAfterFirst, '0 repair calls on identical re-run');
    assert.equal(second.spine?.classify.status, 'cached');
    assert.deepEqual([...new Set(second.questions.map(q => q.no))].sort((a, b) => a - b), numbers);
  } finally {
    LLMAdapter.execute = originalExecute;
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- defects reuse invariants
test('#38 Part C defects are typed with sliced evidence and reuse coverage arithmetic', () => {
  const lines = [line(1, '1. Real stem.'), line(2, '2. Another stem.'), line(3, '2. Duplicated stem.'), line(4, 'orphan printed words')];
  const questions = [mkQuestion('q1', 1, [[1, 1]], lines), mkQuestion('q2a', 2, [[2, 2]], lines), mkQuestion('q2b', 2, [[3, 3]], lines)];
  const defects = computeDefects({
    doc: { questions, sections: [{ id: 's1', index: 1, title: '', spans: [[1, 4]], questionIds: [] } as any], totalPoints: undefined },
    lines, expectedNumbers: [1, 2, 3], expectedStarts: [{ no: 3, line: 3 }], keyLineNos: [],
  });
  const kinds = defects.map(d => d.kind);
  assert.ok(kinds.includes('duplicate-number'));
  assert.ok(kinds.includes('missing-number'));
  const dup = defects.find(d => d.kind === 'duplicate-number')!;
  assert.deepEqual(dup.questionIds.sort(), ['q2a', 'q2b']);
  assert.ok(dup.evidence.length > 0 && dup.evidence.every(e => typeof e.text === 'string' && e.text.length > 0), 'evidence is sliced document text');
  assert.ok(defects.every(d => d.id && d.detail), 'every defect is typed with an id + detail');
});
