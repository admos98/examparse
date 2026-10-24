import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  assembleAndValidateQuestions,
  assembleAndValidateSections,
  canonicalizeSections,
  splitInlineOptions,
  stripLeadingOptionMarker,
  trimOptionInstructionResidue,
} from '../src/pipeline/assemble';
import { segmentDocument, findIntraLineMultiNumbers } from '../src/pipeline/segment';
import {
  computeImageQuestionHints,
  enumerateExpectedQuestionNos,
  getExamHealth,
  validateExamInvariants,
} from '../src/pipeline/quality';
import { assignExtractedImageIds, mergeExtractedPageImages } from '../src/pipeline/extract';
import { fallbackImageKind, labelImagesBatched } from '../src/pipeline/vision';
import {
  DEFAULT_MAX_MODEL_CALLS,
  DEFAULT_MAX_TOOL_EXECUTIONS,
  computeActionFingerprint,
  newAgentSession,
  runAgentTurn,
  type AgentRuntime,
} from '../src/pipeline/agent';
import { createToolRegistry, splitGroupChildrenInDoc } from '../src/pipeline/agentTools';
import { DEFAULT_SETTINGS } from '../src/store';
import {
  annotateLibrarySummaries,
  exportExamFileName,
  summarizeExamForLibrary,
} from '../src/utils/examExport';
import { AssistantView } from '../src/views/AssistantView';
import { LibraryView } from '../src/views/LibraryView';
import type { ExamDoc, ImageAsset, SourceLine } from '../src/types';

function makeLines(texts: string[], page = 1): SourceLine[] {
  return texts.map((text, idx) => ({
    id: `L${String(idx + 1).padStart(4, '0')}`,
    page,
    text,
  }));
}

test('T1 — Fix 1: inline option splitter strips markers, folds backticks, rejects non-sequences, and never duplicates unsplit blobs', () => {
  // Bench Q25 with Iranian PDF backtick-apostrophes AND plain ASCII
  const q25Backtick = splitInlineOptions('a) won`t he b) won`t they c) will they d) will he');
  assert.ok(q25Backtick);
  assert.deepEqual(
    q25Backtick.map(o => o.text),
    ["won't he", "won't they", "will they", "will he"],
  );

  // Full assemble path over Q25 source lines
  const lines = makeLines([
    '25. Nobody called last night, ___?',
    'a) won`t he   b) won`t they   c) will they   d) will he',
  ]);
  const assembled = assembleAndValidateQuestions(
    [
      {
        id: 'q25',
        no: 25,
        label: '25',
        type: 'mcq',
        spans: [[1, 2]],
        options: [
          { key: 'a', spans: [[2, 2]] },
          { key: 'b', spans: [[2, 2]] },
          { key: 'c', spans: [[2, 2]] },
          { key: 'd', spans: [[2, 2]] },
        ],
      },
    ],
    lines,
  );
  assert.equal(assembled.questions.length, 1);
  assert.deepEqual(
    assembled.questions[0].options?.map(o => o.text),
    ["won't he", "won't they", "will they", "will he"],
  );

  // Matching pool options with `a.` / `b.` / `c.` / `d.` prefixes strip markers everywhere
  const dottedPool = splitInlineOptions('a. hospital   b. airport   c. library   d. museum');
  assert.ok(dottedPool);
  assert.deepEqual(dottedPool.map(o => o.text), ['hospital', 'airport', 'library', 'museum']);
  assert.equal(stripLeadingOptionMarker('a. hospital'), 'hospital');

  // Persian sentence containing standalone letters after ZWNJ fold must NOT split as fake options
  assert.deepEqual(splitInlineOptions('او و علی به مدرسه رفتند و کتاب خواندند.'), []);

  // Unsplittable MCQ gets options=[] + OPTIONS_MISSING, ZERO duplicate unsplit blobs
  const unsplitLines = makeLines([
    '12. Choose the correct answer from the box below.',
    'hospital / airport / library / museum',
  ]);
  const unsplittable = assembleAndValidateQuestions(
    [
      {
        id: 'q12',
        no: 12,
        label: '12',
        type: 'mcq',
        spans: [[1, 2]],
        options: [
          { key: 'a', spans: [[2, 2]] },
          { key: 'b', spans: [[2, 2]] },
          { key: 'c', spans: [[2, 2]] },
          { key: 'd', spans: [[2, 2]] },
        ],
      },
    ],
    unsplitLines,
  );
  assert.deepEqual(unsplittable.questions[0].options, []);
  assert.ok(unsplittable.flags.some(f => f.code === 'OPTIONS_MISSING'));
});

