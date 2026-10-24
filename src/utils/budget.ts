/**
 * Token, Budget, Cost Estimation, and Usage Tracking
 */
import { CostTable, UsageRecord } from '../types';



/**
 * Per-provider calibration: chars-per-token running average, persisted in the folder cache, clamped 1.0–6.0
 */
interface CalibrationEntry {
  totalChars: number;
  totalTokens: number;
  avg: number;
}

let calibrationMemory: Record<string, CalibrationEntry> = {};
export async function hydrateCalibrationMap(): Promise<void> {
  const res = await fetch('/api/cache/calibration');
  calibrationMemory = res.ok ? await res.json() : {};
}
function loadCalibrationMap(): Record<string, CalibrationEntry> { return calibrationMemory; }
function saveCalibrationMap(map: Record<string, CalibrationEntry>): void {
  calibrationMemory = map;
  void fetch('/api/cache/calibration', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) })
    .catch(() => console.warn('Calibration cache write unavailable; default estimates remain safe.'));
}

/**
 * Get per-provider chars-per-token ratio, default 3.2
 */
export function getCalibration(providerKey: string = 'default'): number {
  const map = loadCalibrationMap();
  return map[providerKey]?.avg || 3.2;
}

/**
 * Update calibration ratio with actual observed API usage (computed from full sent text length: system + user prompt).
 * Persists per provider in the folder cache, clamped 1.0–6.0.
 */
export function updateTokenCalibration(
  fullSentTextLength: number,
  actualTokens: number,
  providerKey: string = 'default'
) {
  if (fullSentTextLength <= 0 || actualTokens <= 0) return;
  const map = loadCalibrationMap();
  const entry = map[providerKey] || { totalChars: 0, totalTokens: 0, avg: 3.2 };
  entry.totalChars += fullSentTextLength;
  entry.totalTokens += actualTokens;
  entry.avg = Math.max(1.0, Math.min(6.0, entry.totalChars / entry.totalTokens));
  map[providerKey] = entry;
  saveCalibrationMap(map);
}

/**
 * Estimate input tokens from text length and language, using per-provider calibration
 */
export function estimateTextTokens(text: string, isRtl: boolean = false, providerKey: string = 'default'): number {
  if (!text) return 0;
  const base = getCalibration(providerKey);
  // Persian / Arabic tokens tend to be ~2.2 - 2.8 chars per token
  const charsPerToken = isRtl ? Math.min(base, 2.5) : base;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate image tokens
 * Gemini: ≈ 258 × ceil(w/768) × ceil(h/768)
 * OpenAI: ≈ flat 400 tokens per image
 */
export function estimateImageTokens(width: number, height: number, isGemini: boolean = true): number {
  if (!isGemini) return 400;
  const tilesX = Math.max(1, Math.ceil(width / 768));
  const tilesY = Math.max(1, Math.ceil(height / 768));
  return 258 * tilesX * tilesY;
}

/**
 * Estimate pre-flight pipeline tokens and cost
 * Prices each stage at its own role model.
 */
export interface PreflightEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
  exceedsBudget: boolean;
  warning50Percent: boolean;
  breakdown: {
    textTokens: number;
    imageTokens: number;
    visionCalls: number;
    ocrCalls: number;
    /** A5 — Stage 2.5 cleanup judgment (0 when disabled/cached). */
    cleanupCalls: number;
    cleanupTokens: number;
    cleanupCostUsd: number;
    textRepairCalls: number;
    textRepairTokens: number;
    textRepairCostUsd: number;
  };
}

export interface PreflightStageModels {
  structureModel?: string;
  ocrModel?: string;
  visionModel?: string;
  repairModel?: string;
  cleanupModel?: string;
  textRepairModel?: string;
}

