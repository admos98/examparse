// E2 Local observability: last 50 pipeline runs from usage/audit data
import type { UsageRecord } from '../types';

export interface RunRecord {
  examId:string;
  examName:string;
  ts:string;
  stages: string[];
  attempts:number;
  calls:number;
  tokens:number;
  cost:number;
  flags:string[];
  outcome:'complete'|'partial'|'failed';
}

export function buildDiagnostics(runs: RunRecord[], errors: Record<string,number>){
  return {
    runs: runs.slice(-50),
    providerErrorTaxonomy: errors,
    generatedAt: new Date().toISOString(),
  };
}

export function exportDiagnostics(diagnostics:any): string {
  // Still NO keys, NO source text (assert via test)
  const safe = JSON.parse(JSON.stringify(diagnostics));
  // Strip any accidental source text fields if present
  delete safe.sourceText;
  delete safe.apiKey;
  delete safe.providerKeys;
  return JSON.stringify(safe, null, 2);
}

export function diagnosticsFromUsage(usage: UsageRecord[]): RunRecord[] {
  // Group by exam id + timestamp day
  const map = new Map<string, RunRecord>();
  for(const u of usage){
    const key = u.dedupeKey || u.label || 'unknown';
    if(!map.has(key)) map.set(key, { examId: key, examName: u.label, ts:u.ts, stages:[u.role], attempts:1, calls:1, tokens: u.inputTokens+u.outputTokens, cost: u.costUsd||0, flags:[], outcome:'partial' });
    else {
      const r = map.get(key)!;
      r.tokens += u.inputTokens+u.outputTokens;
      r.cost += u.costUsd||0;
      r.calls++;
    }
  }
  return [...map.values()].slice(-50);
}
