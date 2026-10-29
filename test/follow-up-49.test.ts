import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '../src/store';
import type { AppSettings, SourceLine } from '../src/types';
import { runLocalLoop } from '../src/pipeline/localLoopRunner';
import { projectAuthoredDocument, type LoopModelRequest } from '../src/pipeline/localLoop';
import { countExamMap, parseExamMap, runMapFirstRead, type LoopMapReceipt } from '../src/pipeline/mapFirst';
import { MapOutline } from '../src/components/MapOutline';

const line = (id: number, text: string, page = 1): SourceLine => ({ id: `L${id}`, page, y: id, text });
const lines = [line(1, 'Exam English grade 10'), ...Array.from({ length: 6 }, (_, i) => line(i + 2, `${i + 1}. Question number ${i + 1}?`, i < 3 ? 1 : 2))];
const settings = (mode: 'active' | 'shadow' = 'shadow', decide = false): AppSettings => ({ ...DEFAULT_SETTINGS,
  thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false },
  providers: [{ id:'d', name:'local', kind:'openai-compatible', baseURL:'http://localhost:8080', apiKey:'', decideDialect:'thx' }],
  roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: decide ? { providerId:'d', model:'decider' } : undefined }, decideMode: mode });
const map = (sections: any[]) => ({ meta: { subject:'English', grade:'10' }, sections, instructionGroups:[], passages:[], images:[], answerKey:{present:false} });
const section = (title: string, a: number, b: number, count = b-a+1) => ({ title, firstQuestion:a, lastQuestion:b, questionCount:count, kind:'vocabulary' });
const question = (n: number) => ({ number:n, type:'short', stem:`Question number ${n}?`, options:[], imageIds:[] });
const response = (value: unknown) => ({ rawText: JSON.stringify(value) });
function runnerCaller(proposal: any, parsed: Record<string, number[]>, requests: LoopModelRequest[]) {
  return async (req: LoopModelRequest) => {
    requests.push(req);
    if (req.label.startsWith('Map ·')) return response(proposal);
    if (req.label.startsWith('Re-map')) return response({ invalid:'cannot repair' });
    if (req.label.startsWith('Section parse')) return response({ questions:(parsed[req.label.replace('Section parse · ','')] || []).map(n => ({ ...question(n), ...(req.text.includes('p1') && n >= 2 && n <= 5 ? { passageId:'p1' } : {}) })) });
    return response({ corrections:[] });
  };
}
const noCache = { cacheGet: async <T,>() => undefined as T | undefined, cacheSet: async () => {}, cacheKey: async (text: string) => text };

test('map counts overlapping sections and an incorrect total while still parsing', async () => {
  const proposal = map([section('A',1,4,2), section('B',4,6,3)]);
  const parsed = parseExamMap(response(proposal))!;
  const findings = countExamMap(parsed, lines, []);
  assert.ok(findings.some(v=>v.kind==='section-overlap' && /Q4/.test(v.message)));
  assert.ok(findings.some(v=>v.kind==='section-count-total' && /5/.test(v.message)));
  const requests: LoopModelRequest[] = [];
  const receipt = await runLocalLoop({ lines, images:[], settings:settings(), fileHash:'m1', caller:runnerCaller(proposal,{ A:[1,2,3,4], B:[4,5,6] },requests) });
  assert.ok(requests.some(r=>r.label==='Section parse · A'));
  assert.equal(receipt.map?.sections[0].status, 'disputed');
  assert.ok(receipt.map?.remaps.some(r=>!r.applied));
  assert.ok(receipt.document.questions.length > 0);
});

test('map gap results in section-missing verdict and one extra source parse', async () => {
  const proposal = map([section('A',1,2), section('C',5,6)]); const requests: LoopModelRequest[] = [];
  const receipt = await runLocalLoop({ lines, images:[], settings:settings(), fileHash:'m2', caller:runnerCaller(proposal,{ A:[1,2], C:[5,6], unmapped:[3,4] },requests) });
  assert.equal(requests.filter(r=>r.label==='Section parse · unmapped').length, 1);
  assert.deepEqual(receipt.document.questions.map(q=>q.number), [1,2,3,4,5,6]);
  assert.ok(receipt.codeVerdicts.some(v=>v.kind==='section-missing' && v.questionNumbers.includes(3)));
});

