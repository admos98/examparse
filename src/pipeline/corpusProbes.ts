/**
 * Godlike Batch 1, Part D — deterministic format probes (report-only insurance).
 *
 * Both probes are GENERATED from the acceptance exam's stored lines with fixed seeds, so
 * the committed fixtures are exactly reproducible from this module (a test asserts it):
 *  - two-column: each page's run order is column-shuffled (page split into two column
 *    sequences, then interleaved run-by-run) the way naive two-column extraction reads;
 *  - scanned-noise: OCR-typical single-character substitutions from a fixed confusion
 *    table at a fixed rate, seeded PRNG.
 * Truth is unchanged from the acceptance entry; the runner measures today's robustness.
 */
import type { SourceLine } from '../types';

export const PROBE_SEED = 13990613;
export const OCR_NOISE_RATE = 0.02;

/** Fixed OCR confusion table (single-character substitutions only). */
export const OCR_CONFUSIONS: Record<string, string> = {
  O: '0', '0': 'O', l: '1', '1': 'l', I: '1', S: '5', '5': 'S', B: '8', '8': 'B',
  e: 'c', c: 'e', a: 'o', o: 'a', u: 'v', v: 'u', n: 'm', m: 'n', g: '9', '9': 'g', Z: '2', '2': 'Z',
};

/** Small deterministic PRNG (mulberry32) — same seed, same fixture, forever. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renumber(lines: SourceLine[]): SourceLine[] {
  return lines.map((line, index) => ({ ...line, id: `L${String(index + 1).padStart(4, '0')}` }));
}

/**
 * Two-column probe: per page, split the line sequence into left/right column halves and
 * interleave them run-by-run (L1, R1, L2, R2, …) — the order a column-unaware extractor
 * emits. Line texts/pages are untouched; ids are re-sequenced in the new reading order.
 */
export function columnShuffleLines(lines: SourceLine[]): SourceLine[] {
  const byPage = new Map<number, SourceLine[]>();
  for (const line of lines) byPage.set(line.page, [...(byPage.get(line.page) || []), line]);
  const out: SourceLine[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const rows = byPage.get(page)!;
    const mid = Math.ceil(rows.length / 2);
    const left = rows.slice(0, mid);
    const right = rows.slice(mid);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      if (left[index]) out.push(left[index]);
      if (right[index]) out.push(right[index]);
    }
  }
  return renumber(out);
}

/**
 * #38 held-out furniture probe: re-wrap every page of an existing corpus exam in DIFFERENT
 * page furniture the pipeline has never seen — a new repeated running header and footer on
 * every page plus a differently-phrased "continued" line between pages. Question/section
 * text is untouched byte-for-byte; only furniture lines are inserted and ids re-sequenced.
 * The probe passes if classification still finds the same questions/sections and the new
 * furniture stays furniture (i.e. nothing about the old furniture wording was memorized).
 */
export interface RefurnishStyle {
  header: string;
  footer: (page: number, pages: number) => string;
  continued: string;
}

export const REFURNISH_STYLE: RefurnishStyle = {
  header: '★ STAR ACADEMY · TERMINAL ASSESSMENT · DO NOT WRITE OUTSIDE THE BOX ★',
  footer: (page, pages) => `Star Academy — assessment paper · sheet ${page} of ${pages} · SA-${100 + page}`,
  continued: '…the test carries on over the page…',
};

export function rewrapFurniture(lines: SourceLine[], style: RefurnishStyle = REFURNISH_STYLE): SourceLine[] {
  const byPage = new Map<number, SourceLine[]>();
  for (const line of lines) byPage.set(line.page, [...(byPage.get(line.page) || []), line]);
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const out: SourceLine[] = [];
  pages.forEach((page, pageIndex) => {
    out.push({ id: '', page, y: 24, text: style.header });
    for (const line of byPage.get(page)!) {
      const { furniture: _stripped, ...rest } = line;
      out.push(rest as SourceLine);
    }
    if (pageIndex < pages.length - 1) out.push({ id: '', page, y: 760, text: style.continued });
    out.push({ id: '', page, y: 792, text: style.footer(pageIndex + 1, pages.length) });
  });
  return renumber(out);
}

/**
 * Scanned-style probe: each character present in the fixed confusion table is substituted
 * with probability `rate` (seeded). All other characters (including Persian script) pass
 * through byte-for-byte; the substitution stream is a pure function of (seed, lines).
 */
export function injectOcrNoise(lines: SourceLine[], seed: number = PROBE_SEED, rate: number = OCR_NOISE_RATE): SourceLine[] {
  const rng = mulberry32(seed);
  return lines.map(line => ({
    ...line,
    text: [...line.text].map(char => {
      const substitute = OCR_CONFUSIONS[char];
      if (substitute === undefined) return char;
      return rng() < rate ? substitute : char;
    }).join(''),
  }));
}
