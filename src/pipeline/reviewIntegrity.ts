/** Final local integrity seam, shared by fresh parses, reopened drafts and review edits. */
import type { ExamDoc, Flag, ImageAsset } from '../types';
import { getExamHealth } from './quality';

/** Remove superseded snapshots, never historical per-question repair receipts. */
export function reconcileFinalFlags(doc: ExamDoc): ExamDoc {
  const health = getExamHealth(doc);
  const snapshotCodes = new Set(['POINTS_MISMATCH', 'POINTS_DERIVED', 'POINTS_TOTAL_ASSERTION_FAILED', 'COVERAGE_MISSING', 'COVERAGE_DUPLICATE', 'PARTIAL_COVERAGE', 'IMAGE_REFS_UNRESOLVED']);
  const flags = (doc.flags || []).filter(flag => !snapshotCodes.has(flag.code) && !(!flag.questionId && /\d/.test(flag.message) && /(?:total|sum|deficit|count|missing|unresolved|coverage|duplicate numbers)/i.test(flag.message)));
  const add = (code: string, severity: Flag['severity'], message: string) => flags.push({ id: `flag_final_${code}`, code, severity, message });
  if (health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.01) add('POINTS_MISMATCH', 'warn', `Points total ${health.pointsParsed} does not match ${health.pointsExpected}; please check marks.`);
  else if (doc.flags.some(flag => flag.code === 'POINTS_DERIVED')) add('POINTS_DERIVED', 'info', `Final points total: ${health.pointsParsed}${health.pointsExpected === undefined ? '' : ` of ${health.pointsExpected}`}.`);
  if (health.missing.length) add('COVERAGE_MISSING', 'warn', `Missing question numbers: ${health.missing.join(', ')}.`);
  if (health.duplicates.length) add('COVERAGE_DUPLICATE', 'warn', `Duplicate question numbers: ${health.duplicates.join(', ')}.`);
  if (health.unresolvedImageRefs.length) add('IMAGE_REFS_UNRESOLVED', 'warn', `Unresolved image references: ${health.unresolvedImageRefs.join(', ')}.`);
  return { ...doc, flags };
}

/** IDs can change; match only unique evidence, never guess across pages. */
export function repairImageReferences(doc: ExamDoc, previousImages: ImageAsset[] = []): ExamDoc {
  const flags = [...(doc.flags || [])];
  const questions = doc.questions.map(q => ({ ...q, images: (q.images || []).flatMap(ref => {
    if (doc.images.some(image => image.id === ref.imageId)) return [ref];
    const old = previousImages.find(image => image.id === ref.imageId);
    const page = old?.page ?? doc.source.lines.find(line => Number(line.id.replace(/\D/g, '')) === ref.anchorLine)?.page;
    const candidates = doc.images.filter(image => (old?.blobKey && image.blobKey === old.blobKey) ||
      (page !== undefined && image.page === page && (ref.anchorLine ?? old?.anchorLine) !== undefined && image.anchorLine === (ref.anchorLine ?? old?.anchorLine)));
    const match = candidates.length === 1 ? candidates[0] : undefined;
    const code = match ? 'IMAGE_REF_REMAPPED' : 'IMAGE_REF_DROPPED';
    if (!flags.some(flag => flag.id === `flag_${code}_${q.id}_${ref.imageId}`)) flags.push({ id: `flag_${code}_${q.id}_${ref.imageId}`, code, severity: match ? 'info' : 'warn', questionId: q.id,
      message: match ? `Q${q.no}: image reference restored to ${match.id}.` : `Q${q.no}: unavailable image reference ${ref.imageId} was removed; check the source.` });
    return match ? [{ ...ref, imageId: match.id }] : [];
  }) }));
  return { ...doc, questions, flags };
}

/** Resolve ALL assets, including unplaced ones. Missing bytes are absent, not phantom cards.
 * The injected loader is the component's test seam; verified folder URLs outlive review.
 */
export async function prepareReviewDocument(doc: ExamDoc, load: (key: string) => Promise<Blob | undefined>, url: (blob: Blob, image: ImageAsset) => string = (_blob, image) => `/api/images/${encodeURIComponent(image.blobKey)}`): Promise<ExamDoc> {
  const flags = [...(doc.flags || [])];
  const resolved = await Promise.all(doc.images.map(async image => {
    if (image.dataUrl?.startsWith('blob:') || image.dataUrl?.startsWith('data:')) return image;
    const blob = image.blobKey ? await load(image.blobKey) : undefined;
    if (blob) return { ...image, dataUrl: url(blob, image) };
    flags.push({ id: `flag_IMAGE_ASSET_ABSENT_${image.id}`, code: 'IMAGE_ASSET_ABSENT', severity: 'warn', message: `Image ${image.id} on page ${image.page} is unavailable in storage; re-import the source to restore it.` });
    return undefined;
  }));
  const images = resolved.filter((image): image is ImageAsset => !!image);
  return reconcileFinalFlags(repairImageReferences({ ...doc, images, flags }, doc.images));
}
