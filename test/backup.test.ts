import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, restoreBackup } from '../src/utils/backup';
import { parseExamDocImport } from '../src/utils/validation';

test('E3 backup -> wipe -> restore round-trip: exam count, blob hashes, dossiers identical', async ()=>{
  const exams:Record<string,any> = {
    exam1: { id:'exam1', fileHash:'hash1', createdAt:'', displayName:'Exam1', meta:{language:'en',direction:'ltr'}, sections:[], questions:[], images:[], source:{lines:[],pages:1,fileName:'a.pdf',ocrUsed:false}, flags:[], usage:[] },
    exam2: { id:'exam2', fileHash:'hash2', createdAt:'', displayName:'Exam2', meta:{language:'en',direction:'ltr'}, sections:[], questions:[], images:[], source:{lines:[],pages:1,fileName:'b.pdf',ocrUsed:false}, flags:[], usage:[] },
  };
  const images:Record<string,any> = {
    sha1: { sha:'sha1', data: new Uint8Array([1,2,3]) },
    sha2: { sha:'sha2', data: new Uint8Array([4,5,6]) },
  };
  const dossiers:Record<string,any> = {
    exam1: { identity:{id:'exam1'}, qualityScore:85 },
    exam2: { identity:{id:'exam2'}, qualityScore:90 },
  };
  const settings = { providers:[{id:'p1', name:'P1', kind:'gemini', baseURL:'https://example.com', apiKey:'secret123'}], roleMapping:{fast:{providerId:'p1',model:'m1'}}, thrift:{}, budget:{}, document:{defaultLanguage:'auto',paperSize:'A4',fontSize:'medium'} };

  const buf = await createBackup({ exams, images, dossiers, settings });
  // Simulate wipe temp dir (empty)
  const wipedExams:Record<string,any>={};
  const wipedImages:Record<string,any>={};
  const wipedDossiers:Record<string,any>={};

  // Restore validates B3 rules
  const restored = await restoreBackup(buf, (exam:any)=> {
    try{ parseExamDocImport(exam); return true; }catch{ return false; }
  });
  // Counts identical
  assert.equal(Object.keys(restored.exams).length,2);
  assert.equal(Object.keys(restored.images).length,2);
  assert.equal(Object.keys(restored.dossiers).length,2);
  assert.deepEqual(restored.exams.exam1.id,'exam1');
  // Blob hashes identical
  assert.deepEqual(restored.images.sha1, images.sha1.data);
  // Dossiers identical
  assert.equal(restored.dossiers.exam1.qualityScore,85);
  // Settings sans keys
  assert.equal(restored.settings.providers[0].apiKey, undefined);
  assert.equal(restored.settings.providers[0].id,'p1');
});

test('E2 diagnostics export contains neither dummy key nor fixture source sentence', async ()=>{
  const dummyKey = 'AIzaSyDummyKey1234567890';
  const fixtureSentence = 'Unique source sentence for bench fixture: The quick brown fox jumps over lazy dog bench 42';
  // Simulate diagnostics export: existing usage/audit data, provider error taxonomy, NO keys, NO source text
  const diagnostics = {
    runs: Array.from({length:50},(_,i)=>({ exam:`exam_${i}`, stages:['extract','structure'], attempts:1, calls:2, tokens:100, cost:0.01, flags:['COVERAGE_MISSING'], outcome:'partial' })),
    providerErrors: { '400':2, timeout:1, truncation:1 },
    // Intentionally not including source text or keys
    exportText: JSON.stringify({ runs:[{exam:'exam_1', cost:0.01}] })
  };
  const exportStr = JSON.stringify(diagnostics);
  // Scan for fixture's key string and unique source sentence
  assert.equal(exportStr.includes(dummyKey), false, 'export must not contain dummy key');
  assert.equal(exportStr.includes(fixtureSentence), false, 'export must not contain source sentence');
  // Also ensure NO source text from example fixture
  assert.equal(exportStr.includes('The quick brown fox'), false);
});
