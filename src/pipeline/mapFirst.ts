/** Map-first READ: proposals and audit evidence, never a save gate. */
import type { AppSettings, ImageAsset, SourceLine } from '../types';
import { LLMAdapter } from '../providers/adapter';
import { DECIDE_CATCH, DECIDE_PASS, DECIDE_TIMEOUT_MS } from './audit';
import { resolveDecisionProvider, type LoopDecisionCaller } from './loopAudit';
import { enumerateExpectedQuestionNos } from './quality';
import { estimateTokens } from './memory/tokens';
import { errorMessage, flatAuthoredQuestions, normalizeAuthoredDocument, parseLoopJson, type AuthoredDocument, type LoopModelResponse, type LoopVerdict } from './localLoop';

export type MapStatus = 'counted' | 'audited' | 'uncertain' | 'disputed';
export interface MapSection { title: string; firstQuestion: number; lastQuestion: number; questionCount: number; kind: string; status: MapStatus }
export interface MapGroup { appliesToFirst: number; appliesToLast: number; text: string; status: MapStatus }
export interface MapPassage extends MapGroup { id: string; sectionTitle: string }
export interface MapImage { imageId: string; sectionTitle: string; aboutQuestion?: number; status: MapStatus }
export interface MapVerdict { id: string; kind: string; entryIds: string[]; message: string; questionNumbers: number[] }
export interface MapVote { entryId: string; kind: string; probability: number; choice?: string; indicted: boolean }
export interface LoopMapReceipt {
  meta: Record<string, unknown>; sections: MapSection[]; instructionGroups: MapGroup[]; passages: MapPassage[]; images: MapImage[];
  answerKey?: { present: boolean; firstQuestion?: number; lastQuestion?: number };
  codeVerdicts: MapVerdict[]; auditVotes: MapVote[]; remaps: Array<{ entryId: string; applied: boolean; reason: string; before?: unknown; after?: unknown }>;
  agreement: { agree: number; disagree: number; uncertain: number };
  auditCalls: number; auditErrors: number; auditUsage: { inputTokens: number; outputTokens: number };
  sectionFindings?: MapVerdict[];
  phase: 'map' | 'audit' | 'remap' | 'parse' | 'completed' | 'fallback'; currentSection?: string; parsedSections: number; totalSections: number; notes: string[];
}
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const positive = (v: unknown): number | undefined => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : undefined; };
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const status = 'counted' as const;
export const MAP_SYSTEM = `Map the WHOLE printed exam, not question bodies. Return ONLY JSON: {"meta":{"subject":"...","grade":"...","totalPoints":40,"durationMinutes":100},"sections":[{"title":"Listening","firstQuestion":1,"lastQuestion":8,"questionCount":8,"kind":"listening|vocabulary|grammar|reading|writing|other"}],"instructionGroups":[{"appliesToFirst":1,"appliesToLast":8,"text":"exact printed instruction"}],"passages":[{"id":"p1","sectionTitle":"Reading","appliesToFirst":41,"appliesToLast":45,"text":"full printed passage"}],"images":[{"imageId":"img_001","sectionTitle":"Listening","aboutQuestion":1}],"answerKey":{"present":false}}. Use ranges and counts only, never enumerate line numbers. Preserve instructions and passages verbatim and identify all printed sections and questions. Do not invent content or author questions. /no_think`;
export const REMAP_SYSTEM = `Correct ONLY the indicated map entry using the supplied source and quoted verdict. Return that single corrected section, instruction group, passage, or image object as JSON, with the same keys. Do not author questions or edit other entries. /no_think`;
export const SECTION_SYSTEM = `Read the supplied section as full authored JSON. Return {"sections":[{"title":"..."}],"questions":[{"number":1,"sectionTitle":"...","type":"mcq|truefalse|fillblank|short|matching|other","stem":"full printed question text","options":[{"key":"a","text":"..."}],"answer":"only if printed","points":1,"imageIds":[],"passageId":"p1"}],"passages":[]}. The map is a proposed contract, not permission to invent questions, answers, or points. Report only what the source contains. Use the printed question number to identify its section even for continuations at a boundary. Preserve blanks, all options, instructions, and image claims. Link passage-dependent questions to supplied passageId; do not copy passage into stems. Do not enumerate source lines. /no_think`;

