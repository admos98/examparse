import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblePositionedTextItems } from '../src/pipeline/extractionQuality';
import { extractionCacheKey, EXTRACTION_VERSION } from '../src/pipeline/extractCache';
import { PARSER_VERSION } from '../src/pipeline/prompts';
import type { TextItemPosition } from '../src/pipeline/extractionQuality';

const item = (str: string, x: number, w: number, dir: 'rtl' | 'ltr', h = 20): TextItemPosition => ({ str, x, y: 100, w, h, dir });

test('Part A: relative gap spacing scales with font size and preserves byte-identical English extraction', () => {
  const small = assemblePositionedTextItems([
    item('The', 0, 20, 'ltr', 10), item('exam', 24, 26, 'ltr', 10),
  ], false);
  const large = assemblePositionedTextItems([
    item('The', 0, 40, 'ltr', 20), item('exam', 48, 52, 'ltr', 20),
  ], false);
  const legacyWhitespace = assemblePositionedTextItems([
    item('The ', 0, 28, 'ltr', 10), item('exam', 32, 26, 'ltr', 10),
  ], false);
  assert.equal(small.text, 'The exam');
  assert.equal(large.text, small.text);
  assert.equal(legacyWhitespace.text, 'The  exam', 'LTR spacing remains byte-identical to the pre-fix extractor');
  assert.equal(small.reorderedEnglishIsland, false);
});

test('Part A: bidi-lite reorders only a contiguous English island embedded in an RTL line', () => {
  const result = assemblePositionedTextItems([
    item('متن ', 280, 42, 'rtl'),
    // PDF visual coordinates yield the English phrase in reverse order within the RTL row.
    item('Exam', 240, 40, 'ltr'),
    item('English ', 180, 60, 'ltr'),
    item('فارسی', 80, 35, 'rtl'),
  ], true);
  assert.equal(result.text, 'متن English Exam فارسی');
  assert.equal(result.reorderedEnglishIsland, true);
});

test('Part A: extraction cache is explicitly versioned for relative-gap and bidi-lite assembly', () => {
  assert.match(EXTRACTION_VERSION, /relative-gap-bidi-lite/);
  assert.match(extractionCacheKey('file-hash'), /extract-v4-relative-gap-bidi-lite/);
  assert.match(PARSER_VERSION, /rtl-run-order/);
});
