/**
 * Shared page-furniture & continued-page marker patterns used uniformly across
 * stems, options, passages, and answer-key slicing/cleaning (Parts D2 & D3).
 */

const PERSIAN_PAGE_ORDINAL_SOURCE =
  '(?:اول|یکم|د\\s*ومی?|دومی?|سومی?|چهار\\s*می?|چهارمی?|پنجمی?|شش\\s*می?|ششمی?|هفتمی?|هشتمی?|نهمی?|دهمی?|بعدی?|قبلی?|[۰-۹٠-٩\\d]+)';

/**
 * Continued-page markers with or without "سوالات"/"پاسخ", with or without space
 * before "ی" (e.g. `»ادامه در صفحهیدوم«`, `«ادامه سوالات در صفحه سومی»`,
 * `» ادامه ی سؤالات در صفحه ی پنجم «`).
 */
export const CONTINUED_PAGE_MARKER_RE = new RegExp(
  `[«»"()]?\\s*ادامه(?:\\s*[یىٔ])?(?:\\s+(?:س[وؤ]الات|پاسخ(?:\\s*نامه)?|امتحان|[آا]زمون|مطلب))?\\s+در\\s+صفحه(?:\\s*[یىٔ]|[یىٔ])?(?:\\s*${PERSIAN_PAGE_ORDINAL_SOURCE})?\\s*[«»"()]?`,
  'giu',
);

/**
 * Guillemet-wrapped page/ordinal markers left behind when partial watermarks or
 * continued-page headers/footers appear inline (e.g. `«سومی»`, `«صفحه سوم»`, `«…صفحه…»`).
 */
export const GUILLEMET_PAGE_MARKER_RE = new RegExp(
  `[«»]\\s*(?:[^«»\\r\\n]{0,48}?صفحه[^«»\\r\\n]{0,32}?|(?:صفحه(?:\\s*[یىٔ]|[یىٔ])?\\s*)?${PERSIAN_PAGE_ORDINAL_SOURCE})\\s*[«»]`,
  'giu',
);

/**
 * Matching-view variant where `normalizeForMatching` folded `«`/`»` into `"`; callers
 * verify the original raw characters are guillemets before excising ordinal-only matches.
 */
export const MATCHING_VIEW_GUILLEMET_ORDINAL_RE = new RegExp(
  `"\\s*(?:[^"\\r\\n]{0,48}?صفحه[^"\\r\\n]{0,32}?|(?:صفحه(?:\\s*ی|ی)?\\s*)?${PERSIAN_PAGE_ORDINAL_SOURCE})\\s*"`,
  'giu',
);

/** Canonical shared furniture & watermark regexes applied across stems, options, answers, and passages. */
export const SHARED_FURNITURE_LEXICON: RegExp[] = [
  /مرکز\s*سنجش\s*و\s*پایش\s*کیفیت\s*[آا]موزش[یى]/giu,
  /www[.\-]kanoon[.\-]ir/gi,
  /kanoon\.ir/gi,
  /aee\.medu\.ir/gi,
  /https?:\/\/\S+/gi,
  CONTINUED_PAGE_MARKER_RE,
  GUILLEMET_PAGE_MARKER_RE,
];

/** Inline mask patterns used when detecting option markers on lines carrying inline watermarks/furniture. */
export const SHARED_INLINE_FURNITURE_MASK_PATTERNS: RegExp[] = [
  ...SHARED_FURNITURE_LEXICON,
  /صفحه\s*[۰-۹٠-٩\d]+\s*از\s*[۰-۹٠-٩\d]+/giu,
  /محل\s*مهر\s*یا\s*امض[اآ][ءی]?/giu,
];

/** Fast pre-check before running regex loops or NFKC presentation-form mapping. */
export const SHARED_FURNITURE_FAST_RE =
  /مرکز|kanoon|medu|https?:|ادامه|صفحه|[«»]|[\uFB50-\uFDFF\uFE70-\uFEFF]/iu;

/** Fold Arabic Presentation Forms + Arabic Yeh/Kaf so line-level furniture checks work on raw PDF lines. */
export function foldFurnitureForms(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u0640\u064b-\u0652\u0670]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ى/g, 'ی')
    .replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c >= '۰' ? 0x6f0 : 0x660)));
}

/** True when an entire line is purely page furniture / continued-page footer / watermark. */
export function isStandaloneFurnitureLine(text: string): boolean {
  const folded = foldFurnitureForms(text).trim();
  if (!folded) return false;
  let stripped = folded;
  for (const re of SHARED_INLINE_FURNITURE_MASK_PATTERNS) {
    const copy = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    stripped = stripped.replace(copy, ' ');
  }
  stripped = stripped.replace(/^[\s«»"()[\].,:؛،\-–—]+|[\s«»"()[\].,:؛،\-–—]+$/gu, '').trim();
  return stripped.length === 0;
}
