/**
 * Stage 2: Structure Pass Pipeline (§6.2)
 * Sends Line-Addressed Source (LAS) + image manifest to LLM with Prompt T1 and strict schema.
 */
import { ImageAsset, LLMRequest, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { T1_GEMINI_SCHEMA, T1_STRUCTURE_SYSTEM } from './prompts';
import { repairTruncatedJson } from '../utils/jsonRepair';
import { appendJournalCall, loadJournal, markJournalComplete } from './journal';
import { evaluateCoverage, enumerateExpectedQuestionNos, normalizeForMatching, matchingView, parsePrintedNumberFromStem } from './quality';


export interface StructurePassResult {
  sections: any[];
  rawQuestions: any[];
  meta: any;
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  rawText: string;
  label?: string;
  resumeLine?: number;
  attempts?: number;
  recoveryCalls?: number;
  finishReason?: string;
  flags?: any[];
  wireFormat?: 'v1' | 'v2';
  outputTokensSavedPct?: number;
  v1OutputTokenEstimate?: number;
  callUsage?: Array<{ label: string; inputTokens: number; outputTokens: number; cachedTokens?: number }>;
  /** True only if the (final) model response had json: null origin — such results must never be cached. */
  jsonNull?: boolean;
}

const WIRE_TYPES: Record<string, string> = { m: 'mcq', f: 'truefalse', b: 'fillblank', s: 'short', l: 'long', a: 'matching', u: 'multi', n: 'numeric', d: 'diagram', '?': 'unknown' };

function spansFromWire(value: any): Array<[number, number]> {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return [[value, value]];
  if (!Array.isArray(value)) return [];
  if (value.length === 2 && value.every(x => typeof x === 'number')) return [[Number(value[0]), Number(value[1])]];
  return value.flatMap((item: any) => spansFromWire(item));
}

/** Pure compact wire v2 expander. Unknown / legacy shapes pass through for v1 validation. */
export function expandWireV2(raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const hasV2 = Array.isArray(raw.q) || Array.isArray(raw.s) || Boolean(raw.m);
  const hasV1 = Array.isArray(raw.questions) || Array.isArray(raw.sections) || Boolean(raw.meta);
  if (!hasV2) return Array.isArray(raw.questions) ? { ...raw, __wireFormat: 'v1' } : raw;
  // Tolerate models mixing v2 keys with v1 long names/stem fields by using the v1 path.
  if (hasV1 || (raw.q || []).some((q: any) => q && ('stem' in q || 'stemText' in q || 'fullStem' in q || 'options' in q || 'spans' in q))) {
    if (Array.isArray(raw.questions)) return raw;
    const mixedQuestions = Array.isArray(raw.q) ? raw.q.map((q: any) => ({
      ...q,
      id: q?.id || (Number.isFinite(Number(q?.n ?? q?.no)) ? `q${Number(q.n ?? q.no)}` : undefined),
      label: q?.label || String(q?.no ?? q?.n ?? ''),
      no: q?.no ?? q?.n,
      sectionId: q?.sectionId ?? q?.s,
      spans: q?.spans ?? spansFromWire(q?.p),
      type: q?.type ?? WIRE_TYPES[q?.t] ?? q?.t,
    })) : [];
    return {
      ...raw,
      meta: raw.meta || (raw.m ? { subject: raw.m.subject, grade: raw.m.grade, totalPoints: raw.m.totalPoints, language: raw.m.language } : {}),
      sections: raw.sections || (raw.s || []).map((s: any) => ({ ...s, spans: s.spans ?? spansFromWire(s.p) })),
      questions: mixedQuestions,
      __wireFormat: 'v1',
    };
  }
  const questions = (raw.q || []).filter((q: any) => q && typeof q === 'object').map((q: any, index: number) => {
    const no = Number(q.n ?? q.no) || index + 1;
    const spans = spansFromWire(q.p ?? q.spans);
    const optionsRaw = q.o ?? q.options;
    let options: any[] | undefined;
    if (Array.isArray(optionsRaw)) {
      options = optionsRaw.map((pair: any, i: number) => {
        if (Array.isArray(pair)) return { key: String(pair[0] ?? String.fromCharCode(97 + i)), spans: spansFromWire(pair[1]) };
        return { key: String(pair?.key ?? String.fromCharCode(97 + i)), spans: spansFromWire(pair?.spans ?? pair?.p) };
      });
    }
    const answerSpanValue = q.a ?? q.answer?.spans;
    const imageValues = q.i ?? q.images;
    const tablesValue = q.x ?? q.tables;
    return {
      id: q.id || `q${no}${q.g !== undefined ? `_child_${index + 1}` : ''}`,
      label: String(q.label ?? no),
      no,
      ...(q.parentId ? { parentId: q.parentId } : q.g !== undefined ? { parentId: `q${Number(q.g)}` } : {}),
      ...(q.s || q.sectionId ? { sectionId: q.sectionId || q.s } : {}),
      spans,
      type: q.type || WIRE_TYPES[q.t] || 'unknown',
      ...(Number.isFinite(Number(q.v ?? q.points)) && (q.v ?? q.points) !== 0.5 ? { points: Number(q.v ?? q.points) } : {}),
      ...(options?.length ? { options } : {}),
      ...(answerSpanValue !== undefined ? { answer: { spans: spansFromWire(answerSpanValue) } } : {}),
      ...(Array.isArray(tablesValue) && tablesValue.length ? { tables: tablesValue.map((t: any) => ({ spans: spansFromWire(t?.spans ?? t?.p ?? t) })) } : {}),
      ...(Array.isArray(imageValues) && imageValues.length ? { images: imageValues.map((image: any) => typeof image === 'string' ? { imageId: image, role: 'stem' } : image) } : {}),
      confidence: typeof q.c === 'number' ? Math.max(0, Math.min(9, q.c)) / 10 : (typeof q.confidence === 'number' ? q.confidence : 0.9),
      ...(Array.isArray(q.flags) ? { flags: q.flags } : {}),
    };
  });
  const sections = (raw.s || []).filter((s: any) => s && typeof s === 'object').map((s: any, index: number) => ({
    id: String(s.id || `sec_${index + 1}`), index: Number(s.index) || index + 1, spans: spansFromWire(s.p ?? s.spans), ...(s.kind ? { kind: s.kind } : {}),
  }));
  const meta = raw.m ? {
    ...(raw.m.subject ? { subject: raw.m.subject } : {}), ...(raw.m.grade ? { grade: raw.m.grade } : {}),
    ...(typeof raw.m.totalPoints === 'number' ? { totalPoints: raw.m.totalPoints } : {}), ...(raw.m.language ? { language: raw.m.language } : {}),
  } : (raw.meta || {});
  return { questions, sections, meta, __wireFormat: 'v2' };
}

/** Unwrap envelopes, then expand wire v2; v1 payloads pass through unchanged. */
export function unwrapStructureData(data: any): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return expandWireV2(data);
  let unwrapped = data;
  if (!Array.isArray(data.questions) && !Array.isArray(data.q)) {
    for (const key of ['result', 'data', 'exam', 'output'] as const) {
      const env = data[key];
      if (env && typeof env === 'object' && !Array.isArray(env) && (Array.isArray(env.questions) || Array.isArray(env.q))) {
        unwrapped = { ...data, ...env, meta: env.meta ?? data.meta, m: env.m ?? data.m };
        break;
      }
    }
  }
  return expandWireV2(unwrapped);
}

function buildStructureShapeError(params: {
  finishReason?: string;
  rawText?: string;
  jsonNull: boolean;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
}): Error & any {
  const rawText = params.rawText || '';
  let message = `Structure response had no usable questions (finishReason=${params.finishReason || 'unknown'}; output chars=${rawText.length}).`;
  if (params.jsonNull && !rawText.includes('{')) {
    message = `Structure response had no usable questions (finishReason=${params.finishReason || 'unknown'}; output chars=${rawText.length}): reply was non-JSON prose/reasoning; use a non-reasoning instruct model or a higher output cap.`;
  }
  const flag = {
    id: 'flag_structure_shape_mismatch',
    severity: 'error' as const,
    code: 'STRUCTURE_SHAPE_MISMATCH',
    message,
  };
  const err: any = new Error(message);
  err.code = 'STRUCTURE_SHAPE_MISMATCH';
  err.flag = flag;
  err.flags = [flag];
  err.attempts = params.attempts;
  err.usage = params.usage;
  err.finishReason = params.finishReason;
  err.rawTextLength = rawText.length;
  return err;
}

