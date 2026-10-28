/** Follow-up #46: model-authored JSON is the working document. Code checks and routes; it never edits content. */
import type { ExamDoc, ImageAsset, Question, SourceLine } from '../types';
import { repairTruncatedJson } from '../utils/jsonRepair';
import { normalizeGrade, normalizeSubject, normalizeDigits } from './metaRead';
import { hasCountingLoop } from './globalRead';

export { hasCountingLoop };
export const LOOP_VERSION = 'local-loop-v1';
export const LOOP_OVERLAP_LINES = 30;
export const LOOP_STEPS = ['read', 'self-review', 'code-check', 'code-fix', 'decision-audit', 'final-fix'] as const;
export type LoopStepId = typeof LOOP_STEPS[number];
export const LOOP_STEP_NAMES: Record<LoopStepId, string> = {
  read: 'Read', 'self-review': 'Self-review', 'code-check': 'Code check',
  'code-fix': 'Code-verdict fix', 'decision-audit': 'Decision audit', 'final-fix': 'Final fix',
};
export const CODE_VERDICT_KINDS = ['invalid-json-remnant', 'duplicate-number', 'missing-number', 'empty-stem',
  'options-missing-for-type', 'points-sum-mismatch', 'image-unassigned', 'image-double-assigned', 'meta-field-implausible'] as const;
export type CodeVerdictKind = typeof CODE_VERDICT_KINDS[number];
export type LoopDecisionKind = 'stem-faithful' | 'complete' | 'uncontaminated' | 'type-correct' | 'answer-correct'
  | 'answer-letter' | 'points-plausible' | 'belongs-in-section' | 'image-belongs';
export interface LoopVerdict {
  id: string;
  questionNumbers: number[];
  kind: CodeVerdictKind | LoopDecisionKind;
  message: string;
  source: 'code' | 'decision';
  probability?: number;
  choice?: string;
  imageId?: string;
  page?: number;
  routed?: boolean;
  closed?: boolean;
}
export interface AuthoredQuestion {
  number: number;
  sectionTitle?: string;
  type: Question['type'];
  stem: string;
  options: Array<{ key: string; text: string; [key: string]: unknown }>;
  answer?: string;
  points?: number;
  imageIds: string[];
  subQuestions?: AuthoredQuestion[];
  sourcePages?: number[];
  /** Model-authored extensions and advisory stemFrom/stemTo are retained, never used to slice text. */
  [key: string]: unknown;
}
export interface AuthoredDocument {
  meta: Record<string, unknown>;
  sections: Array<{ title: string; [key: string]: unknown }>;
  questions: AuthoredQuestion[];
}
export interface LoopPageReceipt {
  page: number; status: 'ok' | 'salvaged' | 'empty' | 'failed' | 'cached';
  calls: number; questions: number; notes: string[];
}
export interface LoopStepReceipt {
  step: LoopStepId; name: string;
  status: 'idle' | 'running' | 'completed' | 'skipped' | 'failed' | 'cached';
  calls: number; correctionsApplied: number; verdictsRaised: number; verdictsClosed: number;
  notes: string[]; inputTokens: number; outputTokens: number;
}
export interface LoopReceipt {
  version: typeof LOOP_VERSION;
  document: AuthoredDocument;
  steps: LoopStepReceipt[];
  pages: LoopPageReceipt[];
  codeVerdicts: LoopVerdict[];
  auditVerdicts: LoopVerdict[];
  survivingVerdicts: LoopVerdict[];
  notes: string[];
  auditMode: 'shadow' | 'active' | 'skipped';
}
export interface LoopModelRequest {
  step: Exclude<LoopStepId, 'code-check' | 'decision-audit'>;
  system: string; text: string; label: string;
  /** Deliberately no small page cap: a full page of authored questions must fit. */
  maxOutputTokens?: number;
}
export interface LoopModelResponse { rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }
export type LoopModelCaller = (request: LoopModelRequest) => Promise<LoopModelResponse>;

