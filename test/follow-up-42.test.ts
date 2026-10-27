import test from 'node:test';
import assert from 'node:assert/strict';
import type { Question, SourceLine } from '../src/types';
import {
  CLOUD_RETRY_DELAY_MS,
  assembleReadProposal,
  checkReadOutput,
  cloudPageRead,
  isTransientProviderError,
  parseReadProposal,
  runGlobalReadStage,
  validatePageProposal,
} from '../src/pipeline/globalRead';
import { validateMetaCandidate } from '../src/pipeline/metaRead';
import {
  parseRepairOps,
  repairOpSignature,
  runRepairLoop,
  type RepairState,
} from '../src/pipeline/repairLoop';

/**
 * Follow-up #42 — parser hardening, cloud weather retry, repair stops flailing.
 * Field evidence: local attempts died on `Cannot read properties of null (reading 'key')` thrown by the
 * proposal parser and handed to the model as its retry complaint; repair burned 19 calls / 198 ops on a
 * 5-question document while proposing operations on read-failed pages.
 */

const line = (n: number, text: string, page = 1): SourceLine => ({ id: `L${String(n).padStart(4, '0')}`, page, y: n * 10, pageHeight: 900, text });

/** Every complaint must say what to fix — never a bare code or a stack trace. */
const ACTIONABLE = /must|needs?|return|use|set |label|give|each|every|only|cite|claim|keyed|object|no questions|no operations/i;
const assertActionable = (complaints: string[], label: string) => {
  assert.ok(complaints.length > 0, `${label}: malformed output must produce at least one complaint`);
  for (const complaint of complaints) {
    assert.equal(typeof complaint, 'string', `${label}: complaints are strings`);
    assert.ok(complaint.trim().length > 12, `${label}: complaint too terse to act on — ${JSON.stringify(complaint)}`);
    assert.match(complaint, ACTIONABLE, `${label}: complaint must say what to fix — ${JSON.stringify(complaint)}`);
  }
};

// ============================================================================
// (a) parser fuzz — null / garbage proposals never throw, complaints actionable
// ============================================================================

const GARBAGE: unknown[] = [
  null,
  undefined,
  'not json at all',
  '{"r": [',
  [],
  {},
  42,
  true,
  { r: null, q: null, s: null, m: null, k: null },
  { r: {}, q: {}, s: {}, m: [], k: [] },
  { r: [null, 5, 'x', [], {}], q: [null, 7, [], 'q'], s: [null, 3, {}], m: 'x', k: 'y' },
  { r: [[1, 1]], q: [{ n: 1, p: [[1, 1]], o: [null] }] },
  { r: [[1, 1, 'nonsense']], q: [{ n: 1 }], k: { 1: null } },
  { q: [{ p: [[1, 1]] }, { n: 0, p: [[1, 1]] }], m: { subject: 'English', grade: { value: '12' }, total: { value: 40, line: 0 } } },
];

test('#42 (a): parseReadProposal never throws — truncated, null-riddled and garbage output becomes actionable complaints', () => {
  for (const raw of GARBAGE) {
    const asJson = typeof raw === 'string' ? undefined : raw;
    const asText = typeof raw === 'string' ? raw : (() => { try { return JSON.stringify(raw) ?? ''; } catch { return ''; } })();
    let proposal: ReturnType<typeof parseReadProposal>;
    assert.doesNotThrow(() => { proposal = parseReadProposal(asText, asJson); }, `parseReadProposal threw for ${JSON.stringify(raw)}`);
    // The proposal is always a usable, fully-shaped object even when nothing could be read.
    assert.ok(proposal!.labels instanceof Map);
    assert.ok(Array.isArray(proposal!.ranges));
    assert.ok(Array.isArray(proposal!.questions));
    assert.ok(Array.isArray(proposal!.sections));
    assert.equal(typeof proposal!.meta, 'object');
    assert.equal(typeof proposal!.answerKey, 'object');
  }
});

test('#42 (a): the field crash — a null option entry — is a complaint about the entry, not a TypeError', () => {
  const lines = [line(1, 'Header'), line(2, '1. Pick the correct verb.')];
  const checked = checkReadOutput('', { r: [[1, 2, 'question']], q: [{ n: 1, p: [[2, 2]], t: 'mcq', o: [null] }] }, lines);
  assert.equal(checked.ok, false);
  assertActionable(checked.complaints, 'null option');
  assert.match(checked.complaints.join(' '), /q entry 1 .*option 1 is null/);
  assert.doesNotMatch(checked.complaints.join(' '), /Cannot read propert/);
});

