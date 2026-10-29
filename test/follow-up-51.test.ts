/** #51 — visual map audit + six phases (check-then-fix-once). */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '../src/store';
import type { AppSettings, ExamDoc, ImageAsset, SourceLine } from '../src/types';
import { runLocalLoop } from '../src/pipeline/localLoopRunner';
import {
  LOOP_PHASES, LOOP_PHASE_NAMES, VERDICT_CONCERN, batchVerdictsBySection, changedQuestionNumbers, mergeVerdicts, normalizeAuthoredDocument,
  type LoopModelRequest, type LoopReceipt as Receipt, type LoopVerdict,
} from '../src/pipeline/localLoop';
import { buildLoopDecisionCatalogue, buildThxDecisionBody } from '../src/pipeline/loopAudit';
import { runMapFirstRead, visualMapItems, type LoopMapReceipt } from '../src/pipeline/mapFirst';
import { DECIDE_CATCH, DECIDE_PASS } from '../src/pipeline/audit';
import { MapOutline } from '../src/components/MapOutline';
import { LoopReceipt } from '../src/components/LoopReceipt';
import { LoopPhaseList, initialLoopStages } from '../src/views/Step3Analyze';
import { computeAttention } from '../src/utils/attention';
import { validateDecisionsRequest } from '../server';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const line = (id: number, text: string, page = 1): SourceLine => ({ id: `L${String(id).padStart(4, '0')}`, page, y: id, text });
const exam = (n: number): SourceLine[] => [line(1, 'English Quiz — grade 10'), line(2, 'Section A: Vocabulary'),
  ...Array.from({ length: n }, (_, i) => line(i + 3, `${i + 1}. Question number ${i + 1}? a) yes b) no`, i < n / 2 ? 1 : 2))];
const settings = (mode: 'active' | 'shadow' = 'active', extra: Partial<AppSettings> = {}, dialect: 'thx' | 'jev' = 'thx'): AppSettings => ({ ...DEFAULT_SETTINGS,
  thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false },
  providers: [{ id: 'd', name: 'local decide', kind: 'openai-compatible', baseURL: 'http://localhost:8080', apiKey: '', decideDialect: dialect }],
  roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId: 'd', model: 'decider' } }, decideMode: mode, ...extra } as AppSettings);
const goodQuestion = (n: number) => ({ number: n, sectionTitle: 'Vocabulary', type: 'mcq', stem: `Question number ${n}?`, options: [{ key: 'a', text: 'yes' }, { key: 'b', text: 'no' }], imageIds: [] });
const examMap = (n: number) => ({ meta: { subject: 'English', grade: '10' }, sectionCount: 1, sections: [{ title: 'Vocabulary', firstQuestion: 1, lastQuestion: n, questionCount: n, kind: 'vocabulary' }],
  instructionGroupCount: 0, instructionGroups: [], passageCount: 0, passages: [], imageCount: 0, images: [] });
/** Section parse with planted defects: empty stems (code AND decision flag them) and one wrong stem (decision only). */
function generative(n: number, empty: number[], wrong: number[], log: string[], fixInputs: string[]) {
  return async (req: LoopModelRequest) => {
    log.push(`gen:${req.step}:${req.label}`);
    if (req.step === 'map') return { rawText: JSON.stringify(examMap(n)) };
    if (req.step === 'parse') {
      const questions = Array.from({ length: n }, (_, i) => goodQuestion(i + 1)).map(q => empty.includes(q.number) ? { ...q, stem: '' } : wrong.includes(q.number) ? { ...q, stem: 'WRONG invented text' } : q);
      return { rawText: JSON.stringify({ questionCount: n, questions }) };
    }
    // Fix: repair every question supplied, by number, from the source.
    fixInputs.push(req.text);
    const supplied = JSON.parse(req.text.split('\n\nSOURCE PAGES')[0]).questions as Array<{ number: number }>;
    return { rawText: JSON.stringify({ corrections: supplied.map(q => ({ action: 'replace', questionNumber: q.number, question: goodQuestion(q.number) })) }) };
  };
}
/** THX-shaped stub referee: flags stems that are empty (p 0.1) or invented (p 0.05); everything else is sound. */
function referee(log: string[], bodies: any[] = [], override: (name: string, body: any) => number | undefined = () => undefined) {
  return async (body: any) => {
    bodies.push(body);
    const [name, question] = Object.entries(body.questions)[0] as [string, any];
    log.push(`decide:${name}`);
    if (question.type === 'score') return { results: [{ name, probability: 0.9, choice: '2' }] };
    if (question.criteria && !Array.isArray(question.criteria)) return { results: [{ name, probability: 0.9, choice: name.includes('section-title') ? 'Vocabulary' : Object.keys(question.criteria)[0] }] };
    const forced = override(name, body);
    if (forced !== undefined) return { results: [{ name, probability: forced }] };
    const p = /stem-faithful/.test(name) && body.state.includes('"stem":""') ? 0.1 : /stem-faithful/.test(name) && body.state.includes('WRONG') ? 0.05 : 0.95;
    return { results: [{ name, probability: p }] };
  };
}
const stemConcern = (v: LoopVerdict) => VERDICT_CONCERN[v.kind] === 'stem';
const timelineKeys = (receipt: Receipt) => receipt.timeline!.map(e => `${e.phase}:${e.event}`);

