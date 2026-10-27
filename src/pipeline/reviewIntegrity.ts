/** Final local integrity seam, shared by fresh parses, reopened drafts and review edits. */
import type { ExamDoc, Flag, ImageAsset } from '../types';
import { getExamHealth } from './quality';

/** Remove superseded snapshots, never historical per-question repair receipts. */
export function reconcileFinalFlags(doc: ExamDoc): ExamDoc {
  const health = getExamHealth(doc);
  const snapshotCodes = new Set([
    'POINTS_MISMATCH',
    'POINTS_DERIVED',
    'POINTS_TOTAL_ASSERTION_FAILED',
    'COVERAGE_MISSING',
    'COVERAGE_DUPLICATE',
    'PARTIAL_COVERAGE',
    'IMAGE_REFS_UNRESOLVED',
  ]);
  const flags = (doc.flags || []).filter(
    flag =>
      !snapshotCodes.has(flag.code) &&
      !(
        !flag.questionId &&
        flag.code !== 'PARTIAL_STORAGE' &&
        flag.code !== 'PAGE_READ_FAILED' &&
        flag.code !== 'GLOBAL_READ_FAILED' &&
        /\d/.test(flag.message) &&
        /(?:total|sum|deficit|count|missing|unresolved|coverage|duplicate numbers)/i.test(flag.message)
      ),
  );
  const add = (code: string, severity: Flag['severity'], message: string, rootCauseId?: string) =>
    flags.push({ id: `flag_final_${code}`, code, severity, message, ...(rootCauseId ? { rootCauseId } : {}) });
  if (health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.01) {
    add('POINTS_MISMATCH', 'warn', `Points total ${health.pointsParsed} does not match ${health.pointsExpected}; please check marks.`);
  } else if (doc.flags.some(flag => flag.code === 'POINTS_DERIVED')) {
    add('POINTS_DERIVED', 'info', `Final points total: ${health.pointsParsed}${health.pointsExpected === undefined ? '' : ` of ${health.pointsExpected}`}.`);
  }
  if (health.missing.length) add('COVERAGE_MISSING', 'warn', `Missing question numbers: ${health.missing.join(', ')}.`);
  if (health.duplicates.length) add('COVERAGE_DUPLICATE', 'warn', `Duplicate question numbers: ${health.duplicates.join(', ')}.`);
  if (health.unresolvedImageRefs.length && doc.storageState !== 'PARTIAL-STORAGE') {
    add('IMAGE_REFS_UNRESOLVED', 'warn', `Unresolved image references: ${health.unresolvedImageRefs.join(', ')}.`, 'storage_failure');
  }
  return { ...doc, flags };
}

/** IDs can change; match only unique evidence, never guess across pages. */
export function repairImageReferences(doc: ExamDoc, previousImages: ImageAsset[] = []): ExamDoc {
  const flags = [...(doc.flags || [])];
  const questions = doc.questions.map(q => ({
    ...q,
    images: (q.images || []).flatMap(ref => {
      if (doc.images.some(image => image.id === ref.imageId)) return [ref];
      const old = previousImages.find(image => image.id === ref.imageId);
      const page = old?.page ?? doc.source.lines.find(line => Number(line.id.replace(/\D/g, '')) === ref.anchorLine)?.page;
      const candidates = doc.images.filter(
        image =>
          (old?.blobKey && image.blobKey === old.blobKey) ||
          (page !== undefined &&
            image.page === page &&
            (ref.anchorLine ?? old?.anchorLine) !== undefined &&
            image.anchorLine === (ref.anchorLine ?? old?.anchorLine)),
      );
      const match = candidates.length === 1 ? candidates[0] : undefined;
      const code = match ? 'IMAGE_REF_REMAPPED' : 'IMAGE_REF_DROPPED';
      if (!flags.some(flag => flag.id === `flag_${code}_${q.id}_${ref.imageId}`)) {
        flags.push({
          id: `flag_${code}_${q.id}_${ref.imageId}`,
          code,
          severity: match ? 'info' : 'warn',
          questionId: q.id,
          rootCauseId: 'storage_failure',
          message: match
            ? `Q${q.no}: image reference restored to ${match.id}.`
            : `Q${q.no}: unavailable image reference ${ref.imageId} was removed; check the source.`,
        });
      }
      return match ? [{ ...ref, imageId: match.id }] : [];
    }),
  }));
  return { ...doc, questions, flags };
}