test('section prompts include group and passage contract; passage is shared and instruction scope persists', async () => {
  const proposal = { ...map([section('Reading',1,6)]), instructionGroups:[{ appliesToFirst:2, appliesToLast:5, text:'Read the passage and answer each question.' }], passages:[{ id:'p1', sectionTitle:'Reading', appliesToFirst:2, appliesToLast:5, text:'Once there was a long source passage.' }] };
  const requests: LoopModelRequest[] = []; const snapshots: LoopMapReceipt[] = [];
  const receipt = await runLocalLoop({ lines, images:[], settings:settings(), fileHash:'m3', caller:runnerCaller(proposal,{ Reading:[1,2,3,4,5,6] },requests), onMapUpdate:m=>{ snapshots.push(m); } });
  const parse = requests.find(r=>r.label==='Section parse · Reading')!;
  assert.match(parse.text, /questionCount":6/); assert.match(parse.text, /Read the passage and answer each question/);
  assert.equal(receipt.document.passages?.length, 1);
  for (const n of [2,3,4,5]) { const q = receipt.document.questions.find(q=>q.number===n)!; assert.equal(q.passageId,'p1'); assert.doesNotMatch(q.stem,/Once there was/); }
  const projected = projectAuthoredDocument(receipt.document);
  assert.deepEqual(projected.questions.find(q=>q.no===2)?.instructionGroups,['Read the passage and answer each question.']);
  assert.equal(projected.questions.find(q=>q.no===1)?.instructionGroups,undefined);
  const before = snapshots.find(s=>s.phase==='parse' && s.parsedSections===0)!;
  assert.ok(before); const html = renderToStaticMarkup(React.createElement(MapOutline,{map:before}));
  assert.match(html,/1a · Exam map/); assert.match(html,/1e Section parse 0\/1/); assert.match(html,/Read the passage/);
});

test('section count mismatch is scoped and a boundary continuation merges by number', async () => {
  const proposal = map([section('A',1,2), section('B',3,4), section('C',5,6)]); const requests: LoopModelRequest[] = [];
  const receipt = await runLocalLoop({ lines, images:[], settings:settings(), fileHash:'m4', caller:runnerCaller(proposal,{ A:[1,2,3], B:[3], C:[5,6] },requests) });
  assert.equal(receipt.document.questions.filter(q=>q.number===3).length,1);
  assert.equal(receipt.document.questions.find(q=>q.number===3)?.sectionTitle,'B');
  assert.ok(receipt.codeVerdicts.some(v=>v.kind==='section-count-mismatch' && /Section B/.test(v.message)));
  assert.ok(receipt.codeVerdicts.some(v=>v.kind==='section-range-mismatch' && /Section A/.test(v.message)));
});

const longLines: SourceLine[] = [];
for (let n=1, id=1; n<=6; n++) { longLines.push(line(id++, `${n}. source ${n}`, n <= 2 ? 1 : n <= 4 ? 2 : 3)); for(let j=0;j<35;j++) longLines.push(line(id++, `source-${n}-detail-${j}`, n <= 2 ? 1 : n <= 4 ? 2 : 3)); }
const auditMap = map([section('A',1,2), section('B',3,4), section('C',5,6)]);
async function auditScenario(mode:'active'|'shadow', boundary:number, down=false) {
  const calls: Array<{label:string; text:string}> = []; let auditCalls = 0;
  const result = await runMapFirstRead({ lines:longLines, images:[], settings:settings(mode,true), fileHash:'audit', ...noCache,
    call: async (label,_system,text) => {
      calls.push({label,text});
      if (label.startsWith('Map ·')) return response(auditMap);
      if (label.startsWith('Re-map')) return response(section('A',1,2));
      if (label.startsWith('Section parse')) { const name=label.split(' · ')[1]; return response({questions: (name==='A'?[1,2]:name==='B'?[3,4]:[5,6]).map(question)}); }
      return response({});
    },
    decisionCaller: async body => {
      auditCalls++; if (down) throw new Error('HTTP 502');
      const [name, item] = Object.entries(body.questions)[0] as [string,any];
      const title = name.startsWith('section:0') ? 'A' : name.startsWith('section:1') ? 'B' : 'C';
      return { results:[{ name, probability:name === 'section:0 section-boundary' ? boundary : .95, ...(item.type==='choice' ? {choice:title} : {}) }] };
    } });
  return { result:result!, calls, auditCalls };
}
test('active confident-wrong map boundary indicts only that section and re-map is scoped', async () => {
  const {result,calls} = await auditScenario('active',.08);
  assert.equal(result.map.auditVotes.filter(v=>v.indicted).length,1);
  const remaps = calls.filter(c=>c.label.startsWith('Re-map')); assert.equal(remaps.length,1);
  assert.match(remaps[0].label,/section:0/); assert.match(remaps[0].text,/section-boundary p=0.08/);
  assert.doesNotMatch(remaps[0].text,/source-5-detail/);
  assert.equal(result.map.remaps[0].applied,false);
  assert.equal(result.map.sections[0].status,'disputed');
});
test('uncertain and shadow votes never re-map; endpoint down skips map audit and still parses', async () => {
  const uncertain = await auditScenario('active',.5); assert.equal(uncertain.calls.filter(c=>c.label.startsWith('Re-map')).length,0); assert.equal(uncertain.result.map.sections[0].status,'uncertain');
  const shadow = await auditScenario('shadow',.08); assert.equal(shadow.calls.filter(c=>c.label.startsWith('Re-map')).length,0); assert.ok(shadow.result.map.auditVotes.some(v=>v.probability===.08 && !v.indicted)); assert.equal(shadow.result.map.agreement.disagree,1);
  const down = await auditScenario('active',.08,true); assert.equal(down.auditCalls,5); assert.match(down.result.map.notes.join(' '),/endpoint unreachable/); assert.equal(down.result.document.questions.length,6);
});

test('section cache uses section contract and content; changing one section leaves others cached', async () => {
  const memory = new Map<string, any>(); const calls: string[] = [];
  let proposal = map([section('A',1,2), section('B',3,4), section('C',5,6)]);
  const execute = () => runMapFirstRead({ lines:longLines, images:[], settings:settings(), fileHash:'cache',
    cacheGet: async <T,>(key:string) => memory.get(key) as T | undefined,
    cacheSet: async (key:string,value:unknown) => { memory.set(key,value); }, cacheKey: async text => text,
    call: async (label,_system,_text) => {
      calls.push(label); if (label.startsWith('Map')) return response(proposal);
      if (label.startsWith('Section parse')) { const title=label.split(' · ')[1]; return response({questions:(title==='A'?[1,2]:title==='B'?[3,4]:[5,6]).map(question)}); }
      return response({});
    } });
  await execute(); assert.equal(calls.filter(x=>x.startsWith('Section parse')).length,3);
  calls.length=0; proposal = map([{...section('A',1,2),kind:'grammar'}, section('B',3,4), section('C',5,6)]);
  await execute(); assert.deepEqual(calls.filter(x=>x.startsWith('Section parse')), ['Section parse · A']);
});

test('context rejection retries mapping at page boundaries with overlap, rather than abandoning the read', async () => {
  const calls: Array<{label:string,text:string}> = [];
  const result = await runMapFirstRead({ lines:longLines, images:[], settings:settings(), fileHash:'context', ...noCache,
    call: async (label,_system,text) => {
      calls.push({label,text});
      if (label === 'Map · 1/1') throw new Error('context length exceeded');
      if (label.startsWith('Map')) return response(auditMap);
      if (label.startsWith('Section parse')) { const title=label.split(' · ')[1]; return response({questions:(title==='A'?[1,2]:title==='B'?[3,4]:[5,6]).map(question)}); }
      return response({});
    } });
  assert.ok(result); assert.ok(calls.filter(c=>c.label.startsWith('Map')).length > 2);
  const secondChunk = calls.find(c=>c.label.startsWith('Map · 2/'))!;
  assert.match(secondChunk.text,/source-2-detail-34/); assert.match(secondChunk.text,/3\. source 3/);
  assert.equal(result!.document.questions.length,6);
});

test('map image hint prefers the mapped section without overriding a model claim', async () => {
  const { assignAuthoredImages, normalizeAuthoredDocument } = await import('../src/pipeline/localLoop');
  const img: any = { id:'img1', page:1, bbox:{x:0,y:0,w:1,h:1}, mime:'image/png', sha:'', width:1,height:1, blobKey:'img1' };
  const document = normalizeAuthoredDocument({ questions:[{ number:1,sectionTitle:'A',type:'short',stem:'Describe the picture',sourcePages:[1] },{ number:2,sectionTitle:'B',type:'short',stem:'Describe the picture',sourcePages:[1] }] });
  const mapReceipt = parseExamMap(response({ ...map([section('A',1,1),section('B',2,2)]), images:[{imageId:'img1', sectionTitle:'B', aboutQuestion:2}] }))!;
  assignAuthoredImages(document,[img],[line(1,'1. Describe the picture'),line(2,'2. Describe the picture')],mapReceipt);
  assert.deepEqual(document.questions.map(q=>q.imageIds),[[],['img1']]);
});

test('map code identifies outside and duplicate scopes and unknown image IDs', () => {
  const proposal = { ...map([section('A',1,3),section('B',4,6)]),
    instructionGroups:[{appliesToFirst:1,appliesToLast:2,text:'Do these.'},{appliesToFirst:1,appliesToLast:2,text:'Do these too.'}],
    passages:[{id:'p',sectionTitle:'B',appliesToFirst:3,appliesToLast:4,text:'Passage'}],
    images:[{imageId:'missing-image',sectionTitle:'A',aboutQuestion:1}] };
  const findings = countExamMap(parseExamMap(response(proposal))!,lines,[]);
  assert.ok(findings.some(v=>v.kind==='duplicate-scope'));
  assert.ok(findings.some(v=>v.kind==='scope-outside-section'));
  assert.ok(findings.some(v=>v.kind==='unknown-image'));
});

test('a scoped code remap that resolves the overlap is retained in the map receipt', async () => {
  const proposal = map([section('A',1,4,2),section('B',4,6,3)]);
  const result = await runMapFirstRead({ lines, images:[], settings:settings(), fileHash:'fixed', ...noCache,
    call: async (label) => {
      if (label.startsWith('Map')) return response(proposal);
      if (label==='Re-map · section:0') return response(section('A',1,3,3));
      if (label==='Re-map · section:1') return response(section('B',4,6,3));
      if (label.startsWith('Section parse')) return response({questions:(label.endsWith('A')?[1,2,3]:[4,5,6]).map(question)});
      return response({});
    } });
  assert.equal(result?.map.sections[0].lastQuestion,3);
  assert.equal(result?.map.remaps.find(r=>r.entryId==='section:0')?.applied,true);
  assert.ok(result?.map.remaps.find(r=>r.entryId==='section:0')?.before);
  assert.ok(result?.map.remaps.find(r=>r.entryId==='section:0')?.after);
});

test('scoped shared instruction and passage render once in the final exam', async () => {
  const { DeterministicRenderer } = await import('../src/views/DeterministicRenderer');
  const proposal = { ...map([section('Reading',1,6)]), instructionGroups:[{ appliesToFirst:2, appliesToLast:5, text:'Read the passage and answer each question.' }], passages:[{ id:'p1', sectionTitle:'Reading', appliesToFirst:2, appliesToLast:5, text:'Once there was a long source passage.' }] };
  const requests: LoopModelRequest[] = [];
  const receipt = await runLocalLoop({ lines, images:[], settings:settings(), fileHash:'render', caller:runnerCaller(proposal,{Reading:[1,2,3,4,5,6]},requests) });
  const projected = projectAuthoredDocument(receipt.document);
  const exam: any = { id:'e', fileHash:'x', createdAt:'', displayName:'Exam', meta:{language:'en',direction:'ltr'}, sections:projected.sections, questions:projected.questions, instructionGroups:receipt.document.instructionGroups, passages:receipt.document.passages, images:[], flags:[], usage:[], source:{lines:[],pages:2,ocrUsed:false,fileName:'x.pdf'} };
  const markup = renderToStaticMarkup(React.createElement(DeterministicRenderer,{doc:exam,mode:'paper'}));
  const plain = markup.replace(/<[^>]*>/g,'');
  assert.equal(plain.split('Read the passage and answer each question.').length - 1, 1);
  assert.equal(plain.split('Once there was a long source passage.').length - 1, 1);
});

test('a map passage proposal never silently manufactures a link the section reader omitted', async () => {
  const proposal = { ...map([section('Reading',1,6)]), passages:[{ id:'p1', sectionTitle:'Reading', appliesToFirst:2, appliesToLast:5, text:'Source passage.' }] };
  const receipt = await runLocalLoop({ lines, images:[], settings:settings(), fileHash:'no-invent', caller:async req => {
    if (req.label.startsWith('Map')) return response(proposal);
    if (req.label.startsWith('Section parse')) return response({questions:[1,2,3,4,5,6].map(question)});
    return response({corrections:[]});
  } });
  assert.equal(receipt.document.questions.find(q=>q.number===2)?.passageId,undefined);
  assert.equal(receipt.document.passages?.length,0); assert.equal(receipt.map?.passages.length,1);
  assert.ok(receipt.codeVerdicts.some(v=>v.kind==='passage-link-missing' && v.questionNumbers.includes(2)));
});

test('numbers discovered only by section parsing also trigger the one unmapped parse', async () => {
  const proposal = map([section('A',1,2)]); const source = [line(1,'1. First?'),line(2,'2. Second?'),line(3,'Another question without a detectable printed marker')];
  const requests: LoopModelRequest[] = [];
  const receipt = await runLocalLoop({ lines:source, images:[], settings:settings(), fileHash:'found-by-parse', caller:runnerCaller(proposal,{A:[1,2,7],unmapped:[7]},requests) });
  assert.equal(requests.filter(r=>r.label==='Section parse · unmapped').length,1);
  assert.equal(receipt.document.questions.find(q=>q.number===7)?.sectionTitle,'Unmapped questions');
  assert.ok(receipt.map?.codeVerdicts.some(v=>v.kind==='section-missing' && v.questionNumbers.includes(7)));
});
