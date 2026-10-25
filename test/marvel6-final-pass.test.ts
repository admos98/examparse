import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamDoc, LLMRequest, LLMResponse, Question, SourceLine } from '../src/types';
import type { ExtractedDocument } from '../src/pipeline/extract';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { canonicalizeForms, computeShapeAudit, runFinalCanonicalization } from '../src/pipeline/forms';
import { canonicalizeQuestionInDoc, createToolRegistry, splitGroupChildrenInDoc } from '../src/pipeline/agentTools';
import { runFullPipeline } from '../src/pipeline';
import { getExamHealth, validateExamInvariants } from '../src/pipeline/quality';
import { LLMAdapter } from '../src/providers/adapter';
import { DEFAULT_SETTINGS } from '../src/store';
import { sha256 } from '../src/utils/hash';
import { runCorpus } from '../scripts/corpus';

const mkLine = (no: number, text: string, page = 1): SourceLine => ({
  id: `L${String(no).padStart(4, '0')}`,
  page,
  text,
});

type QInit = Omit<Question, 'label' | 'images'> & { label?: string; images?: Question['images'] };
const mkQ = (q: QInit): Question => ({ label: String(q.no), images: [], ...q });

function mkDoc(lines: SourceLine[], questions: QInit[], sections?: ExamDoc['sections']): ExamDoc {
  return {
    id: 'exam_marvel6',
    fileHash: 'hash_marvel6',
    createdAt: '2026-10-23T00:00:00.000Z',
    displayName: 'Marvel 6',
    meta: { language: 'en', direction: 'ltr', totalPoints: 2 },
    sections: sections || [{ id: 'sec_1', index: 1, title: 'Grammar', spans: [[1, lines.length]] }],
    questions: questions.map(mkQ),
    images: [],
    source: { lines, pages: 1, ocrUsed: false, fileName: 'test.pdf', expectedQuestionNos: questions.map(q => q.no) },
    flags: [],
    usage: [],
  } as ExamDoc;
}

/** In-memory folder storage stand-in (same contract the app's /api/exams uses). */
function mockFolderStorage() {
  const saved = new Map<string, ExamDoc>();
  const originalFetch = globalThis.fetch;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || (typeof input === 'object' && input && 'method' in input ? (input as any).method : 'GET');
    const examMatch = url.match(/^\/api\/exams\/([^/?]+)/);
    if (examMatch) {
      const id = decodeURIComponent(examMatch[1]);
      if (method === 'PUT') {
        saved.set(id, JSON.parse(String(init?.body)) as ExamDoc);
        return json({ ok: true });
      }
      if (method === 'GET') {
        const doc = saved.get(id);
        return doc ? json(doc) : json({ error: 'not found' }, 404);
      }
    }
    // Journal/settings endpoints must read as "absent", never as a malformed journal object.
    if (url.startsWith('/api/')) return method === 'GET' ? json({ error: 'not found' }, 404) : json({ ok: true });
    return json({ ok: true });
  }) as typeof fetch;
  return { saved, restore: () => { globalThis.fetch = originalFetch; } };
}

// ============================================================================
// T1 — a replacement question adopted AFTER assembly is canonicalized by the
//      final pass (the field's repair/critic path).
// ============================================================================