/**
 * Resolve ALL assets, including unplaced ones. Missing blobs keep dataUrl-free references
 * (`storageMissing: true`) so question references remain recoverable via "Restore from source"
 * instead of silently wiping `doc.images` to `[]`. Assets already accounted for by
 * `PARTIAL-STORAGE` do NOT emit duplicate surprise `IMAGE_ASSET_ABSENT` flags.
 */
export async function prepareReviewDocument(
  doc: ExamDoc,
  load: (key: string) => Promise<Blob | undefined>,
  url: (blob: Blob, image: ImageAsset) => string = (_blob, image) => `/api/images/${encodeURIComponent(image.blobKey)}`,
): Promise<ExamDoc> {
  const flags = [...(doc.flags || [])];
  const partialStorageIds = new Set<string>(doc.failedImageIds || []);
  for (const flag of flags) {
    if (flag.code === 'PARTIAL_STORAGE') {
      for (const img of doc.images || []) {
        if (flag.message.includes(img.id)) partialStorageIds.add(img.id);
      }
    }
  }
  const keepHiddenBlob = (target: ImageAsset, source: ImageAsset): ImageAsset => {
    if ((source as any)._blob instanceof Blob) {
      Object.defineProperty(target, '_blob', { value: (source as any)._blob, enumerable: false, configurable: true, writable: true });
    }
    return target;
  };
  const images = await Promise.all(
    (doc.images || []).map(async image => {
      if ((image.dataUrl?.startsWith('blob:') || image.dataUrl?.startsWith('data:')) && !image.storageMissing) {
        return keepHiddenBlob({ ...image }, image);
      }
      const blob = image.blobKey ? await load(image.blobKey) : undefined;
      if (blob) {
        const { storageMissing: _cleared, ...rest } = image;
        return keepHiddenBlob({ ...rest, dataUrl: url(blob, image) }, image);
      }
      if (!partialStorageIds.has(image.id) && doc.storageState !== 'PARTIAL-STORAGE') {
        const absentId = `flag_IMAGE_ASSET_ABSENT_${image.id}`;
        if (!flags.some(f => f.id === absentId)) {
          flags.push({
            id: absentId,
            code: 'IMAGE_ASSET_ABSENT',
            severity: 'warn',
            rootCauseId: 'storage_failure',
            message: `Image ${image.id} on page ${image.page} is unavailable in storage; restore it from source.`,
          });
        }
      }
      const { dataUrl: _missingUrl, ...rest } = image;
      return keepHiddenBlob({ ...rest, storageMissing: true }, image);
    }),
  );
  return reconcileFinalFlags(repairImageReferences({ ...doc, images, flags }, doc.images));
}

export interface RestoreImageDeps {
  extractPageImages?: (page: number, file: File) => Promise<Array<ImageAsset & { _blob?: Blob }>>;
  saveBlob?: (key: string, blob: Blob) => Promise<void>;
  toUrl?: (key: string, image: ImageAsset) => string;
}

/**
 * Part A — Per-missing-image "Restore from source": re-extracts ONLY `target.page` from the
 * retained raw source file, matches the missing asset on that page, persists its blob, and
 * clears `storageMissing` / `PARTIAL-STORAGE` for that image ID.
 */