export function calculatePreflightEstimate(params: {
  text: string;
  isRtl: boolean;
  images: { width: number; height: number }[];
  scannedPagesCount: number;
  isGemini: boolean;
  model: string;
  costTable: CostTable;
  maxUsdPerRun: number;
  stageModels?: PreflightStageModels;
  maxImagesPerVisionCall?: number;
  providerKey?: string;
  /** A5 — pre-computed cleanup call shape from estimateCleanupCall(); omit when cleanup is off or cached. */
  cleanup?: { chunks: number; inputTokens: number; outputTokens: number };
  /** Stage 2.75: at most one repair batch; omitted when disabled or line-hash cache is complete. */
  textRepair?: { calls: number; inputTokens: number; outputTokens: number };
}): PreflightEstimate {
  const {
    text,
    isRtl,
    images,
    scannedPagesCount,
    isGemini,
    model,
    costTable,
    maxUsdPerRun,
    stageModels,
    maxImagesPerVisionCall = 16,
    providerKey = 'default',
    cleanup,
    textRepair,
  } = params;

  // 1. Structure text input tokens (priced at structure model)
  const structureModel = stageModels?.structureModel || model;
  const textTokens = estimateTextTokens(text, isRtl, providerKey);

  // 2. OCR tokens if scanned pages exist (3 pages per batch), priced at OCR model
  const ocrModel = stageModels?.ocrModel || model;
  const ocrCalls = Math.ceil(scannedPagesCount / 3);
  const ocrTokens = scannedPagesCount * (isGemini ? 258 * 2 * 2 : 500);

  // 3. Vision calls: chunk by maxImagesPerVisionCall (minimum chunks)
  const visionModel = stageModels?.visionModel || model;
  const visionCalls = images.length > 0 ? Math.max(1, Math.ceil(images.length / Math.max(1, maxImagesPerVisionCall))) : 0;
  let imageTokens = 0;
  for (const img of images) {
    imageTokens += estimateImageTokens(img.width, img.height, isGemini);
  }

  // Per-stage cost: each stage priced at its own model rate
  const structureRate = costTable[structureModel] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
  const ocrRate = costTable[ocrModel] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
  const visionRate = costTable[visionModel] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };

  // Output estimates per stage
  const structureOutputTokens = Math.max(250, Math.ceil(textTokens * 0.1));
  const ocrOutputTokens = scannedPagesCount * 400;
  const visionOutputTokens = images.length * 20;

  // 4. Cleanup judgment (A5): one small call per ≤400 judged lines, priced at the cleanup role model
  const cleanupModel = stageModels?.cleanupModel || structureModel;
  const cleanupRate = costTable[cleanupModel] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
  const cleanupCalls = cleanup?.chunks || 0;
  const cleanupInput = cleanupCalls ? cleanup!.inputTokens : 0;
  const cleanupOutput = cleanupCalls ? cleanup!.outputTokens : 0;
  const cleanupCost =
    (cleanupInput / 1_000_000) * cleanupRate.inputCostPerMillion +
    (cleanupOutput / 1_000_000) * cleanupRate.outputCostPerMillion;

  const textRepairModel = stageModels?.textRepairModel || cleanupModel;
  const textRepairRate = costTable[textRepairModel] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
  const textRepairCalls = textRepair?.calls || 0;
  const textRepairInput = textRepairCalls ? textRepair!.inputTokens : 0;
  const textRepairOutput = textRepairCalls ? textRepair!.outputTokens : 0;
  const textRepairCost =
    (textRepairInput / 1_000_000) * textRepairRate.inputCostPerMillion +
    (textRepairOutput / 1_000_000) * textRepairRate.outputCostPerMillion;

  const estimatedInputTokens = textTokens + ocrTokens + imageTokens + cleanupInput + textRepairInput;
  const estimatedOutputTokens = structureOutputTokens + ocrOutputTokens + visionOutputTokens + cleanupOutput + textRepairOutput;
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;

  // Cost per stage
  const structureCost =
    (textTokens / 1_000_000) * structureRate.inputCostPerMillion +
    (structureOutputTokens / 1_000_000) * structureRate.outputCostPerMillion;
  const ocrCost =
    (ocrTokens / 1_000_000) * ocrRate.inputCostPerMillion +
    (ocrOutputTokens / 1_000_000) * ocrRate.outputCostPerMillion;
  const visionCost =
    (imageTokens / 1_000_000) * visionRate.inputCostPerMillion +
    (visionOutputTokens / 1_000_000) * visionRate.outputCostPerMillion;

  const estimatedCostUsd = structureCost + ocrCost + visionCost + cleanupCost + textRepairCost;

  const exceedsBudget = maxUsdPerRun > 0 && estimatedCostUsd > maxUsdPerRun;
  const warning50Percent = maxUsdPerRun > 0 && estimatedCostUsd > maxUsdPerRun * 0.5;

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    estimatedCostUsd,
    exceedsBudget,
    warning50Percent,
    breakdown: {
      textTokens,
      imageTokens,
      visionCalls,
      ocrCalls,
      cleanupCalls,
      cleanupTokens: cleanupInput + cleanupOutput,
      cleanupCostUsd: cleanupCost,
      textRepairCalls,
      textRepairTokens: textRepairInput + textRepairOutput,
      textRepairCostUsd: textRepairCost,
    },
  };
}

/**
 * Calculate cost from actual tokens given a model
 */
export function calculateActualCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  costTable: CostTable
): number {
  const rate = costTable[model] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
  return (
    (inputTokens / 1_000_000) * rate.inputCostPerMillion +
    (outputTokens / 1_000_000) * rate.outputCostPerMillion
  );
}

/**
 * Aggregate session usage stats
 */
export interface SessionUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalSavedUsd: number;
  totalCachedTokens: number;
  callCount: number;
  cacheHitCount: number;
}

export function summarizeUsage(records: UsageRecord[], costTable: CostTable): SessionUsageSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalSavedUsd = 0;
  let totalCachedTokens = 0;
  let callCount = 0;
  let cacheHitCount = 0;

  for (const r of records) {
    if (r.isCachedHit) {
      cacheHitCount++;
      const savedTokens = (r.inputTokens || 0) + (r.outputTokens || 0);
      totalCachedTokens += savedTokens;
      const rate = costTable[r.model] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
      totalSavedUsd +=
        ((r.inputTokens || 0) / 1_000_000) * rate.inputCostPerMillion +
        ((r.outputTokens || 0) / 1_000_000) * rate.outputCostPerMillion;
    } else {
      callCount++;
      totalInputTokens += r.inputTokens || 0;
      totalOutputTokens += r.outputTokens || 0;
      totalCostUsd += r.costUsd || 0;
      if (r.cachedTokens) {
        totalCachedTokens += r.cachedTokens;
        const rate = costTable[r.model] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
        totalSavedUsd += (r.cachedTokens / 1_000_000) * rate.inputCostPerMillion;
      }
    }
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd,
    totalSavedUsd,
    totalCachedTokens,
    callCount,
    cacheHitCount,
  };
}
