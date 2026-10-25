import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { ImageAsset, LLMRequest, Question } from '../src/types';
import { assignImagesExact, enforceSingleImageOwnership, captionAffinity } from '../src/pipeline/imageOwnership';
import { runStructurePass } from '../src/pipeline/structure';
import { LLMAdapter } from '../src/providers/adapter';
import {
  acceptanceAssignment,
  acceptanceImages,
  acceptanceLines,
  acceptanceQuestions,
} from './fixtures/acceptance-image-assignment';

const ownerByImage = (questions: Question[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const question of questions) for (const ref of question.images) out[ref.imageId] = question.no;
  return out;
};

const runAcceptance = async (mutate?: (questions: Question[], images: ImageAsset[]) => void, adjudicate?: any) => {
  const questions = acceptanceQuestions();
  const images = acceptanceImages();
  mutate?.(questions, images);
  return assignImagesExact({ questions, images, sourceLines: acceptanceLines, adjudicate });
};

/** Re-position the writing group's pictures in a different reading order (caption order ≠ printed order). */
const reorder = (images: ImageAsset[], order: string[]) => {
  for (const [index, id] of order.entries()) {
    const image = images.find(candidate => candidate.id === id)!;
    image.bbox = { ...image.bbox, y: 240 + index * 30 };
  }
  return images;
};

test('T1 acceptance: every image lands on its printed item (4 topic pictures, 4 page-2 pictures, 2 study pictures, 1 healthy picture)', async () => {
  const result = await runAcceptance();
  assert.deepEqual(ownerByImage(result.questions), acceptanceAssignment);

  // Exact per-image assertions (the acceptance table).
  const questionNo = (imageId: string) => result.questions.find(question => question.images.some(ref => ref.imageId === imageId))!.no;
  assert.equal(questionNo('img_dict'), 15);
  assert.equal(questionNo('img_mother'), 16);
  assert.equal(questionNo('img_boy'), 17);
  assert.equal(questionNo('img_solar'), 18);
  assert.equal(questionNo('img_study_a'), 49);
  assert.equal(questionNo('img_study_b'), 49);
  assert.equal(questionNo('img_ferdowsi'), 63);
  assert.equal(questionNo('img_tv'), 64);
  assert.equal(questionNo('img_sport'), 65);
  assert.equal(questionNo('img_clean'), 66);
  assert.equal(questionNo('img_healthy'), 67);

  // B1/I13: single ownership doc-wide, and a group parent never holds an item picture.
  const seen = new Set<string>();
  for (const question of result.questions) {
    for (const ref of question.images) {
      assert.ok(!seen.has(ref.imageId), `${ref.imageId} is owned twice`);
      seen.add(ref.imageId);
    }
  }
  assert.equal(result.questions.find(question => question.id === 'q63')!.images.length, 0, 'parent Q63 holds no topic image');
  assert.equal(result.questions.find(question => question.id === 'q15')!.images.length, 0, 'parent Q15 holds no item picture');

  // B3: the decoration verdict on the solar picture is rebutted, with a receipt.
  assert.ok(result.flags.some(flag => flag.code === 'VISION_DECORATION_REBUTTED' && flag.imageId === 'img_solar'));
  const solar = result.images.find(image => image.id === 'img_solar')!;
  assert.notEqual(solar.label?.role, 'decoration');
  assert.deepEqual(solar.label?.assignment?.ruleChain, ['order-bijection', 'caption-verified']);
  assert.equal(solar.label?.questionRef, 'q15_c18');

  // Every image carries a receipt visible to the inspector.
  assert.equal(result.receipts.length, 11);
  assert.ok(result.receipts.every(receipt => receipt.ruleChain.length > 0));
  assert.equal(result.tray.length, 0);
  assert.equal(result.suspects, 0);
});

