/** 2D — Model reputations. Deterministic from the run journal. Advisory only:
 * a run always uses the role mapping as of run start. n<3 = "insufficient data". */
import type { RunJournalEntry } from './memory/types';

export type SizeBucket = 'small' | 'medium' | 'large';
export interface DocTraitBucket { language: string; size: SizeBucket; images: boolean }
export const bucketKey = (b: DocTraitBucket) => `${b.language}|${b.size}|${b.images ? 'img' : 'noimg'}`;

export function docTraitBucket(traits: { languagesDetected?: string[]; lines?: number; hasImages?: number }): DocTraitBucket {
  const lines = traits?.lines || 0;
  return {
    language: traits?.languagesDetected?.[0] || 'unknown',
    size: lines < 150 ? 'small' : lines < 600 ? 'medium' : 'large',
    images: (traits?.hasImages || 0) > 0,
  };
}

export interface ScoreboardRow {
  role: string; modelId: string; bucket: string;
  jobs: number;
  cleanCoverageRate: number;      // mean coveragePercent/100 over jobs
  meanDefectsPerExam: number;     // verifier defects when present, else flags raised
  recoveries: number;             // jobs whose ladder went beyond L0
  /** meanCostPerCleanQuestion = Σcost / ΣcleanQuestions, cleanQuestions = max(0, parsed − defects). */
  meanCostPerCleanQuestion: number;
  truncationRate: number;         // jobs with a truncation flag / jobs
  /** Godlike-1 C3: Σagreed/Σchecked key-table letter agreement; null = no evidence yet. */
  answerAccuracy: number | null;
  /** Total letter answers checked against the key table across jobs. */
  answerChecked: number;
  insufficientData: boolean;      // n<3 — never fake a %
}

type RunLike = RunJournalEntry & { verifierDefects?: number };

export function buildScoreboard(runs: RunLike[]): ScoreboardRow[] {
  const acc = new Map<string, { role: string; modelId: string; bucket: string; jobs: number; cov: number; defects: number; recoveries: number; cost: number; cleanQs: number; trunc: number; ansChecked: number; ansAgreed: number }>();
  for (const run of runs || []) {
    const bucket = bucketKey(docTraitBucket(run.docTraits as any));
    const defects = typeof run.verifierDefects === 'number' ? run.verifierDefects : (run.flagsRaised?.length || 0);
    for (const [role, modelId] of Object.entries(run.models || {})) {
      const key = `${role}|${modelId}|${bucket}`;
      const row = acc.get(key) || { role, modelId, bucket, jobs: 0, cov: 0, defects: 0, recoveries: 0, cost: 0, cleanQs: 0, trunc: 0, ansChecked: 0, ansAgreed: 0 };
      row.jobs++;
      row.cov += (run.outcome?.health?.coveragePercent || 0) / 100;
      row.defects += defects;
      if ((run.ladderPath || []).length > 1) row.recoveries++;
      row.cost += run.outcome?.cost || 0;
      row.cleanQs += Math.max(0, (run.outcome?.health?.parsed || 0) - defects);
      if ((run.flagsRaised || []).some(f => /TRUNCAT/i.test(f))) row.trunc++;
      // C3: answers are produced by the run's models collectively, so agreement evidence
      // accrues to every (role×model) on the run — same attribution as the other traits.
      row.ansChecked += Math.max(0, Number(run.answerAccuracy?.checked) || 0);
      row.ansAgreed += Math.max(0, Number(run.answerAccuracy?.agreed) || 0);
      acc.set(key, row);
    }
  }
  return [...acc.values()].map(r => ({
    role: r.role, modelId: r.modelId, bucket: r.bucket, jobs: r.jobs,
    cleanCoverageRate: Number((r.cov / r.jobs).toFixed(4)),
    meanDefectsPerExam: Number((r.defects / r.jobs).toFixed(4)),
    recoveries: r.recoveries,
    meanCostPerCleanQuestion: r.cleanQs > 0 ? Number((r.cost / r.cleanQs).toFixed(6)) : 0,
    truncationRate: Number((r.trunc / r.jobs).toFixed(4)),
    answerAccuracy: r.ansChecked > 0 ? Number((r.ansAgreed / r.ansChecked).toFixed(4)) : null,
    answerChecked: r.ansChecked,
    insufficientData: r.jobs < 3,
  })).sort((a, b) => a.role.localeCompare(b.role) || b.cleanCoverageRate - a.cleanCoverageRate);
}

/** Pure leader pick for the CURRENT doc's bucket. Returns null when nobody has n≥3. */
export function leaderFor(rows: ScoreboardRow[], role: string, bucket: string): ScoreboardRow | null {
  const eligible = rows.filter(r => r.role === role && r.bucket === bucket && !r.insufficientData);
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => b.cleanCoverageRate - a.cleanCoverageRate || a.meanCostPerCleanQuestion - b.meanCostPerCleanQuestion || a.modelId.localeCompare(b.modelId))[0];
}

/** Name-based weak-model heuristic — demoted below probe+scoreboard, labelled a guess. */
export function weakModelNameGuess(modelId: string): { weak: boolean; label: 'guess' } {
  return { weak: /free|lite|mini|small|tiny|flash-8b|nano/i.test(modelId || ''), label: 'guess' };
}

/** Reflection may cite the scoreboard only at n≥8 with a ≥15-pt clean-rate leader gap (2D). */
export function scoreboardEvidenceGap(rows: ScoreboardRow[], role: string, bucket: string): { citable: boolean; leader?: ScoreboardRow; gapPoints?: number } {
  const eligible = rows.filter(r => r.role === role && r.bucket === bucket && r.jobs >= 8)
    .sort((a, b) => b.cleanCoverageRate - a.cleanCoverageRate);
  if (eligible.length < 2) return { citable: false };
  const gapPoints = Math.round((eligible[0].cleanCoverageRate - eligible[1].cleanCoverageRate) * 100);
  return { citable: gapPoints >= 15, leader: eligible[0], gapPoints };
}
