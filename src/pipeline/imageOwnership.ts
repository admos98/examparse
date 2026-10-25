/**
 * Follow-up #36 Part B — image assignment, exact.
 *
 * Ownership is decided by PRINTED GEOMETRY + COUNTS, never by a model vote:
 *  - B2 order-preserving bijection for a group whose candidate-image count equals its child count;
 *  - B3 caption affinity verifies each pair (deterministic, no model);
 *  - a contradiction may be resolved by ONE bundled constrained adjudication call (caller-injected);
 *  - B5 determinism lock: same doc + same vision captions ⇒ identical assignment.
 * Single ownership (I13) is enforced here and again at the save boundary.
 */
import type { ExamDoc, Flag, ImageAsset, Question, SourceLine } from '../types';
import { spanEndLine, spanStartLine } from './spans';

export type ImageRule = 'order-bijection' | 'caption-verified' | 'vision-adjudicated' | 'geometry' | 'tray' | 'parent-level';

export interface ImageAssignmentReceipt {
  imageId: string;
  questionId?: string;
  questionLabel?: string;
  groupId?: string;
  /** 1-based reading position of the image inside its group. */
  order?: number;
  caption?: string;
  ruleChain: ImageRule[];
  note?: string;
}

export interface AdjudicationCase {
  groupId: string;
  imageId: string;
  caption?: string;
  candidates: Array<{ ref: string; label: string; stem: string }>;
}

/** One bundled call for every suspect pair in the document (caller-injected; optional). */
export type ImageAdjudicator = (cases: AdjudicationCase[]) => Promise<Record<string, string>> | Record<string, string>;

export interface ExactAssignmentResult {
  images: ImageAsset[];
  questions: Question[];
  flags: Flag[];
  receipts: ImageAssignmentReceipt[];
  /** Images that ended in the human tray (no owning question). */
  tray: string[];
  byRule: Record<string, number>;
  /** Suspect pairs that stayed on printed order (human one-click). */
  suspects: number;
  adjudicated: number;
  corrected: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'by',
  'this', 'that', 'these', 'those', 'its', 'it', 'as', 'at', 'from', 'has', 'have', 'had', 'one', 'two', 'three',
  'picture', 'pictures', 'image', 'images', 'photo', 'photos', 'photo)', 'please', 'below', 'above', 'your',
]);

/** Very small, deterministic English/Persian-tolerant stemmer (never used for text output). */
function stemToken(token: string): string {
  if (token.length > 4 && /(?:ies)$/.test(token)) return token.slice(0, -3) + 'y';
  if (token.length > 4 && /(?:ing)$/.test(token)) return token.slice(0, -3);
  if (token.length > 4 && /(?:ed)$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && /s$/.test(token) && !/ss$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Normalized, order-free caption/child-text keywords. */
export function captionKeywords(text: string | undefined): string[] {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u064B-\u0652\u200c\u200f\u200e]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !STOPWORDS.has(token))
    .map(stemToken);
}

/** Number of shared keywords between an image caption and a child's printed text. */
export function captionAffinity(caption: string | undefined, childText: string | undefined): number {
  const captionTokens = new Set(captionKeywords(caption));
  if (!captionTokens.size) return 0;
  let score = 0;
  for (const token of new Set(captionKeywords(childText))) {
    if (captionTokens.has(token)) score++;
  }
  return score;
}

const lineNumber = (id: string | undefined): number | undefined => {
  if (!id) return undefined;
  const digits = String(id).replace(/\D/g, '');
  return digits ? Number(digits) : undefined;
};

function readingOrder(a: ImageAsset, b: ImageAsset): number {
  return (a.page || 0) - (b.page || 0)
    || (a.bbox?.y ?? 0) - (b.bbox?.y ?? 0)
    || (a.bbox?.x ?? 0) - (b.bbox?.x ?? 0)
    || String(a.id).localeCompare(String(b.id));
}

