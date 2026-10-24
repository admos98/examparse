import type { Flag, ImageAsset, Question } from '../types';
import { spanLineNumbers } from './spans';

function questionNumbers(ref: string | undefined): number[] {
  if (!ref) return [];
  return [...ref.matchAll(/\d{1,3}/g)].map(match => Number(match[0]));
}

function childLineDistance(child: Question, anchorLine: number): number {
  const lines = spanLineNumbers(child.spans);
  return lines.length ? Math.min(...lines.map(line => Math.abs(line - anchorLine))) : Number.MAX_SAFE_INTEGER;
}

/** Move group-parent images to children using explicit labels, then nearest anchors, then stable order. */
export function distributeGroupImages(questions: Question[], images: ImageAsset[]): { questions: Question[]; flags: Flag[]; distributed: number; fallback: number; unassigned: number } {
  const next = questions.map(question => ({ ...question, images: [...(question.images || [])], flags: question.flags ? [...question.flags] : undefined }));
  const assetById = new Map(images.map(image => [image.id, image]));
  const flags: Flag[] = [];
  let distributed = 0;
  let fallback = 0;
  let unassigned = 0;

  for (const parent of next.filter(question => !question.parentId)) {
    const children = next.filter(question => question.parentId === parent.id).sort((a, b) => a.no - b.no || a.id.localeCompare(b.id));
    if (!children.length) continue;
    if (parent.receipt?.ruleChain.includes('dialogue-group')) {
      for (const ref of parent.images.filter(image => image.role !== 'decoration')) flags.push({
        id: `flag_GROUP_IMAGE_RETAINED_SHARED_CONTEXT_${parent.id}_${ref.imageId}`,
        severity: 'info',
        code: 'GROUP_IMAGE_RETAINED_SHARED_CONTEXT',
        message: `${ref.imageId} remains on dialogue parent Q${parent.no} as shared context rather than being assigned to one blank child.`,
        questionId: parent.id,
      });
      continue;
    }
    const moveRefs = parent.images.filter(ref => ref.role !== 'decoration');
    const mismatch = moveRefs.filter(ref => assetById.has(ref.imageId)).length !== children.length;
    if (moveRefs.length && moveRefs.length < children.length) {
      const pages = new Set(moveRefs.map(ref => assetById.get(ref.imageId)?.page).filter(page => page !== undefined));
      const claimed = new Set(next.flatMap(q => q.images.map(ref => ref.imageId)));
      const candidates = images.filter(image => pages.has(image.page) && !claimed.has(image.id) && !image.label?.questionRef && image.label?.role !== 'decoration' && image.label?.kind !== 'decoration')
        .sort((a, b) => a.page - b.page || a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || a.id.localeCompare(b.id));
      for (const image of candidates.slice(0, children.length - moveRefs.length)) moveRefs.push({ imageId: image.id, role: 'stem', anchorLine: image.anchorLine });
    }
    if (mismatch) moveRefs.sort((a, b) => {
      const x = assetById.get(a.imageId), y = assetById.get(b.imageId);
      return (x?.page || 0) - (y?.page || 0) || (x?.bbox.y || 0) - (y?.bbox.y || 0) || (x?.bbox.x || 0) - (y?.bbox.x || 0);
    });
    if (!moveRefs.length) continue;

    const retainedRefs = parent.images.filter(ref => ref.role === 'decoration');
    const seen = new Set<string>();
    for (const ref of moveRefs) {
      if (seen.has(ref.imageId)) continue;
      seen.add(ref.imageId);
      const asset = assetById.get(ref.imageId);
      if (!asset) {
        retainedRefs.push(ref);
        unassigned++;
        flags.push({
          id: `flag_GROUP_IMAGE_UNASSIGNED_${parent.id}_${ref.imageId}`,
          severity: 'warn',
          code: 'GROUP_IMAGE_DISTRIBUTION_UNASSIGNED',
          message: `${ref.imageId} remains on shared parent Q${parent.no}; its image asset is missing, so no child assignment was made.`,
          questionId: parent.id,
        });
        continue;
      }
      if (asset.label?.role === 'decoration' || asset.label?.kind === 'decoration') {
        retainedRefs.push(ref);
        flags.push({
          id: `flag_GROUP_IMAGE_RETAINED_DECORATION_${parent.id}_${ref.imageId}`,
          severity: 'info',
          code: 'GROUP_IMAGE_RETAINED_DECORATION',
          message: `${ref.imageId} remains on shared parent Q${parent.no} because the image is labeled decoration.`,
          questionId: parent.id,
        });
        continue;
      }
      const labelNos = questionNumbers(asset.label?.questionRef);
      const labelPointsToParent = asset.label?.questionRef === parent.id || asset.label?.questionRef === parent.label || labelNos.includes(parent.no);
      let target = labelPointsToParent ? undefined : children.find(child => child.id === asset.label?.questionRef || child.label === asset.label?.questionRef || labelNos.includes(child.no));
      let usedFallback = false;
      const anchor = ref.anchorLine ?? asset.anchorLine;
      if (!target && anchor !== undefined && !mismatch) {
        target = [...children].sort((a, b) => childLineDistance(a, anchor) - childLineDistance(b, anchor) || a.no - b.no || a.id.localeCompare(b.id))[0];
        usedFallback = true;
      }
      if (!target) {
        target = children.find(child => !child.images.some(image => image.role !== 'decoration')) || children[seen.size % children.length];
        usedFallback = true;
      }
      if (!target) {
        retainedRefs.push(ref);
        unassigned++;
        continue;
      }
      if (!target.images.some(existing => existing.imageId === ref.imageId)) target.images.push({ ...ref, role: ref.role === 'option' || ref.role === 'table' ? ref.role : 'stem' });
      distributed++;
      if (usedFallback) fallback++;
      target.flags = [...new Set([...(target.flags || []), 'GROUP_IMAGE_DISTRIBUTED'])];
      flags.push({
        id: `flag_GROUP_IMAGE_DISTRIBUTED_${parent.id}_${target.id}_${ref.imageId}`,
        severity: usedFallback ? 'warn' : 'info',
        code: usedFallback ? 'GROUP_IMAGE_DISTRIBUTION_FALLBACK' : 'GROUP_IMAGE_DISTRIBUTED',
        message: usedFallback
          ? `${ref.imageId} moved from shared parent Q${parent.no} to child Q${target.no} by deterministic anchor/order fallback.`
          : `${ref.imageId} moved from shared parent Q${parent.no} to labelled child Q${target.no}.`,
        questionId: target.id,
      });
    }
    parent.images = retainedRefs;
    for (const child of children.filter(child => !child.images.some(ref => ref.role !== 'decoration'))) {
      flags.push({ id: `flag_GROUP_IMAGE_DISTRIBUTION_UNASSIGNED_${parent.id}_${child.id}`, code: 'GROUP_IMAGE_DISTRIBUTION_UNASSIGNED', severity: 'warn', questionId: child.id,
        message: `Q${child.no}: no remaining same-page image candidate; check the shared parent or source.` });
    }
  }
  return { questions: next, flags, distributed, fallback, unassigned };
}