test('#42 (a): every malformed shape names the entry and the expected shape; good entries survive beside bad ones', () => {
  const lines = [line(1, 'Header'), line(2, '1. One'), line(3, '2. Two')];
  const checked = checkReadOutput('', {
    r: [null, [1, 1, 'furniture'], [2, 3, 'question']],
    q: [null, { n: 1, p: [[2, 2]], t: 'short' }, { n: 2, p: [[3, 3]], t: 'short' }],
    s: 'oops',
    m: { subject: { value: 'English' } },
    k: { 1: null },
  }, lines);
  assert.equal(checked.ok, false, 'structural complaints block the page from being accepted');
  assertActionable(checked.complaints, 'mixed garbage');
  const text = checked.complaints.join('\n');
  assert.match(text, /r entry 1 is null/);
  assert.match(text, /q entry 1 is null/);
  assert.match(text, /s \(sections\) must be a list/);
  assert.match(text, /meta\.subject has no evidence line/);
  assert.match(text, /k\["1"\] is null/);
  // The readable entries still parse — the model only has to fix what the complaint names.
  assert.equal(checked.proposal.questions.length, 2);
  assert.equal(checked.proposal.ranges.length, 2);
});

test('#42 (a): a fuzz sweep of truncated JSON prefixes never throws and always complains', () => {
  const full = '{"r":[[1,1,"furniture"],[2,3,"question"]],"q":[{"n":1,"p":[[2,2]],"t":"mcq","o":[["a",[[2,2]]],["b",[[3,3]]]]}],"s":[{"id":"s1","title":"Part","p":[[2,3]]}],"m":{"subject":{"value":"English","line":1}},"k":{"1":{"value":"a","p":[[9,9]]}}}';
  const lines = [line(1, 'Header'), line(2, '1. One'), line(3, 'b) two')];
  for (let cut = 0; cut <= full.length; cut += 7) {
    const truncated = full.slice(0, cut);
    assert.doesNotThrow(() => checkReadOutput(truncated, undefined, lines), `threw on prefix of length ${cut}`);
    const checked = checkReadOutput(truncated, undefined, lines);
    if (!checked.ok) assertActionable(checked.complaints, `prefix ${cut}`);
  }
  // Null-riddled array permutations.
  const entries = [null, 0, '', [], {}, { n: 1, p: [[2, 2]] }];
  for (const a of entries) for (const b of entries) {
    const payload = { r: [a, [1, 1, 'furniture'], [2, 3, 'question']], q: [b, { n: 1, p: [[2, 2]], t: 'short' }] };
    assert.doesNotThrow(() => checkReadOutput('', payload, lines));
  }
});

test('#42 (a): parseRepairOps never throws — malformed operations become named complaints', () => {
  const payloads: unknown[] = [
    null, undefined, 'not json', '[', {}, [], 7,
    { ops: 'nope' },
    { ops: [null, 3, [], { op: 'unknownOp' }, { op: 'assignLines' }, { op: 'mergeQuestions', a: 'q1', b: 'q1' }] },
    { operations: [{ op: 'dropAsFurniture', lines: 'x' }, { op: 'setSection', title: '  ' }] },
  ];
  for (const payload of payloads) {
    let parsed: ReturnType<typeof parseRepairOps>;
    assert.doesNotThrow(() => { parsed = parseRepairOps('', payload ?? undefined); }, `parseRepairOps threw for ${JSON.stringify(payload)}`);
    assert.ok(Array.isArray(parsed!.ops));
    if (!parsed!.ops.length) assertActionable(parsed!.complaints, `repair payload ${JSON.stringify(payload)}`);
    for (const complaint of parsed!.complaints) assert.match(complaint, /ops entry|operations payload|JSON operations object/);
  }
  // A bare array of operations and a fenced reply are both still readable.
  const bareArray = parseRepairOps('[{"op":"setSection","line":4,"title":"Part B"}]');
  assert.deepEqual(bareArray.ops, [{ op: 'setSection', defect: '', line: 4, title: 'Part B' }]);
  const fenced = parseRepairOps('```json\n{"ops":[{"op":"noFix","defect":"d1","reason":"not printed"}]}\n```');
  assert.equal(fenced.ops.length, 1);
  assert.equal(fenced.ops[0].op, 'noFix');

  const mixed = parseRepairOps('', { ops: [null, { op: 'setSection', line: 4, title: 'Part B' }] });
  assert.equal(mixed.ops.length, 1, 'the readable operation survives');
  assert.equal(mixed.rejected, 1);
  assertActionable(mixed.complaints, 'one bad op');
});

