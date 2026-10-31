import test from 'node:test';
import assert from 'node:assert/strict';
import { file, png } from './fixtures/package-53';
import { importQuestionPackage } from '../src/pipeline/packageImport';
import { importPackageFolder } from '../src/pipeline/packageBatchImport';
import { enrichPackage } from '../src/pipeline/packageEnrichment';
import { generatePackageExplanations } from '../src/pipeline/packageExplanations';
import { loadImageBundle } from '../src/pipeline/evidenceBundle';
import { optionalPoints } from '../src/pipeline/optionalGroups';
import { getExamHealth, validateExamInvariants } from '../src/pipeline/quality';
import { buildExportDoc } from '../src/utils/examExport';
import { createQuestionBankExport } from '../src/utils/questionBankExport';
import { DEFAULT_SETTINGS } from '../src/store';

const settings = {...DEFAULT_SETTINGS, providers:[{id:'read',name:'writer',kind:'openai-compatible' as const,baseURL:'http://localhost:1234',apiKey:''},{id:'d',name:'judge',kind:'openai-compatible' as const,baseURL:'http://localhost:8080',apiKey:'',decideDialect:'thx' as const}],roleMapping:{...DEFAULT_SETTINGS.roleMapping,read:{providerId:'read',model:'writer'},vision:{providerId:'read',model:'writer'},decide:{providerId:'d',model:'judge'}}};
const row = (label: string, stem: string, extra: any = {}) => ({ type:'multiple_choice',title:`Question ${label}`,stem,options:[{key:'A',text:'yes'},{key:'B',text:'no'}],answer_key:{correct:['A']},points:1,...extra });
const pack = (id: string, questions: any[]) => file('batch.json',JSON.stringify({batch_id:id,questions}));
const explanations = async (req: any) => ({rawText:'',json:{corrections:JSON.parse(req.text).questions.map((q:any) => ({questionNumber:q.number,explanation:`Because ${q.label}.`}))}});
const judge = async (body: any) => { const name=Object.keys(body.questions)[0]; return {results:[{name,probability:.9,choice:name.includes('blind-answer')?'A':name.includes('difficulty')?'2':name.includes('demand')?'recall':undefined}]}; };

test('#56 scripts are mapped by explicit section and never leak', async () => {
 const qs = Array.from({length:15},(_,i)=>row(String(i+1),`Listen to the recording (Section ${Math.floor(i/5)+1}). Question ${i+1}?`));
 qs.push(row('16','Listen to the recording, answer this question.')); qs.push(row('17','A regular vocabulary question.'));
 const script = file('listening_scripts.md','## Section 1 — Questions 1–5\nLaptop unique.\n## Section 2 — Questions 6–10\nInvention unique.\n## Section 3 — Questions 11–15\nRecycling unique.');
 const doc = await importQuestionPackage([pack('scripts',qs),script]);
 assert.deepEqual(doc.source.packageScriptReceipt?.map(r=>r.sectionId),[...Array(5).fill('1'),...Array(5).fill('2'),...Array(5).fill('3'),null]);
 assert.equal(doc.questions[16].imported?.script,undefined);
 const records: any[]=[]; const out=await enrichPackage(doc,settings,{explanationCaller:explanations,decisionCaller:async body=>{records.push(body);return judge(body);}});
 for(let i=0;i<15;i++) { const r=records.find(b=>Object.keys(b.questions)[0]===`q_${i+1} blind-answer`); assert.ok(r); const text=JSON.stringify(r); const texts=['Laptop unique.','Invention unique.','Recycling unique.']; texts.forEach((v,j)=>j===Math.floor(i/5)?assert.ok(text.includes(v)):assert.ok(!text.includes(v))); assert.equal(out.questions[i].enrichment?.verification,'verified'); }
 assert.equal(out.questions[15].enrichment?.verification,'unjudged'); assert.ok(!records.some(b=>Object.keys(b.questions)[0]==='q_16 blind-answer'));
});

