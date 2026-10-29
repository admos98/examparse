/** Decision audit: quality verdicts plus advisory difficulty and curriculum proposals. */
import type { AppSettings, ImageAsset, ProviderConfig, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { getPipelineCache, setPipelineCache } from '../store';
import { sha256 } from '../utils/hash';
import { normalizeDigits } from './metaRead';
import { detectKeyTerritory } from './quality';
import { canonicalLetter, parseAnswerLetter } from './answerCorrectness';
import type { Question } from '../types';
import { estimateTokens } from './memory/tokens';
import { DECIDE_CATCH, DECIDE_PASS, DECIDE_TIMEOUT_MS } from './audit';
import { curriculumLessons, keywordCurriculumHint, hintsForLesson, emptyCurriculumHints } from './curriculumHints';
import { errorMessage, sourceText, sourceProvesTruncatedStem, flatAuthoredQuestions, questionSourcePages, sourcePagesText, type AuthoredDocument, type LoopDecisionKind, type LoopVerdict } from './localLoop';

export interface LoopDecisionItem {
  id: string; type: LoopDecisionKind; name: string; instructions: string;
  questionNumbers: number[]; input: Record<string, unknown>;
  choices?: string[]; choiceDescriptions?: Record<string, string>; imageId?: string;
  /** Code-only comparison target: NEVER serialized into the judge record. */
  expectedChoice?: string;
  comparisonId?: string;
  skippedNoEvidence?: string;
  authoredQuestion?: import('./localLoop').AuthoredQuestion;
  images?: Array<{ id: string; mime: string; data: string }>;
}
export type DecisionRequestBody = any;
export type LoopDecisionCaller = (body: DecisionRequestBody) => Promise<{ results: Array<{ name: string; probability: number; choice?: string; distribution?: Record<string, number> }> }>;
/** #50 Part D: ordinal difficulty levels sent as llama.cpp's native score criteria (array, index 0 = level 1). */
export const DIFFICULTY_LEVELS = ['1: trivial recall', '2: easy', '3: medium', '4: hard', '5: very hard multi-step'] as const;
export const DIFFICULTY_INSTRUCTIONS = 'Rate expected student difficulty from 1 (recall/trivial) to 5 (multi-step/very hard), considering the stem, options and section.';
/** A flat level distribution is an uncertain difficulty estimate. */
export const DIFFICULTY_UNCERTAIN_BELOW = 0.4;
/** THX (/v1/systemone) single-question body. Score items use the shape the llama.cpp implementation accepts:
 * { type: 'score', criteria: [level descriptions] } — the old { levels } shape is rejected with HTTP 400. */
export function buildThxDecisionBody(item: LoopDecisionItem, model: string, state: string): DecisionRequestBody {
  const question = item.type === 'difficulty'
    ? { type: 'score', instructions: item.instructions, criteria: [...DIFFICULTY_LEVELS] }
    : item.choices
      ? { type: 'choice', instructions: item.instructions, criteria: item.choiceDescriptions || Object.fromEntries(item.choices.map(c => [c, c])) }
      : { type: 'noul', instructions: item.instructions };
  // #51: llama.cpp systemone accepts top-level `images` (data URLs) on mmproj builds — pixels were silently dropped before.
  const images = (item.images || []).map(image => `data:${image.mime};base64,${image.data}`);
  return { model, state, questions: { [item.name]: question }, ...(images.length ? { images } : {}) };
}
export type LoopDecisionVote = { probability: number; choice?: string; distribution?: Record<string, number> };
export interface LoopAuditResult {
  verdicts: LoopVerdict[]; routed: LoopVerdict[]; calls: number; mode: 'shadow' | 'active' | 'skipped';
  notes: string[]; usage: { inputTokens: number; outputTokens: number }; catches: number; uncertain: number; endpointErrors: number; difficultyUncertain: number; skippedNoEvidence: number; dialect?: 'jev'|'thx'; endpointHost?: string;
  /** #51: every vote by item id (for the Present re-check), plus re-check economy counters. */
  votes: Map<string, LoopDecisionVote>; revoted: number; reused: number;
}
/** The decide endpoint takes pixels when the user marked the build multimodal (settings or provider flag). */
export function decideIsMultimodal(settings: AppSettings, provider?: ProviderConfig): boolean {
  return settings.decideMultimodal === true || provider?.multimodalDecisions === true;
}
export function resolveDecisionProvider(settings: AppSettings): (ProviderConfig & { model: string }) | undefined {
  const selection = settings.roleMapping.decide;
  if (!selection?.model) return undefined;
  // Optional means optional: never fall back to read, cloud, or the first (possibly remote) provider.
  const provider = settings.providers.find(p => p.id === selection.providerId);
  // Generative roles remain local-only; decide is an explicitly user-configured referee and may be hosted.
  if (!provider || provider.kind !== 'openai-compatible') return undefined;
  return { ...provider, model: selection.model };
}
export function buildLoopDecisionCatalogue(params: {
  document: AuthoredDocument; lines: SourceLine[]; images: ImageAsset[];
  mode?: 'shadow' | 'active'; multimodal?: boolean; imagePayloads?: Record<string, { id: string; mime: string; data: string }>;
}): LoopDecisionItem[] {
  const { document, lines, images, multimodal = false, imagePayloads = {} } = params;
  const items: LoopDecisionItem[] = [];
  const keyLines = detectKeyTerritory(lines).lineNos;
  const blindLines = lines.filter(line => line.tag !== 'key' && !keyLines.has(Number(line.id.replace(/\D/g, ''))) && !/\b(?:answer\s*key|correct\s*answer|answer)\s*[:：]|\[KEY\]/i.test(line.text));
  const sourceFor = (q: import('./localLoop').AuthoredQuestion, blind = false) => sourcePagesText(blind ? blindLines : lines, questionSourcePages(q, lines));
  const itemSource = (q: import('./localLoop').AuthoredQuestion, blind: boolean) => {
    const pages = questionSourcePages(q, lines);
    const candidates = (blind ? blindLines : lines).filter(line => pages.includes(line.page) && !line.watermark);
    const numbered = (line: SourceLine) => /^\s*\(?(\d+)[).、:]\s*/.exec(normalizeDigits(line.text));
    const start = candidates.findIndex(line => Number(numbered(line)?.[1]) === q.number);
    if (start < 0) return sourceText(candidates); // never invent a smaller evidence window
    let end = start + 1;
    while (end < candidates.length && !numbered(candidates[end])) end++;
    return sourceText(candidates.slice(start, end));
  };
  const listeningScript = (blind: boolean) => {
    const source = blind ? blindLines : lines;
    const start = source.findIndex(line => /^\s*(?:(?:listening|audio) script|transcript|متن شنیداری)\s*[:：]?/i.test(line.text));
    return start < 0 ? undefined : sourceText(source.slice(start));
  };
  const contentKinds = new Set<LoopDecisionKind>(['complete', 'answer-correct', 'answer-letter', 'difficulty', 'curriculum-hint']);
  const record = (q: import('./localLoop').AuthoredQuestion, blind = false) => {
    // Whitelist, not a spread: model extensions can carry answers/rationales too.
    const question = blind ? { number: q.number, type: q.type, stem: q.stem,
      options: q.options.map(o => ({ key: o.key, text: o.text })) } : q;
    const passage = document.passages?.find(p => q.passageId ? p.id === q.passageId : q.number >= p.appliesToFirst! && q.number <= p.appliesToLast!);
    return { question, sourceItemText: itemSource(q, blind), sourcePageText: sourceFor(q, blind), ...(passage ? { passageText: passage.text } : {}),
      ...(/listen|audio|شنید/i.test(`${q.sectionTitle || ''} ${q.stem}`) && listeningScript(blind) ? { listeningScript: listeningScript(blind) } : {}) };
  };
  const evidenceMissing = (q: import('./localLoop').AuthoredQuestion, type: LoopDecisionKind): string | undefined => {
    if (!itemSource(q, false).trim()) return 'source text unavailable';
    if (!contentKinds.has(type)) return undefined;
    if (/\b(picture|image|photo|illustration)\b/i.test(q.stem) && !q.imageIds.length) return 'image not judged — no pixels';
    if (q.imageIds.length && q.imageIds.some(id => !multimodal || !imagePayloads[id]?.data)) return 'image not judged — no pixels';
    if (q.passageId && !document.passages?.some(p => p.id === q.passageId && p.text.trim())) return 'passage unavailable';
    if (/listen|audio|شنید/i.test(`${q.sectionTitle || ''} ${q.stem}`) &&
      !listeningScript(false)) return 'unverifiable for teacher — no printed listening script';
    if (/according to (?:the )?(?:passage|text)|read(?:ing)? passage/i.test(q.stem) &&
      !document.passages?.some(p => (p.id === q.passageId || (q.number >= p.appliesToFirst! && q.number <= p.appliesToLast!)) && p.text.trim())) return 'passage unavailable';
  };
  const add = (q: import('./localLoop').AuthoredQuestion, type: LoopDecisionKind, instructions: string, blind = false): LoopDecisionItem => {
    const missing = evidenceMissing(q, type);
    const payloads = contentKinds.has(type) ? q.imageIds.flatMap(id => multimodal && imagePayloads[id]?.data ? [imagePayloads[id]] : []) : [];
    const item: LoopDecisionItem = { id: `Q${q.number}::${type}`, type, name: `Q${q.number} ${type}`, instructions,
      questionNumbers: [q.number], input: record(q, blind), authoredQuestion: q,
      ...(missing ? { skippedNoEvidence: missing } : {}), ...(payloads.length ? { images: payloads } : {}) };
    items.push(item); return item;
  };
  const questions = flatAuthoredQuestions(document);
  const pointsMismatch = typeof document.meta.totalPoints === 'number' && Math.abs(questions.reduce((sum, q) => sum + (q.subQuestions?.length ? 0 : q.points || 0), 0) - document.meta.totalPoints) > 0.001;
  for (const q of questions) {
    if (!sourceProvesTruncatedStem(q, lines)) add(q, 'stem-faithful', "Every part of this question's text appears in the source text.");
    if (!sourceProvesTruncatedStem(q, lines)) add(q, 'complete', 'This question can be answered from the text given, without anything missing.');
    add(q, 'uncontaminated', "All material in this question belongs to this question.");
    add(q, 'type-correct', 'The declared question type matches the source question.');
    if (q.answer?.trim()) {
      if (q.options.length >= 2) {
        const letter = parseAnswerLetter(q.answer, q as unknown as Question);
        const expected = q.options.find(o => (letter !== undefined && canonicalLetter(o.key) === letter) || o.text.trim().toLowerCase() === q.answer!.trim().toLowerCase())?.key;
        for (const type of ['answer-correct', 'answer-letter'] as const) {
          const item = add(q, type, type === 'answer-correct' ? 'Which option is the correct answer to this question?' : 'Which option letter names the correct answer to this question?', true);
          item.choices = q.options.map(o => o.key);
          item.choiceDescriptions = Object.fromEntries(q.options.map(o => [o.key, o.text]));
          item.expectedChoice = expected;
          if (!expected) item.skippedNoEvidence = 'unverifiable for teacher — authored key does not resolve to an option';
        }
      } else if (!['mcq', 'multi', 'truefalse', 'matching'].includes(q.type)) add(q, 'answer-correct', `The answer '${q.answer}' is a correct answer to this question.`);
    }
    if (!pointsMismatch) add(q, 'points-plausible', 'The points shown for this question are printed in the source for this question.');
    add(q, 'belongs-in-section', 'This question belongs in its assigned printed section.');
    const difficulty = add(q, 'difficulty', DIFFICULTY_INSTRUCTIONS);
    difficulty.choices = ['1', '2', '3', '4', '5'];
    const lessons = curriculumLessons(document.meta.grade, document.meta.subject);
    const hint = keywordCurriculumHint(lessons, `${q.stem} ${q.options.map(o => o.text).join(' ')}`);
    q.curriculumHints = hint || emptyCurriculumHints();
    if (hint) q.curriculumSource = 'keyword'; else delete q.curriculumSource;
    if (!hint && lessons.length && params.mode === 'active') {
      const item = add(q, 'curriculum-hint', 'Choose the official lesson most relevant to this question.');
      item.choices = lessons.map(lesson => lesson.title);
      item.choiceDescriptions = Object.fromEntries(lessons.map(lesson => [lesson.title, lesson.choiceDescription || lesson.title]));
    }
  }
  for (const image of images) {
    if (image.duplicateOf || image.label?.role === 'decoration' || image.label?.kind === 'decoration') continue;
    const candidates = flatAuthoredQuestions(document).filter(q => questionSourcePages(q, lines).includes(image.page));
    const owner = candidates.find(q => q.imageIds.includes(image.id));
    const payload = multimodal && imagePayloads[image.id]?.data ? imagePayloads[image.id] : undefined;
    items.push({
      id: `image-${image.id}::image-belongs`, type: 'image-belongs', name: `Image ${image.id} image-belongs`,
      instructions: IMAGE_OWNERSHIP_INSTRUCTIONS,
      questionNumbers: owner ? [owner.number] : candidates.map(q => q.number), imageId: image.id,
      choices: ['this question', 'another question on the page', 'no question'],
      input: { imageId: image.id, page: image.page, caption: image.label?.caption || '', currentQuestionNumber: owner?.number ?? null,
        candidateQuestions: candidates.map(q => ({ number: q.number, stem: q.stem, options: q.options.map(o => ({ key: o.key, text: o.text })) })), pixelsAttached: Boolean(payload),
        sourcePageText: sourcePagesText(lines, [image.page]) },
      ...(payload ? { images: [payload] } : { skippedNoEvidence: 'image not judged — no pixels' }),
    });
    if (owner && owner.options.length >= 2) {
      const expected = parseAnswerLetter(owner.answer, owner as unknown as Question);
      const option = owner.options.find(o => expected !== undefined && canonicalLetter(o.key) === expected);
      items.push({ id: `image-${image.id}::image-belongs-sentences`, type: 'image-belongs', name: `Image ${image.id} image-belongs sentences`,
        instructions: 'Which sentence does this picture illustrate?', imageId: image.id, questionNumbers: [owner.number],
        input: { question: { stem: owner.stem, options: owner.options.map(o => ({ key: o.key, text: o.text })) } },
        choices: [...owner.options.map(o => o.key), 'none'], choiceDescriptions: { ...Object.fromEntries(owner.options.map(o => [o.key, o.text])), none: 'None of these sentences' },
        comparisonId: `image-${image.id}::image-belongs`, expectedChoice: option?.key,
        ...(payload ? { images: [payload] } : { skippedNoEvidence: 'image not judged — no pixels' }) });
    }
  }
  return items;
}
/** #52: illustrative scenes count, not merely literal object identity. */
export const IMAGE_OWNERSHIP_INSTRUCTIONS = 'Does this image belong to the currently assigned question? Choose this question, another question on the page, or no question. A picture belongs to a question when it shows the situation, activity, or subject that question or its correct sentence describes; a typical illustrative scene counts as a match.';

/** Choice evidence uses the requested 0.50 confidence floor. Noul bands stay 0.80/0.20.
 * No empirical per-kind calibration is claimed: see scripts/calibrate-decide.ts. */
export function blindChoiceSoundProbability(expected: string, choices: string[], vote: LoopDecisionVote): number {
  // Only numerically uniform distributions are flat; no unmeasured near-flat band.
  const values = Object.values(vote.distribution || {});
  if (!vote.choice || !choices.includes(vote.choice) || vote.probability < 0.5 ||
    (values.length > 1 && Math.max(...values) - Math.min(...values) <= Number.EPSILON * values.length)) return 0.5;
  return vote.choice === expected ? 1 : 0;
}
export function decisionSoundProbability(item: LoopDecisionItem, vote: LoopDecisionVote): number {
  if (item.choices && item.type !== 'difficulty' && item.type !== 'curriculum-hint') {
    if (!vote.choice || !item.choices.includes(vote.choice) || vote.probability < 0.5) return 0.5;
    const values = Object.values(vote.distribution || {});
    if (values.length > 1 && Math.max(...values) - Math.min(...values) <= Number.EPSILON * values.length) return 0.5;
    if (item.expectedChoice !== undefined) return blindChoiceSoundProbability(item.expectedChoice, item.choices, vote);
    if (item.type === 'image-belongs') {
      if (item.input.currentQuestionNumber === null) return 0.5;
      return vote.choice === 'this question' ? vote.probability : 1 - vote.probability;
    }
    return 0.5;
  }
  return vote.probability;
}
/** Marked middle elision; unlike a prefix slice it cannot amputate final statements. */
export function elideMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const edge = Math.max(1, Math.floor((maxChars - 7) / 2));
  return `${text.slice(0, edge)}\n[…]\n${text.slice(-edge)}`;
}
/** Full item and explicit passage evidence are never shortened. Only background page context is
 * middle-elided; retaining both edges prevents the old tail-amputation of T/F statements.
 * Oversize indispensable evidence is sent whole rather than silently voting on a fragment. */
