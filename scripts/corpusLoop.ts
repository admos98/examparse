/** #46 scripted-generative corpus mode. The script authors full question JSON from source text only;
 * truth.json is used afterwards for reporting, never to build the model response. No provider calls. */
import type { ImageAsset, SourceLine } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/store';
import { normalizeDigits } from '../src/pipeline/metaRead';
import { detectSectionHeaders, extractDocumentTotals, detectKeyTerritory } from '../src/pipeline/quality';
import { runLocalLoop } from '../src/pipeline/localLoopRunner';
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
export function scriptedLoopReader(lines: SourceLine[], images: ImageAsset[] = []): LoopModelCaller {
  const headers = detectSectionHeaders(lines);
  const keyLines = detectKeyTerritory(lines).lineNos;
  const total = extractDocumentTotals(lines, keyLines).documentTotal;
  return async req => {
    if (req.step !== 'read') return { rawText: JSON.stringify({ corrections: [] }), json: { corrections: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
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
