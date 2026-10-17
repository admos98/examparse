/**
 * Stage 4: Batched Vision Labeling Pipeline (§6.4)
 * Chunks images by maxImagesPerVisionCall, each chunk gets its own manifest and call.
 * Sums usage across chunks. optimizeImageForVision fills white before JPEG-encoding.
 */
import { ImageAsset, LLMRequest, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T2_IMAGE_LABELING_SYSTEM } from './prompts';
import { getImageBlob } from '../store';

/**
 * Convert a Blob to base64 string without data prefix
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale and compress image if needed (max long edge, JPEG q80)
 * Fills white background before JPEG-encoding to avoid transparent→black artifacts.
 * Rejects on img.onerror.
 */
async function optimizeImageForVision(
  blob: Blob,
  maxLongEdge: number = 1024,
  quality: number = 0.8
): Promise<{ base64: string; mime: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxLongEdge || height > maxLongEdge) {
        if (width > height) {
          height = Math.round((height * maxLongEdge) / width);
          width = maxLongEdge;
        } else {
          width = Math.round((width * maxLongEdge) / height);
          height = maxLongEdge;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Fill white background before drawing (avoids transparent→black in JPEG)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const base64 = dataUrl.split(',')[1] || '';
        resolve({ base64, mime: 'image/jpeg', width, height });
      } else {
        blobToBase64(blob).then(base64 => resolve({ base64, mime: blob.type || 'image/jpeg', width: img.width, height: img.height }));
      }
    };
    img.onerror = (e) => {
      reject(new Error(`optimizeImageForVision: img.onerror fired for blob (size=${blob.size}, type=${blob.type})`));
    };
    img.src = URL.createObjectURL(blob);
  });
}

