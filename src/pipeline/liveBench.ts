/** 2G — Continuous self-benchmark. Live bench NEVER auto-runs and never blocks:
 * the estimate is shown and explicitly confirmed before any call (declining = 0 calls). */

export interface LiveBenchFixtureInput { id: string; structureCalls: number; estInputTokens: number; estOutputTokens: number }
export interface LiveBenchEstimate { calls: number; estInputTokens: number; estOutputTokens: number; estCostUsd: number }

export function estimateLiveBench(fixtures: LiveBenchFixtureInput[], ratePerMillion: { input: number; output: number }): LiveBenchEstimate {
  const calls = fixtures.reduce((s, f) => s + f.structureCalls, 0);
  const estInputTokens = fixtures.reduce((s, f) => s + f.estInputTokens, 0);
  const estOutputTokens = fixtures.reduce((s, f) => s + f.estOutputTokens, 0);
  return { calls, estInputTokens, estOutputTokens, estCostUsd: Number(((estInputTokens / 1e6) * ratePerMillion.input + (estOutputTokens / 1e6) * ratePerMillion.output).toFixed(4)) };
}

/** The confirm gate: without explicit confirmation the runner must not be invoked. */
export function liveBenchGate(confirmed: boolean): { allowed: boolean; reason: string } {
  return confirmed ? { allowed: true, reason: 'confirmed' } : { allowed: false, reason: 'declined — 0 calls' };
}

export interface LiveBenchScorecard {
  ts: string; role: string; modelId: string;
  fixtures: Array<{ id: string; coveragePercent: number; quality: number; calls: number }>;
  meanCoverage: number; meanQuality: number; totalCalls: number; costUsd: number;
}

export function diffScorecards(prev: LiveBenchScorecard | null, next: LiveBenchScorecard): Array<{ fixture: string; coverageDelta: number; qualityDelta: number }> {
  if (!prev) return next.fixtures.map(f => ({ fixture: f.id, coverageDelta: f.coveragePercent, qualityDelta: f.quality }));
  const prevBy = new Map(prev.fixtures.map(f => [f.id, f]));
  return next.fixtures.map(f => {
    const p = prevBy.get(f.id);
    return { fixture: f.id, coverageDelta: p ? Number((f.coveragePercent - p.coveragePercent).toFixed(2)) : f.coveragePercent, qualityDelta: p ? f.quality - p.quality : f.quality };
  });
}

/** Clean-rate trend: last 20 jobs vs prior 20 (local, from run journal coverage). */
export function cleanRateTrend(coverages: number[]): { recent: number | null; prior: number | null; n: number } {
  const mean = (xs: number[]) => xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null;
  return { recent: mean(coverages.slice(-20)), prior: mean(coverages.slice(-40, -20)), n: coverages.length };
}

/** REGRESSION ALARM: trailing-window clean-rate drop ≥15 pts, n≥10 both windows.
 * Correlation only — dismissible, never auto-reverts anything. */
export function regressionAlarm(coverages: number[]): { alarm: boolean; recent?: number; prior?: number; message?: string } {
  const recent = coverages.slice(-10);
  const prior = coverages.slice(-20, -10);
  if (recent.length < 10 || prior.length < 10) return { alarm: false };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = mean(recent); const p = mean(prior);
  if (p - r >= 15) return { alarm: true, recent: Number(r.toFixed(1)), prior: Number(p.toFixed(1)), message: `Clean-rate dropped ${Math.round(p - r)} pts (last 10 jobs ${r.toFixed(0)}% vs prior 10 ${p.toFixed(0)}%). Correlation only — check recent model/config changes; nothing was reverted.` };
  return { alarm: false, recent: Number(r.toFixed(1)), prior: Number(p.toFixed(1)) };
}