export interface StructurePassParams {
  sourceLines: SourceLine[];
  images: ImageAsset[];
  languageHint?: string;
  latexEnabled: boolean;
  providerConfig: any;
  maxBudgetTokens?: number;
  journalKey?: string;
  journalEnabled?: boolean;
  onLiveText?: (label: string, channel: 'output' | 'reasoning' | 'info', fullText: string) => void;
  recoveryBudget?: { count: number };
  /** Force one bounded call per locally inferred section (long docs / weak models). */
  forceSectionMode?: boolean;
  /** Recovery may target only these printed numbers. */
  recoveryOnlyNumbers?: number[];
  onProgress?: (message: string) => void;
  /** Audit completed section calls immediately, including candidates later rejected or interrupted. */
  onCallUsage?: (call: { label: string; inputTokens: number; outputTokens: number; cachedTokens?: number }) => Promise<void>;
  existingRawQuestions?: any[];
  existingSections?: any[];
  existingMeta?: any;
}

export function coveredUntilLine(questions: any[]): number {
  let maximum = 0;
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.spans)) {
      for (const span of node.spans) {
        if (!Array.isArray(span)) continue;
        const endLine = Number(span[1]);
        if (Number.isFinite(endLine)) maximum = Math.max(maximum, endLine);
      }
    }
    for (const key of ['options', 'subQuestions', 'tables']) {
      if (Array.isArray(node[key])) node[key].forEach(visit);
    }
    if (node.answer) visit(node.answer);
  };
  if (Array.isArray(questions)) questions.forEach(visit);
  return maximum;
}

const COMPACT_T1_SCHEMA = {
  m: { subject: 'string?', grade: 'string?', totalPoints: 'number?', language: 'string?' },
  s: [{ id: 'string', index: 'number', p: 'line|range|ranges', kind: 'Listening|Vocabulary|Grammar|Reading|Writing|Other?' }],
  q: [{ n: 'printed number', s: 'section id?', t: 'm|f|b|s|l|a|u|n|d|?', p: 'line|range|ranges', v: 'points, omit 0.5', o: [['key', 'spans']], a: 'answer spans', c: '0..9, omit=9', i: ['image id'], x: ['table spans'], g: 'parent printed number?' }],
};

interface SectionPlan { id: string; index: number; title: string; start: number; end: number; expected: number[] }

function isSectionHeading(text: string): string | undefined {
  const value = normalizeForMatching(text).trim();
  const match = value.match(/^\s*(?:(?:section|part|unit)\s*|(?:بخش|قسمت)\s*)?\d{0,2}\s*[.)：:-]?\s*(listening|vocabulary|grammar|reading|writing|other|use of english|language focus|شنیداری|بخش شنیداری|واژگان|دستور زبان|گرامر|درک مطلب|نوشتاری|نگارش)\s*$/i);
  if (!match) return undefined;
  const view = matchingView(text.trim()); const start = match[0].lastIndexOf(match[1]);
  return text.trim().slice(view.originalOffset(start), view.originalOffset(start + match[1].length));
}

function makeSectionPlans(sourceLines: SourceLine[], expectedNumbers: number[], expectedLineByNo: Map<number, number>): SectionPlan[] {
  const sorted = [...sourceLines].sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
  if (!sorted.length) return [];
  const headings = sorted.flatMap((line, index) => {
    const title = line.furniture ? undefined : isSectionHeading(line.text);
    return title ? [{ index, title, line: Number(line.id.replace(/\D/g, '')) }] : [];
  });
  let boundaries: Array<{ start: number; end: number; title: string }> = [];
  // Section vocabulary is a title HINT only; geometry/enumeration determines bounded work windows.
  if (expectedNumbers.length > 25) {
    const ordered = [...expectedNumbers].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (let i = 0; i < ordered.length; i += 25) groups.push(ordered.slice(i, i + 25));
    boundaries = groups.map((group, i) => ({
      start: i === 0 ? Number(sorted[0].id.replace(/\D/g, '')) || 1 : expectedLineByNo.get(group[0]) || 1,
      end: i + 1 < groups.length ? (expectedLineByNo.get(groups[i + 1][0]) || Number(sorted[sorted.length - 1].id.replace(/\D/g, ''))) - 1 : Number(sorted[sorted.length - 1].id.replace(/\D/g, '')),
      title: `Question group ${i + 1}`,
    }));
  } else {
    // Layout fallback: use printed pages, then 80-line chunks. This avoids an unbounded mega-call.
    const pages = [...new Set(sorted.map(line => line.page))];
    if (pages.length > 1) {
      boundaries = pages.map(page => {
        const pageLines = sorted.filter(line => line.page === page);
        return { start: Number(pageLines[0].id.replace(/\D/g, '')), end: Number(pageLines[pageLines.length - 1].id.replace(/\D/g, '')), title: `Page ${page}` };
      });
    } else {
      for (let i = 0; i < sorted.length; i += 80) {
        const block = sorted.slice(i, i + 80);
        boundaries.push({ start: Number(block[0].id.replace(/\D/g, '')), end: Number(block[block.length - 1].id.replace(/\D/g, '')), title: `Section ${boundaries.length + 1}` });
      }
    }
  }
  if (boundaries.length > 1) {
    const firstQuestionLine = Math.min(...expectedNumbers.map(n => expectedLineByNo.get(n) || Infinity));
    if (Number.isFinite(firstQuestionLine) && firstQuestionLine < boundaries[0].start) boundaries[0].start = Number(sorted[0].id.replace(/\D/g, '')) || 1;
  }
  return boundaries.map((boundary, index) => {
    const id = `sec_${index + 1}`;
    const expected = expectedNumbers.filter(n => {
      const nLine = expectedLineByNo.get(n) || -1;
      return nLine >= boundary.start && nLine <= boundary.end;
    });
    return { id, index: index + 1, title: headings.find(h => h.line >= boundary.start && h.line <= boundary.end)?.title || boundary.title, start: boundary.start, end: boundary.end, expected };
  }).filter(plan => plan.end >= plan.start);
}

const sourceLineTextCache = new WeakMap<SourceLine[], Map<number, string>>();
function sourceLineTextByNumber(sourceLines: SourceLine[]): Map<number, string> {
  let map = sourceLineTextCache.get(sourceLines);
  if (!map) {
    map = new Map(sourceLines.map(line => [Number(line.id.replace(/\D/g, '')), line.text.replace(/^\[L\d+\]\s*/, '')]));
    sourceLineTextCache.set(sourceLines, map);
  }
  return map;
}
function shortSourceText(spans: any, sourceLines: SourceLine[], maxLines = 20): string {
  if (!Array.isArray(spans)) return '';
  const map = sourceLineTextByNumber(sourceLines);
  const output: string[] = [];
  let remaining = maxLines;
  for (const span of spans) {
    if (!Array.isArray(span) || span.length < 2 || remaining <= 0) continue;
    const start = Number(span[0]); const end = Math.min(Number(span[1]), start + remaining - 1);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
    for (let n = start; n <= end && remaining > 0; n++) {
      const text = map.get(n);
      if (text !== undefined) output.push(text);
      remaining--;
    }
  }
  return output.join('\n');
}

function rawQuestionNumber(q: any, sourceLines: SourceLine[]): number | undefined {
  const printed = parsePrintedNumberFromStem(shortSourceText(q?.spans, sourceLines));
  const n = printed ?? Number(q?.no ?? q?.n);
  return Number.isInteger(n) && n >= 1 && n <= 300 ? n : undefined;
}

