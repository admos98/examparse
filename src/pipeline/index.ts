/**
 * #39 / #40 default pipeline: Extract → Global Read → Check → Repair → Present.
 * The model proposes document meaning page by page (sheet by sheet). Code only slices source text
 * and checks the closed arithmetic list. Failure of one page is a defect, never an empty document.
 */
import type { AppSettings, CompileSpineRecord, ExamDoc, Flag, ImageAsset, PipelineStageId, SourceLine, SpinePageReadRecord, StageStatus, UsageRecord } from '../types';
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
import {
  assembleReadProposal,
  pageReadFailedMessage,
  runGlobalReadStage,
  serializeReadProposal,
  type PageReadCache,
  type PageReadCacheEntry,
  type ReadProposal,
} from './globalRead';
import type { SpineBudget } from './classify';

/** #41: meta + repair keep their small bounded spine budget. The Global Read owns its own per-exam allowance. */
const SPINE_META_REPAIR_MAX_CALLS = 30;
const SPINE_META_REPAIR_MAX_UNITS = 200;
import { imageAsMetaInput, runMetaRead, type MetaReadResult } from './metaRead';
import { computeDefects, type Defect } from './defects';
import { runRepairLoop, serializeRepairLoopResult } from './repairLoop';
import { compileDocument } from './compile';
import { runDecisionAudit } from './audit';
import { autoDecorateRepeatedImages } from './quality';
import { labelImagesBatched } from './vision';
import { assignImagesExact, enforceSingleImageOwnership } from './imageOwnership';
import { validateAndFixDuplicateImageIds } from './assemble';
import { prepareReviewDocument } from './reviewIntegrity';
import { beginJob, endJob, guidanceSummary, type JobHandle } from './memory/harness';

export interface PipelineCallbacks {
  onStageUpdate: (stage: StageStatus) => void;
  onNodeUpdate?: (node: { id: string; label?: string; status: string; tokens?: number; error?: string }) => void;
  onUsageUpdate?: (record: UsageRecord) => void;
  onLiveText?: (stageId: string, label: string, channel: 'output' | 'reasoning' | 'info', fullText: string) => void;
}

