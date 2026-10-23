/**
 * Stage 4: Batched Vision Labeling Pipeline (§6.4)
 * Chunks images by maxImagesPerVisionCall, each chunk gets its own manifest and call.
 * Sums usage across chunks. optimizeImageForVision fills white before JPEG-encoding.
 */
import { ImageAsset, LLMRequest, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T2_IMAGE_LABELING_SYSTEM } from './prompts';
import { getImageBlob } from '../store';
import { Question } from '../types';
import { spanLineNumbers, spanStartLine } from './spans';

/** Fallback kind: 'photo' for raster crops unless vector/diagram-detected; never blanket 'diagram'. */
export function fallbackImageKind(img: Partial<ImageAsset> & { vectorDetected?: boolean; diagramDetected?: boolean }): 'photo' | 'diagram' {
  if (img.vectorDetected === true || img.diagramDetected === true || /svg/i.test(img.mime || '')) {
    return 'diagram';
  }
  return 'photo';
}

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
 * Exported for testing G4.
 */
export async function processVisionChunk(
  chunkImages: { img: ImageAsset; base64: string; mime: string }[],
  sourceLines: SourceLine[],
  providerConfig: any,
  questionHints: Record<string, { questionRef: string; group: string; page: number }>,
  maxOutputTokens?: number,
  onLiveText?: (label: string, channel: 'output' | 'reasoning' | 'info', text: string) => void,
  candidatesByImage?: Record<string, Array<{ref:string, stem:string}>>,
  pageThumbnails?: Record<number, string>,
): Promise<{
  labelMap: Map<string, any>;
  flags: any[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}> {
  const payloadImages: { id: string; mime: string; data: string }[] = [];
  const manifestEntries: string[] = [];

  for (const { img, base64, mime } of chunkImages) {
    payloadImages.push({ id: img.id, mime, data: base64 });

    // Extract <=6 source lines around anchor (legacy fallback if no candidates)
    const anchorIdx = img.anchorLine
      ? Math.max(0, img.anchorLine - 1)
      : sourceLines.findIndex(l => l.page === img.page);

    const startIdx = Math.max(0, anchorIdx - 2);
    const endIdx = Math.min(sourceLines.length, anchorIdx + 4);
    const contextLines = sourceLines
      .slice(startIdx, endIdx)
      .map(l => l.text.replace(/^\[L\d+\]\s*/, ''))
      .join('\n');
    const hint = questionHints[img.id];
    const hintText = hint ? `Geometric ground-truth hint: printed inside Q${hint.group}, page ${hint.page}; confirm or reassign with reason.` : 'No deterministic question anchor; do not invent a question pairing.';
    // D1: candidate-only manifest when provided
    const candidates = candidatesByImage?.[img.id];
    const candidateText = candidates && candidates.length
      ? `Candidates (choose ONLY from these or decoration): ${candidates.map(c=> `${c.ref}="${c.stem.slice(0,120)}"`).join(' | ')}`
      : hintText;
    const thumbInfo = pageThumbnails?.[img.page] ? ` Page thumbnail with numbered bounding-box overlays provided as separate image.` : '';

    manifestEntries.push(
      `Image ${img.id}: page ${img.page}, near line ${img.anchorLine || 'unknown'}\n${candidateText}\nContext:\n${contextLines}${thumbInfo}`
    );
  }

  const promptText = `IMAGES ARE ATTACHED IN MANIFEST ORDER.\n\nMANIFEST:\n${manifestEntries.join('\n---\n')}\n\nReturn JSON: {"items": [{"id": string, "role": "stem|option|table|decoration", "questionRef": string|null, "kind": "photo|diagram|chart|table|formula|handwriting|decoration", "caption": "at most 6 words", "reason": "required for decoration/reassignment", "needsText": boolean}]} (or a JSON array).`;

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

  const response = await LLMAdapter.execute(request, { onDelta: (channel, full) => onLiveText?.(request.label, channel, full), onInfo: note => onLiveText?.(request.label, 'info', note) });

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
  questionHints?: Record<string, { questionRef: string; group: string; page: number }>;
  questions?: Question[];
  onLiveText?: (label: string, channel: 'output' | 'reasoning' | 'info', text: string) => void;
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
    } catch {
      console.warn(`Vision: skipping optimization for image ${img.id}; diagnostic details were omitted.`);
    }
  }

  if (prepared.length === 0) {
    const fallbackImages = images.map(img => {
      const rawHint = params.questionHints?.[img.id];
      if (rawHint && rawHint.page === img.page) {
        return {
          ...img,
          label: {
            role: 'stem' as const,
            questionRef: rawHint.questionRef,
            kind: fallbackImageKind(img),
            caption: undefined,
            reason: 'Same-page geometry fallback',
            source: 'geometry',
          } as any,
        };
      }
      const { label: _unplaced, ...cleanImg } = img as ImageAsset;
      return cleanImg as ImageAsset;
    });
    return {
      updatedImages: fallbackImages,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  // Chunk by maxImagesPerVisionCall (minimum chunks)
  const chunkSize = Math.max(1, maxImagesPerVisionCall);
  const chunks: typeof prepared[] = [];
  for (let i = 0; i < prepared.length; i += chunkSize) {
    chunks.push(prepared.slice(i, i + chunkSize));
  }

  // D1: build candidate sets per image (≤4) from geometric hints + question stems (truncated 120)
  const candidatesByImage: Record<string, Array<{ref:string, stem:string}>> = {};
  if (params.questionHints) {
    // params may carry questions for stem slicing; we use hints as base and add nearby questions if available
    for (const img of prepared.map(p=>p.img)) {
      const hint = params.questionHints?.[(img as any).id];
      // Use hint's group as primary candidate, plus up to 3 neighbors by page/line proximity if questions provided
      const candidates: Array<{ref:string, stem:string}> = [];
      if (hint) candidates.push({ ref: hint.questionRef, stem: (hint as any).stem?.slice(0,120) || '' });
      // If caller supplied questionsWithStems, add more
      const extra = (params as any).questions as Question[] | undefined;
      if (extra && candidates.length < 4) {
        const page = img.page;
        // nearest questions by anchor line distance
        const byDist = [...extra].sort((a,b)=>{
          const aStart = a.spans?.[0] ? spanStartLine(a.spans[0]) : undefined;
          const bStart = b.spans?.[0] ? spanStartLine(b.spans[0]) : undefined;
          const da = aStart ? Math.abs(aStart - (img.anchorLine||0)) : 9999;
          const db = bStart ? Math.abs(bStart - (img.anchorLine||0)) : 9999;
          return da - db;
        }).filter(q=> !candidates.some(c=>c.ref===q.label));
        for (const q of byDist.slice(0, 4 - candidates.length)) {
          if (q.sectionId && extra.find(p=>p.id===q.parentId)) continue; // prefer roots
          candidates.push({ ref: q.label || String(q.no), stem: (q.stem||'').slice(0,120) });
        }
      }
      if (candidates.length) candidatesByImage[(img as any).id] = candidates.slice(0,4);
    }
  }

  // Process each chunk
  const mergedLabelMap = new Map<string, any>();
  const allFlags: any[] = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  for (const chunk of chunks) {
    const result = await processVisionChunk(chunk, sourceLines, providerConfig, params.questionHints || {}, maxOutputTokens, params.onLiveText, candidatesByImage);
    for (const [id, label] of result.labelMap) {
      mergedLabelMap.set(id, label);
    }
    allFlags.push(...result.flags);
    totalUsage.inputTokens += result.usage.inputTokens;
    totalUsage.outputTokens += result.usage.outputTokens;
    totalUsage.cachedTokens += result.usage.cachedTokens || 0;
  }

  // D1: candidate-only rejection (VISION_REF_REJECTED)
  const hasShapeMismatch = allFlags.some(f=>f.code==='VISION_SHAPE_MISMATCH');
  if (hasShapeMismatch) {
    // D2: unparsed = conservative: geometry only, discard captions from model
    for (const img of images) {
      const hint = params.questionHints?.[img.duplicateOf || img.id] || params.questionHints?.[img.id];
      if (hint && !img.label) {
        // will be applied below as geometry fallback
      }
    }
    allFlags.push({ id: 'flag_vision_conservative', severity: 'info', code: 'VISION_CONSERVATIVE_GEOMETRY', message: 'Vision unparseable: refs from geometry only (captions discarded).' });
  }

  // Apply labels to images & propagate to duplicates, with candidate validation & strict ±0 same-page geometry sanity
  const linePageByNo = new Map(sourceLines.map(l => [Number(String(l.id).replace(/\D/g, '')), l.page]));
  const questionPagesByRef = new Map<string, Set<number>>();
  for (const q of ((params as any).questions || []) as Question[]) {
    const pages = new Set<number>();
    for (const ln of spanLineNumbers(q.spans)) {
      const p = linePageByNo.get(ln);
      if (p !== undefined) pages.add(p);
    }
    if (pages.size) {
      questionPagesByRef.set(String(q.no), pages);
      if (q.label) questionPagesByRef.set(String(q.label), pages);
      if (q.id) questionPagesByRef.set(String(q.id), pages);
    }
  }
  const samePageGeometryHint = (img: ImageAsset) => {
    const rawHint = params.questionHints?.[img.id];
    if (!rawHint || rawHint.page !== img.page) return undefined;
    const knownPages = questionPagesByRef.get(String(rawHint.questionRef));
    if (knownPages && !knownPages.has(img.page)) return undefined;
    return rawHint;
  };

  const updatedImages = images.map(img => {
    const targetId = img.duplicateOf || img.id;
    let label = mergedLabelMap.get(targetId);
    // D2: if shape mismatch, ignore model labels entirely (geometry only)
    if (hasShapeMismatch) label = undefined;
    const hint = samePageGeometryHint(img);
    const candidates = candidatesByImage[targetId] || candidatesByImage[img.id];
    const candidateRefs = new Set((candidates||[]).map(c=>String(c.ref)));
    if (label && label.questionRef && candidateRefs.size > 0) {
      const refStr = String(label.questionRef);
      const isDecoration = label.role === 'decoration';
      if (!isDecoration && !candidateRefs.has(refStr)) {
        allFlags.push({ id: `flag_vision_ref_rejected_${img.id}`, severity: 'warn', code: 'VISION_REF_REJECTED', message: `${img.id} model ref ${refStr} outside candidates [${[...candidateRefs].join(',')}]; geometry applies.` });
        const samePageFallbackRef = hint?.questionRef || (candidates || []).find(c => {
          const pages = questionPagesByRef.get(String(c.ref));
          return pages ? pages.has(img.page) : false;
        })?.ref;
        if (samePageFallbackRef) {
          label = { ...label, questionRef: samePageFallbackRef, kind: label.kind || fallbackImageKind(img), reason: label.reason || 'Rejected out-of-candidate ref; same-page geometry fallback.' };
        } else {
          // Cross-page without valid vision ref → leave unplaced (no forced ref)
          label = undefined;
        }
      }
    }
    if (label) {
      const role = label.role || 'stem';
      const reassigned = Boolean(hint && label.questionRef && String(label.questionRef) !== hint.questionRef);
      if (reassigned && !String(label.reason || '').trim()) allFlags.push({ id: `flag_vision_reassign_${img.id}`, severity: 'warn', code: 'VISION_REASSIGNMENT_UNJUSTIFIED', message: `${img.id} was reassigned from geometric hint Q${hint!.questionRef} without a reason.` });
      const kind = label.kind || fallbackImageKind(img);
      const caption = String(label.caption || '').trim().split(/\s+/).slice(0, 6).join(' ');
      const decorationCaption = role === 'decoration' || kind === 'decoration' ? (caption || 'Decoration; model supplied no caption') : caption;
      if ((role === 'decoration' || kind === 'decoration') && !caption && !hasShapeMismatch) allFlags.push({ id: `flag_vision_decoration_${img.id}`, severity: 'warn', code: 'DECORATION_UNJUSTIFIED', message: `${img.id} was marked decoration without a caption.` });
      return {
        ...img,
        label: {
          role,
          questionRef: label.questionRef || hint?.questionRef || undefined,
          kind,
          caption: hasShapeMismatch ? undefined : decorationCaption || undefined,
          reason: String(label.reason || '').trim() || undefined,
          needsText: Boolean(label.needsText),
          source: hasShapeMismatch ? 'geometry' : undefined,
        } as any,
      };
    }
    // No model label: conservative same-page (±0) geometry fallback only; unassignable → unplaced tray
    if (hint) {
      return {
        ...img,
        label: {
          role: 'stem',
          questionRef: hint.questionRef,
          kind: fallbackImageKind(img),
          caption: undefined,
          reason: hasShapeMismatch ? 'Geometry fallback (unparsed vision)' : 'Same-page geometry fallback',
          source: 'geometry',
        } as any,
      };
    }
    // Unassignable by geometry and unconfirmed by vision → strip any pre-seeded ref so it lands in unplaced tray
    const { label: _unplaced, ...cleanImg } = img as ImageAsset;
    return cleanImg as ImageAsset;
  });

  return {
    updatedImages,
    usage: totalUsage,
    flags: allFlags,
  };
}
