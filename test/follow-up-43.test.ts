import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppSettings, ExamDoc, Question, SourceLine } from '../src/types';
import { compileDocument } from '../src/pipeline/compile';
import { buildDecisionCatalogue, DECIDE_CATCH, DECIDE_PASS, runDecisionAudit } from '../src/pipeline/audit';
import { computeAttention } from '../src/utils/attention';
import { parseReportForDoc } from '../src/utils/examExport';

const line = (n: number, text: string, page = 1): SourceLine => ({
  id: `L${String(n).padStart(4, '0')}`, page, y: n * 10, pageHeight: 900, text,
});

const claimed = (q: Question): number[] => {
  const nos: number[] = [];
  for (const s of q.spans) if (Array.isArray(s)) for (let n = s[0]; n <= s[1]; n++) nos.push(n);
  for (const o of q.options || []) for (const s of o.spans) if (Array.isArray(s)) for (let n = s[0]; n <= s[1]; n++) nos.push(n);
  return [...new Set(nos)].sort((a, b) => a - b);
};


const q = (id: string, no: number, spans: [number, number][],
           options: { key: string; spans: [number, number][] }[] = [],
           answer?: { spans: [number, number][] }): Question => ({
  id, label: `Q${no}`, no, sectionId: 's1', type: 'mcq',
  spans: spans.map(([a, b]) => [a, b] as [number, number]),
  stem: `Q${no} stem`,
  options: options.map(o => ({ key: o.key, spans: o.spans.map(([a, b]) => [a, b] as [number, number]), text: `opt ${o.key}` })),
  answer: answer ? { spans: answer.spans.map(([a, b]) => [a, b] as [number, number]), source: 'ai' } : undefined,
  points: 2, confidence: 1, images: [],
});

const settings = (decideSel: unknown = undefined, mode?: 'shadow' | 'active'): AppSettings =>
  (({
    providers: decideSel ? [{ id: 'g', name: 'Gemini', kind: 'gemini', baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'x', disableReasoning: true, structuredOutputs: true, extraBodyJson: '' }] : [],
    roleMapping: {
      fast: { providerId: 'g', model: 'm' },
      standard: { providerId: 'g', model: 'm' },
      escalation: { providerId: 'g', model: 'm' },
      vision: { providerId: 'g', model: 'm' },
      read: { providerId: 'g', model: 'm' },
      meta: { providerId: 'g', model: 'm' },
      cloud: { providerId: 'g', model: 'm' },
      repair: { providerId: 'g', model: 'm' },
      ...(decideSel ? { decide: decideSel as any } : {}),
    },
    costTable: { m: { inputCostPerMillion: 1, outputCostPerMillion: 2 } },
    thrift: { latexNormalization: false, maxImagesPerVisionCall: 16, imageMaxLongEdge: 1024, jpegQuality: 80, cacheEnabled: true },
    budget: { maxUsdPerRun: 0.25, maxOutputTokens: 1024 },
    document: { defaultLanguage: 'auto', paperSize: 'A4', fontSize: 'medium' },
    decideMode: mode,
  } as unknown) as AppSettings);

// ---------------------------------------------------------------------------
// Fake folder storage so the content-hash cache (get/setPipelineCache) works
// in tests without a server. Real route: GET/PUT /api/cache/<key>.
// ---------------------------------------------------------------------------
const cache = new Map<string, unknown>();
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith('/api/cache/')) {
    const key = url.slice('/api/cache/'.length);
    if (init?.method === 'PUT') { cache.set(key, init.body ? JSON.parse(init.body) : null); return { ok: true, status: 200, json: async () => null }; }
    return { ok: true, status: 200, json: async () => cache.get(key) };
  }
  if (url.startsWith('/api/usage')) return { ok: true, status: 200, json: async () => null };
  throw new Error('unmocked fetch: ' + url);
}) as any;

test.beforeEach(() => { cache.clear(); });

test.after(() => { globalThis.fetch = realFetch; });

