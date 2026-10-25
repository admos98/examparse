import { getReviewImageBlob } from '../store';
import { prepareReviewDocument, reconcileFinalFlags, repairImageReferences } from './reviewIntegrity';
/**
 * Main Pipeline Orchestrator (§6)
 * Coordinates Extract → OCR → Structure → Vision → Assemble & Validate → Escalation Repair
 * with content-hash caching, token thrift enforcement, and live stage status.
 */
import { AppSettings, ExamDoc, ImageAsset, LineTag, Question, SourceLine, StageStatus, UsageRecord, computeDisplayName } from '../types';
import { CLEANUP_VERSION, runCleanupStage, cleanupKeySignature } from './cleanup';
import { applyTextRepairOverlay, runTextRepairStage, TextRepairCache, TextRepairCacheEntry, TextRepairStats } from './textRepair';
import { computeOwnership, orphanFlag } from './ownership';
import { applyLocalGates } from './gates';
import { extractDocument, ExtractedDocument } from './extract';
import { tagFurniture, extractionDiagnostics } from './extractionQuality';
import { runBatchedOcr } from './ocr';
import { runStructurePass, rawCoverageQuestions } from './structure';
import { adjudicateImageAssignments, labelImagesBatched, fallbackImageKind } from './vision';
import { assembleAndValidateQuestions, sliceSourceSpans, validateAndFixDuplicateImageIds } from './assemble';
import { spanLineNumbers, spansContainLine } from './spans';
import { validateSemantic } from './semanticValidators';
import { buildCriticQueue, runCritic, recordVerdicts } from './critic';
import { consensusTriggerForSection, diffConsensus, resolveConsensusModel, CONSENSUS_CAPS } from './consensus';
import { tracesForDoc } from './provenance';
import { LLMAdapter } from '../providers/adapter';
import { autoDecorateRepeatedImages, computeImageQuestionHints, enumerateExpectedQuestionNos, evaluateCoverage, markPartialForInvariantViolations, parsePrintedNumberFromStem, validateExamInvariants } from './quality';
import { runEscalationRepair } from './repair';
import { canonicalizeForms, runFinalCanonicalization } from './forms';
import { assignImagesExact, enforceSingleImageOwnership } from './imageOwnership';
import { runAnswerCorrectness, type AnswerSpotCache, type SpotVerdict } from './answerCorrectness';
import { assembleFromLabels, lineNo as classifyLineNo, runClassifyStage, type ClassifyStageResult, type LabelAssembly, type SpineBudget } from './classify';
import { runRepairLoop, serializeRepairLoopResult, type RepairLoopResult } from './repairLoop';
import { appendJournalCall } from './journal';
import { extractDocumentTotals } from './quality';
import { sha256 } from '../utils/hash';
import { getCachedStageResult, setCachedStageResult } from './cache';
import { appendUsageRecord, getPipelineCache, loadExamDoc, loadPageThumbDataUrls, saveExamDoc, setPipelineCache } from '../store';
import { calculateActualCost, updateTokenCalibration } from '../utils/budget';
import { detectLanguageAndDirection } from '../utils/numbers';
import { PARSER_VERSION } from './prompts';
import { getExamHealth } from './quality';
import { beginJob, endJob, guidanceSummary, type JobHandle } from './memory/harness';

export interface PipelineCallbacks {
  onStageUpdate: (stage: StageStatus) => void;
  /** 2E: task-graph node events (section · status · tokens) for the Step 3 node list. */
  onNodeUpdate?: (node: { id: string; label?: string; status: string; tokens?: number; error?: string }) => void;
  onUsageUpdate?: (record: UsageRecord) => void;
  onLiveText?: (stageId: string, label: string, channel: 'output' | 'reasoning' | 'info', fullText: string) => void;
}