function rawCoverageQuestions(rawQuestions: any[], sourceLines: SourceLine[]): any[] {
  const keyLines = enumerateExpectedQuestionNos(sourceLines).keyTerritory.lineNos;
  return rawQuestions.filter(q => {
    if (!Array.isArray(q?.spans)) return false;
    let checked = 0;
    for (const span of q.spans) {
      if (!Array.isArray(span) || span.length < 2) continue;
      const start = Number(span[0]); const end = Number(span[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
      for (let n = start; n <= end && checked < 5_000; n++, checked++) if (!keyLines.has(n)) return true;
    }
    return false;
  }).map(q => ({ ...q, stem: shortSourceText(q?.spans, sourceLines) }));
}

function rawQuestionIdentity(q: any, sourceLines: SourceLine[]): string | undefined {
  const number = rawQuestionNumber(q, sourceLines);
  if (number === undefined) return undefined;
  const firstSpan = Array.isArray(q?.spans) ? q.spans.find((span: any) => Array.isArray(span) && Number.isFinite(Number(span[0]))) : undefined;
  return `${number}@${firstSpan ? Number(firstSpan[0]) : 'unknown'}`;
}

function mergeRawByPrintedNumber(existing: any[], additions: any[], sourceLines: SourceLine[]): any[] {
  const merged = [...existing];
  const identity = (q: any) => rawQuestionIdentity(q, sourceLines);
  const seen = new Set(existing.map(identity).filter((key): key is string => Boolean(key)));
  for (const q of additions) {
    const key = identity(q);
    // Drop only the exact same printed occurrence repeated by an overlapping/recovery call.
    // Keep equal numbers anchored to different source lines so coverage can flag a real duplicate.
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(q);
  }
  return merged;
}

function makeCoverageFlags(rawQuestions: any[], sourceLines: SourceLine[], expected: number[], totalPoints?: number): any[] {
  const coverage = evaluateCoverage(expected, rawCoverageQuestions(rawQuestions, sourceLines), totalPoints);
  const flags: any[] = [];
  if (coverage.missing.length) flags.push({ code: 'COVERAGE_MISSING', severity: 'error', message: `Missing printed question numbers: ${coverage.missing.join(', ')}.` });
  if (coverage.duplicates.length) flags.push({ code: 'COVERAGE_DUPLICATE', severity: 'warn', message: `Duplicate printed question numbers: ${coverage.duplicates.join(', ')}.` });
  if (!coverage.pointsMatch) flags.push({ code: 'POINTS_MISMATCH', severity: 'warn', message: `Points total ${coverage.pointsParsed} does not match header ${totalPoints}; deficit ${coverage.pointDeficit}.` });
  return flags;
}

function attachWireTokenAccounting(result: StructurePassResult): StructurePassResult {
  const v1Payload = {
    meta: result.meta || {},
    sections: (result.sections || []).map(section => ({ id: section.id, index: section.index, title: section.title, instructions: section.instructions, spans: section.spans })),
    questions: (result.rawQuestions || []).map(q => ({
      id: q.id, label: q.label, no: q.no, parentId: q.parentId, sectionId: q.sectionId, spans: q.spans,
      type: q.type, points: q.points, options: q.options, answer: q.answer, tables: q.tables, images: q.images,
      rewrites: q.rewrites, confidence: q.confidence,
    })),
  };
  const v1OutputTokenEstimate = Math.ceil(JSON.stringify(v1Payload).length / 3.2);
  const observed = result.usage.outputTokens || Math.ceil((result.rawText || '').length / 3.2);
  const outputTokensSavedPct = v1OutputTokenEstimate > 0 ? Math.max(0, Math.min(100, (1 - observed / v1OutputTokenEstimate) * 100)) : 0;
  const accounted = { ...result, v1OutputTokenEstimate, outputTokensSavedPct };
  try {
    if ((import.meta as any).env?.DEV) console.table([{ wireFormat: accounted.wireFormat || 'v2', outputTokens: observed, v1SizingEstimate: v1OutputTokenEstimate, savedPercent: Number(outputTokensSavedPct.toFixed(1)) }]);
  } catch { /* import.meta.env may not exist in a test/runtime shell */ }
  return accounted;
}

function formatLas(sourceLines: SourceLine[], keyLines: Set<number>): string {
  let text = '';
  let currentPage = 0;
  for (const line of sourceLines) {
    if (line.page !== currentPage) { currentPage = line.page; text += `=== PAGE ${currentPage} ===\n`; }
    const n = Number(line.id.replace(/\D/g, ''));
    text += `[${line.id}] ${keyLines.has(n) ? '[KEY] ' : ''}${line.furniture ? '[FURNITURE] ' : ''}${line.text}\n`;
  }
  return text;
}

async function parseStructureResponse(response: any): Promise<any> {
  let data: any = unwrapStructureData(response?.json);
  if ((!Array.isArray(data?.questions) || data.questions.length === 0) && typeof response?.rawText === 'string' && response.rawText.includes('{')) {
    let parsed: any = null;
    try { parsed = JSON.parse(response.rawText); } catch { parsed = repairTruncatedJson(response.rawText); }
    data = unwrapStructureData(parsed);
  }
  return data;
}

function responseTripwires(data: any, plan: SectionPlan, sourceLines: SourceLine[], keyLines: Set<number>): string[] {
  const tripwires: string[] = [];
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  const seen = new Set<number>();
  const lineCount = sourceLines.reduce((maximum, line) => Math.max(maximum, Number(line.id.replace(/\D/g, '')) || 0), 0);
  const keyStart = keyLines.size ? [...keyLines].reduce((minimum, line) => Math.min(minimum, line), Infinity) : Infinity;
  let outOfBounds = false, keyQuestionSpan = false, undeclaredSection = false, duplicates = false;
  const declaredIds = new Set((data?.sections || []).map((section: any) => String(section.id)));
  for (const q of questions) {
    const number = rawQuestionNumber(q, sourceLines);
    if (number !== undefined && seen.has(number)) duplicates = true;
    if (number !== undefined) seen.add(number);
    const spans: any[] = [...(Array.isArray(q?.spans) ? q.spans : []), ...(Array.isArray(q?.options) ? q.options.flatMap((o: any) => Array.isArray(o?.spans) ? o.spans : []) : []), ...(Array.isArray(q?.tables) ? q.tables.flatMap((t: any) => Array.isArray(t?.spans) ? t.spans : []) : [])];
    for (const span of spans) if (!Array.isArray(span) || span[0] < 1 || span[1] > lineCount || span[0] > span[1]) outOfBounds = true;
    for (const span of spans) if (Array.isArray(span) && Number(span[1]) >= keyStart) keyQuestionSpan = true;
    if (q?.sectionId && declaredIds.size && !declaredIds.has(String(q.sectionId)) && q.sectionId !== plan.id) undeclaredSection = true;
  }
  const emitted = questions.map((q: any) => rawQuestionNumber(q, sourceLines)).filter((n: any) => n !== undefined);
  const missing = plan.expected.filter(n => !emitted.includes(n));
  if (missing.length) tripwires.push(`missing questions ${missing.join(',')}`);
  if (duplicates) tripwires.push('duplicate question numbers');
  if (outOfBounds) tripwires.push('spans outside source bounds');
  if (keyQuestionSpan) tripwires.push('question spans in key territory');
  if (undeclaredSection) tripwires.push('undeclared section ids');
  const declaredPoints = Number(data?.meta?.totalPoints);
  if (Number.isFinite(declaredPoints) && declaredPoints > 0) {
    const points = questions.reduce((sum: number, q: any) => sum + (Number(q.points) || 0), 0);
    if (Math.abs(points - declaredPoints) > 0.51) tripwires.push('points mismatch');
  }
  return tripwires;
}

function clipSpansBeforeKey(spans: any, sourceMin: number, sourceMax: number, keyStart: number): Array<[number, number]> {
  if (!Array.isArray(spans)) return [];
  return spans.flatMap((span: any) => {
    if (!Array.isArray(span) || span.length < 2) return [];
    const start = Math.max(sourceMin, Number(span[0]));
    const end = Math.min(sourceMax, keyStart - 1, Number(span[1]));
    return Number.isFinite(start) && Number.isFinite(end) && start <= end ? [[start, end] as [number, number]] : [];
  });
}

function sanitizeRawSectionQuestions(data: any, plan: SectionPlan, sourceLines: SourceLine[], keyLines: Set<number>): any[] {
  const bounds = sourceLines.reduce((range, line) => {
    const n = Number(line.id.replace(/\D/g, '')) || 0;
    return { min: Math.min(range.min, n || Infinity), max: Math.max(range.max, n) };
  }, { min: Infinity, max: 0 });
  const sourceMin = Number.isFinite(bounds.min) ? bounds.min : 1;
  const sourceMax = bounds.max;
  const keyStart = keyLines.size ? [...keyLines].reduce((minimum, line) => Math.min(minimum, line), Infinity) : Infinity;
  const seen = new Set<string>();
  return (Array.isArray(data?.questions) ? data.questions : []).flatMap((input: any) => {
    const q = { ...input };
    const identity = rawQuestionIdentity(q, sourceLines);
    if (identity && seen.has(identity)) return [];
    if (identity) seen.add(identity);
    const inKey = (Array.isArray(q.spans) ? q.spans : []).some((span: any) => Array.isArray(span) && Number(span[1]) >= keyStart);
    if (inKey) return [];
    q.spans = clipSpansBeforeKey(q.spans, sourceMin, sourceMax, keyStart);
    if (!q.spans.length) return [];
    q.options = (Array.isArray(q.options) ? q.options : []).map((option: any) => ({ ...option, spans: clipSpansBeforeKey(option?.spans, sourceMin, sourceMax, keyStart) })).filter((option: any) => option.spans.length);
    q.tables = (Array.isArray(q.tables) ? q.tables : []).map((table: any) => ({ ...table, spans: clipSpansBeforeKey(table?.spans, sourceMin, sourceMax, keyStart) })).filter((table: any) => table.spans.length);
    if (!q.sectionId || q.sectionId !== plan.id) q.sectionId = plan.id;
    if (!q.id) q.id = `q${rawQuestionNumber(q, sourceLines) ?? q.no ?? plan.index}`;
    if (!q.label) q.label = String(rawQuestionNumber(q, sourceLines) ?? q.no ?? plan.index);
    return [q];
  });
}

async function runSectionCall(params: StructurePassParams, plan: SectionPlan, allPlans: SectionPlan[], targetNumbers: number[], phase: string, priorQuestions: any[], priorSections: any[]): Promise<{ questions: any[]; sections: any[]; meta: any; usage: any; rawText: string; label: string; attempts: number; tripwires: string[] }> {
  const keyLines = enumerateExpectedQuestionNos(params.sourceLines).keyTerritory.lineNos;
  const sectionLines = params.sourceLines.filter(line => {
    const n = Number(line.id.replace(/\D/g, ''));
    return n >= plan.start && n <= plan.end;
  });
  const normalizedTargets = targetNumbers.map(String);
  const keyAnswerLines = params.sourceLines.filter(line => keyLines.has(Number(line.id.replace(/\D/g, ''))));
  const relevantKeyLines = keyAnswerLines.length <= 160 || !targetNumbers.length
    ? keyAnswerLines
    : keyAnswerLines.filter(line => normalizedTargets.some(n => new RegExp(`(?:^|\\D)${n}\\s*[.)：:-]`).test(normalizeForMatching(line.text))));
  const lines = [...new Map([...sectionLines, ...relevantKeyLines].map(line => [line.id, line])).values()].sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
  const manifest = params.images.filter(img => img.anchorLine && img.anchorLine >= plan.start && img.anchorLine <= plan.end).map(img => ({ id: img.id, page: img.page, nearLine: img.anchorLine }));
  const las = formatLas(lines, keyLines);
  const rangeText = targetNumbers.length ? `REQUIRED PRINTED QUESTIONS: ${targetNumbers.join(', ')}. Do not omit any listed number; output only these questions plus the section spans.` : 'Output all questions from this section.';
  const keyPreamble = keyLines.size ? 'Lines after the key marker are the official answer key; use them ONLY for answer spans. [KEY] lines are excluded from the question hunt.\n' : '';
  const sessionMemory = priorQuestions.length ? `SESSION MEMORY: already parsed numbers ${priorQuestions.map(q => rawQuestionNumber(q, params.sourceLines)).filter(Boolean).join(',')}; section ids ${priorSections.map(s => s.id).join(',')}. Do not repeat existing question numbers.\n` : '';
  const retryHint = phase.includes('hint') ? `\nYour previous output missed ${targetNumbers.join(', ')}; output ONLY the missing numbers, with valid spans.\n` : '';
  const text = `${keyPreamble}CONFIG: ${JSON.stringify({ latex: params.latexEnabled, languageHint: params.languageHint || null })}\n${sessionMemory}${rangeText}${retryHint}\nSECTION ${plan.index}/${allPlans.length} ${plan.title} (${plan.start}-${plan.end})\nIMAGE MANIFEST: ${JSON.stringify(manifest)}\nSOURCE:\n${las}\nWIRE FORMAT: compact JSON v2. ${JSON.stringify(COMPACT_T1_SCHEMA)}`;
  const budget = params.maxBudgetTokens || 16384;
  const maxOutputTokens = Math.min(budget, Math.max(2048, Math.ceil(Math.max(lines.length * 12, lines.reduce((s, l) => s + l.text.length, 0) / 3.2 * 0.3) * 1.25)));
  const label = phase.startsWith('recovery') ? `Structure Recovery ${phase}: ${plan.id}` : `Structure Section: ${plan.id} [${plan.index}/${allPlans.length}] ${plan.title}`;
  const request: LLMRequest = { role: 'fast', system: T1_STRUCTURE_SYSTEM, text, jsonSchema: params.providerConfig?.kind === 'gemini' ? T1_GEMINI_SCHEMA : undefined, maxOutputTokens, label, providerConfig: params.providerConfig };
  const response = await LLMAdapter.execute(request, {
    onDelta: (channel, full) => params.onLiveText?.(label, channel, full),
    onInfo: note => params.onLiveText?.(label, 'info', note),
    salvagePartial: true,
  });
  await params.onCallUsage?.({ label, ...response.usage });
  if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: response.rawText, reasoningText: response.reasoningText, finishReason: response.finishReason, usage: response.usage, complete: true });
  const data = await parseStructureResponse(response);
  const tripwires = responseTripwires(data, { ...plan, expected: targetNumbers }, params.sourceLines, keyLines);
  let questions = sanitizeRawSectionQuestions(data, plan, params.sourceLines, keyLines);
  let sections = Array.isArray(data?.sections) ? data.sections.map((s: any) => ({ ...s, id: plan.id, index: plan.index, spans: Array.isArray(s.spans) ? s.spans : [] })) : [];
  if (!sections.length) sections = [{ id: plan.id, index: plan.index, spans: [[plan.start, plan.end]], kind: plan.title }];
  const totalPoints = data?.meta?.totalPoints;
  return { questions, sections, meta: data?.meta || {}, usage: response.usage, rawText: response.rawText, label, attempts: 1, tripwires };
}

