/**
 * Follow-up #36 Part C — "needs attention" means exactly one thing.
 *
 * `computeAttention(doc)` is the SINGLE source of truth for the attention count on every
 * surface (Step 4 header sentence, attention panel header, collapsed chip, Library health chip,
 * getExamHealth/Dossier/Assistant). It returns only things a HUMAN must finish; app-internal
 * events (repair rejections/applications, critic/consensus opinions, detachments, absorptions,
 * retries) are never attention items — they live in "What the app already fixed"/technical log.
 */
import type { ExamDoc, Flag, ImageAsset, Question } from '../types';

export type AttentionKind = 'answer-missing' | 'answer-conflict' | 'stem-hollow' | 'options-missing' | 'image-unplaced' | 'image-suspect' | 'points-unresolved' | 'metadata-missing' | 'read-failed' | 'audit-catch';

export interface AttentionAction {
  /** 'question' scrolls to + expands that card; 'image-tray' opens the tray; 'page-retry' re-reads one failed page; 'source-page' opens that page in Source. */
  target: 'question' | 'image-tray' | 'page-retry' | 'source-page';
  questionId?: string;
  imageIds?: string[];
  page?: number;
  lineNo?: number;
  /** Button label, e.g. "Go" / "Open" / "Retry page" / "Open page". */
  label: string;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  rootCauseId: string;
  /** One plain sentence that always ENDS with the action(s) the user can take. */
  plainSentence: string;
  action: AttentionAction;
  secondaryAction?: AttentionAction;
  questionIds: string[];
  imageIds: string[];
  /** Number of underlying rows folded into this item (1 for a single row). */
  count: number;
  severity: 'warn' | 'error';
}

const hasChildren = (doc: Pick<ExamDoc, 'questions'>, question: Question): boolean =>
  (doc.questions || []).some(item => item.parentId === question.id);

const questionById = (doc: Pick<ExamDoc, 'questions'>, id: string | undefined): Question | undefined =>
  id ? (doc.questions || []).find(question => question.id === id) : undefined;

const labelOf = (question: Question | undefined, fallback = 'This question'): string =>
  question ? `Q${question.no}` : fallback;

function questionItem(params: {
  kind: AttentionKind;
  rootCauseId: string;
  question: Question;
  sentence: string;
  actionLabel?: string;
  severity?: 'warn' | 'error';
  count?: number;
}): AttentionItem {
  const { question } = params;
  return {
    id: `${params.kind}_${question.id}`,
    kind: params.kind,
    rootCauseId: params.rootCauseId,
    plainSentence: `${params.sentence} [${params.actionLabel || 'Go'}]`,
    action: { target: 'question', questionId: question.id, label: params.actionLabel || 'Go' },
    questionIds: [question.id],
    imageIds: [],
    count: params.count ?? 1,
    severity: params.severity || 'warn',
  };
}

/** Images that no question owns (and that are not decoration / not duplicates). */
export function unplacedImages(doc: ExamDoc): ImageAsset[] {
  const owned = new Set<string>();
  for (const question of doc.questions || []) for (const ref of question.images || []) owned.add(ref.imageId);
  return (doc.images || []).filter(image =>
    !image.duplicateOf
    && !owned.has(image.id)
    && image.label?.role !== 'decoration'
    && image.label?.kind !== 'decoration',
  );
}

/** Images a human may still need to check (order-suspect pairings, suspect strips, missing blobs). */
function suspectImages(doc: ExamDoc): ImageAsset[] {
  const flagged = new Set(
    (doc.flags || [])
      .filter(flag => flag.code === 'IMAGE_ORDER_SUSPECT' || flag.code === 'IMAGE_ASSET_ABSENT')
      .map(flag => flag.imageId)
      .filter((id): id is string => Boolean(id)),
  );
  return (doc.images || []).filter(image =>
    !image.duplicateOf
    && (flagged.has(image.id) || Boolean(image.storageMissing)),
  );
}

function failedReadPages(doc: ExamDoc): Set<number> {
  const pages = new Set<number>();
  for (const flag of doc.flags || []) {
    if (flag.code !== 'PAGE_READ_FAILED') continue;
    const m = flag.id.match(/(\d+)$/) || flag.message.match(/Page\s+(\d+)/i);
    if (m) pages.add(Number(m[1]));
  }
  if ((doc.questions || []).length > 0 && !(doc.flags || []).some(f => f.code === 'GLOBAL_READ_FAILED')) {
    for (const p of doc.spine?.classify?.pages || []) {
      if (p.status === 'failed') pages.add(p.page);
    }
  }
  return pages;
}

