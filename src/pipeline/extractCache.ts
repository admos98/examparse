/**
 * Extraction cache (B5): ExtractedDocument cached under
 * extract:{fileHash}:{PARSER_VERSION} — lines, image metas, scannedPageIndices,
 * pages; page renders live as thumb blobs (see store.savePageThumbBlobs).
 */
import { ExtractedDocument, extractDocument } from './extract';
import { PARSER_VERSION } from './prompts';
import { getPipelineCache, setPipelineCache, savePageThumbBlobs, getImageBlob, getReviewImageBlob, saveSourceFile } from '../store';
import { sha256 } from '../utils/hash';

/** Bumped whenever PDF text-run assembly changes, independently of structure prompt versioning. */
export const EXTRACTION_VERSION = 'extract-v4-relative-gap-bidi-lite';

export function extractionCacheKey(fileHash: string): string {
  return `extract:${fileHash}:${EXTRACTION_VERSION}:${PARSER_VERSION}`;
}

interface CachedExtraction {
  diagnostics?: ExtractedDocument['diagnostics'];
  lines: ExtractedDocument['lines'];
  images: ExtractedDocument['images'];
  scannedPageIndices: number[];
  pages: number;
  ocrUsed: boolean;
  fileName: string;
  pageThumbKeys: string[];
}

async function resolveThumbUrls(pageThumbKeys: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const k of pageThumbKeys) {
    const blob = await getImageBlob(k);
    urls.push(blob ? URL.createObjectURL(blob) : '');
  }
  return urls;
}

/**
 * Extract a file, or serve the cached extraction for the same fileHash.
 * On a miss, page renders are persisted as thumb blobs before caching.
 */
export async function getOrExtractDocument(
  file: File,
  opts?: { fileHash?: string; useCache?: boolean }
): Promise<{ extracted: ExtractedDocument; fileHash: string; fromCache: boolean }> {
  const fileHash = opts?.fileHash || (await sha256(await file.arrayBuffer()));
  const useCache = opts?.useCache !== false;
  void saveSourceFile(fileHash, file, file.name);

  if (useCache) {
    const cached = await getPipelineCache<CachedExtraction>(extractionCacheKey(fileHash));
    if (cached && Array.isArray(cached.lines)) {
      const cachedImages = cached.images || [];
      let allBlobsPresent = true;
      for (const img of cachedImages) {
        if (!img.blobKey) {
          allBlobsPresent = false;
          break;
        }
        const blob = await getReviewImageBlob(img.blobKey).catch(() => undefined);
        if (!blob) {
          allBlobsPresent = false;
          break;
        }
      }
      if (allBlobsPresent) {
        const pageThumbKeys = cached.pageThumbKeys || [];
        return {
          extracted: {
            diagnostics: cached.diagnostics,
            lines: cached.lines,
            images: cachedImages.map(img => ({
              ...img,
              dataUrl: `/api/images/${encodeURIComponent(img.blobKey)}`,
            })),
            scannedPageIndices: cached.scannedPageIndices || [],
            pages: cached.pages,
            ocrUsed: cached.ocrUsed,
            fileName: cached.fileName || file.name,
            pageImages: pageThumbKeys.length > 0 ? await resolveThumbUrls(pageThumbKeys) : [],
            pageThumbKeys,
          },
          fileHash,
          fromCache: true,
        };
      }
    }
  }

  const extracted = await extractDocument(file);
  let pageThumbKeys = extracted.pageThumbKeys || [];
  if (extracted.pageImages && extracted.pageImages.length > 0) {
    pageThumbKeys = await savePageThumbBlobs(fileHash, extracted.pageImages);
  }
  const withThumbs: ExtractedDocument = { ...extracted, pageThumbKeys };

  if (useCache) {
    const payload: CachedExtraction = {
      diagnostics: withThumbs.diagnostics,
      lines: withThumbs.lines,
      // Image metas only (drop transient object URLs)
      images: (withThumbs.images || []).map(img => {
        const { dataUrl, ...rest } = img as any;
        return rest;
      }),
      scannedPageIndices: withThumbs.scannedPageIndices || [],
      pages: withThumbs.pages,
      ocrUsed: withThumbs.ocrUsed,
      fileName: withThumbs.fileName || file.name,
      pageThumbKeys,
    };
    await setPipelineCache(extractionCacheKey(fileHash), payload);
  }

  return { extracted: withThumbs, fileHash, fromCache: false };
}
