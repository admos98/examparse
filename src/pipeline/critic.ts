/** 2B — The Critic. Adversarial verifier invoked ONLY on evidence.
 * Never edits: reparse → existing recovery machinery; review → top of review queue.
 * No critic model configured ⇒ 2A flags queue for review, 0 calls, honestly degraded. */
import { z } from 'zod';
import type { Question } from '../types';
import type { SemanticIssue } from './semanticValidators';

export interface CriticVerdict {
  questionId: string;
  verdict: 'ok' | 'defect';
  defectKind?: string;
  suggestedAction: 'accept' | 'reparse' | 'review';
  note: string; // ≤140 chars enforced locally
  ts?: string;
}

export const CriticVerdictSchema = z.object({
  questionId: z.string(),
  verdict: z.enum(['ok', 'defect']),
  defectKind: z.string().optional(),
  suggestedAction: z.enum(['accept', 'reparse', 'review']),
  note: z.string().max(280),
});

export interface CriticQueueItem { question: Question; suspicions: SemanticIssue[]; reason: string }

export const CRITIC_BATCH = 8;
export const CRITIC_MAX_CALLS = 2;

/** Queue = ≥1 2A warn, calibrated confidence <0.6, or a consensus disagreement. */
export function buildCriticQueue(questions: Question[], issues: SemanticIssue[], disagreementIds: string[] = []): CriticQueueItem[] {
  const warnByQ = new Map<string, SemanticIssue[]>();
  for (const i of issues) if (i.severity === 'warn' && i.questionId) warnByQ.set(i.questionId, [...(warnByQ.get(i.questionId) || []), i]);
  const dis = new Set(disagreementIds);
  const queue: CriticQueueItem[] = [];
  for (const q of questions) {
    const suspicions = warnByQ.get(q.id) || [];
    const reasons: string[] = [];
    if (suspicions.length) reasons.push(suspicions.map(s => s.code).join(','));
    if (q.confidence < 0.6) reasons.push(`confidence ${q.confidence.toFixed(2)}<0.6`);
    if (dis.has(q.id)) reasons.push('consensus disagreement');
    if (reasons.length) queue.push({ question: q, suspicions, reason: reasons.join('; ') });
  }
  return queue;
}

export function batchCriticQueue(queue: CriticQueueItem[]): CriticQueueItem[][] {
  const capped = queue.slice(0, CRITIC_BATCH * CRITIC_MAX_CALLS);
  const batches: CriticQueueItem[][] = [];
  for (let i = 0; i < capped.length; i += CRITIC_BATCH) batches.push(capped.slice(i, i + CRITIC_BATCH));
  return batches.slice(0, CRITIC_MAX_CALLS);
}

export type CriticCaller = (batch: CriticQueueItem[]) => Promise<unknown[]>;

export interface CriticRunResult {
  calls: number;
  verdicts: CriticVerdict[];
  reviewQueue: string[];   // questionIds sent to top of Step 4 queue
  reparseQueue: string[];  // questionIds handed to existing recovery machinery
  degraded: boolean;       // true when no critic model configured (0 calls)
}

/** Caller injected (transport in app, mock in tests). null caller = unconfigured. */
export async function runCritic(queue: CriticQueueItem[], caller: CriticCaller | null): Promise<CriticRunResult> {
  if (!caller) {
    return { calls: 0, verdicts: [], reviewQueue: queue.map(i => i.question.id), reparseQueue: [], degraded: true };
  }
  const verdicts: CriticVerdict[] = [];
  let calls = 0;
  for (const batch of batchCriticQueue(queue)) {
    calls++;
    let raw: unknown[] = [];
    try { raw = await caller(batch); } catch { raw = []; }
    for (const item of Array.isArray(raw) ? raw : []) {
      const parsed = CriticVerdictSchema.safeParse(item);
      if (!parsed.success) continue; // tolerant: drop malformed verdicts, never crash
      verdicts.push({ ...parsed.data, note: parsed.data.note.slice(0, 140), ts: new Date().toISOString() });
    }
  }
  return {
    calls,
    verdicts,
    reviewQueue: verdicts.filter(v => v.suggestedAction === 'review' || (v.verdict === 'defect' && v.suggestedAction !== 'reparse')).map(v => v.questionId),
    reparseQueue: verdicts.filter(v => v.verdict === 'defect' && v.suggestedAction === 'reparse').map(v => v.questionId),
    degraded: false,
  };
}

/** Dossier verdicts[] — last 3 per question. */
export function recordVerdicts(store: Record<string, CriticVerdict[]>, verdicts: CriticVerdict[]): Record<string, CriticVerdict[]> {
  const out: Record<string, CriticVerdict[]> = { ...store };
  for (const v of verdicts) out[v.questionId] = [...(out[v.questionId] || []), v].slice(-3);
  return out;
}
