import type { ImageAsset, SourceLine } from '../types';

export const META_VERSION = 'meta-read-v1';
export const SUBJECT_LEXICON: Readonly<Record<string, string>> = {
  'زبان انگلیسی': 'English', انگلیسی: 'English', english: 'English',
  ریاضی: 'Math', mathematics: 'Math', math: 'Math',
  فیزیک: 'Physics', physics: 'Physics', شیمی: 'Chemistry', chemistry: 'Chemistry',
  زیست: 'Biology', 'زیست شناسی': 'Biology', biology: 'Biology',
  فارسی: 'Persian', persian: 'Persian', عربی: 'Arabic', arabic: 'Arabic',
  تاریخ: 'History', history: 'History', جغرافیا: 'Geography', geography: 'Geography',
};
const GRADE_WORDS: Readonly<Record<string, number>> = {
  اول: 1, یکم: 1, دوم: 2, سوم: 3, چهارم: 4, پنجم: 5, ششم: 6,
  هفتم: 7, هشتم: 8, نهم: 9, دهم: 10, یازدهم: 11, دوازدهم: 12,
};
export interface MetaField<T> { value: T; evidenceLine: number }
export interface MetaCandidate { subject?: MetaField<string>; grade?: MetaField<number>; total?: MetaField<number>; date?: MetaField<string> }
export interface MetaDefect { field: 'subject' | 'grade' | 'total' | 'date'; complaint: string; evidenceLine?: number }
export interface ValidatedMeta { value: MetaCandidate; defects: MetaDefect[] }
export interface MetaCaller { (request: { system: string; text: string; images?: Array<{ id: string; mime: string; data: string }>; label: string; maxOutputTokens: number; reasoningOff: true }): Promise<{ rawText: string; json?: unknown; usage?: { inputTokens: number; outputTokens: number } }> }

