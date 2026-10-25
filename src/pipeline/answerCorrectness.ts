/**
 * Godlike Batch 1, Part C — answer CORRECTNESS (anchored → right).
 *
 * C1 (pure local): the key territory's per-item segments form a {no → letter} table sliced
 * from document text. Every mcq/truefalse/matching answer letter must EQUAL the table's;
 * the table wins a mismatch (it is document text), ambiguity becomes ANSWER_CONFLICT.
 * C2 (one batched cheap call, cascaded + cached): short/fill answers whose attached text
 * differs from the key's own text get match/mismatch/key-unclear verdicts. Mismatches are
 * attention items only — answers are document text and are never auto-rewritten here.
 * C3: agreement counts ride the run journal into the scoreboard's answer-accuracy trait.
 */
import type { Flag, LineSpan, Question, SourceLine } from '../types';
import { answerTextForSpans, cleanAnswerText, findAnswerKeySpan, printedAnswerAnchors } from './answerKey';
import { normalizeForMatching } from './quality';
import { sha256 } from '../utils/hash';
import { ANSWER_SPOTCHECK_SYSTEM, ANSWER_SPOTCHECK_VERSION } from './prompts';

function sourceNo(line: SourceLine): number {
  return Number(String(line.id).replace(/\D/g, '')) || 0;
}

const PERSIAN_LETTERS: Record<string, string> = { 'الف': 'a', 'ب': 'b', 'پ': 'c', 'ج': 'c', 'ت': 'd', 'د': 'd' };

/** Canonical latin letter for an option key ('B', '(b)', 'الف', 'ب' → 'a'…'j'). */
export function canonicalLetter(raw: string | undefined): string | undefined {
  const value = normalizeForMatching(raw || '').trim().toLowerCase().replace(/[().:]/g, '').trim();
  if (!value) return undefined;
  if (/^[a-j]$/.test(value)) return value;
  return PERSIAN_LETTERS[value];
}

/**
 * The option letter a piece of answer/key text names, read as a human would:
 * "( b )", "False ( b)", "(a) True", bare "c", a True/False word (via the question's
 * own options), Persian option words, or a text exactly equal to one option's text.
 */
export function parseAnswerLetter(text: string | undefined, question?: Question): string | undefined {
  const raw = (text || '').trim();
  if (!raw) return undefined;
  const value = normalizeForMatching(raw);
  const parenLatin = value.match(/\(\s*([a-jA-J])\s*\)/);
  if (parenLatin) return parenLatin[1].toLowerCase();
  const parenPersian = value.match(/\(\s*(الف|ب|پ|ج|ت|د)\s*\)/);
  if (parenPersian) return PERSIAN_LETTERS[parenPersian[1]];
  const bare = value.trim().match(/^\(?\s*([a-jA-J])\s*[.)]?$/);
  if (bare) return bare[1].toLowerCase();
  const leading = value.trim().match(/^([a-jA-J])\s*[.)]\s/);
  if (leading && raw.length <= 90) return leading[1].toLowerCase();
  const leadingPersian = value.trim().match(/^(الف|ب|پ|ج|ت|د)\s*[.)]/);
  if (leadingPersian) return PERSIAN_LETTERS[leadingPersian[1]];
  if (question?.options?.length) {
    const wanted = value.replace(/\s+/g, ' ').trim();
    // True/False words resolve through the question's own printed options.
    const tf = wanted.match(/^(true|false|صحیح|درست|غلط|نادرست)\b/iu);
    const probes = tf ? [tf[1].toLowerCase(), wanted] : [wanted];
    for (const probe of probes) {
      for (const option of question.options) {
        if (normalizeForMatching(option.text || '').replace(/\s+/g, ' ').trim() === probe) {
          return canonicalLetter(option.key);
        }
      }
    }
  }
  return undefined;
}

export interface KeySegment {
  no: number;
  text: string;
  spans: LineSpan[];
}

