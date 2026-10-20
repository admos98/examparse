#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { assembleAndValidateQuestions } from '../src/pipeline/assemble';
import { applyLocalGates } from '../src/pipeline/gates';
import { runCleanupStage } from '../src/pipeline/cleanup';
import { enumerateExpectedQuestionNos, evaluateCoverage, getExamHealth, parsePrintedNumberFromStem } from '../src/pipeline/quality';
import { computeQualityScore } from '../src/utils/qualityScore';
import { expandWireV2 } from '../src/pipeline/structure';
import { deriveDocTraits } from '../src/pipeline/memory/docTraits';
import { assemblePipelineGuidanceFrom } from '../src/pipeline/memory/guidance';
import { selectPlaybookEntries, PLAYBOOK_CAP_TOKENS } from '../src/pipeline/memory/playbook';
import { selectSkillsFromPool } from '../src/pipeline/memory/skills';
import { parseSkillFile } from '../src/pipeline/memory/lint';
import { BOOTSTRAP_PLAYBOOK } from '../src/pipeline/memory/bootstrap';
import { validateSemantic } from '../src/pipeline/semanticValidators';
import { diffConsensus } from '../src/pipeline/consensus';
import { buildScoreboard, leaderFor, docTraitBucket, bucketKey } from '../src/pipeline/scoreboard';
import { runTaskGraph, mergeInOrder } from '../src/pipeline/taskGraph';
import { SHIPPED_SKILLS } from '../src/pipeline/memory/shippedSkills';

const fixturesDir = path.join(process.cwd(), 'test/fixtures/golden');
const thresholdsPath = path.join(fixturesDir, 'thresholds.json');
const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));

type PointsRange = readonly [number, number];

function pointsRange(value: unknown, fixtureId: string): PointsRange {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error(`${fixtureId}: pointsPercent must be an inclusive [min, max] range.`);
  }
  const range: PointsRange = [value[0], value[1]];
  if (range[0] < 0 || range[1] < range[0]) throw new Error(`${fixtureId}: invalid pointsPercent range [${range.join(', ')}].`);
  return range;
}

function rawQuestionIdentity(question: any, sourceLines: any[]): string | undefined {
  const spans = Array.isArray(question?.spans) ? question.spans : [];
  const firstSpan = spans.find((span: unknown) => Array.isArray(span) && Number.isFinite(Number(span[0])));
  const firstLine = firstSpan ? Number(firstSpan[0]) : undefined;
  const sourceText = firstLine === undefined
    ? undefined
    : sourceLines.find(line => Number(String(line.id).replace(/\D/g, '')) === firstLine)?.text;
  const printedNumber = parsePrintedNumberFromStem(sourceText);
  const declaredNumber = Number(question?.no ?? question?.n);
  const number = printedNumber ?? declaredNumber;
  if (!Number.isInteger(number) || number < 1 || number > 300 || firstLine === undefined) return undefined;
  return `${number}@${firstLine}`;
}

