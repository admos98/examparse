/** Local, section-batched explanations. Responses are applied per question, never as arbitrary patches. */
import type { AppSettings, ExamDoc, LLMRequest, LLMResponse, Question } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { localProviderFor } from './localProvider';
import { canonicalLetter, parseAnswerLetter } from './answerCorrectness';

export function explanationKey(q: Question): string | undefined {
  if (!['mcq', 'truefalse', 'fillblank', 'short'].includes(q.type)) return undefined;
  if (q.imported?.disputed || q.imported?.answer_key?.disputed || q.imported?.answer_key?.status === 'disputed') return undefined;
  if (q.answer?.source === 'ai') return undefined;
  const answer = q.answer?.text?.trim();
  if (!answer || (q.answer?.source !== 'manual' && q.imported?.answer_key?.correct?.length !== 1)) return undefined;
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
} = {}): Promise<string[]> {
  // A rerun never carries a stale explanation forward if generation is unavailable or fails.
  for (const q of doc.questions) delete q.explanation;
  const provider = localProviderFor(settings, 'read');
  if (!provider) return ['Explanation generation not run — no local generative read provider configured.', `explanations: 0 of ${doc.questions.filter(q => explanationKey(q)).length} keyed questions`];
  const decide = settings.roleMapping.decide;
  const decisionProvider = decide && settings.providers.find(p => p.id === decide.providerId);
  if (decide && decide.model === provider.model && (decide.providerId === provider.id || (decisionProvider?.baseURL && decisionProvider.baseURL.replace(/\/+$/, '') === provider.baseURL.replace(/\/+$/, '')))) return ['Explanation generation not run — the read role selects the decision model.', `explanations: 0 of ${doc.questions.filter(q => explanationKey(q)).length} keyed questions`];
  const notes: string[] = [];
  const eligible = doc.questions.filter(q => explanationKey(q));
  const system = 'Write student-facing explanations in the exam language. For each keyed question, use only the question, passage and options: explain in one or two sentences why the marked answer is correct and, for multiple choice, briefly why it beats the alternatives. Do not use outside facts or invent answers. Return JSON only: {"corrections":[{"questionNumber":"55A","explanation":"..."}]}. Use the exact label supplied as questionNumber. /no_think';
  const run = async (batch: Question[], section: string) => {
    const text = JSON.stringify({ language: doc.meta.language, section, questions: batch.map(q => ({ number: /^\d+$/.test(q.label) ? q.no : q.label, label: q.label, type: q.type, stem: q.stem, options: q.options?.map(o => ({ key: o.key, text: o.text })), passage: doc.passages?.find(p => p.id === q.passageId)?.text, script: q.imported?.script, answer: explanationKey(q) })) });
    const request: LLMRequest = { role: 'read', system, text, providerConfig: provider, label: `Package explanations · ${section}`, maxOutputTokens: Math.min(8192, Math.max(512, batch.length * 160)) };
    options.onProgress?.(`Explain · ${section}`);
    try {
      const response = await (options.caller || (r => LLMAdapter.execute(r)))(request);
      let value: any = response.json;
      if (response.rawText?.trim()) {
        try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
        catch {
          // Salvage complete JSON objects, never guess truncated explanation text.
          const rows: any[] = []; for (const m of response.rawText.matchAll(/\{[^{}]*\}/g)) { try { rows.push(JSON.parse(m[0])); } catch { /* incomplete object */ } }
          value = { corrections: rows }; notes.push(`Explanation generation returned malformed JSON for ${section}.`);
        }
      }
      const rows = Array.isArray(value?.corrections) ? value.corrections : [];
      const seen = new Set<string>();
      for (const row of rows) {
        const label = String(row?.questionNumber ?? row?.label ?? '');
        if (typeof row?.explanation !== 'string' || !row.explanation.trim() || seen.has(label)) continue;
        const matches = batch.filter(q => q.label === label);
        if (matches.length !== 1) continue;
        seen.add(label); matches[0].explanation = { text: row.explanation.trim(), source: 'model' };
      }
      if (seen.size < batch.length) notes.push(`Explanation generation omitted or returned malformed items in ${section}.`);
      try { await options.onJournal?.({ label: request.label, rawText: response.rawText || JSON.stringify(value), requestText: JSON.stringify({ system, text }) }); } catch { /* best effort */ }
    } catch { notes.push(`Explanation generation failed for ${section}; judging continues.`); }
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
      for (const q of batch.filter(q => !q.explanation)) await run([q], section);
    }
  }
  notes.push(`explanations: ${eligible.filter(q => q.explanation).length} of ${eligible.length} keyed questions`);
  return [...new Set(notes)];
}
