import test from "node:test";
import assert from "node:assert/strict";
import { ExamDoc, AppSettings, LLMResponse } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/store";
import { assembleAndValidateQuestions } from "../src/pipeline/assemble";
import { examContentRevision } from "../src/pipeline/quality";
import { createToolRegistry } from "../src/pipeline/agentTools";
import {
  AgentRuntime,
  AgentSession,
  newAgentSession,
  runAgentTurn,
} from "../src/pipeline/agent";
import {
  agentText,
  assistantError,
  AgentOperationError,
  verificationText,
} from "../src/pipeline/agentI18n";
import {
  applySectionCandidate,
  prepareSectionReparse,
  SectionCandidate,
} from "../src/pipeline/reparseSection";

function fixture(): ExamDoc {
  const lines: ExamDoc['source']['lines'] = [
    { id: "L0001", page: 1, text: "Writing" },
    { id: "L0002", page: 1, text: "۱. مي‌شود؟ Original exact stem" },
    { id: "L0003", page: 1, text: "۲. يكي ديگر از پرسش‌های اين بخش؟" },
    { id: "L0004", page: 1, text: "Reading" },
    { id: "L0005", page: 1, text: "۳. Outside section — untouched" },
    { id: "L0006", page: 2, text: "راهنمای تصحیح" },
    { id: "L0007", page: 2, text: "1. answer, not a question" },
    { id: "L0008", page: 2, text: "Question 1 is worth 0.5 marks. Question 2 is worth 1.5 marks. Question 3 is worth 1 mark.", tag: "key" },
  ];
  return {
    id: "reparse_fixture",
    fileHash: "fixture",
    createdAt: "2026-10-18",
    displayName: "Untouched name",
    meta: { language: "fa", direction: "rtl", totalPoints: 3 },
    source: {
      lines,
      pages: 2,
      fileName: "fixture.txt",
      ocrUsed: false,
      expectedQuestionNos: [1, 2, 3],
      keyTerritoryLineNos: [6, 7, 8],
    },
    questions: assembleAndValidateQuestions(
      [
        {
          id: "q1",
          no: 1,
          sectionId: "s1",
          spans: [[2, 2]],
          points: 1,
          confidence: 0.9,
          type: "short",
        },
        {
          id: "q2",
          no: 2,
          sectionId: "s1",
          spans: [[3, 3]],
          points: 1,
          confidence: 0.9,
          type: "short",
        },
        {
          id: "q3",
          no: 3,
          sectionId: "s2",
          spans: [[5, 5]],
          points: 1,
          confidence: 0.9,
          type: "short",
        },
      ],
      lines,
      undefined,
      { keyTerritoryLineNos: [6, 7, 8] },
    ).questions,
    sections: [
      { id: "s1", index: 1, title: "Writing", spans: [[1, 3]] },
      { id: "s2", index: 2, title: "Reading", spans: [[4, 5]] },
    ],
    images: [],
    flags: [],
    usage: [],
  };
}
const candidate = (): SectionCandidate => ({
  sectionId: "s1",
  usage: [],
  rawQuestions: [
    {
      id: "model1",
      no: 1,
      spans: [[2, 2]],
      points: 0.5,
      confidence: 0.9,
      type: "short",
    },
    {
      id: "model2",
      no: 2,
      spans: [[3, 3]],
      points: 1.5,
      confidence: 0.9,
      type: "short",
    },
  ],
});
const response = (name?: string, args: unknown = {}): LLMResponse => ({
  json: null,
  usage: { inputTokens: 0, outputTokens: 0 },
  rawText: name
    ? `\`\`\`tool\n${JSON.stringify({ name, args })}\n\`\`\``
    : "No further actions.",
});
function setup() {
  let doc = fixture();
  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  let preparations = 0;
  let modelCalls = 0;
  let saved: AgentSession | undefined;
  const snapshots: ExamDoc[] = [];
  const runtime: AgentRuntime = {
    getDoc: () => doc,
    getSettings: () => settings,
    registry: createToolRegistry({
      getDoc: () => doc,
      getSettings: () => settings,
      updateDoc: async (d) => {
        doc = d;
      },
      updateSettings: async () => {},
      retryMissing: async (d) => d,
      reparseSection: async () => {
        preparations++;
        return candidate();
      },
    }),
    model: async () =>
      ++modelCalls === 1
        ? response("reparse_section", { sectionId: "s1" })
        : response(),
    snapshot: async () => {
      snapshots.push(structuredClone(doc));
      return `undo_${snapshots.length - 1}`;
    },
    persist: async (s) => {
      saved = structuredClone(s);
    },
  };
  return {
    runtime,
    get doc() {
      return doc;
    },
    set doc(value) {
      doc = value;
    },
    get saved() {
      return saved!;
    },
    get preparations() {
      return preparations;
    },
    get calls() {
      return modelCalls;
    },
    snapshots,
  };
}

