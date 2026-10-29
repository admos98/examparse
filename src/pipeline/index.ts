/** #46 default path: extraction capabilities → six local loop steps → Present.
 * Model-authored JSON is authoritative. Checkers comment; only model patches change question content.
 * Legacy compile/repair/cloud modules remain available to explicit Assistant/proving-ground tools, never called here.
 */
import type { AppSettings, ExamDoc, Flag, ImageAsset, PipelineStageId, ProviderConfig, SourceLine, StageStatus, UsageRecord } from '../types';
import { computeDisplayName } from '../types';
import { extractDocument, type ExtractedDocument } from './extract';
import { runBatchedOcr } from './ocr';
import { applyTextRepairOverlay, runTextRepairStage, type TextRepairCache, type TextRepairCacheEntry } from './textRepair';
import { LLMAdapter } from '../providers/adapter';
import { sha256 } from '../utils/hash';
import { appendJournalCall } from './journal';
import { getCachedStageResult, setCachedStageResult } from './cache';
import { appendUsageRecord, getPipelineCache, getReviewImageBlob, loadExamDoc, loadPageThumbDataUrls, saveExamDoc, setPipelineCache } from '../store';
import { calculateActualCost } from '../utils/budget';
import { detectLanguageAndDirection } from '../utils/numbers';
import { labelImagesBatched } from './vision';
import { prepareReviewDocument } from './reviewIntegrity';
import { beginJob, endJob, guidanceSummary, type JobHandle } from './memory/harness';
import { runLocalLoop } from './localLoopRunner';
import { errorMessage, projectAuthoredDocument, type LoopReceipt, type LoopStepId } from './localLoop';
import type { LoopDecisionCaller } from './loopAudit';

export interface PipelineCallbacks {
  onStageUpdate: (stage: StageStatus) => void;
  onNodeUpdate?: (node: { id: string; label?: string; status: string; tokens?: number; error?: string }) => void;
  onUsageUpdate?: (record: UsageRecord) => void;
  onMapUpdate?: (map: import('./mapFirst').LoopMapReceipt) => void;
  onLiveText?: (stageId: string, label: string, channel: 'output' | 'reasoning' | 'info', fullText: string) => void;
}
export interface PipelineOptions {
  forceRerun?: boolean; answerKeyFile?: File | null; preExtracted?: ExtractedDocument; fileHash?: string; forceStages?: PipelineStageId[];
  /** Offline corpus / fault-injection seam; the browser uses the configured local read endpoint. */
  loopCaller?: import('./localLoop').LoopModelCaller;
  decisionCaller?: LoopDecisionCaller;
}
export { isLocalEndpoint, localProviderFor } from './localProvider';
import { localProviderFor } from './localProvider';
const usageRecord = (role: UsageRecord['role'], provider: any, usage: any, label: string, costTable: AppSettings['costTable'], cached = false): UsageRecord => ({
  ts: new Date().toISOString(), role, provider: provider?.name || 'local (unconfigured)', model: provider?.model || 'none',
  inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0,
  costUsd: cached ? 0 : calculateActualCost(usage?.inputTokens || 0, usage?.outputTokens || 0, provider?.model || '', costTable), label, ...(cached ? { isCachedHit: true } : {}),
});
const stageId = (step: LoopStepId): PipelineStageId => ({ read: 'read', 'self-review': 'self-review', 'code-check': 'check', 'code-fix': 'code-fix', 'decision-audit': 'audit', 'final-fix': 'final-fix' }[step] as PipelineStageId);
export { loopFlags } from './loopFlags';
import { loopFlags } from './loopFlags';
async function imagePayload(image: ImageAsset): Promise<{ id: string; mime: string; data: string } | undefined> {
  const blob = await getReviewImageBlob(image.blobKey || image.sha);
  if (!blob) return undefined;
  const mime = blob.type || image.mime;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'].includes(mime)) throw new Error('unsupported image MIME type');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('image payload size is invalid');
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { id: image.id, mime, data: btoa(binary) };
}

