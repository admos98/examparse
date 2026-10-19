/** Layer 2 — learned playbook (semantic memory). The model proposes, code decides (B2).
 * Pure selection/credit logic is synchronous so tests + bench stay offline; async
 * wrappers talk to the folder-backed server routes.
 */
import { estimateTokens } from './tokens';
import type { DocTraits, PlaybookEntry, PlaybookFile, PlaybookKind, PlaybookStatus } from './types';

export const PLAYBOOK_CAP_TOKENS = 5000; // A4 — hard cap for ANY model call
export const ASSISTANT_PLAYBOOK_CAP = 1500; // A4 — assistant subset inside the state-pack budget
export const GUIDANCE_HEADER = 'FIELD LESSONS (from prior runs on similar documents — follow where applicable)';
const LESSON_MAX = 280;
const CANDIDACY_MS = 30 * 24 * 60 * 60 * 1000; // B2: candidate expires silently after 30 days

export interface PlaybookCtx {
  modelId?: string;
  docTraits?: DocTraits;
  role?: string;
  capTokens?: number;
}

export function emptyPlaybook(): PlaybookFile {
  return { version: 1, entries: [] };
}

export function normalizeLesson(text: string): string {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\u200c\u200d]+/g, ' ').replace(/[.,;:!?]+$/g, '').trim();
}

/** Confidence = Laplace-smoothed success rate: (successes+1)/(total+2). Documented choice (B2). */
export function confidenceFormula(successes: number, failures: number): number {
  const total = Math.max(0, successes) + Math.max(0, failures);
  return Number(((successes + 1) / (total + 2)).toFixed(4));
}

function modelMatches(scopeModel: string, modelId?: string): boolean {
  if (!modelId) return false;
  const scope = scopeModel.toLowerCase();
  const model = modelId.toLowerCase();
  if (model.includes(scope) || scope.includes(model)) return true;
  // Trait families: 'free'/'lite'/'mini' style scope matches any such model name.
  const families = ['free', 'lite', 'mini', 'small', 'tiny', 'pro', 'flash', 'reasoning'];
  return families.some(family => scope.includes(family) && model.includes(family));
}

/** Scope match: model, doc trait, role. Empty scope = generic (matches everything).
 * D1 exception: vision/OCR prompts are perception, not judgment — they receive NO
 * playbook unless an entry is explicitly scoped to that very role. */
export function scopeMatches(entry: PlaybookEntry, ctx: PlaybookCtx): boolean {
  const scope = entry.scope || {};
  const perceptionRole = ctx.role === 'vision' || ctx.role === 'ocr';
  if (perceptionRole) return String(scope.role || '') === ctx.role;
  if (!scope.modelId && !scope.docTrait && !scope.role) return true;
  if (scope.modelId && !modelMatches(String(scope.modelId), ctx.modelId)) return false;
  if (scope.role && ctx.role && String(scope.role) !== ctx.role && String(scope.role) !== '*') return false;
  if (scope.docTrait && ctx.docTraits) {
    const trait = String(scope.docTrait).toLowerCase();
    const traits = ctx.docTraits;
    const checks: Array<[string, boolean]> = [
      ['rtl', Boolean(traits.rtl)],
      ['persian', traits.languagesDetected?.includes('fa') ?? false],
      ['arabic', traits.languagesDetected?.includes('ar') ?? false],
      ['english', traits.languagesDetected?.includes('en') ?? false],
      ['image', (traits.hasImages || 0) > 0],
      ['long', Boolean(traits.isLong)],
      ['key', Boolean(traits.hasKeyPages)],
      ['section', (traits.sectionCount || 0) >= 2],
      ['scanned', Boolean((traits as any).ocrUsed)],
      ['twocolumn', Boolean((traits as any).twoColumn)],
    ];
    const known = checks.filter(([name]) => trait.includes(name));
    // Unknown trait keywords are permissive (scope may name a fixture/domain);
    // known keywords must all hold.
    if (known.length && !known.every(([, ok]) => ok)) return false;
  }
  return true;
}

