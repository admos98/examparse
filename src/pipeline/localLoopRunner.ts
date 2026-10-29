/** #51: six phases, in this order only — Extract → Map → Parse → Check → Fix → Present.
 * Both checkers (code, then decision audit) comment before the ONE generative Fix pass; Present re-checks
 * what Fix changed. Every provider/payload failure is a note; there is no abort/budget exception class. */
import type { AppSettings, ImageAsset, SourceLine } from '../types';
import { sha256 } from '../utils/hash';
import { getPipelineCache, setPipelineCache } from '../store';
import { LLMAdapter } from '../providers/adapter';
import { DECIDE_CATCH, DECIDE_PASS, DECIDE_TIMEOUT_MS } from './audit';
import {
  LOOP_VERSION, LOOP_FIX_SYSTEM, LOOP_READ_SYSTEM, applyCorrections, applyMetaCorrection,
  buildLoopPagePrompt, buildLoopPages, checkAuthoredDocument, assignAuthoredImages, errorMessage, flaggedFixInput,
  mergePageReads, newLoopReceipt, pageFromResponse, parseCorrections, mergeVerdicts, batchVerdictsBySection, changedQuestionNumbers,
  callWithOneRetry, fixOutputCap, pathologyNote, responsePathology, flatAuthoredQuestions,
  type LoopModelCaller, type LoopPathologyRecord, type LoopReceipt, type LoopPhaseId, type LoopStepId, type LoopVerdict,
} from './localLoop';
import { resolveDecisionProvider, runLoopDecisionAudit, type LoopAuditResult, type LoopDecisionCaller } from './loopAudit';
import { runMapPhase, runParsePhase, sectionReadVerdicts, type LoopMapReceipt, type MapFirstReadParams } from './mapFirst';
import { modelFacingLines } from './lineNormalize';

