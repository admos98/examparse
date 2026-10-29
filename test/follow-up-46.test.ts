import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppSettings, ImageAsset, SourceLine } from '../src/types';
import type { ExtractedDocument } from '../src/pipeline/extract';
import { DEFAULT_SETTINGS } from '../src/store';
import { runFullPipeline } from '../src/pipeline';
import { runLocalLoop } from '../src/pipeline/localLoopRunner';
import { applyCorrections, checkAuthoredDocument, normalizeAuthoredDocument, parseCorrections, projectAuthoredDocument, type LoopModelCaller } from '../src/pipeline/localLoop';
import { buildLoopDecisionCatalogue, runLoopDecisionAudit } from '../src/pipeline/loopAudit';
import { computeAttention } from '../src/utils/attention';
import { parseReportForDoc } from '../src/utils/examExport';
import { LLMAdapter } from '../src/providers/adapter';
import { sha256 } from '../src/utils/hash';
import { mockFolderStorage } from './fixtures/folder-storage';
import { runCorpus } from '../scripts/corpus';

const line = (n: number, text: string, page = 1): SourceLine => ({ id: `L${String(n).padStart(4, '0')}`, page, y: n * 10, text });
const lines = [line(1, 'English Exam — Grade 10 — Total 4 marks'), line(2, '1. Choose the correct word. (2 marks)'), line(3, '2. Explain the ending. (2 marks)')];
const authored = () => normalizeAuthoredDocument({ meta: { subject: 'English', grade: '10', totalPoints: 4 }, sections: [{ title: 'Vocabulary' }], questions: [
  { number: 1, sectionTitle: 'Vocabulary', type: 'mcq', stem: 'Choose the correct word.', options: [{ key: 'a', text: 'Happy' }, { key: 'b', text: 'Sad' }], points: 2, imageIds: [] },
  { number: 2, sectionTitle: 'Vocabulary', type: 'short', stem: 'Explain the ending.', options: [], points: 2, imageIds: [] },
] });
const localSettings = (extra: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  providers: [{ id: 'local', name: 'Local', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', apiKey: '', disableReasoning: true, structuredOutputs: true, extraBodyJson: '' }],
  roleMapping: { ...DEFAULT_SETTINGS.roleMapping, read: { providerId: 'local', model: 'reader' }, vision: { providerId: 'local', model: 'vision' }, decide: { providerId: 'local', model: 'decider' } },
  thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false },
  ...extra,
} as AppSettings);
const readCaller = (doc = authored()): LoopModelCaller => async req => req.step !== 'fix'
  ? { rawText: JSON.stringify(doc), json: doc, usage: { inputTokens: 10, outputTokens: 10 } }
  : { rawText: '{"corrections":[]}', json: { corrections: [] }, usage: { inputTokens: 1, outputTokens: 1 } };

test('#46 patches: replace/insert/delete by number; unknown numbers are ignored and noted', () => {
  const doc = authored();
  const corrections = parseCorrections({ rawText: JSON.stringify({ corrections: [
    { action: 'replace', questionNumber: 1, question: { number: 1, sectionTitle: 'Vocabulary', type: 'mcq', stem: 'Corrected full stem.', options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], points: 2, imageIds: [] } },
    { action: 'insert', questionNumber: 3, question: { number: 3, sectionTitle: 'Vocabulary', type: 'short', stem: 'New question.', options: [], points: 0, imageIds: [] } },
    { action: 'delete', questionNumber: 2 },
    { action: 'replace', questionNumber: 99, question: { number: 99, type: 'short', stem: 'Unknown', options: [], imageIds: [] } },
  ] }), json: undefined })!;
  const result = applyCorrections(doc, corrections);
  assert.equal(result.applied, 3);
  assert.deepEqual(result.document.questions.map(q => q.number), [1, 3]);
  assert.equal(result.document.questions[0].stem, 'Corrected full stem.');
  assert.ok(result.notes.some(note => /99 does not exist/.test(note)));
  assert.equal(doc.questions[0].stem, 'Choose the correct word.', 'input document is not mutated');
});

test('#46 code check raises duplicate-number and points-sum-mismatch comments without editing', () => {
  const doc = authored();
  doc.questions.push({ ...doc.questions[0], stem: 'Duplicate record.' });
  doc.meta.totalPoints = 9;
  const before = JSON.stringify(doc);
  const verdicts = checkAuthoredDocument(doc, []);
  assert.ok(verdicts.some(v => v.kind === 'duplicate-number' && v.questionNumbers.includes(1)));
  assert.ok(verdicts.some(v => v.kind === 'points-sum-mismatch'));
  assert.equal(JSON.stringify(doc), before, 'checkers only comment');
});

test('#46 audit: unconfigured endpoint skips with a note', async () => {
  const settings = localSettings(); settings.roleMapping.decide = undefined;
  const result = await runLoopDecisionAudit({ document: authored(), lines, images: [], settings, fileHash: 'h' });
  assert.equal(result.mode, 'skipped');
  assert.equal(result.calls, 0);
  assert.ok(result.notes.some(note => /no decide endpoint/.test(note)));
});

