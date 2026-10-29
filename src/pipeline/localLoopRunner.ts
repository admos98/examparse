/** Six steps, in order. Every provider/payload failure is a note; there is no abort/budget exception class. */
import type { ImageAsset, SourceLine } from '../types';
import { sha256 } from '../utils/hash';
import { getPipelineCache, setPipelineCache } from '../store';
import {
  LOOP_VERSION, LOOP_FIX_SYSTEM, LOOP_READ_SYSTEM, LOOP_REVIEW_SYSTEM, applyCorrections, applyMetaCorrection,
  buildLoopPagePrompt, buildLoopPages, buildReviewChunks, checkAuthoredDocument, assignAuthoredImages, errorMessage, flaggedFixInput,
  mergePageReads, newLoopReceipt, pageFromResponse, parseCorrections,
  callWithOneRetry, fixOutputCap, pathologyNote, responsePathology, flatAuthoredQuestions,
  type LoopModelCaller, type LoopPathologyRecord, type LoopReceipt, type LoopStepId, type LoopVerdict,
} from './localLoop';
import { runLoopDecisionAudit, type LoopDecisionCaller } from './loopAudit';
import { runMapFirstRead, sectionReadVerdicts, type LoopMapReceipt } from './mapFirst';
import type { AppSettings } from '../types';
import { modelFacingLines } from './lineNormalize';

export interface LocalLoopParams {
  lines: SourceLine[]; images: ImageAsset[]; settings: AppSettings; fileHash: string;
  caller?: LoopModelCaller; modelId?: string; guidance?: string; force?: boolean;
  decisionCaller?: LoopDecisionCaller;
  imagePayload?: (image: ImageAsset) => Promise<{ id: string; mime: string; data: string } | undefined>;
  onStep?: (receipt: LoopReceipt, step: LoopStepId) => void | Promise<void>;
  onMapUpdate?: (map: LoopMapReceipt) => void | Promise<void>;
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
  const { images, settings, fileHash } = params;
  // #50 Part C: every model prompt and code count reads the normalized twin; watermark lines are furniture.
  const lines = modelFacingLines(params.lines);
  const cacheEnabled = settings.thrift.cacheEnabled && !params.force;
  const cacheGet = async <T>(key: string): Promise<T | undefined> => { if (!cacheEnabled) return undefined; try { return await getPipelineCache<T>(key); } catch { return undefined; } };
  const cacheSet = async (key: string, value: unknown) => { if (!settings.thrift.cacheEnabled) return; try { await setPipelineCache(key, value); } catch { /* optional */ } };
  const guidanceHash = await sha256(params.guidance || '');
  const call = async (step: LoopStepId, label: string, system: string, text: string, cap?: number) => {
    const row = receipt.steps.find(s => s.step === step)!;
    if (!params.caller) throw new Error('no local read model configured');
    row.calls++;
    // #50 Part A: proportional caps for map / section / fix calls (a loop can't burn the whole window).
    // The page-READ fallback keeps the generous authored-output allowance, never a run budget.
    const maxOutputTokens = cap ?? Math.min(65536, Math.max(16384, settings.budget.maxOutputTokens || 0, Math.ceil(text.length / 2)));
    const response = await params.caller({ step: step as any, system, text, label, maxOutputTokens });
    row.inputTokens += response.usage?.inputTokens || 0; row.outputTokens += response.usage?.outputTokens || 0;
    params.onUsage?.(step, response.usage || { inputTokens: 0, outputTokens: 0 }, label);
    params.onLiveText?.(step, label, 'output', response.rawText || '');
    try { await params.onJournal?.({ label, rawText: response.rawText, requestText: text }); } catch { /* optional */ }
    return response;
  };
  const recordPathology = (record: LoopPathologyRecord) => { (receipt.pathologies ||= []).push(record); };
  const parseWithRetry = async (step: 'self-review' | 'code-fix' | 'final-fix', label: string, system: string, text: string, cap?: number) => {
    let response = await call(step, label, system, text, cap);
    const salvage = (r: typeof response) => parseCorrections(r, { salvage: Boolean(responsePathology(r)) });
    if (responsePathology(response)) {
      // A breaker/cap cut: complete correction objects are salvaged and the target gets its ONE retry
      // (shared with the unparseable-output retry below — never a third call).
      const result = await callWithOneRetry({ label, text, cap, first: response, call: (l, t) => call(step, l, system, t, cap),
        parse: salvage, count: c => c ? c.length : -1, onNote: m => note(receipt, step, m), onPathology: recordPathology });
      return { response: result.response, corrections: result.value };
    }
    let corrections = parseCorrections(response);
    if (!corrections) {
      note(receipt, step, `${label}: unparseable correction output — retried: true (once).`);
      const example = 'Return only JSON, for example: {"corrections":[{"action":"replace","questionNumber":1,"question":{"number":1,"type":"short","stem":"Example question?","options":[],"imageIds":[]}}]}. Include complete corrected objects and any passages. No invented answers or points.';
      response = await call(step, `${label} · retry`, example, text, cap);
      corrections = salvage(response);
      const kind = responsePathology(response);
      if (kind) {
        note(receipt, step, `${pathologyNote(`${label} · retry`, kind, response.breaker?.completedItems, corrections?.length ?? 0, cap)} Second failure on the same target — marked partial; no third attempt.`);
        recordPathology({ label, kind, cutAtItem: response.breaker?.completedItems, salvaged: corrections?.length ?? 0, retried: true, outcome: 'partial' });
      }
    }
    return { response, corrections };
  };
  const safe = async (step: LoopStepId, work: () => Promise<void>) => {
    const row = receipt.steps.find(s => s.step === step)!; row.status = 'running';
    await notify(params, receipt, step);
    try { await work(); if (row.status === 'running') row.status = 'completed'; }
    catch (error) { row.status = 'failed'; note(receipt, step, `${row.name} skipped — ${errorMessage(error)}; continuing with the current document.`); }
    await notify(params, receipt, step, true);
  };

