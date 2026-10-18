import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeForMatching,
  normalizeDigits,
  detectKeyTerritory,
  enumerateExpectedQuestionNos,
  parsePrintedNumberFromStem,
  evaluateCoverage,
  matchingView,
  getExamHealth,
} from '../src/pipeline/quality';
import {
  assembleAndValidateQuestions,
  assembleAndValidateSections,
  sliceSourceSpans,
} from '../src/pipeline/assemble';
import {
  columnSegments,
  extractionDiagnostics,
  tagFurniture,
} from '../src/pipeline/extractionQuality';
import {
  materializeMergedCrop,
  mergeAdjacentImageGeometry,
} from '../src/pipeline/imageGeometry';
import { sha256 } from '../src/utils/hash';
import { trilingualFixtures, printedSet } from './fixtures/trilingual';
import { ExamDoc, ImageAsset, SourceLine } from '../src/types';
const lines = (texts: string[], page = 1, offset = 0): SourceLine[] =>
  texts.map((text, i) => ({
    id: `L${String(i + 1 + offset).padStart(4, '0')}`,
    text,
    page,
  }));
for (const fixture of trilingualFixtures)
  test(`trilingual corpus: ${fixture.name}`, () => {
    const source = [
      ...lines(fixture.questions),
      ...lines(
        ['Iranian final header', fixture.key, '99. key only'],
        2,
        fixture.questions.length,
      ),
    ];
    const original = JSON.stringify(source);
    const result = enumerateExpectedQuestionNos(source);
    assert.deepEqual(result.numbers, printedSet);
    assert.equal(result.keyTerritory.markerLine, fixture.questions.length + 1);
    assert.equal(result.keyTerritory.lineNos.size, 3);
    assert.equal(parsePrintedNumberFromStem(fixture.questions[3]), 31);
    for (const n of [15, 16, 17, 18, 63, 64, 9])
      assert.ok(result.lineByNumber.has(n));
    for (const n of [1399, 2024, 6, 30, 1, 5])
      assert.equal(result.numbers.includes(n), false);
    assert.equal(JSON.stringify(source), original);
  });
