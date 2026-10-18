import { ImageAsset } from '../types';

export function mergeAdjacentImageGeometry<T extends Pick<ImageAsset, 'page' | 'bbox'>>(assets: T[], renderScale = 1): Array<{ assets: T[]; bbox: ImageAsset['bbox'] }> {
  const groups = assets.map(asset => ({ assets: [asset], bbox: { ...asset.bbox } }));
  const pt = (value: number) => value * renderScale;
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]; const b = groups[j];
        const aPage = a.assets[0].page; const bPage = b.assets[0].page;
        if (aPage !== bPage) continue;
        const xNear = Math.abs(a.bbox.x - b.bbox.x) <= pt(6);
        const widthNear = Math.abs(a.bbox.w - b.bbox.w) <= pt(6);
        const xGap = Math.max(0, Math.max(a.bbox.x, b.bbox.x) - Math.min(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w));
        const xOverlapOrTouch = xGap <= pt(4);
        const yGap = Math.max(0, Math.max(a.bbox.y, b.bbox.y) - Math.min(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h));
        const yContiguous = yGap <= pt(3);
        if (!xNear || !widthNear || !xOverlapOrTouch || !yContiguous) continue;
        const x = Math.min(a.bbox.x, b.bbox.x); const y = Math.min(a.bbox.y, b.bbox.y);
        const right = Math.max(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w);
        const bottom = Math.max(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h);
        groups[i] = { assets: [...a.assets, ...b.assets], bbox: { x, y, w: right - x, h: bottom - y } };
        groups.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return groups;
}

export function isSuspectStrip(bbox: ImageAsset['bbox'], renderScale = 1): boolean {
  const wPt = bbox.w / renderScale;
  const hPt = bbox.h / renderScale;
  const min = Math.min(wPt, hPt);
  const ratio = Math.max(wPt, hPt) / Math.max(1, min);
  return min < 24 || ratio > 8;
}

/** Materialize a merged asset exclusively from the rendered page crop, not any strip's bytes/metadata. */
export async function materializeMergedCrop(
  assets: ImageAsset[], bbox: ImageAsset['bbox'], sourceLines: import('../types').SourceLine[], pdfY: number,
  cropPage: (bbox: ImageAsset['bbox']) => Promise<{ blob: Blob; width: number; height: number; dHash: string }>,
): Promise<ImageAsset & { _blob: Blob }> {
  const { sha256 } = await import('../utils/hash');
  const crop = await cropPage(bbox); const sha = await sha256(await crop.blob.arrayBuffer());
  const first = assets[0];
  const nearest = sourceLines.filter(l => l.page === first.page && l.y !== undefined && !l.furniture).sort((a, b) => Math.abs(a.y! - pdfY) - Math.abs(b.y! - pdfY))[0];
  return { ...first, bbox, mime: 'image/jpeg', sha, blobKey: sha, width: crop.width, height: crop.height, dHash: crop.dHash,
    anchorLine: nearest ? Number(nearest.id.slice(1)) : undefined, duplicateOf: undefined, dataUrl: URL.createObjectURL(crop.blob), _blob: crop.blob };
}
