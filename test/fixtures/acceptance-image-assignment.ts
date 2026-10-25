import type { ImageAsset, Question, SourceLine } from '../../src/types';

/**
 * Follow-up #36 acceptance fixture — the field's English paper (page-2 picture matching, the study
 * pictures of Q49, and the writing topics 63–66 + Q67 "healthy lifestyle").
 *
 * Numbers mirror the field export: the group parent keeps the first printed number of its own
 * enumeration (Q15 for items 15–18, Q63 for topics 63–66) — exactly as `forms.ts` allows for
 * enumerative groups — and the parent itself owns NO picture.
 */
export const acceptanceLines: SourceLine[] = [
  { id: 'L0001', page: 1, text: 'Vocabulary' },
  { id: 'L0002', page: 1, text: 'Match each picture with the correct word.' },
  // Field layout: the four items share ONE printed line (that is what makes the segmenter
  // emit a group parent and what `carveGroupChildSpans` carves into per-item slices).
  { id: 'L0003', page: 1, text: '15. a) dictionary    16. b) mother    17. c) boy    18. d) solar panel' },
  { id: 'L0004', page: 1, text: '19. Choose the correct definition for each word.' },
  { id: 'L0005', page: 2, text: 'Reading' },
  { id: 'L0006', page: 2, text: '49. Study the two diagrams of the water cycle and label them.' },
  { id: 'L0007', page: 2, text: 'Writing' },
  { id: 'L0008', page: 2, text: 'Write a Topic Sentence for each topic below using the given pictures.' },
  { id: 'L0009', page: 2, text: '63. a) Ferdowsi    64. b) Watching TV    65. c) Sport    66. d) Clean energy' },
  { id: 'L0010', page: 2, text: '67. Write a paragraph about having a healthy lifestyle.' },
  { id: 'L0011', page: 2, text: '68. Circle the best title for the passage.' },
];

const image = (
  id: string, page: number, y: number, anchorLine: number,
  caption: string,
  label?: ImageAsset['label'],
): ImageAsset => ({
  id,
  page,
  bbox: { x: 40, y, w: 160, h: 90 },
  mime: 'image/png',
  sha: `sha_${id}`,
  width: 160,
  height: 90,
  anchorLine,
  blobKey: `blob_${id}`,
  dataUrl: `/api/images/blob_${id}`,
  label: label === undefined ? { role: 'stem', kind: 'photo', caption } : label,
});

/** Reading order = printed order: one picture per item line, then the study pair, then the topics. */
export const acceptanceImages = (): ImageAsset[] => [
  image('img_dict', 1, 120, 3, 'Dictionary entry circled'),
  image('img_mother', 1, 160, 3, 'Mother hugging child'),
  image('img_boy', 1, 200, 3, 'Boy watching TV'),
  // Field defect: vision called the solar picture "decoration"; the arithmetic rebuts it.
  image('img_solar', 1, 240, 3, 'Solar panel sun icon', { role: 'decoration', kind: 'decoration', caption: 'Solar panel sun icon' }),
  image('img_study_a', 2, 80, 6, 'Water cycle diagram'),
  image('img_study_b', 2, 130, 6, 'Water cycle label boxes'),
  image('img_ferdowsi', 2, 240, 9, 'Ferdowsi statue portrait'),
  image('img_tv', 2, 280, 9, 'Boy watching TV'),
  image('img_sport', 2, 320, 9, 'Sports equipment collection'),
  image('img_clean', 2, 360, 9, 'Clean energy city'),
  image('img_healthy', 2, 430, 10, 'Fresh fruit and vegetables'),
];

const span = (line: number): [number, number] => [line, line];