test('#56 batch queues enrichment, isolates failures, skips duplicates and supports import-only', async()=>{
 const f=(path:string,id:string)=>({...pack(id,[row('1','Pick one.')]),webkitRelativePath:path}); const files=[f('parent/a/batch.json','a'),f('parent/b/batch.json','b')]; const stored:any[]=[]; let calls=0; const progress:string[]=[];
 const result=await importPackageFolder(files,[],async d=>{stored.push(structuredClone(d));},m=>progress.push(m),async(d,p)=>{calls++;p('judge'); if(d.source.packageBatchId==='a') throw Error('offline'); return enrichPackage(d,settings,{explanationCaller:explanations,decisionCaller:judge});});
 assert.equal(result.imported,2); assert.equal(calls,2); assert.match(result.details[0],/imported.*enrichment failed.*offline/); assert.match(result.details[1],/imported.*enrichment ✓/); assert.ok(stored.some(d=>d.source.packageBatchId==='b' && d.questions[0].enrichment?.verification==='verified')); assert.ok(progress.some(m=>/Exam 2 of 2.*judge/.test(m)));
 const again=await importPackageFolder(files,stored,async()=>{},undefined,async d=>{throw Error('duplicate was enriched');}); assert.equal(again.duplicates,2);
 const only=await importPackageFolder(files,[],async()=>{}); assert.ok(only.details.every(d=>/import only/.test(d)));
});

test('#56 alternatives, full labels, totals, and exact image ownership', async()=>{
 const rows:any[]=[];
 for(const branch of ['A','B']) for(let n=55;n<=58;n++) rows.push(row(`${n}${branch}`,'OPTIONAL GROUP: Answer either 55A–58A OR 55B–58B.',{instructions:'Answer either branch A or branch B.'}));
 for(const n of [59,60]) for(const b of ['A','B']) rows.push(row(`${n}${b}`,`Choose either part A or part B for question ${n}.`,{instructions:`Choose either part A or part B for question ${n}.`}));
 for(const b of ['a','b','c','d']) rows.push(row(`17C-${b}`,'Choose either part C or part D.',{instructions:'Choose either part C or part D.'})); rows.push(row('17D','Choose either part C or part D.',{instructions:'Choose either part C or part D.',points:4})); rows.push(row('17','Compulsory.'));
 const doc=await importQuestionPackage([pack('alternatives',rows),file('question-17C-a.png',png)]);
 assert.equal(doc.questions[0].label,'55A'); assert.equal(doc.questions.find(q=>q.label==='17C-a')?.images.length,1); assert.equal(doc.questions.find(q=>q.label==='17')?.images.length,0);
 assert.equal(doc.optionalGroups?.length,4); assert.equal(doc.optionalGroups?.find(g=>g.memberLabels.includes('55A'))?.rule,'choose-one-branch'); assert.equal(optionalPoints(doc,doc.questions),11); assert.deepEqual(getExamHealth(doc).duplicates,[]); assert.ok(!validateExamInvariants(doc).violations.some(v=>v.code==='I8'));
 const notes=await generatePackageExplanations(doc,settings,{caller:explanations,loadBundle:q=>loadImageBundle(doc,q,4,async()=>undefined),writerCanSeeImages:true}); assert.match(notes.join(' '),/explanations: 18 of 18/); assert.equal(doc.questions.find(q=>q.label==='55A')?.explanation?.text,'Because 55A.');
 const exported=buildExportDoc(doc); assert.equal(exported.questions[0].label,'55A'); assert.ok(exported.optionalGroups.length); const bank=await createQuestionBankExport(doc,{sourceDataset:'x'},async()=>new Blob([png])); assert.equal(bank.batch.questions[0].label,'55A'); assert.match(bank.batch.questions[0].title,/55A/);
});

test('#56 explanation batches salvage partial output and retry missing once', async()=>{
 const doc=await importQuestionPackage([pack('small',Array.from({length:9},(_,i)=>row(String(i+1),'Pick.')))]); const calls:number[]=[];
 const notes=await generatePackageExplanations(doc,settings,{caller:async req=>{ const qs=JSON.parse(req.text).questions; calls.push(qs.length); if(qs.length>1) return {json:null,rawText:`broken {"questionNumber":${qs[0].number},"explanation":"salvaged"} ...`}; return explanations(req); }});
 assert.ok(calls.every(n=>n<=4)); assert.equal(doc.questions.filter(q=>q.explanation).length,9); assert.match(notes.join(' '),/explanations: 9 of 9 keyed questions/); assert.equal(calls.length, 9, 'three initial batches plus one scoped retry for each of six omitted rows');
});

