import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { z } from 'zod';
import { createQuestionBankExport } from '../src/utils/questionBankExport';
import { tagBankQuestions } from '../src/pipeline/bankTagging';
import { DEFAULT_SETTINGS } from '../src/store';
import type { ExamDoc, Question, ImageAsset } from '../src/types';
import { createHash } from 'node:crypto';

const options = [{ key: 'a', text: 'cat', spans: [] }, { key: 'b', text: 'dog', spans: [] }];
const q = (no: number, extra: Partial<Question> = {}): Question => ({ id: `q${no}`, label: String(no), no, type: 'mcq', stem: `Question ${no}`, sectionId: 's', spans: [], options, images: [], confidence: 1, ...extra });
const image = (id: string): ImageAsset => ({ id, page: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, mime: 'image/png', sha: '', width: 1, height: 1, blobKey: id });
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,1,2,3]);
const doc = (): ExamDoc => ({ id: 'e', fileHash: 'x', createdAt: '', displayName: 'Exam', meta: { title: 'Official English exam', subject: 'English', grade: '10', year: '1402', language: 'en', direction: 'ltr' }, sections: [{ id: 's', index: 1, title: 'Vocabulary', spans: [] }], questions: [
 q(1, { stem: 'Look at the picture below', images: [{ imageId: 'i1', role: 'stem' }], answer: { source: 'paper', text: 'B' }, points: 1, difficulty: { value: 3, source: 'model' }, difficultyMode: 'shadow' }),
 q(2, { images: [{ imageId: 'i2', role: 'stem' }], answer: { source: 'paper', text: 'unknown' } }),
 q(3, { answer: { source: 'ai', text: 'a' }, images: [{ imageId: 'i3', role: 'option' }] }),
 q(4, { type: 'essay', options: [], points: undefined, stem: 'Explain.' }),
], images: [image('i1'), image('i2'), image('i3')], source: { lines: [], pages: 1, ocrUsed: false, fileName: 'exam.pdf' }, flags: [], usage: [] });
const schema = z.object({ batch_id: z.string().uuid(), source_dataset: z.string().min(1), questions: z.array(z.object({
 type: z.enum(['multiple_choice','true_false','short_answer','long_answer','fill_in_blank','matching','ordering']), title: z.string(), stem: z.string().optional(),
 stem_blocks: z.array(z.union([z.object({ t: z.literal('text'), v: z.string() }), z.object({ t: z.literal('img'), asset: z.string().regex(/^[0-9a-f]{64}$/) })])).optional(),
 options: z.array(z.object({ key: z.string().regex(/^[1-9]\d*$/), text: z.string() })).optional(),
 answer_key: z.object({ correct: z.array(z.string().regex(/^[1-9]\d*$/)), grading: z.literal('auto') }).optional(),
 explanation: z.null(), points: z.number().nullable(), grade: z.string(), subject: z.string(),
 curriculum_hints: z.object({ chapter: z.string().nullable(), lesson: z.string().nullable(), topic: z.string().nullable() }),
 difficulty: z.object({ value: z.number().int().min(1).max(5), source: z.literal('model') }).optional(),
 provenance: z.object({ source_type: z.enum(['authored','official_cited']), source_url: z.null(), source_ref: z.string().nullable() }), tags: z.array(z.string()),
}).refine(v => (v.stem === undefined) !== (v.stem_blocks === undefined)).refine(v => v.provenance.source_type !== 'official_cited' || !!v.provenance.source_ref)) });

test('batch follows Appendix A, deduplicates and verifies binary assets, and never invents answer keys', async () => {
 const exam = doc();
 const result = await createQuestionBankExport(exam, { sourceDataset: 'english-konkur-1402', sourceRef: 'Official English exam — 1402', includeModelDifficulty: true }, async () => new Blob([png]));
 schema.parse(result.batch); assert.equal(result.batch.questions.length, 4);
 const [first, second, third, fourth] = result.batch.questions;
 assert.equal(first.stem, undefined); assert.equal(first.stem_blocks?.[0].t, 'img');
 assert.deepEqual(first.options?.map(o => o.key), ['1','2']); assert.deepEqual(first.answer_key, { correct: ['2'], grading: 'auto' });
 assert.equal(second.answer_key, undefined); assert.equal(third.answer_key, undefined);
 assert.deepEqual(result.report.needs_answer_key.map(x => x.question), ['Q2','Q3']);
 assert.equal(result.report.asset_count, 1); assert.equal(result.report.total_bytes, png.length);
 // #58 — a picture option is never faked as a text option: the option text stays the printed
 // text, the asset ships, and the question carries an explicit unsupported-option-image state.
 assert.deepEqual(result.report.image_options, ['Q3']);
 assert.equal(third.options![0].text, 'cat');
 assert.deepEqual(third.unsupported_option_images, ['1']);
 assert.ok(third.tags.includes('option_image_unsupported'));
 assert.ok(result.report.contract.pending.some(entry => entry.kind === 'picture-option'));
 // #57 Part A — essay/paragraph/writing travel as bank long_answer; short_answer stays short_answer.
 assert.equal(fourth.type, 'long_answer'); assert.equal(fourth.points, null);
 assert.equal(result.report.images_placed, 1); assert.equal(result.report.image_references, 2);
 assert.deepEqual(first.difficulty, { value: 3, source: 'model' });
 const zip = await JSZip.loadAsync(result.zip); const root = result.filename.replace(/\.zip$/, '');
 const hash = createHash('sha256').update(png).digest('hex');
 assert.deepEqual(await zip.file(`${root}/assets/${hash}.png`)!.async('uint8array'), png);
 assert.equal(Object.keys(zip.files).filter(k => /assets\/[^/]+\.png$/.test(k)).length, 1);
 // #57 Part C — v1.1 manifest: asset id → file, sha, mime, byte size (content-addressed).
 const manifest = JSON.parse(await zip.file(`${root}/assets/manifest.json`)!.async('string'));
 assert.equal(manifest.format, 'examparse.assets');
 assert.equal(manifest.assets.length, 1);
 assert.equal(manifest.assets[0].sha256, hash);
 assert.deepEqual(manifest.assets[0].references.map((ref: any) => ref.questionId).sort(), ['q1', 'q2', 'q3']);
 assert.ok(manifest.assets.every((a: any) => a.path === `assets/${hash}.png` && a.sha256 === hash && a.mime === 'image/png'));
 assert.deepEqual(JSON.parse(await zip.file(`${root}/export-report.json`)!.async('string')), result.report);
 assert.deepEqual(JSON.parse(await zip.file(`${root}/batch.json`)!.async('string')), result.batch);
 const secondExport = await createQuestionBankExport(exam, { sourceDataset: 'english-konkur-1402', includeModelDifficulty: false }, async () => new Blob([png]));
 assert.notEqual(result.batch.batch_id, secondExport.batch.batch_id); assert.equal(secondExport.batch.questions[0].difficulty, undefined);
});

