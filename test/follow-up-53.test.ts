import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { enrichPackage, lessonRanking } from '../src/pipeline/packageEnrichment';
import { DEFAULT_SETTINGS } from '../src/store';
import { createQuestionBankExport } from '../src/utils/questionBankExport';
import { computeAttention, unplacedImages } from '../src/utils/attention';
import { curriculumLessons } from '../src/pipeline/curriculumHints';
import { authoredPackage, file, passage, png, png2, provenance } from './fixtures/package-53';

const settings = { ...DEFAULT_SETTINGS, decideMultimodal: false, providers: [{ id: 'd', name: 'judge', kind: 'openai-compatible' as const, baseURL: 'http://localhost:8080', apiKey: '', decideDialect: 'thx' as const }], roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId: 'd', model: 'judge' } } };
const imported = () => importQuestionPackage([file('package.json', JSON.stringify(authoredPackage())), file('images/question-7.png', png), file('images/questions-39-40.png', png2), file('images/unassigned.png', Uint8Array.from([...png, 9]))]);

test('#53 authored package: passages, metadata, SHA dedupe, explicit ownership and tray', async () => {
 const doc = await imported();
 assert.equal(doc.source.kind, 'package'); assert.equal(doc.questions.length, 9); assert.equal(doc.sections[0].title, 'Imported questions');
 assert.equal(doc.passages?.length, 1); assert.equal(doc.passages?.[0].text, passage);
 assert.equal(JSON.stringify(doc).split(passage).length - 1, 1);
 assert.ok(doc.questions.slice(3,6).every(q => q.passageId === doc.passages![0].id && !q.stem!.includes(passage)));
 assert.equal(doc.images.length, 3); assert.equal(doc.questions[6].images.length, 1);
 assert.equal(doc.questions[6].images[0].imageId, doc.images.find(i => i.sha === createHash('sha256').update(png).digest('hex'))?.id);
 assert.equal(doc.questions[7].images[0].imageId, doc.questions[8].images[0].imageId);
 assert.equal(unplacedImages(doc).length, 1); assert.equal(doc.questions[1].points, null); assert.equal(doc.questions[1].imported?.answer_key, null); assert.equal(doc.questions[1].answer, undefined);
 assert.deepEqual(doc.questions[0].imported?.provenance, provenance); assert.doesNotMatch(JSON.stringify(doc.questions), /data:image/);
});

test('#53 Appendix A stem blocks use asset SHA and preserve null fields', async () => {
 const batch = authoredPackage(); const hash = createHash('sha256').update(png).digest('hex');
 const row: any = batch.questions[6]; delete row.stem; row.stem_blocks = [{ t: 'text', v: 'Which picture?' }, { t: 'img', asset: hash }];
 const doc = await importQuestionPackage([file('batch.json', JSON.stringify(batch)), file(`assets/${hash}.png`, png)]);
 assert.equal(doc.questions.length, 9); assert.equal(doc.images.length, 1); assert.equal(doc.questions[6].images[0].imageId, doc.images[0].id);
 assert.equal(doc.passages?.[0].text, passage); assert.equal(doc.questions[1].points, null); assert.deepEqual(doc.questions[0].imported?.provenance, provenance);
});

test('#53 lesson distributions are derived in code', () => {
 assert.deepEqual(lessonRanking({ one:.55, two:.30, three:.05 }).lessons, [{lesson:'one',probability:.55}, {lesson:'two',probability:.30}]);
 assert.equal(lessonRanking({ one:.55, two:.30, three:.05 }).origin, 'multi');
 assert.equal(lessonRanking({ one:.8, two:.1 }).origin, 'single');
 assert.equal(lessonRanking({ one:.2, two:.18 }).origin, 'beyond-book');
 assert.equal(lessonRanking({ "not from this textbook's lessons":.6, one:.3 }).origin, 'beyond-book');
});

