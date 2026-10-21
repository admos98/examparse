/**
 * F4 — assistant executor: canonical action queues, batched reads, budget-bound resume,
 * working-memory brief, and the zero-model-call "Fix it" chip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  AgentSession,
  FIX_IT_RE,
  healthSummary,
  newAgentSession,
  parseToolReply,
  runAgentTurn,
  statePack,
  validateActionQueue,
} from '../src/pipeline/agent';
import { createToolRegistry } from '../src/pipeline/agentTools';
import { DEFAULT_SETTINGS } from '../src/store';
import { AppSettings, ExamDoc, LLMResponse } from '../src/types';

const TEXTS = [
  'Final English Exam — total 7 points',
  '1. What is the capital of France? a) Paris b) Rome',
  '2. Write the past tense of "go".',
  '3. Choose the correct word: She ___ to school. a) go b) goes',
  '4. Translate: "book".',
  '5. Match the words with their opposites: (6) big ....... (7) cold .......',
  'a) small b) hot',
];
/** Five parsed questions; Q5 is a group parent whose number line enumerates (6) and (7). */
function exam(): ExamDoc {
  const lines = TEXTS.map((text, i) => ({ id: `L${String(i + 1).padStart(4, '0')}`, page: 1, text }));
  const questions = [1, 2, 3, 4, 5].map((n) => ({
    id: `q${n}`,
    no: n,
    label: String(n),
    spans: [[n + 1, n === 5 ? 7 : n + 1]] as [number, number][],
    sectionId: 's1',
    type: n === 1 || n === 3 ? 'mcq' : 'short',
    stem: TEXTS[n],
    options: n === 1 ? [{ label: 'a', text: 'Paris' }, { label: 'b', text: 'Rome' }] : n === 3 ? [{ label: 'a', text: 'go' }, { label: 'b', text: 'goes' }] : [],
    images: [],
    confidence: 0.9,
    points: 1,
    flags: [],
  })) as unknown as ExamDoc['questions'];
  return {
    id: 'executor-fixture',
    fileHash: 'exec',
    createdAt: '2026-10-20',
    displayName: 'Executor fixture',
    meta: { totalPoints: 7, language: 'en', direction: 'ltr' },
    source: { lines, pages: 1, fileName: 'exec.txt', ocrUsed: false },
    questions,
    sections: [{ id: 's1', index: 1, title: 'Main', spans: [[2, 7]] }],
    images: [],
    flags: [],
    usage: [],
  } as ExamDoc;
}
const reply = (rawText: string): LLMResponse => ({ rawText, json: null, usage: { inputTokens: 40, outputTokens: 20 } });
const tool = (name: string, args: unknown = {}) => `\`\`\`tool\n${JSON.stringify({ name, args })}\n\`\`\``;

function harness(scripts: string[]) {
  let doc = exam();
  let settings = structuredClone(DEFAULT_SETTINGS) as AppSettings;
  const snapshots: string[] = [];
  let calls = 0;
  let retries = 0;
  let persisted: AgentSession | undefined;
  const runtime: AgentRuntime = {
    getDoc: () => doc,
    getSettings: () => settings,
    registry: createToolRegistry({
      getDoc: () => doc,
      getSettings: () => settings,
      updateDoc: async (d) => { doc = d; },
      updateSettings: async (s) => { settings = s; },
      // Retry is a genuine zero-add: the harness must climb the ladder, not loop.
      retryMissing: async (d) => { retries++; return d; },
    }),
    snapshot: async () => { snapshots.push(`undo_${snapshots.length}`); return snapshots.at(-1)!; },
    persist: async (s) => { persisted = structuredClone(s); },
    model: async () => reply(scripts[calls++] ?? 'No further actions.'),
  };
  return {
    runtime,
    get doc() { return doc; },
    get calls() { return calls; },
    get retries() { return retries; },
    get snapshots() { return snapshots; },
    get persisted() { return persisted; },
  };
}
const toolEvents = (s: AgentSession, name: string) => s.events.filter((e) => e.tool?.name === name && e.status === 'complete');

test('F4 — "fix it" runs the deterministic pipeline + canonical queue with ZERO model calls', async () => {
  const h = harness([]);
  assert.ok(FIX_IT_RE.test('Fix it') && FIX_IT_RE.test('درستش کن') && !FIX_IT_RE.test('fix it please'));
  const before = healthSummary(h.doc);
  assert.deepEqual(before.missing, [6, 7]);
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'fix it');
  assert.equal(h.calls, 0, 'no model call at all');
  assert.equal(h.retries, 1, 'remediation pipeline tried the additive retry once');
  assert.equal(toolEvents(s, 'run_remediation_pipeline').length, 1);
  assert.equal(toolEvents(s, 'diagnose_missing').length, 1);
  assert.equal(toolEvents(s, 'split_group_children').length, 1, 'canonical queue executed the split');
  const after = healthSummary(h.doc);
  assert.deepEqual(after.missing, []);
  assert.equal(after.parsed, 7);
  assert.notEqual(after.state, 'red', 'children shells carry no points yet → amber at worst, never red');
  const delta = s.events.find((e) => e.text.startsWith('Executor delta'));
  assert.ok(delta, 'single delta report');
  assert.match(delta!.text, /parsed 5 → 7, missing 2 → 0/);
  assert.match(s.events.at(-1)!.text, /missing 2 → 0/);
  assert.equal(s.ladderPath?.[0], 'fix-it');
  assert.ok(s.events.every((e) => !e.text.includes('Checkpoint')), 'no bound hit');
  console.log(`fix it: model calls ${h.calls}, tool executions ${s.executions} (budgeted ${s.weightedExecutions}), missing ${before.missing.length} → ${after.missing.length}`);
});

