/**
 * Optional Stage 2.75 text repair. The model proposes overlays only; deterministic
 * code enforces every fence and never mutates SourceLine.text.
 */
import type { ExamDoc, Flag, LineSpan, Question, SourceLine } from '../types';
import { assembleAndValidateQuestions, assembleAndValidateSections, sliceSourceSpans } from './assemble';
import { enumerateExpectedQuestionNos, normalizeForMatching, normalizeStoredText, computeLineQuality } from './quality';
import { segmentDocument } from './segment';
import { isOffsetSpan } from './spans';
import { answerTextForSpans } from './answerKey';
import { sha256 } from '../utils/hash';
import { TEXT_REPAIR_SYSTEM, TEXT_REPAIR_VERSION } from './prompts';

export interface TextRepairCandidate {
  lineNo: number;
  text: string;
  reasons: string[];
}

export interface TextRepairProposal {
  lineNo: number;
  text: string;
}

export interface TextRepairResponse {
  json?: unknown;
  rawText?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
}

export type TextRepairCacheEntry =
  | { outcome: 'repaired'; text: string }
  | { outcome: 'rejected'; reasons: string[] }
  | { outcome: 'unchanged' };

export interface TextRepairCache {
  get(key: string): Promise<TextRepairCacheEntry | undefined>;
  set(key: string, value: TextRepairCacheEntry): Promise<void>;
}

export interface TextRepairStats {
  status: 'disabled' | 'no-candidates' | 'unavailable' | 'cached' | 'completed' | 'completed-with-problems';
  candidates: number;
  repaired: number;
  rejected: number;
  unchanged: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedLines: number;
  /** Number of accepted overlays explicitly removed by the user in review. */
  reverted?: number;
  rejectionReasons: Record<string, number>;
  skippedReason?: string;
}

export interface TextRepairResult {
  lineRepairs: Record<string, string>;
  flags: Flag[];
  stats: TextRepairStats;
}

export type TextRepairCaller = (request: {
  system: string;
  text: string;
  label: string;
  maxOutputTokens: number;
}) => Promise<TextRepairResponse>;

function lineNo(line: SourceLine): number {
  return Number(String(line.id).replace(/\D/g, '')) || 0;
}

function scriptCounts(text: string): { arabic: number; latin: number; letters: number } {
  let arabic = 0;
  let latin = 0;
  for (const char of normalizeStoredText(text)) {
    if (/\p{Script=Arabic}/u.test(char) && /\p{Letter}/u.test(char)) arabic++;
    else if (/\p{Script=Latin}/u.test(char) && /\p{Letter}/u.test(char)) latin++;
  }
  return { arabic, latin, letters: arabic + latin };
}

/** Conservative, deterministic suspicion signals; key and running-furniture lines are never sent. */
export function collectTextRepairCandidates(lines: SourceLine[], keyLines: Set<number> | number[] = []): TextRepairCandidate[] {
  const keys = keyLines instanceof Set ? keyLines : new Set(keyLines);
  const normalizedLines = lines.map(line => ({ ...line, text: normalizeStoredText(line.text) }));
  const qualityByLine = new Map(computeLineQuality(normalizedLines).map(item => [item.line, item]));
  const candidates: TextRepairCandidate[] = [];

  for (const line of lines) {
    const n = lineNo(line);
    if (n <= 0 || keys.has(n) || line.tag === 'key' || line.furniture || line.tag === 'furniture' || line.tag === 'pagenum' || line.tag === 'junk') continue;
    const text = normalizeStoredText(line.text);
    if (!text.trim()) continue;
    const reasons: string[] = [];
    const quality = qualityByLine.get(n);
    const counts = scriptCounts(text);
    const compact = text.replace(/[\s\u200c\u200d\u064b-\u065f\u0670]/gu, '');
    const maxArabicRun = Math.max(0, ...[...compact.matchAll(/\p{Script=Arabic}{1,}/gu)].map(match => match[0].length));
    const mixedRatio = counts.letters > 0 ? Math.min(counts.arabic, counts.latin) / counts.letters : 0;

    if (line.garbled) reasons.push('extraction-garbled');
    if ((quality?.score ?? 100) < 70) reasons.push('low-readability');
    if (maxArabicRun >= 18) reasons.push('fused-arabic-run');
    if (/[\p{Script=Arabic}]\d|\d[\p{Script=Arabic}]/u.test(text)) reasons.push('script-digit-glue');
    if (counts.arabic >= 8 && counts.latin >= 5 && mixedRatio >= 0.12 && text.length >= 28) reasons.push('mixed-script-run');
    if (line.layoutWarning && /ambiguous|legacy.order/i.test(line.layoutWarning)) reasons.push('layout-order-warning');
    if (reasons.length) candidates.push({ lineNo: n, text: line.text, reasons: [...new Set(reasons)] });
  }
  return candidates;
}

