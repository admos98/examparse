import React, { useEffect, useRef, useState } from "react";
import { AppSettings, ExamDoc, UsageRecord } from "../types";
import {
  AgentSession,
  healthSummary,
  newAgentSession,
  runAgentTurn,
} from "../pipeline/agent";
import { examContentRevision } from "../pipeline/quality";
import { sha256 } from "../utils/hash";
import { createToolRegistry } from "../pipeline/agentTools";
import { applyTheme } from "../pipeline/agentTheme";
import {
  getPipelineCache,
  setPipelineCache,
  saveExamDoc,
  loadExamDoc,
  loadUsageLog,
  appendUsageRecord,
} from "../store";
import { LLMAdapter } from "../providers/adapter";
import { retryMissingCoverage } from "../pipeline/retryCoverage";
import { calculateActualCost } from "../utils/budget";
import { prepareSectionReparse } from "../pipeline/reparseSection";
import { assistantError, AgentOperationError } from "../pipeline/agentI18n";

type UndoState = Pick<
  ExamDoc,
  | "questions"
  | "sections"
  | "images"
  | "meta"
  | "displayName"
  | "nameSource"
  | "flags"
> & {
  id: string;
  settings: Pick<
    AppSettings,
    "themeTokens" | "uiLanguage" | "defaultExamMode" | "livePanel"
  >;
};
interface Props {
  verifyOnOpen?: boolean;
  mode?: "page" | "panel";
  doc: ExamDoc;
  settings: AppSettings;
  onUpdateDoc: (doc: ExamDoc) => void;
  onSettings: (settings: AppSettings) => void;
  onClose: () => void;
}
export function AssistantView({
  verifyOnOpen,
  mode = "page",
  doc,
  settings,
  onUpdateDoc,
  onSettings,
  onClose,
}: Props) {
  const [session, setSession] = useState<AgentSession>(() =>
    newAgentSession(doc.id),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [envKey, setEnvKey] = useState(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const autoVerified = useRef(false);
  const sessionRef = useRef(session);
  const busyRef = useRef(false);
  const loadedId = useRef("");
  const fa = settings.uiLanguage === "fa";
  const t = (en: string, persian: string) => (fa ? persian : en);
  const health = healthSummary(doc);
  const role = settings.roleMapping.agent || settings.roleMapping.fast;
  const provider = settings.providers.find((p) => p.id === role.providerId);
  const configured = Boolean(
    provider &&
      role.model &&
      (provider.kind === "openai-compatible" ||
        provider.apiKey.trim() ||
        envKey),
  );
  const publish = (value: AgentSession) => {
    sessionRef.current = value;
    setSession({ ...value, events: [...value.events] });
  };
  const persist = async (value: AgentSession) => {
    publish(value);
    await setPipelineCache(`agent:session:${doc.id}`, value);
  };
  async function updateDoc(value: ExamDoc) {
    await saveExamDoc(value, await sha256(examContentRevision(docRef.current)));
    docRef.current = value;
    onUpdateDoc(value);
  }
  async function updateDossier(value: any) {
    try {
      const { saveDossier } = await import('../store');
      await saveDossier(value);
    } catch {}
  }
  async function updateSettings(value: AppSettings) {
    settingsRef.current = value;
    onSettings(value);
    applyTheme(value);
  }
  async function snapshot() {
    const current = docRef.current;
    const s = settingsRef.current;
    const history =
      (await getPipelineCache<UndoState[]>(`agent:undo:${doc.id}`)) || [];
    const id = `undo_${Date.now()}_${history.length}`;
    history.push(
      JSON.parse(
        JSON.stringify({
          id,
          questions: current.questions,
          flags: current.flags,
          sections: current.sections,
          images: current.images.map(({ dataUrl, ...i }) => i),
          meta: current.meta,
          displayName: current.displayName,
          nameSource: current.nameSource,
          settings: {
            themeTokens: s.themeTokens || {},
            uiLanguage: s.uiLanguage || "en",
            defaultExamMode: s.defaultExamMode || "review",
            livePanel: s.livePanel ?? true,
          },
        }),
      ),
    );
    await setPipelineCache(`agent:undo:${doc.id}`, history.slice(-10));
    return id;
  }
  async function undo(id: string) {
    try {
      const snapshot = (
        await getPipelineCache<UndoState[]>(`agent:undo:${doc.id}`)
      )?.find((s) => s.id === id);
      if (!snapshot)
        throw new Error(
          t(
            "Undo snapshot expired (last 10 retained). Use Versions in Step 4.",
            "نسخه بازگشت منقضی شده است؛ از نسخه‌های گام ۴ استفاده کنید.",
          ),
        );
      await updateDoc({
        ...docRef.current,
        questions: snapshot.questions,
        flags: snapshot.flags || docRef.current.flags,
        sections: snapshot.sections,
        meta: snapshot.meta,
        displayName: snapshot.displayName,
        nameSource: snapshot.nameSource,
        images: snapshot.images.map((i) => ({
          ...i,
          dataUrl: `/api/images/${i.blobKey}`,
        })),
      });
      await updateSettings({ ...settingsRef.current, ...snapshot.settings });
      const next = {
        ...sessionRef.current,
        events: [
          ...sessionRef.current.events,
          {
            id: `undo_${Date.now()}`,
            kind: "assistant" as const,
            text: t(
              "Restored pre-action state.",
              "وضعیت پیش از عمل بازیابی شد.",
            ),
          },
        ],
      };
      await persist(next);
    } catch (error) {
      setError(
        assistantError(
          error,
          settingsRef.current.uiLanguage === "fa" ? "fa" : "en",
        ),
      );
    }
  }
  async function run(user?: string, resuming?: AgentSession) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setStream("");
    const working = resuming || sessionRef.current;
    let modelCalls = user !== undefined ? 0 : working.calls;
    const priorTurnCost = user !== undefined ? 0 : working.costUsd;
    const baselineUsage = new Set(loadUsageLog().map((u) => JSON.stringify(u)));
    let monthlySpend = 0;
    const budgetId =
      user !== undefined
        ? `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        : working.turnId;
    const refreshBudget = async () => {
      const budget = await getPipelineCache<{ calls: number }>(
        `agent:budget:${budgetId}`,
      );
      modelCalls = Math.max(modelCalls, budget?.calls || 0);
    };
    const recordUsage = async (usage: UsageRecord) => {
      appendUsageRecord(usage);
      const response = await fetch(`/api/exams/${doc.id}/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(usage),
      });
      if (!response.ok) throw new AgentOperationError("usageWrite");
    };
    const registry = createToolRegistry({
      getDoc: () => docRef.current,
      getSettings: () => settingsRef.current,
      getDossier: () => {
        try {
          const dossierKey = `examparse_dossier_${docRef.current.id}`;
          const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(dossierKey) : null;
          if (raw) return JSON.parse(raw);
        } catch {}
        // fallback: build on fly
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { buildDossier } = require('../pipeline/dossier');
          return buildDossier(docRef.current as any);
        } catch { return undefined; }
      },
      updateDoc,
      updateSettings,
      updateDossier,
      remediationPipeline: async (current) => {
        const { runFullPipeline } = await import('../pipeline/index');
        // Dummy remediation pipeline call: just return health delta
        const { healthSummary } = await import('../pipeline/agent');
        return { health: healthSummary(current), ok:true };
      },
      reparseSection: async (current, sectionId) => {
        try {
          return await prepareSectionReparse({
            doc: current,
            sectionId,
            settings: settingsRef.current,
            agentBudgetId: budgetId,
            recordUsage,
            onLiveText: (_label, channel, text) => {
              if (channel === "output") setStream(text);
            },
          });
        } finally {
          await refreshBudget();
        }
      },
      retryMissing: async (current) => {
        try {
          return await retryMissingCoverage(
            current,
            settingsRef.current,
            undefined,
            (_label, channel, text) => {
              if (channel === "output") setStream(text);
            },
            budgetId,
          );
        } finally {
          await refreshBudget();
        }
      },
    });
    const owner = crypto.randomUUID();
    let leaseHeld = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const lease = async () => {
      const res = await fetch(`/api/agent-lock/${doc.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
    };
    try {
      await lease();
      leaseHeld = true;
      heartbeat = setInterval(() => {
        void lease().catch((e) => {
          active.current = false;
          setError(
            assistantError(
              e,
              settingsRef.current.uiLanguage === "fa" ? "fa" : "en",
            ),
          );
        });
      }, 30000);
      const monthly = await fetch("/api/usage/monthly");
      if (!monthly.ok) throw new AgentOperationError("folderUsage");
      monthlySpend =
        (await monthly.json())[new Date().toISOString().slice(0, 7)] || 0;
      const result = await runAgentTurn(
        {
          isActive: () => active.current,
          refreshDoc: async () => {
            const latest = await loadExamDoc(doc.id);
            if (!latest) throw new AgentOperationError("examMissing");
            docRef.current = latest;
            onUpdateDoc(latest);
          },
          turnId: budgetId,
          getDoc: () => docRef.current,
          getSettings: () => settingsRef.current,
          getDossier: () => {
            try {
              const raw = localStorage.getItem(`examparse_dossier_${docRef.current.id}`);
              if (raw) return JSON.parse(raw);
            } catch {}
            try { const { buildDossier } = require('../pipeline/dossier'); return buildDossier(docRef.current as any); } catch { return undefined; }
          },
          registry,
          persist,
          emit: publish,
          snapshot,
          totalModelCalls: () => modelCalls,
          totalCostUsd: () =>
            priorTurnCost +
            loadUsageLog()
              .filter(
                (u) =>
                  u.role === "agent" && !baselineUsage.has(JSON.stringify(u)),
              )
              .reduce((n, u) => n + (u.costUsd || 0), 0),
          readOnly: () => {
            const s = settingsRef.current;
            const cap = s.assistantMonthlySoftCapUsd;
            return (
              cap !== undefined &&
              monthlySpend +
                loadUsageLog()
                  .filter(
                    (u) =>
                      u.role === "agent" &&
                      !baselineUsage.has(JSON.stringify(u)) &&
                      u.ts.slice(0, 7) === new Date().toISOString().slice(0, 7),
                  )
                  .reduce((n, u) => n + (u.costUsd || 0), 0) >=
                cap
            );
          },
          model:
            configured && provider
              ? async (system, text) => {
                  const currentSettings = settingsRef.current;
                  const selection =
                    currentSettings.roleMapping.agent ||
                    currentSettings.roleMapping.fast;
                  // Freeze provider for this turn: chat cannot change it.
                  const response = await LLMAdapter.execute(
                    {
                      role: "agent",
                      system,
                      text,
                      maxOutputTokens: currentSettings.budget.maxOutputTokens,
                      label: "Assistant turn",
                      providerConfig: {
                        ...provider,
                        structuredOutputs: false,
                        model: selection.model,
                        agentBudgetId: budgetId,
                      },
                    },
                    {
                      onDelta: (channel, full) => {
                        if (channel === "output") setStream(full);
                      },
                    },
                  ).finally(refreshBudget);
                  modelCalls = Math.max(modelCalls, working.calls);
                  const usage: UsageRecord = {
                    ts: new Date().toISOString(),
                    role: "agent",
                    provider: provider.name,
                    model: selection.model,
                    ...response.usage,
                    costUsd: calculateActualCost(
                      response.usage.inputTokens,
                      response.usage.outputTokens,
                      selection.model,
                      currentSettings.costTable,
                    ),
                    label: "Assistant turn",
                  };
                  working.costUsd += usage.costUsd || 0;
                  await recordUsage(usage);
                  publish(working);
                  setStream("");
                  return response;
                }
              : undefined,
        },
        working,
        user,
      );
      await persist(result);
    } catch (error) {
      setError(
        assistantError(
          error,
          settingsRef.current.uiLanguage === "fa" ? "fa" : "en",
        ),
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (leaseHeld)
        await fetch(`/api/agent-lock/${doc.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner }),
        }).catch(() => undefined);
      busyRef.current = false;
      setBusy(false);
      setStream("");
    }
  }
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [stored, info] = await Promise.all([
        getPipelineCache<AgentSession>(`agent:session:${doc.id}`),
        fetch("/api/storage/health").then((r) => r.json()),
      ]);
      if (!mounted) return;
      setEnvKey(Boolean(info.defaultGeminiConfigured));
      const value = stored || newAgentSession(doc.id);
      publish(value);
      setReady(true);
      // Resume is explicit so a reload never silently sends a provider request.
      loadedId.current = doc.id;
    })().catch((e) =>
      setError(
        assistantError(
          e,
          settingsRef.current.uiLanguage === "fa" ? "fa" : "en",
        ),
      ),
    );
    return () => {
      mounted = false;
    };
  }, [doc.id]);
  useEffect(() => {
    if (
      ready &&
      verifyOnOpen &&
      !autoVerified.current &&
      !sessionRef.current.running &&
      !sessionRef.current.pending
    ) {
      autoVerified.current = true;
      void run(t("Check this exam end-to-end", "این آزمون را کامل بررسی کن"));
    }
  }, [ready, verifyOnOpen]);
  return (
    <section
      aria-label={t("Exam assistant", "دستیار آزمون")}
      data-assistant-mode={mode}
      className={
        mode === "panel"
          ? "fixed right-0 top-0 bottom-0 w-full sm:w-[480px] z-50 bg-white dark:bg-slate-950 border-l shadow-2xl flex flex-col"
          : "max-w-5xl mx-auto w-full border rounded-2xl bg-white dark:bg-slate-950 flex flex-col h-[calc(100dvh-9rem)] min-h-[500px]"
      }
      dir={fa ? "rtl" : "ltr"}
    >
      <header className="p-4 border-b flex justify-between items-center">
        <div>
          <h2 className="font-bold">{t("Assistant", "دستیار")}</h2>
          <p className="text-xs">
            ${session.costUsd.toFixed(5)} {t("this turn", "این نوبت")} ·{" "}
            {session.calls}/{(settings.agentLimits?.maxModelCalls ?? 25)} {t("model calls", "فراخوانی مدل")}
          </p>
        </div>
        <button
          disabled={busy}
          onClick={onClose}
          className="p-2 border rounded"
        >
          {mode === "page"
            ? t("Back to exam", "بازگشت به آزمون")
            : t("Close", "بستن")}
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4 space-y-3" aria-live="polite">
        <p className="text-xs text-slate-500">
          {t(
            "Chats send only the summaries and slices you ask about to your configured model — your files stay in the local folder.",
            "گفت‌وگو فقط خلاصه‌ها و بخش‌هایی را که می‌خواهید به مدل تنظیم‌شده می‌فرستد — فایل‌ها در پوشه محلی می‌مانند.",
          )}
        </p>
        {session.events.map((event) => (
          <div
            key={event.id}
            className={`p-3 rounded-xl text-xs whitespace-pre-wrap break-words border ${event.kind === "user" ? "bg-blue-50 dark:bg-slate-800" : event.kind === "error" ? "border-red-400" : ""}`}
          >
            {event.tool && (
              <b>
                {event.tool.name} →{" "}
                {event.status === "complete"
                  ? t("complete", "انجام شد")
                  : event.status === "refused"
                    ? t("refused", "رد شد")
                    : event.status === "preparing"
                      ? t("preparing", "در حال آماده‌سازی")
                      : t("confirmation required", "نیازمند تایید")}
                <br />
              </b>
            )}
            {event.text}
            {event.undoId && (
              <button
                disabled={busy}
                onClick={() => void undo(event.undoId!)}
                className="block underline mt-2"
              >
                {t("Undo", "بازگردانی")}
              </button>
            )}
          </div>
        ))}
        {session.pending && !busy && (
          <div className="border border-amber-500 p-3 rounded-xl text-xs">
            <p>
              {t(
                "Only the action shown above will execute. Verify the exact question/count.",
                "فقط عمل بالا اجرا می‌شود. سوال و تعداد را بررسی کنید.",
              )}
            </p>
            {session.prepared && (
              <p className="my-2 text-slate-500">
                {t(
                  "Preparation usage is already logged. Cancel discards the candidate, not the usage audit.",
                  "مصرف آماده‌سازی ثبت شده است. لغو فقط نسخه پیشنهادی را کنار می‌گذارد، نه گزارش مصرف را.",
                )}
              </p>
            )}
            {session.prepared && (
              <details className="my-3 border rounded p-2" open>
                <summary>
                  {t(
                    "Exact section diff — all fields, before / after",
                    "تفاوت دقیق بخش — همه فیلدها، پیش و پس",
                  )}
                </summary>
                <div className="grid md:grid-cols-2 gap-3 mt-2">
                  {(["before", "after"] as const).map((side) => (
                    <div key={side}>
                      <h3 className="font-bold">
                        {side === "before"
                          ? t("Before", "پیش از تغییر")
                          : t("After", "پس از تغییر")}
                      </h3>
                      <pre
                        dir="ltr"
                        className="text-[11px] whitespace-pre-wrap break-words max-h-96 overflow-auto bg-slate-50 dark:bg-slate-900 p-2"
                      >
                        {JSON.stringify(session.prepared!.diff[side], null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <button
              className="border p-2 mr-2"
              onClick={() => {
                const s = sessionRef.current;
                s.confirmed = true;
                void run(undefined, s);
              }}
            >
              {t("Confirm", "تایید")}
            </button>
            <button
              className="border p-2"
              onClick={() => {
                const s = sessionRef.current;
                s.pending = undefined;
                s.prepared = undefined;
                s.confirmed = false;
                s.running = false;
                void persist(s);
              }}
            >
              {t("Cancel", "لغو")}
            </button>
          </div>
        )}
        {session.running && !busy && (
          <button
            className="border p-2"
            onClick={() => void run(undefined, sessionRef.current)}
          >
            {t("Resume interrupted turn", "ادامه نوبت قطع‌شده")}
          </button>
        )}
        {stream && <p className="text-xs whitespace-pre-wrap">{stream}</p>}
        {busy && <p>{t("Assistant is working…", "دستیار در حال کار است…")}</p>}
        {error && (
          <p role="alert" className="text-red-600 text-xs">
            {error}
          </p>
        )}
      </div>
      <div className="p-4 border-t space-y-2">
        <div className="flex flex-wrap gap-2 text-xs">
          {health.missing.length > 0 && (
            <button
              disabled={busy || !ready || Boolean(session.pending)}
              className="border rounded p-2"
              onClick={() =>
                void run(
                  t(
                    `Why are ${health.missing.length} questions missing? Fix the missing questions.`,
                    `چرا ${health.missing.length} سوال جا افتاده؟ سوال‌های جاافتاده را اصلاح کن.`,
                  ),
                )
              }
            >
              {t(
                `Fix ${health.missing.length} missing questions`,
                `اصلاح ${health.missing.length} سوال جاافتاده`,
              )}
            </button>
          )}
          {health.unplacedImages > 0 && (
            <button
              disabled={busy || !ready || Boolean(session.pending)}
              className="border rounded p-2"
              onClick={() =>
                void run(
                  t("Place the orphan images", "تصاویر بی‌جایگاه را قرار بده"),
                )
              }
            >
              {t("Place orphan images", "جای‌گذاری تصاویر")}
            </button>
          )}
          <button
            disabled={busy || !ready || Boolean(session.pending)}
            className="border rounded p-2"
            onClick={() =>
              void run(
                t("Check this exam end-to-end", "این آزمون را کامل بررسی کن"),
              )
            }
          >
            {t("Check this exam end-to-end", "بررسی کامل آزمون")}
          </button>
        </div>
        {!configured && (
          <p className="text-xs">
            {t(
              "Configure a model to chat. Health chips work locally.",
              "برای گفت‌وگو مدل را تنظیم کنید؛ بررسی سلامت محلی است.",
            )}
          </p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || sessionRef.current.pending) return;
            const message = input;
            setInput("");
            void run(message);
          }}
        >
          <input
            aria-label={t("Message assistant", "پیام به دستیار")}
            disabled={busy || !ready || !configured || Boolean(session.pending)}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="min-w-0 flex-1 border rounded-xl p-3 text-sm"
            placeholder={t("Ask about this exam…", "درباره آزمون بپرسید…")}
          />
          <button
            disabled={busy || !configured || !ready || Boolean(session.pending)}
            className="border rounded-xl p-3"
          >
            {t("Send", "ارسال")}
          </button>
        </form>
      </div>
    </section>
  );
}
