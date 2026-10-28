import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReadProposalChecked, buildPageReadPrompt, runGlobalReadStage } from '../src/pipeline/globalRead';
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
  furnitureLines: [1],
  sections: [{ title: 'Listening', headerLine: 2 }],
  questions: [{ number: 1, type: 'truefalse', stemLines: [3], optionLines: [4, 5], options: [{ key: 'a', lines: [4] }, { key: 'b', lines: [5] }], continuationLines: [], marksLine: 6, answerLine: null, imageIds: [] }],
  answerKey: [{ number: 1, answer: 'b', line: 20 }],
};

test('compact and verbose formats normalize the same scripted page to the same proposal', () => {
  const c = parseReadProposalChecked('', compact, 'compact', lines).proposal;
  const v = parseReadProposalChecked('', verbose, 'verbose', lines).proposal;
  assert.deepEqual(v.questions, c.questions);
  assert.deepEqual(v.sections, c.sections);
  assert.deepEqual([...v.labels].filter(([, label]) => label === 'furniture'), [...c.labels].filter(([, label]) => label === 'furniture'));
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
    page: 1, furnitureLines: [], sections: [{ title: 'Listening', headerLine: 1 }],
    questions: [{ number: 1, type: 'short', stemLines: [2, 4], optionLines: [], continuationLines: [], marksLine: null, answerLine: null, imageIds: [] }], answerKey: [],
  }, 'verbose', source).proposal;
  assert.deepEqual(proposal.questions[0].spans, [[2, 2], [4, 4]]);
  const assembled = assembleReadProposal(proposal, source);
  const compiled = await compileDocument({ questions: assembled.questions, sections: assembled.sections, lines: source, keyLineNos: assembled.keyLineNos, accountedLineNos: [...proposal.labels.keys()] });
  assert.ok(compiled.reconciliations.some(r => r.kind === 'orphan-absorbed' && r.lines.includes(3)));
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
  assert.match(prompt, /If you are producing questions at regular line intervals, you have stopped reading — go back to the printed numbers\./);
});

test('page report records the actual verbose format and its output-token receipt', async () => {
  const result = await runGlobalReadStage({
    lines,
    format: 'verbose',
    caller: async request => {
      assert.match(request.text, /"furnitureLines"/);
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