test('#42 (a): the sibling metadata parser never throws either — garbage becomes a plain defect', () => {
  const lines = [line(1, 'English Exam'), line(2, 'Grade 12'), line(3, 'Total: 40 marks')];
  const payloads: unknown[] = [null, undefined, 7, 'nope', [], { subject: null, grade: [], total: 'a lot', date: { evidenceLine: 'x' } }, { total: { value: 1e9 } }];
  for (const payload of payloads) {
    let result: ReturnType<typeof validateMetaCandidate>;
    assert.doesNotThrow(() => { result = validateMetaCandidate(payload as any, lines); }, `validateMetaCandidate threw for ${JSON.stringify(payload)}`);
    assert.ok(result!.defects.length > 0, 'unreadable metadata reports what is missing');
    for (const defect of result!.defects) assert.ok(defect.complaint.length > 3);
  }
  // A valid candidate still validates exactly as before.
  const good = validateMetaCandidate({ subject: { value: 'English', line: 1 }, grade: { value: '12', line: 2 }, total: { value: 40, line: 3 } }, lines);
  assert.equal(good.value.subject?.value, 'English');
  assert.equal(good.value.total?.value, 40);
});

// ============================================================================
// (b) cloud transient-error retry — weather is retried once, refusal is not
// ============================================================================

const mkLine = (no: number, page: number, text: string): SourceLine => ({ id: `L${String(no).padStart(4, '0')}`, page, y: (no % 3 + 1) * 100, text });
const examLines = (pages = 1): SourceLine[] => {
  const out: SourceLine[] = [];
  for (let p = 1; p <= pages; p++) {
    out.push(mkLine((p - 1) * 3 + 1, p, `Unit ${p} — reading`));
    out.push(mkLine((p - 1) * 3 + 2, p, `${p}. Question ${p}: choose the best word.`));
    out.push(mkLine((p - 1) * 3 + 3, p, `a) option for question ${p}`));
  }
  return out;
};
const goodPage = (a: number): unknown => ({ r: [[a, a, 'furniture'], [a + 1, a + 2, 'question']], q: [{ n: Math.round(a / 3) + 1, p: [[a + 1, a + 1]], t: 'short' }] });
const ownedRange = (text: string): [number, number] => {
  const m = text.match(/non-ctx lines \(L(\d{4})\.\.L(\d{4})\)/);
  return [Number(m?.[1] || 0), Number(m?.[2] || 0)];
};
const formatFailure = { rawText: 'Sure! Here it is.', json: undefined, usage: { inputTokens: 10, outputTokens: 5 } };

test('#42 (b): a 503 fails once then succeeds — the page lands on the retry with cloudAttempts 2 and the provider error recorded', async () => {
  const waits: number[] = [];
  let cloudCalls = 0;
  const result = await runGlobalReadStage({
    lines: examLines(1),
    caller: async () => formatFailure,
    cloudCaller: async req => {
      cloudCalls++;
      if (cloudCalls === 1) throw new Error('503 Service Unavailable');
      const [a] = ownedRange(req.text);
      return { rawText: '{}', json: goodPage(a) };
    },
    cloudRetryDelayMs: 0,
    wait: async (ms: number) => { waits.push(ms); },
  });
  assert.equal(cloudCalls, 2, 'exactly one transient retry');
  assert.equal(waits.length, 1);
  assert.equal(result.pages[0].status, 'cloud ok');
  assert.equal(result.pages[0].cloudCalls, 2);
  assert.equal(result.pages[0].cloudAttempts, 2);
  assert.match(result.pages[0].cloudError || '', /503/);
  assert.equal(result.cloudCalls, 2);
  assert.equal(result.proposal?.questions.length, 1);
});

test('#42 (b): a validation-bad cloud response gets exactly one cloud call — content is never retried', async () => {
  let cloudCalls = 0;
  const result = await runGlobalReadStage({
    lines: examLines(1),
    caller: async () => formatFailure,
    cloudCaller: async () => {
      cloudCalls++;
      // Parses fine, but says "no questions" on a page that plainly has a numbered line: a refusal, not weather.
      return { rawText: '{"r":[],"q":[]}', json: { r: [], q: [] } };
    },
    cloudRetryDelayMs: 0,
    wait: async () => { throw new Error('a validation failure must not wait for a retry'); },
  });
  assert.equal(cloudCalls, 1);
  assert.equal(result.pages[0].status, 'failed');
  assert.equal(result.pages[0].cloudAttempts, 1);
  assert.equal(result.pages[0].cloudError, undefined, 'a content refusal is not weather');
  assert.match(result.pages[0].reason || '', /no questions/);
});

