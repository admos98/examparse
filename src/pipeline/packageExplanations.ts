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
  if (!provider) return ['Explanation generation not run — no local generative read provider configured.'];
  const decide = settings.roleMapping.decide;
  const decisionProvider = decide && settings.providers.find(p => p.id === decide.providerId);
  if (decide && decide.model === provider.model && (decide.providerId === provider.id || (decisionProvider?.baseURL && decisionProvider.baseURL.replace(/\/+$/, '') === provider.baseURL.replace(/\/+$/, '')))) return ['Explanation generation not run — the read role selects the decision model.'];
  const notes: string[] = [];
  const sectionIds = [...new Set(doc.questions.map(q => q.sectionId))];
  for (const sectionId of sectionIds) {
    const eligible = doc.questions.filter(q => q.sectionId === sectionId && explanationKey(q));
    if (!eligible.length) continue;
    // Question numbers must uniquely identify a correction within a section.
    const counts = new Map<number, number>(); for (const q of eligible) counts.set(q.no, (counts.get(q.no) || 0) + 1);
    const unique = eligible.filter(q => counts.get(q.no) === 1);
    if (unique.length !== eligible.length) notes.push('Explanation generation skipped ambiguous duplicate question numbers.');
    if (!unique.length) continue;
    const section = doc.sections.find(s => s.id === sectionId)?.title || 'Section';
    const system = 'Write student-facing explanations in the exam language. For each keyed question, use only the question, passage and options: explain in one or two sentences why the marked answer is correct and, for multiple choice, briefly why it beats the alternatives. Do not use outside facts or invent answers. Return JSON only: {"corrections":[{"questionNumber":1,"explanation":"..."}]}. /no_think';
    const text = JSON.stringify({ language: doc.meta.language, section, questions: unique.map(q => ({ number: q.no, type: q.type, stem: q.stem, options: q.options?.map(o => ({ key: o.key, text: o.text })), passage: doc.passages?.find(p => p.id === q.passageId)?.text, answer: explanationKey(q) })) });
    const request: LLMRequest = { role: 'read', system, text, providerConfig: provider, label: `Package explanations · ${section}`, maxOutputTokens: Math.min(8192, Math.max(512, unique.length * 160)) };
    options.onProgress?.(`Explain · ${section}`);
    try {
      const response = await (options.caller || (r => LLMAdapter.execute(r)))(request);
      let value: any = response.json;
      if (response.rawText?.trim()) {
        try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
        catch { notes.push(`Explanation generation returned invalid JSON for ${section}.`); continue; }
      }
      const rows = value && typeof value === 'object' ? value.corrections : undefined;
      if (!Array.isArray(rows)) { notes.push(`Explanation generation returned no corrections for ${section}.`); continue; }
      const seen = new Set<number>();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || !Number.isInteger(row.questionNumber) || typeof row.explanation !== 'string' || !row.explanation.trim() || seen.has(row.questionNumber)) continue;
        const q = unique.find(q => q.no === row.questionNumber); if (!q) continue;
        seen.add(row.questionNumber); q.explanation = { text: row.explanation.trim(), source: 'model' };
      }
      if (seen.size < unique.length) notes.push(`Explanation generation omitted or returned malformed items in ${section}.`);
      try { await options.onJournal?.({ label: request.label, rawText: response.rawText || JSON.stringify(value), requestText: JSON.stringify({ system, text }) }); } catch { /* best effort */ }
    } catch { notes.push(`Explanation generation failed for ${section}; judging continues.`); }
  }
  return notes;
}