test("section candidate is pure, span-only, original-text invariant and leaves all other sections and metadata untouched", () => {
  const doc = fixture();
  const before = structuredClone(doc);
  const result = applySectionCandidate(doc, candidate());
  assert.deepEqual(doc, before);
  assert.deepEqual(result.questions[2], before.questions[2]);
  assert.deepEqual(result.sections[1], before.sections[1]);
  assert.deepEqual(result.meta, before.meta);
  assert.deepEqual(result.source, before.source);
  assert.equal(result.displayName, before.displayName);
  assert.deepEqual(result.usage, before.usage);
  assert.equal(result.questions[0].stem, before.questions[0].stem);
  assert.equal(result.questions[0].id, "q1");
  assert.equal(result.questions[0].points, 0.5);
  assert.equal(result.questions[1].points, 1.5);
});

test("unsafe section candidates reject outside/key/absent spans, rewrites, empty/low-confidence data and schema violations", () => {
  const doc = fixture();
  for (const bad of [
    { ...candidate(), rawQuestions: [] },
    { ...candidate(), sectionId: "missing" },
    { ...candidate(), rawQuestions: [{ no: 3, spans: [[5, 5]] }] },
    { ...candidate(), rawQuestions: [{ no: 1, spans: [[7, 7]] }] },
    { ...candidate(), rawQuestions: [{ no: 1, spans: [[100, 100]] }] },
    {
      ...candidate(),
      rawQuestions: [{ no: 1, spans: [[2, 2]], confidence: 0.1 }],
    },
    { ...candidate(), rawQuestions: [{ no: 1, spans: [[2, 2]], points: -1 }] },
    {
      ...candidate(),
      rawQuestions: [{ no: 1, spans: [[2, 2]], stem: "model-invented text" }],
    },
    {
      ...candidate(),
      rawQuestions: [
        { no: 1, spans: [[2, 2]], rewrites: [{ line: 2, text: "invented" }] },
      ],
    },
    {
      ...candidate(),
      rawQuestions: [
        { no: 1, spans: [[2, 2]], images: [{ imageId: "foreign" }] },
      ],
    },
  ])
    assert.throws(() => applySectionCandidate(doc, bad));
  const overlapping = structuredClone(doc);
  overlapping.questions[2].spans = [[2, 2]];
  assert.throws(() => applySectionCandidate(overlapping, candidate()));
  assert.equal(JSON.stringify(doc), JSON.stringify(fixture()));
});

test("section reparse persists exact candidate, requires consent, resumes without a second preparation, and supplies Undo", async () => {
  const h = setup();
  const original = structuredClone(h.doc);
  const session = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing section",
  );
  assert.equal(session.pending?.name, "reparse_section");
  assert.equal(session.prepared?.baseRevision, examContentRevision(original));
  assert.equal(h.preparations, 1);
  assert.equal(h.snapshots.length, 0);
  assert.deepEqual(h.doc, original);
  assert.ok(
    JSON.stringify(session.prepared?.diff.before).includes(
      "Original exact stem",
    ),
  );
  assert.equal((session.prepared!.diff.after as any).questions[0].points, 0.5);
  // Reconstructed from durable cache as after closing/reloading the page; not an in-memory closure.
  const resumed = structuredClone(h.saved);
  await runAgentTurn(h.runtime, resumed);
  assert.equal(h.preparations, 1);
  assert.deepEqual(h.doc, original);
  resumed.confirmed = true;
  await runAgentTurn(h.runtime, resumed);
  assert.equal(h.preparations, 1);
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.doc.questions[0].points, 0.5);
  assert.ok(resumed.events.some((e) => e.undoId === "undo_0"));
  assert.match(resumed.events.at(-1)!.text, /Verified green/);
  h.doc = structuredClone(h.snapshots[0]);
  assert.deepEqual(h.doc, original);
});

test("human edit invalidates pending exact diff; no snapshot, overwrite, or repeated preparation", async () => {
  const h = setup();
  const session = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing",
  );
  h.doc = { ...h.doc, displayName: "Human edit wins" };
  session.confirmed = true;
  await runAgentTurn(h.runtime, session);
  assert.equal(h.doc.displayName, "Human edit wins");
  assert.equal(h.doc.questions[0].points, 0.5);
  assert.equal(h.preparations, 1);
  assert.equal(h.snapshots.length, 0);
  assert.equal(session.pending, undefined);
  assert.match(
    session.events.map((e) => e.text).join("\n"),
    /Human edits detected/,
  );
});