export interface VisionLabelResult {
  updatedImages: ImageAsset[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  flags?: any[];
}

/**
 * Process a single chunk of images through the vision model
 */
async function processVisionChunk(
  chunkImages: { img: ImageAsset; base64: string; mime: string }[],
  sourceLines: SourceLine[],
  providerConfig: any,
  maxOutputTokens?: number,
): Promise<{
  labelMap: Map<string, any>;
  flags: any[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}> {
  const payloadImages: { id: string; mime: string; data: string }[] = [];
  const manifestEntries: string[] = [];

  for (const { img, base64, mime } of chunkImages) {
    payloadImages.push({ id: img.id, mime, data: base64 });

    // Extract <= 6 source lines around anchor
    const anchorIdx = img.anchorLine
      ? Math.max(0, img.anchorLine - 1)
      : sourceLines.findIndex(l => l.page === img.page);

    const startIdx = Math.max(0, anchorIdx - 2);
    const endIdx = Math.min(sourceLines.length, anchorIdx + 4);
    const contextLines = sourceLines
      .slice(startIdx, endIdx)
      .map(l => `${l.id}: ${l.text}`)
      .join('\n');

    manifestEntries.push(
      `Image ${img.id}: page ${img.page}, near line ${img.anchorLine || 'unknown'}\nContext:\n${contextLines}`
    );
  }

  const promptText = `IMAGES ARE ATTACHED IN MANIFEST ORDER.\n\nMANIFEST:\n${manifestEntries.join('\n---\n')}\n\nReturn JSON: {"items": [{"id": string, "role": "stem|option|table|decoration", "questionRef": string|null, "kind": "photo|diagram|chart|table|formula|handwriting|decoration", "caption": string, "needsText": boolean}]} (or a JSON array).`;

  const request: LLMRequest = {
    role: 'vision',
    system: T2_IMAGE_LABELING_SYSTEM,
    text: promptText,
    images: payloadImages,
    maxOutputTokens: maxOutputTokens
      ? Math.min(maxOutputTokens, Math.max(500, payloadImages.length * 120))
      : Math.max(500, payloadImages.length * 120),
    label: `Vision Labeling (${payloadImages.length} images)`,
    providerConfig,
  };

  const response = await LLMAdapter.execute(request);

  // Parse envelope or bare array (accept labels/data/annotations keys, or a single {id, ...} object)
  let rawItems: any[] | null = null;
  if (Array.isArray(response.json)) {
    rawItems = response.json;
  } else if (response.json && typeof response.json === 'object') {
    const obj = response.json as any;
    if (Array.isArray(obj.items)) rawItems = obj.items;
    else if (Array.isArray(obj.images)) rawItems = obj.images;
    else if (Array.isArray(obj.answers)) rawItems = obj.answers;
    else if (Array.isArray(obj.results)) rawItems = obj.results;
    else if (Array.isArray(obj.labels)) rawItems = obj.labels;
    else if (Array.isArray(obj.data)) rawItems = obj.data;
    else if (Array.isArray(obj.annotations)) rawItems = obj.annotations;
    else if (typeof obj.id === 'string' && obj.id) rawItems = [obj];
  }

  const flags: { id: string; severity: 'info' | 'warn' | 'error'; code: string; message: string }[] = [];
  if (!rawItems) {
    flags.push({
      id: `flag_vis_mismatch`,
      severity: 'warn',
      code: 'VISION_SHAPE_MISMATCH',
      message: `Vision response returned unexpected format instead of {"items": [...]}. Images assigned default roles. Raw: ${(response.rawText || '').slice(0, 200)}`,
    });
    rawItems = [];
  }

  const labelMap = new Map<string, any>();
  for (const item of rawItems) {
    if (item && item.id) {
      labelMap.set(item.id, item);
    }
  }

  return { labelMap, flags, usage: response.usage };
}

export async function labelImagesBatched(params: {
  images: ImageAsset[];
  sourceLines: SourceLine[];
  providerConfig: any;
  maxLongEdge?: number;
  quality?: number;
  maxImagesPerVisionCall?: number;
  maxOutputTokens?: number;
}): Promise<VisionLabelResult> {
  const {
    images,
    sourceLines,
    providerConfig,
    maxLongEdge = 1024,
    quality = 0.8,
    maxImagesPerVisionCall = 16,
    maxOutputTokens,
  } = params;

  if (images.length === 0) {
    return {
      updatedImages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  // Filter out duplicates (we map duplicate labels locally)
  const uniqueImages = images.filter(img => !img.duplicateOf);

  // Prepare optimized image payloads
  const prepared: { img: ImageAsset; base64: string; mime: string }[] = [];
  for (const img of uniqueImages) {
    const blob = await getImageBlob(img.blobKey);
    if (!blob) continue;
    try {
      const optimized = await optimizeImageForVision(blob, maxLongEdge, quality);
      prepared.push({ img, base64: optimized.base64, mime: optimized.mime });
    } catch (err) {
      console.warn(`Vision: skipping image ${img.id} due to optimization error:`, err);
    }
  }

  if (prepared.length === 0) {
    return {
      updatedImages: images,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  // Chunk by maxImagesPerVisionCall (minimum chunks)
  const chunkSize = Math.max(1, maxImagesPerVisionCall);
  const chunks: typeof prepared[] = [];
  for (let i = 0; i < prepared.length; i += chunkSize) {
    chunks.push(prepared.slice(i, i + chunkSize));
  }

  // Process each chunk
  const mergedLabelMap = new Map<string, any>();
  const allFlags: any[] = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  for (const chunk of chunks) {
    const result = await processVisionChunk(chunk, sourceLines, providerConfig, maxOutputTokens);
    for (const [id, label] of result.labelMap) {
      mergedLabelMap.set(id, label);
    }
    allFlags.push(...result.flags);
    totalUsage.inputTokens += result.usage.inputTokens;
    totalUsage.outputTokens += result.usage.outputTokens;
    totalUsage.cachedTokens += result.usage.cachedTokens || 0;
  }

  // Apply labels to images & propagate to duplicates
  const updatedImages = images.map(img => {
    const targetId = img.duplicateOf || img.id;
    const label = mergedLabelMap.get(targetId);
    if (label) {
      return {
        ...img,
        label: {
          role: label.role || 'stem',
          questionRef: label.questionRef || undefined,
          kind: label.kind || 'diagram',
          caption: label.caption || undefined,
          needsText: Boolean(label.needsText),
        },
      };
    }
    return img;
  });

  return {
    updatedImages,
    usage: totalUsage,
    flags: allFlags,
  };
}
