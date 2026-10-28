/** The harness: one place where memory is matched before a job, injected into the
 * call, and credited/blamed from the OUTCOME afterwards (B2/C4). It also owns the
 * run journal write and the fire-and-forget reflection trigger (D3).
 *
 * Memory is ADVISORY (E1): nothing here can change health, confirmations or caps —
 * the deterministic gates in pipeline/quality, pipeline/agent and server.ts run
 * exactly as before regardless of what any lesson says.
 */
import { estimateTokens } from './tokens';
import { deriveDocTraits } from './docTraits';
import {
  ASSISTANT_PLAYBOOK_CAP, PLAYBOOK_CAP_TOKENS, loadMemoryConfig, loadPlaybook, matchedEntryIds,
  postCredit, logActivity, selectPlaybookEntries,
  type PlaybookCtx, type PlaybookInjection,
} from './playbook';
import {
  applySkillOutcome, evaluateSkillStaleness, formatSkillsForInjection, loadSkills, saveSkill,
  selectSkillsFromPool, type ParsedSkill, type SkillSelectionCtx,
} from './skills';
import { appendRunEntry, buildRunEntry, jobIsInteresting, loadRuns, makeJobId, type RunJournalEntry } from './runs';
import { serializeSkill } from './lint';
import { scheduleReflection, type ReflectionDeps } from './reflection';
import { guidanceDigestLine } from './guidance';
import type { DocTraits } from './types';

export const USER_CORRECTION_WINDOW_MS = 10 * 60 * 1000; // D3

export interface JobHandle {
  jobId: string;
  kind: 'pipeline' | 'remediation' | 'assistant';
  examId?: string;
  startedAt: number;
  docTraits: DocTraits;
  models: Record<string, string>;
  /** Playbook entries in scope BEFORE the job — credited/blamed from the outcome. */
  matchedPlaybookIds: string[];
  playbook: PlaybookInjection;
  skills: Array<{ slug: string; draftShadow: boolean; tokens: number }>;
  skillsBlock: string;
  guidanceTokens: number;
  ladderPath: string[];
  flagsRaised: string[];
  /** Post-job baseline revision for the 10-minute user-correction window. */
  baselineRevision?: string;
  baselineTs?: string;
}

export interface BeginJobParams {
  kind: JobHandle['kind'];
  examId?: string;
  sourceLines?: any[];
  images?: any[];
  sections?: any[];
  pages?: number;
  languageHint?: string;
  modelId?: string;
  models?: Record<string, string>;
  role?: string;
  /** Assistant-only selection context (C3). Pipeline calls get playbook only (D1). */
  userMessage?: string;
  health?: any;
  openIssueCodes?: string[];
  capTokens?: number;
  skillsCapTokens?: number;
}

/** Assemble guidance for a job. Empty memory ⇒ empty blocks ⇒ prompts unchanged (D4). */
export async function beginJob(params: BeginJobParams): Promise<JobHandle> {
  const jobId = makeJobId(params.kind);
  const docTraits = deriveDocTraits({
    sourceLines: params.sourceLines || [],
    images: params.images || [],
    sections: params.sections || [],
    pages: params.pages,
    languageHint: params.languageHint,
  });
  const models: Record<string, string> = params.models || (params.modelId ? { [params.role || 'fast']: params.modelId } : {});
  // A4 — the assistant rides a re-budgeted cap (playbook ≤1,500 tok); pipeline calls use the full ≤5,000.
  const ctx: PlaybookCtx = {
    modelId: params.modelId, docTraits,
    role: params.role || (params.kind === 'assistant' ? 'agent' : 'fast'),
    capTokens: params.capTokens ?? (params.kind === 'assistant' ? ASSISTANT_PLAYBOOK_CAP : PLAYBOOK_CAP_TOKENS),
  };

  const config = await loadMemoryConfig().catch(() => ({ learningEnabled: true, reflectionEnabled: true }));
  let playbook: PlaybookInjection = { block: '', tokens: 0, included: [], omittedCount: 0, omittedIds: [], digest: 'Guidance: playbook 0 entries (0 tok).' };
  let matchedPlaybookIds: string[] = [];
  let skills: Array<{ slug: string; draftShadow: boolean; tokens: number }> = [];
  let skillsBlock = '';
  if (config.learningEnabled) {
    const file = await loadPlaybook().catch(() => ({ version: 1 as const, entries: [] }));
    matchedPlaybookIds = matchedEntryIds(file, ctx);
    playbook = selectPlaybookEntries(file, ctx);
    if (params.kind === 'assistant') {
      const skillCtx: SkillSelectionCtx = {
        userMessage: params.userMessage, health: params.health, docTraits,
        openIssueCodes: params.openIssueCodes, roles: ['agent'],
      };
      const pool: ParsedSkill[] = await loadSkills().catch(() => []);
      const selection = selectSkillsFromPool(pool, skillCtx, params.skillsCapTokens);
      skills = selection.selected.map(item => ({ slug: item.skill.meta.slug, draftShadow: item.draftShadow, tokens: estimateTokens(item.skill.body) }));
      skillsBlock = formatSkillsForInjection(selection.selected);
    }
  }
  return {
    jobId, kind: params.kind, examId: params.examId, startedAt: Date.now(), docTraits, models,
    matchedPlaybookIds, playbook, skills, skillsBlock,
    guidanceTokens: playbook.tokens + estimateTokens(skillsBlock),
    ladderPath: [], flagsRaised: [],
  };
}

