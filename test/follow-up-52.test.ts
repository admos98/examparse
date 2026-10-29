/** #52: measured question shapes, blind comparison and evidence conservation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/store';
import type { AppSettings, ImageAsset, SourceLine } from '../src/types';
import { normalizeAuthoredDocument } from '../src/pipeline/localLoop';
import { buildLoopDecisionCatalogue, buildLoopDecisionState, buildThxDecisionBody, runLoopDecisionAudit } from '../src/pipeline/loopAudit';

const settings: AppSettings = { ...DEFAULT_SETTINGS, decideMode: 'active', decideMultimodal: true,
  thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false },
  providers: [{ id: 'd', name: 'judge', kind: 'openai-compatible', baseURL: 'http://localhost:8080', apiKey: '', decideDialect: 'thx' }],
  roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId: 'd', model: 'local' } } };
const lines: SourceLine[] = [{ id: 'L0001', page: 1, text: '1. What does a dictionary help you find? a) meanings b) weather' },
  { id: 'L0002', page: 1, text: 'Answer: (a)', tag: 'key' }];
const document = () => normalizeAuthoredDocument({ questions: [{ number: 1, type: 'mcq', stem: 'What does a dictionary help you find?',
  options: [{ key: 'a', text: 'meanings' }, { key: 'b', text: 'weather' }], answer: 'meanings', rationale: 'SECRET_KEY_RATIONALE', imageIds: [] }] });
const image = { id: 'dictionary', page: 1, label: { caption: 'dictionary' } } as ImageAsset;
const payload = { id: 'dictionary', mime: 'image/png', data: 'pixels' };

test('#52 blind answer choices contain full options but no marked answer, extensions, or key source', () => {
  const doc = document();
  for (const item of buildLoopDecisionCatalogue({ document: doc, lines, images: [] }).filter(i => i.type.startsWith('answer-'))) {
    assert.deepEqual(item.choices, ['a', 'b']);
    assert.equal(item.expectedChoice, 'a', 'text key uses existing option normalization');
    const body = buildThxDecisionBody(item, 'local', buildLoopDecisionState(item));
    assert.deepEqual(body.questions[item.name].criteria, { a: 'meanings', b: 'weather' });
    assert.doesNotMatch(JSON.stringify(body), /"answer"|Answer:|SECRET_KEY_RATIONALE|expectedChoice/);
    assert.match(body.state, /meanings/); assert.match(body.state, /weather/);
  }
  delete doc.questions[0].answer;
  assert.equal(buildLoopDecisionCatalogue({ document: doc, lines, images: [] }).filter(i => i.type.startsWith('answer-')).length, 0);
});

for (const [label, choice, p, distribution, expected] of [
  ['agree', 'a', .55, undefined, 1], ['disagree boundary', 'b', .5, undefined, 0],
  ['disagree', 'b', .99, undefined, 0], ['weak', 'b', .49, undefined, .5],
  ['flat', 'a', .5, { a: .5, b: .5 }, .5], ['missing choice', undefined, .99, undefined, .5],
] as const) test(`#52 blind routing: ${label}`, async () => {
  const result = await runLoopDecisionAudit({ document: document(), lines, images: [], settings, fileHash: label,
    decisionCaller: async body => {
      const name = Object.keys(body.questions)[0];
      return { results: [{ name, probability: name.includes('answer-') ? p : .95,
        ...(name.includes('answer-') ? { choice, distribution } : name.includes('difficulty') ? { choice: '2' } : {}) }] };
    } });
  const verdicts = result.verdicts.filter(v => v.kind.startsWith('answer-'));
  assert.equal(verdicts.length, 2); assert.ok(verdicts.every(v => v.probability === expected));
  assert.equal(result.routed.filter(v => v.kind.startsWith('answer-')).length, expected === 0 ? 2 : 0);
});

test('#52 all catalogue nouls are single positive claims (no coordinating conjunction)', () => {
  const doc = document(); doc.questions.push({ ...doc.questions[0], number: 2, options: [], type: 'short', answer: 'a useful book' });
  const items = buildLoopDecisionCatalogue({ document: doc, lines, images: [image] });
  for (const item of items.filter(i => !i.choices)) {
    assert.doesNotMatch(item.instructions, /\b(and|or|including|if)\b/i, item.instructions);
    assert.equal((item.instructions.match(/[.!?](?:\s|$)/g) || []).length, 1, item.instructions);
  }
});

test('#52 absent pixels skips image verdicts without a call or a vote', async () => {
  let imageCalls = 0; const progress: any[] = [];
  const result = await runLoopDecisionAudit({ document: normalizeAuthoredDocument({ questions: [] }), lines, images: [image], settings, fileHash: 'pixels',
    onProgress: p => progress.push(p), decisionCaller: async () => { imageCalls++; throw new Error('must not run'); } });
  assert.equal(imageCalls, 0); assert.equal(result.calls, 0); assert.equal(result.votes.size, 0);
  assert.equal(result.skippedNoEvidence, 1); assert.equal(progress.at(-1).skippedNoEvidence, 1);
  assert.match(result.notes.join(' '), /image not judged — no pixels/);
});

test('#52 passage and listening content are unverifiable without evidence, not votes', async () => {
  const doc = document(); doc.questions[0].passageId = 'missing'; doc.questions[0].sectionTitle = 'Listening';
  const catalogue = buildLoopDecisionCatalogue({ document: doc, lines, images: [] });
  for (const item of catalogue.filter(i => ['answer-correct', 'answer-letter', 'difficulty', 'complete'].includes(i.type))) assert.ok(item.skippedNoEvidence);
  delete doc.questions[0].passageId;
  assert.match(buildLoopDecisionCatalogue({ document: doc, lines, images: [] }).find(i => i.type === 'answer-correct')!.skippedNoEvidence!, /unverifiable for teacher/);
  let forbidden = 0;
  const result = await runLoopDecisionAudit({ document: doc, lines, images: [], settings, fileHash: 'listen', decisionCaller: async body => {
    const name = Object.keys(body.questions)[0]; if (/answer-|difficulty|complete/.test(name)) forbidden++;
    return { results: [{ name, probability: .95 }] };
  } });
  assert.equal(forbidden, 0); assert.ok(result.skippedNoEvidence >= 4);
});

test('#52 long records preserve full T/F statement and explicit passage; source is middle-elided', () => {
  const statement = 'FINAL TRUE/FALSE STATEMENT: the traveller arrived on Tuesday.';
  const doc = document(); doc.questions[0].stem = statement; doc.questions[0].passageId = 'p1';
  doc.passages = [{ id: 'p1', sectionTitle: 'Reading', text: `START ${'passage '.repeat(1600)} END`, appliesToFirst: 1, appliesToLast: 1 }];
  const source = [{ id: 'L0001', page: 1, text: `SOURCE START ${'background '.repeat(4000)} ${statement}` }];
  const catalogue = buildLoopDecisionCatalogue({ document: doc, lines: source, images: [] });
  const state = buildLoopDecisionState(catalogue.find(i => i.type === 'answer-correct')!);
  assert.match(state, /\[…\]/); assert.ok(state.includes(statement)); assert.ok(state.includes(doc.passages[0].text));
  const difficulty = catalogue.find(i => i.type === 'difficulty')!;
  assert.equal(difficulty.input.sourcePageText, 'PAGE 1\n' + source[0].text);
});

for (const [label, ownerChoice, sentenceChoice, expected] of [
  ['agree', 'this question', 'a', .99], ['conflict', 'this question', 'b', .5], ['reverse conflict', 'no question', 'a', .5],
] as const) test(`#52 thematic image matching: ${label}`, async () => {
  const doc = document(); doc.questions[0].imageIds = [image.id];
  const calls: any[] = [];
  const result = await runLoopDecisionAudit({ document: doc, lines, images: [image], settings, fileHash: label, imagePayload: async () => payload,
    decisionCaller: async body => {
      const name = Object.keys(body.questions)[0]; calls.push(body);
      return { results: [{ name, probability: name.endsWith('sentences') ? .99 : .97,
        choice: name.includes('image-belongs') ? name.endsWith('sentences') ? sentenceChoice : ownerChoice : name.includes('answer-') ? 'a' : name.includes('difficulty') ? '2' : undefined }] };
    } });
  const ownership = calls.find(b => Object.keys(b.questions)[0] === 'Image dictionary image-belongs');
  assert.match(ownership.questions['Image dictionary image-belongs'].instructions, /a typical illustrative scene counts as a match/);
  assert.equal(calls.filter(b => Object.keys(b.questions)[0].includes('image-belongs')).length, 2);
  assert.ok(calls.filter(b => Object.keys(b.questions)[0].includes('image-belongs')).every(b => b.images[0].includes('pixels')));
  assert.equal(result.verdicts.find(v => v.kind === 'image-belongs')!.probability, expected);
  assert.equal(result.routed.filter(v => v.kind === 'image-belongs').length, 0);
});

test('#52 fillblank answer is one affirmative clause with source evidence', () => {
  const doc = document(); doc.questions[0].type = 'fillblank'; doc.questions[0].options = []; doc.questions[0].answer = 'century';
  const item = buildLoopDecisionCatalogue({ document: doc, lines, images: [] }).find(i => i.type === 'answer-correct')!;
  assert.equal(item.instructions, "The answer 'century' is a correct answer to this question.");
  assert.ok(item.input.sourcePageText); assert.equal(item.choices, undefined);
});

// Planted AFTER Parse/compile: exact duplicate emissions are intentionally deduped by #50.
import { calibrationReport, calibrationRun, scriptedCalibrationJudge } from '../scripts/calibrate-decide';
import { CALIBRATION_CORRUPTIONS, expectedKind } from './fixtures/calibration-exam';
import { calibrationSummary, parseDecisionCalibrationReport } from '../src/pipeline/decisionCalibration';
import { LLMAdapter } from '../src/providers/adapter';
import { checkAuthoredDocument } from '../src/pipeline/localLoop';

for (const kind of CALIBRATION_CORRUPTIONS) test(`#52 calibration: ${kind} routes its indictment into Fix batches`, async () => {
  const run = await calibrationRun(kind);
  const expected = expectedKind[kind];
  assert.ok(run.fixVerdicts.some(v => v.kind === expected || v.merged?.some(m => m.kind === expected)), JSON.stringify(run.fixVerdicts));
  if (['truncate-stem', 'delete-question', 'duplicate-question', 'flatten-points'].includes(kind)) {
    assert.ok(run.receipt.codeVerdicts.some(v => v.kind === expected));
    assert.equal(run.receipt.auditVerdicts.filter(v => (v.probability ?? 1) <= .2).length, 0, 'code defects never get duplicate judge indictments');
    if (kind === 'truncate-stem') assert.equal(run.catalogueVotes.has('Q5::stem-faithful'), false);
    if (kind === 'flatten-points') assert.equal([...run.catalogueVotes.keys()].some(id => id.endsWith('points-plausible')), false);
  }
});

test('#52 calibration controls: zero confident indictments; report is explicitly scripted, never promotion evidence', async () => {
  const control = await calibrationRun('control'); assert.equal(control.fixVerdicts.length, 0);
  const report = await calibrationReport();
  assert.deepEqual(report.counts, { catches: 7, planted: 7, falseAlarms: 0, clean: 67 });
  assert.equal(report.mode, 'scripted'); assert.equal(report.endpointErrors, 0);
  assert.ok(parseDecisionCalibrationReport(JSON.parse(JSON.stringify(report))));
  assert.match(calibrationSummary(report, report.model, report.endpointHost, 'thx'), /No live calibration/);
  report.mode = 'live';
  assert.match(calibrationSummary(report, report.model, report.endpointHost, 'thx'), /catches 7\/7 planted errors, false indictments 0\/67/);
  assert.match(calibrationSummary(report, 'different-model', report.endpointHost, 'thx'), /No live calibration/);
  assert.match(calibrationSummary(report, report.model, 'different-host', 'thx'), /No live calibration/);
  assert.match(calibrationSummary(report, report.model, report.endpointHost, 'jev'), /No live calibration/);
  assert.throws(() => parseDecisionCalibrationReport({ ...report, counts: { catches: 9, planted: 7 } }), /Invalid/);
});

test('#52 THX chooses argmax rather than answer string and retains flat evidence', () => {
  const body = { questions: { blind: { type: 'choice', criteria: { a: 'first', b: 'second' } } } };
  const decoded = LLMAdapter.parseDecisionResponse(settings.providers[0], body, { answers: { blind: { answer: 'a', probabilities: { a: .2, b: .8 } } } });
  assert.deepEqual(decoded.results, [{ name: 'blind', probability: .8, choice: 'b', distribution: { a: .2, b: .8 } }]);
});

test('#52 passage in declared scope is in the record even without an authored passageId', () => {
  const doc = document(); doc.passages = [{ id: 'p1', sectionTitle: 'Reading', appliesToFirst: 1, appliesToLast: 1, text: 'The traveller arrived Tuesday.' }];
  const record = buildLoopDecisionCatalogue({ document: doc, lines, images: [] }).find(i => i.type === 'answer-correct')!;
  assert.equal(record.input.passageText, doc.passages[0].text);
});

test('#52 code prefix check does not confuse a complete short stem with truncation', () => {
  const doc = document();
  assert.equal(checkAuthoredDocument(doc, [], [], lines).filter(v => v.kind === 'empty-stem').length, 0);
});

test('#52 actual source question in the middle of a long page is indispensable, not elided', () => {
  const doc = document();
  const source: SourceLine[] = [{ id: 'L0001', page: 1, text: 'background '.repeat(1800) },
    { id: 'L0002', page: 1, text: '1. SOURCE QUESTION IN THE MIDDLE: What does a dictionary help you find?' },
    { id: 'L0003', page: 1, text: 'a) meanings b) weather' },
    { id: 'L0004', page: 1, text: '2. ' + 'background '.repeat(1800) }];
  const item = buildLoopDecisionCatalogue({ document: doc, lines: source, images: [] }).find(i => i.type === 'answer-correct')!;
  const state = buildLoopDecisionState(item);
  assert.match(state, /SOURCE QUESTION IN THE MIDDLE/); assert.match(state, /\[…\]/);
  assert.match(state, /a\) meanings b\) weather/);
});

test('#52 printed listening script stays in the record and enables content judgments', () => {
  const doc = document(); doc.questions[0].sectionTitle = 'Listening';
  const source = [...lines, { id: 'L0003', page: 2, text: 'Listening script: The bus arrives at noon.' }];
  const item = buildLoopDecisionCatalogue({ document: doc, lines: source, images: [] }).find(i => i.type === 'answer-correct')!;
  assert.equal(item.skippedNoEvidence, undefined);
  assert.match(buildLoopDecisionState(item), /The bus arrives at noon/);
});

import { runMapFirstRead } from '../src/pipeline/mapFirst';
for (const [label, choice, distribution, expected] of [
  ['agree', 'passage-1', undefined, 1], ['disagree', 'none', undefined, 0],
  ['flat', 'passage-1', { 'passage-1': .5, none: .5 }, .5],
] as const) test(`#52 map passage-scope is a blind passage choice: ${label}`, async () => {
  const bodies: any[] = [];
  const result = await runMapFirstRead({ lines: [{ id: 'L0001', page: 1, text: '1. What time did she arrive?' }], images: [], settings: { ...settings, decideMode: 'shadow' }, fileHash: 'passage', cacheGet: async () => undefined, cacheSet: async () => {}, cacheKey: async text => text,
    call: async label => ({ rawText: JSON.stringify(label.startsWith('Map') ? { sectionCount: 1, sections: [{ title: 'Reading', firstQuestion: 1, lastQuestion: 1, questionCount: 1, kind: 'reading' }],
      passageCount: 1, passages: [{ id: 'secret-owned-passage', sectionTitle: 'Reading', text: 'She arrived at noon.', appliesToFirst: 1, appliesToLast: 1 }], instructionGroupCount: 0, instructionGroups: [], imageCount: 0, images: [] } : { questionCount: 1, questions: [{ number: 1, type: 'short', stem: 'What time did she arrive?', passageId: 'secret-owned-passage' }] }) }),
    decisionCaller: async body => {
      bodies.push(body); const name = Object.keys(body.questions)[0];
      return { results: [{ name, probability: distribution ? .5 : .95, choice: name.includes('passage-scope') ? choice : 'Reading', distribution: name.includes('passage-scope') ? distribution : undefined }] };
    } });
  const body = bodies.find(b => Object.keys(b.questions)[0].includes('passage-scope'));
  assert.deepEqual(body.questions['passage:0 passage-scope'].criteria, { 'passage-1': 'She arrived at noon.', none: 'None of these passages' });
  assert.doesNotMatch(body.state, /secret-owned-passage/);
  assert.equal(result!.map.auditVotes.find(v => v.kind === 'passage-scope')!.probability, expected);
});

test('#52 JEV blind records compare options in code; shadow never routes disagreement', async () => {
  for (const mode of ['shadow', 'active'] as const) {
    const s = { ...settings, decideMode: mode, providers: [{ ...settings.providers[0], decideDialect: 'jev' as const }] };
    const bodies: any[] = [];
    const result = await runLoopDecisionAudit({ document: document(), lines, images: [], settings: s, fileHash: mode,
      decisionCaller: async body => { bodies.push(body); return { results: body.questions.map((q: any) => ({ name: q.name, probability: .75,
        choice: q.name.includes('answer-') ? 'b' : q.name.includes('difficulty') ? '2' : undefined })) }; } });
    const answers = bodies.flatMap(b => b.questions).filter(q => q.name.includes('answer-'));
    assert.equal(answers.length, 2);
    for (const q of answers) {
      assert.deepEqual(q.choices, ['a', 'b']); assert.deepEqual(q.choiceDescriptions, { a: 'meanings', b: 'weather' });
      assert.doesNotMatch(JSON.stringify(q), /"answer"|Answer:|SECRET_KEY_RATIONALE|expectedChoice/);
    }
    assert.equal(result.verdicts.filter(v => v.kind.startsWith('answer-') && v.probability === 0).length, 2);
    assert.equal(result.routed.length, mode === 'active' ? 2 : 0);
  }
});

test('#52 malformed responses remain counted as uncertain, not skipped evidence or confident catches', async () => {
  const result = await runLoopDecisionAudit({ document: document(), lines, images: [], settings, fileHash: 'unusable',
    decisionCaller: async () => ({ results: [] }) });
  assert.equal(result.verdicts.length, 0); assert.equal(result.routed.length, 0);
  assert.equal(result.skippedNoEvidence, 0); assert.equal(result.uncertain, 9);
});