const STATUS_RANK: Record<PlaybookStatus, number> = { active: 0, candidate: 1, demoted: 2 };

export function rankEntries(entries: PlaybookEntry[]): PlaybookEntry[] {
  return [...entries].sort((a, b) => {
    const statusDelta = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
    if (statusDelta !== 0) return statusDelta;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const seenA = Date.parse(a.evidence?.lastSeen || a.evidence?.firstSeen || '') || 0;
    const seenB = Date.parse(b.evidence?.lastSeen || b.evidence?.firstSeen || '') || 0;
    return seenB - seenA;
  });
}

export function entryLine(entry: PlaybookEntry): string {
  return `- ${entry.lesson}`;
}

export interface PlaybookInjection {
  block: string; // delimited guidance block ('' when nothing matched — cold start stays byte-identical)
  tokens: number;
  included: PlaybookEntry[];
  omittedCount: number;
  omittedIds: string[];
  digest: string; // "Guidance: playbook N entries (T tok)" — inspectable per B5
}

/** Greedy pack within the cap; demoted entries are never injected (B2). */
export function selectPlaybookEntries(file: PlaybookFile, ctx: PlaybookCtx): PlaybookInjection {
  const cap = ctx.capTokens ?? PLAYBOOK_CAP_TOKENS;
  const entries = (file?.entries || []).filter(entry => entry.status === 'active' || entry.status === 'candidate');
  const matched = entries.filter(entry => scopeMatches(entry, ctx));
  const ranked = rankEntries(matched);
  const headerTokens = estimateTokens(`\n\n${GUIDANCE_HEADER}\n`);
  const digestTokens = estimateTokens('\nMemoryDigest: playbook 0 entries (0 tok), omitted 0 by cap.\n');
  let used = headerTokens + digestTokens;
  const included: PlaybookEntry[] = [];
  const omitted: PlaybookEntry[] = [];
  for (const entry of ranked) {
    const tokens = estimateTokens(entryLine(entry) + '\n');
    if (used + tokens > cap || included.length >= 50) { omitted.push(entry); continue; }
    used += tokens;
    included.push(entry);
  }
  if (!included.length) {
    return { block: '', tokens: 0, included: [], omittedCount: matched.length, omittedIds: matched.map(entry => entry.id), digest: `Guidance: playbook 0 entries (0 tok), omitted ${matched.length} by cap.` };
  }
  const digest = `MemoryDigest: playbook ${included.length} entries (${used} tok), omitted ${omitted.length} by cap.`;
  const block = `\n\n${GUIDANCE_HEADER}\n${included.map(entryLine).join('\n')}\n${digest}\n`;
  return { block, tokens: estimateTokens(block), included, omittedCount: omitted.length, omittedIds: omitted.map(entry => entry.id), digest };
}

/** Matched entry ids for a job — the harness records these BEFORE the job so the
 * outcome can credit/blame exactly the entries that were in scope (B2). */
export function matchedEntryIds(file: PlaybookFile, ctx: PlaybookCtx): string[] {
  return (file?.entries || [])
    .filter(entry => entry.status === 'active' || entry.status === 'candidate')
    .filter(entry => scopeMatches(entry, ctx))
    .map(entry => entry.id);
}

// --- B2 promotion gate: deterministic, applied by code (never by the model) ---
export interface CreditOutcome { success: boolean }
export interface CreditResult {
  playbook: PlaybookFile;
  transitions: Array<{ id: string; lesson: string; from: PlaybookStatus; to: PlaybookStatus; successes: number; failures: number; confidence: number }>;
}