// ===========================================================================
// Part A — compile tests
// ===========================================================================

test('compile (a): double-claimed lines → first claim wins; emptied loser is dropped, never shipped', async () => {
  const lines = [line(1, 'Q1 stem'), line(2, 'opt A'), line(3, 'Q2 stem'), line(4, 'opt B')];
  const q1 = q('q1', 1, [[1, 1]], [{ key: 'A', spans: [[2, 2]]}]);
  const q2 = q('q2', 2, [[1, 3]], [{ key: 'A', spans: [[4, 4]]}]); // claims line 1 too
  const out = await compileDocument({ questions: [q1, q2], sections: [], lines, keyLineNos: [] });

  // Line 1: first claim (document order, Q1) keeps it; Q2 loses it.
  const foundQ2 = out.questions.find(q => q.id === 'q2');
  assert.ok(foundQ2, 'Q2 survives with its remaining lines');
  assert.deepEqual(claimed(foundQ2!), [3, 4], 'Q2 keeps its un-contested stem line plus its own option');
  assert.deepEqual(claimed(out.questions.find(q => q.id === 'q1')!), [1, 2], 'Q1 keeps line 1 plus its own option');

  const doubles = out.reconciliations.filter(r => r.kind === 'double-claim');
  assert.equal(doubles.length, 2, 'lines 1 and 2 are both double-claimed (Q2 spans 1–3)');
  assert.deepEqual(doubles[0].lines, [1]);
  assert.deepEqual(doubles[0].questionIds, ['q1', 'q2']);
  assert.deepEqual(doubles[1].lines, [2]);
  assert.deepEqual(doubles[1].questionIds, ['q1', 'q2']);
  assert.ok(out.journal.some(j => j.label === 'Compile · double-claim'), 'reconciliation is journaled');

  // No empty question is shipped, and no unclaimed-line defect is manufactured.
  assert.equal(out.questions.length, 2);
  assert.equal(out.defects.length, 0);
  assert.equal(out.pageStatus.get(1), 'ok-reconciled');
});

test('compile (a2): a question stripped of every line is dropped, recorded, and never reaches the teacher as an empty record', async () => {
  const lines = [line(1, 'shared line')];
  const q1 = q('q1', 1, [[1, 1]]);
  const q2 = q('q2', 2, [[1, 1]]); // identical claim, later in document order
  const out = await compileDocument({ questions: [q1, q2], sections: [], lines, keyLineNos: [] });

  assert.equal(out.questions.length, 1, 'emptied loser is removed');
  assert.equal(out.questions[0].id, 'q1');
  assert.equal(out.reconciliations.filter(r => r.kind === 'question-dropped').length, 1, 'drop is journaled');
  assert.equal(out.defects.length, 0);
});

