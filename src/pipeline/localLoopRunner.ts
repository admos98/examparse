/** Six steps, in order. Every provider/payload failure is a note; there is no abort/budget exception class. */
import type { ImageAsset, SourceLine } from '../types';
import { sha256 } from '../utils/hash';
import { getPipelineCache, setPipelineCache } from '../store';
import {
  LOOP_VERSION, LOOP_FIX_SYSTEM, LOOP_READ_SYSTEM, LOOP_REVIEW_SYSTEM, applyCorrections, applyMetaCorrection,
  buildLoopPagePrompt, buildLoopPages, buildReviewChunks, checkAuthoredDocument, errorMessage, flaggedFixInput,
  mergePageReads, newLoopReceipt, pageFromResponse, parseCorrections,
  type LoopModelCaller, type LoopReceipt, type LoopStepId, type LoopVerdict,
} from './localLoop';
import { runLoopDecisionAudit, type LoopDecisionCaller } from './loopAudit';
import type { AppSettings } from '../types';

export interface LocalLoopParams {
  lines: SourceLine[]; images: ImageAsset[]; settings: AppSettings; fileHash: string;
  caller?: LoopModelCaller; modelId?: string; guidance?: string; force?: boolean;
  decisionCaller?: LoopDecisionCaller;
  imagePayload?: (image: ImageAsset) => Promise<{ id: string; mime: string; data: string } | undefined>;
  onStep?: (receipt: LoopReceipt, step: LoopStepId) => void | Promise<void>;
  /** Called after READ and each subsequent step, including applied patches. Persistence is owned by the app shell. */
  onSave?: (receipt: LoopReceipt, step: LoopStepId) => Promise<void>;
  onLiveText?: (step: LoopStepId, label: string, channel: 'output' | 'reasoning' | 'info', text: string) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText?: string }) => void | Promise<void>;
  onUsage?: (step: LoopStepId, usage: { inputTokens: number; outputTokens: number }, label: string, cached?: boolean) => void;
}
const note = (receipt: LoopReceipt, step: LoopStepId, message: string) => {
  const row = receipt.steps.find(s => s.step === step)!;
  if (!row.notes.includes(message)) row.notes.push(message);
  if (!receipt.notes.includes(message)) receipt.notes.push(message);
};
async function notify(params: LocalLoopParams, receipt: LoopReceipt, step: LoopStepId, save = false) {
  try { await params.onStep?.(receipt, step); } catch { /* UI callbacks cannot stop the loop */ }
  if (save) try { await params.onSave?.(receipt, step); } catch (error) { note(receipt, step, `Document kept in memory; save unavailable — ${errorMessage(error)}`); }
}
export async function runLocalLoop(params: LocalLoopParams): Promise<LoopReceipt> {
  const receipt = newLoopReceipt();
  const { lines, images, settings, fileHash } = params;
  const cacheEnabled = settings.thrift.cacheEnabled && !params.force;
  const cacheGet = async <T>(key: string): Promise<T | undefined> => { if (!cacheEnabled) return undefined; try { return await getPipelineCache<T>(key); } catch { return undefined; } };
  const cacheSet = async (key: string, value: unknown) => { if (!settings.thrift.cacheEnabled) return; try { await setPipelineCache(key, value); } catch { /* optional */ } };
  const guidanceHash = await sha256(params.guidance || '');
  const call = async (step: LoopStepId, label: string, system: string, text: string) => {
    const row = receipt.steps.find(s => s.step === step)!;
    if (!params.caller) throw new Error('no local read model configured');
    row.calls++;
    // Generous authored-output allowance, never the old 800+30/line cap and never a run budget.
    const maxOutputTokens = Math.min(65536, Math.max(16384, settings.budget.maxOutputTokens || 0, Math.ceil(text.length / 2)));
    const response = await params.caller({ step: step as any, system, text, label, maxOutputTokens });
    row.inputTokens += response.usage?.inputTokens || 0; row.outputTokens += response.usage?.outputTokens || 0;
    params.onUsage?.(step, response.usage || { inputTokens: 0, outputTokens: 0 }, label);
    params.onLiveText?.(step, label, 'output', response.rawText || '');
    try { await params.onJournal?.({ label, rawText: response.rawText, requestText: text }); } catch { /* optional */ }
    return response;
  };
  const safe = async (step: LoopStepId, work: () => Promise<void>) => {
    const row = receipt.steps.find(s => s.step === step)!; row.status = 'running';
    await notify(params, receipt, step);
    try { await work(); if (row.status === 'running') row.status = 'completed'; }
    catch (error) { row.status = 'failed'; note(receipt, step, `${row.name} skipped — ${errorMessage(error)}; continuing with the current document.`); }
    await notify(params, receipt, step, true);
  };

  // 1. READ — one local call per page, cached by that page's actual input, never by a call allowance.
  await safe('read', async () => {
    const row = receipt.steps[0]; const pages = buildLoopPages(lines); const reads = [];
    if (!pages.length) note(receipt, 'read', 'No extracted page text; the source document shell is still saved.');
    for (const chunk of pages) {
      const text = buildLoopPagePrompt(chunk, images, params.guidance);
      const key = await sha256(`${LOOP_VERSION}:read:${fileHash}:${params.modelId || (params.caller ? 'scripted' : 'none')}:${guidanceHash}:${text}`);
      const pageRow = { page: chunk.page, status: 'failed' as any, calls: 0, questions: 0, notes: [] as string[] };
      try {
        const cached = await cacheGet<{ rawText: string; json?: unknown }>(key);
        const label = `Read · page ${chunk.page}/${pages.length}`;
        let response = cached;
        if (response) { row.status = 'cached'; params.onUsage?.('read', { inputTokens: 0, outputTokens: 0 }, `${label} (cache hit)`, true); }
        else response = await call('read', label, LOOP_READ_SYSTEM, text);
        const parsed = pageFromResponse(response, chunk.page, Boolean(cached));
        reads.push(parsed.document);
        Object.assign(pageRow, parsed.receipt);
        for (const message of parsed.receipt.notes) note(receipt, 'read', message);
        if (!cached && parsed.receipt.status !== 'empty' && parsed.receipt.status !== 'failed') await cacheSet(key, { rawText: response.rawText, json: response.json });
      } catch (error) {
        const message = /image payload/i.test(errorMessage(error)) ? `Page ${chunk.page}: vision captions unavailable — image placement may need manual check.` : `Page ${chunk.page} read skipped — ${errorMessage(error)}.`;
        pageRow.notes.push(message); note(receipt, 'read', message);
      }
      receipt.pages.push(pageRow);
      params.onLiveText?.('read', `Page ${chunk.page}`, 'info', `${pageRow.status}: ${pageRow.questions} question(s). ${pageRow.notes.join(' ')}`);
      await notify(params, receipt, 'read');
    }
    receipt.document = mergePageReads(reads);
    if (row.status === 'running') row.status = 'completed';
  });

  // 2. SELF-REVIEW — fresh call(s), whole exam when it fits, otherwise section/page chunks.
  await safe('self-review', async () => {
    const row = receipt.steps[1];
    if (!receipt.document.questions.length) { row.status = 'skipped'; note(receipt, 'self-review', 'Self-review skipped — no authored questions yet.'); return; }
    for (const [index, chunk] of buildReviewChunks(receipt.document, lines).entries()) {
      const label = `Self-review · ${index + 1}`;
      const text = `YOUR PARSE:\n${JSON.stringify(chunk.document)}\n\nORIGINAL TEXT:\n${chunk.source}`;
      try {
        const response = await call('self-review', label, LOOP_REVIEW_SYSTEM, text);
        const corrections = parseCorrections(response);
        if (!corrections) { note(receipt, 'self-review', `${label}: unparseable correction output — step chunk skipped.`); continue; }
        const applied = applyCorrections(receipt.document, corrections);
        receipt.document = applied.document; row.correctionsApplied += applied.applied;
        for (const message of applied.notes) note(receipt, 'self-review', message);
        if (applied.applied) await notify(params, receipt, 'self-review', true);
      } catch (error) { note(receipt, 'self-review', `${label} skipped — ${errorMessage(error)}.`); }
    }
  });

  // 3. CODE CHECK — closed verdict vocabulary; no content mutation and no gate.
  const remnants: LoopVerdict[] = receipt.pages.filter(p => p.status === 'salvaged').map(p => ({
    id: `code:invalid-json-remnant:page-${p.page}`, kind: 'invalid-json-remnant', questionNumbers: [], source: 'code', page: p.page,
    message: `Page ${p.page} contained an invalid JSON remnant; only complete question objects were kept.`,
  }));
  await safe('code-check', async () => {
    receipt.codeVerdicts = checkAuthoredDocument(receipt.document, images, remnants);
    receipt.steps[2].verdictsRaised = receipt.codeVerdicts.length;
  });

  // 4. CODE-VERDICT FIX — flagged full objects + their source pages + plain-language comments, one pass.
  await safe('code-fix', async () => {
    const row = receipt.steps[3]; const verdicts = receipt.codeVerdicts;
    if (!verdicts.length) { row.status = 'skipped'; note(receipt, 'code-fix', 'No code verdicts to fix.'); return; }
    const groups = chunkVerdicts(verdicts);
    for (const [index, group] of groups.entries()) {
      const label = `Code-verdict fix · ${index + 1}`;
      try {
        const response = await call('code-fix', label, LOOP_FIX_SYSTEM, flaggedFixInput(receipt.document, group, lines));
        const corrections = parseCorrections(response);
        if (!corrections) { note(receipt, 'code-fix', `${label}: unparseable correction output — patch skipped.`); continue; }
        const before = checkAuthoredDocument(receipt.document, images, remnants);
        let applied = applyCorrections(receipt.document, corrections);
        applied.document = applyMetaCorrection(response, applied.document, group);
        receipt.document = applied.document; row.correctionsApplied += applied.applied;
        const after = checkAuthoredDocument(receipt.document, images, remnants);
        row.verdictsClosed += closedVerdictIds(before, after).length;
        for (const message of applied.notes) note(receipt, 'code-fix', message);
        if (applied.applied) await notify(params, receipt, 'code-fix', true);
      } catch (error) { note(receipt, 'code-fix', `${label} skipped — ${errorMessage(error)}.`); }
    }
    receipt.codeVerdicts = checkAuthoredDocument(receipt.document, images, remnants);
  });

  // 5. DECISION AUDIT — comments only; active mode merely selects the final pass's input.
  await safe('decision-audit', async () => {
    const audit = await runLoopDecisionAudit({ document: receipt.document, lines, images, settings, fileHash,
      decisionCaller: params.decisionCaller, imagePayload: params.imagePayload, onJournal: params.onJournal });
    receipt.auditMode = audit.mode; receipt.auditVerdicts = audit.verdicts;
    receipt.steps[4].calls = audit.calls; receipt.steps[4].inputTokens = audit.usage.inputTokens; receipt.steps[4].outputTokens = audit.usage.outputTokens;
    receipt.steps[4].verdictsRaised = audit.verdicts.filter(v => (v.probability ?? 1) < 0.8).length;
    if (audit.calls) params.onUsage?.('decision-audit', audit.usage, `Decision audit · ${audit.calls} request(s)`);
    for (const message of audit.notes) note(receipt, 'decision-audit', message);
    if (audit.mode === 'skipped') receipt.steps[4].status = 'skipped';
    if (audit.mode === 'shadow') note(receipt, 'decision-audit', 'Shadow mode — verdicts reported only; nothing routed to Final fix.');
    // Attach the routing list to the receipt through verdict.routed; no edits happen here.
  });

  // 6. FINAL FIX — active confident-wrong items only, each question included exactly once. Then STOP.
  await safe('final-fix', async () => {
    const row = receipt.steps[5];
    const routed = receipt.auditVerdicts.filter(v => v.routed && (v.probability ?? 1) <= 0.2);
    if (receipt.auditMode !== 'active' || !routed.length) { row.status = 'skipped'; note(receipt, 'final-fix', receipt.auditMode === 'active' ? 'No confident-wrong audit verdicts to fix.' : 'Final fix skipped — decision audit did not route any items.'); return; }
    for (const [index, group] of chunkVerdicts(routed).entries()) {
      const label = `Final fix · ${index + 1}`;
      try {
        const response = await call('final-fix', label, LOOP_FIX_SYSTEM, flaggedFixInput(receipt.document, group, lines, true));
        const corrections = parseCorrections(response);
        if (!corrections) { note(receipt, 'final-fix', `${label}: unparseable correction output — patch skipped.`); continue; }
        const before = checkAuthoredDocument(receipt.document, images, remnants);
        const applied = applyCorrections(receipt.document, corrections);
        receipt.document = applied.document; row.correctionsApplied += applied.applied;
        row.verdictsClosed += closedVerdictIds(before, checkAuthoredDocument(receipt.document, images, remnants)).length;
        if (applied.applied) {
          const patched = new Set((corrections || []).filter(c => c.action !== 'delete').map(c => c.questionNumber));
          for (const verdict of group) if (verdict.questionNumbers.some(no => patched.has(no))) { verdict.closed = true; row.verdictsClosed++; }
          await notify(params, receipt, 'final-fix', true);
        }
        for (const message of applied.notes) note(receipt, 'final-fix', message);
      } catch (error) { note(receipt, 'final-fix', `${label} skipped — ${errorMessage(error)}.`); }
    }
  });
  receipt.codeVerdicts = checkAuthoredDocument(receipt.document, images, remnants);
  receipt.survivingVerdicts = [...receipt.codeVerdicts, ...receipt.auditVerdicts.filter(v => !v.closed && (v.probability ?? 1) < 0.8)];
  return receipt;
}
/** Partition work for small prompts, not a retry loop. A question is sent at most once per patch step,
 * but every verdict touching that question travels with it so the model sees the full comment set. */
