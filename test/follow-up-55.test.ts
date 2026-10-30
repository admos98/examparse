import test from 'node:test';
import assert from 'node:assert/strict';
import { importPackageFolder } from '../src/pipeline/packageBatchImport';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { enrichPackage, lessonRanking } from '../src/pipeline/packageEnrichment';
import { referencesAbsentMaterial } from '../src/pipeline/completenessCorroboration';
import { DEFAULT_SETTINGS } from '../src/store';
import { file, png } from './fixtures/package-53';
import { createHash } from 'node:crypto';

const batch = (id: string, stem = 'Listen to the newly authored script in listening_scripts.md, Section 1.') => JSON.stringify({ batch_id: id, grade: 12, subject: 'English', questions: [{ type: 'multiple_choice', title: 'Question 1', stem, options: [{key:'A',text:'yes'}, {key:'B',text:'no'}], answer_key: {correct:['A']} }] });
const f = (path: string, data: string) => { const base = file(path.split('/').pop()!, data); return { ...base, webkitRelativePath: path }; };

test('#55 parent-folder imports are isolated, idempotent, and report collisions', async () => {
 const sha = createHash('sha256').update(png).digest('hex');
 const appendix = JSON.parse(batch('b')); delete appendix.questions[0].stem; appendix.questions[0].stem_blocks = [{t:'text',v:'Choose one.'},{t:'img',asset:sha}];
 const imageFile = (path: string) => { const base = file(path.split('/').pop()!,png); return { ...base, webkitRelativePath:path }; };
 const files = [f('parent/a/exam.json', batch('a')), imageFile('parent/a/images/question-1.png'), f('parent/b/batch.json', JSON.stringify(appendix)), imageFile(`parent/b/assets/${sha}.png`), f('parent/bad/exam.json','{'), f('parent/other/readme.md','hi'), f('parent/root.txt','ignored')];
 const saved: any[] = []; const save = async (doc: any) => { saved.push(doc); };
 const first = await importPackageFolder(files, [], save);
 assert.deepEqual([first.imported, first.duplicates, first.failed, first.notPackage], [2,0,1,1]); assert.equal(saved[0].images.length,1); assert.equal(saved[1].images.length,1);
 const second = await importPackageFolder(files, [...saved], save);
 assert.equal(second.duplicates, 2); assert.equal(second.imported, 0);
 const third = await importPackageFolder([f('parent/a/exam.json', batch('a','changed'))], [...saved], save);
 assert.equal(third.imported, 1); assert.match(third.details[0], /collision/);
});

test('#55 listening collateral joins the blind record; missing script remains unverifiable', async () => {
 const json = f('exam.json', batch('a')); const script = f('listening_scripts.md', '## Section 1\nA unique script passage.\n');
 const doc = await importQuestionPackage([json, script]);
 assert.doesNotMatch(doc.questions[0].stem!, /\.md/); assert.match(doc.questions[0].imported!.provenance.source_ref, /listening_scripts\.md/);
 const settings = { ...DEFAULT_SETTINGS, providers: [{ id:'d', name:'judge', kind:'openai-compatible' as const, baseURL:'http://localhost:8080', apiKey:'', decideDialect:'thx' as const }], roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId:'d', model:'judge' } } };
 const bodies: any[] = [];
 const caller = async (body: any) => { bodies.push(body); const name = Object.keys(body.questions)[0]; return {results:[{name, probability:.9, choice: name.includes('blind-answer') ? 'A' : undefined}]}; };
 const judged = await enrichPackage(doc, settings, {decisionCaller:caller});
 assert.equal(judged.questions[0].enrichment?.verification, 'verified'); assert.ok(bodies.some(b => JSON.stringify(b).includes('A unique script passage.')));
 const noScript = await enrichPackage(await importQuestionPackage([json]), settings, {decisionCaller:caller});
 assert.equal(noScript.questions[0].enrichment?.verification, 'unjudged'); assert.equal(noScript.source.enrichmentNotes?.filter(n => /without an included script/.test(n)).length, 1);
});

test('#55 origin is total and in-stem passage is not dangling', async () => {
 assert.equal(lessonRanking({one:.69,two:.2}).origin, 'single');
 const doc = await importQuestionPackage([f('exam.json', batch('x', `Read the following passage.\n\n${'Evidence '.repeat(30)}\n\nWhat happened?`))]);
 assert.equal(referencesAbsentMaterial(doc.questions[0]), false);
});