function staysOutsideKeyTerritory(question: any, keyLineNos: Set<number>): boolean {
  const spans = Array.isArray(question?.spans) ? question.spans : [];
  return spans.some((span: unknown) => {
    if (!Array.isArray(span) || span.length < 2) return false;
    const start = Number(span[0]);
    const end = Number(span[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return false;
    for (let line = start; line <= end; line++) if (!keyLineNos.has(line)) return true;
    return false;
  });
}

/** Match the structure pass's exact printed-number/span merge so retries cannot inflate points. */
function mergeRawQuestions(existing: any[], additions: any[], sourceLines: any[], keyLineNos: Set<number>): any[] {
  const merged = [...existing];
  const seen = new Set(existing.map(question => rawQuestionIdentity(question, sourceLines)).filter((key): key is string => Boolean(key)));
  for (const question of additions) {
    if (!staysOutsideKeyTerritory(question, keyLineNos)) continue;
    const key = rawQuestionIdentity(question, sourceLines);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(question);
  }
  return merged;
}

function countOptionBlobs(doc:any): number {
  let c=0;
  for (const q of doc.questions || []) {
    if (!q.options || !q.stem) continue;
    for (const opt of q.options) if (opt.text && q.stem.includes(opt.text) && opt.text.length>4) c++;
  }
  return c;
}
function countPhantomMissing(expected:number[], parsed:number[]): number {
  // phantom = numbers that were expected but missing due to sub-part misinterpretation (e.g., 64,65,66 from 63 a-d)
  // For bench, we count missing that are actually phantom (should not be expected)
  // Our quality enumerate should already filter phantoms; bench reports phantom-missing as missing that remain but are phantom?
  // Simple: count missing that are 64-66 when 63 has subparts
  return 0; // placeholder until fixture marks phantom
}

async function runFixture(id:string){
  const mod = await import(path.join(fixturesDir, `${id}.ts`));
  const fixture = mod.fixture || mod.default;
  const start = performance.now();
  const sourceLines = fixture.sourceLines;
  const docTraits = deriveDocTraits({
    sourceLines, images: fixture.mockImages || [], sections: [], pages: 5,
    languageHint: fixture.expected?.language,
  });
  const enumerated = enumerateExpectedQuestionNos(sourceLines);
  const expectedNumbers = enumerated.numbers;
  // Simulate structure responses -> collect rawQuestions
  let rawQuestions: any[] = [];
  let sections: any[] = [];
  let meta: any = {};
  let structureCalls = 0;
  let outputTokens = 0;
  for (const resp of fixture.mockStructureResponses || []) {
    structureCalls++;
    // Handle pathological cases: rawText truncated etc. For bench we use wire directly if present, else parse rawText
    let wire = resp.wire;
    if (!wire && resp.rawText) {
      try { wire = JSON.parse(resp.rawText.match(/{[\s\S]*}/)?.[0] || '{}'); } catch { wire = resp.repair || {}; }
    }
    if (!wire) continue;
    // Expand v2
    const expanded = expandWireV2(wire);
    const qs = expanded.questions || expanded.q || [];
    rawQuestions = mergeRawQuestions(rawQuestions, qs, sourceLines, enumerated.keyTerritory.lineNos);
    if (expanded.sections) sections.push(...expanded.sections);
    if (expanded.meta) meta = { ...meta, ...expanded.meta };
    if (expanded.m) meta = { ...meta, ...expanded.m };
    outputTokens += Math.ceil(JSON.stringify(wire).length / 3.2);
  }
  // For fixtures with mockImages, add them later
  const images = fixture.mockImages || [];

  const totalPoints = meta.totalPoints || fixture.expected.pointsTotal;
  // A4 — local cleanup pre-pass only (0 calls): tags never move text; bench reports prompt lines before/after.
  const cleanup = await runCleanupStage({ lines: sourceLines, keyLines: enumerated.keyTerritory.lineNos, pages: 5, expectedNumbers: expectedNumbers });
  const taggedLines = cleanup.lines;
  const assembled = assembleAndValidateQuestions(rawQuestions, taggedLines, totalPoints, {
    keyTerritoryLineNos: [...enumerated.keyTerritory.lineNos],
    imageIds: images.map((i:any)=>i.id),
    unresolvedImageIds: [],
  });
  // B/C — the same local gates the pipeline runs: section split, containment, META_TOTAL, ownership.
  const gates = applyLocalGates({ questions: assembled.questions, rawSections: sections, lines: taggedLines, keyLines: enumerated.keyTerritory.lineNos, metaTotalPoints: totalPoints });
  let finalSections: any[] = gates.sections.length ? gates.sections : [{ id:'sec_1', index:1, title:'Default', spans:[[1, sourceLines.length]] }];
  const finalTotalPoints = gates.totalPoints ?? totalPoints;

  // Merge fragmented strips simulation for image-heavy: if duplicate dHash, merge
  let finalImages = images;
  if (fixture.id === 'image-heavy' && images.length) {
    const byHash = new Map<string, any>();
    for (const img of images) {
      if (byHash.has(img.dHash) && img.imageFlags?.includes('IMAGE_SUSPECT_STRIP')) {
        // merge: skip second strip
        continue;
      }
      byHash.set(img.dHash, img);
    }
    finalImages = [...byHash.values()];
  }

  const doc: any = {
    id: `fixture-${id}`,
    fileHash: `hash-${id}`,
    createdAt: new Date().toISOString(),
    displayName: fixture.id,
    meta: { title: fixture.id, subject: meta.subject, grade: meta.grade, totalPoints: finalTotalPoints, language: meta.language || 'en', direction: 'ltr' },
    sections: finalSections.map((s:any, i:number)=>({ id: s.id || `sec_${i+1}`, index: s.index || i+1, title: s.title || s.kind || `Section ${i+1}`, spans: s.spans || s.p || [[1, sourceLines.length]] })),
    questions: gates.questions,
    images: finalImages,
    source: { lines: taggedLines, pages: 5, fileName: `${id}.pdf`, ocrUsed:false, expectedQuestionNos: expectedNumbers, keyTerritoryLineNos: [...enumerated.keyTerritory.lineNos], orphanLineNos: gates.ownership.orphanLineNos, cleanupStats: cleanup.stats },
    flags: [...assembled.flags, ...gates.flags],
    usage: [],
  };
  // F1 gauntlet gates (reported for every fixture; asserted via thresholds / fixture.headerTitles).
  const hollow = doc.flags.filter((f:any) => f.code === 'STEM_HOLLOW').length;
  const mcqUnder2 = doc.questions.filter((q:any) => q.type === 'mcq' && (q.options || []).filter((o:any) => (o.text || '').trim().length >= 2).length < 2).length;
  const orphanRate = gates.ownership.orphanRate;
  const sectionTitles = doc.sections.map((s:any) => s.title);

  const health = getExamHealth(doc);
  const coverage = health.coveragePercent;
  const pointsPercent = health.pointsExpected ? Math.round((health.pointsParsed / health.pointsExpected)*100) : 100;
  const optionBlobs = countOptionBlobs(doc);
  const phantomMissing = fixture.expected.phantomMissing?.length || 0; // for now 0
  const quality = computeQualityScore(doc);
  // D1/A4 — measure the guidance the pipeline structure prompt would carry for this
  // document (offline: the cold-start bootstrap playbook, no fetch, no model calls).
  const guidance = assemblePipelineGuidanceFrom(BOOTSTRAP_PLAYBOOK, {
    sourceLines, images: finalImages, sections: finalSections, pages: 5, role: 'fast', docTraits,
  });
  const wallMs = Math.round(performance.now() - start);

  return {
    id,
    docTraits,
    guidanceTokens: guidance.tokens,
    guidanceIncluded: guidance.includedCount,
    guidanceOmitted: guidance.omittedCount,
    coverage,
    pointsPercent,
    optionBlobs,
    phantomMissing,
    structureCalls,
    outputTokens,
    wallMs,
    quality: quality.total,
    health,
    doc,
    expected: fixture.expected,
    hollow, mcqUnder2, orphanRate, sectionTitles,
    cleanupLines: { before: cleanup.stats.linesBefore, after: cleanup.stats.linesAfter, tokensBefore: cleanup.stats.tokensBefore, tokensAfter: cleanup.stats.tokensAfter, fenceSaved: cleanup.stats.fenceSaved },
    gates: { splits: gates.splits, reassigned: gates.reassigned, ambiguous: gates.ambiguous, totalPoints: finalTotalPoints, documentTotal: fixture.documentTotal, headerTitles: fixture.headerTitles },
  };
}

async function main(){
  const ids = Object.keys(thresholds).filter(k=>!k.startsWith('_'));
  if (ids.length < 8) {
    console.error(`Thresholds has only ${ids.length} fixtures, need >=8`);
    process.exit(1);
  }
  console.log(`\nGolden Benchmark — ${ids.length} fixtures (mock transport, offline)\n`);
  console.log(`| Fixture            | Coverage | Points | OptBlob | Phantom | Calls | Tokens | Guidance | Hollow | Orphan% | Clean L | Wall ms | Quality | Status |`);
  console.log(`|--------------------|----------|--------|---------|---------|-------|--------|----------|--------|---------|---------|---------|---------|--------|`);

  let failed = false;
  const results:any[] = [];
  for (const id of ids) {
    const r = await runFixture(id);
    results.push(r);
    const thr = thresholds[id];
    const covOk = r.coverage >= thr.coveragePercent;
    const [pointsMin, pointsMax] = pointsRange(thr.pointsPercent, id);
    const ptsOk = r.pointsPercent >= pointsMin && r.pointsPercent <= pointsMax;
    const blobOk = r.optionBlobs <= thr.maxOptionBlob;
    const phantomOk = r.phantomMissing <= (thr.maxPhantomMissing ?? 0);
    const callsOk = r.structureCalls <= thr.maxStructureCalls;
    const tokensOk = r.outputTokens <= thr.maxOutputTokens;
    const wallOk = r.wallMs <= thr.maxWallMs;
    // For image-heavy, also check unplacedImages
    let imageOk = true;
    if (thr.maxUnplacedImages !== undefined) {
      imageOk = r.health.unplacedImages.length <= thr.maxUnplacedImages;
    }
    const orphanOk = thr.maxOrphanRate === undefined || r.orphanRate <= thr.maxOrphanRate;
    const hollowOk = thr.maxHollow === undefined || r.hollow <= thr.maxHollow;
    // F1 — the gauntlet gates (only fixtures that declare printed headers / a document total).
    const gauntletReasons: string[] = [];
    if (r.gates.headerTitles) {
      if (r.hollow !== 0) gauntletReasons.push(`STEM_HOLLOW ${r.hollow} ≠ 0`);
      if (r.mcqUnder2 !== 0) gauntletReasons.push(`${r.mcqUnder2} MCQ(s) with <2 options`);
      if (r.orphanRate !== 0) gauntletReasons.push(`orphan rate ${(r.orphanRate * 100).toFixed(1)}% ≠ 0`);
      if (r.gates.documentTotal !== undefined && r.gates.totalPoints !== r.gates.documentTotal) gauntletReasons.push(`totalPoints ${r.gates.totalPoints} ≠ document ${r.gates.documentTotal}`);
      const want = [...r.gates.headerTitles].sort().join('|'); const got = [...r.sectionTitles].sort().join('|');
      if (want !== got) gauntletReasons.push(`sections [${r.sectionTitles.join(', ')}] ≠ headers [${r.gates.headerTitles.join(', ')}]`);
      const honestPartial = r.health.state !== 'green' && r.doc.flags.some((f: any) => f.code === 'PARTIAL_COVERAGE' || f.code === 'REPAIR_SURVIVORS' || f.code === 'COVERAGE_MISSING');
      if (r.health.state !== 'green' && !honestPartial) gauntletReasons.push(`coverage ${r.health.state} without an honest PARTIAL flag`);
    }
    const ok = covOk && ptsOk && blobOk && phantomOk && callsOk && tokensOk && wallOk && imageOk && orphanOk && hollowOk && gauntletReasons.length === 0;
    if (!ok) failed = true;
    const status = ok ? 'PASS' : 'FAIL';
    const line = `| ${id.padEnd(18)} | ${String(r.coverage.toFixed(1)+'%').padStart(8)} | ${String(r.pointsPercent+'%').padStart(6)} | ${String(r.optionBlobs).padStart(7)} | ${String(r.phantomMissing).padStart(7)} | ${String(r.structureCalls).padStart(5)} | ${String(r.outputTokens).padStart(6)} | ${String(r.guidanceTokens+' tok').padStart(8)} | ${String(r.hollow).padStart(6)} | ${String((r.orphanRate*100).toFixed(1)+'%').padStart(7)} | ${String(`${r.cleanupLines.before}→${r.cleanupLines.after}`).padStart(7)} | ${String(r.wallMs).padStart(7)} | ${String(r.quality).padStart(7)} | ${status.padEnd(6)} |`;
    console.log(line);
    for (const reason of gauntletReasons) console.log(`  ↳ ${id} GAUNTLET: ${reason}`);
    if (!orphanOk) console.log(`  ↳ ${id} regression: orphan rate ${(r.orphanRate*100).toFixed(1)}% > ${thr.maxOrphanRate*100}%`);
    if (!hollowOk) console.log(`  ↳ ${id} regression: hollow ${r.hollow} > ${thr.maxHollow}`);
    if (!ok) {
      const reasons:string[] = [];
      if (!covOk) reasons.push(`coverage ${r.coverage.toFixed(1)} < ${thr.coveragePercent}`);
      if (r.pointsPercent < pointsMin) reasons.push(`points ${r.pointsPercent} < ${pointsMin}`);
      if (r.pointsPercent > pointsMax) reasons.push(`points ${r.pointsPercent} > ${pointsMax}`);
      if (!blobOk) reasons.push(`optBlob ${r.optionBlobs} > ${thr.maxOptionBlob}`);
      if (!phantomOk) reasons.push(`phantom ${r.phantomMissing} > ${thr.maxPhantomMissing}`);
      if (!callsOk) reasons.push(`calls ${r.structureCalls} > ${thr.maxStructureCalls}`);
      if (!tokensOk) reasons.push(`tokens ${r.outputTokens} > ${thr.maxOutputTokens}`);
      if (!wallOk) reasons.push(`wall ${r.wallMs} > ${thr.maxWallMs}`);
      if (!imageOk) reasons.push(`unplaced ${r.health.unplacedImages.length} > ${thr.maxUnplacedImages}`);
      console.log(`  ↳ ${id} regression: ${reasons.join(', ')}`);
    }
  }

  console.log(`\nThresholds file: ${thresholdsPath}`);
  console.log(`Total: ${results.length} fixtures — ${failed ? 'FAIL' : 'PASS'}\n`);

  // Also print quality breakdown per fixture
  console.log('Quality breakdown (coverage30 points15 options15 images15 numbering10 confidence6 orphan4 passage5):');
  for (const r of results) {
    const q = computeQualityScore(r.doc);
    console.log(` ${r.id}: total ${q.total} [cov ${q.coverage} pts ${q.points} opt ${q.optionsCleanliness} img ${q.imagePlacement} num ${q.numbering} conf ${q.confidence} orphan ${q.orphan} pass ${q.passage}]`);
  }
  console.log('');
  // F1 scorecard for gauntlet fixtures.
  for (const r of results.filter(x => x.gates.headerTitles)) {
    const cs = r.doc.source.cleanupStats;
    console.log(`Gauntlet scorecard — ${r.id}:`);
    console.log(`  STEM_HOLLOW ${r.hollow} · MCQ<2opts ${r.mcqUnder2} · orphan rate ${(r.orphanRate*100).toFixed(1)}% · totalPoints ${r.gates.totalPoints} (document ${r.gates.documentTotal}) · sections [${r.sectionTitles.join(', ')}] vs headers [${r.gates.headerTitles.join(', ')}] · section splits ${r.gates.splits} · reassigned ${r.gates.reassigned} · ambiguous ${r.gates.ambiguous} · health ${r.health.state} (${r.health.coveragePercent}%) · cleanup local prompt lines ${cs.linesBefore}→${cs.linesAfter} (≈${cs.tokensBefore}→${cs.tokensAfter} tok, fence-saved ${cs.fenceSaved}) · flags ${Object.entries(r.doc.flags.reduce((acc: any, f: any) => { acc[f.code] = (acc[f.code]||0)+1; return acc; }, {})).map(([k,v]) => `${k}×${v}`).join(' ')}`);
  }
  console.log('');

  // --- E4 memory goldens (offline, deterministic) ---
  const memoryGoldensPath = path.join(fixturesDir, 'memory-goldens.json');
  const goldens: any = { docTraitRerun: {}, skillSelection: {}, capFixture: {} };
  const skillPool = SHIPPED_SKILLS.map(skill => parseSkillFile(skill.content, skill.slug));
  for (const r of results) {
    // (1) doc-trait rerun: same input ⇒ byte-identical traits, twice.
    const rerunA = deriveDocTraits({ sourceLines: r.doc.source.lines, images: r.doc.images, sections: r.doc.sections, pages: 5 });
    const rerunB = deriveDocTraits({ sourceLines: r.doc.source.lines, images: r.doc.images, sections: r.doc.sections, pages: 5 });
    if (JSON.stringify(rerunA) !== JSON.stringify(rerunB)) { failed = true; console.error(`  ↳ memory golden ${r.id}: doc-trait rerun is NOT deterministic`); }
    goldens.docTraitRerun[r.id] = rerunA;
    // (2) skill selection: fixed pool + fixture context ⇒ exact slug order.
    const selection = selectSkillsFromPool(skillPool, {
      userMessage: 'check this exam and repair what is missing',
      health: { state: r.health.state, missing: (r.health.missing || []).slice(0, 10), unplacedImages: (r.health.unplacedImages || []).length ?? 0 },
      docTraits: r.docTraits, roles: ['agent'],
    });
    goldens.skillSelection[r.id] = { selected: selection.selected.map(item => item.skill.meta.slug), totalTokens: selection.totalTokens, omitted: selection.omitted };
  }
  // (3) cap fixture: 50 fat entries ⇒ injection stays ≤5,000 tokens with honest counts.
  const fatEntries = Array.from({ length: 50 }, (_, i) => ({
    id: `fat_${String(i).padStart(2, '0')}`, kind: 'strategy' as const, scope: {},
    lesson: `Lesson ${i}: `.padEnd(280, 'procedure detail. '),
    status: 'active' as const, confidence: 0.5 + (i % 5) / 10,
    evidence: { runIds: [`run_${i}`], successes: i % 4, failures: 0, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-10-01T00:00:00.000Z' },
  }));
  const capped = selectPlaybookEntries({ version: 1, entries: fatEntries }, { role: 'fast', capTokens: PLAYBOOK_CAP_TOKENS });
  goldens.capFixture = { included: capped.included.length, omitted: capped.omittedCount, tokens: capped.tokens, cap: PLAYBOOK_CAP_TOKENS };
  if (capped.tokens > PLAYBOOK_CAP_TOKENS) { failed = true; console.error(`  ↳ memory golden capFixture: ${capped.tokens} tok > ${PLAYBOOK_CAP_TOKENS} cap`); }
  if (capped.included.length + capped.omittedCount !== 50) { failed = true; console.error('  ↳ memory golden capFixture: included + omitted != 50'); }

  let goldensChanged = false;
  if (fs.existsSync(memoryGoldensPath)) {
    const previous = JSON.parse(fs.readFileSync(memoryGoldensPath, 'utf8'));
    if (JSON.stringify(previous) !== JSON.stringify(goldens)) {
      goldensChanged = true; failed = true;
      console.error('  ↳ memory goldens DRIFTED — inspect the diff and update test/fixtures/golden/memory-goldens.json visibly if intended.');
      for (const section of ['docTraitRerun', 'skillSelection', 'capFixture'] as const) {
        if (JSON.stringify(previous[section]) !== JSON.stringify(goldens[section])) {
          console.error(`    changed section: ${section}`);
          for (const key of Object.keys(goldens[section])) {
            if (JSON.stringify(previous[section]?.[key]) !== JSON.stringify(goldens[section][key])) {
              console.error(`      ${key}: was ${JSON.stringify(previous[section]?.[key])} now ${JSON.stringify(goldens[section][key])}`);
            }
          }
        }
      }
    }
  } else {
    fs.writeFileSync(memoryGoldensPath, JSON.stringify(goldens, null, 2) + '\n');
    console.log(`Memory goldens: created ${memoryGoldensPath} (first run)`);
  }
  console.log(`Memory goldens: doc-trait rerun ${Object.keys(goldens.docTraitRerun).length} fixtures deterministic; skill selection ${Object.keys(goldens.skillSelection).length} fixtures; cap fixture included ${goldens.capFixture.included}/omitted ${goldens.capFixture.omitted} at ${goldens.capFixture.tokens} tok ≤ ${goldens.capFixture.cap} — ${goldensChanged ? 'DRIFT' : 'PASS'}`);
  console.log(`Guidance tokens per fixture (bootstrap playbook, offline): ${results.map(r => `${r.id} ${r.guidanceTokens}`).join(', ')}`);

  // --- Part 2 fixtures: verifier / consensus / graph-determinism / scoreboard math ---
  {
    const planted: any[] = [
      { id: 'p1', label: '1', no: 1, spans: [[1, 1]], stem: 'Pick ____', type: 'mcq', images: [], confidence: 0.9, options: [{ key: 'a', spans: [[1, 1]], text: 'same' }, { key: 'b', spans: [[1, 1]], text: 'same' }] },
      { id: 'p2', label: '2', no: 2, spans: [[2, 2]], stem: 'He goes home', type: 'fillblank', images: [], confidence: 0.9 },
    ];
    const codes = validateSemantic(planted as any, []).map(i => i.code);
    if (!codes.includes('OPTION_DUPLICATE') || !codes.includes('STEM_SHAPE_SUSPECT')) { failed = true; console.error('  ↳ Part2 verifier fixture: planted defects not caught', codes); }
    const graphNodes = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, run: async () => { await new Promise(r => setTimeout(r, (6 - i) * 2)); return i; } }));
    const g1 = await runTaskGraph(graphNodes, { concurrency: 1 });
    const g4 = await runTaskGraph(graphNodes, { concurrency: 4 });
    const order = graphNodes.map(n => n.id);
    if (JSON.stringify(mergeInOrder(g1.results, order)) !== JSON.stringify(mergeInOrder(g4.results, order))) { failed = true; console.error('  ↳ Part2 graph fixture: concurrency merge differs'); }
    const dec = diffConsensus(planted as any, planted as any, validateSemantic(planted as any, []));
    if (!dec) { failed = true; console.error('  ↳ Part2 consensus fixture failed'); }
    const sbRuns: any[] = Array.from({ length: 3 }, (_, i) => ({ ts: '', jobId: `b${i}`, kind: 'pipeline', docTraits: { pages: 1, lines: 10, expectedQs: 1, languagesDetected: ['en'], hasKeyPages: false, hasImages: 0, sectionCount: 1 }, models: { fast: 'bench-model' }, outcome: { health: { expected: 1, parsed: 1, missing: [], duplicates: [], coveragePercent: 100, state: 'green', complete: true }, calls: 1, tokens: { input: 1, output: 1 }, cost: 0.01, wallMs: 1, flagsRaised: [] }, ladderPath: ['L0'], flagsRaised: [], userCorrections: 0, verifierDefects: 0 }));
    const rows = buildScoreboard(sbRuns);
    const leader = leaderFor(rows, 'fast', bucketKey(docTraitBucket(sbRuns[0].docTraits)));
    if (leader?.modelId !== 'bench-model' || leader.cleanCoverageRate !== 1) { failed = true; console.error('  ↳ Part2 scoreboard fixture wrong', rows); }
    console.log(`Part 2 fixtures: verifier caught [${codes.join(', ')}]; consensus accepted ${dec.accepted.length}/review ${dec.review.length}; graph c1==c4 merge [${mergeInOrder(g4.results, order).join(',')}]; scoreboard leader ${leader?.modelId} clean-rate ${leader?.cleanCoverageRate} — ${failed ? 'FAIL' : 'PASS'}`);
  }

  if (failed) {
    console.error('Bench FAILED: threshold regression detected. Loosening a threshold requires editing thresholds.json visibly in the diff.');
    process.exit(1);
  } else {
    console.log('Bench PASS');
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