export function applyCredit(file: PlaybookFile, matchedIds: string[], outcome: CreditOutcome, now = new Date().toISOString()): CreditResult {
  const transitions: CreditResult['transitions'] = [];
  const ids = new Set(matchedIds);
  const entries = (file?.entries || []).map(entry => {
    if (!ids.has(entry.id)) return entry;
    const evidence = { ...(entry.evidence || { runIds: [], successes: 0, failures: 0, firstSeen: now, lastSeen: now }) };
    const from = entry.status;
    if (outcome.success) {
      evidence.successes = (evidence.successes || 0) + 1;
      evidence.consecutiveFailures = 0;
      evidence.lastVerified = now;
    } else {
      evidence.failures = (evidence.failures || 0) + 1;
      evidence.consecutiveFailures = (evidence.consecutiveFailures || 0) + 1;
    }
    evidence.lastSeen = now;
    const confidence = confidenceFormula(evidence.successes || 0, evidence.failures || 0);
    let status: PlaybookStatus = from;
    const total = (evidence.successes || 0) + (evidence.failures || 0);
    if (from === 'candidate' && ((evidence.successes >= 2 && evidence.failures === 0) || (confidence >= 0.6 && total >= 3))) status = 'active';
    if (from === 'active' && ((evidence.consecutiveFailures || 0) >= 2 || confidence < 0.35)) status = 'demoted';
    if (status !== from) transitions.push({ id: entry.id, lesson: entry.lesson, from, to: status, successes: evidence.successes, failures: evidence.failures, confidence });
    return { ...entry, evidence, confidence, status };
  });
  return { playbook: { version: 1, entries }, transitions };
}

export interface ProposalInput { lesson: string; scope?: PlaybookEntry['scope']; kind?: PlaybookKind; evidenceRunIds: string[] }

