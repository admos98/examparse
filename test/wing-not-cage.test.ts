import test from 'node:test';
import assert from 'node:assert/strict';
import type { Question, SourceLine } from '../src/types';
import { parseReadProposal, runGlobalReadStage, validateReadProposal } from '../src/pipeline/globalRead';
import { normalizeGrade, normalizeSubject, runMetaRead, validateMetaCandidate } from '../src/pipeline/metaRead';
import { runRepairLoop, type RepairState } from '../src/pipeline/repairLoop';

const line = (n: number, text: string, page = 1): SourceLine => ({ id: `L${String(n).padStart(4, '0')}`, page, y: n * 10, pageHeight: 900, text });
const q = (id: string, no: number, n: number): Question => ({ id, no, label: String(no), spans: [[n, n]], stem: `${no}. stem`, type: 'short', points: 1, confidence: 1, images: [] });

test('#39 Global Read is span-only, whole-paper, reasoning-off, and retries with validator complaint verbatim', async () => {
  const lines = [line(1, 'Header'), line(2, '1. One'), line(3, '2. Two')];
  const requests: any[] = [];
  const valid = { r: [[1, 1, 'furniture'], [2, 3, 'question']], q: [{ n: 1, p: [[2, 2]], t: 'short' }, { n: 2, p: [[3, 3]], t: 'short' }], s: [{ id: 's1', title: 'Part', p: [[2, 3]] }] };
  const result = await runGlobalReadStage({ lines, caller: async req => {
    requests.push(req);
    return requests.length === 1
      ? { rawText: '{}', json: { r: [[1, 2, 'furniture']], q: [] }, usage: { inputTokens: 1, outputTokens: 1 } }
      : { rawText: JSON.stringify(valid), json: valid, usage: { inputTokens: 1, outputTokens: 1 } };
  }});
  assert.equal(result.status, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests.every(r => r.reasoningOff === true), true);
  assert.match(requests[1].text, /VALIDATOR COMPLAINT/);
  assert.match(requests[1].text, /unlabelled lines: 3/);
  assert.equal(result.proposal?.questions.length, 2);
});

test('#39 Global Read validation is arithmetic only: exact line identity, unique numbers, non-overlap', () => {
  const lines = [line(1, 'x'), line(2, 'y')];
  const proposal = parseReadProposal('', { r: [[1, 2, 'question']], q: [{ n: 1, p: [[1, 2]], t: 'short' }, { n: 1, p: [[2, 2]], t: 'short' }], s: [] });
  const checked = validateReadProposal(proposal, lines);
  assert.equal(checked.ok, false);
  assert.match(checked.complaints.join(' '), /duplicates: 1/);
  assert.match(checked.complaints.join(' '), /overlap on lines: 2/);
});

test('#39 Persian metadata lexicons reject duration-as-total and two reads agree on grade 12 / English / 40', async () => {
  const lines = [line(1, 'امتحان زبان انگلیسی'), line(2, 'پایه دوازدهم'), line(3, 'مدت: ۱۰۰ دقیقه'), line(4, 'نمره کل: ۴۰')];
  assert.equal(normalizeGrade('پایه دوازدهم'), 12);
  assert.equal(normalizeSubject('آزمون زبان انگلیسی'), 'English');
  const rejected = validateMetaCandidate({ subject: { value: 'زبان انگلیسی', line: 1 }, grade: { value: 'دوازدهم', line: 2 }, total: { value: '۱۰۰', line: 3 } }, lines);
  assert.equal(rejected.value.total, undefined);
  assert.match(rejected.defects.find(d => d.field === 'total')?.complaint || '', /duration/);
  const answer = { subject: { value: 'زبان انگلیسی', line: 1 }, grade: { value: 'پایه دوازدهم', line: 2 }, total: { value: 40, line: 4 } };
  const result = await runMetaRead({ lines, printedTotalLine: 4, caller: async () => ({ rawText: JSON.stringify(answer), json: answer, usage: { inputTokens: 1, outputTokens: 1 } }) });
  assert.equal(result.calls, 2);
  assert.equal(result.meta.subject?.value, 'English');
  assert.equal(result.meta.grade?.value, 12);
  assert.equal(result.meta.total?.value, 40);
});

test('#39 cloud escalation payload is exactly one defect and only that defect evidence', async () => {
  const lines = [line(1, '1. one'), line(2, '2. two'), line(3, '2. duplicate')];
  const state: RepairState = { questions: [q('q1', 1, 1), q('q2a', 2, 2), q('q2b', 2, 3)], sections: [{ id: 's1', index: 1, title: 'Part', spans: [[1, 3]] }] };
  const cloudPayloads: string[] = [];
  const loop = await runRepairLoop({ state, lines, expectedNumbers: [1, 2], keyLineNos: [], budget: { calls: 0, units: 0, maxCalls: 20, maxUnits: 100 }, caller: async () => ({ rawText: '{"ops":[{"op":"noFix","defect":"duplicate-number:2"}]}', json: { ops: [{ op: 'noFix', defect: 'duplicate-number:2' }] } }), escalationCaller: async req => { cloudPayloads.push(req.text); return { rawText: '{"ops":[{"op":"mergeQuestions","defect":"duplicate-number:2","a":"q2a","b":"q2b"}]}', json: { ops: [{ op: 'mergeQuestions', defect: 'duplicate-number:2', a: 'q2a', b: 'q2b' }] } }; } });
  assert.equal(loop.remainingDefects.some(d => d.kind === 'duplicate-number'), false);
  assert.equal(cloudPayloads.length, 1);
  assert.match(cloudPayloads[0], /^ONE DEFECT ONLY/);
  assert.match(cloudPayloads[0], /L0002/);
  assert.doesNotMatch(cloudPayloads[0], /L0001/);
});
