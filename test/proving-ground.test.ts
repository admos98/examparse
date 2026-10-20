/** Part 2 — Proving Ground acceptance tests (offline, mocked transports). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateSemantic, applySemanticDeterministicFixes } from '../src/pipeline/semanticValidators';
import { buildCriticQueue, runCritic, recordVerdicts } from '../src/pipeline/critic';
import { consensusTriggerForSection, diffConsensus, resolveConsensusModel, spanOverlap } from '../src/pipeline/consensus';
import { buildScoreboard, leaderFor, docTraitBucket, bucketKey, scoreboardEvidenceGap } from '../src/pipeline/scoreboard';
import { runTaskGraph, mergeInOrder } from '../src/pipeline/taskGraph';
import { buildTrace, tracesForDoc, traceForAgent, buildParseReport, configHash } from '../src/pipeline/provenance';
import { estimateLiveBench, liveBenchGate, diffScorecards, regressionAlarm, cleanRateTrend } from '../src/pipeline/liveBench';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { expandWireV2 } from '../src/pipeline/structure';
import { fixture as iranian } from './fixtures/golden/iranian-rtl';
import type { Question } from '../src/types';

const Q = (partial: Partial<Question>): Question => ({
  id: partial.id || `q${partial.no || 1}`, label: String(partial.no || 1), no: partial.no || 1,
  spans: partial.spans || [[1, 1]], stem: partial.stem ?? 'Sample stem?', type: partial.type || 'short',
  images: [], confidence: partial.confidence ?? 0.9, ...partial,
} as Question);
const SEMANTIC_WARNS = ['ANSWER_ANCHOR_SUSPECT', 'OPTION_DUPLICATE', 'PASSAGE_DETACHED', 'SECTION_SPAN_OUTSIDE'];

// (5) 2A validators — positive + negative each
test('2A: each validator fires on planted defect and stays silent on clean input', () => {
  const sections: any[] = [{ id: 's1', index: 0, title: 'Reading', passage: '', spans: [[1, 10]] }];
  // (a) answer anchor: two questions share identical paper-answer segment, no number
  const a = validateSemantic([Q({ id: 'a1', no: 1, answer: { source: 'paper', text: 'option b' } }), Q({ id: 'a2', no: 2, answer: { source: 'paper', text: 'option b' } })]);
  assert.equal(a.filter(i => i.code === 'ANSWER_ANCHOR_SUSPECT').length, 2);
  assert.equal(validateSemantic([Q({ no: 3, answer: { source: 'paper', text: '3. b' } })]).filter(i => i.code === 'ANSWER_ANCHOR_SUSPECT').length, 0);
  // (b) blank position
  assert.ok(validateSemantic([Q({ type: 'fillblank', stem: 'He goes to school' })]).some(i => i.code === 'STEM_SHAPE_SUSPECT' && i.severity === 'info'));
  assert.equal(validateSemantic([Q({ type: 'fillblank', stem: 'He ____ to school' })]).filter(i => i.code === 'STEM_SHAPE_SUSPECT').length, 0);
  // (c) option distinctness names keys
  const c = validateSemantic([Q({ type: 'mcq', stem: 'Pick one ____', options: [{ key: 'a', spans: [[1, 1]], text: 'same' }, { key: 'b', spans: [[1, 1]], text: 'same' }] })]);
  assert.deepEqual(c.find(i => i.code === 'OPTION_DUPLICATE')?.keys, ['b']);
  // (d) passage detached
  const d = validateSemantic([Q({ sectionId: 's1', stem: 'According to the passage, why?' })], sections);
  assert.ok(d.some(i => i.code === 'PASSAGE_DETACHED'));
  assert.equal(validateSemantic([Q({ sectionId: 's1', stem: 'According to the passage, why?' })], [{ ...sections[0], passage: 'A long enough passage text here.' }]).filter(i => i.code === 'PASSAGE_DETACHED').length, 0);
  // (e) section containment
  const e = validateSemantic([Q({ sectionId: 's1', spans: [[20, 29]] })], sections);
  assert.ok(e.some(i => i.code === 'SECTION_SPAN_OUTSIDE'));
  assert.equal(validateSemantic([Q({ sectionId: 's1', spans: [[2, 5]] })], sections).filter(i => i.code === 'SECTION_SPAN_OUTSIDE').length, 0);
  // deterministic fix re-splits a duplicated option blob
  const fixed = applySemanticDeterministicFixes([Q({ type: 'mcq', stem: 'x ____', options: [{ key: 'a', spans: [[1, 1]], text: 'red b) blue' }, { key: 'b', spans: [[1, 1]], text: 'red b) blue' }] })]);
  assert.equal(fixed.fixes.length, 1);
});

test('2A: known-good Iranian golden yields 0 false semantic warns through the assembly funnel', () => {
  const wire: any = (iranian.mockStructureResponses[0] as any).wire;
  const expanded: any = expandWireV2(wire);
  const raw = expanded.questions || expanded.q || [];
  const res = assembleAndValidateQuestions(raw, iranian.sourceLines as any);
  const warns = res.flags.filter(f => SEMANTIC_WARNS.includes(f.code) && f.severity === 'warn');
  assert.equal(warns.length, 0, JSON.stringify(warns.slice(0, 3)));
  assert.ok(res.questions.length > 50);
});

// (6) Critic
test('2B critic: rigged 5-defect/5-clean fixture → 1 batched call, exactly defective set flagged; unconfigured → 0 calls + review queue', async () => {
  const qs: Question[] = [];
  for (let i = 1; i <= 10; i++) qs.push(Q({ id: `q${i}`, no: i, stem: `Stem ${i} ____`, confidence: i <= 5 ? 0.5 : 0.95 }));
  const issues = qs.slice(0, 5).map(q => ({ code: 'OPTION_DUPLICATE' as const, severity: 'warn' as const, questionId: q.id, message: 'dup' }));
  const queue = buildCriticQueue(qs, issues);
  assert.equal(queue.length, 5);
  let calls = 0;
  const result = await runCritic(queue, async (batch) => { calls++; return batch.map(i => ({ questionId: i.question.id, verdict: 'defect', defectKind: 'option-duplicate', suggestedAction: 'review', note: 'duplicate options' })); });
  assert.equal(calls, 1); assert.equal(result.calls, 1);
  assert.deepEqual(result.verdicts.map(v => v.questionId).sort(), ['q1', 'q2', 'q3', 'q4', 'q5']);
  assert.deepEqual(result.reviewQueue.sort(), ['q1', 'q2', 'q3', 'q4', 'q5']);
  // clean questions untouched
  assert.ok(!result.verdicts.some(v => ['q6', 'q7', 'q8', 'q9', 'q10'].includes(v.questionId)));
  const degraded = await runCritic(queue, null);
  assert.equal(degraded.calls, 0); assert.equal(degraded.degraded, true); assert.equal(degraded.reviewQueue.length, 5);
  // verdicts persist last-3
  let store: Record<string, any[]> = {};
  for (let i = 0; i < 5; i++) store = recordVerdicts(store, [{ questionId: 'q1', verdict: 'ok', suggestedAction: 'accept', note: `n${i}` }]);
  assert.equal(store.q1.length, 3);
});

// (7) Consensus
test('2C consensus: bad-A/good-B reaches fewer defects; same-model skip at 0 calls', () => {
  const trig = consensusTriggerForSection({ questions: [Q({ confidence: 0.5 })], issues: [{ code: 'OPTION_DUPLICATE', severity: 'warn', questionId: 'q1', message: 'x' }, { code: 'OPTION_DUPLICATE', severity: 'warn', questionId: 'q1', message: 'y' }] });
  assert.equal(trig.triggered, true);
  assert.equal(consensusTriggerForSection({ questions: [Q({ confidence: 0.95 })], issues: [] }).triggered, false);
  const badA = [Q({ id: 'a1', no: 1, spans: [[1, 2]], stem: 's ____' }), Q({ id: 'a2', no: 2, spans: [[3, 4]], stem: 't ____' })];
  const goodB = [Q({ id: 'b1', no: 1, spans: [[1, 2]], stem: 's ____' }), Q({ id: 'b2', no: 2, spans: [[5, 6]], stem: 't ____' })];
  const issuesA = [{ code: 'OPTION_DUPLICATE' as const, severity: 'warn' as const, questionId: 'a2', message: 'dup' }];
  const dec = diffConsensus(badA, goodB, issuesA);
  assert.equal(dec.accepted.length, 2);
  assert.ok(dec.agreedNos.includes(1));
  assert.ok(dec.accepted.find(q => q.no === 2)?.flags?.includes('CONSENSUS_CLEAN_SIDE'));
  assert.equal(spanOverlap(badA[0], goodB[0]), 1);
  const same = resolveConsensusModel('model-x', undefined, 'model-x');
  assert.ok('skip' in same && same.code === 'CONSENSUS_SAME_MODEL');
  assert.deepEqual(resolveConsensusModel('model-x', 'model-y'), { model: 'model-y', distinct: true });
});

// (8) Scoreboard math — hand-recomputed
test('2D scoreboard: bucket math exact, leader pure, n<3 insufficient', () => {
  const mkRun = (model: string, cov: number, parsed: number, cost: number, defects: number): any => ({
    ts: new Date().toISOString(), jobId: Math.random().toString(), kind: 'pipeline',
    docTraits: { pages: 1, lines: 50, expectedQs: 10, languagesDetected: ['en'], hasKeyPages: false, hasImages: 0, sectionCount: 1 },
    models: { fast: model }, outcome: { health: { expected: 10, parsed, missing: [], duplicates: [], coveragePercent: cov, state: 'green', complete: true }, calls: 1, tokens: { input: 1, output: 1 }, cost, wallMs: 1, flagsRaised: [] },
    ladderPath: ['L0'], flagsRaised: [], userCorrections: 0, verifierDefects: defects,
  });
  const runs = [mkRun('good', 100, 10, 1.0, 0), mkRun('good', 100, 10, 1.0, 0), mkRun('good', 90, 10, 1.0, 1), mkRun('bad', 50, 10, 3.0, 5), mkRun('bad', 50, 10, 3.0, 5), mkRun('bad', 50, 10, 3.0, 5), mkRun('rare', 100, 10, 0.1, 0)];
  const rows = buildScoreboard(runs);
  const bucket = bucketKey(docTraitBucket(runs[0].docTraits));
  const good = rows.find(r => r.modelId === 'good')!;
  assert.equal(good.jobs, 3);
  assert.equal(good.cleanCoverageRate, Number(((1 + 1 + 0.9) / 3).toFixed(4)));
  assert.equal(good.meanDefectsPerExam, Number((1 / 3).toFixed(4)));
  assert.equal(good.meanCostPerCleanQuestion, Number((3 / (10 + 10 + 9)).toFixed(6))); // Σcost/Σ(parsed−defects)
  assert.equal(rows.find(r => r.modelId === 'rare')!.insufficientData, true);
  assert.equal(leaderFor(rows, 'fast', bucket)?.modelId, 'good');
  assert.equal(scoreboardEvidenceGap(rows, 'fast', bucket).citable, false); // n<8
});

// (9) Task graph determinism + resume + timeout
test('2E graph: concurrency 1 vs 4 identical merged hash; resume skips done; hung node times out, PARTIAL names it', async () => {
  const mkNodes = (executed: string[]) => Array.from({ length: 8 }, (_, i) => ({
    id: `sec${i}`, label: `Section ${i}`,
    run: async () => { executed.push(`sec${i}`); await new Promise(r => setTimeout(r, (8 - i) * 3)); return { no: i + 1, text: `Q${i + 1}` }; },
  }));
  const hash = (v: unknown) => { const s = JSON.stringify(v); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };
  const e1: string[] = []; const e4: string[] = [];
  const t0 = Date.now(); const r1 = await runTaskGraph(mkNodes(e1), { concurrency: 1 });
  const t1 = Date.now(); const r4 = await runTaskGraph(mkNodes(e4), { concurrency: 4 });
  const t2 = Date.now();
  const order = Array.from({ length: 8 }, (_, i) => `sec${i}`);
  assert.equal(hash(mergeInOrder(r1.results, order)), hash(mergeInOrder(r4.results, order)));
  assert.ok((t1 - t0) / Math.max(1, t2 - t1) >= 1.8, `wall c1=${t1 - t0}ms c4=${t2 - t1}ms`);
  // resume: completed nodes never re-execute
  const eR: string[] = [];
  const resumed = await runTaskGraph(mkNodes(eR), { concurrency: 2, resumed: { sec0: { no: 1, text: 'Q1' }, sec1: { no: 2, text: 'Q2' } } as any });
  assert.deepEqual([...resumed.callsExecuted].sort(), ['sec2', 'sec3', 'sec4', 'sec5', 'sec6', 'sec7']);
  // hung node → timeout, others complete, PARTIAL names it
  const hung = await runTaskGraph([
    { id: 'ok', label: 'Fine', run: async () => 1 },
    { id: 'hang', label: 'Hung Section', timeoutMs: 30, run: () => new Promise(() => { /* never */ }) },
    { id: 'dep', label: 'Dependent', deps: ['hang'], run: async () => 2 },
  ], { concurrency: 3 });
  assert.equal(hung.results.ok, 1);
  assert.equal(hung.partial, true);
  assert.match(hung.partialMessage || '', /Hung Section/);
  assert.equal(hung.nodes.find(n => n.id === 'dep')?.status, 'skipped');
});

