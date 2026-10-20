/**
 * Main Pipeline Orchestrator (§6)
 * Coordinates Extract → OCR → Structure → Vision → Assemble & Validate → Escalation Repair
 * with content-hash caching, token thrift enforcement, and live stage status.
 */
import { AppSettings, ExamDoc, SourceLine, StageStatus, UsageRecord, computeDisplayName } from '../types';
import { extractDocument, ExtractedDocument } from './extract';
import { tagFurniture, extractionDiagnostics } from './extractionQuality';
import { runBatchedOcr } from './ocr';
import { runStructurePass } from './structure';
import { labelImagesBatched } from './vision';
import { assembleAndValidateQuestions, assembleAndValidateSections, sliceSourceSpans, validateAndFixDuplicateImageIds } from './assemble';
import { autoDecorateRepeatedImages, computeImageQuestionHints, enumerateExpectedQuestionNos, evaluateCoverage, parsePrintedNumberFromStem } from './quality';
import { runEscalationRepair } from './repair';
import { sha256 } from '../utils/hash';
import { getCachedStageResult, setCachedStageResult } from './cache';
import { appendUsageRecord, loadExamDoc, loadPageThumbDataUrls, saveExamDoc, setPipelineCache } from '../store';
import { calculateActualCost, updateTokenCalibration } from '../utils/budget';
import { detectLanguageAndDirection } from '../utils/numbers';
import { PARSER_VERSION } from './prompts';
import { getExamHealth } from './quality';
import { beginJob, endJob, guidanceSummary, type JobHandle } from './memory/harness';

export interface PipelineCallbacks {
  onStageUpdate: (stage: StageStatus) => void;
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
  const keyTerritoryLineNos = [...expectedEnumeration.keyTerritory.lineNos].sort((a, b) => a - b);

  // 3. STAGE: STRUCTURE PASS (single call for short docs; bounded sections for long/weak-model docs)
  onStageUpdate({
    id: 'structure',
    name: 'Structure Pass',
    status: 'running',
    message: `Expected ${expectedQuestionNos.length} printed question(s); deterministic completeness gate enabled.`,
  });

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

  // Check cache for structure pass
  const cachedStructure = !stageForced('structure')
    ? await getCachedStageResult<any>({
        fileHash,
        stage: 'structure',
        provider: structProviderConfig.id,
        model: structProviderConfig.model,
        options: { latex: settings.thrift.latexNormalization, linesHash },
      })
    : null;

