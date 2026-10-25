/**
 * #39 default pipeline: Extract → Global Read → Check → Repair → Present.
 * The model proposes document meaning. Code only slices source text and checks the closed arithmetic list.
 */
import type { AppSettings, ExamDoc, Flag, ImageAsset, LLMRequest, SourceLine, StageStatus, UsageRecord } from '../types';
import { computeDisplayName } from '../types';
import { extractDocument, type ExtractedDocument } from './extract';
import { runBatchedOcr } from './ocr';
import { applyTextRepairOverlay, runTextRepairStage, type TextRepairCache, type TextRepairCacheEntry } from './textRepair';
import { LLMAdapter } from '../providers/adapter';
import { sha256 } from '../utils/hash';
import { appendJournalCall } from './journal';
import { getCachedStageResult, setCachedStageResult } from './cache';
import { appendUsageRecord, getPipelineCache, loadExamDoc, loadPageThumbDataUrls, saveExamDoc, setPipelineCache } from '../store';
import { calculateActualCost } from '../utils/budget';
import { detectLanguageAndDirection } from '../utils/numbers';
import { assembleReadProposal, runGlobalReadStage, validateReadProposal, parseReadProposal, serializeReadProposal, type ReadBudget, type ReadProposal } from './globalRead';
import { imageAsMetaInput, runMetaRead, type MetaReadResult } from './metaRead';
import { computeDefects, type Defect } from './defects';
import { runRepairLoop, serializeRepairLoopResult } from './repairLoop';
import { autoDecorateRepeatedImages } from './quality';
import { labelImagesBatched } from './vision';
import { assignImagesExact, enforceSingleImageOwnership } from './imageOwnership';
import { validateAndFixDuplicateImageIds } from './assemble';
import { prepareReviewDocument } from './reviewIntegrity';
import { getReviewImageBlob } from '../store';
import { beginJob, endJob, guidanceSummary, type JobHandle } from './memory/harness';

export interface PipelineCallbacks {
  onStageUpdate: (stage: StageStatus) => void;
  onNodeUpdate?: (node: { id: string; label?: string; status: string; tokens?: number; error?: string }) => void;
  onUsageUpdate?: (record: UsageRecord) => void;
  onLiveText?: (stageId: string, label: string, channel: 'output' | 'reasoning' | 'info', fullText: string) => void;
}

const lineNo = (line: SourceLine) => Number(String(line.id).replace(/\D/g, ''));
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
    const map: Record<string, string> = { 'hollow-question': 'STEM_HOLLOW', 'options-missing': 'OPTIONS_MISSING', 'points-unresolved': 'POINTS_UNPRICED', 'points-sum': 'POINTS_MISMATCH', 'image-ownership': 'IMAGE_ORDER_SUSPECT' };
    return { id: `attention_survivor_${i + 1}`, severity: defect.kind === 'hollow-question' || defect.kind === 'options-missing' ? 'error' : 'warn', code: map[defect.kind] || 'PARSE_CHECK_SURVIVOR', message: defect.detail, ...(qid ? { questionId: qid } : {}), rootCauseId: defect.id };
  });
}

