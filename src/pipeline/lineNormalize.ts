/**
 * Follow-up #50 Part C — deterministic input hygiene at line-build time.
 *
 * Every line gets a model-facing twin (`normalized`) used for ALL model prompts and code counting:
 *  - Arabic-Indic (٠–٩) and Persian (۰–۹) digits → Latin 0–9;
 *  - a digit run containing a known-corrupt glyph (e.g. U+0FFF in "١࿿۵", a mangled ۱۵) is rendered as
 *    U+FFFD in the twin and the line is flagged `digitSuspect`, so no model mistakes it for a number;
 *  - a line whose shape is one token/domain repeated ≥3× (e.g. "www-kanoon-irwww-kanoon-irwww-kanoon-ir")
 *    is tagged `watermark` (and furniture) and excluded from model prompts. No cross-page repetition is
 *    required: the shape is self-evident.
 *
 * The original `text` is never touched (storage/export keep it verbatim). Persian/Arabic LETTERS are not
 * touched here — the repair overlay owns those. The twin is only stored when it differs from `text`;
 * `modelText(line)` is the single accessor.
 */
import type { SourceLine } from '../types';

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;
const DIGIT = '0-9\\u0660-\\u0669\\u06F0-\\u06F9';
/** Glyphs that only appear inside digit runs as extraction corruption: unassigned Tibetan tail
 * (U+0FDB–U+0FFF, e.g. ࿿), the Private Use Area, and the Specials block (U+FFF0–U+FFFF incl. U+FFFD). */
const CORRUPT = '\\u0FDB-\\u0FFF\\uE000-\\uF8FF\\uFFF0-\\uFFFF';
const RUN_RE = new RegExp(`[${DIGIT}${CORRUPT}]+`, 'g');
const HAS_DIGIT_RE = new RegExp(`[${DIGIT}]`);
/** Never-legitimate glyphs (unassigned / Specials) corrupt any run they touch. */
const HARD_CORRUPT_RE = /[\u0FDB-\u0FFF\uFFF0-\uFFFF]/;
/** Private-use glyphs are also symbol-font bullets (e.g. "1."), so they only count strictly INSIDE digits. */
const INSIDE_CORRUPT_RE = new RegExp(`[${DIGIT}][${CORRUPT}]+[${DIGIT}]`);
export const SUSPECT_DIGIT_MARK = '\uFFFD';

/** Arabic-Indic and Persian digits to Latin. Letters and everything else are left untouched. */
export function latinDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, ch => {
    const code = ch.charCodeAt(0);
    return String(code >= PERSIAN_ZERO ? code - PERSIAN_ZERO : code - ARABIC_INDIC_ZERO);
  });
}

export function normalizeLineDigits(text: string): { normalized: string; digitSuspect: boolean } {
  let digitSuspect = false;
  const marked = text.replace(RUN_RE, run => {
    if (HAS_DIGIT_RE.test(run) && (HARD_CORRUPT_RE.test(run) || INSIDE_CORRUPT_RE.test(run))) { digitSuspect = true; return SUSPECT_DIGIT_MARK; }
    return run;
  });
  return { normalized: latinDigits(marked), digitSuspect };
}

/** One token (≥3 chars, containing a letter or digit) repeated ≥3 times with an optional single separator. */
const REPEATED_TOKEN_RE = /^(\S{3,}?)(?:[-·. ]?\1){2,}$/u;
const DOMAIN_RE = /(?:www[-.·])?[a-z0-9]{2,}(?:[-.·][a-z0-9]{2,})*?[-.·](?:ir|com|org|net|info|edu|co|io)(?![a-z])/gi;

export function isWatermarkShape(normalizedText: string): boolean {
  const t = normalizedText.trim();
  if (t.length < 9) return false;
  const repeated = REPEATED_TOKEN_RE.exec(t);
  if (repeated && /[\p{L}\p{N}]/u.test(repeated[1])) return true;
  const counts = new Map<string, number>();
  for (const m of t.matchAll(DOMAIN_RE)) {
    const key = m[0].toLowerCase().replace(/[-.·]/g, '.').replace(/^www\./, '');
    const n = (counts.get(key) || 0) + 1;
    if (n >= 3) return true;
    counts.set(key, n);
  }
  return false;
}

/**
 * Idempotent: always recomputed from the CURRENT `text` (e.g. after a repair overlay replaced it), so the
 * twin can never go stale. Returns new objects only for lines that change.
 */
export function annotateSourceLines(lines: SourceLine[]): SourceLine[] {
  return lines.map(line => {
    const { normalized, digitSuspect } = normalizeLineDigits(line.text);
    const watermark = isWatermarkShape(normalized);
    const next: SourceLine = { ...line };
    if (normalized !== line.text) next.normalized = normalized; else delete next.normalized;
    if (digitSuspect) next.digitSuspect = true; else delete next.digitSuspect;
    if (watermark) { next.watermark = true; next.furniture = true; } else delete next.watermark;
    const same = next.normalized === line.normalized && next.digitSuspect === line.digitSuspect && next.watermark === line.watermark && next.furniture === line.furniture;
    return same ? line : next;
  });
}

/** The model-facing text of a line (normalized twin when present). */
export const modelText = (line: SourceLine): string => line.normalized ?? line.text;

/** Lines as every model prompt and code count sees them: watermark lines removed, text = normalized twin. */
export function modelFacingLines(lines: SourceLine[]): SourceLine[] {
  return annotateSourceLines(lines).filter(line => !line.watermark).map(line => line.normalized === undefined ? line : { ...line, text: line.normalized });
}

export function lineHygieneDiagnostics(lines: SourceLine[]): { digitSuspectLines: string[]; watermarkLines: string[] } {
  return { digitSuspectLines: lines.filter(l => l.digitSuspect).map(l => l.id), watermarkLines: lines.filter(l => l.watermark).map(l => l.id) };
}
