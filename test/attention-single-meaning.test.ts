import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExamDoc, Flag, Question } from '../src/types';
import { computeAttention } from '../src/utils/attention';
import { IntegrityFlags } from '../src/components/IntegrityFlags';
import { Step4ReviewContent } from '../src/views/Step4Review';
import { getExamHealth } from '../src/pipeline/quality';
import { healthSummary } from '../src/pipeline/agent';
import { buildDossier } from '../src/pipeline/dossier';
import { createToolRegistry } from '../src/pipeline/agentTools';
import { DEFAULT_SETTINGS } from '../src/store';

/** C4 fixture: 15 repair rejections + 14 critic notes (app-internal) + 2 missing answers + 1 unplaced image. */
export const attentionFixtureDoc = (): ExamDoc => {
  const questions: Question[] = [
    { id: 'q1', label: '1', no: 1, sectionId: 'sec_1', spans: [[2, 2]], stem: '1. Choose the correct word.', type: 'mcq', points: 1, confidence: 0.95,
      options: [{ key: 'a', text: 'alpha', spans: [[2, 2]] }, { key: 'b', text: 'beta', spans: [[2, 2]] }], answer: { text: 'a', source: 'paper' }, images: [] },
    { id: 'q2', label: '2', no: 2, sectionId: 'sec_1', spans: [[3, 3]], stem: '2. Choose the correct option.', type: 'mcq', points: 1, confidence: 0.95,
      options: [{ key: 'a', text: 'one', spans: [[3, 3]] }, { key: 'b', text: 'two', spans: [[3, 3]] }], answer: { text: 'b', source: 'paper' }, images: [] },
    { id: 'q32', label: '32', no: 32, sectionId: 'sec_1', spans: [[4, 4]], stem: '32. Why does the writer mention the river?', type: 'short', points: 2, confidence: 0.8, images: [] },
    { id: 'q50', label: '50', no: 50, sectionId: 'sec_1', spans: [[5, 5]], stem: '50. Write a sentence about your city.', type: 'long', points: 2, confidence: 0.8, images: [] },
  ];
  const flags: Flag[] = [
    ...Array.from({ length: 15 }, (_, index): Flag => ({
      id: `repair_rejected_${index}`, code: 'TEXT_REPAIR_REJECTED', severity: 'warn',
      message: `Line ${index + 1}: the repair was declined by the local fence.`,
    })),
    ...Array.from({ length: 14 }, (_, index): Flag => ({
      id: `critic_${index}`, code: 'CRITIC_DEFECT', severity: 'warn', questionId: 'q1',
      message: `Critic opinion ${index + 1}: the option wording could be sharper.`,
    })),
  ];
  return {
    id: 'exam_attention_fixture',
    fileHash: 'hash_attention_fixture',
    createdAt: new Date(0).toISOString(),
    displayName: 'Attention fixture',
    meta: { title: 'Attention fixture', language: 'en', direction: 'ltr', totalPoints: 6 },
    sections: [{ id: 'sec_1', index: 1, title: 'Reading', spans: [[1, 5]] }],
    questions,
    images: [
      { id: 'img_unplaced', page: 1, bbox: { x: 10, y: 400, w: 100, h: 80 }, mime: 'image/png', sha: 'unplaced', width: 100, height: 80,
        anchorLine: 40, blobKey: 'blob_unplaced', dataUrl: '/api/images/blob_unplaced', label: { role: 'stem', kind: 'photo', caption: 'A river bank' } },
    ],
    source: {
      lines: [
        { id: 'L0001', page: 1, text: 'Reading' },
        { id: 'L0002', page: 1, text: '1. Choose the correct word. a) alpha b) beta' },
        { id: 'L0003', page: 1, text: '2. Choose the correct option. a) one b) two' },
        { id: 'L0004', page: 1, text: '32. Why does the writer mention the river?' },
        { id: 'L0005', page: 1, text: '50. Write a sentence about your city.' },
      ],
      pages: 1,
      ocrUsed: false,
      fileName: 'attention-fixture.pdf',
      expectedQuestionNos: [1, 2, 32, 50],
    },
    flags,
    usage: [],
  } as ExamDoc;
};