export interface LocalLoopParams {
  lines: SourceLine[]; images: ImageAsset[]; settings: AppSettings; fileHash: string;
  caller?: LoopModelCaller; modelId?: string; guidance?: string; force?: boolean;
  decisionCaller?: LoopDecisionCaller;
  imagePayload?: (image: ImageAsset) => Promise<{ id: string; mime: string; data: string } | undefined>;
  /** #51 Part A: the page image OCR rendered, reused temporarily for the visual map audit. */
  pageImage?: (page: number) => Promise<{ id: string; mime: string; data: string } | undefined>;
  /** Phase 1 happens before the loop (extraction, hygiene, OCR); its summary is recorded on the receipt row. */
  extract?: { calls?: number; notes?: string[] };
  onStep?: (receipt: LoopReceipt, step: LoopStepId) => void | Promise<void>;
  onMapUpdate?: (map: LoopMapReceipt) => void | Promise<void>;
  /** Called after Parse, Check, Fix and Present. Persistence is owned by the app shell. */
  onSave?: (receipt: LoopReceipt, step: LoopStepId) => Promise<void>;
  onLiveText?: (step: LoopStepId, label: string, channel: 'output' | 'reasoning' | 'info', text: string) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText?: string }) => void | Promise<void>;
  /** `role` tells generative (read) usage from decision-endpoint usage within the same phase. */
  onUsage?: (step: LoopStepId, usage: { inputTokens: number; outputTokens: number }, label: string, cached?: boolean, role?: 'read' | 'decide') => void;
}
const note = (receipt: LoopReceipt, step: LoopStepId, message: string) => {
  const row = receipt.steps.find(s => s.step === step)!;
  if (!row.notes.includes(message)) row.notes.push(message);
  if (!receipt.notes.includes(message)) receipt.notes.push(message);
};
/** Phase summary line: on the receipt row (and UI stage message) only — never a teacher attention note. */
const summary = (receipt: LoopReceipt, step: LoopStepId, message: string) => { const row = receipt.steps.find(s => s.step === step)!; if (!row.notes.includes(message)) row.notes.push(message); };
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
  const phaseRow = (phase: LoopPhaseId) => receipt.steps.find(s => s.step === phase)!;
  /** Collapsed timeline: the acceptance journal of what ran, in order (generate / decide / code). */
  const trace = (phase: LoopPhaseId, event: 'generate' | 'decide' | 'code') => {
    const timeline = (receipt.timeline ||= []); const last = timeline[timeline.length - 1];
    if (last && last.phase === phase && last.event === event) last.count++; else timeline.push({ phase, event, count: 1 });
  };
  const call = async (step: 'map' | 'parse' | 'fix', label: string, system: string, text: string, cap?: number) => {
    const row = phaseRow(step);
    if (!params.caller) throw new Error('no local read model configured');
    row.calls++; trace(step, 'generate');
    // #50 Part A: proportional caps for map / section / fix calls (a loop can't burn the whole window).
    // The page-parse fallback keeps the generous authored-output allowance, never a run budget.
    const maxOutputTokens = cap ?? Math.min(65536, Math.max(16384, settings.budget.maxOutputTokens || 0, Math.ceil(text.length / 2)));
    const response = await params.caller({ step, system, text, label, maxOutputTokens });
    row.inputTokens += response.usage?.inputTokens || 0; row.outputTokens += response.usage?.outputTokens || 0;
    params.onUsage?.(step, response.usage || { inputTokens: 0, outputTokens: 0 }, label, false, 'read');
    params.onLiveText?.(step, label, 'output', response.rawText || '');
    try { await params.onJournal?.({ label, rawText: response.rawText, requestText: text }); } catch { /* optional */ }
    return response;
  };
  const decideProvider = resolveDecisionProvider(settings);
  const decisionCallerFor = (phase: LoopPhaseId): LoopDecisionCaller | undefined => {
    const base: LoopDecisionCaller | undefined = params.decisionCaller || (decideProvider ? body => LLMAdapter.executeDecisions({ providerConfig: decideProvider, body, timeoutMs: DECIDE_TIMEOUT_MS }) : undefined);
    return base && (async body => { trace(phase, 'decide'); return base(body); });
  };
  const recordPathology = (record: LoopPathologyRecord) => { (receipt.pathologies ||= []).push(record); };
  const parseWithRetry = async (label: string, system: string, text: string, cap?: number) => {
    const step = 'fix' as const;
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
  const safe = async (step: LoopPhaseId, work: () => Promise<void>, save = true) => {
    const row = phaseRow(step); row.status = 'running';
    await notify(params, receipt, step);
    try { await work(); if (row.status === 'running') row.status = 'completed'; }
    catch (error) { row.status = 'failed'; note(receipt, step, `${row.name} skipped — ${errorMessage(error)}; continuing with the current document.`); }
    await notify(params, receipt, step, save);
  };

  // ── 1. EXTRACT ── already ran (text layer, #50 hygiene, OCR); the row records it so the receipt mirrors the UI.
  { const row = phaseRow('extract'); row.status = 'completed'; row.calls = params.extract?.calls || 0;
    for (const message of params.extract?.notes || []) if (!row.notes.includes(message)) row.notes.push(message);
    await notify(params, receipt, 'extract'); }

  // ── 2. MAP ── generative map → code count → decision audit (text + visual) → re-map of indicted entries only.
  // Not saved: there is no document yet, and an empty save would overwrite a previous good parse.
  let map: LoopMapReceipt | undefined;
  const mapParams = (phase: 'map' | 'parse'): MapFirstReadParams => ({ lines, images, settings, fileHash, guidance: params.guidance,
    decisionCaller: decisionCallerFor('map'), pageImage: params.pageImage, onCode: () => trace('map', 'code'),
    call: (label, system, text, cap) => call(phase, label, system, text, cap), cacheGet, cacheSet, onPathology: recordPathology,
    cacheKey: text => sha256(`${LOOP_VERSION}:map-read:${params.modelId || 'scripted'}:${guidanceHash}:${text}`),
    onNote: message => note(receipt, phase, message),
    onAuditUsage: (usage, label) => params.onUsage?.('map', usage, label, false, 'decide'),
    onUpdate: async m => {
      receipt.map = structuredClone(m);
      try { await params.onMapUpdate?.(structuredClone(m)); } catch { /* UI is advisory */ }
      await notify(params, receipt, phase);
    } });
  await safe('map', async () => {
    const row = phaseRow('map');
    if (!lines.length || !params.caller) { row.status = 'skipped'; note(receipt, 'map', !lines.length ? 'Map skipped — no extracted page text.' : 'Map skipped — no local read model configured.'); return; }
    try { map = await runMapPhase(mapParams('map')); }
    catch (error) { note(receipt, 'map', `Map unavailable — ${errorMessage(error)}; falling back to page parse.`); }
    if (!map) return;
    receipt.map = map;
    for (const message of map.notes) note(receipt, 'map', message);
    const indicted = map.auditVotes.filter(v => v.indicted).length;
    const remapped = map.remaps.filter(r => r.applied).length;
    row.calls += map.auditCalls; row.verdictsRaised = map.codeVerdicts.length + indicted; row.verdictsClosed = remapped; row.correctionsApplied = remapped;
    row.verdictsCarried = map.remaps.filter(r => !r.applied).length;
    const visual = map.visualAudit;
    summary(receipt, 'map', `Map: ${map.sections.length} section(s) · ${map.codeVerdicts.length} code count finding(s) · ${map.auditVotes.length} audit vote(s)${visual ? ` (${visual.voted} visual, ${visual.skipped} visual skipped)` : ''} · ${remapped} entr${remapped === 1 ? 'y' : 'ies'} re-mapped.`);
  }, false);

  // ── 3. PARSE ── per section against the contract (#50 re-read rule, cloze blanks). Page parse is the never-empty fallback.
  await safe('parse', async () => {
    const row = phaseRow('parse');
    if (map) {
      const notesBefore = map.notes.length;
      try {
        receipt.document = await runParsePhase(map, mapParams('parse'));
        receipt.map = map;
        receipt.reconciled = { ...(map.reconciled || { truncated: 0, deduped: 0 }) };
        receipt.sectionReReads = map.sectionReReads || 0;
        for (const message of map.notes.slice(notesBefore)) note(receipt, 'parse', message);
        assignAuthoredImages(receipt.document, images, lines, receipt.map);
        return;
      } catch (error) { note(receipt, 'parse', `Section parse unavailable — ${errorMessage(error)}; falling back to page parse.`); }
    }
    const pages = buildLoopPages(lines); const reads = [];
    if (!pages.length) note(receipt, 'parse', 'No extracted page text; the source document shell is still saved.');
    for (const chunk of pages) {
      const text = buildLoopPagePrompt(chunk, images, params.guidance);
      const key = await sha256(`${LOOP_VERSION}:read:${fileHash}:${params.modelId || (params.caller ? 'scripted' : 'none')}:${guidanceHash}:${text}`);
      const pageRow = { page: chunk.page, status: 'failed' as any, calls: 0, questions: 0, notes: [] as string[] };
      try {
        const cached = await cacheGet<{ rawText: string; json?: unknown }>(key);
        const label = `Read · page ${chunk.page}/${pages.length}`;
        let response = cached;
        if (response) { row.status = 'cached'; params.onUsage?.('parse', { inputTokens: 0, outputTokens: 0 }, `${label} (cache hit)`, true); }
        else response = await call('parse', label, LOOP_READ_SYSTEM, text);
        const pageKind = responsePathology(response as any);
        const parsed = pageFromResponse(response, chunk.page, Boolean(cached));
        if (pageKind) { const salvaged = parsed.document.questions.length; note(receipt, 'parse', pathologyNote(label, pageKind, (response as any).breaker?.completedItems, salvaged)); recordPathology({ label, kind: pageKind, cutAtItem: (response as any).breaker?.completedItems, salvaged, retried: false, outcome: 'partial' }); }
        reads.push(parsed.document);
        Object.assign(pageRow, parsed.receipt);
        for (const message of parsed.receipt.notes) note(receipt, 'parse', message);
        if (!cached && parsed.receipt.status !== 'empty' && parsed.receipt.status !== 'failed') await cacheSet(key, { rawText: response.rawText, json: response.json });
      } catch (error) {
        const message = /image payload/i.test(errorMessage(error)) ? `Page ${chunk.page}: vision captions unavailable — image placement may need manual check.` : `Page ${chunk.page} read skipped — ${errorMessage(error)}.`;
        pageRow.notes.push(message); note(receipt, 'parse', message);
      }
      receipt.pages.push(pageRow);
      params.onLiveText?.('parse', `Page ${chunk.page}`, 'info', `${pageRow.status}: ${pageRow.questions} question(s). ${pageRow.notes.join(' ')}`);
      await notify(params, receipt, 'parse');
    }
    receipt.document = mergePageReads(reads);
    assignAuthoredImages(receipt.document, images, lines, receipt.map);
    if (row.status === 'running') row.status = 'completed';
  });

  // ── 4. CHECK ── code verdicts, then the decision audit (catalogue + difficulty/hints). Both comment only.
  // Output: ONE merged, source-tagged verdict list. Nothing is edited here (difficulty/curriculum tags aside).
  const remnants: LoopVerdict[] = [ ...(receipt.map?.sectionFindings?.map(v => ({ id: `code:${v.id}`, kind: 'section-range-mismatch' as const, questionNumbers: v.questionNumbers, source: 'code' as const, message: v.message })) || []), ...(receipt.map?.codeVerdicts.filter(v => v.kind === 'section-missing').map(v => ({ id: `code:${v.id}`, kind: 'section-missing' as const, questionNumbers: v.questionNumbers, source: 'code' as const, message: v.message })) || []), ...receipt.pages.filter(p => p.status === 'salvaged').map(p => ({
    id: `code:invalid-json-remnant:page-${p.page}`, kind: 'invalid-json-remnant' as const, questionNumbers: [], source: 'code' as const, page: p.page,
    message: `Page ${p.page} contained an invalid JSON remnant; only complete question objects were kept.`,
  })) ];
  const check = () => [...checkAuthoredDocument(receipt.document, images, remnants), ...sectionReadVerdicts(receipt.map, receipt.document, lines)];
  const auditProgressText = (count: number) => `Auditing ${count} questions + ${images.length} images`;
  let audit: LoopAuditResult | undefined;
  await safe('check', async () => {
    const row = phaseRow('check');
    trace('check', 'code');
    receipt.codeVerdicts = check();
    summary(receipt, 'check', `Code check: ${receipt.codeVerdicts.length} verdict(s) — comments only.`);
    await notify(params, receipt, 'check');
    try {
      audit = await runLoopDecisionAudit({ document: receipt.document, lines, images, settings, fileHash,
        decisionCaller: decisionCallerFor('check'), imagePayload: params.imagePayload, onJournal: params.onJournal,
        onProgress: progress => {
          row.auditProgress = progress;
          params.onLiveText?.('check', progress.currentItem || `${auditProgressText(receipt.document.questions.length)} — ${progress.total} decisions`, 'output', progress.recent.join('\n'));
          void notify(params, receipt, 'check');
        } });
    } catch (error) { note(receipt, 'check', `Decision audit skipped — ${errorMessage(error)}; code verdicts stand alone.`); }
    if (audit) {
      receipt.auditMode = audit.mode; receipt.auditVerdicts = audit.verdicts;
      if (audit.dialect && audit.endpointHost) receipt.decisionProvenance = { dialect: audit.dialect, host: audit.endpointHost };
      row.calls = audit.calls; row.inputTokens = audit.usage.inputTokens; row.outputTokens = audit.usage.outputTokens;
      if (row.auditProgress) { const p = row.auditProgress; note(receipt, 'check', `Decision audit · ${p.decided}/${p.total} decided · ${p.catches} catches · ${p.uncertain} uncertain · ${p.endpointErrors} endpoint errors · ${p.rate.toFixed(1)}/s`); }
      if (audit.calls) params.onUsage?.('check', audit.usage, `Decision audit · ${audit.calls} request(s)`, false, 'decide');
      for (const message of audit.notes) note(receipt, 'check', message);
      if (audit.mode === 'shadow') note(receipt, 'check', 'Shadow mode — decision verdicts reported only; Fix receives the code verdicts alone.');
    }
    const decisions = receipt.auditMode === 'skipped' ? [] : receipt.auditVerdicts;
    receipt.mergedVerdicts = mergeVerdicts(receipt.codeVerdicts, decisions, DECIDE_PASS);
    const both = receipt.mergedVerdicts.filter(v => v.sources?.length === 2).length;
    row.verdictsRaised = receipt.mergedVerdicts.length;
    summary(receipt, 'check', `Merged verdict list: ${receipt.mergedVerdicts.length} (${receipt.mergedVerdicts.filter(v => v.source === 'code').length} code, ${receipt.mergedVerdicts.filter(v => v.source === 'decision' && !v.sources).length} decision, ${both} flagged by both and counted once).`);
  });

  // ── 5. FIX ── ONE generative patch pass, batched by section. In scope: code verdicts + confident-wrong decision
  // verdicts (active mode). Uncertain-band decision verdicts ride along as hints only. No loop, no second pass.
  const patchTeacherVerdicts: LoopVerdict[] = [];
  const recordPatchNotes = (messages: string[]) => messages.forEach((message, index) => {
    const no = Number(message.match(/(?:question|numbered) (\d+)/i)?.[1]);
    patchTeacherVerdicts.push({ id: `code:patch-unapplied:${phaseRow('fix').calls}:${index}`, kind: 'patch-unapplied', questionNumbers: Number.isFinite(no) && no > 0 ? [no] : [], source: 'code', message: `Teacher review required: ${message}` });
  });
  const active = receipt.auditMode === 'active';
  const merged = receipt.mergedVerdicts || [];
  // Shadow mode reports only: the fixer never sees a decision probability.
  const scope = active
    ? merged.filter(v => v.source === 'code' || v.sources?.includes('code') || (v.source === 'decision' && (v.probability ?? 1) <= DECIDE_CATCH))
    : receipt.codeVerdicts;
  const hints = active ? merged.filter(v => v.source === 'decision' && !v.sources && (v.probability ?? 1) > DECIDE_CATCH && (v.probability ?? 1) < DECIDE_PASS).map(v => ({ ...v, hint: true })) : [];
  let changed: number[] = [];
  await safe('fix', async () => {
    const row = phaseRow('fix');
    if (!scope.length) { row.status = 'skipped'; note(receipt, 'fix', 'Fix skipped — no code verdicts or confident-wrong decision verdicts in scope.'); return; }
    if (!params.caller) { row.status = 'skipped'; note(receipt, 'fix', 'Fix skipped — no local read model configured; verdicts carried to the attention list.'); return; }
    const sectionOf = (n: number) => flatAuthoredQuestions(receipt.document).find(q => q.number === n)?.sectionTitle
      || receipt.map?.sections.find(s => n >= s.firstQuestion && n <= s.lastQuestion)?.title || 'Unsectioned';
    const before = structuredClone(receipt.document);
    const batches = batchVerdictsBySection(receipt.document, scope, hints, sectionOf, 12);
    const perSection = new Map<string, number>(); for (const b of batches) perSection.set(b.section, (perSection.get(b.section) || 0) + 1);
    const seenSection = new Map<string, number>();
    for (const batch of batches) {
      const k = (seenSection.get(batch.section) || 0) + 1; seenSection.set(batch.section, k);
      const label = `Fix · ${batch.section}${(perSection.get(batch.section) || 1) > 1 ? ` (${k}/${perSection.get(batch.section)})` : ''}`;
      const group = [...batch.verdicts, ...batch.hints];
      try {
        const proposedPassages = receipt.map?.passages.filter(p => group.some(v => (v.kind === 'passage-link-missing' || v.kind === 'blank-missing') && v.questionNumbers.some(n => n >= p.appliesToFirst && n <= p.appliesToLast))) || [];
        // #50 Part B: a missing cloze blank is a section-scoped re-ask — quote the owning section contract.
        const blankSections = receipt.map?.sections.filter(s => group.some(v => v.kind === 'blank-missing' && v.questionNumbers.some(n => n >= s.firstQuestion && n <= s.lastQuestion))) || [];
        const fixInput = flaggedFixInput(receipt.document, group, lines) + (proposedPassages.length ? `\n\nPROPOSED MAP PASSAGES (verify against source):\n${JSON.stringify(proposedPassages)}` : '')
          + (blankSections.length ? `\n\nSECTION SCOPE (insert each missing blank as a fillblank question linked to its passage):\n${JSON.stringify(blankSections)}` : '');
        const flagged = new Set(group.flatMap(v => v.questionNumbers)).size + (group.some(v => !v.questionNumbers.length) ? 1 : 0);
        const { response, corrections } = await parseWithRetry(label, LOOP_FIX_SYSTEM, fixInput, fixOutputCap(flagged));
        if (!corrections) { note(receipt, 'fix', `${label}: unparseable correction output — patch skipped.`); continue; }
        receipt.pointsWithdrawn = (receipt.pointsWithdrawn || 0) + corrections.filter(c => c.pointsWithdrawn).length;
        const applied = applyCorrections(receipt.document, corrections);
        applied.document = applyMetaCorrection(response, applied.document, batch.verdicts);
        receipt.document = applied.document; row.correctionsApplied += applied.applied;
        for (const message of applied.notes) note(receipt, 'fix', message);
        recordPatchNotes(applied.notes);
        if (applied.applied) await notify(params, receipt, 'fix');
      } catch (error) { note(receipt, 'fix', `${label} skipped — ${errorMessage(error)}.`); }
    }
    changed = changedQuestionNumbers(before, receipt.document);
    summary(receipt, 'fix', `Fix: ${batches.length} section batch(es) · ${scope.length} verdict(s) in scope · ${hints.length} hint(s) · ${row.correctionsApplied} patch(es) applied · changed ${changed.length ? changed.map(n => `Q${n}`).join(', ') : 'nothing'}.`);
  });

  // ── 6. PRESENT ── re-check first: code re-runs (no model calls); the decision audit re-votes ONLY items Fix
  // changed or that were confidently indicted, reusing Check's votes for the rest. Survivors = attention list.
  await safe('present', async () => {
    const row = phaseRow('present');
    trace('present', 'code');
    receipt.codeVerdicts = [...check(), ...patchTeacherVerdicts];
    let revoted = 0, reused = 0;
    if (audit && audit.mode !== 'skipped' && audit.votes.size) {
      const changedSet = new Set(changed);
      const indictedIds = new Set(merged.filter(v => v.source === 'decision' && (v.probability ?? 1) <= DECIDE_CATCH).map(v => v.id));
      try {
        const re = await runLoopDecisionAudit({ document: receipt.document, lines, images, settings, fileHash,
          decisionCaller: decisionCallerFor('present'), imagePayload: params.imagePayload, onJournal: params.onJournal,
          recheck: { previous: audit.votes, revote: item => item.questionNumbers.some(n => changedSet.has(n)) || indictedIds.has(`decision:${item.id}`) },
          onProgress: progress => { row.auditProgress = progress; void notify(params, receipt, 'present'); } });
        receipt.auditVerdicts = re.verdicts; revoted = re.revoted; reused = re.reused;
        row.calls = re.calls; row.inputTokens = re.usage.inputTokens; row.outputTokens = re.usage.outputTokens;
        if (re.calls) params.onUsage?.('present', re.usage, `Decision re-check · ${re.calls} request(s)`, false, 'decide');
        for (const message of re.notes) note(receipt, 'present', `Re-check: ${message}`);
      } catch (error) { note(receipt, 'present', `Decision re-check skipped — ${errorMessage(error)}; Check votes kept.`); }
    }
    receipt.recheck = { codeModelCalls: 0, decisionRevoted: revoted, decisionReused: reused, changedQuestions: changed };
    receipt.survivingVerdicts = mergeVerdicts(receipt.codeVerdicts, receipt.auditMode === 'skipped' ? [] : receipt.auditVerdicts, DECIDE_PASS);
    const surviving = new Set(receipt.survivingVerdicts.map(v => v.id));
    const earlier = new Set(merged.map(v => v.id));
    row.verdictsCarried = receipt.survivingVerdicts.filter(v => earlier.has(v.id)).length;
    row.verdictsClosed = merged.filter(v => !surviving.has(v.id)).length;
    row.verdictsRaised = receipt.survivingVerdicts.filter(v => !earlier.has(v.id)).length;
    for (const v of merged) if (!surviving.has(v.id)) v.closed = true;
    const fixRow = phaseRow('fix');
    fixRow.verdictsClosed = scope.filter(v => !surviving.has(v.id)).length;
    fixRow.verdictsCarried = scope.length - fixRow.verdictsClosed;
    summary(receipt, 'present', `Re-check: code ${receipt.codeVerdicts.length} verdict(s), no model calls · decision re-voted ${revoted}, reused ${reused} · ${row.verdictsClosed} closed, ${row.verdictsCarried} carried, ${row.verdictsRaised} new → ${receipt.survivingVerdicts.length} on the attention list.`);
  });
  return receipt;
}