async function runSectionedStructurePass(params: StructurePassParams, options: { expected: number[]; lineByNumber: Map<number, number>; existing?: StructurePassResult; recoveryOnly?: number[] }): Promise<StructurePassResult> {
  const expected = options.expected;
  const plans = makeSectionPlans(params.sourceLines, expected, options.lineByNumber);
  const budget = params.recoveryBudget || (params.recoveryBudget = { count: 0 });
  const existingQuestions = [...(options.existing?.rawQuestions || params.existingRawQuestions || [])];
  const mergedQuestions = [...existingQuestions];
  const mergedSections = [...(options.existing?.sections || params.existingSections || [])];
  const meta = { ...(options.existing?.meta || params.existingMeta || {}) };
  let inputTokens = options.existing?.usage.inputTokens || 0;
  let outputTokens = options.existing?.usage.outputTokens || 0;
  let cachedTokens = options.existing?.usage.cachedTokens || 0;
  let attempts = options.existing?.attempts || 0;
  const flags = [...(options.existing?.flags || [])];
  const callUsage = [...(options.existing?.callUsage || [])];
  const journal = params.journalEnabled && params.journalKey ? await loadJournal(params.journalKey) : undefined;
  const resumed = new Set<string>();
  if (journal && !journal.complete && !options.recoveryOnly) {
    for (const plan of plans) {
      const prior = [...journal.calls].reverse().find(call => call.complete && call.label.startsWith(`Structure Section: ${plan.id} `));
      if (!prior) continue;
      let recovered: any = null;
      try { recovered = unwrapStructureData(JSON.parse(prior.rawText)); } catch { recovered = unwrapStructureData(repairTruncatedJson(prior.rawText)); }
      if (!Array.isArray(recovered?.questions) && !Array.isArray(recovered?.sections)) continue;
      const sanitized = sanitizeRawSectionQuestions(recovered, plan, params.sourceLines, enumerateExpectedQuestionNos(params.sourceLines).keyTerritory.lineNos);
      const found = new Set(sanitized.map(q => rawQuestionNumber(q, params.sourceLines)));
      if (plan.expected.length && !plan.expected.every(n => found.has(n))) continue;
      mergedQuestions.push(...sanitized);
      mergedSections.push(...(recovered.sections || [{ id: plan.id, index: plan.index, spans: [[plan.start, plan.end]], kind: plan.title }]));
      meta.subject ||= recovered.meta?.subject; meta.grade ||= recovered.meta?.grade; meta.totalPoints ||= recovered.meta?.totalPoints; meta.language ||= recovered.meta?.language;
      resumed.add(plan.id);
      params.onProgress?.(`Section ${plan.index}/${plans.length} · ${plan.title} · ${plan.expected.length} questions ✓ (journal)`);
    }
  }
  const targetSet = new Set(options.recoveryOnly || []);
  const recoveryAttemptsBySection = new Map<string, number>();
  const runPlan = async (plan: SectionPlan, targetNumbers: number[], phase: string, isRecovery: boolean) => {
    const sectionRecoveryCount = recoveryAttemptsBySection.get(plan.id) || 0;
    if (isRecovery && (budget.count >= 8 || sectionRecoveryCount >= 2)) return;
    if (isRecovery) {
      budget.count++;
      recoveryAttemptsBySection.set(plan.id, sectionRecoveryCount + 1);
    }
    const result = await runSectionCall(params, plan, plans, targetNumbers, phase, mergedQuestions, mergedSections);
    attempts += result.attempts;
    inputTokens += result.usage.inputTokens || 0; outputTokens += result.usage.outputTokens || 0; cachedTokens += result.usage.cachedTokens || 0;
    callUsage.push({ label: result.label, inputTokens: result.usage.inputTokens || 0, outputTokens: result.usage.outputTokens || 0, cachedTokens: result.usage.cachedTokens || 0 });
    let chosen = result;
    // G2: reject a badly malformed response and make exactly one corrective re-request.
    if (result.tripwires.length >= 3 && budget.count < 8 && (recoveryAttemptsBySection.get(plan.id) || 0) < 2) {
      flags.push({ code: 'STRUCTURE_TRIPWIRES_RETRY', severity: 'warn', message: `${plan.title}: rejected output with ${result.tripwires.length} tripwires; corrective retry requested.` });
      budget.count++;
      recoveryAttemptsBySection.set(plan.id, (recoveryAttemptsBySection.get(plan.id) || 0) + 1);
      const retry = await runSectionCall(params, plan, plans, targetNumbers, `${phase} hint`, mergedQuestions, mergedSections);
      attempts += retry.attempts; inputTokens += retry.usage.inputTokens || 0; outputTokens += retry.usage.outputTokens || 0; cachedTokens += retry.usage.cachedTokens || 0;
      callUsage.push({ label: retry.label, inputTokens: retry.usage.inputTokens || 0, outputTokens: retry.usage.outputTokens || 0, cachedTokens: retry.usage.cachedTokens || 0 });
      chosen = retry;
    }
    if (Object.keys(meta).length === 0) Object.assign(meta, chosen.meta);
    const already = new Set(mergedQuestions.map(q => rawQuestionIdentity(q, params.sourceLines)).filter((key): key is string => Boolean(key)));
    const additions = chosen.questions.filter(q => {
      const key = rawQuestionIdentity(q, params.sourceLines);
      if (!key || already.has(key)) return false;
      already.add(key);
      return true;
    });
    mergedQuestions.push(...additions);
    mergedSections.push(...chosen.sections);
    return chosen.tripwires;
  };

  // Initial G1 per-section calls. Resume skips complete, valid section entries.
  for (const plan of plans) {
    if (resumed.has(plan.id)) continue;
    if (options.recoveryOnly && !plan.expected.some(n => targetSet.has(n))) continue;
    const targets = options.recoveryOnly ? plan.expected.filter(n => targetSet.has(n)) : plan.expected;
    await runPlan(plan, targets, options.recoveryOnly ? 'recovery-ui' : 'initial', Boolean(options.recoveryOnly));
    const found = new Set(mergedQuestions.map(q => rawQuestionNumber(q, params.sourceLines)).filter((n): n is number => n !== undefined));
    const missingInSection = targets.filter(n => !found.has(n));
    params.onProgress?.(`Section ${plan.index}/${plans.length} · ${plan.title} · ${targets.length} questions ${missingInSection.length ? `— missing ${missingInSection.join(', ')}` : '✓'}`);
  }

  // A3: at most 2 rounds, max 3 affected sections in each round, ≤8 recovery calls total.
  let recoveryRounds = 0;
  for (let round = 1; round <= 2; round++) {
    const coverage = evaluateCoverage(expected, rawCoverageQuestions(mergedQuestions, params.sourceLines), meta.totalPoints);
    if (coverage.missing.length === 0) break;
    const affected = plans.filter(plan => plan.expected.some(n => coverage.missing.includes(n))).slice(0, 3);
    if (!affected.length) break;
    recoveryRounds++;
    for (const plan of affected) {
      if (budget.count >= 8) break;
      const missingForSection = plan.expected.filter(n => coverage.missing.includes(n));
      await runPlan(plan, missingForSection, `recovery-${round}`, true);
    }
  }
  const finalCoverage = evaluateCoverage(expected, rawCoverageQuestions(mergedQuestions, params.sourceLines), meta.totalPoints);
  const parsedAnyQuestions = rawCoverageQuestions(mergedQuestions, params.sourceLines).length > 0;
  const coverageFlags = makeCoverageFlags(mergedQuestions, params.sourceLines, expected, meta.totalPoints);
  flags.push(...coverageFlags);
  if (!parsedAnyQuestions) flags.push({ code: 'STRUCTURE_EMPTY', severity: 'error', message: 'No questions were reconstructed outside answer-key territory; the document remains incomplete.' });
  if (recoveryRounds) flags.push({ code: 'COVERAGE_RECOVERY_USED', severity: 'info', message: `Used ${recoveryRounds} missing-coverage recovery round(s); ${budget.count} recovery call(s) consumed.` });
  const dedupSections = [...new Map(mergedSections.map((section: any, i: number) => [String(section.id || `sec_${i}`), section])).values()];
  const complete = finalCoverage.complete && parsedAnyQuestions;
  if (complete && params.journalEnabled && params.journalKey) await markJournalComplete(params.journalKey);
  const wireFormat = 'v2' as const;
  return {
    sections: dedupSections, rawQuestions: mergeRawByPrintedNumber([], mergedQuestions, params.sourceLines), meta,
    usage: { inputTokens, outputTokens, cachedTokens }, rawText: 'Merged from section calls', attempts, recoveryCalls: budget.count, callUsage,
    finishReason: complete ? 'sectioned-complete' : 'sectioned-partial', flags,
    wireFormat, jsonNull: !complete,
  };
}