/** B1 — reflection cost lands in the usage log under the label "Reflection". */
async function defaultReflectionUsageLogger(record: { label: string; inputTokens: number; outputTokens: number; costUsd?: number; provider?: string; model?: string }): Promise<void> {
  try {
    await fetch('/api/usage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ts: new Date().toISOString(), role: 'fast',
        provider: record.provider || 'unknown', model: record.model || 'unknown',
        inputTokens: record.inputTokens, outputTokens: record.outputTokens,
        costUsd: record.costUsd || 0, label: record.label,
      }),
    });
  } catch { /* offline — usage logging is best-effort */ }
}

export interface EndJobParams {
  health: any;
  verifierDefects?: number;
  defectFixRates?: { localFixed: number; cloudFixed: number; teacherLeft: number };
  /** Godlike-1 C3: key-table answer agreement for this job. */
  answerAccuracy?: { checked: number; agreed: number; corrected: number; conflicts: number };
  /** #43: decision-audit statistics for this job (scoreboard, per decide model). */
  audit?: { decisions: number; catches: number; uncertain: number };
  readPageOutcomes?: Array<{ format: 'compact' | 'verbose'; outcome: 'ok' | 'ok-reconciled' | 'partial' | 'failed' }>;
  calls: number;
  tokens: { input: number; output: number; cached?: number };
  costUsd: number;
  ladderPath?: string[];
  flagsRaised?: string[];
  isCacheHit?: boolean;
  toolRefused?: boolean;
  userCorrections?: number;
  transcriptSummary?: string;
  cleanJobIndex?: number;
  baselineRevision?: string;
  /** Source text lines (strings) for the E3 ≥12-word quote check during reflection. Never persisted. */
  sourceLines?: string[];
  /** B1 — the monthly soft cap is exhausted: reflection must not run. */
  monthlyCapExhausted?: boolean;
  /** Usage sink for the "Reflection" label (defaults to POST /api/usage). */
  logUsage?: (record: { label: string; inputTokens: number; outputTokens: number; costUsd?: number; provider?: string; model?: string }) => void;
  /** Reflection deps (model injection for tests/bench). */
  reflection?: ReflectionDeps;
  settings?: any;
  /** When false, no journal/reflection/credit happens (learning disabled). */
  learningEnabled?: boolean;
}

export interface EndJobResult {
  entry: RunJournalEntry;
  credited: boolean;
  transitions: Array<{ id: string; from: string; to: string }>;
  pruned: string[];
  reflectionScheduled: boolean;
  interesting: boolean;
  reasons: string[];
}

/** Outcome → success/failure for matched entries (B2):
 * green health + no user correction = success; non-green or correction = failure. */
export function outcomeIsSuccess(health: any, userCorrections: number): boolean {
  const state = String(health?.state || 'amber');
  const missing = Array.isArray(health?.missing) ? health.missing.length : 0;
  return state === 'green' && missing === 0 && (userCorrections || 0) === 0;
}

