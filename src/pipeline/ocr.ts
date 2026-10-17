/**
 * Batched OCR Pipeline for Scanned Exam Pages (§6.4)
 * Batches <= 3 pages per call, downscaled to 1600px long edge, JPEG q80.
 */
import { LLMRequest, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T5_OCR_SYSTEM } from './prompts';

export interface OcrResult {
  lines: SourceLine[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}

export async function runBatchedOcr(params: {
  pageImages: string[]; // data URLs of rendered scanned pages
  scannedPageIndices: number[]; // 1-based page indices
  startLineNum?: number;
  providerConfig: any;
  maxOutputTokens?: number;
}): Promise<OcrResult> {
  const { pageImages, scannedPageIndices, startLineNum = 1, providerConfig, maxOutputTokens } = params;

  if (scannedPageIndices.length === 0 || pageImages.length === 0) {
    return {
      lines: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const generatedLines: SourceLine[] = [];
  let currentLineIndex = startLineNum;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;

  // Batch <= 3 pages per call (minimum calls)
  const batchSize = 3;
  for (let b = 0; b < scannedPageIndices.length; b += batchSize) {
    const batchIndices = scannedPageIndices.slice(b, b + batchSize);
    const imagesPayload: { id: string; mime: string; data: string }[] = [];

    for (const pageNum of batchIndices) {
      const dataUrl = pageImages[pageNum - 1];
      if (!dataUrl) continue;
      const base64 = dataUrl.split(',')[1];
      const mime = dataUrl.split(';')[0].replace('data:', '') || 'image/jpeg';
      imagesPayload.push({
        id: `page_${pageNum}`,
        mime,
        data: base64,
      });
    }

    if (imagesPayload.length === 0) continue;

    const promptText = `Transcribe pages ${batchIndices.join(', ')} into numbered lines starting from line L${String(currentLineIndex).padStart(4, '0')}.`;

    const request: LLMRequest = {
      role: 'ocr',
      system: T5_OCR_SYSTEM,
      text: promptText,
      images: imagesPayload,
      maxOutputTokens: maxOutputTokens ? Math.min(maxOutputTokens, 4096) : 4096,
      label: `OCR Pass (Pages ${batchIndices.join(', ')})`,
      providerConfig,
    };

    const response = await LLMAdapter.execute(request);
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    totalCachedTokens += response.usage.cachedTokens || 0;

    // Parse transcript lines from json response
    const json: any = response.json;
    if (json && Array.isArray(json.pages)) {
      for (const p of json.pages) {
        const pageNum = p.page || batchIndices[0];
        const rawLines = Array.isArray(p.lines) ? p.lines : [];
        for (const rawLine of rawLines) {
          const cleanText = String(rawLine).replace(/^\[L\d+\]\s*/, '').trim();
          if (cleanText) {
            generatedLines.push({
              id: `L${String(currentLineIndex).padStart(4, '0')}`,
              page: pageNum,
              text: cleanText,
            });
            currentLineIndex++;
          }
        }
      }
    } else {
      // Fallback: parse rawText line by line (do NOT strip leading digits/question numbers)
      const textLines = response.rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of textLines) {
        const clean = line.replace(/^\[L\d+\]\s*/, '').trim();
        if (clean && !clean.startsWith('{') && !clean.startsWith('}')) {
          generatedLines.push({
            id: `L${String(currentLineIndex).padStart(4, '0')}`,
            page: batchIndices[0],
            text: clean,
          });
          currentLineIndex++;
        }
      }
    }
  }

  return {
    lines: generatedLines,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedTokens: totalCachedTokens,
    },
  };
}