export function parseExamMap(response: LoopModelResponse): LoopMapReceipt | undefined {
  const parsedResponse = parseLoopJson(response);
  const raw = obj(parsedResponse.value);
  if (!Array.isArray(raw.sections) || !raw.sections.length) return undefined;
  const sections: MapSection[] = raw.sections.map((s: any): MapSection | undefined => {
    const title = str(s?.title), firstQuestion = positive(s?.firstQuestion), lastQuestion = positive(s?.lastQuestion), count = Number(s?.questionCount);
    if (!title || !firstQuestion || !lastQuestion || s?.questionCount === null || s?.questionCount === undefined || s?.questionCount === '' || lastQuestion < firstQuestion || !Number.isInteger(count) || count < 0 || count > 1000) return undefined;
    return { title, firstQuestion, lastQuestion, questionCount: count, kind: str(s.kind) || 'other', status };
  }).filter((s: MapSection | undefined): s is MapSection => Boolean(s));
  if (!sections.length || sections.length !== raw.sections.length) return undefined;
  const group = (g: any): MapGroup | undefined => {
    const appliesToFirst = positive(g?.appliesToFirst), appliesToLast = positive(g?.appliesToLast), text = str(g?.text);
    if (!appliesToFirst || !appliesToLast || appliesToLast < appliesToFirst || !text) return undefined;
    return { appliesToFirst, appliesToLast, text, status };
  };
  const instructionGroups: MapGroup[] = (Array.isArray(raw.instructionGroups) ? raw.instructionGroups : []).map(group).filter((g: MapGroup | undefined): g is MapGroup => Boolean(g));
  const passages: MapPassage[] = (Array.isArray(raw.passages) ? raw.passages : []).map((p: any, i: number) => { const g = group(p); return g ? { ...g, id: str(p.id) || `p${i + 1}`, sectionTitle: str(p.sectionTitle) } : undefined; }).filter((p: MapPassage | undefined): p is MapPassage => Boolean(p));
  const images: MapImage[] = (Array.isArray(raw.images) ? raw.images : []).filter((i: any) => str(i?.imageId)).map((i: any) => ({ imageId: str(i.imageId), sectionTitle: str(i.sectionTitle), ...(positive(i.aboutQuestion) ? { aboutQuestion: positive(i.aboutQuestion) } : {}), status }));
  const malformedNotes = [ ...(parsedResponse.salvaged ? ['Map output required JSON salvage; review the proposed map.'] : []), ...[ ['instruction group', raw.instructionGroups, instructionGroups], ['passage', raw.passages, passages], ['image', raw.images, images] ].flatMap(([name, input, output]) => Array.isArray(input) && Array.isArray(output) && input.length > output.length ? [`${input.length - output.length} malformed ${name} map entr${input.length - output.length === 1 ? 'y was' : 'ies were'} omitted; teacher review required.`] : []) ];
  return { meta: obj(raw.meta), sections, instructionGroups, passages, images, ...(raw.answerKey && typeof raw.answerKey.present === 'boolean' ? { answerKey: { present: raw.answerKey.present, ...(positive(raw.answerKey.firstQuestion) ? { firstQuestion: positive(raw.answerKey.firstQuestion) } : {}), ...(positive(raw.answerKey.lastQuestion) ? { lastQuestion: positive(raw.answerKey.lastQuestion) } : {}) } } : {}), codeVerdicts: [], auditVotes: [], remaps: [], agreement: { agree: 0, disagree: 0, uncertain: 0 }, auditCalls: 0, auditErrors: 0, auditUsage: { inputTokens: 0, outputTokens: 0 }, phase: 'map', parsedSections: 0, totalSections: sections.length, notes: malformedNotes };
}
export function mapEntries(map: LoopMapReceipt): Array<{ id: string; value: MapSection | MapGroup | MapPassage | MapImage }> {
  return [ ...map.sections.map((value, i) => ({ id: `section:${i}`, value })), ...map.instructionGroups.map((value, i) => ({ id: `instruction:${i}`, value })), ...map.passages.map((value, i) => ({ id: `passage:${i}`, value })), ...map.images.map((value, i) => ({ id: `image:${i}`, value })) ];
}
export function countExamMap(map: LoopMapReceipt, lines: SourceLine[], images: ImageAsset[]): MapVerdict[] {
  const verdicts: MapVerdict[] = [];
  const add = (kind: string, entryIds: string[], message: string, questionNumbers: number[] = []) => verdicts.push({ id: `${kind}:${entryIds.join(',') || 'map'}:${questionNumbers.join(',')}`, kind, entryIds, message, questionNumbers });
  const expected = enumerateExpectedQuestionNos(lines).numbers;
  const max = Math.min(1000, Math.max(0, ...expected, ...map.sections.map(s => s.lastQuestion)));
  for (let i = 0; i < map.sections.length; i++) for (let j = i + 1; j < map.sections.length; j++) {
    const a = map.sections[i], b = map.sections[j], first = Math.max(a.firstQuestion, b.firstQuestion), last = Math.min(a.lastQuestion, b.lastQuestion);
    if (first <= last) add('section-overlap', [`section:${i}`, `section:${j}`], `Sections ${a.title} and ${b.title} overlap at Q${first}–${last}.`, [first, last]);
  }
  const missing: number[] = [];
  for (let n = 1; n <= max; n++) if (!map.sections.some(s => n >= s.firstQuestion && n <= s.lastQuestion)) missing.push(n);
  if (missing.length) {
    const adjacent = map.sections.flatMap((s,i)=>missing.some(n => n === s.firstQuestion - 1 || n === s.lastQuestion + 1) ? [`section:${i}`] : []);
    add('section-gap', adjacent, `Map leaves numbered gaps: ${missing.map(n => `Q${n}`).join(', ')} (highest ${max}).`, missing);
  }
  const total = map.sections.reduce((n, s) => n + s.questionCount, 0);
  if (total !== max) {
    const mismatched = map.sections.flatMap((s, i) => s.questionCount !== s.lastQuestion - s.firstQuestion + 1 ? [`section:${i}`] : []);
    add('section-count-total', mismatched.length ? mismatched : map.sections.map((_, i) => `section:${i}`), `Section counts sum to ${total}, not the highest question number ${max}.`);
  }
  const allRanges = [...map.instructionGroups.map((v,i)=>({ id:`instruction:${i}`, value:v })), ...map.passages.map((v,i)=>({ id:`passage:${i}`, value:v }))];
  for (const { id, value } of allRanges) if (!map.sections.some(s => value.appliesToFirst >= s.firstQuestion && value.appliesToLast <= s.lastQuestion)) add('scope-outside-section', [id], `${id} range Q${value.appliesToFirst}–${value.appliesToLast} is outside a section.`, [value.appliesToFirst, value.appliesToLast]);
  for (let i = 0; i < allRanges.length; i++) for (let j = i + 1; j < allRanges.length; j++) {
    const a = allRanges[i], b = allRanges[j];
    // A passage and an instruction may legitimately govern the same children; duplicates within the same category are suspect.
    if (a.id.split(':')[0] === b.id.split(':')[0] && a.value.appliesToFirst === b.value.appliesToFirst && a.value.appliesToLast === b.value.appliesToLast) add('duplicate-scope', [a.id, b.id], `${a.id} and ${b.id} claim the same range Q${a.value.appliesToFirst}–${a.value.appliesToLast}.`, [a.value.appliesToFirst, a.value.appliesToLast]);
  }
  map.images.forEach((image, i) => { if (!images.some(x => x.id === image.imageId)) add('unknown-image', [`image:${i}`], `Image inventory references unknown ${image.imageId}.`); });
  return verdicts;
}
function lineIndex(lines: SourceLine[], lineNo?: number): number { return lineNo === undefined ? -1 : lines.findIndex(l => Number(l.id.replace(/\D/g, '')) === lineNo); }
export function regionForRange(lines: SourceLine[], first: number, last: number, context = 30): SourceLine[] {
  const expected = enumerateExpectedQuestionNos(lines);
  const starts = expected.numbers.filter(n => n >= first && n <= last).map(n => lineIndex(lines, expected.lineByNumber.get(n))).filter(i => i >= 0);
  if (!starts.length) return lines;
  const start = Math.min(...starts); const next = expected.numbers.filter(n => n > last).map(n => lineIndex(lines, expected.lineByNumber.get(n))).filter(i => i > start).sort((a,b)=>a-b)[0];
  const end = next === undefined ? lines.length : next;
  const sectionPages = new Set(lines.slice(start, end).map(l => l.page));
  const pageIndices = lines.flatMap((l, i) => sectionPages.has(l.page) ? [i] : []);
  return lines.slice(Math.max(0, Math.min(start, ...pageIndices) - context), Math.min(lines.length, Math.max(end, ...pageIndices.map(i=>i+1)) + context));
}
export function edgeText(lines: SourceLine[], first: number, last: number, maxChars = 1800): string {
  const expected = enumerateExpectedQuestionNos(lines); const indexes = [first, last].map(n => lineIndex(lines, expected.lineByNumber.get(n))).filter(n => n >= 0);
  if (!indexes.length) return lines.slice(0, 10).map(l => l.text).join('\n').slice(0, maxChars);
  const selected = new Set<number>(); for (const idx of indexes) for (let i = Math.max(0, idx-3); i < Math.min(lines.length, idx+4); i++) selected.add(i);
  return [...selected].sort((a,b)=>a-b).map(i => lines[i].text).join('\n').slice(0, maxChars);
}
export function sectionContract(map: LoopMapReceipt, section: MapSection): object {
  return { section: { title: section.title, firstQuestion: section.firstQuestion, lastQuestion: section.lastQuestion, questionCount: section.questionCount, kind: section.kind, status: section.status },
    instructionGroups: map.instructionGroups.filter(g => g.appliesToFirst <= section.lastQuestion && g.appliesToLast >= section.firstQuestion),
    passages: map.passages.filter(p => p.sectionTitle === section.title || (p.appliesToFirst <= section.lastQuestion && p.appliesToLast >= section.firstQuestion)),
    images: map.images.filter(i => i.sectionTitle === section.title || (i.aboutQuestion !== undefined && i.aboutQuestion >= section.firstQuestion && i.aboutQuestion <= section.lastQuestion)), answerKey: map.answerKey };
}
export function sectionReadVerdicts(map: LoopMapReceipt | undefined, doc: AuthoredDocument): LoopVerdict[] {
  if (!map || map.phase === 'fallback') return [];
  const questions = flatAuthoredQuestions(doc);
  const counts: LoopVerdict[] = map.sections.flatMap((s,i) => {
    const found = [...new Set(questions.filter(q => q.number >= s.firstQuestion && q.number <= s.lastQuestion).map(q => q.number))];
    if (found.length === s.questionCount) return [];
    const numbers = Array.from({ length: Math.min(1000, s.lastQuestion-s.firstQuestion+1) }, (_, n) => s.firstQuestion+n);
    return [{ id: `code:section-count-mismatch:${i}`, kind: 'section-count-mismatch' as const, questionNumbers: numbers,
      message: `Section ${s.title} expected ${s.questionCount} questions (Q${s.firstQuestion}–${s.lastQuestion}); parsed ${found.length}. Check the map and source.`, source: 'code' as const }];
  });
  const passageLinks: LoopVerdict[] = map.passages.flatMap(p => questions.filter(q => q.number >= p.appliesToFirst && q.number <= p.appliesToLast && (q.passageId !== p.id || !doc.passages?.some(pass => pass.id === p.id))).map(q => ({
    id: `code:passage-link-missing:${p.id}:${q.number}`, kind:'passage-link-missing' as const, questionNumbers:[q.number], source:'code' as const,
    message:`The map proposes passage ${p.id} for Q${q.number}, but ${q.passageId === p.id ? 'the passage body is missing' : q.passageId ? `the section parse linked ${q.passageId}` : 'the section parse did not link a passage'}. Review the source and map.`,
  })));
  return [...counts, ...passageLinks];
}