/** Every per-item key segment in key territory, sliced at the next printed anchor. */
export function extractKeySegments(lines: SourceLine[], keyLines: Set<number>): Map<number, KeySegment[]> {
  const out = new Map<number, KeySegment[]>();
  const sorted = [...lines].sort((a, b) => sourceNo(a) - sourceNo(b));
  for (const line of sorted) {
    const n = sourceNo(line);
    if (!keyLines.has(n) || line.furniture || line.tag === 'junk') continue;
    const anchors = printedAnswerAnchors(line.text);
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index];
      const next = anchors.slice(index + 1).find(candidate => candidate.start > anchor.bodyStart);
      const end = next?.start ?? line.text.length;
      if (end <= anchor.bodyStart) continue;
      const text = cleanAnswerText(line.text.slice(anchor.bodyStart, end));
      if (!text) continue;
      const segment: KeySegment = { no: anchor.no, text, spans: [{ line: n, start: anchor.bodyStart, end }] };
      out.set(anchor.no, [...(out.get(anchor.no) || []), segment]);
    }
  }
  return out;
}

export interface LetterTable {
  /** no → the one letter every key segment for that item agrees on. */
  table: Map<number, { letter: string; segment: KeySegment }>;
  /** no → conflicting letters (the key itself is ambiguous for this item). */
  ambiguous: Map<number, string[]>;
}

/** C1 table: {no → letter} from sliced key text; disagreements are ambiguity, never a vote. */
export function extractKeyLetterTable(lines: SourceLine[], keyLines: Set<number>, questions: Question[] = []): LetterTable {
  const byNo = new Map<number, Question>();
  for (const question of questions) if (!byNo.has(question.no)) byNo.set(question.no, question);
  const table = new Map<number, { letter: string; segment: KeySegment }>();
  const ambiguous = new Map<number, string[]>();
  for (const [no, segments] of extractKeySegments(lines, keyLines)) {
    const letters = new Map<string, KeySegment>();
    for (const segment of segments) {
      const letter = parseAnswerLetter(segment.text, byNo.get(no));
      if (letter && !letters.has(letter)) letters.set(letter, segment);
    }
    if (letters.size === 1) {
      const [letter, segment] = [...letters.entries()][0];
      table.set(no, { letter, segment });
    } else if (letters.size > 1) {
      ambiguous.set(no, [...letters.keys()].sort());
    }
  }
  return { table, ambiguous };
}

export interface LetterVerificationStats {
  checked: number;
  agreed: number;
  corrected: number;
  conflicts: number;
}

const LETTER_TYPES = new Set(['mcq', 'truefalse', 'matching']);
const DOCUMENT_SOURCES = new Set(['paper', 'keyfile']);

/**
 * C1 — verify every letter answer against the key table. The table (sliced document text)
 * wins a mismatch; the question's answer is re-sliced from the winning key segment.
 * Manual/AI answers are never touched. Input questions are not mutated.
 */
