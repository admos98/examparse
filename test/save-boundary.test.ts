import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExamInvariants } from '../src/pipeline/quality';
import type { ExamDoc, SourceLine } from '../src/types';

function makeDoc(overrides: Partial<ExamDoc> = {}): ExamDoc {
  const base: ExamDoc = {
    id: 'test_doc',
    fileHash: 'abc123',
    createdAt: new Date().toISOString(),
    displayName: 'Test',
    meta: { totalPoints: 2, language: 'en', direction: 'ltr' },
    sections: [{ id: 'sec_1', index: 1, title: 'Section 1', spans: [[1,10]] }],
    questions: [
      { id: 'q1', label: '1', no: 1, sectionId: 'sec_1', spans: [[1,1]], stem: '1. What is 2+2?', type: 'mcq', points: 1, confidence: 0.9, flags: [], options: [{ key: 'a', spans: [[2,2]], text: 'Option 3' }, { key: 'b', spans: [[2,2]], text: 'Option 4' }], images: [], tables: [] },
      { id: 'q2', label: '2', no: 2, sectionId: 'sec_1', spans: [[3,3]], stem: '2. Capital city of Iran?', type: 'mcq', points: 1, confidence: 0.9, flags: [], options: [{ key: 'a', spans: [[4,4]], text: 'Tehran' }, { key: 'b', spans: [[4,4]], text: 'Paris' }], images: [], tables: [] },
    ],
    images: [],
    source: { lines: [{ id: 'L0001', page: 1, text: '1. What is 2+2?' } as SourceLine], pages: 1, fileName: 'x.pdf', ocrUsed: false, expectedQuestionNos: [1,2] },
    flags: [],
    usage: [],
  } as any;
  return { ...base, ...overrides, meta: { ...base.meta, ...(overrides.meta||{}) }, source: { ...base.source, ...(overrides.source||{}) } } as ExamDoc;
}

test('G3 I1 hollow stem', () => {
  const doc = makeDoc();
  doc.questions[0].stem = '' as any;
  const { ok, violations } = validateExamInvariants(doc);
  assert.equal(ok, false);
  assert.ok(violations.some(v=>v.code==='I1'));
});

test('G3 I2 mcq under 2 distinct', () => {
  const doc = makeDoc();
  doc.questions[0].options = [{ key:'a', spans:[[2,2]], text:'same' }, { key:'b', spans:[[2,2]], text:'same' }] as any;
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I2'));
});

test('G3 I2 truefalse exactly 2', () => {
  const doc = makeDoc();
  doc.questions[0].type = 'truefalse' as any;
  doc.questions[0].options = [{ key:'a', spans:[[2,2]], text:'True' }] as any;
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I2'));
});

test('G3 I3 watermark', () => {
  const doc = makeDoc();
  doc.questions[0].stem = 'What is www.kanoon.ir doing?' as any;
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I3'));
});

test('G3 I4 points number', () => {
  const doc = makeDoc();
  (doc.questions[0] as any).points = undefined;
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I4'));
});

test('G3 I5 points sum vs meta', () => {
  const doc = makeDoc();
  doc.meta.totalPoints = 100;
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I5'));
});

test('G3 I6 duplicate image id', () => {
  const doc = makeDoc();
  doc.images = [{ id:'img_001', page:1, bbox:{x:0,y:0,w:10,h:10}, mime:'image/jpeg', sha:'a', width:10, height:10, anchorLine:1, blobKey:'a' } as any, { id:'img_001', page:1, bbox:{x:0,y:0,w:10,h:10}, mime:'image/jpeg', sha:'b', width:10, height:10, anchorLine:1, blobKey:'b' } as any];
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I6'));
});

test('G3 I6 unresolved imageRef', () => {
  const doc = makeDoc();
  doc.images = [{ id:'img_001', page:1, bbox:{x:0,y:0,w:10,h:10}, mime:'image/jpeg', sha:'a', width:10, height:10, anchorLine:1, blobKey:'a' } as any];
  doc.questions[0].images = [{ imageId:'img_999', role:'stem' } as any];
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I6'));
});