export function buildLoopDecisionState(item: LoopDecisionItem): string {
  const { sourcePageText, ...required } = item.input;
  const full = JSON.stringify(required);
  const source = String(sourcePageText || '');
  const budget = Math.max(400, (850 - estimateTokens(full)) * 3);
  const context = elideMiddle(source, budget);
  return `Question: ${full}\nSource: ${context}`;
}
const emptyResult = (mode: LoopAuditResult['mode'], notes: string[] = []): LoopAuditResult => ({ verdicts: [], routed: [], calls: 0, mode, notes, usage: { inputTokens: 0, outputTokens: 0 }, catches: 0, uncertain: 0, endpointErrors: 0, difficultyUncertain: 0, skippedNoEvidence: 0, votes: new Map(), revoted: 0, reused: 0 });
const clamp = (value: unknown): number | undefined => { if (value === null || value === undefined || value === '') return undefined; const p = Number(value); return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : undefined; };
export interface LoopAuditProgress {
  total: number; questions: number; images: number; decided: number; catches: number; uncertain: number; endpointErrors: number; skippedNoEvidence: number;
  rate: number; currentItem?: string; recent: string[]; skipped?: boolean;
}
export async function runLoopDecisionAudit(params: {
  document: AuthoredDocument; lines: SourceLine[]; images: ImageAsset[]; settings: AppSettings; fileHash: string;
  decisionCaller?: LoopDecisionCaller;
  imagePayload?: (image: ImageAsset) => Promise<{ id: string; mime: string; data: string } | undefined>;
  onProgress?: (progress: LoopAuditProgress) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText?: string }) => void | Promise<void>;
  /** #51 Present re-check: only items where revote() is true are sent (fresh, cache bypassed); the rest reuse
   * their Check vote. Items with neither are left unvoted — a re-check never widens the audit. */
  recheck?: { previous: Map<string, LoopDecisionVote>; revote: (item: LoopDecisionItem) => boolean };
}): Promise<LoopAuditResult> {
  const { document, lines, images, settings, fileHash } = params;
  const mode = settings.decideMode ?? 'shadow';
  const provider = resolveDecisionProvider(settings);
  if (!provider) return emptyResult('skipped', ['decision audit skipped — no decide endpoint configured']);
  const result = emptyResult(mode);
  try { result.dialect = provider.decideDialect || 'jev'; result.endpointHost = new URL(provider.baseURL).host; } catch { result.endpointHost = provider.baseURL; }
  const multimodal = decideIsMultimodal(settings, provider);
  const payloads: Record<string, { id: string; mime: string; data: string }> = {};
  if (multimodal && params.imagePayload) {
    for (const image of images) {
      try { const payload = await params.imagePayload(image); if (payload) payloads[image.id] = payload; }
      catch (error) { result.notes.push(`Image ${image.id} not judged — no pixels (${errorMessage(error)}).`); }
    }
  }
  const fullCatalogue = buildLoopDecisionCatalogue({ document, lines, images, mode, multimodal, imagePayloads: payloads });
  const recheck = params.recheck;
  const catalogue = recheck ? fullCatalogue.filter(item => recheck.revote(item) || recheck.previous.has(item.id)) : fullCatalogue;
  if (!catalogue.length) return result;
  const started = Date.now();
  const progress: LoopAuditProgress = { total: catalogue.length, questions: flatAuthoredQuestions(document).length, images: catalogue.filter(item => item.type === 'image-belongs').length, decided: 0, catches: 0, uncertain: 0, endpointErrors: 0, skippedNoEvidence: 0, rate: 0, recent: [] };
  const emit = () => { progress.rate = progress.decided / Math.max(0.001, (Date.now() - started) / 1000); try { params.onProgress?.({ ...progress, recent: [...progress.recent] }); } catch { /* UI is advisory */ } };
  const soundProbability = (item: LoopDecisionItem, vote: LoopDecisionVote) => {
    let p = decisionSoundProbability(item, vote);
    if (item.type === 'image-belongs' && !item.comparisonId) {
      const comparative = catalogue.find(c => c.comparisonId === item.id);
      if (comparative) {
        const other = result.votes.get(comparative.id);
        // Both measurements are required. Conflicting evidence must never silently pass.
        if (!other || comparative.skippedNoEvidence) return 0.5;
        const cp = decisionSoundProbability(comparative, other);
        if ((p >= DECIDE_PASS && cp <= DECIDE_CATCH) || (p <= DECIDE_CATCH && cp >= DECIDE_PASS)) return 0.5;
        if (p >= DECIDE_PASS && cp >= DECIDE_PASS) p = Math.max(p, other.probability);
        else if (cp > DECIDE_CATCH && cp < DECIDE_PASS) p = 0.5;
      }
    }
    return p;
  };
  let noVoteUncertain = 0, curriculumUncertain = 0;
  const completed = (item: LoopDecisionItem, vote?: LoopDecisionVote, endpointError = false) => {
    progress.decided++; progress.currentItem = item.name;
    if (!vote) noVoteUncertain++;
    if (vote && item.type === 'curriculum-hint' && vote.probability < 0.5) curriculumUncertain++;
    if (endpointError) progress.endpointErrors++;
    const p = vote && soundProbability(item, vote);
    const tagging = item.type === 'difficulty' || item.type === 'curriculum-hint';
    const tagUncertain = p !== undefined && (item.type === 'difficulty' ? p < DIFFICULTY_UNCERTAIN_BELOW : p < 0.5);
    if (p === undefined || (tagging ? tagUncertain : p > DECIDE_CATCH && p < DECIDE_PASS)) progress.uncertain++;
    else if (!tagging && p <= DECIDE_CATCH) progress.catches++;
    progress.recent.push(`${item.name.replace(' ', ' · ')} · ${p === undefined ? 'uncertain' : `p=${p.toFixed(2)} ${tagging ? (tagUncertain ? '?' : '✓') : p <= DECIDE_CATCH ? '⚠' : p >= DECIDE_PASS ? '✓' : '?'}`}${endpointError ? ' · endpoint error' : ''}`);
    progress.recent = progress.recent.slice(-20); emit();
  };
  emit();
  const cacheEnabled = settings.thrift.cacheEnabled;
  const unresolved: LoopDecisionItem[] = [];
  const votes = result.votes;
  for (const item of catalogue) {
    if (item.skippedNoEvidence) {
      result.skippedNoEvidence++; progress.skippedNoEvidence++;
      result.notes.push(`${item.name}: ${item.skippedNoEvidence}`); emit(); continue;
    }
    if (recheck) {
      if (recheck.revote(item)) { unresolved.push(item); result.revoted++; continue; }
      const prior = recheck.previous.get(item.id)!; votes.set(item.id, prior); completed(item, prior); result.reused++; continue;
    }
    if (!cacheEnabled) { unresolved.push(item); continue; }
    const key = await sha256(`loop-decide-v2:${fileHash}:${provider.id}:${provider.model}:${multimodal}:${JSON.stringify(item)}`);
    try {
      const cached = await getPipelineCache<{ probability: number; choice?: string }>(key);
      if (cached && clamp(cached.probability) !== undefined) { votes.set(item.id, cached); completed(item, cached); } else unresolved.push(item);
    } catch { unresolved.push(item); }
  }
  // THX items are independent; localhost defaults to one request. JEV keeps its existing batches.
  const thx = provider.decideDialect === 'thx';
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(provider.baseURL).hostname); } catch { /* invalid URL handled by transport */ }
  const configured = Number(provider.decideConcurrency);
  const concurrency = Number.isFinite(configured) && configured >= 1 ? Math.min(32, Math.floor(configured)) : (thx && local ? 1 : 4);
  const width = thx ? concurrency : 16;
  let consecutiveEndpointErrors = 0;
  for (let start = 0; start < unresolved.length; start += width) {
    const window = unresolved.slice(start, start + width);
    const caller = params.decisionCaller || ((request: DecisionRequestBody) => LLMAdapter.executeDecisions({ providerConfig: provider, body: request, timeoutMs: DECIDE_TIMEOUT_MS }));
    const jobs = thx ? window.map(item => [item]) : [window];
    await Promise.all(jobs.map(async batch => {
      const item0=batch[0];
      const state = buildLoopDecisionState(item0);
      const body: DecisionRequestBody = thx ? buildThxDecisionBody(item0, provider.model, state) : {
        input: { exam: fileHash.slice(0, 12), purpose: 'comment-only exam audit' },
        questions: batch.map(item => ({ type: item.choices ? 'choice' : 'probability', name: item.id, instructions: item.instructions, input: item.input, ...(item.choices ? { choices: item.choices, ...(item.choiceDescriptions ? { choiceDescriptions: item.choiceDescriptions } : {}) } : {}), ...(item.images ? { images: item.images } : {}) })),
      };
      result.calls++; result.usage.inputTokens += estimateTokens(JSON.stringify(body));
      try {
        const response = await caller(body);
        const byName = new Map(response.results.map(r => [r.name, r]));
        for (const item of batch) {
          const row = byName.get(item.id) ?? byName.get(item.name); const p = clamp(row?.probability);
          if (p === undefined || (item.type === 'difficulty' && !['1', '2', '3', '4', '5'].includes(row?.choice || '')) || (item.type === 'curriculum-hint' && !item.choices?.includes(row?.choice || ''))) { result.notes.push(`Decision audit returned no usable verdict for ${item.id}.`); completed(item); continue; }
          const vote = { probability: p, ...(row?.choice !== undefined ? { choice: row.choice } : {}), ...(row?.distribution ? { distribution: row.distribution } : {}) };
          votes.set(item.id, vote); completed(item, vote);
          if (cacheEnabled) try { await setPipelineCache(await sha256(`loop-decide-v2:${fileHash}:${provider.id}:${provider.model}:${multimodal}:${JSON.stringify(item)}`), vote); } catch { /* best effort */ }
        }
        consecutiveEndpointErrors = 0;
        try { await params.onJournal?.({ label: 'Decision audit · comments only', rawText: JSON.stringify(response.results), requestText: JSON.stringify(body) }); } catch { /* journal is optional */ }
      } catch (error) {
        const message = errorMessage(error);
        const endpointError = /HTTP 5\d\d|abort|timed? ?out|network|fetch|unreachable|connection|ECONN/i.test(message);
        if (endpointError) consecutiveEndpointErrors++; else consecutiveEndpointErrors = 0;
        for (const item of batch) completed(item, undefined, endpointError);
        result.notes.push(`decision audit skipped for ${batch.length} item(s) — ${message}`);
      }
    }));
    if (consecutiveEndpointErrors >= 5) {
      result.notes.push(`endpoint unreachable — skipping (${progress.endpointErrors} errors)`);
      progress.skipped = true; emit(); break;
    }
  }
  result.endpointErrors = progress.endpointErrors;
  for (const item of catalogue) {
    const vote = votes.get(item.id); if (!vote || item.comparisonId || item.skippedNoEvidence) continue;
    const probability = soundProbability(item, vote);
    if (item.type === 'difficulty') {
      const value = Number(vote.choice);
      if (Number.isInteger(value) && value >= 1 && value <= 5) {
        const q = item.authoredQuestion!;
        // Argmax level from the returned distribution; flat (top level < 0.4) is flagged uncertain.
        const uncertain = probability < DIFFICULTY_UNCERTAIN_BELOW;
        q.difficulty = { value, source: 'model', ...(uncertain ? { uncertain: true } : {}) }; q.difficultyMode = mode;
        if (uncertain) result.difficultyUncertain++;
      }
      continue;
    }
    if (item.type === 'curriculum-hint') {
      const lesson = curriculumLessons(document.meta.grade, document.meta.subject).find(l => l.title === vote.choice);
      if (lesson && probability >= 0.5) {
        const q = item.authoredQuestion!;
        q.curriculumHints = hintsForLesson(lesson); q.curriculumSource = 'decision';
      }
      continue;
    }
    const verdict: LoopVerdict = {
      id: `decision:${item.id}`, kind: item.type, questionNumbers: [...new Set(item.questionNumbers)], source: 'decision', probability,
      message: item.expectedChoice !== undefined ? `Blind choice comparison: ${vote.choice === item.expectedChoice ? 'agrees with' : 'differs from'} the authored option (judge confidence ${vote.probability.toFixed(2)}). Routing score: ${probability.toFixed(2)}; this is not a calibrated posterior.` : `${item.instructions} Probability that this item is sound: ${probability.toFixed(2)}.${vote.choice ? ` Choice: ${vote.choice}.` : ''}`,
      ...(vote.choice !== undefined ? { choice: vote.choice } : {}), ...(item.imageId ? { imageId: item.imageId } : {}),
    };
    result.verdicts.push(verdict);
    if (probability <= DECIDE_CATCH) {
      result.catches++;
      if (mode === 'active') { verdict.routed = true; result.routed.push(verdict); }
    } else if (probability < DECIDE_PASS) result.uncertain++;
  }
  progress.catches = result.catches;
  result.uncertain += result.difficultyUncertain + noVoteUncertain + curriculumUncertain;
  progress.uncertain = result.uncertain;
  emit();
  if (result.difficultyUncertain) result.notes.push(`difficultyUncertain: ${result.difficultyUncertain} model estimate(s) have a flat level distribution (top level < ${DIFFICULTY_UNCERTAIN_BELOW}).`);
  if (progress.skipped || (!result.verdicts.length && result.notes.length)) result.mode = 'skipped';
  return result;
}
