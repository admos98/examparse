import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  AgentSession,
  compactResult,
  healthSummary,
  isAgentWorking,
  newAgentSession,
  parseToolReply,
  runAgentTurn,
  statePack,
} from '../src/pipeline/agent';
import { createToolRegistry } from '../src/pipeline/agentTools';
import { applyTheme, THEME_DEFAULTS } from '../src/pipeline/agentTheme';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  loadUsageLog,
} from '../src/store';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { AppSettings, ExamDoc, LLMResponse } from '../src/types';
function exam(parsed = 38): ExamDoc {
  const lines = Array.from({ length: 67 }, (_, i) => ({
    id: `L${String(i + 1).padStart(4, '0')}`,
    page: Math.floor(i / 20) + 1,
    text: `${i + 1}. می‌شود؟ Iranian original ${i + 1}`,
  }));
  const source = [
    { id: 'L0001', page: 1, text: 'ردیف | سؤالات | نمره' },
    { id: 'L0002', page: 1, text: 'آزمون نهایی زبان انگلیسی — نمره ۴۸' },
    { id: 'L0003', page: 1, text: 'شنیداری Listening' },
    ...lines.map((l, i) => ({
      ...l,
      id: `L${String(i + 4).padStart(4, '0')}`,
    })),
    { id: 'L0071', page: 5, text: 'راهنماي تصحيح' },
    { id: 'L0072', page: 5, text: '1. Key only' },
  ];
  const all = assembleAndValidateQuestions(
    lines.map((l, i) => ({
      id: `q${i + 1}`,
      no: i + 1,
      spans: [[i + 4, i + 4]],
      sectionId: 's',
      type: 'short',
      confidence: 0.9,
      points:
        i < 12 ? 0.5 : i < 37 ? 0.75 : i === 37 ? 0.25 : i < 62 ? 0.75 : 1,
    })),
    source,
  ).questions;
  return {
    id: `iranian_${parsed}`,
    fileHash: 'fixture',
    createdAt: '2026-10-18',
    displayName: 'Iranian final',
    meta: { totalPoints: 48, language: 'fa', direction: 'rtl' },
    source: {
      lines: source,
      pages: 5,
      fileName: 'iranian.txt',
      ocrUsed: false,
    },
    questions: all.slice(0, parsed),
    sections: [{ id: 's', index: 1, title: 'نوشتاری', spans: [[1, 67]] }],
    images: [],
    flags: [],
    usage: [],
  };
}
const reply = (rawText: string): LLMResponse => ({
  rawText,
  json: null,
  usage: { inputTokens: 50, outputTokens: 20 },
});
const tool = (name: string, args: unknown = {}) =>
  `\`\`\`tool\n${JSON.stringify({ name, args })}\n\`\`\``;