export function verifyLetterAnswers(params: {
  questions: Question[];
  lines: SourceLine[];
  keyLines: Set<number> | number[];
}): { questions: Question[]; flags: Flag[]; stats: LetterVerificationStats; letterTable: LetterTable } {
  const keyLines = params.keyLines instanceof Set ? params.keyLines : new Set(params.keyLines);
  const letterTable = extractKeyLetterTable(params.lines, keyLines, params.questions);
  const flags: Flag[] = [];
  const stats: LetterVerificationStats = { checked: 0, agreed: 0, corrected: 0, conflicts: 0 };
  const questions = params.questions.map(question => {
    if (!LETTER_TYPES.has(question.type)) return question;
    if (!question.answer?.text?.trim() || !DOCUMENT_SOURCES.has(question.answer.source)) return question;
    if (letterTable.ambiguous.has(question.no)) {
      stats.conflicts++;
      const letters = letterTable.ambiguous.get(question.no)!;
      flags.push({
        id: `flag_ANSWER_CONFLICT_${question.id}`,
        severity: 'warn',
        code: 'ANSWER_CONFLICT',
        questionId: question.id,
        rootCauseId: `question_${question.id}`,
        message: `Q${question.no}: the printed key itself gives conflicting answers (${letters.map(letter => `(${letter})`).join(' vs ')}); the attached answer "${question.answer.text.trim().slice(0, 60)}" was left unchanged.`,
      });
      return { ...question, flags: [...new Set([...(question.flags || []), 'ANSWER_CONFLICT'])] };
    }
    const entry = letterTable.table.get(question.no);
    if (!entry) return question;
    const attached = parseAnswerLetter(question.answer.text, question);
    if (!attached) return question;
    stats.checked++;
    if (attached === entry.letter) {
      stats.agreed++;
      return question;
    }
    stats.corrected++;
    flags.push({
      id: `flag_ANSWER_CORRECTED_FROM_KEY_${question.id}`,
      severity: 'info',
      code: 'ANSWER_CORRECTED_FROM_KEY',
      questionId: question.id,
      rootCauseId: `question_${question.id}`,
      message: `Q${question.no}: answer corrected from the printed key — was (${attached}) "${question.answer.text.trim().slice(0, 60)}", key says (${entry.letter}) "${entry.segment.text.slice(0, 60)}".`,
    });
    return {
      ...question,
      answer: { spans: entry.segment.spans, text: entry.segment.text, source: question.answer.source },
      flags: [...new Set([...(question.flags || []), 'ANSWER_CORRECTED_FROM_KEY'])],
    };
  });
  return { questions, flags, stats, letterTable };
}

// ---------------------------------------------------------------------------
// C2 — text-answer spot verification (ONE batched call, cached, silent skip)
// ---------------------------------------------------------------------------

export type SpotVerdict = 'match' | 'mismatch' | 'key-unclear';

export interface AnswerSpotCandidate {
  question: Question;
  attached: string;
  keyText: string;
}

export type AnswerSpotCaller = (request: {
  system: string;
  text: string;
  label: string;
  maxOutputTokens: number;
}) => Promise<{ json?: unknown; rawText?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } }>;

export interface AnswerSpotCache {
  get(key: string): Promise<SpotVerdict | undefined>;
  set(key: string, value: SpotVerdict): Promise<void>;
}

export interface AnswerSpotStats {
  status: 'no-candidates' | 'unavailable' | 'cached' | 'completed';
  candidates: number;
  localMatches: number;
  matches: number;
  mismatches: number;
  unclear: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedVerdicts: number;
  skippedReason?: string;
}

const TEXT_TYPES = new Set(['short', 'fillblank']);
const normText = (value: string): string => normalizeForMatching(value).replace(/\s+/g, ' ').trim().toLowerCase();

/** Short/fill items whose attached answer differs from the key's own text (model candidates). */
export function collectSpotCandidates(params: {
  questions: Question[];
  lines: SourceLine[];
  keyLines: Set<number> | number[];
}): { candidates: AnswerSpotCandidate[]; localMatches: number } {
  const keyLines = params.keyLines instanceof Set ? params.keyLines : new Set(params.keyLines);
  const candidates: AnswerSpotCandidate[] = [];
  let localMatches = 0;
  for (const question of params.questions) {
    if (!TEXT_TYPES.has(question.type)) continue;
    if (!question.answer?.text?.trim() || !DOCUMENT_SOURCES.has(question.answer.source)) continue;
    const spans = findAnswerKeySpan(params.lines, keyLines, question.no);
    if (!spans?.length) continue;
    const keyText = answerTextForSpans(spans, params.lines);
    if (!keyText) continue;
    if (normText(keyText) === normText(question.answer.text)) { localMatches++; continue; }
    candidates.push({ question, attached: question.answer.text.trim(), keyText });
  }
  return { candidates, localMatches };
}

