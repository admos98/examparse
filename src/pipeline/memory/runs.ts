/** Layer 1 — episodic memory. The global run journal (memory/runs.jsonl) is the raw
 * evidence every learned lesson must cite (A1). Append-only, rotated at 2,000 lines
 * into a plain .jsonl archive (no compression dependency).
 */
import type { DocTraits, RunJournalEntry } from './types';

export type { DocTraits, RunJournalEntry };

export const RUNS_CAP = 2000; // A1 rotation point
export const ARCHIVE_NAME = 'runs-archive.jsonl';

export function makeJobId(prefix = 'job'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildRunEntry(params: {
  jobId: string;
  kind: RunJournalEntry['kind'];
  examId?: string;
  docTraits: DocTraits;
  models: Record<string, string>;
  health: any;
  calls: number;
  tokens: { input: number; output: number; cached?: number };
  costUsd: number;
  wallMs: number;
  ladderPath: string[];
  flagsRaised: string[];
  userCorrections?: number;
  ts?: string;
}): RunJournalEntry {
  return {
    ts: params.ts || new Date().toISOString(),
    jobId: params.jobId,
    kind: params.kind,
    examId: params.examId,
    docTraits: params.docTraits,
    models: params.models,
    outcome: {
      health: {
        expected: Number(params.health?.expected ?? params.health?.expectedCount ?? 0),
        parsed: Number(params.health?.parsed ?? params.health?.parsedCount ?? 0),
        missing: Array.isArray(params.health?.missing) ? params.health.missing.slice(0, 40) : [],
        duplicates: Array.isArray(params.health?.duplicates) ? params.health.duplicates.slice(0, 20) : [],
        coveragePercent: Number(params.health?.coveragePercent ?? 0),
        state: String(params.health?.state || 'amber'),
        complete: Boolean(params.health?.complete),
        pointsParsed: Number(params.health?.points ?? params.health?.pointsParsed ?? 0),
        pointsExpected: Number(params.health?.totalPoints ?? params.health?.pointsExpected ?? 0),
      },
      calls: Number(params.calls) || 0,
      tokens: { input: Number(params.tokens?.input) || 0, output: Number(params.tokens?.output) || 0, cached: Number(params.tokens?.cached) || 0 },
      cost: Number(params.costUsd) || 0,
      wallMs: Number(params.wallMs) || 0,
      flagsRaised: params.flagsRaised.slice(0, 20),
    },
    ladderPath: params.ladderPath.slice(0, 40),
    flagsRaised: params.flagsRaised.slice(0, 20),
    userCorrections: Number(params.userCorrections) || 0,
  };
}

/** B1 "interesting" gate. Every 10th clean job is sampled so successes also teach. */
export function jobIsInteresting(params: {
  ladderPath: string[];
  healthState: string;
  flagsRaised: string[];
  userCorrections: number;
  cleanJobIndex?: number; // 1-based count of consecutive clean jobs
  toolRefused?: boolean;
}): { interesting: boolean; reasons: string[] } {
  const reasons: string[] = [];
  // A rung, a recovery/retry/reparse/repair label or a refusal — not a plain stage list.
  const LADDER_STEP = /(?:^|[^a-z])(?:l[1-4]|retry|reparse|recovery|repair|escalat|refused)/i;
  const beyondL0 = params.ladderPath.some(step => LADDER_STEP.test(String(step)));
  if (beyondL0) reasons.push('recovery/ladder beyond L0');
  if (params.healthState !== 'green') reasons.push(`health ended ${params.healthState}`);
  if (params.userCorrections > 0) reasons.push(`${params.userCorrections} user correction(s)`);
  if (params.toolRefused) reasons.push('a tool was refused/no-opped');
  if (params.flagsRaised.some(code => /PARTIAL|EMPTY|TRIPWIRE|SHAPE|REJECT/.test(code))) reasons.push('error flag raised');
  const cleanJobIndex = params.cleanJobIndex ?? 0;
  if (!reasons.length && cleanJobIndex > 0 && cleanJobIndex % 10 === 0) reasons.push(`every 10th clean job (#${cleanJobIndex})`);
  return { interesting: reasons.length > 0, reasons };
}

/** Rotation helper shared with the server (plain split, no compression deps). */
export function rotateRunLines(lines: string[], cap = RUNS_CAP): { kept: string[]; archived: string[] } {
  if (lines.length <= cap) return { kept: lines, archived: [] };
  const splitAt = lines.length - cap;
  return { kept: lines.slice(splitAt), archived: lines.slice(0, splitAt) };
}

// --- folder-backed client helpers ---
export async function appendRunEntry(entry: RunJournalEntry): Promise<void> {
  try {
    await fetch('/api/memory/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
  } catch { /* offline / storage not configured */ }
}

export async function loadRuns(limit = 200): Promise<RunJournalEntry[]> {
  try {
    const res = await fetch('/api/memory/runs');
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).slice(-limit);
  } catch { return []; }
}

export async function loadActivity(limit = 50): Promise<{ runs: RunJournalEntry[]; activity: any[] }> {
  try {
    const res = await fetch('/api/memory/activity');
    if (!res.ok) return { runs: [], activity: [] };
    const data = await res.json();
    return { runs: (data?.runs || []).slice(-limit), activity: (data?.activity || []).slice(-limit) };
  } catch { return { runs: [], activity: [] }; }
}
