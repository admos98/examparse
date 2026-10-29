import test from 'node:test';
import assert from 'node:assert/strict';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { enrichPackage } from '../src/pipeline/packageEnrichment';
import { normalizeIdentity } from '../src/pipeline/identity';
import { stemEndsMidWordOrSentence, hasEmptyOrPlaceholderOption, referencesAbsentMaterial, markedlyShorterThanSource } from '../src/pipeline/completenessCorroboration';
import { curriculumLessons } from '../src/pipeline/curriculumHints';
import { computeAttention } from '../src/utils/attention';
import { buildExportDoc } from '../src/utils/examExport';
import { createQuestionBankExport } from '../src/utils/questionBankExport';
import { DEFAULT_SETTINGS } from '../src/store';
import { authoredPackage, file, png2 } from './fixtures/package-53';

const settings = { ...DEFAULT_SETTINGS, decideMultimodal: true, providers: [{ id: 'd', name: 'judge', kind: 'openai-compatible' as const, baseURL: 'http://localhost:8080', apiKey: '', decideDialect: 'thx' as const }], roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId: 'd', model: 'judge' } } };
async function load(batch: any, image = false) { return importQuestionPackage([file('batch.json', JSON.stringify(batch)), ...(image ? [file('images/questions-39-40.png', png2)] : [])]); }
function judge(calls: string[], complete = .9) {
 return async (body: any) => {
  const name = Object.keys(body.questions)[0]; calls.push(name);
  const choices = (body.questions[name] as any).choices;
  if (name.includes('lessons')) { const lesson = curriculumLessons('12', 'English')[0].title; return {results:[{name, choice:lesson, probability:.8, distribution:{[lesson]:.8}}]}; }
  if (name.includes('blind-answer') || name.includes('image-placement')) return {results:[{name, choice:'A', probability:.91}]};
  if (name.includes('demand')) return {results:[{name, choice:'recall', probability:.8}]};
  if (name.includes('reading-mode')) return {results:[{name, choice:'direct-finding', probability:.8}]};
  return {results:[{name, probability:complete}]};
 };
}

test('#54 normalize identity and rank using canonical meta, retaining provenance', async () => {
 for (const grade of ['english_12th_grade', 'Grade 12', '12th Grade', 'grade_12']) assert.deepEqual(normalizeIdentity(grade, 'english'), {grade:'12', gradeDisplay:'12th Grade', subject:'English'});
 const batch = authoredPackage(); batch.questions = [batch.questions[0]]; batch.questions[0].grade = 'english_12th_grade'; batch.questions[0].subject = 'english';
 const doc = await load(batch); assert.equal(doc.meta.title, 'English — 12th Grade'); assert.equal(doc.meta.grade, '12'); assert.equal(doc.questions[0].imported?.grade, 'english_12th_grade');
 const calls: string[] = []; const result = await enrichPackage(doc, settings, {decisionCaller:judge(calls)});
 assert.ok(calls.some(n=>n.includes('lessons'))); assert.equal(result.questions[0].enrichment?.origin, 'single'); assert.equal(result.questions[0].enrichment?.lessons?.length, 1);
});

test('#54 unknown lessons differ from beyond-book in both exports', async () => {
 const batch = authoredPackage(); batch.questions = [batch.questions[0]]; batch.questions[0].grade = 'unknown';
 const doc = await load(batch); const result = await enrichPackage(doc, settings, {decisionCaller:judge([])});
 assert.equal(result.questions[0].enrichment?.origin, 'unknown'); assert.deepEqual(result.questions[0].enrichment?.lessons, []);
 assert.match(result.source.enrichmentNotes!.join(' '), /lesson ranking skipped — no curriculum lessons for grade unknown \/ subject English/);
 assert.equal(buildExportDoc(result).questions[0].enrichment.origin, 'unknown');
 const exported = await createQuestionBankExport(result, {sourceDataset:'example'}); assert.equal(exported.batch.questions[0].enrichment?.origin, 'unknown'); assert.ok(exported.report.enrichment_notes?.length);
});

test('#54 listening gates answer alone; missing pixels do not gate stem judgments', async () => {
 const batch = authoredPackage(); batch.questions = batch.questions.slice(0, 2); batch.questions.forEach(q => { q.grade = '12'; }); batch.questions[0].stem = 'Listen to the audio and answer.'; batch.questions[1].stem = 'Which image is shown?';
 const doc = await load(batch); const calls: string[] = []; const result = await enrichPackage(doc, settings, {decisionCaller:judge(calls)});
 assert.equal(result.questions[0].enrichment?.verification, 'unjudged'); assert.ok(result.questions[0].enrichment?.demand); assert.ok(result.questions[0].enrichment?.completeness); assert.ok(result.questions[0].enrichment?.lessons);
 assert.ok(!calls.some(n=>n.includes('q_1 blind-answer'))); assert.ok(calls.some(n=>n.includes('q_2 demand'))); assert.ok(calls.some(n=>n.includes('q_2 complete')));
 assert.equal(result.source.enrichmentNotes!.filter(n=>/Listening/.test(n)).length, 1); assert.match(result.source.enrichmentNotes!.find(n=>/Listening/.test(n))!, /answer checks/);
});

