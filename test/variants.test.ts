import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVariantB, variantHash } from '../src/pipeline/variants';
import type { ExamDoc, Question } from '../src/types';

function makeMcqDoc(): ExamDoc {
  const lines = Array.from({ length: 10 }, (_, i) => ({ id: `L${String(i + 1).padStart(4, '0')}`, page: 1, text: `${i + 1}. Q${i + 1}` }));
  const mcqs: Question[] = Array.from({ length: 5 }, (_, i): Question => ({
    id: `q${i + 1}`,
    label: String(i + 1),
    no: i + 1,
    sectionId: 'sec_1',
    spans: [[i + 1, i + 1]],
    type: 'mcq',
    confidence: 0.9,
    images: [],
    options: [
      { key: 'a', spans: [[i + 1, i + 1]], text: `OptA${i + 1}` },
      { key: 'b', spans: [[i + 1, i + 1]], text: `OptB${i + 1}` },
      { key: 'c', spans: [[i + 1, i + 1]], text: `OptC${i + 1}` },
      { key: 'd', spans: [[i + 1, i + 1]], text: `OptD${i + 1}` },
    ],
    answer: { text: 'b', source: 'paper' },
  }));
  const shortQuestion: Question = {
    id: 'q6', label: '6', no: 6, sectionId: 'sec_1', spans: [[6, 6]], type: 'short', confidence: 0.9, images: [], stem: 'Short answer',
  };

  return {
    id: 'exam_var', fileHash: 'h', createdAt: '', displayName: 'VarTest', meta: { language: 'en', direction: 'ltr' },
    sections: [{ id: 'sec_1', index: 1, title: 'S', spans: [[1, 10]] }],
    questions: [...mcqs, shortQuestion],
    images: [], source: { lines, pages: 1, fileName: 'f.pdf', ocrUsed: false }, flags: [], usage: [],
  };
}

test('D4 seeded shuffle reproducible, answer remapping verified, non-MCQ excluded, variant prints own key', () => {
  const doc = makeMcqDoc();
  const seed = 'test-seed-123';
  const v1 = generateVariantB(doc, seed);
  const v2 = generateVariantB(doc, seed);
  // Same seed => identical doc hash
  assert.equal(variantHash(v1.variant), variantHash(v2.variant));
  // Different seed => different
  const v3 = generateVariantB(doc, 'other-seed');
  assert.notEqual(variantHash(v1.variant), variantHash(v3.variant));

  // Answer remapping verified: correct TEXT invariant over all MCQs
  for (const question of v1.variant.questions.filter(question => question.type === 'mcq')) {
    const original = doc.questions.find(candidate => candidate.id === question.id);
    assert.ok(original?.options && original.answer?.text && question.options && question.answer?.text);
    const originalCorrectText = original.options.find(option => option.key === original.answer?.text)?.text;
    const newCorrectText = question.options.find(option => option.key === question.answer?.text)?.text;
    assert.equal(originalCorrectText, newCorrectText, `TEXT invariant for ${question.id}`);
  }

  // Non-MCQ exclusion noted
  assert.ok(v1.excluded.includes('q6'));
  assert.match(v1.note, /Excluded 1/);

  // Variant prints its own key: each variant question answer should be present and distinct
  assert.equal(v1.variant.questions.filter(question => question.answer).length, 5);
  assert.ok(v1.variant.displayName.includes('Variant B'));
  assert.ok(v1.variant.id.includes(seed.slice(0, 6)));

  // Points/sections preserved
  assert.equal(v1.variant.sections.length, doc.sections.length);
  assert.equal(v1.variant.questions.length, doc.questions.length);
});
