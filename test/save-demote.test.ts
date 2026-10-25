import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamDoc, LLMRequest, LLMResponse, SourceLine } from '../src/types';
import type { ExtractedDocument } from '../src/pipeline/extract';
import { createLocalDraft } from '../src/pipeline/localDraft';
import { validateExamInvariants } from '../src/pipeline/quality';
import { confirmPartialExport, partialExportIssues } from '../src/utils/examExport';
import { saveExamDoc, loadExamDoc, DEFAULT_SETTINGS } from '../src/store';
import { runFullPipeline } from '../src/pipeline';
import { LLMAdapter } from '../src/providers/adapter';
import { sha256 } from '../src/utils/hash';

/** In-memory folder storage stand-in: captures PUT bodies and serves them back on GET. */
function mockFolderStorage() {
  const saved = new Map<string, ExamDoc>();
  const originalFetch = globalThis.fetch;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input === 'object' && input && 'method' in input ? (input as any).method : 'GET');
    const examMatch = url.match(/^\/api\/exams\/([^/?]+)/);
    if (examMatch) {
      const id = decodeURIComponent(examMatch[1]);
      if (method === 'PUT') {
        saved.set(id, JSON.parse(String(init?.body)) as ExamDoc);
        return json({ ok: true });
      }
      if (method === 'GET') {
        const doc = saved.get(id);
        return doc ? json(doc) : json({ error: 'not found' }, 404);
      }
    }
    if (url.startsWith('/api/')) return method === 'GET' ? json({ error: 'not found' }, 404) : json({ ok: true });
    return json({ ok: true });
  }) as typeof fetch;
  return {
    saved,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

const sourceLines: SourceLine[] = [
  { id: 'L0001', page: 1, text: 'Unit test exam' },
  { id: 'L0002', page: 1, text: '1. What is two plus two?' },
  { id: 'L0003', page: 1, text: '2. Name the capital of Iran.' },
];

function cleanParsedDoc(overrides: Partial<ExamDoc> = {}): ExamDoc {
  const base = {
    id: 'exam_demote_clean',
    fileHash: 'cleanhash',
    createdAt: new Date().toISOString(),
    displayName: 'Clean',
    meta: { totalPoints: 2, language: 'en', direction: 'ltr' },
    sections: [{ id: 'sec_1', index: 1, title: 'Section 1', spans: [[1, 3]] }],
    questions: [
      {
        id: 'q1', label: '1', no: 1, sectionId: 'sec_1', spans: [[2, 2]], stem: 'What is two plus two?',
        type: 'mcq', points: 1, confidence: 0.9, flags: [], images: [], tables: [],
        options: [{ key: 'a', spans: [[2, 2]], text: 'Three' }, { key: 'b', spans: [[2, 2]], text: 'Four' }],
      },
      {
        id: 'q2', label: '2', no: 2, sectionId: 'sec_1', spans: [[3, 3]], stem: 'Name the capital of Iran.',
        type: 'mcq', points: 1, confidence: 0.9, flags: [], images: [], tables: [],
        options: [{ key: 'a', spans: [[3, 3]], text: 'Tehran' }, { key: 'b', spans: [[3, 3]], text: 'Paris' }],
      },
    ],
    images: [],
    source: { lines: sourceLines, pages: 1, fileName: 'clean.pdf', ocrUsed: false, expectedQuestionNos: [1, 2] },
    flags: [],
    usage: [],
  } as unknown as ExamDoc;
  return {
    ...base,
    ...overrides,
    meta: { ...base.meta, ...(overrides.meta || {}) },
    source: { ...base.source, ...(overrides.source || {}) },
  } as ExamDoc;
}

function draftShape(overrides: Partial<ExamDoc> = {}): ExamDoc {
  const image = (id: string, blobKey: string) => ({
    id, page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: blobKey,
    width: 10, height: 10, anchorLine: 2, blobKey, dataUrl: `/api/images/${blobKey}`,
  });
  const base = {
    id: 'exam_demote_draft',
    fileHash: 'drafthash',
    createdAt: new Date().toISOString(),
    displayName: 'Draft',
    meta: { language: 'en', direction: 'ltr' },
    sections: [],
    questions: [],
    images: [image('dup_img', 'blob_a'), image('dup_img', 'blob_b')],
    source: { lines: sourceLines, pages: 1, fileName: 'draft.pdf', ocrUsed: false, expectedQuestionNos: [1, 2] },
    flags: [{ id: 'source_only', code: 'SOURCE_ONLY', severity: 'info' as const, message: 'Local source-only draft.' }],
    usage: [],
  } as unknown as ExamDoc;
  return { ...base, ...overrides, source: { ...base.source, ...(overrides.source || {}) } } as ExamDoc;
}

test('T1 SOURCE_ONLY draft saves despite duplicate image ids, without partial marking', async () => {
  const storage = mockFolderStorage();
  try {
    const draft = draftShape();
    assert.equal((draft.images as any[]).length, 2);

    await saveExamDoc(draft); // must resolve: drafts are not exams

    const stored = storage.saved.get(draft.id)!;
    assert.ok(stored, 'draft was persisted');
    const imageIds = stored.images.map(image => image.id);
    assert.equal(new Set(imageIds).size, imageIds.length, 'stored draft has unique image ids');
    assert.equal(stored.questions.length, 0);
    assert.notEqual((stored as any).partial, true, 'draft is not marked partial');
    assert.equal(stored.flags.some(flag => flag.code === 'PARTIAL_EXAM'), false, 'draft has no PARTIAL_EXAM flag');
    assert.equal(stored.flags.some(flag => flag.code === 'SOURCE_ONLY'), true, 'draft stays source-only');

    // Draft creation dedupes too, so the import path never even hands duplicates to storage.
    const extracted: ExtractedDocument = {
      lines: sourceLines, pages: 1, ocrUsed: false, fileName: 'draft.pdf',
      images: draft.images, scannedPageIndices: [], pageImages: [],
    };
    const created = createLocalDraft({ ...extracted, images: [draft.images[0], { ...draft.images[1], id: 'dup_img' }] }, 'drafthash');
    assert.equal(new Set(created.images.map(image => image.id)).size, created.images.length, 'createLocalDraft emits unique image ids');
    assert.equal(created.flags.some(flag => flag.code === 'PARTIAL_EXAM'), false);
  } finally {
    storage.restore();
  }
});

test('T2 violating parsed doc saves as PARTIAL, and export still requires confirmation', async () => {
  const storage = mockFolderStorage();
  try {
    const doc = cleanParsedDoc({ id: 'exam_demote_violating' });
    doc.questions[0].stem = ''; // I1 hollow stem
    (doc.questions[0] as any).points = null; // I4 points must be a number
    doc.meta.totalPoints = 10; // I5 points sum mismatch
    assert.notEqual((doc as any).partial, true, 'fixture starts unmarked');
    assert.equal(validateExamInvariants(doc).ok, false, 'fixture really violates invariants');

    await saveExamDoc(doc); // must resolve — persistence is not endorsement

    const stored = storage.saved.get(doc.id)!;
    assert.ok(stored, 'violating doc was persisted');
    assert.equal((stored as any).partial, true, 'stored doc is demoted to partial');
    const partialFlag = stored.flags.find(flag => flag.code === 'PARTIAL_EXAM');
    assert.ok(partialFlag, 'PARTIAL_EXAM flag is persisted');
    assert.match(partialFlag!.message, /questions 1\b/, 'flag names the violating question number');
    assert.match(partialFlag!.message, /I1/);
    assert.match(partialFlag!.message, /I4/);
    assert.match(partialFlag!.message, /I5/);
    assert.equal(stored.flags.filter(flag => flag.code === 'PARTIAL_EXAM').length, 1, 'exactly one PARTIAL_EXAM flag');

    // Reload through the ordinary loader and re-check the demotion survives the round trip.
    const reloaded = await loadExamDoc(doc.id);
    assert.ok(reloaded);
    assert.equal((reloaded as any).partial, true);
    assert.equal(reloaded!.flags.some(flag => flag.code === 'PARTIAL_EXAM'), true);

    // Export enforcement lives in utils/examExport.ts → partialExportIssues/confirmPartialExport,
    // consumed by Step5Exam.requestAction and LibraryView.handleExport.
    assert.ok(partialExportIssues(reloaded!).length > 0, 'export gate reports the violation');
    assert.equal(confirmPartialExport(reloaded!, 'print'), false, 'unconfirmed export is refused');
    assert.equal(confirmPartialExport(reloaded!, 'json'), false, 'unconfirmed JSON export is refused');
  } finally {
    storage.restore();
  }
});

test('T3 clean parsed doc saves unmarked', async () => {
  const storage = mockFolderStorage();
  try {
    const doc = cleanParsedDoc({ id: 'exam_demote_clean_save' });
    assert.equal(validateExamInvariants(doc).ok, true);
    const flagsBefore = doc.flags.length;

    await saveExamDoc(doc);

    const stored = storage.saved.get(doc.id)!;
    assert.ok(stored);
    assert.notEqual((stored as any).partial, true, 'clean doc is not partial');
    assert.equal(stored.flags.some(flag => flag.code === 'PARTIAL_EXAM'), false);
    assert.equal(stored.flags.length, flagsBefore, 'no flags are added to a clean doc');
  } finally {
    storage.restore();
  }
});