test('#56 review tags and explanation policy derive from saved enrichment', async()=>{
 const doc=await importQuestionPackage([pack('tags',[row('1','One.',{tags:['existing','manual_review']}),row('2','Two.'),row('3','Three.')])]);
 for(const [i,state] of (['disagreed','uncertain','verified'] as const).entries()){doc.questions[i].enrichment={source:'model',verification:state,explanationCheck:{state:i===0?'rejected':i===1?'uncertain':'verified',probability:i===0?.1:i===1?.5:.9}};doc.questions[i].explanation={source:'model',text:`explanation ${i}`};}
 for(let i=0;i<2;i++){const structured=buildExportDoc(doc);const bank=await createQuestionBankExport(doc,{sourceDataset:'tags'}); assert.ok(structured.questions[0].tags.includes('answer_key_needs_review')); assert.ok(bank.batch.questions[0].tags.includes('answer_key_needs_review')); assert.ok(bank.batch.questions[1].tags.includes('manual_review')); assert.ok(structured.questions[1].tags.includes('manual_review')); assert.equal(structured.questions[1].explanation.text,'explanation 1'); assert.equal(bank.batch.questions[1].explanation,null); assert.equal(bank.batch.questions[2].explanation,null,'legacy model verdict has no fingerprint and is not bank evidence'); assert.equal(structured.questions[0].explanation,undefined); assert.ok(!bank.batch.questions[0].tags.includes('explanation_needs_review')); assert.ok(bank.batch.questions[0].tags.includes('existing')); }
});

test('#56 range mapping, conflicts and legacy unscoped scripts fail closed', async()=>{
 const doc=await importQuestionPackage([pack('range',[row('2','Listen to the recording.'),row('3','Listen to group 2 and Section 1.'),row('4','A vocabulary exercise.')]),file('listening.md','## Section 1 — Questions 1–3\nFirst.\n## Section 2 — Questions 4–6\nSecond.')]);
 assert.equal(doc.questions[0].imported?.script,'First.'); assert.equal(doc.questions[1].imported?.script,undefined); assert.equal(doc.questions[2].imported?.script,undefined);
 doc.source.packageScriptReceipt=undefined; doc.questions[0].imported!.script='Stale wrong script';
 const records:any[]=[]; const out=await enrichPackage(doc,settings,{explanationCaller:explanations,decisionCaller:async b=>{records.push(b);return judge(b);}});
 assert.equal(out.questions[0].imported?.script,undefined); assert.equal(out.questions[0].enrichment?.verification,'unjudged'); assert.equal(out.questions[0].enrichment?.explanationCheck?.state,'unjudged'); assert.ok(!records.some(b=>JSON.stringify(b).includes('Stale wrong script')));
});

test('#56 missing explanation has exactly one retry and never blocks judging', async()=>{
 const doc=await importQuestionPackage([pack('retry',[row('1','Pick.')])]); let count=0;
 const out=await enrichPackage(doc,settings,{explanationCaller:async()=>{count++;return {json:null,rawText:'bad'};},decisionCaller:judge});
 assert.equal(count,2); assert.equal(out.questions[0].explanation,undefined); assert.equal(out.questions[0].enrichment?.verification,'verified'); assert.match(out.source.enrichmentNotes!.join(' '),/explanations: 0 of 1/);
});

test('#56 listening metadata uses the same evidence gate as script mapping', async()=>{
 const questions = [row('1','What did the speaker say?',{instructions:'Listening — Section 2'}),row('2','What did the speaker say?',{instructions:'Listening exercise'})];
 const script = file('listening.md','## Section 2 — Questions 1–1\nMetadata-mapped evidence.');
 const doc = await importQuestionPackage([pack('metadata-listening',questions),script]);
 const records:any[]=[]; const out=await enrichPackage(doc,settings,{explanationCaller:explanations,decisionCaller:async b=>{records.push(b);return judge(b);}});
 assert.equal(out.questions[0].imported?.script,'Metadata-mapped evidence.');
 assert.match(JSON.stringify(records.find(b=>Object.keys(b.questions)[0]==='q_1 blind-answer')),/Metadata-mapped evidence/);
 assert.equal(out.questions[1].enrichment?.verification,'unjudged');
 assert.ok(!records.some(b=>Object.keys(b.questions)[0]==='q_2 blind-answer'));
});

test('#56 listening group membership can map an otherwise unnumbered script range', async()=>{
 const data = {batch_id:'groups',questions:[row('20','What was said?',{instructions:'Listening exercise',instructionGroups:['group-x']})],instruction_groups:[{id:'group-x',start:6,end:10}]};
 const doc = await importQuestionPackage([file('batch.json',JSON.stringify(data)),file('listening.md','## Section 2 — Questions 6–10\nGroup-specific evidence.')]);
 assert.equal(doc.questions[0].imported?.script,'Group-specific evidence.');
 assert.equal(doc.source.packageScriptReceipt?.[0].sectionId,'2');
});