export async function endJob(handle: JobHandle, params: EndJobParams): Promise<EndJobResult> {
  const wallMs = Math.max(0, Date.now() - handle.startedAt);
  const ladderPath = [...handle.ladderPath, ...(params.ladderPath || [])];
  const flagsRaised = [...new Set([...handle.flagsRaised, ...(params.flagsRaised || [])])];
  const entry = buildRunEntry({
    jobId: handle.jobId, kind: handle.kind, examId: handle.examId, docTraits: handle.docTraits,
    models: handle.models, health: params.health, calls: params.calls, tokens: params.tokens,
    costUsd: params.costUsd, wallMs, ladderPath, flagsRaised, userCorrections: params.userCorrections || 0,
  });
  if (typeof params.verifierDefects === 'number') entry.verifierDefects = params.verifierDefects;
  if (params.defectFixRates) entry.defectFixRates = { ...params.defectFixRates };
  if (params.answerAccuracy && params.answerAccuracy.checked > 0) entry.answerAccuracy = { ...params.answerAccuracy };
  if (params.audit) entry.audit = { ...params.audit };
  if (params.readPageOutcomes) entry.readPageOutcomes = params.readPageOutcomes.map(item => ({ ...item }));
  if (params.baselineRevision) { entry.baselineRevision = params.baselineRevision; entry.baselineTs = new Date().toISOString(); }
  // B2/D3 — the ids credited/blamed for this job ride in the journal line itself so the
  // server's delayed correction sweep can blame them after the 10-minute window closes.
  if (handle.matchedPlaybookIds.length) entry.matchedIds = handle.matchedPlaybookIds.slice(0, 50);
  // B5 — record exactly which guidance rode along, incl. draft-shadow skills (B3(b) reads this).
  entry.guidance = {
    playbookEntries: handle.playbook.included.length,
    playbookTokens: handle.playbook.tokens,
    skills: handle.skills.filter(s => !s.draftShadow).map(s => s.slug),
    skillsTokens: handle.skills.reduce((sum, s) => sum + s.tokens, 0),
    omittedByCap: handle.playbook.omittedCount,
    ...(handle.skills.some(s => s.draftShadow) ? { draftShadowSkills: handle.skills.filter(s => s.draftShadow).map(s => s.slug) } : {}),
  };

  const learningEnabled = params.learningEnabled ?? (await loadMemoryConfig().catch(() => ({ learningEnabled: true })).then(cfg => cfg.learningEnabled));
  // B1 — "every 10th clean job" sampling: when nothing else makes this job interesting,
  // count the trailing streak of clean jobs in the journal (this job is not appended yet).
  let cleanJobIndex = params.cleanJobIndex;
  const preliminary = jobIsInteresting({
    ladderPath, healthState: entry.outcome.health.state, flagsRaised,
    userCorrections: entry.userCorrections, toolRefused: params.toolRefused,
  });
  if (!preliminary.interesting && cleanJobIndex === undefined && learningEnabled) {
    try {
      const recent = await loadRuns(2000);
      let streak = 0;
      for (let i = recent.length - 1; i >= 0; i--) {
        const run: any = recent[i];
        const wasClean = !jobIsInteresting({
          ladderPath: run?.ladderPath || [], healthState: String(run?.outcome?.health?.state || 'amber'),
          flagsRaised: run?.flagsRaised || [], userCorrections: Number(run?.userCorrections) || 0,
        }).interesting;
        if (!wasClean) break;
        streak++;
      }
      cleanJobIndex = streak + 1;
    } catch { /* offline: no sampling */ }
  }
  const interesting = jobIsInteresting({
    ladderPath, healthState: entry.outcome.health.state, flagsRaised,
    userCorrections: entry.userCorrections, cleanJobIndex, toolRefused: params.toolRefused,
  });
  const result: EndJobResult = {
    entry, credited: false, transitions: [], pruned: [],
    reflectionScheduled: false, interesting: interesting.interesting, reasons: interesting.reasons,
  };
  if (!learningEnabled) return result;

  // A1 — raw evidence: always write the journal line (append-only).
  await appendRunEntry(entry).catch(() => undefined);

  // B2 — deterministic credit/blame for entries whose scope matched this job.
  if (handle.matchedPlaybookIds.length) {
    const success = outcomeIsSuccess(params.health, entry.userCorrections);
    try { await postCredit(handle.matchedPlaybookIds, success); result.credited = true; } catch { /* offline */ }
  }

  // C4/B2 shared machinery — skill stats + lazy pruning after each job.
  if (handle.skills.length) {
    try {
      const pool = await loadSkills();
      const green = outcomeIsSuccess(params.health, entry.userCorrections);
      const updated = applySkillOutcome(pool, handle.skills.map(s => s.slug), { green, followed: true });
      for (const skill of updated) {
        const original = pool.find(item => item.meta.slug === skill.meta.slug);
        if (!original || JSON.stringify(original.meta.stats) === JSON.stringify(skill.meta.stats)) continue;
        await saveSkill(skill.meta.slug, serializeSkill(skill.meta, skill.body));
      }
      const stale = evaluateSkillStaleness(updated);
      for (const report of stale) {
        if (report.action !== 'archived') continue;
        const skill = updated.find(item => item.meta.slug === report.slug);
        if (!skill) continue;
        await saveSkill(report.slug, serializeSkill({ ...skill.meta, status: 'archived' }, skill.body));
        result.pruned.push(report.slug);
        await logActivity({ type: 'skill_archived', slug: report.slug, reason: report.reason, ts: new Date().toISOString() });
      }
    } catch { /* offline / storage not configured */ }
  }

  // D3 — one reflection call, fire-and-forget, never blocks the UI.
  if (interesting.interesting && !params.isCacheHit) {
    scheduleReflection(entry, {
      ...(params.reflection || {}),
      settings: params.reflection?.settings || params.settings,
      isCacheHit: params.isCacheHit,
      interesting: true,
      transcriptSummary: params.transcriptSummary,
      sourceLines: params.reflection?.sourceLines || params.sourceLines,
      monthlyCapExhausted: params.monthlyCapExhausted ?? params.reflection?.monthlyCapExhausted,
      logUsage: params.reflection?.logUsage || params.logUsage || defaultReflectionUsageLogger,
      logActivity: params.reflection?.logActivity || (record => { void logActivity(record); }),
    });
    result.reflectionScheduled = true;
  }
  return result;
}