export interface MapFirstReadParams {
  lines: SourceLine[]; images: ImageAsset[]; settings: AppSettings; guidance?: string; fileHash: string;
  call: (label: string, system: string, text: string) => Promise<LoopModelResponse>;
  decisionCaller?: LoopDecisionCaller;
  cacheGet: <T>(key: string) => Promise<T | undefined>; cacheSet: (key: string, value: unknown) => Promise<void>;
  cacheKey: (text: string) => Promise<string>;
  onUpdate?: (map: LoopMapReceipt) => void | Promise<void>;
  onNote?: (message: string) => void;
  onAuditUsage?: (usage: { inputTokens: number; outputTokens: number }, label: string) => void;
}
const sourceText = (lines: SourceLine[]) => lines.map(l => `PAGE ${l.page}: ${l.text}`).join('\n');
function remapRegion(lines: SourceLine[], first: number, last: number): SourceLine[] {
  const expected = enumerateExpectedQuestionNos(lines);
  const indexes = expected.numbers.filter(n => n >= first && n <= last).map(n => lineIndex(lines, expected.lineByNumber.get(n))).filter(i=>i>=0);
  if (!indexes.length) return lines;
  const start = Math.min(...indexes); const next = expected.numbers.filter(n=>n>last).map(n=>lineIndex(lines,expected.lineByNumber.get(n))).filter(i=>i>start).sort((a,b)=>a-b)[0];
  return lines.slice(Math.max(0,start-8), Math.min(lines.length, (next ?? Math.max(...indexes)+1)+8));
}
function rangeForEntry(map: LoopMapReceipt, id: string): [number, number] {
  const [kind, indexText] = id.split(':'); const i = Number(indexText);
  if (kind === 'section') { const s = map.sections[i]; return [s.firstQuestion, s.lastQuestion]; }
  if (kind === 'image') { const image = map.images[i]; const s = map.sections.find(s => s.title === image.sectionTitle); const n = image.aboutQuestion; return n ? [n, n] : s ? [s.firstQuestion, s.lastQuestion] : [1, 1000]; }
  const entry = kind === 'instruction' ? map.instructionGroups[i] : map.passages[i]; return [entry.appliesToFirst, entry.appliesToLast];
}
function setEntry(map: LoopMapReceipt, id: string, value: any): boolean {
  const [kind, indexText] = id.split(':'); const i = Number(indexText);
  const wrapper = { sections: kind === 'section' ? [value] : [{ title: 'placeholder', firstQuestion: 1, lastQuestion: 1, questionCount: 1, kind: 'other' }],
    instructionGroups: kind === 'instruction' ? [value] : [], passages: kind === 'passage' ? [value] : [], images: kind === 'image' ? [value] : [] };
  const parsed = parseExamMap({ rawText: JSON.stringify(wrapper) }); if (!parsed) return false;
  if (kind === 'section' && parsed.sections[0]) map.sections[i] = parsed.sections[0];
  else if (kind === 'instruction' && parsed.instructionGroups[0]) map.instructionGroups[i] = parsed.instructionGroups[0];
  else if (kind === 'passage' && parsed.passages[0]) map.passages[i] = parsed.passages[0];
  else if (kind === 'image' && parsed.images[0]) map.images[i] = parsed.images[0];
  else return false;
  return true;
}
async function auditMap(map: LoopMapReceipt, params: MapFirstReadParams): Promise<void> {
  const provider = resolveDecisionProvider(params.settings);
  if (!provider) { map.notes.push('Map audit skipped — no decide endpoint configured; raw map retained.'); return; }
  const mode = params.settings.decideMode ?? 'shadow';
  const items: Array<{ id: string; kind: string; instructions: string; choices?: string[]; first: number; last: number; context: unknown }> = [];
  map.sections.forEach((s, i) => {
    const contract = sectionContract(map, s); const common = { id: `section:${i}`, first: s.firstQuestion, last: s.lastQuestion, context: contract };
    items.push({ ...common, kind: 'section-boundary', instructions: `In the source, does section ${s.title} span questions ${s.firstQuestion}–${s.lastQuestion}?` });
    items.push({ ...common, kind: 'section-title', instructions: `Which section do questions ${s.firstQuestion}–${s.lastQuestion} belong to?`, choices: [...new Set([...map.sections.map(x=>x.title), 'other'])] });
    items.push({ ...common, kind: 'kind-plausible', instructions: `Is the declared kind ${s.kind} right for this section's questions?` });
  });
  map.instructionGroups.forEach((g,i) => items.push({ id:`instruction:${i}`, kind:'instruction-scope', first:g.appliesToFirst,last:g.appliesToLast, context:g, instructions:`Does this instruction govern questions ${g.appliesToFirst}–${g.appliesToLast}?` }));
  map.passages.forEach((p,i) => items.push({ id:`passage:${i}`, kind:'passage-scope', first:p.appliesToFirst,last:p.appliesToLast, context:p, instructions:`Is this the passage questions ${p.appliesToFirst}–${p.appliesToLast} refer to?` }));
  let errors = 0;
  for (const item of items) {
    const thx = provider.decideDialect === 'thx';
    // Keep the THX record compact without slicing JSON mid-object or dropping section criteria.
    const summarize = (value: unknown, limit: number): unknown => {
      if (typeof value === 'string') return value.length > limit ? `${value.slice(0,limit)}…` : value;
      if (Array.isArray(value)) return value.map(v => summarize(v, limit));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, k === 'title' || k === 'id' ? v : summarize(v, limit)]));
      return value;
    };
    let summaryLimit = thx ? 180 : 4000;
    let context = JSON.stringify(summarize(item.context, summaryLimit));
    let edge = edgeText(params.lines, item.first, item.last, thx ? 1200 : 10000);
    const name = `${item.id} ${item.kind}`;
    const makeBody = (): any => thx ? { model: provider.model, state: `Map entry: ${context}\nSource edges: ${edge}`, questions: { [name]: { type: item.choices ? 'choice' : 'noul', instructions: item.instructions, ...(item.choices ? { criteria: Object.fromEntries(item.choices.map(c=>[c,c])) } : {}) } } }
      : { input: { purpose: 'audit proposed exam map' }, questions: [{ name, type: item.choices ? 'choice' : 'probability', instructions: item.instructions, input: { entry: item.context, sourceEdges: edge }, ...(item.choices ? { choices: item.choices } : {}) }] };
    let body = makeBody();
    if (thx) {
      while (edge.length > 200 && estimateTokens(JSON.stringify(body)) > 900) { edge = edge.slice(0, Math.floor(edge.length * 0.8)); body = makeBody(); }
      while (summaryLimit > 20 && estimateTokens(JSON.stringify(body)) > 900) { summaryLimit = Math.max(20, Math.floor(summaryLimit * 0.7)); context = JSON.stringify(summarize(item.context, summaryLimit)); body = makeBody(); }
      if (estimateTokens(JSON.stringify(body)) > 1000) { map.notes.push(`Map audit ${item.kind} for ${item.id} exceeds the THX context cap; entry remains unreviewed.`); continue; }
    }
    const usage = { inputTokens: estimateTokens(JSON.stringify(body)), outputTokens: 0 };
    map.auditCalls++; map.auditUsage.inputTokens += usage.inputTokens;
    try {
      const caller = params.decisionCaller || ((body: any) => LLMAdapter.executeDecisions({ providerConfig: provider, body, timeoutMs: DECIDE_TIMEOUT_MS }));
      const response = await caller(body); usage.outputTokens = estimateTokens(JSON.stringify(response.results)); map.auditUsage.outputTokens += usage.outputTokens; errors = 0; const row = response.results.find(r=>r.name === name); const p = row?.probability;
      if (typeof p !== 'number' || !Number.isFinite(p)) { map.notes.push(`Map audit returned no usable ${item.kind} verdict for ${item.id}.`); continue; }
      errors = 0;
      let probability = Math.max(0, Math.min(1, p));
      if (item.kind === 'section-title') {
        const s = map.sections[Number(item.id.split(':')[1])];
        probability = row?.choice === s.title ? probability : row?.choice && item.choices?.includes(row.choice) ? 1 - probability : 0.5;
      }
      const indicted = mode === 'active' && probability <= DECIDE_CATCH;
      if (probability <= DECIDE_CATCH) map.agreement.disagree++; else if (probability >= DECIDE_PASS) map.agreement.agree++; else map.agreement.uncertain++;
      map.auditVotes.push({ entryId: item.id, kind: item.kind, probability, ...(row?.choice ? { choice: row.choice } : {}), indicted });
      const entry = mapEntries(map).find(e=>e.id === item.id)?.value;
      if (entry) {
        if (probability <= DECIDE_CATCH) entry.status = 'disputed';
        else if (entry.status !== 'disputed' && probability > DECIDE_CATCH && probability < DECIDE_PASS) entry.status = 'uncertain';
        else if (entry.status === 'counted' && probability >= DECIDE_PASS) entry.status = 'audited';
      }
    } catch (error) {
      errors++; map.auditErrors++; if (errors >= 5) { map.notes.push(`Map audit endpoint unreachable — skipped after ${errors} errors; parsing continues (${errorMessage(error)}).`); break; }
    } finally { try { params.onAuditUsage?.(usage, `Map audit · ${item.kind}`); } catch { /* usage is advisory */ } await params.onUpdate?.(map); }
  }
  if (errors > 0 && errors < 5) map.notes.push(`Map audit had ${errors} endpoint error(s); parsing continues.`);
  if (mode === 'shadow') map.notes.push('Map audit shadow mode — votes recorded; no audit indictments routed.');
}

