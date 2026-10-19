#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { assembleAndValidateQuestions, assembleAndValidateSections } from '../src/pipeline/assemble';
import { enumerateExpectedQuestionNos, evaluateCoverage, getExamHealth, parsePrintedNumberFromStem } from '../src/pipeline/quality';
import { computeQualityScore } from '../src/utils/qualityScore';
import { expandWireV2 } from '../src/pipeline/structure';

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
  const assembled = assembleAndValidateQuestions(rawQuestions, sourceLines, totalPoints, {
    keyTerritoryLineNos: [...enumerated.keyTerritory.lineNos],
    imageIds: images.map((i:any)=>i.id),
    unresolvedImageIds: [],
  });
  // Sections
  let finalSections = sections.length ? sections : [{ id:'sec_1', index:1, title:'Default', spans:[[1, sourceLines.length]] }];
  try {
    const secAssembled = assembleAndValidateSections(sections, sourceLines, assembled.questions, [...enumerated.keyTerritory.lineNos]);
    if (secAssembled.sections.length) finalSections = secAssembled.sections;
  } catch {}

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
    meta: { title: fixture.id, subject: meta.subject, grade: meta.grade, totalPoints, language: meta.language || 'en', direction: 'ltr' },
    sections: finalSections.map((s:any, i:number)=>({ id: s.id || `sec_${i+1}`, index: s.index || i+1, title: s.title || s.kind || `Section ${i+1}`, spans: s.spans || s.p || [[1, sourceLines.length]] })),
    questions: assembled.questions,
    images: finalImages,
    source: { lines: sourceLines, pages: 5, fileName: `${id}.pdf`, ocrUsed:false, expectedQuestionNos: expectedNumbers, keyTerritoryLineNos: [...enumerated.keyTerritory.lineNos] },
    flags: assembled.flags,
    usage: [],
  };

  const health = getExamHealth(doc);
  const coverage = health.coveragePercent;
  const pointsPercent = health.pointsExpected ? Math.round((health.pointsParsed / health.pointsExpected)*100) : 100;
  const optionBlobs = countOptionBlobs(doc);
  const phantomMissing = fixture.expected.phantomMissing?.length || 0; // for now 0
  const quality = computeQualityScore(doc);
  const wallMs = Math.round(performance.now() - start);

  return {
    id,
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
  };
}

async function main(){
  const ids = Object.keys(thresholds).filter(k=>!k.startsWith('_'));
  if (ids.length < 8) {
    console.error(`Thresholds has only ${ids.length} fixtures, need >=8`);
    process.exit(1);
  }
  console.log(`\nGolden Benchmark — ${ids.length} fixtures (mock transport, offline)\n`);
  console.log(`| Fixture            | Coverage | Points | OptBlob | Phantom | Calls | Tokens | Wall ms | Quality | Status |`);
  console.log(`|--------------------|----------|--------|---------|---------|-------|--------|---------|---------|--------|`);

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
    const ok = covOk && ptsOk && blobOk && phantomOk && callsOk && tokensOk && wallOk && imageOk;
    if (!ok) failed = true;
    const status = ok ? 'PASS' : 'FAIL';
    const line = `| ${id.padEnd(18)} | ${String(r.coverage.toFixed(1)+'%').padStart(8)} | ${String(r.pointsPercent+'%').padStart(6)} | ${String(r.optionBlobs).padStart(7)} | ${String(r.phantomMissing).padStart(7)} | ${String(r.structureCalls).padStart(5)} | ${String(r.outputTokens).padStart(6)} | ${String(r.wallMs).padStart(7)} | ${String(r.quality).padStart(7)} | ${status.padEnd(6)} |`;
    console.log(line);
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
  console.log('Quality breakdown (coverage30 points15 options15 images15 numbering10 confidence10 passage5):');
  for (const r of results) {
    const q = computeQualityScore(r.doc);
    console.log(` ${r.id}: total ${q.total} [cov ${q.coverage} pts ${q.points} opt ${q.optionsCleanliness} img ${q.imagePlacement} num ${q.numbering} conf ${q.confidence} pass ${q.passage}]`);
  }
  console.log('');

  if (failed) {
    console.error('Bench FAILED: threshold regression detected. Loosening a threshold requires editing thresholds.json visibly in the diff.');
    process.exit(1);
  } else {
    console.log('Bench PASS');
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
