/**
 * STAGE 2.5 — CLEANUP (AI-curated, locally-fenced).
 *
 * Principle: the cleanup model may JUDGE lines; it may never DELETE, EDIT or RENUMBER
 * them. It emits per-line verdicts; deterministic code applies them as TAGS on the
 * line objects. Span indices, stored text and provenance are untouched, so cleanup
 * is fully reversible and auditable. The structure stage receives a CLEAN VIEW
 * (tagged lines annotated, junk omitted from the prompt rendering only).
 *
 * Everything here is pure except `runCleanupStage`, which takes an injected caller
 * (the pipeline passes the LLM adapter; tests pass a scripted mock).
 */
import type { LineTag, LineTagSource, SourceLine } from '../types';
import { detectSectionHeaders, exciseWatermarks, lineNumber, normalizeForMatching, parsePrintedNumberFromStem } from './quality';

export const CLEANUP_VERSION = 'cleanup-v1';
export const CLEANUP_CHUNK_LINES = 400;
export const CLEANUP_CONTEXT_WINDOW = 2;

export interface LineVerdict {
  line: number;
  tag: LineTag;
  source: LineTagSource;
  conf?: number;
  /** True when a fence overrode the AI's verdict (e.g. junk on a printed-number line). */
  fenced?: boolean;
}

export interface CleanupStats {
  judged: number;
  junk: number;
  suspect: number;
  fenceSaved: number;
  aiSkipped: boolean;
  linesBefore: number;
  linesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  source: 'off' | 'local' | 'ai' | 'cached';
}

export interface CleanupFlag { code: string; severity: 'info' | 'warn' | 'error'; message: string }

