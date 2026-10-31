/** Standalone, bank-independent ExamParse ZIP creation and download. */
import JSZip from 'jszip';
import type { ExamDoc, ImageAsset, Question } from '../types';
import { getDisplayName, sanitizeFileName } from '../types';
import { getReviewImageBlob, dataUrlToBlob } from '../store';
import { buildExportDoc } from './examExport';
import { extractInlineDataImages } from './inlineImages';
import type { InterchangeAssetInput } from './examparseFormat';
import { EXAMPARSE_FORMAT_README, validateExamParseInterchange } from './examparseFormat';

export interface StandaloneZipResult {
  zip: Uint8Array;
  filename: string;
  root: string;
  questionCount: number;
  assetCount: number;
  totalAssetBytes: number;
}
interface PixelAsset { sha256: string; path: string; mime: string; bytes: Uint8Array; owners: string[] }

function flatten(questions: Question[]): Question[] { return questions.flatMap(question => [question, ...flatten(question.subQuestions || [])]); }
function signature(bytes: Uint8Array): { mime: string; ext: string } | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return { mime: 'image/png', ext: 'png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii(0, 2) === 'BM') return { mime: 'image/bmp', ext: 'bmp' };
  return undefined;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable; portable assets cannot be exported safely.');
  const hash = await crypto.subtle.digest('SHA-256', bytes as any);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}
async function loadImage(image: ImageAsset): Promise<Blob | undefined> {
  try { if (image.blobKey) { const blob = await getReviewImageBlob(image.blobKey); if (blob) return blob; } } catch { /* retain JSON metadata and mark the file unavailable */ }
  try { if (image.dataUrl?.startsWith('data:')) return dataUrlToBlob(image.dataUrl); } catch { /* corrupt data URI */ }
  return undefined;
}

/**
 * Build the canonical ExamParse interchange and its self-contained asset pool. This path has no
 * dataset, destination contract, provider, credential, or downstream service dependency.
 */
export async function createStandaloneExamParseZip(docInput: ExamDoc): Promise<StandaloneZipResult> {
  const doc = structuredClone(docInput);
  const assets = new Map<string, PixelAsset>();
  const written = new Map<string, InterchangeAssetInput>();
  const storeBytes = async (bytes: Uint8Array, ownerKey: string, metadata?: Pick<InterchangeAssetInput, 'ownerQuestionId' | 'location' | 'optionIndex' | 'offset'>) => {
    const kind = signature(bytes);
    if (!kind) throw new Error(`Unsupported image bytes for ${ownerKey}; pixels remain unavailable in this ZIP.`);
    const hash = await sha256(bytes);
    const path = `assets/${hash}.${kind.ext}`;
    const asset = assets.get(hash) || { sha256: hash, path, mime: kind.mime, bytes, owners: [] };
    if (!asset.owners.includes(ownerKey)) asset.owners.push(ownerKey);
    assets.set(hash, asset);
    written.set(ownerKey, { sha256: hash, path, mime: kind.mime, bytes: bytes.length, ...metadata });
  };

  for (const image of doc.images || []) {
    try {
      const blob = await loadImage(image);
      if (!blob) { image.storageMissing = true; continue; }
      await storeBytes(new Uint8Array(await blob.arrayBuffer()), image.id);
      const stored = written.get(image.id)!;
      image.mime = stored.mime;
      image.sha = stored.sha256;
      delete image.storageMissing;
    } catch { image.storageMissing = true; }
  }

  for (const question of flatten(doc.questions || [])) {
    const stemImages = extractInlineDataImages(question.stem || '').images;
    for (const [index, item] of stemImages.entries()) {
      try { await storeBytes(item.bytes, `${question.id}:inline:${index + 1}`, { ownerQuestionId: question.id, location: 'stem', offset: item.offset }); }
      catch { /* builder emits a durable pending reference */ }
    }
    for (const [optionIndex, option] of (question.options || []).entries()) {
      const images = extractInlineDataImages(option.text || '').images;
      for (const item of images) {
        try {
          const hash = await sha256(item.bytes);
          const ownerKey = `${question.id}:option${optionIndex + 1}:asset:${hash}`;
          await storeBytes(item.bytes, ownerKey, { ownerQuestionId: question.id, location: 'option', optionIndex, offset: item.offset });
        } catch { /* builder emits a durable pending reference */ }
      }
    }
  }

  const canonical = buildExportDoc(doc, written);
  const validation = validateExamParseInterchange(canonical);
  if (!validation.valid) throw new Error(`ExamParse interchange validation failed: ${validation.errors.join('; ')}`);

  const root = `${sanitizeFileName(getDisplayName(doc)) || 'exam'}-examparse`;
  const zip = new JSZip();
  const folder = zip.folder(root)!;
  folder.file('examparse.json', JSON.stringify(canonical, null, 2));
  folder.file('assets/manifest.json', JSON.stringify(canonical.assetManifest, null, 2));
  folder.file('README.md', EXAMPARSE_FORMAT_README);
  for (const asset of assets.values()) folder.file(asset.path, asset.bytes);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const writtenZip = await JSZip.loadAsync(bytes);
  for (const asset of assets.values()) {
    const entry = writtenZip.file(`${root}/${asset.path}`);
    if (!entry || await sha256(await entry.async('uint8array')) !== asset.sha256) throw new Error(`Asset ${asset.sha256} failed post-write verification.`);
  }
  return {
    zip: bytes,
    filename: `${root}.zip`,
    root,
    questionCount: flatten(doc.questions || []).length,
    assetCount: assets.size,
    totalAssetBytes: [...assets.values()].reduce((sum, asset) => sum + asset.bytes.length, 0),
  };
}

export function downloadStandaloneExamParseZip(result: StandaloneZipResult): void {
  const url = URL.createObjectURL(new Blob([result.zip as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a'); link.href = url; link.download = result.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