function questionText(question: Question | undefined): string {
  if (!question) return '';
  return [
    question.stem || '',
    ...(question.options || []).map(option => option.text || ''),
    question.answer?.text || '',
  ].join(' ').slice(0, 600);
}

function questionLines(question: Question): number[] {
  const lines: number[] = [];
  const visit = (spans: Question['spans'] | undefined) => {
    for (const span of spans || []) {
      const start = spanStartLine(span);
      const end = spanEndLine(span);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      for (let line = start; line <= end; line++) lines.push(line);
    }
  };
  visit(question.spans);
  for (const option of question.options || []) visit(option.spans);
  for (const table of question.tables || []) visit(table.spans);
  return lines;
}

function startLineOf(question: Question): number {
  const lines = questionLines(question);
  return lines.length ? Math.min(...lines) : Number.MAX_SAFE_INTEGER;
}

function endLineOf(question: Question): number {
  const lines = questionLines(question);
  return lines.length ? Math.max(...lines) : -1;
}

interface GroupUnit {
  id: string;
  parent: Question;
  children: Question[];
  startLine: number;
  endLine: number;
  zoneEnd: number;
  pages: Set<number>;
  dialogue: boolean;
}

export interface AssignImagesExactParams {
  questions: Question[];
  images: ImageAsset[];
  sourceLines: SourceLine[];
  /** Optional single bundled constrained adjudication call for suspect pairs only. */
  adjudicate?: ImageAdjudicator;
  /** Test/diagnostic hook: never used for behaviour. */
  onDiagnostic?: (message: string) => void;
}

/**
 * Assign every image to at most one question using geometry + count arithmetic.
 * Never deletes an image; anything unresolved lands in the human tray.
 */