// ── 1. Phase order ──────────────────────────────────────────────────────────────────────────────
test('#51 phase order: Map → map checks → Parse → code check → decision audit → Fix → re-check; no self-review/final-fix', async () => {
  const log: string[] = []; const fixInputs: string[] = [];
  const receipt = await runLocalLoop({ lines: exam(6), images: [], settings: settings('active'), fileHash: 'order', caller: generative(6, [2], [4], log, fixInputs), decisionCaller: referee(log) });
  assert.deepEqual(timelineKeys(receipt), ['map:generate', 'map:code', 'map:decide', 'parse:generate', 'check:code', 'check:decide', 'fix:generate', 'present:code', 'present:decide']);
  assert.deepEqual(receipt.steps.map(s => s.step), [...LOOP_PHASES]);
  assert.deepEqual(receipt.steps.map(s => s.name), ['Extract', 'Map', 'Parse', 'Check', 'Fix', 'Present']);
  // Between the last Parse call and the Fix call, the only model traffic is the decision audit.
  const lastParse = log.map(e => e.startsWith('gen:parse')).lastIndexOf(true);
  const firstFix = log.findIndex(e => e.startsWith('gen:fix'));
  assert.ok(lastParse >= 0 && firstFix > lastParse);
  assert.ok(log.slice(lastParse + 1, firstFix).every(e => e.startsWith('decide:')), 'no generative call between code check and Fix');
  assert.ok(log.slice(lastParse + 1, firstFix).some(e => e.startsWith('decide:Q')), 'the decision audit ran before Fix');
  assert.equal(log.filter(e => e.startsWith('gen:fix')).length, 1, 'ONE fix pass (one section batch)');
  assert.ok(!log.some(e => /self-review|final fix|code-verdict/i.test(e)), 'deleted steps make zero calls');
  assert.equal(receipt.version, 'local-loop-v2');
});

// ── 2. Merged verdict ───────────────────────────────────────────────────────────────────────────
test('#51 merged verdict: code empty-stem + decision stem-faithful on Q2 = ONE verdict with the decision probability; Fix gets it once with both sources', async () => {
  const log: string[] = []; const fixInputs: string[] = [];
  const receipt = await runLocalLoop({ lines: exam(6), images: [], settings: settings('active'), fileHash: 'merge', caller: generative(6, [2], [4], log, fixInputs), decisionCaller: referee(log) });
  const q2 = receipt.mergedVerdicts!.filter(v => v.questionNumbers.includes(2) && stemConcern(v));
  assert.equal(q2.length, 1, JSON.stringify(receipt.mergedVerdicts));
  assert.deepEqual(q2[0].sources, ['code', 'decision']);
  assert.equal(q2[0].probability, 0.1);
  assert.deepEqual(q2[0].merged!.map(m => `${m.source}:${m.kind}`).sort(), ['code:empty-stem', 'decision:stem-faithful']);
  assert.ok(!receipt.mergedVerdicts!.some(v => v.kind === 'empty-stem' && v.questionNumbers.includes(2)), 'the code twin is absorbed, not listed twice');
  assert.equal(fixInputs.length, 1);
  const payload = JSON.parse(fixInputs[0].split('\n\nSOURCE PAGES')[0]);
  assert.equal(payload.questions.filter((q: any) => q.number === 2).length, 1, 'Q2 sent once');
  const sent = payload.verdicts.filter((v: any) => v.questionNumbers.includes(2) && VERDICT_CONCERN[v.kind as keyof typeof VERDICT_CONCERN] === 'stem');
  assert.equal(sent.length, 1, 'the merged verdict travels once');
  assert.deepEqual(sent[0].sources.map((s: any) => s.source).sort(), ['code', 'decision']);
  assert.equal(sent[0].sources.find((s: any) => s.source === 'decision').probability, 0.1);
  // Q4: decision-only confident-wrong is in scope (active) and quoted with its probability.
  assert.ok(payload.verdicts.some((v: any) => v.kind === 'stem-faithful' && v.questionNumbers.includes(4) && v.probability === 0.05));
});