test('T1 final pass: a post-assemble whole-line True/False replacement becomes [True, False] with a clean stem', () => {
  const lines = [
    mkLine(1, '1.  Her mother said to him to call the bus station.  a) True  b) False'),
    mkLine(2, '2.  Early humans discovered how to make fire.  a) True  b) False'),
  ];
  const sections: ExamDoc['sections'] = [{ id: 'sec_1', index: 1, title: 'Grammar', spans: [[1, 2]] }];

  // First pass runs through the assembler (which canonicalizes early, as before).
  const assembled = assembleAndValidateQuestions([
    { id: 'q1', no: 1, type: 'mcq', spans: [[1, 1]], confidence: 0.85, options: [{ key: 'a', spans: [[1, 1]] }, { key: 'b', spans: [[1, 1]] }] },
    { id: 'q2', no: 2, type: 'mcq', spans: [[2, 2]], confidence: 0.85, options: [{ key: 'a', spans: [[2, 2]] }, { key: 'b', spans: [[2, 2]] }] },
  ], lines, 2, { gapCompletion: false, sections });
  assert.deepEqual(assembled.questions.map(q => q.options?.map(o => o.text)), [['True', 'False'], ['True', 'False']]);

  // The field defect: repair/critic replace these questions wholesale with the whole source
  // line as stem AND as both options — never re-entering the assembler.
  const replaced = assembled.questions.map(q => {
    const span: [number, number] = [q.no, q.no];
    const wholeLine = lines[q.no - 1].text;
    return {
      ...q,
      type: 'mcq' as const,
      spans: [span],
      stem: wholeLine,
      options: [
        { key: 'a', spans: [span], text: wholeLine },
        { key: 'b', spans: [span], text: wholeLine },
      ],
    };
  });
  assert.ok(replaced.every(q => (q.options || []).every(o => (o.text || '').includes('a) True'))));

  const final = runFinalCanonicalization({ questions: replaced, sourceLines: lines, sections });
  for (const q of final.questions) {
    assert.equal(q.type, 'truefalse');
    assert.deepEqual(q.options?.map(o => o.text), ['True', 'False']);
    assert.ok(!/a\)\s*true/i.test(q.stem || ''), `stem still carries the inline TF tail: ${q.stem}`);
    assert.ok(!/b\)\s*false/i.test(q.stem || ''));
  }
  assert.deepEqual(final.shapeAudit, { optionIncludesStem: 0, duplicateSiblingStems: 0, overlongStems: 0 });
  assert.deepEqual(computeShapeAudit(final.questions), final.shapeAudit);
});

test('T1/Fix4: a stem over the 500-char brake keeps its text verbatim, is flagged STEM_OVERLONG and named in health', () => {
  const longText = `38. ${'The passage keeps describing early humans and their tools. '.repeat(16)}`.trim();
  assert.ok(longText.length > 500);
  const lines = [mkLine(1, 'Reading'), mkLine(2, longText)];
  const sections: ExamDoc['sections'] = [{ id: 'sec_1', index: 1, title: 'Reading', spans: [[1, 2]] }];
  const doc = mkDoc(lines, [{
    id: 'q38', no: 38, sectionId: 'sec_1', spans: [[1, 2]], stem: longText, type: 'short', confidence: 0.8,
  }], sections);

  const final = runFinalCanonicalization({ questions: doc.questions, sourceLines: lines, sections });
  const q38 = final.questions.find(q => q.id === 'q38')!;
  assert.equal(q38.stem, longText, 'no invention/truncation of the surviving stem');
  assert.ok((q38.flags || []).includes('STEM_OVERLONG'));
  assert.deepEqual(final.stemOverlong.map(item => item.no), [38]);
  assert.ok(final.flags.some(flag => flag.code === 'STEM_OVERLONG' && flag.questionId === 'q38'));

  const health = getExamHealth({ ...doc, questions: final.questions, source: { ...doc.source, finalShapeAudit: final.shapeAudit } });
  assert.deepEqual(health.stemOverlong, [{ id: 'q38', no: 38, label: '38', length: longText.length }]);
  assert.equal(health.shapeAudit?.overlongStems, 1);
});

test('T1c shape audit: surviving classes are counted and diagnosed by question number (PARTIAL_EXAM input)', () => {
  const lines = [mkLine(1, 'Same words here'), mkLine(2, 'Same words here')];
  const questions = [
    mkQ({ id: 'q1', no: 1, sectionId: 'sec_1', spans: [[1, 1]], stem: 'Same words here', type: 'short', confidence: 0.9 }),
    mkQ({ id: 'q2', no: 2, sectionId: 'sec_1', spans: [[2, 2]], stem: 'Same words here', type: 'short', confidence: 0.9 }),
  ];
  const final = runFinalCanonicalization({
    questions,
    sourceLines: lines,
    sections: [{ id: 'sec_1', index: 1, title: 'Grammar', spans: [[1, 2]] }],
  });
  assert.equal(final.shapeAudit.duplicateSiblingStems, 1);
  assert.deepEqual(final.shapeProblems.map(problem => problem.no).sort((a, b) => a - b), [1, 2]);
  assert.ok(final.shapeProblems.every(problem => problem.kinds.includes('sibling-identical-stem')));
});