test('#54 filename shared asset: ownership is structural, picture matching still votes', async () => {
 const batch = authoredPackage(); batch.questions = batch.questions.slice(7); const doc = await load(batch, true);
 assert.equal(doc.images[0].packageShared?.structural, true); assert.equal(doc.images[0].packageShared?.ownerIds.length, 2);
 const calls: string[] = []; let result = await enrichPackage(doc, settings, {decisionCaller:judge(calls)});
 assert.ok(!calls.some(n=>n.includes('image-placement'))); assert.ok(result.questions.every(q=>q.enrichment?.imagePlacement?.[0].state === 'verified'));
 assert.equal(result.source.enrichmentNotes!.filter(n=>/shared by Q39–Q40/.test(n)).length, 1);
 doc.questions[0].stem = 'Which sentence matches the picture?'; const matchingCalls: string[] = [];
 result = await enrichPackage(doc, settings, {decisionCaller:judge(matchingCalls)});
 assert.equal(matchingCalls.filter(n=>n.includes('image-placement')).length, 1); assert.equal(result.questions[0].enrichment?.imagePlacement?.[0].state, 'verified');
});

test('#54 suffix runs, singleton and explicit grouping receipts survive export', async () => {
 const batch = authoredPackage(); batch.questions = Array.from({length: 10}, (_,i)=>({...batch.questions[0], title:`Question ${String(i+1).padStart(2,'0')} — ${i<4?'Listening':i===4?'Singleton':'Vocabulary'}`}));
 const doc = await load(batch); assert.deepEqual(doc.source.packageSectionReceipt, {rule:'title-suffix', sections:[{title:'Listening', questionNumbers:[1,2,3,4,5]},{title:'Vocabulary', questionNumbers:[6,7,8,9,10]}]});
 const exported = await createQuestionBankExport(doc, {sourceDataset:'example'}); assert.deepEqual(exported.report.package_section_receipt, doc.source.packageSectionReceipt);
 const explicit = await load({...batch, sections:[{title:'Group A', start:1,end:5},{title:'Group B',start:6,end:10}]}); assert.equal(explicit.source.packageSectionReceipt?.rule,'explicit'); assert.deepEqual(explicit.sections.map(s=>s.title), ['Group A','Group B']);
 const markerBatch = authoredPackage(); markerBatch.questions = markerBatch.questions.slice(0,2); markerBatch.questions[0].stem = 'Section A — Grammar\nChoose.'; assert.equal((await load(markerBatch)).source.packageSectionReceipt?.rule, 'marker');
});

test('#54 named completeness shape checks and attention corroboration', async () => {
 const batch = authoredPackage(); batch.questions = [batch.questions[0]]; const doc = await load(batch); const q = doc.questions[0];
 assert.equal(stemEndsMidWordOrSentence({...q, stem:'This is incomple-'}), true); assert.equal(stemEndsMidWordOrSentence({...q, stem:'This is complete.'}), false);
 assert.equal(hasEmptyOrPlaceholderOption({...q, options:[{key:'A', text:'[missing]', spans:[]}]}), true); assert.equal(hasEmptyOrPlaceholderOption(q), false);
 assert.equal(referencesAbsentMaterial({...q, stem:'Read the passage.'}), true); assert.equal(referencesAbsentMaterial({...q, stem:'Read the passage.'}, 'Passage'), false);
 assert.equal(referencesAbsentMaterial({...q, stem:'Look at the picture.'}), true); assert.equal(referencesAbsentMaterial({...q, stem:'Use the table.'}), true);
 assert.equal(markedlyShorterThanSource({...q, stem:'Short', options:[], packageSourceTextLength:100}), true); assert.equal(markedlyShorterThanSource({...q, packageSourceTextLength:10}), false);
 const quiet = await enrichPackage(doc, settings, {decisionCaller:judge([], .1)}); assert.equal(quiet.questions[0].enrichment?.completeness?.probability, .1); assert.ok(!quiet.flags.some(f=>/incomplete/.test(f.message)));
 const before = computeAttention(quiet).length; doc.questions[0].stem = 'This is incomple-'; const flagged = await enrichPackage(doc, settings, {decisionCaller:judge([], .1)});
 assert.ok(flagged.flags.some(f=>/incomplete/.test(f.message))); assert.equal(computeAttention(flagged).length, before + 1);
});

test('#54 a supplied listening transcript is passed to blind verification', async () => {
 const batch = authoredPackage(); batch.questions = [batch.questions[0]]; batch.questions[0].title = 'Question 1 — Listening'; batch.questions[0].grade = '12';
 (batch.questions[0] as any).transcript = 'The speaker says alpha.';
 const doc = await load(batch); const requests: any[] = [];
 const result = await enrichPackage(doc, settings, {decisionCaller: async body => { requests.push(body); return judge([])(body); }});
 const blind = requests.find(b => Object.keys(b.questions)[0].includes('blind-answer'));
 assert.ok(blind); assert.match(JSON.stringify(blind), /The speaker says alpha/); assert.equal(result.questions[0].enrichment?.verification, 'verified');
 assert.ok(!result.source.enrichmentNotes?.some(n => /Listening/.test(n)));
});

test('#54 singleton suffix does not create a section; shared placement needs pixels', async () => {
 const batch = authoredPackage(); batch.questions = batch.questions.slice(7); batch.questions[0].title = 'Question 39 — Listening'; batch.questions[1].title = 'Question 40 — Vocabulary';
 const doc = await load(batch, true); assert.equal(doc.source.packageSectionReceipt?.rule, 'fallback'); assert.equal(doc.sections.length, 1);
 const calls: string[] = []; const result = await enrichPackage(doc, {...settings, decideMultimodal:false}, {decisionCaller:judge(calls)});
 assert.ok(result.questions.every(q => q.enrichment?.imagePlacement?.[0].state === 'skipped-no-evidence')); assert.ok(!calls.some(n=>n.includes('image-placement')));
});