test('#51 merge unit: concern mapping, image key, pass-band decision votes never enter the list', () => {
  const code: LoopVerdict[] = [
    { id: 'code:empty-stem:3', kind: 'empty-stem', questionNumbers: [3], source: 'code', message: 'Q3 has no stem.' },
    { id: 'code:image-unassigned:img1', kind: 'image-unassigned', questionNumbers: [], imageId: 'img1', source: 'code', message: 'img1 is unassigned.' },
    { id: 'code:options-missing:5', kind: 'options-missing-for-type', questionNumbers: [5], source: 'code', message: 'Q5 mcq without options.' },
  ];
  const decision: LoopVerdict[] = [
    { id: 'decision:Q3::stem-faithful', kind: 'stem-faithful', questionNumbers: [3], source: 'decision', probability: 0.15, message: 'stem?' },
    { id: 'decision:image-img1::image-belongs', kind: 'image-belongs', questionNumbers: [7], imageId: 'img1', source: 'decision', probability: 0.5, message: 'image?' },
    { id: 'decision:Q5::complete', kind: 'complete', questionNumbers: [5], source: 'decision', probability: 0.9, message: 'complete' },
    { id: 'decision:Q5::type-correct', kind: 'type-correct', questionNumbers: [5], source: 'decision', probability: 0.3, message: 'type?' },
  ];
  const merged = mergeVerdicts(code, decision, DECIDE_PASS);
  assert.equal(merged.length, 4, JSON.stringify(merged.map(v => v.id)));
  assert.deepEqual(merged.find(v => v.id === 'decision:Q3::stem-faithful')!.sources, ['code', 'decision']);
  assert.deepEqual(merged.find(v => v.id === 'decision:image-img1::image-belongs')!.sources, ['code', 'decision'], 'image concern keyed by imageId');
  assert.ok(merged.some(v => v.id === 'code:options-missing:5'), 'a passing decision vote never absorbs a code verdict');
  assert.ok(merged.some(v => v.id === 'decision:Q5::type-correct' && !v.sources), 'different concern stays separate');
});

test('#51 shadow mode: Fix receives code verdicts only — no decision probability reaches the fixer', async () => {
  const log: string[] = []; const fixInputs: string[] = [];
  const receipt = await runLocalLoop({ lines: exam(6), images: [], settings: settings('shadow'), fileHash: 'shadow', caller: generative(6, [2], [4], log, fixInputs), decisionCaller: referee(log) });
  assert.equal(receipt.auditMode, 'shadow');
  assert.equal(fixInputs.length, 1);
  const payload = JSON.parse(fixInputs[0].split('\n\nSOURCE PAGES')[0]);
  assert.deepEqual(payload.questions.map((q: any) => q.number), [2], 'Q4 (decision-only) is not fixed in shadow mode');
  assert.ok(payload.verdicts.every((v: any) => v.probability === undefined && !v.sources));
  assert.ok(receipt.survivingVerdicts.some(v => v.questionNumbers.includes(4) && v.source === 'decision'), 'shadow still reports Q4');
});

