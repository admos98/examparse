/**
 * Part B — LINE OWNERSHIP in the assembly funnel.
 *
 * Every non-junk line in exam territory must be owned by a question, a section
 * (header / instruction / passage / preamble) or be an ORPHAN. Models anchor
 * questions (often lazily, one line); deterministic gap completion extends each
 * question forward over the lines nobody else claims, never crossing a barrier:
 * printed-number line, section header, instruction, passage tag, key territory,
 * another question's lines, total-points / closing lines.
 *
 * Pure, 0 model calls. Operates on RAW questions (before assembly) so the existing
 * option splitter / stem decontamination run on the completed spans, and on
 * assembled docs for the ownership map used by health, quality score and bench.
 */
import type { ExamDoc, ExamSection, LineSpan, Question, SourceLine } from '../types';
import { detectSectionHeaders, lineNumber, normalizeForMatching, parsePrintedNumberFromStem } from './quality';
import { isBarePageNumber, isInstructionText, isOptionMarkerLine, isTotalPointsLine } from './cleanup';

export const GAP_ABSORB_CAP = 30;
export const TAIL_ABSORB_CAP = 8;
const CLOSING_RE = /^(?:good\s*luck|موفق\s*باشید|پیروز\s*باشید|با\s*آرزوی\s*موفقیت|end\s*of\s*(?:exam|test|paper)|پایان\s*(?:آزمون|سوالات|امتحان))/i;

export type OwnerKind = 'question' | 'section' | 'unowned' | 'skipped';
export interface OwnershipEntry { line: number; owner: OwnerKind; ownerId?: string; reason: string }
export interface OwnershipMap {
  entries: OwnershipEntry[];
  /** Lines in exam territory that count toward the orphan rate denominator (non-skip). */
  territory: number;
  orphanLineNos: number[];
  orphanRate: number;
}

export interface GapCompletionResult {
  raw: any[];
  /** questionKey (id or index) → absorbed line numbers. */
  absorbed: Map<string, number[]>;
  /** Questions whose options were synthesised locally from markers (count of options). */
  synthesized: Map<string, number>;
  capped: string[];
}

function spanLines(spans: LineSpan[] | undefined): number[] {
  const out = new Set<number>();
  for (const s of Array.isArray(spans) ? spans : []) {
    if (!Array.isArray(s)) continue; // tolerate malformed spans from older/foreign docs
    const [a, b] = s;
    if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b - a < 5000) for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}
function compress(lines: number[]): LineSpan[] {
  const out: LineSpan[] = [];
  for (const n of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === n) last[1] = n; else out.push([n, n]);
  }
  return out;
}
function rawSpans(spans: unknown): LineSpan[] {
  if (!Array.isArray(spans)) return [];
  const out: LineSpan[] = [];
  for (const s of spans) {
    if (Array.isArray(s) && s.length >= 2) { const a = Number(s[0]), b = Number(s[1]); if (Number.isInteger(a) && Number.isInteger(b) && a > 0 && b >= a) out.push([a, b]); }
    else if (typeof s === 'number' && Number.isInteger(s) && s > 0) out.push([s, s]);
  }
  return out;
}

/** Lines that neither absorb nor block: furniture, page numbers, confirmed junk, blank text. */
export function isSkippedLine(line: SourceLine): boolean {
  if (line.furniture || line.tag === 'furniture' || line.tag === 'pagenum' || line.tag === 'junk' || !line.text.trim()) return true;
  // Even without cleanup tags: bare page numbers, URL-only and watermark-only lines are never question content.
  return isBarePageNumber(line.text) || /^(?:https?:\/\/|www[.-])\S+$/i.test(line.text.trim()) || !normalizeForMatching(line.text).trim();
}

export type BarrierKind = 'printed-number' | 'header' | 'instruction' | 'passage' | 'key' | 'total' | 'closing';
export interface LineClass { line: number; barrier?: BarrierKind; sectionLevel: boolean; optionMarker: boolean; skipped: boolean }

