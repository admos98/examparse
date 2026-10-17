/**
 * Token, Budget, Cost Estimation, and Usage Tracking
 */
import { CostTable, UsageRecord } from '../types';

let charsPerTokenRunningAvg = 3.2;
let totalCalibrationChars = 0;
let totalCalibrationTokens = 0;

/**
 * Update calibration ratio with actual observed API usage
 */
export function updateTokenCalibration(chars: number, actualTokens: number) {
  if (chars <= 0 || actualTokens <= 0) return;
  totalCalibrationChars += chars;
  totalCalibrationTokens += actualTokens;
  charsPerTokenRunningAvg = totalCalibrationChars / totalCalibrationTokens;
}

/**
 * Estimate input tokens from text length and language
 */
export function estimateTextTokens(text: string, isRtl: boolean = false): number {
  if (!text) return 0;
  // Persian / Arabic tokens tend to be ~2.2 - 2.8 chars per token
  const baseCharsPerToken = isRtl ? Math.min(charsPerTokenRunningAvg, 2.5) : charsPerTokenRunningAvg;
  return Math.ceil(text.length / baseCharsPerToken);
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

export function calculatePreflightEstimate(params: {
  text: string;
  isRtl: boolean;
  images: { width: number; height: number }[];
  scannedPagesCount: number;
  isGemini: boolean;
  model: string;
  costTable: CostTable;
  maxUsdPerRun: number;
}): PreflightEstimate {
  const { text, isRtl, images, scannedPagesCount, isGemini, model, costTable, maxUsdPerRun } = params;

  // 1. Structure text input tokens
  const textTokens = estimateTextTokens(text, isRtl);

  // 2. OCR tokens if scanned pages exist (3 pages per batch)
  const ocrCalls = Math.ceil(scannedPagesCount / 3);
  const ocrTokens = scannedPagesCount * (isGemini ? 258 * 2 * 2 : 500);

  // 3. Vision call tokens (1 batched call for images)
  const visionCalls = images.length > 0 ? 1 : 0;
  let imageTokens = 0;
  for (const img of images) {
    imageTokens += estimateImageTokens(img.width, img.height, isGemini);
  }

  const estimatedInputTokens = textTokens + ocrTokens + imageTokens;
  // Output estimate ≈ 10% of input for structure + small metadata
  const estimatedOutputTokens = Math.max(250, Math.ceil(textTokens * 0.1) + images.length * 20);
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;

  // Cost calculation
  const rate = costTable[model] || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
  const estimatedCostUsd =
    (estimatedInputTokens / 1_000_000) * rate.inputCostPerMillion +
    (estimatedOutputTokens / 1_000_000) * rate.outputCostPerMillion;

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