test('T1/I13: a parent that duplicates a group image (field Q63 defect) is stripped; final pass enforces single ownership', async () => {
  const result = await runAcceptance(questions => {
    const writingParent = questions.find(question => question.id === 'q63')!;
    writingParent.images = ['img_ferdowsi', 'img_tv', 'img_sport', 'img_clean'].map(imageId => ({ imageId, role: 'stem' as const }));
    const matchingParent = questions.find(question => question.id === 'q15')!;
    matchingParent.images = ['img_dict', 'img_mother', 'img_boy', 'img_solar'].map(imageId => ({ imageId, role: 'stem' as const }));
  });
  assert.deepEqual(ownerByImage(result.questions), acceptanceAssignment);
  assert.equal(result.questions.find(question => question.id === 'q63')!.images.length, 0);
  assert.equal(result.questions.find(question => question.id === 'q15')!.images.length, 0);

  // The save-boundary pass is the second line of defence (I12-style).
  const duplicated = {
    ...result,
    questions: [
      { ...result.questions[0], images: [{ imageId: 'img_dict', role: 'stem' as const }] },
      { ...result.questions[1], images: [{ imageId: 'img_dict', role: 'stem' as const }] },
    ],
  } as any;
  const enforced = enforceSingleImageOwnership(duplicated);
  assert.equal(enforced.removed, 1);
  assert.equal(enforced.doc.questions[1].images.length, 0);
});

test('T1/B5 determinism lock: identical assignment across two runs with flipped synthetic vision verdicts', async () => {
  const baseline = await runAcceptance();
  const flipped = await runAcceptance((_questions, images) => {
    const byId = new Map(images.map(image => [image.id, image]));
    (byId.get('img_study_a') as ImageAsset).label = { role: 'decoration', kind: 'decoration', caption: 'Water cycle diagram' };
    (byId.get('img_healthy') as ImageAsset).label = { role: 'decoration', kind: 'decoration', caption: 'Fresh fruit and vegetables' };
    (byId.get('img_solar') as ImageAsset).label = { role: 'stem', kind: 'photo', caption: 'Solar panel sun icon', questionRef: 'q19' };
    (byId.get('img_ferdowsi') as ImageAsset).label = { role: 'option', kind: 'photo', caption: 'Ferdowsi statue portrait' };
    (byId.get('img_tv') as ImageAsset).label = { role: 'stem', kind: 'photo', caption: 'Boy watching TV', questionRef: 'q63_c63' };
  });
  assert.deepEqual(ownerByImage(flipped.questions), ownerByImage(baseline.questions));
  assert.deepEqual(ownerByImage(flipped.questions), acceptanceAssignment);
});

test('T2 caption affinity: a shuffled picture order is corrected (never silently wrong)', async () => {
  const result = await runAcceptance((_questions, images) => {
    reorder(images, ['img_ferdowsi', 'img_sport', 'img_tv', 'img_clean']);
  });
  assert.deepEqual(ownerByImage(result.questions), acceptanceAssignment, 'caption permutation restores topic↔picture pairing');
  assert.equal(result.corrected, 2);
  const corrected = result.receipts.filter(receipt => receipt.note === 'caption permutation overrides printed order');
  assert.equal(corrected.length, 2);
  assert.deepEqual(corrected.map(receipt => receipt.imageId).sort(), ['img_sport', 'img_tv']);
  assert.ok(!result.flags.some(flag => flag.code === 'IMAGE_ORDER_SUSPECT'));
});

test('T2 caption affinity: a contradicting caption triggers ONE constrained adjudication; its choice only stands when affinity is restored', async () => {
  const images = () => {
    const all = acceptanceImages();
    const set = (id: string, y: number, caption: string) => {
      const image = all.find(candidate => candidate.id === id)!;
      image.bbox = { ...image.bbox, y };
      image.label = { role: 'stem', kind: 'photo', caption };
    };
    set('img_ferdowsi', 240, 'Boy watching TV'); // contradicts topic 63 (Ferdowsi)
    set('img_tv', 280, 'Boy watching TV');
    set('img_sport', 320, 'Sports equipment collection');
    set('img_clean', 360, 'Clean energy city');
    return all;
  };

  let calls = 0;
  let seenCases: any[] = [];
  const applied = await assignImagesExact({
    questions: acceptanceQuestions(),
    images: images(),
    sourceLines: acceptanceLines,
    adjudicate: (cases: any[]) => {
      calls++;
      seenCases = cases;
      return { img_ferdowsi: 'q63_c64' };
    },
  });
  assert.equal(calls, 1, 'exactly one bundled adjudication call for all suspects');
  assert.equal(applied.adjudicated, 1);
  assert.equal(applied.suspects, 0);
  assert.equal(ownerByImage(applied.questions).img_ferdowsi, 64);
  const receipt = applied.receipts.find(item => item.imageId === 'img_ferdowsi')!;
  assert.deepEqual(receipt.ruleChain, ['order-bijection', 'vision-adjudicated']);
  assert.equal(seenCases.length, 1);
  assert.deepEqual(seenCases[0].candidates.map((candidate: any) => candidate.ref), ['q63_c63', 'q63_c64', 'q63_c65', 'q63_c66'],
    'candidates are constrained to the suspect image’s own group children');

  // The model may NOT invent a ref: rejected, printed order stands, the image is flagged for one click.
  const rejected = await assignImagesExact({
    questions: acceptanceQuestions(),
    images: images(),
    sourceLines: acceptanceLines,
    adjudicate: () => ({ img_ferdowsi: 'q99' }),
  });
  assert.equal(ownerByImage(rejected.questions).img_ferdowsi, 63);
  assert.equal(rejected.suspects, 1);
  assert.ok(rejected.flags.some(flag => flag.code === 'IMAGE_ORDER_SUSPECT' && flag.imageId === 'img_ferdowsi'));
});