  // 1. MAP, count, audit, scoped re-map, then section READ. Page READ is a never-empty fallback.
  await safe('read', async () => {
    const row = receipt.steps[0]; const pages = buildLoopPages(lines); const reads = [];
    if (lines.length && params.caller) {
      try {
        const mapped = await runMapFirstRead({ lines, images, settings, fileHash, guidance: params.guidance, decisionCaller: params.decisionCaller,
          call: (label, system, text, cap) => call('read', label, system, text, cap), cacheGet, cacheSet, onPathology: recordPathology,
          cacheKey: text => sha256(`${LOOP_VERSION}:map-read:${params.modelId || 'scripted'}:${guidanceHash}:${text}`),
          onNote: message => note(receipt, 'read', message),
          onAuditUsage: (usage, label) => params.onUsage?.('decision-audit', usage, label),
          onUpdate: async map => {
            receipt.map = structuredClone(map);
            try { await params.onMapUpdate?.(structuredClone(map)); } catch { /* UI is advisory */ }
            await notify(params, receipt, 'read');
          },
        });
        if (mapped) {
          receipt.map = mapped.map; receipt.document = mapped.document;
          receipt.reconciled = { ...(mapped.map.reconciled || { truncated: 0, deduped: 0 }) };
          receipt.sectionReReads = mapped.map.sectionReReads || 0;
          for (const message of mapped.map.notes) note(receipt, 'read', message);
          return;
        }
      } catch (error) { note(receipt, 'read', `Map-first READ unavailable — ${errorMessage(error)}; falling back to page READ.`); }
    }
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
        const pageKind = responsePathology(response as any);
        const parsed = pageFromResponse(response, chunk.page, Boolean(cached));
        if (pageKind) { const salvaged = parsed.document.questions.length; note(receipt, 'read', pathologyNote(label, pageKind, (response as any).breaker?.completedItems, salvaged)); recordPathology({ label, kind: pageKind, cutAtItem: (response as any).breaker?.completedItems, salvaged, retried: false, outcome: 'partial' }); }
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

  // Code image assignment follows READ and precedes SELF-REVIEW.
  assignAuthoredImages(receipt.document, images, lines, receipt.map);

  const patchTeacherVerdicts: LoopVerdict[] = [];
  const recordPatchNotes=(messages:string[])=>messages.forEach((message,index)=>{
    const no=Number(message.match(/(?:question|numbered) (\\d+)/i)?.[1]);
    patchTeacherVerdicts.push({id:`code:patch-unapplied:${receipt.steps[3].calls}:${index}`,kind:'patch-unapplied',questionNumbers:Number.isFinite(no)&&no>0?[no]:[],source:'code',message:`Teacher review required: ${message}`});
  });

  // 2. SELF-REVIEW — fresh call(s), whole exam when it fits, otherwise section/page chunks.
  await safe('self-review', async () => {
    const row = receipt.steps[1];
    if (!receipt.document.questions.length) { row.status = 'skipped'; note(receipt, 'self-review', 'Self-review skipped — no authored questions yet.'); return; }
    for (const [index, chunk] of buildReviewChunks(receipt.document, lines).entries()) {
      const label = `Self-review · ${index + 1}`;
      const mapDisputes = receipt.map ? [...receipt.map.codeVerdicts.map(v => v.message), ...receipt.map.remaps.filter(r => !r.applied).map(r => `${r.entryId}: ${r.reason}`)] : [];
      const text = `YOUR PARSE:\n${JSON.stringify(chunk.document)}${mapDisputes.length ? `\n\nMAP FINDINGS (proposals, not facts):\n${mapDisputes.join('\n')}` : ''}\n\nORIGINAL TEXT:\n${chunk.source}`;
      try {
        const { corrections } = await parseWithRetry('self-review', label, LOOP_REVIEW_SYSTEM, text, fixOutputCap(flatAuthoredQuestions(chunk.document).length));
        if (!corrections) { note(receipt, 'self-review', `${label}: unparseable correction output — step chunk skipped.`); continue; }
        const applied = applyCorrections(receipt.document, corrections);
        receipt.document = applied.document; row.correctionsApplied += applied.applied;
        for (const message of applied.notes) note(receipt, 'self-review', message);
        recordPatchNotes(applied.notes);
        if (applied.applied) await notify(params, receipt, 'self-review', true);
      } catch (error) { note(receipt, 'self-review', `${label} skipped — ${errorMessage(error)}.`); }
    }
  });

  // 3. CODE CHECK — closed verdict vocabulary; no content mutation and no gate.
  const remnants: LoopVerdict[] = [ ...(receipt.map?.sectionFindings?.map(v => ({ id: `code:${v.id}`, kind: 'section-range-mismatch' as const, questionNumbers: v.questionNumbers, source: 'code' as const, message: v.message })) || []), ...(receipt.map?.codeVerdicts.filter(v => v.kind === 'section-missing').map(v => ({ id: `code:${v.id}`, kind: 'section-missing' as const, questionNumbers: v.questionNumbers, source: 'code' as const, message: v.message })) || []), ...receipt.pages.filter(p => p.status === 'salvaged').map(p => ({
    id: `code:invalid-json-remnant:page-${p.page}`, kind: 'invalid-json-remnant' as const, questionNumbers: [], source: 'code' as const, page: p.page,
    message: `Page ${p.page} contained an invalid JSON remnant; only complete question objects were kept.`,
  })) ];
  const check = () => [...checkAuthoredDocument(receipt.document, images, remnants), ...sectionReadVerdicts(receipt.map, receipt.document, lines)];
  await safe('code-check', async () => {
    receipt.codeVerdicts = check();
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
        const proposedPassages = receipt.map?.passages.filter(p => group.some(v => (v.kind === 'passage-link-missing' || v.kind === 'blank-missing') && v.questionNumbers.some(n => n >= p.appliesToFirst && n <= p.appliesToLast))) || [];
        // #50 Part B: a missing cloze blank is a section-scoped re-ask — quote the owning section contract.
        const blankSections = receipt.map?.sections.filter(s => group.some(v => v.kind === 'blank-missing' && v.questionNumbers.some(n => n >= s.firstQuestion && n <= s.lastQuestion))) || [];
        const fixInput = flaggedFixInput(receipt.document, group, lines) + (proposedPassages.length ? `\n\nPROPOSED MAP PASSAGES (verify against source):\n${JSON.stringify(proposedPassages)}` : '')
          + (blankSections.length ? `\n\nSECTION SCOPE (insert each missing blank as a fillblank question linked to its passage):\n${JSON.stringify(blankSections)}` : '');
        const flagged = new Set(group.flatMap(v => v.questionNumbers)).size + (group.some(v => !v.questionNumbers.length) ? 1 : 0);
        const { response, corrections } = await parseWithRetry('code-fix', label, LOOP_FIX_SYSTEM, fixInput, fixOutputCap(flagged));
        if (!corrections) { note(receipt, 'code-fix', `${label}: unparseable correction output — patch skipped.`); continue; }
        const before = check();
        receipt.pointsWithdrawn = (receipt.pointsWithdrawn || 0) + corrections.filter(c=>c.pointsWithdrawn).length;
        let applied = applyCorrections(receipt.document, corrections);
        applied.document = applyMetaCorrection(response, applied.document, group);
        receipt.document = applied.document; row.correctionsApplied += applied.applied;
        const after = check();
        row.verdictsClosed += closedVerdictIds(before, after).length;
        for (const message of applied.notes) note(receipt, 'code-fix', message);
        recordPatchNotes(applied.notes);
        if (applied.applied) await notify(params, receipt, 'code-fix', true);
      } catch (error) { note(receipt, 'code-fix', `${label} skipped — ${errorMessage(error)}.`); }
    }
    receipt.codeVerdicts = check();
  });

