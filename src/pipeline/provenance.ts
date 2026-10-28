/** 2F — Provenance. Per-question decision trace + exam-level Parse report.
 * The export receipt must never embed secrets (test greps for the dummy key). */
import type { AuditSummary, ExamDoc, Question, SpineClassifyRecord, SpinePageReadRecord, SpineRepairRecord } from '../types';
import type { CriticVerdict } from './critic';
import { estimateTokens } from './memory/tokens';

export interface TransformRecord { kind: 'option-split' | 'answer-split' | 'numbering' | 'image-merge' | 'consensus' | 'critic' | 'patch' | 'manual' | 'rewrite' | 'gap-completion' | 'form-canonicalize'; detail: string; ts: string }
export interface QuestionTrace {
  questionId: string; no: number;
  origin: { callLabel: string; model: string; wireFormat?: string; journalResumed: boolean };
  transforms: TransformRecord[]; // last 8
  guidance: { playbookIds: string[]; skillIds: string[] };
  confidenceMath: { base: number; deductions: Array<{ reason: string; amount: number }>; final: number };
  verdicts: CriticVerdict[]; // last 3
  /** Deterministic source/rule receipt; optional on legacy records. */
  builtBy?: { lineStart: number; lineEnd: number; ruleChain: string[]; ruleConfidence: number };
}

export function buildTrace(params: {
  question: Question;
  origin: QuestionTrace['origin'];
  transforms?: TransformRecord[];
  guidance?: QuestionTrace['guidance'];
  confidenceMath?: QuestionTrace['confidenceMath'];
  verdicts?: CriticVerdict[];
}): QuestionTrace {
  const q = params.question;
  return {
    questionId: q.id, no: q.no,
    origin: params.origin,
    transforms: (params.transforms || []).slice(-8),
    guidance: params.guidance || { playbookIds: [], skillIds: [] },
    confidenceMath: params.confidenceMath || { base: q.confidence, deductions: [], final: q.confidence },
    verdicts: (params.verdicts || []).slice(-3),
    ...(q.receipt ? { builtBy: { lineStart: q.receipt.lineStart, lineEnd: q.receipt.lineEnd, ruleChain: [...q.receipt.ruleChain], ruleConfidence: q.receipt.ruleConfidence } } : {}),
  };
}

/** Trace for every question in a doc (100% coverage on goldens is test-asserted). */
export function tracesForDoc(doc: ExamDoc, origin: QuestionTrace['origin'], extras?: Record<string, Partial<QuestionTrace>>): QuestionTrace[] {
  return (doc.questions || []).map(q => buildTrace({ question: q, origin, ...(extras?.[q.id] || {}), transforms: [...localTransforms(doc, q), ...((extras?.[q.id] as any)?.transforms || [])] }));
}

/** D — deterministic transforms recoverable from the question itself: applied rewrites and gap-completed spans. */
export function localTransforms(doc: ExamDoc, q: Question): TransformRecord[] {
  const out: TransformRecord[] = [];
  const ts = doc.createdAt || new Date().toISOString();
  const byNo = new Map((doc.source?.lines || []).map(l => [Number(String(l.id).replace(/\D/g, '')), l.text]));
  for (const r of q.rewrites || []) {
    const original = byNo.get(r.line);
    out.push({ kind: 'rewrite', detail: `L${String(r.line).padStart(4, '0')} [GARBLED?] rendered from rewrite: “${(original || '').slice(0, 60)}” ⮕ “${r.text.slice(0, 60)}” (original retained; revert in Step 4)`, ts });
  }
  if ((q.flags || []).includes('GAP_ABSORBED')) out.push({ kind: 'gap-completion', detail: 'Unowned lines after the model\'s span were absorbed locally (B2); printed numbers, headers and key lines were never crossed.', ts });
  const formRules = (q.receipt?.ruleChain || []).filter(r => r.startsWith('form:'));
  if (formRules.length) {
    const typeNote = (q.flags || []).includes('TYPE_CORRECTED_BY_FORM') ? ` (type corrected to ${q.type})` : '';
    out.push({ kind: 'form-canonicalize', detail: `Applied deterministic form canonicalizer(s): ${formRules.join(', ')}${typeNote}.`, ts });
  }
  return out;
}

