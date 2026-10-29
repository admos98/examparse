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
 type: z.enum(['multiple_choice','true_false','short_answer','fill_in_blank','matching','ordering']), title: z.string(), stem: z.string().optional(),
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
 assert.deepEqual(result.report.image_options, ['Q3']); assert.match(third.options![0].text, /Image option/);
 assert.equal(fourth.type, 'short_answer'); assert.equal(fourth.points, null);
 assert.deepEqual(first.difficulty, { value: 3, source: 'model' });
 const zip = await JSZip.loadAsync(result.zip); const root = result.filename.replace(/\.zip$/, '');
 const hash = createHash('sha256').update(png).digest('hex');
 assert.deepEqual(await zip.file(`${root}/assets/${hash}.png`)!.async('uint8array'), png);
 assert.equal(Object.keys(zip.files).filter(k => /assets\/[^/]+\.png$/.test(k)).length, 1);
 assert.deepEqual(JSON.parse(await zip.file(`${root}/export-report.json`)!.async('string')), result.report);
 assert.deepEqual(JSON.parse(await zip.file(`${root}/batch.json`)!.async('string')), result.batch);
 const secondExport = await createQuestionBankExport(exam, { sourceDataset: 'english-konkur-1402', includeModelDifficulty: false }, async () => new Blob([png]));
 assert.notEqual(result.batch.batch_id, secondExport.batch.batch_id); assert.equal(secondExport.batch.questions[0].difficulty, undefined);
});

test('missing images fail safely and official refs cannot be blank', async () => {
 await assert.rejects(() => createQuestionBankExport(doc(), { sourceDataset: 'dataset', sourceRef: '' }, async () => new Blob([png])), /source reference/);
 await assert.rejects(() => createQuestionBankExport(doc(), { sourceDataset: 'dataset' }, async () => undefined), /unavailable/);
});

test('answer audit uncertainty prevents exporting a key', async () => {
 const exam = doc(); exam.questions = [q(1, { answer: { source: 'paper', text: 'a' } })]; exam.images = [];
 exam.loop = { auditVerdicts: [{ id:'a', kind:'answer-correct', source:'decision', questionNumbers:[1], probability: .5, message:'' }] } as any;
 const result = await createQuestionBankExport(exam, { sourceDataset: 'dataset' });
 assert.equal(result.batch.questions[0].answer_key, undefined); assert.equal(result.report.needs_answer_key.length, 1);
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
