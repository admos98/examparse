import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMAdapter } from '../src/providers/adapter';
import { runLoopDecisionAudit, type LoopAuditProgress } from '../src/pipeline/loopAudit';
import { normalizeAuthoredDocument } from '../src/pipeline/localLoop';
import { runLocalLoop } from '../src/pipeline/localLoopRunner';
import { DEFAULT_SETTINGS } from '../src/store';

const provider = { id: 'llama', name: 'llama', kind: 'openai-compatible' as const, baseURL: 'http://localhost:8080/v1', apiKey: '', decideDialect: 'thx' as const, model: 'local' };
const settings = { ...DEFAULT_SETTINGS, providers: [provider], roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId: 'llama', model: 'local' } }, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false } };
const doc = () => normalizeAuthoredDocument({ questions: [{ number: 1, type: 'short', stem: 'A question?', options: [] }] });

test('THX parses the systemone answers envelope and retains existing fallbacks', async () => {
  const old = globalThis.fetch;
  // Representative envelope based on the reported shape, not an actual captured response.
  let data: any = { model: 'redacted', answers: { 'Q1 complete': { answer: 'yes', probabilities: { yes: 0.87, no: 0.13 } } }, usage: { prompt_tokens: 42, completion_tokens: 2 } };
  globalThis.fetch = (async () => ({ ok: true, json: async () => data })) as any;
  try {
    const run = (name: string, question: any) => LLMAdapter.executeDecisions({ providerConfig: provider, body: { state: 'Q', questions: { [name]: question } } as any });
    assert.deepEqual((await run('Q1 complete', { type: 'noul' })).results, [{ name: 'Q1 complete', probability: .87 }]);
    data.answers = { 'Q1 choice': { answer: 'b', probabilities: { a: .2, b: .8 } } };
    assert.deepEqual((await run('Q1 choice', { type: 'choice', criteria: { a: 'a', b: 'b' } })).results, [{ name: 'Q1 choice', probability: .8, choice: 'b' }]);
    data.answers['Q1 choice'] = { probabilities: { a: .9, b: .1 } };
    assert.deepEqual((await run('Q1 choice', { type: 'choice', criteria: { a: 'a', b: 'b' } })).results, [{ name: 'Q1 choice', probability: .9, choice: 'a' }]);
    data.answers = { 'Q1 complete': { probability: .6 } };
    assert.equal((await run('Q1 complete', { type: 'noul' })).results[0].probability, .6);
  } finally { globalThis.fetch = old; }
});

test('audit reports progress and defaults localhost THX to one in-flight request', async () => {
  let running = 0, max = 0, calls = 0, binary = 0; const updates: LoopAuditProgress[] = [];
  const result = await runLoopDecisionAudit({ document: doc(), lines: [], images: [], settings, fileHash: 'test', onProgress: p => updates.push(p), decisionCaller: async body => {
    running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 2)); running--; calls++;
    const name = Object.keys(body.questions)[0];
    // #50 Part D: difficulty is uncertain when its top level is below 0.4 (was: "value 3 is uncertain").
    if (name.endsWith('difficulty')) return { results: [{ name, probability: .3, choice: '3', distribution: { '1': .1, '2': .25, '3': .3, '4': .25, '5': .1 } }] };
    binary++;
    return { results: [{ name, probability: binary === 1 ? .1 : binary === 2 ? .5 : .95 }] };
  } });
  assert.equal(max, 1); assert.equal(calls, 9); assert.equal(result.catches, 1); assert.equal(result.uncertain, 2);
  assert.equal(updates[0].total, 9); assert.equal(updates.at(-1)?.decided, 9); assert.equal(updates.at(-1)?.endpointErrors, 0);
  assert.equal(updates.at(-1)?.recent.length, 9);
});

test('audit fast-skips after five consecutive endpoint errors', async () => {
  let calls = 0; let progress: LoopAuditProgress | undefined;
  const result = await runLoopDecisionAudit({ document: doc(), lines: [], images: [], settings, fileHash: 'test', onProgress: p => { progress = p; }, decisionCaller: async () => { calls++; throw new Error('Decisions endpoint HTTP 502'); } });
  assert.equal(calls, 5); assert.equal(result.mode, 'skipped'); assert.equal(result.endpointErrors, 5);
  assert.equal(progress?.decided, 5); assert.equal(progress?.uncertain, 5); assert.match(result.notes.join(' '), /endpoint unreachable — skipping \(5 errors\)/);
});

// #51: the self-review step and its retry test were deleted together (its instructions live in the Fix prompt).

