/** #46 decision audit: typed probability comments only. It has no document-writing API. */
import type { AppSettings, ImageAsset, ProviderConfig, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { getPipelineCache, setPipelineCache } from '../store';
import { sha256 } from '../utils/hash';
import { estimateTokens } from './memory/tokens';
import { DECIDE_CATCH, DECIDE_PASS, DECIDE_TIMEOUT_MS } from './audit';
import { errorMessage, flatAuthoredQuestions, questionSourcePages, sourcePagesText, type AuthoredDocument, type LoopDecisionKind, type LoopVerdict } from './localLoop';

export interface LoopDecisionItem {
  id: string; type: LoopDecisionKind; name: string; instructions: string;
  questionNumbers: number[]; input: Record<string, unknown>;
  choices?: string[]; imageId?: string;
  images?: Array<{ id: string; mime: string; data: string }>;
}
export type DecisionRequestBody = any;
export type LoopDecisionCaller = (body: DecisionRequestBody) => Promise<{ results: Array<{ name: string; probability: number; choice?: string }> }>;
export interface LoopAuditResult {
  verdicts: LoopVerdict[]; routed: LoopVerdict[]; calls: number; mode: 'shadow' | 'active' | 'skipped';
  notes: string[]; usage: { inputTokens: number; outputTokens: number }; catches: number; uncertain: number; dialect?: 'jev'|'thx'; endpointHost?: string;
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
  multimodal?: boolean; imagePayloads?: Record<string, { id: string; mime: string; data: string }>;
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
const emptyResult = (mode: LoopAuditResult['mode'], notes: string[] = []): LoopAuditResult => ({ verdicts: [], routed: [], calls: 0, mode, notes, usage: { inputTokens: 0, outputTokens: 0 }, catches: 0, uncertain: 0 });
const clamp = (value: unknown): number | undefined => { const p = Number(value); return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : undefined; };
export async function runLoopDecisionAudit(params: {
  document: AuthoredDocument; lines: SourceLine[]; images: ImageAsset[]; settings: AppSettings; fileHash: string;
  decisionCaller?: LoopDecisionCaller;
  imagePayload?: (image: ImageAsset) => Promise<{ id: string; mime: string; data: string } | undefined>;
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
  const catalogue = buildLoopDecisionCatalogue({ document, lines, images, multimodal, imagePayloads: payloads });
  if (!catalogue.length) return result;
  const cacheEnabled = settings.thrift.cacheEnabled;
  const unresolved: LoopDecisionItem[] = [];
  const votes = new Map<string, { probability: number; choice?: string }>();
  for (const item of catalogue) {
    if (!cacheEnabled) { unresolved.push(item); continue; }
    const key = await sha256(`loop-decide-v1:${fileHash}:${provider.id}:${provider.model}:${multimodal}:${JSON.stringify(item)}`);
    try {
      const cached = await getPipelineCache<{ probability: number; choice?: string }>(key);
      if (cached && clamp(cached.probability) !== undefined) votes.set(item.id, cached); else unresolved.push(item);
    } catch { unresolved.push(item); }
  }
  // THX items are independent; cap concurrent single-item requests at four. JEV keeps its existing batches.
  const thx = provider.decideDialect === 'thx';
  const width = thx ? 4 : 16;
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
      const body: DecisionRequestBody = thx ? {
        model: provider.model, state, questions: { [item0.name]: { type: item0.type === 'points-plausible' ? 'score' : item0.choices ? 'choice' : 'noul', instructions: item0.instructions, ...(item0.choices ? { criteria: Object.fromEntries(item0.choices.map(c=>[c,c])) } : {}) } },
      } : {
        input: { exam: fileHash.slice(0, 12), purpose: 'comment-only exam audit' },
        questions: batch.map(item => ({ type: item.choices ? 'choice' : 'probability', name: item.id, instructions: item.instructions, input: item.input, ...(item.choices ? { choices: item.choices } : {}), ...(item.images ? { images: item.images } : {}) })),
      };
      result.calls++; result.usage.inputTokens += estimateTokens(JSON.stringify(body));
      try {
        const response = await caller(body);
        const byName = new Map(response.results.map(r => [r.name, r]));
        for (const item of batch) {
          const row = byName.get(item.id); const p = clamp(row?.probability);
          if (p === undefined) { result.notes.push(`Decision audit returned no usable verdict for ${item.id}.`); continue; }
          const vote = { probability: p, ...(row?.choice !== undefined ? { choice: row.choice } : {}) };
          votes.set(item.id, vote);
          if (cacheEnabled) try { await setPipelineCache(await sha256(`loop-decide-v1:${fileHash}:${provider.id}:${provider.model}:${multimodal}:${JSON.stringify(item)}`), vote); } catch { /* best effort */ }
        }
        try { await params.onJournal?.({ label: 'Decision audit · comments only', rawText: JSON.stringify(response.results), requestText: JSON.stringify(body) }); } catch { /* journal is optional */ }
      } catch (error) { result.notes.push(`decision audit skipped for ${batch.length} item(s) — ${errorMessage(error)}`); }
    }));
  }
  for (const item of catalogue) {
    const vote = votes.get(item.id); if (!vote) continue;
    let probability = vote.probability;
    if (item.type === 'image-belongs') {
      // Choice probability is P(selected choice), not P(sound). Normalize to the positive frame.
      if (vote.choice === 'this question') probability = item.input.currentQuestionNumber === null ? 0.5 : vote.probability;
      else if (vote.choice === 'another question on the page' || vote.choice === 'no question') probability = 1 - vote.probability;
      else probability = 0.5;
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
  if (!result.verdicts.length && result.notes.length) result.mode = 'skipped';
  return result;
}