export async function runFullPipeline(
  file: File,
  settings: AppSettings,
  callbacks: PipelineCallbacks,
  options?: {
    forceRerun?: boolean;
    answerKeyFile?: File | null;
    preExtracted?: ExtractedDocument;
    fileHash?: string;
    forceStages?: import('../types').PipelineStageId[];
  }
): Promise<ExamDoc> {
  const { onStageUpdate, onUsageUpdate, onLiveText } = callbacks;
  const cacheEnabled = settings.thrift.cacheEnabled;
  const forceAll = options?.forceRerun || !cacheEnabled;
  const forcedStages = new Set(options?.forceStages || []);
  const stageForced = (id: string) => forceAll || forcedStages.has(id as any);
  const examIdForDedupe = (hash: string) => `exam_${hash.slice(0, 12)}`;
  // Respect the cache toggle on writes: nothing is written while it is off.
  const writeStageCache = async (params: Parameters<typeof setCachedStageResult>[0], data: any) => {
    if (cacheEnabled) await setCachedStageResult(params, data);
  };

  // Compute file SHA-256 for cache key
  const fileBuffer = await file.arrayBuffer();
  const fileHash = await sha256(fileBuffer);

  // 1. STAGE: EXTRACT (Local, 0 API calls) — skipped when a matching pre-extraction is supplied.
  let extracted: ExtractedDocument;
  const canUsePreExtracted =
    options?.preExtracted && options?.fileHash && options.fileHash === fileHash && !stageForced('extract');
  if (canUsePreExtracted) {
    extracted = options!.preExtracted!;
    onStageUpdate({
      id: 'extract',
      name: 'Local Extraction',
      status: 'cached',
      message: `Extraction (cached) — ${extracted.lines.length} lines, ${extracted.images.length} images from ${extracted.pages} page(s). (0 API calls)`,
    });
  } else {
    onStageUpdate({
      id: 'extract',
      name: 'Local Extraction',
      status: 'running',
      message: 'Extracting text coordinates, lines, and embedded images...',
    });
    const tExtractStart = Date.now();
    extracted = await extractDocument(file);
    const tExtractDuration = Date.now() - tExtractStart;
    onStageUpdate({
      id: 'extract',
      name: 'Local Extraction',
      status: 'completed',
      durationMs: tExtractDuration,
      message: `Extracted ${extracted.lines.length} lines, ${extracted.images.length} images from ${extracted.pages} page(s). (0 API calls)`,
    });
  }

  let workingLines = extracted.lines;
  let storedSourceLines: SourceLine[] = workingLines;
  let textRepairLineRepairs: Record<string, string> = {};
  let textRepairStats: TextRepairStats | undefined;
  const textRepairFlags: any[] = [];
  let ocrUsed = extracted.ocrUsed;
  const usageRecords: UsageRecord[] = [];

  // 2. STAGE: OCR FOR SCANNED PAGES (If detected)
  if (extracted.scannedPageIndices.length > 0 && (extracted.pageImages.length > 0 || (extracted.pageThumbKeys && extracted.pageThumbKeys.length > 0))) {
    onStageUpdate({
      id: 'ocr',
      name: 'Scanned Pages OCR',
      status: 'running',
      message: `Transcribing ${extracted.scannedPageIndices.length} scanned page(s) in batched calls...`,
    });

    const ocrRole = settings.roleMapping.vision;
    const ocrProvider = settings.providers.find(p => p.id === ocrRole.providerId) || settings.providers[0];
    const providerConfig = { ...ocrProvider, model: ocrRole.model };

    // Check cache
    const cachedOcr = !stageForced('ocr')
      ? await getCachedStageResult<{ lines?: any[]; mergedLines?: any[]; usage: any }>({
          fileHash,
          stage: 'ocr',
          provider: providerConfig.id,
          model: providerConfig.model,
          options: extracted.scannedPageIndices,
        })
      : null;

    if (cachedOcr) {
      workingLines = cachedOcr.mergedLines || cachedOcr.lines || workingLines;
      ocrUsed = true;
      const cachedUsageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'ocr',
        provider: providerConfig.name,
        model: providerConfig.model,
        inputTokens: cachedOcr.usage?.inputTokens || 0,
        outputTokens: cachedOcr.usage?.outputTokens || 0,
        costUsd: 0,
        label: `Scanned Pages OCR (Cache Hit, ${extracted.scannedPageIndices.length} pages)`,
        isCachedHit: true,
      };
      usageRecords.push(cachedUsageRec);
      appendUsageRecord(cachedUsageRec, `${examIdForDedupe(fileHash)}:ocr:${providerConfig.model}`);
      onUsageUpdate?.(cachedUsageRec);

      onStageUpdate({
        id: 'ocr',
        name: 'Scanned Pages OCR',
        status: 'cached',
        message: 'Loaded OCR lines from cache (0 calls, $0.00)',
      });
    } else {
      const t0 = Date.now();
      // OCR resolves page renders through thumb blobs (dataURLs only for scanned pages).
      let ocrPageImages = extracted.pageImages;
      const hasDataUrls = extracted.scannedPageIndices.some(
        pg => typeof extracted.pageImages[pg - 1] === 'string' && extracted.pageImages[pg - 1].startsWith('data:')
      );
      if (!hasDataUrls && extracted.pageThumbKeys && extracted.pageThumbKeys.length > 0) {
        const thumbMap = await loadPageThumbDataUrls(extracted.pageThumbKeys, extracted.scannedPageIndices);
        ocrPageImages = Array.from({ length: extracted.pages }, (_, i) => thumbMap.get(i + 1) || '');
      }
      const ocrRes = await runBatchedOcr({
        pageImages: ocrPageImages,
        scannedPageIndices: extracted.scannedPageIndices,
        startLineNum: 1,
        providerConfig,
        maxOutputTokens: settings.budget.maxOutputTokens,
        onLiveText: (label, channel, text) => onLiveText?.('ocr', label, channel, text),
      });

      // Merge per-page in page order with central renumbering (no append-at-end)
      // Build old→new line number map by page + per-page ordinal for anchorLine rewriting
      const merged: SourceLine[] = [];
      const oldToNewLineMap = new Map<number, number>();
      let globalNum = 1;
      for (let p = 1; p <= extracted.pages; p++) {
        const isScanned = extracted.scannedPageIndices.includes(p);
        const pLines = isScanned
          ? ocrRes.lines.filter(l => l.page === p)
          : extracted.lines.filter(l => l.page === p);
        for (const line of pLines) {
          const oldNum = parseInt(String(line.id).replace(/\D/g, ''), 10);
          const newNum = globalNum;
          if (!isNaN(oldNum)) {
            oldToNewLineMap.set(oldNum, newNum);
          }
          merged.push({
            ...line,
            id: `L${String(globalNum).padStart(4, '0')}`,
            page: p,
          });
          globalNum++;
        }
      }
      workingLines = merged;
      ocrUsed = true;

      // Rewrite image anchorLines through the old→new map
      const rewriteAnchor = (oldLine: number | undefined): number | undefined => {
        if (oldLine === undefined) return undefined;
        return oldToNewLineMap.get(oldLine) ?? oldLine;
      };
      for (const img of extracted.images) {
        img.anchorLine = rewriteAnchor(img.anchorLine);
      }

      const costUsd = calculateActualCost(
        ocrRes.usage.inputTokens,
        ocrRes.usage.outputTokens,
        providerConfig.model,
        settings.costTable
      );

      const usageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'ocr',
        provider: providerConfig.name,
        model: providerConfig.model,
        inputTokens: ocrRes.usage.inputTokens,
        outputTokens: ocrRes.usage.outputTokens,
        cachedTokens: ocrRes.usage.cachedTokens,
        costUsd,
        label: `OCR Pass (${extracted.scannedPageIndices.length} pages)`,
      };
      usageRecords.push(usageRec);
      appendUsageRecord(usageRec);
      onUsageUpdate?.(usageRec);

      await writeStageCache(
        {
          fileHash,
          stage: 'ocr',
          provider: providerConfig.id,
          model: providerConfig.model,
          options: extracted.scannedPageIndices,
        },
        { mergedLines: workingLines, lines: ocrRes.lines, usage: ocrRes.usage }
      );

      onStageUpdate({
        id: 'ocr',
        name: 'Scanned Pages OCR',
        status: 'completed',
        durationMs: Date.now() - t0,
        inputTokens: ocrRes.usage.inputTokens,
        outputTokens: ocrRes.usage.outputTokens,
        costUsd,
        message: `OCR generated ${ocrRes.lines.length} lines.`,
      });
    }
  }

  workingLines = tagFurniture(workingLines, extracted.pages);
  // Dependency-correct stage keys: hash of the (possibly OCR-merged) working lines.
  const linesHash = (await sha256(workingLines.map(l => l.id + ' ' + l.text).join('\n'))).slice(0, 16);
  const visionImgShas = [...new Set(extracted.images.map(img => img.sha).filter(Boolean))].sort();

  // Detect language & direction
  const fullSampleText = workingLines.slice(0, 40).map(l => l.text).join(' ');
  const detected = detectLanguageAndDirection(fullSampleText);
  const langDirection = settings.document.defaultLanguage === 'rtl' ? 'rtl' : settings.document.defaultLanguage === 'ltr' ? 'ltr' : detected.direction;
  const language = detected.language;
  const expectedEnumeration = enumerateExpectedQuestionNos(workingLines);
  const expectedQuestionNos = expectedEnumeration.numbers;
  // #38: pattern-derived key territory is the FALLBACK seed only. When the classify spine runs,
  // this is replaced below by the model's answer-key/marks labels (meaning is the model's job).
  let keyTerritoryLineNos = [...expectedEnumeration.keyTerritory.lineNos].sort((a, b) => a - b);

  // 2.5 STAGE: CLEANUP — AI judges lines, deterministic code tags them; nothing is deleted or edited.
  const cleanupEnabled = settings.cleanupEnabled !== false;
  let cleanupStats: NonNullable<ExamDoc['source']['cleanupStats']> | undefined;
  let cleanupOverrides: Record<string, LineTag> = {};
  const cleanupFlags: any[] = [];
  let cleanupSignature = 'off';
  {
    // The local pre-pass always runs (deterministic, 0 calls); the Settings toggle governs the AI judgment only.
    const cleanupStageName = 'Cleanup (Stage 2.5)';
    onStageUpdate({ id: 'cleanup', name: cleanupStageName, status: 'running', message: cleanupEnabled ? 'Local pre-pass: furniture, page numbers, key territory, headers…' : 'AI cleanup disabled in Settings — local pre-pass only (0 calls)…' });
    const cleanupSel = settings.roleMapping.cleanup || settings.roleMapping.fast;
    const cleanupProvider = settings.providers.find(p => p.id === cleanupSel.providerId) || settings.providers[0];
    const cleanupProviderConfig = cleanupEnabled && cleanupProvider ? { ...cleanupProvider, model: cleanupSel.model } : undefined;
    try { cleanupOverrides = (await getPipelineCache<Record<string, LineTag>>(`cleanupOverrides:${fileHash}`)) || {}; } catch { cleanupOverrides = {}; }
    const cleanupCacheParams = { fileHash, stage: 'cleanup' as const, provider: cleanupProviderConfig?.id || 'none', model: cleanupProviderConfig?.model || 'none', options: { linesHash, version: CLEANUP_VERSION } };
    const cachedCleanup = !stageForced('cleanup') ? await getCachedStageResult<{ aiVerdicts: any[]; usage: any }>(cleanupCacheParams) : null;
    const t0 = Date.now();
    const cleanupResult = await runCleanupStage({
      lines: workingLines, keyLines: new Set(keyTerritoryLineNos), pages: extracted.pages, expectedNumbers: expectedQuestionNos, overrides: cleanupOverrides,
      enabled: cleanupEnabled,
      cachedVerdicts: cleanupEnabled ? cachedCleanup?.aiVerdicts : undefined,
      caller: cleanupProviderConfig ? async req => {
        const response = await LLMAdapter.execute(
          { role: 'cleanup', system: req.system, text: req.text, maxOutputTokens: req.maxOutputTokens, label: req.label, providerConfig: cleanupProviderConfig },
          { onDelta: (channel, full) => onLiveText?.('cleanup', req.label, channel, full), onInfo: note => onLiveText?.('cleanup', req.label, 'info', note) },
        );
        return { rawText: response.rawText, json: response.json, usage: response.usage };
      } : undefined,
      onProgress: message => onStageUpdate({ id: 'cleanup', name: cleanupStageName, status: 'running', message }),
    });
    workingLines = cleanupResult.lines;
    cleanupStats = cleanupResult.stats;
    cleanupFlags.push(...cleanupResult.flags.map((f, i) => ({ id: `flag_${f.code}_${i + 1}`, code: f.code, severity: f.severity, message: f.message })));
    cleanupSignature = cleanupKeySignature({ enabled: cleanupEnabled, model: cleanupProviderConfig?.model, overrides: cleanupOverrides });
    let cleanupCost = 0;
    if (cleanupResult.calls && cleanupProviderConfig) {
      cleanupCost = calculateActualCost(cleanupResult.usage.inputTokens, cleanupResult.usage.outputTokens, cleanupProviderConfig.model, settings.costTable);
      const rec: UsageRecord = { ts: new Date().toISOString(), role: 'cleanup', provider: cleanupProviderConfig.name, model: cleanupProviderConfig.model, inputTokens: cleanupResult.usage.inputTokens, outputTokens: cleanupResult.usage.outputTokens, costUsd: cleanupCost, label: `Cleanup (${cleanupResult.calls} call${cleanupResult.calls > 1 ? 's' : ''})` };
      usageRecords.push(rec); appendUsageRecord(rec); onUsageUpdate?.(rec);
      if (!cleanupResult.stats.aiSkipped) await writeStageCache(cleanupCacheParams, { aiVerdicts: cleanupResult.aiVerdicts, usage: cleanupResult.usage });
    }
    const st = cleanupResult.stats;
    onStageUpdate({
      id: 'cleanup', name: cleanupStageName,
      status: cleanupResult.cached ? 'cached' : st.aiSkipped ? 'completed-with-problems' : 'completed',
      durationMs: Date.now() - t0, inputTokens: cleanupResult.usage.inputTokens, outputTokens: cleanupResult.usage.outputTokens, costUsd: cleanupCost,
      message: `${st.source === 'off' ? 'AI cleanup disabled — local tags only (0 calls) · ' : st.source === 'cached' ? 'Verdicts from cache (0 calls) · ' : st.aiSkipped ? 'AI cleanup skipped after retry — local tags only · ' : cleanupResult.calls ? `${cleanupResult.calls} call(s) · ` : 'local tags only (no provider) · '}judged ${st.judged} · junk ${st.junk} · suspect ${st.suspect} · fence-saved ${st.fenceSaved} · prompt lines ${st.linesBefore}→${st.linesAfter} (≈${st.tokensBefore}→${st.tokensAfter} tok).`,
    });
  }

  // 2.75 STAGE: OPTIONAL BATCHED TEXT REPAIR — overlays only; stored extracted lines stay immutable.
  {
    storedSourceLines = workingLines;
    const enabled = settings.textRepairEnabled === true;
    const repairStageName = 'Text Repair Overlay (Stage 2.75)';
    onStageUpdate({ id: 'text-repair', name: repairStageName, status: enabled ? 'running' : 'skipped', message: enabled ? 'Checking suspicious non-key lines; at most one batched call…' : 'Disabled in Settings — parsing original source text (0 calls).' });
    const repairSel = settings.roleMapping.cleanup || settings.roleMapping.fast;
    const repairProvider = settings.providers.find(p => p.id === repairSel.providerId) || settings.providers[0];
    const repairProviderConfig = enabled && repairProvider ? { ...repairProvider, model: repairSel.model } : undefined;
    const lineCache: TextRepairCache = {
      get: async key => {
        try { return await getPipelineCache<TextRepairCacheEntry>(key); } catch { return undefined; }
      },
      set: async (key, value) => {
        if (cacheEnabled) await setPipelineCache<TextRepairCacheEntry>(key, value);
      },
    };
    const t0 = Date.now();
    const repairResult = await runTextRepairStage({
      lines: storedSourceLines,
      keyLines: new Set(keyTerritoryLineNos),
      enabled,
      provider: repairProviderConfig?.id,
      model: repairProviderConfig?.model,
      force: stageForced('text-repair'),
      cache: lineCache,
      caller: repairProviderConfig ? async req => {
        const response = await LLMAdapter.execute(
          { role: 'text-repair', system: req.system, text: req.text, maxOutputTokens: req.maxOutputTokens, label: req.label, providerConfig: repairProviderConfig },
          { onDelta: (channel, full) => onLiveText?.('text-repair', req.label, channel, full), onInfo: note => onLiveText?.('text-repair', req.label, 'info', note) },
        );
        return { rawText: response.rawText, json: response.json, usage: response.usage };
      } : undefined,
    });
    textRepairLineRepairs = repairResult.lineRepairs;
    textRepairStats = repairResult.stats;
    textRepairFlags.push(...repairResult.flags);
    workingLines = applyTextRepairOverlay(storedSourceLines, textRepairLineRepairs);
    if (repairResult.stats.calls && repairProviderConfig) {
      const repairCost = calculateActualCost(repairResult.stats.inputTokens, repairResult.stats.outputTokens, repairProviderConfig.model, settings.costTable);
      const rec: UsageRecord = {
        ts: new Date().toISOString(), role: 'text-repair', provider: repairProviderConfig.name, model: repairProviderConfig.model,
        inputTokens: repairResult.stats.inputTokens, outputTokens: repairResult.stats.outputTokens, costUsd: repairCost,
        label: `Text repair (${repairResult.stats.candidates} candidates; one batch)`,
      };
      usageRecords.push(rec); appendUsageRecord(rec); onUsageUpdate?.(rec);
    }
    const stageStatus = repairResult.stats.status === 'disabled' || repairResult.stats.status === 'no-candidates' || repairResult.stats.status === 'unavailable'
      ? 'skipped'
      : repairResult.stats.status === 'cached' ? 'cached'
        : repairResult.stats.status === 'completed-with-problems' ? 'completed-with-problems' : 'completed';
    const repairCost = repairResult.stats.calls && repairProviderConfig
      ? calculateActualCost(repairResult.stats.inputTokens, repairResult.stats.outputTokens, repairProviderConfig.model, settings.costTable) : 0;
    onStageUpdate({
      id: 'text-repair', name: repairStageName, status: stageStatus,
      durationMs: Date.now() - t0, inputTokens: repairResult.stats.inputTokens, outputTokens: repairResult.stats.outputTokens, costUsd: repairCost,
      message: `${repairResult.stats.calls ? '1 batched call' : repairResult.stats.cachedLines ? 'per-line cache hit (0 calls)' : '0 calls'} · ${repairResult.stats.candidates} candidates · ${repairResult.stats.repaired} overlay(s) · ${repairResult.stats.rejected} rejected · ${repairResult.stats.unchanged} unchanged · ${repairResult.stats.cachedLines} cached line(s) · original source preserved${repairResult.stats.skippedReason ? ` · ${repairResult.stats.skippedReason}` : ''}.`,
    });
  }

  // 2.8 STAGE (#38 AI-first spine — Part A: global line classification; Part B: label assembly).
  // The model decides what each line IS (furniture / section header / question start / key…);
  // code then assembles mechanically. Pattern-based furniture/section/key deciders survive only
  // as prompt context here and inside the legacy fallback path (old segmenter, below). On any
  // classify failure the legacy path runs unchanged and CLASSIFY_FALLBACK is recorded — never silent.
  const spineBudget: SpineBudget = {
    calls: 0, units: 0,
    maxCalls: settings.agentLimits?.maxModelCalls ?? 30,
    maxUnits: settings.agentLimits?.maxToolExecutions ?? 200,
  };
  const spineJournalKey = `spine:${fileHash}:${linesHash}`;
  const spineFlags: any[] = [];
  const spineInfo: { classify: any; repairLoop: any } = {
    classify: { status: 'skipped', calls: 0 },
    repairLoop: { status: 'skipped', rounds: 0, calls: 0, opsAccepted: 0, opsRejected: 0, escalations: 0, defectsRemaining: 0, remainingKinds: [] },
  };
  const journalSpine = async (label: string, rawText: string) => {
    if (!cacheEnabled) return;
    try { await appendJournalCall(spineJournalKey, { ts: new Date().toISOString(), label, rawText, complete: true }); } catch { /* journal is best-effort */ }
  };
  let classifyOk = false;
  let labelAssembly: LabelAssembly | undefined;
  let classifyStageResult: ClassifyStageResult | undefined;
  {
    const classifyStageName = 'Line Sorting (Classify)';
    // Default mapping: same provider/model as cleanup's effective mapping (classify → cleanup → fast).
    const classifySel = settings.roleMapping.classify || settings.roleMapping.cleanup || settings.roleMapping.fast;
    const classifyProvider = settings.providers.find(p => p.id === classifySel.providerId) || settings.providers[0];
    const classifyEnabledSetting = settings.classifyEnabled !== false;
    const classifyProviderConfig = classifyEnabledSetting && classifyProvider ? { ...classifyProvider, model: classifySel.model } : undefined;
    const recordFallback = (status: string, reason: string, stageStatus: 'skipped' | 'completed-with-problems') => {
      spineInfo.classify = { status: 'fallback', calls: classifyStageResult?.calls || 0, reason, ...(classifyProviderConfig ? { provider: classifyProviderConfig.id, model: classifyProviderConfig.model } : {}) };
      spineFlags.push({
        id: 'flag_CLASSIFY_FALLBACK', code: 'CLASSIFY_FALLBACK', severity: 'info',
        message: `Automatic line sorting was not used (${reason}); the standard structuring method sorted this paper instead.`,
      });
      onStageUpdate({ id: 'classify', name: classifyStageName, status: stageStatus, message: `Line sorting not used — ${reason}. Continuing with the standard method.` });
      void status;
    };
    if (!classifyEnabledSetting) {
      recordFallback('skipped', 'turned off in Settings', 'skipped');
    } else if (!classifyProviderConfig) {
      recordFallback('unavailable', 'no AI provider is configured', 'skipped');
    } else {
      onStageUpdate({ id: 'classify', name: classifyStageName, status: 'running', message: `Asking ${classifyProviderConfig.model} what each of the ${workingLines.length} lines is…` });
      const classifyCacheParams = { fileHash, stage: 'classify' as const, provider: classifyProviderConfig.id, model: classifyProviderConfig.model, options: { linesHash, cleanup: cleanupSignature } };
      const cachedClassify = !stageForced('classify') ? await getCachedStageResult<any>(classifyCacheParams) : undefined;
      const localTags = new Map<number, string>();
      for (const line of workingLines) if (line.tag) localTags.set(classifyLineNo(line), line.tag);
      const t0 = Date.now();
      classifyStageResult = await runClassifyStage({
        lines: workingLines,
        cached: cachedClassify ? (cachedClassify.invalid ? { invalid: true, problems: cachedClassify.problems } : cachedClassify.serialized) : undefined,
        localTags,
        budget: spineBudget,
        onJournal: entry => journalSpine(entry.label, entry.rawText),
        onProgress: message => onStageUpdate({ id: 'classify', name: classifyStageName, status: 'running', message }),
        caller: async req => {
          const response = await LLMAdapter.execute(
            { role: 'classify', system: req.system, text: req.text, maxOutputTokens: req.maxOutputTokens, label: req.label, providerConfig: classifyProviderConfig },
            { onDelta: (channel, full) => onLiveText?.('classify', req.label, channel, full), onInfo: note => onLiveText?.('classify', req.label, 'info', note) },
          );
          return { rawText: response.rawText, json: response.json, usage: response.usage };
        },
      });
      const result = classifyStageResult;
      if (result.calls > 0) {
        const cost = calculateActualCost(result.usage.inputTokens, result.usage.outputTokens, classifyProviderConfig.model, settings.costTable);
        const rec: UsageRecord = { ts: new Date().toISOString(), role: 'classify', provider: classifyProviderConfig.name, model: classifyProviderConfig.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: cost, label: `Classify (${result.calls} call${result.calls > 1 ? 's' : ''})` };
        usageRecords.push(rec); appendUsageRecord(rec); onUsageUpdate?.(rec);
      } else if (result.status === 'cached') {
        const rec: UsageRecord = { ts: new Date().toISOString(), role: 'classify', provider: classifyProviderConfig.name, model: classifyProviderConfig.model, inputTokens: 0, outputTokens: 0, costUsd: 0, label: 'Classify (Cache Hit)', isCachedHit: true };
        usageRecords.push(rec); appendUsageRecord(rec, `${examIdForDedupe(fileHash)}:classify:${classifyProviderConfig.model}`); onUsageUpdate?.(rec);
      }
      if ((result.status === 'completed' || result.status === 'cached') && result.classification) {
        labelAssembly = assembleFromLabels({ lines: workingLines, classification: result.classification });
        if (labelAssembly.rawQuestions.length > 0) {
          classifyOk = true;
          // Labels decide key/marks territory from here on (Part B4) — not the pattern detector.
          keyTerritoryLineNos = labelAssembly.keyLineNos;
          spineInfo.classify = { status: result.status, provider: classifyProviderConfig.id, model: classifyProviderConfig.model, calls: result.calls, labelledLines: result.classification.labels.size };
          if (result.status === 'completed' && result.serialized) await writeStageCache(classifyCacheParams, { serialized: result.serialized });
          onStageUpdate({
            id: 'classify', name: classifyStageName,
            status: result.status === 'cached' ? 'cached' : 'completed',
            durationMs: Date.now() - t0, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
            attempts: result.attempts,
            message: `${result.status === 'cached' ? 'Line sorting from cache (0 calls)' : `Sorted every line in ${result.calls} call(s)`} · ${labelAssembly.sections.length} section(s) · ${labelAssembly.rawQuestions.length} question record(s) · ${labelAssembly.furnitureLineNos.length} furniture line(s) set aside · ${labelAssembly.keyLineNos.length} answer-key/marks line(s).`,
          });
        }
      }
      if (!classifyOk) {
        // Cache invalid output (not provider failures) so an identical re-run costs 0 classify calls.
        if (result.status === 'invalid') await writeStageCache(classifyCacheParams, { invalid: true, problems: result.problems });
        labelAssembly = undefined;
        recordFallback(result.status, result.reason || result.problems?.[0] || 'line sorting failed', result.status === 'unavailable' ? 'skipped' : 'completed-with-problems');
      }
    }
  }

  // F2/B: SEGMENTATION SUMMARY BEFORE STRUCTURE (shown before any structure token spent)
  // B1 deterministic 100% coverage + B4 fallback (>20% mismatch → legacy) + lens preview
  let segmentation: any = null;
  let segmentWireForStructure: any = null;
  let segmentFallback = false;
  if (classifyOk && labelAssembly) {
    // #38 Part B: label-derived segments replace the deterministic segmenter (kept as fallback only).
    segmentation = {
      segments: labelAssembly.segments,
      diagnostics: { coverage: 100, sectionsDetected: labelAssembly.sections.length, segmentsByKind: {}, perSection: [], fallbackSections: [] },
    };
    onStageUpdate({
      id: 'structure',
      name: 'Structure Pass',
      status: 'running',
      message: `Line labels give ${labelAssembly.segments.length} segments across ${labelAssembly.sections.length} section(s); the deterministic segmenter is not needed on this run.`,
    });
  }
  if (!classifyOk) try {
    const { segmentDocument } = await import('./segment');
    const segRes = segmentDocument({ lines: workingLines, keyLines: new Set(keyTerritoryLineNos), pages: extracted.pages });
    segmentation = segRes;
    // B4: confidence / mismatch fallback — if any section has >20% count mismatch or non-monotonic, use legacy free-span flow
    const hasFallback = segRes.diagnostics.fallbackSections.length > 0;
    const fallbackPct = segRes.diagnostics.perSection.filter((p: any) => p.fallback).length / Math.max(1, segRes.diagnostics.perSection.length);
    if (hasFallback && fallbackPct > 0) {
      // For now, only force fallback when number-less fixture (expected 0) or large mismatch; Iranian golden has 0 fallback so stays on segment path
      const forceLegacy = segRes.diagnostics.perSection.some((p: any) => p.fallback && p.expected === 0 && p.segmented === 0);
      if (forceLegacy) {
        segmentFallback = true;
        // Keep segmentation for telemetry/lens but mark fallback so structure uses legacy spans
        segRes.diagnostics.fallbackSections.push('SEGMENTER_FALLBACK');
      }
    }
    const fallbackMsg = segRes.diagnostics.fallbackSections.length ? ` Fallback: ${segRes.diagnostics.fallbackSections.join(', ')} (legacy)` : '';
    const segByKind = Object.entries(segRes.diagnostics.segmentsByKind).map(([k,v]: any)=> `${k}:${v}`).join(' ');
    onStageUpdate({
      id: 'structure',
      name: 'Structure Pass',
      status: 'running',
      message: `Segmentation: ${segRes.diagnostics.sectionsDetected} sections, ${segRes.segments.length} segments [${segByKind}] | per-section expected vs segmented ${segRes.diagnostics.perSection.map((p: any)=> `${p.title} ${p.expected}→${p.segmented}${p.fallback?'⚠':''}`).join(' | ')}${fallbackMsg} — deterministic 100% coverage: ${segRes.diagnostics.coverage.toFixed(1)}% (telemetry before model).`,
    });
    // Emit segment preview data via onLiveText for Step2 lens (colour by kind) - best-effort + flip overrides
    try { (callbacks as any).onSegmentUpdate?.(segRes); } catch {}
    // B2: build compact segment wire for structure (S1..Sn) — advisory, never executive
    if (!segmentFallback) {
      segmentWireForStructure = segRes.segments.map((s: any) => ({
        seg: s.id,
        kind: s.kind,
        range: [s.startLine, s.endLine],
        ...(s.printedNo !== undefined ? { n: s.printedNo } : {}),
        ...(s.childNos ? { childNos: s.childNos } : {}),
        ...(s.groupForm ? { groupForm: s.groupForm } : {}),
        ...(s.parentStemLines?.length ? { parentStemLines: s.parentStemLines } : {}),
        hint: s.sectionHint,
        // 120-char preview favors the governing instruction for an enumerative shared parent.
        preview: (workingLines.find((l: any) => Number(l.id.replace(/\D/g,''))===(s.parentStemLines?.[0] || s.startLine))?.text || '').slice(0,120),
      }));
    }
  } catch (e: any) {
    onStageUpdate({
      id: 'structure',
      name: 'Structure Pass',
      status: 'running',
      message: `Expected ${expectedQuestionNos.length} printed question(s); deterministic completeness gate enabled. (segmenter error: ${e?.message||e})`,
    });
  }
  if (!segmentation) onStageUpdate({
    id: 'structure',
    name: 'Structure Pass',
    status: 'running',
    message: `Expected ${expectedQuestionNos.length} printed question(s); deterministic completeness gate enabled.`,
  });
  // Expose segmentation wire for structure cache key (deterministic-before-LLM)
  const segmentSignature = segmentation && !segmentFallback ? `seg:${segmentation.segments.length}:${segmentation.diagnostics.coverage.toFixed(0)}` : 'seg:off';

  // 3.5 STAGE: VISION CALL (Part A — moved BEFORE structure labelling).
  // Vision reads the segmenter's candidate segments (pure geometry), returns {caption, kind, role}.
  // Roles are PROVISIONAL here: ownership is decided afterwards by printed geometry + counts (Part B).
  // Cached on image content + segment content, so an unchanged re-run still costs 0 calls.
  let updatedImages = autoDecorateRepeatedImages(extracted.images);
  const lineTextByNo = new Map(workingLines.map(line => [Number(String(line.id).replace(/\D/g, '')), line]));
  const segmentList: any[] = (!segmentFallback && segmentation?.segments) ? segmentation.segments : [];
  const segmentCandidates: Record<string, Array<{ ref: string; stem: string }>> = {};
  const segmentHints: Record<string, { questionRef: string; group: string; page: number }> = {};
  if (segmentList.length) {
    for (const img of updatedImages) {
      if (img.label?.role === 'decoration' || img.label?.kind === 'decoration') continue;
      const anchor = img.anchorLine;
      const samePage = (seg: any) => {
        const first = lineTextByNo.get(seg.parentStemLines?.[0] ?? seg.startLine) || lineTextByNo.get(seg.startLine);
        return first?.page === img.page;
      };
      let chosen: any[] = anchor === undefined
        ? []
        : segmentList.filter(seg => seg.startLine <= anchor && seg.endLine >= anchor && samePage(seg));
      if (!chosen.length) {
        const preceding = segmentList.filter(seg => samePage(seg) && seg.endLine < (anchor ?? 0)).sort((a, b) => b.endLine - a.endLine)[0];
        const following = segmentList.filter(seg => samePage(seg) && seg.startLine > (anchor ?? 0)).sort((a, b) => a.startLine - b.startLine)[0];
        chosen = [preceding, following].filter(Boolean);
      }
      if (!chosen.length) chosen = segmentList.filter(samePage).slice(0, 2);
      const candidates = chosen.slice(0, 4).map((seg: any) => {
        const first = lineTextByNo.get(seg.parentStemLines?.[0] ?? seg.startLine) || lineTextByNo.get(seg.startLine);
        return {
          ref: String(seg.id),
          stem: `segment ${seg.id} (${seg.kind}${seg.printedNo !== undefined ? `, n=${seg.printedNo}` : ''}) ${String(first?.text || '').slice(0, 120)}`,
        };
      });
      if (candidates.length) {
        segmentCandidates[img.id] = candidates;
        segmentHints[img.id] = { questionRef: String(chosen[0].id), group: String(chosen[0].id), page: img.page };
      }
    }
  }
  const visionRole = settings.roleMapping.vision;
  const visionProvider = settings.providers.find(p => p.id === visionRole.providerId) || settings.providers[0];
  const visionProviderConfig = { ...visionProvider, model: visionRole.model };
  let visionStageFlags: any[] = [];
  const visionCandidates = updatedImages.filter(img => img.label?.role !== 'decoration' && img.label?.kind !== 'decoration');
  // Segment refs are not question refs: park them on `segmentRef` and keep the verdict provisional.
  const markProvisional = (images: ImageAsset[]): ImageAsset[] => images.map(img => {
    if (!img.label) return img;
    const rawLabel = img.label as any;
    const segmentRef = rawLabel.segmentRef || (candidateSegmentRefs.has(String(rawLabel.questionRef)) ? String(rawLabel.questionRef) : undefined);
    const { questionRef: _segmentRefOnly, ...rest } = rawLabel;
    return { ...img, label: { ...rest, segmentRef, provisional: true, source: rawLabel.source || 'vision' } as any };
  });
  const candidateSegmentRefs = new Set(Object.values(segmentCandidates).flat().map(candidate => candidate.ref));
  if (updatedImages.length > 0 && visionCandidates.length > 0) {
    onStageUpdate({
      id: 'vision',
      name: 'Batched Vision Labeling',
      status: 'running',
      message: `Labeling ${visionCandidates.length} image(s) in ${Math.ceil(visionCandidates.length / Math.max(1, settings.thrift.maxImagesPerVisionCall))} bundled call(s) BEFORE structure, so captions inform section labelling; repeated logos were classified locally.`,
    });

    const cachedVision = !stageForced('vision')
      ? await getCachedStageResult<any>({
          fileHash,
          stage: 'vision',
          provider: visionProviderConfig.id,
          model: visionProviderConfig.model,
          options: { linesHash, imgShas: visionImgShas, segments: segmentSignature },
        })
      : null;

    if (cachedVision) {
      const cachedImages = autoDecorateRepeatedImages(cachedVision.updatedImages || []);
      const cachedById = new Map(cachedImages.map((img: any) => [img.id, img]));
      updatedImages = markProvisional(updatedImages.map(img => {
        const cached = cachedById.get(img.id);
        return cached ? { ...img, ...cached, label: cached.label || img.label } : img;
      }));
      visionStageFlags = cachedVision.flags || [];
      const cachedUsageRec: UsageRecord = {
        ts: new Date().toISOString(), role: 'vision', provider: visionProviderConfig.name, model: visionProviderConfig.model,
        inputTokens: cachedVision.usage?.inputTokens || 0, outputTokens: cachedVision.usage?.outputTokens || 0, costUsd: 0,
        label: 'Vision Labeling (Cache Hit)', isCachedHit: true,
      };
      usageRecords.push(cachedUsageRec);
      appendUsageRecord(cachedUsageRec, `${examIdForDedupe(fileHash)}:vision:${visionProviderConfig.model}`);
      onUsageUpdate?.(cachedUsageRec);
      onStageUpdate({ id: 'vision', name: 'Batched Vision Labeling', status: 'cached', message: 'Image captions/roles loaded from cache (0 calls); structure will see them.' });
    } else {
      const t0 = Date.now();
      const visionRes = await labelImagesBatched({
        images: visionCandidates,
        sourceLines: workingLines,
        providerConfig: visionProviderConfig,
        maxLongEdge: settings.thrift.imageMaxLongEdge,
        quality: settings.thrift.jpegQuality / 100,
        maxImagesPerVisionCall: settings.thrift.maxImagesPerVisionCall,
        maxOutputTokens: settings.budget.maxOutputTokens,
        questionHints: segmentHints,
        candidatesByImage: segmentCandidates,
        onLiveText: (label, channel, text) => onLiveText?.('vision', label, channel, text),
      });
      const visionById = new Map(visionRes.updatedImages.map(img => [img.id, img]));
      updatedImages = markProvisional(updatedImages.map(img => visionById.get(img.id) || img));
      visionStageFlags = visionRes.flags || [];
      const costUsd = calculateActualCost(visionRes.usage.inputTokens, visionRes.usage.outputTokens, visionProviderConfig.model, settings.costTable);
      const usageRec: UsageRecord = {
        ts: new Date().toISOString(), role: 'vision', provider: visionProviderConfig.name, model: visionProviderConfig.model,
        inputTokens: visionRes.usage.inputTokens, outputTokens: visionRes.usage.outputTokens, costUsd,
        label: `Vision Labeling (${visionCandidates.length} images)`,
      };
      usageRecords.push(usageRec); appendUsageRecord(usageRec); onUsageUpdate?.(usageRec);
      await writeStageCache({ fileHash, stage: 'vision', provider: visionProviderConfig.id, model: visionProviderConfig.model, options: { linesHash, imgShas: visionImgShas, segments: segmentSignature } }, visionRes);
      onStageUpdate({
        id: 'vision', name: 'Batched Vision Labeling', status: 'completed', durationMs: Date.now() - t0,
        inputTokens: visionRes.usage.inputTokens, outputTokens: visionRes.usage.outputTokens, costUsd,
        message: `Captioned ${visionCandidates.length} image(s) against the segmenter's candidates; roles stay provisional until Part B decides ownership.`,
      });
    }
  } else if (updatedImages.length > 0) {
    onStageUpdate({ id: 'vision', name: 'Batched Vision Labeling', status: 'skipped', message: 'All detected images were repeated page decorations; classified locally (0 calls).' });
  } else {
    onStageUpdate({ id: 'vision', name: 'Batched Vision Labeling', status: 'skipped', message: 'No images detected in document (0 calls).' });
  }
  // Structure sees the captions: a compact, deterministic signature keeps the structure cache honest.
  const visionLabelSignature = (await sha256(JSON.stringify(updatedImages.map(img => [img.id, img.page, img.label?.caption || '', img.label?.kind || '', img.label?.role || ''])))).slice(0, 16);

  const structRole = settings.roleMapping.fast;
  const structProvider = settings.providers.find(p => p.id === structRole.providerId) || settings.providers[0];
  const structProviderConfig = { ...structProvider, model: structRole.model };

  // D1/D3 — ONE memory job per pipeline parse. Advisory only (E1): deterministic gates
  // below are unchanged whether or not any lesson was injected.
  const jobStartedAt = Date.now();
  let job: JobHandle | undefined;
  try {
    job = await beginJob({
      kind: 'pipeline',
      sourceLines: workingLines,
      images: extracted.images,
      pages: extracted.pages,
      languageHint: language,
      modelId: structRole.model,
      models: Object.fromEntries(Object.entries(settings.roleMapping).map(([role, sel]) => [role, sel?.model || ''])),
      role: 'fast',
    });
  } catch { job = undefined; }
  const structureGuidance = job
    ? { block: job.playbook.block, tokens: job.playbook.tokens, digest: job.playbook.digest, entries: job.playbook.included.length, omitted: job.playbook.omittedCount }
    : undefined;
  const journalKey = await sha256(`${fileHash}:${await sha256(JSON.stringify(workingLines))}:${structProviderConfig.id}:${structProviderConfig.model}:${PARSER_VERSION}`);
  if (cacheEnabled) {
    try { await setPipelineCache(`journalkey:${fileHash}`, journalKey); } catch { /* attempt-history pointer is best-effort */ }
  }

  // Check cache for structure pass (segment signature is deterministic-before-LLM)
  const cachedStructure = !stageForced('structure')
    ? await getCachedStageResult<any>({
        fileHash,
        stage: 'structure',
        provider: structProviderConfig.id,
        model: structProviderConfig.model,
        options: { latex: settings.thrift.latexNormalization, linesHash, cleanup: cleanupSignature, segments: segmentSignature, images: visionLabelSignature },
      })
    : null;

  let structureData: any;
    // Never serve empty, json:null, or incomplete structure caches. Incomplete results must re-enter the journal-aware recovery path.
    const cachedCoverage = cachedStructure && Array.isArray((cachedStructure as any).rawQuestions)
      ? evaluateCoverage(expectedQuestionNos, rawCoverageQuestions((cachedStructure as any).rawQuestions, workingLines), (cachedStructure as any).meta?.totalPoints)
      : null;
    const cachedStructureUsable = Boolean(
      cachedStructure && Array.isArray((cachedStructure as any).rawQuestions) && (cachedStructure as any).rawQuestions.length > 0 &&
      !(cachedStructure as any).jsonNull && cachedCoverage?.complete
    );
    if (classifyOk && labelAssembly) {
      // #38 Part B: structure comes from the labels — printed total read from the paper itself;
      // no structure model call. Downstream (assemble/gates/forms/images/answers) is unchanged.
      const printedTotals = extractDocumentTotals(workingLines, keyTerritoryLineNos);
      structureData = {
        meta: { totalPoints: printedTotals.documentTotal, language },
        sections: labelAssembly.sections,
        rawQuestions: labelAssembly.rawQuestions,
        flags: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        callUsage: [],
        attempts: 0,
        label: 'Line-label assembly',
        wireFormat: 'labels',
        isCachedHit: classifyStageResult?.status === 'cached',
      };
      onStageUpdate({
        id: 'structure',
        name: 'Structure Pass',
        status: structureData.isCachedHit ? 'cached' : 'completed',
        message: `Assembled from line labels — ${labelAssembly.rawQuestions.length} preliminary question(s) across ${labelAssembly.sections.length} section(s)${printedTotals.documentTotal !== undefined ? `; printed total ${printedTotals.documentTotal}` : ''}. No structure model call was needed.`,
      });
    } else if (cachedStructureUsable) {
      structureData = { ...cachedStructure, isCachedHit: true };
      const cachedUsageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'fast',
        provider: structProviderConfig.name,
        model: structProviderConfig.model,
        inputTokens: cachedStructure.usage?.inputTokens || 0,
        outputTokens: cachedStructure.usage?.outputTokens || 0,
        costUsd: 0,
        label: 'Structure Pass (Cache Hit)',
        isCachedHit: true,
      };
      usageRecords.push(cachedUsageRec);
      appendUsageRecord(cachedUsageRec, `${examIdForDedupe(fileHash)}:structure:${structProviderConfig.model}`);
      onUsageUpdate?.(cachedUsageRec);

      onStageUpdate({
        id: 'structure',
        name: 'Structure Pass',
        status: 'cached',
        message: '0 calls · $0.00 · served from cache',
      });
    } else {
      const t0 = Date.now();
      let structRes: Awaited<ReturnType<typeof runStructurePass>>;
      try {
        structRes = await runStructurePass({
          sourceLines: workingLines,
          images: updatedImages,
          languageHint: language,
          latexEnabled: settings.thrift.latexNormalization,
          providerConfig: structProviderConfig,
          maxBudgetTokens: settings.budget.maxOutputTokens,
          journalEnabled: cacheEnabled && !stageForced('structure'),
          journalKey,
          forceSectionMode: structRole.model.toLowerCase().includes('free') || settings.budget.maxOutputTokens < 8192,
          onProgress: (message: string) => onStageUpdate({ id: 'structure', name: 'Structure Pass', status: 'running', message }),
          onLiveText: (label: string, channel: string, fullText: string) => onLiveText?.('structure', label, channel as any, fullText),
          guidance: structureGuidance,
          parallelSections: settings.parallelSections ?? 3,
          onNode: (node: any) => { onLiveText?.('structure', `node ${node.id}`, 'info', `${node.label || node.id}: ${node.status}${node.error ? ` — ${node.error}` : ''}`); (callbacks as any).onNodeUpdate?.(node); },
          // D — sections >40% [GARBLED?] go once to the escalation model (≤2 per pass).
          escalationProviderConfig: (() => { const sel = settings.roleMapping.escalation; const prov = sel && settings.providers.find(p => p.id === sel.providerId); return prov ? { ...prov, model: sel.model } : undefined; })(),
          garbledEscalationBudget: { count: 0, max: 2 },
          // B2: deterministic segments wire v2 (advisory-never-executive; legacy fallback when SEGMENTER_FALLBACK)
          segments: segmentWireForStructure || undefined,
          segmentFallback: segmentFallback,
        } as any);
      } catch (err: any) {
        onStageUpdate({
          id: 'structure',
          name: 'Structure Pass',
          status: 'failed',
          durationMs: Date.now() - t0,
          inputTokens: err?.usage?.inputTokens,
          outputTokens: err?.usage?.outputTokens,
          attempts: err?.attempts,
          message: err?.message || 'Structure Pass failed',
        });
        throw err;
      }

      structureData = structRes;

      // Update token calibration with full sent text length (system + user prompt), per provider
      const rawSourceChars = workingLines.reduce((acc, l) => acc + l.text.length, 0);
      const providerKey = `${structProviderConfig.kind}:${structProviderConfig.id}`;
      updateTokenCalibration(rawSourceChars, structRes.usage.inputTokens, providerKey);

      const callRecords: UsageRecord[] = (structRes.callUsage?.length ? structRes.callUsage : [{ label: structRes.label || 'Structure Pass', ...structRes.usage }]).map(call => ({
        ts: new Date().toISOString(), role: 'fast', provider: structProviderConfig.name, model: structProviderConfig.model,
        inputTokens: call.inputTokens || 0, outputTokens: call.outputTokens || 0, cachedTokens: call.cachedTokens || 0,
        costUsd: calculateActualCost(call.inputTokens || 0, call.outputTokens || 0, structProviderConfig.model, settings.costTable),
        label: call.label || 'Structure Pass',
      }));
      const costUsd = callRecords.reduce((sum, call) => sum + (call.costUsd || 0), 0);
      for (const usageRec of callRecords) {
        usageRecords.push(usageRec);
        appendUsageRecord(usageRec);
        onUsageUpdate?.(usageRec);
      }

    // Cache only complete coverage; partial structure is persisted via the journal and visible partial ExamDoc.
    // Coverage uses the same stem discipline as the structure pass itself: a group child shares its
    // parent's printed line, so slicing that line would score every sibling as the parent's number and
    // wrongly reject a complete parse from the cache.
    const structCoverage = evaluateCoverage(expectedQuestionNos, rawCoverageQuestions(structRes.rawQuestions, workingLines), structRes.meta?.totalPoints);
    if (structRes.rawQuestions.length > 0 && !structRes.jsonNull && structCoverage.complete) {
      await writeStageCache(
        {
          fileHash,
          stage: 'structure',
          provider: structProviderConfig.id,
          model: structProviderConfig.model,
          options: { latex: settings.thrift.latexNormalization, linesHash, cleanup: cleanupSignature, segments: segmentSignature, images: visionLabelSignature },
        },
        structRes
      );
    }

    onStageUpdate({
      id: 'structure',
      name: 'Structure Pass',
      status: 'completed',
      durationMs: Date.now() - t0,
      inputTokens: structRes.usage.inputTokens,
      outputTokens: structRes.usage.outputTokens,
      costUsd,
      attempts: structRes.attempts,
      message: `${structRes.flags?.some((f: any) => f.code === 'RESUMED_FROM_JOURNAL') ? `Resumed partial parse — ${structRes.rawQuestions.length} questions recovered, continuing at line ${structRes.resumeLine || 1}. ` : ''}Parsed ${structRes.rawQuestions.length} preliminary question(s) across ${structRes.sections.length} sections. Wire ${structRes.wireFormat || 'v2'}; estimated ${Math.round(structRes.outputTokensSavedPct || 0)}% fewer output tokens than v1.`,
    });
  }

  // 5. STAGE: ASSEMBLE & VALIDATE (Local)
  onStageUpdate({
    id: 'assemble',
    name: 'Assemble & Validate',
    status: 'running',
    message: 'Reconstructing stems from spans and validating integrity...',
  });

  const totalDeclaredPoints = structureData.meta?.totalPoints;
  const unresolvedImageIds = updatedImages.filter(img => !img.dataUrl).map(img => img.id);
  const assembled = assembleAndValidateQuestions(
    structureData.rawQuestions || [],
    workingLines,
    totalDeclaredPoints,
    { keyTerritoryLineNos, imageIds: updatedImages.map(img => img.id), unresolvedImageIds, segmentReceipts: segmentation?.segments || [], sections: structureData.sections || [] }
  );

  let finalQuestions = assembled.questions;
  let allFlags: any[] = [
    ...cleanupFlags,
    ...spineFlags,
    ...textRepairFlags,
    ...(structureData.flags || []),
    ...assembled.flags,
    ...(visionStageFlags || []),
  ].map((f: any, i: number) => ({ ...f, id: f.id || `flag_pipeline_${i + 1}` }));

  // Attach locally hinted / vision-confirmed assets. Geometry-only labels require strict same-page (±0) spans; cross-page requires vision.
  const workingLinePageByNo = new Map(workingLines.map(l => [Number(String(l.id).replace(/\D/g, '')), l.page]));
  for (const img of updatedImages) {
    if (img.label?.questionRef && img.label.role !== 'decoration' && img.label.kind !== 'decoration') {
      const matchQ = finalQuestions.find(q => q.id === img.label?.questionRef || q.label === img.label?.questionRef || String(q.no) === img.label?.questionRef);
      const isGeometryOnly = (img.label as any).source === 'geometry';
      const hasSamePageSpan = matchQ ? spanLineNumbers(matchQ.spans).some(ln => workingLinePageByNo.get(ln) === img.page) : false;
      if (matchQ && (!isGeometryOnly || hasSamePageSpan)) {
        if (!matchQ.images.some(ref => ref.imageId === img.id)) {
          matchQ.images.push({ imageId: img.id, role: img.label.role || 'stem', anchorLine: img.anchorLine });
        }
      } else if (isGeometryOnly && !hasSamePageSpan) {
        // Cross-page geometry fallback is disallowed — clear forced ref so asset stays in unplaced tray
        delete img.label;
      }
    }
    for (const imageFlag of img.imageFlags || []) {
      const message = imageFlag === 'IMAGE_UNANCHORED'
        ? `${img.id} on page ${img.page} could not be confidently anchored to a question; the asset is retained for review.`
        : `${img.id} on page ${img.page} has suspect strip geometry and was retained for review.`;
      allFlags.push({ id: `flag_${imageFlag}_${img.id}`, severity: 'warn', code: imageFlag, message });
    }
  }
  // 6. STAGE: ESCALATION REPAIR (≤ 1 call, escalation model)
  if (assembled.failingQuestions.length > 0) {
    onStageUpdate({
      id: 'repair',
      name: 'Escalation Repair',
      status: 'running',
      message: `Dispatching ${assembled.failingQuestions.length} failing item(s) to escalation model...`,
    });

    const repairRole = settings.roleMapping.escalation;
    const repairProvider = settings.providers.find(p => p.id === repairRole.providerId) || settings.providers[0];
    const repairProviderConfig = { ...repairProvider, model: repairRole.model };

    const repairOptions = {
      failing: assembled.failingQuestions.map(f => ({
        id: f.question.id,
        errors: [...f.errors].sort(),
      })),
    };

    const cachedRepair = !stageForced('repair')
      ? await getCachedStageResult<{ repairedQuestions: any[]; usage: any }>({
          fileHash,
          stage: 'repair',
          provider: repairProviderConfig.id,
          model: repairProviderConfig.model,
          options: repairOptions,
        })
      : null;

    if (cachedRepair) {
      // Fix 2 — a cache hit is still an ADOPTION: the stored replacement set enters the doc
      // through the same exported canonicalizer registry as the live path (zero extra calls).
      const cachedCanonical = canonicalizeForms({
        questions: cachedRepair.repairedQuestions,
        sourceLines: workingLines,
        sections: structureData.sections || [],
      });
      finalQuestions = cachedCanonical.questions;
      for (const formFlag of cachedCanonical.flags) {
        if (!allFlags.some(existing => existing.code === formFlag.code && existing.questionId === formFlag.questionId)) allFlags.push(formFlag);
      }
      const cachedUsageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'escalation',
        provider: repairProviderConfig.name,
        model: repairProviderConfig.model,
        inputTokens: cachedRepair.usage?.inputTokens || 0,
        outputTokens: cachedRepair.usage?.outputTokens || 0,
        costUsd: 0,
        label: `Escalation Repair (Cache Hit, ${assembled.failingQuestions.length} items)`,
        isCachedHit: true,
      };
      usageRecords.push(cachedUsageRec);
      appendUsageRecord(cachedUsageRec, `${examIdForDedupe(fileHash)}:repair:${repairProviderConfig.model}`);
      onUsageUpdate?.(cachedUsageRec);

      onStageUpdate({
        id: 'repair',
        name: 'Escalation Repair',
        status: 'cached',
        message: `Repaired ${assembled.failingQuestions.length} items from cache (0 calls, $0.00)`,
      });
    } else {
      const t0 = Date.now();
      const repairRes = await runEscalationRepair({
        failingItems: assembled.failingQuestions,
        allQuestions: finalQuestions,
        sourceLines: workingLines,
        keyTerritoryLineNos,
        providerConfig: repairProviderConfig,
        maxOutputTokens: settings.budget.maxOutputTokens,
        onLiveText: (label, channel, text) => onLiveText?.('repair', label, channel, text),
      });

      finalQuestions = repairRes.repairedQuestions;
      for (const formFlag of repairRes.formFlags || []) {
        if (!allFlags.some(existing => existing.code === formFlag.code && existing.questionId === formFlag.questionId)) allFlags.push(formFlag);
      }
      if (repairRes.rejectedCount) allFlags.push({ id: `flag_repair_rejected_${allFlags.length + 1}`, severity: 'error', code: 'REPAIR_SPAN_REJECTED', message: `${repairRes.rejectedCount} repaired question(s) were excluded because no safe question spans remained outside answer-key territory.` });
      if (repairRes.restrictedCount) allFlags.push({ id: `flag_repair_restricted_${allFlags.length + 1}`, severity: 'warn', code: 'REPAIR_SPAN_RESTRICTED', message: `${repairRes.restrictedCount} repaired item(s) had unsafe or answer-key spans clipped locally; review the remaining source anchors.` });
      // D — rewrite fence on the repair channel (same rules as the structure pass).
      if (repairRes.rewritesRejected) allFlags.push({ id: `flag_repair_rewrite_rejected_${allFlags.length + 1}`, severity: 'info', code: 'REWRITE_REJECTED', message: `${repairRes.rewritesRejected} repair rewrite(s) rejected by the fence (not locally garbled, carried digits/markers, outside spans, >140 chars or key territory); original text kept.` });
      if (repairRes.rewritesApplied) allFlags.push({ id: `flag_repair_rewrite_applied_${allFlags.length + 1}`, severity: 'info', code: 'REWRITE_APPLIED', message: `${repairRes.rewritesApplied} garbled line(s) rendered from repair rewrites; originals retained for one-click revert in Step 4.` });

      // Merge shapeMismatch flag from repair
      if (repairRes.shapeMismatch) {
        allFlags.push({
          id: `flag_${allFlags.length + 1}`,
          severity: 'warn',
          code: 'REPAIR_SHAPE_MISMATCH',
          message: 'Escalation repair response returned unexpected format; some items may not have been repaired.',
        });
      }

      const costUsd = calculateActualCost(
        repairRes.usage.inputTokens,
        repairRes.usage.outputTokens,
        repairProviderConfig.model,
        settings.costTable
      );

      const usageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'escalation',
        provider: repairProviderConfig.name,
        model: repairProviderConfig.model,
        inputTokens: repairRes.usage.inputTokens,
        outputTokens: repairRes.usage.outputTokens,
        costUsd,
        label: `Escalation Repair (${assembled.failingQuestions.length} items)`,
      };
      usageRecords.push(usageRec);
      appendUsageRecord(usageRec);
      onUsageUpdate?.(usageRec);

      await writeStageCache(
        {
          fileHash,
          stage: 'repair',
          provider: repairProviderConfig.id,
          model: repairProviderConfig.model,
          options: repairOptions,
        },
        { repairedQuestions: finalQuestions, usage: repairRes.usage }
      );

      onStageUpdate({
        id: 'repair',
        name: 'Escalation Repair',
        status: 'completed',
        durationMs: Date.now() - t0,
        inputTokens: repairRes.usage.inputTokens,
        outputTokens: repairRes.usage.outputTokens,
        costUsd,
        message: `Repaired ${repairRes.appliedCount ?? assembled.failingQuestions.length} items.`,
      });
    }
  } else {
    onStageUpdate({
      id: 'repair',
      name: 'Escalation Repair',
      status: 'skipped',
      message: 'All questions passed validation cleanly (0 calls)',
    });
  }

  // C2 — error validators are re-run after repair: fixed items lose their flag, survivors stay honest.
  {
    const errorCodes = new Set(['STEM_HOLLOW', 'OPTIONS_MISSING']);
    const still = new Map<string, string[]>();
    for (const issue of validateSemantic(finalQuestions, [], q => sliceSourceSpans(q.spans, workingLines))) {
      if (issue.severity === 'error' && issue.questionId) still.set(issue.questionId, [...(still.get(issue.questionId) || []), issue.code]);
    }
    for (const q of finalQuestions) {
      const keep = new Set(still.get(q.id) || []);
      const before = q.flags || [];
      q.flags = before.filter(code => !errorCodes.has(code) || keep.has(code));
      for (const code of keep) if (!q.flags.includes(code)) q.flags.push(code);
    }
    allFlags = allFlags.filter(f => !(errorCodes.has(f.code) && f.questionId && !still.get(f.questionId)?.includes(f.code)));
    const survivors = [...still.entries()];
    if (survivors.length && assembled.failingQuestions.length) {
      allFlags.push({ id: 'flag_repair_survivors', severity: 'error', code: 'REPAIR_SURVIVORS', message: `${survivors.length} question(s) still fail local validators after escalation repair: ${survivors.slice(0, 10).map(([id, codes]) => `${finalQuestions.find(q => q.id === id)?.label || id} (${codes.join('/')})`).join(', ')}${survivors.length > 10 ? ', …' : ''}. Shown as PARTIAL in Step 4.` });
    }
  }

  // 6.5 External Answer Key File Integration (If attached by user)
  if (options?.answerKeyFile) {
    try {
      const { mergeAnswerKeyFile } = await import('./keyfile');
      const keyResult = await mergeAnswerKeyFile(options.answerKeyFile, finalQuestions);
      finalQuestions = keyResult.updatedQuestions;
      if (keyResult.matchedCount > 0) {
        allFlags.push({
          id: `flag_${allFlags.length + 1}`,
          severity: 'info',
          code: 'KEYFILE_MERGED',
          message: `Matched ${keyResult.matchedCount} answers from attached key file.`,
        });
      }
    } catch (err: any) {
      console.warn('Failed to merge answer-key file; source contents and provider credentials were omitted.');
    }
  }

  // B/C — shared local gates: section split at inner headers, containment reassignment, META_TOTAL, ownership.
  const gates = applyLocalGates({ questions: finalQuestions, rawSections: structureData.sections || [], lines: workingLines, keyLines: keyTerritoryLineNos, metaTotalPoints: totalDeclaredPoints });
  finalQuestions = gates.questions;
  const reconciledTotalPoints = gates.totalPoints;
  allFlags.push(...gates.flags.filter(f => f.code !== 'ORPHAN_LINES'));
  if (reconciledTotalPoints !== totalDeclaredPoints) allFlags = allFlags.filter(f => f.code !== 'POINTS_MISMATCH');

  // Local completeness and section hygiene run after every structure outcome, including cache/resume/chunk/repair paths.
  const coverage = evaluateCoverage(expectedQuestionNos, finalQuestions, reconciledTotalPoints);
  if (coverage.missing.length && !allFlags.some(f => f.code === 'COVERAGE_MISSING')) allFlags.push({ id: 'flag_coverage_missing', severity: 'error', code: 'COVERAGE_MISSING', message: `Missing printed question numbers: ${coverage.missing.join(', ')}.` });
  if (coverage.duplicates.length && !allFlags.some(f => f.code === 'COVERAGE_DUPLICATE')) allFlags.push({ id: 'flag_coverage_duplicate', severity: 'warn', code: 'COVERAGE_DUPLICATE', message: `Duplicate printed question numbers: ${coverage.duplicates.join(', ')}.` });
  if (!coverage.pointsMatch && !allFlags.some(f => f.code === 'POINTS_MISMATCH')) allFlags.push({ id: 'flag_points_mismatch', severity: 'warn', code: 'POINTS_MISMATCH', message: `Points sum ${coverage.pointsParsed} does not match header ${reconciledTotalPoints}; deficit ${coverage.pointDeficit}.` });
  if (coverage.missing.length && !allFlags.some(f => f.code === 'PARTIAL_COVERAGE')) allFlags.push({ id: 'flag_partial_coverage', severity: 'error', code: 'PARTIAL_COVERAGE', message: `Recovery exhausted with ${coverage.missing.length} missing question(s): ${coverage.missing.join(', ')}.` });
  if (!finalQuestions.length && !allFlags.some(f => f.code === 'STRUCTURE_EMPTY')) allFlags.push({ id: 'flag_structure_empty', severity: 'error', code: 'STRUCTURE_EMPTY', message: 'No questions were reconstructed; the document remains incomplete.' });

  // #38 Part C + D — VERIFY, THEN BOUNDED AI REPAIR. Code computes the typed defect list from
  // the assembled document (existing invariants/coverage/ownership); the repair role may only
  // answer with operations from the closed vocabulary, which code validates and applies before
  // re-verifying (≤3 rounds, escalation once per surviving kind, executor budgets shared with
  // classify). Consensus/critic below consume this post-loop document. Survivors reach the
  // teacher through the single attention function — defect kinds never surface directly.
  let finalSections = gates.sections;
  {
    const repairSel = settings.roleMapping.repair || settings.roleMapping.cleanup || settings.roleMapping.fast;
    const repairProvider = settings.providers.find(p => p.id === repairSel.providerId) || settings.providers[0];
    const repairProviderConfig = repairProvider ? { ...repairProvider, model: repairSel.model } : undefined;
    const escSel = settings.roleMapping.escalation;
    const escProvider = settings.providers.find(p => p.id === escSel.providerId) || settings.providers[0];
    const escProviderConfig = escProvider ? { ...escProvider, model: escSel.model } : undefined;
    const questionsHash = (await sha256(JSON.stringify(finalQuestions.map(q => [q.id, q.no, q.spans, q.points, q.sectionId])))).slice(0, 16);
    const repairCacheParams = { fileHash, stage: 'defect-repair' as const, provider: repairProviderConfig?.id || 'none', model: repairProviderConfig?.model || 'none', options: { linesHash, questionsHash, path: classifyOk ? 'labels' : 'legacy' } };
    const cachedLoop = cacheEnabled && !stageForced('repair') ? await getCachedStageResult<any>(repairCacheParams) : undefined;
    const loopResult: RepairLoopResult = await runRepairLoop({
      state: { questions: finalQuestions, sections: finalSections },
      lines: workingLines,
      expectedNumbers: expectedQuestionNos,
      expectedStarts: [...expectedEnumeration.lineByNumber.entries()].map(([no, line]) => ({ no, line })),
      keyLineNos: keyTerritoryLineNos,
      accountedLineNos: [...(labelAssembly?.furnitureLineNos || []), ...(labelAssembly ? Object.values(labelAssembly.sectionPreludes).flat() : [])],
      totalPoints: reconciledTotalPoints,
      images: updatedImages,
      budget: spineBudget,
      cachedResult: cachedLoop?.serialized,
      onJournal: entry => journalSpine(entry.label, entry.rawText),
      onProgress: message => onStageUpdate({ id: 'assemble', name: 'Assemble & Validate', status: 'running', message }),
      caller: repairProviderConfig ? async req => {
        const response = await LLMAdapter.execute(
          { role: 'repair', system: req.system, text: req.text, maxOutputTokens: req.maxOutputTokens, label: req.label, providerConfig: repairProviderConfig },
          { onDelta: (channel, full) => onLiveText?.('repair', req.label, channel, full), onInfo: note => onLiveText?.('repair', req.label, 'info', note) },
        );
        return { rawText: response.rawText, json: response.json, usage: response.usage };
      } : undefined,
      escalationCaller: escProviderConfig ? async req => {
        const response = await LLMAdapter.execute(
          { role: 'escalation', system: req.system, text: req.text, maxOutputTokens: req.maxOutputTokens, label: req.label, providerConfig: escProviderConfig },
          { onDelta: (channel, full) => onLiveText?.('repair', req.label, channel, full), onInfo: note => onLiveText?.('repair', req.label, 'info', note) },
        );
        return { rawText: response.rawText, json: response.json, usage: response.usage };
      } : undefined,
    });
    finalQuestions = loopResult.state.questions;
    finalSections = loopResult.state.sections;
    spineInfo.repairLoop = {
      status: loopResult.status, rounds: loopResult.rounds.length, calls: loopResult.calls,
      opsAccepted: loopResult.opsAccepted, opsRejected: loopResult.opsRejected, escalations: loopResult.escalations,
      defectsRemaining: loopResult.remainingDefects.length,
      remainingKinds: [...new Set(loopResult.remainingDefects.map(d => d.kind))],
    };
    if (loopResult.status === 'completed' && loopResult.calls > 0) {
      if (repairProviderConfig && (loopResult.usage.inputTokens || loopResult.usage.outputTokens)) {
        const rec: UsageRecord = { ts: new Date().toISOString(), role: 'repair', provider: repairProviderConfig.name, model: repairProviderConfig.model, inputTokens: loopResult.usage.inputTokens, outputTokens: loopResult.usage.outputTokens, costUsd: calculateActualCost(loopResult.usage.inputTokens, loopResult.usage.outputTokens, repairProviderConfig.model, settings.costTable), label: `Defect repair (${loopResult.rounds.length} round(s))` };
        usageRecords.push(rec); appendUsageRecord(rec); onUsageUpdate?.(rec);
      }
      if (escProviderConfig && (loopResult.escalationUsage.inputTokens || loopResult.escalationUsage.outputTokens)) {
        const rec: UsageRecord = { ts: new Date().toISOString(), role: 'escalation', provider: escProviderConfig.name, model: escProviderConfig.model, inputTokens: loopResult.escalationUsage.inputTokens, outputTokens: loopResult.escalationUsage.outputTokens, costUsd: calculateActualCost(loopResult.escalationUsage.inputTokens, loopResult.escalationUsage.outputTokens, escProviderConfig.model, settings.costTable), label: 'Defect repair — second opinion' };
        usageRecords.push(rec); appendUsageRecord(rec); onUsageUpdate?.(rec);
      }
      if (cacheEnabled) await writeStageCache(repairCacheParams, { serialized: serializeRepairLoopResult(loopResult) });
    } else if (loopResult.status === 'cached' && repairProviderConfig) {
      const rec: UsageRecord = { ts: new Date().toISOString(), role: 'repair', provider: repairProviderConfig.name, model: repairProviderConfig.model, inputTokens: 0, outputTokens: 0, costUsd: 0, label: 'Defect repair (Cache Hit)', isCachedHit: true };
      usageRecords.push(rec); appendUsageRecord(rec, `${examIdForDedupe(fileHash)}:defect-repair:${repairProviderConfig.model}`); onUsageUpdate?.(rec);
    }
    if (loopResult.opsAccepted > 0) {
      allFlags.push({
        id: 'flag_DEFECT_REPAIR', code: 'DEFECT_REPAIR', severity: 'info',
        message: `Automatic checks fixed ${loopResult.opsAccepted} problem(s) in the paper's bookkeeping${loopResult.escalations ? ` (${loopResult.escalations} needed a second opinion from a stronger model)` : ''}${loopResult.remainingDefects.length ? `; ${loopResult.remainingDefects.length} thing(s) still need your eye` : ''}.`,
      });
    }
    onStageUpdate({
      id: 'assemble', name: 'Assemble & Validate', status: 'running',
      message: loopResult.status === 'no-defects'
        ? 'Arithmetic checks pass: every printed number and line is accounted for; no automatic fixes needed.'
        : loopResult.status === 'skipped'
          ? `Arithmetic checks found ${loopResult.remainingDefects.length} open item(s); no model was available for automatic fixes.`
          : `Automatic fix check: ${loopResult.rounds.length} round(s), ${loopResult.opsAccepted} fix(es) applied, ${loopResult.opsRejected} suggestion(s) rejected, ${loopResult.escalations} second opinion(s); ${loopResult.remainingDefects.length} item(s) still open.`,
    });
  }

  const sectionAssembly = { sections: finalSections };

  // Fix 2 (Marvel Batch 6) — ADOPTION-TIME CANONICALIZATION (defense in depth).
  // Every replacement question (consensus winner, critic reparse candidate, recovery insert)
  // passes the SAME exported registry — together with its group parent/siblings so
  // shared-line child stems can be carved — BEFORE it enters the final doc. Returns null when
  // the registry rejects the candidate (e.g. a phantom child numbered as its own parent).
  const adoptCanonicalized = (incoming: Question): Question | null => {
    const peers = finalQuestions.filter(peer => peer.id === incoming.parentId || (incoming.parentId !== undefined && peer.parentId === incoming.parentId));
    const canonical = canonicalizeForms({
      questions: [...peers, incoming],
      sourceLines: workingLines,
      sections: sectionAssembly.sections,
    });
    for (const formFlag of canonical.flags) {
      if (!allFlags.some(existing => existing.code === formFlag.code && existing.questionId === formFlag.questionId)) allFlags.push(formFlag);
    }
    return canonical.questions.find(question => question.id === incoming.id) || null;
  };

  // 2A (d)/(e): section-aware semantic validators, now that sections exist.
  for (const issue of validateSemantic(finalQuestions, sectionAssembly.sections)) {
    if (issue.code !== 'PASSAGE_DETACHED' && issue.code !== 'PASSAGE_CONTAINS_STEM' && issue.code !== 'SECTION_SPAN_OUTSIDE') continue;
    allFlags.push({ id: `flag_${issue.code}_${issue.questionId || 'doc'}`, severity: issue.severity, code: issue.code, message: issue.message, questionId: issue.questionId });
    const q = finalQuestions.find(item => item.id === issue.questionId);
    if (q && !q.flags?.includes(issue.code)) q.flags = [...(q.flags || []), issue.code];
  }

  const pointsSummary = `${coverage.pointsParsed}${totalDeclaredPoints !== undefined ? ` of ${totalDeclaredPoints}` : ''}`;
  const missingSummary = coverage.missing.length ? `missing ${coverage.missing.join(', ')}` : 'missing none';
  const guidanceNote = structureData.guidanceTokens ? ` · guidance tokens ${structureData.guidanceTokens}` : ' · guidance tokens 0';
  const structureSummary = `Expected ${expectedQuestionNos.length} questions · parsed ${coverage.parsedNumbers.length} · ${missingSummary} · points ${pointsSummary} · attempts ${structureData.attempts || 0} · recovery calls used ${structureData.recoveryCalls || 0}${guidanceNote}.`;
  const isIncomplete = !coverage.complete || finalQuestions.length === 0;
  const structureStatus = structureData.isCachedHit && !isIncomplete
    ? 'cached'
    : coverage.missing.length > 0 && coverage.coveragePercent < 80
      ? 'partial'
      : isIncomplete ? 'completed-with-problems' : 'completed';
  onStageUpdate({
    id: 'structure', name: 'Structure Pass', status: structureStatus as any,
    inputTokens: structureData.usage?.inputTokens, outputTokens: structureData.usage?.outputTokens,
    attempts: structureData.attempts, message: structureSummary,
  });
  onStageUpdate({
    id: 'assemble', name: 'Assemble & Validate',
    status: isIncomplete ? (coverage.coveragePercent < 80 ? 'partial' : 'completed-with-problems') : 'completed',
    message: `Assembled ${finalQuestions.length} questions across ${sectionAssembly.sections.length} sections. ${structureSummary}`,
  });

  // 2C CONSENSUS + 2B CRITIC (evidence-only, caps enforced, never blocks on failure)
  let verdictStore: Record<string, any[]> = {};
  let consensusSectionsRun: string[] = [];
  let criticSummary = { calls: 0, defects: 0, ok: 0 };
  try {
    const semanticAll = validateSemantic(finalQuestions, sectionAssembly.sections);
    const disagreementIds: string[] = [];
    // 2C — hard sections only; clean sections never pay.
    if (settings.consensusEnabled !== false && settings.providers.length) {
      const consSel = settings.roleMapping.consensus || settings.roleMapping.escalation;
      const consProvider = settings.providers.find(p => p.id === consSel?.providerId) || settings.providers[0];
      const resolved = resolveConsensusModel(structProviderConfig.model, consSel?.model, settings.roleMapping.escalation?.model);
      const parsedNosGlobal = new Set(finalQuestions.map(q => q.no));
      const triggered = sectionAssembly.sections.filter(sec => {
        const qs = finalQuestions.filter(q => q.sectionId === sec.id);
        // Missing in-section: expected printed number whose source line lies inside this section's spans and was not parsed.
        const missingInSection = expectedQuestionNos.filter(n => {
          if (parsedNosGlobal.has(n)) return false;
          const line = expectedEnumeration.lineByNumber.get(n);
          return line !== undefined && spansContainLine(sec.spans, line);
        });
        // In-section points mismatch: parsed points vs the section header total, when declared.
        const parsedPoints = qs.reduce((sum, q) => sum + (q.points || 0), 0);
        const pointsMismatch = typeof sec.points === 'number' && sec.points > 0 && parsedPoints > 0 && Math.abs(parsedPoints - sec.points) > 0.51;
        // Tripwires fired by this section's structure call (flag messages name the section).
        const tripwiresFired = (structureData.flags || []).some((f: any) => /TRIPWIRE/i.test(String(f?.code)) && (!sec.title || String(f?.message || '').includes(sec.title)));
        return consensusTriggerForSection({ questions: qs, issues: semanticAll, missingInSection, pointsMismatch, tripwiresFired }).triggered;
      }).slice(0, CONSENSUS_CAPS.maxSections);
      if ('skip' in resolved) {
        if (triggered.length) allFlags.push({ id: 'flag_CONSENSUS_SAME_MODEL', severity: 'info', code: 'CONSENSUS_SAME_MODEL', message: `Consensus skipped: consensus model is the structure model (${resolved.model}); ${triggered.length} hard section(s) not re-parsed (0 calls).` });
      } else if (triggered.length) {
        const consProviderConfig = { ...consProvider, model: resolved.model };
        let consCalls = 0;
        for (const sec of triggered) {
          if (consCalls >= CONSENSUS_CAPS.maxCalls) break;
          const aQs = finalQuestions.filter(q => q.sectionId === sec.id);
          if (!aQs.length) continue;
          const second = await runStructurePass({
            sourceLines: workingLines, images: extracted.images, languageHint: language,
            latexEnabled: settings.thrift.latexNormalization, providerConfig: consProviderConfig,
            maxBudgetTokens: settings.budget.maxOutputTokens, journalEnabled: false,
            recoveryOnlyNumbers: aQs.map(q => q.no), guidance: structureGuidance,
            parallelSections: settings.parallelSections ?? 3,
          });
          consCalls += second.callUsage?.length || second.attempts || 1;
          consensusSectionsRun.push(sec.id);
          const usageRec: UsageRecord = { ts: new Date().toISOString(), role: 'consensus', provider: consProviderConfig.name, model: resolved.model, inputTokens: second.usage.inputTokens || 0, outputTokens: second.usage.outputTokens || 0, costUsd: calculateActualCost(second.usage.inputTokens || 0, second.usage.outputTokens || 0, resolved.model, settings.costTable), label: `Consensus: ${sec.title || sec.id}` };
          usageRecords.push(usageRec); appendUsageRecord(usageRec); onUsageUpdate?.(usageRec);
          const bAssembled = assembleAndValidateQuestions(second.rawQuestions || [], workingLines, totalDeclaredPoints, { keyTerritoryLineNos, imageIds: updatedImages.map(i => i.id), unresolvedImageIds, sections: sectionAssembly.sections });
          const dec = diffConsensus(aQs, bAssembled.questions.filter(q => aQs.some(a => a.no === q.no) || q.sectionId === sec.id), semanticAll);
          for (const accepted of dec.accepted) {
            const adoptedConsensus = adoptCanonicalized({ ...accepted, sectionId: sec.id });
            if (adoptedConsensus) {
              const idx = finalQuestions.findIndex(q => q.no === adoptedConsensus.no && q.sectionId === sec.id);
              if (idx >= 0) finalQuestions[idx] = adoptedConsensus;
              else finalQuestions.push(adoptedConsensus);
            }
          }
          for (const rev of dec.review) {
            disagreementIds.push(finalQuestions.find(q => q.no === rev.no && q.sectionId === sec.id)?.id || '');
            allFlags.push({ id: `flag_CONSENSUS_REVIEW_${sec.id}_${rev.no}`, severity: 'warn', code: 'CONSENSUS_REVIEW', message: `Q${rev.no} (${sec.title || sec.id}): ${rev.reason}; both parses kept for Step 4 review.`, questionId: finalQuestions.find(q => q.no === rev.no && q.sectionId === sec.id)?.id });
          }
          if (dec.needsCritic.length) allFlags.push({ id: `flag_CONSENSUS_CRITIC_${sec.id}`, severity: 'info', code: 'CONSENSUS_CRITIC_TIEBREAK', message: `${sec.title || sec.id}: span conflict with both sides clean on Q${dec.needsCritic.join(', Q')} — queued for the critic.` });
        }
        onStageUpdate({ id: 'assemble', name: 'Assemble & Validate', status: 'completed', message: `Consensus ran on ${consensusSectionsRun.length} hard section(s) (${consCalls} call(s), model ${resolved.model}); clean sections were not re-parsed.` });
      }
    }
    // 2B — critic on evidence only. Defaults to the escalation model; never edits.
    const queue = buildCriticQueue(finalQuestions, validateSemantic(finalQuestions, sectionAssembly.sections), disagreementIds.filter(Boolean));
    if (queue.length) {
      const criticSel = settings.roleMapping.critic || settings.roleMapping.escalation;
      const criticProvider = settings.providers.find(p => p.id === criticSel?.providerId) || settings.providers[0];
      const caller = criticProvider ? async (batch: any[]) => {
        const cfg = { ...criticProvider, model: criticSel?.model || settings.roleMapping.escalation.model };
        const payload = batch.map(item => ({ questionId: item.question.id, no: item.question.no, type: item.question.type, stem: (item.question.stem || '').slice(0, 400), options: (item.question.options || []).map((o: any) => o.text), sourceSlice: sliceSourceSpans(item.question.spans || [], workingLines).slice(0, 600), suspicions: item.suspicions.map((x: any) => x.code), reason: item.reason }));
        const resp = await LLMAdapter.execute({ role: 'critic', system: 'You are an adversarial verifier. You NEVER edit. For each item return a verdict only. Output strict JSON: {"verdicts":[{"questionId":"...","verdict":"ok|defect","defectKind":"...","suggestedAction":"accept|reparse|review","note":"≤140 chars"}]}', text: JSON.stringify(payload), maxOutputTokens: 1200, label: 'Critic (evidence queue)', providerConfig: cfg } as any);
        const usageRec: UsageRecord = { ts: new Date().toISOString(), role: 'critic', provider: criticProvider.name, model: cfg.model, inputTokens: resp.usage.inputTokens || 0, outputTokens: resp.usage.outputTokens || 0, costUsd: calculateActualCost(resp.usage.inputTokens || 0, resp.usage.outputTokens || 0, cfg.model, settings.costTable), label: 'Critic (evidence queue)' };
        usageRecords.push(usageRec); appendUsageRecord(usageRec); onUsageUpdate?.(usageRec);
        try { const parsed = JSON.parse(resp.rawText.match(/\{[\s\S]*\}/)?.[0] || '{}'); return Array.isArray(parsed.verdicts) ? parsed.verdicts : []; } catch { return []; }
      } : null;
      const criticRun = await runCritic(queue, caller);
      criticSummary = { calls: criticRun.calls, defects: criticRun.verdicts.filter(v => v.verdict === 'defect').length, ok: criticRun.verdicts.filter(v => v.verdict === 'ok').length };
      onStageUpdate({ id: 'assemble', name: 'Assemble & Validate', status: 'completed', message: `Critic: ${criticSummary.calls} batched call(s) on ${queue.length} evidence-flagged question(s) — ${criticSummary.defects} defect(s), ${criticSummary.ok} ok${criticRun.degraded ? ' (unconfigured: queued for review, 0 calls)' : ''}. Consensus sections: ${consensusSectionsRun.length}.` });
      verdictStore = recordVerdicts(verdictStore, criticRun.verdicts);
      for (const v of criticRun.verdicts) {
        const q = finalQuestions.find(item => item.id === v.questionId);
        if (q && !q.flags?.includes('CRITIC_' + v.verdict.toUpperCase())) q.flags = [...(q.flags || []), 'CRITIC_' + v.verdict.toUpperCase()];
        allFlags.push({ id: `flag_CRITIC_${v.questionId}`, severity: v.verdict === 'defect' ? 'warn' : 'info', code: v.verdict === 'defect' ? 'CRITIC_DEFECT' : 'CRITIC_OK', message: `Critic Q${q?.no ?? v.questionId}: ${v.verdict}${v.defectKind ? ` (${v.defectKind})` : ''} → ${v.suggestedAction}. ${v.note}`, questionId: v.questionId });
      }
      if (criticRun.degraded) allFlags.push({ id: 'flag_CRITIC_UNCONFIGURED', severity: 'info', code: 'CRITIC_UNCONFIGURED', message: `No critic model configured: ${queue.length} flagged question(s) queued for Step 4 review (0 critic calls).` });
      else if (criticRun.reparseQueue.length) {
        // 2B: reparse → existing recovery machinery/budget. The critic never edits;
        // the structure role re-parses only the condemned printed numbers and the
        // replacement must assemble cleanly (or at least differently) to be adopted.
        const reparseNos = [...new Set(criticRun.reparseQueue.map(id => finalQuestions.find(q => q.id === id)?.no).filter((n): n is number => typeof n === 'number'))];
        let adopted = 0;
        if (reparseNos.length) {
          try {
            const existingRawQuestions = finalQuestions.map(question => ({
              id: question.id, label: question.label, no: question.no, parentId: question.parentId, sectionId: question.sectionId,
              spans: question.spans, points: question.points, type: question.type,
              options: question.options?.map(option => ({ key: option.key, spans: option.spans })),
              answer: question.answer?.spans ? { spans: question.answer.spans } : undefined,
              tables: question.tables?.map(table => ({ spans: table.spans })),
              rewrites: question.rewrites, images: question.images, confidence: question.confidence, flags: question.flags,
            }));
            const reparsed = await runStructurePass({
              sourceLines: workingLines, images: extracted.images, languageHint: language,
              latexEnabled: settings.thrift.latexNormalization, providerConfig: structProviderConfig,
              maxBudgetTokens: settings.budget.maxOutputTokens, journalEnabled: false,
              forceSectionMode: true, recoveryOnlyNumbers: reparseNos, existingRawQuestions,
              existingSections: sectionAssembly.sections, guidance: structureGuidance,
              parallelSections: settings.parallelSections ?? 3,
            });
            const usageRec: UsageRecord = { ts: new Date().toISOString(), role: 'fast', provider: structProviderConfig.name, model: structProviderConfig.model, inputTokens: reparsed.usage.inputTokens || 0, outputTokens: reparsed.usage.outputTokens || 0, costUsd: calculateActualCost(reparsed.usage.inputTokens || 0, reparsed.usage.outputTokens || 0, structProviderConfig.model, settings.costTable), label: 'Critic Reparse (recovery machinery)' };
            usageRecords.push(usageRec); appendUsageRecord(usageRec); onUsageUpdate?.(usageRec);
            const fresh = assembleAndValidateQuestions((reparsed.rawQuestions || []).filter((raw: any) => reparseNos.includes(Number(raw.no))), workingLines, totalDeclaredPoints, { keyTerritoryLineNos, imageIds: updatedImages.map(i => i.id), unresolvedImageIds, sections: sectionAssembly.sections });
            for (const candidate of fresh.questions) {
              const idx = finalQuestions.findIndex(q => q.no === candidate.no);
              if (idx < 0) continue;
              const before = finalQuestions[idx];
              const candidateWarns = validateSemantic([candidate], sectionAssembly.sections).filter(i => i.severity === 'warn').length;
              const beforeWarns = validateSemantic([before], sectionAssembly.sections).filter(i => i.severity === 'warn').length;
              if (candidateWarns < beforeWarns || JSON.stringify(candidate.spans) !== JSON.stringify(before.spans)) {
                const adoptedCandidate = adoptCanonicalized({
                  ...candidate,
                  id: before.id,
                  sectionId: before.sectionId,
                  flags: [...(candidate.flags || []), 'CRITIC_REPARSED'],
                });
                if (adoptedCandidate) {
                  finalQuestions[idx] = adoptedCandidate;
                  adopted++;
                }
              }
            }
          } catch { /* recovery failure leaves the original questions + review flags intact */ }
        }
        allFlags.push({ id: 'flag_CRITIC_REPARSE', severity: 'warn', code: 'CRITIC_REPARSE_DONE', message: `Critic requested reparse for ${reparseNos.length} question(s); existing recovery machinery re-parsed them and ${adopted} replacement(s) were adopted (critic itself never edits). Remainder stay at the top of the Step 4 queue.` });
      }
    }
  } catch (err: any) {
    allFlags.push({ id: 'flag_PROVING_GROUND_SKIPPED', severity: 'info', code: 'PROVING_GROUND_SKIPPED', message: `Consensus/critic stage skipped after a local error (pipeline result unaffected): ${String(err?.message || err).slice(0, 160)}` });
  }

  // 6.9 — FINAL CANONICALIZATION PASS (Marvel Batch 6, Fix 1).
  // Assembly-time canonicalization only shapes the FIRST pass; escalation repair, consensus,
  // critic reparse and recovery all replace questions wholesale afterwards. This runs the same
  // exported registry last — after every question-producing/replacing stage and before the
  // invariant gate/save — so form fixes (TF pairs, inline MCQ, matching pools), the >500-char
  // passage re-detachment brake, phantom-child rejection and the shape audit are a guarantee,
  // not a suggestion. It never blocks saving; remaining shape classes demote to PARTIAL below.
  const finalPass = runFinalCanonicalization({
    questions: finalQuestions,
    sourceLines: workingLines,
    sections: sectionAssembly.sections,
  });
  finalQuestions = finalPass.questions;
  {
    // Sections come back cloned; land passage/instruction updates on the live section objects.
    const updatedById = new Map(finalPass.sections.map(section => [section.id, section]));
    for (const section of sectionAssembly.sections) {
      const updated = updatedById.get(section.id);
      if (!updated) continue;
      if (updated.passage !== undefined) section.passage = updated.passage;
      if (updated.instructions !== undefined) section.instructions = updated.instructions;
    }
  }
  for (const formFlag of finalPass.flags) {
    if (!allFlags.some(existing => existing.code === formFlag.code && existing.questionId === formFlag.questionId)) allFlags.push(formFlag);
  }
  // 6.5 PART B (follow-up #36) — EXACT image assignment, replacing the old heuristic distributor.
  // Ownership is decided by printed geometry + counts (B2 bijection), verified by caption affinity (B3),
  // and never by a run-to-run model vote (B5). Single ownership (I13) is rebuilt from the owner map.
  const imageAssignment = await assignImagesExact({
    questions: finalQuestions,
    images: updatedImages,
    sourceLines: workingLines,
    adjudicate: (cases) => adjudicateImageAssignments({
      cases,
      providerConfig: visionProviderConfig,
      maxOutputTokens: settings.budget.maxOutputTokens,
      onLiveText: (label, channel, text) => onLiveText?.('vision', label, channel, text),
    }) as any,
  });
  finalQuestions = imageAssignment.questions;
  updatedImages = imageAssignment.images;
  allFlags.push(...imageAssignment.flags);
  const assignmentSummary = [
    `order-bijection ${imageAssignment.byRule['order-bijection'] || 0}`,
    ...(imageAssignment.byRule['parent-as-item'] ? [`parent-as-item ${imageAssignment.byRule['parent-as-item']}`] : []),
    `caption-verified ${imageAssignment.byRule['caption-verified'] || 0}`,
    `vision-adjudicated ${imageAssignment.adjudicated}`,
    `geometry ${imageAssignment.byRule.geometry || 0}`,
    `tray ${imageAssignment.tray.length}`,
    `${imageAssignment.corrected} caption correction(s)`,
    `${imageAssignment.suspects} suspect`,
  ].join(' · ');
  onStageUpdate({
    id: 'assemble',
    name: 'Assemble & Validate',
    status: imageAssignment.suspects ? 'completed-with-problems' : 'completed',
    message: `Image assignment (exact): ${assignmentSummary}; every image has at most one owning question (I13).`,
  });

  // 6.6 PART C (Godlike Batch 1) — ANSWER CORRECTNESS. C1 is pure local: letter answers are
  // checked against the {no → letter} table sliced from key territory (table wins, ambiguity
  // → ANSWER_CONFLICT attention). C2 spends at most ONE batched fast-role call spot-checking
  // short/fill text answers against the key's own text (cached per stem+answers hash, skipped
  // silently with no available model); mismatches are attention items, never rewrites.
  const correctness = await runAnswerCorrectness({
    questions: finalQuestions,
    lines: workingLines,
    keyLines: keyTerritoryLineNos,
    spotProvider: structProviderConfig.id,
    spotModel: structProviderConfig.model,
    spotCache: {
      get: async key => { try { return await getPipelineCache<SpotVerdict>(key); } catch { return undefined; } },
      set: async (key, value) => { if (cacheEnabled) await setPipelineCache<SpotVerdict>(key, value); },
    } satisfies AnswerSpotCache,
    spotCaller: async req => {
      const response = await LLMAdapter.execute(
        { role: 'fast', system: req.system, text: req.text, maxOutputTokens: req.maxOutputTokens, label: req.label, providerConfig: structProviderConfig },
        { onDelta: (channel, full) => onLiveText?.('assemble', req.label, channel, full), onInfo: note => onLiveText?.('assemble', req.label, 'info', note) },
      );
      return { rawText: response.rawText, json: response.json, usage: response.usage };
    },
  });
  finalQuestions = correctness.questions;
  allFlags.push(...correctness.flags);
  if (correctness.spot.calls) {
    const spotCost = calculateActualCost(correctness.spot.inputTokens, correctness.spot.outputTokens, structProviderConfig.model, settings.costTable);
    const rec: UsageRecord = {
      ts: new Date().toISOString(), role: 'fast', provider: structProviderConfig.name, model: structProviderConfig.model,
      inputTokens: correctness.spot.inputTokens, outputTokens: correctness.spot.outputTokens, costUsd: spotCost,
      label: `Answer spot-check (${correctness.spot.candidates} item${correctness.spot.candidates === 1 ? '' : 's'}; one batch)`,
    };
    usageRecords.push(rec); appendUsageRecord(rec); onUsageUpdate?.(rec);
  }
  onStageUpdate({
    id: 'assemble',
    name: 'Assemble & Validate',
    status: correctness.letter.conflicts || correctness.spot.mismatches ? 'completed-with-problems' : 'completed',
    message: `Answer correctness: ${correctness.letter.checked} letter answer(s) checked against the key table (${correctness.letter.agreed} agreed, ${correctness.letter.corrected} corrected from the key, ${correctness.letter.conflicts} conflict(s)); text spot-check ${correctness.spot.status} (${correctness.spot.calls} call, ${correctness.spot.mismatches} mismatch(es) for review).`,
  });


  // Typed against `ShapeProblemDiagnosis['kinds']` so a new final-pass shape class cannot be
  // silently dropped from the demotion mapping (tsc enforces completeness now).
  const SHAPE_CLASS_CODE: Record<import('./forms').ShapeProblemDiagnosis['kinds'][number], { code: string; label: string }> = {
    'duplicate-options': { code: 'SHAPE_DUPLICATE_OPTIONS', label: 'duplicate options' },
    'option-contains-stem': { code: 'SHAPE_OPTION_INCLUDES_STEM', label: 'option repeats its whole stem' },
    'sibling-identical-stem': { code: 'SHAPE_DUPLICATE_SIBLING_STEMS', label: 'identical sibling stems' },
    'overlong-stem': { code: 'SHAPE_OVERLONG_STEM', label: 'stem >500 chars after re-detachment' },
    'malformed-truefalse': { code: 'SHAPE_MALFORMED_TRUEFALSE', label: 'malformed True/False pair' },
  };
  const finalShapeViolations: import('./quality').InvariantViolation[] = [];
  for (const problem of finalPass.shapeProblems) {
    for (const kind of problem.kinds) {
      const meta = SHAPE_CLASS_CODE[kind];
      if (!meta) continue;
      finalShapeViolations.push({
        code: meta.code,
        severity: 'error',
        questionId: problem.questionId,
        message: `Q${problem.no}: ${meta.label} survived the final canonicalization pass.`,
      });
    }
  }
  const shapeAuditLabel = `${finalPass.shapeAudit.optionIncludesStem}/${finalPass.shapeAudit.duplicateSiblingStems}/${finalPass.shapeAudit.overlongStems}`;
  const shapeAuditClean = finalPass.shapeAudit.optionIncludesStem === 0 && finalPass.shapeAudit.duplicateSiblingStems === 0 && finalPass.shapeAudit.overlongStems === 0;
  const overlongSummary = finalPass.stemOverlong.length
    ? ` · overlong: ${finalPass.stemOverlong.map(item => `Q${item.no} (${item.length} chars)`).join(', ')}`
    : '';
  onStageUpdate({
    id: 'assemble',
    name: 'Assemble & Validate',
    status: shapeAuditClean ? 'completed' : 'completed-with-problems',
    message: `Final canonicalization (last): ${finalPass.questions.length} question(s) · shape audit ${shapeAuditLabel} (option⊃stem / duplicate sibling stems / overlong stems)${overlongSummary}.`,
  });

  // 7. BUILD FINAL EXAM DOC & PERSIST
  const examId = `exam_${fileHash.slice(0, 12)}`;
  // AI-metadata naming (no extra API call). Preserve a manual rename on re-analysis of the same file/id.
  let displayName = computeDisplayName(structureData.meta, file.name);
  let nameSource: 'ai' | 'manual' = 'ai';
  try {
    const existing = await loadExamDoc(examId);
    if (existing?.nameSource === 'manual' && existing.displayName?.trim()) {
      displayName = existing.displayName;
      nameSource = 'manual';
    }
  } catch {
    // No existing doc / storage unavailable — keep the AI-derived name.
  }
  const diagnostics = extractionDiagnostics(workingLines, extracted.pages, updatedImages,
    extracted.scannedPageIndices.filter(page => workingLines.some(line => line.page === page)), extracted.diagnostics);
  for (const page of diagnostics.emptyPages) allFlags.push({ id: `extraction_empty_${page}`, code: 'EXTRACTION_PAGE_EMPTY', severity: 'error', message: `Page ${page} has no extracted or OCR text. Review import.` });
  // B3 (after consensus/critic) — ownership map → ORPHAN_LINES (info ≤2%, warn above).
  const ownership = computeOwnership({ lines: workingLines, questions: finalQuestions, sections: sectionAssembly.sections, keyLines: keyTerritoryLineNos });
  const orphan = orphanFlag(ownership);
  if (orphan) allFlags.push({ id: 'flag_ORPHAN_LINES', severity: orphan.severity, code: orphan.code, message: orphan.message });

  let examDoc: ExamDoc = {
    id: examId,
    fileHash,
    createdAt: new Date().toISOString(),
    displayName,
    nameSource,
    meta: {
      title: structureData.meta?.title || file.name.replace(/\.[^/.]+$/, ''),
      subject: structureData.meta?.subject,
      grade: structureData.meta?.grade,
      school: structureData.meta?.school,
      term: structureData.meta?.term,
      year: structureData.meta?.year,
      durationMinutes: structureData.meta?.durationMinutes,
      totalPoints: reconciledTotalPoints,
      language,
      direction: langDirection,
    },
    sections: sectionAssembly.sections,
    questions: finalQuestions,
    images: updatedImages,
    source: {
      diagnostics,
      lines: storedSourceLines,
      ...(Object.keys(textRepairLineRepairs).length ? { lineRepairs: textRepairLineRepairs } : {}),
      ...(textRepairStats ? { textRepairStats } : {}),
      pages: extracted.pages,
      ocrUsed,
      fileName: file.name,
      pageImages: extracted.pageImages,
      pageThumbKeys: extracted.pageThumbKeys || [],
      expectedQuestionNos,
      keyTerritoryLineNos,
      orphanLineNos: ownership.orphanLineNos,
      // Fix 1c/4 — final canonicalization receipts for the health report (persisted, not just logged).
      finalShapeAudit: { ...finalPass.shapeAudit },
      ...(cleanupStats ? { cleanupStats } : {}),
      ...(Object.keys(cleanupOverrides).length ? { cleanupOverrides } : {}),
    },
    flags: allFlags,
    usage: usageRecords,
    // #38 spine receipt (classify provenance + repair-loop summary + shared budget accounting).
    spine: {
      classify: spineInfo.classify,
      repairLoop: spineInfo.repairLoop,
      budget: { calls: spineBudget.calls, units: spineBudget.units, maxCalls: spineBudget.maxCalls, maxUnits: spineBudget.maxUnits },
    },
    guidanceTokens: Number(structureData.guidanceTokens) || 0,
    verdicts: verdictStore,
    traces: tracesForDoc({ id: examId, questions: finalQuestions } as any, { callLabel: 'Structure Pass', model: structProviderConfig.model, journalResumed: Boolean(structureData.isCachedHit) }),
  };

  // C5: resolve extraction collisions only after assembly, when source-page context
  // can safely rewrite question references as well as image metadata and flags.
  examDoc = validateAndFixDuplicateImageIds(examDoc).doc;
  examDoc = reconcileFinalFlags(repairImageReferences(examDoc, examDoc.images));
  // I13 (Part B1) — enforced in the final pass exactly like I12: no image id may appear in two questions.
  examDoc = enforceSingleImageOwnership(examDoc).doc;

  // C2 — a finished parse always persists. Any error-severity violation that survived the
  // deterministic fixes demotes this doc to visibly PARTIAL (persisted `partial` marker +
  // PARTIAL_EXAM flag naming the questions). saveExamDoc itself never rejects for quality.
  const saveGate = validateExamInvariants(examDoc);
  // Final-pass shape classes are demoted through the SAME save-boundary mechanics (never block):
  // the PARTIAL_EXAM banner names the offending printed numbers.
  const gateViolations = finalShapeViolations.length
    ? [...saveGate.violations, ...finalShapeViolations]
    : saveGate.violations;
  if (!saveGate.ok || finalShapeViolations.length) examDoc = markPartialForInvariantViolations(examDoc, gateViolations);

  // Persist durably BEFORE prepareReviewDocument so deferred import-time _blob payloads are written
  // to folder storage first, and any PARTIAL-STORAGE status is reflected on the returned examDoc.
  const saveResult = await saveExamDoc(examDoc);
  if (saveResult.status === 'PARTIAL-STORAGE') {
    const failedSet = new Set(saveResult.failedImageIds);
    examDoc = {
      ...examDoc,
      storageState: 'PARTIAL-STORAGE',
      failedImageIds: saveResult.failedImageIds,
      images: examDoc.images.map(img =>
        failedSet.has(img.id)
          ? (() => {
              const { dataUrl: _omit, ...rest } = img;
              return { ...rest, storageMissing: true };
            })()
          : img,
      ),
      flags: [
        ...examDoc.flags.filter(f => f.code !== 'PARTIAL_STORAGE'),
        {
          id: 'flag_PARTIAL_STORAGE',
          severity: 'warn',
          code: 'PARTIAL_STORAGE',
          rootCauseId: 'storage_failure',
          message: saveResult.banner || `PARTIAL-STORAGE: failed to persist image blobs (${saveResult.failedImageIds.join(', ')})`,
        },
      ],
    };
  }
  examDoc = await prepareReviewDocument(examDoc, getReviewImageBlob);

  // D3 — pipeline finish (including partial) is a job completion point: journal the run,
  // credit/blame matched lessons from the OUTCOME, and maybe reflect. Fire-and-forget.
  if (job) {
    try {
      const finalHealth = getExamHealth(examDoc);
      const liveCalls = usageRecords.filter(record => !record.isCachedHit);
      const isCacheHit = usageRecords.length > 0 && liveCalls.length === 0;
      job.ladderPath = [
        'extract',
        ...(ocrUsed ? ['ocr'] : []),
        'cleanup',
        'structure',
        ...(structureData.callUsage?.length ? structureData.callUsage.map((call: any) => String(call.label || 'structure')) : []),
        ...(updatedImages.length ? ['vision'] : []),
        'assemble',
        ...(assembled.failingQuestions?.length ? ['repair'] : []),
        ...(options?.answerKeyFile ? ['keyfile'] : []),
      ];
      job.flagsRaised = allFlags.map(flag => String(flag?.code || '')).filter(Boolean);
      await endJob(job, {
        health: {
          expected: finalHealth.expectedCount, parsed: finalHealth.parsedCount, missing: finalHealth.missing,
          duplicates: finalHealth.duplicates, coveragePercent: finalHealth.coveragePercent, state: finalHealth.state,
          complete: finalHealth.complete, pointsParsed: finalHealth.pointsParsed, pointsExpected: finalHealth.pointsExpected,
          // Final-pass (Fix 1c/4): shape audit counts + stems still over the brake after re-detachment.
          shapeAudit: finalPass.shapeAudit,
          overlongStems: finalPass.stemOverlong,
        },
        verifierDefects: allFlags.filter(f => ['ANSWER_ANCHOR_SUSPECT','OPTION_DUPLICATE','PASSAGE_DETACHED','SECTION_SPAN_OUTSIDE','CRITIC_DEFECT'].includes(String(f?.code))).length,
        // C3 — key-table agreement feeds the scoreboard's answer-accuracy trait.
        answerAccuracy: correctness.accuracy.checked ? { ...correctness.accuracy } : undefined,
        calls: liveCalls.length,
        tokens: {
          input: usageRecords.reduce((sum, record) => sum + (record.inputTokens || 0), 0),
          output: usageRecords.reduce((sum, record) => sum + (record.outputTokens || 0), 0),
          cached: usageRecords.reduce((sum, record) => sum + (record.cachedTokens || 0), 0),
        },
        costUsd: usageRecords.reduce((sum, record) => sum + (record.costUsd || 0), 0),
        isCacheHit,
        settings,
        baselineRevision: examContentRevisionLocal(examDoc),
        sourceLines: workingLines.slice(0, 500).map((line: any) => String(line?.text || '')),
      });
      onStageUpdate({
        id: 'structure', name: 'Structure Pass', status: structureStatus as any,
        message: `${structureSummary} ${guidanceSummary(job)}`,
      });
    } catch { /* memory is advisory (E1) — never fail a parse over it */ }
  }
  void jobStartedAt;
  return examDoc;
}

/** Local revision helper so the memory harness never imports the quality module twice. */
function examContentRevisionLocal(doc: ExamDoc): string {
  try { return JSON.stringify([doc.questions?.length, doc.sections?.length, doc.images?.length, doc.flags?.length, doc.meta]).slice(0, 400); } catch { return ''; }
}

export { sliceSourceSpans, carveOptionsAcrossLines, carveGroupChildSpans } from './spans';
export { canonicalizeForms, computeShapeAudit, runFinalCanonicalization, FORM_EXECUTION_ORDER, FORM_RULE_ID } from './forms';
export { replayFieldExport } from './fieldReplay';

