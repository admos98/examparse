import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAuthoredDocument, applyCorrections, type AuthoredDocument } from '../src/pipeline/localLoop';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { assembleReadProposal } from '../src/pipeline/globalRead';
import { validateExamParseInterchange } from '../src/utils/examparseFormat';
import { buildExportDoc } from '../src/utils/examExport';
import { createQuestionBankExport } from '../src/utils/questionBankExport';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { file } from './fixtures/package-53';
import type { ExamDoc, Question } from '../src/types';

const q = (id: string, label: string, no: number, sectionId: string): Question => ({
  id, label, no, sectionId, spans: [], stem: `Question ${label}.`, type: 'mcq',
  options: [{ key: 'A', spans: [], text: 'one' }, { key: 'B', spans: [], text: 'two' }], images: [], confidence: 1,
});
const doc: ExamDoc = {
  id: 'stable-doc', fileHash: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z', displayName: 'English 12',
  meta: { title: 'English 12', subject: 'English', grade: '12', language: 'en', direction: 'ltr' },
  sections: [{ id: 's1', index: 0, title: 'Listening', spans: [] }], passages: [], questions: [q('q-55-a','55A',55,'s1')], images: [],
  source: { kind: 'pdf', fileName: 'source.pdf', lines: [], pages: 1, ocrUsed: false }, flags: [], usage: [],
};

test('standalone reader answers without source-line evidence remain proposals, not paper keys', () => {
  const authored: AuthoredDocument = {
    meta: { subject: 'English', grade: '12' }, sections: [{ title: 'Section 1' }],
    questions: [{ number: 1, sectionTitle: 'Section 1', type: 'mcq', stem: 'Choose.', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], answer: 'B', imageIds: [] }],
  };
  const projected = projectAuthoredDocument(authored);
  assert.equal(projected.questions[0].answer, undefined);
  assert.equal(projected.questions[0].enrichment?.proposedAnswer?.text, 'B');
});

test('ambiguous correction by bare number never picks or merges same-number alternatives', () => {
  const authored: AuthoredDocument = {
    meta: {}, sections: [{ title: 'Section A' }, { title: 'Section B' }], questions: [
      { id: 'a', number: 55, label: '55A', sectionTitle: 'Section A', type: 'mcq', stem: 'Alpha task.', options: [], imageIds: [] },
      { id: 'b', number: 55, label: '55B', sectionTitle: 'Section A', type: 'mcq', stem: 'Beta task.', options: [], imageIds: [] },
    ],
  };
  const result = applyCorrections(authored, [{ action: 'replace', questionNumber: 55, question: { number: 55, label: '55', type: 'mcq', stem: 'Corrected.', options: [], imageIds: [] } }]);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.document.questions.map(row => row.label), ['55A', '55B']);
  assert.ok(result.notes.some(note => /ambiguous|pick|disagree/i.test(note)));
});

test('structured JSON and ZIP publish one versioned standalone document plus a hashed asset manifest', async () => {
  const structured = buildExportDoc(doc);
  assert.equal(structured.format, 'examparse.interchange');
  assert.equal(structured.formatVersion, '1.0.0');
  assert.equal(structured.assetManifest.format, 'examparse.assets');
  const zip = await createQuestionBankExport(doc, { sourceDataset: 'standalone' });
  const jszip = (await import('jszip')).default;
  const archive = await jszip.loadAsync(zip.zip);
  const root = zip.filename.replace(/\.zip$/, '');
  assert.ok(archive.file(`${root}/examparse.json`));
  assert.ok(archive.file(`${root}/assets/manifest.json`));
  const canonical = JSON.parse(await archive.file(`${root}/examparse.json`)!.async('string'));
  assert.equal(canonical.format, 'examparse.interchange');
  assert.equal(canonical.formatVersion, '1.0.0');
  assert.equal(canonical.questions[0].label, '55A');
  assert.deepEqual(canonical.questions, structured.questions);
  assert.deepEqual(canonical.sections, structured.sections);
  assert.deepEqual(canonical.assetManifest, structured.assetManifest);
  assert.equal(validateExamParseInterchange(canonical).valid, true);
  assert.equal(canonical.teacherOnly.boundary, 'not-student-safe');
});

test('standalone canonical root reimports from the extracted folder without a bank schema', async () => {
  const base = file('batch.json', JSON.stringify({ batch_id: 'canonical', questions: [{ type: 'short_answer', label: '17C-a', title: 'Question 17C-a', stem: 'Write.', points: null }] }));
  const imported = await importQuestionPackage([base]);
  const zip = await createQuestionBankExport(imported, { sourceDataset: 'canonical' });
  const jszip = (await import('jszip')).default;
  const archive = await jszip.loadAsync(zip.zip);
  const root = zip.filename.replace(/\.zip$/, '');
  const files: any[] = [];
  for (const [path, entry] of Object.entries(archive.files)) {
    if (entry.dir) continue;
    const bytes = await (entry as any).async('uint8array');
    files.push({ name: path.split('/').pop(), webkitRelativePath: path, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type: '' });
  }
  const restored = await importQuestionPackage(files);
  assert.equal(restored.questions[0].label, '17C-a');
});