// ── 3. Re-check economy ─────────────────────────────────────────────────────────────────────────
test('#51 re-check economy: Fix changes 3 of 60 → decision re-votes only those items; code re-check makes zero model calls; repaired defects do not survive', async () => {
  const log: string[] = []; const fixInputs: string[] = [];
  const lines = exam(60);
  const receipt = await runLocalLoop({ lines, images: [], settings: settings('active'), fileHash: 'economy', caller: generative(60, [2, 50], [4], log, fixInputs), decisionCaller: referee(log) });
  assert.deepEqual(receipt.recheck!.changedQuestions, [2, 4, 50]);
  const timeline = receipt.timeline!;
  const checkDecides = timeline.find(e => e.phase === 'check' && e.event === 'decide')!.count;
  const presentDecides = timeline.find(e => e.phase === 'present' && e.event === 'decide')!.count;
  const changed = new Set([2, 4, 50]);
  const indicted = new Set(receipt.mergedVerdicts!.filter(v => v.source === 'decision' && (v.probability ?? 1) <= DECIDE_CATCH).map(v => v.id));
  const catalogue = buildLoopDecisionCatalogue({ document: receipt.document, lines, images: [], mode: 'active' });
  const bound = catalogue.filter(item => item.questionNumbers.some(n => changed.has(n)) || indicted.has(`decision:${item.id}`)).length;
  assert.equal(presentDecides, bound, `re-votes ${presentDecides} = changed + confidently indicted items ${bound}`);
  assert.ok(presentDecides <= bound && presentDecides < checkDecides / 10, `${presentDecides} vs ${checkDecides}`);
  assert.equal(receipt.recheck!.decisionRevoted, presentDecides);
  assert.equal(receipt.recheck!.decisionReused, checkDecides - presentDecides);
  // Code re-check: no model calls at all after Fix.
  const firstFix = log.findIndex(e => e.startsWith('gen:fix'));
  assert.equal(log.slice(firstFix + 1).filter(e => e.startsWith('gen:')).length, 0);
  assert.equal(receipt.recheck!.codeModelCalls, 0);
  // Post-fix state: none of the repaired defects survive; the Fix row records closures.
  for (const n of [2, 4, 50]) assert.ok(!receipt.survivingVerdicts.some(v => v.questionNumbers.includes(n) && stemConcern(v)), `Q${n} repaired`);
  assert.ok(!receipt.codeVerdicts.some(v => v.kind === 'empty-stem'));
  const fixRow = receipt.steps.find(s => s.step === 'fix')!;
  assert.equal(fixRow.correctionsApplied, 3); assert.ok(fixRow.verdictsClosed >= 3);
  // Difficulty rides on the final document: replaced questions were re-voted and re-tagged.
  assert.equal((receipt.document.questions.find(q => q.number === 2) as any)?.difficulty?.value, 2);
});

test('#51 Fix batches by section; hints join existing batches only; changedQuestionNumbers ignores Check tags', () => {
  const doc = normalizeAuthoredDocument({ questions: [
    ...[1, 2, 3].map(n => ({ ...goodQuestion(n), sectionTitle: 'A' })), ...[4, 5, 6].map(n => ({ ...goodQuestion(n), sectionTitle: 'B' })), { ...goodQuestion(7), sectionTitle: 'C' },
  ] });
  const v = (id: string, n: number[], extra: Partial<LoopVerdict> = {}): LoopVerdict => ({ id, kind: 'empty-stem', questionNumbers: n, source: 'code', message: id, ...extra });
  const sectionOf = (n: number) => doc.questions.find(q => q.number === n)!.sectionTitle!;
  const batches = batchVerdictsBySection(doc, [v('a1', [1]), v('b5', [5]), v('meta', [], { kind: 'meta-field-implausible' })],
    [v('h2', [2], { source: 'decision', hint: true }), v('h7', [7], { source: 'decision', hint: true })], sectionOf);
  assert.deepEqual(batches.map(b => b.section), ['A', 'B']);
  assert.deepEqual(batches[0].verdicts.map(x => x.id), ['a1', 'meta']);
  assert.deepEqual(batches[0].hints.map(x => x.id), ['h2']);
  assert.ok(!batches.some(b => b.hints.some(h => h.id === 'h7')), 'a hint-only section gets no call');
  const tagged = structuredClone(doc); tagged.questions[0].difficulty = { value: 3, source: 'model' } as any;
  assert.deepEqual(changedQuestionNumbers(doc, tagged), []);
  tagged.questions[1].stem = 'changed'; tagged.questions.pop();
  assert.deepEqual(changedQuestionNumbers(doc, tagged), [2, 7]);
});

// ── 4. Visual map audit ─────────────────────────────────────────────────────────────────────────
const vLines: SourceLine[] = [line(1, 'Science Quiz'), line(2, 'Part A: Pictures'), line(3, '1. Look at the picture.'), line(4, '2. Name the animal.'), line(5, '3. Count the legs.'),
  line(6, 'Part B: Reading', 2), line(7, 'Once upon a time there was a long passage about a fox.', 2), line(8, '4. Who is the story about?', 2), line(9, '5. Where did the fox go?', 2), line(10, '6. Why?', 2)];