test('difficulty score uses argmax and is stored as a shadow proposal', async () => {
  const old = globalThis.fetch;
  // #50 Part D: the llama.cpp /v1/systemone score shape (see test/fixtures/systemone-llama-score-response.json):
  // request criteria = level labels; response probabilities keyed by 0-based level index.
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ answers: { 'Q1 difficulty': { type: 'score', score: 2, legend: { '0': '1: trivial recall', '1': '2: easy', '2': '3: medium', '3': '4: hard', '4': '5: very hard multi-step' }, probabilities: { '0': .1, '1': .2, '2': .4, '3': .2, '4': .1 }, confidence: .2 } } }) })) as any;
  try {
    const parsed = await LLMAdapter.executeDecisions({ providerConfig: provider, body: { state: 'Q', questions: { 'Q1 difficulty': { type: 'score', instructions: 'rate', criteria: ['1: trivial recall','2: easy','3: medium','4: hard','5: very hard multi-step'] } } } as any });
    assert.deepEqual(parsed.results, [{ name: 'Q1 difficulty', probability: .4, choice: '3', distribution: { '1': .1, '2': .2, '3': .4, '4': .2, '5': .1 } }]);
  } finally { globalThis.fetch = old; }
  const document = doc();
  const result = await runLoopDecisionAudit({ document, lines: [], images: [], settings, fileHash: 'score', decisionCaller: async body => {
    const name = Object.keys(body.questions)[0];
    return { results: [{ name, probability: name.endsWith('difficulty') ? .4 : .95, ...(name.endsWith('difficulty') ? { choice: '3' } : {}) }] };
  } });
  // top level exactly 0.4 is not below the 0.4 uncertainty line
  assert.deepEqual(document.questions[0].difficulty, { value: 3, source: 'model' });
  assert.equal(document.questions[0].difficultyMode, 'shadow'); assert.equal(result.difficultyUncertain, 0);
});

test('curriculum keywords choose a clear lesson, and ambiguous active questions use grade choices', async () => {
  const { curriculumLessons, keywordCurriculumHint } = await import('../src/pipeline/curriculumHints');
  const lessons = curriculumLessons('10', 'English');
  assert.equal(keywordCurriculumHint(lessons, 'Protect endangered wildlife and forest habitat')?.lesson, 'Saving Nature');
  assert.equal(curriculumLessons('10', 'Math').length, 0);
  const document = normalizeAuthoredDocument({ meta: { grade: '10', subject: 'English' }, questions: [
    { number: 1, type: 'short', stem: 'Protect endangered wildlife and forest habitat' },
    { number: 2, type: 'short', stem: 'Choose the correct word.' },
  ] });
  const choiceRequests: any[] = [];
  await runLoopDecisionAudit({ document, lines: [], images: [], settings: { ...settings, decideMode: 'active' }, fileHash: 'hint', decisionCaller: async body => {
    const [name, item] = Object.entries(body.questions)[0] as [string, any];
    if (item.type === 'choice') { choiceRequests.push(item); return { results: [{ name, probability: .6, choice: lessons[0].title }] }; }
    return { results: [{ name, probability: .95, ...(item.type === 'score' ? { choice: '2' } : {}) }] };
  } });
  assert.equal(document.questions[0].curriculumSource, 'keyword');
  assert.equal(document.questions[0].curriculumHints && (document.questions[0].curriculumHints as any).lesson, 'Saving Nature');
  assert.equal(choiceRequests.length, 1); assert.deepEqual(Object.keys(choiceRequests[0].criteria), lessons.map(l => l.title));
  assert.equal(document.questions[1].curriculumSource, 'decision');
});

test('unmapped subjects and low-confidence curriculum choices remain untagged', async () => {
  const document = normalizeAuthoredDocument({ meta: { grade: '12', subject: 'English' }, questions: [{ number: 1, type: 'short', stem: 'Choose.' }] });
  await runLoopDecisionAudit({ document, lines: [], images: [], settings: { ...settings, decideMode: 'active' }, fileHash: 'hint-low', decisionCaller: async body => {
    const [name, item] = Object.entries(body.questions)[0] as [string, any];
    return { results: [{ name, probability: item.type === 'choice' ? .3 : .95, ...(item.type === 'choice' ? { choice: Object.keys(item.criteria)[0] } : item.type === 'score' ? { choice: '2' } : {}) }] };
  } });
  assert.deepEqual(document.questions[0].curriculumHints, { chapter: null, lesson: null, topic: null });
  assert.equal(document.questions[0].curriculumSource, undefined);
});