// (10) Provenance
test('2F provenance: 100% traced, transform chain exact, receipt has no dummy key', () => {
  const doc: any = { id: 'exam_x', questions: [Q({ id: 'q1', no: 1 }), Q({ id: 'q2', no: 2 })] };
  const traces = tracesForDoc(doc, { callLabel: 'Structure (sectioned)', model: 'm1', journalResumed: false }, {
    q1: { transforms: [{ kind: 'option-split', detail: 'split b) from a', ts: 't1' }, { kind: 'numbering', detail: '7→1', ts: 't2' }] },
  });
  assert.equal(traces.length, 2);
  assert.deepEqual(traces[0].transforms.map(t => t.kind), ['option-split', 'numbering']);
  assert.ok(traceForAgent(traces[0]));
  const report = buildParseReport(doc, { models: { fast: 'm1' }, calls: 3, tokens: { input: 10, output: 5 }, cost: 0.01, consensusSections: [], critic: { calls: 1, defects: 2, ok: 3 }, memory: { playbookIds: [], skillIds: [], guidanceTokens: 0 }, config: { apiKey: 'DUMMY-KEY-123', model: 'm1' } });
  const receipt = JSON.stringify(report);
  assert.ok(!receipt.includes('DUMMY-KEY-123'), 'receipt must never embed secrets');
  assert.ok(report.configHash.startsWith('cfg_'));
  assert.equal(configHash({ a: 1 }), configHash({ a: 1 }));
});