function chunkVerdicts(verdicts: LoopVerdict[]): LoopVerdict[][] {
  const byNumber = new Map<number, LoopVerdict[]>();
  const extras: LoopVerdict[] = [];
  for (const verdict of verdicts) {
    if (!verdict.questionNumbers.length) { extras.push(verdict); continue; }
    for (const no of new Set(verdict.questionNumbers)) byNumber.set(no, [...(byNumber.get(no) || []), verdict]);
  }
  const groups: LoopVerdict[][] = [];
  const numbers = [...byNumber.keys()];
  for (let start = 0; start < numbers.length; start += 12) {
    const slice = new Set(numbers.slice(start, start + 12));
    const seen = new Set<string>();
    const group: LoopVerdict[] = [];
    for (const no of slice) for (const verdict of byNumber.get(no) || []) if (!seen.has(verdict.id)) {
      seen.add(verdict.id);
      group.push({ ...verdict, questionNumbers: verdict.questionNumbers.filter(n => slice.has(n)) });
    }
    if (group.length) groups.push(group);
  }
  // Image-only and exam-level meta verdicts ride in the first group (or their own group when no question is flagged).
  if (extras.length) { if (groups.length) groups[0].push(...extras); else groups.push(extras); }
  return groups;
}
function closedVerdictIds(before: LoopVerdict[], after: LoopVerdict[]): string[] {
  const remaining = new Set(after.map(v => v.id)); return before.filter(v => !remaining.has(v.id)).map(v => v.id);
}