/** D3 — 10-minute user-correction window.
 * Heuristic (documented): a correction is a stored exam VERSION whose timestamp falls
 * inside (jobEnd, jobEnd+10min] and whose change is NOT accounted for by an assistant
 * ledger entry in the same window (agent mutations are ledgered; human edits are not).
 * False positives are acceptable: any unledgered post-job change is treated as the user
 * disagreeing with the result.
 */
export function countUserCorrections(params: {
  jobEndTs: string;
  versions?: Array<{ ts?: string; id?: string }>;
  ledgerEntries?: Array<{ ts?: string; tool?: string }>;
  windowMs?: number;
}): number {
  const end = Date.parse(params.jobEndTs);
  if (!Number.isFinite(end)) return 0;
  const windowMs = params.windowMs ?? USER_CORRECTION_WINDOW_MS;
  const ledgerCount = (params.ledgerEntries || []).filter(item => {
    const ts = Date.parse(String(item?.ts || ''));
    return Number.isFinite(ts) && ts >= end && ts <= end + windowMs;
  }).length;
  const versionCount = (params.versions || []).filter(item => {
    const ts = Date.parse(String(item?.ts || ''));
    return Number.isFinite(ts) && ts > end && ts <= end + windowMs;
  }).length;
  return Math.max(0, versionCount - ledgerCount);
}

/** Guidance summary line for stage-card details (B5): exactly what was sent. */
export function guidanceSummary(handle: JobHandle): string {
  return guidanceDigestLine({
    includedPlaybook: handle.playbook.included.length,
    playbookTokens: handle.playbook.tokens,
    includedSkills: handle.skills.map(skill => skill.slug),
    skillsTokens: handle.skills.reduce((sum, skill) => sum + skill.tokens, 0),
    omittedPlaybook: handle.playbook.omittedCount,
  });
}

export type { RunJournalEntry };