function digitMultiset(text: string): string[] {
  return [...normalizeForMatching(text).matchAll(/[0-9]/g)].map(match => match[0]).sort();
}

function latinTokens(text: string): string[] {
  return [...text.normalize('NFKC').matchAll(/\p{Script=Latin}+(?:['’ʼ][\p{Script=Latin}]+)*(?:-[\p{Script=Latin}]+)*/gu)]
    .map(match => match[0].toLocaleLowerCase('en'));
}

function latinIslandSlices(text: string): string[] {
  const tokens = [...text.normalize('NFKC').matchAll(/\p{Script=Latin}+(?:['’ʼ][\p{Script=Latin}]+)*(?:-[\p{Script=Latin}]+)*/gu)]
    .map(match => ({ text: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
  const islands: string[] = [];
  let first: (typeof tokens)[number] | undefined;
  let last: (typeof tokens)[number] | undefined;
  const finish = () => {
    if (first && last) islands.push(text.normalize('NFKC').slice(first.start, last.end));
    first = undefined;
    last = undefined;
  };
  for (const token of tokens) {
    const between = last ? text.normalize('NFKC').slice(last.end, token.start) : '';
    if (!last || !/[\p{Script=Arabic}\d\n\r]/u.test(between)) {
      first ||= token;
      last = token;
    } else {
      finish();
      first = token;
      last = token;
    }
  }
  finish();
  return islands;
}

function printedNumberTokens(text: string): string[] {
  const value = normalizeForMatching(text);
  const tokens: string[] = [];
  const re = /(?:^|\s)(?:\((\d{1,3})\)|(\d{1,3})\s*([.)]|[-:])(?=\s|$))/gu;
  for (const match of value.matchAll(re)) tokens.push(`${match[1] || match[2]}${match[3] || ')'}`);
  // Numbered cloze blanks such as "9 ……" are also printed anchors.
  for (const match of value.matchAll(/(?:^|\s)(\d{1,3})(?=\s*(?:\.{2,}|…+|_{2,}))/gu)) tokens.push(`blank:${match[1]}`);
  return tokens;
}

function normalizedLength(text: string): number {
  return normalizeForMatching(text).replace(/\s+/g, ' ').trim().length;
}

function arabicRatio(text: string): number {
  const counts = scriptCounts(text);
  return counts.letters ? counts.arabic / counts.letters : 0;
}

/** Reasons returned here are stable machine labels so the fence breakdown can be reported. */
export function textRepairRejectionReasons(original: string, proposed: string): string[] {
  const reasons: string[] = [];
  if (JSON.stringify(digitMultiset(original)) !== JSON.stringify(digitMultiset(proposed))) reasons.push('digit multiset changed');
  if (JSON.stringify(latinTokens(original)) !== JSON.stringify(latinTokens(proposed))) reasons.push('Latin token multiset changed');
  const originalIslands = latinIslandSlices(original);
  const proposedIslands = latinIslandSlices(proposed);
  if (JSON.stringify(originalIslands) !== JSON.stringify(proposedIslands)) reasons.push('Latin island changed');
  if (JSON.stringify(printedNumberTokens(original)) !== JSON.stringify(printedNumberTokens(proposed))) reasons.push('printed-number token changed');
  const beforeLength = normalizedLength(original);
  const afterLength = normalizedLength(proposed);
  const lengthRatio = beforeLength ? afterLength / beforeLength : (afterLength ? Infinity : 1);
  if (lengthRatio < 0.70 || lengthRatio > 1.45) reasons.push('length ratio outside [0.70,1.45]');
  const beforeArabic = arabicRatio(original);
  const afterArabic = arabicRatio(proposed);
  if (beforeArabic > 0 && afterArabic + 0.001 < beforeArabic) reasons.push('Arabic-script ratio decreased');
  return reasons;
}

function parseJson(rawText?: string): unknown {
  if (!rawText?.trim()) return undefined;
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { return undefined; }
}

/** Tolerant to the documented {r:[[line,text]]} shape and object-array wire variants. */
export function parseTextRepairProposals(rawText?: string, json?: unknown): TextRepairProposal[] {
  let payload = json ?? parseJson(rawText);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const object = payload as Record<string, unknown>;
    payload = object.r ?? object.repairs ?? object.items;
  }
  if (!Array.isArray(payload)) return [];
  const out: TextRepairProposal[] = [];
  for (const row of payload) {
    if (Array.isArray(row) && row.length >= 2) {
      const n = typeof row[0] === 'string' ? Number(row[0].replace(/\D/g, '')) : Number(row[0]);
      if (Number.isInteger(n) && n > 0 && typeof row[1] === 'string') out.push({ lineNo: n, text: row[1] });
      continue;
    }
    if (row && typeof row === 'object') {
      const item = row as Record<string, unknown>;
      const rawNo = item.n ?? item.lineNo ?? item.line;
      const n = typeof rawNo === 'string' ? Number(rawNo.replace(/\D/g, '')) : Number(rawNo);
      const text = item.t ?? item.text;
      if (Number.isInteger(n) && n > 0 && typeof text === 'string') out.push({ lineNo: n, text });
    }
  }
  return out;
}

export async function textRepairCacheKey(text: string, provider: string, model: string): Promise<string> {
  const contentHash = await sha256(`${TEXT_REPAIR_VERSION}\n${text}`);
  const modelHash = await sha256(`${provider}\n${model}\n${TEXT_REPAIR_VERSION}`);
  return `text-repair-line:${modelHash}:${contentHash}`;
}

function proposalPrompt(candidates: TextRepairCandidate[]): string {
  const rows = candidates.map(candidate => [candidate.lineNo, candidate.text, candidate.reasons.join(',')]);
  return `Repair candidates [lineNumber, originalText, localSignals]:\n${JSON.stringify(rows)}\nReturn {"r":[[lineNumber,"candidate text"],...]} only.`;
}

function emptyStats(status: TextRepairStats['status'], candidates = 0, skippedReason?: string): TextRepairStats {
  return {
    status, candidates, repaired: 0, rejected: 0, unchanged: 0, calls: 0,
    inputTokens: 0, outputTokens: 0, cachedLines: 0, rejectionReasons: {},
    ...(skippedReason ? { skippedReason } : {}),
  };
}

function addOutcome(result: TextRepairResult, candidate: TextRepairCandidate, entry: TextRepairCacheEntry): void {
  if (entry.outcome === 'repaired') {
    result.lineRepairs[String(candidate.lineNo)] = entry.text;
    result.stats.repaired++;
    result.flags.push({
      id: `flag_TEXT_REPAIR_APPLIED_L${candidate.lineNo}`,
      severity: 'info',
      code: 'TEXT_REPAIR_APPLIED',
      message: `Stage 2.75 applied a fenced readability overlay to L${String(candidate.lineNo).padStart(4, '0')}; stored source text remains unchanged.`,
    });
    return;
  }
  if (entry.outcome === 'rejected') {
    result.stats.rejected++;
    for (const reason of entry.reasons) result.stats.rejectionReasons[reason] = (result.stats.rejectionReasons[reason] || 0) + 1;
    result.flags.push({
      id: `flag_TEXT_REPAIR_REJECTED_L${candidate.lineNo}`,
      severity: 'warn',
      code: 'TEXT_REPAIR_REJECTED',
      message: `Stage 2.75 rejected L${String(candidate.lineNo).padStart(4, '0')} (${entry.reasons.join('; ')}); original retained.`,
    });
    return;
  }
  result.stats.unchanged++;
}

export async function runTextRepairStage(params: {
  lines: SourceLine[];
  keyLines?: Set<number> | number[];
  enabled: boolean;
  provider?: string;
  model?: string;
  caller?: TextRepairCaller;
  cache?: TextRepairCache;
  force?: boolean;
  maxOutputTokens?: number;
}): Promise<TextRepairResult> {
  const candidates = collectTextRepairCandidates(params.lines, params.keyLines || []);
  const result: TextRepairResult = {
    lineRepairs: {},
    flags: [],
    stats: emptyStats('disabled', candidates.length, 'disabled in Settings'),
  };
  if (!params.enabled) return result;
  if (!candidates.length) {
    result.stats = emptyStats('no-candidates', 0, 'no suspicious non-key lines');
    return result;
  }
  if (!params.caller || !params.provider || !params.model) {
    result.stats = emptyStats('unavailable', candidates.length, 'repair provider unavailable');
    result.flags.push({ id: 'flag_TEXT_REPAIR_SKIPPED', severity: 'info', code: 'TEXT_REPAIR_SKIPPED', message: 'Stage 2.75 skipped because no repair provider is available; parsing continued with original text.' });
    return result;
  }

  const candidateByNo = new Map(candidates.map(candidate => [candidate.lineNo, candidate]));
  const entries = new Map<number, TextRepairCacheEntry>();
  const cacheKeys = new Map<number, string>();
  const misses: TextRepairCandidate[] = [];
  for (const candidate of candidates) {
    const key = await textRepairCacheKey(candidate.text, params.provider, params.model);
    cacheKeys.set(candidate.lineNo, key);
    const cached = !params.force && params.cache ? await params.cache.get(key) : undefined;
    if (cached) {
      entries.set(candidate.lineNo, cached);
      result.stats.cachedLines++;
    } else misses.push(candidate);
  }

  if (misses.length > 0) {
    let response: TextRepairResponse;
    try {
      response = await params.caller({
        system: TEXT_REPAIR_SYSTEM,
        text: proposalPrompt(misses),
        label: `Text repair (${misses.length} candidate line${misses.length === 1 ? '' : 's'})`,
        maxOutputTokens: params.maxOutputTokens || 4096,
      });
    } catch (error) {
      result.stats.status = 'unavailable';
      result.stats.skippedReason = `provider error: ${String((error as Error)?.message || error).slice(0, 160)}`;
      result.flags.push({ id: 'flag_TEXT_REPAIR_SKIPPED', severity: 'info', code: 'TEXT_REPAIR_SKIPPED', message: `Stage 2.75 skipped after provider failure; parsing continued with original text (${result.stats.skippedReason}).` });
      for (const [no, entry] of entries) addOutcome(result, candidateByNo.get(no)!, entry);
      return result;
    }
    result.stats.calls = 1;
    result.stats.inputTokens = Math.max(0, Number(response.usage?.inputTokens) || 0);
    result.stats.outputTokens = Math.max(0, Number(response.usage?.outputTokens) || 0);
    const proposals = parseTextRepairProposals(response.rawText, response.json);
    const proposalByNo = new Map<number, TextRepairProposal>();
    const duplicateNos = new Set<number>();
    for (const proposal of proposals) {
      if (!candidateByNo.has(proposal.lineNo) || !misses.some(item => item.lineNo === proposal.lineNo)) continue;
      if (proposalByNo.has(proposal.lineNo)) duplicateNos.add(proposal.lineNo);
      else proposalByNo.set(proposal.lineNo, proposal);
    }

    for (const candidate of misses) {
      const proposal = proposalByNo.get(candidate.lineNo);
      let entry: TextRepairCacheEntry = { outcome: 'unchanged' };
      if (proposal && proposal.text !== candidate.text && !duplicateNos.has(candidate.lineNo)) {
        const reasons = textRepairRejectionReasons(candidate.text, proposal.text);
        if (reasons.length) entry = { outcome: 'rejected', reasons };
        else entry = { outcome: 'repaired', text: proposal.text };
      } else if (duplicateNos.has(candidate.lineNo)) {
        entry = { outcome: 'rejected', reasons: ['duplicate model proposal'] };
      }
      entries.set(candidate.lineNo, entry);
      const key = cacheKeys.get(candidate.lineNo);
      if (key && params.cache) await params.cache.set(key, entry);
    }
  }

  for (const candidate of candidates) {
    const entry = entries.get(candidate.lineNo);
    if (entry) addOutcome(result, candidate, entry);
  }
  if (result.stats.calls === 0 && result.stats.cachedLines === candidates.length) result.stats.status = 'cached';
  else result.stats.status = result.stats.rejected > 0 ? 'completed-with-problems' : 'completed';
  return result;
}

/** Return fresh line objects with overlays applied; the input array and its line text stay untouched. */
export function applyTextRepairOverlay(lines: SourceLine[], lineRepairs?: Record<string, string>): SourceLine[] {
  if (!lineRepairs || !Object.keys(lineRepairs).length) return lines;
  return lines.map(line => {
    const repaired = lineRepairs[String(lineNo(line))];
    return typeof repaired === 'string' ? { ...line, text: repaired } : line;
  });
}

/** Remove selected overlays and deterministically re-slice dependent question/section text. */
export function revertTextRepairOverlays(doc: ExamDoc, selectedLineNos?: number[]): ExamDoc {
  const current = doc.source.lineRepairs || {};
  const selected = selectedLineNos ? new Set(selectedLineNos.map(String)) : undefined;
  const removed = Object.keys(current).filter(key => !selected || selected.has(key));
  if (!removed.length) return doc;

  const lineRepairs = { ...current };
  for (const key of removed) delete lineRepairs[key];
  const lines = applyTextRepairOverlay(doc.source.lines, lineRepairs);
  const keyLines = new Set(doc.source.keyTerritoryLineNos || enumerateExpectedQuestionNos(doc.source.lines).keyTerritory.lineNos);
  const segmentReceipts = segmentDocument({ lines, keyLines }).segments;
  const toLineSpans = (spans: LineSpan[] | undefined): LineSpan[] => (spans || []).map(span =>
    isOffsetSpan(span) ? [span.line, span.line] as [number, number] : [span[0], span[1]] as [number, number],
  );
  const rawQuestions = doc.questions.map(question => ({
    id: question.id,
    label: question.label,
    no: question.no,
    parentId: question.parentId,
    sectionId: question.sectionId,
    spans: toLineSpans(question.spans),
    points: question.points,
    type: question.type,
    options: question.options?.map(option => ({ key: option.key, spans: toLineSpans(option.spans) })),
    answer: question.answer?.spans ? { spans: toLineSpans(question.answer.spans) } : undefined,
    tables: question.tables?.map(table => ({ spans: toLineSpans(table.spans) })),
    rewrites: question.rewrites,
    images: question.images,
    confidence: question.confidence,
    flags: question.flags,
  }));
  const assembled = assembleAndValidateQuestions(rawQuestions, lines, doc.meta.totalPoints, {
    keyTerritoryLineNos: [...keyLines],
    imageIds: doc.images.map(image => image.id),
    sections: doc.sections,
    gapCompletion: false,
    segmentReceipts,
    semanticErrorsToRepair: false,
  });
  const oldById = new Map(doc.questions.map(question => [question.id, question]));
  const questions: Question[] = assembled.questions.map(question => {
    const old = oldById.get(question.id);
    if (!old) return question;
    const options = question.options?.map(option => ({
      ...option,
      text: option.spans.length ? sliceSourceSpans(option.spans, lines, old.rewrites) : option.text,
    }));
    return {
      ...question,
      points: old.points,
      confidence: old.confidence,
      images: old.images,
      options,
      answer: old.answer?.source !== 'paper'
        ? old.answer
        : question.answer?.spans?.length
          ? { ...question.answer, text: answerTextForSpans(question.answer.spans, lines) }
          : old.answer,
      flags: [...new Set([...(old.flags || []), ...(question.flags || [])])],
    };
  });
  // Preserve any manually accepted legacy question not emitted by the deterministic segmenter.
  for (const old of doc.questions) if (!questions.some(question => question.id === old.id)) questions.push(old);

  const sectionInputs = doc.sections.map(section => ({ ...section, instructions: undefined, passage: undefined }));
  const rebuiltSections = assembleAndValidateSections(sectionInputs, lines, questions, keyLines);
  const oldSections = new Map(doc.sections.map(section => [section.id, section]));
  const sections = rebuiltSections.sections.map(section => {
    const old = oldSections.get(section.id);
    return old ? { ...section, points: section.points ?? old.points } : section;
  });
  const removedNos = new Set(removed.map(Number));
  const flags = doc.flags.filter(flag => {
    if (flag.code !== 'TEXT_REPAIR_APPLIED') return true;
    const flaggedLine = Number(flag.id.match(/_L(\d+)$/)?.[1]);
    return !removedNos.has(flaggedLine);
  });
  for (const key of removed) flags.push({
    id: `flag_TEXT_REPAIR_REVERTED_L${key}`,
    severity: 'info',
    code: 'TEXT_REPAIR_REVERTED',
    message: `Stage 2.75 overlay for L${String(Number(key)).padStart(4, '0')} was reverted; dependent text was rebuilt from the stored source line.`,
  });

  return {
    ...doc,
    questions,
    sections,
    flags,
    source: {
      ...doc.source,
      lineRepairs,
      textRepairStats: doc.source.textRepairStats ? {
        ...doc.source.textRepairStats,
        reverted: (doc.source.textRepairStats.reverted || 0) + removed.length,
      } : undefined,
    },
  };
}

export function estimateTextRepairCall(candidates: TextRepairCandidate[]): { calls: number; inputTokens: number; outputTokens: number } {
  if (!candidates.length) return { calls: 0, inputTokens: 0, outputTokens: 0 };
  const inputText = TEXT_REPAIR_SYSTEM + proposalPrompt(candidates);
  return { calls: 1, inputTokens: Math.ceil(inputText.length / 2.8), outputTokens: Math.max(128, Math.ceil(candidates.reduce((sum, candidate) => sum + candidate.text.length, 0) / 1.8)) };
}