  let structureData: any;
    // Never serve empty, json:null, or incomplete structure caches. Incomplete results must re-enter the journal-aware recovery path.
    const cachedCoverage = cachedStructure && Array.isArray((cachedStructure as any).rawQuestions)
      ? evaluateCoverage(expectedQuestionNos, (cachedStructure as any).rawQuestions.map((q: any) => ({ ...q, stem: sliceSourceSpans(q.spans || [], workingLines) })), (cachedStructure as any).meta?.totalPoints)
      : null;
    const cachedStructureUsable = Boolean(
      cachedStructure && Array.isArray((cachedStructure as any).rawQuestions) && (cachedStructure as any).rawQuestions.length > 0 &&
      !(cachedStructure as any).jsonNull && cachedCoverage?.complete
    );
    if (cachedStructureUsable) {
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
          images: extracted.images,
          languageHint: language,
          latexEnabled: settings.thrift.latexNormalization,
          providerConfig: structProviderConfig,
          maxBudgetTokens: settings.budget.maxOutputTokens,
          journalEnabled: cacheEnabled && !stageForced('structure'),
          journalKey,
          forceSectionMode: structRole.model.toLowerCase().includes('free') || settings.budget.maxOutputTokens < 8192,
          onProgress: message => onStageUpdate({ id: 'structure', name: 'Structure Pass', status: 'running', message }),
          onLiveText: (label, channel, fullText) => onLiveText?.('structure', label, channel, fullText),
          guidance: structureGuidance,
        });
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
    const structCoverage = evaluateCoverage(expectedQuestionNos, structRes.rawQuestions.map((q: any) => ({ ...q, stem: sliceSourceSpans(q.spans || [], workingLines) })), structRes.meta?.totalPoints);
    if (structRes.rawQuestions.length > 0 && !structRes.jsonNull && structCoverage.complete) {
      await writeStageCache(
        {
          fileHash,
          stage: 'structure',
          provider: structProviderConfig.id,
          model: structProviderConfig.model,
          options: { latex: settings.thrift.latexNormalization, linesHash },
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

  // 4. STAGE: VISION CALL — geometric hints are set locally before the single bundled model pass.
  let updatedImages = autoDecorateRepeatedImages(extracted.images);
  const questionHints = computeImageQuestionHints(updatedImages, structureData.rawQuestions || [], workingLines);
  updatedImages = updatedImages.map(img => {
    const hint = questionHints[img.id];
    if (!hint || img.label?.role === 'decoration' || img.label?.kind === 'decoration') return img;
    return { ...img, label: { ...(img.label || {}), role: img.label?.role || 'stem', questionRef: img.label?.questionRef || hint.questionRef } };
  });
  let visionStageFlags: any[] = [];
  const visionCandidates = updatedImages.filter(img => img.label?.role !== 'decoration' && img.label?.kind !== 'decoration');
  if (updatedImages.length > 0 && visionCandidates.length > 0) {
    onStageUpdate({
      id: 'vision',
      name: 'Batched Vision Labeling',
      status: 'running',
      message: `Labeling ${visionCandidates.length} image(s) in ${Math.ceil(visionCandidates.length / Math.max(1, settings.thrift.maxImagesPerVisionCall))} bundled call(s); repeated logos were classified locally.`,
    });

    const visionRole = settings.roleMapping.vision;
    const visionProvider = settings.providers.find(p => p.id === visionRole.providerId) || settings.providers[0];
    const visionProviderConfig = { ...visionProvider, model: visionRole.model };

    const cachedVision = !stageForced('vision')
      ? await getCachedStageResult<any>({
          fileHash,
          stage: 'vision',
          provider: visionProviderConfig.id,
          model: visionProviderConfig.model,
          options: { linesHash, imgShas: visionImgShas },
        })
      : null;

    if (cachedVision) {
      const cachedImages = autoDecorateRepeatedImages(cachedVision.updatedImages || []);
      const cachedById = new Map(cachedImages.map((img: any) => [img.id, img]));
      updatedImages = updatedImages.map(img => {
        const cached = cachedById.get(img.id);
        const hint = questionHints[img.id];
        return cached ? { ...img, ...cached, label: cached.label || img.label } : img.label?.questionRef || !hint ? img : { ...img, label: { ...(img.label || {}), role: 'stem', questionRef: hint.questionRef } };
      });
      visionStageFlags = cachedVision.flags || [];
      const cachedUsageRec: UsageRecord = {
        ts: new Date().toISOString(), role: 'vision', provider: visionProviderConfig.name, model: visionProviderConfig.model,
        inputTokens: cachedVision.usage?.inputTokens || 0, outputTokens: cachedVision.usage?.outputTokens || 0, costUsd: 0,
        label: 'Vision Labeling (Cache Hit)', isCachedHit: true,
      };
      usageRecords.push(cachedUsageRec);
      appendUsageRecord(cachedUsageRec, `${examIdForDedupe(fileHash)}:vision:${visionProviderConfig.model}`);
      onUsageUpdate?.(cachedUsageRec);
      onStageUpdate({ id: 'vision', name: 'Batched Vision Labeling', status: 'cached', message: 'Image labels loaded from cache; local geometric hints retained (0 calls).' });
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
        questionHints,
        onLiveText: (label, channel, text) => onLiveText?.('vision', label, channel, text),
      });
      const visionById = new Map(visionRes.updatedImages.map(img => [img.id, img]));
      updatedImages = updatedImages.map(img => visionById.get(img.id) || img);
      visionStageFlags = visionRes.flags || [];
      const costUsd = calculateActualCost(visionRes.usage.inputTokens, visionRes.usage.outputTokens, visionProviderConfig.model, settings.costTable);
      const usageRec: UsageRecord = {
        ts: new Date().toISOString(), role: 'vision', provider: visionProviderConfig.name, model: visionProviderConfig.model,
        inputTokens: visionRes.usage.inputTokens, outputTokens: visionRes.usage.outputTokens, costUsd,
        label: `Vision Labeling (${visionCandidates.length} images)`,
      };
      usageRecords.push(usageRec); appendUsageRecord(usageRec); onUsageUpdate?.(usageRec);
      await writeStageCache({ fileHash, stage: 'vision', provider: visionProviderConfig.id, model: visionProviderConfig.model, options: { linesHash, imgShas: visionImgShas } }, visionRes);
      onStageUpdate({
        id: 'vision', name: 'Batched Vision Labeling', status: 'completed', durationMs: Date.now() - t0,
        inputTokens: visionRes.usage.inputTokens, outputTokens: visionRes.usage.outputTokens, costUsd,
        message: `Mapped ${visionCandidates.length} image(s); geometric hints supplied before model confirmation.`,
      });
    }
  } else if (updatedImages.length > 0) {
    onStageUpdate({ id: 'vision', name: 'Batched Vision Labeling', status: 'skipped', message: 'All detected images were repeated page decorations; classified locally (0 calls).' });
  } else {
    onStageUpdate({ id: 'vision', name: 'Batched Vision Labeling', status: 'skipped', message: 'No images detected in document (0 calls).' });
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
    { keyTerritoryLineNos, imageIds: updatedImages.map(img => img.id), unresolvedImageIds }
  );

  let finalQuestions = assembled.questions;
  let allFlags: any[] = [
    ...(structureData.flags || []),
    ...assembled.flags,
    ...(visionStageFlags || []),
  ].map((f: any, i: number) => ({ ...f, id: f.id || `flag_pipeline_${i + 1}` }));

  // Attach locally hinted / vision-confirmed assets. Parent/group references are resolved before children.
  for (const img of updatedImages) {
    if (img.label?.questionRef && img.label.role !== 'decoration' && img.label.kind !== 'decoration') {
      const matchQ = finalQuestions.find(q => q.id === img.label?.questionRef || q.label === img.label?.questionRef || String(q.no) === img.label?.questionRef);
      if (matchQ && !matchQ.images.some(ref => ref.imageId === img.id)) {
        matchQ.images.push({ imageId: img.id, role: img.label.role || 'stem', anchorLine: img.anchorLine });
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
      finalQuestions = cachedRepair.repairedQuestions;
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
      if (repairRes.rejectedCount) allFlags.push({ id: `flag_repair_rejected_${allFlags.length + 1}`, severity: 'error', code: 'REPAIR_SPAN_REJECTED', message: `${repairRes.rejectedCount} repaired question(s) were excluded because no safe question spans remained outside answer-key territory.` });
      if (repairRes.restrictedCount) allFlags.push({ id: `flag_repair_restricted_${allFlags.length + 1}`, severity: 'warn', code: 'REPAIR_SPAN_RESTRICTED', message: `${repairRes.restrictedCount} repaired item(s) had unsafe or answer-key spans clipped locally; review the remaining source anchors.` });

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

  // Local completeness and section hygiene run after every structure outcome, including cache/resume/chunk/repair paths.
  const coverage = evaluateCoverage(expectedQuestionNos, finalQuestions, totalDeclaredPoints);
  if (coverage.missing.length && !allFlags.some(f => f.code === 'COVERAGE_MISSING')) allFlags.push({ id: 'flag_coverage_missing', severity: 'error', code: 'COVERAGE_MISSING', message: `Missing printed question numbers: ${coverage.missing.join(', ')}.` });
  if (coverage.duplicates.length && !allFlags.some(f => f.code === 'COVERAGE_DUPLICATE')) allFlags.push({ id: 'flag_coverage_duplicate', severity: 'warn', code: 'COVERAGE_DUPLICATE', message: `Duplicate printed question numbers: ${coverage.duplicates.join(', ')}.` });
  if (!coverage.pointsMatch && !allFlags.some(f => f.code === 'POINTS_MISMATCH')) allFlags.push({ id: 'flag_points_mismatch', severity: 'warn', code: 'POINTS_MISMATCH', message: `Points sum ${coverage.pointsParsed} does not match header ${totalDeclaredPoints}; deficit ${coverage.pointDeficit}.` });
  if (coverage.missing.length && !allFlags.some(f => f.code === 'PARTIAL_COVERAGE')) allFlags.push({ id: 'flag_partial_coverage', severity: 'error', code: 'PARTIAL_COVERAGE', message: `Recovery exhausted with ${coverage.missing.length} missing question(s): ${coverage.missing.join(', ')}.` });
  if (!finalQuestions.length && !allFlags.some(f => f.code === 'STRUCTURE_EMPTY')) allFlags.push({ id: 'flag_structure_empty', severity: 'error', code: 'STRUCTURE_EMPTY', message: 'No questions were reconstructed; the document remains incomplete.' });

  // Fill undeclared section ids locally from the question's source span.
  finalQuestions = finalQuestions.map(question => {
    if (question.sectionId) return question;
    const firstLine = question.spans[0]?.[0];
    const section = structureData.sections?.find((candidate: any) => (candidate.spans || []).some((span: any) => firstLine >= span[0] && firstLine <= span[1]));
    return section ? { ...question, sectionId: section.id } : question;
  });
  const sectionAssembly = assembleAndValidateSections(structureData.sections, workingLines, finalQuestions, keyTerritoryLineNos);
  allFlags.push(...sectionAssembly.flags.map((f, i) => ({ ...f, id: f.id || `flag_section_${i + 1}` })));

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
      totalPoints: structureData.meta?.totalPoints,
      language,
      direction: langDirection,
    },
    sections: sectionAssembly.sections,
    questions: finalQuestions,
    images: updatedImages,
    source: {
      diagnostics,
      lines: workingLines,
      pages: extracted.pages,
      ocrUsed,
      fileName: file.name,
      pageImages: extracted.pageImages,
      pageThumbKeys: extracted.pageThumbKeys || [],
      expectedQuestionNos,
      keyTerritoryLineNos,
    },
    flags: allFlags,
    usage: usageRecords,
  };

  // C5: resolve extraction collisions only after assembly, when source-page context
  // can safely rewrite question references as well as image metadata and flags.
  examDoc = validateAndFixDuplicateImageIds(examDoc).doc;

  await saveExamDoc(examDoc);

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
        },
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