test('actual redacted llama-server systemone capture parses noul and choice', async () => {
  const capture = (await import('./fixtures/systemone-llama-response.json')).default;
  const old = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => capture })) as any;
  try {
    const noul = await LLMAdapter.executeDecisions({ providerConfig: provider, body: { state: 'Q', questions: { answer_ok: { type: 'noul' } } } as any });
    const choice = await LLMAdapter.executeDecisions({ providerConfig: provider, body: { state: 'Q', questions: { correct_letter: { type: 'choice', criteria: { A: 'because', B: 'so', C: 'although', D: 'unless' } } } } as any });
    assert.deepEqual(noul.results, [{ name: 'answer_ok', probability: 0.6527858416386044 }]);
    assert.deepEqual(choice.results, [{ name: 'correct_letter', probability: 0.6365900484187214, choice: 'B' }]);
  } finally { globalThis.fetch = old; }
});

test('explicit local concurrency overrides the single-slot default', async () => {
  let running = 0, max = 0;
  const concurrentSettings = { ...settings, providers: [{ ...provider, decideConcurrency: 2 }] };
  await runLoopDecisionAudit({ document: doc(), lines: [], images: [], settings: concurrentSettings, fileHash: 'c2', decisionCaller: async body => {
    running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 4)); running--;
    const name = Object.keys(body.questions)[0];
    return { results: [{ name, probability: .9, ...(name.endsWith('difficulty') ? { choice: '2' } : {}) }] };
  } });
  assert.equal(max, 2);
});

test('Fix retries a malformed passage patch once and records the retry', async () => {
  let fixes = 0;
  const passageDoc = normalizeAuthoredDocument({ questions: [{ number: 1, sectionTitle: 'Reading', type: 'short', stem: 'What does the passage say?', options: [] }] });
  const receipt = await runLocalLoop({ lines: [{ id: 'L1', page: 1, y: 1, text: '1. What does the passage say?' }], images: [], settings: { ...settings, roleMapping: { ...settings.roleMapping, decide: undefined } }, fileHash: 'passage', caller: async req => {
    if (req.step !== 'fix') return { rawText: JSON.stringify(passageDoc) };
    if (req.step === 'fix') { fixes++; return { rawText: fixes === 1 ? '{bad' : JSON.stringify({ passages: [{ id: 'p1', sectionTitle: 'Reading', text: 'A source passage.' }], corrections: [{ action: 'replace', questionNumber: 1, question: { ...passageDoc.questions[0], passageId: 'p1' } }] }) }; }
    return { rawText: '{"corrections":[]}' };
  } });
  assert.equal(fixes, 2); assert.match(receipt.steps.find(s => s.step === 'fix')!.notes.join(' '), /retried: true/);
  assert.equal(receipt.document.passages?.[0].text, 'A source passage.');
});

test('malformed JEV probabilities are uncertain, never confident catches', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ results: [{ name: 'x', probability: null }, { name: 'y' }, { name: 'z', probability: 0 }] }) })) as any;
  try {
    const response = await LLMAdapter.executeDecisions({ providerConfig: { ...provider, decideDialect: 'jev' }, body: { input: {}, questions: [] } });
    assert.deepEqual(response.results, [{ name: 'z', probability: 0 }]);
  } finally { globalThis.fetch = old; }
});

test('live audit transport consumes delayed systemone envelopes and reaches the total', async () => {
  const old = globalThis.fetch; const updates: LoopAuditProgress[] = []; let count = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    await new Promise(r => setTimeout(r, 2));
    const { body } = JSON.parse(init.body); const [name, item] = Object.entries(body.questions)[0] as [string, any]; count++;
    const answer = item.type === 'score' ? { probabilities: { '1': .1, '2': .1, '3': .6, '4': .1, '5': .1 } } : { noul: count === 1 ? .05 : .95 };
    return { ok: true, json: async () => ({ model: 'redacted', answers: { [name]: answer }, usage: {} }) } as any;
  }) as any;
  try {
    const result = await runLoopDecisionAudit({ document: doc(), lines: [], images: [], settings, fileHash: 'transport', onProgress: p => updates.push(p) });
    assert.equal(count, 9); assert.equal(result.verdicts.length, 8); assert.equal(result.catches, 1);
    assert.equal(updates.at(-1)?.decided, updates.at(-1)?.total); assert.equal(updates.at(-1)?.endpointErrors, 0);
  } finally { globalThis.fetch = old; }
});