for (const [label, choice, probability, distribution, verification] of [
 ['agree', 'A', .8, undefined, 'verified'], ['disagree', 'B', .8, undefined, 'disagreed'], ['flat', 'A', .25, { A:.25, B:.25, C:.25, D:.25 }, 'uncertain'],
] as const) test(`#53 blind verification ${label}; immutable keys; reading precedes demand`, async () => {
 const doc = await imported(); const original = JSON.stringify(doc.questions.map(q => q.imported?.answer_key)); const bodies: any[] = [];
 const lessons = curriculumLessons('10', 'English');
 const result = await enrichPackage(doc, settings, { decisionCaller: async body => {
   bodies.push(body); const [name] = Object.keys(body.questions);
   if (name.includes('blind-answer')) return { results: [{ name, probability, choice, distribution }] };
   if (name.includes('lessons')) return { results: [{ name, probability:.55, choice:lessons[0].title, distribution:{ [lessons[0].title]:.55,[lessons[1].title]:.30,[lessons[2].title]:.05 } }] };
   if (name.includes('reading-mode')) return { results: [{name, probability:.8, choice:'direct-finding', distribution:{'direct-finding':.8,comprehension:.2}}] };
   if (name.includes('demand')) return { results: [{name, probability:.7, choice:'inference', distribution:{recall:.1,comprehension:.2,inference:.7}}] };
   return { results: [{name, probability:.9}] };
 } });
 assert.equal(result.questions[0].enrichment?.verification, verification); assert.equal(JSON.stringify(result.questions.map(q => q.imported?.answer_key)), original);
 const blind = bodies.filter(b => Object.keys(b.questions)[0].includes('blind-answer'));
 assert.ok(blind.length); for (const b of blind) { assert.doesNotMatch(JSON.stringify(b), /answer_key|provenance|expectedChoice|"correct"/); assert.match(b.state, /alpha/); }
 assert.equal(result.questions[0].enrichment?.origin, 'multi'); assert.equal(result.questions[0].enrichment?.lessons?.length, 2);
 const names = bodies.map(b => Object.keys(b.questions)[0]); assert.ok(names.indexOf('q_4 reading-mode') < names.indexOf('q_4 demand'));
 assert.equal(result.questions[3].enrichment?.readingMode?.value, 'direct-finding'); assert.equal(result.questions[3].enrichment?.demand?.value, 'comprehension'); assert.equal(result.questions[3].enrichment?.demand?.probability, .2);
 assert.equal(result.questions[6].enrichment?.imagePlacement?.[0].state, 'skipped-no-evidence'); assert.ok(!names.some(n => n.includes('image-placement')));
 assert.equal(result.flags.filter(f => f.message.includes('disagrees')).length > 0, verification === 'disagreed');
 if (verification === 'disagreed') assert.ok(computeAttention(result).some(i => i.plainSentence.includes('disagrees')));
});

test('#53 missing provider and endpoint failures remain usable, never guess image verdict', async () => {
 const doc = await imported(); const noProvider = await enrichPackage(doc, { ...settings, roleMapping: { ...settings.roleMapping, decide: undefined } });
 assert.equal(noProvider.source.enrichmentStatus, 'not run'); assert.equal(noProvider.questions.length, doc.questions.length);
 const failed = await enrichPackage(doc, { ...settings, decideMultimodal: true }, { decisionCaller: async () => { throw new Error('connection refused'); } });
 assert.equal(failed.source.enrichmentStatus, 'not run'); assert.equal(failed.questions[6].enrichment?.imagePlacement?.[0].state, 'skipped-no-evidence');
});

test('#53 bank export respects lesson threshold, teacher confirmation and passage, never maps demand to difficulty', async () => {
 const doc = await imported();
 doc.questions[0].enrichment = { source:'model', verification:'disagreed', lessons:[{lesson:'model lesson', probability:.55}], demand:{value:'inference',probability:.9} };
 doc.questions[1].enrichment = { source:'model', verification:'unjudged', lessons:[{lesson:'weak', probability:.49}], teacherLesson:{lesson:'teacher lesson', source:'teacher'} };
 const result = await createQuestionBankExport(doc, { sourceDataset:'synthetic' }, async image => new Blob([image.sha === createHash('sha256').update(png).digest('hex') ? png : png2]));
 assert.equal(result.batch.questions[0].curriculum_hints.lesson, null); // #55 requires a margin-qualified write-back, not a top-score guess. assert.equal(result.batch.questions[1].curriculum_hints.lesson, 'teacher lesson');
 assert.equal(result.batch.questions[0].difficulty, undefined); assert.deepEqual(result.batch.questions[0].answer_key, { correct:['1'], grading:'auto' });
 assert.equal(result.batch.questions[1].answer_key, undefined); assert.match(result.batch.questions[3].stem!, /traveller/);
 assert.equal(result.batch.questions[0].enrichment?.origin, undefined);
});