export async function runStructurePass(params: StructurePassParams): Promise<StructurePassResult> {
  const expected = enumerateExpectedQuestionNos(params.sourceLines);
  const model = String(params.providerConfig?.model || '').toLowerCase();
  const weakModel = /(?:free|lite|mini|small|tiny|(?:^|[-_])(?:3|4|5|7|8|9)b(?:[-_]|$))/i.test(model) || Number(params.maxBudgetTokens || 0) > 0 && Number(params.maxBudgetTokens) < 8192;
  const forceSections = Boolean(params.forceSectionMode || weakModel || expected.numbers.length > 25 || params.sourceLines.length > 220 || params.recoveryOnlyNumbers?.length);
  if (forceSections) {
    const sectioned = await runSectionedStructurePass(params, { expected: expected.numbers, lineByNumber: expected.lineByNumber, recoveryOnly: params.recoveryOnlyNumbers });
    return attachWireTokenAccounting(sectioned);
  }
  const result = await runSingleStructurePass(params);
  const coverage = evaluateCoverage(expected.numbers, rawCoverageQuestions(result.rawQuestions, params.sourceLines), result.meta?.totalPoints);
  const recoveryBudget = params.recoveryBudget || (params.recoveryBudget = { count: 0 });
  if (coverage.missing.length) {
    const recovery = await runSectionedStructurePass({ ...params, recoveryBudget }, {
      expected: expected.numbers, lineByNumber: expected.lineByNumber, existing: result, recoveryOnly: coverage.missing,
    });
    return attachWireTokenAccounting(recovery);
  }
  const coverageFlags = makeCoverageFlags(result.rawQuestions, params.sourceLines, expected.numbers, result.meta?.totalPoints);
  result.flags = [...(result.flags || []), ...coverageFlags];
  result.recoveryCalls = recoveryBudget.count;
  result.wireFormat ||= 'v2';
  return attachWireTokenAccounting(result);
}