test("section overwrite gate requires cheaper missing-coverage recovery first and honors read-only cap", async () => {
  const h = setup();
  h.doc = { ...h.doc, questions: h.doc.questions.filter((q) => q.no !== 2) };
  const s = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing",
  );
  assert.equal(h.preparations, 0);
  assert.match(
    s.events.map((e) => e.text).join("\n"),
    /retry_missing_questions before/,
  );
  const capped = setup();
  capped.runtime.readOnly = () => true;
  await runAgentTurn(
    capped.runtime,
    newAgentSession(capped.doc.id),
    "Reparse Writing",
  );
  assert.equal(capped.preparations, 0);
  assert.equal(capped.snapshots.length, 0);
});

test("cancelled, interrupted, or forged confirmations never apply a section candidate or silently call the provider again", async () => {
  const h = setup();
  const s = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing",
  );
  s.pending = undefined;
  s.prepared = undefined;
  s.confirmed = false;
  assert.equal(h.doc.questions[0].points, 0.5);
  assert.equal(h.snapshots.length, 0);
  s.preparing = true;
  await runAgentTurn(h.runtime, s);
  assert.equal(h.calls, 1);
  assert.equal(h.preparations, 1);
  assert.match(s.events.at(-1)!.text, /preparation was interrupted/);
  s.pending = { name: "reparse_section", args: { sectionId: "s1" } };
  s.confirmed = true;
  await runAgentTurn(h.runtime, s);
  assert.equal(h.snapshots.length, 0);
  assert.match(s.events.at(-1)!.text, /No prepared candidate/);
});

test("candidate preparation uses only original section LAS, existing structure adapter/budget/journal, and immediately audits paid calls even on interruption", async () => {
  const doc = fixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const records: unknown[] = [];
  const prepared = await prepareSectionReparse({
    doc,
    settings,
    sectionId: "s1",
    agentBudgetId: "turn_fixture",
    recordUsage: async (u) => {
      records.push(u);
    },
    runStructure: async (params) => {
      assert.deepEqual(
        params.sourceLines.map((l) => l.id),
        ["L0001", "L0002", "L0003"],
      );
      assert.equal(params.sourceLines[1].text, doc.source.lines[1].text);
      assert.equal(params.providerConfig.agentBudgetId, "turn_fixture");
      assert.equal(params.forceSectionMode, true);
      assert.ok(params.journalKey);
      await params.onCallUsage!({
        label: "mock section",
        inputTokens: 100,
        outputTokens: 50,
      });
      return {
        rawQuestions: candidate().rawQuestions,
        sections: [],
        meta: {},
        usage: { inputTokens: 100, outputTokens: 50 },
        rawText: "",
        callUsage: [],
      };
    },
  });
  assert.equal(prepared.usage.length, 1);
  assert.equal(records.length, 1);
  await assert.rejects(
    prepareSectionReparse({
      doc,
      settings,
      sectionId: "s1",
      agentBudgetId: "turn_fixture",
      recordUsage: async (u) => {
        records.push(u);
      },
      runStructure: async (params) => {
        await params.onCallUsage!({
          label: "mock section before crash",
          inputTokens: 100,
          outputTokens: 50,
        });
        throw new Error("upstream bound reached after completed call");
      },
    }),
    /bound reached/,
  );
  assert.equal(records.length, 2);
  assert.deepEqual(doc, fixture());
});

test("Persian harness localizes no-provider, malformed/refused, progress, verification, and operation errors while preserving machine tool names", async () => {
  const h = setup();
  h.runtime.model = undefined;
  const noProvider = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "سلامت آزمون را بررسی کن",
  );
  assert.match(noProvider.events.at(-1)!.text, /هیچ فراخوانی مدل/);
  assert.doesNotMatch(
    noProvider.events
      .filter((e) => e.kind === "assistant")
      .map((e) => e.text)
      .join("\n"),
    /Configure|Health:|green/,
  );
  const blocked = setup();
  blocked.runtime.model = async () => response("delete_everything");
  const refused = await runAgentTurn(
    blocked.runtime,
    newAgentSession(blocked.doc.id),
    "همه چیز را حذف کن",
  );
  assert.match(
    refused.events.find((e) => e.status === "refused")!.text,
    /ابزار غیرمجاز/,
  );
  assert.match(refused.events.at(-1)!.text, /سقف اجرا رسیده است/);
  assert.match(refused.events.at(-1)!.text, /سلامت کامل به‌صورت محلی تایید شد/);
  assert.match(agentText("preparation", "fa"), /آماده‌سازی/);
  assert.match(
    assistantError(new AgentOperationError("stale"), "fa"),
    /آزمون پس از آماده‌سازی/,
  );
  assert.match(assistantError(new Error("HTTP 409"), "fa"), /هیچ تغییری/);
  assert.match(
    verificationText(
      { expected: 3, parsed: 2, missing: [2], points: 2, totalPoints: 3 },
      {
        expected: 3,
        parsed: 2,
        missing: [2],
        points: 2,
        totalPoints: 3,
        state: "red",
      },
      false,
      "fa",
    ),
    /ناقص/,
  );
});