test('T3 structure prompts carry the image block (captions + per-segment image ids) in the new order', async () => {
  const requestLog: LLMRequest[] = [];
  const execute = mock.method(LLMAdapter, 'execute', async (request: LLMRequest) => {
    requestLog.push(request);
    return {
      json: {
        m: { subject: 'English', totalPoints: 1, language: 'en' },
        s: [{ id: 'sec_1', index: 1, p: [[1, 11]], kind: 'Other' }],
        q: [{ n: 15, s: 'sec_1', t: 'a', p: [[2, 3]], v: 1, c: 9 }],
      },
      rawText: 'fixture structure response',
      finishReason: 'STOP',
      usage: { inputTokens: 10, outputTokens: 10 },
    } as any;
  });
  try {
    const images = acceptanceImages().map(image => ({
      ...image,
      label: { ...image.label, role: image.label?.role === 'decoration' ? ('decoration' as const) : ('stem' as const), provisional: true, source: 'vision' as const },
    }));
    await runStructurePass({
      sourceLines: acceptanceLines,
      images,
      latexEnabled: false,
      forceSectionMode: false,
      segments: [
        { seg: 'S1', kind: 'group-parent', range: [2, 3], n: 15, hint: 'Vocabulary', preview: 'Match each picture with the correct word.' },
      ],
      providerConfig: { id: 'test', name: 'test', kind: 'openai-compatible', model: 'gpt-4o', baseURL: 'https://example.test/v1' },
    } as any);
    assert.ok(requestLog.length >= 1);
    const prompt = requestLog[0].text || '';
    assert.match(prompt, /IMAGE CAPTIONS/, 'structure prompt carries the vision caption block');
    assert.match(prompt, /\[img_dict p1 "Dictionary entry circled"\]/);
    assert.match(prompt, /\[img_ferdowsi p2 "Ferdowsi statue portrait"\]/);
    assert.match(prompt, /caption/, 'the manifest exposes captions to the structure model');
    assert.ok(prompt.indexOf('img_dict') < prompt.indexOf('SOURCE:'), 'image block precedes the source lines');
  } finally {
    execute.mock.restore();
  }
});

test('T2/B3 caption affinity is a deterministic, normalized token overlap', () => {
  assert.ok(captionAffinity('Ferdowsi statue portrait', 'Ferdowsi') >= 1);
  assert.ok(captionAffinity('Mother hugging child', 'The mother is hugging her little child.') >= 2);
  assert.ok(captionAffinity('Sports equipment collection', 'Sport') >= 1, 'plural/topic inflection still matches');
  assert.equal(captionAffinity('Clean energy city', 'Ferdowsi'), 0);
  assert.equal(captionAffinity(undefined, 'anything'), 0);
});

// ============================================================================
// Godlike Batch 1, Part A — parent-as-item bijection (the last image defect)
// ============================================================================
import {
  acceptanceFieldImages,
  acceptanceFieldLines,
  acceptanceFieldQuestions,
} from './fixtures/acceptance-image-assignment';