const providerFor = (settings: AppSettings, role: 'read' | 'meta' | 'cloud' | 'repair' | 'vision') => {
  const selection = role === 'read'
    ? settings.roleMapping.read || settings.roleMapping.fast
    : role === 'meta'
      ? settings.roleMapping.meta || settings.roleMapping.read || settings.roleMapping.fast
      : role === 'cloud'
        ? settings.roleMapping.cloud || settings.roleMapping.escalation
        : role === 'repair'
          ? settings.roleMapping.repair || settings.roleMapping.read || settings.roleMapping.fast
          : settings.roleMapping.vision;
  const provider = settings.providers.find(p => p.id === selection.providerId) || settings.providers[0];
  return provider ? { ...provider, model: selection.model } : undefined;
};
const forcedOff = <T extends { disableReasoning?: boolean; extraBodyJson?: string }>(provider: T): T => {
  let extra: Record<string, unknown> = {};
  try { extra = provider.extraBodyJson ? JSON.parse(provider.extraBodyJson) : {}; } catch { extra = {}; }
  for (const key of ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking', 'chat_template_kwargs']) delete extra[key];
  return { ...provider, disableReasoning: true, extraBodyJson: Object.keys(extra).length ? JSON.stringify(extra) : '' };
};
const usageRecord = (role: UsageRecord['role'], provider: any, usage: any, label: string, cached = false): UsageRecord => ({
  ts: new Date().toISOString(), role, provider: provider?.name || 'unconfigured', model: provider?.model || 'none',
  inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0,
  costUsd: cached ? 0 : calculateActualCost(usage?.inputTokens || 0, usage?.outputTokens || 0, provider?.model || '', {}), label, ...(cached ? { isCachedHit: true } : {}),
});
async function topThirdPage(dataUrl: string | undefined): Promise<string | undefined> {
  if (!dataUrl?.startsWith('data:') || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return dataUrl;
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const height = Math.max(1, Math.ceil(bitmap.height / 3));
    const canvas = new OffscreenCanvas(bitmap.width, height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, bitmap.width, height, 0, 0, bitmap.width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${blob.type};base64,${btoa(binary)}`;
  } catch { return dataUrl; }
}
function defectFlags(defects: Defect[]): Flag[] {
  return defects.map((defect, i): Flag => {
    const qid = defect.questionIds[0];
    const imageId = defect.kind === 'image-unplaced' ? defect.id.replace(/^image-unplaced:/, '') : undefined;
    const map: Record<string, string> = {
      'hollow-question': 'STEM_HOLLOW',
      'options-missing': 'OPTIONS_MISSING',
      'points-unresolved': 'POINTS_UNPRICED',
      'points-sum': 'POINTS_MISMATCH',
      'image-ownership': 'IMAGE_ORDER_SUSPECT',
      'image-unplaced': 'IMAGE_UNPLACED',
      'audit-catch': 'AUDIT_CATCH',
    };
    return {
      id: `attention_survivor_${i + 1}`,
      severity: defect.kind === 'hollow-question' || defect.kind === 'options-missing' || defect.kind === 'audit-catch' ? 'error' : 'warn',
      code: map[defect.kind] || 'PARSE_CHECK_SURVIVOR',
      message: defect.detail,
      ...(qid ? { questionId: qid } : {}),
      ...(imageId ? { imageId } : {}),
      rootCauseId: defect.id,
    };
  });
}

export async function runFullPipeline(file: File, settings: AppSettings, callbacks: PipelineCallbacks, options?: { forceRerun?: boolean; answerKeyFile?: File | null; preExtracted?: ExtractedDocument; fileHash?: string; forceStages?: PipelineStageId[] }): Promise<ExamDoc> {
  const stage = callbacks.onStageUpdate; const usageRecords: UsageRecord[] = [];
  const record = (r: UsageRecord) => { usageRecords.push(r); appendUsageRecord(r); callbacks.onUsageUpdate?.(r); };
  const fileHash = options?.fileHash || await sha256(await file.arrayBuffer());
  const force = Boolean(options?.forceRerun) || !settings.thrift.cacheEnabled;
  const forceStage = (id: PipelineStageId) => force || Boolean(options?.forceStages?.includes(id));
  const cacheWrite = async (p: any, value: unknown) => { if (settings.thrift.cacheEnabled) await setCachedStageResult(p, value); };

  // 1 — EXTRACT. OCR and the fenced text-repair overlay are capabilities inside this stage, not semantic parser stages.
  stage({ id: 'extract', name: 'Extract', status: 'running', message: 'Extracting addressed lines, geometry, and images…' });
  let extracted = options?.preExtracted && options.fileHash === fileHash ? options.preExtracted : await extractDocument(file);
  let lines = extracted.lines; let ocrUsed = extracted.ocrUsed;
  if (extracted.scannedPageIndices.length && (extracted.pageImages.length || extracted.pageThumbKeys?.length)) {
    const vision = providerFor(settings, 'vision');
    if (vision) {
      let pageImages = extracted.pageImages;
      if (!pageImages.some(Boolean) && extracted.pageThumbKeys?.length) {
        const thumbs = await loadPageThumbDataUrls(extracted.pageThumbKeys, extracted.scannedPageIndices);
        pageImages = Array.from({ length: extracted.pages }, (_, i) => thumbs.get(i + 1) || '');
      }
      const ocrCache = { fileHash, stage: 'ocr' as any, provider: vision.id, model: vision.model, options: extracted.scannedPageIndices };
      const cachedOcr = !forceStage('extract') ? await getCachedStageResult<any>(ocrCache) : undefined;
      if (cachedOcr?.mergedLines) { lines = cachedOcr.mergedLines; ocrUsed = true; record(usageRecord('ocr', vision, {}, 'Extract · OCR (Cache Hit)', true)); }
      else {
        const ocr = await runBatchedOcr({ pageImages, scannedPageIndices: extracted.scannedPageIndices, startLineNum: 1, providerConfig: vision, maxOutputTokens: settings.budget.maxOutputTokens, onLiveText: (label, channel, text) => callbacks.onLiveText?.('extract', label, channel, text) });
        const scanned = new Set(extracted.scannedPageIndices); const merged: SourceLine[] = []; let seq = 1;
        for (let p = 1; p <= extracted.pages; p++) for (const l of (scanned.has(p) ? ocr.lines : extracted.lines).filter(x => x.page === p)) merged.push({ ...l, id: `L${String(seq++).padStart(4, '0')}` });
        lines = merged; ocrUsed = true; await cacheWrite(ocrCache, { mergedLines: merged, usage: ocr.usage }); record(usageRecord('ocr', vision, ocr.usage, 'Extract · scanned-page OCR'));
      }
    }
  }
  const storedLines = lines;
  let lineRepairs: Record<string, string> = {}; let textRepairStats: any;
  if (settings.textRepairEnabled) {
    const readProvider = providerFor(settings, 'read');
    const lineCache: TextRepairCache = { get: async key => { try { return await getPipelineCache<TextRepairCacheEntry>(key); } catch { return undefined; } }, set: async (key, value) => { if (settings.thrift.cacheEnabled) await setPipelineCache(key, value); } };
    const repaired = await runTextRepairStage({ lines, keyLines: new Set(), enabled: true, provider: readProvider?.id, model: readProvider?.model, force: forceStage('extract'), cache: lineCache, caller: readProvider ? async req => {
      const r = await LLMAdapter.execute({ role: 'text-repair', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: readProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage };
    } : undefined });
    lineRepairs = repaired.lineRepairs; textRepairStats = repaired.stats; lines = applyTextRepairOverlay(lines, lineRepairs);
  }
  const linesHash = (await sha256(lines.map(l => `${l.id}|${l.page}|${l.y}|${l.text}`).join('\n'))).slice(0, 20);
  stage({ id: 'extract', name: 'Extract', status: 'completed', message: `${lines.length} addressed lines · ${extracted.images.length} images · ${extracted.pages} pages${ocrUsed ? ' · OCR used' : ''}.` });

  const readProviderRaw = providerFor(settings, 'read'); const readProvider = readProviderRaw ? forcedOff(readProviderRaw) : undefined;
  const cloudProvider = providerFor(settings, 'cloud'); const cloudReadProvider = cloudProvider ? forcedOff(cloudProvider) : undefined;
  const repairProvider = providerFor(settings, 'repair'); const metaProviderRaw = providerFor(settings, 'meta'); const metaProvider = metaProviderRaw ? forcedOff(metaProviderRaw) : undefined;
  const visionProvider = providerFor(settings, 'vision');
  // #43: shared generative callers for compile re-asks (read role first, cloud rescue).
  const compileCaller = readProvider ? async (req: { system: string; text: string; maxOutputTokens?: number; label: string }) => {
    const r = await LLMAdapter.execute({ role: 'read', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: readProvider });
    return { rawText: r.rawText, json: r.json, usage: r.usage };
  } : undefined;
  const compileCloudCaller = cloudReadProvider ? async (req: { system: string; text: string; maxOutputTokens?: number; label: string }) => {
    const r = await LLMAdapter.execute({ role: 'cloud', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: cloudReadProvider });
    return { rawText: r.rawText, json: r.json, usage: r.usage };
  } : undefined;
  // #41: `agentLimits` governs only the Assistant executor. Meta + repair draw from this spine budget; Global Read does not.
  const budget: SpineBudget = { calls: 0, units: 0, maxCalls: SPINE_META_REPAIR_MAX_CALLS, maxUnits: SPINE_META_REPAIR_MAX_UNITS };
  const journalKey = `wing:${fileHash}:${linesHash}`;
  const journal = async (label: string, rawText: string, requestText?: string) => { if (settings.thrift.cacheEnabled) await appendJournalCall(journalKey, { ts: new Date().toISOString(), label, rawText, requestText, complete: true }); };

  let job: JobHandle | undefined;
  try { job = await beginJob({ kind: 'pipeline', sourceLines: lines, images: extracted.images, pages: extracted.pages, languageHint: detectLanguageAndDirection(lines.slice(0, 50).map(l => l.text).join(' ')).language, modelId: readProvider?.model || '', models: Object.fromEntries(Object.entries(settings.roleMapping).map(([k, v]) => [k, v?.model || ''])), role: 'read' as any }); } catch { job = undefined; }

  // 2 — GLOBAL READ (bundled vision captions first so each sheet prompt receives its page's image captions + addresses).
  stage({ id: 'read', name: 'Global Read', status: 'running', message: 'Reading sheet by sheet; reasoning is forced off…' });
  let updatedImages: ImageAsset[] = autoDecorateRepeatedImages(extracted.images);
  if (updatedImages.some(i => i.label?.role !== 'decoration') && visionProvider) {
    const visionCache = { fileHash, stage: 'vision' as any, provider: visionProvider.id, model: visionProvider.model, options: { linesHash, images: updatedImages.map(i => i.sha) } };
    const cachedVision = !forceStage('read') ? await getCachedStageResult<any>(visionCache) : undefined;
    if (cachedVision?.updatedImages) { updatedImages = cachedVision.updatedImages; record(usageRecord('vision', visionProvider, {}, 'Global Read · image captions (Cache Hit)', true)); }
    else {
      try {
        const vision = await labelImagesBatched({
          images: updatedImages.filter(i => i.label?.role !== 'decoration'),
          sourceLines: lines,
          providerConfig: visionProvider,
          maxLongEdge: settings.thrift.imageMaxLongEdge,
          quality: settings.thrift.jpegQuality / 100,
          maxImagesPerVisionCall: settings.thrift.maxImagesPerVisionCall,
          maxOutputTokens: settings.budget.maxOutputTokens,
        });
        const labelledById = new Map(vision.updatedImages.filter(i => Boolean(i.label)).map(i => [i.id, i]));
        updatedImages = updatedImages.map(i => labelledById.get(i.id) || i);
        await cacheWrite(visionCache, { updatedImages, usage: vision.usage });
        record(usageRecord('vision', visionProvider, vision.usage, 'Global Read · bundled image captions'));
      } catch { /* unowned images surface through image-unplaced defect */ }
    }
  }

  const pageCache: PageReadCache = {
    get: async key => {
      if (forceStage('read')) return undefined;
      try { return await getPipelineCache<PageReadCacheEntry>(key); } catch { return undefined; }
    },
    set: async (key, value) => {
      if (settings.thrift.cacheEnabled) {
        try { await setPipelineCache(key, value); } catch { /* ignore storage errors */ }
      }
    },
  };
  const readResult = await runGlobalReadStage({
    lines,
    images: updatedImages,
    model: readProvider?.model,
    pageCache,
    guidance: job?.playbook.block,
    onJournal: e => journal(e.label, e.rawText, e.requestText),
    onPageUpdate: (pageReport: SpinePageReadRecord, completed: number, total: number) => {
      const detail = pageReport.status === 'failed'
        ? `page ${pageReport.page} failed`
        : `page ${pageReport.page} ${pageReport.status} (${pageReport.questions} question${pageReport.questions === 1 ? '' : 's'})`;
      stage({ id: 'read', name: 'Global Read', status: 'running', message: `Sheet ${completed}/${total} · ${detail}…` });
      callbacks.onLiveText?.('read', 'Page progress', 'info', `Page ${pageReport.page}/${total}: ${pageReport.status}${pageReport.cached ? ' (cached)' : ''} — ${pageReport.questions} question(s)`);
    },
    caller: readProvider ? async req => {
      const response = await LLMAdapter.execute(
        { role: 'read', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: readProvider },
        { onDelta: (channel, full) => channel === 'output' && callbacks.onLiveText?.('read', req.label, channel, full) },
      );
      return { rawText: response.rawText, json: response.json, usage: response.usage };
    } : undefined,
    cloudCaller: cloudReadProvider ? async req => {
      const response = await LLMAdapter.execute(
        { role: 'cloud', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: cloudReadProvider },
        { onDelta: (channel, full) => channel === 'output' && callbacks.onLiveText?.('read', req.label, channel, full) },
      );
      return { rawText: response.rawText, json: response.json, usage: response.usage };
    } : undefined,
  });

  const proposal: ReadProposal | undefined = readResult.proposal;
  if (readResult.calls) {
    record(usageRecord('read', readProvider, readResult.usage, `Global Read (${readResult.calls} call${readResult.calls === 1 ? '' : 's'})`));
  } else if (readResult.status === 'cached') {
    record(usageRecord('read', readProvider, readResult.usage, 'Global Read (Cache Hit)', true));
  }
  if (readResult.cloudCalls) {
    record(usageRecord('cloud', cloudProvider, readResult.cloudUsage, `Cloud · Page Read (${readResult.cloudCalls} page${readResult.cloudCalls === 1 ? '' : 's'})`));
  }
  const cloudOkCount = readResult.pages.filter(p => p.status === 'cloud ok').length;
  stage({
    id: 'read',
    name: 'Global Read',
    status: !proposal
      ? 'completed-with-problems'
      : readResult.failedPages.length > 0
        ? 'completed-with-problems'
        : readResult.status === 'cached'
          ? 'cached'
          : 'completed',
    message: proposal
      ? `${proposal.questions.length} proposed questions · ${proposal.sections.length} proposed sections · ${readResult.pages.length - readResult.failedPages.length}/${readResult.pages.length} page(s) read${cloudOkCount ? ` (${cloudOkCount} via cloud)` : ''}${readResult.failedPages.length ? ` · ${readResult.failedPages.length} failed` : ''} · read calls ${readResult.calls + readResult.cloudCalls} of ${readResult.readAllowance}.`
      : `Global Read failed on all ${readResult.pages.length || extracted.pages} page(s); no code-first fallback was used. ${readResult.complaints.join('; ')}`,
  });

  const assembled = proposal ? assembleReadProposal(proposal, lines) : { questions: [], sections: [], keyLineNos: [], furnitureLineNos: [] };
  let questions = assembled.questions; let sections = assembled.sections;

  // Hard rule (#40 B3): the pipeline may NEVER ship 0 questions when ≥1 page read succeeded with questions.
  const succeededQuestionPages = readResult.pages.filter(p => p.status !== 'failed' && p.questions > 0);
  if (succeededQuestionPages.length > 0 && questions.length === 0) {
    throw new Error(`Invariant violation: ${succeededQuestionPages.length} page(s) read succeeded with questions, but assembled document has 0 questions.`);
  }

  // `assignImagesExact` bijection/I13 after assembly (#40 Part C): pairs images to questions on succeeded pages
  // while keeping images on failed pages unplaced so they flow through Check → Repair → Cloud → Attention.
  try {
    const initialAssigned = await assignImagesExact({ questions, images: updatedImages, sourceLines: lines, failedPages: readResult.failedPages });
    questions = initialAssigned.questions; updatedImages = initialAssigned.images;
  } catch { /* unowned image becomes image-unplaced defect */ }

  // Dedicated metadata path: two tiny reads, then one-image vision tie-break.
  const printedTotalLine = proposal?.meta.total?.evidenceLine;
  const firstPageInput = imageAsMetaInput(await topThirdPage(extracted.pageImages?.[0]));
  const callMeta = metaProvider ? async (req: any) => { const r = await LLMAdapter.execute({ role: 'meta', system: req.system, text: req.text, images: req.images, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: metaProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined;
  const callVisionMeta = visionProvider ? async (req: any) => { const r = await LLMAdapter.execute({ role: 'vision', system: req.system, text: req.text, images: req.images, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: visionProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined;
  const metaCache = { fileHash, stage: 'meta-read' as any, provider: metaProvider?.id || 'none', model: metaProvider?.model || 'none', options: { linesHash, totalLine: printedTotalLine || null, version: 'meta-read-v1' } };
  const cachedMeta = !forceStage('read') ? await getCachedStageResult<any>(metaCache) : undefined;
  const metaRead: MetaReadResult = cachedMeta?.meta
    ? { ...cachedMeta, calls: 0, usage: { inputTokens: 0, outputTokens: 0 } } as MetaReadResult
    : await runMetaRead({ lines, printedTotalLine, caller: callMeta, visionCaller: callVisionMeta, firstPageTopThird: firstPageInput, onJournal: e => journal(e.label, e.rawText, e.requestText) });
  if (!cachedMeta?.meta) await cacheWrite(metaCache, metaRead);
  budget.calls += metaRead.calls;
  if (metaRead.calls) record(usageRecord('meta', metaProvider, metaRead.usage, `Metadata (${metaRead.calls} call${metaRead.calls === 1 ? '' : 's'})`));
  else if (cachedMeta?.meta) record(usageRecord('meta', metaProvider, metaRead.usage, 'Metadata (Cache Hit)', true));
  const totalPoints = metaRead.meta.total?.value;

  // 3 — CHECK: closed arithmetic list only.
  stage({ id: 'check', name: 'Check', status: 'running', message: 'Checking identity, counts, spans, marks, images, and metadata vocabulary…' });
  const ownMax = Math.max(0, ...questions.map(q => q.no)); const expectedNumbers = Array.from({ length: ownMax }, (_, i) => i + 1);
  const accountedLineNos = proposal ? [...proposal.labels.keys()].filter(n => !questions.some(q => q.spans.some((s: any) => Array.isArray(s) && n >= s[0] && n <= s[1]))) : [];
  let defects = computeDefects({ doc: { questions, sections, images: updatedImages, totalPoints }, lines, expectedNumbers, keyLineNos: assembled.keyLineNos, accountedLineNos });
  stage({ id: 'check', name: 'Check', status: defects.length || metaRead.defects.length ? 'completed-with-problems' : 'completed', message: `${defects.length} document defect(s) · ${metaRead.defects.length} metadata field(s) unresolved.` });

  // 4 — REPAIR: local at most twice; each survivor alone to canonical cloud role.
  stage({ id: 'repair', name: 'Repair', status: defects.length ? 'running' : 'skipped', message: defects.length ? `Repairing ${defects.length} checked defect(s)…` : 'No arithmetic defects.' });
  const repairCache = { fileHash, stage: 'defect-repair' as any, provider: repairProvider?.id || 'none', model: repairProvider?.model || 'none', options: { linesHash, failedPages: readResult.failedPages, proposal: proposal ? (await sha256(serializeReadProposal(proposal))).slice(0, 16) : 'invalid' } };
  const cachedRepair = !forceStage('repair') ? await getCachedStageResult<any>(repairCache) : undefined;
  const loop = await runRepairLoop({
    state: { questions, sections },
    lines,
    expectedNumbers,
    keyLineNos: assembled.keyLineNos,
    accountedLineNos,
    totalPoints,
    images: updatedImages,
    failedPages: readResult.failedPages,
    budget,
    cachedResult: cachedRepair?.serialized,
    onJournal: e => journal(e.label, e.rawText, e.requestText),
    caller: repairProvider ? async req => { const r = await LLMAdapter.execute({ role: 'repair', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: repairProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined,
    escalationCaller: cloudProvider ? async req => { const r = await LLMAdapter.execute({ role: 'cloud', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: cloudProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined,
  });
  questions = loop.state.questions; sections = loop.state.sections; defects = loop.remainingDefects;
  if (succeededQuestionPages.length > 0 && questions.length === 0) {
    throw new Error(`Invariant violation after repair: ${succeededQuestionPages.length} page(s) succeeded, but repaired document has 0 questions.`);
  }
  if (loop.status === 'completed') await cacheWrite(repairCache, { serialized: serializeRepairLoopResult(loop) });
  if (loop.usage.inputTokens || loop.usage.outputTokens) record(usageRecord('repair', repairProvider, loop.usage, 'Local defect repair'));
  if (loop.escalationUsage.inputTokens || loop.escalationUsage.outputTokens) record(usageRecord('cloud', cloudProvider, loop.escalationUsage, 'Cloud defect repair'));
  stage({
    id: 'repair',
    name: 'Repair',
    status: defects.length ? 'completed-with-problems' : loop.status === 'cached' ? 'cached' : 'completed',
    message: `${loop.opsAccepted} fix(es) accepted · ${loop.opsRejected} rejected · ${loop.opsDeduped} duplicate(s) skipped${loop.abandonedKinds.length ? ` · ${loop.abandonedKinds.length} kind(s) abandoned` : ''} · ${loop.escalations} cloud escalation(s) · ${defects.length} survivor(s) for the teacher.${loop.droppedReadFailedDefects ? ` ${loop.droppedReadFailedDefects} item(s) on unread pages wait for [Retry page].` : ''}`,
  });

  // #43 Part A — Compile: reconcile page proposals instead of wholesale rejection.
  // Salvages everything salvageable; remaining defects become a scoped work list for the teacher.
  stage({ id: 'compile', name: 'Compile', status: 'running', message: 'Reconciling page proposals and scoping remaining defects…' });
  const compiled = await compileDocument({
    questions, sections, lines,
    keyLineNos: assembled.keyLineNos,
    // The classifier's accounted lines (furniture + key + section labels) are not claims:
    // the compiler must treat them as accounted, exactly like computeDefects does.
    accountedLineNos,
    failedPages: readResult.failedPages,
    caller: compileCaller,
    cloudCaller: compileCloudCaller,
    onJournal: e => journal(e.label, e.rawText, e.requestText),
    // Compile re-asks sit outside the read allowance and the repair budget.
    budget: { calls: 0, units: 0, maxCalls: 100, maxUnits: 1000 },
  });
  questions = compiled.questions;
  sections = compiled.sections;
  const compileByKind: Record<string, number> = {};
  for (const rec of compiled.reconciliations) compileByKind[rec.kind] = (compileByKind[rec.kind] || 0) + 1;
  const compileRecord: CompileSpineRecord = {
    reconciliations: compiled.reconciliations.length,
    byKind: compileByKind,
    pages: [...compiled.pageStatus.entries()].map(([page, status]) => ({ page, status })),
    calls: compiled.calls,
    defectsRemaining: compiled.defects.length,
  };
  defects = [...defects, ...compiled.defects];
  if (compiled.calls) record(usageRecord('read', readProvider, compiled.usage, `Compile · scoped re-asks (${compiled.calls} call${compiled.calls === 1 ? '' : 's'})`));
  stage({ id: 'compile', name: 'Compile', status: compiled.defects.length ? 'completed-with-problems' : 'completed', message: `${compiled.reconciliations.length} reconciliation(s) · ${compiled.calls} scoped re-ask(s) · ${compiled.defects.length} defect(s) to the teacher.` });

  // #43 Part B — Decision Audit: probability votes on the settled document; routes nothing in shadow mode.
  // Never consumes the read allowance or the repair budget.
  stage({ id: 'audit', name: 'Decision Audit', status: 'running', message: 'Running the decision audit over the settled document…' });
  const auditResult = await runDecisionAudit({
    doc: { questions, sections, images: updatedImages, totalPoints, meta: metaRead?.meta as ExamDoc['meta'] | undefined },
    lines,
    settings,
    fileHash,
    caller: compileCaller,
    cloudCaller: compileCloudCaller,
    keyLineNos: assembled.keyLineNos,
    failedPages: readResult.failedPages,
    existingDefects: defects,
    onJournal: e => journal(e.label, e.rawText, e.requestText),
  });
  questions = auditResult.questions;
  sections = auditResult.sections;
  defects = [...defects, ...auditResult.defects];
  const auditSummary = auditResult.summary;
  const decideSelection = settings.roleMapping.decide;
  const decideProvider = decideSelection ? (settings.providers.find(p => p.id === decideSelection.providerId) || settings.providers[0]) : undefined;
  if (auditResult.calls || auditResult.usage.inputTokens) {
    record(usageRecord('decide', decideProvider, auditResult.usage, `Decision Audit (${auditResult.calls} vote${auditResult.calls === 1 ? '' : 's'})`));
  }
  stage({ id: 'audit', name: 'Decision Audit', status: auditSummary.mode === 'skipped' ? 'skipped' : (auditSummary.catches ? 'completed-with-problems' : 'completed'), message: `${auditSummary.decisions} decision vote(s) · ${auditSummary.catches} catch(es) · ${auditSummary.uncertain} uncertain · ${auditSummary.mode}${auditSummary.transportError ? ` · transport: ${auditSummary.transportError}` : ''}` });

  // Final image bijection/I13 pass after repair.
  try {
    const assigned = await assignImagesExact({ questions, images: updatedImages, sourceLines: lines, failedPages: readResult.failedPages });
    questions = assigned.questions; updatedImages = assigned.images;
  } catch { /* unowned image becomes attention */ }
  const detection = detectLanguageAndDirection(lines.slice(0, 60).map(l => l.text).join(' '));
  const flags: Flag[] = [...defectFlags(defects), ...metaRead.defects.map((d, i) => ({ id: `meta_missing_${i}`, code: 'META_MISSING', severity: 'warn' as const, message: d.complaint, rootCauseId: `meta_${d.field}` }))];
  if (!proposal) {
    flags.push({ id: 'global_read_failed', code: 'GLOBAL_READ_FAILED', severity: 'error', message: 'Global Read failed validation and no parser fallback was used. Set up the paper manually or retry with another read model.' });
  } else {
    for (const failedPage of readResult.failedPages) {
      flags.push({
        id: `page_read_failed_${failedPage}`,
        code: 'PAGE_READ_FAILED',
        severity: 'error',
        rootCauseId: `page_read_failed_${failedPage}`,
        message: pageReadFailedMessage(failedPage, readResult.pages.find(p => p.page === failedPage)?.reason),
      });
    }
  }
  const orphanLineNos = [...new Set(defects.filter(d => d.kind === 'unaccounted-lines').flatMap(d => d.lineIds))].sort((a, b) => a - b);

  // 5 — PRESENT. Raw internal flags are persisted for audit; UI surfaces must consume computeAttention only.
  stage({ id: 'present', name: 'Present', status: 'running', message: 'Preparing the checked document and teacher attention list…' });
  const examId = `exam_${fileHash.slice(0, 12)}`;
  const meta = { subject: metaRead.meta.subject?.value, grade: metaRead.meta.grade ? String(metaRead.meta.grade.value) : undefined, totalPoints, language: detection.language, direction: detection.direction } as ExamDoc['meta'];
  // Never build a confident title from half-read metadata.
  let displayName = meta.subject && meta.grade ? computeDisplayName(meta, file.name) : file.name.replace(/\.[^/.]+$/, '') || 'Exam'; let nameSource: 'ai' | 'manual' = 'ai';
  try { const old = await loadExamDoc(examId); if (old?.nameSource === 'manual' && old.displayName) { displayName = old.displayName; nameSource = 'manual'; } } catch { /* first parse */ }
  const classifyStatus = !proposal
    ? 'unavailable'
    : readResult.failedPages.length > 0
      ? 'partial'
      : readResult.status === 'cached'
        ? 'cached'
        : 'completed';
  let doc: ExamDoc = {
    id: examId,
    fileHash,
    createdAt: new Date().toISOString(),
    displayName,
    nameSource,
    meta,
    sections,
    questions,
    images: updatedImages,
    source: {
      lines: storedLines,
      pages: extracted.pages,
      ocrUsed,
      fileName: file.name,
      pageImages: extracted.pageImages,
      pageThumbKeys: extracted.pageThumbKeys || [],
      expectedQuestionNos: expectedNumbers,
      keyTerritoryLineNos: assembled.keyLineNos,
      orphanLineNos,
      ...(Object.keys(lineRepairs).length ? { lineRepairs } : {}),
      ...(textRepairStats ? { textRepairStats } : {}),
    },
    flags,
    usage: usageRecords,
    guidanceTokens: job?.playbook.tokens || 0,
    spine: {
      classify: {
        status: classifyStatus,
        provider: readProvider?.id,
        model: readProvider?.model,
        calls: readResult.calls,
        cloudCalls: readResult.cloudCalls,
        readAllowance: readResult.readAllowance,
        labelledLines: proposal?.labels.size,
        pages: readResult.pages,
        pageProposals: readResult.pageProposals,
        ...(!proposal || readResult.complaints.length ? { reason: readResult.complaints.join('; ') } : {}),
      },
      repairLoop: {
        status: loop.status,
        rounds: loop.rounds.length,
        calls: loop.calls,
        // #42: the summary reconciles — proposed = accepted + rejected + deduped.
        opsProposed: loop.opsProposed,
        opsAccepted: loop.opsAccepted,
        opsRejected: loop.opsRejected,
        opsDeduped: loop.opsDeduped,
        ...(loop.abandonedKinds.length ? { abandonedKinds: loop.abandonedKinds } : {}),
        ...(loop.droppedReadFailedDefects ? { droppedReadFailedDefects: loop.droppedReadFailedDefects } : {}),
        escalations: loop.escalations,
        defectsRemaining: defects.length + metaRead.defects.length,
        remainingKinds: [...new Set([...defects.map(d => d.kind), ...metaRead.defects.map(d => `meta-${d.field}`)])],
      },
      compile: compileRecord,
      audit: auditSummary,
      budget: { ...budget },
    },
  };
  doc = validateAndFixDuplicateImageIds(doc).doc;
  doc = enforceSingleImageOwnership(doc).doc;
  if (flags.some(flag => flag.severity === 'error')) doc = { ...doc, partial: true, flags: [...doc.flags, { id: 'partial_exam', code: 'PARTIAL_EXAM', severity: 'error', message: 'Some checked defects remain; the document is saved as partial.' }] };
  await saveExamDoc(doc); doc = await prepareReviewDocument(doc, getReviewImageBlob);
  stage({ id: 'present', name: 'Present', status: flags.length ? 'completed-with-problems' : 'completed', message: `${questions.length} questions · ${sections.length} sections · ${defects.length + metaRead.defects.length} teacher attention source(s).${!proposal ? ' Global Read fallback was not used.' : ''}` });

  if (job) try {
    const localFixed = loop.rounds.filter(round => !round.escalatedKinds.length).reduce((sum, round) => sum + round.accepted, 0);
    const cloudFixed = loop.rounds.filter(round => round.escalatedKinds.length).reduce((sum, round) => sum + round.accepted, 0);
    await endJob(job, { health: { expected: expectedNumbers.length, parsed: questions.length, missing: defects.filter(d => d.kind === 'missing-number').length, duplicates: defects.filter(d => d.kind === 'duplicate-number').length, coveragePercent: expectedNumbers.length ? questions.length / expectedNumbers.length * 100 : 0, state: flags.length ? 'partial' : 'complete', complete: flags.length === 0, pointsParsed: questions.reduce((s, q) => s + (q.points || 0), 0), pointsExpected: totalPoints, audit: { decisions: auditSummary.decisions, catches: auditSummary.catches, uncertain: auditSummary.uncertain } }, verifierDefects: defects.length, defectFixRates: { localFixed, cloudFixed, teacherLeft: defects.length + metaRead.defects.length }, audit: { decisions: auditSummary.decisions, catches: auditSummary.catches, uncertain: auditSummary.uncertain }, calls: usageRecords.filter(r => !r.isCachedHit).length, tokens: { input: usageRecords.reduce((s, r) => s + r.inputTokens, 0), output: usageRecords.reduce((s, r) => s + r.outputTokens, 0), cached: 0 }, costUsd: usageRecords.reduce((s, r) => s + (r.costUsd || 0), 0), isCacheHit: readResult.status === 'cached' && loop.status === 'cached', settings, baselineRevision: `${questions.length}:${sections.length}:${totalPoints ?? 'null'}`, sourceLines: lines.slice(0, 500).map(l => l.text) }); callbacks.onLiveText?.('present', 'Memory', 'info', guidanceSummary(job)); } catch { /* memory is report-only */ }
  return doc;
}

export { sliceSourceSpans, carveOptionsAcrossLines, carveGroupChildSpans } from './spans';
export { canonicalizeForms, computeShapeAudit, runFinalCanonicalization, FORM_EXECUTION_ORDER, FORM_RULE_ID } from './forms';
export { replayFieldExport } from './fieldReplay';
export { retryFailedPage } from './pageRetry';