test('F4 — "fix it" works without any configured provider', async () => {
  const h = harness([]);
  h.runtime.model = undefined;
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'درستش کن');
  assert.deepEqual(healthSummary(h.doc).missing, []);
  assert.equal(toolEvents(s, 'split_group_children').length, 1);
  assert.ok(!s.events.some((e) => /no model|هیچ فراخوانی مدل/i.test(e.text)), 'no "configure a model" refusal');
});

test('F4 — diagnose_missing returns a canonical queue; executor runs split_group_children with no further model call; delta correct', async () => {
  const h = harness([tool('diagnose_missing', { numbers: [6, 7] }), 'Done: executor split the group.']);
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'Why are 6 and 7 missing?');
  assert.equal(h.calls, 2, 'one diagnosis turn + one closing chat turn; nothing in between');
  const diag = toolEvents(s, 'diagnose_missing')[0];
  const split = toolEvents(s, 'split_group_children')[0];
  assert.ok(diag && split);
  assert.ok(s.events.indexOf(diag) < s.events.indexOf(split), 'queue ran right after the diagnosis');
  assert.equal(h.snapshots.length, 1, 'one undo snapshot for the one mutation');
  assert.deepEqual(healthSummary(h.doc).missing, []);
  const report = s.observations.find((o) => o.includes('"executor"'));
  assert.ok(report, 'exactly one executor observation');
  assert.equal(s.observations.filter((o) => o.includes('"executor"')).length, 1);
  const parsed = JSON.parse(report!);
  const exec = parsed.executor ?? JSON.parse(parsed.preview + '"}}}').executor;
  assert.ok(exec === undefined || (exec.delta.parsed === 2 && exec.delta.missing === -2), 'delta parsed +2 / missing −2');
  assert.match(report!, /"example":"Reply in chat only/, 'worked follow-up example present once the queue resolved the gap');
  // Health observations: one at task start, one executor re-observation, final verification reuses it.
  assert.equal(toolEvents(s, 'get_exam_health').length, 2, 'executor re-observes ONCE for the whole queue');
  assert.match(s.events.at(-1)!.text, /missing 2 → 0/);
  // E4 — the brief carries the diagnosis summary verbatim and clears the resolved open questions.
  const brief = s.task!.brief!;
  const fresh = harness([]);
  const diagSummary = ((await fresh.runtime.registry.diagnose_missing.execute({ numbers: [6, 7] })) as any).summary as string;
  assert.equal(diagSummary, 'Diagnosed 2 missing numbers: 6=group-parent; 7=group-parent');
  assert.ok(brief.establishedFacts.includes(`diagnose_missing: ${diagSummary}`), 'fact stored verbatim');
  assert.ok(brief.triedActions.some((t) => t.startsWith('diagnose_missing(')));
  assert.ok(brief.triedActions.some((t) => t.startsWith('split_group_children(')));
  assert.deepEqual(brief.openQuestions, [], 'open questions for 6/7 closed once they parse');
  assert.ok(s.task!.completedRungs!.some((r) => r.rung === 'L2'));
  assert.ok(h.persisted!.task!.brief, 'brief persisted with the task');
  console.log(`executor: model calls ${h.calls}, tool executions ${s.executions} (budgeted ${s.weightedExecutions})`);
});

test('F4 — bound hit checkpoints the executor queue; "continue" resumes it without repeating finished items', async () => {
  const h = harness([tool('diagnose_missing', { numbers: [6, 7, 8, 9] }), 'thinking…', 'Done.']);
  // Make Q3 a second group parent so the canonical queue has two mutations.
  const d = h.doc;
  d.source.lines[3] = { ...d.source.lines[3], text: '3. Circle the correct forms: (8) she go/goes (9) they is/are' };
  (d.questions[2] as any).stem = d.source.lines[3].text;
  const base = healthSummary(d);
  assert.deepEqual(base.missing, [6, 7, 8, 9]);
  // Budget: start observe 0.25 + diagnose read 0.25 + first split 1 = 1.5; a second mutation would exceed 2.
  h.runtime.getSettings().agentLimits = { maxModelCalls: 2, maxToolExecutions: 2 };
  const s = newAgentSession(d.id);
  await runAgentTurn(h.runtime, s, 'fix 6-9');
  assert.equal(toolEvents(s, 'split_group_children').length, 1, 'one item ran before the budget paused the queue');
  assert.equal(s.task!.executorQueue!.length, 1, 'the other item is checkpointed');
  const checkpoint = s.events.find((e) => e.text.startsWith('Checkpoint'));
  assert.ok(checkpoint, 'bound hit produced a checkpoint');
  assert.match(checkpoint!.text, /executor queue: split_group_children/);
  assert.match(s.events.at(-1)!.text, /Bounds reached/);
  const ranFirst = toolEvents(s, 'split_group_children')[0].tool!.args.parentQuestionId;
  await runAgentTurn(h.runtime, s, 'continue');
  const splits = toolEvents(s, 'split_group_children');
  assert.equal(splits.length, 2, 'resume ran exactly the remaining item');
  assert.notEqual(splits[1].tool!.args.parentQuestionId, ranFirst, 'no repeat of the finished item');
  assert.equal(s.task!.executorQueue!.length, 0);
  assert.deepEqual(healthSummary(h.doc).missing, []);
  assert.ok(h.calls <= 3);
});

