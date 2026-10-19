/** B1 — end-of-job reflection. One bounded call per interesting job.
 * The model proposes; the promotion gate (B2) and the linter (C1) decide.
 * Never blocks the UI (D3) and never runs on cache-hit reruns.
 */
import { z } from 'zod';
import type { RunJournalEntry } from './types';
import { lessonIsSafe, loadMemoryConfig } from './playbook';
import { repairTruncatedJson } from '../../utils/jsonRepair';

export const REFLECTION_MAX_OUTPUT_TOKENS = 600; // B1
export const REFLECTION_MAX_INPUT_TOKENS = 2000; // B1 (compact, never raw source)
export const REFLECTION_MAX_PROPOSALS = 3; // B1

const ScopeSchema = z.object({
  modelId: z.string().max(80).optional(),
  docTrait: z.string().max(60).optional(),
  role: z.string().max(40).optional(),
}).passthrough();

export const ReflectionProposalSchema = z.object({
  layer: z.enum(['playbook', 'skill']),
  scope: ScopeSchema.optional(),
  lesson: z.string().min(8).max(280),
  procedureSteps: z.array(z.string().min(1).max(200)).max(6).optional(),
  evidenceRunIds: z.array(z.string().min(1).max(64)).min(1).max(5),
  predictedEffect: z.string().max(200).optional(),
});

export const ReflectionOutputSchema = z.object({ proposals: z.array(ReflectionProposalSchema).max(REFLECTION_MAX_PROPOSALS) });

export type ReflectionProposal = z.infer<typeof ReflectionProposalSchema>;
export type ReflectionSkipReason = 'cache-hit' | 'learning-disabled' | 'reflection-disabled' | 'cap-exhausted' | 'not-interesting' | 'no-model' | 'invalid-output';

export const REFLECTION_SYSTEM = `You are ExamParse's memory reflection analyst. You receive ONE compact job record: document traits, models per role, the ladder path taken, flags raised, final health numbers, cost and user-correction count — never raw exam source text.
Decide whether this episode teaches something GENERALIZABLE for future jobs. Output strict JSON only, no prose, no markdown fences:
{"proposals":[{"layer":"playbook"|"skill","scope":{"modelId"?,"docTrait"?,"role"?},"lesson":"<=280 chars, imperative, specific, falsifiable","procedureSteps":["only for layer=skill, <=6 steps"],"evidenceRunIds":["jobId"],"predictedEffect":"measurable expectation"}]}
Rules: at most 3 proposals; ZERO proposals is the common, correct answer when nothing generalizes. A lesson that is really a procedure ("when X, do steps 1-2-3") must use layer="skill". Facts about models/documents/strategies use layer="playbook". Never quote document text, student data, provider keys or endpoints. Prefer one sharp lesson over three vague ones. Your first character must be {.`;

export interface ReflectionDeps {
  /** Model call. Defaults to the app's LLMAdapter; tests/bench inject a mock. */
  model?: (request: { system: string; text: string; maxOutputTokens: number; label: string }) => Promise<{ json: unknown; rawText: string; usage?: { inputTokens: number; outputTokens: number } }>;
  /** Config loader (defaults to the folder-backed /api/memory/config). */
  loadConfig?: () => Promise<{ learningEnabled: boolean; reflectionEnabled: boolean }>;
  /** Proposal sink (defaults to POST /api/memory/proposals). */
  submitProposal?: (proposal: ReflectionProposal, jobId: string) => Promise<void>;
  /** Usage sink for the "Reflection" label (provider/model/costUsd when known). */
  logUsage?: (record: { label: string; inputTokens: number; outputTokens: number; costUsd?: number; provider?: string; model?: string }) => void;
  /** Activity sink (failures logged silently, B4). */
  logActivity?: (entry: Record<string, unknown>) => void;
  /** Source lines of the job's doc, when available, for the E3 quote check. */
  sourceLines?: string[];
  /** Monthly soft-cap exhaustion flag (B1). */
  monthlyCapExhausted?: boolean;
  /** Whether the job was a cache-hit 0-call rerun (B1). */
  isCacheHit?: boolean;
  /** Whether the job was interesting (computed by runs.jobIsInteresting). */
  interesting?: boolean;
  transcriptSummary?: string;
  settings?: any;
}

