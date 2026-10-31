/** Local, section-batched explanations. Responses are applied per question, never as arbitrary patches. */
import type { AppSettings, ExamDoc, LLMRequest, LLMResponse, Question } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { localProviderFor } from './localProvider';
import { canonicalLetter, parseAnswerLetter } from './answerCorrectness';
import { salvageJsonObjects } from '../utils/jsonRepair';
import { executableAnswerText, hasSourceKey, readFillBlankBlanks } from '../utils/bankAnswers';
import { explanationFingerprint, instructionTextFor } from './evidence';
import type { ImageBundle } from './evidenceBundle';

export function explanationKey(q: Question): string | undefined {
  if (!['mcq', 'truefalse', 'fillblank', 'short'].includes(q.type)) return undefined;
  if (q.imported?.disputed || q.imported?.answer_key?.disputed || q.imported?.answer_key?.status === 'disputed') return undefined;
  // #58 — a legacy AI value or a proposal is not an executable answer and never anchors a check.
  const importedCorrect = q.imported?.answer_key?.correct;
  const fillblanks = q.type === 'fillblank' ? readFillBlankBlanks(q) : undefined;
  const answer = executableAnswerText(q) || (Array.isArray(importedCorrect) ? importedCorrect.map(String).join(', ') : fillblanks?.blanks.map(blank => blank.accept.join(' / ')).join(' | '));
  if (!answer || !hasSourceKey(q)) return undefined;
  if (q.type === 'mcq' || (q.type === 'truefalse' && (q.options || []).length)) {
    const letter = parseAnswerLetter(answer, q);
    if (!(q.options || []).some(o => o.key.trim().toLowerCase() === answer.toLowerCase() || o.text?.trim().toLowerCase() === answer.toLowerCase() || (letter && canonicalLetter(o.key) === letter))) return undefined;
  }
  return answer;
}