// ---------------------------------------------------------------------------------
// Local pattern knowledge (regex already knows these; the AI is never asked to redo them)
// ---------------------------------------------------------------------------------
const OPTION_MARKER_LINE = /^\s*(?:\(?[a-h][).:]|\([a-h]\)|\((?:الف|ب|پ|ت|ث|ج|چ|د)\)|(?:الف|ب|پ|ت|ث|ج|چ|د)[).:])(?:\s|$)/i;
const OPTION_MARKER_ANY = /(?:^|\s)(?:\(?[a-h][).:]|\([a-h]\)|\((?:الف|ب|پ|ت|ث|ج|چ|د)\)|(?:الف|ب|پ|ت|ث|ج|چ|د)[).:])(?=\s|$)/i;
const BLANK_MARKER = /……|…{2,}|\.\.\.|_{2,}|-{3,}|\(\s*\)|\(\s*\.+\s*\)/;
const GROUP_ENUM = /\(\d{1,3}\)\s*\(\d{1,3}\)/;
const URL_ONLY = /^(?:https?:\/\/|www[.-])\S+$/i;
const INSTRUCTION_RE = /^(?:\(?یک\s+(?:تعریف|کلمه|جمله|مورد)\s+اضاف(?:ه|ی)\s+(?:است|می‌باشد|میباشد)|instructions?\b|directions?\b|read\b|choose\b|select\b|listen\b|complete\b|answer\b|fill\b|match\b|write\b|circle\b|underline\b|دستورالعمل|به سوالات|به پرسش|گزینه|جاهای خالی|جملات|جمله|کلمات|با توجه به|متن زیر|مکالمه|پاسخ\s+صحیح|دانش\s*اموز\s*عزیز|در\s+این\s+قسمت|در\s+سوالهای|توجه\s*:)/i;
const TOTAL_POINTS_RE = /(?:جمع\s*نمره|جمع\s*نمرات|نمره\s*کل|total\s*(?:points|marks|score))/i;

/** A line that carries a printed question number (leading, parenthesised, or a (15)(16) group line). */
export function isPrintedNumberLine(text: string): boolean {
  if (parsePrintedNumberFromStem(text) !== undefined) return true;
  return GROUP_ENUM.test(normalizeForMatching(text));
}
export function isOptionMarkerLine(text: string): boolean {
  const v = normalizeForMatching(text).trim();
  if (OPTION_MARKER_LINE.test(v)) return true;
  return (v.match(new RegExp(OPTION_MARKER_ANY.source, 'gi')) || []).length >= 2;
}
export function hasBlankMarker(text: string): boolean {
  return BLANK_MARKER.test(text) || BLANK_MARKER.test(normalizeForMatching(text));
}
/** Bare page numbers: "2", "- 2 -", "صفحه ۲", "page 2 of 5". */
export function isBarePageNumber(text: string): boolean {
  const v = normalizeForMatching(text).trim().replace(/^[-–—\s]+|[-–—\s]+$/g, '');
  return /^(?:page\s*|صفحه\s*(?:ی\s*)?|ص\s*)?\d{1,3}(?:\s*(?:\/|of|از)\s*\d{1,3})?$/i.test(v);
}
export function isTotalPointsLine(text: string): boolean {
  return TOTAL_POINTS_RE.test(normalizeForMatching(text));
}
export function isInstructionText(text: string): boolean {
  return INSTRUCTION_RE.test(normalizeForMatching(text).trim());
}

/** D1 — low readability: ≥30% of tokens are mixed-script glue, replacement chars, or watermark residue. */
export function isGarbledText(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return /\uFFFD/.test(text);
  let bad = 0;
  for (const token of tokens) {
    const arabic = /[\u0600-\u06FF]/.test(token);
    const latin = /[A-Za-z]/.test(token);
    const glue = arabic && latin && token.length >= 4;
    const residue = /kanoon|www[.-]|\.ir\b|\uFFFD/i.test(token) && !/^(?:https?:\/\/|www\.)\S+$/i.test(token);
    if (glue || residue) bad++;
  }
  return bad / tokens.length >= 0.3;
}

/** The three fence patterns: these lines can NEVER become junk (A3). */
export function isFenceProtected(text: string): boolean {
  return isPrintedNumberLine(text) || isOptionMarkerLine(text) || hasBlankMarker(text);
}

// ---------------------------------------------------------------------------------
// A1 — deterministic pre-pass (0 calls)
// ---------------------------------------------------------------------------------
export interface LocalPrepassResult {
  verdicts: Map<number, LineVerdict>;
  garbled: Set<number>;
  /** Printed numbers enumerated before the pre-pass (protects bare numbers that are question anchors). */
  protectedBareNumbers: Set<number>;
}

export function localCleanupPrepass(
  lines: SourceLine[],
  keyLines: Set<number>,
  options: { pages?: number; expectedNumbers?: number[]; overrides?: Record<string, LineTag> } = {},
): LocalPrepassResult {
  const verdicts = new Map<number, LineVerdict>();
  const garbled = new Set<number>();
  const pages = options.pages || new Set(lines.map(line => line.page)).size || 1;
  const expected = new Set(options.expectedNumbers || []);
  const protectedBareNumbers = new Set<number>();
  const byPage = new Map<number, SourceLine[]>();
  for (const line of lines) byPage.set(line.page, [...(byPage.get(line.page) || []), line]);

  // Repeated text across ≥60% of pages (text-only; complements the geometry-based tagFurniture).
  const textPages = new Map<string, Set<number>>();
  for (const line of lines) {
    const key = normalizeForMatching(line.text).trim();
    if (key.length < 3 || isFenceProtected(line.text)) continue;
    const set = textPages.get(key) || new Set<number>();
    set.add(line.page);
    textPages.set(key, set);
  }
  const repeatedThreshold = Math.max(2, Math.ceil(pages * 0.6));
  const headerLines = new Set(detectSectionHeaders(lines).map(h => h.headerLine));

  for (const line of lines) {
    const n = lineNumber(line);
    const text = line.text;
    const normalized = normalizeForMatching(text).trim();
    if (isGarbledText(text)) garbled.add(n);
    const pageLines = byPage.get(line.page) || [];
    const pos = pageLines.indexOf(line);
    const edge = pos <= 1 || pos >= pageLines.length - 2;

    let tag: LineTag | undefined;
    if (keyLines.has(n)) tag = 'key';
    else if (line.furniture) tag = 'furniture';
    else if ((!normalized || !exciseWatermarks(text).text.trim()) && text.trim()) tag = 'furniture'; // watermark-only (lexicon strips it to nothing)
    else if (URL_ONLY.test(text.trim())) tag = 'furniture';
    else if (pages >= 2 && normalized.length >= 3 && (textPages.get(normalized)?.size || 0) >= repeatedThreshold && !headerLines.has(n)) tag = 'furniture';
    else if (isBarePageNumber(text)) {
      const value = Number(normalized.replace(/\D+/g, ' ').trim().split(' ')[0]);
      const looksLikeQuestionAnchor = expected.has(value) && !edge && Math.abs(value - line.page) > 1;
      if (looksLikeQuestionAnchor) protectedBareNumbers.add(n);
      else tag = 'pagenum';
    }
    else if (headerLines.has(n)) tag = 'header';
    if (tag) verdicts.set(n, { line: n, tag, source: 'local' });
  }
  // User overrides win over every local verdict (and later over AI ones).
  for (const [lineKey, tag] of Object.entries(options.overrides || {})) {
    const n = Number(lineKey);
    if (Number.isInteger(n) && lines.some(line => lineNumber(line) === n)) verdicts.set(n, { line: n, tag, source: 'user' });
  }
  return { verdicts, garbled, protectedBareNumbers };
}

// ---------------------------------------------------------------------------------
// A2 — the cleanup call (prompt, chunking, tolerant parsing)
// ---------------------------------------------------------------------------------
export const CLEANUP_SYSTEM = `You are ExamClean, a line judge for printed exams. You NEVER delete, edit or renumber lines: you only label each line id. Return compact JSON only: {"v":[["L0012","junk",9],...]} — one entry per JUDGED line id (skip lines marked ctx), verdict word, confidence digit 0-9.
Verdicts: keep (exam content of any kind) · junk (nothing to do with the exam: page numbers, watermarks, URLs, running headers/footers, printer noise) · header (section title/heading line) · instruction (teacher instruction such as "Choose the best answer" / Persian "گزینه درست را انتخاب کنید") · question (line that starts or continues a numbered question, including "(15) (16) (17) (18)" group lines) · option (answer choice line a)/b)/الف)/ب)) · passage (reading passage prose) · dialogue (A:/B: or speaker lines) · table-row (tabular row).
Definitions by example:
1. "[L0007] 3. He ____ to school yesterday." → question 9 (a blank is content).
2. "[L0008] www-kanoon-ir" → junk 9 (watermark alone on a line).
3. "[L0009] The keys are on the table www-kanoon-ir" → keep 8 — TRAP: a watermark glued mid-sentence; the SENTENCE is content, never junk.
4. "[L0010] ۲" → junk 9 (a line that is only a page number).
5. "[L0011] به سوالات زیر پاسخ دهید." → instruction 9 — TRAP: Persian instruction lines are NOT junk; sectioners need them.
6. "[L0012] (15) (16) (17) (18)" → question 9 — TRAP: a group picture-matching line IS a question anchor.
7. "[L0013] a) go b) went c) gone" → option 9.
8. "[L0014] Reading درک مطلب (نمره ۱۰)" → header 9.
9. "[L0015] Tom: Where is the bank? Sara: Next to the post office." → dialogue 8.
Lines marked [KEY] are answer-key territory: they are already tagged locally and are shown for context only — never relabel them keep or junk. Lines marked ctx are context only; do not output them. When unsure prefer keep with a low digit; junk below 8 is treated as suspect, not removed. No prose, no markdown. /no_think`;

export interface CleanupChunk {
  index: number;
  /** Lines to judge (not locally tagged). */
  judge: SourceLine[];
  /** Context-only tagged neighbours. */
  context: Array<{ line: SourceLine; tag: LineTag }>;
}

export function buildCleanupChunks(lines: SourceLine[], local: Map<number, LineVerdict>, chunkSize = CLEANUP_CHUNK_LINES): CleanupChunk[] {
  const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  const judgeAll = sorted.filter(line => !local.has(lineNumber(line)));
  const chunks: CleanupChunk[] = [];
  for (let i = 0; i < judgeAll.length; i += chunkSize) {
    const judge = judgeAll.slice(i, i + chunkSize);
    const judgeSet = new Set(judge.map(lineNumber));
    const context: CleanupChunk['context'] = [];
    for (const line of judge) {
      const idx = sorted.indexOf(line);
      for (let d = -CLEANUP_CONTEXT_WINDOW; d <= CLEANUP_CONTEXT_WINDOW; d++) {
        const neighbour = sorted[idx + d];
        if (!neighbour || d === 0) continue;
        const n = lineNumber(neighbour);
        const tag = local.get(n)?.tag;
        if (tag && !judgeSet.has(n) && !context.some(c => c.line === neighbour)) context.push({ line: neighbour, tag });
      }
    }
    chunks.push({ index: chunks.length, judge, context });
  }
  return chunks;
}

export function renderCleanupChunk(chunk: CleanupChunk): string {
  const rows = [
    ...chunk.judge.map(line => ({ n: lineNumber(line), text: `${line.id} ${line.text}` })),
    ...chunk.context.map(({ line, tag }) => ({ n: lineNumber(line), text: `${line.id} ctx[${tag === 'key' ? 'KEY' : tag.toUpperCase()}] ${line.text}` })),
  ].sort((a, b) => a.n - b.n);
  return `JUDGE ${chunk.judge.length} lines (ids ${chunk.judge[0]?.id || '-'}..${chunk.judge[chunk.judge.length - 1]?.id || '-'}); ctx lines are context only.\n${rows.map(r => r.text).join('\n')}`;
}

const VERDICT_WORDS = new Set<LineTag>(['keep', 'junk', 'header', 'instruction', 'question', 'option', 'passage', 'dialogue', 'table-row']);
function normalizeVerdictWord(word: unknown): LineTag | undefined {
  const w = String(word ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (VERDICT_WORDS.has(w as LineTag)) return w as LineTag;
  if (w === 'pagenum' || w === 'page-number' || w === 'furniture' || w === 'watermark' || w === 'noise') return 'junk';
  if (w === 'content' || w === 'text' || w === 'ok') return 'keep';
  if (w === 'title' || w === 'heading' || w === 'section') return 'header';
  if (w === 'table' || w === 'row') return 'table-row';
  if (w === 'choice' || w === 'options') return 'option';
  return undefined;
}

/** Tolerant salvage: strict JSON first, then object arrays, then "L0012 junk 9" text lines. */
export function parseCleanupVerdicts(rawText: string, json?: unknown): Array<{ line: number; tag: LineTag; conf: number }> {
  const out: Array<{ line: number; tag: LineTag; conf: number }> = [];
  const push = (id: unknown, verdict: unknown, conf: unknown) => {
    const line = Number(String(id ?? '').replace(/\D/g, ''));
    const tag = normalizeVerdictWord(verdict);
    const c = Number(conf);
    if (!Number.isInteger(line) || line <= 0 || !tag) return;
    out.push({ line, tag, conf: Number.isFinite(c) ? Math.max(0, Math.min(9, Math.round(c))) : 5 });
  };
  const consume = (value: any) => {
    const list = Array.isArray(value) ? value : Array.isArray(value?.v) ? value.v : Array.isArray(value?.verdicts) ? value.verdicts : Array.isArray(value?.lines) ? value.lines : null;
    if (!list) return false;
    for (const item of list) {
      if (Array.isArray(item)) push(item[0], item[1], item[2]);
      else if (item && typeof item === 'object') push(item.id ?? item.l ?? item.line, item.verdict ?? item.v ?? item.tag, item.conf ?? item.c ?? item.confidence);
    }
    return list.length > 0;
  };
  if (json && consume(json)) return out;
  const text = String(rawText || '');
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try { if (consume(JSON.parse(candidate))) return out; } catch { /* fall through to salvage */ }
    // Truncated JSON: salvage every complete triple.
    for (const m of candidate.matchAll(/\[\s*"?(L?\d{1,5})"?\s*,\s*"?([a-z-]+)"?\s*(?:,\s*(\d))?\s*\]/gi)) push(m[1], m[2], m[3] ?? 5);
    if (out.length) return out;
  }
  for (const m of text.matchAll(/\b(L\d{3,5})\b[^\S\n]*[:=,-]?[^\S\n]*([a-z-]+)(?:[^\S\n]*[:=,-]?[^\S\n]*(\d))?/gi)) push(m[1], m[2], m[3] ?? 5);
  return out;
}

// ---------------------------------------------------------------------------------
// A3 — local fences on AI verdicts (deterministic, non-negotiable)
// ---------------------------------------------------------------------------------
export interface FenceResult { verdicts: Map<number, LineVerdict>; fenceSaved: number; flags: CleanupFlag[]; junk: number; suspect: number }

export function fenceVerdicts(
  lines: SourceLine[],
  local: Map<number, LineVerdict>,
  ai: Array<{ line: number; tag: LineTag; conf: number }>,
  protectedBareNumbers: Set<number> = new Set(),
): FenceResult {
  const byLine = new Map(lines.map(line => [lineNumber(line), line]));
  const verdicts = new Map<number, LineVerdict>(local);
  const flags: CleanupFlag[] = [];
  let fenceSaved = 0, junk = 0, suspect = 0;
  for (const v of ai) {
    const line = byLine.get(v.line);
    if (!line) continue;
    const existing = local.get(v.line);
    // Locally tagged lines (key/furniture/pagenum/header/user) are never relabelled by the AI.
    if (existing) continue;
    if (v.tag === 'junk') {
      if (isFenceProtected(line.text) || protectedBareNumbers.has(v.line)) {
        fenceSaved++;
        verdicts.set(v.line, { line: v.line, tag: 'keep', source: 'ai', conf: v.conf, fenced: true });
        flags.push({ code: 'CLEANUP_FENCE_SAVED', severity: 'info', message: `${line.id}: AI judged junk but the line carries a printed number, option marker or blank — kept.` });
        continue;
      }
      if (v.conf >= 8) { junk++; verdicts.set(v.line, { line: v.line, tag: 'junk', source: 'ai', conf: v.conf }); }
      else if (v.conf >= 5) { suspect++; verdicts.set(v.line, { line: v.line, tag: 'suspect-junk', source: 'ai', conf: v.conf }); }
      else verdicts.set(v.line, { line: v.line, tag: 'keep', source: 'ai', conf: v.conf });
      continue;
    }
    verdicts.set(v.line, { line: v.line, tag: v.tag, source: 'ai', conf: v.conf });
  }
  return { verdicts, fenceSaved, flags, junk, suspect };
}

/** Apply verdicts as tags. Never touches id/text/page/y; untagged lines stay untouched. */
export function applyTagsToLines(lines: SourceLine[], verdicts: Map<number, LineVerdict>, garbled: Set<number> = new Set()): SourceLine[] {
  return lines.map(line => {
    const n = lineNumber(line);
    const v = verdicts.get(n);
    const isGarbled = garbled.has(n);
    if (!v && !isGarbled) return line;
    const next: SourceLine = { ...line };
    if (v) { next.tag = v.tag; next.tagSource = v.source; if (v.conf !== undefined) next.tagConf = v.conf; }
    if (isGarbled) next.garbled = true;
    return next;
  });
}

/** Tags that keep a line out of prompts (junk-class). Suspect junk stays visible in a tail block. */
export function isPromptOmitted(line: SourceLine): boolean {
  return line.tag === 'junk' || line.tag === 'pagenum';
}
/** Junk-class lines for slicing/ownership. Only confirmed junk (AI conf≥8 / user) — local tags never alter slicing (F3). */
export function isContentJunk(line: SourceLine): boolean {
  return line.tag === 'junk';
}

/** Prompt prefix for a tag (rendering only — stored text is never mutated). */
export function tagPrefix(line: SourceLine): string {
  switch (line.tag) {
    case 'furniture': return '[FURNITURE] ';
    case 'key': return '[KEY] ';
    case 'header': return '[HDR] ';
    case 'instruction': return '[INSTR] ';
    case 'passage': return '[PASSAGE] ';
    case 'dialogue': return '[DIALOGUE] ';
    case 'table-row': return '[ROW] ';
    case 'suspect-junk': return '[SUSPECT] ';
    default: return '';
  }
}

export interface CleanViewResult { text: string; linesBefore: number; linesAfter: number; tokensBefore: number; tokensAfter: number; omitted: number[]; suspect: SourceLine[] }
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * A4 — the CLEAN VIEW for structure prompts: page markers kept, tags rendered as prefixes,
 * junk-tagged lines omitted entirely, suspect-junk listed in a tail block so nothing is invisible.
 * Spans in model output still reference ORIGINAL line numbers (ids are unchanged).
 */
export function renderCleanView(lines: SourceLine[], keyLines: Set<number>, options: { cleanup?: boolean } = {}): CleanViewResult {
  const cleanup = options.cleanup !== false;
  let before = '', after = '';
  let currentPage = 0;
  const omitted: number[] = [];
  const suspect: SourceLine[] = [];
  for (const line of lines) {
    if (line.page !== currentPage) { currentPage = line.page; const marker = `=== PAGE ${currentPage} ===\n`; before += marker; after += marker; }
    const n = lineNumber(line);
    const legacy = `[${line.id}] ${keyLines.has(n) ? '[KEY] ' : ''}${line.furniture ? '[FURNITURE] ' : ''}${line.text}\n`;
    before += legacy;
    if (!cleanup) { after += legacy; continue; }
    if (isPromptOmitted(line)) { omitted.push(n); continue; }
    if (line.tag === 'suspect-junk') suspect.push(line);
    const keyPrefix = keyLines.has(n) && line.tag !== 'key' ? '[KEY] ' : '';
    const furniturePrefix = line.furniture && line.tag !== 'furniture' ? '[FURNITURE] ' : '';
    const garbledPrefix = line.garbled ? '[GARBLED?] ' : '';
    after += `[${line.id}] ${keyPrefix}${furniturePrefix}${tagPrefix(line)}${garbledPrefix}${line.text}\n`;
  }
  if (cleanup && omitted.length) after += `(cleanup omitted ${omitted.length} junk line(s): ${omitted.slice(0, 40).map(n => `L${String(n).padStart(4, '0')}`).join(',')}${omitted.length > 40 ? ',…' : ''})\n`;
  return { text: after, linesBefore: lines.length, linesAfter: lines.length - omitted.length, tokensBefore: estimateTokens(before), tokensAfter: estimateTokens(after), omitted, suspect };
}

// ---------------------------------------------------------------------------------
// A5 — cost discipline
// ---------------------------------------------------------------------------------
export function estimateCleanupCall(lines: SourceLine[], keyLines: Set<number>, pages = 1): { chunks: number; inputTokens: number; outputTokens: number; judged: number } {
  const local = localCleanupPrepass(lines, keyLines, { pages });
  const chunks = buildCleanupChunks(lines, local.verdicts);
  const judged = chunks.reduce((sum, c) => sum + c.judge.length, 0);
  const inputTokens = chunks.reduce((sum, c) => sum + estimateTokens(renderCleanupChunk(c)), 0) + chunks.length * estimateTokens(CLEANUP_SYSTEM);
  // ids + 1 word + 1 digit per line ≈ 7 tokens/line — the cheapest possible AI judgment.
  return { chunks: chunks.length, inputTokens, outputTokens: judged * 7 + chunks.length * 4, judged };
}

// ---------------------------------------------------------------------------------
// Orchestration (one call per exam, chunked >400 lines; caller injected so transport is mockable)
// ---------------------------------------------------------------------------------
export interface CleanupCaller {
  (request: { system: string; text: string; label: string; maxOutputTokens: number }): Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number } }>;
}
export interface RunCleanupParams {
  lines: SourceLine[];
  keyLines: Set<number>;
  pages?: number;
  expectedNumbers?: number[];
  overrides?: Record<string, LineTag>;
  /** false ⇒ local pre-pass only (0 calls); undefined ⇒ AI if a caller is supplied. */
  enabled?: boolean;
  caller?: CleanupCaller;
  cachedVerdicts?: Array<{ line: number; tag: LineTag; conf: number }>;
  onProgress?: (message: string) => void;
}
export interface RunCleanupResult {
  lines: SourceLine[];
  verdicts: LineVerdict[];
  aiVerdicts: Array<{ line: number; tag: LineTag; conf: number }>;
  stats: CleanupStats;
  flags: CleanupFlag[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  calls: number;
  /** True when verdicts came from the cache (0 calls). */
  cached: boolean;
}

export async function runCleanupStage(params: RunCleanupParams): Promise<RunCleanupResult> {
  const { lines, keyLines } = params;
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const flags: CleanupFlag[] = [];
  const baseStats = (): CleanupStats => ({ judged: 0, junk: 0, suspect: 0, fenceSaved: 0, aiSkipped: false, linesBefore: lines.length, linesAfter: lines.length, tokensBefore: 0, tokensAfter: 0, source: 'off' });
  // The deterministic local pre-pass (A1) always runs — it is free, regex-only, and feeds
  // ownership/gap completion. `enabled:false` switches off the AI judgment only (0 calls).
  const aiEnabled = params.enabled !== false;
  const local = localCleanupPrepass(lines, keyLines, { pages: params.pages, expectedNumbers: params.expectedNumbers, overrides: params.overrides });
  let aiVerdicts: Array<{ line: number; tag: LineTag; conf: number }> = aiEnabled ? (params.cachedVerdicts || []) : [];
  let calls = 0;
  let aiSkipped = false;
  let source: CleanupStats['source'] = !aiEnabled ? 'off' : params.cachedVerdicts ? 'cached' : 'local';
  // F1 ladder: chunk sizes 400→200→100→50. The stage is invoked once per exam at 400;
  // smaller sizes are used only when judged lines exceed the current window (large docs)
  // or when the pipeline escalates a `completed-with-problems` result (cache-aware, outside).
  // Shape-mismatch (<25% parsed) on a small doc (judged ≤400) is exactly 2 attempts then
  // CLEANUP_AI_SKIPPED — no recursive 30-call explosion.
  const ladderSizes = [400, 200, 100, 50] as const;
  const judgedAllCount = (() => {
    const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
    return sorted.filter(l => !local.verdicts.has(lineNumber(l))).length;
  })();
  void baseStats;
  if (aiEnabled && !params.cachedVerdicts && params.caller) {
    source = 'ai';
    let ladderSucceeded = false;
    // Cache-aware: try 400 first; smaller sizes are fallback for large docs that don't fit.
    for (let ladderIdx = 0; ladderIdx < ladderSizes.length && !ladderSucceeded; ladderIdx++) {
      const chunkSize = ladderSizes[ladderIdx];
      // Small-doc fast path: only the 400 window applies; smaller windows would be single chunk again.
      if (judgedAllCount <= 400 && chunkSize !== 400) break;
      // Large-doc: skip sizes that still exceed judged count? Actually we want 400→200→100→50 progression,
      // so once we are at 200 we rebuild chunks at 200 (more chunks, smaller payload).
      if (judgedAllCount <= chunkSize && ladderIdx > 0) continue;
      const chunks = buildCleanupChunks(lines, local.verdicts, chunkSize);
      if (!chunks.length) { ladderSucceeded = true; break; }
      let chunkIdx = 0;
      let failedThisLadder = false;
      const verdictsThisLadder: Array<{ line: number; tag: LineTag; conf: number }> = [];
      for (const chunk of chunks) {
        const text = renderCleanupChunk(chunk);
        const maxOutputTokens = Math.max(256, chunk.judge.length * 12 + 64);
        let parsed: Array<{ line: number; tag: LineTag; conf: number }> = [];
        for (let attempt = 0; attempt < 2 && !parsed.length; attempt++) {
          try {
            params.onProgress?.(`Cleanup: judging ${chunk.judge.length} line(s) (chunk ${chunk.index + 1}/${chunks.length} @${chunkSize}${attempt ? ', retry' : ''})`);
            const response = await params.caller({ system: CLEANUP_SYSTEM, text: attempt ? `${text}\n\nYour previous reply was not the required JSON. Output {"v":[["L0001","keep",9],...]} only.` : text, label: `Cleanup${chunks.length > 1 ? ` (chunk ${chunk.index + 1}/${chunks.length})` : ''}@${chunkSize}${attempt ? ' retry' : ''}`, maxOutputTokens });
            calls++;
            usage.inputTokens += response.usage?.inputTokens || 0; usage.outputTokens += response.usage?.outputTokens || 0; usage.cachedTokens += response.usage?.cachedTokens || 0;
            const judgeIds = new Set(chunk.judge.map(lineNumber));
            parsed = parseCleanupVerdicts(response.rawText, response.json).filter(v => judgeIds.has(v.line));
            if (parsed.length < Math.ceil(chunk.judge.length / 4)) parsed = [];
          } catch { parsed = []; }
        }
        if (!parsed.length) { failedThisLadder = true; chunkIdx = chunk.index; break; }
        verdictsThisLadder.push(...parsed);
      }
      if (failedThisLadder) {
        // Small doc shape-mismatch: exactly 2 attempts, then LOCAL fallback — do NOT ladder to smaller sizes
        // (smaller sizes would still be single chunk and would double calls to 4, violating gauntlet).
        if (judgedAllCount <= chunkSize) { aiSkipped = true; break; }
        // Large doc: fall through to try next smaller chunkSize (cache will store per-size results externally).
        // For gauntlet's shape-mismatch case (judged <=400) we already broke; for large docs we continue.
        continue;
      } else {
        aiVerdicts = verdictsThisLadder;
        ladderSucceeded = true;
        // If we succeeded at a smaller size than 400, record that ladder was used (for observability)
        if (chunkSize !== 400) flags.push({ code: 'CLEANUP_LADDER_USED', severity: 'info', message: `Cleanup ladder used chunk size ${chunkSize} (400→${chunkSize})` });
      }
    }
    // If no ladder size succeeded and not already marked skipped (e.g., large doc all sizes failed), mark skipped
    if (!ladderSucceeded && !aiSkipped && aiVerdicts.length === 0) {
      // No verdicts collected → fallback to local
      aiSkipped = true;
    }
  }
  if (aiSkipped) {
    aiVerdicts = [];
    flags.push({ code: 'CLEANUP_AI_SKIPPED', severity: 'warn', message: 'Cleanup model failed or returned an unusable shape after one retry; the parse continued with LOCAL cleanup tags only.' });
  }
  const fenced = fenceVerdicts(lines, local.verdicts, aiVerdicts, local.protectedBareNumbers);
  flags.push(...fenced.flags);
  const tagged = applyTagsToLines(lines, fenced.verdicts, local.garbled);
  const view = renderCleanView(tagged, keyLines);
  const stats: CleanupStats = {
    judged: aiVerdicts.length, junk: fenced.junk + [...local.verdicts.values()].filter(v => v.tag === 'furniture' || v.tag === 'pagenum').length,
    suspect: fenced.suspect, fenceSaved: fenced.fenceSaved, aiSkipped,
    linesBefore: view.linesBefore, linesAfter: view.linesAfter, tokensBefore: view.tokensBefore, tokensAfter: view.tokensAfter,
    source: aiSkipped ? 'local' : source,
  };
  return { lines: tagged, verdicts: [...fenced.verdicts.values()].sort((a, b) => a.line - b.line), aiVerdicts, stats, flags, usage, calls, cached: aiEnabled && Boolean(params.cachedVerdicts) };
}

/** Stable content hash input for the cleanup cache (ids + text + version + model). */
/**
 * Deterministic part of the structure cache key that the cleanup stage contributes. It is computable
 * BEFORE any call (Step 3 pre-flight uses the same function), so cache-hit reporting matches the run.
 */
export function cleanupKeySignature(params: { enabled: boolean; model?: string; overrides?: Record<string, LineTag> }): string {
  const overrides = Object.entries(params.overrides || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([k, v]) => `${k}=${v}`).join(',');
  return `${CLEANUP_VERSION}|${params.enabled ? params.model || 'fast' : 'off'}|${overrides || '-'}`;
}

export function cleanupCacheOptions(lines: SourceLine[], model: string, overrides?: Record<string, LineTag>): { version: string; model: string; lineCount: number; overrides: string } {
  return { version: CLEANUP_VERSION, model, lineCount: lines.length, overrides: JSON.stringify(overrides || {}) };
}