const vImages: ImageAsset[] = [{ id: 'img_1', page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: 's1', width: 10, height: 10 } as ImageAsset];
const vMap = { meta: {}, sectionCount: 2, sections: [{ title: 'Pictures', firstQuestion: 1, lastQuestion: 3, questionCount: 3, kind: 'other' }, { title: 'Reading', firstQuestion: 4, lastQuestion: 6, questionCount: 3, kind: 'reading' }],
  instructionGroupCount: 0, instructionGroups: [], passageCount: 1, passages: [{ id: 'p1', sectionTitle: 'Reading', appliesToFirst: 4, appliesToLast: 6, text: 'Once upon a time there was a long passage about a fox.' }],
  imageCount: 1, images: [{ imageId: 'img_1', sectionTitle: 'Pictures', aboutQuestion: 1 }] };
const noCache = { cacheGet: async <T,>() => undefined as T | undefined, cacheSet: async () => {}, cacheKey: async (text: string) => text };
const pageImage = (pages: number[]) => async (page: number) => { pages.push(page); return { id: `page-${page}`, mime: 'image/png', data: Buffer.from(`page${page}`).toString('base64') }; };
function vCall(calls: Array<{ label: string; text: string }>) {
  return async (label: string, _system: string, text: string) => {
    calls.push({ label, text });
    if (label.startsWith('Map')) return { rawText: JSON.stringify(vMap) };
    if (label.startsWith('Re-map')) return { rawText: JSON.stringify(JSON.parse(text.split('\n')[0].replace(/^ENTRY [^:]+: /, ''))) };
    const title = label.split(' · ')[1];
    return { rawText: JSON.stringify({ questions: (title === 'Pictures' ? [1, 2, 3] : [4, 5, 6]).map(n => ({ number: n, type: 'short', stem: `Q${n}`, options: [], imageIds: [] })) }) };
  };
}
const isVisual = (body: any) => Boolean(body.images) || Boolean(body.questions?.[0]?.images);

test('#51 visual: page of each claim comes from text evidence; four items for two sections + one picture page + one passage', () => {
  const parsed = { ...vMap, sections: vMap.sections.map(s => ({ ...s, status: 'counted' })), passages: vMap.passages.map(p => ({ ...p, status: 'counted' })), images: vMap.images.map(i => ({ ...i, status: 'counted' })) } as any;
  const items = visualMapItems(parsed, vLines, vImages);
  assert.deepEqual(items.map(i => `${i.kind}@${i.page}:${i.entryIds.join('+')}`), ['section-start-visible@1:section:0', 'section-start-visible@2:section:1', 'pictures-present@1:image:0', 'passage-visible@2:passage:0']);
  assert.equal(items[0].claim, "The map claims a section titled 'Pictures' begins on this page (question 1).");
});

test('#51 visual: every visual item carries exactly ONE page-image payload (THX data URL and JEV object)', async () => {
  for (const dialect of ['thx', 'jev'] as const) {
    const bodies: any[] = []; const pages: number[] = [];
    const decisionCaller = async (body: any) => { bodies.push(body); return dialect === 'thx'
      ? { results: [{ name: Object.keys(body.questions)[0], probability: 0.95, ...(Object.values(body.questions as any)[0] as any).criteria ? { choice: 'Pictures' } : {} }] }
      : { results: body.questions.map((q: any) => ({ name: q.name, probability: 0.95, ...(q.choices ? { choice: q.choices[0] } : {}) })) }; };
    const result = await runMapFirstRead({ lines: vLines, images: vImages, settings: settings('active', { decideMultimodal: true }, dialect), fileHash: `vis-${dialect}`, ...noCache, call: vCall([]), decisionCaller, pageImage: pageImage(pages) });
    const visual = bodies.filter(isVisual);
    assert.equal(visual.length, 4, dialect);
    for (const body of visual) {
      if (dialect === 'thx') { assert.equal(body.images.length, 1); assert.match(body.images[0], /^data:image\/png;base64,/); assert.equal(Object.keys(body.questions).length, 1); }
      else { assert.equal(body.questions.length, 1); assert.equal(body.questions[0].images.length, 1); assert.equal(body.questions[0].images[0].mime, 'image/png'); }
    }
    assert.ok(bodies.filter(b => !isVisual(b)).length > 0, 'text items still voted');
    assert.deepEqual(pages, [1, 2, 1, 2]);
    assert.deepEqual(result!.map.visualAudit, { items: 4, voted: 4, skipped: 0 });
    assert.equal(result!.map.auditVotes.filter(v => v.visual).length, 4);
  }
});