test('#55 difficulty, lesson margin and confidence are written from decision votes', async () => {
 const { curriculumLessons } = await import('../src/pipeline/curriculumHints');
 const { buildExportDoc } = await import('../src/utils/examExport');
 const doc = await importQuestionPackage([f('exam.json', batch('x', 'Choose the right word.'))]);
 const lessons = curriculumLessons('12','English');
 const settings = { ...DEFAULT_SETTINGS, providers: [{id:'d',name:'judge',kind:'openai-compatible' as const,baseURL:'http://localhost:8080',apiKey:'',decideDialect:'thx' as const}], roleMapping: {...DEFAULT_SETTINGS.roleMapping, decide:{providerId:'d',model:'judge'}} };
 const run = (second: number) => enrichPackage(doc, settings, {decisionCaller:async body => {
  const name = Object.keys(body.questions)[0];
  if (name.includes('blind-answer')) return {results:[{name, probability:.8, choice:'A', distribution:{A:.8,B:.2}}]};
  if (name.includes('lessons')) return {results:[{name, probability:.62, choice:lessons[0].title, distribution:{[lessons[0].title]:.62,[lessons[1].title]:second}}]};
  if (name.includes('difficulty')) { assert.equal(body.questions[name].type,'score'); assert.equal(body.questions[name].criteria.length,5); return {results:[{name, probability:.6, choice:'3', distribution:{'1':.1,'2':.1,'3':.6,'4':.1,'5':.1}}]}; }
  return {results:[{name, probability:.9, choice:name.includes('demand') ? 'recall' : undefined}]};
 }});
 const strong = await run(.2); assert.equal(strong.questions[0].curriculumHints?.lesson, lessons[0].title); assert.ok(strong.questions[0].curriculumHints?.chapter); assert.equal(strong.questions[0].difficulty?.value,3); assert.equal(strong.questions[0].confidence,.8); assert.equal(buildExportDoc(strong).meta.grade,'english_12th_grade');
 const close = await run(.55); assert.equal(close.questions[0].curriculumHints?.lesson,null);
});

test('#55 explain precedes judge; malformed items are isolated and rejected prose never exports', async () => {
 const { createQuestionBankExport } = await import('../src/utils/questionBankExport');
 const { buildExportDoc } = await import('../src/utils/examExport');
 const { exportSelected } = await import('../src/pipeline/bulkOps');
 const { createBackup, restoreBackup } = await import('../src/utils/backup');
 const rows = [
  {type:'multiple_choice',title:'Question 1',stem:'Pick one.', options:[{key:'A',text:'One'},{key:'B',text:'Two'}],answer_key:{correct:['A']}},
  {type:'fill_in_blank',title:'Question 2',stem:'Fill the blank.',answer_key:{correct:['one']}},
  {type:'short_answer',title:'Question 3',stem:'No answer.',answer_key:null},
  {type:'essay',title:'Question 4',stem:'Write an essay.',answer_key:{correct:['essay']}}
 ];
 const doc = await importQuestionPackage([f('exam.json',JSON.stringify({batch_id:'explain',grade:12,subject:'English',questions:rows}))]);
 const settings = {...DEFAULT_SETTINGS, providers:[{id:'read',name:'local',kind:'openai-compatible' as const,baseURL:'http://localhost:1234/v1',apiKey:''},{id:'d',name:'judge',kind:'openai-compatible' as const,baseURL:'http://localhost:8080',apiKey:'',decideDialect:'thx' as const}],roleMapping:{...DEFAULT_SETTINGS.roleMapping,read:{providerId:'read',model:'writer'},decide:{providerId:'d',model:'judge'}}};
 const events: string[] = []; const records: any[] = [];
 const result = await enrichPackage(doc, settings, {
  explanationCaller:async request => { events.push('explain'); const sent = JSON.parse(request.text); assert.deepEqual(sent.questions.map((q:any) => q.number),[1,2]); return {json:{corrections:[{questionNumber:1,explanation:'Unique wrong prose.'},{questionNumber:2,explanation:4}]},rawText:''}; },
  decisionCaller:async body => { events.push('judge'); records.push(body); const name = Object.keys(body.questions)[0];
   if (name.includes('explanation-check')) return {results:[{name,probability:.1}]};
   if (name.includes('blind-answer')) return {results:[{name,probability:.9,choice:'A'}]};
   if (name.includes('lessons')) return {results:[]};
   if (name.includes('difficulty')) return {results:[{name,probability:.6,choice:'2'}]};
   if (name.includes('demand')) return {results:[{name,probability:.7,choice:'recall'}]};
   return {results:[{name,probability:.9}]};
  }
 });
 assert.equal(events[0],'explain'); assert.ok(events.slice(1).every(e => e === 'judge'));
 assert.equal(result.questions[0].explanation?.text,'Unique wrong prose.'); assert.equal(result.questions[0].enrichment?.explanationCheck?.state,'rejected');
 assert.ok(result.questions.slice(1).every(q => !q.explanation));
 const check = records.find(b => Object.keys(b.questions)[0].includes('explanation-check')); assert.match(JSON.stringify(check), /Unique wrong prose/); assert.match(check.state, /"key":"A"/);
 for (const b of records.filter(b => /lessons|difficulty|demand/.test(Object.keys(b.questions)[0]))) assert.doesNotMatch(JSON.stringify(b), /Unique wrong prose/);
 assert.doesNotMatch(JSON.stringify(buildExportDoc(result)), /Unique wrong prose/); assert.doesNotMatch(JSON.stringify(exportSelected(result,[result.questions[0].id]).json), /Unique wrong prose/);
 const backup = await createBackup({exams:{x:result},images:{},dossiers:{},settings:{}}); assert.doesNotMatch(JSON.stringify((await restoreBackup(backup)).exams), /Unique wrong prose/);
 const exported = await createQuestionBankExport(result,{sourceDataset:'test'}); assert.doesNotMatch(JSON.stringify(exported.batch), /Unique wrong prose/); assert.equal(exported.batch.questions[0].explanation,null);
 assert.ok(result.source.enrichmentNotes?.some(n => /malformed/.test(n)));
});