test('T2 — Fix 2 & I11: intra-line multi-number splitter emits parent+children with char offsets, fixes number slip, and enforces I11', () => {
  const lines = makeLines([
    'Part B: Grammar',
    '19. a) go  b) goes    20. a) do  b) does    21. a) is  b) are',
    '22. She plays tennis every Friday.',
    'جمع نمره: 2.5',
  ]);
  const intra = findIntraLineMultiNumbers(lines[1].text);
  assert.equal(intra.length, 3);
  assert.deepEqual(intra.map(i => i.no), [19, 20, 21]);

  const segResult = segmentDocument({ lines });
  assert.equal(segResult.diagnostics.fallbackSections.length, 0);
  const seg19 = segResult.segments.find(s => s.kind === 'group-parent' && s.printedNo === 19);
  const seg20 = segResult.segments.find(s => s.printedNo === 20 && s.parentSegmentId === seg19?.id);
  const seg21 = segResult.segments.find(s => s.printedNo === 21 && s.parentSegmentId === seg19?.id);
  assert.ok(seg19 && seg20 && seg21, 'emitted group-parent 19 + child segments 20 & 21');
  assert.ok(typeof seg20.charStart === 'number' && typeof seg20.charEnd === 'number');

  // Assemble slices child text cleanly by offsets and corrects slipped number 99 -> 22
  const asm = assembleAndValidateQuestions(
    [
      {
        id: 'q19',
        no: 19,
        label: '19',
        sectionId: 'sec_grammar',
        type: 'fillblank',
        spans: [[2, 2]],
        points: 1.5,
      },
      {
        id: 'q99_slipped',
        no: 99,
        label: '99',
        sectionId: 'sec_grammar',
        type: 'short',
        spans: [[3, 3]],
        points: 1,
      },
    ],
    lines,
  );
  assert.deepEqual(asm.questions.map(q => q.no), [19, 20, 21, 22]);
  const child20 = asm.questions.find(q => q.no === 20)!;
  assert.equal(child20.parentId, 'q19');
  assert.equal(child20.sectionId, 'sec_grammar');
  assert.match(child20.stem || '', /^20\.\s*a\)\s*do/);
  assert.ok(!(child20.stem || '').includes('21.'));
  assert.ok(asm.flags.some(f => f.code === 'NUMBER_SLIPPED_CORRECTED'));

  // Direct I11 gate verification on an un-repaired slipped doc
  const brokenDoc: ExamDoc = {
    id: 'exam_i11',
    fileHash: 'h_i11',
    createdAt: new Date().toISOString(),
    displayName: 'I11 Check',
    meta: { language: 'en', direction: 'ltr', totalPoints: 2.5 },
    sections: [{ id: 'sec_grammar', index: 1, title: 'Grammar', spans: [[1, 3]] }],
    questions: asm.questions.map(q => (q.no === 22 ? { ...q, no: 24, label: '24' } : q)),
    images: [],
    source: {
      lines,
      pages: 1,
      fileName: 'i11.pdf',
      ocrUsed: false,
      expectedQuestionNos: enumerateExpectedQuestionNos(lines).numbers,
    },
    flags: [],
    usage: [],
  };
  const invBroken = validateExamInvariants(brokenDoc);
  assert.equal(invBroken.ok, false);
  assert.ok(invBroken.violations.some(v => v.code === 'I11'));
  assert.ok(invBroken.flags.some(f => f.code === 'INVARIANT_I11_NUMBER_SLIP'));

  const validDoc: ExamDoc = {
    ...brokenDoc,
    questions: asm.questions,
  };
  const invClean = validateExamInvariants(validDoc);
  assert.equal(invClean.ok, true, `Expected 0 invariant errors, got: ${JSON.stringify(invClean.violations)}`);
});