/** Compact wire prompt for the one batched spot-check call. */
export function buildSpotCheckPrompt(candidates: AnswerSpotCandidate[]): string {
  return candidates.map(candidate =>
    `[${candidate.question.no}] Q: ${(candidate.question.stem || '').slice(0, 160)} | A: ${candidate.attached.slice(0, 120)} | K: ${candidate.keyText.slice(0, 120)}`,
  ).join('\n');
}

/** Parse the compact verdict wire {"v":[[no,"m"|"x"|"u"],…]} (tolerant of raw text). */
export function parseSpotVerdicts(json: unknown, rawText?: string): Map<number, SpotVerdict> {
  let data: any = json;
  if (!data && rawText) {
    try { data = JSON.parse(rawText.slice(rawText.indexOf('{'), rawText.lastIndexOf('}') + 1)); } catch { data = undefined; }
  }
  const rows: any[] = Array.isArray(data?.v) ? data.v : Array.isArray(data) ? data : [];
  const out = new Map<number, SpotVerdict>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const no = Number(row[0]);
    if (!Number.isInteger(no)) continue;
    const code = String(row[1]).trim().toLowerCase();
    out.set(no, code === 'm' || code === 'match' ? 'match' : code === 'x' || code === 'mismatch' ? 'mismatch' : 'key-unclear');
  }
  return out;
}

async function spotCacheKey(candidate: AnswerSpotCandidate, provider: string, model: string): Promise<string> {
  return sha256([ANSWER_SPOTCHECK_VERSION, provider, model, candidate.question.stem || '', candidate.attached, candidate.keyText].join('|'));
}

/**
 * C2 — exactly ONE batched call per exam (0 when everything is cached or locally equal).
 * Skipped silently when the fast/local-capable role has no available model. Mismatches
 * become ANSWER_TEXT_MISMATCH attention flags with both texts; answers are never rewritten.
 */
export async function runAnswerSpotChecks(params: {
  questions: Question[];
  lines: SourceLine[];
  keyLines: Set<number> | number[];
  caller?: AnswerSpotCaller;
  provider?: string;
  model?: string;
  cache?: AnswerSpotCache;
  force?: boolean;
  maxOutputTokens?: number;
}): Promise<{ questions: Question[]; flags: Flag[]; stats: AnswerSpotStats }> {
  const { candidates, localMatches } = collectSpotCandidates(params);
  const stats: AnswerSpotStats = {
    status: 'no-candidates', candidates: candidates.length, localMatches,
    matches: 0, mismatches: 0, unclear: 0, calls: 0, inputTokens: 0, outputTokens: 0, cachedVerdicts: 0,
  };
  const flags: Flag[] = [];
  if (!candidates.length) return { questions: params.questions, flags, stats };

  const verdicts = new Map<number, SpotVerdict>();
  const misses: AnswerSpotCandidate[] = [];
  const cacheKeys = new Map<number, string>();
  if (params.provider && params.model) {
    for (const candidate of candidates) {
      const key = await spotCacheKey(candidate, params.provider, params.model);
      cacheKeys.set(candidate.question.no, key);
      const cached = !params.force && params.cache ? await params.cache.get(key).catch(() => undefined) : undefined;
      if (cached) { verdicts.set(candidate.question.no, cached); stats.cachedVerdicts++; }
      else misses.push(candidate);
    }
  } else {
    misses.push(...candidates);
  }

  if (misses.length) {
    if (!params.caller || !params.provider || !params.model) {
      // Silent by contract: no flag, no failure — the parse simply keeps its answers.
      stats.status = 'unavailable';
      stats.skippedReason = 'spot-check model unavailable';
      return { questions: params.questions, flags, stats };
    }
    let response: Awaited<ReturnType<AnswerSpotCaller>>;
    try {
      response = await params.caller({
        system: ANSWER_SPOTCHECK_SYSTEM,
        text: buildSpotCheckPrompt(misses),
        label: `Answer spot-check (${misses.length} item${misses.length === 1 ? '' : 's'})`,
        maxOutputTokens: params.maxOutputTokens || 1024,
      });
    } catch (error) {
      stats.status = 'unavailable';
      stats.skippedReason = `provider error: ${String((error as Error)?.message || error).slice(0, 120)}`;
      return { questions: params.questions, flags, stats };
    }
    stats.calls = 1;
    stats.inputTokens = Math.max(0, Number(response.usage?.inputTokens) || 0);
    stats.outputTokens = Math.max(0, Number(response.usage?.outputTokens) || 0);
    const fresh = parseSpotVerdicts(response.json, response.rawText);
    for (const candidate of misses) {
      const verdict = fresh.get(candidate.question.no) || 'key-unclear';
      verdicts.set(candidate.question.no, verdict);
      const key = cacheKeys.get(candidate.question.no);
      if (key && params.cache) await params.cache.set(key, verdict).catch(() => undefined);
    }
  }

  const byNo = new Map(candidates.map(candidate => [candidate.question.no, candidate]));
  const questions = params.questions.map(question => {
    const verdict = verdicts.get(question.no);
    const candidate = byNo.get(question.no);
    if (!verdict || !candidate || candidate.question.id !== question.id) return question;
    if (verdict === 'match') { stats.matches++; return question; }
    if (verdict === 'key-unclear') { stats.unclear++; return question; }
    stats.mismatches++;
    flags.push({
      id: `flag_ANSWER_TEXT_MISMATCH_${question.id}`,
      severity: 'warn',
      code: 'ANSWER_TEXT_MISMATCH',
      questionId: question.id,
      rootCauseId: `question_${question.id}`,
      message: `Q${question.no}: attached answer "${candidate.attached.slice(0, 100)}" may not match the key's "${candidate.keyText.slice(0, 100)}" (spot-check); the answer was not changed.`,
    });
    return { ...question, flags: [...new Set([...(question.flags || []), 'ANSWER_TEXT_MISMATCH'])] };
  });
  stats.status = stats.calls === 0 && stats.cachedVerdicts === candidates.length ? 'cached' : 'completed';
  return { questions, flags, stats };
}

