/** 2C — Consensus on hard sections only. Clean sections never pay.
 * Local diff by printed number; critic tie-breaks span conflicts when both sides clean. */
import type { Question } from '../types';
import { spanLineNumbers } from './assemble';
import { semanticIssuesFor, type SemanticIssue } from './semanticValidators';

export interface ConsensusTrigger { triggered: boolean; reasons: string[] }

export function consensusTriggerForSection(params: {
  questions: Question[];
  issues: SemanticIssue[];
  missingInSection?: number[];
  tripwiresFired?: boolean;
  pointsMismatch?: boolean;
}): ConsensusTrigger {
  const reasons: string[] = [];
  if ((params.missingInSection || []).length) reasons.push('missing coverage in-section');
  const warns = params.issues.filter(i => i.severity === 'warn' && params.questions.some(q => q.id === i.questionId));
  if (warns.length >= 2) reasons.push(`≥2 semantic warns (${warns.length})`);
  if (params.questions.length) {
    const mean = params.questions.reduce((s, q) => s + q.confidence, 0) / params.questions.length;
    if (mean < 0.7) reasons.push(`mean confidence ${mean.toFixed(2)}<0.7`);
  }
  if (params.tripwiresFired) reasons.push('tripwires fired');
  if (params.pointsMismatch) reasons.push('in-section points mismatch');
  return { triggered: reasons.length > 0, reasons };
}

export function spanOverlap(a: Question, b: Question): number {
  const la = new Set(spanLineNumbers(a.spans || []));
  const lb = spanLineNumbers(b.spans || []);
  if (!la.size || !lb.length) return 0;
  const inter = lb.filter(n => la.has(n)).length;
  return inter / Math.min(la.size, lb.length);
}

export interface ConsensusDecision {
  accepted: Question[];                       // agreed or clean-side winners
  review: Array<{ no: number; a?: Question; b?: Question; reason: string }>;
  needsCritic: number[];                      // span conflict, both clean → critic tie-break
  agreedNos: number[];
}

/** A = structure parse, B = consensus parse. Deterministic local diff. */
export function diffConsensus(aQs: Question[], bQs: Question[], issues: SemanticIssue[]): ConsensusDecision {
  const byNoB = new Map(bQs.map(q => [q.no, q]));
  const seenB = new Set<number>();
  const dec: ConsensusDecision = { accepted: [], review: [], needsCritic: [], agreedNos: [] };
  const clean = (q: Question) => semanticIssuesFor(issues, q.id).every(i => i.severity !== 'warn');
  for (const a of [...aQs].sort((x, y) => x.no - y.no)) {
    const b = byNoB.get(a.no);
    if (!b) {
      if (clean(a)) dec.accepted.push({ ...a, flags: [...(a.flags || []), 'CONSENSUS_SINGLE_SIDE_CLEAN'] });
      else dec.review.push({ no: a.no, a, reason: 'only in structure parse and not clean' });
      continue;
    }
    seenB.add(b.no);
    if (spanOverlap(a, b) >= 0.8 && a.type === b.type) {
      dec.agreedNos.push(a.no);
      dec.accepted.push({ ...a, flags: [...(a.flags || []), 'CONSENSUS_AGREED'] });
    } else if (clean(a) && !clean(b)) dec.accepted.push({ ...a, flags: [...(a.flags || []), 'CONSENSUS_CLEAN_SIDE'] });
    else if (!clean(a) && clean(b)) dec.accepted.push({ ...b, flags: [...(b.flags || []), 'CONSENSUS_CLEAN_SIDE'] });
    else if (clean(a) && clean(b)) dec.needsCritic.push(a.no), dec.review.push({ no: a.no, a, b, reason: 'span conflict, both clean — critic tie-break or review' });
    else dec.review.push({ no: a.no, a, b, reason: 'span/type conflict, neither side clean' });
  }
  for (const b of bQs) {
    if (seenB.has(b.no) || aQs.some(q => q.no === b.no)) continue;
    if (clean(b)) dec.accepted.push({ ...b, flags: [...(b.flags || []), 'CONSENSUS_SINGLE_SIDE_CLEAN'] });
    else dec.review.push({ no: b.no, b, reason: 'only in consensus parse and not clean' });
  }
  dec.accepted.sort((x, y) => x.no - y.no);
  return dec;
}

/** Same-model consensus is a skip, never silent spend (CONSENSUS_SAME_MODEL info). */
export function resolveConsensusModel(structureModel: string, consensusModel?: string, escalationModel?: string):
  | { model: string; distinct: boolean }
  | { skip: true; code: 'CONSENSUS_SAME_MODEL'; model: string } {
  const candidate = consensusModel || escalationModel || structureModel;
  if (candidate === structureModel) return { skip: true, code: 'CONSENSUS_SAME_MODEL', model: candidate };
  return { model: candidate, distinct: candidate !== structureModel };
}

export const CONSENSUS_CAPS = { maxSections: 4, maxCalls: 6 };