test('#46 audit: multimodal build sends pixels; caption-only build sends caption and candidate stems without pixels', () => {
  const image: ImageAsset = { id: 'img1', page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: 'sha', width: 10, height: 10, label: { role: 'stem', kind: 'photo', caption: 'A cat' } } as ImageAsset;
  const doc = authored(); doc.questions[0].imageIds = ['img1'];
  const payload = { id: 'img1', mime: 'image/png', data: 'aGVsbG8=' };
  const mm = buildLoopDecisionCatalogue({ document: doc, lines, images: [image], multimodal: true, imagePayloads: { img1: payload } }).find(item => item.type === 'image-belongs')!;
  const caption = buildLoopDecisionCatalogue({ document: doc, lines, images: [image], multimodal: false }).find(item => item.type === 'image-belongs')!;
  assert.deepEqual(mm.images, [payload]);
  assert.equal(caption.images, undefined);
  assert.equal(caption.input.caption, 'A cat');
  assert.ok((caption.input.candidateQuestions as any[]).length > 0);
  assert.deepEqual(caption.choices, ['this question', 'another question on the page', 'no question']);
});

test('#46/#51 audit: shadow routes nothing; active routes confident-wrong exactly once to the single Fix pass', async () => {
  const image: ImageAsset = { id: 'img1', page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: 'sha', width: 10, height: 10 } as ImageAsset;
  const decisionCaller = async (body: any) => ({ results: body.questions.map((item: any) => ({ name: item.name, probability: item.name.includes('Q1::stem-faithful') ? 0.05 : 0.95 })) });
  const shadow = await runLoopDecisionAudit({ document: authored(), lines, images: [image], settings: localSettings({ decideMode: 'shadow' }), fileHash: 'h', decisionCaller });
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.routed.length, 0);
  assert.ok(shadow.verdicts.some(v => v.probability === 0.05));
  const finalInputs: string[] = [];
  const caller: LoopModelCaller = async req => {
    if (req.step !== 'fix') return readCaller()(req);
    if (req.step === 'fix') { finalInputs.push(req.text); return { rawText: JSON.stringify({ corrections: [{ action: 'replace', questionNumber: 1, question: { ...authored().questions[0], stem: 'Audit-corrected stem.' } }] }), json: undefined }; }
    return { rawText: '{"corrections":[]}', json: { corrections: [] } };
  };
  const receipt = await runLocalLoop({ lines, images: [image], settings: localSettings({ decideMode: 'active' }), fileHash: 'h2', caller, decisionCaller });
  assert.equal(receipt.auditMode, 'active');
  const fix = receipt.steps.find(s => s.step === 'fix')!;
  assert.equal(fix.calls, 1, 'one patch pass');
  assert.equal(finalInputs.length, 1);
  assert.equal((finalInputs[0].match(/"number":1/g) || []).length, 1, 'question 1 is sent exactly once');
  assert.match(finalInputs[0], /stem-faithful/);
  assert.equal(receipt.document.questions[0].stem, 'Audit-corrected stem.');
  assert.equal(fix.correctionsApplied, 1);
});

test('#46 never-empty fault injection: every model step throws, including replayed image-payload failure; Present completes and the shell is saved', async () => {
  const storage = mockFolderStorage();
  const originalExecute = LLMAdapter.execute;
  const stages: string[] = [];
  const preExtracted: ExtractedDocument = { fileName: 'fault.pdf', lines, pages: 1, ocrUsed: false, scannedPageIndices: [], pageImages: [], pageThumbKeys: [], images: [{ id: 'img1', page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, mime: 'image/png', sha: 'sha', width: 10, height: 10, blobKey: 'sha' } as ImageAsset] };
  LLMAdapter.execute = (async () => { throw new Error('image payload replay failed'); }) as typeof LLMAdapter.execute;
  const throwingCaller: LoopModelCaller = async () => { throw new Error('image payload replay failed'); };
  try {
    const file = new File(['fault'], 'fault.pdf', { type: 'application/pdf' });
    const fileHash = await sha256(await file.arrayBuffer());
    const doc = await runFullPipeline(file, localSettings({ decideMode: 'active' }), { onStageUpdate: stage => stages.push(`${stage.id}:${stage.status}`) }, { preExtracted, fileHash, loopCaller: throwingCaller, decisionCaller: async () => { throw new Error('decisions endpoint down'); } });
    assert.ok(stages.some(stage => stage.startsWith('present:completed')), 'Present completes');
    assert.equal(doc.loop!.steps.length, 6);
    for (const step of ['map', 'parse', 'check', 'fix', 'present']) assert.ok(doc.loop!.steps.find(s => s.step === step)!.notes.length > 0, `${step} has a one-line note`);
    assert.ok(doc.source.lines.length > 0, 'extraction shell retained');
    assert.ok(storage.saved.has(doc.id), 'document saved despite every model throwing');
    assert.ok(computeAttention(doc).length > 0);
    assert.equal(parseReportForDoc(doc).loop?.steps.length, 6);
    assert.ok(!stages.some(stage => /failed/.test(stage) && stage.startsWith('present')), 'no top-level Analysis failed');
  } finally { LLMAdapter.execute = originalExecute; storage.restore(); }
});

test('#46 corpus loop mode reports every entry plus the mock against printed truth without hard gates', async () => {
  const { results, ok } = await runCorpus({ mode: 'loop', print: false });
  assert.equal(ok, true);
  assert.equal(results.length, 15); // #50 Part B added cloze-passage
  assert.ok(results.some(result => result.exam === 'mock-born-digital'));
  for (const result of results) {
    assert.match(result.recall, /^\d+\/\d+$/);
    assert.match(result.sections, /^\d+\/\d+$/);
    assert.match(result.total, /^[\d.]+\/\d+$/);
    assert.equal(result.gated, false);
    assert.deepEqual(result.failures, []);
  }
});
