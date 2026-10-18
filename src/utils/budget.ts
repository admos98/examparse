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
  };
}

export interface PreflightStageModels {
  structureModel?: string;
  ocrModel?: string;
  visionModel?: string;
  repairModel?: string;
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

  const estimatedInputTokens = textTokens + ocrTokens + imageTokens;
  const estimatedOutputTokens = structureOutputTokens + ocrOutputTokens + visionOutputTokens;
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

  const estimatedCostUsd = structureCost + ocrCost + visionCost;

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