test('#51 visual: a confident-wrong visual vote indicts like a text vote — scoped re-map of that entry only; uncertain and shadow never re-map', async () => {
  const thxCaller = (p: (name: string) => number) => async (body: any) => {
    const [name, q] = Object.entries(body.questions)[0] as [string, any];
    return { results: [{ name, probability: body.images ? p(name) : 0.95, ...(q.criteria ? { choice: name.startsWith('section:1') ? 'Reading' : 'Pictures' } : {}) }] };
  };
  const calls: Array<{ label: string; text: string }> = [];
  const active = await runMapFirstRead({ lines: vLines, images: vImages, settings: settings('active', { decideMultimodal: true }), fileHash: 'vis-indict', ...noCache, call: vCall(calls),
    decisionCaller: thxCaller(name => name === 'section:1 section-start-visible' ? 0.05 : 0.95), pageImage: pageImage([]) });
  const remaps = calls.filter(c => c.label.startsWith('Re-map'));
  assert.deepEqual(remaps.map(c => c.label), ['Re-map · section:1']);
  assert.match(remaps[0].text, /section-start-visible p=0\.05 \(seen on the page image\)/);
  assert.ok(active!.map.auditVotes.some(v => v.visual && v.entryId === 'section:1' && v.indicted));
  assert.equal(active!.map.sections[1].status, 'disputed', 'an unchanged re-map cannot answer the visual indictment');
  assert.equal(active!.document.questions.length, 6, 'parsing continues');
  for (const [mode, p] of [['active', 0.5], ['shadow', 0.05]] as const) {
    const quiet: Array<{ label: string; text: string }> = [];
    const result = await runMapFirstRead({ lines: vLines, images: vImages, settings: settings(mode, { decideMultimodal: true }), fileHash: `vis-${mode}`, ...noCache, call: vCall(quiet),
      decisionCaller: thxCaller(name => name === 'section:1 section-start-visible' ? p : 0.95), pageImage: pageImage([]) });
    assert.equal(quiet.filter(c => c.label.startsWith('Re-map')).length, 0, `${mode} p=${p}`);
    assert.ok(result!.map.auditVotes.some(v => v.visual && v.entryId === 'section:1' && !v.indicted));
  }
});

test('#51 visual: an image-erroring endpoint skips and counts the visual items; text verdicts still land', async () => {
  let visualAttempts = 0;
  const decisionCaller = async (body: any) => {
    if (body.images) { visualAttempts++; throw new Error('Decisions endpoint HTTP 500: image input is not supported'); }
    const [name, q] = Object.entries(body.questions)[0] as [string, any];
    return { results: [{ name, probability: 0.95, ...(q.criteria ? { choice: 'Pictures' } : {}) }] };
  };
  const result = await runMapFirstRead({ lines: vLines, images: vImages, settings: settings('active', { decideMultimodal: true }), fileHash: 'vis-err', ...noCache, call: vCall([]), decisionCaller, pageImage: pageImage([]) });
  const map = result!.map;
  assert.deepEqual(map.visualAudit, { items: 4, voted: 0, skipped: 4 });
  assert.equal(visualAttempts, 3, 'short-circuit after 3 consecutive image errors; the 4th is skipped without a call');
  assert.equal(map.auditVotes.filter(v => v.visual).length, 0);
  assert.equal(map.auditVotes.filter(v => !v.visual).length, 7, '3 per section × 2 + passage scope');
  assert.ok(map.notes.some(n => /Visual map audit: 1 remaining item\(s\) skipped after 3 consecutive image errors; text votes stand/.test(n)), map.notes.join('\n'));
  assert.equal(result!.document.questions.length, 6);
});