test('#57/#58 missing images export with explicit missing-asset markers and explicit official refs cannot be blank', async () => {
 // #58 — official provenance is explicit, never inferred from a title.
 const official = doc(); (official.meta as any).official = true;
 await assert.rejects(() => createQuestionBankExport(official, { sourceDataset: 'dataset', sourceRef: '' }, async () => new Blob([png])), /source reference/);
 const titled = doc();
 assert.equal((await createQuestionBankExport(titled, { sourceDataset: 'dataset' }, async () => new Blob([png]))).batch.questions[0].provenance.source_type, 'authored', 'a title never turns a paper official');
 // #57 Part C — unavailable pixels never fail the export and never leave a silent token.
 const result = await createQuestionBankExport(doc(), { sourceDataset: 'dataset' }, async () => undefined);
 assert.deepEqual(result.report.missing_assets.map(entry => entry.image), ['i1', 'i2']);
 assert.equal(result.report.images_placed, 0);
 assert.equal(result.report.image_references, 2);
 assert.ok(result.report.notes.some(note => /retained in metadata/.test(note)));
 // #58 — an unresolved reference is retained as metadata, never rendered as a student image block.
 assert.equal(result.batch.questions.slice(0, 2).flatMap(row => row.stem_blocks || []).filter(block => block.t === 'img').length, 0, 'no broken image block reaches the student content');
 assert.deepEqual(result.batch.questions[0].unresolved_placeholders?.map(entry => entry.asset), ['i1']);
 assert.deepEqual(result.batch.questions[1].unresolved_placeholders?.map(entry => entry.asset), ['i2']);
 const zip = await JSZip.loadAsync(result.zip);
 const batchText = await zip.file(`${result.filename.replace(/\.zip$/, '')}/batch.json`)!.async('string');
 assert.doesNotMatch(batchText, /img_[0-9a-f]{16,}/i, 'no placeholder token ever appears in an export');
});

test('#58 an uncertain audit adds review attention but never erases a genuine source answer', async () => {
 const exam = doc(); exam.questions = [q(1, { answer: { source: 'paper', text: 'a' } })]; exam.images = [];
 exam.loop = { auditVerdicts: [{ id:'a', kind:'answer-correct', source:'decision', questionNumbers:[1], probability: .5, message:'' }] } as any;
 const result = await createQuestionBankExport(exam, { sourceDataset: 'dataset' });
 // The source key survives (a judge estimate is not proof), and the row is flagged for review.
 assert.deepEqual(result.batch.questions[0].answer_key, { correct: ['1'], grading: 'auto' });
 assert.ok(result.batch.questions[0].tags.includes('answer_key_needs_review'));
 assert.equal(result.report.needs_answer_key.length, 0);
});

test('export-time tagging uses keyword first and only asks choices for ambiguous active questions', async () => {
 const exam = doc(); exam.questions = [q(1, { stem: 'Protect endangered wildlife and forest habitat', options: [] }), q(2, { stem: 'Choose the right word', options: [] })]; exam.images = [];
 const provider = { id: 'llama', name: 'local', kind: 'openai-compatible' as const, baseURL: 'http://localhost:8080', apiKey: '', decideDialect: 'thx' as const };
 const settings = { ...DEFAULT_SETTINGS, decideMode: 'active' as const, providers: [provider], roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId: 'llama', model: 'x' } } };
 const calls: any[] = []; const updates: any[] = [];
 const tagged = await tagBankQuestions({ doc: exam, settings, includeModelDifficulty: true, onProgress: p => updates.push(p), decisionCaller: async body => {
  calls.push(body); const [name, question] = Object.entries(body.questions)[0] as [string, any];
  return { results: [{ name, probability: .75, choice: question.type === 'score' ? '4' : 'Saving Nature' }] };
 } });
 assert.equal(exam.questions[0].difficulty, undefined, 'input remains unchanged');
 assert.deepEqual(tagged.doc.questions[0].difficulty, { value: 4, source: 'model' });
 assert.equal(tagged.doc.questions[0].curriculumSource, 'keyword'); assert.equal(tagged.doc.questions[1].curriculumSource, 'decision');
 assert.equal(calls.filter(c => Object.values(c.questions)[0] && (Object.values(c.questions)[0] as any).type === 'choice').length, 1);
 assert.equal(updates.at(-1).completed, 2);
});