// (11) Live bench confirm gate + diff + regression alarm
test('2G live bench: decline = 0 calls gate, estimate math, second-run diff, regression alarm bounds', () => {
  assert.equal(liveBenchGate(false).allowed, false);
  assert.equal(liveBenchGate(true).allowed, true);
  const est = estimateLiveBench([{ id: 'g1', structureCalls: 2, estInputTokens: 1_000_000, estOutputTokens: 500_000 }], { input: 1, output: 2 });
  assert.equal(est.calls, 2); assert.equal(est.estCostUsd, 2);
  const s1: any = { ts: 't1', role: 'fast', modelId: 'a', fixtures: [{ id: 'g1', coveragePercent: 90, quality: 80, calls: 1 }], meanCoverage: 90, meanQuality: 80, totalCalls: 1, costUsd: 0.1 };
  const s2: any = { ...s1, ts: 't2', fixtures: [{ id: 'g1', coveragePercent: 95, quality: 85, calls: 1 }] };
  assert.deepEqual(diffScorecards(s1, s2), [{ fixture: 'g1', coverageDelta: 5, qualityDelta: 5 }]);
  assert.equal(regressionAlarm(Array(10).fill(95).concat(Array(10).fill(70))).alarm, true);
  assert.equal(regressionAlarm(Array(10).fill(95)).alarm, false); // n<10 both windows
  const trend = cleanRateTrend(Array.from({ length: 40 }, (_, i) => i < 20 ? 80 : 90));
  assert.equal(trend.recent, 90); assert.equal(trend.prior, 80);
});

