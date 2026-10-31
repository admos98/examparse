/**
 * Follow-up #58 Part A — one canonical reading of "what answer does this question actually have?".
 *
 * The invariant enforced here: a model may PROPOSE an answer, but only a genuine source/keyfile
 * answer or an explicit teacher save is EXECUTABLE. Every export, attention row and enrichment
 * gate must use these helpers instead of reading `q.answer.text` directly, otherwise a legacy
 * `answer.source === 'ai'` value (or `enrichment.proposedAnswer`) can masquerade as a key.
 *
 * Nothing here decides the destination bank's wire shape; `bankContract.ts` owns that and this
 * module only reports the facts (option keys, text blanks, descriptive sample, keyless).
 */
import type { ExamDoc, Question } from '../types';

/** Types the bank/engine grades automatically (a missing key is a defect, not a teacher choice). */
export const AUTO_GRADED_TYPES: ReadonlySet<Question['type']> = new Set<Question['type']>(['mcq', 'truefalse', 'fillblank', 'matching', 'multi', 'numeric']);
/** Descriptive / tashrihi types: no executable key exists; a sample answer + rubric is the contract. */
export const DESCRIPTIVE_TYPES: ReadonlySet<Question['type']> = new Set<Question['type']>(['short', 'long', 'essay']);

/** Where an answer's authority comes from. `ai` is deliberately NOT an authority. */
export type AnswerProvenance = 'paper' | 'keyfile' | 'manual' | 'teacher' | 'ai';

export function answerProvenance(q: Question): AnswerProvenance | undefined {
  const source = q.answer?.source;
  if (!source) return undefined;
  return source as AnswerProvenance;
}

/** A source/keyfile/teacher answer: the ONLY kind that may populate an executable field. */
export function isExecutableSourceAnswer(q: Question): boolean {
  const source = q.answer?.source;
  return Boolean(q.answer?.text?.trim()) && source !== undefined && source !== 'ai';
}

/** The answer text an engine may execute, or undefined (keyless / AI proposal / empty). */
export function executableAnswerText(q: Question): string | undefined {
  // A saved teacher correction supersedes imported paper/keyfile history. Other genuine source
  // answers remain executable, but a model answer never is.
  return isExecutableSourceAnswer(q) ? q.answer!.text!.trim() : undefined;
}

/** The value that should be displayed in an answer-key preview (never a model proposal). */
export function answerKeyDisplayText(q: Question): string | undefined {
  const answer = executableAnswerText(q);
  if (answer) return answer;
  const imported = q.imported as Record<string, unknown> | undefined;
  const correct = (imported?.answer_key as { correct?: unknown } | undefined)?.correct;
  if (Array.isArray(correct)) return correct.map(String).join(', ') || undefined;
  const blanks = imported?.correctFillBlanks ?? imported?.correct_fill_blanks;
  if (Array.isArray(blanks)) return blanks.map(value => Array.isArray(value) ? value.join(' / ') : String(value)).join(' | ') || undefined;
  return undefined;
}

/**
 * Does the SOURCE supply an answer for this item at all? Covers the plain answer object, an
 * imported `answer_key.correct`, and an imported executable `correctFillBlanks`. This is the
 * honest "is it keyed?" question — separate from "can the destination represent it?".
 */
export function hasSourceKey(q: Question): boolean {
  if (isExecutableSourceAnswer(q)) return true;
  const imported = q.imported as Record<string, unknown> | undefined;
  const correct = (imported?.answer_key as { correct?: unknown } | undefined)?.correct;
  if (Array.isArray(correct) && correct.some(value => typeof value === 'string' && value.trim())) return true;
  const blanks = imported?.correctFillBlanks ?? imported?.correct_fill_blanks;
  if (Array.isArray(blanks) && asStringArray(blanks).length) return true;
  return false;
}

/** A model proposal kept in the review payload only (never executable). */
export function proposalText(q: Question): string | undefined {
  const proposed = q.enrichment?.proposedAnswer;
  if (proposed?.adopted) return undefined; // adopted means the teacher saved their own key
  return proposed?.text?.trim() || undefined;
}

/** Whether the teacher has explicitly saved an answer (manual source, not a legacy AI value). */
export function hasTeacherAnswer(q: Question): boolean {
  return q.answer?.source === 'manual' && Boolean(q.answer.text?.trim());
}

export interface BlankAnswer {
  /** Accepted spellings for ONE blank. A single entry means exactly one accepted answer. */
  accept: string[];
}

export type BankAnswerPlan =
  | { kind: 'option-key'; correct: string[]; optionKeys: string[]; source: AnswerProvenance }
  | { kind: 'true-false'; value: boolean; source: AnswerProvenance }
  | { kind: 'text-blanks'; blanks: BlankAnswer[]; source: AnswerProvenance; ambiguity?: string }
  | { kind: 'descriptive'; text: string; source: AnswerProvenance }
  | { kind: 'keyless'; reason: string; proposal?: string };

