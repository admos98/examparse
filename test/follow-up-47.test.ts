import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAuthoredDocument, checkAuthoredDocument, assignAuthoredImages, applyCorrections, parseCorrections } from '../src/pipeline/localLoop';
import { resolveDecisionProvider } from '../src/pipeline/loopAudit';
import { DEFAULT_SETTINGS } from '../src/store';
import type { ImageAsset, SourceLine } from '../src/types';
const line=(n:number,text:string,page=1):SourceLine=>({id:`L${String(n).padStart(4,'0')}`,page,y:n,text});
test('passage schema retains one shared passage and flags absent passage link',()=>{
 const doc=normalizeAuthoredDocument({sections:[{title:'Reading'}],passages:[{id:'p1',sectionTitle:'Reading',text:'A complete reading passage.'}],questions:[{number:1,sectionTitle:'Reading',type:'short',stem:'What does paragraph two say?',passageId:'p1'},{number:2,sectionTitle:'Reading',type:'short',stem:'What is in the passage?',passageId:'p1'}]});
 assert.equal(doc.passages?.length,1); assert.equal(checkAuthoredDocument(doc,[]).some(v=>v.kind==='passage-missing'),false);
 doc.passages=[];doc.questions[0].passageId=undefined;assert.ok(checkAuthoredDocument(doc,[]).some(v=>v.kind==='passage-missing'));
});
test('image assignment is one-owner and document-order, including decoration-labelled images',()=>{
 const doc=normalizeAuthoredDocument({questions:[{number:1,type:'short',stem:'Look at the picture.',options:[],sourcePages:[1],imageIds:['wrong']},{number:2,type:'short',stem:'Look at the diagram.',options:[],sourcePages:[1]}]});
 const imgs=[1,2,3].map((n)=>({id:`img_00${n}`,page:1,label:{role:n===3?'decoration':'content'}} as ImageAsset));
 assignAuthoredImages(doc,imgs,[line(1,'1 look at picture'),line(2,'2 look at diagram')]);
 assert.deepEqual(doc.questions.map(q=>q.imageIds.length),[1,1]);
 assert.equal(new Set(doc.questions.flatMap(q=>q.imageIds)).size,2);
 assert.equal(checkAuthoredDocument(doc,imgs).filter(v=>v.kind==='image-unassigned').length,1);
});
test('duplicate correction uses stem similarity; ambiguous duplicate yields teacher-facing note',()=>{
 const doc=normalizeAuthoredDocument({questions:[{number:57,sectionTitle:'A',type:'short',stem:'The matching answer',options:[]},{number:57,sectionTitle:'B',type:'short',stem:'Choose a different thing',options:[]}]});
 const c=parseCorrections({rawText:JSON.stringify({corrections:[{action:'replace',questionNumber:57,question:{number:57,type:'short',stem:'The matching answer corrected',options:[]}}]})})!;
 const out=applyCorrections(doc,c);assert.match(out.document.questions.find(q=>q.sectionTitle==='A')!.stem,/corrected/);
 const ambiguous=parseCorrections({rawText:JSON.stringify({corrections:[{action:'replace',questionNumber:57,question:{number:57,type:'short',stem:'Unrelated wording',options:[]}}]})})!;
 assert.match(applyCorrections(doc,ambiguous).notes.join(' '),/Two questions numbered 57 disagree/);
});
test('explicit remote decide provider resolves; no local-only rejection',()=>{
 const settings={...DEFAULT_SETTINGS,providers:[{id:'remote',name:'AnyRouter',kind:'openai-compatible' as const,baseURL:'https://anyrouter.dev/api/v1',apiKey:'',decideDialect:'thx' as const}],roleMapping:{...DEFAULT_SETTINGS.roleMapping,decide:{providerId:'remote',model:'hal-x/thx-01'}}};
 assert.equal(resolveDecisionProvider(settings)?.model,'hal-x/thx-01');
});

test('THX adapter sends keyed text-only payload and normalizes choice and noul maps',async()=>{
 const original=globalThis.fetch; const sent:any[]=[]; let response:any={};
 globalThis.fetch=(async(_url:any,init:any)=>{sent.push(JSON.parse(init.body));return {ok:true,json:async()=>response} as any;}) as any;
 try{
  const {LLMAdapter}=await import('../src/providers/adapter');
  const provider:any={id:'remote',name:'AnyRouter',kind:'openai-compatible',baseURL:'https://anyrouter.dev/api/v1',apiKey:'x',decisionsPath:'/decisions',decideDialect:'thx',model:'hal-x/thx-01'};
  const choiceBody:any={model:provider.model,state:'Q details',questions:{'Q1 choice':{type:'choice',instructions:'Choose',criteria:{a:'a',b:'b'}}}};
  response={'Q1 choice':{a:0.2,b:0.8}};
  const choice=await LLMAdapter.executeDecisions({providerConfig:provider,body:choiceBody});
  assert.deepEqual(choice.results,[{name:'Q1 choice',probability:0.8,choice:'b',distribution:{a:0.2,b:0.8}}]);
  assert.deepEqual(Object.keys(sent[0].body.questions),['Q1 choice']);assert.equal(sent[0].body.state,'Q details');
  response={'Q2 complete':{yes:0.73}};
  const noul=await LLMAdapter.executeDecisions({providerConfig:provider,body:{model:provider.model,state:'Q',questions:{'Q2 complete':{type:'noul',instructions:'Is complete?'}}} as any});
  assert.equal(noul.results[0].probability,0.73);assert.equal(noul.results[0].name,'Q2 complete');
 } finally {globalThis.fetch=original;}
});

test('mergeDuplicates operation collapses conflicting stem-identical records to one corrected object',()=>{
 const doc=normalizeAuthoredDocument({questions:[{number:8,sectionTitle:'A',type:'short',stem:'same exact stem',options:[],answer:'yes'},{number:8,sectionTitle:'A',type:'mcq',stem:'same exact stem',options:[{key:'a',text:'A'},{key:'b',text:'B'}],answer:'a'}]});
 assert.ok(checkAuthoredDocument(doc,[]).some(v=>v.kind==='duplicate-conflict'));
 const correction=parseCorrections({rawText:JSON.stringify({corrections:[{action:'mergeDuplicates',questionNumber:8,question:{number:8,sectionTitle:'A',type:'mcq',stem:'same exact stem',options:[{key:'a',text:'A'},{key:'b',text:'B'}],answer:'a'}}]})})!;
 const merged=applyCorrections(doc,correction);assert.equal(merged.applied,1);assert.equal(merged.document.questions.length,1);assert.equal(merged.document.questions[0].type,'mcq');
});