/** Group parents keep their own first printed number; children carry the enumerated items. */
export const acceptanceQuestions = (): Question[] => [
  {
    id: 'q15', label: '15', no: 15, sectionId: 'sec_vocab', spans: [span(2)],
    stem: 'Match each picture with the correct word.', type: 'matching', points: 2, confidence: 0.9,
    images: [], answer: { text: 'dictionary / mother / boy / solar panel', source: 'paper' },
    receipt: { lineStart: 2, lineEnd: 2, ruleChain: ['enumerative-group'], ruleConfidence: 88 },
  },
  ...([
    ['q15_c15', 15, 3, 'dictionary'],
    ['q15_c16', 16, 3, 'mother'],
    ['q15_c17', 17, 3, 'boy'],
    ['q15_c18', 18, 3, 'solar panel'],
  ] as const).map(([id, no, lineNo, item]) => ({
    id, label: String(no), no, parentId: 'q15', sectionId: 'sec_vocab', spans: [span(lineNo)],
    stem: item, type: 'matching' as const, points: 0.5, confidence: 0.9, images: [] as Question['images'],
    answer: { text: item, source: 'paper' as const },
    receipt: { lineStart: lineNo, lineEnd: lineNo, ruleChain: ['enumerative-group-child'], ruleConfidence: 88 },
  })),
  {
    id: 'q19', label: '19', no: 19, sectionId: 'sec_vocab', spans: [span(4)],
    stem: 'Choose the correct definition for each word.', type: 'short', points: 1, confidence: 0.9,
    images: [], answer: { text: 'definitions', source: 'paper' },
    receipt: { lineStart: 4, lineEnd: 4, ruleChain: ['question-start'], ruleConfidence: 90 },
  },
  {
    id: 'q49', label: '49', no: 49, sectionId: 'sec_reading', spans: [span(6)],
    stem: 'Study the two diagrams of the water cycle and label them.', type: 'short', points: 2, confidence: 0.9,
    images: [], answer: { text: 'evaporation, condensation', source: 'paper' },
    receipt: { lineStart: 6, lineEnd: 6, ruleChain: ['question-start'], ruleConfidence: 90 },
  },
  {
    id: 'q63', label: '63', no: 63, sectionId: 'sec_writing', spans: [span(8)],
    stem: 'Write a Topic Sentence for each topic below using the given pictures.', type: 'essay', points: 1,
    confidence: 0.9, images: [], answer: { text: 'model paragraph', source: 'paper' },
    receipt: { lineStart: 8, lineEnd: 8, ruleChain: ['enumerative-group'], ruleConfidence: 87 },
  },
  ...([
    ['q63_c63', 63, 9, 'Ferdowsi'],
    ['q63_c64', 64, 9, 'Watching TV'],
    ['q63_c65', 65, 9, 'Sport'],
    ['q63_c66', 66, 9, 'Clean energy'],
  ] as const).map(([id, no, lineNo, topic]) => ({
    id, label: String(no), no, parentId: 'q63', sectionId: 'sec_writing', spans: [span(lineNo)],
    stem: topic, type: 'essay' as const, points: 1, confidence: 0.9, images: [] as Question['images'],
    answer: { text: `Topic sentence about ${topic}.`, source: 'paper' as const },
    receipt: { lineStart: lineNo, lineEnd: lineNo, ruleChain: ['enumerative-group-child'], ruleConfidence: 87 },
  })),
  {
    id: 'q67', label: '67', no: 67, sectionId: 'sec_writing', spans: [span(10)],
    stem: 'Write a paragraph about having a healthy lifestyle.', type: 'essay', points: 2,
    confidence: 0.9, images: [], answer: { text: 'model paragraph', source: 'paper' },
    receipt: { lineStart: 10, lineEnd: 10, ruleChain: ['question-start'], ruleConfidence: 90 },
  },
];

export const acceptanceSections = [
  { id: 'sec_vocab', index: 1, title: 'Vocabulary', spans: [span(1), span(4)] as [number, number][] },
  { id: 'sec_reading', index: 2, title: 'Reading', spans: [span(5), span(6)] as [number, number][] },
  { id: 'sec_writing', index: 3, title: 'Writing', spans: [span(7), span(11)] as [number, number][] },
];

/**
 * Godlike Batch 1 field shape — how the post-#36 parse ACTUALLY modelled page 2:
 * parent(15) + THREE children (16,17,18) with token stems, the sentences a–e living in the
 * parent's shared option pool (the children's matching targets). Writing likewise arrives as
 * parent(63) + children 64/65/66. The parent-as-item bijection must still deal 4↔4 and 4↔4.
 */
export const acceptanceFieldLines: SourceLine[] = [
  { id: 'L0001', page: 1, text: 'Vocabulary' },
  { id: 'L0002', page: 1, text: 'Look at the pictures and choose the correct sentence for each picture. (One sentence is extra.)' },
  { id: 'L0003', page: 1, text: '(15)  (16)  (17)  (18)' },
  { id: 'L0004', page: 1, text: 'a. The mother is hugging her little child.' },
  { id: 'L0005', page: 1, text: 'b. My sister often sits in the balcony and studies her lessons.' },
  { id: 'L0006', page: 1, text: 'c. The student circled the dictionary entry for the new word.' },
  { id: 'L0007', page: 1, text: 'd. Solar panels change solar power into electricity.' },
  { id: 'L0008', page: 1, text: 'e. The sofa converts into bed.' },
  { id: 'L0009', page: 1, text: '19. Choose the correct definition for each word.' },
  { id: 'L0010', page: 2, text: 'Reading' },
  { id: 'L0011', page: 2, text: '49. Study the two diagrams of the water cycle and label them.' },
  { id: 'L0012', page: 2, text: 'Writing' },
  { id: 'L0013', page: 2, text: 'Write a Topic Sentence for each topic below using the given pictures.' },
  { id: 'L0014', page: 2, text: '66. d) Clean energy… 65. c) Sport……… 64. b) Watching TV…… 63. a) Ferdowsi….' },
  { id: 'L0015', page: 2, text: '67. Write a paragraph about having a healthy lifestyle.' },
  { id: 'L0016', page: 2, text: '68. Circle the best title for the passage.' },
];

const FIELD_ANCHORS: Record<string, number> = {
  img_dict: 3, img_mother: 3, img_boy: 3, img_solar: 3,
  img_study_a: 11, img_study_b: 11,
  img_ferdowsi: 14, img_tv: 14, img_sport: 14, img_clean: 14,
  img_healthy: 15,
};