/** Identical normalized lesson text merges evidence instead of duplicating (B2). */
export function addProposal(file: PlaybookFile, proposal: ProposalInput, now = new Date().toISOString()): { playbook: PlaybookFile; merged: boolean; entry: PlaybookEntry } {
  const lesson = String(proposal.lesson || '').trim().slice(0, LESSON_MAX);
  const normalized = normalizeLesson(lesson);
  const entries = [...(file?.entries || [])];
  const existingIndex = entries.findIndex(entry => normalizeLesson(entry.lesson) === normalized);
  if (existingIndex >= 0) {
    const existing = entries[existingIndex];
    const evidence = {
      ...existing.evidence,
      runIds: [...new Set([...(existing.evidence?.runIds || []), ...(proposal.evidenceRunIds || [])])].slice(-20),
      lastSeen: now,
    };
    const merged: PlaybookEntry = { ...existing, evidence, scope: { ...existing.scope, ...(proposal.scope || {}) } };
    entries[existingIndex] = merged;
    return { playbook: { version: 1, entries }, merged: true, entry: merged };
  }
  const entry: PlaybookEntry = {
    id: `pb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: proposal.kind || 'strategy',
    scope: proposal.scope || {},
    lesson,
    evidence: { runIds: [...(proposal.evidenceRunIds || [])].slice(-20), successes: 0, failures: 0, firstSeen: now, lastSeen: now },
    status: 'candidate',
    confidence: 0.3,
  };
  entries.push(entry);
  return { playbook: { version: 1, entries }, merged: false, entry };
}

/** Candidates with no matching job in 30 days expire silently (B2). */
export function expireCandidates(file: PlaybookFile, nowMs = Date.now()): { playbook: PlaybookFile; expired: string[] } {
  const expired: string[] = [];
  const entries = (file?.entries || []).filter(entry => {
    if (entry.status !== 'candidate') return true;
    const last = Date.parse(entry.evidence?.lastSeen || entry.evidence?.firstSeen || '') || 0;
    if (last && nowMs - last > CANDIDACY_MS) { expired.push(entry.id); return false; }
    return true;
  });
  return { playbook: { version: 1, entries }, expired };
}

/** Manual editor-in-chief controls (B4). */
export function setEntryStatus(file: PlaybookFile, id: string, status: PlaybookStatus): PlaybookFile {
  return { version: 1, entries: (file?.entries || []).map(entry => entry.id === id ? { ...entry, status, confidence: status === 'candidate' ? Math.min(entry.confidence, 0.3) : entry.confidence } : entry) };
}
export function deleteEntry(file: PlaybookFile, id: string): PlaybookFile {
  return { version: 1, entries: (file?.entries || []).filter(entry => entry.id !== id) };
}
export function editEntryLesson(file: PlaybookFile, id: string, lesson: string): PlaybookFile {
  return {
    version: 1,
    entries: (file?.entries || []).map(entry => entry.id === id
      ? { ...entry, lesson: String(lesson).trim().slice(0, LESSON_MAX), evidence: { ...entry.evidence, lastSeen: new Date().toISOString() } }
      : entry),
  };
}

/** E3 — lessons may not carry credentials, endpoints, student data or long source quotes. */
export function lessonIsSafe(lesson: string, sourceLines?: string[]): { ok: boolean; reason?: string } {
  const text = String(lesson || '');
  if (text.length > LESSON_MAX) return { ok: false, reason: `lesson exceeds ${LESSON_MAX} chars` };
  if (/AIza[0-9A-Za-z_-]{8,}|sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{8,}/i.test(text)) return { ok: false, reason: 'lesson contains a credential-like token' };
  if (/https?:\/\/[^\s]+/i.test(text)) return { ok: false, reason: 'lesson contains an endpoint URL' };
  if (sourceLines?.length) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length >= 13) {
      const normalizedLines = sourceLines.map(line => line.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '));
      for (let i = 0; i + 13 <= words.length; i++) {
        const span = words.slice(i, i + 13).join(' ').toLowerCase();
        if (normalizedLines.some(line => line.includes(span))) return { ok: false, reason: 'lesson quotes ≥12 consecutive words from source' };
      }
    }
  }
  return { ok: true };
}

export const PLAYBOOK_CAPS = { PLAYBOOK_CAP_TOKENS, ASSISTANT_PLAYBOOK_CAP };

// --- Async folder-backed client helpers ---
export async function loadPlaybook(): Promise<PlaybookFile> {
  try {
    const res = await fetch('/api/memory/playbook');
    if (!res.ok) return emptyPlaybook();
    const data = await res.json();
    if (data && Array.isArray(data.entries)) return { version: 1, entries: data.entries };
    return emptyPlaybook();
  } catch { return emptyPlaybook(); }
}

export async function savePlaybook(file: PlaybookFile): Promise<boolean> {
  try {
    const res = await fetch('/api/memory/playbook', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file) });
    return res.ok;
  } catch { return false; }
}

export async function loadMemoryConfig(): Promise<{ learningEnabled: boolean; reflectionEnabled: boolean }> {
  try {
    const res = await fetch('/api/memory/config');
    if (!res.ok) return { learningEnabled: true, reflectionEnabled: true };
    const cfg = await res.json();
    return { learningEnabled: cfg?.learningEnabled !== false, reflectionEnabled: cfg?.reflectionEnabled !== false };
  } catch { return { learningEnabled: true, reflectionEnabled: true }; }
}

export async function saveMemoryConfig(cfg: { learningEnabled?: boolean; reflectionEnabled?: boolean }): Promise<void> {
  try { await fetch('/api/memory/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }); } catch { /* offline */ }
}

export async function postCredit(matchedIds: string[], success: boolean): Promise<void> {
  try { await fetch('/api/memory/credit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchedIds, success }) }); } catch { /* offline */ }
}

export async function logActivity(entry: Record<string, unknown>): Promise<void> {
  try { await fetch('/api/memory/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }); } catch { /* offline */ }
}

/** Guidance assembly that also respects the Learning toggle (B5). */
export async function selectPlaybookForCall(ctx: PlaybookCtx): Promise<PlaybookInjection> {
  const config = await loadMemoryConfig();
  if (!config.learningEnabled) return { block: '', tokens: 0, included: [], omittedCount: 0, omittedIds: [], digest: 'Guidance: playbook 0 entries (0 tok) — learning disabled.' };
  const file = await loadPlaybook();
  return selectPlaybookEntries(file, ctx);
}