  // 5. DECISION AUDIT — comments only; active mode merely selects the final pass's input.
  await safe('decision-audit', async () => {
    const audit = await runLoopDecisionAudit({ document: receipt.document, lines, images, settings, fileHash,
      decisionCaller: params.decisionCaller, imagePayload: params.imagePayload, onJournal: params.onJournal,
      onProgress: progress => {
        receipt.steps[4].auditProgress = progress;
        params.onLiveText?.('decision-audit', progress.currentItem || `Auditing ${receipt.document.questions.length} questions + ${images.length} images — ${progress.total} decisions`, 'output', progress.recent.join('\n'));
        void notify(params, receipt, 'decision-audit');
      } });
    receipt.auditMode = audit.mode; receipt.auditVerdicts = audit.verdicts;
    if(audit.dialect && audit.endpointHost) receipt.decisionProvenance={dialect:audit.dialect,host:audit.endpointHost};
    receipt.steps[4].calls = audit.calls; receipt.steps[4].inputTokens = audit.usage.inputTokens; receipt.steps[4].outputTokens = audit.usage.outputTokens;
    receipt.steps[4].verdictsRaised = audit.verdicts.filter(v => (v.probability ?? 1) < 0.8).length;
    if (receipt.steps[4].auditProgress) { const p = receipt.steps[4].auditProgress; note(receipt, 'decision-audit', `Decision audit · ${p.decided}/${p.total} decided · ${p.catches} catches · ${p.uncertain} uncertain · ${p.endpointErrors} endpoint errors · ${p.rate.toFixed(1)}/s`); }
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
        const { corrections } = await parseWithRetry('final-fix', label, LOOP_FIX_SYSTEM, flaggedFixInput(receipt.document, group, lines, true), fixOutputCap(new Set(group.flatMap(v => v.questionNumbers)).size || 1));
        if (!corrections) { note(receipt, 'final-fix', `${label}: unparseable correction output — patch skipped.`); continue; }
        const before = check();
        const applied = applyCorrections(receipt.document, corrections);
        receipt.document = applied.document; row.correctionsApplied += applied.applied;
        row.verdictsClosed += closedVerdictIds(before, check()).length;
        if (applied.applied) {
          const patched = new Set((corrections || []).filter(c => c.action !== 'delete').map(c => c.questionNumber));
          for (const verdict of group) if (verdict.questionNumbers.some(no => patched.has(no))) { verdict.closed = true; row.verdictsClosed++; }
          await notify(params, receipt, 'final-fix', true);
        }
        for (const message of applied.notes) note(receipt, 'final-fix', message);
        recordPatchNotes(applied.notes);
      } catch (error) { note(receipt, 'final-fix', `${label} skipped — ${errorMessage(error)}.`); }
    }
  });
  receipt.codeVerdicts = [...check(), ...patchTeacherVerdicts];
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