// #21 lazy pdfjs regression guard
test('#21: extract.ts has no top-level pdfjs-dist import; lazy dynamic import inside PDF path', () => {
  const src = fs.readFileSync(new URL('../src/pipeline/extract.ts', import.meta.url), 'utf8');
  assert.ok(!/^import .*pdfjs-dist/m.test(src));
  assert.ok(/await import\('pdfjs-dist'\)/.test(src));
});

// Wiring added after the first proving-ground pass
import { buildExportDoc, parseReportForDoc } from '../src/utils/examExport';
import { validateAppSettings } from '../src/utils/validation';

test('wiring: export JSON embeds the Parse-report receipt with no dummy key; settings accept critic/consensus + parallelSections', () => {
  const doc: any = {
    id: 'exam_wire', fileHash: 'h', createdAt: 't', displayName: 'Wire', meta: {}, sections: [], images: [],
    questions: [Q({ id: 'q1', no: 1 })], source: { lines: [], pages: 1, ocrUsed: false, fileName: 'w.txt' }, flags: [],
    usage: [{ ts: 't', role: 'fast', provider: 'p', model: 'm1', inputTokens: 10, outputTokens: 5, costUsd: 0.01, label: 'Structure', apiKey: 'DUMMY-KEY-999' }],
    verdicts: { q1: [{ questionId: 'q1', verdict: 'defect', suggestedAction: 'review', note: 'x' }] },
    traces: [{ questionId: 'q1', no: 1, origin: { callLabel: 'Structure Pass', model: 'm1', journalResumed: false }, transforms: [], guidance: { playbookIds: ['pb1'], skillIds: [] }, confidenceMath: { base: 0.9, deductions: [], final: 0.9 }, verdicts: [] }],
  };
  const exported = buildExportDoc(doc);
  assert.ok(exported.parseReport, 'receipt embedded');
  assert.equal(exported.parseReport.critic.defects, 1);
  assert.deepEqual(exported.parseReport.memory.playbookIds, ['pb1']);
  assert.ok(!JSON.stringify(exported).includes('DUMMY-KEY-999'));
  assert.equal(parseReportForDoc(doc).calls, 1);

  const settings: any = {
    providers: [{ id: 'p1', name: 'P', kind: 'openai-compatible', baseURL: 'https://example.com', apiKey: 'k' }],
    roleMapping: { fast: { providerId: 'p1', model: 'a' }, standard: { providerId: 'p1', model: 'a' }, escalation: { providerId: 'p1', model: 'b' }, vision: { providerId: 'p1', model: 'a' }, critic: { providerId: 'p1', model: 'b' }, consensus: { providerId: 'p1', model: 'c' } },
    costTable: {}, thrift: { latexNormalization: true, maxImagesPerVisionCall: 8, imageMaxLongEdge: 1024, jpegQuality: 80, cacheEnabled: true },
    budget: { maxUsdPerRun: 1, maxOutputTokens: 4096 }, document: { defaultLanguage: 'auto', paperSize: 'A4', fontSize: 'medium' },
    parallelSections: 4, consensusEnabled: true,
  };
  const parsed: any = validateAppSettings(settings);
  assert.equal(parsed.roleMapping.critic.model, 'b');
  assert.equal(parsed.roleMapping.consensus.model, 'c');
  assert.equal(parsed.parallelSections, 4);
});

test('wiring-2: consensus triggers on points mismatch / tripwires / in-section missing; graph nodes report tokens', async () => {
  assert.equal(consensusTriggerForSection({ questions: [Q({ confidence: 0.95 })], issues: [], pointsMismatch: true }).triggered, true);
  assert.equal(consensusTriggerForSection({ questions: [Q({ confidence: 0.95 })], issues: [], tripwiresFired: true }).triggered, true);
  assert.equal(consensusTriggerForSection({ questions: [Q({ confidence: 0.95 })], issues: [], missingInSection: [7] }).triggered, true);
  assert.deepEqual(consensusTriggerForSection({ questions: [Q({ confidence: 0.95 })], issues: [] }), { triggered: false, reasons: [] });
  const g = await runTaskGraph([{ id: 'n1', label: 'S1', run: async () => ({ tokens: 123 }) }], { concurrency: 1 });
  assert.equal(g.nodes[0].tokens, 123);
  assert.equal(g.nodes[0].status, 'done');
});