/** Header anchors: keyword-detected headers that are NOT printed-number lines, plus header tags. */
export function headerAnchors(lines: SourceLine[]): Array<{ title: string; headerLine: number; kind: string; rawTitle: string }> {
  const byNo = new Map(lines.map(line => [lineNumber(line), line]));
  const out = new Map<number, { title: string; headerLine: number; kind: string; rawTitle: string }>();
  for (const h of detectSectionHeaders(lines)) {
    const line = byNo.get(h.headerLine);
    if (!line || parsePrintedNumberFromStem(line.text) !== undefined || line.tag === 'junk') continue;
    out.set(h.headerLine, { title: h.title, headerLine: h.headerLine, kind: h.kind, rawTitle: h.rawTitle });
  }
  for (const line of lines) {
    const n = lineNumber(line);
    if (line.tag === 'header' && !out.has(n) && parsePrintedNumberFromStem(line.text) === undefined) out.set(n, { title: line.text.trim().slice(0, 60), headerLine: n, kind: 'Other', rawTitle: line.text.trim() });
  }
  return [...out.values()].sort((a, b) => a.headerLine - b.headerLine);
}

export function classifyLines(lines: SourceLine[], keyLines: Set<number>): Map<number, LineClass> {
  const headers = new Set(headerAnchors(lines).map(h => h.headerLine));
  const out = new Map<number, LineClass>();
  for (const line of lines) {
    const n = lineNumber(line);
    const skipped = isSkippedLine(line);
    let barrier: BarrierKind | undefined;
    if (keyLines.has(n) || line.tag === 'key') barrier = 'key';
    else if (!skipped) {
      if (headers.has(n) || line.tag === 'header') barrier = 'header';
      else if (isTotalPointsLine(line.text)) barrier = 'total';
      else if (CLOSING_RE.test(normalizeForMatching(line.text).trim())) barrier = 'closing';
      else if (line.tag === 'passage') barrier = 'passage';
      else if (line.tag === 'instruction' || (isInstructionText(line.text) && parsePrintedNumberFromStem(line.text) === undefined)) barrier = 'instruction';
      else if (parsePrintedNumberFromStem(line.text) !== undefined || /\(\d{1,3}\)\s*\(\d{1,3}\)/.test(normalizeForMatching(line.text))) barrier = 'printed-number';
    }
    out.set(n, { line: n, barrier, sectionLevel: barrier === 'header' || barrier === 'instruction' || barrier === 'passage' || barrier === 'total' || barrier === 'closing', optionMarker: !skipped && isOptionMarkerLine(line.text), skipped });
  }
  return out;
}

const PERSIAN_OPTION_SERIES: readonly (readonly string[])[] = [
  ['الف', 'ب', 'ج', 'د', 'ه', 'و'],
  ['الف', 'ب', 'پ', 'ت', 'ث', 'ج', 'چ'],
];

function hasIntraLineMultiNumbers(text: string): boolean {
  if (!/(?:^|\s)(?:\([0-9۰-۹٠-٩０-９]{1,3}\)|[0-9۰-۹٠-٩０-９]{1,3}\s*[.):-])\s*(?:\([a-jالفبپتثجچدهو]\)|[a-jالفبپتثجچدهو][).:])/i.test(text)) return false;
  const v = normalizeForMatching(text);
  const re = /(?:^|\s)(?:\((\d{1,3})\)|(\d{1,3})\s*[.):-])\s*(?:\(([a-j])\)|([a-j])[).:]|\((الف|ب|پ|ت|ث|ج|چ|د|ه|و)\)|(الف|ب|پ|ت|ث|ج|چ|د|ه|و)[).:])(?=\s|$)/gi;
  const nos: number[] = [];
  for (const m of v.matchAll(re)) {
    const n = Number(m[1] || m[2]);
    if (Number.isInteger(n) && n >= 1 && n <= 300) nos.push(n);
  }
  return nos.length >= 2 && nos.every((n, i) => i === 0 || n > nos[i - 1]);
}

function optionMarkerKeys(text: string): string[] {
  if (hasIntraLineMultiNumbers(text)) return [];
  const v = normalizeForMatching(text);
  const re = /(?:^|\s)(?:\(([a-j])\)|([a-j])[).:]|\((الف|ب|پ|ت|ث|ج|چ|د|ه|و)\)|(الف|ب|پ|ت|ث|ج|چ|د|ه|و)[).:])(?=\s|$)/gi;
  const raw: string[] = [];
  for (const m of v.matchAll(re)) raw.push((m[1] || m[2] || m[3] || m[4] || '').toLowerCase());
  // Ordered Latin sequence starting at 'a'
  let bestLatin: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 'a') continue;
    const seq: string[] = ['a'];
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j] === String.fromCharCode(97 + seq.length)) seq.push(raw[j]);
    }
    if (seq.length >= bestLatin.length) bestLatin = seq;
  }
  if (bestLatin.length >= 2) return bestLatin;
  // Ordered Persian sequence starting strictly at 'الف'
  for (const series of PERSIAN_OPTION_SERIES) {
    let bestFa: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== series[0]) continue;
      const seq: string[] = [series[0]];
      for (let j = i + 1; j < raw.length && seq.length < series.length; j++) {
        if (raw[j] === series[seq.length]) seq.push(raw[j]);
      }
      if (seq.length >= bestFa.length) bestFa = seq;
    }
    if (bestFa.length >= 2) return bestFa;
  }
  const tf = [...v.matchAll(/(?:^|[\s/])(true|false|درست|نادرست)(?=\s|$|[).:/])/g)].map(m => m[1]);
  if (tf.includes('true') && tf.includes('false')) return ['true', 'false'];
  if (tf.includes('درست') && tf.includes('نادرست')) return ['درست', 'نادرست'];
  return [];
}