/** Strip decorative quoting/brackets used by printed keys without changing the value itself. */
export function cleanAnswerValue(value: string): string {
  return value.trim().replace(/^[([{‘“"'\s]+|[)\]}’”"'\s]+$/g, '');
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => (Array.isArray(item) ? asStringArray(item) : typeof item === 'string' && item.trim() ? [item.trim()] : []));
}

/**
 * Read explicitly supplied fill-in-the-blank answers without collapsing or inventing equivalences.
 *
 * Priority: `correctFillBlanks` (the bank's own executable array form) → `answer_key.correct`
 * (a single element = one blank; several elements are preserved verbatim and flagged ambiguous
 * because the package did not say whether they are separate blanks or alternatives).
 */
export function readFillBlankBlanks(q: Question): { blanks: BlankAnswer[]; ambiguity?: string } | undefined {
  // Explicit teacher save is the current key; retain it as the single entered answer rather than
  // silently preferring the imported source history.
  if (q.answer?.source === 'manual' && q.answer.text?.trim()) return { blanks: [{ accept: [cleanAnswerValue(q.answer.text)] }] };
  const imported = q.imported as Record<string, unknown> | undefined;
  const correctFillBlanks = imported?.correctFillBlanks ?? imported?.correct_fill_blanks;
  if (Array.isArray(correctFillBlanks) && correctFillBlanks.length) {
    const blanks: BlankAnswer[] = correctFillBlanks
      .map(entry => {
        if (Array.isArray(entry)) return { accept: asStringArray(entry) };
        if (entry && typeof entry === 'object' && Array.isArray((entry as { accept?: unknown }).accept)) {
          return { accept: asStringArray((entry as { accept: unknown }).accept) };
        }
        const single = asStringArray(entry);
        return single.length ? { accept: single } : undefined;
      })
      .filter((blank): blank is BlankAnswer => Boolean(blank?.accept.length));
    if (blanks.length) return { blanks };
  }
  const keyCorrect = asStringArray((imported?.answer_key as { correct?: unknown } | undefined)?.correct);
  if (keyCorrect.length > 1) return { blanks: keyCorrect.map(value => ({ accept: [value] })), ambiguity: 'several source values were supplied; blanks vs alternatives was not stated by the package' };
  if (keyCorrect.length === 1) return { blanks: [{ accept: [keyCorrect[0]] }] };
  const text = executableAnswerText(q);
  if (text) return { blanks: [{ accept: [text] }] };
  return undefined;
}

const TRUE_VALUES = new Set(['true', 't', 'yes', 'y', '1', 'درست', 'صحیح', 'بله']);
const FALSE_VALUES = new Set(['false', 'f', 'no', 'n', '0', 'غلط', 'نادرست', 'خیر']);

export function parseTrueFalse(value: string): boolean | undefined {
  const normalized = cleanAnswerValue(value).toLocaleLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function normalizeOption(value: string): string {
  return cleanAnswerValue(value).toLocaleLowerCase().replace(/\s+/g, ' ');
}

/**
 * Map one source answer onto the question's own option list. Returns a single bank option index
 * (1-based, as Appendix A expects) only when the mapping is unambiguous.
 */
export function optionIndexFor(q: Question, value: string): string | undefined {
  const options = q.options || [];
  if (!options.length) return undefined;
  const target = normalizeOption(value);
  if (!target) return undefined;
  const matches = options
    .map((option, index) => ({ index, key: normalizeOption(option.key), text: option.text ? normalizeOption(option.text) : '' }))
    .filter(option => option.key === target || (option.text && option.text === target));
  if (matches.length === 1) return String(matches[0].index + 1);
  if (matches.length > 1) return undefined;
  // A bare Latin letter may identify an ordered option even when stored keys are numeric (or vice versa).
  if (/^[a-z]$/i.test(target)) {
    const letterIndex = target.toUpperCase().charCodeAt(0) - 65;
    if (letterIndex < options.length) return String(letterIndex + 1);
  }
  if (/^\d+$/.test(target)) {
    const numeric = Number(target);
    if (numeric >= 1 && numeric <= options.length && options.every(option => /^\d+$/.test(option.key))) return String(numeric);
  }
  return undefined;
}

/**
 * A general semantic type conflict: the source label says short answer but the task asks for a
 * paragraph/essay. The source classification is PRESERVED and the suggestion is surfaced; nothing
 * is silently rewritten by a blanket rule.
 */
export function typeSuggestion(q: Question): 'long_answer' | undefined {
  if (q.type !== 'short') return undefined;
  const text = `${q.stem || ''} ${q.imported?.instructions || ''}`;
  return /\b(?:write|compose|produce)\s+(?:a|one|two|three|an?\s+\w+)\s+(?:short\s+)?paragraphs?\b|\bwrite\s+an?\s+(?:short\s+)?essay\b|پاراگراف|بند\s*(?:نویسی|بنویس)/i.test(text)
    ? 'long_answer'
    : undefined;
}

/** All option indices for a multi-key answer (only when every value maps unambiguously). */
export function optionIndicesFor(q: Question, values: string[]): string[] | undefined {
  const mapped = values.map(value => optionIndexFor(q, value));
  return mapped.every(Boolean) ? (mapped as string[]) : undefined;
}

/**
 * The factual answer plan for one question. Never reads a model proposal as an answer.
 */
export function planBankAnswer(q: Question): BankAnswerPlan {
  const raw = answerProvenance(q);
  // A plan's provenance is an authority label; 'ai' can never be one.
  const source: AnswerProvenance | undefined = raw && raw !== 'ai' ? raw : undefined;
  if (q.type === 'matching' && !(q.options || []).length) {
    return { kind: 'keyless', reason: 'matching item has no options of its own (shared pool or parent-owned key)' };
  }
  if (q.subQuestions?.length) {
    return { kind: 'keyless', reason: 'parent question is answered by its sub-questions' };
  }
  if (DESCRIPTIVE_TYPES.has(q.type)) {
    const sampleSource = q.sampleAnswer?.source;
    const sampleText = q.sampleAnswer?.text?.trim();
    const text = executableAnswerText(q) || (sampleText && sampleSource && sampleSource !== 'model' ? sampleText : undefined);
    const descriptiveSource = source || (sampleSource && sampleSource !== 'model' ? sampleSource as AnswerProvenance : undefined);
    if (text && descriptiveSource) return { kind: 'descriptive', text, source: descriptiveSource };
    return { kind: 'keyless', reason: 'descriptive item has no source sample answer', ...(proposalText(q) ? { proposal: proposalText(q) } : {}) };
  }
  if (q.type === 'fillblank') {
    const read = readFillBlankBlanks(q);
    if (read) {
      const importedFlags = source ? [] : [];
      void importedFlags;
      return { kind: 'text-blanks', ...read, source: source || 'paper' };
    }
    return { kind: 'keyless', reason: 'no source answer key was supplied', ...(proposalText(q) ? { proposal: proposalText(q) } : {}) };
  }
  if (q.type === 'truefalse' && !(q.options || []).length) {
    const text = executableAnswerText(q);
    const value = text ? parseTrueFalse(text) : undefined;
    if (text && value !== undefined) return { kind: 'true-false', value, source: source! };
    return { kind: 'keyless', reason: text ? 'true/false value could not be read from the source answer' : 'no source answer key was supplied', ...(proposalText(q) ? { proposal: proposalText(q) } : {}) };
  }
  if (AUTO_GRADED_TYPES.has(q.type)) {
    // Prefer the richest explicit source: every imported correct value, else the single answer text.
    const importedCorrect = q.answer?.source === 'manual' ? [] : asStringArray((q.imported?.answer_key as { correct?: unknown } | undefined)?.correct);
    const text = executableAnswerText(q);
    const values = text && q.answer?.source === 'manual' ? [text] : importedCorrect.length ? importedCorrect : text ? [text] : [];
    if (values.length) {
      const mapped = optionIndicesFor(q, values);
      if (mapped) return { kind: 'option-key', correct: mapped, optionKeys: (q.options || []).map(option => option.key), source: source || (importedCorrect.length ? 'paper' : 'manual') };
      return { kind: 'keyless', reason: 'source answer cannot be represented as an option key', ...(proposalText(q) ? { proposal: proposalText(q) } : {}) };
    }
    return { kind: 'keyless', reason: 'no source answer key was supplied', ...(proposalText(q) ? { proposal: proposalText(q) } : {}) };
  }
  // Unknown/numeric/diagram types: preserve a source answer as text, never invent an option key.
  const text = executableAnswerText(q);
  if (text) return { kind: 'descriptive', text, source: source! };
  return { kind: 'keyless', reason: 'no source answer key was supplied', ...(proposalText(q) ? { proposal: proposalText(q) } : {}) };
}

/**
 * Migrate legacy `answer.source: 'ai'` values in place (non-destructively):
 * the user's AI-Solve text stays on the question as an explicit NON-executable proposal, and an
 * auto-graded item keeps looking keyless so `answer_key_needs_review` survives.
 */
export function migrateLegacyAiAnswers(doc: ExamDoc): ExamDoc {
  for (const q of doc.questions || []) {
    if (q.answer?.source !== 'ai') continue;
    const text = q.answer.text?.trim();
    if (text && !q.enrichment?.proposedAnswer) {
      q.enrichment = {
        source: 'model', verification: 'unjudged', ...q.enrichment,
        proposedAnswer: { text, source: 'model' },
      };
    }
    const imported = q.imported as Record<string, unknown> | undefined;
    const correct = (imported?.answer_key as { correct?: unknown } | undefined)?.correct;
    const recoverable = AUTO_GRADED_TYPES.has(q.type) && Array.isArray(correct)
      ? correct.map(String).filter(value => value.trim()) : [];
    if (recoverable.length) {
      q.answer = { text: recoverable.join(', '), source: 'paper' };
      if (imported?.answer_key && typeof imported.answer_key === 'object') {
        (imported.answer_key as Record<string, unknown>).source = 'paper';
      }
    } else {
      delete q.answer;
      if (!q.imported) q.imported = {};
      q.imported.legacyAiAnswerSourceLost = Boolean(text);
    }
  }
  return doc;
}
