import { ImageAsset, SourceLine } from "../types";
import { normalizeForMatching } from "./quality";

export interface TextItemPosition {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  dir: "rtl" | "ltr";
}
/** Split only on a wide gutter that no other row crosses. Uncertain layouts retain legacy reading order. */
export function columnSegments(
  cluster: TextItemPosition[],
  pageItems: TextItemPosition[],
  pageWidth: number,
) {
  const rtl =
    pageItems.filter((i) => i.dir === "rtl").length > pageItems.length / 2;
  // Corroborated body gutters can coexist with a page-wide title/footer. Use a
  // narrow common whitespace corridor, not every pixel of one row's variable gap.
  const rows: TextItemPosition[][] = [];
  for (const item of pageItems.filter((i) => i.str.trim())) {
    const row = rows.find((r) => Math.abs(r[0].y - item.y) <= 4);
    if (row) row.push(item);
    else rows.push([item]);
  }
  const gutters = rows.flatMap((row) => {
    const ordered = [...row].sort((a, b) => a.x - b.x);
    return ordered
      .slice(1)
      .flatMap((item, i) =>
        item.x - (ordered[i].x + ordered[i].w) > pageWidth * 0.18
          ? [
              {
                left: ordered[i].x + ordered[i].w + 4,
                right: item.x - 4,
                y: item.y,
              },
            ]
          : [],
      );
  });
  const sorted = [...cluster].sort((a, b) => a.x - b.x);
  const segments: TextItemPosition[][] = [];
  let current: TextItemPosition[] = [];
  let ambiguous = false;
  for (const item of sorted) {
    const prev = current.at(-1);
    if (prev && item.x - (prev.x + prev.w) > pageWidth * 0.18) {
      const left = prev.x + prev.w + 4;
      const right = item.x - 4;
      const halfBand = pageWidth * 0.02;
      const candidates = [
        (left + right) / 2,
        ...gutters.map((g) => (g.left + g.right) / 2),
      ].filter((x) => x - halfBand >= left && x + halfBand <= right);
      const best = candidates
        .map((x) => ({
          x,
          supporters: gutters.filter(
            (g) => g.left <= x - halfBand && g.right >= x + halfBand,
          ),
        }))
        .sort((a, b) => b.supporters.length - a.supporters.length)[0];
      const corroborated =
        best &&
        new Set(best.supporters.map((g) => Math.round(g.y / 4))).size >= 3;
      const minY = corroborated
        ? Math.min(...best.supporters.map((g) => g.y)) - 4
        : -Infinity;
      const maxY = corroborated
        ? Math.max(...best.supporters.map((g) => g.y)) + 4
        : Infinity;
      const corridorLeft = corroborated ? best.x - halfBand : left;
      const corridorRight = corroborated ? best.x + halfBand : right;
      const crossing = pageItems.some(
        (other) =>
          other.str.trim() &&
          other.y >= minY &&
          other.y <= maxY &&
          other.x < corridorRight &&
          other.x + other.w > corridorLeft &&
          Math.abs(other.y - item.y) > 4,
      );
      if (!crossing) {
        segments.push(current);
        current = [];
      } else ambiguous = true;
    }
    current.push(item);
  }
  if (current.length) segments.push(current);
  if (ambiguous)
    return {
      segments: [[...cluster].sort((a, b) => (rtl ? b.x - a.x : a.x - b.x))],
      ambiguous,
    };
  if (rtl) segments.reverse();
  return {
    segments: segments.map((s) =>
      s.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x)),
    ),
    ambiguous,
  };
}

/** Tags only: never removes/reorders lines or changes their text. */
export function tagFurniture(lines: SourceLine[], pages: number): SourceLine[] {
  if (pages < 2) return lines;
  const groups = new Map<string, SourceLine[]>();
  for (const line of lines) {
    if (line.y === undefined) continue;
    // Known PDF page geometry prevents repeated options/passages in the body
    // from being mistaken for running furniture. Older/OCR fixtures retain the
    // conservative same-text/same-position threshold when height is unknown.
    if (
      line.pageHeight &&
      line.y > line.pageHeight * 0.1 &&
      line.y < line.pageHeight * 0.88
    )
      continue;
    const key =
      normalizeForMatching(line.text).trim() ||
      (line.text.trim() ? "<lexicon-furniture>" : "");
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), line]);
  }
  const furniture = new Set<string>();
  for (const group of groups.values())
    for (const candidate of group) {
      const repeated = group.filter((l) => Math.abs(l.y! - candidate.y!) <= 5);
      if (new Set(repeated.map((l) => l.page)).size >= Math.ceil(pages * 0.6))
        repeated.forEach((l) => furniture.add(l.id));
    }
  return lines.map((l) =>
    furniture.has(l.id) ? { ...l, furniture: true } : l,
  );
}
export interface ExtractionDiagnostics {
  pages: number;
  linesPerPage: number[];
  furnitureCount: number;
  imagesFound: number;
  imagesMerged: number;
  imagesDropped: number;
  ocrPages: number[];
  suspectStripCount: number;
  emptyPages: number[];
  ambiguousLayouts: number;
}
export function extractionDiagnostics(
  lines: SourceLine[],
  pages: number,
  images: ImageAsset[],
  ocrPages: number[] = [],
  counts?: Partial<ExtractionDiagnostics>,
): ExtractionDiagnostics {
  const linesPerPage = Array.from(
    { length: pages },
    (_, i) => lines.filter((l) => l.page === i + 1).length,
  );
  return {
    pages,
    linesPerPage,
    furnitureCount: lines.filter((l) => l.furniture).length,
    imagesFound: counts?.imagesFound ?? images.length,
    imagesMerged: counts?.imagesMerged ?? 0,
    imagesDropped: counts?.imagesDropped ?? 0,
    ocrPages,
    suspectStripCount: images.filter((i) =>
      i.imageFlags?.includes("IMAGE_SUSPECT_STRIP"),
    ).length,
    emptyPages: linesPerPage.flatMap((n, i) => (n === 0 ? [i + 1] : [])),
    ambiguousLayouts: lines.filter((l) => l.layoutWarning).length,
  };
}