test('#53 multimodal picture choice sends pixels and uses illustrative-scene criterion', async () => {
 const doc = await imported(); doc.questions = [doc.questions[6]]; doc.images = [doc.images.find(i => i.id === doc.questions[0].images[0].imageId)!]; const calls: any[] = [];
 const result = await enrichPackage(doc, { ...settings, decideMultimodal: true }, { decisionCaller: async body => {
   calls.push(body); const name = Object.keys(body.questions)[0];
   if (name.includes('image-placement')) return { results: [{ name, probability: .9, choice: 'B' }] };
   if (name.includes('blind-answer')) return { results: [{ name, probability: .9, choice: 'A' }] };
   if (name.includes('lessons')) return { results: [] };
   if (name.includes('demand')) return { results: [{ name, probability: .9, choice: 'recall' }] };
   return { results: [{ name, probability: .9 }] };
 } });
 const imageCall = calls.find(b => Object.keys(b.questions)[0].includes('image-placement'));
 assert.ok(imageCall.images[0].startsWith('data:image/png;base64,')); assert.match(Object.values(imageCall.questions)[0] as any && (Object.values(imageCall.questions)[0] as any).instructions, /typical illustrative scene/);
 assert.equal(result.questions[0].enrichment?.imagePlacement?.[0].state, 'disagreed'); assert.ok(result.flags.some(f => /Image may belong/.test(f.message)));
});

test('#53 absent listening script produces one exam note and skips only answer votes', async () => {
 const doc = await imported(); doc.questions = doc.questions.slice(0,2); doc.questions.forEach(q => { q.stem = 'Listen to the audio and answer.'; }); const calls: any[] = [];
 const result = await enrichPackage(doc, settings, { decisionCaller: async body => { calls.push(body); return { results: [] }; } });
 assert.ok(calls.some(b => Object.keys(b.questions)[0].includes('complete'))); assert.ok(!calls.some(b => Object.keys(b.questions)[0].includes('blind-answer'))); assert.equal(result.source.enrichmentNotes?.filter(n => n.includes('Listening')).length, 1);
});

test('#53 package persists in the folder library and reopens with assets', { timeout: 30000 }, async () => {
 const { spawn } = await import('node:child_process');
 const net = await import('node:net'); const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
 const { saveExamDoc, loadExamDoc, listExamSummaries } = await import('../src/store');
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package53-')); const listener = net.createServer();
 listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = (listener.address() as import('node:net').AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
 const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', PORT: String(port), EXAMFORGE_DATA_DIR: '', EXAMPARSE_CONFIG_FILE: path.join(root, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
 const originalFetch = globalThis.fetch;
 try {
  await new Promise<void>((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error(`Server timeout ${output}`)), 15000);
   child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ExamParse server running')) { clearTimeout(timer); resolve(); } });
   child.stderr.on('data', chunk => { output += String(chunk); }); child.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); }); });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await originalFetch(base + '/api/storage/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({dir:path.join(root, 'data')}) })).status, 200);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => originalFetch(typeof input === 'string' && input.startsWith('/') ? base + input : input, init)) as typeof fetch;
  const doc = await imported(); await saveExamDoc(doc);
  assert.ok((await listExamSummaries()).some(s => s.id === doc.id));
  const reopened = await loadExamDoc(doc.id); assert.equal(reopened?.source.kind, 'package'); assert.equal(reopened?.questions.length, 9); assert.equal(reopened?.questions[1].points, null);
  assert.ok(reopened?.images.every(image => image.dataUrl?.startsWith('/api/images/')));
  const exported = await createQuestionBankExport(reopened!, { sourceDataset:'synthetic' }); assert.equal(exported.batch.questions.length, 9); assert.equal(exported.report.asset_count, 2);
 } finally { globalThis.fetch = originalFetch; child.kill('SIGTERM'); await fs.rm(root, { recursive:true, force:true }); }
});

test('#53 JEV blind requests withhold the key and accept full lesson distributions', async () => {
 const doc = await imported(); doc.questions = [doc.questions[0]]; doc.images = [];
 const jev = { ...settings, providers: [{ ...settings.providers[0], decideDialect: 'jev' as const }] }; const calls: any[] = [];
 const lessons = curriculumLessons('10', 'English');
 const result = await enrichPackage(doc, jev, { decisionCaller: async body => {
   calls.push(body); const item = body.questions[0];
   if (item.name.includes('blind-answer')) return { results: [{name:item.name, choice:'B', probability:.8}] };
   if (item.name.includes('lessons')) return { results: [{name:item.name, choice:lessons[0].title, probability:.8, distribution:{[lessons[0].title]:.8,[lessons[1].title]:.1}}] };
   if (item.name.includes('demand')) return { results: [{name:item.name, choice:'recall', probability:.8}] };
   return { results: [{name:item.name, probability:.9}] };
 } });
 const blind = calls.find(b => b.questions[0].name.includes('blind-answer'));
 assert.doesNotMatch(JSON.stringify(blind), /answer_key|provenance|expectedChoice|"correct"/);
 assert.deepEqual(blind.questions[0].choices, ['A','B','C','D']);
 assert.equal(result.questions[0].enrichment?.verification, 'disagreed'); assert.equal(result.questions[0].enrichment?.origin, 'single');
});
