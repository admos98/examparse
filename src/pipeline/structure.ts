/**
 * Stage 2: Structure Pass Pipeline (§6.2)
 * Sends Line-Addressed Source (LAS) + image manifest to LLM with Prompt T1 and strict schema.
 */
import { ImageAsset, LLMRequest, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { runTaskGraph } from './taskGraph';
import { T1_GEMINI_SCHEMA, T1_STRUCTURE_SYSTEM } from './prompts';
import { repairTruncatedJson } from '../utils/jsonRepair';
import { appendJournalCall, loadJournal, markJournalComplete } from './journal';
import { evaluateCoverage, enumerateExpectedQuestionNos, normalizeForMatching, matchingView, parsePrintedNumberFromStem, detectSectionHeaders } from './quality';
import { clipSpansBeforeLine, coerceLineSpan, isOffsetSpan, sliceNormalizedLineByOffsets, spanEndLine, spanStartLine } from './spans';
import { renderCleanView } from './cleanup';


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
  /** A4 — assembled memory guidance size for this job (0 with empty memory). */
  guidanceTokens?: number;
  guidanceDigest?: string;
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
    // D: wire `r` = [[line, text], ...] rewrite requests; fenced later by the assembly funnel.
    const rewriteRaw = q.r ?? q.rewrites;
    const rewrites = Array.isArray(rewriteRaw) ? rewriteRaw.flatMap((item: any) => {
      if (Array.isArray(item) && Number.isInteger(Number(item[0])) && typeof item[1] === 'string') return [{ line: Number(item[0]), text: item[1] }];
      if (item && typeof item === 'object' && Number.isInteger(Number(item.line)) && typeof item.text === 'string') return [{ line: Number(item.line), text: item.text }];
      return [];
    }) : [];
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
      ...(rewrites.length ? { rewrites } : {}),
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

/** B2 — segment wire v2 expander: {seg,action,type,points,options,answerSpans,images,confidence} → questions */
function expandSegmentWire(raw: any, segments: Array<{ seg: string; range: [number, number]; hint?: string }>): any {
  if (!raw || typeof raw !== 'object') return raw;
  const segActions: any[] = Array.isArray(raw.seg) ? raw.seg : Array.isArray(raw.segments) ? raw.segments : Array.isArray(raw.actions) ? raw.actions : [];
  if (!segActions.length) return raw;
  const bySeg = new Map(segments.map(s => [s.seg, s]));
  const questions: any[] = [];
  const skipped = new Set<string>();
  for (let i = 0; i < segActions.length; i++) {
    const a = segActions[i];
    if (!a || !a.seg || skipped.has(a.seg)) continue;
    const seg = bySeg.get(a.seg);
    if (!seg) continue;
    const action = String(a.action || 'accept').toLowerCase();
    const t = a.type || a.t;
    const type = WIRE_TYPES[t] || t || 'unknown';
    const points = (a.points ?? a.v);
    const confidence = typeof a.confidence === 'number' ? a.confidence : typeof a.c === 'number' ? a.c / 10 : 0.85;
    if (action === 'drop') continue;
    if (action === 'merge-next') {
      const nextAction = segActions[i + 1];
      const nextSeg = nextAction ? bySeg.get(nextAction.seg) : undefined;
      if (nextSeg) {
        // Merge current + next segment spans
        skipped.add(nextSeg.seg);
        const mergedSpan: [number, number] = [seg.range[0], nextSeg.range[1]];
        questions.push({
          n: a.n ?? nextAction?.n ?? questions.length + 1,
          p: [mergedSpan],
          t: type !== 'unknown' ? Object.keys(WIRE_TYPES).find(k => WIRE_TYPES[k] === type) || '?' : '?',
          ...(points !== undefined ? { v: points } : {}),
          ...(a.options || a.o ? { o: a.options || a.o } : {}),
          c: Math.round(confidence * 10),
          ...(a.answerSpans || a.a ? { a: a.answerSpans || a.a } : {}),
          ...(a.images || a.i ? { i: a.images || a.i } : {}),
        });
        continue;
      }
    }
    if (action === 'split') {
      // Split segment at second printed number boundary — naive: mid of range
      const mid = Math.floor((seg.range[0] + seg.range[1]) / 2);
      // Find split line as first line with printed number after start
      // For now use mid as split point; assembly's gap completion will extend
      const spans1: [number, number] = [seg.range[0], mid];
      const spans2: [number, number] = [mid + 1, seg.range[1]];
      questions.push({
        n: a.n ?? questions.length + 1,
        p: [spans1],
        t: type !== 'unknown' ? Object.keys(WIRE_TYPES).find(k => WIRE_TYPES[k] === type) || '?' : '?',
        ...(points !== undefined ? { v: points } : {}),
        c: Math.round(confidence * 10),
      });
      questions.push({
        n: (a.n ?? questions.length) + 1,
        p: [spans2],
        t: type !== 'unknown' ? Object.keys(WIRE_TYPES).find(k => WIRE_TYPES[k] === type) || '?' : '?',
        c: Math.round(confidence * 10),
      });
      continue;
    }
    // accept / relabel: use segment range as p
    questions.push({
      n: a.n ?? a.no ?? seg.range[0], // fallback to range start
      p: [[seg.range[0], seg.range[1]]],
      t: type !== 'unknown' ? Object.keys(WIRE_TYPES).find(k => WIRE_TYPES[k] === type) || '?' : (seg as any).kind === 'group-parent' ? 'a' : '?',
      ...(points !== undefined ? { v: points } : {}),
      ...(a.options || a.o ? { o: a.options || a.o } : {}),
      ...(a.answerSpans || a.a ? { a: a.answerSpans || a.a } : {}),
      ...(a.images || a.i ? { i: a.images || a.i } : {}),
      c: Math.round(confidence * 10),
    });
  }
  return { q: questions, s: raw.s || raw.sections, m: raw.m || raw.meta, __wireFormat: 'v2-seg' };
}

/** Unwrap envelopes, then expand wire v2 / segment wire; v1 payloads pass through unchanged. */
export function unwrapStructureData(data: any, opts?: { segments?: Array<{ seg: string; range: [number, number] }> }): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return expandWireV2(data);
  // B2: segment wire detection — if segments provided and raw contains seg/actions, use segment expander
  if (opts?.segments && (Array.isArray((data as any).seg) || Array.isArray((data as any).segments) || Array.isArray((data as any).actions))) {
    const segExpanded = expandSegmentWire(data, opts.segments);
    if (Array.isArray(segExpanded?.q) && segExpanded.q.length) return expandWireV2(segExpanded);
  }
  let unwrapped = data;
  // Also unwrap segActions nested in result/data/exam
  if (!Array.isArray(data.questions) && !Array.isArray(data.q) && !Array.isArray((data as any).seg)) {
    for (const key of ['result', 'data', 'exam', 'output'] as const) {
      const env = data[key];
      if (env && typeof env === 'object' && !Array.isArray(env) && (Array.isArray(env.questions) || Array.isArray(env.q) || Array.isArray((env as any).seg))) {
        unwrapped = { ...data, ...env, meta: env.meta ?? data.meta, m: env.m ?? data.m };
        if (opts?.segments && (Array.isArray((unwrapped as any).seg) || Array.isArray((unwrapped as any).segments))) {
          const segExpanded2 = expandSegmentWire(unwrapped, opts.segments);
          if (Array.isArray(segExpanded2?.q) && segExpanded2.q.length) return expandWireV2(segExpanded2);
        }
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
  /** 2E: bounded section parallelism (1–6, default 3) + node observer for the Step 3 node list. */
  parallelSections?: number;
  onNode?: (node: { id: string; label?: string; status: string; tokens?: number; error?: string }) => void;
  /** Audit completed section calls immediately, including candidates later rejected or interrupted. */
  onCallUsage?: (call: { label: string; inputTokens: number; outputTokens: number; cachedTokens?: number }) => Promise<void>;
  existingRawQuestions?: any[];
  existingSections?: any[];
  existingMeta?: any;
  /**
   * D1 — memory guidance (playbook subset) assembled ONCE per job and inherited by
   * every structure path (single/journal-resume/sectioned/chunked). Empty memory ⇒
   * empty block ⇒ the prompt bytes are identical to the pre-memory behaviour (D4).
   */
  guidance?: StructureGuidance;
  /** Reports the assembled guidance size so the bench/stage card can print it (A4). */
  onGuidance?: (guidance: StructureGuidance) => void;
  /** A4 hard cap for the playbook block (default 5,000 tokens). */
  guidanceCapTokens?: number;
  /** D — escalation model for sections whose lines are >40% locally garbled (one routed call per section, ≤2 per pass). */
  escalationProviderConfig?: any;
  garbledEscalationBudget?: { count: number; max: number };
  /** B2 — deterministic segments wire v2 (advisory, never executive). When present, model labels/classifies/corrects per segment. */
  segments?: Array<{ seg: string; kind: string; range: [number, number]; n?: number; childNos?: number[]; hint: string; preview: string }>;
  /** B4 — when true, skip segment wire and use legacy free-span flow */
  segmentFallback?: boolean;
}

export interface StructureGuidance {
  block: string;
  tokens: number;
  digest: string;
  entries: number;
  omitted: number;
}

const EMPTY_GUIDANCE: StructureGuidance = { block: '', tokens: 0, digest: 'Guidance: playbook 0 entries (0 tok).', entries: 0, omitted: 0 };

/** THE guidance assembly point for the structure role (D1). Memoized per params object. */
const guidanceCache = new WeakMap<object, StructureGuidance>();
export async function resolveStructureGuidance(params: StructurePassParams): Promise<StructureGuidance> {
  if (params.guidance) return params.guidance;
  const cached = guidanceCache.get(params);
  if (cached) { params.guidance = cached; return cached; }
  let guidance = EMPTY_GUIDANCE;
  try {
    const { assemblePipelineGuidance } = await import('./memory/guidance');
    const assembled = await assemblePipelineGuidance({
      sourceLines: params.sourceLines,
      images: params.images,
      sections: params.existingSections,
      languageHint: params.languageHint,
      modelId: String(params.providerConfig?.model || ''),
      role: 'fast',
      capTokens: params.guidanceCapTokens,
    });
    guidance = { block: assembled.text, tokens: assembled.tokens, digest: assembled.digest, entries: assembled.includedCount, omitted: assembled.omittedCount };
  } catch {
    guidance = EMPTY_GUIDANCE; // memory is advisory: a failure never changes the parse
  }
  guidanceCache.set(params, guidance);
  params.guidance = guidance;
  params.onGuidance?.(guidance);
  return guidance;
}

/** Structure system prompt + the delimited FIELD LESSONS block (empty ⇒ byte-identical). */
export function structureSystemPrompt(params: Pick<StructurePassParams, 'guidance'>): string {
  const block = params.guidance?.block;
  return block ? `${T1_STRUCTURE_SYSTEM}\n${block}` : T1_STRUCTURE_SYSTEM;
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
  // C3: anchor on header TAGS first (cleanup/AI/user), then the keyword detector, then printed-number contiguity.
  const detected = detectSectionHeaders(sourceLines);
  const taggedHeaders = sorted.filter(line => line.tag === 'header' && !detected.some(h => h.headerLine === Number(line.id.replace(/\D/g, ''))))
    .map(line => ({ title: isSectionHeading(line.text) || line.text.trim().slice(0, 60), headerLine: Number(line.id.replace(/\D/g, '')), kind: 'Other', start: Number(line.id.replace(/\D/g, '')), rawTitle: line.text.trim() }));
  const headerCandidates = [...detected, ...taggedHeaders].sort((a, b) => a.headerLine - b.headerLine);
  let boundaries: Array<{ start: number; end: number; title: string; kind?: string }> = [];
  if (headerCandidates.length >= 3 || (headerCandidates.length >= 2 && taggedHeaders.length > 0)) {
    const maxLine = Number(sorted[sorted.length - 1].id.replace(/\D/g, '')) || 1;
    const minLine = Number(sorted[0].id.replace(/\D/g, '')) || 1;
    for (let i=0;i<headerCandidates.length;i++) {
      const h = headerCandidates[i];
      const start = h.headerLine;
      const end = i+1 < headerCandidates.length ? (headerCandidates[i+1].headerLine - 1) : maxLine;
      boundaries.push({ start, end, title: h.title, kind: h.kind });
    }
    const firstQuestionLine = Math.min(...expectedNumbers.map(n => expectedLineByNo.get(n) || Infinity));
    if (Number.isFinite(firstQuestionLine) && firstQuestionLine < boundaries[0].start) boundaries[0].start = minLine;
  } else if (expectedNumbers.length > 25) {
    const ordered = [...expectedNumbers].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (let i = 0; i < ordered.length; i += 25) groups.push(ordered.slice(i, i + 25));
    boundaries = groups.map((group, i) => ({
      start: i === 0 ? Number(sorted[0].id.replace(/\D/g, '')) || 1 : expectedLineByNo.get(group[0]) || 1,
      end: i + 1 < groups.length ? (expectedLineByNo.get(groups[i + 1][0]) || Number(sorted[sorted.length - 1].id.replace(/\D/g, ''))) - 1 : Number(sorted[sorted.length - 1].id.replace(/\D/g, '')),
      title: `Question group ${i + 1}`,
    }));
  } else {
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
  if (boundaries.length > 1 && !(headerCandidates.length >= 3 || (headerCandidates.length >= 2 && taggedHeaders.length > 0))) {
    const firstQuestionLine = Math.min(...expectedNumbers.map(n => expectedLineByNo.get(n) || Infinity));
    if (Number.isFinite(firstQuestionLine) && firstQuestionLine < boundaries[0].start) boundaries[0].start = Number(sorted[0].id.replace(/\D/g, '')) || 1;
  }
  return boundaries.map((boundary, index) => {
    const id = `sec_${index + 1}`;
    const expected = expectedNumbers.filter(n => {
      const nLine = expectedLineByNo.get(n) || -1;
      return nLine >= boundary.start && nLine <= boundary.end;
    });
    const headingTitle = headings.find(h => h.line >= boundary.start && h.line <= boundary.end)?.title;
    const title = (boundary as any).kind ? boundary.title : (headingTitle || boundary.title);
    return { id, index: index + 1, title, start: boundary.start, end: boundary.end, expected };
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
  for (const raw of spans) {
    if (remaining <= 0) break;
    const span = coerceLineSpan(raw);
    if (!span) continue;
    if (isOffsetSpan(span)) {
      const text = map.get(span.line);
      if (text !== undefined) {
        const sliced = sliceNormalizedLineByOffsets(text, span.start, span.end).text;
        if (sliced) output.push(sliced);
      }
      remaining--;
      continue;
    }
    const start = span[0];
    const end = Math.min(span[1], start + remaining - 1);
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
    for (const raw of q.spans) {
      const span = coerceLineSpan(raw);
      if (!span) continue;
      const start = spanStartLine(span);
      const end = spanEndLine(span);
      for (let n = start; n <= end && checked < 5_000; n++, checked++) if (!keyLines.has(n)) return true;
    }
    return false;
  }).map(q => ({ ...q, stem: shortSourceText(q?.spans, sourceLines) }));
}

function rawQuestionIdentity(q: any, sourceLines: SourceLine[]): string | undefined {
  const number = rawQuestionNumber(q, sourceLines);
  if (number === undefined) return undefined;
  const firstCoerced = Array.isArray(q?.spans)
    ? q.spans.map((span: any) => coerceLineSpan(span)).find(Boolean)
    : undefined;
  return `${number}@${firstCoerced ? spanStartLine(firstCoerced) : 'unknown'}`;
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

/**
 * A4 — the structure prompt sees the CLEAN VIEW: cleanup tags rendered as prefixes
 * ([FURNITURE]/[KEY]/[HDR]/[INSTR]/[GARBLED?]), confirmed junk omitted. Line ids are the
 * original ids, so every span the model returns still references original line numbers.
 * Untagged lines render exactly as before cleanup existed.
 */
function formatLas(sourceLines: SourceLine[], keyLines: Set<number>): string {
  return renderCleanView(sourceLines, keyLines).text;
}

async function parseStructureResponse(response: any): Promise<any> {
  // E1: planAck handling — if model returns planAck, unwrap it as harmless ack (section plan accepted)
  try {
    const raw = response?.rawText || (response?.json ? JSON.stringify(response.json) : '');
    if (typeof raw === 'string' && raw.includes('planAck')) {
      let parsed:any=null;
      try { parsed = response?.json || JSON.parse(raw); } catch {}
      if (parsed && parsed.planAck) return { planAck: parsed.planAck, _isAck:true, sections:[], questions:[] };
      // Also handle v2 wrapper containing planAck
      if (parsed && parsed.sections && parsed.questions === undefined && parsed.planAck) return { planAck: parsed.planAck, _isAck:true, sections:[], questions:[] };
    }
  } catch {}
  let data: any = unwrapStructureData(response?.json);
  if (((data as any)?._isAck)) return data;
  if ((!Array.isArray(data?.questions) || data.questions.length === 0) && typeof response?.rawText === 'string' && response.rawText.includes('{')) {
    let parsed: any = null;
    try { parsed = JSON.parse(response.rawText); } catch { parsed = repairTruncatedJson(response.rawText); }
    data = unwrapStructureData(parsed);
  }
  return data;
}

export function responseTripwires(data: any, plan: SectionPlan, sourceLines: SourceLine[], keyLines: Set<number>, opts?: { segments?: Array<{ seg: string; range: [number, number] }>; segActions?: any[] }): string[] {
  if ((data as any)?._isAck) return [];
  const tripwires: string[] = [];
  // B3 seg handling: validate seg actions when segments wire used
  if (opts?.segments && opts?.segActions) {
    const segIds = new Set(opts.segments.map(s=>s.seg));
    const seenSeg = new Set<string>();
    const confidences: number[] = [];
    for (const a of opts.segActions) {
      if (!a?.seg) { tripwires.push('seg action missing seg id'); continue; }
      if (!segIds.has(a.seg)) tripwires.push(`seg ${a.seg} not in manifest`);
      if (seenSeg.has(a.seg)) tripwires.push(`duplicate seg ${a.seg}`);
      seenSeg.add(a.seg);
      const validActions = ['accept','relabel','split','merge-next','drop'];
      if (a.action && !validActions.includes(String(a.action).toLowerCase())) tripwires.push(`invalid seg action ${a.action} for ${a.seg}`);
      const conf = typeof a.confidence === 'number' ? a.confidence : typeof a.c === 'number' ? a.c/10 : undefined;
      if (conf !== undefined) {
        if (conf < 0 || conf > 1) tripwires.push(`confidence out of range for ${a.seg}`);
        confidences.push(conf);
      }
    }
    const unaddressed = [...segIds].filter(id=>!seenSeg.has(id));
    if (unaddressed.length && unaddressed.length > opts.segments.length * 0.5) {
      tripwires.push(`missing seg actions for ${unaddressed.slice(0,3).join(',')}${unaddressed.length>3?'...':''}`);
    }
    if (confidences.length && confidences.reduce((s,c)=>s+c,0)/confidences.length < 0.6) {
      tripwires.push('low avg confidence seg actions');
    }
  }
  const questions = Array.isArray(data?.questions) ? data.questions : Array.isArray((data as any)?.q) ? (data as any).q : [];
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
    for (const raw of spans) {
      const sp = coerceLineSpan(raw);
      if (!sp || spanStartLine(sp) < 1 || spanEndLine(sp) > lineCount || spanStartLine(sp) > spanEndLine(sp)) outOfBounds = true;
      if (sp && spanEndLine(sp) >= keyStart) keyQuestionSpan = true;
    }
    if (q?.sectionId && declaredIds.size && !declaredIds.has(String(q.sectionId)) && q.sectionId !== plan.id) undeclaredSection = true;
  }
  const emitted = questions.map((q: any) => rawQuestionNumber(q, sourceLines)).filter((n: any) => n !== undefined);
  const missing = plan.expected.filter(n => !emitted.includes(n));
  if (missing.length) tripwires.push(`missing questions ${missing.join(',')}`);
  if (duplicates) tripwires.push('duplicate question numbers');
  // A3: Group parent without children tripwire: stem contains (15)(16) enumerations but no children
  for (const q of questions) {
    const stem = shortSourceText(q?.spans, sourceLines);
    const enumerated = [...stem.matchAll(/\((\d{1,3})\)/g)].map(m=>Number(m[1])).filter(n=>n>=1&&n<=300);
    if (enumerated.length >= 2) {
      const hasChildren = questions.some((candidate: { g?: unknown; parentId?: unknown }) =>
        (candidate.g !== undefined && Number(candidate.g) === rawQuestionNumber(q, sourceLines)) ||
        (candidate.parentId !== undefined && candidate.parentId === q.id)
      );
      // Check if parent enumerates its own number plus others and has no children
      if (!hasChildren && enumerated.length >= 2) {
        tripwires.push(`group parent ${rawQuestionNumber(q, sourceLines) || q.n} enumerates ${enumerated.join(',')} but has no children`);
      }
    }
  }
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

function clipSpansBeforeKey(spans: any, sourceMin: number, sourceMax: number, keyStart: number) {
  return clipSpansBeforeLine(spans, sourceMin, sourceMax, keyStart);
}

function sanitizeRawSectionQuestions(data: any, plan: SectionPlan, sourceLines: SourceLine[], keyLines: Set<number>): any[] {
  if ((data as any)?._isAck) return [];
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
    const inKey = (Array.isArray(q.spans) ? q.spans : []).some((raw: any) => {
      const sp = coerceLineSpan(raw);
      return sp ? spanEndLine(sp) >= keyStart : false;
    });
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

/** D — share of a section's content lines the local readability pass marked [GARBLED?]. */
export function sectionGarbledRatio(lines: SourceLine[]): number {
  const content = lines.filter(line => !line.furniture && line.tag !== 'pagenum' && line.tag !== 'junk' && line.tag !== 'key' && line.text.trim());
  if (!content.length) return 0;
  return content.filter(line => line.garbled).length / content.length;
}
export const GARBLED_ESCALATION_RATIO = 0.4;

/** B3 — segment-level recovery helpers (≤3 segs/round +±1 neighbours) */
export function getSegmentSubsetForPlan(segments: Array<{ seg: string; range: [number, number]; hint?: string }>, plan: { start: number; end: number }): Array<{ seg: string; range: [number, number]; hint?: string }> {
  if (!segments?.length) return [];
  return segments.filter(s => s.range[0] >= plan.start && s.range[1] <= plan.end || s.range[0] <= plan.end && s.range[1] >= plan.start);
}
export function selectRecoverySegments(segments: Array<{ seg: string; range: [number, number]; n?: number; kind?: string }>, missingNumbers: number[], opts?: { perRound?: number }): Array<{ seg: string; range: [number, number] }> {
  const perRound = opts?.perRound ?? 3;
  // Map missing numbers to segment indices via printedNo or range hint
  const segIndexById = new Map(segments.map((s,i)=>[s.seg,i]));
  const targetIdxs = new Set<number>();
  for (const n of missingNumbers) {
    // Find segment whose n matches or whose hint contains n, or whose range start matches expected line
    let idx = segments.findIndex(s => s.n === n);
    if (idx === -1) {
      // fallback: find by scanning source line association (use first segment whose range contains expected line if available)
      idx = segments.findIndex(s => String(s.seg) === `S${n}`);
    }
    if (idx !== -1) targetIdxs.add(idx);
  }
  // If no direct match, take first perRound missing segments in order
  if (!targetIdxs.size) {
    for (let i=0;i<Math.min(perRound, segments.length);i++) targetIdxs.add(i);
  }
  // Limit to perRound ordered
  const ordered = [...targetIdxs].sort((a,b)=>a-b).slice(0, perRound);
  // Expand ±1 neighbours
  const expanded = new Set<number>();
  for (const idx of ordered) {
    for (let d=-1; d<=1; d++) {
      const nb = idx + d;
      if (nb >=0 && nb < segments.length) expanded.add(nb);
    }
  }
  return [...expanded].sort((a,b)=>a-b).map(i=>segments[i]);
}
export async function runSegmentRecovery(params: StructurePassParams, missingNumbers: number[], segments: Array<{ seg: string; range: [number, number]; hint?: string; preview?: string }>): Promise<{ questions: any[]; usage: any; flags: any[] }> {
  // B3: at most 2 rounds, ≤3 segs/round +±1 neighbours, budget aware
  const allSegments = segments || params.segments || [];
  if (!allSegments.length || !missingNumbers.length) return { questions: [], usage: { inputTokens:0, outputTokens:0 }, flags: [] };
  let recovered: any[] = [];
  let totalUsage = { inputTokens:0, outputTokens:0, cachedTokens:0 };
  const flags: any[] = [];
  const budget = params.recoveryBudget || (params.recoveryBudget = { count: 0 });
  for (let round=1; round<=2; round++) {
    const remaining = missingNumbers.filter(n=> !recovered.some((q:any)=> rawQuestionNumber(q, params.sourceLines)===n));
    if (!remaining.length) break;
    const segsThisRound = selectRecoverySegments(allSegments as any, remaining, { perRound: 3 });
    if (!segsThisRound.length || budget.count >= 8) break;
    budget.count++;
    // Build LAS for segs + neighbours slice (use source lines covered by segs)
    const lineNos = new Set<number>();
    for (const s of segsThisRound) for (let n=s.range[0]; n<=s.range[1]; n++) lineNos.add(n);
    const lines = params.sourceLines.filter(l=> lineNos.has(Number(l.id.replace(/\D/g,''))));
    const segWire = segsThisRound.map(s=> ({ seg: s.seg, range: s.range, hint: (s as any).hint }));
    const segActionsNeeded = segsThisRound.map(s=> s.seg).join(',');
    const keyLines = enumerateExpectedQuestionNos(params.sourceLines).keyTerritory.lineNos;
    const las = formatLas(lines, keyLines);
    const segBlock = `\nSEGMENTS RECOVERY ROUND ${round} (${segsThisRound.length} segs ±1 neighbours: ${segActionsNeeded})\n${segsThisRound.map(s=> `${s.seg} [${s.range[0]}-${s.range[1]}]`).join('\n')}`;
    const text = `CONFIG: ${JSON.stringify({ latex: params.latexEnabled, languageHint: params.languageHint || null })}\nREQUIRED PRINTED QUESTIONS: ${remaining.join(', ')}\n${segBlock}\nSOURCE:\n${las}\nFor each segment output {seg,action,type,points,options,answerSpans,images,confidence}`;
    const label = `Structure Segment Recovery Round ${round} (${segsThisRound.length} segs)`;
    const request: any = { role: 'fast', system: structureSystemPrompt(params), text, maxOutputTokens: Math.min(params.maxBudgetTokens||16384, 4096), label, providerConfig: params.providerConfig };
    const resp = await LLMAdapter.execute(request, { onDelta: (ch:string,full:string)=> params.onLiveText?.(label, ch as any, full), onInfo: (note:string)=> params.onLiveText?.(label,'info',note), salvagePartial:true } as any);
    totalUsage.inputTokens += resp.usage.inputTokens||0; totalUsage.outputTokens += resp.usage.outputTokens||0; totalUsage.cachedTokens += resp.usage.cachedTokens||0;
    const data = await parseStructureResponse(resp);
    // B3 tripwires for seg handling during recovery
    const segActions = (resp.json as any)?.seg || (resp.json as any)?.segments || [];
    const planStub = { id: `seg-recovery-${round}`, index: round, title: `Segment Recovery ${round}`, start: Math.min(...segsThisRound.map(s=>s.range[0])), end: Math.max(...segsThisRound.map(s=>s.range[1])), expected: remaining };
    const trip = responseTripwires(data, planStub as any, params.sourceLines, keyLines, { segments: allSegments as any, segActions });
    if (trip.length >= 3) {
      flags.push({ code: 'SEG_RECOVERY_TRIPWIRES', severity: 'warn', message: `Segment recovery round ${round} tripwires: ${trip.join('; ')}` });
    }
    const added = Array.isArray(data?.questions) ? data.questions : Array.isArray((data as any)?.q) ? (data as any).q : [];
    if (added.length) recovered.push(...added);
  }
  return { questions: recovered, usage: totalUsage, flags };
}

async function runSectionCall(params: StructurePassParams, plan: SectionPlan, allPlans: SectionPlan[], targetNumbers: number[], phase: string, priorQuestions: any[], priorSections: any[]): Promise<{ questions: any[]; sections: any[]; meta: any; usage: any; rawText: string; label: string; attempts: number; tripwires: string[]; escalated?: boolean; garbledRatio?: number }> {
  const keyLines = enumerateExpectedQuestionNos(params.sourceLines).keyTerritory.lineNos;
  // B2 segment subset: when wire present, restrict to segment lines within plan (not whole section range)
  let sectionLines: typeof params.sourceLines;
  let segmentSubset: Array<{ seg: string; range: [number, number]; hint?: string; preview?: string; kind?: string; n?: number }> | undefined;
  if (params.segments && !params.segmentFallback && params.segments.length) {
    const subsets = getSegmentSubsetForPlan(params.segments as any, plan);
    if (subsets.length) {
      segmentSubset = subsets;
      const allowed = new Set<number>();
      for (const s of subsets) for (let n=s.range[0]; n<=s.range[1]; n++) allowed.add(n);
      sectionLines = params.sourceLines.filter(line => {
        const n = Number(line.id.replace(/\D/g, ''));
        return allowed.has(n);
      });
      // Fallback to full plan range if segment filtering yields empty (should not happen)
      if (!sectionLines.length) {
        sectionLines = params.sourceLines.filter(line => {
          const n = Number(line.id.replace(/\D/g, ''));
          return n >= plan.start && n <= plan.end;
        });
        segmentSubset = undefined;
      }
    } else {
      sectionLines = params.sourceLines.filter(line => {
        const n = Number(line.id.replace(/\D/g, ''));
        return n >= plan.start && n <= plan.end;
      });
    }
  } else {
    sectionLines = params.sourceLines.filter(line => {
      const n = Number(line.id.replace(/\D/g, ''));
      return n >= plan.start && n <= plan.end;
    });
  }
  // D — a mostly-garbled section is routed ONCE to the escalation model (budgeted), never silently.
  const garbledRatio = sectionGarbledRatio(sectionLines);
  const escalationBudget = params.garbledEscalationBudget;
  const escalate = Boolean(params.escalationProviderConfig) && garbledRatio > GARBLED_ESCALATION_RATIO && !phase.startsWith('recovery') && !phase.includes('hint')
    && Boolean(escalationBudget) && escalationBudget!.count < escalationBudget!.max
    && String(params.escalationProviderConfig?.model || '') !== String(params.providerConfig?.model || '');
  if (escalate) escalationBudget!.count++;
  const providerConfig = escalate ? params.escalationProviderConfig : params.providerConfig;
  const normalizedTargets = targetNumbers.map(String);
  const keyAnswerLines = params.sourceLines.filter(line => keyLines.has(Number(line.id.replace(/\D/g, ''))));
  const relevantKeyLines = keyAnswerLines.length <= 160 || !targetNumbers.length
    ? keyAnswerLines
    : keyAnswerLines.filter(line => normalizedTargets.some(n => new RegExp(`(?:^|\\D)${n}\\s*[.)：:-]`).test(normalizeForMatching(line.text))));
  const lines = [...new Map([...sectionLines, ...relevantKeyLines].map(line => [line.id, line])).values()].sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
  const manifest = params.images.filter(img => img.anchorLine && img.anchorLine >= plan.start && img.anchorLine <= plan.end).map(img => ({ id: img.id, page: img.page, nearLine: img.anchorLine }));
  const las = formatLas(lines, keyLines);
  // B2 segment subset wire for this section (advisory-never-executive)
  let segmentBlockSec = '';
  if (segmentSubset && segmentSubset.length) {
    const segLines = segmentSubset.map(s => `${s.seg} [${s.range[0]}-${s.range[1]}] ${s.kind || ''} n=${(s as any).n ?? '-'} hint=${s.hint || ''} preview="${(s.preview || '').replace(/"/g,"'").slice(0,80)}"`).join('\n');
    segmentBlockSec = `\nSEGMENTS (section subset, advisory):\n${segLines}\nFor each seg output {seg,action,type,points,options,answerSpans,images,confidence} (do not emit free-form p spans; use seg ids).`;
  }
  const rangeText = targetNumbers.length ? `REQUIRED PRINTED QUESTIONS: ${targetNumbers.join(', ')}. Do not omit any listed number; output only these questions plus the section spans.` : 'Output all questions from this section.';
  const keyPreamble = keyLines.size ? 'Lines after the key marker are the official answer key; use them ONLY for answer spans. [KEY] lines are excluded from the question hunt.\n' : '';
  const sessionMemory = priorQuestions.length ? `SESSION MEMORY: already parsed numbers ${priorQuestions.map(q => rawQuestionNumber(q, params.sourceLines)).filter(Boolean).join(',')}; section ids ${priorSections.map(s => s.id).join(',')}. Do not repeat existing question numbers.\n` : '';
  const retryHint = phase.includes('hint') ? `\nYour previous output missed ${targetNumbers.join(', ')}; output ONLY the missing numbers, with valid spans.\n` : '';
  const text = `${keyPreamble}CONFIG: ${JSON.stringify({ latex: params.latexEnabled, languageHint: params.languageHint || null })}\n${sessionMemory}${rangeText}${retryHint}\nSECTION ${plan.index}/${allPlans.length} ${plan.title} (${plan.start}-${plan.end})\nIMAGE MANIFEST: ${JSON.stringify(manifest)}\nSOURCE:\n${las}${segmentBlockSec}\nWIRE FORMAT: compact JSON v2. ${JSON.stringify(COMPACT_T1_SCHEMA)}${segmentBlockSec ? ' + seg' : ''}`;
  const budget = params.maxBudgetTokens || 16384;
  const maxOutputTokens = Math.min(budget, Math.max(2048, Math.ceil(Math.max(lines.length * 12, lines.reduce((s, l) => s + l.text.length, 0) / 3.2 * 0.3) * 1.25)));
  const label = `${phase.startsWith('recovery') ? `Structure Recovery ${phase}: ${plan.id}` : `Structure Section: ${plan.id} [${plan.index}/${allPlans.length}] ${plan.title}`}${escalate ? ' (garbled → escalation model)' : ''}`;
  const request: LLMRequest = { role: escalate ? 'escalation' : 'fast', system: structureSystemPrompt(params), text, jsonSchema: providerConfig?.kind === 'gemini' ? T1_GEMINI_SCHEMA : undefined, maxOutputTokens, label, providerConfig };
  const response = await LLMAdapter.execute(request, {
    onDelta: (channel, full) => params.onLiveText?.(label, channel, full),
    onInfo: note => params.onLiveText?.(label, 'info', note),
    salvagePartial: true,
  });
  await params.onCallUsage?.({ label, ...response.usage });
  if (params.journalEnabled && params.journalKey) await appendJournalCall(params.journalKey, { ts: new Date().toISOString(), label, rawText: response.rawText, reasoningText: response.reasoningText, finishReason: response.finishReason, usage: response.usage, complete: true });
  const data = await parseStructureResponse(response);
  // B3 seg tripwire handling: pass segActions when segment wire present
  const segActions = (data as any)?.seg || (data as any)?.segments || (data as any)?.actions || (response.json as any)?.seg || [];
  const tripwires = responseTripwires(data, { ...plan, expected: targetNumbers } as any, params.sourceLines, keyLines, segmentSubset ? { segments: segmentSubset as any, segActions } : undefined);
  let questions = sanitizeRawSectionQuestions(data, plan, params.sourceLines, keyLines);
  let sections = Array.isArray(data?.sections) ? data.sections.map((s: any) => ({ ...s, id: plan.id, index: plan.index, spans: Array.isArray(s.spans) ? s.spans : [] })) : [];
  if (!sections.length) sections = [{ id: plan.id, index: plan.index, spans: [[plan.start, plan.end]], kind: plan.title }];
  const totalPoints = data?.meta?.totalPoints;
  return { questions, sections, meta: data?.meta || {}, usage: response.usage, rawText: response.rawText, label, attempts: 1, tripwires, escalated: escalate, garbledRatio };
}

async function runSectionedStructurePass(params: StructurePassParams, options: { expected: number[]; lineByNumber: Map<number, number>; existing?: StructurePassResult; recoveryOnly?: number[] }): Promise<StructurePassResult> {
  await resolveStructureGuidance(params);
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
    if (result.escalated) flags.push({ code: 'SECTION_GARBLED_ESCALATED', severity: 'info', message: `${plan.title}: ${Math.round((result.garbledRatio || 0) * 100)}% of lines are locally garbled (>${Math.round(GARBLED_ESCALATION_RATIO * 100)}%); this section was routed once to the escalation model.` });
    else if ((result.garbledRatio || 0) > GARBLED_ESCALATION_RATIO) flags.push({ code: 'SECTION_GARBLED', severity: 'warn', message: `${plan.title}: ${Math.round((result.garbledRatio || 0) * 100)}% of lines are locally garbled; escalation budget exhausted or no escalation model — review the [GARBLED?] lines in Step 2.` });
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

  // Initial G1 per-section calls — 2E task graph: bounded concurrency, per-node
  // timeout, branch-local failure. Journal-resumed sections never re-execute.
  const initialPlans = plans.filter(plan => !resumed.has(plan.id) && (!options.recoveryOnly || plan.expected.some(n => targetSet.has(n))));
  const graph = await runTaskGraph(
    initialPlans.map(plan => ({
      id: plan.id,
      label: plan.title,
      run: async () => {
        const targets = options.recoveryOnly ? plan.expected.filter(n => targetSet.has(n)) : plan.expected;
        const usageBefore = callUsage.length;
        await runPlan(plan, targets, options.recoveryOnly ? 'recovery-ui' : 'initial', Boolean(options.recoveryOnly));
        const tokens = callUsage.slice(usageBefore).reduce((sum, c) => sum + (c.inputTokens || 0) + (c.outputTokens || 0), 0);
        const found = new Set(mergedQuestions.map(q => rawQuestionNumber(q, params.sourceLines)).filter((n): n is number => n !== undefined));
        const missingInSection = targets.filter(n => !found.has(n));
        params.onProgress?.(`Section ${plan.index}/${plans.length} · ${plan.title} · ${targets.length} questions ${missingInSection.length ? `— missing ${missingInSection.join(', ')}` : '✓'}`);
        return { planId: plan.id, tokens };
      },
    })),
    { concurrency: params.parallelSections ?? 3, onNode: node => params.onNode?.(node) },
  );
  for (const failedId of graph.failedNodes) {
    const plan = plans.find(p => p.id === failedId);
    flags.push({ code: 'SECTION_NODE_FAILED', severity: 'error', message: `${plan?.title || failedId}: section node failed; other sections continued. ${graph.partialMessage || ''}` });
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
  // B3 segment-level recovery (≤3 segs/round +±1 neighbours) when segments wire is active and coverage still missing
  if (params.segments && !params.segmentFallback && params.segments.length) {
    const postSectionCoverage = evaluateCoverage(expected, rawCoverageQuestions(mergedQuestions, params.sourceLines), meta.totalPoints);
    if (postSectionCoverage.missing.length) {
      const segRes = await runSegmentRecovery(params as any, postSectionCoverage.missing, params.segments as any);
      if (segRes.questions.length) {
        const deduped = segRes.questions.filter((q:any)=> {
          const id = rawQuestionIdentity(q, params.sourceLines);
          if (!id) return true;
          return !mergedQuestions.some((m:any)=> rawQuestionIdentity(m, params.sourceLines)===id);
        });
        mergedQuestions.push(...deduped);
        if (segRes.usage.inputTokens || segRes.usage.outputTokens) {
          inputTokens += segRes.usage.inputTokens||0; outputTokens += segRes.usage.outputTokens||0; cachedTokens += segRes.usage.cachedTokens||0;
        }
        if (segRes.flags.length) flags.push(...segRes.flags);
        flags.push({ code: 'SEG_RECOVERY_USED', severity: 'info', message: `Segment recovery: ${deduped.length} question(s) recovered via ≤3 segs/round ±1 neighbours (rounds up to 2).` });
      }
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
  // D1 — ONE assembly point: every structure path below inherits params.guidance.
  const guidance = await resolveStructureGuidance(params);
  const stamp = (result: StructurePassResult): StructurePassResult => ({ ...result, guidanceTokens: guidance.tokens, guidanceDigest: guidance.digest });
  const expected = enumerateExpectedQuestionNos(params.sourceLines);
  const model = String(params.providerConfig?.model || '').toLowerCase();
  const weakModel = /(?:free|lite|mini|small|tiny|(?:^|[-_])(?:3|4|5|7|8|9)b(?:[-_]|$))/i.test(model) || Number(params.maxBudgetTokens || 0) > 0 && Number(params.maxBudgetTokens) < 8192;
  const forceSections = Boolean(params.forceSectionMode || weakModel || expected.numbers.length > 25 || params.sourceLines.length > 220 || params.recoveryOnlyNumbers?.length);
  if (forceSections) {
    const sectioned = await runSectionedStructurePass(params, { expected: expected.numbers, lineByNumber: expected.lineByNumber, recoveryOnly: params.recoveryOnlyNumbers });
    return stamp(attachWireTokenAccounting(sectioned));
  }
  const result = await runSingleStructurePass(params);
  const coverage = evaluateCoverage(expected.numbers, rawCoverageQuestions(result.rawQuestions, params.sourceLines), result.meta?.totalPoints);
  const recoveryBudget = params.recoveryBudget || (params.recoveryBudget = { count: 0 });
  if (coverage.missing.length) {
    const recovery = await runSectionedStructurePass({ ...params, recoveryBudget }, {
      expected: expected.numbers, lineByNumber: expected.lineByNumber, existing: result, recoveryOnly: coverage.missing,
    });
    return stamp(attachWireTokenAccounting(recovery));
  }
  const coverageFlags = makeCoverageFlags(result.rawQuestions, params.sourceLines, expected.numbers, result.meta?.totalPoints);
  result.flags = [...(result.flags || []), ...coverageFlags];
  result.recoveryCalls = recoveryBudget.count;
  result.wireFormat ||= 'v2';
  return stamp(attachWireTokenAccounting(result));
}

async function runSingleStructurePass(params: StructurePassParams): Promise<StructurePassResult> {
  await resolveStructureGuidance(params);
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
  // B2: segment wire (deterministic-before-LLM) — when present, model only labels/classifies/corrects
  let segmentBlock = '';
  if (params.segments && !params.segmentFallback) {
    const segLines = params.segments.map(s => `${s.seg} [${s.range[0]}-${s.range[1]}] ${s.kind} n=${s.n ?? '-'} hint=${s.hint} preview="${s.preview.replace(/"/g, "'")}"`).join('\n');
    segmentBlock = `\n\nSEGMENTS (deterministic, 100% coverage, advisory-never-executive — you ONLY label/correct, never invent spans):\n${segLines}\nFor each segment, output one object in "seg": [{"seg":"S1","action":"accept|relabel|split|merge-next|drop","type":"m|f|b|s|l|a|u|n|d|?","points":1,"options":[["a",1]],"answerSpans":[1],"images":["img_001"],"confidence":9}] where confidence 0-9 (9=certain). accept=relabel use segment lines as question spans; split=one segment is two questions; merge-next=merge with next; drop=header/passage/instruction. Do not emit free-form p spans; use only seg ids.`;
  }
  let userPrompt = `${keyPreamble}CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint: languageHint || null })}\nIMAGE MANIFEST: ${JSON.stringify(manifestEntries)}\nSOURCE:\n${lasText}${segmentBlock}\nWIRE FORMAT: compact JSON v2. ${JSON.stringify(COMPACT_T1_SCHEMA)}${params.segments && !params.segmentFallback ? ' + seg' : ''}`;

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
    system: structureSystemPrompt(params),
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
  // B2/B4: segment-aware unwrap with confidence+fallback (>20% mismatch → legacy)
  let data: any;
  let segmentFallbackUsed = false;
  if (params.segments && !params.segmentFallback) {
    data = unwrapStructureData(response.json, { segments: params.segments as any });
    const segActions = (response.json as any)?.seg || (response.json as any)?.segments || (response.json as any)?.actions;
    if (Array.isArray(segActions) && segActions.length) {
      const avgConf = segActions.reduce((s: number, a: any) => s + (typeof a.confidence === 'number' ? a.confidence : typeof a.c === 'number' ? a.c / 10 : 0.85), 0) / segActions.length;
      const mismatch = Math.abs(segActions.length - params.segments.length) / params.segments.length;
      const lowConf = segActions.filter((a: any) => (typeof a.confidence === 'number' ? a.confidence : typeof a.c === 'number' ? a.c / 10 : 0.85) < 0.6).length / segActions.length;
      if (avgConf < 0.6 || mismatch > 0.2 || lowConf > 0.2) {
        const legacy = unwrapStructureData(response.json);
        if (Array.isArray(legacy?.questions) && legacy.questions.length) {
          data = legacy;
          segmentFallbackUsed = true;
        }
      }
    }
  } else {
    data = unwrapStructureData(response.json);
  }
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
  await resolveStructureGuidance(params);
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
    // A4 — chunks see the same clean view as every other structure path (tags as prefixes, confirmed junk omitted, original ids).
    const las = renderCleanView(lines, keyLines).text;
    const start = Number(lines[0]?.id.replace(/\D/g,'')), end = Number(lines[lines.length-1]?.id.replace(/\D/g,''));
    const chunkManifest = manifest.filter((m:any) => { const n = Number(m.nearLine); return n >= start && n <= end; });
    const keyPreamble = keyLines.size ? 'Lines tagged [KEY] are official answer-key territory: use them ONLY for answer spans; never parse questions from them.\n' : '';
    const base = `${keyPreamble}CONFIG: ${JSON.stringify({ latex: latexEnabled, languageHint: languageHint || null })}\n${mergedQuestions.length ? sessionBrief() + '\n' : ''}\nIMAGE MANIFEST:\n${JSON.stringify(chunkManifest)}\n\nSOURCE CHUNK:\n${las}`;
    const schemaBlock = !isGemini ? `\n\nREQUIRED JSON SCHEMA CONTRACT (Strict):\n${JSON.stringify(COMPACT_T1_SCHEMA)}` : '';
    const inTokens = Math.ceil(lines.reduce((n,l)=>n+l.text.length,0) / 3.2);
    const est = Math.max(inTokens * .25, lines.length * 14);
    const cap = Math.min(budgetCap, Math.max(4096, Math.ceil(est * 1.25)));
    const req: LLMRequest = { role: 'fast', system: structureSystemPrompt(params), text: base + schemaBlock, jsonSchema: isGemini ? T1_GEMINI_SCHEMA : undefined, maxOutputTokens: cap, label, providerConfig };
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