test('compile (b): unclaimed interior run is absorbed; surgical re-ask closes one defect; furniture by ≥3-page repetition', async () => {
  const lines = [
    line(1, '1. Stem start'), line(2, 'stem cont.'),
    line(3, 'mid line A'), line(4, 'mid line B'), line(5, 'mid line C'), line(6, 'mid line D'),
    line(7, 'stem end'), line(8, 'opt A'),
  ];
  const q1 = q('q1', 1, [[1, 2], [7, 8]], [{ key: 'A', spans: [[8, 8]]}]);
  const out = await compileDocument({ questions: [q1], sections: [], lines, keyLineNos: [] });

  // Lines 3–6 sit between two lines of Q1 and were claimed by nobody: absorbed, no defect.
  assert.deepEqual(claimed(q1), [1, 2, 3, 4, 5, 6, 7, 8], 'interior run absorbed into the question');
  assert.equal(out.reconciliations.filter(r => r.kind === 'orphan-absorbed').length, 1, 'absorption journaled');
  assert.equal(out.defects.length, 0, 'no defect remains for an absorbed run');
  assert.equal(out.pageStatus.get(1), 'ok-reconciled');

  // One precise re-ask closes a remaining defect (surgical correction).
  const lines2 = [line(1, '1. Stem'), line(2, 'opt A'), line(3, 'orphan A'), line(4, 'orphan B'), line(5, 'orphan C'), line(6, '2. Stem2')];
  const q2 = q('q2', 1, [[1, 1]], [{ key: 'A', spans: [[2, 2]]}]);
  const q3 = q('q3', 2, [[6, 6]]);
  let capturedDefectId = '';
  const out2 = await compileDocument({
    questions: [q2, q3], sections: [], lines: lines2, keyLineNos: [],
    caller: async req => {
      capturedDefectId = req.text.match(/"defect":"([^"]+)"/)?.[1] ?? '';
      return { rawText: '{}', json: { ops: [{ op: 'assignLines', defect: capturedDefectId || 'd', lines: [3, 5], questionId: 'q2' }] }, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  });
  assert.equal(out2.defects.length, 0, 're-ask closed the defect');
  assert.equal(out2.closedDefects.length, 1, 'defect closed by code-validated op');
  assert.deepEqual(claimed(out2.questions.find(q => q.id === 'q2')!), [1, 2, 3, 4, 5], 'assigned lines applied to the question');

  // Furniture: identical line text on ≥3 pages is never a claim.
  const lines3 = [
    line(1, 'RUNNING HEADER'), line(5, '1. Only question on page 1'),
    line(1, 'RUNNING HEADER', 2), line(1, 'RUNNING HEADER', 3),
  ];
  const q4 = q('q4', 1, [[5, 5]]);
  const out3 = await compileDocument({ questions: [q4], sections: [], lines: lines3, keyLineNos: [] });
  assert.equal(out3.furnitureDropped.includes(1), true, 'repeated line treated as furniture');
  assert.equal(out3.reconciliations.filter(r => r.kind === 'orphan-furniture').length, 1, 'furniture reconciliation recorded');
  assert.equal(out3.defects.length, 0, 'furniture line is not an unaccounted-lines defect');
  assert.equal(out3.pageStatus.get(1), 'ok-reconciled');
  assert.equal(out3.pageStatus.get(2), 'ok');
  assert.equal(out3.pageStatus.get(3), 'ok');
});

test('compile (c): duplicate printed numbers keep the more complete record; read-failed only when nothing is salvageable', async () => {
  const lines = [
    line(10, '5. First stem (complete)'), line(11, 'opt A'), line(12, 'opt B'),
    line(20, '5. Duplicate stem'),
  ];
  const q1 = q('q1', 5, [[10, 12]], [{ key: 'A', spans: [[11, 11]]}, { key: 'B', spans: [[12, 12]]}]);
  const q2 = q('q2', 5, [[20, 20]]);
  const out = await compileDocument({ questions: [q1, q2], sections: [], lines, keyLineNos: [] });

  assert.equal(out.questions.length, 1, 'duplicate record dropped');
  assert.equal(out.questions[0].id, 'q1', 'more complete record kept');
  const dup = out.reconciliations.filter(r => r.kind === 'duplicate-number');
  assert.equal(dup.length, 1, 'duplicate-number reconciliation recorded');
  assert.match(dup[0].detail, /kept the more complete record/);

  // A page with questions plus a surviving defect is partial, never read-failed.
  const lines2 = [line(30, '6. Stem'), line(31, 'unclaimed orphan')];
  const q3 = q('q3', 6, [[30, 30]]);
  const out2 = await compileDocument({ questions: [q3], sections: [], lines: lines2, keyLineNos: [] });
  assert.equal(out2.defects.length, 1, 'unclaimed line becomes a defect, not a rejected page');
  assert.equal(out2.pageStatus.get(1), 'partial', 'salvageable page is partial, not read-failed');

  // A page the read could not touch at all, with no questions to salvage, is read-failed.
  const lines3 = [line(13, 'page 2, never read', 2)];
  const out3 = await compileDocument({ questions: [], sections: [], lines: lines3, keyLineNos: [], failedPages: [2] });
  assert.equal(out3.pageStatus.get(2), 'read-failed', 'unread page with nothing salvageable is read-failed');
});

// ===========================================================================
// Part B — decision audit tests
// ===========================================================================

const baseDoc = {
  questions: [q('q1', 1, [[1, 2], [4, 4]], [{ key: 'A', spans: [[3, 3]]}])],
  sections: [{ id: 's1', index: 1, title: 'Part 1', spans: [[1, 4] as [number, number]] }],
  images: [],
  totalPoints: 10,
  meta: { subject: 'English', grade: '12', language: 'en', direction: 'ltr' as const },
};
const baseLines = [line(1, '1. Stem text'), line(2, 'stem cont.'), line(3, 'A) option'), line(4, '2. Next question?')];

test('audit (a): no decide role → layer skipped, never an error; parse report carries the skip line', async () => {
  const result = await runDecisionAudit({ doc: baseDoc, lines: baseLines, settings: settings(), fileHash: 'hash-a' });
  assert.equal(result.summary.mode, 'skipped');
  assert.equal(result.summary.skipReason, 'no decide role');
  assert.equal(result.summary.decisions, 0);
  assert.equal(result.summary.catches, 0);
  assert.equal(result.defects.length, 0);
  assert.equal(result.votes.length, 0);

  const doc = {
    ...baseDoc, id: 'exam_1', fileHash: 'hash-a', createdAt: new Date().toISOString(), displayName: 'English Exam',
    source: { lines: baseLines, pages: 1, ocrUsed: false, fileName: 'a.pdf', expectedQuestionNos: [], keyTerritoryLineNos: [], orphanLineNos: [] },
    flags: [], usage: [],
    spine: { classify: { status: 'completed', calls: 0 }, repairLoop: { status: 'completed', rounds: 0, calls: 0, escalations: 0, defectsRemaining: 0, remainingKinds: [], budget: { calls: 0, units: 0, maxCalls: 0, maxUnits: 0 } }, audit: result.summary, budget: { calls: 0, units: 0, maxCalls: 0, maxUnits: 0 } },
  } as unknown as ExamDoc;
  const report = parseReportForDoc(doc);
  assert.equal(report.audit?.mode, 'skipped');
  assert.equal(report.audit?.skipReason, 'no decide role');
  assert.ok(JSON.stringify(report.audit).includes('no decide role'), 'parse report says audit: skipped (no decide role)');
  assert.ok(JSON.stringify(report).includes('audit'), 'audit present in parse report');
});

test('audit (b): shadow mode is the default — computes, journals, reports, routes nothing', async () => {
  let decisionCalls = 0;
  const probs = new Map<string, number>([['Q1::stem-faithful', 0.05]]); // one confident-wrong catch
  const decisionCaller = async (body: any) => {
    decisionCalls++;
    return { results: body.questions.map((item: any) => ({ name: item.id, probability: probs.get(item.id) ?? 0.9 })) };
  };
  const journals: string[] = [];
  const result = await runDecisionAudit({
    doc: baseDoc, lines: baseLines, settings: settings({ providerId: 'g', model: 'm' }), fileHash: 'hash-b',
    decisionCaller, onJournal: e => { journals.push(e.label); },
  });
  assert.equal(result.summary.mode, 'shadow', 'default mode is shadow');
  assert.equal(result.summary.decisions, buildDecisionCatalogue({ doc: baseDoc, lines: baseLines }).length, 'every catalogue item decided');
  assert.equal(result.summary.catches, 1, 'catch counted in shadow');
  assert.equal(result.summary.uncertain, 0);
  assert.equal(result.defects.length, 0, 'shadow never creates a defect');
  assert.equal(decisionCalls, 1, 'exactly one decisions request');
  assert.ok(journals.some(j => j.includes('shadow — not routed')), 'shadow non-routing is journaled');

  // No attention item arises from a shadow catch.
  const doc = { ...baseDoc, id: 'exam_1', questions: baseDoc.questions, sections: baseDoc.sections, images: [], source: { lines: baseLines }, flags: [], usage: [] } as unknown as ExamDoc;
  assert.equal(computeAttention(doc).filter(i => i.kind === 'audit-catch').length, 0);
});

test('audit (c): active mode, p ≤ 0.20 → scoped re-ask quoting the audit, then the teacher; a closed re-ask needs no teacher', async () => {
  // (c1) re-ask declines (noFix) → defect survives → teacher attention item.
  let decisionCalls = 0;
  const probs = new Map<string, number>([['Q1::stem-faithful', 0.05]]);
  const decisionCaller = async (body: any) => {
    decisionCalls++;
    return { results: body.questions.map((item: any) => ({ name: item.id, probability: probs.get(item.id) ?? 0.9 })) };
  };
  const result = await runDecisionAudit({
    doc: baseDoc, lines: baseLines, settings: settings({ providerId: 'g', model: 'm' }, 'active'), fileHash: 'hash-c',
    decisionCaller,
    caller: async () => ({ rawText: '{}', json: { ops: [{ op: 'noFix', defect: 'd', reason: 'cannot fix from evidence' }] }, usage: { inputTokens: 5, outputTokens: 5 } }),
  });
  assert.equal(result.summary.mode, 'active');
  assert.equal(result.summary.catches, 1);
  assert.equal(result.defects.length, 1, 'surviving catch becomes a defect');
  assert.equal(result.defects[0].kind, 'audit-catch');
  assert.equal(result.defects[0].questionIds[0], 'q1');
  assert.match(result.defects[0].detail, /Decision audit/);

  // The defect reaches the teacher via the single attention function.
  const flag = { id: 'f1', code: 'AUDIT_CATCH', severity: 'error' as const, message: result.defects[0].detail, questionId: 'q1' };
  const doc = { ...baseDoc, id: 'exam_1', questions: baseDoc.questions, sections: baseDoc.sections, images: [], source: { lines: baseLines }, flags: [flag], usage: [] } as unknown as ExamDoc;
  const attention = computeAttention(doc);
  assert.equal(attention.filter(i => i.kind === 'audit-catch').length, 1, 'audit catch is teacher attention');
  assert.equal(attention[0].questionIds[0], 'q1');

  // (c2) re-ask closes the defect → nothing reaches the teacher.
  const result2 = await runDecisionAudit({
    doc: baseDoc, lines: baseLines, settings: settings({ providerId: 'g', model: 'm' }, 'active'), fileHash: 'hash-c2',
    decisionCaller,
    caller: async () => ({ rawText: '{}', json: { ops: [{ op: 'dropAsFurniture', defect: 'd', lines: [4, 4] }] }, usage: { inputTokens: 5, outputTokens: 5 } }),
  });
  assert.equal(result2.defects.length, 0, 'closed catch needs no teacher');
});

test('audit (d): 0.20–0.80 → audit-uncertain, report-only, unless another defect touches the question', async () => {
  const probs = new Map<string, number>([['Q1::stem-faithful', 0.50]]);
  const decisionCaller = async (body: any) => ({ results: body.questions.map((item: any) => ({ name: item.id, probability: probs.get(item.id) ?? 0.9 })) });
  const journals: string[] = [];
  const result = await runDecisionAudit({
    doc: baseDoc, lines: baseLines, settings: settings({ providerId: 'g', model: 'm' }, 'active'), fileHash: 'hash-d',
    decisionCaller, onJournal: e => { journals.push(e.label); },
  });
  assert.equal(result.summary.uncertain, 1);
  assert.equal(result.summary.catches, 0);
  assert.equal(result.defects.length, 0, 'uncertain is never a defect by itself');
  assert.ok(journals.some(j => j.includes('audit-uncertain')), 'uncertain is journaled');

  // Same uncertain vote, but the question already has a compile/repair defect → noted as evidence.
  const journals2: string[] = [];
  await runDecisionAudit({
    doc: baseDoc, lines: baseLines, settings: settings({ providerId: 'g', model: 'm' }, 'active'), fileHash: 'hash-d2',
    decisionCaller, existingDefects: [{ questionIds: ['q1'] }], onJournal: e => { journals2.push(e.rawText ?? ''); },
  });
  assert.ok(journals2.some(t => t.includes('already has a compile/repair defect; noted as evidence')), 'uncertain is evidenced against a touched question');
});

test('audit (e): decisions are content-hash cached (record hash + question name + model)', async () => {
  let decisionCalls = 0;
  const decisionCaller = async (body: any) => {
    decisionCalls++;
    return { results: body.questions.map((item: any) => ({ name: item.id, probability: 0.9 })) };
  };
  const settingsWithDecide = settings({ providerId: 'g', model: 'm' });

  const r1 = await runDecisionAudit({ doc: baseDoc, lines: baseLines, settings: settingsWithDecide, fileHash: 'hash-e', decisionCaller });
  const r2 = await runDecisionAudit({ doc: baseDoc, lines: baseLines, settings: settingsWithDecide, fileHash: 'hash-e', decisionCaller });

  assert.equal(decisionCalls, 1, 'second run serves every vote from the content-hash cache');
  assert.equal(r1.summary.decisions, r2.summary.decisions, 'decisions counted identically on a cache hit');
  assert.ok(r2.votes.every(v => v.cached), 'second-run votes are cache hits');
  assert.equal(r1.summary.inputTokens > 0, true, 'first run estimates input tokens');
  assert.equal(r2.summary.inputTokens, 0, 'cache hits cost nothing');

  // Different model → different cache key → fresh call.
  const settingsOtherModel = settings({ providerId: 'g', model: 'm2' });
  await runDecisionAudit({ doc: baseDoc, lines: baseLines, settings: settingsOtherModel, fileHash: 'hash-e', decisionCaller });
  assert.equal(decisionCalls, 2, 'a different model re-decides (cache key includes model)');
});

test('audit (f): thresholds are global and visible (0.80 pass / 0.20 catch), with no transport meltdown', async () => {
  assert.equal(DECIDE_PASS, 0.80);
  assert.equal(DECIDE_CATCH, 0.20);

  for (const [p, expectCatch, expectUncertain] of [
    [0.80, 0, 0],   // exactly 0.80 passes
    [0.799, 0, 8],  // just below pass → uncertain
    [0.20, 8, 0],   // exactly 0.20 is a catch
    [0.201, 0, 8],  // just above catch → uncertain
  ] as const) {
    const probs = new Map<string, number>();
    const catalogue = buildDecisionCatalogue({ doc: baseDoc, lines: baseLines });
    for (const item of catalogue) probs.set(item.id, p);
    const decisionCaller = async (body: any) => ({ results: body.questions.map((item: any) => ({ name: item.id, probability: probs.get(item.id) })) });
    const result = await runDecisionAudit({ doc: baseDoc, lines: baseLines, settings: settings({ providerId: 'g', model: 'm' }, 'active'), fileHash: `hash-f-${p}`, decisionCaller });
    assert.equal(result.summary.catches, expectCatch, `p=${p}: catches`);
    assert.equal(result.summary.uncertain, expectUncertain, `p=${p}: uncertain`);
    assert.equal(result.summary.decisions, catalogue.length);
  }

  // Transport failure: configured but unreachable → reported, never thrown, nothing routed.
  const result = await runDecisionAudit({
    doc: baseDoc, lines: baseLines, settings: settings({ providerId: 'g', model: 'm' }, 'active'), fileHash: 'hash-f2',
    decisionCaller: async () => { throw new Error('connection refused'); },
  });
  assert.equal(result.summary.mode, 'active');
  assert.ok(result.summary.transportError, 'transport error recorded');
  assert.equal(result.defects.length, 0, 'nothing routed when the decisions endpoint is unreachable');
});