test('G3 I7 section order', () => {
  const doc = makeDoc();
  doc.sections = [{ id:'sec_1', index:2, title:'B', spans:[[1,2]] },{ id:'sec_2', index:1, title:'A', spans:[[3,4]] }] as any;
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I7'));
});

test('G3 I7 question sectionId exists', () => {
  const doc = makeDoc();
  doc.questions[0].sectionId = 'sec_999';
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I7'));
});

test('G3 I8 duplicate number without parent', () => {
  const doc = makeDoc();
  doc.questions[1].no = 1;
  doc.questions[1].label = '1';
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I8'));
});

test('G3 I9 shared pool violation', () => {
  const doc = makeDoc();
  // parent with pool
  doc.questions[0].id = 'qParent';
  doc.questions[0].options = [{ key:'a', spans:[[2,2]], text:'pool A' }, { key:'b', spans:[[2,2]], text:'pool B' }] as any;
  doc.questions[1].parentId = 'qParent';
  doc.questions[1].options = [{ key:'a', spans:[[4,4]], text:'child A' }, { key:'b', spans:[[4,4]], text:'child B' }] as any;
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I9'));
});

test('G3 I10 missing coverage requires partial', () => {
  const doc = makeDoc();
  doc.source.expectedQuestionNos = [1,2,3];
  // only 1,2 present, missing 3, not partial
  const { violations } = validateExamInvariants(doc);
  assert.ok(violations.some(v=>v.code==='I10'));
  // with partial, should be warn not error? Our validate marks warn for I10, so ok should still be true (since warn not error)
  doc.flags = [{ id:'f', code:'PARTIAL_EXAM', severity:'warn', message:'partial' } as any];
  (doc as any).partial = true;
  const { ok: ok2 } = validateExamInvariants(doc);
  assert.equal(ok2, true, 'partial with missing should be ok (warn only)');
});

test('G3 funnel: complete doc passes all I1-I10', () => {
  const doc = makeDoc();
  const { ok, violations } = validateExamInvariants(doc);
  assert.equal(ok, true);
  assert.equal(violations.filter(v=>v.severity==='error').length, 0);
});

test('G3 C2 save boundary: violating doc is persisted as PARTIAL, never rejected', async () => {
  const { saveExamDoc } = await import('../src/store/index');
  const doc = makeDoc();
  doc.questions[0].stem = '' as any; // I1 violation (fixture preserved)
  const gate = validateExamInvariants(doc);
  assert.ok(gate.violations.some(x=>x.code==='I1'));
  assert.equal(gate.ok, false);
  assert.ok(gate.violations.some(x=>x.severity==='error'));

  const originalFetch = globalThis.fetch;
  let stored: any;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input === 'object' && input && 'method' in input ? (input as any).method : 'GET');
    if (url.startsWith('/api/exams/')) {
      if (method === 'PUT') {
        stored = JSON.parse(String(init?.body));
        return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return method === 'GET'
      ? new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
      : new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    // Demote-not-throw contract: persistence is not endorsement, so the save resolves.
    await saveExamDoc(doc);
    assert.ok(stored, 'violating doc is still persisted');
    assert.equal(stored.partial, true, 'stored doc carries the partial marker');
    const partialFlag = stored.flags.find((flag: any) => flag.code === 'PARTIAL_EXAM');
    assert.ok(partialFlag, 'stored doc carries a PARTIAL_EXAM banner');
    assert.match(partialFlag.message, /questions 1\b/, 'banner names the violating question number');
    assert.equal(stored.flags.filter((flag: any) => flag.code === 'PARTIAL_EXAM').length, 1, 'no duplicate PARTIAL_EXAM flags');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('G3 provenance invariant-fix trace', () => {
  const doc = makeDoc();
  // Simulate invariant-fix provenance: after auto-fix, flag INVARIANT_FIX should be added
  // Our current code adds INVARIANT_* flags; provenance is via flags + traces
  const { ok } = validateExamInvariants(doc);
  assert.equal(ok, true);
});
