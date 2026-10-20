/** 2A — Semantic local validators. Pure, deterministic, 0 model calls.
 * Run inside the assembly funnel so fresh/resumed/chunked/imported docs all get them.
 * Heuristic humility: shape suspicions are info, only structural contradictions warn. */
import type { ExamSection, Question } from '../types';
import { normalizeForMatching } from './quality';

export interface SemanticIssue {
  code: 'ANSWER_ANCHOR_SUSPECT' | 'STEM_SHAPE_SUSPECT' | 'OPTION_DUPLICATE' | 'PASSAGE_DETACHED' | 'PASSAGE_CONTAINS_STEM' | 'SECTION_SPAN_OUTSIDE';
  severity: 'info' | 'warn';
  questionId?: string;
  message: string;
  keys?: string[]; // offending option keys for OPTION_DUPLICATE
}

const norm = (t?: string) => normalizeForMatching(t || '').replace(/\s+/g, ' ').trim();
const BLANK_RE = /……|\.\.\.|___|…{2,}|\(\s*\)|\(\s*\.+\s*\)|_{2,}|-{3,}/;
const PASSAGE_REF_RE = /passage|reading text|text above|listening|dialogue|conversation|متن|قطعه|درک مطلب|شنیداری|گفتگو/i;

function answerContainsNumber(text: string, no: number): boolean {
  const n = norm(text);
  return new RegExp(`(^|\\D)${no}(\\D|$)`).test(n);
}

/** (a)–(e) validators over assembled questions. */
function spanLineNumbers(spans: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (const [a, b] of spans || []) for (let n = a; n <= b; n++) out.push(n);
  return out;
}

export function validateSemantic(questions: Question[], sections: ExamSection[] = []): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const sectionById = new Map((sections || []).map(s => [s.id, s]));
  const answerTexts = (questions || []).map(q => norm(q.answer?.text));
  for (const q of questions || []) {
    // (a) ANSWER-ANCHOR
    if (q.answer?.source === 'paper' && q.answer.text && norm(q.answer.text)) {
      const seg = norm(q.answer.text);
      const distinctFromSiblings = answerTexts.filter(t => t && t === seg).length <= 1 && seg.length > 0;
      if (!answerContainsNumber(q.answer.text, q.no) && !distinctFromSiblings) {
        issues.push({ code: 'ANSWER_ANCHOR_SUSPECT', severity: 'warn', questionId: q.id, message: `Q${q.no}: paper answer segment neither contains printed number ${q.no} nor differs from sibling segments.` });
      }
    }
    // (b) BLANK-POSITION (info only — heuristic humility)
    if ((q.type === 'fillblank' || q.type === 'mcq') && q.stem && !BLANK_RE.test(q.stem)) {
      // MCQ stems very often legitimately have no blank; only flag fillblank, or MCQ stems ending mid-phrase.
      if (q.type === 'fillblank' || /[:：]\s*$/.test(q.stem.trim()) || /\b(?:is|are|was|the|a|an|of|to)\s*$/i.test(q.stem.trim())) {
        issues.push({ code: 'STEM_SHAPE_SUSPECT', severity: 'info', questionId: q.id, message: `Q${q.no}: ${q.type} stem has no blank marker (……/.../___). Heuristic only.` });
      }
    }
    // (c) OPTION-DISTINCTNESS
    if (q.options && q.options.length > 1) {
      const seen = new Map<string, string>();
      const badKeys: string[] = [];
      for (const opt of q.options) {
        const t = norm(opt.text);
        if (!t) continue;
        if (seen.has(t) || t === norm(q.stem)) badKeys.push(opt.key);
        else seen.set(t, opt.key);
      }
      if (badKeys.length) issues.push({ code: 'OPTION_DUPLICATE', severity: 'warn', questionId: q.id, keys: badKeys, message: `Q${q.no}: options not pairwise distinct / equal stem — keys: ${badKeys.join(', ')}.` });
    }
    const section = q.sectionId ? sectionById.get(q.sectionId) : undefined;
    // (d) PASSAGE-ATTACHMENT
    const refText = `${q.stem || ''} ${section?.title || ''} ${section?.instructions || ''}`;
    if (section && PASSAGE_REF_RE.test(refText)) {
      if (!section.passage || section.passage.trim().length < 10) {
        issues.push({ code: 'PASSAGE_DETACHED', severity: 'warn', questionId: q.id, message: `Q${q.no}: references a passage/listening text but its section has none attached.` });
      } else if (q.stem && norm(section.passage).includes(norm(q.stem)) && norm(q.stem).length > 12) {
        issues.push({ code: 'PASSAGE_CONTAINS_STEM', severity: 'info', questionId: q.id, message: `Q${q.no}: section passage contains this stem verbatim — stem may have been sliced from the passage.` });
      }
    }
    // (e) SECTION-CONTAINMENT: ≥80% of question span lines inside section spans
    if (section && section.spans?.length && q.spans?.length) {
      const qLines = spanLineNumbers(q.spans);
      const sLines = new Set(spanLineNumbers(section.spans));
      if (qLines.length) {
        const inside = qLines.filter(n => sLines.has(n)).length;
        if (inside / qLines.length < 0.8) {
          issues.push({ code: 'SECTION_SPAN_OUTSIDE', severity: 'warn', questionId: q.id, message: `Q${q.no}: only ${inside}/${qLines.length} span lines inside section "${section.title || section.id}".` });
        }
      }
    }
  }
  return issues;
}

