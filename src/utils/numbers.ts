/**
 * Digit normalization, language detection, and exam heuristic patterns
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
import { normalizeForMatching, matchingView } from '../pipeline/quality';
/** @deprecated Matching uses the canonical normalizer. */
export const normalizeDigitsToAscii = normalizeForMatching;

/**
 * Format a number to Persian digits for display if direction is RTL
 */
export function toPersianDigits(num: number | string): string {
  const str = String(num);
  let res = '';
  for (const char of str) {
    const code = char.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      res += PERSIAN_DIGITS[code - 48];
    } else {
      res += char;
    }
  }
  return res;
}

/**
 * Detect language and text direction based on codepoints
 * Persian/Arabic/Hebrew codepoint ratio > 20% → rtl, 'fa' / 'ar'; else ltr, 'en'
 */
export function detectLanguageAndDirection(text: string): { language: string; direction: 'ltr' | 'rtl' } {
  if (!text || text.trim().length === 0) {
    return { language: 'en', direction: 'ltr' };
  }

  let rtlCount = 0;
  let totalChars = 0;
  let persianSpecific = 0; // پ چ ژ گ ک ی

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Ignore whitespaces and punctuation
    if (code <= 32 || (code >= 33 && code <= 47)) continue;
    totalChars++;

    // Arabic / Persian Unicode blocks: 0x0600 - 0x06FF, 0x0750 - 0x077F, 0x08A0 - 0x08FF, 0xFB50 - 0xFDFF, 0xFE70 - 0xFEFF
    if (
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0750 && code <= 0x077f) ||
      (code >= 0x08a0 && code <= 0x08ff) ||
      (code >= 0xfb50 && code <= 0xfdff) ||
      (code >= 0xfe70 && code <= 0xfeff)
    ) {
      rtlCount++;
      // Persian specific chars: پ (1662), چ (1670), ژ (1688), گ (1711)
      if (code === 1662 || code === 1670 || code === 1688 || code === 1711) {
        persianSpecific++;
      }
    }
  }

  if (totalChars === 0) return { language: 'en', direction: 'ltr' };

  const ratio = rtlCount / totalChars;
  if (ratio > 0.2) {
    return {
      language: persianSpecific > 0 ? 'fa' : 'ar',
      direction: 'rtl',
    };
  }

  return { language: 'en', direction: 'ltr' };
}

/**
 * Heuristics for question number patterns:
 * 1. 1- 1) Q1 سؤال ۱ ۱) (۱) / sub: 1-1, 1.a, الف), a)
 */
export function matchQuestionPattern(line: string): { isQuestion: boolean; label?: string; num?: number } | null {
  const view = matchingView(line.trim());
  const norm = view.text;

  // Pattern: "1.", "1)", "1 -", "Q1.", "Question 1:", "سوال 1:"
  const m1 = norm.match(/^(?:(?:[Qq]uestion|[Qq]|[Ss]ؤال|سوال)\s*)?\(?(\d{1,3})\)?[\.\-\:\)]\s*/);
  if (m1) {
    const start = m1[0].indexOf(m1[1]);
    const originalLabel = line.trim().slice(view.originalOffset(start), view.originalOffset(start + m1[1].length));
    return {
      isQuestion: true,
      num: parseInt(m1[1], 10),
      label: originalLabel,
    };
  }

  // Pattern: "(1)", "①", "1)"
  const m2 = norm.match(/^\(([0-9]{1,3})\)/);
  if (m2) {
    return {
      isQuestion: true,
      num: parseInt(m2[1], 10),
      label: m2[1],
    };
  }

  return null;
}

/**
 * Heuristic points patterns:
 * (۲ نمره), (2 marks), [2], ۲ نمره, (0.5), [1.5 pts]
 */
export function extractPointsPattern(line: string): number | undefined {
  const norm = normalizeDigitsToAscii(line);
  const m = norm.match(/(?:[\(\[]\s*(\d+(?:\.\d+)?)\s*(?:نمره|نمره\s*ها|marks?|points?|pts?)\s*[\)\]])|(?:[\(\[]\s*(\d+(?:\.\d+)?)\s*[\)\]])|(?:\b(\d+(?:\.\d+)?)\s*نمره\b)/i);
  if (m) {
    const val = m[1] || m[2] || m[3];
    const n = parseFloat(val);
    if (!isNaN(n) && n > 0 && n <= 100) return n;
  }
  return undefined;
}

/**
 * Heuristic fill in the blank patterns:
 * ____, ......, ----------
 */
export function isFillBlankPattern(text: string): boolean {
  return /_{3,}|\.{4,}|-{4,}/.test(normalizeForMatching(text));
}