export interface ReflectionResult {
  called: boolean;
  proposals: ReflectionProposal[];
  rejected: number;
  skipReason?: ReflectionSkipReason;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/** Compact, ≤2,000-token reflection input. NEVER raw source text (B1). */
export function buildReflectionInput(entry: RunJournalEntry, transcriptSummary?: string): string {
  const payload = {
    run: {
      jobId: entry.jobId,
      kind: entry.kind,
      ts: entry.ts,
      docTraits: entry.docTraits,
      models: entry.models,
      ladderPath: entry.ladderPath?.slice(0, 12),
      flagsRaised: entry.flagsRaised?.slice(0, 10),
      userCorrections: entry.userCorrections,
    },
    outcome: {
      health: entry.outcome?.health,
      calls: entry.outcome?.calls,
      tokens: entry.outcome?.tokens,
      cost: Number((entry.outcome?.cost || 0).toFixed(5)),
      wallMs: entry.outcome?.wallMs,
    },
    transcriptSummary: (transcriptSummary || '').slice(0, 400),
  };
  const json = JSON.stringify(payload);
  // 2,000 tokens ≈ 8,000 chars under the repo's chars/4 estimator — hard truncation.
  return json.length > REFLECTION_MAX_INPUT_TOKENS * 4 ? json.slice(0, REFLECTION_MAX_INPUT_TOKENS * 4) : json;
}

/** Tolerant salvage: strict JSON, fenced JSON, then repaired truncated JSON. */
export function parseReflectionOutputDetailed(raw: unknown, rawText?: string): { valid: ReflectionProposal[]; rejected: number } {
  const candidates: any[] = [];
  const collect = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) { candidates.push(...value); return; }
    if (Array.isArray(value.proposals)) { candidates.push(...value.proposals); return; }
    if (Array.isArray(value.items)) { candidates.push(...value.items); return; }
    if (value.layer || value.lesson) candidates.push(value);
  };
  collect(raw);
  if (!candidates.length && typeof rawText === 'string' && rawText.trim()) {
    const text = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    try { collect(JSON.parse(text)); } catch {
      const repaired = repairTruncatedJson(text);
      if (repaired) collect(repaired);
    }
  }
  const out: ReflectionProposal[] = [];
  let rejected = 0;
  for (const candidate of candidates) {
    const parsed = ReflectionProposalSchema.safeParse(candidate);
    if (!parsed.success) { rejected++; continue; }
    if (out.length >= REFLECTION_MAX_PROPOSALS) { rejected++; continue; }
    out.push(parsed.data);
  }
  return { valid: out, rejected };
}

export function parseReflectionOutput(raw: unknown, rawText?: string): ReflectionProposal[] {
  return parseReflectionOutputDetailed(raw, rawText).valid;
}

async function defaultSubmitProposal(proposal: ReflectionProposal, sourceLines?: string[]): Promise<void> {
  const res = await fetch('/api/memory/proposals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sourceLines?.length ? { proposal, sourceLines: sourceLines.slice(0, 2000) } : { proposal }),
  });
  // A server-side rejection (E3, missing evidence, failed linter) must count as rejected.
  if (!res.ok) throw new Error(`proposal rejected by server (${res.status})`);
}

async function defaultModel(request: { system: string; text: string; maxOutputTokens: number; label: string }, settings?: any): Promise<{ json: unknown; rawText: string; usage?: { inputTokens: number; outputTokens: number; costUsd?: number; provider?: string; model?: string } }> {
  const { LLMAdapter } = await import('../../providers/adapter');
  const { calculateActualCost } = await import('../../utils/budget');
  // Cheapest configured non-reasoning model preferred: the 'fast' role mapping.
  const role = settings?.roleMapping?.fast;
  const provider = settings?.providers?.find((p: any) => p.id === role?.providerId) || settings?.providers?.[0];
  if (!provider) throw new Error('no provider configured');
  const model = role?.model || provider.model || 'gemini-2.5-flash-lite';
  const response: any = await LLMAdapter.execute({
    role: 'fast',
    system: request.system,
    text: request.text,
    maxOutputTokens: request.maxOutputTokens,
    label: request.label,
    providerConfig: { ...provider, model, disableReasoning: true, structuredOutputs: true },
  });
  const inputTokens = response?.usage?.inputTokens || 0;
  const outputTokens = response?.usage?.outputTokens || 0;
  return {
    json: response?.json, rawText: response?.rawText ?? '',
    usage: {
      inputTokens, outputTokens,
      costUsd: calculateActualCost(inputTokens, outputTokens, model, settings?.costTable || {}),
      provider: String(provider.name || provider.id || 'unknown'), model,
    },
  };
}