test('#42 (b): cloudPageRead waits the ~5s default before its single retry, and only for transient errors', async () => {
  const waits: number[] = [];
  let calls = 0;
  const lines = examLines(1);
  const ok = await cloudPageRead({
    page: 1,
    totalPages: 1,
    owned: lines,
    context: [],
    caller: async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed (ETIMEDOUT)');
      return { rawText: '{}', json: goodPage(1) };
    },
    wait: async (ms: number) => { waits.push(ms); },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.calls, 2);
  assert.deepEqual(waits, [CLOUD_RETRY_DELAY_MS]);
  assert.equal(CLOUD_RETRY_DELAY_MS, 5000);
  assert.match(ok.error || '', /ETIMEDOUT/);

  // A 401 is a refusal: no second call, no wait.
  const refused = await cloudPageRead({
    page: 1,
    totalPages: 1,
    owned: lines,
    context: [],
    caller: async () => { throw new Error('401 Unauthorized — invalid api key'); },
    wait: async () => { throw new Error('must not wait'); },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.calls, 1);

  assert.equal(isTransientProviderError('503 Service Unavailable'), true);
  assert.equal(isTransientProviderError('deepseek-v4-flash:free [502] fetch failed (ETIMEDOUT)'), true);
  assert.equal(isTransientProviderError('socket hang up'), true);
  assert.equal(isTransientProviderError('429 Too Many Requests'), true);
  assert.equal(isTransientProviderError('401 Unauthorized'), false);
  assert.equal(isTransientProviderError('the proposal contains no questions'), false);
});

// ============================================================================
// (c) repair filtering — no calls for read-failed pages, dedupe, abandonment
// ============================================================================

const q = (id: string, no: number, span: [number, number], extra: Partial<Question> = {}): Question => ({
  id, no, label: String(no), spans: [span], stem: `${no}. printed stem`, type: 'short', points: 1, confidence: 1, images: [], ...extra,
});

test('#42 (c): defects whose every line sits on a read-failed page produce ZERO repair calls', async () => {
  const lines = [line(1, 'Header'), line(2, '1. One'), line(3, '2. Two'), line(4, 'Picture page header', 2), line(5, '3. Three (page two)', 2), line(6, '4. Four (page two)', 2)];
  const state: RepairState = { questions: [q('q1', 1, [2, 2]), q('q2', 2, [3, 3])], sections: [{ id: 's1', index: 1, title: 'Part', spans: [[1, 3]] } as any] };
  let calls = 0;
  const loop = await runRepairLoop({
    state,
    lines,
    expectedNumbers: [1, 2],
    keyLineNos: [],
    failedPages: [2],
    budget: { calls: 0, units: 0, maxCalls: 50, maxUnits: 500 },
    caller: async () => { calls++; return { rawText: '{"ops":[]}', json: { ops: [] } }; },
    escalationCaller: async () => { calls++; return { rawText: '{"ops":[]}', json: { ops: [] } }; },
  });
  assert.equal(calls, 0, 'repair never pays to propose fixes for read-failed pages');
  assert.equal(loop.calls, 0);
  assert.equal(loop.status, 'no-defects', 'nothing is repairable; the page-retry path owns it');
  assert.ok(loop.droppedReadFailedDefects > 0, 'the report says how many defects were handed to the page-retry path');
  assert.ok(loop.remainingDefects.every(d => d.lineIds.some(n => n >= 4)), 'the dropped defects are the page-2 ones');
});

test('#42 (c): an identical rejected operation is counted once as deduped, never re-validated — proposed = accepted + rejected + deduped', async () => {
  const lines = [line(1, 'Header'), line(2, '1. One'), line(3, '2. Two')];
  const state: RepairState = { questions: [q('q1', 1, [2, 2])], sections: [{ id: 's1', index: 1, title: 'Part', spans: [[1, 3]] } as any] };
  const op = { op: 'assignLines' as const, defect: 'unaccounted-lines:3', lines: [3, 3] as [number, number], questionId: 'q_missing' };
  let calls = 0;
  const loop = await runRepairLoop({
    state,
    lines,
    expectedNumbers: [1],
    keyLineNos: [],
    budget: { calls: 0, units: 0, maxCalls: 50, maxUnits: 500 },
    caller: async () => { calls++; return { rawText: JSON.stringify({ ops: [op] }), json: { ops: [op] } }; },
  });
  assert.equal(calls, 2, 'two rounds were attempted');
  const [first, second] = loop.rounds;
  assert.equal(first.rejected, 1);
  assert.equal(first.deduped, 0);
  assert.equal(second.rejected, 0, 'the same operation is never re-sent to the validator');
  assert.equal(second.deduped, 1);
  assert.equal(loop.opsProposed, 2);
  assert.equal(loop.opsAccepted + loop.opsRejected + loop.opsDeduped, loop.opsProposed, 'the summary reconciles');
  assert.equal(repairOpSignature(op), repairOpSignature({ ...op, defect: 'another-defect-id' }), 'identity is kind + targets, not the defect id');
});

test('#42 (c): after 10 rejections of one kind in a round, that kind is abandoned for the round', async () => {
  const lines: SourceLine[] = [line(1, 'Header')];
  const questions: Question[] = [];
  for (let n = 1; n <= 16; n++) {
    lines.push(line(n + 1, `${n}. Question ${n}`));
    // An mcq with no printed options: one options-missing defect per question, so 15 + 1 batches.
    questions.push({ id: `q${n}`, no: n, label: String(n), spans: [[n + 1, n + 1]], stem: `${n}. Question ${n}`, type: 'mcq', points: 1, confidence: 1, images: [], options: [] });
  }
  const rejectingOps = Array.from({ length: 15 }, (_, i) => ({ op: 'assignLines', defect: `options-missing:q${i + 1}`, lines: [i + 2, i + 2], questionId: 'ghost' }));
  const callsPerRound: number[] = [];
  const loop = await runRepairLoop({
    state: { questions, sections: [{ id: 's1', index: 1, title: 'Part', spans: [[1, 20]] } as any] },
    lines,
    expectedNumbers: Array.from({ length: 16 }, (_, i) => i + 1),
    keyLineNos: [],
    budget: { calls: 0, units: 0, maxCalls: 50, maxUnits: 5000 },
    caller: async () => { callsPerRound.push(1); return { rawText: JSON.stringify({ ops: rejectingOps }), json: { ops: rejectingOps } }; },
  });
  assert.equal(loop.rounds[0].calls, 1, 'the abandoned kind stops after its first batch instead of paying for the second');
  assert.deepEqual(loop.rounds[0].abandonedKinds, ['options-missing']);
  assert.equal(callsPerRound.length, loop.calls);
  assert.ok(callsPerRound.length < 4, 'abandonment caps the calls a failing kind can burn');
  assert.ok(loop.rounds[0].rejected >= 10);
  assert.ok(loop.abandonedKinds.includes('options-missing'));
  assert.equal(loop.opsProposed, loop.opsAccepted + loop.opsRejected + loop.opsDeduped);
});

// ============================================================================
// (d) key-only pages are valid
// ============================================================================

test('#42 (d): a page whose validated content is only key/marks lines is local ok with 0 questions and keeps its key evidence', async () => {
  const lines: SourceLine[] = [
    line(1, 'Unit 1 — reading'), line(2, '1. Question one'), line(3, '2. Question two'),
    line(4, 'Unit 2 — reading', 2), line(5, '3. Question three', 2), line(6, '4. Question four', 2),
    line(7, 'Answer Key', 3), line(8, '1. b', 3), line(9, '2. c', 3), line(10, '3. a', 3), line(11, '4. d', 3),
  ];
  const answerKeyPage = { r: [[7, 7, 'furniture'], [8, 11, 'key']], q: [], k: { 1: { value: 'b', p: [[8, 8]] }, 2: { value: 'c', p: [[9, 9]] } } };
  // Unit-level guarantee: key/marks-only content validates, and the strict (non-key) mode still refuses it.
  const keyOwned = lines.filter(l => l.page === 3);
  const keyProposal = parseReadProposal('', answerKeyPage);
  assert.equal(validatePageProposal(keyProposal, keyOwned, { allowKeyOnlyPage: true }).ok, true);
  assert.equal(validatePageProposal(keyProposal, keyOwned, { allowKeyOnlyPage: false }).ok, false);

  const calls: string[] = [];
  const result = await runGlobalReadStage({
    lines,
    caller: async req => {
      calls.push(req.label);
      if (req.text.includes('Page 3/3.')) return { rawText: '{}', json: answerKeyPage };
      const first = Number(req.text.match(/non-ctx lines \(L(\d{4})\.\./)?.[1] || 1);
      const questionNo = Math.round((first - 1) / 3) * 2 + 1;
      return {
        rawText: '{}',
        json: {
          r: [[first, first, 'furniture'], [first + 1, first + 2, 'question']],
          q: [{ n: questionNo, p: [[first + 1, first + 1]], t: 'short' }, { n: questionNo + 1, p: [[first + 2, first + 2]], t: 'short' }],
        },
      };
    },
  });
  assert.equal(result.pages[2].status, 'local ok', 'the answer-key page is a normal page, not a failure');
  assert.equal(result.pages[2].questions, 0);
  assert.equal(calls.filter(label => label.includes('page 3/3')).length, 1, 'no retry needed');
  assert.equal(result.failedPages.length, 0);
  assert.equal(result.proposal?.questions.length, 4);
  const assembled = assembleReadProposal(result.proposal!, lines);
  assert.deepEqual(assembled.keyLineNos, [8, 9, 10, 11], 'key evidence flows into assembly exactly like a question page');
});

// ============================================================================
// Report — cloud weather per page, and a repair summary that reconciles
// ============================================================================

test('#42 report: per-page cloudAttempts/cloudError and a reconciling repair summary reach the Parse report', async () => {
  const { parseReportForDoc } = await import('../src/utils/examExport');
  const { runRepairLoop: runLoop } = await import('../src/pipeline/repairLoop');
  const { computeDefects } = await import('../src/pipeline/defects');
  const lines = examLines(2);
  let cloudCalls = 0;
  const read = await runGlobalReadStage({
    lines,
    caller: async () => formatFailure,
    cloudCaller: async req => {
      cloudCalls++;
      if (cloudCalls === 1) throw new Error('502 Bad Gateway');
      const [a] = ownedRange(req.text);
      return { rawText: '{}', json: goodPage(a) };
    },
    cloudRetryDelayMs: 0,
    wait: async () => undefined,
  });
  const state: RepairState = { questions: [q('q1', 1, [2, 2])], sections: [{ id: 's1', index: 1, title: 'Part', spans: [[1, 3]] } as any] };
  const op = { op: 'assignLines' as const, defect: 'unaccounted-lines:3', lines: [3, 3] as [number, number], questionId: 'ghost' };
  const loop = await runLoop({
    state, lines, expectedNumbers: [1], keyLineNos: [],
    budget: { calls: 0, units: 0, maxCalls: 20, maxUnits: 500 },
    caller: async () => ({ rawText: JSON.stringify({ ops: [op] }), json: { ops: [op] } }),
  });
  const defects = computeDefects({ doc: { questions: loop.state.questions, sections: loop.state.sections }, lines, expectedNumbers: [1], keyLineNos: [] });
  const doc = {
    id: 'exam_report_42', fileHash: 'h', createdAt: new Date().toISOString(), displayName: 'Report',
    meta: { language: 'en', direction: 'ltr' }, sections: [], questions: [], images: [], flags: [],
    source: { lines, pages: 2 }, usage: [],
    spine: {
      classify: { status: 'partial', calls: read.calls, cloudCalls: read.cloudCalls, readAllowance: read.readAllowance, pages: read.pages },
      repairLoop: {
        status: loop.status, rounds: loop.rounds.length, calls: loop.calls,
        opsProposed: loop.opsProposed, opsAccepted: loop.opsAccepted, opsRejected: loop.opsRejected, opsDeduped: loop.opsDeduped,
        escalations: loop.escalations, defectsRemaining: defects.length, remainingKinds: [...new Set(defects.map(d => d.kind))],
      },
      budget: { calls: 0, units: 0, maxCalls: 10, maxUnits: 100 },
    },
  } as any;

  const report = parseReportForDoc(doc);
  const failedPage = report.pages?.find(p => p.status === 'failed') || report.pages?.find(p => (p.cloudAttempts || 0) > 1);
  assert.ok(failedPage, 'the weather page is in the report');
  assert.equal(failedPage!.cloudAttempts, 2, 'the report shows the retry was needed');
  assert.match(failedPage!.cloudError || '', /502/);

  const repair = report.repairLoop!;
  assert.equal(repair.opsProposed, (repair.opsAccepted || 0) + (repair.opsRejected || 0) + (repair.opsDeduped || 0), 'proposed = accepted + rejected + deduped');
  assert.equal(repair.opsRejected, 1);
  assert.equal(repair.opsDeduped, 1);
});