test('#51 visual: a non-multimodal provider gets zero visual items, no page images and no errors', async () => {
  const bodies: any[] = []; const pages: number[] = [];
  const decisionCaller = async (body: any) => { bodies.push(body); const [name, q] = Object.entries(body.questions)[0] as [string, any]; return { results: [{ name, probability: 0.95, ...(q.criteria ? { choice: 'Pictures' } : {}) }] }; };
  const result = await runMapFirstRead({ lines: vLines, images: vImages, settings: settings('active', { decideMultimodal: false }), fileHash: 'vis-off', ...noCache, call: vCall([]), decisionCaller, pageImage: pageImage(pages) });
  assert.equal(bodies.filter(isVisual).length, 0);
  assert.deepEqual(pages, []);
  assert.equal(result!.map.visualAudit, undefined);
  assert.equal(result!.map.auditErrors, 0);
  assert.ok(!result!.map.notes.some(n => /visual/i.test(n)));
});

test('#51 visual wiring: runLocalLoop passes the page image through to the Map phase; THX image-belongs now carries pixels', async () => {
  const bodies: any[] = [];
  const caller = async (req: LoopModelRequest) => {
    if (req.step === 'fix') return { rawText: '{"corrections":[]}' };
    return vCall([])(req.label, req.system, req.text);
  };
  const receipt = await runLocalLoop({ lines: vLines, images: vImages, settings: settings('active', { decideMultimodal: true }), fileHash: 'vis-loop', caller,
    decisionCaller: async body => { bodies.push(body); const [name, q] = Object.entries(body.questions)[0] as [string, any]; return { results: [{ name, probability: 0.95, ...(q.type === 'score' ? { choice: '2' } : q.criteria ? { choice: Object.keys(q.criteria)[0] } : {}) }] }; },
    pageImage: pageImage([]) });
  assert.equal(receipt.map?.visualAudit?.items, 4);
  const item = { id: 'image-img_1::image-belongs', type: 'image-belongs', name: 'Image img_1 image-belongs', instructions: 'x', questionNumbers: [1], choices: ['this question', 'no question'], images: [{ id: 'img_1', mime: 'image/png', data: 'AAAA' }], input: {} } as any;
  assert.deepEqual(buildThxDecisionBody(item, 'm', 'state').images, ['data:image/png;base64,AAAA']);
  // The thin server proxy accepts (and bounds) THX data-URL images.
  const base = { providerConfig: { kind: 'openai-compatible', model: 'm', baseURL: 'http://localhost:8080', decideDialect: 'thx' }, body: { state: 's', questions: { a: { type: 'noul', instructions: 'x' } } } };
  assert.equal(validateDecisionsRequest({ ...base, body: { ...base.body, images: ['data:image/png;base64,AAAA'] } }), null);
  assert.match(String(validateDecisionsRequest({ ...base, body: { ...base.body, images: ['https://example.com/x.png'] } })), /invalid/);
  assert.match(String(validateDecisionsRequest({ ...base, body: { ...base.body, images: Array(9).fill('data:image/png;base64,AAAA') } })), /8-image/);
});

// ── 6. UI / receipt ─────────────────────────────────────────────────────────────────────────────
const outlineMap = (): LoopMapReceipt => ({ meta: {}, sections: [{ title: 'Pictures', firstQuestion: 1, lastQuestion: 3, questionCount: 3, kind: 'other', status: 'audited' }, { title: 'Reading', firstQuestion: 4, lastQuestion: 6, questionCount: 3, kind: 'reading', status: 'disputed' }],
  instructionGroups: [], passages: [{ id: 'p1', sectionTitle: 'Reading', appliesToFirst: 4, appliesToLast: 6, text: 'Once upon a time', status: 'counted' }], images: [],
  codeVerdicts: [], auditVotes: [{ entryId: 'section:0', kind: 'section-start-visible', probability: 0.93, indicted: false, visual: true }, { entryId: 'section:1', kind: 'section-start-visible', probability: 0.05, indicted: true, visual: true }, { entryId: 'section:1', kind: 'section-boundary', probability: 0.9, indicted: false }],
  remaps: [], agreement: { agree: 2, disagree: 1, uncertain: 0 }, auditCalls: 3, auditErrors: 0, auditUsage: { inputTokens: 0, outputTokens: 0 }, visualAudit: { items: 2, voted: 2, skipped: 0 },
  phase: 'completed', parsedSections: 2, totalSections: 2, notes: [] });