// ============================================================================
// T2 — Assistant-tool adoption: offset-sliced distinct children, no
//      self-numbered phantom child.
// ============================================================================

function groupFixture(): { lines: SourceLine[]; doc: ExamDoc } {
  const lines = [
    mkLine(1, '(15)  (16)  (17)  (18)'),
    mkLine(2, 'a) The mother is hugging her little child.'),
    mkLine(3, 'b) My sister often sits in the balcony and studies her lessons.'),
    mkLine(4, 'c) The student circled the dictionary entry for the new word.'),
    mkLine(5, 'd) Solar panels change solar power into electricity.'),
    mkLine(6, 'e) The sofa converts into bed.'),
  ];
  const doc = mkDoc(lines, [{
    id: 'q15', no: 15, sectionId: 'sec_1', spans: [[1, 1]], stem: '(15)  (16)  (17)  (18)',
    type: 'matching', points: 2, confidence: 0.85,
    options: [
      { key: 'a', spans: [[2, 2]], text: lines[1].text },
      { key: 'b', spans: [[3, 3]], text: lines[2].text },
      { key: 'c', spans: [[4, 4]], text: lines[3].text },
      { key: 'd', spans: [[5, 5]], text: lines[4].text },
      { key: 'e', spans: [[6, 6]], text: lines[5].text },
    ],
  }]);
  return { lines, doc };
}

const phantomChild = (parent: Question): Question => ({
  id: `${parent.id}_c15`, no: 15, label: '15', parentId: parent.id, sectionId: parent.sectionId,
  spans: parent.spans, stem: parent.stem, points: 0, type: parent.type, confidence: 0.6, images: [],
});

test('T2 split_group_children: children get offset-sliced distinct stems at creation, never the parent number', () => {
  const { lines, doc } = groupFixture();
  const split = splitGroupChildrenInDoc(doc, 'q15');
  assert.equal(split.ok, true);
  assert.deepEqual(split.added, [16, 17, 18]);

  const children = split.doc.questions.filter(question => question.parentId === 'q15');
  assert.deepEqual(children.map(child => child.no).sort((a, b) => a - b), [16, 17, 18]);
  assert.equal(children.some(child => child.no === 15), false, 'no child may carry the parent printed number');

  const stems = children.map(child => child.stem || '');
  assert.equal(new Set(stems).size, stems.length, `child stems must be distinct: ${JSON.stringify(stems)}`);
  const spans = children.map(child => child.spans[0] as any);
  assert.ok(spans.every(span => span && span.line === 1), 'children carry OffsetSpans on the shared group line');
  assert.equal(new Set(spans.map(span => JSON.stringify(span))).size, spans.length, 'child spans are disjoint');
  for (const child of children) {
    assert.equal(child.stem, lines[0].text.slice((child.spans[0] as any).start, (child.spans[0] as any).end).trim());
  }
});

test('T2 phantom: a child numbered as its own parent is dropped by the canonicalizer, at creation and via the tool', async () => {
  const { doc } = groupFixture();
  const parent = doc.questions[0];
  const withPhantom: ExamDoc = { ...doc, questions: [...doc.questions, phantomChild(parent)] };

  // Adoption-time canonicalization (repair/critic/recovery/Assistant all funnel through it).
  const canonical = canonicalizeQuestionInDoc(withPhantom, { scope: 'exam' });
  assert.equal(canonical.doc.questions.some(q => q.no === 15 && q.parentId === 'q15'), false);
  assert.ok(canonical.doc.flags.some(flag => flag.code === 'PHANTOM_SELF_CHILD_REMOVED'));
  assert.equal(canonical.doc.questions.filter(q => q.no === 15).length, 1, 'the real parent 15 survives');

  // Registry path — exactly what the Assistant calls.
  let live = withPhantom;
  const registry = createToolRegistry({
    getDoc: () => live,
    getSettings: () => structuredClone(DEFAULT_SETTINGS),
    updateDoc: async next => { live = next; },
    updateSettings: async () => undefined,
    retryMissing: async current => current,
  });
  const result = (await registry.canonicalize_question.execute({ scope: 'exam' })) as any;
  assert.equal(result.ok, true);
  assert.equal(live.questions.some(q => q.no === 15 && q.parentId === 'q15'), false);

  // Creation path: splitting the parent again cannot mint a new phantom (15 is already taken).
  const split = splitGroupChildrenInDoc(withPhantom, 'q15');
  assert.deepEqual(split.added, [16, 17, 18]);
  assert.equal(split.doc.questions.some(q => q.parentId === 'q15' && q.no === 15), false, 'adoption drops the pre-existing phantom');
});