test('#55 generation uses local role only and failures do not stop judging', async () => {
 const doc = await importQuestionPackage([f('exam.json',batch('no-cloud','Choose.'))]);
 const settings = {...DEFAULT_SETTINGS, providers:[{id:'cloud',name:'cloud',kind:'openai-compatible' as const,baseURL:'https://cloud.example/v1',apiKey:''},{id:'d',name:'judge',kind:'openai-compatible' as const,baseURL:'http://localhost:8080',apiKey:'',decideDialect:'thx' as const}],roleMapping:{...DEFAULT_SETTINGS.roleMapping,read:{providerId:'cloud',model:'writer'},decide:{providerId:'d',model:'judge'}}};
 let generated = 0, judged = 0;
 const result = await enrichPackage(doc,settings,{explanationCaller:async () => { generated++; throw Error('must not call'); }, decisionCaller:async body => {judged++; return {results:[{name:Object.keys(body.questions)[0],probability:.9}]};}});
 assert.equal(generated,0); assert.ok(judged > 0); assert.match(result.source.enrichmentNotes!.join(' '),/not run/);
});

test('#55 passage run crosses true-false subheaders and judges reading for every linked item', async () => {
 const passage = 'A traveller walked through the forest and met a friendly guide. '.repeat(6);
 const rows = Array.from({length:6},(_,i) => ({type:'true_false',title:`Question ${i+1}`,section:'Reading',stem: i===1 ? 'True or false? The traveller walked.' : i===3 ? `True or false:\n\n${passage}\n\nThe guide was friendly.` : i===5 ? `${'Different material '.repeat(20)}\n\nOther question?` : `${passage}\n\nQuestion ${i+1}?`,options:[{key:'A',text:'True'},{key:'B',text:'False'}],answer_key:{correct:['A']}}));
 const doc = await importQuestionPackage([f('exam.json',JSON.stringify({batch_id:'passages',grade:12,subject:'English',questions:rows}))]);
 assert.ok(doc.questions[0].passageId); assert.ok(doc.questions.slice(0,5).every(q => q.passageId === doc.questions[0].passageId)); assert.ok(!doc.questions[5].passageId);
 const settings = {...DEFAULT_SETTINGS,providers:[{id:'d',name:'judge',kind:'openai-compatible' as const,baseURL:'http://localhost:8080',apiKey:'',decideDialect:'thx' as const}],roleMapping:{...DEFAULT_SETTINGS.roleMapping,decide:{providerId:'d',model:'judge'}}};
 const names:string[]=[];
 const result = await enrichPackage(doc,settings,{decisionCaller:async body => {const name=Object.keys(body.questions)[0]; names.push(name); return {results:[{name,probability:.9,choice:name.includes('reading-mode') ? 'direct-finding' : name.includes('blind-answer') ? 'A' : name.includes('demand') ? 'recall' : name.includes('difficulty') ? '2' : undefined}]};}});
 assert.equal(names.filter(n => n.includes('reading-mode')).length,5); assert.ok(result.questions.slice(0,5).every(q => q.enrichment?.readingMode));
});