export const normalizeDigits = (text: string): string => String(text || '').replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const normalizeText = (text: string) => normalizeDigits(text).toLowerCase().replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[\u200c\s_-]+/g, ' ').trim();
export function normalizeGrade(value: unknown): number | undefined {
  const text = normalizeText(String(value ?? '')).replace(/^پایه\s+/, '');
  const numeric = Number(text.match(/\d{1,2}/)?.[0]);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  for (const [word, n] of Object.entries(GRADE_WORDS)) if (text === word || text.includes(`پایه ${word}`) || text.endsWith(` ${word}`)) return n;
  return undefined;
}
export function normalizeSubject(value: unknown): string | undefined {
  const text = normalizeText(String(value ?? ''));
  for (const [term, canonical] of Object.entries(SUBJECT_LEXICON)) if (text === normalizeText(term) || text.includes(normalizeText(term))) return canonical;
  return undefined;
}
function durationNumbers(lines: SourceLine[]): Set<number> {
  const out = new Set<number>();
  for (const line of lines) {
    const text = normalizeText(line.text);
    if (!/(مدت|زمان|دقیقه|duration|time|minutes?|صفحه|pages?)/i.test(text)) continue;
    for (const m of text.matchAll(/\d{1,3}/g)) out.add(Number(m[0]));
  }
  return out;
}
export function validateMetaCandidate(raw: any, lines: SourceLine[]): ValidatedMeta {
  const value: MetaCandidate = {}; const defects: MetaDefect[] = []; const lineSet = new Set(lines.map(l => Number(l.id.replace(/\D/g, ''))));
  const field = (name: string) => raw?.[name];
  const evidence = (f: any): number | undefined => { const n = Number(f?.evidenceLine ?? f?.line); return Number.isInteger(n) && lineSet.has(n) ? n : undefined; };
  const subjectField = field('subject');
  if (subjectField != null) { const subject = normalizeSubject(subjectField?.value ?? subjectField); const line = evidence(subjectField); if (subject && line) value.subject = { value: subject, evidenceLine: line }; else defects.push({ field: 'subject', complaint: subject ? 'subject has no valid evidence line' : 'subject is not in the bilingual subject lexicon', evidenceLine: line }); }
  else defects.push({ field: 'subject', complaint: 'subject is missing' });
  const gradeField = field('grade');
  if (gradeField != null) { const grade = normalizeGrade(gradeField?.value ?? gradeField); const line = evidence(gradeField); if (grade && line) value.grade = { value: grade, evidenceLine: line }; else defects.push({ field: 'grade', complaint: grade ? 'grade has no valid evidence line' : 'grade is not a recognised value from 1 to 12', evidenceLine: line }); }
  else defects.push({ field: 'grade', complaint: 'grade is missing' });
  const totalField = field('total') ?? field('totalPoints');
  if (totalField != null) {
    const total = Number(normalizeDigits(String(totalField?.value ?? totalField)).match(/\d{1,3}(?:\.\d+)?/)?.[0]); const line = evidence(totalField); const excluded = durationNumbers(lines);
    if (Number.isFinite(total) && total >= 10 && total <= 100 && !excluded.has(total) && line) value.total = { value: total, evidenceLine: line };
    else defects.push({ field: 'total', complaint: excluded.has(total) ? `proposed total ${total} is labelled as duration/time/pages in the header` : 'total must be 10–100 with a valid evidence line', evidenceLine: line });
  } else defects.push({ field: 'total', complaint: 'total is missing' });
  const dateField = field('date');
  if (dateField != null) { const text = String(dateField?.value ?? dateField).trim(); const line = evidence(dateField); if (text && line) value.date = { value: text, evidenceLine: line }; else defects.push({ field: 'date', complaint: 'date has no valid value/evidence line', evidenceLine: line }); }
  return { value, defects };
}
function parse(rawText: string, json?: unknown): any { if (json && typeof json === 'object') return json; try { return JSON.parse(rawText.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return {}; } }
const META_SYSTEM = `Read ONLY the exam metadata visible in these header/total lines. Return JSON {"subject":{"value":"...","line":1},"grade":{"value":"...","line":2},"total":{"value":40,"line":90},"date":{"value":"...","line":3}}. Every field needs its actual evidence line. Do not infer or guess. A duration, time, Listening subtotal, or page count is not the exam total. JSON only. Reasoning off. /no_think`;
const VISION_META_SYSTEM = `Read the printed Persian/English header box in the attached top third of page one. Return the same metadata JSON with line set to the nearest supplied header line. Never guess. Distinguish total marks from duration/time and subtotals. JSON only. /no_think`;
const lineNo = (l: SourceLine) => Number(l.id.replace(/\D/g, ''));
function agree(a: MetaCandidate, b: MetaCandidate, key: keyof MetaCandidate): boolean { return a[key]?.value === b[key]?.value; }
export interface MetaReadResult { meta: MetaCandidate; defects: MetaDefect[]; calls: number; usedVision: boolean; usage: { inputTokens: number; outputTokens: number }; candidates: MetaCandidate[] }

/** Two tiny local reads, then a first-page top-third vision tie-break when fields disagree or fail validation. */
export async function runMetaRead(params: { lines: SourceLine[]; printedTotalLine?: number; caller?: MetaCaller; visionCaller?: MetaCaller; firstPageTopThird?: { id: string; mime: string; data: string }; onJournal?: (e: { label: string; rawText: string; requestText: string }) => void | Promise<void> }): Promise<MetaReadResult> {
  const header = params.lines.filter(l => l.page === 1 && (l.y === undefined || l.pageHeight === undefined || l.y <= l.pageHeight / 3));
  const selected = [...header]; const totalLine = params.lines.find(l => lineNo(l) === params.printedTotalLine); if (totalLine && !selected.includes(totalLine)) selected.push(totalLine);
  const text = selected.map(l => `[${l.id}] ${l.text}`).join('\n'); const usage = { inputTokens: 0, outputTokens: 0 }; let calls = 0;
  const candidates: MetaCandidate[] = []; const defects: MetaDefect[] = [];
  if (params.caller) for (let i = 0; i < 2; i++) {
    try { const r = await params.caller({ system: META_SYSTEM, text, label: `Meta read ${i + 1}/2`, maxOutputTokens: 700, reasoningOff: true }); calls++; if (r.usage) { usage.inputTokens += r.usage.inputTokens || 0; usage.outputTokens += r.usage.outputTokens || 0; } await params.onJournal?.({ label: `Meta read ${i + 1}/2`, rawText: r.rawText, requestText: text }); const valid = validateMetaCandidate(parse(r.rawText, r.json), params.lines); candidates.push(valid.value); defects.push(...valid.defects); } catch { candidates.push({}); }
  }
  const merged: MetaCandidate = {}; const fields: Array<keyof MetaCandidate> = ['subject', 'grade', 'total', 'date'];
  for (const key of fields) if (candidates.length >= 2 && agree(candidates[0], candidates[1], key) && candidates[0][key]) (merged as any)[key] = candidates[0][key];
  const unresolved = fields.filter(k => !merged[k]); let usedVision = false;
  if (unresolved.length && params.visionCaller && params.firstPageTopThird) {
    try { const r = await params.visionCaller({ system: VISION_META_SYSTEM, text, images: [params.firstPageTopThird], label: 'Meta vision tie-break', maxOutputTokens: 700, reasoningOff: true }); calls++; usedVision = true; if (r.usage) { usage.inputTokens += r.usage.inputTokens || 0; usage.outputTokens += r.usage.outputTokens || 0; } await params.onJournal?.({ label: 'Meta vision tie-break', rawText: r.rawText, requestText: text }); const valid = validateMetaCandidate(parse(r.rawText, r.json), params.lines); candidates.push(valid.value); for (const key of unresolved) if (valid.value[key]) (merged as any)[key] = valid.value[key]; } catch { /* unresolved fields remain null by omission */ }
  }
  const finalDefects = fields.filter(k => !merged[k]).map(field => ({ field, complaint: `couldn't read the ${field} — tap to set` } as MetaDefect));
  return { meta: merged, defects: finalDefects, calls, usedVision, usage, candidates };
}

export function imageAsMetaInput(image?: string): { id: string; mime: string; data: string } | undefined {
  if (!image?.startsWith('data:')) return undefined; const match = image.match(/^data:([^;]+);base64,(.+)$/); return match ? { id: 'page-1-top-third', mime: match[1], data: match[2] } : undefined;
}
void (null as unknown as ImageAsset);