test('#51 UI: Step 3 shows exactly the six phases (names = receipt names) with the map outline and seen markers before Parse', () => {
  const stages = initialLoopStages(settings('active', { decideMultimodal: true }));
  assert.deepEqual(stages.map(s => s.id), [...LOOP_PHASES]);
  assert.deepEqual(stages.map(s => s.name), LOOP_PHASES.map(p => LOOP_PHASE_NAMES[p]));
  const html = renderToStaticMarkup(React.createElement(LoopPhaseList, { stages, map: outlineMap() }));
  const at = (needle: string) => html.indexOf(needle);
  assert.ok(at('data-loop-stage="map"') < at('data-testid="map-outline"') && at('data-testid="map-outline"') < at('data-loop-stage="parse"'), 'outline sits between Map and Parse');
  assert.match(html, /seen ✓/); assert.match(html, /seen ✗/); assert.match(html, /text only/);
  assert.doesNotMatch(html, /Self-review|Final fix|Code-verdict/);
  // No visual audit → no markers at all (the legacy outline is unchanged).
  const plain = renderToStaticMarkup(React.createElement(MapOutline, { map: { ...outlineMap(), visualAudit: undefined, auditVotes: [] } }));
  assert.doesNotMatch(plain, /seen|text only/);
});

test('#51 receipt: phase rows mirror the UI 1:1 with calls/raised/closed/carried/patches; legacy v1 receipts still parse and render', async () => {
  const log: string[] = [];
  const receipt = await runLocalLoop({ lines: exam(6), images: [], settings: settings('active'), fileHash: 'receipt', caller: generative(6, [2], [4], log, []), decisionCaller: referee(log) });
  const html = renderToStaticMarkup(React.createElement(LoopReceipt, { receipt }));
  assert.match(html, /Loop receipt — six phases/);
  const rows = [...html.matchAll(/data-loop-step="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(rows, [...LOOP_PHASES]);
  assert.match(html, /Patches applied/); assert.match(html, /Verdicts carried/); assert.match(html, /data-testid="loop-recheck"/);
  const check = receipt.steps.find(s => s.step === 'check')!; const fix = receipt.steps.find(s => s.step === 'fix')!; const present = receipt.steps.find(s => s.step === 'present')!;
  assert.equal(check.verdictsRaised, receipt.mergedVerdicts!.length);
  assert.equal(fix.calls, 1); assert.equal(fix.correctionsApplied, 2);
  assert.equal(present.verdictsCarried! + present.verdictsClosed, receipt.mergedVerdicts!.length);
  // Legacy: a pre-#51 receipt with the old six step ids still renders and feeds attention.
  const legacy = { ...structuredClone(receipt), version: 'local-loop-v1', mergedVerdicts: undefined, recheck: undefined, timeline: undefined,
    steps: ['read', 'self-review', 'code-check', 'code-fix', 'decision-audit', 'final-fix'].map((step, i) => ({ step, name: ['Read', 'Self-review', 'Code check', 'Code-verdict fix', 'Decision audit', 'Final fix'][i], status: 'completed', calls: 1, correctionsApplied: 0, verdictsRaised: 0, verdictsClosed: 0, notes: [], inputTokens: 0, outputTokens: 0 })) } as unknown as Receipt;
  const legacyHtml = renderToStaticMarkup(React.createElement(LoopReceipt, { receipt: legacy }));
  assert.match(legacyHtml, /legacy receipt/); assert.match(legacyHtml, /Self-review/);
  const doc = { id: 'x', questions: [], sections: [], images: [], flags: [], meta: {}, loop: legacy } as unknown as ExamDoc;
  assert.ok(Array.isArray(computeAttention(doc)));
  const reparsed = JSON.parse(JSON.stringify(legacy)) as Receipt;
  assert.equal(reparsed.steps[1].step, 'self-review');
});

test('#51 attention: a surviving decision-only verdict reads as a plain sentence, not the raw prompt', async () => {
  const log: string[] = [];
  const receipt = await runLocalLoop({ lines: exam(6), images: [], settings: settings('shadow'), fileHash: 'plain', caller: generative(6, [], [4], log, []), decisionCaller: referee(log) });
  const doc = { id: 'x', questions: [{ id: 'q4', no: 4 }], sections: [], images: [], flags: [], meta: {}, loop: receipt } as unknown as ExamDoc;
  const item = computeAttention(doc).find(i => i.id === 'decision:Q4::stem-faithful');
  assert.ok(item, JSON.stringify(computeAttention(doc).map(i => i.id)));
  assert.match(item!.plainSentence, /^The audit judges Q4 likely not faithful to the printed stem \(sound p=0\.05\)\./);
});