async function runSingleStructurePass(params: StructurePassParams): Promise<StructurePassResult> {
  const { sourceLines, images, languageHint, latexEnabled, providerConfig, maxBudgetTokens } = params;
  const recoveryBudget = params.recoveryBudget || (params.recoveryBudget = { count: 0 });
  const consumeRecovery = () => { if (recoveryBudget.count >= 8) return false; recoveryBudget.count++; return true; };

  // LAS includes stable line IDs; answer-key territory remains addressable but is locally marked.
  const keyTerritory = enumerateExpectedQuestionNos(sourceLines).keyTerritory;
  const lasText = formatLas(sourceLines, keyTerritory.lineNos);

  // Format Image Manifest (IDs, page, near line — NO pixels!)
  const manifestEntries = images.map(img => ({
    id: img.id,
    page: img.page,
    nearLine: img.anchorLine || 'unknown',
  }));

  const isGemini = providerConfig?.kind === 'gemini';

  const keyPreamble = keyTerritory.lineNos.size ? `Lines after line ${keyTerritory.markerLine} are the official answer key; use them ONLY for answer spans. [KEY] lines are excluded from the question hunt.\n\n` : '';
  let userPrompt = `${keyPreamble}CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint: languageHint || null })}\nIMAGE MANIFEST: ${JSON.stringify(manifestEntries)}\nSOURCE:\n${lasText}\nWIRE FORMAT: compact JSON v2. ${JSON.stringify(COMPACT_T1_SCHEMA)}`;

  // For non-Gemini providers, embed a compact JSON schema directly in user prompt
  if (!isGemini) {
    userPrompt += `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA, null, 2)}`;
  }

  // If source text > 120k characters, chunk by pages (rare for exams, but supported per §5.8 & §10)
  if (lasText.length > 120_000) {
    return attachWireTokenAccounting(await runChunkedStructurePass(params, lasText, manifestEntries));
  }

  // Size from exam density while respecting the user's configured ceiling.
  const budgetCap = maxBudgetTokens || 16384;
  const estimatedInput = Math.ceil(lasText.length / 3.2);
  const estimatedOutput = Math.max(estimatedInput * 0.25, sourceLines.length * 14);
  const baseCap = Math.min(budgetCap, Math.max(8192, Math.ceil(estimatedOutput * 1.25)));

  const request: LLMRequest = {
    role: 'fast',
    system: T1_STRUCTURE_SYSTEM,
    text: userPrompt,
    jsonSchema: isGemini ? T1_GEMINI_SCHEMA : undefined,
    maxOutputTokens: baseCap,
    label: 'Structure Pass',
    providerConfig,
  };

  let attempts = 1;
  // Recover the newest journal partial only via ordinary salvage/repair + structure validation.
  if (params.journalEnabled && params.journalKey) {
    const journal = await loadJournal(params.journalKey);
    if (journal && !journal.complete) {
      let recovered: any = null; let recoveredRaw = ''; let recoveredWasRepaired = false;
      for (const call of [...journal.calls].reverse()) {
        if (!call.rawText?.includes('{')) continue;
        let parsed: any = null; let wasRepaired = false;
        try { parsed = JSON.parse(call.rawText); } catch { parsed = repairTruncatedJson(call.rawText); wasRepaired = parsed !== null; }
        parsed = unwrapStructureData(parsed);
        if (Array.isArray(parsed?.questions) && parsed.questions.length) { recovered = parsed; recoveredRaw = call.rawText; recoveredWasRepaired = wasRepaired; break; }
      }
      if (recovered) {
        const questions = [...recovered.questions]; const sections = [...(recovered.sections || [])];
        const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        const resumedCallUsage = journal.calls.filter(call => call.complete && call.usage).map(call => ({ label: call.label, inputTokens: call.usage?.inputTokens || 0, outputTokens: call.usage?.outputTokens || 0, cachedTokens: call.usage?.cachedTokens || 0 }));
        let continuationCount = 0;
        let addedAtLeastOne = false; let covered = coveredUntilLine(questions);
        const expectedNumbers = enumerateExpectedQuestionNos(sourceLines).numbers;
        for (let round = 0; round < 2; round++) {
          const currentCoverage = evaluateCoverage(expectedNumbers, rawCoverageQuestions(questions, sourceLines), recovered.meta?.totalPoints);
          if (currentCoverage.complete && rawCoverageQuestions(questions, sourceLines).length > 0) break;
          if (round > 0 && !consumeRecovery()) break;
          const startLine = Math.max(1, covered - 1);
          const remaining = sourceLines.filter(line => Number(line.id.replace(/\D/g, '')) >= startLine);
          if (!remaining.length) break;
          const lastBySection: Record<string, number> = {};
          for (const q of questions) { const sid = q.sectionId || 'default'; lastBySection[sid] = Math.max(lastBySection[sid] || 0, Number(q.no) || 0); }
          const memory = `SESSION MEMORY (already established — do NOT repeat these): meta=${JSON.stringify(recovered.meta || {})}; sections=${JSON.stringify(sections.map(s => ({ id: s.id, title: String(s.title || '').slice(0, 40) })))}; lastQuestionNoBySection=${JSON.stringify(lastBySection)}; coveredSourceLines=1..${covered}. Reuse these section ids; continue question numbering after the given numbers; output ONLY questions/sections for the source below.`.slice(0, 1100);
          const lines = remaining.map(line => {
            const lineNo = Number(line.id.replace(/\D/g, ''));
            return `[${line.id}] ${keyTerritory.lineNos.has(lineNo) ? '[KEY] ' : ''}${line.furniture ? '[FURNITURE] ' : ''}${line.text}`;
          }).join('\n');
          const sourceMarker = request.text.indexOf('\nSOURCE:');
          const basePrefix = sourceMarker >= 0 ? request.text.slice(0, sourceMarker) : request.text;
          const configEnd = basePrefix.indexOf('\n');
          const withMemory = configEnd >= 0 ? `${basePrefix.slice(0, configEnd)}\n${memory}${basePrefix.slice(configEnd)}` : `${basePrefix}\n${memory}`;
          const contract = !isGemini ? `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA)}` : '';
          const continuationReq: LLMRequest = { ...request, text: `${withMemory}\n\nSOURCE (continuation):\n${lines}${contract}`, maxOutputTokens: Math.min(budgetCap, Math.max(4096, Math.ceil(Math.max(remaining.length * 14, remaining.reduce((n,l)=>n+l.text.length,0)/3.2*0.25)*1.25))), label: `Structure Pass (Journal Continuation ${round + 1})` };
          const continuation = await LLMAdapter.execute(continuationReq, { onDelta: (channel, full) => params.onLiveText?.(continuationReq.label, channel, full), onInfo: note => params.onLiveText?.(continuationReq.label, 'info', note), salvagePartial: true });
          continuationCount++;
          resumedCallUsage.push({ label: continuationReq.label, inputTokens: continuation.usage.inputTokens || 0, outputTokens: continuation.usage.outputTokens || 0, cachedTokens: continuation.usage.cachedTokens || 0 });
          if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: continuationReq.label, rawText: continuation.rawText, reasoningText: continuation.reasoningText, finishReason: continuation.finishReason, usage: continuation.usage, complete: true });
          usage.inputTokens += continuation.usage.inputTokens; usage.outputTokens += continuation.usage.outputTokens; usage.cachedTokens = (usage.cachedTokens || 0) + (continuation.usage.cachedTokens || 0);
          let part: any = unwrapStructureData(continuation.json);
          if (!Array.isArray(part?.questions) && continuation.json == null) part = unwrapStructureData(repairTruncatedJson(continuation.rawText));
          const seen = new Set(questions.map(q => rawQuestionIdentity(q, sourceLines)).filter((key): key is string => Boolean(key)));
          const added = (part?.questions || []).filter((q: any) => { const key = rawQuestionIdentity(q, sourceLines); if (!key || seen.has(key)) return false; seen.add(key); return true; });
          if (!added.length) break;
          addedAtLeastOne = true; questions.push(...added); sections.push(...(part.sections || [])); recovered.meta = recovered.meta || part.meta; covered = coveredUntilLine(questions);
          const lastSourceLine = sourceLines.reduce((maximum, line) => Math.max(maximum, Number(line.id.replace(/\D/g, '')) || 0), 0);
          if (covered >= lastSourceLine) break;
        }
        const resumedUsableQuestions = rawCoverageQuestions(questions, sourceLines);
        const resumedCoverage = evaluateCoverage(expectedNumbers, resumedUsableQuestions, recovered.meta?.totalPoints);
        const resumedComplete = resumedCoverage.complete && resumedUsableQuestions.length > 0;
        if (resumedComplete && params.journalEnabled && params.journalKey) await markJournalComplete(params.journalKey);
        const priorUsage = journal.calls.reduce((a, c) => ({ inputTokens: a.inputTokens + (c.usage?.inputTokens || 0), outputTokens: a.outputTokens + (c.usage?.outputTokens || 0), cachedTokens: (a.cachedTokens || 0) + (c.usage?.cachedTokens || 0) }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
        const resumeFlags = [
          { code: 'RESUMED_FROM_JOURNAL', message: `Recovered ${questions.length} question candidate(s) from a previous partial parse${addedAtLeastOne ? ' and continued the parse' : ''}.` },
          ...makeCoverageFlags(questions, sourceLines, expectedNumbers, recovered.meta?.totalPoints),
          ...(resumedUsableQuestions.length === 0 ? [{ code: 'STRUCTURE_EMPTY', severity: 'error', message: 'No questions were reconstructed outside answer-key territory.' }] : []),
          ...(!resumedComplete ? [{ code: 'PARTIAL_COVERAGE', severity: 'error', message: 'The resumed parse remains incomplete and will be persisted as partial.' }] : []),
          ...(recoveredWasRepaired ? [{ code: 'TRUNCATED_JSON_REPAIRED', message: `Recovered ${questions.length} questions from truncated JSON.` }] : []),
        ];
        return { sections, rawQuestions: questions, meta: recovered.meta || {}, usage: { inputTokens: priorUsage.inputTokens + usage.inputTokens, outputTokens: priorUsage.outputTokens + usage.outputTokens, cachedTokens: (priorUsage.cachedTokens || 0) + (usage.cachedTokens || 0) }, rawText: recoveredRaw, resumeLine: Math.max(1, covered - 1), attempts: journal.calls.filter(call => call.complete).length + continuationCount, callUsage: resumedCallUsage, finishReason: resumedComplete ? 'journal-resume-complete' : 'journal-resume-partial', flags: resumeFlags, jsonNull: !resumedComplete };
      }
    }
  }

  const streamOpts = (label: string) => {
    let output = '', reasoning = '', lastPersist = 0;
    return {
      onDelta: (channel: 'output' | 'reasoning', fullText: string) => {
        if (channel === 'output') output = fullText; else reasoning = fullText;
        params.onLiveText?.(label, channel, fullText);
        const now = Date.now();
        if (params.journalEnabled && params.journalKey && now - lastPersist >= 3000) {
          lastPersist = now;
          void appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: output, reasoningText: reasoning, complete: false });
        }
      },
      onInfo: (note: string) => params.onLiveText?.(label, 'info', note),
      salvagePartial: true,
    };
  };
  let response = await LLMAdapter.execute(request, streamOpts(request.label));
  if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: request.label, rawText: response.rawText, reasoningText: response.reasoningText, finishReason: response.finishReason, usage: response.usage, complete: true });
  let data: any = unwrapStructureData(response.json);
  const totalUsage = { ...response.usage };
  let finalFinishReason = response.finishReason;
  let finalRawText = response.rawText;

  // Truncation-only sizing ladder. Parseable wrong-shape replies fail fast.
  const truncated = (r: any) => r.finishReason === 'MAX_TOKENS' || r.finishReason === 'length' || r.finishReason === 'stream-died' || r.json == null;
  const caps = [Math.min(budgetCap, baseCap * 2), budgetCap];
  for (const cap of caps) {
    if (!truncated(response)) break;
    if (!consumeRecovery()) break;
    const retryReq = { ...request, maxOutputTokens: cap, label: `Structure Pass (Retry ${attempts + 1})` };
    const retryResponse = await LLMAdapter.execute(retryReq, streamOpts(retryReq.label));
    attempts++;
    if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: retryReq.label, rawText: retryResponse.rawText, reasoningText: retryResponse.reasoningText, finishReason: retryResponse.finishReason, usage: retryResponse.usage, complete: true });
    totalUsage.inputTokens += retryResponse.usage.inputTokens;
    totalUsage.outputTokens += retryResponse.usage.outputTokens;
    totalUsage.cachedTokens = (totalUsage.cachedTokens || 0) + (retryResponse.usage.cachedTokens || 0);
    response = retryResponse;
    data = unwrapStructureData(retryResponse.json);
    finalFinishReason = retryResponse.finishReason;
    finalRawText = retryResponse.rawText;
  }
  let repaired = false;
  if (response.json == null && finalRawText.includes('{')) {
    const recovered = repairTruncatedJson(finalRawText);
    const unwrapped = unwrapStructureData(recovered);
    if (Array.isArray(unwrapped?.questions) && unwrapped.questions.length > 0) {
      data = unwrapped;
      repaired = true;
    }
  }

  let questions = data && Array.isArray(data.questions) ? data.questions : [];

  if (questions.length === 0 && response.json == null && (finalFinishReason === 'length' || finalFinishReason === 'MAX_TOKENS' || finalFinishReason === 'stream-died') && finalRawText.includes('{')) {
    const chunked = await runChunkedStructurePass(params, lasText, manifestEntries);
    chunked.attempts = attempts + (chunked.attempts || 0);
    chunked.usage.inputTokens += totalUsage.inputTokens;
    chunked.usage.outputTokens += totalUsage.outputTokens;
    chunked.usage.cachedTokens = (chunked.usage.cachedTokens || 0) + (totalUsage.cachedTokens || 0);
    return chunked;
  }
  if (questions.length === 0 && response.json == null && !finalRawText.includes('{') && consumeRecovery()) {
    const enforcedReq = { ...request, maxOutputTokens: budgetCap, system: `${request.system}\n\nYour previous reply was prose, which is invalid. Output JSON only — first character { — no reasoning text in the reply.`, label: 'Structure Pass (Format Retry)' };
    const enforced = await LLMAdapter.execute(enforcedReq, streamOpts(enforcedReq.label));
    attempts++;
    if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label: enforcedReq.label, rawText: enforced.rawText, reasoningText: enforced.reasoningText, finishReason: enforced.finishReason, usage: enforced.usage, complete: true });
    totalUsage.inputTokens += enforced.usage.inputTokens;
    totalUsage.outputTokens += enforced.usage.outputTokens;
    totalUsage.cachedTokens = (totalUsage.cachedTokens || 0) + (enforced.usage.cachedTokens || 0);
    response = enforced;
    finalRawText = enforced.rawText;
    finalFinishReason = enforced.finishReason;
    data = unwrapStructureData(enforced.json);
    questions = Array.isArray(data?.questions) ? data.questions : [];
    if (!questions.length && enforced.json == null && finalRawText.includes('{')) {
      const recovered = unwrapStructureData(repairTruncatedJson(finalRawText));
      if (Array.isArray(recovered?.questions) && recovered.questions.length) { data = recovered; questions = recovered.questions; repaired = true; }
    }
  }

  if (questions.length === 0) {
    throw buildStructureShapeError({
      finishReason: finalFinishReason,
      rawText: finalRawText,
      jsonNull: response.json === null || response.json === undefined,
      attempts,
      usage: totalUsage,
    });
  }

  const needsContinuation = repaired || finalFinishReason === 'length' || finalFinishReason === 'MAX_TOKENS' || finalFinishReason === 'stream-died';
  if (needsContinuation && params.journalEnabled && params.journalKey) {
    // Route a recovered truncated prefix through the same journal continuation path on LAS after coverage.
    return runStructurePass(params);
  }
  let coverageCompleted = false;
  if (needsContinuation && !params.journalEnabled && questions.length > 0) {
    let covered = coveredUntilLine(questions);
    for (let round = 0; round < 2; round++) {
      if (round > 0 && !consumeRecovery()) break;
      const tail = sourceLines.filter(line => Number(line.id.replace(/\D/g, '')) >= Math.max(1, covered - 1));
      if (!tail.length) break;
      const lastNos: Record<string, number> = {};
      questions.forEach((q: any) => { const id = q.sectionId || 'default'; lastNos[id] = Math.max(lastNos[id] || 0, Number(q.no) || 0); });
      const memory = `SESSION MEMORY (already established — do NOT repeat these): meta=${JSON.stringify(data.meta || {})}; sections=${JSON.stringify((data.sections || []).map((s: any) => ({ id: s.id, title: String(s.title || '').slice(0,40) })))}; lastQuestionNoBySection=${JSON.stringify(lastNos)}; coveredSourceLines=1..${covered}. Reuse these section ids; continue question numbering after the given numbers; output ONLY questions/sections for the source below.`.slice(0,1100);
      const lineText = tail.map(line => `[${line.id}] ${line.furniture ? '[FURNITURE] ' : ''}${line.text}`).join('\n');
      const basePrefix = request.text.split('\n\nSOURCE:')[0];
      const configEnd = basePrefix.indexOf('\n');
      const withMemory = configEnd >= 0 ? `${basePrefix.slice(0, configEnd)}\n${memory}${basePrefix.slice(configEnd)}` : `${basePrefix}\n${memory}`;
      const prompt = `${withMemory}\n\nSOURCE (continuation):\n${lineText}${!isGemini ? `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA)}` : ''}`;
      const continuationReq: LLMRequest = { ...request, text: prompt, label: `Structure Pass (Continuation ${round + 1})`, maxOutputTokens: budgetCap };
      const cont = await LLMAdapter.execute(continuationReq, streamOpts(continuationReq.label));
      attempts++; totalUsage.inputTokens += cont.usage.inputTokens; totalUsage.outputTokens += cont.usage.outputTokens; totalUsage.cachedTokens = (totalUsage.cachedTokens || 0) + (cont.usage.cachedTokens || 0);
      let more: any = unwrapStructureData(cont.json);
      if (!Array.isArray(more?.questions) && cont.json == null) more = unwrapStructureData(repairTruncatedJson(cont.rawText));
      const existing = new Set(questions.map((q: any) => `${q.sectionId || ''}:${q.no}`));
      const additions = (more?.questions || []).filter((q: any) => { const key = `${q.sectionId || ''}:${q.no}`; if (existing.has(key)) return false; existing.add(key); return true; });
      if (!additions.length) break;
      questions.push(...additions); data.sections = [...(data.sections || []), ...(more.sections || [])]; covered = coveredUntilLine(questions); coverageCompleted = true;
      const lastSourceLine = sourceLines.reduce((maximum, line) => Math.max(maximum, Number(line.id.replace(/\D/g, '')) || 0), 0);
      if (covered >= lastSourceLine) break;
    }
  }

  // Token-Thrift Acceptance Check (§12 Test 1): expect output ≤ 12% of input
  const thriftRatio = totalUsage.inputTokens > 0
    ? (totalUsage.outputTokens / totalUsage.inputTokens) * 100
    : 0;
  console.log(
    `[Token-Thrift Audit] Structure Pass: in=${totalUsage.inputTokens}, out=${totalUsage.outputTokens} (ratio: ${thriftRatio.toFixed(1)}%, target: <=12%)`
  );

  const usableQuestions = rawCoverageQuestions(questions, sourceLines);
  const parsedCoverage = evaluateCoverage(
    enumerateExpectedQuestionNos(sourceLines).numbers,
    usableQuestions,
    data.meta?.totalPoints
  );
  const structureComplete = parsedCoverage.complete && usableQuestions.length > 0;
  if (params.journalEnabled && params.journalKey && !repaired && structureComplete) await markJournalComplete(params.journalKey);
  const wireFormat: 'v1' | 'v2' = data.__wireFormat === 'v1' ? 'v1' : 'v2';
  if (wireFormat === 'v1') console.info('[Structure] Model used legacy v1 JSON; tolerant expansion path accepted it.');
  return {
    sections: Array.isArray(data.sections) ? data.sections : [],
    rawQuestions: questions,
    meta: data.meta || {},
    usage: totalUsage,
    rawText: finalRawText,
    label: response.label || request.label,
    attempts,
    finishReason: finalFinishReason,
    wireFormat,
    callUsage: [{ label: response.label || request.label, inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens, cachedTokens: totalUsage.cachedTokens || 0 }],
    flags: [...(repaired ? [{ code: 'TRUNCATED_JSON_REPAIRED', message: `Recovered ${questions.length} questions from truncated JSON.` }] : []), ...(needsContinuation && !coverageCompleted ? [{ code: 'PARTIAL_COVERAGE', message: 'No additional questions were recovered during continuation.' }] : [])],
    jsonNull: !structureComplete || ((response.json === null || response.json === undefined) && !coverageCompleted),
  };
}