/**
 * B2 — gap completion on raw structure output. Returns a new raw array (inputs untouched).
 * `sections` may be raw (spans only) or assembled; only spans/ids are read.
 */
export function completeGapsRaw(
  rawQuestions: any[],
  lines: SourceLine[],
  options: { keyLines?: Set<number>; sections?: Array<{ id?: string; spans?: unknown }> } = {},
): GapCompletionResult {
  const keyLines = options.keyLines || new Set<number>();
  const sorted = [...lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  const lineNos = sorted.map(lineNumber);
  const byNo = new Map(sorted.map(line => [lineNumber(line), line]));
  const classes = classifyLines(sorted, keyLines);
  const absorbed = new Map<string, number[]>();
  const synthesized = new Map<string, number>();
  const capped: string[] = [];
  const raw = (Array.isArray(rawQuestions) ? rawQuestions : []).map(q => (q && typeof q === 'object' ? { ...q } : q));

  // Section ranges (start lines act as barriers for questions outside that section).
  const sectionRanges = (options.sections || []).map((s, i) => { const sp = rawSpans(s?.spans); const ls = spanLines(sp); return { id: String(s?.id || `sec_${i + 1}`), start: ls[0], end: ls[ls.length - 1] }; }).filter(s => s.start !== undefined);
  const sectionStarts = new Set(sectionRanges.map(s => s.start));

  // Ownership from the model's own spans (stem ∪ options ∪ tables), excluding key lines.
  const owner = new Map<number, number>();
  const owned: Array<{ idx: number; lines: number[]; firstLine: number }> = [];
  raw.forEach((q, idx) => {
    if (!q || typeof q !== 'object') return;
    const all = spanLines([...rawSpans(q.spans), ...((Array.isArray(q.options) ? q.options : []).flatMap((o: any) => rawSpans(o?.spans))), ...((Array.isArray(q.tables) ? q.tables : []).flatMap((t: any) => rawSpans(t?.spans)))]).filter(n => byNo.has(n) && !keyLines.has(n));
    if (!all.length) return;
    for (const n of all) if (!owner.has(n)) owner.set(n, idx);
    owned.push({ idx, lines: all, firstLine: all[0] });
  });
  owned.sort((a, b) => a.firstLine - b.firstLine);
  const key = (idx: number) => String(raw[idx]?.id || `#${idx}`);
  const lastLineNo = lineNos[lineNos.length - 1];

  for (const entry of owned) {
    const q = raw[entry.idx];
    const stemLines = spanLines(rawSpans(q.spans));
    const last = entry.lines[entry.lines.length - 1];
    const lastLine = byNo.get(last);
    const sectionId = typeof q.sectionId === 'string' ? q.sectionId : undefined;
    const ownSection = sectionRanges.find(s => s.id === sectionId) || sectionRanges.find(s => s.start! <= last && (s.end ?? Infinity) >= last);
    const sectionEnd = ownSection?.end ?? lastLineNo;
    // Children of a parent (shared parentId) are closed by the parent's remaining lines — no special casing needed.
    const gained: number[] = [];
    let n = last + 1;
    let stopped: 'barrier' | 'owned' | 'end' | 'cap' | 'section' = 'end';
    let nextIsQuestion = false;
    for (; n <= lastLineNo; n++) {
      const line = byNo.get(n);
      if (!line) continue;
      if (owner.has(n)) { stopped = 'owned'; nextIsQuestion = true; break; }
      if (n > sectionEnd || (sectionStarts.has(n) && !(ownSection && ownSection.start === n))) { stopped = 'section'; break; }
      const cls = classes.get(n)!;
      if (cls.skipped) continue;
      if (cls.barrier) { stopped = 'barrier'; nextIsQuestion = cls.barrier === 'printed-number'; break; }
      if (gained.length >= GAP_ABSORB_CAP) { stopped = 'cap'; break; }
      gained.push(n);
    }
    // Trailing gap (nothing after): absorb only same-page lines, capped — "Good luck", names, grids stay out.
    if (!nextIsQuestion && stopped !== 'owned') {
      const page = lastLine?.page;
      const trimmed = gained.filter(m => byNo.get(m)?.page === page).slice(0, TAIL_ABSORB_CAP);
      if (trimmed.length !== gained.length) { gained.length = 0; gained.push(...trimmed); }
    }
    if (stopped === 'cap') capped.push(key(entry.idx));
    if (!gained.length) { maybeSynthesizeOptions(q, stemLines, byNo, synthesized, key(entry.idx)); continue; }
    for (const m of gained) owner.set(m, entry.idx);
    absorbed.set(key(entry.idx), gained);

    // Stem continuation before the first option-marker line; option area from there on.
    const rawOptions: any[] = Array.isArray(q.options) ? q.options : [];
    const existingOptionLines = spanLines(rawOptions.flatMap((o: any) => rawSpans(o?.spans)));
    const firstOptionLine = existingOptionLines[0] ?? gained.find(m => classes.get(m)?.optionMarker) ?? Infinity;
    const optionArea = gained.filter(m => m >= firstOptionLine);
    // Stem spans cover the whole question body (as models do); decontaminateStem drops option text.
    q.spans = compress([...stemLines, ...gained]);
    if (optionArea.length) {
      const pool = [...new Set([...existingOptionLines, ...optionArea])].sort((a, b) => a - b);
      const keys = dedupeKeys(optionMarkerKeys(pool.map(m => byNo.get(m)?.text || '').join('\n')));
      if (keys.length >= 2) {
        // Rebuild options from the markers actually printed: each option references the pooled area;
        // the assembly option splitter assigns texts by marker order.
        q.options = keys.map(k => ({ key: k, spans: compress(pool) }));
        if (!rawOptions.length || rawOptions.length !== keys.length) synthesized.set(key(entry.idx), keys.length);
        if (!q.type || q.type === 'unknown' || q.type === 'short') q.type = isTrueFalsePair(keys, pool, byNo) ? 'truefalse' : 'mcq';
      } else if (rawOptions.length) {
        // No new markers: extend the last option with the option-area continuation lines.
        const lastOption = rawOptions[rawOptions.length - 1];
        q.options = [...rawOptions.slice(0, -1), { ...lastOption, spans: compress([...spanLines(rawSpans(lastOption?.spans)), ...optionArea]) }];
      }
    }
    maybeSynthesizeOptions(q, spanLines(rawSpans(q.spans)), byNo, synthesized, key(entry.idx));
  }
  return { raw, absorbed, synthesized, capped };
}

function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const k of keys) { if (!k || seen.has(k)) continue; seen.add(k); out.push(k); }
  return out;
}
function isTrueFalsePair(keys: string[], pool: number[], byNo: Map<number, SourceLine>): boolean {
  const text = normalizeForMatching(pool.map(m => byNo.get(m)?.text || '').join(' '));
  return keys.length === 2 && /\b(?:true|درست)\b/.test(text) && /\b(?:false|نادرست)\b/.test(text);
}