export async function restoreMissingImageFromSource(
  doc: ExamDoc,
  imageId: string,
  sourceFile: File,
  deps?: RestoreImageDeps,
): Promise<ExamDoc> {
  const target = (doc.images || []).find(img => img.id === imageId);
  if (!target) throw new Error(`Image ${imageId} does not exist in this exam.`);

  const pageCandidates: Array<ImageAsset & { _blob?: Blob }> = deps?.extractPageImages
    ? await deps.extractPageImages(target.page, sourceFile)
    : ((await (await import('./extract')).extractDocument(sourceFile, {
        onlyPages: [target.page],
        skipPersistence: true,
      })).images as Array<ImageAsset & { _blob?: Blob }>);

  const samePage = pageCandidates.filter(c => c.page === target.page || pageCandidates.length > 0);
  if (samePage.length === 0) {
    throw new Error(`No extractable image found on page ${target.page} of ${sourceFile.name}.`);
  }

  const bboxDist = (a: ImageAsset['bbox'], b: ImageAsset['bbox']) => {
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    return Math.hypot(ax - bx, ay - by);
  };

  const match =
    samePage.find(c => target.sha && c.sha === target.sha) ||
    samePage.find(c => target.blobKey && c.blobKey === target.blobKey) ||
    samePage.find(c => target.dHash && c.dHash && c.dHash === target.dHash) ||
    [...samePage].sort((a, b) => bboxDist(a.bbox, target.bbox) - bboxDist(b.bbox, target.bbox))[0];

  const { dataUrlToBlob, saveImageBlob } = await import('../store');
  let blob: Blob | undefined = (match as any)._blob instanceof Blob ? (match as any)._blob : undefined;
  if (!blob && match.dataUrl?.startsWith('data:')) {
    blob = dataUrlToBlob(match.dataUrl);
  } else if (!blob && match.dataUrl?.startsWith('blob:')) {
    blob = await (await fetch(match.dataUrl)).blob();
  }
  if (!blob) {
    throw new Error(`Extracted image on page ${target.page} had no binary payload to restore.`);
  }

  const key = target.blobKey || match.blobKey || match.sha || target.id;
  if (deps?.saveBlob) await deps.saveBlob(key, blob);
  else await saveImageBlob(key, blob);

  const resolvedUrl = deps?.toUrl ? deps.toUrl(key, target) : `/api/images/${encodeURIComponent(key)}`;
  const images = doc.images.map(img => {
    if (img.id !== imageId) return img;
    const { storageMissing: _cleared, ...rest } = img;
    return {
      ...rest,
      sha: match.sha || img.sha,
      blobKey: key,
      dataUrl: resolvedUrl,
    };
  });

  const remainingFailed = (doc.failedImageIds || []).filter(id => id !== imageId);
  let flags = (doc.flags || []).filter(
    f => f.id !== `flag_IMAGE_ASSET_ABSENT_${imageId}`,
  );
  let storageState: ExamDoc['storageState'] = doc.storageState;
  if (remainingFailed.length === 0) {
    storageState = undefined;
    flags = flags.filter(f => f.code !== 'PARTIAL_STORAGE');
  } else {
    storageState = 'PARTIAL-STORAGE';
    const banner = `PARTIAL-STORAGE: failed to store image blob(s) [${remainingFailed.join(', ')}] in the local data folder. Exam metadata was saved; restore missing images from source in Step 4.`;
    flags = [
      ...flags.filter(f => f.code !== 'PARTIAL_STORAGE'),
      {
        id: `flag_PARTIAL_STORAGE_${doc.id}`,
        code: 'PARTIAL_STORAGE',
        severity: 'warn',
        rootCauseId: 'storage_failure',
        message: banner,
      },
    ];
  }

  const updated: ExamDoc = {
    ...doc,
    images,
    flags,
    ...(storageState ? { storageState, failedImageIds: remainingFailed } : { storageState: undefined, failedImageIds: undefined }),
  };
  if (!storageState) {
    delete updated.storageState;
    delete updated.failedImageIds;
  }
  return reconcileFinalFlags(updated);
}