export async function runFullPipeline(file: File, settings: AppSettings, callbacks: PipelineCallbacks, options?: { forceRerun?: boolean; answerKeyFile?: File | null; preExtracted?: ExtractedDocument; fileHash?: string; forceStages?: import('../types').PipelineStageId[] }): Promise<ExamDoc> {
  const stage = callbacks.onStageUpdate; const usageRecords: UsageRecord[] = [];
  const record = (r: UsageRecord) => { usageRecords.push(r); appendUsageRecord(r); callbacks.onUsageUpdate?.(r); };
  const fileHash = options?.fileHash || await sha256(await file.arrayBuffer());
  const force = Boolean(options?.forceRerun) || !settings.thrift.cacheEnabled;
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
      const cachedOcr = !force ? await getCachedStageResult<any>(ocrCache) : undefined;
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
    const repaired = await runTextRepairStage({ lines, keyLines: new Set(), enabled: true, provider: readProvider?.id, model: readProvider?.model, force, cache: lineCache, caller: readProvider ? async req => {
      const r = await LLMAdapter.execute({ role: 'text-repair', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: readProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage };
    } : undefined });
    lineRepairs = repaired.lineRepairs; textRepairStats = repaired.stats; lines = applyTextRepairOverlay(lines, lineRepairs);
  }
  const linesHash = (await sha256(lines.map(l => `${l.id}|${l.page}|${l.y}|${l.text}`).join('\n'))).slice(0, 20);
  stage({ id: 'extract', name: 'Extract', status: 'completed', message: `${lines.length} addressed lines · ${extracted.images.length} images · ${extracted.pages} pages${ocrUsed ? ' · OCR used' : ''}.` });

  const readProviderRaw = providerFor(settings, 'read'); const readProvider = readProviderRaw ? forcedOff(readProviderRaw) : undefined;
  const cloudProvider = providerFor(settings, 'cloud'); const repairProvider = providerFor(settings, 'repair'); const metaProviderRaw = providerFor(settings, 'meta'); const metaProvider = metaProviderRaw ? forcedOff(metaProviderRaw) : undefined;
  const visionProvider = providerFor(settings, 'vision');
  const budget: ReadBudget = { calls: 0, units: 0, maxCalls: settings.agentLimits?.maxModelCalls || 30, maxUnits: settings.agentLimits?.maxToolExecutions || 200 };
  const journalKey = `wing:${fileHash}:${linesHash}`;
  const journal = async (label: string, rawText: string, requestText?: string) => { if (settings.thrift.cacheEnabled) await appendJournalCall(journalKey, { ts: new Date().toISOString(), label, rawText, requestText, complete: true }); };

  let job: JobHandle | undefined;
  try { job = await beginJob({ kind: 'pipeline', sourceLines: lines, images: extracted.images, pages: extracted.pages, languageHint: detectLanguageAndDirection(lines.slice(0, 50).map(l => l.text).join(' ')).language, modelId: readProvider?.model || '', models: Object.fromEntries(Object.entries(settings.roleMapping).map(([k, v]) => [k, v?.model || ''])), role: 'read' as any }); } catch { job = undefined; }

  // 2 — GLOBAL READ.
  stage({ id: 'read', name: 'Global Read', status: 'running', message: 'One model is reading the whole paper; reasoning is forced off…' });
  const readCache = { fileHash, stage: 'global-read' as any, provider: readProvider?.id || 'none', model: readProvider?.model || 'none', options: { linesHash, version: 'global-read-v1' } };
  const cachedRead = !force ? await getCachedStageResult<any>(readCache) : undefined;
  const readResult = await runGlobalReadStage({ lines, cached: cachedRead?.serialized, budget, guidance: job?.playbook.block, onJournal: e => journal(e.label, e.rawText, e.requestText), caller: readProvider ? async req => {
    const response = await LLMAdapter.execute({ role: 'read', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: readProvider }, { onDelta: (channel, full) => channel === 'output' && callbacks.onLiveText?.('read', req.label, channel, full) });
    return { rawText: response.rawText, json: response.json, usage: response.usage };
  } : undefined });
  let proposal: ReadProposal | undefined = readResult.proposal; let readEscalated = false;
  if (!proposal && cloudProvider && readResult.complaints.length) {
    // Validation failure is itself repaired; there is deliberately no deterministic parser resurrection.
    const evidenceNos = [...new Set(readResult.complaints.flatMap(c => [...c.matchAll(/\b(\d{1,5})\b/g)].map(m => Number(m[1]))))].slice(0, 30);
    const evidence = lines.filter(l => evidenceNos.includes(lineNo(l))).map(l => `[${l.id}] ${l.text}`).join('\n');
    const text = `ONE DEFECT ONLY\nCOMPLAINT:\n${readResult.complaints.join('\n')}\nEVIDENCE ONLY:\n${evidence || '(validator supplied no line ids)'}\nReturn a corrected complete Global Read JSON proposal; do not discuss.`;
    try {
      const r = await LLMAdapter.execute({ role: 'cloud', system: 'Repair this single invalid Global Read proposal from only the complaint and evidence. JSON only.', text, label: 'Cloud · Global Read defect', maxOutputTokens: 32000, providerConfig: cloudProvider });
      budget.calls++; readEscalated = true; await journal('Cloud · Global Read defect', r.rawText, text);
      const candidate = parseReadProposal(r.rawText, r.json); if (validateReadProposal(candidate, lines).ok) { proposal = candidate; await cacheWrite(readCache, { serialized: serializeReadProposal(candidate) }); }
      record(usageRecord('cloud', cloudProvider, r.usage, 'Cloud · Global Read defect'));
    } catch { /* teacher receives a visible failed-read item below */ }
  }
  if (proposal && readResult.status === 'completed' && readResult.serialized) await cacheWrite(readCache, { serialized: readResult.serialized });
  if (readResult.calls) record(usageRecord('read', readProvider, readResult.usage, `Global Read (${readResult.calls} call${readResult.calls === 1 ? '' : 's'})`));
  stage({ id: 'read', name: 'Global Read', status: proposal ? (readResult.status === 'cached' ? 'cached' : 'completed') : 'completed-with-problems', message: proposal ? `${proposal.questions.length} proposed questions · ${proposal.sections.length} proposed sections${readEscalated ? ' · recovered by cloud' : ''}.` : `Global Read failed validation; no code-first fallback was used. ${readResult.complaints.join('; ')}` });

  const assembled = proposal ? assembleReadProposal(proposal, lines) : { questions: [], sections: [], keyLineNos: [], furnitureLineNos: [] };
  let questions = assembled.questions; let sections = assembled.sections; let updatedImages: ImageAsset[] = autoDecorateRepeatedImages(extracted.images);
  // Bundled vision captions are retained, but captions never create question boundaries.
  if (updatedImages.some(i => i.label?.role !== 'decoration') && visionProvider) {
    const visionCache = { fileHash, stage: 'vision' as any, provider: visionProvider.id, model: visionProvider.model, options: { linesHash, images: updatedImages.map(i => i.sha) } };
    const cachedVision = !force ? await getCachedStageResult<any>(visionCache) : undefined;
    if (cachedVision?.updatedImages) { updatedImages = cachedVision.updatedImages; record(usageRecord('vision', visionProvider, {}, 'Global Read · image captions (Cache Hit)', true)); }
    else try { const vision = await labelImagesBatched({ images: updatedImages.filter(i => i.label?.role !== 'decoration'), sourceLines: lines, providerConfig: visionProvider, maxLongEdge: settings.thrift.imageMaxLongEdge, quality: settings.thrift.jpegQuality / 100, maxImagesPerVisionCall: settings.thrift.maxImagesPerVisionCall, maxOutputTokens: settings.budget.maxOutputTokens }); updatedImages = vision.updatedImages; await cacheWrite(visionCache, { updatedImages, usage: vision.usage }); record(usageRecord('vision', visionProvider, vision.usage, 'Global Read · bundled image captions')); } catch { /* check(d) will leave unowned images visible */ }
  }

  // Dedicated metadata path: two tiny reads, then one-image vision tie-break.
  const printedTotalLine = proposal?.meta.total?.evidenceLine;
  const firstPageInput = imageAsMetaInput(await topThirdPage(extracted.pageImages?.[0]));
  const callMeta = metaProvider ? async (req: any) => { const r = await LLMAdapter.execute({ role: 'meta', system: req.system, text: req.text, images: req.images, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: metaProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined;
  const callVisionMeta = visionProvider ? async (req: any) => { const r = await LLMAdapter.execute({ role: 'vision', system: req.system, text: req.text, images: req.images, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: visionProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined;
  const metaCache = { fileHash, stage: 'meta-read' as any, provider: metaProvider?.id || 'none', model: metaProvider?.model || 'none', options: { linesHash, totalLine: printedTotalLine || null, version: 'meta-read-v1' } };
  const cachedMeta = !force ? await getCachedStageResult<any>(metaCache) : undefined;
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
  let defects = computeDefects({ doc: { questions, sections, images: updatedImages, totalPoints }, lines, expectedNumbers, keyLineNos: assembled.keyLineNos, accountedLineNos: proposal ? [...proposal.labels.keys()].filter(n => !questions.some(q => q.spans.some((s: any) => Array.isArray(s) && n >= s[0] && n <= s[1]))) : [] });
  stage({ id: 'check', name: 'Check', status: defects.length || metaRead.defects.length ? 'completed-with-problems' : 'completed', message: `${defects.length} document defect(s) · ${metaRead.defects.length} metadata field(s) unresolved.` });

  // 4 — REPAIR: local at most twice; each survivor alone to canonical cloud role.
  stage({ id: 'repair', name: 'Repair', status: defects.length ? 'running' : 'skipped', message: defects.length ? `Repairing ${defects.length} checked defect(s)…` : 'No arithmetic defects.' });
  const repairCache = { fileHash, stage: 'defect-repair' as any, provider: repairProvider?.id || 'none', model: repairProvider?.model || 'none', options: { linesHash, proposal: proposal ? (await sha256(serializeReadProposal(proposal))).slice(0, 16) : 'invalid' } };
  const cachedRepair = !force ? await getCachedStageResult<any>(repairCache) : undefined;
  const loop = await runRepairLoop({ state: { questions, sections }, lines, expectedNumbers, keyLineNos: assembled.keyLineNos, accountedLineNos: proposal ? [...proposal.labels.keys()].filter(n => !questions.some(q => q.spans.some((s: any) => Array.isArray(s) && n >= s[0] && n <= s[1]))) : [], totalPoints, images: updatedImages, budget, cachedResult: cachedRepair?.serialized, onJournal: e => journal(e.label, e.rawText, e.requestText), caller: repairProvider ? async req => { const r = await LLMAdapter.execute({ role: 'repair', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: repairProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined, escalationCaller: cloudProvider ? async req => { const r = await LLMAdapter.execute({ role: 'cloud', system: req.system, text: req.text, label: req.label, maxOutputTokens: req.maxOutputTokens, providerConfig: cloudProvider }); return { rawText: r.rawText, json: r.json, usage: r.usage }; } : undefined });
  questions = loop.state.questions; sections = loop.state.sections; defects = loop.remainingDefects;
  if (loop.status === 'completed') await cacheWrite(repairCache, { serialized: serializeRepairLoopResult(loop) });
  if (loop.usage.inputTokens || loop.usage.outputTokens) record(usageRecord('repair', repairProvider, loop.usage, 'Local defect repair'));
  if (loop.escalationUsage.inputTokens || loop.escalationUsage.outputTokens) record(usageRecord('cloud', cloudProvider, loop.escalationUsage, 'Cloud defect repair'));
  stage({ id: 'repair', name: 'Repair', status: defects.length ? 'completed-with-problems' : loop.status === 'cached' ? 'cached' : 'completed', message: `${loop.opsAccepted} fix(es) accepted · ${loop.escalations} cloud escalation(s) · ${defects.length} survivor(s) for the teacher.` });

  // Image bijection/I13 is arithmetic ownership and therefore remains in check/presentation.
  try { const assigned = await assignImagesExact({ questions, images: updatedImages, sourceLines: lines }); questions = assigned.questions; updatedImages = assigned.images; } catch { /* unowned image becomes attention */ }
  const detection = detectLanguageAndDirection(lines.slice(0, 60).map(l => l.text).join(' '));
  const flags: Flag[] = [...defectFlags(defects), ...metaRead.defects.map((d, i) => ({ id: `meta_missing_${i}`, code: 'META_MISSING', severity: 'warn' as const, message: d.complaint, rootCauseId: `meta_${d.field}` }))];
  if (!proposal) flags.push({ id: 'global_read_failed', code: 'GLOBAL_READ_FAILED', severity: 'error', message: 'Global Read failed validation and no parser fallback was used. Set up the paper manually or retry with another read model.' });

  // 5 — PRESENT. Raw internal flags are persisted for audit; UI surfaces must consume computeAttention only.
  stage({ id: 'present', name: 'Present', status: 'running', message: 'Preparing the checked document and teacher attention list…' });
  const examId = `exam_${fileHash.slice(0, 12)}`;
  const meta = { subject: metaRead.meta.subject?.value, grade: metaRead.meta.grade ? String(metaRead.meta.grade.value) : undefined, totalPoints, language: detection.language, direction: detection.direction } as ExamDoc['meta'];
  // Never build a confident title from half-read metadata.
  let displayName = meta.subject && meta.grade ? computeDisplayName(meta, file.name) : file.name.replace(/\.[^/.]+$/, '') || 'Exam'; let nameSource: 'ai' | 'manual' = 'ai';
  try { const old = await loadExamDoc(examId); if (old?.nameSource === 'manual' && old.displayName) { displayName = old.displayName; nameSource = 'manual'; } } catch { /* first parse */ }
  let doc: ExamDoc = { id: examId, fileHash, createdAt: new Date().toISOString(), displayName, nameSource, meta, sections, questions, images: updatedImages, source: { lines: storedLines, pages: extracted.pages, ocrUsed, fileName: file.name, pageImages: extracted.pageImages, pageThumbKeys: extracted.pageThumbKeys || [], expectedQuestionNos: expectedNumbers, keyTerritoryLineNos: assembled.keyLineNos, ...(Object.keys(lineRepairs).length ? { lineRepairs } : {}), ...(textRepairStats ? { textRepairStats } : {}) }, flags, usage: usageRecords, guidanceTokens: job?.playbook.tokens || 0, spine: { classify: { status: proposal ? (readResult.status === 'cached' ? 'cached' : 'completed') : 'unavailable', provider: readProvider?.id, model: readProvider?.model, calls: readResult.calls, labelledLines: proposal?.labels.size, ...(!proposal ? { reason: readResult.complaints.join('; ') } : {}) }, repairLoop: { status: loop.status, rounds: loop.rounds.length, calls: loop.calls, opsAccepted: loop.opsAccepted, opsRejected: loop.opsRejected, escalations: loop.escalations, defectsRemaining: defects.length + metaRead.defects.length, remainingKinds: [...new Set([...defects.map(d => d.kind), ...metaRead.defects.map(d => `meta-${d.field}`)])] }, budget: { ...budget } } };
  doc = validateAndFixDuplicateImageIds(doc).doc;
  doc = enforceSingleImageOwnership(doc).doc;
  if (flags.some(flag => flag.severity === 'error')) doc = { ...doc, partial: true, flags: [...doc.flags, { id: 'partial_exam', code: 'PARTIAL_EXAM', severity: 'error', message: 'Some checked defects remain; the document is saved as partial.' }] };
  await saveExamDoc(doc); doc = await prepareReviewDocument(doc, getReviewImageBlob);
  stage({ id: 'present', name: 'Present', status: flags.length ? 'completed-with-problems' : 'completed', message: `${questions.length} questions · ${sections.length} sections · ${defects.length + metaRead.defects.length} teacher attention source(s).${!proposal ? ' Global Read fallback was not used.' : ''}` });

  if (job) try {
    const localFixed = loop.rounds.filter(round => !round.escalatedKinds.length).reduce((sum, round) => sum + round.accepted, 0);
    const cloudFixed = loop.rounds.filter(round => round.escalatedKinds.length).reduce((sum, round) => sum + round.accepted, 0);
    await endJob(job, { health: { expected: expectedNumbers.length, parsed: questions.length, missing: defects.filter(d => d.kind === 'missing-number').length, duplicates: defects.filter(d => d.kind === 'duplicate-number').length, coveragePercent: expectedNumbers.length ? questions.length / expectedNumbers.length * 100 : 0, state: flags.length ? 'partial' : 'complete', complete: flags.length === 0, pointsParsed: questions.reduce((s, q) => s + (q.points || 0), 0), pointsExpected: totalPoints }, verifierDefects: defects.length, defectFixRates: { localFixed, cloudFixed, teacherLeft: defects.length + metaRead.defects.length }, calls: usageRecords.filter(r => !r.isCachedHit).length, tokens: { input: usageRecords.reduce((s, r) => s + r.inputTokens, 0), output: usageRecords.reduce((s, r) => s + r.outputTokens, 0), cached: 0 }, costUsd: usageRecords.reduce((s, r) => s + (r.costUsd || 0), 0), isCacheHit: readResult.status === 'cached' && loop.status === 'cached', settings, baselineRevision: `${questions.length}:${sections.length}:${totalPoints ?? 'null'}`, sourceLines: lines.slice(0, 500).map(l => l.text) }); callbacks.onLiveText?.('present', 'Memory', 'info', guidanceSummary(job)); } catch { /* memory is report-only */ }
  return doc;
}

export { sliceSourceSpans, carveOptionsAcrossLines, carveGroupChildSpans } from './spans';
export { canonicalizeForms, computeShapeAudit, runFinalCanonicalization, FORM_EXECUTION_ORDER, FORM_RULE_ID } from './forms';
export { replayFieldExport } from './fieldReplay';
