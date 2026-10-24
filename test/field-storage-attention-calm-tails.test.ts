import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ExamDoc, Flag, ImageAsset, Question, SourceLine } from '../src/types';
import { DEFAULT_SETTINGS, getReviewImageBlob, loadExamDoc, saveExamDoc } from '../src/store';
import { prepareReviewDocument, restoreMissingImageFromSource } from '../src/pipeline/reviewIntegrity';
import { buildExportDoc } from '../src/utils/examExport';
import { parseExamDocImport } from '../src/utils/validation';
import { validateSemantic } from '../src/pipeline/semanticValidators';
import { groupAttentionFlags, triageFlags } from '../src/utils/flagPresentation';
import { IntegrityFlags } from '../src/components/IntegrityFlags';
import { Step4Review, Step4ReviewContent } from '../src/views/Step4Review';
import { getExamHealth, exciseWatermarksWithLearned } from '../src/pipeline/quality';
import { replayFieldExport } from '../src/pipeline/fieldReplay';
import { assembleAndValidateQuestions, assembleAndValidateSections } from '../src/pipeline/assemble';
import { cleanAnswerText } from '../src/pipeline/answerKey';
import { buildDossier } from '../src/pipeline/dossier';

const sha256Hex = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function startTempServer() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'examparse-part-a-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });

  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      EXAMFORGE_DATA_DIR: dataDir,
      EXAMPARSE_CONFIG_FILE: path.join(root, 'config.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${logs}`)), 15000);
    child.stdout.on('data', chunk => {
      logs += String(chunk);
      if (logs.includes('ExamParse server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      logs += String(chunk);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${logs}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    async cleanup() {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

// 1x1 PNG payloads with distinct bytes so each image has a distinct SHA-256 blobKey
function makePngBytes(tag: number): Buffer {
  // Valid minimal PNG header + distinct trailing chunk byte
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, tag & 0xff,
  ]);
}

test('T1 (Part A): folder storage seam — 3 images save/reload/export cleanly; simulated blob failure reports PARTIAL-STORAGE with named ID, no IMAGE_ASSET_ABSENT surprise, and per-image restore-from-source recovers it', { timeout: 30000 }, async () => {
  const srv = await startTempServer();
  const originalFetch = globalThis.fetch;
  let failBlobKey: string | null = null;
  const storageEvents: string[] = [];

  const prevWindow = (globalThis as any).window;
  const mockTarget = new EventTarget();
  mockTarget.addEventListener('storage-error', (ev: Event) => {
    storageEvents.push(String((ev as CustomEvent).detail || ''));
  });
  (globalThis as any).window = mockTarget;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (failBlobKey && method === 'PUT' && rawUrl.startsWith(`/api/images/${failBlobKey}`)) {
      return new Response(JSON.stringify({ error: 'Simulated EPERM disk lock on Windows folder' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const targetUrl = rawUrl.startsWith('/') ? `${srv.baseUrl}${rawUrl}` : rawUrl;
    return originalFetch(targetUrl, init);
  }) as typeof fetch;

  try {
    const png1 = makePngBytes(1);
    const png2 = makePngBytes(2);
    const png3 = makePngBytes(3);
    const sha1 = sha256Hex(png1);
    const sha2 = sha256Hex(png2);
    const sha3 = sha256Hex(png3);

    const makeAsset = (id: string, page: number, sha: string, bytes: Buffer): ImageAsset => ({
      id,
      page,
      bbox: { x: 10, y: 20 * page, w: 120, h: 80 },
      mime: 'image/png',
      sha,
      width: 120,
      height: 80,
      anchorLine: page,
      blobKey: sha,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    });

    const sourceLines: SourceLine[] = [
      { id: 'L0001', page: 1, text: '1. Look at the first picture and choose the answer.' },
      { id: 'L0002', page: 2, text: '2. Look at the second picture and choose the answer.' },
      { id: 'L0003', page: 3, text: '3. Look at the third picture and choose the answer.' },
    ];

    const docOk: ExamDoc = {
      id: 'exam_part_a_ok',
      fileHash: 'hash_part_a_ok',
      createdAt: new Date().toISOString(),
      displayName: 'Part A Three Images',
      meta: { language: 'en', direction: 'ltr', totalPoints: 3 },
      sections: [{ id: 'sec_1', index: 1, title: 'Listening', spans: [[1, 3]] }],
      questions: [
        {
          id: 'q1', label: '1', no: 1, sectionId: 'sec_1', spans: [[1, 1]],
          stem: '1. Look at the first picture and choose the answer.', type: 'mcq', points: 1, confidence: 0.95,
          options: [{ key: 'a', spans: [[1, 1]], text: 'Cat' }, { key: 'b', spans: [[1, 1]], text: 'Dog' }],
          images: [{ imageId: 'img_001', role: 'stem', anchorLine: 1 }],
        },
        {
          id: 'q2', label: '2', no: 2, sectionId: 'sec_1', spans: [[2, 2]],
          stem: '2. Look at the second picture and choose the answer.', type: 'mcq', points: 1, confidence: 0.95,
          options: [{ key: 'a', spans: [[2, 2]], text: 'Sun' }, { key: 'b', spans: [[2, 2]], text: 'Moon' }],
          images: [{ imageId: 'img_002', role: 'stem', anchorLine: 2 }],
        },
        {
          id: 'q3', label: '3', no: 3, sectionId: 'sec_1', spans: [[3, 3]],
          stem: '3. Look at the third picture and choose the answer.', type: 'mcq', points: 1, confidence: 0.95,
          options: [{ key: 'a', spans: [[3, 3]], text: 'Tree' }, { key: 'b', spans: [[3, 3]], text: 'Flower' }],
          images: [{ imageId: 'img_003', role: 'stem', anchorLine: 3 }],
        },
      ],
      images: [
        makeAsset('img_001', 1, sha1, png1),
        makeAsset('img_002', 2, sha2, png2),
        makeAsset('img_003', 3, sha3, png3),
      ],
      source: { lines: sourceLines, pages: 3, ocrUsed: false, fileName: 'exam.pdf', expectedQuestionNos: [1, 2, 3] },
      flags: [],
      usage: [],
    };

    // 1. Healthy save with 3 images -> reload -> all 3 renderable + JSON export preserves resolvable refs & metadata
    const okRes = await saveExamDoc(structuredClone(docOk));
    assert.equal(okRes.status, 'ok');
    assert.deepEqual(okRes.failedImageIds, []);

    const reloadedOk = await loadExamDoc('exam_part_a_ok');
    assert.ok(reloadedOk);
    assert.equal(reloadedOk.images.length, 3);
    for (const img of reloadedOk.images) {
      assert.equal(Boolean(img.storageMissing), false);
      assert.match(img.dataUrl || '', /^\/api\/images\//);
      const blob = await getReviewImageBlob(img.blobKey);
      assert.ok(blob && blob.size > 0, `blob for ${img.id} exists in folder storage`);
    }
    const preparedOk = await prepareReviewDocument(reloadedOk, getReviewImageBlob);
    assert.equal(preparedOk.images.length, 3);
    assert.equal(preparedOk.flags.some(f => f.code === 'IMAGE_ASSET_ABSENT' || f.code === 'IMAGE_REF_DROPPED'), false);

    const exported = buildExportDoc(reloadedOk);
    assert.equal(exported.images.length, 3, 'JSON export never strips extracted images to []');
    assert.equal(exported.exportMeta.binariesStripped, true);
    assert.equal(exported.exportMeta.imageCount, 3);
    assert.ok(exported.images.every((img: any) => !img.dataUrl && img.blobKey && img.localUrl?.startsWith('/api/images/') && img.exportPath));
    // In-app doc still retains renderable URLs
    assert.ok(reloadedOk.images.every(img => Boolean(img.dataUrl)));
    // Exported JSON round-trips cleanly through schema import
    const reimported = parseExamDocImport(JSON.stringify(exported));
    assert.equal(reimported.error, undefined);
    assert.equal(reimported.doc?.images.length, 3);

    // 2. Simulate write failure on img_002 -> save reports PARTIAL-STORAGE naming img_002, no IMAGE_ASSET_ABSENT surprise later
    const pngFail = makePngBytes(99);
    const shaFail = sha256Hex(pngFail);
    failBlobKey = shaFail;
    storageEvents.length = 0;

    const docFail: ExamDoc = {
      ...structuredClone(docOk),
      id: 'exam_part_a_partial',
      images: [
        makeAsset('img_001', 1, sha1, png1),
        makeAsset('img_002', 2, shaFail, pngFail),
        makeAsset('img_003', 3, sha3, png3),
      ],
    };

    const partialRes = await saveExamDoc(docFail);
    assert.equal(partialRes.status, 'PARTIAL-STORAGE');
    assert.deepEqual(partialRes.failedImageIds, ['img_002']);
    assert.match(partialRes.banner || '', /PARTIAL-STORAGE.*img_002/);
    assert.ok(storageEvents.some(msg => msg.includes('PARTIAL-STORAGE') && msg.includes('img_002')), 'storage banner names PARTIAL-STORAGE and img_002');

    const reloadedPartial = await loadExamDoc('exam_part_a_partial');
    assert.ok(reloadedPartial);
    assert.equal(reloadedPartial.storageState, 'PARTIAL-STORAGE');
    assert.deepEqual(reloadedPartial.failedImageIds, ['img_002']);
    assert.equal(reloadedPartial.images.length, 3, 'dataUrl-free reference kept for img_002');
    assert.equal(reloadedPartial.images.find(i => i.id === 'img_002')?.dataUrl, undefined);
    assert.equal(reloadedPartial.images.find(i => i.id === 'img_002')?.storageMissing, true);
    assert.equal(reloadedPartial.questions[1].images.length, 1, 'Q2 image reference preserved');

    const preparedPartial = await prepareReviewDocument(reloadedPartial, getReviewImageBlob);
    assert.equal(preparedPartial.flags.some(f => f.code === 'IMAGE_ASSET_ABSENT'), false, 'no IMAGE_ASSET_ABSENT surprise later');
    assert.equal(preparedPartial.flags.some(f => f.code === 'IMAGE_REF_DROPPED'), false, 'question image refs are not dropped');

    // Step 4 image tray offers per-missing-image "Restore from source"
    const step4Html = renderToStaticMarkup(
      React.createElement(Step4ReviewContent, {
        examDoc: preparedPartial,
        settings: DEFAULT_SETTINGS,
        onUpdateDoc: () => undefined,
        onProceedToExamView: () => undefined,
      }),
    );
    assert.match(step4Html, /data-missing-images-tray="true"/);
    assert.match(step4Html, /img_002 · page 2/);
    assert.match(step4Html, /Restore from source/);

    // 3. Restore img_002 from source once disk fault clears -> all 3 images renderable and PARTIAL-STORAGE cleared
    failBlobKey = null;
    const rawSourceFile = new File([new Uint8Array(pngFail)], 'exam.pdf', { type: 'application/pdf' });
    const restoredDoc = await restoreMissingImageFromSource(preparedPartial, 'img_002', rawSourceFile, {
      extractPageImages: async (page) => {
        assert.equal(page, 2, 're-extracts only missing image page');
        const asset = makeAsset('reextracted_p2', 2, shaFail, pngFail) as ImageAsset & { _blob?: Blob };
        asset._blob = new Blob([new Uint8Array(pngFail)], { type: 'image/png' });
        return [asset];
      },
    });
    const afterRestoreSave = await saveExamDoc(restoredDoc);
    assert.equal(afterRestoreSave.status, 'ok');
    assert.deepEqual(afterRestoreSave.failedImageIds, []);

    const reloadedRecovered = await loadExamDoc('exam_part_a_partial');
    assert.ok(reloadedRecovered);
    assert.equal(reloadedRecovered.storageState, undefined);
    assert.equal(reloadedRecovered.images.every(img => Boolean(img.dataUrl) && !img.storageMissing), true);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as any).window = prevWindow;
    await srv.cleanup();
  }
});

test('T2 (Parts B1 & B2): present letter/TF/short-token answers emit ZERO instruction-answer flags; 50-row field attention load collapses to single-digit root causes while get_open_issues keeps per-question data', async () => {
  const fieldExport = JSON.parse(
    fs.readFileSync('test/fixtures/field-exports/English — 11_structured (2).json', 'utf8'),
  ) as ExamDoc;
  const replayed = replayFieldExport(fieldExport);

  // B1: Replayed 67-question exam has carved answers like "( a )", "( c )", "arrange", etc. -> ZERO ANSWER_ANCHOR_SUSPECT
  const semanticIssues = validateSemantic(replayed.replayedQuestions, replayed.replayedSections);
  const suspectOnReplayed = semanticIssues.filter(i => i.code === 'ANSWER_ANCHOR_SUSPECT');
  assert.equal(suspectOnReplayed.length, 0, `expected 0 ANSWER_ANCHOR_SUSPECT on valid answers, got ${JSON.stringify(suspectOnReplayed)}`);

  // Verify genuine doubtful anchors STILL fire (empty, instruction-classified, span-inconsistent)
  const genuineCheck = validateSemantic([
    {
      id: 'q_empty', label: '1', no: 1, spans: [[1, 1]], stem: '1. Sample valid question stem?', type: 'mcq', confidence: 0.9, images: [],
      options: [{ key: 'a', spans: [[1, 1]], text: 'One' }, { key: 'b', spans: [[1, 1]], text: 'Two' }],
      answer: { source: 'paper', text: '   ', spans: [[100, 100]] },
    },
    {
      id: 'q_instr', label: '2', no: 2, spans: [[2, 2]], stem: '2. Another valid question stem?', type: 'short', confidence: 0.9, images: [],
      answer: { source: 'paper', text: 'هر پاسخ صحیح 0.5 نمره منظور گردد', spans: [[101, 101]] },
    },
    {
      id: 'q_dup_span_1', label: '3', no: 3, spans: [[3, 3]], stem: '3. First shared-span question?', type: 'short', confidence: 0.9, images: [],
      answer: { source: 'paper', text: 'shared uncarved answer text', spans: [[102, 102]] },
    },
    {
      id: 'q_dup_span_2', label: '4', no: 4, spans: [[4, 4]], stem: '4. Second shared-span question?', type: 'short', confidence: 0.9, images: [],
      answer: { source: 'paper', text: 'shared uncarved answer text', spans: [[102, 102]] },
    },
  ]);
  assert.equal(genuineCheck.filter(i => i.code === 'ANSWER_ANCHOR_SUSPECT').length, 4);

  const questions = replayed.replayedQuestions;
  const sections = replayed.replayedSections;

  // Exact 50-row field screen composition from English — 11_structured (4).json:
  // 26 false-positive ANSWER_ANCHOR_SUSPECT on carved answers -> eliminated by B1 (0 rows)
  // + 11 exam-level IMAGE_ASSET_ABSENT + 13 storage-coupled IMAGE_REF_DROPPED = 24 remaining rows -> 2 grouped root-cause rows!
  const exact50AfterB1Flags: Flag[] = [
    ...Array.from({ length: 11 }, (_, idx): Flag => ({
      id: `exact_abs_${idx}`,
      code: 'IMAGE_ASSET_ABSENT',
      severity: 'warn',
      message: `Image img_${String(idx + 1).padStart(3, '0')} is absent from storage.`,
    })),
    ...questions.slice(0, 13).map((q, idx): Flag => ({
      id: `exact_drop_${idx}`,
      code: 'IMAGE_REF_DROPPED',
      severity: 'warn',
      questionId: q.id,
      rootCauseId: 'storage_failure',
      message: `Q${q.no}: unavailable image reference was removed.`,
    })),
  ];
  assert.equal(groupAttentionFlags(exact50AfterB1Flags, { sections, questions }).length, 2, 'exact 50-row field screen (26 B1 false positives + 11 absent + 13 dropped) collapses to 2 root-cause rows');

  // Mixed scenario including section-coupled unpriced items + 2 standalone hollow stems -> 5 root causes (single digits, genuine defects preserved)
  const sec3Questions = questions.filter(q => q.sectionId === sections[2].id && !q.parentId).slice(0, 5);
  const standaloneTwo = questions.filter(q => !q.parentId).slice(20, 22);

  const postB1Flags: Flag[] = [
    ...Array.from({ length: 11 }, (_, idx): Flag => ({
      id: `flag_IMAGE_ASSET_ABSENT_img_${String(idx + 1).padStart(3, '0')}`,
      code: 'IMAGE_ASSET_ABSENT',
      severity: 'warn',
      message: `Image img_${String(idx + 1).padStart(3, '0')} on page 1 is unavailable in storage.`,
    })),
    ...questions.slice(0, 13).map((q, idx): Flag => ({
      id: `flag_IMAGE_REF_DROPPED_${q.id}_${idx}`,
      code: 'IMAGE_REF_DROPPED',
      severity: 'warn',
      questionId: q.id,
      rootCauseId: 'storage_failure',
      message: `Q${q.no}: unavailable image reference was removed.`,
    })),
    ...sec3Questions.map((q): Flag => ({
      id: `flag_POINTS_UNPRICED_${q.id}`,
      code: 'POINTS_UNPRICED',
      severity: 'warn',
      questionId: q.id,
      message: `Q${q.no}: unpriced question.`,
    })),
    ...standaloneTwo.map((q): Flag => ({
      id: `flag_STEM_HOLLOW_${q.id}`,
      code: 'STEM_HOLLOW',
      severity: 'error',
      questionId: q.id,
      message: `Q${q.no}: stem is hollow.`,
    })),
  ];

  // Raw attention rows after B1 = 31 (down from 50 before B1)
  assert.equal(triageFlags(postB1Flags).attention.length, 31);

  const fieldScenarioDoc: ExamDoc = {
    ...fieldExport,
    id: 'exam_field_b2',
    sections,
    questions,
    flags: postB1Flags,
  };

  const groups = groupAttentionFlags(fieldScenarioDoc.flags, fieldScenarioDoc);
  assert.equal(groups.length, 5, '50 field attention rows reduce to 5 root causes');

  const absentGroup = groups.find(g => g.code === 'IMAGE_ASSET_ABSENT');
  assert.ok(absentGroup);
  assert.match(absentGroup.summary, /11 images absent from storage — one storage failure/);

  const droppedGroup = groups.find(g => g.code === 'IMAGE_REF_DROPPED');
  assert.ok(droppedGroup && droppedGroup.expandable && droppedGroup.count === 13);

  const hollowGroups = groups.filter(g => g.code === 'STEM_HOLLOW');
  assert.equal(hollowGroups.length, 2, 'genuine distinct per-question defects are never suppressed');

  const flagsHtml = renderToStaticMarkup(React.createElement(IntegrityFlags, { doc: fieldScenarioDoc }));
  assert.match(flagsHtml, /5 things need attention/);
  assert.match(flagsHtml, /11 images absent from storage — one storage failure/);
  assert.doesNotMatch(flagsHtml, /<details open/);

  // getExamHealth agrees on root-cause attention count
  assert.equal(getExamHealth(fieldScenarioDoc).attentionCount, groups.length);

  // Assistant's get_open_issues (buildDossier.knownIssues) retains exact raw counts & affected questionRefs unchanged
  const dossier = buildDossier(fieldScenarioDoc);
  assert.equal(dossier.knownIssues.IMAGE_ASSET_ABSENT?.count, 11);
  assert.equal(dossier.knownIssues.IMAGE_REF_DROPPED?.count, 13);
  assert.equal(dossier.knownIssues.IMAGE_REF_DROPPED?.questionRefs.length, 13);
  assert.equal(dossier.knownIssues.POINTS_UNPRICED?.count, 5);
  assert.equal(dossier.knownIssues.STEM_HOLLOW?.count, 2);
  assert.equal(dossier.healthSnapshot.attentionCount, groups.length, 'Assistant healthSnapshot agrees with UI attentionCount');
});

test('T3 (Part C): Step 4 default view renders sections collapsed, <= attention questions + section headers cards, auto-expands ONLY attention questions, and keeps AI Solve affordances', () => {
  const fieldExport = JSON.parse(
    fs.readFileSync('test/fixtures/field-exports/English — 11_structured (2).json', 'utf8'),
  ) as ExamDoc;
  const replayed = replayFieldExport(fieldExport);

  const healthyDoc: ExamDoc = {
    ...fieldExport,
    id: 'exam_step4_calm',
    sections: replayed.replayedSections,
    questions: replayed.replayedQuestions,
    images: [],
    flags: [],
  };

  // 1. Healthy 67-q exam default render
  const defaultHtml = renderToStaticMarkup(
    React.createElement(Step4Review, {
      examDoc: healthyDoc,
      settings: DEFAULT_SETTINGS,
      onUpdateDoc: () => undefined,
      onProceedToExamView: () => undefined,
    }),
  );

  const sectionHeadersCount = (defaultHtml.match(/data-review-section="/g) || []).length;
  const renderedQuestionCards = (defaultHtml.match(/data-review-question="/g) || []).length;
  const totalDomTags = (defaultHtml.match(/<[a-zA-Z0-9-]+[\s>]/g) || []).length;

  assert.equal(sectionHeadersCount, 8, 'all 8 sections render header rows');
  assert.equal(renderedQuestionCards, 0, 'sections render collapsed by default');
  assert.ok(
    renderedQuestionCards + sectionHeadersCount <= 0 + sectionHeadersCount,
    'rendered default card count <= attention questions + section headers',
  );
  assert.ok(totalDomTags < 350, `calm default view keeps DOM compact (${totalDomTags} elements vs ~1900 previously)`);
  // Top-level "Answer with AI" affordance remains present for answer-less questions (e.g. Q50, Q63, Q67)
  assert.match(defaultHtml, /Answer with AI \(\d+\)/);

  // 2. With 2 attention questions: sections show attention dot; when expanded via filter, ONLY attention questions auto-expand internals
  const qAtt1 = healthyDoc.questions.find(q => q.no === 25)!;
  const qAtt2 = healthyDoc.questions.find(q => q.no === 50)!; // answer-less question
  const docWithTwoAttention: ExamDoc = {
    ...healthyDoc,
    flags: [
      { id: 'f_att_1', code: 'POINTS_UNPRICED', severity: 'warn', questionId: qAtt1.id, message: 'Check marks' },
      { id: 'f_att_2', code: 'STEM_OVERLONG', severity: 'warn', questionId: qAtt2.id, message: 'Check stem' },
    ],
  };

  const attDefaultHtml = renderToStaticMarkup(
    React.createElement(Step4Review, {
      examDoc: docWithTwoAttention,
      settings: DEFAULT_SETTINGS,
      onUpdateDoc: () => undefined,
      onProceedToExamView: () => undefined,
    }),
  );
  const attSectionDots = (attDefaultHtml.match(/data-attention-dot="true"/g) || []).length;
  const attDefaultCards =
    (attDefaultHtml.match(/data-review-question="/g) || []).length +
    (attDefaultHtml.match(/data-review-section="/g) || []).length;
  assert.equal(attSectionDots, 2, 'sections containing attention questions display attention dots');
  assert.ok(attDefaultCards <= 2 + 8, 'default card count <= attention questions + section headers');

  // When sections are opened, ONLY the 2 attention questions auto-expand internals; healthy cards stay compact and AI Solve remains intact
  const expandedSectionsHtml = renderToStaticMarkup(
    React.createElement(Step4Review, {
      examDoc: docWithTwoAttention,
      settings: DEFAULT_SETTINGS,
      onUpdateDoc: () => undefined,
      onProceedToExamView: () => undefined,
      initialExpandedSectionIds: docWithTwoAttention.sections.map(s => s.id),
    }),
  );
  const expandedQuestionCount = (expandedSectionsHtml.match(/data-question-expanded="true"/g) || []).length;
  const compactQuestionCount = (expandedSectionsHtml.match(/data-question-expanded="false"/g) || []).length;
  const internalsPanels = (expandedSectionsHtml.match(/data-question-internals="/g) || []).length;
  assert.equal(expandedQuestionCount, 2, 'only the 2 attention questions auto-expand');
  assert.equal(internalsPanels, 2, 'internals (spans, confidence, receipt, flags) render only on expanded cards');
  assert.ok(expandedSectionsHtml.includes(`data-question-internals="${qAtt1.id}"`));
  assert.ok(expandedSectionsHtml.includes(`data-question-internals="${qAtt2.id}"`));
  assert.ok(compactQuestionCount >= 50, 'all healthy root questions render in compact review form');
  assert.match(expandedSectionsHtml, /Solve with AI/);
  assert.match(expandedSectionsHtml, /AI Solve/);
});

test('T4 (Part D): Q15 option (e) stops at instruction/word-bank boundary, Q30 option is furniture-free, Q38 answer is tail-free, and Writing intro excludes fill-stem continuations', () => {
  const sourceLines = JSON.parse(
    fs.readFileSync('test/fixtures/corpus/english-final-13991009pq89w65173/source-lines.json', 'utf8'),
  ) as SourceLine[];
  const fieldExport = JSON.parse(
    fs.readFileSync('test/fixtures/field-exports/English — 11_structured (2).json', 'utf8'),
  ) as ExamDoc;
  const replayed = replayFieldExport(fieldExport);

  // D1 (Q15-class): Even when Q15's span lazily extends through L0057 (score "2" + Persian rubric + word bank),
  // option (e) MUST end cleanly at "...converts into bed." and word-bank items attach to Q19..Q21.
  const q15Overextended = assembleAndValidateQuestions(
    [
      { id: 'q15', no: 15, sectionId: 'sec_2', spans: [[49, 57]], type: 'matching', confidence: 0.9 },
      { id: 'q16', no: 16, parentId: 'q15', sectionId: 'sec_2', spans: [[49, 49]], type: 'matching', confidence: 0.9 },
      { id: 'q17', no: 17, parentId: 'q15', sectionId: 'sec_2', spans: [[49, 49]], type: 'matching', confidence: 0.9 },
      { id: 'q18', no: 18, parentId: 'q15', sectionId: 'sec_2', spans: [[49, 49]], type: 'matching', confidence: 0.9 },
      { id: 'q19', no: 19, sectionId: 'sec_2', spans: [[58, 58]], type: 'unknown', confidence: 0.9 },
    ],
    sourceLines,
  );
  const q15 = q15Overextended.questions.find(q => q.id === 'q15')!;
  const optE = q15.options?.find(o => o.key === 'e');
  assert.ok(optE, 'Q15 has option e');
  assert.equal(optE.text, 'The sofa converts into bed.');
  assert.ok(optE.text!.endsWith('converts into bed.'));
  assert.doesNotMatch(optE.text!, /یک کلمه اضافی|repeatedly|forever|demand|arrange/);

  const q19 = q15Overextended.questions.find(q => q.id === 'q19')!;
  assert.deepEqual(q19.wordBank, ['repeatedly', 'forever', 'demand', 'arrange']);

  // D2 (Q30-class): Both full continued-page footer and partial-learned «سومی» / «…صفحه…» residue are excised from options
  const q30Res = assembleAndValidateQuestions(
    [
      {
        id: 'q30',
        no: 30,
        sectionId: 'sec_3',
        spans: [[78, 81]],
        type: 'mcq',
        confidence: 0.9,
        options: [
          { key: 'a', spans: [[79, 79]] },
          { key: 'b', spans: [[79, 79]] },
          { key: 'c', spans: [[79, 79]] },
          { key: 'd', spans: [[79, 81]] },
        ],
      },
    ],
    sourceLines,
  );
  const q30OptD = q30Res.questions[0].options?.find(o => o.key === 'd');
  assert.equal(q30OptD?.text, 'increases');
  assert.equal(exciseWatermarksWithLearned('increases «سومی»', []).text, 'increases');
  assert.equal(exciseWatermarksWithLearned('increases «ادامه در صفحه سومی»', []).text, 'increases');

  // D3 (Q38-class): Answer tail "»ادامه در صفحهیدوم«" and preceding bare score/page number "4" are excised
  const replayedQ38 = replayed.replayedQuestions.find(q => q.no === 38)!;
  assert.ok(replayedQ38.answer?.text);
  assert.doesNotMatch(replayedQ38.answer!.text!, /ادامه|صفحه|«|»|\n4\b/);
  assert.equal(
    cleanAnswerText('We can live without food for a few weeks »ادامه در صفحهیدوم«'),
    'We can live without food for a few weeks',
  );
  assert.equal(
    cleanAnswerText('We can live without food for a few weeks\n4\n»ادامه در صفحهیدوم«'),
    'We can live without food for a few weeks',
  );

  // D4 (Writing-intro): Section intro/passage assembly excludes lines inside ANY question's spans
  // AND excludes immediate unnumbered prose continuations of a fill/blank stem (L0162..L0163 after Q50 L0161).
  const replayedWritingSec = replayed.replayedSections.find(s => /writing/i.test(s.title || ''))!;
  assert.ok(replayedWritingSec);
  assert.equal(replayedWritingSec.passage, undefined);

  const q50LazyOneLine: Question = {
    id: 'q50',
    label: '50',
    no: 50,
    sectionId: 'sec_wrong_id', // Even when sectionId has not yet been canonicalized to sec_writing!
    spans: [[161, 161]],
    stem: '50. Smoking ...... . It increases the risk of death among the people who smoke.',
    type: 'fillblank',
    images: [],
    confidence: 0.9,
  };
  const q49: Question = {
    id: 'q49',
    label: '49',
    no: 49,
    sectionId: 'sec_wrong_id',
    spans: [[159, 159]],
    stem: '49. Saeed studied hard for the exam,……………………………… .',
    type: 'fillblank',
    images: [],
    confidence: 0.9,
  };
  const writingSecRes = assembleAndValidateSections(
    [{ id: 'sec_writing', index: 5, title: 'Writing', spans: [[151, 170]] }],
    sourceLines,
    [q49, q50LazyOneLine],
    [],
  );
  assert.equal(
    writingSecRes.sections[0].passage,
    undefined,
    `Writing section passage must exclude Q50 fill continuation, got: ${JSON.stringify(writingSecRes.sections[0].passage)}`,
  );
});