test('C4: 15 repair-rejections + 14 critic notes + 2 missing answers + 1 unplaced image = ONE number (3) on every surface', () => {
  const doc = attentionFixtureDoc();
  const items = computeAttention(doc);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => item.kind).sort(), ['answer-missing', 'answer-missing', 'image-unplaced']);

  // C3 — every item is actionable and the sentence ends with the action.
  for (const item of items) {
    assert.ok(item.action, `${item.id} carries an action`);
    assert.ok(['question', 'image-tray'].includes(item.action.target));
    assert.match(item.plainSentence, /\[(Go|Open|Fix|Solve|Confirm)\]$/);
  }

  // Surface 1+2+3: attention panel header, Step-4 header sentence and the collapsed chip.
  const panelHtml = renderToStaticMarkup(React.createElement(IntegrityFlags, { doc }));
  assert.match(panelHtml, /data-attention-count="3"/);
  assert.match(panelHtml, />3 things need attention</);
  const attentionButtons = panelHtml.match(/data-attention-kind="/g) || [];
  assert.equal(attentionButtons.length, 3, 'opening the panel shows exactly those 3 items');
  assert.doesNotMatch(panelHtml, /data-attention-kind="[^"]*"[^>]*>Q1: /, 'app-internal events are not attention rows');
  assert.match(panelHtml, /TEXT_REPAIR_REJECTED/, 'repair rejections live in the technical log');

  const step4Html = renderToStaticMarkup(
    React.createElement(Step4ReviewContent, {
      examDoc: doc,
      settings: DEFAULT_SETTINGS,
      onUpdateDoc: () => undefined,
      onProceedToExamView: () => undefined,
    }),
  );
  assert.match(step4Html, /3 things need attention/);
  assert.match(step4Html, /data-attention-chip="3"/);
  assert.match(step4Html, /data-attention-count="3"/);

  // Surface 4+5+6: health, dossier and the Assistant all read the same function.
  assert.equal(getExamHealth(doc).attentionCount, 3);
  assert.equal(healthSummary(doc).attention, 3);
  assert.equal(buildDossier(doc).healthSnapshot.attentionCount, 3);
  const registry = createToolRegistry({
    getDoc: () => doc,
    getSettings: () => DEFAULT_SETTINGS,
    updateDoc: async () => undefined,
    updateSettings: async () => undefined,
    retryMissing: async current => current,
  });
  const openIssues = (registry as any).get_open_issues.execute({}) as any;
  assert.equal(openIssues.summary, '3 things need attention');
  assert.equal(openIssues.data.length, 3);
  assert.ok(openIssues.data.every((item: any) => Boolean(item.action)));
});

test('C1: app-internal events alone never create attention items', () => {
  const doc = attentionFixtureDoc();
  doc.flags = [
    ...Array.from({ length: 15 }, (_, index): Flag => ({ id: `r_${index}`, code: 'TEXT_REPAIR_REJECTED', severity: 'warn', message: 'declined' })),
    ...Array.from({ length: 14 }, (_, index): Flag => ({ id: `c_${index}`, code: 'CRITIC_DEFECT', severity: 'warn', message: 'opinion' })),
    ...Array.from({ length: 10 }, (_, index): Flag => ({ id: `k_${index}`, code: 'CONSENSUS_REVIEW', severity: 'warn', message: 'opinion' })),
    ...Array.from({ length: 15 }, (_, index): Flag => ({ id: `p_${index}`, code: 'PASSAGE_DETACHED', severity: 'info', message: 'handled' })),
    { id: 'absorbed', code: 'GAP_ABSORBED', severity: 'info', message: 'handled' },
    { id: 'applied', code: 'TEXT_REPAIR_APPLIED', severity: 'info', message: 'applied' },
  ];
  // Nothing else wrong: every question answered, every image owned → zero human actions.
  doc.questions = doc.questions.map(question => ({ ...question, answer: question.answer || { text: 'answer', source: 'manual' as const } }));
  doc.questions[0].images = [{ imageId: 'img_unplaced', role: 'stem' }];
  assert.deepEqual(computeAttention(doc), []);
  assert.equal(getExamHealth(doc).attentionCount, 0);
  const html = renderToStaticMarkup(React.createElement(IntegrityFlags, { doc }));
  assert.match(html, /Nothing needs your attention/);
  assert.match(html, /TEXT_REPAIR_REJECTED/);
});

test('C1: image items open the tray filtered to the exact images, question items target the question', () => {
  const doc = attentionFixtureDoc();
  const items = computeAttention(doc);
  const imageItem = items.find(item => item.kind === 'image-unplaced')!;
  assert.equal(imageItem.action.target, 'image-tray');
  assert.deepEqual(imageItem.action.imageIds, ['img_unplaced']);
  assert.match(imageItem.plainSentence, /1 picture isn't placed/);
  const answerItem = items.find(item => item.kind === 'answer-missing')!;
  assert.equal(answerItem.action.target, 'question');
  assert.ok(doc.questions.some(question => question.id === answerItem.action.questionId));
  assert.match(answerItem.plainSentence, /has no answer yet — solve it with AI or add it manually\. \[Solve\]$/);
});