/** B1 — the single reflection entry point. Fire-and-forget from job completion (D3). */
export async function maybeReflect(entry: RunJournalEntry, deps: ReflectionDeps = {}): Promise<ReflectionResult> {
  const skip = (reason: ReflectionSkipReason): ReflectionResult => ({ called: false, proposals: [], rejected: 0, skipReason: reason });
  if (deps.isCacheHit) return skip('cache-hit');
  const config = await (deps.loadConfig ? deps.loadConfig() : loadMemoryConfig().catch(() => ({ learningEnabled: true, reflectionEnabled: true })));
  if (config.learningEnabled === false) return skip('learning-disabled');
  if (config.reflectionEnabled === false) return skip('reflection-disabled');
  if (deps.monthlyCapExhausted) return skip('cap-exhausted');
  if (deps.interesting === false) return skip('not-interesting');
  if (!deps.model && !(typeof fetch === 'function')) return skip('no-model');

  const input = buildReflectionInput(entry, deps.transcriptSummary);
  let response: { json: unknown; rawText: string; usage?: { inputTokens: number; outputTokens: number; costUsd?: number; provider?: string; model?: string } };
  try {
    response = deps.model
      ? await deps.model({ system: REFLECTION_SYSTEM, text: input, maxOutputTokens: REFLECTION_MAX_OUTPUT_TOKENS, label: 'Reflection' })
      : await defaultModel({ system: REFLECTION_SYSTEM, text: input, maxOutputTokens: REFLECTION_MAX_OUTPUT_TOKENS, label: 'Reflection' }, deps.settings);
  } catch (error: any) {
    deps.logActivity?.({ type: 'reflection_error', jobId: entry.jobId, message: String(error?.message || error).slice(0, 200), ts: new Date().toISOString() });
    return skip('no-model');
  }
  deps.logUsage?.({ label: 'Reflection', inputTokens: response.usage?.inputTokens || 0, outputTokens: response.usage?.outputTokens || 0, costUsd: response.usage?.costUsd, provider: response.usage?.provider, model: response.usage?.model });

  const { valid: parsed, rejected: schemaRejected } = parseReflectionOutputDetailed(response.json, response.rawText);
  const accepted: ReflectionProposal[] = [];
  let rejected = schemaRejected;
  for (const proposal of parsed) {
    // E3 — lessons are about PROCEDURE, never content/credentials.
    const safety = lessonIsSafe(proposal.lesson, deps.sourceLines);
    if (!safety.ok) { rejected++; continue; }
    if (proposal.layer === 'skill' && !(proposal.procedureSteps?.length)) { rejected++; continue; }
    // Force procedure-shaped lessons into the skill layer (A3).
    const normalized: ReflectionProposal = { ...proposal, evidenceRunIds: [...new Set([...proposal.evidenceRunIds, entry.jobId])].slice(0, 5) };
    try {
      await (deps.submitProposal ? deps.submitProposal(normalized, entry.jobId) : defaultSubmitProposal(normalized, deps.sourceLines));
      accepted.push(normalized);
    } catch { rejected++; }
  }
  if (!parsed.length && typeof response.rawText === 'string' && response.rawText.trim() && !response.rawText.includes('{')) {
    deps.logActivity?.({ type: 'reflection_invalid_output', jobId: entry.jobId, ts: new Date().toISOString() });
    return { called: true, proposals: [], rejected, skipReason: 'invalid-output', usage: { inputTokens: response.usage?.inputTokens || 0, outputTokens: response.usage?.outputTokens || 0, costUsd: response.usage?.costUsd } };
  }
  return { called: true, proposals: accepted, rejected, usage: { inputTokens: response.usage?.inputTokens || 0, outputTokens: response.usage?.outputTokens || 0, costUsd: response.usage?.costUsd } };
}

/** D3 — fire-and-forget; never blocks the UI; failures logged silently to Activity. */
export function scheduleReflection(entry: RunJournalEntry, deps: ReflectionDeps = {}): void {
  void maybeReflect(entry, deps).catch(error => {
    try { deps.logActivity?.({ type: 'reflection_error', jobId: entry.jobId, message: String(error?.message || error).slice(0, 200), ts: new Date().toISOString() }); } catch { /* ignore */ }
  });
}

export const REFLECTION_CAPS = { maxOutputTokens: REFLECTION_MAX_OUTPUT_TOKENS, maxInputTokens: REFLECTION_MAX_INPUT_TOKENS, maxProposals: REFLECTION_MAX_PROPOSALS };
