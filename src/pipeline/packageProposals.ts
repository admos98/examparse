/**
 * Follow-up #58 Part A — a candidate answer for a KEYLESS OPTIONLESS fill-in-the-blank.
 *
 * There are no options to name, so the checker cannot "choose"; the existing local generative
 * role writes one candidate in the existing small batch (≤4 items, same section/instruction
 * group). The candidate, its confidence and its check state live ONLY in
 * `enrichment.proposedAnswer` (the review payload). Nothing here can populate `answer`,
 * `answer_key.correct`, `correctFillBlanks` or any other executable field.
 */
import type { AppSettings, ExamDoc, LLMRequest, Question } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { localProviderFor } from './localProvider';
import { salvageJsonObjects } from '../utils/jsonRepair';
import { executableAnswerText, proposalText } from '../utils/bankAnswers';
import { listeningEvidence } from './evidenceBundle';

/** Keyless, optionless blanks — the only items this pass may touch. */
export function candidateItems(doc: ExamDoc): Question[] {
  return (doc.questions || []).filter(question =>
    question.type === 'fillblank'
    && !executableAnswerText(question)
    && !proposalText(question)
    && !(question.options || []).length
    && !question.subQuestions?.length);
}

const SYSTEM = 'Complete each exam blank with the answer the question asks for, in the exam language. Use only the question, its passage and listening script; do not invent facts. Return JSON only: {"candidates":[{"questionNumber":"14","answer":"..."}]}. Use the exact label supplied as questionNumber. /no_think';

export async function generateFillBlankCandidates(doc: ExamDoc, settings: AppSettings, options: {
  caller?: (request: LLMRequest) => Promise<Pick<import('../types').LLMResponse, 'json' | 'rawText'>>;
  onProgress?: (message: string) => void;
  onJournal?: (entry: { label: string; rawText: string; requestText: string }) => Promise<void>;
} = {}): Promise<string[]> {
  const eligible = candidateItems(doc);
  if (!eligible.length) return [];
  const provider = localProviderFor(settings, 'read');
  if (!provider) return [`fill-in-the-blank candidates: 0 of ${eligible.length} proposed — no local generative read provider configured.`];
  const notes: string[] = [];
  // Never mix instruction groups or sections; never more than four items per call.
  const groups = new Map<string, Question[]>();
  for (const question of eligible) {
    const memberships = (doc.instructionGroups || []).map((group, index) => question.no >= group.appliesToFirst && question.no <= group.appliesToLast ? index : -1).filter(index => index >= 0);
    const key = JSON.stringify([question.sectionId, question.imported?.instructions || (memberships.length ? memberships : null)]);
    groups.set(key, [...(groups.get(key) || []), question]);
  }
  for (const questions of groups.values()) {
    const section = doc.sections.find(candidate => candidate.id === questions[0].sectionId)?.title || 'Section';
    for (let index = 0; index < questions.length; index += 4) {
      const batch = questions.slice(index, index + 4);
      const usable = batch.filter(question => !question.images.length && !listeningEvidence(doc, question).listening);
      if (!usable.length) continue;
      const text = JSON.stringify({
        language: doc.meta.language,
        section,
        questions: usable.map(question => ({
          number: /^\d+$/.test(question.label) ? question.no : question.label,
          label: question.label,
          stem: question.stem,
          passage: doc.passages?.find(passage => passage.id === question.passageId)?.text,
          script: question.imported?.script || question.imported?.transcript,
        })),
      });
      const request: LLMRequest = { role: 'read', system: SYSTEM, text, providerConfig: provider, label: `Package blank candidates · ${section}`, maxOutputTokens: Math.min(2048, Math.max(256, usable.length * 120)) };
      options.onProgress?.(`Blank candidates · ${section}`);
      try {
        const response = await (options.caller || ((r: LLMRequest) => LLMAdapter.execute(r)))(request);
        let value: any = response.json;
        if (response.rawText?.trim()) {
          try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); }
          catch { value = { candidates: salvageJsonObjects(response.rawText) }; }
        }
        const rows: any[] = Array.isArray(value?.candidates) ? value.candidates : Array.isArray(value?.corrections) ? value.corrections : [];
        for (const row of rows) {
          const label = String(row?.questionNumber ?? row?.label ?? '');
          const answer = typeof row?.answer === 'string' ? row.answer.trim() : '';
          const matches = usable.filter(question => question.label === label);
          if (matches.length !== 1 || !answer) continue;
          // Review payload only — never an executable field, never marked adopted.
          matches[0].enrichment = {
            ...(matches[0].enrichment || { source: 'model', verification: 'unjudged' }),
            proposedAnswer: { text: answer, source: 'model' },
          };
        }
        try { await options.onJournal?.({ label: request.label, rawText: response.rawText || JSON.stringify(value), requestText: JSON.stringify({ system: SYSTEM, text }) }); } catch { /* journal best effort */ }
      } catch { notes.push(`fill-in-the-blank candidates: one batch call failed in ${section}.`); }
    }
  }
  const proposed = eligible.filter(question => Boolean(proposalText(question))).length;
  notes.push(`fill-in-the-blank candidates: ${proposed} of ${eligible.length} keyless blanks proposed (review only — never an answer key).`);
  return [...new Set(notes)];
}