test('T1 (Godlike-1/A1): field shape parent(15)+3 token children deals 4↔4 — full 11/11 acceptance table', async () => {
  const result = await assignImagesExact({
    questions: acceptanceFieldQuestions(),
    images: acceptanceFieldImages(),
    sourceLines: acceptanceFieldLines,
  });
  // The full T1 image table, now on the field modelling (parent IS item 15 / topic 63).
  assert.deepEqual(ownerByImage(result.questions), acceptanceAssignment);
  const questionNo = (imageId: string) => result.questions.find(q => q.images.some(ref => ref.imageId === imageId))!.no;
  assert.equal(questionNo('img_dict'), 15);
  assert.equal(questionNo('img_mother'), 16);
  assert.equal(questionNo('img_boy'), 17);
  assert.equal(questionNo('img_solar'), 18, 'solar picture placed on its own item (was UNOWNED pre-fix)');
  assert.equal(questionNo('img_study_a'), 49);
  assert.equal(questionNo('img_study_b'), 49);
  assert.equal(questionNo('img_ferdowsi'), 63);
  assert.equal(questionNo('img_tv'), 64);
  assert.equal(questionNo('img_sport'), 65);
  assert.equal(questionNo('img_clean'), 66);
  assert.equal(questionNo('img_healthy'), 67);
  assert.equal(result.tray.length, 0, 'no picture left unowned');
  assert.equal(result.suspects, 0);

  // A3: parent-as-item receipts exist, and the parent retains NO image beyond its own item
  // picture (single ownership I13 — never the whole group set as in the old Q63 defect).
  const dictReceipt = result.receipts.find(receipt => receipt.imageId === 'img_dict')!;
  assert.ok(dictReceipt.ruleChain.includes('parent-as-item'), `parent-as-item receipt present: ${dictReceipt.ruleChain.join('>')}`);
  assert.equal(dictReceipt.questionId, 'q15');
  const ferdowsiReceipt = result.receipts.find(receipt => receipt.imageId === 'img_ferdowsi')!;
  assert.ok(ferdowsiReceipt.ruleChain.includes('parent-as-item'));
  assert.deepEqual(result.questions.find(q => q.id === 'q15')!.images.map(ref => ref.imageId), ['img_dict'],
    'parent Q15 holds exactly its own item picture and no parent-level set');
  assert.deepEqual(result.questions.find(q => q.id === 'q63')!.images.map(ref => ref.imageId), ['img_ferdowsi']);
  const seen = new Set<string>();
  for (const q of result.questions) for (const ref of q.images) {
    assert.ok(!seen.has(ref.imageId), `${ref.imageId} owned twice (I13)`);
    seen.add(ref.imageId);
  }
  assert.equal(seen.size, 11);
  // Token children were verified through their answer-letter → shared-sentence resolution.
  const solarReceipt = result.receipts.find(receipt => receipt.imageId === 'img_solar')!;
  assert.equal(solarReceipt.questionId, 'q18');
  assert.ok(solarReceipt.ruleChain.includes('caption-verified'), 'solar caption verified against sentence d via answer letter');
});

test('A2 (Godlike-1): adjudication context carries the parent shared sentences for token-stem children', async () => {
  const images = acceptanceFieldImages();
  // Two "mother" captions: the first picture (dealt to parent-as-item 15/dictionary) contradicts
  // its resolved sentence, but no closed caption permutation exists → ONE adjudication call.
  for (const id of ['img_dict', 'img_mother']) {
    const image = images.find(item => item.id === id)!;
    image.label = { role: 'stem', kind: 'photo', caption: 'Mother hugging child' };
  }
  let seenCases: any[] = [];
  const result = await assignImagesExact({
    questions: acceptanceFieldQuestions(),
    images,
    sourceLines: acceptanceFieldLines,
    adjudicate: (cases: any[]) => { seenCases = cases; return { img_dict: 'q16' }; },
  });
  assert.equal(seenCases.length, 1, 'one bundled adjudication case');
  const adjudicationCase = seenCases[0];
  assert.equal(adjudicationCase.imageId, 'img_dict');
  assert.match(adjudicationCase.sharedContext || '', /mother is hugging her little child/i,
    'shared context includes sentence a (the children matching targets)');
  assert.match(adjudicationCase.sharedContext || '', /sits in the balcony/i, 'shared context includes sentence b');
  const tokenCandidate = adjudicationCase.candidates.find((candidate: any) => candidate.ref === 'q16');
  assert.match(tokenCandidate.stem, /mother is hugging/i, 'token candidate "(16)" carries its target sentence');
  assert.deepEqual(adjudicationCase.candidates.map((candidate: any) => candidate.ref), ['q15', 'q16', 'q17', 'q18'],
    'candidates are the full item set incl. parent-as-item, constrained to the group');
  // Vision refereed; order dealt: the choice stands only because affinity is restored.
  assert.equal(result.adjudicated, 1);
  assert.equal(ownerByImage(result.questions).img_dict, 16);
});