test('public raw parser does not promote reader answer spans without key-tagged source lines', () => {
  const sourceLines = [
    { id: 'L0001', page: 1, text: '1. Choose the best answer.', tag: 'question' as const },
    { id: 'L0002', page: 1, text: 'B', tag: 'option' as const },
  ];
  const result = assembleAndValidateQuestions([{ id: 'q1', no: 1, label: '1', type: 'mcq', spans: [[1, 1]], answer: { spans: [[2, 2]] }, options: [{ key: 'A', spans: [[2, 2]] }, { key: 'B', spans: [[2, 2]] }] }], sourceLines, undefined, { keyTerritoryLineNos: [2] });
  assert.equal(result.questions[0].answer, undefined);
  assert.ok(result.flags.some(flag => flag.code === 'ANSWER_SOURCE_EVIDENCE_MISSING'));
});

test('global reader answer-key text stays a proposal unless its spans bind to key-tagged lines', () => {
  const sourceLines = [
    { id: 'L0001', page: 1, text: 'Explain the idea.', tag: 'question' as const },
    { id: 'L0002', page: 1, text: 'A reader assertion, not a printed key.', tag: 'keep' as const },
  ];
  const proposal: any = { questions: [{ no: 1, section: 's1', spans: [[1, 1]], type: 'short', answerSpans: [[2, 2]] }], answerKey: { '1': { value: 'model assertion' } }, sections: [{ id: 's1', title: 'Section 1', spans: [[1, 1]] }], labels: new Map() };
  const projected = assembleReadProposal(proposal, sourceLines).questions[0];
  assert.equal(projected.answer, undefined);
  assert.equal(projected.enrichment?.proposedAnswer?.text, 'A reader assertion, not a printed key.');
});

test('canonical package records bundled asset SHA/MIME, teacher script boundary, and reimports both', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
  const imageDoc = structuredClone(doc);
  imageDoc.images = [{ id: 'img-1', page: 1, bbox: { x: 1, y: 2, w: 3, h: 4 }, mime: 'image/png', sha: '', width: 1, height: 1, blobKey: 'asset-test', dataUrl: `data:image/png;base64,${btoa(binary)}` }];
  imageDoc.questions[0].images = [{ imageId: 'img-1', role: 'stem' }];
  imageDoc.questions[0].imported = { script: 'The teacher-only script says wait for the bus.', scriptNote: 'Source handout.' };
  const exported = await createQuestionBankExport(imageDoc, { sourceDataset: 'standalone' });
  const jszip = (await import('jszip')).default; const archive = await jszip.loadAsync(exported.zip); const root = exported.filename.replace(/\.zip$/, '');
  const canonical = JSON.parse(await archive.file(`${root}/examparse.json`)!.async('string'));
  const asset = canonical.assetManifest.assets.find((row: any) => row.sourceIds?.includes('img-1'));
  assert.equal(asset.state, 'available'); assert.equal(asset.mime, 'image/png'); assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.equal(asset.path, `assets/${asset.sha256}.png`);
  assert.ok(archive.file(`${root}/${asset.path}`));
  assert.equal(canonical.questions[0].imported.script, undefined);
  assert.equal(canonical.teacherOnly.listeningScripts[0].text, 'The teacher-only script says wait for the bus.');
  const files: any[] = [];
  for (const [path, entry] of Object.entries(archive.files)) { if ((entry as any).dir) continue; const content = await (entry as any).async('uint8array'); files.push({ name: path.split('/').pop(), webkitRelativePath: path, text: async () => new TextDecoder().decode(content), arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength), type: '' }); }
  const restored = await importQuestionPackage(files);
  assert.equal(restored.questions[0].imported?.script, 'The teacher-only script says wait for the bus.');
  assert.equal(restored.images.find(image => image.id === 'img-1')?.dataUrl?.startsWith('data:image/png;base64,'), true);
  const withoutPixels = await importQuestionPackage(files.filter(file => !String(file.webkitRelativePath).endsWith(`/${asset.path}`)));
  assert.equal(withoutPixels.images.find(image => image.id === 'img-1')?.storageMissing, true);
  assert.ok((withoutPixels as any).completeness?.issues?.some((issue: any) => issue.code === 'asset-unavailable-on-import'));
});