test('#55 bank zip splits 51 questions into two batches with a single shared asset pool', async () => {
 const JSZip = (await import('jszip')).default;
 const { createQuestionBankExport } = await import('../src/utils/questionBankExport');
 const { png } = await import('./fixtures/package-53');
 const doc = await importQuestionPackage([file('exam.json',batch('large','Question.')),file('question-1.png',png)]);
 doc.questions = Array.from({length:51},(_,i) => ({...structuredClone(doc.questions[0]),id:`q_${i+1}`,no:i+1,label:String(i+1)}));
 const result = await createQuestionBankExport(doc,{sourceDataset:'large'},async () => new Blob([png]));
 const zip = await JSZip.loadAsync(result.zip); const paths = Object.keys(zip.files);
 const batches = paths.filter(p => /part-\d+\/batch\.json$/.test(p)).sort(); assert.equal(batches.length,2);
 const data = await Promise.all(batches.map(async p => JSON.parse(await zip.file(p)!.async('string'))));
 assert.deepEqual(data.map(d => d.questions.length),[50,1]); assert.notEqual(data[0].batch_id,data[1].batch_id);
 assert.equal(paths.filter(p => /\/assets\/[^/]+\.png$/.test(p)).length,1);
 assert.equal(data[0].questions[0].stem_blocks.find((b:any) => b.t === 'img').asset,doc.images[0].sha);
});

test('#55 abstention, teacher precedence, beyond-book and in-stem evidence are preserved', async () => {
 const { curriculumLessons } = await import('../src/pipeline/curriculumHints');
 const long = `Read the following passage.\n\n${'A factual passage about a traveller. '.repeat(9)}\n\nAnswer the question.`;
 const doc = await importQuestionPackage([f('exam.json',batch('tuning',long))]); const lessons = curriculumLessons('12','English');
 doc.questions[0].enrichment = {source:'model',verification:'unjudged',teacherLesson:{lesson:lessons[1].title,source:'teacher'}};
 const settings = {...DEFAULT_SETTINGS,providers:[{id:'d',name:'judge',kind:'openai-compatible' as const,baseURL:'http://localhost:8080',apiKey:'',decideDialect:'thx' as const}],roleMapping:{...DEFAULT_SETTINGS.roleMapping,decide:{providerId:'d',model:'judge'}}};
 const out = await enrichPackage(doc,settings,{decisionCaller:async body => {
  const name = Object.keys(body.questions)[0];
  if(name.includes('blind-answer')) return {results:[{name,probability:.9,choice:'A'}]};
  if(name.includes('complete')) return {results:[{name,probability:.1}]};
  if(name.includes('lessons')) return {results:[{name,probability:.9,choice:"not from this textbook's lessons",distribution:{"not from this textbook's lessons":.9,[lessons[0].title]:.1}}]};
  if(name.includes('difficulty')) return {results:[{name,probability:.25,choice:'3',distribution:{'1':.15,'2':.2,'3':.25,'4':.2,'5':.2}}]};
  return {results:[{name,probability:.8,choice:name.includes('demand')?'recall':undefined}]};
 }});
 const q=out.questions[0]; assert.equal(q.enrichment?.origin,'beyond-book'); assert.equal(q.curriculumHints?.lesson,lessons[1].title); assert.equal(q.difficulty,null); assert.equal(q.enrichment?.difficultyUncertain,true); assert.equal(out.flags.filter(flag => flag.code === 'PACKAGE_ENRICHMENT').length,0);
 const notRun = await enrichPackage(doc,{...settings,roleMapping:{...settings.roleMapping,decide:undefined}}); assert.equal(notRun.questions[0].confidence,null);
});

test('#55 local explanation failures are noted and judging still proceeds', async () => {
 const doc=await importQuestionPackage([f('exam.json',batch('failed-generation','Choose.'))]);
 const settings={...DEFAULT_SETTINGS,providers:[{id:'read',name:'writer',kind:'openai-compatible' as const,baseURL:'http://localhost:1234',apiKey:''},{id:'d',name:'judge',kind:'openai-compatible' as const,baseURL:'http://localhost:8080',apiKey:'',decideDialect:'thx' as const}],roleMapping:{...DEFAULT_SETTINGS.roleMapping,read:{providerId:'read',model:'writer'},decide:{providerId:'d',model:'judge'}}};
 let calls=0; const out=await enrichPackage(doc,settings,{explanationCaller:async()=>{throw Error('offline');},decisionCaller:async body=>{calls++;return {results:[{name:Object.keys(body.questions)[0],probability:.9}]};}});
 assert.ok(calls>0); assert.ok(out.source.enrichmentNotes?.some(n => /generation failed/.test(n))); assert.equal(out.questions[0].explanation,undefined);
});