export async function assignImagesExact(params: AssignImagesExactParams): Promise<ExactAssignmentResult> {
  const sourceLines = params.sourceLines || [];
  const pageByLine = new Map<number, number>();
  for (const line of sourceLines) {
    const n = lineNumber(line.id);
    if (n !== undefined) pageByLine.set(n, line.page);
  }
  const questions: Question[] = params.questions.map(question => ({
    ...question,
    images: [...(question.images || [])].map(ref => ({ ...ref })),
  }));
  const byId = new Map(questions.map(question => [question.id, question]));
  const images: ImageAsset[] = params.images.map(image => ({ ...image, label: image.label ? { ...image.label } : undefined }));
  const imageById = new Map(images.map(image => [image.id, image]));
  const flags: Flag[] = [];
  const receipts: ImageAssignmentReceipt[] = [];
  // Legacy extraction collisions (two assets sharing one id) cannot be keyed safely here; the
  // dedicated page-aware id repair runs later and rewrites them, so those refs are left untouched.
  const idCounts = new Map<string, number>();
  for (const image of images) idCounts.set(image.id, (idCounts.get(image.id) || 0) + 1);
  const ambiguousIds = new Set([...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
  const assignableImages = images.filter(image => !ambiguousIds.has(image.id));
  const byRule: Record<string, number> = {};
  const owner = new Map<string, string>(); // imageId -> questionId (I13 authority)
  const groupOfImage = new Map<string, string>();

  const bump = (_rule: ImageRule) => { /* counts are derived from receipts at the end */ };
  const note = (message: string) => { try { params.onDiagnostic?.(message); } catch { /* diagnostics never change the parse */ } };

  // --- group discovery (parents with children) ------------------------------------------------
  const childrenByParent = new Map<string, Question[]>();
  for (const question of questions) {
    if (!question.parentId) continue;
    childrenByParent.set(question.parentId, [...(childrenByParent.get(question.parentId) || []), question]);
  }
  const groups: GroupUnit[] = [];
  for (const [parentId, children] of childrenByParent) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    const members = [...children, parent];
    const starts = members.map(startLineOf).filter(line => line !== Number.MAX_SAFE_INTEGER);
    if (!starts.length) continue;
    const startLine = Math.min(...starts);
    const endLine = Math.max(...members.map(endLineOf).filter(line => line >= 0), startLine);
    const pages = new Set<number>();
    for (const member of members) {
      for (const line of questionLines(member)) {
        const page = pageByLine.get(line);
        if (page !== undefined) pages.add(page);
      }
    }
    // Zone extends to the line before the next root question on the same page: printed exams put the
    // item pictures inside their group's vertical band, never inside the next question's band.
    const nextRootStarts = questions
      .filter(question => !question.parentId && question.id !== parent.id)
      .map(startLineOf)
      .filter(line => line > startLine && line !== Number.MAX_SAFE_INTEGER);
    const nextRoot = nextRootStarts.length ? Math.min(...nextRootStarts) : Number.MAX_SAFE_INTEGER;
    const zoneEnd = Math.max(endLine, Math.min(nextRoot - 1, endLine + 40));
    groups.push({
      id: parent.id,
      parent,
      children: [...children].sort((a, b) => a.no - b.no || startLineOf(a) - startLineOf(b) || a.id.localeCompare(b.id)),
      startLine,
      endLine,
      zoneEnd,
      pages,
      dialogue: Boolean(parent.receipt?.ruleChain?.some(rule => rule === 'dialogue-group')),
    });
  }
  groups.sort((a, b) => a.startLine - b.startLine || a.id.localeCompare(b.id));

  const imageInGroupZone = (image: ImageAsset, group: GroupUnit): boolean => {
    if (!group.pages.has(image.page)) return false;
    if (image.anchorLine === undefined) return group.pages.size > 1;
    return image.anchorLine >= group.startLine && image.anchorLine <= group.zoneEnd;
  };

  // --- B2 order-preserving bijection ---------------------------------------------------------
  interface Pair {
    image: ImageAsset;
    target: Question;
    group: GroupUnit;
    order: number;
    ownScore: number;
    strong: boolean; // caption identifies this child (score > 0 and highest for this image)
  }
  const pairs: Pair[] = [];
  const claimed = new Set<string>();
  const pairQuestions = new Map<string, string>(); // imageId -> questionId (before adjudication)
  const uncertain: Pair[] = [];

  for (const group of groups) {
    // Dialogue groups genuinely share one context image (I9) — never spread it across blanks.
    if (group.dialogue) {
      const shared = assignableImages.filter(image => !claimed.has(image.id) && imageInGroupZone(image, group));
      for (const image of shared) {
        claimed.add(image.id);
        pairQuestions.set(image.id, group.parent.id);
        groupOfImage.set(image.id, group.id);
        bump('parent-level');
        receipts.push({ imageId: image.id, questionId: group.parent.id, questionLabel: group.parent.label, groupId: group.id, caption: image.label?.caption, ruleChain: ['parent-level'], note: 'dialogue shared context' });
      }
      continue;
    }
    const pool = assignableImages
      .filter(image => !claimed.has(image.id) && imageInGroupZone(image, group))
      .sort(readingOrder);
    if (!pool.length) continue;
    const members = group.children;
    if (!members.length) continue;

    const pairedCount = Math.min(pool.length, members.length);
    for (let index = 0; index < pairedCount; index++) {
      const image = pool[index];
      const target = members[index];
      claimed.add(image.id);
      const caption = image.label?.caption;
      const ownScore = captionAffinity(caption, questionText(target));
      const scores = members.map(member => captionAffinity(caption, questionText(member)));
      const best = Math.max(...scores);
      const bestIndex = scores.indexOf(best);
      const strong = ownScore > 0 && ownScore >= best;
      const pair: Pair = { image, target, group, order: index + 1, ownScore, strong };
      pairs.push(pair);
      pairQuestions.set(image.id, target.id);
      groupOfImage.set(image.id, group.id);
      if (!strong && best > ownScore && bestIndex >= 0) uncertain.push(pair);
      else if (ownScore === 0 && best === 0 && members.length > 0) note(`no caption evidence for ${image.id}`);
    }
    const extras = pool.slice(members.length);
    for (const image of extras) {
      claimed.add(image.id); // consumed from the pool, lands in the tray below
      groupOfImage.set(image.id, group.id);
      flags.push({
        id: `flag_IMAGE_EXTRA_${group.id}_${image.id}`,
        severity: 'warn',
        code: 'IMAGE_UNPLACED',
        questionId: group.parent.id,
        imageId: image.id,
        rootCauseId: `group_${group.id}`,
        message: `${image.id} belongs to the picture set of Q${group.parent.no} but the group has ${members.length} item(s); it stays unplaced for one-click placement.`,
      });
    }
    if (pool.length < members.length) {
      const starved = members.slice(pool.length);
      flags.push({
        id: `flag_IMAGE_MISSING_FOR_CHILD_${group.id}`,
        severity: 'warn',
        code: 'IMAGE_MISSING_FOR_CHILD',
        questionId: group.parent.id,
        rootCauseId: `group_${group.id}`,
        message: `Q${starved.map(child => child.no).join(', Q')} have no picture in their own group (${pool.length} picture(s) for ${members.length} item(s)); check the source.`,
      });
    }
  }

  // --- B3 verification + deterministic caption permutation ----------------------------------
  let corrected = 0;
  let suspects = 0;
  const applyTarget = (pair: Pair, target: Question, rule: ImageRule[], noteText?: string, score?: number) => {
    pair.target = target;
    pairQuestions.set(pair.image.id, target.id);
    bump(rule[rule.length - 1]);
    receipts.push({
      imageId: pair.image.id,
      questionId: target.id,
      questionLabel: target.label,
      groupId: pair.group.id,
      order: pair.order,
      caption: pair.image.label?.caption,
      ruleChain: rule,
      note: noteText,
    });
    if (score !== undefined) pair.ownScore = score;
  };

  for (const pair of pairs) {
    if (!uncertain.includes(pair)) {
      applyTarget(pair, pair.target, pair.strong ? ['order-bijection', 'caption-verified'] : ['order-bijection'],
        pair.strong ? undefined : 'printed order (no contradicting caption)');
    }
  }

  // A caption that unambiguously identifies a different child is a deterministic correction when every
  // suspect in the group has a unique best child (no model required).
  const correctedPairs = new Set<Pair>();
  const groupIds = [...new Set(uncertain.map(pair => pair.group.id))];
  for (const groupId of groupIds) {
    const groupPairs = uncertain.filter(pair => pair.group.id === groupId);
    const group = groupPairs[0].group;
    // A permutation is provable only when every suspect has a strictly better child, those children are
    // unique, and they are exactly the children the suspects currently hold (a closed cycle/swap).
    const desired = new Map<Pair, { child: Question; score: number }>();
    for (const pair of groupPairs) {
      const scored = group.children
        .map(child => ({ child, score: captionAffinity(pair.image.label?.caption, questionText(child)) }))
        .sort((a, b) => b.score - a.score || a.child.no - b.child.no);
      if (!scored.length || scored[0].score <= pair.ownScore) continue;
      desired.set(pair, scored[0]);
    }
    if (desired.size !== groupPairs.length) continue;
    const targets = [...desired.values()].map(target => target.child.id);
    const uniqueTargets = new Set(targets).size === targets.length;
    const ownedBySuspects = new Set(groupPairs.map(pair => pair.target.id));
    const closedCycle = targets.every(childId => ownedBySuspects.has(childId));
    if (!uniqueTargets || !closedCycle) continue;
    for (const [pair, target] of desired) {
      applyTarget(pair, target.child, ['order-bijection', 'caption-verified'], 'caption permutation overrides printed order', target.score);
      correctedPairs.add(pair);
      corrected += 1;
    }
  }

  // Remaining suspects: ONE bundled constrained adjudication call across the whole document.
  const remaining = uncertain.filter(pair => !correctedPairs.has(pair));
  let adjudicated = 0;
  const adjudicationCases: AdjudicationCase[] = remaining.map(pair => ({
    groupId: pair.group.id,
    imageId: pair.image.id,
    caption: pair.image.label?.caption,
    candidates: pair.group.children.map(child => ({ ref: child.id, label: child.label, stem: questionText(child).slice(0, 200) })),
  }));
  let adjudication: Record<string, string> = {};
  if (adjudicationCases.length && params.adjudicate) {
    try {
      adjudication = (await params.adjudicate(adjudicationCases)) || {};
    } catch {
      adjudication = {}; // a failed advisory call never changes the deterministic outcome
    }
  }
  for (const pair of remaining) {
    const choice = adjudication[pair.image.id];
    const chosen = choice ? pair.group.children.find(child => child.id === choice || child.label === choice || String(child.no) === choice) : undefined;
    const originalScore = captionAffinity(pair.image.label?.caption, questionText(pair.target));
    if (chosen && chosen.id !== pair.target.id && captionAffinity(pair.image.label?.caption, questionText(chosen)) > originalScore) {
      applyTarget(pair, chosen, ['order-bijection', 'vision-adjudicated'], 'constrained adjudication restored caption affinity');
      adjudicated++;
      bump('vision-adjudicated');
      continue;
    }
    applyTarget(pair, pair.target, ['order-bijection'], 'printed order kept; caption affinity did not confirm the pair');
    suspects++;
    flags.push({
      id: `flag_IMAGE_ORDER_SUSPECT_${pair.image.id}`,
      severity: 'warn',
      code: 'IMAGE_ORDER_SUSPECT',
      questionId: pair.target.id,
      imageId: pair.image.id,
      rootCauseId: `group_${pair.group.id}`,
      message: `${pair.image.id} ("${pair.image.label?.caption || 'no caption'}") was paired with Q${pair.target.no} by printed order; the caption points elsewhere — confirm with one click.`,
    });
    if (adjudication[pair.image.id] && chosen && chosen.id === pair.target.id) note(`adjudication confirmed printed order for ${pair.image.id}`);
  }

  // --- loose images: geometry decides (B3 last paragraph) ------------------------------------
  const looseUnresolved: string[] = [];
  for (const image of assignableImages) {
    if (claimed.has(image.id)) continue;
    if (image.duplicateOf) continue;
    const anchor = image.anchorLine;
    const onPage = (question: Question) => questionLines(question).some(line => pageByLine.get(line) === image.page);
    const pageQuestions = questions.filter(onPage);
    if (!pageQuestions.length) {
      // No candidate question on this page at all: the decoration presumption stands.
      const label = image.label || { role: 'decoration' as const };
      image.label = { ...label, role: label.role || 'decoration', kind: label.kind || 'decoration' } as ImageAsset['label'];
      bump('tray');
      receipts.push({ imageId: image.id, caption: image.label?.caption, ruleChain: ['tray'], note: 'no question spans on this page; decoration presumption stands' });
      looseUnresolved.push(image.id);
      continue;
    }
    let region: Question | undefined;
    if (anchor !== undefined) {
      const containing = pageQuestions.filter(question => questionLines(question).includes(anchor));
      region = containing.sort((a, b) => (questionLines(a).length - questionLines(b).length) || a.no - b.no)[0];
      if (!region) {
        const preceding = pageQuestions
          .filter(question => startLineOf(question) <= anchor && !question.parentId)
          .sort((a, b) => startLineOf(b) - startLineOf(a) || b.no - a.no)[0];
        region = preceding || pageQuestions
          .filter(question => startLineOf(question) >= anchor && !question.parentId)
          .sort((a, b) => startLineOf(a) - startLineOf(b) || a.no - b.no)[0];
      }
    } else {
      region = pageQuestions.filter(question => !question.parentId).sort((a, b) => a.no - b.no)[0];
    }
    const parentOfGroup = region?.parentId ? byId.get(region.parentId) : undefined;
    const groupParent = region && (byId.get(region.id)?.parentId ? parentOfGroup : childrenByParent.has(region.id) ? region : undefined);
    if (groupParent && childrenByParent.has(groupParent.id)) {
      // An image anchored to a group after the bijection was already spent: geometric single owner only
      // when it sits inside one child's own spans, otherwise the human tray.
      const childOwner = anchor !== undefined
        ? groupParent && childrenByParent.get(groupParent.id)!.filter(child => questionLines(child).includes(anchor!)).sort((a, b) => questionLines(a).length - questionLines(b).length)[0]
        : undefined;
      if (!childOwner) {
        looseUnresolved.push(image.id);
        continue;
      }
      region = childOwner;
    }
    if (!region) {
      looseUnresolved.push(image.id);
      continue;
    }
    const score = captionAffinity(image.label?.caption, questionText(region));
    const rule: ImageRule[] = ['geometry'];
    if (score > 0) rule.push('caption-verified');
    owner.set(image.id, region.id);
    pairQuestions.set(image.id, region.id);
    const wasDecoration = image.label?.role === 'decoration' || image.label?.kind === 'decoration';
    image.label = {
      ...(image.label || { role: 'stem' }),
      role: wasDecoration || !image.label?.role ? 'stem' : image.label.role,
      kind: wasDecoration || !image.label?.kind ? 'photo' : image.label.kind,
      questionRef: region.id,
    } as ImageAsset['label'];
    if (wasDecoration) {
      flags.push({
        id: `flag_VISION_DECORATION_REBUTTED_${image.id}`,
        severity: 'warn',
        code: 'VISION_DECORATION_REBUTTED',
        questionId: region.id,
        imageId: image.id,
        message: `${image.id} was labelled decoration but is anchored inside Q${region.no}'s spans; it is item content by geometry.`,
      });
      bump('geometry');
    } else {
      bump('geometry');
    }
    receipts.push({
      imageId: image.id,
      questionId: region.id,
      questionLabel: region.label,
      caption: image.label?.caption,
      ruleChain: rule,
      note: wasDecoration ? 'decoration verdict rebutted by geometry' : 'loose question image placed by geometry',
    });
  }

  // --- apply ownership; decoration rebuttal for group members --------------------------------
  for (const receipt of receipts) {
    if (!receipt.questionId) continue;
    const image = imageById.get(receipt.imageId);
    const target = byId.get(receipt.questionId);
    if (!image || !target) continue;
    owner.set(image.id, target.id);
    const wasDecoration = image.label?.role === 'decoration' || image.label?.kind === 'decoration';
    if (wasDecoration) {
      flags.push({
        id: `flag_VISION_DECORATION_REBUTTED_${image.id}`,
        severity: 'warn',
        code: 'VISION_DECORATION_REBUTTED',
        questionId: target.id,
        imageId: image.id,
        message: `${image.id} was labelled decoration but participates in Q${target.no}'s equal-count picture set; it is item content by arithmetic.`,
      });
    }
    image.label = {
      ...(image.label || { role: 'stem' }),
      role: wasDecoration ? 'stem' : (image.label?.role || 'stem'),
      kind: image.label?.kind && image.label.kind !== 'decoration' ? image.label.kind : (wasDecoration ? 'photo' : image.label?.kind || 'photo'),
      questionRef: target.id,
      assignment: {
        questionId: target.id,
        questionLabel: target.label,
        groupId: receipt.groupId,
        order: receipt.order,
        ruleChain: receipt.ruleChain,
        caption: receipt.caption,
        note: receipt.note,
      },
    } as ImageAsset['label'];
    receipt.questionLabel = target.label;
  }

  // --- I13 single ownership: rebuild every images[] from the owner map --------------------------
  let deduped = 0;
  for (const question of questions) {
    const seen = new Set<string>();
    const kept: Question['images'] = [];
    for (const ref of question.images || []) {
      const imageId = String(ref?.imageId || '');
      if (!imageId) { deduped++; continue; }
      if (ambiguousIds.has(imageId)) { kept.push(ref); continue; } // resolved by the page-aware id repair
      if (seen.has(imageId)) { deduped++; continue; }
      const ownerId = owner.get(imageId);
      if (ownerId && ownerId !== question.id) { deduped++; continue; }
      if (!ownerId) { deduped++; continue; }
      seen.add(imageId);
      kept.push({ ...ref, role: ref.role || 'stem', anchorLine: ref.anchorLine ?? imageById.get(imageId)?.anchorLine });
    }
    question.images = kept;
  }
  for (const [imageId, questionId] of owner) {
    const target = byId.get(questionId);
    const image = imageById.get(imageId);
    if (!target || !image) continue;
    if (!target.images.some(ref => ref.imageId === imageId)) {
      target.images.push({
        imageId,
        role: (image.label?.role === 'decoration' ? 'stem' : image.label?.role) || 'stem',
        anchorLine: image.anchorLine,
      });
    }
  }
  if (deduped) {
    flags.push({
      id: 'flag_IMAGE_SINGLE_OWNERSHIP_DEDUPED',
      severity: 'info',
      code: 'IMAGE_OWNERSHIP_DEDUPED',
      message: `${deduped} duplicate/alien image reference(s) were removed so every image has at most one owning question (I13).`,
    });
  }

  // Tray items: owned by nobody, not decoration, on a page that has questions.
  const tray = assignableImages
    .filter(image => !image.duplicateOf && !owner.has(image.id) && Boolean(image.label?.role && image.label.role !== 'decoration') && Boolean(image.label?.kind && image.label.kind !== 'decoration'))
    .map(image => image.id);
  for (const imageId of new Set(tray)) {
    const image = imageById.get(imageId)!;
    if (flags.some(flag => flag.code === 'IMAGE_UNPLACED' && flag.message.startsWith(`${imageId} `))) continue;
    flags.push({
      id: `flag_IMAGE_UNPLACED_${imageId}`,
      severity: 'warn',
      code: 'IMAGE_UNPLACED',
      imageId,
      message: `${imageId} on page ${image.page} could not be anchored to a question; place it from the tray.`,
    });
  }

  // Rule tallies come from the receipts (a rule chain like order-bijection → caption-verified is one
  // image that satisfied both), so the summary can never disagree with what is shown per image.
  for (const receipt of receipts) {
    for (const rule of receipt.ruleChain) byRule[rule] = (byRule[rule] || 0) + 1;
  }

  return {
    images,
    questions,
    flags,
    receipts,
    tray: [...new Set(tray)],
    byRule,
    suspects,
    adjudicated,
    corrected,
  };
}

/** I13 at the save boundary: an image id appears in at most one question's images list. */
export function enforceSingleImageOwnership(doc: ExamDoc): { doc: ExamDoc; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const questions = (doc.questions || []).map(question => {
    const kept: Question['images'] = [];
    for (const ref of question.images || []) {
      const imageId = String(ref?.imageId || '');
      if (!imageId || seen.has(imageId)) { removed++; continue; }
      seen.add(imageId);
      kept.push(ref);
    }
    return kept.length === (question.images || []).length ? question : { ...question, images: kept };
  });
  if (!removed) return { doc, removed };
  return {
    doc: {
      ...doc,
      questions,
      flags: [
        ...(doc.flags || []),
        {
          id: 'flag_IMAGE_SINGLE_OWNERSHIP_FINAL',
          severity: 'info',
          code: 'IMAGE_OWNERSHIP_DEDUPED',
          message: `Single-ownership pass (I13) removed ${removed} duplicate image reference(s) at save time.`,
        },
      ],
    },
    removed,
  };
}
