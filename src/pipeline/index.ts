/**
 * Main Pipeline Orchestrator (§6)
 * Coordinates Extract → OCR → Structure → Vision → Assemble & Validate → Escalation Repair
 * with content-hash caching, token thrift enforcement, and live stage status.
 */
import { AppSettings, ExamDoc, SourceLine, StageStatus, UsageRecord, computeDisplayName } from '../types';
import { extractDocument, ExtractedDocument } from './extract';
import { runBatchedOcr } from './ocr';
import { runStructurePass } from './structure';
import { labelImagesBatched } from './vision';
import { assembleAndValidateQuestions } from './assemble';
import { runEscalationRepair } from './repair';
import { sha256 } from '../utils/hash';
import { getCachedStageResult, setCachedStageResult } from './cache';
import { appendUsageRecord, loadExamDoc, loadPageThumbDataUrls, saveExamDoc } from '../store';
import { calculateActualCost, updateTokenCalibration } from '../utils/budget';
import { detectLanguageAndDirection } from '../utils/numbers';
import { PARSER_VERSION } from './prompts';

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

  // Dependency-correct stage keys: hash of the (possibly OCR-merged) working lines.
  const linesHash = (await sha256(workingLines.map(l => l.id + ' ' + l.text).join('\n'))).slice(0, 16);
  const visionImgShas = [...new Set(extracted.images.map(img => img.sha).filter(Boolean))].sort();

  // Detect language & direction
  const fullSampleText = workingLines.slice(0, 40).map(l => l.text).join(' ');
  const detected = detectLanguageAndDirection(fullSampleText);
  const langDirection = settings.document.defaultLanguage === 'rtl' ? 'rtl' : settings.document.defaultLanguage === 'ltr' ? 'ltr' : detected.direction;
  const language = detected.language;

  // 3. STAGE: STRUCTURE PASS (1 text call, span references)
  onStageUpdate({
    id: 'structure',
    name: 'Structure Pass',
    status: 'running',
    message: 'Analyzing sections, questions, and span ranges in 1 call...',
  });

  const structRole = settings.roleMapping.fast;
  const structProvider = settings.providers.find(p => p.id === structRole.providerId) || settings.providers[0];
  const structProviderConfig = { ...structProvider, model: structRole.model };

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
    // Never serve a cached structure result with zero questions (or a json:null origin) — treat it as a miss.
    const cachedStructureUsable =
      cachedStructure &&
      Array.isArray((cachedStructure as any).rawQuestions) &&
      (cachedStructure as any).rawQuestions.length > 0 &&
      !(cachedStructure as any).jsonNull;
    if (cachedStructureUsable) {
      structureData = cachedStructure;
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
          journalKey: await sha256(`${fileHash}:${await sha256(JSON.stringify(workingLines))}:${structProviderConfig.id}:${structProviderConfig.model}:${PARSER_VERSION}`),
          onLiveText: (label, channel, fullText) => onLiveText?.('structure', label, channel, fullText),
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

      const costUsd = calculateActualCost(
        structRes.usage.inputTokens,
        structRes.usage.outputTokens,
        structProviderConfig.model,
        settings.costTable
      );

      const usageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'fast',
        provider: structProviderConfig.name,
        model: structProviderConfig.model,
        inputTokens: structRes.usage.inputTokens,
        outputTokens: structRes.usage.outputTokens,
        cachedTokens: structRes.usage.cachedTokens,
        costUsd,
        label: structRes.label || 'Structure Pass',
      };
      usageRecords.push(usageRec);
      appendUsageRecord(usageRec);
      onUsageUpdate?.(usageRec);

    // Never cache a structure result with zero questions or a json:null origin.
    if (structRes.rawQuestions.length > 0 && !structRes.jsonNull) {
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
      message: `${structRes.flags?.some((f: any) => f.code === 'RESUMED_FROM_JOURNAL') ? `Resumed partial parse — ${structRes.rawQuestions.length} questions recovered, continuing at line ${structRes.resumeLine || 1}. ` : ''}Parsed ${structRes.rawQuestions.length} questions across ${structRes.sections.length} sections.`,
    });
  }

  // 4. STAGE: VISION CALL (All images in batched calls, chunked by maxImagesPerVisionCall)
  let updatedImages = extracted.images;
  let visionStageFlags: any[] = [];
  if (extracted.images.length > 0) {
    onStageUpdate({
      id: 'vision',
      name: 'Batched Vision Labeling',
      status: 'running',
      message: `Labeling ${extracted.images.length} image(s) in ${Math.ceil(extracted.images.length / Math.max(1, settings.thrift.maxImagesPerVisionCall))} batched call(s)...`,
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
      updatedImages = cachedVision.updatedImages;
      visionStageFlags = cachedVision.flags || [];
      const cachedUsageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'vision',
        provider: visionProviderConfig.name,
        model: visionProviderConfig.model,
        inputTokens: cachedVision.usage?.inputTokens || 0,
        outputTokens: cachedVision.usage?.outputTokens || 0,
        costUsd: 0,
        label: 'Vision Labeling (Cache Hit)',
        isCachedHit: true,
      };
      usageRecords.push(cachedUsageRec);
      appendUsageRecord(cachedUsageRec, `${examIdForDedupe(fileHash)}:vision:${visionProviderConfig.model}`);
      onUsageUpdate?.(cachedUsageRec);

      onStageUpdate({
        id: 'vision',
        name: 'Batched Vision Labeling',
        status: 'cached',
        message: 'Images labeled from cache (0 calls, $0.00)',
      });
    } else {
      const t0 = Date.now();
      const visionRes = await labelImagesBatched({
        images: extracted.images,
        sourceLines: workingLines,
        providerConfig: visionProviderConfig,
        maxLongEdge: settings.thrift.imageMaxLongEdge,
        quality: settings.thrift.jpegQuality / 100,
        maxImagesPerVisionCall: settings.thrift.maxImagesPerVisionCall,
        maxOutputTokens: settings.budget.maxOutputTokens,
        onLiveText: (label, channel, text) => onLiveText?.('vision', label, channel, text),
      });

      updatedImages = visionRes.updatedImages;
      visionStageFlags = visionRes.flags || [];

      const costUsd = calculateActualCost(
        visionRes.usage.inputTokens,
        visionRes.usage.outputTokens,
        visionProviderConfig.model,
        settings.costTable
      );

      const usageRec: UsageRecord = {
        ts: new Date().toISOString(),
        role: 'vision',
        provider: visionProviderConfig.name,
        model: visionProviderConfig.model,
        inputTokens: visionRes.usage.inputTokens,
        outputTokens: visionRes.usage.outputTokens,
        costUsd,
        label: `Vision Labeling (${extracted.images.length} images)`,
      };
      usageRecords.push(usageRec);
      appendUsageRecord(usageRec);
      onUsageUpdate?.(usageRec);

      await writeStageCache(
        {
          fileHash,
          stage: 'vision',
          provider: visionProviderConfig.id,
          model: visionProviderConfig.model,
          options: { linesHash, imgShas: visionImgShas },
        },
        visionRes
      );

      onStageUpdate({
        id: 'vision',
        name: 'Batched Vision Labeling',
        status: 'completed',
        durationMs: Date.now() - t0,
        inputTokens: visionRes.usage.inputTokens,
        outputTokens: visionRes.usage.outputTokens,
        costUsd,
        message: `Mapped ${extracted.images.length} image(s) to roles & questions.`,
      });
    }
  } else {
    onStageUpdate({
      id: 'vision',
      name: 'Batched Vision Labeling',
      status: 'skipped',
      message: 'No images detected in document (0 calls)',
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
  const assembled = assembleAndValidateQuestions(
    structureData.rawQuestions,
    workingLines,
    totalDeclaredPoints
  );

  let finalQuestions = assembled.questions;
  let allFlags = assembled.flags;

  // Merge visionRes.flags (if vision ran)
  if (visionStageFlags && visionStageFlags.length > 0) {
    allFlags = [...allFlags, ...visionStageFlags];
  }

  // Attach images to questions if labeled
  for (const img of updatedImages) {
    if (img.label && img.label.questionRef) {
      const matchQ = finalQuestions.find(
        q => q.label === img.label?.questionRef || String(q.no) === img.label?.questionRef
      );
      if (matchQ && !matchQ.images.some(i => i.imageId === img.id)) {
        matchQ.images.push({
          imageId: img.id,
          role: img.label.role || 'stem',
          anchorLine: img.anchorLine,
        });
      }
    }
  }

  onStageUpdate({
    id: 'assemble',
    name: 'Assemble & Validate',
    status: 'completed',
    message: `Assembled ${finalQuestions.length} questions. Flags: ${allFlags.length}. Failing: ${assembled.failingQuestions.length}.`,
  });

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
        providerConfig: repairProviderConfig,
        maxOutputTokens: settings.budget.maxOutputTokens,
        onLiveText: (label, channel, text) => onLiveText?.('repair', label, channel, text),
      });

      finalQuestions = repairRes.repairedQuestions;

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
      console.warn('Failed to merge answer key file:', err);
    }
  }

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
  const examDoc: ExamDoc = {
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
    sections: structureData.sections.map((s: any, i: number) => ({
      id: s.id || `sec_${i + 1}`,
      index: s.index || i + 1,
      title: s.title,
      instructions: s.instructions,
      spans: s.spans || [],
    })),
    questions: finalQuestions,
    images: updatedImages,
    source: {
      lines: workingLines,
      pages: extracted.pages,
      ocrUsed,
      fileName: file.name,
      pageImages: extracted.pageImages,
      pageThumbKeys: extracted.pageThumbKeys || [],
    },
    flags: allFlags,
    usage: usageRecords,
  };

  await saveExamDoc(examDoc);
  return examDoc;
}