/** #41: pages the read gave up on only because the read call allowance ran out (never a bare "couldn't be read"). */
function budgetExhaustedReadPages(doc: ExamDoc): Set<number> {
  const pages = new Set<number>();
  for (const p of doc.spine?.classify?.pages || []) {
    if (p.status === 'failed' && p.reason?.includes('read allowance exhausted')) pages.add(p.page);
  }
  return pages;
}

export function computeAttention(doc: ExamDoc): AttentionItem[] {
  const items: AttentionItem[] = [];
  const questions = doc.questions || [];
  const flags: Flag[] = doc.flags || [];
  const readFailure = flags.find(flag => flag.code === 'GLOBAL_READ_FAILED');

  // #40 Part B3: if ALL pages failed (0 questions + GLOBAL_READ_FAILED), ship the empty document
  // with the read-failure attention item as today (never pad with secondary tray/meta noise).
  if (readFailure && questions.length === 0) {
    const exhaustedAll = budgetExhaustedReadPages(doc);
    return [{
      id: 'read-failed',
      kind: 'read-failed',
      rootCauseId: readFailure.id,
      plainSentence: exhaustedAll.size
        ? 'The exam was only partially read because of the read call budget — retry the pages or set up the paper manually. [Review]'
        : 'The whole-paper read failed and no fallback parser was used — retry or set up the paper manually. [Review]',
      action: { target: 'question', label: 'Review' },
      questionIds: [],
      imageIds: [],
      count: 1,
      severity: 'error',
    }];
  }

  const failedPages = failedReadPages(doc);

  // 1. Answer missing — only a human can finish an answer (AI Solve is the offered action).
  // Gated on the document actually carrying answers: a paper-only import (no key, 0 answers) is not
  // nagged with one row per question.
  const answeredCount = questions.filter(question => Boolean(question.answer?.text?.trim())).length;
  const answersExpected = answeredCount > 0;
  for (const question of questions) {
    if (!answersExpected) break;
    if (hasChildren(doc, question)) continue; // the children own the answerable items
    if (question.answer?.text?.trim()) continue;
    if (question.type === 'matching' && !question.options?.length) continue; // pool items are shared with the parent

    if ((question.flags || []).includes('ANSWER_MISSING_ACCEPTED')) continue;
    if (question.type === 'essay' || question.type === 'long') {
      items.push(questionItem({
        kind: 'answer-missing', rootCauseId: `question_${question.id}`, question,
        sentence: `${labelOf(question)} has no model answer yet — solve it with AI or add it manually.`,
        actionLabel: 'Solve', severity: 'warn',
      }));
      continue;
    }
    items.push(questionItem({
      kind: 'answer-missing', rootCauseId: `question_${question.id}`, question,
      sentence: `${labelOf(question)} has no answer yet — solve it with AI or add it manually.`,
      actionLabel: 'Solve',
    }));
  }

  // 1b. Answer correctness conflicts (Part C): the printed key itself is ambiguous, or a
  // spot-check says the attached text answer may not match the key (both texts ride the flag
  // message). Only a human can pick — the pipeline never auto-rewrites these answers.
  const correctnessByQuestion = new Map<string, Flag>();
  for (const flag of flags) {
    if (!flag.questionId) continue;
    if (flag.code !== 'ANSWER_CONFLICT' && flag.code !== 'ANSWER_TEXT_MISMATCH') continue;
    if (!correctnessByQuestion.has(flag.questionId)) correctnessByQuestion.set(flag.questionId, flag);
  }
  for (const [questionId, flag] of correctnessByQuestion) {
    const question = questionById(doc, questionId);
    if (!question) continue;
    const detail = flag.message.replace(/^Q\d+:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 240);
    items.push(questionItem({
      kind: 'answer-conflict', rootCauseId: `question_${question.id}`, question,
      sentence: `${labelOf(question)}'s answer needs a human check — ${detail} Check the answer.`,
      actionLabel: 'Go',
    }));
  }

  // 2. Hollow stem / missing options — the printed content itself needs a human decision.
  const docCodes = new Map<string, Set<string>>();
  for (const flag of flags) {
    if (!flag.questionId) continue;
    if (flag.code !== 'STEM_HOLLOW' && flag.code !== 'OPTIONS_MISSING') continue;
    docCodes.set(flag.questionId, new Set([...(docCodes.get(flag.questionId) || []), flag.code]));
  }
  for (const question of questions) {
    const codes = new Set([...(question.flags || []), ...(docCodes.get(question.id) || [])]);
    if (codes.has('STEM_HOLLOW') || (!question.stem?.trim() && question.type !== 'matching' && !hasChildren(doc, question))) {
      items.push(questionItem({
        kind: 'stem-hollow', rootCauseId: `question_${question.id}`, question,
        sentence: `${labelOf(question)}'s question text is empty — type or re-split the stem.`,
        actionLabel: 'Fix', severity: 'error',
      }));
    }
    if (codes.has('OPTIONS_MISSING') && question.type !== 'fillblank' && question.type !== 'short') {
      items.push(questionItem({
        kind: 'options-missing', rootCauseId: `question_${question.id}`, question,
        sentence: `${labelOf(question)} has no answer choices — add the printed options.`,
        actionLabel: 'Fix', severity: 'error',
      }));
    }
  }

  // 3. Images: unplaced tray (or #40 C2 explanatory failed-page notice) + order-suspect pairings.
  const tray = unplacedImages(doc);
  if (tray.length) {
    const failedTray = questions.length > 0 ? tray.filter(img => failedPages.has(img.page)) : [];
    const regularTray = questions.length > 0 ? tray.filter(img => !failedPages.has(img.page)) : tray;

    if (failedTray.length) {
      const trayPages = [...new Set(failedTray.map(img => img.page))].sort((a, b) => a - b);
      const n = failedTray.length;
      const pronoun = n === 1 ? 'it' : 'them';
      const noun = n === 1 ? '1 picture' : `${n} pictures`;
      const sentence = trayPages.length === 1
        ? `${noun} couldn't be placed because page ${trayPages[0]} couldn't be read — retry the page to place ${pronoun}`
        : `${noun} couldn't be placed because pages ${trayPages.join(', ')} couldn't be read — retry the pages to place ${pronoun}`;
      items.push({
        id: `image-unplaced_failed_page_${trayPages.join('_')}`,
        kind: 'image-unplaced',
        rootCauseId: `page_read_failed_${trayPages[0]}`,
        plainSentence: `${sentence} [Retry page]`,
        action: { target: 'page-retry', page: trayPages[0], imageIds: failedTray.map(image => image.id), label: 'Retry page' },
        questionIds: [],
        imageIds: failedTray.map(image => image.id),
        count: failedTray.length,
        severity: 'warn',
      });
    }

    if (regularTray.length) {
      const sentence = regularTray.length === 1
        ? `1 picture isn't placed — place it from the tray.`
        : `${regularTray.length} pictures aren't placed — place them from the tray.`;
      items.push({
        id: 'image-unplaced',
        kind: 'image-unplaced',
        rootCauseId: 'image_tray',
        plainSentence: `${sentence} [Open]`,
        action: { target: 'image-tray', imageIds: regularTray.map(image => image.id), label: 'Open' },
        questionIds: [],
        imageIds: regularTray.map(image => image.id),
        count: regularTray.length,
        severity: 'warn',
      });
    }
  }
  const suspects = suspectImages(doc);
  if (suspects.length) {
    items.push({
      id: 'image-suspect',
      kind: 'image-suspect',
      rootCauseId: 'image_tray',
      plainSentence: suspects.length === 1
        ? `1 picture's question is unconfirmed — confirm its pairing in the tray.`
        : `${suspects.length} pictures' questions are unconfirmed — confirm their pairings in the tray.`,
      action: { target: 'image-tray', imageIds: suspects.map(image => image.id), label: 'Confirm' },
      questionIds: [],
      imageIds: suspects.map(image => image.id),
      count: suspects.length,
      severity: 'warn',
    });
  }

  // 4. Points that no local rule could resolve (grouped by root cause: group/section/document).
  const pointsFlags = flags.filter(flag =>
    flag.code === 'POINTS_UNPRICED' || flag.code === 'POINTS_MISMATCH' || flag.code === 'POINTS_OVERFLOW' || flag.code === 'POINTS_TOTAL_ASSERTION_FAILED');
  const buckets = new Map<string, Flag[]>();
  for (const flag of pointsFlags) {
    const question = questionById(doc, flag.questionId);
    const parent = question?.parentId ? questionById(doc, question.parentId) : undefined;
    const key = flag.rootCauseId
      || (question?.parentId ? `parent_${question.parentId}` : undefined)
      || (question?.sectionId ? `section_${question.sectionId}` : undefined)
      || (flag.questionId ? `question_${flag.questionId}` : 'document_points');
    void parent;
    buckets.set(key, [...(buckets.get(key) || []), flag]);
  }
  for (const [rootCauseId, bucket] of buckets) {
    const affected = [...new Set(bucket.map(flag => flag.questionId).filter((id): id is string => Boolean(id)))];
    const nos = affected.map(id => questionById(doc, id)?.no).filter((no): no is number => typeof no === 'number').sort((a, b) => a - b);
    const questionList = nos.length
      ? (nos.length <= 4 ? nos.map(no => `Q${no}`).join(', ') : `Q${nos[0]}–Q${nos[nos.length - 1]}`)
      : 'This exam';
    const single = bucket[0];
    const code = single.code;
    const sentence = nos.length
      ? `${questionList} ${nos.length === 1 ? 'has' : 'have'} no usable mark${nos.length === 1 ? '' : 's'} — set the points.`
      : 'The exam total does not add up — set the marks.';
    const actionTarget: AttentionAction = affected.length
      ? { target: 'question', questionId: affected[0], label: 'Go' }
      : { target: 'question', questionId: undefined, label: 'Go' };
    void code;
    items.push({
      id: `points-unresolved_${rootCauseId}`,
      kind: 'points-unresolved',
      rootCauseId,
      plainSentence: `${sentence} [${actionTarget.label}]`,
      action: actionTarget,
      questionIds: affected,
      imageIds: [],
      count: bucket.length,
      severity: 'warn',
    });
  }

  // #43: decision-audit catches that survived their scoped re-ask go to the teacher.
  for (const flag of flags.filter(flag => flag.code === 'AUDIT_CATCH')) {
    const question = questionById(doc, flag.questionId);
    if (!question) continue;
    items.push(questionItem({
      kind: 'audit-catch', rootCauseId: flag.rootCauseId || flag.id, question,
      sentence: `${labelOf(question)} failed the decision audit — ${flag.message}`,
      actionLabel: 'Go', severity: 'warn',
    }));
  }

  // 5. Metadata and failed Global Read (per-page or whole-paper) are explicit teacher work, never silent parse state.
  for (const flag of flags.filter(flag => flag.code === 'META_MISSING')) {
    items.push({ id: `metadata-missing_${flag.rootCauseId || flag.id}`, kind: 'metadata-missing', rootCauseId: flag.rootCauseId || flag.id, plainSentence: `${flag.message} [Set]`, action: { target: 'question', label: 'Set' }, questionIds: [], imageIds: [], count: 1, severity: 'warn' });
  }
  if (readFailure) {
    const exhaustedAll = budgetExhaustedReadPages(doc);
    items.push({ id: 'read-failed', kind: 'read-failed', rootCauseId: readFailure.id, plainSentence: exhaustedAll.size ? 'The exam was only partially read because of the read call budget — retry the pages or set up the paper manually. [Review]' : 'The whole-paper read failed and no fallback parser was used — retry or set up the paper manually. [Review]', action: { target: 'question', label: 'Review' }, questionIds: [], imageIds: [], count: 1, severity: 'error' });
  } else {
    const lines = doc.source?.lines || [];
    const exhaustedPages = budgetExhaustedReadPages(doc);
    for (const p of [...failedPages].sort((a, b) => a - b)) {
      const firstLine = lines
        .filter(l => l.page === p)
        .map(l => Number(String(l.id).replace(/\D/g, '')))
        .filter(n => n > 0)
        .sort((a, b) => a - b)[0] || 1;
      items.push({
        id: `read-failed_page_${p}`,
        kind: 'read-failed',
        rootCauseId: `page_read_failed_${p}`,
        plainSentence: exhaustedPages.has(p)
          ? `Page ${p} couldn't be read — the exam was only partially read because of the call budget; its questions are missing [Retry page] [Open page]`
          : `Page ${p} couldn't be read — its questions are missing [Retry page] [Open page]`,
        action: { target: 'page-retry', page: p, lineNo: firstLine, label: 'Retry page' },
        secondaryAction: { target: 'source-page', page: p, lineNo: firstLine, label: 'Open page' },
        questionIds: [],
        imageIds: [],
        count: 1,
        severity: 'error',
      });
    }
  }

  return items;
}

/** The ONE number every surface prints. */
export function attentionCount(doc: ExamDoc): number {
  return computeAttention(doc).length;
}

/** The question ids that own an attention item (used to auto-expand exactly those cards). */
export function attentionQuestionIds(doc: ExamDoc): string[] {
  return [...new Set(computeAttention(doc).flatMap(item => item.questionIds))];
}

/** The image ids that own an attention item (used to filter the tray). */
export function attentionImageIds(doc: ExamDoc): string[] {
  return [...new Set(computeAttention(doc).flatMap(item => item.imageIds))];
}