/** Sequential 80-line chunk fallback with overlap, session context, and bounded bisection. */
async function runChunkedStructurePass(params: any, _fullLas: string, manifest: any[]): Promise<StructurePassResult> {
  const { sourceLines, languageHint, latexEnabled, providerConfig } = params;
  const keyLines = enumerateExpectedQuestionNos(sourceLines).keyTerritory.lineNos;
  const isGemini = providerConfig?.kind === 'gemini';
  const budgetCap = params.maxBudgetTokens || 16384;
  const chunkSize = 80, overlap = 2;
  const mergedSections: any[] = [], mergedQuestions: any[] = [];
  let mergedMeta: any = {}; let totalInTokens = 0, totalOutTokens = 0, totalCachedTokens = 0, attempts = 0;
  let lastFinishReason: string | undefined, lastRawText = '', lastJsonNull = false;
  const callUsage: Array<{ label: string; inputTokens: number; outputTokens: number; cachedTokens: number }> = [];
  let capped = false;
  let repairedPartial = false;
  const sessionBrief = () => {
    const lastBySection: Record<string, number> = {};
    for (const q of mergedQuestions) { const id = q.sectionId || 'default'; lastBySection[id] = Math.max(lastBySection[id] || 0, Number(q.no) || 0); }
    const covered = coveredUntilLine(mergedQuestions);
    return `SESSION MEMORY (already established — do NOT repeat these): meta=${JSON.stringify(mergedMeta)}; sections=${JSON.stringify(mergedSections.map(s => ({ id: s.id, title: String(s.title || '').slice(0,40) })))}; lastQuestionNoBySection=${JSON.stringify(lastBySection)}; coveredSourceLines=1..${covered}. Reuse these section ids; continue question numbering after the given numbers; output ONLY questions/sections for the source below.`.slice(0, 1100);
  };
  const recordResponse = async (resp: any, label: string) => {
    attempts++;
    totalInTokens += resp.usage.inputTokens; totalOutTokens += resp.usage.outputTokens; totalCachedTokens += resp.usage.cachedTokens || 0;
    lastFinishReason = resp.finishReason; lastRawText = resp.rawText; lastJsonNull = resp.json == null;
    callUsage.push({ label, inputTokens: resp.usage.inputTokens || 0, outputTokens: resp.usage.outputTokens || 0, cachedTokens: resp.usage.cachedTokens || 0 });
    if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: resp.rawText, reasoningText: resp.reasoningText, finishReason: resp.finishReason, usage: resp.usage, complete: true });
  };
  const processChunk = async (lines: SourceLine[], label: string, depth: number): Promise<void> => {
    if (capped) return;
    if (depth > 0) {
      if (!params.recoveryBudget || params.recoveryBudget.count >= 8) { capped = true; return; }
      params.recoveryBudget.count++;
    }
    const las = lines.map(line => {
      const n = Number(line.id.replace(/\D/g, ''));
      return `[${line.id}] ${keyLines.has(n) ? '[KEY] ' : ''}${line.furniture ? '[FURNITURE] ' : ''}${line.text}`;
    }).join('\n');
    const start = Number(lines[0]?.id.replace(/\D/g,'')), end = Number(lines[lines.length-1]?.id.replace(/\D/g,''));
    const chunkManifest = manifest.filter((m:any) => { const n = Number(m.nearLine); return n >= start && n <= end; });
    const keyPreamble = keyLines.size ? 'Lines tagged [KEY] are official answer-key territory: use them ONLY for answer spans; never parse questions from them.\n' : '';
    const base = `${keyPreamble}CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint: languageHint || null })}\n${mergedQuestions.length ? sessionBrief() + '\n' : ''}\nIMAGE MANIFEST:\n${JSON.stringify(chunkManifest)}\n\nSOURCE CHUNK:\n${las}`;
    const schemaBlock = !isGemini ? `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA)}` : '';
    const inTokens = Math.ceil(lines.reduce((n,l)=>n+l.text.length,0) / 3.2);
    const est = Math.max(inTokens * .25, lines.length * 14);
    const cap = Math.min(budgetCap, Math.max(4096, Math.ceil(est * 1.25)));
    const req: LLMRequest = { role: 'fast', system: T1_STRUCTURE_SYSTEM, text: base + schemaBlock, jsonSchema: isGemini ? T1_GEMINI_SCHEMA : undefined, maxOutputTokens: cap, label, providerConfig };
    params.onProgress?.(`${label}: parsing source lines ${start}-${end} (attempt ${attempts + 1}).`);
    let liveOutput = '', liveReasoning = '', lastJournalWrite = 0;
    const opts = { onDelta: (channel: 'output'|'reasoning', fullText: string) => {
      if (channel === 'output') liveOutput = fullText; else liveReasoning = fullText;
      params.onLiveText?.(label, channel, fullText);
      if (params.journalEnabled && params.journalKey && Date.now() - lastJournalWrite >= 3000) {
        lastJournalWrite = Date.now();
        void appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: liveOutput, reasoningText: liveReasoning, complete: false });
      }
    }, onInfo: (note: string) => params.onLiveText?.(label, 'info', note), salvagePartial: true };
    const resp = await LLMAdapter.execute(req, opts); await recordResponse(resp, label);
    let data: any = unwrapStructureData(resp.json);
    const trunc = resp.finishReason === 'length' || resp.finishReason === 'MAX_TOKENS' || resp.finishReason === 'stream-died' || resp.json == null;
    let repaired = false;
    if (trunc && (!Array.isArray(data?.questions) || !data.questions.length) && resp.rawText.includes('{')) {
      const recovered = unwrapStructureData(repairTruncatedJson(resp.rawText));
      if (Array.isArray(recovered?.questions) && recovered.questions.length > 0) {
        data = recovered;
        repaired = true;
      }
    }
    const chunkQuestions = Array.isArray(data?.questions) ? data.questions : [];
    if (trunc && chunkQuestions.length === 0) {
      if (depth < 3 && lines.length >= 20) {
        const mid = Math.ceil(lines.length / 2);
        await processChunk(lines.slice(0, mid), `${label} (bisect A)`, depth + 1);
        await processChunk(lines.slice(Math.max(0, mid - 2)), `${label} (bisect B)`, depth + 1);
        return;
      }
      throw buildStructureShapeError({ finishReason: resp.finishReason, rawText: resp.rawText, jsonNull: resp.json == null, attempts, usage: { inputTokens: totalInTokens, outputTokens: totalOutTokens, cachedTokens: totalCachedTokens } });
    }
    if (trunc && repaired) repairedPartial = true;
    if (chunkQuestions.length) mergedQuestions.push(...chunkQuestions);
    if (Array.isArray(data?.sections)) mergedSections.push(...data.sections);
    if (data?.meta && !Object.keys(mergedMeta).length) mergedMeta = data.meta;
  };
  for (let i = 0, n = 0; i < sourceLines.length; i += chunkSize - overlap, n++) {
    await processChunk(sourceLines.slice(i, i + chunkSize), `Structure Pass (Chunk ${n + 1})`, 0);
    if (capped) break;
  }
  const questions = mergeRawByPrintedNumber([], mergedQuestions, sourceLines);
  const expected = enumerateExpectedQuestionNos(sourceLines).numbers;
  const usableQuestions = rawCoverageQuestions(questions, sourceLines);
  const coverage = evaluateCoverage(expected, usableQuestions, mergedMeta.totalPoints);
  const complete = coverage.complete && usableQuestions.length > 0 && !capped;
  const flags = makeCoverageFlags(questions, sourceLines, expected, mergedMeta.totalPoints);
  if (usableQuestions.length === 0) flags.push({ code: 'STRUCTURE_EMPTY', severity: 'error', message: 'No questions were reconstructed outside answer-key territory; the document remains incomplete.' });
  if (repairedPartial) flags.push({ code: 'TRUNCATED_JSON_REPAIRED', message: `Recovered ${questions.length} questions from truncated JSON.` });
  if (capped) flags.push({ code: 'PARTIAL_COVERAGE', message: 'Recovery call limit reached; returning recovered questions only.' });
  if (complete && params.journalEnabled && params.journalKey) await markJournalComplete(params.journalKey);
  return {
    sections: mergedSections, rawQuestions: questions, meta: mergedMeta,
    usage: { inputTokens: totalInTokens, outputTokens: totalOutTokens, cachedTokens: totalCachedTokens },
    rawText: 'Merged from chunks', attempts, finishReason: complete ? 'chunked-complete' : 'chunked-partial',
    flags, wireFormat: 'v2', callUsage, jsonNull: !complete,
  };
}