function harness(
  scripts: Array<string | (() => Promise<LLMResponse>)>,
  parsed = 38,
) {
  let doc = exam(parsed);
  let settings = structuredClone(DEFAULT_SETTINGS);
  const snapshots = new Map<string, { doc: ExamDoc; settings: AppSettings }>();
  let calls = 0;
  let retries = 0;
  let persisted: AgentSession | undefined;
  const runtime: AgentRuntime = {
    getDoc: () => doc,
    getSettings: () => settings,
    registry: createToolRegistry({
      getDoc: () => doc,
      getSettings: () => settings,
      updateDoc: async (d) => {
        doc = d;
      },
      updateSettings: async (s) => {
        settings = s;
      },
      retryMissing: async (d) => {
        retries++;
        return { ...d, questions: exam(67).questions };
      },
    }),
    snapshot: async () => {
      const id = `undo_${snapshots.size}`;
      snapshots.set(id, structuredClone({ doc, settings }));
      return id;
    },
    persist: async (s) => {
      persisted = structuredClone(s);
    },
    model: async (_system, pack) => {
      assert.ok(
        !pack.includes('Iranian original 67'),
        'source is pulled, not pushed',
      );
      const value = scripts[calls++];
      return typeof value === 'function'
        ? value()
        : reply(value ?? 'No further actions.');
    },
  };
  return {
    runtime,
    get doc() {
      return doc;
    },
    set doc(d: ExamDoc) {
      doc = d;
    },
    get settings() {
      return settings;
    },
    snapshots,
    get calls() {
      return calls;
    },
    get retries() {
      return retries;
    },
    get persisted() {
      return persisted;
    },
    undo: (id: string) => {
      const s = snapshots.get(id)!;
      doc = structuredClone(s.doc);
      settings = structuredClone(s.settings);
    },
  };
}
test('agent verify Iranian 38/67 → retry → forced re-observation → green; exact 2 model/3 tool calls, pack ≤1200 tokens', async () => {
  const h = harness([tool('retry_missing_questions'), 'I am done.']);
  const session = newAgentSession(h.doc.id);
  const pack = statePack(h.doc, 'Check this exam', []);
  assert.doesNotThrow(() => JSON.parse(pack));
  assert.ok(new TextEncoder().encode(pack).length <= 1200);
  console.log(
    `state pack: ${pack.length} chars, UTF-8 token upper bound ${new TextEncoder().encode(pack).length}`,
  );
  await runAgentTurn(h.runtime, session, 'Check this exam');
  assert.equal(h.calls, 2);
  assert.equal(h.retries, 1);
  assert.equal(session.executions, 3);
  assert.equal(healthSummary(h.doc).state, 'green');
  const firstStatement = session.events.findIndex(
    (e) => e.kind === 'assistant' && e.text.includes('Expected 67, parsed 38'),
  );
  const retry = session.events.findIndex(
    (e) => e.tool?.name === 'retry_missing_questions',
  );
  assert.ok(firstStatement >= 0 && firstStatement < retry);
  assert.match(session.events[firstStatement].text, /points 25\/48/);
  assert.equal(session.events[retry + 1].tool?.name, 'get_exam_health');
  assert.match(session.events.at(-1)!.text, /38 → 67/);
  assert.match(session.events.at(-1)!.text, /Verified green/);
  assert.equal(h.persisted!.running, false);
});
test('malformed fenced JSON self-corrects in 3 model calls', async () => {
  const h = harness(['```tool\n{bad json}\n```', tool('get_exam_health')]);
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'check');
  assert.equal(h.calls, 3);
  assert.ok(
    s.events.some(
      (e) => e.kind === 'error' && e.text.includes('Malformed tool JSON'),
    ),
  );
  assert.ok(s.executions <= 12);
});
test('forbidden action refuses with no snapshot/mutation; native calls use identical registry validation', async () => {
  const h = harness([
    tool('execute_javascript', { code: 'delete everything', apiKey: 'secret' }),
    'Okay.',
  ]);
  const before = structuredClone(h.doc);
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'execute code');
  assert.deepEqual(h.doc, before);
  assert.equal(h.snapshots.size, 0);
  assert.ok(s.events.some((e) => e.text.includes('Forbidden/unknown')));
  assert.equal(JSON.stringify(s.events).includes('secret'), false);
  assert.deepEqual(
    parseToolReply({
      rawText: '',
      tool_calls: [{ function: { name: 'get_exam_health', arguments: '{}' } }],
    }).calls,
    [{ name: 'get_exam_health', args: {} }],
  );
});
test('cannot finish on mutation, even when model claims fixed; undo deep-equals questions', async () => {
  const h = harness([
    `Fixed! ${tool('set_question_points', { questionId: 'q1', points: 0.25 })}`,
    'Everything fixed!',
  ]);
  const before = structuredClone(h.doc.questions);
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'change points');
  const mutation = s.events.findIndex(
    (e) => e.tool?.name === 'set_question_points',
  );
  assert.equal(s.events[mutation + 1].tool?.name, 'get_exam_health');
  assert.match(s.events.at(-1)!.text, /Partial/);
  h.undo(s.events[mutation].undoId!);
  assert.deepEqual(h.doc.questions, before);
});
test('destructive deletion executes nothing until exact inline confirmation; then undo restores', async () => {
  const h = harness([tool('delete_question', { questionId: 'q1' }), 'Done']);
  const before = structuredClone(h.doc.questions);
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'delete question 1');
  assert.deepEqual(h.doc.questions, before);
  assert.equal(h.snapshots.size, 0);
  assert.ok(s.pending);
  assert.match(s.events.at(-1)!.text, /38 → 37/);
  s.confirmed = true;
  await runAgentTurn(h.runtime, s);
  assert.equal(h.doc.questions.length, 37);
  const mutation = s.events.find(
    (e) => e.tool?.name === 'delete_question' && e.status === 'complete',
  )!;
  h.undo(mutation.undoId!);
  assert.deepEqual(h.doc.questions, before);
});
test('theme through chat validates token/color, applies instantly, settings persist/reload/reset', async () => {
  const h = harness(
    [
      tool('set_theme_token', { token: 'primary', value: '#EAB308' }),
      'Applied; reset in Settings.',
    ],
    67,
  );
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'make the blue yellow');
  assert.equal(h.settings.themeTokens?.primary, '#EAB308');
  const properties = new Map<string, string>();
  const style = {
    setProperty: (k: string, v: string) => properties.set(k, v),
  } as unknown as CSSStyleDeclaration;
  applyTheme(h.settings, style);
  assert.equal(properties.get('--app-primary'), '#EAB308');
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => values.get(k) || null,
    setItem: (k: string, v: string) => values.set(k, v),
  } as unknown as Storage;
  try {
    saveSettings(h.settings);
    assert.equal(loadSettings().themeTokens?.primary, '#EAB308');
    saveSettings({ ...h.settings, themeTokens: {} });
    applyTheme(loadSettings(), style);
    assert.equal(properties.get('--app-primary'), THEME_DEFAULTS.primary);
  } finally {
    globalThis.localStorage = previous;
  }
  const schema = h.runtime.registry.set_theme_token.schema;
  const token = schema.safeParse({ token: 'arbitrary-css', value: '#000' });
  const color = schema.safeParse({
    token: 'primary',
    value: 'url(javascript:bad)',
  });
  assert.equal(token.success, false);
  assert.equal(color.success, false);
  if (!color.success) assert.match(color.error.message, /hex color/);
});
test('no-provider health chip path: zero model/network calls and empty usage', async () => {
  const h = harness([]);
  h.runtime.model = undefined;
  const previous = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => {
    network++;
    throw new Error('no network allowed');
  }) as typeof fetch;
  try {
    const s = newAgentSession(h.doc.id);
    await runAgentTurn(h.runtime, s, 'Check this exam');
    assert.equal(s.calls, 0);
    assert.equal(network, 0);
    assert.equal(h.calls, 0);
    assert.equal(loadUsageLog().length, 0);
    assert.match(s.events.at(-1)!.text, /Configure a model/);
  } finally {
    globalThis.fetch = previous;
  }
});
test('soft cap is read-only and hard bounds stop at ≤6 model and ≤12 tool executions', async () => {
  const h = harness(
    Array(6).fill(tool('rename_exam', { name: 'forbidden by cap' })),
  );
  // Pin the historical 6/12 bound explicitly (E3 raised the defaults to 30/200).
  h.runtime.getSettings().agentLimits = { maxModelCalls: 6, maxToolExecutions: 12 };
  h.runtime.readOnly = () => true;
  const s = newAgentSession(h.doc.id);
  await runAgentTurn(h.runtime, s, 'rename');
  assert.equal(h.calls, 6);
  assert.ok(s.executions <= 12);
  assert.equal(h.doc.displayName, 'Iranian final');
  assert.equal(h.snapshots.size, 0);
  assert.ok(s.events.some((e) => e.text.includes('READ-ONLY')));
  assert.match(s.events.at(-1)!.text, /Bounds reached/);
  const reads = harness(
    Array(6).fill(
      [
        tool('get_exam_health'),
        tool('get_settings_summary'),
        tool('list_missing'),
        tool('get_questions'),
      ].join('\n'),
    ),
  );
  reads.runtime.getSettings().agentLimits = { maxModelCalls: 6, maxToolExecutions: 12 };
  const rs = newAgentSession(reads.doc.id);
  await runAgentTurn(reads.runtime, rs, 'check');
  // E3 — reads are budgeted at READ_WEIGHT (0.25); the raw count may exceed the bound.
  assert.ok((rs.weightedExecutions ?? rs.executions) <= 12);
  assert.ok(reads.calls <= 6);
  assert.ok(rs.events.filter((e) => e.kind === 'tool').length >= 20, 'batched reads all executed');
});
test('one turn per exam lock and human edit during model call pauses without overwriting', async () => {
  let release!: (r: LLMResponse) => void;
  let entered!: () => void;
  const called = new Promise<void>((r) => {
    entered = r;
  });
  const h = harness([
    () => {
      entered();
      return new Promise<LLMResponse>((r) => {
        release = r;
      });
    },
  ]);
  const s = newAgentSession(h.doc.id);
  const promise = runAgentTurn(h.runtime, s, 'rename');
  await called;
  assert.equal(isAgentWorking(h.doc.id), true);
  await assert.rejects(
    runAgentTurn(h.runtime, newAgentSession(h.doc.id), 'second'),
    /working/,
  );
  h.doc = { ...h.doc, displayName: 'Human edit' };
  release(reply(tool('rename_exam', { name: 'Agent edit' })));
  await promise;
  assert.equal(h.doc.displayName, 'Human edit');
  assert.ok(s.events.some((e) => e.text.includes('Human edits detected')));
  assert.equal(isAgentWorking(h.doc.id), false);
});
test('durable resume retains call bounds and never replays uncertain mutation', async () => {
  const h = harness(['No further actions.']);
  const s = newAgentSession(h.doc.id);
  s.calls = 5;
  s.executions = 9;
  s.running = true;
  s.dirty = true;
  s.user = 'resume';
  s.before = healthSummary(h.doc);
  await runAgentTurn(h.runtime, s);
  assert.equal(h.calls, 1);
  assert.equal(s.calls, 6);
  assert.equal(h.snapshots.size, 0);
  assert.ok(s.events.some((e) => e.text.includes('not replayed')));
  assert.equal(h.persisted!.running, false);
  const output = compactResult(
    { lines: ['x'.repeat(20000)] },
    'get_source_lines',
  );
  assert.ok(Math.ceil(output.length / 2) < 600);
  assert.match(JSON.parse(output).more, /call get_source_lines/);
});
test('pack/result byte ceilings hold for worst-case Unicode, escaping and large histories', () => {
  const d = exam();
  d.displayName = '\u0000'.repeat(200);
  d.sections = Array.from({ length: 50 }, (_, i) => ({
    id: `s${i}`,
    title: 'می‌شود'.repeat(100),
    index: i + 1,
    spans: [],
  }));
  const pack = statePack(
    d,
    '\u0000'.repeat(2000),
    Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      kind: 'assistant',
      text: 'ی'.repeat(1000),
    })),
  );
  assert.doesNotThrow(() => JSON.parse(pack));
  assert.ok(new TextEncoder().encode(pack).length <= 1200);
  const result = compactResult(
    { text: 'می‌شود'.repeat(5000) },
    'get_source_lines',
  );
  assert.doesNotThrow(() => JSON.parse(result));
  assert.ok(new TextEncoder().encode(result).length <= 600);
});
test('fresh import creates a health-reportable source-only draft without any provider', async () => {
  const { createLocalDraft } = await import('../src/pipeline/localDraft');
  const original = exam();
  const draft = createLocalDraft({ lines: original.source.lines, pages: 5, ocrUsed: false, fileName: 'iranian.txt', images: [], pageImages: [], scannedPageIndices: [] }, 'abc123abc123');
  assert.equal(draft.id, 'exam_abc123abc123'); assert.equal(healthSummary(draft).expected, 67); assert.equal(healthSummary(draft).parsed, 0); assert.equal(draft.usage.length, 0); assert.equal(draft.flags[0].code, 'SOURCE_ONLY');
});
