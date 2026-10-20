/**
 * F1–F3 — golden gauntlet: scorecard gates on the lazy-span fixture, the Iranian-layout
 * BEFORE/AFTER table, cleanup-off hash equality, and the CLEANUP_AI_SKIPPED fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { applyLocalGates } from '../src/pipeline/gates';
import { CLEANUP_VERSION, renderCleanView, runCleanupStage } from '../src/pipeline/cleanup';
import { headerAnchors } from '../src/pipeline/ownership';
import { enumerateExpectedQuestionNos, getExamHealth } from '../src/pipeline/quality';
import { expandWireV2 } from '../src/pipeline/structure';
import { fixture as iranian } from './fixtures/golden/iranian-rtl';
import { fixture as gauntlet } from './fixtures/golden/gauntlet-lazy';
import type { ExamDoc, SourceLine } from '../src/types';

interface FunnelOptions { gapCompletion?: boolean; gates?: boolean; cleanup?: boolean; lines?: SourceLine[]; caller?: Parameters<typeof runCleanupStage>[0]['caller'] }
/** The bench funnel in miniature: scripted wire → raw questions → assemble → local gates → doc. */
async function funnel(fx: any, opts: FunnelOptions = {}) {
  const sourceLines: SourceLine[] = opts.lines || fx.sourceLines;
  const enumerated = enumerateExpectedQuestionNos(sourceLines);
  let rawQuestions: any[] = [];
  const sections: any[] = [];
  let meta: any = {};
  for (const resp of fx.mockStructureResponses || []) {
    const expanded = expandWireV2(resp.wire);
    rawQuestions = [...rawQuestions, ...(expanded.questions || [])];
    if (expanded.sections) sections.push(...expanded.sections);
    if (expanded.meta) meta = { ...meta, ...expanded.meta };
  }
  const totalPoints = meta.totalPoints || fx.expected.pointsTotal;
  const cleanup = await runCleanupStage({ lines: sourceLines, keyLines: enumerated.keyTerritory.lineNos, pages: 5, expectedNumbers: enumerated.numbers, enabled: opts.cleanup, caller: opts.caller });
  const lines = cleanup.lines;
  const assembled = assembleAndValidateQuestions(rawQuestions, lines, totalPoints, {
    keyTerritoryLineNos: [...enumerated.keyTerritory.lineNos],
    gapCompletion: opts.gapCompletion,
  } as any);
  let questions = assembled.questions;
  let finalSections: any[] = sections;
  let finalTotal = totalPoints;
  let flags = [...assembled.flags];
  let orphanRate = 0;
  if (opts.gates !== false) {
    const g = applyLocalGates({ questions, rawSections: sections, lines, keyLines: enumerated.keyTerritory.lineNos, metaTotalPoints: totalPoints });
    questions = g.questions; finalSections = g.sections; finalTotal = g.totalPoints ?? totalPoints; flags = [...flags, ...g.flags]; orphanRate = g.ownership.orphanRate;
  }
  const doc: ExamDoc = {
    id: `fx-${fx.id}`, fileHash: fx.id, createdAt: '2026-10-20', displayName: fx.id,
    meta: { totalPoints: finalTotal, language: meta.language || 'en', direction: 'ltr' },
    sections: finalSections.map((s: any, i: number) => ({ id: s.id || `sec_${i + 1}`, index: s.index || i + 1, title: s.title || s.kind || `Section ${i + 1}`, spans: s.spans || s.p })),
    questions, images: [],
    source: { lines, pages: 5, fileName: `${fx.id}.pdf`, ocrUsed: false, keyTerritoryLineNos: [...enumerated.keyTerritory.lineNos] },
    flags, usage: [],
  } as ExamDoc;
  return { doc, cleanup, orphanRate, enumerated };
}
const hollowCount = (doc: ExamDoc) => doc.flags.filter((f) => f.code === 'STEM_HOLLOW').length;
const mcqUnder2 = (doc: ExamDoc) => doc.questions.filter((q) => q.type === 'mcq' && (q.options || []).filter((o) => (o.text || '').trim().length >= 2).length < 2).length;
/** Questions whose first stem line falls outside the spans of the section they are filed under. */
const misfiled = (doc: ExamDoc) => doc.questions.filter((q) => {
  const sec = doc.sections.find((s) => s.id === q.sectionId);
  const line = q.spans[0]?.[0];
  return !sec || line === undefined || !sec.spans.some(([a, b]) => line >= a && line <= b);
}).length;
/** Content hash that ignores cleanup tags/flags/stats — what F3 says may NOT change when cleanup is off. */
function contentHash(doc: ExamDoc): string {
  const strip = (q: any) => ({ id: q.id, no: q.no, stem: q.stem, type: q.type, points: q.points, spans: q.spans, sectionId: q.sectionId, options: (q.options || []).map((o: any) => ({ label: o.label, text: o.text, spans: o.spans })) });
  const payload = {
    questions: doc.questions.map(strip),
    sections: doc.sections.map((s) => ({ id: s.id, title: s.title, spans: s.spans })),
    total: doc.meta.totalPoints,
    lines: doc.source.lines.map((l) => ({ id: l.id, page: l.page, text: l.text, furniture: l.furniture })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

test('F1 — gauntlet-lazy: dumb lazy-span model still yields 0 hollow stems, every MCQ ≥2 options, orphan 0, document total, header sections', async () => {
  const { doc, orphanRate } = await funnel(gauntlet);
  const health = getExamHealth(doc);
  const headers = headerAnchors(doc.source.lines).map((h) => h.title);
  const card = {
    STEM_HOLLOW: hollowCount(doc),
    mcqUnder2: mcqUnder2(doc),
    orphanRate,
    totalPoints: doc.meta.totalPoints,
    documentTotal: 20,
    sections: doc.sections.map((s) => s.title),
    headers,
    coverage: health.coveragePercent,
    state: health.state,
  };
  console.log(`gauntlet scorecard: ${JSON.stringify(card)}`);
  assert.equal(card.STEM_HOLLOW, 0);
  assert.equal(card.mcqUnder2, 0);
  assert.equal(card.orphanRate, 0);
  assert.equal(card.totalPoints, 20, 'META_TOTAL: document wins over the model\'s wrong meta (25)');
  assert.ok(doc.flags.some((f) => f.code === 'META_TOTAL_CORRECTED'));
  assert.deepEqual(card.sections, headers, 'sections == header set');
  assert.ok(health.state === 'green' || doc.flags.some((f) => f.severity === 'error'), 'coverage green or honest partial');
});

test('F2 — Iranian-layout golden BEFORE/AFTER: hollow, misfiling, points, tokens saved', async () => {
  const before = await funnel(iranian, { gapCompletion: false, gates: false, cleanup: false });
  const after = await funnel(iranian);
  const hb = getExamHealth(before.doc);
  const ha = getExamHealth(after.doc);
  const pts = (h: ReturnType<typeof getExamHealth>) => (h.pointsExpected ? Math.round((h.pointsParsed / h.pointsExpected) * 100) : 100);
  const tokensBefore = after.cleanup.stats.tokensBefore;
  const tokensAfter = after.cleanup.stats.tokensAfter;
  const tokensSavedPct = tokensBefore ? Number((((tokensBefore - tokensAfter) / tokensBefore) * 100).toFixed(1)) : 0;
  const rows = [
    ['hollow stems (STEM_HOLLOW)', hollowCount(before.doc), hollowCount(after.doc)],
    ['misfiled questions (outside own section)', misfiled(before.doc), misfiled(after.doc)],
    ['points parsed %', pts(hb), pts(ha)],
    ['coverage %', hb.coveragePercent, ha.coveragePercent],
    ['orphan rate %', '—', Number((after.orphanRate * 100).toFixed(1))],
    ['prompt tokens (clean view)', tokensBefore, tokensAfter],
    ['% tokens saved', '—', tokensSavedPct],
  ];
  console.log('| metric | BEFORE | AFTER |\n|---|---:|---:|\n' + rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n'));
  assert.ok(hollowCount(after.doc) <= hollowCount(before.doc));
  assert.equal(hollowCount(after.doc), 0, 'lazy one-line spans are completed into real stems');
  assert.ok(misfiled(after.doc) <= misfiled(before.doc));
  assert.equal(misfiled(after.doc), 0);
  assert.ok(pts(ha) >= pts(hb));
  assert.equal(after.orphanRate, 0);
  // Local-only cleanup can only add prefixes (page numbers are omitted); real savings come from AI-confirmed junk.
  assert.ok(tokensAfter <= tokensBefore * 1.02, 'clean view overhead stays within 2% when no AI junk is confirmed');
});

test('F3 — cleanup off produces the same document hash (tags/flags excluded); AI tags never move text', async () => {
  // Scripted cleanup model: tags every judged line (instruction/header/keep) — the kind of verdict that may only become a tag.
  const tagger: NonNullable<FunnelOptions['caller']> = async (req) => {
    const ids = [...req.text.matchAll(/^(L\d{4}) (.*)$/gm)].map((m) => [m[1], m[2]] as const);
    return { rawText: JSON.stringify({ v: ids.map(([id, text]) => [id, /^(choose|complete|match|read|write|answer|true or false)/i.test(text) ? 'instruction' : /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(text.trim()) ? 'header' : 'keep', 9]) }), usage: { inputTokens: 200, outputTokens: 60 } };
  };
  for (const fx of [iranian, gauntlet]) {
    const off = await funnel(fx, { cleanup: false });
    const localOnly = await funnel(fx);
    const ai = await funnel(fx, { caller: tagger });
    assert.equal(off.cleanup.stats.source, 'off');
    assert.equal(off.cleanup.calls, 0);
    assert.equal(localOnly.cleanup.calls, 0, 'no caller ⇒ local pre-pass only');
    assert.ok(ai.cleanup.calls >= 1 && !ai.cleanup.stats.aiSkipped, 'AI cleanup ran');
    assert.equal(contentHash(localOnly.doc), contentHash(off.doc), `${fx.id}: AI-off must equal the deterministic local pass`);
    assert.equal(contentHash(ai.doc), contentHash(off.doc), `${fx.id}: AI tags must not change stored content (tags/flags excluded)`);
    assert.ok(ai.doc.source.lines.every((l, i) => l.text === fx.sourceLines[i].text && l.id === fx.sourceLines[i].id), 'text/ids untouched');
    assert.ok(ai.doc.source.lines.some((l) => l.tagSource === 'ai'), 'AI verdicts landed as tags');
    const tagged = localOnly.doc.source.lines.filter((l) => l.tag);
    assert.ok(tagged.length > 0 && tagged.every((l) => l.tagSource === 'local'));
  }
});

test('F3 — CLEANUP_AI_SKIPPED: shape-mismatch replies (after one retry) fall back to local tags and never block the parse', async () => {
  const enumerated = enumerateExpectedQuestionNos(gauntlet.sourceLines);
  let calls = 0;
  const labels: string[] = [];
  const result = await runCleanupStage({
    lines: gauntlet.sourceLines,
    keyLines: enumerated.keyTerritory.lineNos,
    pages: 5,
    expectedNumbers: enumerated.numbers,
    caller: async (req) => { calls++; labels.push(req.label); return { rawText: '{"verdicts":"not the shape you asked for"}', usage: { inputTokens: 100, outputTokens: 10 } }; },
  });
  assert.equal(calls, 2, 'one attempt + exactly one retry');
  assert.match(labels[1], /retry/);
  assert.ok(result.stats.aiSkipped);
  assert.ok(result.flags.some((f) => f.code === 'CLEANUP_AI_SKIPPED' && f.severity === 'warn'));
  assert.equal(result.aiVerdicts.length, 0);
  assert.ok(result.lines.every((l) => !l.tag || l.tagSource === 'local'), 'only local tags survive');
  assert.ok(result.lines.every((l, i) => l.text === gauntlet.sourceLines[i].text));
  // The clean view still renders (the parse continues) and omits nothing that was not AI-confirmed junk.
  const view = renderCleanView(result.lines, enumerated.keyTerritory.lineNos);
  const byNo = new Map(result.lines.map((l) => [Number(l.id.replace(/\D/g, '')), l]));
  assert.ok(view.omitted.every((n) => byNo.get(n)?.tag === 'pagenum' && byNo.get(n)?.tagSource === 'local'), 'only bare page numbers are omitted without AI');
  assert.ok(typeof CLEANUP_VERSION === 'string' && CLEANUP_VERSION.length > 0);

  // A3 fences: a model that calls everything junk cannot delete printed-number / option / blank lines.
  const junkAll = await runCleanupStage({
    lines: gauntlet.sourceLines,
    keyLines: enumerated.keyTerritory.lineNos,
    pages: 5,
    expectedNumbers: enumerated.numbers,
    caller: async (req) => {
      const ids = [...req.text.matchAll(/^(L\d{4}) /gm)].map((m) => m[1]);
      return { rawText: JSON.stringify({ v: ids.map((id) => [id, 'junk', 9]) }), usage: { inputTokens: 100, outputTokens: 50 } };
    },
  });
  assert.ok(junkAll.stats.fenceSaved > 0, 'fence saved printed-number/option/blank lines');
  assert.ok(junkAll.flags.some((f) => f.code === 'CLEANUP_FENCE_SAVED'));
  const printed = junkAll.lines.filter((l) => /^\s*\d{1,3}[.)]\s/.test(l.text) || /^\s*[a-d][).]\s/.test(l.text));
  assert.ok(printed.every((l) => l.tag !== 'junk'), 'no printed-number or option line is junk');
  console.log(`cleanup fences: judged ${junkAll.stats.judged}, junk ${junkAll.stats.junk}, suspect ${junkAll.stats.suspect}, fence-saved ${junkAll.stats.fenceSaved}`);
});

test('D — rewrite fence: only locally garbled, digit-free, in-span, non-key lines ≤140 chars; garbled-ratio routing threshold', async () => {
  const { rewriteRejection, REWRITE_MAX_CHARS } = await import('../src/pipeline/assemble');
  const { sectionGarbledRatio, GARBLED_ESCALATION_RATIO } = await import('../src/pipeline/structure');
  const garbled: SourceLine = { id: 'L0010', page: 1, text: 'th�e c�at s�at o�n t�he m�at', garbled: true };
  const clean: SourceLine = { id: 'L0011', page: 1, text: 'The cat sat on the mat' };
  const numbered: SourceLine = { id: 'L0012', page: 1, text: '12. th�e c�at', garbled: true };
  const key: SourceLine = { id: 'L0013', page: 1, text: 'k�ey l�ine', garbled: true, tag: 'key' };
  const allowed = new Set([10, 11, 12, 13]);
  assert.equal(rewriteRejection({ line: 10, text: 'the cat sat on the mat' }, garbled, new Set(), allowed), undefined, 'garbled line accepted');
  assert.match(rewriteRejection({ line: 11, text: 'anything' }, clean, new Set(), allowed)!, /not locally garbled/);
  assert.match(rewriteRejection({ line: 12, text: 'the cat' }, numbered, new Set(), allowed)!, /printed number|digits/);
  assert.match(rewriteRejection({ line: 13, text: 'key line' }, key, new Set(), allowed)!, /key territory/);
  assert.match(rewriteRejection({ line: 10, text: 'x'.repeat(REWRITE_MAX_CHARS + 1) }, garbled, new Set(), allowed)!, /longer than 140/);
  assert.match(rewriteRejection({ line: 10, text: 'the cat sat on 2 mats' }, garbled, new Set(), allowed)!, /introduces digits/);
  assert.match(rewriteRejection({ line: 10, text: 'ok' }, garbled, new Set(), new Set([99]))!, /outside question spans/);
  assert.match(rewriteRejection({ line: 10, text: 'ok' }, garbled, new Set([10]), allowed)!, /key territory/);
  const lines: SourceLine[] = [garbled, clean, numbered, { id: 'L0014', page: 1, text: 'w�rd', garbled: true }, { id: 'L0015', page: 1, text: '3', tag: 'pagenum' }];
  assert.equal(sectionGarbledRatio(lines), 3 / 4, 'page numbers excluded from the denominator');
  assert.ok(sectionGarbledRatio(lines) > GARBLED_ESCALATION_RATIO);
  assert.equal(sectionGarbledRatio([clean]), 0);
});

test('schema — docs carrying cleanup/critic/consensus usage records and tagged lines survive export → import', async () => {
  const { parseExamDocImport } = await import('../src/utils/validation');
  const doc: any = {
    id: 'doc_schema_1', fileHash: 'a'.repeat(64), createdAt: new Date().toISOString(),
    meta: { language: 'en', direction: 'ltr', totalPoints: 2 },
    sections: [{ id: 'sec_1', index: 1, title: 'A', spans: [[1, 3]] }],
    questions: [{ id: 'q1', no: 1, label: '1', type: 'mcq', spans: [[2, 2]], stem: '1. Choose the right verb form.', options: [{ key: 'a', spans: [[3, 3]], text: 'go' }, { key: 'b', spans: [[3, 3]], text: 'goes' }], rewrites: [{ line: 2, text: 'x' }], flags: ['GAP_ABSORBED', 'REWRITE_APPLIED'], points: 2, confidence: 0.9, images: [], sectionId: 'sec_1' }],
    images: [],
    source: { lines: [{ id: 'L0001', page: 1, text: 'Section A', tag: 'header', tagSource: 'local' }, { id: 'L0002', page: 1, text: '1. Choose the right verb form.', tag: 'question', tagSource: 'ai', tagConf: 8, garbled: false }, { id: 'L0003', page: 1, text: 'a) go b) goes' }], pages: 1, ocrUsed: false, fileName: 'x.pdf', orphanLineNos: [], cleanupStats: { judged: 1, junk: 0, suspect: 0, fenceSaved: 0, aiSkipped: false, linesBefore: 3, linesAfter: 3, tokensBefore: 10, tokensAfter: 10, source: 'ai' } },
    flags: [{ id: 'f1', severity: 'info', code: 'ORPHAN_LINES', message: 'none' }],
    usage: [
      { ts: 't', role: 'cleanup', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, label: 'Cleanup (1 call)' },
      { ts: 't', role: 'critic', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, label: 'Critic' },
      { ts: 't', role: 'consensus', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, label: 'Consensus' },
    ],
  };
  const parsed = parseExamDocImport(JSON.stringify(doc));
  assert.equal(parsed.error, undefined, parsed.error);
  assert.equal(parsed.doc?.usage?.length, 3);
  assert.equal((parsed.doc?.source.lines[1] as any).tag, 'question');
});