/** Same pictures, captions and reading order as the #36 fixture, anchored to the field lines. */
export const acceptanceFieldImages = (): ImageAsset[] =>
  acceptanceImages().map(item => ({ ...item, anchorLine: FIELD_ANCHORS[item.id] ?? item.anchorLine }));

/** Parent-as-item shape: Q15 IS item 15 (answer letter c), Q63 IS topic 63; children are tokens/topics. */
export const acceptanceFieldQuestions = (): Question[] => [
  {
    id: 'q15', label: '15', no: 15, sectionId: 'sec_vocab', spans: [span(2)],
    stem: 'Look at the pictures and choose the correct sentence for each picture. (One sentence is extra.)',
    type: 'matching', points: 2, confidence: 0.9, images: [],
    options: [
      { key: 'a', spans: [span(4)], text: 'The mother is hugging her little child.' },
      { key: 'b', spans: [span(5)], text: 'My sister often sits in the balcony and studies her lessons.' },
      { key: 'c', spans: [span(6)], text: 'The student circled the dictionary entry for the new word.' },
      { key: 'd', spans: [span(7)], text: 'Solar panels change solar power into electricity.' },
      { key: 'e', spans: [span(8)], text: 'The sofa converts into bed.' },
    ],
    answer: { text: '( c )', source: 'paper' },
    receipt: { lineStart: 2, lineEnd: 2, ruleChain: ['enumerative-group'], ruleConfidence: 88 },
  },
  ...([
    ['q16', 16, '( a )'],
    ['q17', 17, '( b )'],
    ['q18', 18, '( d )'],
  ] as const).map(([id, no, letter]) => ({
    id, label: String(no), no, parentId: 'q15', sectionId: 'sec_vocab', spans: [span(3)],
    stem: `(${no})`, type: 'matching' as const, points: 0.5, confidence: 0.9, images: [] as Question['images'],
    answer: { text: letter, source: 'paper' as const },
    receipt: { lineStart: 3, lineEnd: 3, ruleChain: ['enumerative-group-child'], ruleConfidence: 88 },
  })),
  {
    id: 'q19', label: '19', no: 19, sectionId: 'sec_vocab', spans: [span(9)],
    stem: 'Choose the correct definition for each word.', type: 'short', points: 1, confidence: 0.9,
    images: [], answer: { text: 'definitions', source: 'paper' },
    receipt: { lineStart: 9, lineEnd: 9, ruleChain: ['question-start'], ruleConfidence: 90 },
  },
  {
    id: 'q49', label: '49', no: 49, sectionId: 'sec_reading', spans: [span(11)],
    stem: 'Study the two diagrams of the water cycle and label them.', type: 'short', points: 2, confidence: 0.9,
    images: [], answer: { text: 'evaporation, condensation', source: 'paper' },
    receipt: { lineStart: 11, lineEnd: 11, ruleChain: ['question-start'], ruleConfidence: 90 },
  },
  {
    id: 'q63', label: '63', no: 63, sectionId: 'sec_writing', spans: [span(13)],
    stem: 'Write a Topic Sentence for each topic below using the given pictures.', type: 'essay', points: 1,
    confidence: 0.9, images: [], answer: { text: 'Topic sentence about Ferdowsi.', source: 'paper' },
    receipt: { lineStart: 13, lineEnd: 13, ruleChain: ['enumerative-group'], ruleConfidence: 87 },
  },
  ...([
    ['q64', 64, 'Watching TV'],
    ['q65', 65, 'Sport'],
    ['q66', 66, 'Clean energy'],
  ] as const).map(([id, no, topic]) => ({
    id, label: String(no), no, parentId: 'q63', sectionId: 'sec_writing', spans: [span(14)],
    stem: topic, type: 'essay' as const, points: 1, confidence: 0.9, images: [] as Question['images'],
    answer: { text: `Topic sentence about ${topic}.`, source: 'paper' as const },
    receipt: { lineStart: 14, lineEnd: 14, ruleChain: ['enumerative-group-child'], ruleConfidence: 87 },
  })),
  {
    id: 'q67', label: '67', no: 67, sectionId: 'sec_writing', spans: [span(15)],
    stem: 'Write a paragraph about having a healthy lifestyle.', type: 'essay', points: 2,
    confidence: 0.9, images: [], answer: { text: 'model paragraph', source: 'paper' },
    receipt: { lineStart: 15, lineEnd: 15, ruleChain: ['question-start'], ruleConfidence: 90 },
  },
];

/** Expected image → printed number after Part B (the acceptance table). */
export const acceptanceAssignment: Record<string, number> = {
  img_dict: 15,
  img_mother: 16,
  img_boy: 17,
  img_solar: 18,
  img_study_a: 49,
  img_study_b: 49,
  img_ferdowsi: 63,
  img_tv: 64,
  img_sport: 65,
  img_clean: 66,
  img_healthy: 67,
};