/** Option synthesis: a lazy span with no options but ≥2 printed markers → options from markers. */
function maybeSynthesizeOptions(q: any, stemLines: number[], byNo: Map<number, SourceLine>, synthesized: Map<string, number>, k: string): void {
  if (Array.isArray(q.options) && q.options.length) return;
  const candidateLines = stemLines.filter(m => { const line = byNo.get(m); return Boolean(line && !isSkippedLine(line)); });
  if (!candidateLines.length) return;
  const keys = dedupeKeys(optionMarkerKeys(candidateLines.map(m => byNo.get(m)?.text || '').join('\n')));
  if (keys.length < 2) return;
  const firstMarkerRe = /^\s*(?:\([a-j]\)|[a-j][).:]|\((?:الف|ب|پ|ت|ث|ج|چ|د|ه|و)\)|(?:الف|ب|پ|ت|ث|ج|چ|د|ه|و)[).:])(?=\s|$)/i;
  const first = candidateLines.find(m => {
    const t = byNo.get(m)?.text || '';
    return optionMarkerKeys(t).length >= 2 || firstMarkerRe.test(normalizeForMatching(t));
  }) ?? candidateLines[0];
  const pool = candidateLines.filter(m => m >= first);
  q.options = keys.map(key => ({ key, spans: compress(pool) }));
  synthesized.set(k, keys.length);
  if (!q.type || q.type === 'unknown' || q.type === 'short') q.type = isTrueFalsePair(keys, pool, byNo) ? 'truefalse' : 'mcq';
}