export const emptyAuthoredDocument = (): AuthoredDocument => ({ meta: {}, sections: [], questions: [] });
export const newLoopReceipt = (): LoopReceipt => ({
  version: LOOP_VERSION, document: emptyAuthoredDocument(),
  steps: LOOP_STEPS.map(step => ({ step, name: LOOP_STEP_NAMES[step], status: 'idle', calls: 0,
    correctionsApplied: 0, verdictsRaised: 0, verdictsClosed: 0, notes: [], inputTokens: 0, outputTokens: 0 })),
  pages: [], codeVerdicts: [], auditVerdicts: [], survivingVerdicts: [], notes: [], auditMode: 'skipped',
});
export const errorMessage = (error: unknown): string => String((error as any)?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as any : {};
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const number = (value: unknown): number | undefined => {
  const n = Number(normalizeDigits(text(value)).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
const questionNumber = (value: unknown): number | undefined => {
  const n = number(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};
const sectionTitle = (value: unknown): string => text(value).trim();
const sectionKey = (value: unknown): string => sectionTitle(value).normalize('NFKC').toLocaleLowerCase();
const TYPES: Question['type'][] = ['mcq', 'truefalse', 'short', 'long', 'fillblank', 'matching', 'multi', 'numeric', 'diagram', 'essay', 'unknown'];
function questionType(value: unknown): Question['type'] {
  const v = text(value).toLowerCase().replace(/[\s_-]/g, '');
  const aliases: Record<string, Question['type']> = { multiplechoice: 'mcq', choice: 'mcq', trueorfalse: 'truefalse', tf: 'truefalse', fillintheblank: 'fillblank', shortanswer: 'short', longanswer: 'long', freeresponse: 'long', multipleanswer: 'multi' };
  return aliases[v] || TYPES.find(t => t === v) || 'unknown';
}
/** Normalize aliases without discarding the model's object or rewriting its authored text. */
export function normalizeAuthoredQuestion(raw: unknown, page?: number): AuthoredQuestion | undefined {
  const q = object(raw);
  const no = questionNumber(q.number ?? q.no ?? q.questionNumber);
  if (no === undefined) return undefined;
  const options = Array.isArray(q.options) ? q.options.map((o: any, i: number) => typeof o === 'string'
    ? { key: String.fromCharCode(97 + i), text: o }
    : { ...object(o), key: text(o?.key ?? o?.label) || String.fromCharCode(97 + i), text: text(o?.text ?? o?.value) })
    : q.options && typeof q.options === 'object' ? Object.entries(q.options).map(([key, value]) => ({ key, text: text(value) })) : [];
  const answer = q.answer ?? q.answerText ?? q.answerLetter;
  const points = number(q.points ?? q.marks);
  const images = q.imageIds ?? q.images;
  const result: AuthoredQuestion = {
    ...q, number: no, sectionTitle: sectionTitle(q.sectionTitle ?? q.section), type: questionType(q.type),
    stem: text(q.stem ?? q.stemText ?? q.questionText), options,
    imageIds: Array.isArray(images) ? [...new Set(images.map((x: any) => text(typeof x === 'string' ? x : x?.imageId ?? x?.id)).filter(Boolean))] as string[] : [],
  };
  if (answer !== undefined && answer !== null) result.answer = text(typeof answer === 'object' ? answer.text ?? answer.letter ?? answer.value : answer);
  else delete result.answer;
  if (points !== undefined && points >= 0) result.points = points; else delete result.points;
  if (Array.isArray(q.subQuestions)) result.subQuestions = q.subQuestions.map((child: unknown) => normalizeAuthoredQuestion(child, page)).filter(Boolean) as AuthoredQuestion[];
  if (page !== undefined) result.sourcePages = [page];
  return result;
}
export function flatAuthoredQuestions(doc: AuthoredDocument): AuthoredQuestion[] {
  const visit = (questions: AuthoredQuestion[]): AuthoredQuestion[] => questions.flatMap(q => [q, ...visit(q.subQuestions || [])]);
  return visit(doc.questions);
}
export function normalizeAuthoredDocument(raw: unknown): AuthoredDocument {
  const value = object(raw);
  const meta = { ...object(value.meta), ...object(value.metadata) };
  for (const key of ['subject', 'grade', 'totalPoints', 'durationMinutes', 'pages', 'title', 'school', 'year', 'term', 'date']) {
    if (meta[key] === undefined && value[key] !== undefined) meta[key] = value[key];
  }
  if (meta.totalPoints === undefined && meta.total !== undefined) meta.totalPoints = meta.total;
  return {
    meta,
    sections: (Array.isArray(value.sections) ? value.sections : []).map((s: any) => typeof s === 'string' ? { title: s } : { ...object(s), title: sectionTitle(s?.title ?? s?.sectionTitle) }).filter((s: any) => s.title),
    questions: (Array.isArray(value.questions) ? value.questions : Array.isArray(raw) ? raw : []).map((q: unknown) => normalizeAuthoredQuestion(q)).filter(Boolean) as AuthoredQuestion[],
  };
}

/** Complete objects only; a cut-off scalar or half-written question is never invented into data. */
export function completeObjects(raw: string, key: string): unknown[] {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(raw);
  if (!match) return [];
  const out: unknown[] = []; let depth = 0, start = -1, quoted = false, escaped = false;
  for (let i = match.index + match[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === ']' && depth === 0) break;
    if (c === '{' && depth++ === 0) start = i;
    if (c === '}' && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* remnant */ }
    }
  }
  return out;
}
export function parseLoopJson(response: LoopModelResponse): { value: unknown; salvaged: boolean } {
  const raw = (response.rawText || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (raw) {
    try { return { value: JSON.parse(raw), salvaged: false }; } catch { /* salvage below */ }
    const prefix = repairTruncatedJson(raw);
    const questions = completeObjects(raw, 'questions');
    if (questions.length) return { value: { ...object(prefix), questions, sections: completeObjects(raw, 'sections') }, salvaged: true };
    if (prefix !== null) return { value: prefix, salvaged: true };
  }
  if (response.json !== undefined && response.json !== null) return { value: response.json, salvaged: Boolean(raw) };
  return { value: null, salvaged: Boolean(raw) };
}
export interface PageReadResult { document: AuthoredDocument; receipt: LoopPageReceipt; usage: { inputTokens: number; outputTokens: number } }
export function pageFromResponse(response: LoopModelResponse, page: number, cached = false): PageReadResult {
  const parsed = parseLoopJson(response);
  const doc = normalizeAuthoredDocument(parsed.value);
  for (const q of flatAuthoredQuestions(doc)) q.sourcePages = [page];
  const rawQuestions = object(parsed.value).questions;
  const remnant = (parsed.salvaged && doc.questions.length > 0) || (Array.isArray(rawQuestions) && rawQuestions.length !== doc.questions.length);
  const notes: string[] = [];
  if (remnant) notes.push(`Page ${page}: invalid JSON remnant; ${doc.questions.length} complete question object(s) salvaged.`);
  if (!doc.questions.length) notes.push(`Page ${page}: no complete question objects${parsed.value === null ? ' (unreadable model output)' : ''}.`);
  return { document: doc, receipt: { page, status: cached ? 'cached' : remnant ? 'salvaged' : doc.questions.length ? 'ok' : 'empty', calls: cached ? 0 : 1,
    questions: doc.questions.length, notes }, usage: response.usage || { inputTokens: 0, outputTokens: 0 } };
}
const appendText = (a: string, b: string): string => !b || a === b || a.endsWith(b) ? a : a ? `${a}\n${b}` : b;
/** Later pages continue the same number + section. Same-page/different-section duplicates remain visible to CHECK. */
export function mergePageReads(pages: AuthoredDocument[]): AuthoredDocument {
  const result = emptyAuthoredDocument();
  for (const page of pages) {
    for (const [key, value] of Object.entries(page.meta)) if (result.meta[key] === undefined && value !== undefined && value !== null && value !== '') result.meta[key] = value;
    for (const section of page.sections) {
      const old = result.sections.find(s => sectionKey(s.title) === sectionKey(section.title));
      if (old) Object.assign(old, { ...section, ...Object.fromEntries(Object.entries(old).filter(([, v]) => v !== undefined)) });
      else result.sections.push({ ...section });
    }
    for (const q of page.questions) {
      const incomingPage = q.sourcePages?.[0];
      const old = result.questions.find(x => x.number === q.number && sectionKey(x.sectionTitle) === sectionKey(q.sectionTitle) && (incomingPage === undefined || !x.sourcePages?.includes(incomingPage)));
      if (!old) { result.questions.push(structuredClone(q)); continue; }
      old.stem = appendText(old.stem, q.stem);
      for (const option of q.options) {
        const prior = old.options.find(o => o.key === option.key);
        if (prior) prior.text = appendText(prior.text, option.text); else old.options.push({ ...option });
      }
      if (old.answer === undefined) old.answer = q.answer;
      if (old.points === undefined) old.points = q.points;
      old.imageIds = [...new Set([...old.imageIds, ...q.imageIds])];
      old.sourcePages = [...new Set([...(old.sourcePages || []), ...(q.sourcePages || [])])];
      if (q.subQuestions?.length) old.subQuestions = mergePageReads([{ meta: {}, sections: [], questions: old.subQuestions || [] }, { meta: {}, sections: [], questions: q.subQuestions }]).questions;
      for (const [key, value] of Object.entries(q)) if (old[key] === undefined) old[key] = value;
    }
  }
  return result;
}

export type Correction = { action: 'replace' | 'insert' | 'delete'; questionNumber: number; question?: AuthoredQuestion; sectionTitle?: string };
export function parseCorrections(response: LoopModelResponse): Correction[] | undefined {
  // Patch output is all-or-nothing when unparseable. Unlike READ, never apply a guessed partial patch.
  let value: unknown = response.json;
  if (response.rawText?.trim()) {
    try { value = JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); } catch { return undefined; }
  }
  const rows = object(value).corrections;
  if (!Array.isArray(rows)) return undefined;
  const result: Correction[] = [];
  for (const row of rows) {
    const r = object(row); const no = questionNumber(r.questionNumber ?? r.number ?? r.no);
    const action = r.action ?? r.op ?? (r.delete ? 'delete' : 'replace');
    if (no === undefined || !['replace', 'insert', 'delete'].includes(action)) continue;
    const question = action === 'delete' ? undefined : normalizeAuthoredQuestion(r.question ?? r.correctedQuestion ?? r.object);
    if (action !== 'delete' && !question) continue;
    result.push({ action, questionNumber: no, question, sectionTitle: r.sectionTitle === undefined ? undefined : sectionTitle(r.sectionTitle) });
  }
  return result;
}
function replaceInTree(questions: AuthoredQuestion[], correction: Correction): { questions: AuthoredQuestion[]; changed: boolean } {
  let changed = false;
  const next: AuthoredQuestion[] = [];
  for (const q of questions) {
    const matches = q.number === correction.questionNumber && (correction.sectionTitle === undefined || sectionKey(q.sectionTitle) === sectionKey(correction.sectionTitle));
    if (matches) { next.push(structuredClone(correction.question!)); changed = true; }
    else {
      const child = correction.question?.subQuestions ? null : replaceInTree(q.subQuestions || [], correction);
      if (child?.changed) { next.push({ ...q, subQuestions: child.questions }); changed = true; } else next.push(q);
    }
  }
  return { questions: next, changed };
}
function deleteInTree(questions: AuthoredQuestion[], correction: Correction): { questions: AuthoredQuestion[]; changed: boolean } {
  let changed = false; const next: AuthoredQuestion[] = [];
  for (const q of questions) {
    if (q.number === correction.questionNumber && (correction.sectionTitle === undefined || sectionKey(q.sectionTitle) === sectionKey(correction.sectionTitle))) { changed = true; continue; }
    const child = deleteInTree(q.subQuestions || [], correction);
    next.push(child.changed ? { ...q, subQuestions: child.questions } : q); changed ||= child.changed;
  }
  return { questions: next, changed };
}
/** The sole automatic content-writing funnel. Full objects only, addressed by printed number. */
export function applyCorrections(doc: AuthoredDocument, corrections: Correction[]): { document: AuthoredDocument; applied: number; notes: string[] } {
  let next = structuredClone(doc); let applied = 0; const notes: string[] = [];
  for (const correction of corrections) {
    const matches = flatAuthoredQuestions(next).filter(q => q.number === correction.questionNumber && (correction.sectionTitle === undefined || sectionKey(q.sectionTitle) === sectionKey(correction.sectionTitle)));
    if (correction.action === 'insert' && matches.length) { notes.push(`Insert for existing question ${correction.questionNumber} ignored; use replace.`); continue; }
    if (correction.action !== 'insert' && !matches.length) { notes.push(`Correction ignored: question ${correction.questionNumber} does not exist.`); continue; }
    if (matches.length > 1 && correction.sectionTitle === undefined) { notes.push(`Correction for duplicate question ${correction.questionNumber} ignored; sectionTitle is needed to choose its record.`); continue; }
    if (correction.action === 'delete') {
      const removed = deleteInTree(next.questions, correction); next.questions = removed.questions;
      if (removed.changed) applied++;
    } else if (correction.action === 'insert') {
      next.questions.push(structuredClone(correction.question!)); applied++;
      const title = correction.question!.sectionTitle;
      if (title && !next.sections.some(s => sectionKey(s.title) === sectionKey(title))) next.sections.push({ title });
    } else {
      const old = matches[0];
      const replacement = { ...structuredClone(correction.question!), sourcePages: correction.question!.sourcePages || old.sourcePages };
      const replaced = replaceInTree(next.questions, { ...correction, question: replacement });
      next.questions = replaced.questions; if (replaced.changed) applied++;
      const title = replacement.sectionTitle;
      if (title && !next.sections.some(s => sectionKey(s.title) === sectionKey(title))) next.sections.push({ title });
    }
  }
  // Ordering is presentation, not a content edit. Preserve the order of duplicate records.
  next.questions.sort((a, b) => a.number - b.number);
  return { document: next, applied, notes };
}

export function checkAuthoredDocument(doc: AuthoredDocument, images: ImageAsset[], remnants: LoopVerdict[] = []): LoopVerdict[] {
  const verdicts: LoopVerdict[] = [...remnants];
  const questions = flatAuthoredQuestions(doc);
  const add = (kind: CodeVerdictKind, numbers: number[], message: string, extra: Partial<LoopVerdict> = {}) => verdicts.push({ id: `code:${kind}:${numbers.join(',') || extra.imageId || 'exam'}`, kind, questionNumbers: numbers, message, source: 'code', ...extra });
  const byNumber = new Map<number, AuthoredQuestion[]>();
  for (const q of questions) byNumber.set(q.number, [...(byNumber.get(q.number) || []), q]);
  for (const [no, matches] of byNumber) if (matches.length > 1) add('duplicate-number', [no], `Question ${no} appears ${matches.length} times. Check whether these are duplicates or separate sections.`);
  const max = Math.max(0, ...questions.map(q => q.number));
  // Pathology guard: a malformed absurd number must not allocate an unbounded gap list.
  const scanMax = Math.min(max, 1000);
  for (let no = 1; no <= scanMax; no++) if (!byNumber.has(no)) add('missing-number', [no], `Question ${no} is missing between 1 and the document's highest number (${max}).`);
  if (max > scanMax) add('missing-number', [], `The highest authored number (${max}) is implausibly large; gap checking was bounded at ${scanMax}.`);
  for (const q of questions) {
    if (!q.stem.trim() && !q.subQuestions?.length) add('empty-stem', [q.number], `Question ${q.number} has no question text.`);
    if (['mcq', 'multi', 'truefalse', 'matching'].includes(q.type) && q.options.length < 2 && !q.subQuestions?.length) add('options-missing-for-type', [q.number], `Question ${q.number} is ${q.type} but its answer choices are missing or incomplete.`);
  }
  const total = number(doc.meta.totalPoints);
  const parentIds = new Set(questions.filter(q => q.subQuestions?.length).map(q => q.number));
  const sum = questions.filter(q => !parentIds.has(q.number)).reduce((s, q) => s + (q.points || 0), 0);
  if (total !== undefined && Math.abs(sum - total) > 0.001) add('points-sum-mismatch', [], `Printed question points add up to ${sum}, not the exam total ${total}.`);
  const owners = new Map<string, number[]>();
  for (const q of questions) for (const id of q.imageIds) owners.set(id, [...(owners.get(id) || []), q.number]);
  for (const image of images) {
    if (image.duplicateOf || image.label?.role === 'decoration' || image.label?.kind === 'decoration') continue;
    const assigned = owners.get(image.id) || [];
    if (!assigned.length) add('image-unassigned', [], `Image ${image.id} on page ${image.page} has not been assigned to a question.`, { imageId: image.id, page: image.page });
    if (new Set(assigned).size > 1) add('image-double-assigned', assigned, `Image ${image.id} is assigned to more than one question (${assigned.join(', ')}).`, { imageId: image.id, page: image.page });
  }
  if (doc.meta.grade !== undefined && normalizeGrade(doc.meta.grade) === undefined) add('meta-field-implausible', [], `Grade “${text(doc.meta.grade)}” is not a recognised grade from 1 to 12.`);
  if (doc.meta.subject !== undefined && !normalizeSubject(doc.meta.subject)) add('meta-field-implausible', [], `Subject “${text(doc.meta.subject)}” is not in the subject lexicon; re-read the header.`);
  if (total !== undefined) {
    if (total <= 0) add('meta-field-implausible', [], 'The exam total must be positive.');
    for (const field of ['durationMinutes', 'pages']) if (number(doc.meta[field]) === total) add('meta-field-implausible', [], `Exam total ${total} equals ${field === 'pages' ? 'the page count' : 'the duration'}; it may have read the wrong header field.`);
  }
  return verdicts;
}

/** Projection for the existing PAPERWORK UI. Empty spans mean model-authored text, not sliced source. */
export function projectAuthoredDocument(doc: AuthoredDocument): { questions: Question[]; sections: ExamDoc['sections']; meta: Partial<ExamDoc['meta']> } {
  const titles = [...new Set([...doc.sections.map(s => s.title), ...flatAuthoredQuestions(doc).map(q => q.sectionTitle || '').filter(Boolean)])];
  const sections = titles.map((title, index) => {
    const authored = doc.sections.find(s => sectionKey(s.title) === sectionKey(title));
    return { id: `loop_section_${index + 1}`, index: index + 1, title, spans: [], ...(authored?.instructions ? { instructions: text(authored.instructions) } : {}), ...(number(authored?.points) !== undefined ? { points: number(authored?.points) } : {}) };
  });
  const questions: Question[] = [];
  const visit = (q: AuthoredQuestion, parentId?: string) => {
    const id = `loop_q_${q.number}${parentId ? `_child_${questions.length + 1}` : questions.some(x => x.no === q.number) ? `_duplicate_${questions.length + 1}` : ''}`;
    const section = sections.find(s => sectionKey(s.title) === sectionKey(q.sectionTitle));
    const projected: Question = {
      id, no: q.number, label: text(q.label) || String(q.no ?? q.number), type: q.type, stem: q.stem,
      spans: [], options: q.options.map(o => ({ key: o.key, text: o.text, spans: [] })), images: q.imageIds.map(imageId => ({ imageId, role: 'stem' })), confidence: 1,
      ...(section ? { sectionId: section.id } : {}), ...(parentId ? { parentId } : {}),
      ...(q.points !== undefined ? { points: q.points } : {}),
      ...(q.answer !== undefined ? { answer: { text: q.answer, source: 'paper' as const } } : {}),
      ...(Array.isArray(q.wordBank) ? { wordBank: q.wordBank.map(text) } : {}),
    };
    questions.push(projected);
    for (const child of q.subQuestions || []) visit(child, id);
  };
  for (const q of doc.questions) visit(q);
  const meta: Partial<ExamDoc['meta']> = {};
  for (const key of ['title', 'subject', 'grade', 'school', 'term', 'year'] as const) if (doc.meta[key] !== undefined) meta[key] = text(doc.meta[key]);
  for (const key of ['totalPoints', 'durationMinutes'] as const) { const n = number(doc.meta[key]); if (n !== undefined) meta[key] = n; }
  return { questions, sections, meta };
}

export interface LoopPageChunk { page: number; owned: SourceLine[]; context: SourceLine[] }
export function buildLoopPages(lines: SourceLine[]): LoopPageChunk[] {
  const pages: LoopPageChunk[] = [];
  for (const page of [...new Set(lines.map(l => l.page))].sort((a, b) => a - b)) {
    const owned = lines.filter(l => l.page === page);
    pages.push({ page, owned, context: pages.at(-1)?.owned.slice(-LOOP_OVERLAP_LINES) || [] });
  }
  return pages;
}
export const sourceText = (lines: SourceLine[]): string => lines.map(l => l.text).join('\n');
export function sourcePagesText(lines: SourceLine[], pages: number[]): string {
  const wanted = new Set(pages);
  return [...wanted].sort((a, b) => a - b).map(p => `PAGE ${p}\n${sourceText(lines.filter(l => l.page === p))}`).join('\n\n');
}
export function questionSourcePages(q: AuthoredQuestion, lines: SourceLine[]): number[] {
  if (q.sourcePages?.length) return q.sourcePages;
  // Provenance fallback for imported authored objects only; never used to slice or alter text.
  const needle = q.stem.trim().split('\n')[0];
  const found = needle ? lines.find(l => l.text.includes(needle)) : undefined;
  return found ? [found.page] : [...new Set(lines.map(l => l.page))];
}
export const LOOP_READ_SYSTEM = `You are ExamParse's local reader. Read this one exam page and author its questions as full JSON objects. Return JSON only.
Use {"meta":{"subject":"...","grade":"...","totalPoints":40,"durationMinutes":90,"pages":6},"sections":[{"title":"Vocabulary","instructions":"..."}],"questions":[{"number":1,"sectionTitle":"Vocabulary","type":"mcq","stem":"full printed question text","options":[{"key":"a","text":"full choice"}],"answer":"only if a printed key supplies it","points":0.5,"imageIds":["img_1"]}]}.
Use self-descriptive keys. Include the full stem, every option, shared instructions/passages needed to understand the question, printed points only when printed, and a printed answer only when present. Never infer or distribute marks. Include every question on this page, including continuations and subQuestions. Same number + same section on a later page means continuation. The previous-page context is read-only; do not duplicate its questions. Use only supplied image ids when the picture belongs to a question. Do not enumerate source lines. Optional stemFrom/stemTo are advisory only, never a substitute for text. Do not invent questions to fill gaps. Reasoning off. /no_think`;
export const LOOP_REVIEW_SYSTEM = `Here is your parse and the original text. Find questions that are wrong, incomplete, duplicated, missing, or containing another question's material. Return ONLY corrections: for each problem, the question number and the fully corrected question object; for missing questions, the complete new object; for duplicates, which number to delete. If a question is fine, say nothing about it.
JSON: {"corrections":[{"action":"replace","questionNumber":1,"question":{full corrected object}},{"action":"insert","questionNumber":2,"question":{complete new object}},{"action":"delete","questionNumber":3,"sectionTitle":"optional when number is duplicated"}]}. Never return spans or patches to individual fields. No corrections means {"corrections":[]}. Reasoning off. /no_think`;
export const LOOP_FIX_SYSTEM = `Fix only the questions and verdicts supplied. Use the source text, not guesswork. Return corrected FULL question objects by number, as {"corrections":[{"action":"replace","questionNumber":1,"question":{full object}}]}. You may insert a missing question or delete a duplicate using the same envelope. Do not change unflagged questions. If metadata is flagged, re-read the supplied first-page header and include corrected "meta" alongside corrections. Never infer points or answers. Reasoning off. /no_think`;
export function buildLoopPagePrompt(chunk: LoopPageChunk, images: ImageAsset[], guidance?: string): string {
  const context = chunk.context.length ? `PREVIOUS PAGE CONTEXT (read only; last ${LOOP_OVERLAP_LINES} lines):\n${sourceText(chunk.context)}\n\n` : '';
  const captions = images.filter(i => i.page === chunk.page && !i.duplicateOf).map(i => ({ id: i.id, caption: i.label?.caption || null, role: i.label?.role || null }));
  return `${guidance ? `${guidance}\n\n` : ''}${context}PAGE ${chunk.page} SOURCE:\n${sourceText(chunk.owned)}\n\nPAGE IMAGE CAPTIONS:\n${JSON.stringify(captions)}`;
}
export function buildReviewChunks(doc: AuthoredDocument, lines: SourceLine[], maxChars = 60000): Array<{ document: AuthoredDocument; source: string }> {
  const whole = { document: doc, source: sourcePagesText(lines, [...new Set(lines.map(l => l.page))]) };
  if (JSON.stringify(doc).length + whole.source.length <= maxChars) return [whole];
  const groups = [...new Set(doc.questions.map(q => sectionKey(q.sectionTitle)))];
  const chunks: Array<{ document: AuthoredDocument; source: string }> = [];
  for (const group of groups) {
    const questions = doc.questions.filter(q => sectionKey(q.sectionTitle) === group);
    const pages = [...new Set(questions.flatMap(q => questionSourcePages(q, lines)))];
    const sectionDoc = { ...doc, questions, sections: doc.sections.filter(s => !group || sectionKey(s.title) === group) };
    const source = sourcePagesText(lines, pages);
    if (JSON.stringify(sectionDoc).length + source.length <= maxChars) chunks.push({ document: sectionDoc, source });
    else {
      // Large sections are split at page boundaries, never by cutting a question object or its stem.
      for (const page of pages) chunks.push({ document: { ...sectionDoc, questions: questions.filter(q => questionSourcePages(q, lines).includes(page)) }, source: sourcePagesText(lines, [page]) });
    }
  }
  return chunks.length ? chunks : [whole];
}
export function flaggedFixInput(doc: AuthoredDocument, verdicts: LoopVerdict[], lines: SourceLine[], audit = false): string {
  const numbers = new Set(verdicts.flatMap(v => v.questionNumbers));
  const imagePages = verdicts.map(v => v.page).filter((p): p is number => p !== undefined);
  const questions = flatAuthoredQuestions(doc).filter(q => numbers.has(q.number) || (imagePages.length && questionSourcePages(q, lines).some(p => imagePages.includes(p))));
  const pages = [...new Set([...questions.flatMap(q => questionSourcePages(q, lines)), ...imagePages])];
  const metaVerdicts = verdicts.filter(v => v.kind === 'meta-field-implausible');
  if (metaVerdicts.length) pages.push(1);
  const imageIds = new Set(verdicts.map(v => v.imageId).filter(Boolean));
  const images = [...imageIds];
  return JSON.stringify({ questions, meta: metaVerdicts.length ? doc.meta : undefined, images, verdicts: verdicts.map(v => ({ questionNumbers: v.questionNumbers, kind: v.kind, message: v.message, ...(v.probability !== undefined ? { probability: v.probability, choice: v.choice } : {}) })), ...(audit ? { instruction: 'One final patch pass. Fix only these audit-flagged items.' } : {}) })
    + `\n\nSOURCE PAGES:\n${sourcePagesText(lines, pages)}`
    + (metaVerdicts.length ? `\n\nFIRST PAGE HEADER LINES (re-read these; no separate metadata model):\n${lines.filter(l => l.page === 1).slice(0, 15).map(l => l.text).join('\n')}` : '');
}
/** Metadata is part of READ's object; only an explicitly flagged meta correction may change it in step 4/6. */
export function applyMetaCorrection(response: LoopModelResponse, doc: AuthoredDocument, verdicts: LoopVerdict[]): AuthoredDocument {
  if (!verdicts.some(v => v.kind === 'meta-field-implausible')) return doc;
  try {
    const raw = response.rawText?.trim() ? JSON.parse(response.rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')) : response.json;
    const meta = normalizeAuthoredDocument({ meta: raw?.meta ?? raw?.metadata }).meta;
    return Object.keys(meta).length ? { ...doc, meta: { ...doc.meta, ...meta } } : doc;
  } catch { return doc; }
}