/** Plain-language bilingual timeline (EN + FA), for the Step 4 "Trace" disclosure. */
export function traceTimeline(trace: QuestionTrace): Array<{ en: string; fa: string }> {
  const lines: Array<{ en: string; fa: string }> = [{
    en: `Parsed by ${trace.origin.callLabel} (${trace.origin.model})${trace.origin.journalResumed ? ' — resumed from journal, 0 calls' : ''}.`,
    fa: `تجزیه‌شده توسط ${trace.origin.callLabel} (${trace.origin.model})${trace.origin.journalResumed ? ' — از ژورنال بازیابی شد، ۰ فراخوانی' : ''}.`,
  }];
  for (const t of trace.transforms) lines.push({ en: `${t.kind}: ${t.detail}`, fa: `${t.kind}: ${t.detail}` });
  if (trace.builtBy) {
    const displayRule = (rule: string) => rule === 'question-start' ? 'seg-number' : rule === 'watermark-excised' ? 'excision' : rule;
    const chain = trace.builtBy.ruleChain.map(displayRule).join(' → ');
    lines.push({ en: `Built by: ${chain} · conf ${Math.round(trace.builtBy.ruleConfidence)}`, fa: `ساخته‌شده با: ${chain} · اطمینان ${Math.round(trace.builtBy.ruleConfidence)}` });
  }
  const cm = trace.confidenceMath;
  lines.push({
    en: `Confidence ${cm.final.toFixed(2)} = base ${cm.base.toFixed(2)}${cm.deductions.map(d => ` − ${d.amount.toFixed(2)} (${d.reason})`).join('')}.`,
    fa: `اطمینان ${cm.final.toFixed(2)} = پایه ${cm.base.toFixed(2)}${cm.deductions.map(d => ` − ${d.amount.toFixed(2)} (${d.reason})`).join('')}.`,
  });
  for (const v of trace.verdicts) lines.push({ en: `Critic: ${v.verdict} — ${v.note}`, fa: `منتقد: ${v.verdict} — ${v.note}` });
  if (trace.guidance.playbookIds.length || trace.guidance.skillIds.length) {
    lines.push({ en: `Guidance injected: playbook [${trace.guidance.playbookIds.join(', ')}], skills [${trace.guidance.skillIds.join(', ')}].`, fa: `راهنمای تزریق‌شده: پلی‌بوک [${trace.guidance.playbookIds.join(', ')}]، مهارت‌ها [${trace.guidance.skillIds.join(', ')}].` });
  }
  return lines;
}

/** Agent tool get_trace payload — capped at ≤600 tokens by trimming oldest transforms. */
export function traceForAgent(trace: QuestionTrace, capTokens = 600): QuestionTrace {
  let out = trace;
  while (estimateTokens(JSON.stringify(out)) > capTokens && out.transforms.length) {
    out = { ...out, transforms: out.transforms.slice(1) };
  }
  return out;
}

export interface ParseReport {
  examId: string; parserVersion?: string; configHash: string;
  models: Record<string, string>; calls: number; tokens: { input: number; output: number }; cost: number;
  coverageBefore?: number; coverageAfter?: number;
  consensusSections: string[]; critic: { calls: number; defects: number; ok: number };
  /** #38: line-sorting provenance (classify role/model/calls; fallback is explicit, never silent). */
  classify?: SpineClassifyRecord;
  /** #40: per-page Global Read status (`local ok` / `cloud ok` / `failed`) for every sheet. */
  pages?: SpinePageReadRecord[];
  /** Read output-token totals grouped by the actual page wire format. */
  readOutputTokensByFormat?: Partial<Record<'compact' | 'verbose', number>>;
  /** #38: automatic fix loop summary (rounds, fixes applied/rejected, second opinions). */
  repairLoop?: SpineRepairRecord;
  /** #43: deterministic reconciliation counts for page proposals. */
  reconcile?: { total: number; byKind: Record<string, number> };
  /** #43: decision audit summary, or the skip line when no decide role is configured. */
  audit?: AuditSummary;
  memory: { playbookIds: string[]; skillIds: string[]; guidanceTokens: number };
  generatedAt: string;
}

/** Stable config fingerprint — hashes shape, never secret values. */
export function configHash(config: unknown): string {
  const text = JSON.stringify(config, (k, v) => (/key|token|secret|password/i.test(k) ? '[redacted]' : v)) || '';
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `cfg_${h.toString(16)}`;
}

export function buildParseReport(doc: ExamDoc, extras: Omit<ParseReport, 'examId' | 'generatedAt' | 'configHash'> & { config?: unknown }): ParseReport {
  const { config, ...rest } = extras as any;
  return { examId: doc.id, generatedAt: new Date().toISOString(), configHash: configHash(config ?? {}), ...rest };
}