export async function generatePackageExplanations(doc: ExamDoc, settings: AppSettings, options: {
  caller?: (request: LLMRequest) => Promise<Pick<LLMResponse, 'json' | 'rawText'>>;
  onProgress?: (message: string) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText: string }) => Promise<void>;
  /** Addressed pixels for the local writer; full visual groups are sent together or not at all. */
  loadBundle?: (question: Question) => Promise<ImageBundle>;
  writerCanSeeImages?: boolean;
  /** #58 Part F — live output of the underlying (single) model call, never a duplicate call. */
  onStream?: (text: string) => void;
} = {}): Promise<string[]> {
  // Existing explanations are durable work. Missing/stale items may be retried, but a failed
  // provider must never erase a prior draft or a still-current checked explanation.
  const provider = localProviderFor(settings, 'read');
  const visualProvider = localProviderFor(settings, 'vision');
  if (!provider) return ['Explanation generation not run — no local generative read provider configured.', `explanations: 0 of ${doc.questions.filter(q => explanationKey(q)).length} keyed questions`];
  const decide = settings.roleMapping.decide;
  const decisionProvider = decide && settings.providers.find(p => p.id === decide.providerId);
  if (decide && decide.model === provider.model && (decide.providerId === provider.id || (decisionProvider?.baseURL && decisionProvider.baseURL.replace(/\/+$/, '') === provider.baseURL.replace(/\/+$/, '')))) return ['Explanation generation not run — the read role selects the decision model.', `explanations: 0 of ${doc.questions.filter(q => explanationKey(q)).length} keyed questions`];
  const notes: string[] = [];
  // #57 Part E — intermediate narration is counted, never one line per section; it only
  // reaches the final notes when the final outcome is incomplete, as ONE summary line.
  let malformed = 0;
  let omittedBatches = 0;
  let failedBatches = 0;
  // Existing prose is durable; the decision stage may recheck it against current evidence, but
  // only a missing explanation is regenerated here.
  const eligible = doc.questions.filter(q => explanationKey(q) && !q.explanation);
  const skippedForPixels: Question[] = [];
  const system = 'Write student-facing explanations in the exam language. For each keyed question, use only the question, passage and options: explain in one or two sentences why the marked answer is correct and, for multiple choice, briefly why it beats the alternatives. Do not use outside facts or invent answers. Return JSON only: {"corrections":[{"questionNumber":"55A","explanation":"..."}]}. Use the exact label supplied as questionNumber. /no_think';
  const run = async (batch: Question[], section: string) => {
    const bundles = new Map<string, ImageBundle>();
    if (options.loadBundle) for (const q of batch.filter(question => question.images.length)) bundles.set(q.id, await options.loadBundle(q));
    const visual = batch.filter(q => q.images.length > 0);
    const usable = batch.filter(q => !q.images.length || (options.writerCanSeeImages === true && bundles.get(q.id)?.complete));
    for (const q of visual.filter(q => !usable.includes(q))) skippedForPixels.push(q);
    const imagePayloads = usable.flatMap(q => bundles.get(q.id)?.payloads || []);
    const limit = Math.min(...usable.filter(q => q.images.length).map(q => bundles.get(q.id)?.limit || 4), 4);
    const tooLarge = imagePayloads.length > limit;
    const sendQuestions = tooLarge ? usable.filter(q => !q.images.length) : usable;
    if (tooLarge) skippedForPixels.push(...usable.filter(q => q.images.length));
    if (!sendQuestions.length) return;
    const text = JSON.stringify({ language: doc.meta.language, section, questions: sendQuestions.map(q => ({
      number: /^\d+$/.test(q.label) ? q.no : q.label, label: q.label, type: q.type, stem: q.stem,
      options: q.options?.map(o => ({ key: o.key, text: o.text })), passage: doc.passages?.find(p => p.id === q.passageId)?.text,
      script: q.imported?.script || q.imported?.transcript, instructions: instructionTextFor(doc, q), answer: explanationKey(q),
      images: (q.images || []).map(ref => ref.imageId),
    })) });
    const request: LLMRequest = { role: 'read', system, text, providerConfig: imagePayloads.length && !tooLarge ? (visualProvider || provider) : provider, ...(imagePayloads.length && !tooLarge ? { images: imagePayloads } : {}), label: `Package explanations · ${section}`, maxOutputTokens: Math.min(8192, Math.max(512, sendQuestions.length * 160)) };
    options.onProgress?.(`Explain · ${section}`);
    try {
      const response = await (options.caller
        ? options.caller(request)
        : LLMAdapter.execute(request, options.onStream ? { onDelta: (_channel, fullText) => options.onStream!(fullText) } : undefined));
      let value: any = response.json;
      if (response.rawText?.trim()) {
        try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
        catch { value = { corrections: salvageJsonObjects(response.rawText) }; malformed++; }
      }
      const rows = Array.isArray(value?.corrections) ? value.corrections : [];
      const seen = new Set<string>();
      for (const row of rows) {
        const label = String(row?.questionNumber ?? row?.label ?? '');
        if (typeof row?.explanation !== 'string' || !row.explanation.trim() || seen.has(label)) continue;
        const matches = sendQuestions.filter(q => q.label === label);
        if (matches.length !== 1) continue;
        seen.add(label); matches[0].explanation = { text: row.explanation.trim(), source: 'model' };
      }
      if (seen.size < sendQuestions.length) omittedBatches++;
      try { await options.onJournal?.({ label: request.label, rawText: response.rawText || JSON.stringify(value), requestText: JSON.stringify({ system, text }) }); } catch { /* best effort */ }
    } catch { failedBatches++; }
  };
  // Never mix instruction groups or sections, and never send more than four items.
  const groups = new Map<string, Question[]>();
  for (const q of eligible) {
    const memberships = (doc.instructionGroups || []).map((g, i) => q.no >= g.appliesToFirst && q.no <= g.appliesToLast ? i : -1).filter(i => i >= 0);
    const key = JSON.stringify([q.sectionId, q.instructionGroups || q.imported?.instructionGroups || q.imported?.instruction_groups || q.imported?.instructions || (memberships.length ? memberships : null)]);
    groups.set(key, [...(groups.get(key) || []), q]);
  }
  for (const questions of groups.values()) {
    const section = doc.sections.find(s => s.id === questions[0].sectionId)?.title || 'Section';
    for (let i = 0; i < questions.length; i += 4) {
      const batch = questions.slice(i, i + 4);
      await run(batch, section);
      const retry = batch.filter(q => !q.explanation);
      // Nonvisual omissions get a precisely scoped one-item retry. Visual omissions stay together
      // so the addressed pixels are never split into smaller calls.
      const visualRetry = retry.filter(q => q.images.length > 0);
      const textRetry = retry.filter(q => q.images.length === 0);
      if (visualRetry.length) await run(visualRetry, section);
      for (const q of textRetry) await run([q], section);
    }
  }
  const made = eligible.filter(q => q.explanation).length;
  if (made < eligible.length) {
    const parts = [
      ...(failedBatches ? [`generation failed for ${failedBatches} batch call(s)`] : []),
      ...(malformed ? [`${malformed} malformed response(s)`] : []),
      ...(omittedBatches ? [`${omittedBatches} batch(es) omitted or malformed items`] : []),
    ];
    notes.push(`explanations incomplete: ${parts.length ? parts.join(', ') : 'no usable rows returned'} — ${eligible.length - made} of ${eligible.length} keyed items still missing after one retry each.`);
  }
  if (skippedForPixels.length) notes.push(`explanations: ${skippedForPixels.length} keyed picture question(s) not drafted because their pixels could not be shown to the writer.`);
  notes.push(`explanations: ${made} of ${eligible.length} keyed questions`);
  return [...new Set(notes)];
}