/** Returns undefined when the map cannot be authored, so the caller can use the never-empty legacy fallback. */
export async function runMapFirstRead(params: MapFirstReadParams): Promise<{ map: LoopMapReceipt; document: AuthoredDocument } | undefined> {
  const guidance = params.guidance ? `\nPLAYBOOK AND SKILLS:\n${params.guidance}` : '';
  // Try the whole paper first. Split at page boundaries with 30 lines of overlap only when the provider reports a context limit.
  const chunks: SourceLine[][] = [params.lines];
  let map: LoopMapReceipt | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const text = `EXAM SOURCE${chunks.length > 1 ? ` (part ${i+1}/${chunks.length}, includes context overlap)` : ''}:\n${sourceText(chunks[i])}\n\nIMAGE INVENTORY: ${JSON.stringify(params.images.map(im=>({ imageId:im.id, page:im.page, caption:im.label?.caption })))}${guidance}`;
    let parsed: LoopMapReceipt | undefined;
    try { parsed = parseExamMap(await params.call(`Map · ${i+1}/${chunks.length}`, MAP_SYSTEM, text)); }
    catch (error) {
      const message = errorMessage(error);
      const pages = [...new Set(params.lines.map(l=>l.page))];
      if (i === 0 && chunks.length === 1 && pages.length > 1 && /context|token limit|too (?:large|long)|maximum.*length/i.test(message)) {
        const target = Math.max(1, Math.floor(sourceText(params.lines).length / 2));
        const split: SourceLine[][] = []; let current: SourceLine[] = [];
        for (const page of pages) {
          const owned = params.lines.filter(l=>l.page === page);
          if (current.length && sourceText([...current, ...owned]).length > target) { split.push(current); current = [...current.slice(-30), ...owned]; }
          else current.push(...owned);
        }
        if (current.length) split.push(current);
        if (split.length > 1) { chunks.splice(0, chunks.length, ...split); i = -1; map = undefined; params.onNote?.('Map context limit — retrying page-boundary chunks with 30-line overlap.'); continue; }
      }
      params.onNote?.(`Map unavailable — ${message}; falling back to page READ.`); return undefined;
    }
    if (!parsed) { params.onNote?.('Map output was unparseable or lacked section ranges — falling back to page READ.'); return undefined; }
    if (!map) map = parsed;
    else {
      for (const s of parsed.sections) if (!map.sections.some(x=>x.title===s.title && x.firstQuestion===s.firstQuestion && x.lastQuestion===s.lastQuestion)) map.sections.push(s);
      for (const g of parsed.instructionGroups) if (!map.instructionGroups.some(x=>x.appliesToFirst===g.appliesToFirst && x.appliesToLast===g.appliesToLast && x.text===g.text)) map.instructionGroups.push(g);
      for (const p of parsed.passages) if (!map.passages.some(x=>x.id===p.id && x.text===p.text)) map.passages.push(p);
      for (const image of parsed.images) if (!map.images.some(x=>x.imageId===image.imageId)) map.images.push(image);
      Object.assign(map.meta, Object.fromEntries(Object.entries(parsed.meta).filter(([k])=>map!.meta[k] === undefined)));
      if (parsed.answerKey?.present && !map.answerKey?.present) map.answerKey = parsed.answerKey;
    }
  }
  if (!map) return undefined;
  map.totalSections = map.sections.length;
  map.codeVerdicts = countExamMap(map, params.lines, params.images);
  for (const entry of mapEntries(map)) if (map.codeVerdicts.some(v=>v.entryIds.includes(entry.id))) entry.value.status = 'disputed';
  map.phase = 'audit'; await params.onUpdate?.(map);
  await auditMap(map, params);
  map.phase = 'remap'; await params.onUpdate?.(map);
  const affected = new Set([...map.codeVerdicts.flatMap(v=>v.entryIds), ...map.auditVotes.filter(v=>v.indicted).map(v=>v.entryId)]);
  for (const id of affected) {
    const entry = mapEntries(map).find(e=>e.id === id); if (!entry) continue;
    const messages = [...map.codeVerdicts.filter(v=>v.entryIds.includes(id)).map(v=>`code: ${v.message}`), ...map.auditVotes.filter(v=>v.entryId===id && v.indicted).map(v=>`audit ${v.kind} p=${v.probability.toFixed(2)}`)];
    const before = structuredClone(entry.value);
    const [first,last] = rangeForEntry(map,id); const region = remapRegion(params.lines, first, last);
    try {
      const response = await params.call(`Re-map · ${id}`, REMAP_SYSTEM, `ENTRY ${id}: ${JSON.stringify(entry.value)}\nINDICTMENTS: ${messages.join('; ')}\nSOURCE REGION:\n${sourceText(region)}${guidance}`);
      const raw = obj(parseLoopJson(response).value); const candidateValue = raw.entry || raw.section || raw.instructionGroup || raw.passage || raw.image || (id.startsWith('section:') ? raw.sections?.[0] : id.startsWith('instruction:') ? raw.instructionGroups?.[0] : id.startsWith('passage:') ? raw.passages?.[0] : raw.images?.[0]) || raw;
      const candidate = structuredClone(map);
      const prior = countExamMap(map, params.lines, params.images);
      const valid = setEntry(candidate, id, candidateValue);
      const next = valid ? countExamMap(candidate, params.lines, params.images) : [];
      const relatedRemain = next.some(v=>v.entryIds.includes(id));
      const introduced = next.some(v=>!prior.some(old=>old.id===v.id));
      const updated = mapEntries(candidate).find(e=>e.id === id)?.value as any;
      const previous = before as any;
      // A no-op cannot resolve a confident-wrong decision. Keep the original disputed instead of
      // calling it repaired; the section parse and self-review can still arbitrate it.
      const unchangedIndictment = map.auditVotes.filter(v=>v.entryId===id && v.indicted).some(v => {
        if (v.kind === 'section-boundary') return previous.firstQuestion === updated?.firstQuestion && previous.lastQuestion === updated?.lastQuestion;
        if (v.kind === 'section-title') return previous.title === updated?.title;
        if (v.kind === 'kind-plausible') return previous.kind === updated?.kind;
        if (v.kind === 'instruction-scope' || v.kind === 'passage-scope') return previous.appliesToFirst === updated?.appliesToFirst && previous.appliesToLast === updated?.appliesToLast && previous.text === updated?.text;
        return false;
      });
      if (!valid || relatedRemain || introduced || unchangedIndictment) {
        entry.value.status = 'disputed'; map.remaps.push({ entryId:id, applied:false, reason:'Invalid or still disputed; original retained.', before });
      } else {
        setEntry(map, id, candidateValue); map.remaps.push({ entryId:id, applied:true, reason:messages.join('; '), before, after:structuredClone(mapEntries(map).find(e=>e.id===id)?.value) });
      }
    } catch (error) { entry.value.status = 'disputed'; map.remaps.push({ entryId:id, applied:false, reason:`Original retained — ${errorMessage(error)}`, before }); }
    await params.onUpdate?.(map);
  }
  // Preserve original findings for the receipt; section-level checks use the final proposal.
  map.phase = 'parse'; await params.onUpdate?.(map);
  const documents: AuthoredDocument[] = [];
  const parse = async (label: string, contract: unknown, region: SourceLine[], fallbackTitle?: string, section?: MapSection) => {
    const keyLineNos = enumerateExpectedQuestionNos(params.lines).keyTerritory.lineNos;
    const regionIds = new Set(region.map(line => line.id));
    const keyLines = params.lines.filter(line => keyLineNos.has(Number(line.id.replace(/\D/g, ''))) && !regionIds.has(line.id));
    const text = `MAP CONTRACT: ${JSON.stringify(contract)}\nSECTION SOURCE (includes neighbouring context):\n${sourceText(region)}${keyLines.length ? `\n\nANSWER KEY SOURCE (if relevant to this section):\n${sourceText(keyLines)}` : ''}${guidance}`;
    const key = await params.cacheKey(`map-section-v1:${text}`);
    try {
      let response = await params.cacheGet<LoopModelResponse>(key); const cached = Boolean(response);
      if (!response) response = await params.call(label, SECTION_SYSTEM, text);
      const parsed = parseLoopJson(response); const document = normalizeAuthoredDocument(parsed.value);
      if (parsed.value === null || !document.questions.length) map.notes.push(`${label}: no complete questions returned${parsed.value === null ? ' (unreadable output)' : ''}.`);
      if (!cached && document.questions.length && !parsed.salvaged) await params.cacheSet(key, { rawText: response.rawText, json: response.json });
      const expected = enumerateExpectedQuestionNos(params.lines);
      if (section) {
        const outside = [...new Set(flatAuthoredQuestions(document).map(q=>q.number).filter(n=>n<section.firstQuestion || n>section.lastQuestion))];
        if (outside.length) {
          map.sectionFindings ||= [];
          map.sectionFindings.push({ id:`section-range-mismatch:${map.sections.indexOf(section)}`, kind:'section-range-mismatch', entryIds:[`section:${map.sections.indexOf(section)}`], questionNumbers:outside,
            message:`Section ${section.title} returned ${outside.map(n=>`Q${n}`).join(', ')} outside its mapped range Q${section.firstQuestion}–${section.lastQuestion}; assigned by number.` });
        }
      }
      for (const q of flatAuthoredQuestions(document)) {
        const owner = map.sections.find(s=>q.number>=s.firstQuestion && q.number<=s.lastQuestion);
        q.sectionTitle = owner?.title || (section ? 'Unmapped questions' : fallbackTitle || q.sectionTitle);
        const idx = lineIndex(params.lines, expected.lineByNumber.get(q.number));
        q.sourcePages = idx >= 0 ? [params.lines[idx].page] : [...new Set(region.map(l=>l.page))];
      }
      documents.push(document);
    } catch (error) { map.notes.push(`${label} skipped — ${errorMessage(error)}.`); }
  };
  for (const section of map.sections) {
    map.currentSection = section.title; await params.onUpdate?.(map);
    await parse(`Section parse · ${section.title}`, sectionContract(map,section), regionForRange(params.lines, section.firstQuestion, section.lastQuestion), section.title, section);
    map.parsedSections++; await params.onUpdate?.(map);
  }
  const expected = enumerateExpectedQuestionNos(params.lines);
  const parsedQuestions = documents.flatMap(doc => flatAuthoredQuestions(doc));
  const unmapped = [...new Set([...expected.numbers, ...parsedQuestions.map(q => q.number)].filter(n=>!map.sections.some(s=>n>=s.firstQuestion && n<=s.lastQuestion)))].sort((a,b)=>a-b);
  if (unmapped.length) {
    const verdict: MapVerdict = { id:'section-missing:source', kind:'section-missing', entryIds:[], questionNumbers:unmapped, message:`Numbered questions ${unmapped.map(n=>`Q${n}`).join(', ')} are outside every mapped section; one extra parse requested.` };
    map.codeVerdicts.push(verdict); map.currentSection = 'Unmapped questions'; await params.onUpdate?.(map);
    const pages = new Set([...unmapped.map(n=>lineIndex(params.lines,expected.lineByNumber.get(n))).filter(i=>i>=0).map(i=>params.lines[i].page), ...parsedQuestions.filter(q=>unmapped.includes(q.number)).flatMap(q=>q.sourcePages || [])]);
    const extraLines = pages.size ? params.lines.filter(l=>pages.has(l.page)) : params.lines;
    await parse('Section parse · unmapped', { title:'Unmapped questions', numberedQuestions:unmapped, instruction:'Parse the unmapped numbered questions on these pages.' }, extraLines, 'Unmapped questions');
  }
  const result: AuthoredDocument = { meta: { ...map.meta }, sections: map.sections.map(s=>({ title:s.title })), questions: [], instructionGroups: map.instructionGroups.map(({status: _s,...g})=>g), passages: [] };
  const byNumber = new Map<number, typeof result.questions[number]>();
  const mergeQuestion = (previous: typeof result.questions[number], q: typeof result.questions[number]) => {
    if (q.stem && !previous.stem.includes(q.stem)) previous.stem = q.stem.includes(previous.stem) ? q.stem : previous.stem ? `${previous.stem}\n${q.stem}` : q.stem;
    for (const option of q.options) {
      const old = previous.options.find(o=>o.key===option.key);
      if (!old) previous.options.push(structuredClone(option));
      else if (option.text && !old.text.includes(option.text)) old.text = option.text.includes(old.text) ? option.text : `${old.text}\n${option.text}`;
    }
    previous.imageIds = [...new Set([...previous.imageIds,...q.imageIds])]; previous.sourcePages = [...new Set([...(previous.sourcePages || []), ...(q.sourcePages || [])])];
    if (!previous.passageId && q.passageId) previous.passageId = q.passageId;
    if (previous.points === undefined) previous.points = q.points; if (previous.answer === undefined) previous.answer = q.answer;
    if (q.subQuestions?.length) {
      previous.subQuestions ||= [];
      for (const child of q.subQuestions) { const old = previous.subQuestions.find(existing => existing.number === child.number); if (old) mergeQuestion(old,child); else previous.subQuestions.push(structuredClone(child)); }
    }
    for (const [key,value] of Object.entries(q)) if (previous[key] === undefined) previous[key] = value;
  };
  for (const part of documents) {
    for (const [key,value] of Object.entries(part.meta)) if (result.meta[key] === undefined) result.meta[key] = value;
    for (const passage of part.passages || []) if (!result.passages!.some(p=>p.id===passage.id || (p.sectionTitle===passage.sectionTitle && p.text===passage.text))) result.passages!.push(passage);
    for (const section of part.sections) { const existing = result.sections.find(s=>s.title===section.title); if (existing) Object.assign(existing, section); else result.sections.push(section); }
    for (const q of part.questions) {
      const previous = byNumber.get(q.number);
      if (!previous) { const copy = structuredClone(q); result.questions.push(copy); byNumber.set(q.number, copy); }
      else mergeQuestion(previous, q);
    }
  }
  // A mapped passage is only projected into the document when the section reader
  // actually linked it. Otherwise it remains an unendorsed proposal in the map receipt.
  const linked = new Set(flatAuthoredQuestions(result).map(q => q.passageId).filter(Boolean));
  for (const { status: _status, ...passage } of map.passages) if (linked.has(passage.id) && !result.passages!.some(p => p.id === passage.id)) result.passages!.push(passage);
  result.questions.sort((a,b)=>a.number-b.number); map.phase = 'completed'; map.currentSection = undefined; await params.onUpdate?.(map);
  return { map, document: result };
}