test('JSON-only inline option pixels are scrubbed but retain pending ownership; ZIP materializes the same option asset', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 5, 6, 7]);
  let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
  const imageDoc = structuredClone(doc);
  imageDoc.questions[0].options![0].text = `data:image/png;base64,${btoa(binary)}`;
  const structured = buildExportDoc(imageDoc);
  assert.doesNotMatch(JSON.stringify(structured), /data:image\/png;base64,/i);
  assert.ok(structured.questions[0].options[0].imageRefs?.length);
  assert.equal(structured.assetManifest.assets[0].state, 'reference-only');
  assert.equal(structured.assetManifest.assets[0].references[0].location, 'option');
  assert.equal(validateExamParseInterchange(structured).valid, true);

  const exported = await createQuestionBankExport(imageDoc, { sourceDataset: 'option-image' });
  const jszip = (await import('jszip')).default; const archive = await jszip.loadAsync(exported.zip); const root = exported.filename.replace(/\.zip$/, '');
  const canonical = JSON.parse(await archive.file(`${root}/examparse.json`)!.async('string'));
  const option = canonical.questions[0].options[0];
  assert.equal(option.imageRefs.length, 1);
  const asset = canonical.assetManifest.assets.find((row: any) => row.id === option.imageRefs[0]);
  assert.equal(asset.state, 'available'); assert.equal(asset.references[0].location, 'option');
  assert.ok(archive.file(`${root}/${asset.path}`));
});

test('missing saved pixels survive as unavailable assets with owner identity and explicit completeness issues', () => {
  const missing = structuredClone(doc);
  missing.images = [{ id: 'lost-pixels', page: 3, bbox: { x: 0, y: 0, w: 1, h: 1 }, mime: 'image/png', sha: '', width: 0, height: 0, blobKey: 'lost', storageMissing: true }];
  missing.questions[0].images = [{ imageId: 'lost-pixels', role: 'stem' }];
  const output = buildExportDoc(missing);
  const asset = output.assetManifest.assets.find((row: any) => row.sourceIds?.includes('lost-pixels'));
  assert.equal(asset.state, 'unavailable'); assert.equal(asset.path, null);
  assert.equal(asset.references[0].questionId, 'q-55-a');
  assert.ok(output.completeness.issues.some((issue: any) => issue.assetId === asset.id || issue.assetId === 'lost-pixels'));
});

test('bank-independent native ZIP is a complete canonical import even with no assets or legacy batch', async () => {
  const { createStandaloneExamParseZip } = await import('../src/utils/examparseZip');
  const standalone = await createStandaloneExamParseZip(doc);
  const jszip = (await import('jszip')).default; const archive = await jszip.loadAsync(standalone.zip);
  assert.ok(archive.file(`${standalone.root}/examparse.json`));
  assert.ok(archive.file(`${standalone.root}/assets/manifest.json`));
  assert.equal(archive.file(`${standalone.root}/batch.json`), null);
  const files: any[] = [];
  for (const [path, entry] of Object.entries(archive.files)) {
    if ((entry as any).dir) continue;
    const content = await (entry as any).async('uint8array');
    files.push({ name: path.split('/').pop(), webkitRelativePath: path, text: async () => new TextDecoder().decode(content), arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength), type: '' });
  }
  const { importPackageFolder } = await import('../src/pipeline/packageBatchImport');
  const saved: ExamDoc[] = [];
  const result = await importPackageFolder(files, [], async value => { saved.push(value); });
  assert.equal(result.imported, 1); assert.equal(result.failed, 0); assert.equal(result.notPackage, 0);
  assert.equal(saved[0].questions[0].id, 'q-55-a'); assert.equal(saved[0].questions[0].label, '55A');
});

test('legacy AI answers migrate out of nested executable fields before canonical export', () => {
  const nested = structuredClone(doc);
  const child = q('q-55-a-child', '55A-a', 55, 's1');
  child.answer = { source: 'ai', text: 'B' };
  nested.questions[0].subQuestions = [child];
  const output = buildExportDoc(nested);
  const projectedChild = output.questions[0].subQuestions[0];
  assert.equal(projectedChild.answer, undefined);
  assert.equal(projectedChild.enrichment.proposedAnswer.text, 'B');
  assert.equal(projectedChild.enrichment.proposedAnswer.source, 'model');
});

test('absent model points remain unpriced instead of becoming numeric zero', async () => {
  const { normalizeAuthoredQuestion } = await import('../src/pipeline/localLoop');
  const projected = normalizeAuthoredQuestion({ number: 9, type: 'short', stem: 'Explain.', options: [], imageIds: [] });
  assert.equal(projected?.points, undefined);
});


test('versioned validator rejects asset paths that escape the ZIP root', () => {
  const unsafe: any = buildExportDoc(doc);
  unsafe.assetManifest.assets.push({ id: 'asset_bad', sourceIds: ['bad'], sha256: 'a'.repeat(64), mime: 'image/png', path: '../secret.png', state: 'available', references: [] });
  assert.equal(validateExamParseInterchange(unsafe).valid, false);
  assert.ok(validateExamParseInterchange(unsafe).errors.some(error => /safe relative path|path\/hash/i.test(error)));
});
