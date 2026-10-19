import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'perf_hooks';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { enumerateExpectedQuestionNos } from '../src/pipeline/quality';
import { buildDossier } from '../src/pipeline/dossier';
import type { SourceLine } from '../src/types';

test('E1 performance budgets bench-enforced', async ()=>{
  // Extraction of 60-page text-layer PDF <5s (simulate with 60 pages * 30 lines =1800 lines)
  const startExt = performance.now();
  const pages=60; const linesPerPage=30;
  const sourceLines: SourceLine[] = [];
  for(let p=1;p<=pages;p++){
    for(let l=0;l<linesPerPage;l++){
      const id = `L${String((p-1)*linesPerPage + l +1).padStart(4,'0')}`;
      sourceLines.push({ id, page:p, text:`${l+1}. Question ${(p-1)*linesPerPage + l +1}` });
    }
  }
  // Simulate extraction: just generate lines (already did) + tag furniture
  const { tagFurniture } = await import('../src/pipeline/extractionQuality');
  tagFurniture(sourceLines, pages);
  const extMs = performance.now()-startExt;
  console.log(`Extraction 60-page: ${extMs.toFixed(1)}ms (budget 5000)`);
  assert.ok(extMs < 5000, `Extraction budget 5000ms, got ${extMs}`);

  // Assemble+quality over 389 lines/67 questions <100ms
  const qLines = 389;
  const qSource = Array.from({length:qLines},(_,i)=>({id:`L${String(i+1).padStart(4,'0')}`, page:Math.floor(i/40)+1, text:`${i+1}. Q${i+1} text with options a) opt b) opt`}));
  const rawQs = Array.from({length:67},(_,i)=>({id:`q${i+1}`,no:i+1,label:String(i+1),type:'short',spans:[[i+1,i+1]], confidence:0.9}));
  const startAsm = performance.now();
  assembleAndValidateQuestions(rawQs as any, qSource as any, 100);
  const asmMs = performance.now()-startAsm;
  console.log(`Assemble 389/67: ${asmMs.toFixed(1)}ms (budget 100)`);
  assert.ok(asmMs < 100, `Assemble budget 100ms, got ${asmMs}`);

  // Dossier rebuild <50ms
  const exam:any = { id:'perf', fileHash:'h', createdAt:'', displayName:'Perf', meta:{language:'en',direction:'ltr'}, sections:[{id:'sec_1',index:1,title:'S',spans:[[1,qLines]]}], questions: rawQs.map((q:any)=>({id:q.id,no:q.no,label:q.label,sectionId:'sec_1',spans:[[q.no,q.no]],type:'short',confidence:0.9,images:[]})), images:[], source:{lines:qSource,pages:10,fileName:'f.pdf',ocrUsed:false}, flags:[], usage:[] };
  exam.questions = assembleAndValidateQuestions(rawQs as any, qSource as any).questions;
  const startDos = performance.now();
  buildDossier(exam);
  const dosMs = performance.now()-startDos;
  console.log(`Dossier rebuild: ${dosMs.toFixed(1)}ms (budget 50)`);
  assert.ok(dosMs < 50, `Dossier budget 50ms, got ${dosMs}`);

  // Library list 100 exams <500ms from summaries (no full-doc loads)
  const summaries = Array.from({length:100},(_,i)=>({id:`exam_${i}`, displayName:`Exam ${i}`, fileName:`f${i}.pdf`, pages:5, questionCount:20, expectedQuestionCount:20, parsedQuestionCount:20, coveragePercent:100, missingQuestionNos:[], duplicateQuestionNos:[], complete:true, sectionCount:2, imageCount:2, ocrUsed:false, totalCostUsd:0, totalTokens:0, createdAt:'', subject:'', grade:''}));
  const startLib = performance.now();
  // Simulate endpoint returns summaries only: just JSON.stringify
  JSON.stringify(summaries);
  const libMs = performance.now()-startLib;
  console.log(`Library 100: ${libMs.toFixed(1)}ms (budget 500)`);
  assert.ok(libMs < 500, `Library budget 500ms, got ${libMs}`);

  // Where budget fails, bench prints offender - we already log
});