/** Token estimate for the one C2 call (same chars/token convention as text repair). */
export function estimateAnswerSpotCheck(candidates: AnswerSpotCandidate[]): { calls: number; inputTokens: number; outputTokens: number } {
  if (!candidates.length) return { calls: 0, inputTokens: 0, outputTokens: 0 };
  const inputText = ANSWER_SPOTCHECK_SYSTEM + buildSpotCheckPrompt(candidates);
  return {
    calls: 1,
    inputTokens: Math.ceil(inputText.length / 2.8),
    outputTokens: Math.max(32, candidates.length * 8),
  };
}

/** C1 then C2, in that order (deterministic first; the model only sees what remains). */
export async function runAnswerCorrectness(params: {
  questions: Question[];
  lines: SourceLine[];
  keyLines: Set<number> | number[];
  spotCaller?: AnswerSpotCaller;
  spotProvider?: string;
  spotModel?: string;
  spotCache?: AnswerSpotCache;
  spotForce?: boolean;
  spotMaxOutputTokens?: number;
}): Promise<{
  questions: Question[];
  flags: Flag[];
  letter: LetterVerificationStats;
  spot: AnswerSpotStats;
  /** C3 scoreboard evidence: key-table agreement on this parse. */
  accuracy: LetterVerificationStats;
}> {
  const letterResult = verifyLetterAnswers(params);
  const spotResult = await runAnswerSpotChecks({
    questions: letterResult.questions,
    lines: params.lines,
    keyLines: params.keyLines,
    caller: params.spotCaller,
    provider: params.spotProvider,
    model: params.spotModel,
    cache: params.spotCache,
    force: params.spotForce,
    maxOutputTokens: params.spotMaxOutputTokens,
  });
  return {
    questions: spotResult.questions,
    flags: [...letterResult.flags, ...spotResult.flags],
    letter: letterResult.stats,
    spot: spotResult.stats,
    accuracy: letterResult.stats,
  };
}