test('canonical normalization and source/stem/answer/option byte-invariance', () => {
  assert.equal(normalizeDigits, normalizeForMatching);
  assert.equal(
    normalizeForMatching('ي ك ة أ إ آ ؤ ئ ى ۀ ۰۱۲ ٣٤٥ ６７８۹ ؟،؛«»–—'),
    'ی ک ه ا ا ا و ی ی ه 012 345 6789 ?,;""--',
  );
  assert.equal(
    normalizeForMatching('مِـی\u200cشَوَد\u200dA\u00a0B'),
    'می شود a b',
  );
  const text = '۳１. كَـدام می\u200cشود؟';
  const source = lines([text, 'الف) خُـوب ب) بَد', '31. Aَـnswer 32. B']);
  const before = JSON.stringify(source);
  const q = assembleAndValidateQuestions(
    [
      {
        id: 'q31',
        no: 31,
        spans: [[1, 1]],
        type: 'mcq',
        options: [
          { key: 'a', spans: [[2, 2]] },
          { key: 'b', spans: [[2, 2]] },
        ],
        answer: { spans: [[3, 3]] },
        confidence: 0.9,
      },
    ],
    source,
  ).questions[0];
  assert.equal(q.stem, text);
  assert.deepEqual(
    q.options?.map((o) => o.text),
    ['خُـوب', 'بَد'],
  );
  assert.equal(q.answer?.text, 'Aَـnswer');
  assert.equal(JSON.stringify(source), before);
  assert.equal(sliceSourceSpans([[1, 1]], source), text);
  const expanded = matchingView('Ａـي\u200cB');
  assert.equal(expanded.text, normalizeForMatching('Ａـي\u200cB'));
  const extractor = readFileSync('src/pipeline/extract.ts', 'utf8');
  assert.equal(/text:\s*\w+\.normalize\(/.test(extractor), false);
});
test('early embedded page marker, late standalone marker, prose non-marker', () => {
  assert.equal(
    detectKeyTerritory(lines(['header', 'Exam | راهنماي تصحیح | 2024']))
      .markerLine,
    1,
  );
  assert.equal(
    detectKeyTerritory(lines([...Array(12).fill('body'), 'Marking Guide']))
      .markerLine,
    13,
  );
  assert.equal(
    detectKeyTerritory(lines(['1. Explain what an Answer Key is.'])).markerLine,
    undefined,
  );
  assert.equal(detectKeyTerritory(lines(['پاسخنامه'])).markerLine, 1);
});
test('first 2 lines / 240 chars printed-number window, corrected no prevents phantom missing', () => {
  for (const stem of [
    'Choose the best answer.\n35. Original',
    'گزینه را انتخاب کنید\n۳۱. می‌شود',
  ])
    assert.ok(parsePrintedNumberFromStem(stem));
  assert.equal(
    parsePrintedNumberFromStem('A distractor 35. in a sentence'),
    undefined,
  );
  assert.equal(
    parsePrintedNumberFromStem('Header\nInstructions\n35. Too late'),
    undefined,
  );
  assert.equal(
    parsePrintedNumberFromStem(`${'x'.repeat(241)}\n35. Too late`),
    undefined,
  );
  assert.deepEqual(
    evaluateCoverage(
      [31, 35],
      [
        { no: 1, stem: 'Choose the best answer.\n35. Original' },
        { no: 31, stem: 'Instruction-first stem without a printed number' },
      ],
    ).missing,
    [],
  );
});
test('conservative RTL 3-column header; ambiguous gutter retains legacy order with warning', () => {
  const row = [
    { str: '3', x: 500, y: 700, w: 10, h: 12, dir: 'rtl' as const },
    {
      str: 'شنیداری Listening',
      x: 250,
      y: 700,
      w: 90,
      h: 12,
      dir: 'rtl' as const,
    },
    { str: '2', x: 20, y: 700, w: 10, h: 12, dir: 'rtl' as const },
  ];
  const clear = columnSegments(row, row, 600);
  assert.equal(clear.ambiguous, false);
  assert.equal(clear.segments.length, 3);
  assert.equal(
    clear.segments[1].map((i) => i.str).join(' '),
    'شنیداری Listening',
  );
  const ambiguous = columnSegments(
    row,
    [
      ...row,
      {
        str: 'continuous body across gutters',
        x: 20,
        y: 650,
        w: 500,
        h: 12,
        dir: 'rtl',
      },
    ],
    600,
  );
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.segments.length, 1);
  assert.deepEqual(
    ambiguous.segments[0].map((i) => i.str),
    row.map((i) => i.str),
  );
});
test('6-page furniture excludes expected numbers and passages without shifting spans', () => {
  let source: SourceLine[] = [];
  for (let page = 1; page <= 6; page++)
    source.push(
      ...lines(
        [
          '99. مرکز سنجش',
          'www-kanoon-ir',
          `${page}. Question ${page}`,
          'Original reading paragraph one.',
          'Original reading paragraph two.',
        ],
        page,
        source.length,
      ).map((l, i) => ({ ...l, y: [780, 20, 650, 600, 580][i] })),
    );
  const before = JSON.stringify(source.map((l) => [l.id, l.text]));
  const slice = sliceSourceSpans([[3, 3]], source);
  source = tagFurniture(source, 6);
  assert.equal(source.filter((l) => l.furniture).length, 24); // shared reading lines repeat too
  assert.deepEqual(
    enumerateExpectedQuestionNos(source).numbers,
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(JSON.stringify(source.map((l) => [l.id, l.text])), before);
  assert.equal(sliceSourceSpans([[3, 3]], source), slice);
  const sections = assembleAndValidateSections(
    [{ id: 's', index: 1, title: 'Reading', spans: [[1, 30]] }],
    source,
    [],
  );
  assert.equal(sections.sections[0].passage?.includes('www'), false);
  assert.equal(normalizeForMatching('63. keys …www-kanoon-ir'), '63. keys ...');
  const doc = {
    source: { lines: source, expectedQuestionNos: [1] },
    meta: {},
    questions: [{ no: 99, stem: '99. مرکز سنجش', spans: [[1, 1]], images: [] }],
    images: [],
  } as unknown as ExamDoc;
  assert.equal(getExamHealth(doc).parsedCount, 0);
  const diagnostic = extractionDiagnostics(source, 7, []);
  assert.equal(diagnostic.furnitureCount, 24);
  assert.deepEqual(diagnostic.emptyPages, [7]);
});
test('six strips + two photos merge to 3; merged crop pixels/hash/dHash/anchor are recomputed', async () => {
  const image = (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): ImageAsset => ({
    id,
    page: 1,
    bbox: { x, y, w, h },
    width: w,
    height: h,
    mime: 'image/jpeg',
    sha: 'strip_hash',
    blobKey: 'strip_hash',
    dHash: 'strip_dhash',
    anchorLine: 1,
  });
  const assets = [
    ...Array.from({ length: 6 }, (_, i) =>
      image(`strip${i}`, 50, i * 21, 200, 21),
    ),
    image('photo1', 300, 200, 100, 80),
    image('photo2', 450, 400, 100, 80),
  ];
  const groups = mergeAdjacentImageGeometry(assets);
  assert.equal(groups.length, 3);
  const group = groups.find((g) => g.assets.length === 6)!;
  const pagePixels = new Uint8Array([8, 9, 10, 11]);
  let crops = 0;
  const merged = await materializeMergedCrop(
    group.assets,
    group.bbox,
    [
      { id: 'L0001', page: 1, text: 'top', y: 800 },
      { id: 'L0008', page: 1, text: 'middle', y: 737 },
    ],
    737,
    async (bbox) => {
      crops++;
      assert.deepEqual(bbox, { x: 50, y: 0, w: 200, h: 126 });
      return {
        blob: new Blob([pagePixels]),
        width: 200,
        height: 126,
        dHash: 'MERGED_CROP_DHASH',
      };
    },
  );
  assert.equal(crops, 1);
  assert.deepEqual(
    new Uint8Array(await merged._blob.arrayBuffer()),
    pagePixels,
  );
  assert.equal(merged.sha, await sha256(pagePixels.buffer));
  assert.notEqual(merged.sha, assets[0].sha);
  assert.equal(merged.dHash, 'MERGED_CROP_DHASH');
  assert.equal(merged.anchorLine, 8);
  URL.revokeObjectURL(merged.dataUrl!);
});
test('Latin a–h forms, Persian option labels and True/False pairs use normalized copies only', () => {
  for (const body of [
    'a) One b) Two',
    'a. One b. Two',
    'a: One b: Two',
    '(a) One (b) Two',
    '(Ａ) One (Ｂ) Two',
    'الف) می‌شود ب) كُدام',
    'الف. می‌شود ب. كُدام',
    'True / False',
    'درست/نادرست',
  ]) {
    const source = lines(['۳۱. کدام؟', body]);
    const before = JSON.stringify(source);
    const result = assembleAndValidateQuestions(
      [
        {
          id: 'q31',
          no: 31,
          spans: [[1, 1]],
          options: [
            { key: 'a', spans: [[2, 2]] },
            { key: 'b', spans: [[2, 2]] },
          ],
          confidence: 0.9,
        },
      ],
      source,
    );
    const options = result.questions[0].options!.map((o) => o.text);
    if (body.startsWith('True')) assert.deepEqual(options, ['True', 'False']);
    else if (body.startsWith('درست'))
      assert.deepEqual(options, ['درست', 'نادرست']);
    else
      assert.deepEqual(
        options,
        body.includes('الف') ? ['می‌شود', 'كُدام'] : ['One', 'Two'],
      );
    assert.equal(JSON.stringify(source), before);
  }
});
test('furniture threshold is ≥60%, not a single repeated question, and refreshed OCR diagnostics are not stale', () => {
  const source = Array.from({ length: 6 }, (_, i) => ({
    id: `L${i + 1}`,
    page: i + 1,
    text: i < 4 ? 'مرکز سنجش' : 'other',
    y: 800,
  }));
  assert.equal(tagFurniture(source, 6).filter((l) => l.furniture).length, 4);
  assert.equal(
    tagFurniture(
      source.map((l, i) => ({
        ...l,
        text: i < 3 ? 'مرکز سنجش' : `unique ${i}`,
      })),
      6,
    ).filter((l) => l.furniture).length,
    0,
  );
  const old = extractionDiagnostics([], 1, []);
  const updated = extractionDiagnostics(lines(['OCR text']), 1, [], [1], old);
  assert.deepEqual(updated.linesPerPage, [1]);
  assert.deepEqual(updated.emptyPages, []);
  assert.deepEqual(updated.ocrPages, [1]);
});

test('corroborated body gutters ignore wide title/footer, but a crossing body paragraph remains ambiguous', () => {
  const item = (str: string, x: number, y: number, w: number) => ({ str, x, y, w, h: 12, dir: 'ltr' as const });
  const rows = [700, 675, 650, 625, 600].map((y, i) => [item(`left ${i}`, 40, y, 90 + i * 5), item(`right ${i}`, 400, y, 130)]);
  const all = [...rows.flat(), item('page-wide title', 20, 780, 540), item('page-wide footer', 20, 20, 540)];
  const original = JSON.stringify(all);
  const clear = columnSegments(rows[0], all, 600);
  assert.equal(clear.ambiguous, false); assert.equal(clear.segments.length, 2);
  const crossed = columnSegments(rows[0], [...all, item('continuous body paragraph across gutter', 20, 660, 540)], 600);
  assert.equal(crossed.ambiguous, true); assert.equal(crossed.segments.length, 1);
  assert.equal(JSON.stringify(all), original);
});

test('known PDF geometry tags only repeated header/footer, never identical repeated body options or passages', () => {
  const source = Array.from({ length: 6 }, (_, i) => [
    { id: `L${i * 4 + 1}`, page: i + 1, text: 'Examination board', y: 780, pageHeight: 800 },
    { id: `L${i * 4 + 2}`, page: i + 1, text: 'a) Identical option', y: 650, pageHeight: 800 },
    { id: `L${i * 4 + 3}`, page: i + 1, text: 'Repeated body passage, not furniture', y: 600, pageHeight: 800 },
    { id: `L${i * 4 + 4}`, page: i + 1, text: 'Official footer', y: 20, pageHeight: 800 },
  ]).flat();
  const tagged = tagFurniture(source, 6);
  assert.equal(tagged.filter(l => l.furniture).length, 12);
  assert.ok(tagged.filter(l => l.text.includes('option') || l.text.includes('passage')).every(l => !l.furniture));
  assert.deepEqual(tagged.map(l => [l.id, l.text]), source.map(l => [l.id, l.text]));
});