export async function runFullPipeline(file: File, settings: AppSettings, callbacks: PipelineCallbacks, options?: PipelineOptions): Promise<ExamDoc> {
  const stage = (value: StageStatus) => { try { callbacks.onStageUpdate(value); } catch { /* presentation cannot stop parsing */ } };
  const usageRecords: UsageRecord[] = [];
  const readProvider = localProviderFor(settings, 'read');
  const visionProvider = localProviderFor(settings, 'vision');
  const decideProvider = localProviderFor(settings, 'decide');
  const record = (r: UsageRecord) => { usageRecords.push(r); try { appendUsageRecord(r); callbacks.onUsageUpdate?.(r); } catch { /* usage is report-only */ } };
  const fileHash = options?.fileHash || await sha256(await file.arrayBuffer());
  const force = Boolean(options?.forceRerun) || !settings.thrift.cacheEnabled;
  const forceStage = (id: PipelineStageId) => force || Boolean(options?.forceStages?.includes(id));
  const cacheWrite = async (params: any, value: unknown) => { if (settings.thrift.cacheEnabled) try { await setCachedStageResult(params, value); } catch { /* optional */ } };
  const extractionNotes: string[] = [];
  stage({ id: 'extract', name: 'Extract', status: 'running', message: 'Extracting text, geometry, and images…' });
  const extracted = options?.preExtracted && options.fileHash === fileHash ? options.preExtracted : await extractDocument(file);
  let lines = extracted.lines; let ocrUsed = extracted.ocrUsed;
  if (extracted.scannedPageIndices.length && (extracted.pageImages.length || extracted.pageThumbKeys?.length)) {
    if (!visionProvider) extractionNotes.push('Scanned-page OCR skipped — configure a local vision model; extracted text is retained.');
    else try {
      let pageImages = extracted.pageImages;
      if (!pageImages.some(Boolean) && extracted.pageThumbKeys?.length) {
        const thumbs = await loadPageThumbDataUrls(extracted.pageThumbKeys, extracted.scannedPageIndices);
        pageImages = Array.from({ length: extracted.pages }, (_, i) => thumbs.get(i + 1) || '');
      }
      const key = { fileHash, stage: 'ocr' as const, provider: visionProvider.id, model: visionProvider.model, options: extracted.scannedPageIndices };
      const cached = !forceStage('extract') ? await getCachedStageResult<any>(key).catch(() => undefined) : undefined;
      if (cached?.mergedLines) { lines = cached.mergedLines; ocrUsed = true; record(usageRecord('ocr', visionProvider, {}, 'Extract · OCR (cache hit)', settings.costTable, true)); }
      else {
        const ocr = await runBatchedOcr({ pageImages, scannedPageIndices: extracted.scannedPageIndices, startLineNum: 1, providerConfig: visionProvider,
          maxOutputTokens: Math.max(4096, settings.budget.maxOutputTokens), onLiveText: (label, channel, text) => callbacks.onLiveText?.('extract', label, channel, text) });
        const scanned = new Set(extracted.scannedPageIndices); const merged: SourceLine[] = []; let seq = 1;
        for (let page = 1; page <= extracted.pages; page++) for (const line of (scanned.has(page) ? ocr.lines : extracted.lines).filter(l => l.page === page)) merged.push({ ...line, id: `L${String(seq++).padStart(4, '0')}` });
        lines = merged; ocrUsed = true; await cacheWrite(key, { mergedLines: merged }); record(usageRecord('ocr', visionProvider, ocr.usage, 'Extract · OCR', settings.costTable));
      }
    } catch (error) { extractionNotes.push(`OCR unavailable — ${errorMessage(error)}; extracted text is retained.`); }
  }
  const storedLines = lines;
  let lineRepairs: Record<string, string> = {}; let textRepairStats: any;
  if (settings.textRepairEnabled) {
    if (!readProvider) extractionNotes.push('Optional text repair skipped — no local read model.');
    else try {
      const cache: TextRepairCache = { get: async key => { try { return await getPipelineCache<TextRepairCacheEntry>(key); } catch { return undefined; } }, set: async (key, value) => { if (settings.thrift.cacheEnabled) await setPipelineCache(key, value); } };
      const repaired = await runTextRepairStage({ lines, keyLines: new Set(), enabled: true, provider: readProvider.id, model: readProvider.model, force: forceStage('extract'), cache,
        caller: async req => { const r = await LLMAdapter.execute({ role: 'text-repair', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: readProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } });
      lineRepairs = repaired.lineRepairs; textRepairStats = repaired.stats; lines = applyTextRepairOverlay(lines, lineRepairs);
    } catch (error) { extractionNotes.push(`Optional text repair skipped — ${errorMessage(error)}.`); }
  }
  const linesHash = await sha256(lines.map(l => `${l.id}|${l.page}|${l.y}|${l.text}`).join('\n'));
  let images = structuredClone(extracted.images);
  // One bundled caption operation before READ. Its failure is a note, never an image-payload abort.
  if (images.length && visionProvider) {
    const key = { fileHash, stage: 'vision' as const, provider: visionProvider.id, model: visionProvider.model, options: { linesHash, images: images.map(i => i.sha), version: 'loop-captions-v1' } };
    try {
      const cached = !forceStage('read') ? await getCachedStageResult<any>(key).catch(() => undefined) : undefined;
      if (cached?.images) { images = cached.images; record(usageRecord('vision', visionProvider, {}, 'Read · image captions (cache hit)', settings.costTable, true)); }
      else {
        const result = await labelImagesBatched({ images, sourceLines: lines, providerConfig: visionProvider,
          maxLongEdge: settings.thrift.imageMaxLongEdge, quality: settings.thrift.jpegQuality / 100,
          maxImagesPerVisionCall: settings.thrift.maxImagesPerVisionCall, maxOutputTokens: Math.max(8192, settings.budget.maxOutputTokens),
          onLiveText: (label, channel, text) => callbacks.onLiveText?.('read', label, channel, text) });
        const labels = new Map(result.updatedImages.map(i => [i.id, i])); images = images.map(i => labels.get(i.id) || i);
        await cacheWrite(key, { images }); record(usageRecord('vision', visionProvider, result.usage, 'Read · bundled image captions', settings.costTable));
      }
    } catch { extractionNotes.push('vision captions unavailable — image placement may need manual check.'); }
  } else if (images.length) extractionNotes.push('vision captions unavailable — no local vision model; image placement may need manual check.');
  stage({ id: 'extract', name: 'Extract', status: extractionNotes.length ? 'completed-with-problems' : 'completed', message: `${lines.length} lines · ${images.length} images · ${extracted.pages} pages${ocrUsed ? ' · OCR used' : ''}. ${extractionNotes.join(' ')}` });

  const detection = detectLanguageAndDirection(lines.slice(0, 60).map(l => l.text).join(' '));
  const examId = `exam_${fileHash.slice(0, 12)}`;
  let displayName = file.name.replace(/\.[^/.]+$/, '') || 'Exam'; let nameSource: 'ai' | 'manual' = 'ai'; let createdAt = new Date().toISOString();
  try { const old = await loadExamDoc(examId); if (old) { createdAt = old.createdAt; if (old.nameSource === 'manual' && old.displayName) { displayName = old.displayName; nameSource = 'manual'; } } } catch { /* first parse */ }
  let job: JobHandle | undefined;
  try { job = await beginJob({ kind: 'pipeline', sourceLines: lines, images, pages: extracted.pages, languageHint: detection.language, modelId: readProvider?.model || '', models: { read: readProvider?.model || '', vision: visionProvider?.model || '', decide: decideProvider?.model || '' }, role: 'read', includeSkills: true }); } catch { /* memory is advisory */ }
  const caller = options?.loopCaller || (readProvider ? async (req: import('./localLoop').LoopModelRequest) => {
    const response = await LLMAdapter.execute({ role: 'read', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens,
      providerConfig: { ...readProvider, disableReasoning: true } }, {
      detectCountingLoop: true, salvagePartial: true,
      onDelta: (channel, fullText) => callbacks.onLiveText?.(stageId(req.step), req.label, channel, fullText),
      onInfo: message => callbacks.onLiveText?.(stageId(req.step), req.label, 'info', message),
    });
    return { rawText: response.rawText, json: response.json, usage: response.usage };
  } : undefined);
  const journalKey = `local-loop:${fileHash}:${linesHash}`;
  let doc: ExamDoc = {
    id: examId, fileHash, createdAt, displayName, nameSource,
    meta: { language: detection.language, direction: detection.direction }, sections: [], questions: [], images,
    source: { lines: storedLines, pages: extracted.pages, ocrUsed, fileName: file.name, pageImages: extracted.pageImages, pageThumbKeys: extracted.pageThumbKeys || [], diagnostics: extracted.diagnostics,
      ...(Object.keys(lineRepairs).length ? { lineRepairs } : {}), ...(textRepairStats ? { textRepairStats } : {}) },
    flags: [], usage: usageRecords, guidanceTokens: job?.guidanceTokens || 0,
  };
  const applyReceipt = (receipt: LoopReceipt) => {
    const projected = projectAuthoredDocument(receipt.document);
    const meta = { ...doc.meta, ...projected.meta };
    doc = { ...doc, meta, questions: projected.questions, sections: projected.sections, instructionGroups: structuredClone(receipt.document.instructionGroups || []), passages: structuredClone(receipt.document.passages || []), images, partial: receipt.survivingVerdicts.length > 0,
      displayName: nameSource === 'manual' ? displayName : computeDisplayName(meta, file.name),
      usage: [...usageRecords], loop: structuredClone(receipt), guidanceTokens: job?.guidanceTokens || 0 };
    doc.flags = loopFlags(receipt, doc);
    if (nameSource === 'manual') doc.nameSource = 'manual';
  };
  const loop = await runLocalLoop({ lines, images, settings, fileHash, caller, modelId: readProvider ? `${readProvider.id}:${readProvider.model}` : 'scripted', guidance: [job?.playbook.block, job?.skillsBlock].filter(Boolean).join('\n\n'),
    force: forceStage('read'), decisionCaller: options?.decisionCaller, imagePayload,
    onJournal: async entry => { if (settings.thrift.cacheEnabled) await appendJournalCall(journalKey, { ts: new Date().toISOString(), ...entry, complete: true }); },
    onMapUpdate: map => callbacks.onMapUpdate?.(map),
    onLiveText: (step, label, channel, text) => callbacks.onLiveText?.(stageId(step), label, channel, text),
    onUsage: (step, usage, label, cached) => record(usageRecord(step === 'decision-audit' ? 'decide' : 'read', step === 'decision-audit' ? decideProvider : readProvider, usage, label, settings.costTable, cached)),
    onStep: (receipt, step) => {
      applyReceipt(receipt); const row = receipt.steps.find(s => s.step === step)!;
      const status = row.status === 'running' ? 'running' : row.status === 'failed' ? 'completed-with-problems' : row.status === 'idle' ? 'idle' : row.status;
      const progress = row.auditProgress;
      stage({ id: stageId(step), name: row.name, status, message: progress && row.status === 'running' ? `${progress.decided === 0 ? `Auditing ${progress.questions} questions + ${progress.images} images — ${progress.total} decisions · ` : ''}Decision audit · ${progress.decided}/${progress.total} decided · ${progress.catches} catches · ${progress.uncertain} uncertain · ${progress.endpointErrors} endpoint errors · ${progress.rate.toFixed(1)}/s${progress.currentItem ? ` · ${progress.currentItem}` : ''}${progress.skipped ? ' · endpoint unreachable — skipping' : ''}` : `${row.calls} call(s) · ${row.correctionsApplied} correction(s) applied · ${row.verdictsRaised} verdict(s) raised · ${row.verdictsClosed} closed.${row.notes.length ? ` ${row.notes.join(' ')}` : ''}`, inputTokens: row.inputTokens, outputTokens: row.outputTokens });
      callbacks.onNodeUpdate?.({ id: step, label: row.name, status: row.status, tokens: row.inputTokens + row.outputTokens });
    },
    onSave: async receipt => { applyReceipt(receipt); await saveExamDoc(doc); },
  });
  for (const message of extractionNotes) if (!loop.notes.includes(message)) loop.notes.unshift(message);
  applyReceipt(loop);
  stage({ id: 'present', name: 'Present', status: loop.survivingVerdicts.length || loop.notes.length ? 'completed-with-problems' : 'completed', message: `${doc.questions.length} questions · ${doc.sections.length} sections · ${loop.survivingVerdicts.length} surviving verdict(s). The authored document is retained.` });
  try { await saveExamDoc(doc); doc = await prepareReviewDocument(doc, getReviewImageBlob); }
  catch (error) { const message = `Final save/preview unavailable — ${errorMessage(error)}; the parsed document remains available in this session.`; loop.notes.push(message); doc.flags.push({ id: 'loop_save_note', code: 'LOOP_NOTE', severity: 'warn', message }); }
  if (job) try {
    const pointsParsed = doc.questions.reduce((sum, q) => sum + (q.points || 0), 0);
    const missing = loop.codeVerdicts.filter(v => v.kind === 'missing-number').flatMap(v => v.questionNumbers);
    const duplicates = loop.codeVerdicts.filter(v => v.kind === 'duplicate-number').flatMap(v => v.questionNumbers);
    await endJob(job, { health: { expected: Math.max(0, ...doc.questions.map(q => q.no)), parsed: doc.questions.length, missing, duplicates, coveragePercent: doc.questions.length ? doc.questions.length / Math.max(1, ...doc.questions.map(q => q.no)) * 100 : 0, state: loop.survivingVerdicts.length ? 'partial' : 'complete', complete: !loop.survivingVerdicts.length, pointsParsed, pointsExpected: doc.meta.totalPoints },
      verifierDefects: loop.survivingVerdicts.length, defectFixRates: { localFixed: loop.steps.reduce((s, r) => s + r.correctionsApplied, 0), cloudFixed: 0, teacherLeft: loop.survivingVerdicts.length },
      calls: usageRecords.filter(r => !r.isCachedHit).length, tokens: { input: usageRecords.reduce((s, r) => s + r.inputTokens, 0), output: usageRecords.reduce((s, r) => s + r.outputTokens, 0) }, costUsd: usageRecords.reduce((s, r) => s + (r.costUsd || 0), 0),
      ladderPath: loop.steps.map(s => s.step), flagsRaised: loop.survivingVerdicts.map(v => v.kind), settings,
      // No seventh generative step: retain memory evidence/injection, but do not launch the legacy cloud reflection model.
      reflection: { loadConfig: async () => ({ learningEnabled: true, reflectionEnabled: false }) },
      baselineRevision: `${doc.questions.length}:${doc.sections.length}:${doc.meta.totalPoints ?? 'null'}`, sourceLines: lines.slice(0, 500).map(l => l.text),
    }); callbacks.onLiveText?.('present', 'Memory', 'info', guidanceSummary(job));
  } catch { /* memory is report-only */ }
  stage({ id: 'present', name: 'Present', status: loop.survivingVerdicts.length || loop.notes.length ? 'completed-with-problems' : 'completed', message: `${doc.questions.length} questions · ${doc.sections.length} sections · ${loop.survivingVerdicts.length} surviving verdict(s).` });
  return doc;
}

// Explicit legacy/tooling exports. Importing them does not run them in the default pipeline.
export { sliceSourceSpans, carveOptionsAcrossLines, carveGroupChildSpans } from './spans';
export { canonicalizeForms, computeShapeAudit, runFinalCanonicalization, FORM_EXECUTION_ORDER, FORM_RULE_ID } from './forms';
export { replayFieldExport } from './fieldReplay';
export { retryFailedPage } from './pageRetry';