test('F4 — four batched reads cost one model call; leading reads run in parallel; malformed block is isolated', async () => {
  const batch = [tool('get_exam_health'), tool('list_missing'), tool('get_questions', { offset: 0, limit: 2 }), tool('get_settings_summary')].join('\n');
  const h = harness([batch, 'Health reported.']);
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'status');
  assert.equal(h.calls, 2, 'reads: 1 model call; closing chat: 1');
  const firstTurn = s.events.findIndex((e) => e.tool?.name === 'list_missing');
  const names = s.events.slice(firstTurn - 1, firstTurn + 3).map((e) => e.tool?.name);
  assert.deepEqual(names, ['get_exam_health', 'list_missing', 'get_questions', 'get_settings_summary'], 'all four executed in reply order');
  assert.ok(s.ladderPath!.includes('parallel-reads:3'), 'three non-health reads started concurrently');
  assert.equal(s.weightedExecutions, 0.25 * 5, 'five reads at READ_WEIGHT');
  assert.equal(s.executions, 5);

  const mixed = harness([`${tool('get_exam_health')}\n\`\`\`tool\n{not json}\n\`\`\`\n${tool('list_missing')}`, 'ok']);
  const m = newAgentSession(mixed.doc.id);
  await runAgentTurn(mixed.runtime, m, 'status');
  assert.ok(m.events.some((e) => e.kind === 'error' && e.text.includes('Malformed tool JSON')));
  assert.equal(toolEvents(m, 'list_missing').length, 1, 'well-formed blocks still execute next to a malformed one');
  assert.equal(mixed.calls, 2);

  const nine = parseToolReply({ rawText: Array(9).fill(tool('get_exam_health')).join('\n') });
  assert.equal(nine.calls.length, 0);
  assert.match(nine.errors[0], /At most 8/);
  assert.equal(parseToolReply({ rawText: Array(8).fill(tool('get_exam_health')).join('\n') }).calls.length, 8);
});

test('F4 — queue validation rejects unknown tools, wrong risk class, and args not backed by the document', () => {
  const h = harness([]);
  const { valid, rejected } = validateActionQueue(
    [
      { tool: 'split_group_children', args: { parentQuestionId: 'q5' }, rationale: 'ok', riskClass: 'mutate' },
      { tool: 'split_group_children', args: { parentQuestionId: 'q5' }, rationale: 'dup', riskClass: 'mutate' },
      { tool: 'split_group_children', args: { parentQuestionId: 'q99' }, rationale: 'ghost', riskClass: 'mutate' },
      { tool: 'reparse_section', args: { sectionId: 's1' }, rationale: 'risk lie', riskClass: 'read' },
      { tool: 'accept_group_representation', args: { parentQuestionId: 'q5', childNumbers: [1] }, rationale: 'not missing', riskClass: 'mutate' },
      { tool: 'execute_javascript', args: {}, rationale: 'nope', riskClass: 'mutate' },
    ],
    h.runtime.registry,
    h.doc,
  );
  assert.equal(valid.length, 1);
  assert.deepEqual(rejected.map((r) => r.tool), ['split_group_children', 'reparse_section', 'accept_group_representation', 'execute_javascript']);
  // E5 — state pack carries ladder position + next-rung signature and stays ≤1200 bytes.
  const pack = JSON.parse(statePack(h.doc, 'fix', [], { task: { goal: 'fix', plan: ['L0 locals', 'L1 retry', 'L2 inspect', 'L3 reparse', 'L4 escalate'], currentStep: 3, totalSteps: 5, triedActions: [], healthTrajectory: [], completedRungs: [{ rung: 'L1' }], brief: { goal: 'fix', establishedFacts: ['health red: expected 7 parsed 5'], triedActions: [], openQuestions: ['Q6: group-parent?'], nextPlanned: 'L2 diagnose_missing' }, executorQueue: [{ tool: 'split_group_children' }] } }));
  assert.equal(pack.task.rung, 'L2 inspect');
  assert.equal(pack.task.done, 'L1');
  assert.equal(pack.task.next, 'L2 diagnose_missing');
  assert.deepEqual(pack.task.queue, ['split_group_children']);
  assert.ok(new TextEncoder().encode(JSON.stringify(pack)).length <= 1200);
});