test('T3 — Fix 3: split_group_children builds real children with root parentId, captions/source stems, points=0, and trimmed shared options', () => {
  const sourceLines = makeLines([
    'کلمات داده شده را زیر تصاویر مناسب بنویسید. (15) (16) (17) (18) 2 (یک کلمه اضافه است)',
    'www.iran-exam-sample.ir',
    'a) doctor   b) farmer   c) pilot   d) nurse   e) teacher 2 (یک کلمه اضافه است)',
  ]);
  const groupDoc: ExamDoc = {
    id: 'exam_group',
    fileHash: 'h_group',
    createdAt: new Date().toISOString(),
    displayName: 'Group Children Test',
    meta: { language: 'fa', direction: 'rtl', totalPoints: 2 },
    sections: [{ id: 'sec_vocab', index: 1, title: 'واژگان', spans: [[1, 3]] }],
    questions: [
      {
        id: 'q15',
        label: '15',
        no: 15,
        sectionId: 'sec_vocab',
        spans: [[1, 3]],
        stem: sourceLines[0].text,
        points: 2,
        type: 'matching',
        options: [{ key: 'a', spans: [[2, 3]], text: `${sourceLines[1].text} ${sourceLines[2].text}` }],
        images: [
          { imageId: 'img_001', role: 'stem' },
          { imageId: 'img_002', role: 'stem' },
          { imageId: 'img_003', role: 'stem' },
        ],
        confidence: 0.9,
      },
      {
        // Pre-existing child to verify calling split on `q15_child_1` walks parent chain back to root `q15`!
        id: 'q15_child_1',
        label: '16',
        no: 16,
        parentId: 'q15',
        sectionId: 'sec_vocab',
        spans: [[1, 3]],
        stem: '16. a farmer in the field',
        points: 0,
        type: 'matching',
        images: [{ imageId: 'img_002', role: 'stem' }],
        confidence: 0.9,
      },
    ],
    images: [
      { id: 'img_001', page: 1, width: 120, height: 100, mime: 'image/jpeg', sha: 's1', blobKey: 'b1', bbox: { x: 10, y: 10, w: 120, h: 100 }, label: { role: 'stem', kind: 'photo', questionRef: '15', caption: 'a doctor in clinic' } },
      { id: 'img_002', page: 1, width: 120, height: 100, mime: 'image/jpeg', sha: 's2', blobKey: 'b2', bbox: { x: 140, y: 10, w: 120, h: 100 }, label: { role: 'stem', kind: 'photo', questionRef: '16', caption: 'a farmer in field' } },
      { id: 'img_003', page: 1, width: 120, height: 100, mime: 'image/jpeg', sha: 's3', blobKey: 'b3', bbox: { x: 270, y: 10, w: 120, h: 100 }, label: { role: 'stem', kind: 'photo', questionRef: '17', caption: 'airline pilot cockpit' } },
    ],
    source: {
      lines: sourceLines,
      pages: 1,
      fileName: 'group.pdf',
      ocrUsed: false,
      expectedQuestionNos: [15, 16, 17, 18],
    },
    flags: [],
    usage: [],
  };

  // Invoke with `q15_child_1` to prove child `parentId` ALWAYS resolves to root `q15` (never `q15_child_1`)
  const res = splitGroupChildrenInDoc(groupDoc, 'q15_child_1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, [17, 18]);
  assert.equal(res.residueTrimmed, true);

  const q17 = res.doc.questions.find(q => q.no === 17)!;
  const q18 = res.doc.questions.find(q => q.no === 18)!;
  assert.equal(q17.parentId, 'q15');
  assert.equal(q18.parentId, 'q15');
  assert.notEqual(q17.id, q18.id);
  assert.equal(q17.points, 0);
  assert.equal(q18.points, 0);
  // Q17 has caption; Q18 has no image caption so slices shared instruction from source — NEVER "Child N of group P"
  assert.equal(q17.stem, '17. airline pilot cockpit');
  assert.ok(!/Child \d+ of group/i.test(q18.stem || ''), `Unexpected placeholder stem: ${q18.stem}`);
  assert.match(q18.stem || '', /کلمات داده شده/);
  const rootAfter = res.doc.questions.find(q => q.id === 'q15')!;
  assert.deepEqual(
    rootAfter.options?.map(o => o.text),
    ['doctor', 'farmer', 'pilot', 'nurse', 'teacher'],
  );
  assert.equal(q17.options, undefined, 'child inherits shared pool on root parent per invariant I9');
  assert.ok(res.doc.flags.some(f => f.code === 'OPTION_RESIDUE_TRIMMED'));
  assert.equal(validateExamInvariants(res.doc).ok, true);

  // Also check explicit "1/5 (یک کلمه اضافه است)" direct trimmer case
  const directTrim = trimOptionInstructionResidue(
    'teacher 1/5 (یک کلمه اضافه است)',
    'کلمات داده شده را بنویسید. 1/5 (یک کلمه اضافه است)',
  );
  assert.equal(directTrim.trimmed, true);
  assert.equal(directTrim.text, 'teacher');
});

test('T4 — Fix 4: canonicalizeSections sorts sections by first span line, renumbers 1..n, and guarantees I7', () => {
  const lines = makeLines([
    'Section A: Vocabulary',
    '1. Define "resilient".',
    'Section B: Grammar',
    '2. Rewrite in passive voice.',
    'Section C: Reading',
    '3. Read the passage and answer.',
  ]);
  const assembled = assembleAndValidateSections(
    [
      { id: 'sec_reading', index: 1, title: 'Reading', spans: [[5, 6]] },
      { id: 'sec_vocab', index: 9, title: 'Vocabulary', spans: [[1, 2]] },
      { id: 'sec_grammar', index: 4, title: 'Grammar', spans: [[3, 4]] },
    ],
    lines,
  );
  assert.deepEqual(assembled.sections.map(s => s.id), ['sec_vocab', 'sec_grammar', 'sec_reading']);
  assert.deepEqual(assembled.sections.map(s => s.index), [1, 2, 3]);
  assert.ok(assembled.flags.some(f => f.code === 'SECTION_ORDER_CANONICALIZED'));

  const canon = canonicalizeSections(assembled.sections, [
    { id: 'q1', label: '1', no: 1, sectionId: 'sec_vocab', spans: [[2, 2]], stem: '1. Define resilient.', points: 1, type: 'short', images: [], confidence: 0.9 },
  ]);
  assert.equal(canon.changed, false);
});

test('T5 — Fix 5: post-merge single-counter image IDs prevent img_010_dup2 collisions & enforce ±0 same-page geometry sanity + photo default', async () => {
  // Engineer exact 2-page strip-merge collision scenario:
  // Page 1 starts with 10 raw image strips (adjacent strips merge down to 2 images);
  // Page 2 has 9 images whose pre-merge counter collided at `img_010` + a cross-page duplicate logo.
  const page1Assets: ImageAsset[] = Array.from({ length: 10 }, (_, idx) => ({
    id: `img_${String(idx + 1).padStart(3, '0')}`,
    page: 1,
    width: 200,
    height: 24,
    mime: 'image/jpeg',
    sha: idx === 0 ? 'sha_header_logo' : `sha_p1_${idx}`,
    blobKey: `blob_p1_${idx}`,
    bbox: { x: 40, y: idx < 8 ? 100 + idx * 24 : 420 + (idx - 8) * 120, w: 200, h: 24 },
  }));
  const page2Assets: ImageAsset[] = Array.from({ length: 9 }, (_, idx) => ({
    id: `img_${String(idx + 3).padStart(3, '0')}`, // Deliberately collides with page1 pre-merge `img_003..img_010`!
    page: 2,
    width: 180,
    height: 90,
    mime: 'image/jpeg',
    sha: idx === 4 ? 'sha_header_logo' : `sha_p2_${idx}`,
    blobKey: `blob_p2_${idx}`,
    duplicateOf: idx === 4 ? 'img_001' : undefined,
    bbox: { x: 50, y: 80 + idx * 95, w: 180, h: 80 },
  }));

  const merged = mergeExtractedPageImages([
    { page: 1, pageAssets: page1Assets, scale: 1 },
    { page: 2, pageAssets: page2Assets, scale: 1 },
  ]);
  const ids = merged.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, 'every post-merge image ID must be strictly unique');
  assert.deepEqual(
    ids,
    Array.from({ length: ids.length }, (_, i) => `img_${String(i + 1).padStart(3, '0')}`),
  );
  assert.ok(ids.every(id => !id.includes('_dup')), `Must never emit _dup suffix, got ${ids.join(',')}`);
  const p2Dup = merged.find(i => i.page === 2 && i.sha === 'sha_header_logo')!;
  assert.equal(p2Dup.duplicateOf, 'img_001');

  // Verify assignExtractedImageIds updates duplicateOf when canonical target renumbers
  const reordered = assignExtractedImageIds([
    { id: 'old_b', page: 2, width: 100, height: 80, mime: 'image/png', sha: 'same_sha', blobKey: 'bb', duplicateOf: 'old_a', bbox: { x: 10, y: 20, w: 100, h: 80 } },
    { id: 'old_a', page: 1, width: 100, height: 80, mime: 'image/png', sha: 'same_sha', blobKey: 'ba', bbox: { x: 10, y: 20, w: 100, h: 80 } },
  ]);
  assert.equal(reordered[0].id, 'img_001');
  assert.equal(reordered[1].id, 'img_002');
  assert.equal(reordered[1].duplicateOf, 'img_001');

  // Strict ±0 same-page geometry sanity: question on page 1 ONLY, raster image on page 2 -> must NOT cross-page assign!
  const twoPageLines: SourceLine[] = [
    { id: 'L0001', page: 1, text: '1. Look at the photo and answer.' },
    { id: 'L0002', page: 2, text: 'End of exam booklet.' },
  ];
  const crossPageImg: ImageAsset = {
    id: 'img_001',
    page: 2,
    anchorLine: 2,
    width: 240,
    height: 180,
    mime: 'image/jpeg',
    sha: 'sha_cross',
    blobKey: 'blob_cross',
    bbox: { x: 10, y: 40, w: 240, h: 180 },
  };
  const samePageImg: ImageAsset = {
    id: 'img_002',
    page: 1,
    anchorLine: 1,
    width: 240,
    height: 180,
    mime: 'image/jpeg',
    sha: 'sha_same',
    blobKey: 'blob_same',
    bbox: { x: 10, y: 40, w: 240, h: 180 },
  };
  const qList = [
    { id: 'q1', label: '1', no: 1, spans: [[1, 1]] as Array<[number, number]>, options: undefined, tables: undefined },
  ];
  const hints = computeImageQuestionHints([crossPageImg, samePageImg], qList, twoPageLines);
  assert.equal(hints['img_001'], undefined, 'cross-page (±1) image must NOT receive a geometric hint');
  assert.equal(hints['img_002']?.questionRef, '1', 'same-page (±0) image receives geometric hint');
  assert.equal(fallbackImageKind(samePageImg), 'photo');
  assert.equal(fallbackImageKind({ ...samePageImg, vectorDetected: true }), 'diagram');

  // Vision shape-mismatch fallback keeps cross-page image in unplaced tray & labels same-page raster crop as 'photo'
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(new ArrayBuffer(8)), { status: 404 })) as typeof fetch;
  try {
    const labeled = await labelImagesBatched(
      {
        images: [crossPageImg, samePageImg],
        sourceLines: twoPageLines,
        providerConfig: { id: 'p', name: 'Mock', kind: 'openai-compatible', baseURL: 'http://localhost', model: 'mock' } as any,
        maxImagesPerVisionCall: 8,
        maxLongEdge: 512,
        maxOutputTokens: 512,
        questionHints: hints,
        questions: [{ id: 'q1', label: '1', no: 1, spans: [[1, 1]], stem: '1. Look at the photo.', type: 'short', images: [], confidence: 0.9 }],
      },
    );
    assert.equal(labeled.updatedImages[0].label, undefined, 'cross-page image left unplaced without vision');
    assert.equal(labeled.updatedImages[1].label?.questionRef, '1');
    assert.equal(labeled.updatedImages[1].label?.kind, 'photo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('T6 — Fix 6: executor deadlock breakers (zero-add retry satisfies reparse, 2nd refusal PRECONDITION_WAIVED, 1-call ladder, cross-window brief filter, 30/200 budget)', async () => {
  assert.equal(DEFAULT_MAX_MODEL_CALLS, 30);
  assert.equal(DEFAULT_MAX_TOOL_EXECUTIONS, 200);

  const lines = makeLines([
    'Section 1: Reading',
    '1. First reading question?',
    '2. Swallowed reading question?',
  ]);
  const makeDoc = (): ExamDoc => ({
    id: 'exam_exec',
    fileHash: 'h_exec',
    createdAt: new Date().toISOString(),
    displayName: 'Executor Deadlock Test',
    meta: { language: 'en', direction: 'ltr', totalPoints: 2 },
    sections: [{ id: 'sec_read', index: 1, title: 'Reading', spans: [[1, 3]] }],
    questions: [
      { id: 'q1', label: '1', no: 1, sectionId: 'sec_read', spans: [[2, 2]], stem: '1. First reading question?', points: 1, type: 'short', images: [], confidence: 0.9 },
    ],
    images: [],
    source: { lines, pages: 1, fileName: 'exec.pdf', ocrUsed: false, expectedQuestionNos: [1, 2] },
    flags: [],
    usage: [],
  });

  // Case A: Single-call `run_remediation_pipeline` climbs health -> L0 -> L1 (adds 0) -> L2 -> L3 reparse candidate (auto-confirm OFF!)
  let docA = makeDoc();
  let modelCallsA = 0;
  let prepareCallsA = 0;
  const scriptsA = ['```tool\n{"name":"run_remediation_pipeline","args":{}}\n```'];
  const runtimeA: AgentRuntime = {
    getDoc: () => docA,
    getSettings: () => structuredClone(DEFAULT_SETTINGS),
    registry: createToolRegistry({
      getDoc: () => docA,
      getSettings: () => structuredClone(DEFAULT_SETTINGS),
      updateDoc: async d => { docA = d; },
      updateSettings: async () => {},
      retryMissing: async d => d, // zero-add retry!
      reparseSection: async (_d, sectionId) => {
        prepareCallsA++;
        return {
          sectionId,
          rawQuestions: [
            { id: 'q1', no: 1, label: '1', type: 'short', spans: [[2, 2]], points: 1 },
            { id: 'q2', no: 2, label: '2', type: 'short', spans: [[3, 3]], points: 1 },
          ],
          usage: [],
        };
      },
    }),
    snapshot: async () => 'snap_1',
    persist: async () => {},
    model: async () => ({
      json: null,
      rawText: scriptsA[modelCallsA++] ?? 'Done.',
      usage: { inputTokens: 20, outputTokens: 20 },
    }),
  };

  const sessionA = newAgentSession(docA.id);
  await runAgentTurn(runtimeA, sessionA, 'Fix missing questions');
  assert.equal(modelCallsA, 1, 'climbed health -> L0 -> L1 -> L2 -> L3 confirm in ONE model call without intermediate hand-backs');
  assert.equal(prepareCallsA, 1, 'prepared L3 section candidate directly after zero-add L1 retry');
  assert.equal(sessionA.pending?.name, 'reparse_section', 'paused cleanly at L3 confirmation card (auto-confirm OFF)');
  assert.equal(docA.questions.length, 1, 'candidate NOT auto-applied before UI confirmation');

  // Case B: Un-retried 1st `reparse_section` refuses cleanly; 2nd identical attempt waives precondition (`PRECONDITION_WAIVED`) and prepares!
  let docB = makeDoc();
  let prepareCallsB = 0;
  let turnIdxB = 0;
  const repliesB = [
    '```tool\n{"name":"reparse_section","args":{"sectionId":"sec_read"}}\n```',
    '```tool\n{"name":"reparse_section","args":{"sectionId":"sec_read"}}\n```',
  ];
  const runtimeB: AgentRuntime = {
    getDoc: () => docB,
    getSettings: () => structuredClone(DEFAULT_SETTINGS),
    registry: createToolRegistry({
      getDoc: () => docB,
      getSettings: () => structuredClone(DEFAULT_SETTINGS),
      updateDoc: async d => { docB = d; },
      updateSettings: async () => {},
      retryMissing: async d => d,
      reparseSection: async (_d, sectionId) => {
        prepareCallsB++;
        return {
          sectionId,
          rawQuestions: [
            { id: 'q1', no: 1, label: '1', type: 'short', spans: [[2, 2]], points: 1 },
            { id: 'q2', no: 2, label: '2', type: 'short', spans: [[3, 3]], points: 1 },
          ],
          usage: [],
        };
      },
    }),
    snapshot: async () => 'snap_b',
    persist: async () => {},
    model: async () => ({
      json: null,
      rawText: repliesB[turnIdxB++] ?? 'Waiting for user confirmation.',
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  };
  const sessionB = newAgentSession(docB.id);
  await runAgentTurn(runtimeB, sessionB, 'Reparse reading section');
  assert.equal(prepareCallsB, 1, '2nd attempt proceeded after 1st refusal');
  assert.ok(sessionB.preconditionsWaived?.some(fp => fp.startsWith('reparse_section:sec_read:')));
  assert.ok(sessionB.events.some(e => e.text.includes('PRECONDITION_WAIVED')));

  // Case C: `diagnose_missing` filters out previously refused/executed `(action + target + docHash)` across turns/windows
  const fp = computeActionFingerprint('reparse_section', { sectionId: 'sec_read' }, docB);
  assert.ok(sessionB.task?.brief?.refusedFingerprints?.[fp]);
  let diagCallsC = 0;
  let capturedObs = '';
  runtimeB.model = async (_sys, userPack) => {
    capturedObs = userPack;
    if (diagCallsC++ === 0) {
      return { json: null, rawText: '```tool\n{"name":"diagnose_missing","args":{"numbers":[2]}}\n```', usage: { inputTokens: 10, outputTokens: 10 } };
    }
    return { json: null, rawText: 'All checked.', usage: { inputTokens: 5, outputTokens: 5 } };
  };
  sessionB.pending = undefined;
  sessionB.prepared = undefined;
  await runAgentTurn(runtimeB, sessionB, 'continue');
  assert.match(capturedObs, /\\"actionQueue\\":\[\]|"actionQueue":\[\]/, 'already-tried fingerprint filtered from diagnose_missing actionQueue on resume window');

  // Verify Assistant header displays remaining model calls and weighted tool budget out of 30 / 200
  sessionB.calls = 4;
  sessionB.weightedExecutions = 12.5;
  const headerHtml = renderToStaticMarkup(
    React.createElement(AssistantView, {
      doc: docB,
      settings: structuredClone(DEFAULT_SETTINGS),
      mode: 'panel',
      initialSession: sessionB,
      onClose: () => {},
      onUpdateDoc: async () => {},
      onSettings: async () => {},
    }),
  );
  assert.match(headerHtml, /4\/30/);
  assert.match(headerHtml, /26 left/);
  assert.match(headerHtml, /187\.5\/200 tools left/);
});

test('T7 — Fix 7: Library identity populates counts/points/health/model, sorts newest-first, marks Latest per source, and preserves (1)/(2) re-parse export suffix', () => {
  const baseLines = makeLines(['1. Q1?', '2. Q2?', '3. Q3?']);
  const parseOld: ExamDoc = {
    id: 'exam_v1',
    fileHash: 'sha256_iranian_final',
    createdAt: '2026-10-20T09:00:00.000Z',
    displayName: 'Iranian Final Grade 9',
    meta: { language: 'en', direction: 'ltr', totalPoints: 48 },
    sections: [{ id: 's1', index: 1, title: 'Main', spans: [[1, 3]] }],
    questions: [
      { id: 'q1', label: '1', no: 1, sectionId: 's1', spans: [[1, 1]], stem: '1. Q1?', points: 23, type: 'short', images: [], confidence: 0.9 },
      { id: 'q2', label: '2', no: 2, sectionId: 's1', spans: [[2, 2]], stem: '2. Q2?', points: 23, type: 'short', images: [], confidence: 0.9 },
    ],
    images: [],
    source: { lines: baseLines, pages: 4, fileName: 'iranian_final.pdf', ocrUsed: false, expectedQuestionNos: Array.from({ length: 67 }, (_, i) => i + 1) },
    flags: [{ id: 'f_part', code: 'PARTIAL_EXAM', severity: 'error', message: 'Partial' }],
    modelInfo: { fast: 'gemini-2.5-flash' },
    usage: [],
  };

  // Add 62 more clean questions so parsed=64 / expected=67, points=46 / 48!
  parseOld.questions = Array.from({ length: 64 }, (_, i) => ({
    id: `q${i + 1}`,
    label: String(i + 1),
    no: i + 1,
    sectionId: 's1',
    spans: [[1, 1]],
    stem: `${i + 1}. Sample question?`,
    points: i === 0 ? 46 : 0,
    type: 'short',
    images: [],
    confidence: 0.9,
  }));

  const parseNew: ExamDoc = {
    ...structuredClone(parseOld),
    id: 'exam_v2',
    createdAt: '2026-10-21T14:30:00.000Z',
    flags: [],
    meta: { language: 'en', direction: 'ltr', totalPoints: 48 },
    questions: Array.from({ length: 67 }, (_, i) => ({
      id: `q${i + 1}`,
      label: String(i + 1),
      no: i + 1,
      sectionId: 's1',
      spans: [[1, 1]],
      stem: `${i + 1}. Sample question?`,
      points: i === 0 ? 48 : 0,
      type: 'short',
      images: [],
      confidence: 0.95,
    })),
    modelInfo: { fast: 'gemini-2.5-pro' },
  };

  const otherSource: ExamDoc = {
    ...structuredClone(parseNew),
    id: 'exam_other',
    fileHash: 'sha256_other_exam',
    createdAt: '2026-10-19T08:00:00.000Z',
    displayName: 'Biology Quiz',
    source: { ...parseNew.source, fileName: 'biology.pdf' },
  };

  const summaries = [
    summarizeExamForLibrary(parseOld),
    summarizeExamForLibrary(otherSource),
    summarizeExamForLibrary(parseNew),
  ];

  // Verify summary fields: "64/67" questions, "46/48" points, PARTIAL / green health state, modelUsed
  assert.equal(`${summaries[0].parsedQuestionCount}/${summaries[0].expectedQuestionCount}`, '64/67');
  assert.equal(`${summaries[0].pointsParsed}/${summaries[0].pointsExpected}`, '46/48');
  assert.equal(summaries[0].healthState, 'PARTIAL');
  assert.equal(summaries[0].modelUsed, 'gemini-2.5-flash');
  assert.equal(summaries[2].healthState, 'green');
  assert.equal(summaries[2].modelUsed, 'gemini-2.5-pro');

  // Default newest-first sort + "Latest" badge strictly on newest parse per source
  const annotated = annotateLibrarySummaries(summaries);
  assert.deepEqual(annotated.map(a => a.id), ['exam_v2', 'exam_v1', 'exam_other']);
  assert.equal(annotated.find(a => a.id === 'exam_v2')!.isLatest, true);
  assert.equal(annotated.find(a => a.id === 'exam_v1')!.isLatest, false);
  assert.equal(annotated.find(a => a.id === 'exam_other')!.isLatest, true);

  // Re-parse export preserves `(1), (2), ...` suffix cleanly without colliding
  const parseThird: ExamDoc = {
    ...structuredClone(parseNew),
    id: 'exam_v3',
    createdAt: '2026-10-21T16:00:00.000Z',
  };
  const allThree = [...summaries, summarizeExamForLibrary(parseThird)];
  assert.equal(exportExamFileName(parseOld, { siblingSummaries: allThree }), 'Iranian Final Grade 9_structured.json');
  assert.equal(exportExamFileName(parseNew, { siblingSummaries: allThree }), 'Iranian Final Grade 9 (1)_structured.json');
  assert.equal(exportExamFileName(parseThird, { siblingSummaries: allThree }), 'Iranian Final Grade 9 (2)_structured.json');

  // Verify real LibraryView DOM renders newest-first order, "Latest" badge, "64/67", "46/48", health chip, and model name
  const libraryHtml = renderToStaticMarkup(
    React.createElement(LibraryView, {
      isOpen: true,
      initialSummaries: summaries,
      onClose: () => {},
      onOpenExam: () => {},
      onExamRenamed: () => {},
      onExamDeleted: () => {},
      onGoToImport: () => {},
    }),
  );
  assert.match(libraryHtml, /64\/67 questions/);
  assert.match(libraryHtml, /46\/48 pts/);
  assert.match(libraryHtml, /gemini-2\.5-flash/);
  assert.match(libraryHtml, /gemini-2\.5-pro/);
  assert.match(libraryHtml, /PARTIAL/);
  assert.match(libraryHtml, /Latest/);
  assert.ok(libraryHtml.indexOf('data-library-entry="exam_v2"') < libraryHtml.indexOf('data-library-entry="exam_v1"'));
});