/**
 * B1/B3 — ownership map over an assembled document. Section ownership covers header /
 * instruction / passage lines and preambles (lines that precede a question or follow a
 * section-level anchor). Unowned lines are those left in a question's wake or behind an
 * unclaimed printed number (= a missing question's body).
 */
export function computeOwnership(params: { lines: SourceLine[]; questions: Question[]; sections?: ExamSection[]; keyLines?: Set<number> | number[] }): OwnershipMap {
  const keyLines = params.keyLines instanceof Set ? params.keyLines : new Set(params.keyLines || []);
  const sorted = [...params.lines].sort((a, b) => lineNumber(a) - lineNumber(b));
  const classes = classifyLines(sorted, keyLines);
  const questionOwner = new Map<number, string>();
  for (const q of params.questions || []) {
    for (const n of spanLines([...(q.spans || []), ...(q.options || []).flatMap(o => o.spans || []), ...(q.tables || []).flatMap(t => t.spans || [])])) if (!questionOwner.has(n)) questionOwner.set(n, q.id);
  }
  const entries: OwnershipEntry[] = [];
  // State machine over exam territory: what was the last anchor we passed?
  let lastAnchor: 'none' | 'question' | 'section' | 'orphan-number' = 'none';
  for (const line of sorted) {
    const n = lineNumber(line);
    const cls = classes.get(n)!;
    if (cls.barrier === 'key') { entries.push({ line: n, owner: 'skipped', reason: 'key territory' }); continue; }
    if (cls.skipped) { entries.push({ line: n, owner: 'skipped', reason: line.tag || (line.furniture ? 'furniture' : 'blank') }); continue; }
    if (questionOwner.has(n)) { entries.push({ line: n, owner: 'question', ownerId: questionOwner.get(n), reason: 'span' }); lastAnchor = 'question'; continue; }
    if (cls.sectionLevel) { entries.push({ line: n, owner: 'section', reason: cls.barrier! }); lastAnchor = 'section'; continue; }
    if (cls.barrier === 'printed-number') { entries.push({ line: n, owner: 'unowned', reason: 'unclaimed printed number' }); lastAnchor = 'orphan-number'; continue; }
    if (lastAnchor === 'none' || lastAnchor === 'section') { entries.push({ line: n, owner: 'section', reason: lastAnchor === 'none' ? 'front matter' : 'section preamble' }); continue; }
    entries.push({ line: n, owner: 'unowned', reason: lastAnchor === 'question' ? 'after question, unclaimed' : 'body of unclaimed number' });
  }
  const territory = entries.filter(e => e.owner !== 'skipped').length;
  const orphanLineNos = entries.filter(e => e.owner === 'unowned').map(e => e.line);
  return { entries, territory, orphanLineNos, orphanRate: territory ? orphanLineNos.length / territory : 0 };
}

export function computeDocOwnership(doc: ExamDoc): OwnershipMap {
  return computeOwnership({ lines: doc.source?.lines || [], questions: doc.questions || [], sections: doc.sections || [], keyLines: doc.source?.keyTerritoryLineNos || [] });
}

/** B3 flag: info ≤2%, warn above. */
export function orphanFlag(map: OwnershipMap): { code: 'ORPHAN_LINES'; severity: 'info' | 'warn'; message: string } | undefined {
  if (!map.orphanLineNos.length) return undefined;
  const pct = Math.round(map.orphanRate * 1000) / 10;
  const sample = map.orphanLineNos.slice(0, 12).map(n => `L${String(n).padStart(4, '0')}`).join(', ');
  return { code: 'ORPHAN_LINES', severity: map.orphanRate > 0.02 ? 'warn' : 'info', message: `${map.orphanLineNos.length} line(s) (${pct}% of exam territory) belong to no question or section: ${sample}${map.orphanLineNos.length > 12 ? ', …' : ''}.` };
}

/**
 * C3 — local section plan: anchors on header tags/detected headers first, then printed-number
 * contiguity. Returns SECTION_SPLIT_LOCAL splits for section ranges that contain another header.
 */