// ============================================================================
// T3 — the corpus takes the field's path (malformed first pass → replacement
//      adoption → final pass).
// ============================================================================

test('T3 corpus: malformed-first-pass profile is green (shape audit 0/0/0, 12/12 spot checks)', async () => {
  const corpus = await runCorpus({ strict: true, print: false });
  assert.equal(corpus.ok, true);
  const malformed = corpus.results.find(result => result.malformedProfile === true);
  assert.ok(malformed, 'malformed-first-pass profile ran');
  assert.equal(malformed!.exam, 'english-final-13991009pq89w65173·malformed-first-pass');
  assert.equal(malformed!.recall, '67/67');
  assert.equal(malformed!.sections, '8/8');
  assert.equal(malformed!.total, '48');
  assert.equal(malformed!.spotChecks, '12/12');
  assert.equal(malformed!.shapeAuditLabel, '0/0/0');
  assert.deepEqual(malformed!.shapeAudit, { optionIncludesStem: 0, duplicateSiblingStems: 0, overlongStems: 0 });
  assert.equal(malformed!.preAssistantChildren, '15:16,17,18;63:64,65,66');
  assert.deepEqual(malformed!.failures, []);

  const base = corpus.results.find(result => result.exam === 'english-final-13991009pq89w65173')!;
  assert.equal(base.spotChecks, '12/12');
  assert.equal(base.shapeAuditLabel, '0/0/0');
  assert.equal(base.preAssistantChildren, '15:16,17,18;63:64,65,66');
});

// ============================================================================
// T4 — idempotence and registry parity (no forked logic).
// ============================================================================

test('T4 final pass is idempotent and uses the same exported registry as the assembler', () => {
  const lines = [
    mkLine(1, '1.  Her mother said to him to call the bus station.  a) True  b) False'),
    mkLine(2, '2.  Early humans discovered how to make fire.  a) True  b) False'),
  ];
  const sections: ExamDoc['sections'] = [{ id: 'sec_1', index: 1, title: 'Grammar', spans: [[1, 2]] }];
  const malformed = [
    mkQ({ id: 'q1', no: 1, sectionId: 'sec_1', spans: [[1, 1]], stem: lines[0].text, type: 'mcq', confidence: 0.7,
      options: [{ key: 'a', spans: [[1, 1]], text: lines[0].text }, { key: 'b', spans: [[1, 1]], text: lines[0].text }] }),
    mkQ({ id: 'q2', no: 2, sectionId: 'sec_1', spans: [[2, 2]], stem: lines[1].text, type: 'mcq', confidence: 0.7,
      options: [{ key: 'a', spans: [[2, 2]], text: lines[1].text }, { key: 'b', spans: [[2, 2]], text: lines[1].text }] }),
  ];
  const once = runFinalCanonicalization({ questions: malformed, sourceLines: lines, sections });
  const twice = runFinalCanonicalization({ questions: once.questions, sourceLines: lines, sections: once.sections });
  const shape = (questions: Question[]) => questions.map(q => ({ stem: q.stem, options: q.options?.map(o => o.text), type: q.type }));
  assert.deepEqual(shape(twice.questions), shape(once.questions));
  assert.deepEqual(twice.shapeAudit, once.shapeAudit);
  assert.deepEqual(twice.stemOverlong, once.stemOverlong);

  // Same exported function the assembler/gates run — parity proves there is no forked path.
  const viaForms = canonicalizeForms({ questions: malformed, sourceLines: lines, sections });
  assert.deepEqual(shape(viaForms.questions), shape(once.questions));
});