export function semanticIssuesFor(issues: SemanticIssue[], questionId: string): SemanticIssue[] {
  return issues.filter(i => i.questionId === questionId);
}

/** Confidence calibration input: warn −0.08, info −0.02, capped at −0.20 per question. */
export function semanticConfidenceDeduction(issues: SemanticIssue[]): number {
  const d = issues.reduce((s, i) => s + (i.severity === 'warn' ? 0.08 : 0.02), 0);
  return Math.min(0.2, d);
}

/**
 * Deterministic L0 fixes applied before any model call (2A): re-split an option
 * whose text blob contains a later option marker (classic two-options-per-line),
 * which is the common cause of OPTION_DUPLICATE. Mutates a copy; returns fix count.
 */
export function applySemanticDeterministicFixes(questions: Question[]): { questions: Question[]; fixes: Array<{ questionId: string; kind: string }> } {
  const fixes: Array<{ questionId: string; kind: string }> = [];
  const out = questions.map(q => {
    if (!q.options || q.options.length < 2) return q;
    const texts = q.options.map(o => norm(o.text));
    const hasDup = new Set(texts.filter(Boolean)).size !== texts.filter(Boolean).length;
    if (!hasDup) return q;
    const options = q.options.map(o => ({ ...o }));
    let changed = false;
    // A blob like "red b) blue" holds two options on one line: first duplicated
    // option keeps the head fragment, the next duplicated option takes the tail.
    const fragments: string[] = [];
    for (const opt of options) {
      const m = (opt.text || '').match(/^([\s\S]*?)\s+(?:[b-dB-D]|[۲-۴2-4])\s*[).．]\s+([\s\S]+)$/);
      if (m && norm(m[1]) && norm(m[2]) && norm(m[1]) !== norm(m[2])) fragments.push(m[1].trim(), m[2].trim());
    }
    if (fragments.length >= 2) {
      let fi = 0;
      const dupText = norm(options.find(o => fragments.includes((o.text || '').split(/\s+(?:[b-dB-D])\s*[).．]\s+/)[0].trim()))?.text || '');
      for (const opt of options) {
        if (fi < fragments.length && (norm(opt.text) === dupText || (opt.text || '').includes(fragments[0]))) { opt.text = fragments[fi++]; changed = true; }
      }
    }
    if (changed && new Set(options.map(o => norm(o.text))).size === options.filter(o => norm(o.text)).length) {
      fixes.push({ questionId: q.id, kind: 'option-split' });
      return { ...q, options };
    }
    return q;
  });
  return { questions: out, fixes };
}