export function splitSectionsAtHeaders(rawSections: any[], lines: SourceLine[]): { sections: any[]; splits: Array<{ sectionId: string; atLine: number; title: string }> } {
  const headerLines = new Map(headerAnchors(lines).map(h => [h.headerLine, h]));
  const splits: Array<{ sectionId: string; atLine: number; title: string }> = [];
  if (!Array.isArray(rawSections) || !headerLines.size) return { sections: Array.isArray(rawSections) ? rawSections : [], splits };
  const out: any[] = [];
  for (const section of rawSections) {
    const spans = rawSpans(section?.spans);
    const ls = spanLines(spans);
    if (!ls.length) { out.push(section); continue; }
    const start = ls[0], end = ls[ls.length - 1];
    // The first header inside the range is the section's OWN header (front matter / instructions may
    // precede it); only subsequent headers prove the range swallowed another section.
    const inRange = [...headerLines.values()].filter(h => h.headerLine >= start && h.headerLine <= end).sort((a, b) => a.headerLine - b.headerLine);
    const inner = inRange.slice(1);
    if (!inner.length) { out.push(section); continue; }
    let cursor = start;
    const id = String(section?.id || `sec_${out.length + 1}`);
    inner.forEach((h, i) => {
      const piece = { ...section, id: i === 0 ? id : `${id}_split${i}`, spans: [[cursor, h.headerLine - 1]] };
      if (i > 0) { piece.title = inner[i - 1].title; piece.kind = inner[i - 1].kind; }
      out.push(piece);
      splits.push({ sectionId: id, atLine: h.headerLine, title: h.title });
      cursor = h.headerLine;
    });
    const lastHeader = inner[inner.length - 1];
    out.push({ ...section, id: `${id}_split${inner.length}`, title: lastHeader.title, kind: lastHeader.kind, spans: [[cursor, end]] });
  }
  return { sections: out.map((s, i) => ({ ...s, index: i + 1 })), splits };
}

/**
 * C1 — SECTION_CONTAINMENT: a question whose spans sit inside exactly one section's spans is
 * reassigned to it (SECTION_REASSIGNED); zero or several containing sections → caller flags an error.
 */
export function reassignSectionsByContainment(questions: Question[], sections: ExamSection[]): { questions: Question[]; reassigned: Array<{ questionId: string; from?: string; to: string }>; ambiguous: Array<{ questionId: string; candidates: string[] }> } {
  const reassigned: Array<{ questionId: string; from?: string; to: string }> = [];
  const ambiguous: Array<{ questionId: string; candidates: string[] }> = [];
  const sectionLines = sections.map(s => ({ id: s.id, set: new Set(spanLines(s.spans || [])) })).filter(s => s.set.size);
  if (!sectionLines.length) return { questions, reassigned, ambiguous };
  // Order-based territory: from a section's first line up to the next section's first line. Lazy
  // section spans (a header-only span) must not turn every question into an "ambiguous" error.
  const ordered = sectionLines.map(s => ({ id: s.id, start: Math.min(...s.set) })).sort((a, b) => a.start - b.start);
  const territoryOf = (id: string): [number, number] | undefined => {
    const i = ordered.findIndex(s => s.id === id);
    if (i < 0) return undefined;
    return [ordered[i].start, i + 1 < ordered.length ? ordered[i + 1].start - 1 : Number.MAX_SAFE_INTEGER];
  };
  const next = questions.map(q => {
    const qLines = spanLines(q.spans || []);
    if (!qLines.length) return q;
    const current = sectionLines.find(s => s.id === q.sectionId);
    const inside = (s: { set: Set<number> }) => qLines.filter(n => s.set.has(n)).length / qLines.length;
    if (current && inside(current) >= 0.8) return q;
    const inTerritory = (id: string) => { const t = territoryOf(id); return !!t && qLines.filter(n => n >= t[0] && n <= t[1]).length / qLines.length >= 0.8; };
    if (current && inTerritory(current.id)) return q;
    let containing = sectionLines.filter(s => inside(s) >= 0.8).map(s => s.id);
    if (containing.length !== 1) { const byTerritory = ordered.filter(s => inTerritory(s.id)).map(s => s.id); if (byTerritory.length === 1) containing = byTerritory; }
    if (containing.length === 1) {
      reassigned.push({ questionId: q.id, from: q.sectionId, to: containing[0] });
      return { ...q, sectionId: containing[0] };
    }
    if (containing.length !== 1 && (q.sectionId || containing.length > 1)) ambiguous.push({ questionId: q.id, candidates: containing });
    return q;
  });
  return { questions: next, reassigned, ambiguous };
}