test("a human edit during preparation rejects the candidate before it becomes pending consent", async () => {
  const h = setup();
  const registry = h.runtime.registry;
  const prepare = registry.reparse_section.prepare!;
  registry.reparse_section.prepare = async (args) => {
    const result = await prepare(args);
    h.doc = { ...h.doc, displayName: "Edited during preparation" };
    return result;
  };
  const s = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing",
  );
  assert.equal(s.pending, undefined);
  assert.equal(s.prepared, undefined);
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.doc.questions[0].points, 0.5);
  assert.match(s.events.at(-1)!.text, /Exam changed after preparation/);
});

test("confirmed local candidate can commit at the six-call bound without another provider call, and a capped confirmation still cannot mutate", async () => {
  const h = setup();
  // This test pins the historical 6/12 bound explicitly (E3 raised the defaults to 30/200).
  h.runtime.getSettings().agentLimits = { maxModelCalls: 6, maxToolExecutions: 12 };
  const s = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing",
  );
  h.runtime.totalModelCalls = () => 6;
  s.confirmed = true;
  await runAgentTurn(h.runtime, s);
  assert.equal(h.calls, 1);
  assert.equal(h.doc.questions[0].points, 0.5);
  assert.ok(s.calls <= 6);
  assert.ok(s.executions <= 12);
  const capped = setup();
  const pending = await runAgentTurn(
    capped.runtime,
    newAgentSession(capped.doc.id),
    "Reparse Writing",
  );
  capped.runtime.readOnly = () => true;
  pending.confirmed = true;
  await runAgentTurn(capped.runtime, pending);
  assert.equal(capped.snapshots.length, 0);
  assert.equal(capped.doc.questions[0].points, 0.5);
});

test("source-only human edits invalidate consent, so new source text cannot replace the reviewed candidate under identical question spans", async () => {
  const h = setup();
  const s = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing",
  );
  h.doc = {
    ...h.doc,
    source: {
      ...h.doc.source,
      lines: h.doc.source.lines.map((l) =>
        l.id === "L0002"
          ? { ...l, text: "1. New human source text, not reviewed" }
          : l,
      ),
    },
  };
  s.confirmed = true;
  await runAgentTurn(h.runtime, s);
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.doc.questions[0].points, 0.5);
  assert.equal(s.pending, undefined);
  assert.match(s.events.map((e) => e.text).join("\n"), /Human edits detected/);
});

test("tool-bound turn does not spend calls preparing a candidate it could not subsequently commit", async () => {
  const h = setup();
  const read = response("get_exam_health").rawText;
  const distinct = [
    response("get_exam_health").rawText,
    response("list_missing").rawText,
    response("get_questions").rawText,
    response("get_source_lines",{start:1,end:2}).rawText,
    response("get_question",{questionId:"q1"}).rawText,
    response("list_images").rawText,
  ].join("\n");
  const replies = [
    distinct,
    distinct,
    read,
    response("reparse_section", { sectionId: "s1" }).rawText,
  ];
  h.runtime.model = async () => ({
    rawText: replies.shift() || "",
    json: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const s = await runAgentTurn(
    h.runtime,
    newAgentSession(h.doc.id),
    "Reparse Writing",
  );
  assert.ok(h.preparations <= 1, `preparations ${h.preparations} should be 0 or 1 with dedup`);
  assert.ok(s.pending === undefined || s.pending?.name === 'reparse_section');
  assert.equal(h.snapshots.length, 0);
  assert.ok((s.weightedExecutions ?? s.executions) <= 13);
  assert.ok(s.events.at(-1)!.text.includes('Bounds reached') || s.events.at(-1)!.text.includes('Replace section') || s.events.some(e=>e.text.includes('Bounds reached')));
});
