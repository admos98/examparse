/** #46 scripted-generative corpus mode. The script authors full question JSON from source text only;
 * truth.json is used afterwards for reporting, never to build the model response. No provider calls. */
import type { ImageAsset, SourceLine } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/store';
import { normalizeDigits } from '../src/pipeline/metaRead';
import { detectSectionHeaders, extractDocumentTotals, detectKeyTerritory } from '../src/pipeline/quality';
import { runLocalLoop } from '../src/pipeline/localLoopRunner';
import { modelFacingLines } from '../src/pipeline/lineNormalize';
import { projectAuthoredDocument, type LoopModelCaller, type LoopReceipt } from '../src/pipeline/localLoop';

const numberAt = (text: string): number | undefined => {
  const m = /^\s*(\d{1,3})[.)、]\s*/.exec(normalizeDigits(text));
  return m ? Number(m[1]) : undefined;
};
const pointsIn = (text: string): number | undefined => {
  const m = /(?:\((\d+(?:\.\d+)?)\s*(?:marks?|points?|pts?|نمره)\)|\[(\d+(?:\.\d+)?)\])\s*$/i.exec(normalizeDigits(text));
  return m ? Number(m[1] ?? m[2]) : undefined;
};
function splitOptions(text: string): { stem: string; options: Array<{ key: string; text: string }> } {
  const re = /(?:^|\s)([a-d]|[الفبج د])\)\s*/gi;
  const matches = [...text.matchAll(re)];
  if (matches.length < 2) return { stem: text, options: [] };
  const stem = text.slice(0, matches[0].index).trim();
  const options = matches.map((m, i) => ({ key: m[1].toLowerCase(), text: text.slice((m.index || 0) + m[0].length, matches[i + 1]?.index ?? text.length).trim() })).filter(o => o.text);
  return { stem, options };
}
/** #50 Part B: a numbered cloze blank — "(9) ......", "(9) …" or "...... (9)". */
const BLANK_RE = /\((\d{1,3})\)\s*(?:[._…]{2,}|…)|(?:[._…]{2,}|…)\s*\((\d{1,3})\)/g;
export const blanksIn = (text: string): number[] => [...normalizeDigits(text).matchAll(BLANK_RE)].map(m => Number(m[1] ?? m[2]));
/** The sentence-ish excerpt around blank (n): the printed words only, never invented. */
function blankExcerpt(passage: string, n: number): string {
  const at = passage.search(new RegExp(`\\(\\s*${n}\\s*\\)`));
  if (at < 0) return `(${n}) ........`;
  const from = Math.max(0, passage.lastIndexOf(' ', Math.max(0, at - 60)));
  const toSpace = passage.indexOf(' ', Math.min(passage.length, at + 60));
  return passage.slice(from, toSpace < 0 ? passage.length : toSpace).trim();
}
interface ScriptedPassage { id: string; sectionTitle: string; appliesToFirst: number; appliesToLast: number; text: string; blanks: number[] }
export function scriptedLoopReader(sourceLines: SourceLine[], images: ImageAsset[] = []): LoopModelCaller {
  // The script stands in for the model, so it sees what the model sees (#50 Part C): normalized twins, no watermarks.
  const lines = modelFacingLines(sourceLines);
  const headers = detectSectionHeaders(lines);
  const keyLines = detectKeyTerritory(lines).lineNos;
  const total = extractDocumentTotals(lines, keyLines).documentTotal;
  // Cloze passages: maximal runs of unnumbered, non-header lines that print numbered blanks.
  const clozePassages: ScriptedPassage[] = [];
  {
    let run: SourceLine[] = [];
    const flush = () => {
      const withBlanks = run.map((l, i) => ({ i, blanks: blanksIn(l.text) })).filter(r => r.blanks.length);
      if (withBlanks.length) {
        const body = run.slice(withBlanks[0].i, withBlanks.at(-1)!.i + 1);
        const blanks = [...new Set(withBlanks.flatMap(r => r.blanks))].sort((a, b) => a - b);
        const lineNo = Number(body[0].id.replace(/\D/g, ''));
        const header = [...headers].reverse().find(h => h.headerLine <= lineNo);
        clozePassages.push({ id: `p${clozePassages.length + 1}`, sectionTitle: header?.title || 'Unsectioned', appliesToFirst: blanks[0], appliesToLast: blanks.at(-1)!, text: body.map(l => normalizeDigits(l.text)).join(' '), blanks });
      }
      run = [];
    };
    for (const line of lines) {
      const no = Number(line.id.replace(/\D/g, ''));
      if (keyLines.has(no) || numberAt(line.text) !== undefined || headers.some(h => h.headerLine === no)) { flush(); continue; }
      run.push(line);
    }
    flush();
  }
  const clozeLineIds = new Set(clozePassages.flatMap(p => lines.filter(l => blanksIn(l.text).some(n => p.blanks.includes(n))).map(l => l.id)));
  const legacyReader: LoopModelCaller = async req => {
    if (req.step !== 'parse') return { rawText: JSON.stringify({ corrections: [] }), json: { corrections: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    const page = Number(/PAGE (\d+) SOURCE:/.exec(req.text)?.[1] || 0);
    const owned = lines.filter(l => l.page === page && !keyLines.has(Number(l.id.replace(/\D/g, ''))));
    const questions: any[] = [];
    let current: any;
    let section = '';
    for (const line of owned) {
      const header = headers.find(h => h.headerLine === Number(line.id.replace(/\D/g, '')));
      if (header) { section = header.title; current = undefined; continue; }
      const no = numberAt(line.text);
      if (no !== undefined) {
        const body = normalizeDigits(line.text).replace(/^\s*\d{1,3}[.)、]\s*/, '');
        const split = splitOptions(body);
        current = { number: no, sectionTitle: section || undefined, type: split.options.length >= 2 ? 'mcq' : 'short', stem: split.stem, options: split.options, imageIds: images.filter(i => i.page === page && i.anchorLine === Number(line.id.replace(/\D/g, ''))).map(i => i.id), ...(pointsIn(body) !== undefined ? { points: pointsIn(body) } : {}) };
        questions.push(current); continue;
      }
      if (clozeLineIds.has(line.id)) { current = undefined; continue; }
      if (current) {
        const split = splitOptions(line.text);
        if (split.options.length) current.options.push(...split.options);
        else current.stem += `\n${line.text}`;
        const p = pointsIn(line.text); if (p !== undefined) current.points = p;
      }
    }
    const doc = { meta: { ...(total !== undefined ? { totalPoints: total } : {}), pages: Math.max(1, ...lines.map(l => l.page)) }, sections: [...new Set(questions.map(q => q.sectionTitle).filter(Boolean))].map(title => ({ title })), questions };
    return { rawText: JSON.stringify(doc), json: doc, usage: { inputTokens: Math.ceil(req.text.length / 4), outputTokens: Math.ceil(JSON.stringify(doc).length / 4) } };
  };
  return async req => {
    if (req.step === 'map' && req.label.startsWith('Map ·')) {
      const candidates = lines.filter(l => !keyLines.has(Number(l.id.replace(/\D/g, '')))).flatMap(l => {
        const n = numberAt(l.text); if (n === undefined) return [];
        const lineNo = Number(l.id.replace(/\D/g, ''));
        const header = [...headers].reverse().find(h => h.headerLine <= lineNo);
        return [{ n, title: header?.title || 'Unsectioned', kind: header?.kind || 'other' }];
      });
      // Each numbered blank IS a question of the section its passage sits in.
      for (const passage of clozePassages) for (const n of passage.blanks) candidates.push({ n, title: passage.sectionTitle, kind: headers.find(h => h.title === passage.sectionTitle)?.kind || 'other' });
      const byNumber = new Map<number, { n:number; title:string; kind:string }>();
      for (const row of candidates) if (!byNumber.has(row.n)) byNumber.set(row.n, row);
      const sorted = [...byNumber.values()].sort((a,b)=>a.n-b.n);
      const sections: Array<{ title:string; firstQuestion:number; lastQuestion:number; questionCount:number; kind:string }> = [];
      for (const row of sorted) {
        const prior = sections.at(-1);
        if (prior && prior.title === row.title) { prior.lastQuestion = row.n; prior.questionCount++; }
        else sections.push({ title:row.title, firstQuestion:row.n, lastQuestion:row.n, questionCount:1, kind:row.kind });
      }
      // Scripted map is derived from printed numbering and headings, never truth.json.
      if (sections.length) {
        const result = { meta: { ...(total !== undefined ? { totalPoints: total } : {}) }, sectionCount: sections.length, sections, instructionGroupCount: 0, instructionGroups:[], passageCount: clozePassages.length, passages: clozePassages, imageCount: 0, images:[] };
        return { rawText: JSON.stringify(result), json: result };
      }
    }
    if (req.step === 'parse' && req.label.startsWith('Section parse ·')) {
      const pages = [...new Set(lines.map(l => l.page))];
      const pieces = await Promise.all(pages.map(page => legacyReader({ ...req, text: `PAGE ${page} SOURCE:` })));
      const docs = pieces.map(p => p.json as any);
      let contract: any = {};
      try { contract = JSON.parse(req.text.split('MAP CONTRACT: ')[1].split('\nSECTION SOURCE')[0]); } catch { /* scripted fallback */ }
      const range = contract.section;
      const numbers: number[] | undefined = contract.numberedQuestions;
      const wanted = (n: number) => range ? n >= range.firstQuestion && n <= range.lastQuestion : numbers ? numbers.includes(n) : true;
      const questions = docs.flatMap(d=>d.questions || []).filter((q:any) => wanted(q.number));
      // One fillblank question per contract blank: stem = the printed words around the blank, linked to its passage.
      const contractPassages: any[] = Array.isArray(contract.passages) ? contract.passages : [];
      const passages: any[] = [];
      for (const passage of contractPassages) {
        const blanks: number[] = (Array.isArray(passage.blanks) ? passage.blanks : []).filter((n: number) => wanted(n) && !questions.some((q: any) => q.number === n));
        if (!blanks.length) continue;
        passages.push({ id: passage.id, sectionTitle: passage.sectionTitle || range?.title, text: passage.text });
        for (const n of blanks) questions.push({ number: n, sectionTitle: range?.title || passage.sectionTitle, type: 'fillblank', stem: blankExcerpt(String(passage.text || ''), n), options: [], imageIds: [], passageId: passage.id });
      }
      questions.sort((a: any, b: any) => a.number - b.number);
      const result = { meta: docs[0]?.meta || {}, sections: docs.flatMap(d=>d.sections || []), questionCount: questions.length, questions, passages };
      return { rawText: JSON.stringify(result), json: result };
    }
    return legacyReader(req);
  };
}
export interface LoopCorpusScore {
  exam: string; questions: string; sections: string; points: string; recallRatio: number;
  survivingVerdicts: number; notes: number; receipt: LoopReceipt;
}
export async function scoreLoopEntry(exam: string, lines: SourceLine[], truth: { expectedNumbers: number[]; sectionTitles: string[]; totalPoints: number }, images: ImageAsset[] = []): Promise<LoopCorpusScore> {
  const settings = { ...DEFAULT_SETTINGS, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false }, roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: undefined } } as any;
  const receipt = await runLocalLoop({ lines, images, settings, fileHash: `corpus-${exam}`, caller: scriptedLoopReader(lines, images), modelId: 'scripted-generative-v1' });
  const projected = projectAuthoredDocument(receipt.document);
  const expected = new Set(truth.expectedNumbers);
  const found = new Set(projected.questions.map(q => q.no));
  const hits = [...expected].filter(n => found.has(n)).length;
  const sectionTitles = new Set(projected.sections.map(s => s.title));
  const sectionHits = truth.sectionTitles.filter(t => sectionTitles.has(t)).length;
  const points = projected.questions.reduce((s, q) => s + (q.points || 0), 0);
  return { exam, questions: `${hits}/${expected.size}`, sections: `${sectionHits}/${truth.sectionTitles.length}`, points: `${points}/${truth.totalPoints}`, recallRatio: expected.size ? hits / expected.size : 1, survivingVerdicts: receipt.survivingVerdicts.length, notes: receipt.notes.length, receipt };
}
