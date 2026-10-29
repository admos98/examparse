/** Decision audit: quality verdicts plus advisory difficulty and curriculum proposals. */
import type { AppSettings, ImageAsset, ProviderConfig, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { getPipelineCache, setPipelineCache } from '../store';
import { sha256 } from '../utils/hash';
import { estimateTokens } from './memory/tokens';
import { DECIDE_CATCH, DECIDE_PASS, DECIDE_TIMEOUT_MS } from './audit';
import { curriculumLessons, keywordCurriculumHint, hintsForLesson, emptyCurriculumHints } from './curriculumHints';
import { errorMessage, flatAuthoredQuestions, questionSourcePages, sourcePagesText, type AuthoredDocument, type LoopDecisionKind, type LoopVerdict } from './localLoop';

export interface LoopDecisionItem {
  id: string; type: LoopDecisionKind; name: string; instructions: string;
  questionNumbers: number[]; input: Record<string, unknown>;
  choices?: string[]; choiceDescriptions?: Record<string, string>; imageId?: string;
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
  return { model, state, questions: { [item.name]: question } };
}
export interface LoopAuditResult {
  verdicts: LoopVerdict[]; routed: LoopVerdict[]; calls: number; mode: 'shadow' | 'active' | 'skipped';
  notes: string[]; usage: { inputTokens: number; outputTokens: number }; catches: number; uncertain: number; endpointErrors: number; difficultyUncertain: number; dialect?: 'jev'|'thx'; endpointHost?: string;
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
  const add = (q: ReturnType<typeof flatAuthoredQuestions>[number], type: LoopDecisionKind, instructions: string, extra: Record<string, unknown> = {}) => {
    const pages = questionSourcePages(q, lines);
    items.push({ id: `Q${q.number}::${type}`, type, name: `Q${q.number} ${type}`, instructions,
      questionNumbers: [q.number], input: { question: q, sourcePageText: sourcePagesText(lines, pages), ...extra } });
  };
  for (const q of flatAuthoredQuestions(document)) {
    add(q, 'stem-faithful', 'Is the full authored stem faithful to the printed source, without invented or omitted question material?');
    add(q, 'complete', 'Is this question complete, including its options, required passage/instructions, and printed marks?');
    add(q, 'uncontaminated', "Is this question free of another question's material and unrelated header/footer text?");
    add(q, 'type-correct', 'Is the declared question type correct for the printed question?');
    add(q, 'answer-correct', 'If the source prints an answer, is the authored answer correct? If no answer is printed, is it right that no answer was invented?');
    add(q, 'answer-letter', 'If an answer letter is printed or supplied, does it name the correct authored option?');
    add(q, 'points-plausible', 'Are the points faithful to printed marks, without invented or distributed points, and plausible for the exam total?', { totalPoints: document.meta.totalPoints });
    add(q, 'belongs-in-section', 'Does this question belong in its assigned printed section?', { sectionTitle: q.sectionTitle });
    const difficultyChoices = ['1', '2', '3', '4', '5'];
    items.push({ id: `Q${q.number}::difficulty`, type: 'difficulty', name: `Q${q.number} difficulty`,
      instructions: DIFFICULTY_INSTRUCTIONS,
      questionNumbers: [q.number], input: { question: q }, choices: difficultyChoices });
    const lessons = curriculumLessons(document.meta.grade, document.meta.subject);
    const hint = keywordCurriculumHint(lessons, `${q.stem} ${q.options.map(o => o.text).join(' ')}`);
    q.curriculumHints = hint || emptyCurriculumHints();
    if (hint) q.curriculumSource = 'keyword'; else delete q.curriculumSource;
    if (!hint && lessons.length && params.mode === 'active') {
      items.push({ id: `Q${q.number}::curriculum-hint`, type: 'curriculum-hint', name: `Q${q.number} curriculum-hint`,
        instructions: 'Choose the official lesson most relevant to this question.', questionNumbers: [q.number], input: { question: q },
        choices: lessons.map(lesson => lesson.title), choiceDescriptions: Object.fromEntries(lessons.map(lesson => [lesson.title, lesson.choiceDescription || lesson.title])) });
    }
  }
  for (const image of images) {
    if (image.duplicateOf || image.label?.role === 'decoration' || image.label?.kind === 'decoration') continue;
    const candidates = flatAuthoredQuestions(document).filter(q => questionSourcePages(q, lines).includes(image.page));
    const owner = candidates.find(q => q.imageIds.includes(image.id));
    const payload = multimodal ? imagePayloads[image.id] : undefined;
    items.push({
      id: `image-${image.id}::image-belongs`, type: 'image-belongs', name: `Image ${image.id} image-belongs`,
      instructions: 'Does this image belong to the currently assigned question? Choose this question, another question on the page, or no question. Use the pixels when attached; otherwise use the caption and stems.',
      questionNumbers: owner ? [owner.number] : candidates.map(q => q.number), imageId: image.id,
      choices: ['this question', 'another question on the page', 'no question'],
      input: { imageId: image.id, page: image.page, caption: image.label?.caption || '', currentQuestionNumber: owner?.number ?? null,
        candidateQuestions: candidates.map(q => ({ number: q.number, stem: q.stem })), pixelsAttached: Boolean(payload),
        sourcePageText: sourcePagesText(lines, [image.page]) },
      ...(payload ? { images: [payload] } : {}),
    });
  }
  return items;
}
const emptyResult = (mode: LoopAuditResult['mode'], notes: string[] = []): LoopAuditResult => ({ verdicts: [], routed: [], calls: 0, mode, notes, usage: { inputTokens: 0, outputTokens: 0 }, catches: 0, uncertain: 0, endpointErrors: 0, difficultyUncertain: 0 });
const clamp = (value: unknown): number | undefined => { if (value === null || value === undefined || value === '') return undefined; const p = Number(value); return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : undefined; };
export interface LoopAuditProgress {
  total: number; questions: number; images: number; decided: number; catches: number; uncertain: number; endpointErrors: number;
  rate: number; currentItem?: string; recent: string[]; skipped?: boolean;
}
export async function runLoopDecisionAudit(params: {
  document: AuthoredDocument; lines: SourceLine[]; images: ImageAsset[]; settings: AppSettings; fileHash: string;
  decisionCaller?: LoopDecisionCaller;
  imagePayload?: (image: ImageAsset) => Promise<{ id: string; mime: string; data: string } | undefined>;
  onProgress?: (progress: LoopAuditProgress) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText?: string }) => void | Promise<void>;
}): Promise<LoopAuditResult> {
  const { document, lines, images, settings, fileHash } = params;
  const mode = settings.decideMode ?? 'shadow';
  const provider = resolveDecisionProvider(settings);
  if (!provider) return emptyResult('skipped', ['decision audit skipped — no decide endpoint configured']);
  const result = emptyResult(mode);
  try { result.dialect = provider.decideDialect || 'jev'; result.endpointHost = new URL(provider.baseURL).host; } catch { result.endpointHost = provider.baseURL; }
  const multimodal = settings.decideMultimodal === true;
  const payloads: Record<string, { id: string; mime: string; data: string }> = {};
  if (multimodal && params.imagePayload) {
    for (const image of images) {
      try { const payload = await params.imagePayload(image); if (payload) payloads[image.id] = payload; }
      catch (error) { result.notes.push(`Image ${image.id} pixels unavailable — caption-only audit (${errorMessage(error)}).`); }
    }
  }
  const catalogue = buildLoopDecisionCatalogue({ document, lines, images, mode, multimodal, imagePayloads: payloads });
  if (!catalogue.length) return result;
  const started = Date.now();
  const progress: LoopAuditProgress = { total: catalogue.length, questions: flatAuthoredQuestions(document).length, images: catalogue.filter(item => item.type === 'image-belongs').length, decided: 0, catches: 0, uncertain: 0, endpointErrors: 0, rate: 0, recent: [] };
  const emit = () => { progress.rate = progress.decided / Math.max(0.001, (Date.now() - started) / 1000); try { params.onProgress?.({ ...progress, recent: [...progress.recent] }); } catch { /* UI is advisory */ } };
  const soundProbability = (item: LoopDecisionItem, vote: { probability: number; choice?: string }) => {
    if (item.type !== 'image-belongs') return vote.probability;
    if (vote.choice === 'this question') return item.input.currentQuestionNumber === null ? 0.5 : vote.probability;
    if (vote.choice === 'another question on the page' || vote.choice === 'no question') return 1 - vote.probability;
    return 0.5;
  };
  const completed = (item: LoopDecisionItem, vote?: { probability: number; choice?: string }, endpointError = false) => {
    progress.decided++; progress.currentItem = item.name;
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
  const votes = new Map<string, { probability: number; choice?: string; distribution?: Record<string, number> }>();
  for (const item of catalogue) {
    if (!cacheEnabled) { unresolved.push(item); continue; }
    const key = await sha256(`loop-decide-v1:${fileHash}:${provider.id}:${provider.model}:${multimodal}:${JSON.stringify(item)}`);
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
      const questionObject=item0?.input?.question || item0?.input || {};
      const qText=`Question: ${JSON.stringify(questionObject)}`;
      const sourceText=String(item0?.input?.sourcePageText || item0?.input?.caption || '');
      let tail=sourceText;
      while(tail && estimateTokens(`${qText}\nSource: ${tail}`)>850) tail=tail.slice(0,Math.max(0,Math.floor(tail.length*0.85)));
      const state=`${qText}\nSource: ${tail}`;
      const body: DecisionRequestBody = thx ? buildThxDecisionBody(item0, provider.model, state) : {
        input: { exam: fileHash.slice(0, 12), purpose: 'comment-only exam audit' },
        questions: batch.map(item => ({ type: item.choices ? 'choice' : 'probability', name: item.id, instructions: item.instructions, input: item.input, ...(item.choices ? { choices: item.choices } : {}), ...(item.images ? { images: item.images } : {}) })),
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
          if (cacheEnabled) try { await setPipelineCache(await sha256(`loop-decide-v1:${fileHash}:${provider.id}:${provider.model}:${multimodal}:${JSON.stringify(item)}`), vote); } catch { /* best effort */ }
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
    const vote = votes.get(item.id); if (!vote) continue;
    const probability = soundProbability(item, vote);
    if (item.type === 'difficulty') {
      const value = Number(vote.choice);
      if (Number.isInteger(value) && value >= 1 && value <= 5) {
        const q = item.input.question as import('./localLoop').AuthoredQuestion;
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
        const q = item.input.question as import('./localLoop').AuthoredQuestion;
        q.curriculumHints = hintsForLesson(lesson); q.curriculumSource = 'decision';
      }
      continue;
    }
    const verdict: LoopVerdict = {
      id: `decision:${item.id}`, kind: item.type, questionNumbers: [...new Set(item.questionNumbers)], source: 'decision', probability,
      message: `${item.instructions} Probability that this item is sound: ${probability.toFixed(2)}.${vote.choice ? ` Choice: ${vote.choice}.` : ''}`,
      ...(vote.choice !== undefined ? { choice: vote.choice } : {}), ...(item.imageId ? { imageId: item.imageId } : {}),
    };
    result.verdicts.push(verdict);
    if (probability <= DECIDE_CATCH) {
      result.catches++;
      if (mode === 'active') { verdict.routed = true; result.routed.push(verdict); }
    } else if (probability < DECIDE_PASS) result.uncertain++;
  }
  result.uncertain = progress.uncertain;
  if (result.difficultyUncertain) result.notes.push(`difficultyUncertain: ${result.difficultyUncertain} model estimate(s) have a flat level distribution (top level < ${DIFFICULTY_UNCERTAIN_BELOW}).`);
  if (progress.skipped || (!result.verdicts.length && result.notes.length)) result.mode = 'skipped';
  return result;
}
