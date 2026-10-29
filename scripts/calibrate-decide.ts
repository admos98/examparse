/** Report-only local referee calibration. Scripted mode proves routing, NOT model reliability.
 * Usage: npm run calibrate:decide
 *        DECIDE_URL=http://127.0.0.1:8080/v1/systemone DECIDE_MODEL=lightning npm run calibrate:decide -- --live
 *        [--out data/decide-calibration.json] [--capture-score test/fixtures/systemone-real-model-score-response.json]
 * No server is started, no cloud fallback, no threshold/promotion change, no document patches. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '../src/store';
import { LLMAdapter } from '../src/providers/adapter';
import type { AppSettings } from '../src/types';
import { runLoopDecisionAudit } from '../src/pipeline/loopAudit';
import { checkAuthoredDocument, fixRouting, batchVerdictsBySection } from '../src/pipeline/localLoop';
import type { AuthoredDocument } from '../src/pipeline/localLoop';
import type { LoopDecisionCaller } from '../src/pipeline/loopAudit';
import type { CalibrationCounts, DecisionCalibrationReport } from '../src/pipeline/decisionCalibration';
import { CALIBRATION_FIXTURE, CALIBRATION_CORRUPTIONS, calibrationExam, calibrationPixels, plantCorruption, type CalibrationCorruption } from '../test/fixtures/calibration-exam';

export const calibrationSettings = (endpoint = 'http://localhost:8080/v1/systemone', model = 'scripted'): AppSettings => ({ ...DEFAULT_SETTINGS,
  decideMode: 'active', decideMultimodal: true, thrift: { ...DEFAULT_SETTINGS.thrift, cacheEnabled: false },
  providers: [{ id: 'calibration', name: 'Local calibration referee', kind: 'openai-compatible', baseURL: new URL(endpoint).origin, apiKey: '', decisionsPath: new URL(endpoint).pathname, decideDialect: 'thx' }],
  roleMapping: { ...DEFAULT_SETTINGS.roleMapping, decide: { providerId: 'calibration', model } } });

/** Oracle sees the blind record only; corruptions aren't communicated to it. */
export const scriptedCalibrationJudge: LoopDecisionCaller = async body => {
  const good = calibrationExam().document;
  const [name, item] = Object.entries(body.questions)[0] as [string, any];
  const criteria = Object.keys(item.criteria || {});
  if (item.type === 'score') return { results: [{ name, probability: .95, choice: '2' }] };
  if (name.startsWith('Image ')) {
    if (name.endsWith('sentences')) return { results: [{ name, probability: .99, choice: criteria.find(k => item.criteria[k] === 'A red circle.') || 'none' }] };
    return { results: [{ name, probability: .99, choice: body.state.includes('"currentQuestionNumber":20') ? 'this question' : 'another question on the page' }] };
  }
  if (item.type === 'choice' && !name.startsWith('Q')) return { results: [{ name, probability: .99, choice: criteria[0] }] };
  const n = Number(/^Q(\d+)/.exec(name)?.[1]);
  const expected = good.questions.find(q => q.number === n);
  if (item.type === 'choice') return { results: [{ name, probability: .99, choice: expected?.answer || criteria[0] }] };
  let probability = .99;
  if (expected && /uncontaminated|stem-faithful/.test(name)) {
    const record = JSON.parse(body.state.slice('Question: '.length).split('\nSource: ')[0]);
    if (name.endsWith('uncontaminated') && JSON.stringify(record.question.options) !== JSON.stringify(expected.options)) probability = .01;
    if (name.endsWith('stem-faithful') && record.question.stem !== expected.stem) probability = .01;
  }
  return { results: [{ name, probability }] };
};

/** Optional independently verified field package, supplied externally rather than invented here. */
export type CalibrationFixture = ReturnType<typeof calibrationExam> & { name?: string; imagePayloads?: Record<string, { id: string; mime: string; data: string }> };
export async function calibrationRun(kind: CalibrationCorruption | 'control', caller = scriptedCalibrationJudge, settings = calibrationSettings(), fixture: CalibrationFixture = calibrationExam()) {
  const document = kind === 'control' ? fixture.document : plantCorruption(fixture.document, kind);
  // Plant at the Check boundary, not in a Parse response: #50 compile intentionally drops
  // exact duplicate model emissions before Check. Here we test an actually corrupted document.
  const codeVerdicts = checkAuthoredDocument(document, fixture.images, [], fixture.lines);
  const audit = await runLoopDecisionAudit({ document, lines: fixture.lines, images: fixture.images, settings,
    fileHash: `calibration-${kind}`, imagePayload: async image => fixture.imagePayloads ? fixture.imagePayloads[image.id] : image.id === calibrationPixels.id ? calibrationPixels : undefined, decisionCaller: caller });
  const route = fixRouting(codeVerdicts, audit.verdicts, audit.mode === 'active');
  const batches = batchVerdictsBySection(document, route.scope, route.hints, () => 'Calibration');
  const fixVerdicts = batches.flatMap(batch => batch.verdicts);
  return { receipt: { codeVerdicts, auditVerdicts: audit.verdicts, skippedNoEvidence: audit.skippedNoEvidence,
    endpointErrors: audit.endpointErrors }, fixVerdicts, catalogueVotes: audit.votes, document };
}

const counts = (): CalibrationCounts => ({ catches: 0, planted: 0, falseAlarms: 0, clean: 0 });
export async function calibrationReport(caller = scriptedCalibrationJudge, settings = calibrationSettings(), mode: 'scripted' | 'live' = 'scripted', fixture: CalibrationFixture = calibrationExam()): Promise<DecisionCalibrationReport> {
  const provider = settings.providers[0];
  const report: DecisionCalibrationReport = { version: 'decide-calibration-v1', mode, fixture: fixture.name || CALIBRATION_FIXTURE, measuredAt: new Date().toISOString(),
    endpointHost: new URL(provider.baseURL).host, model: settings.roleMapping.decide!.model, dialect: 'thx', counts: counts(), perKind: {}, endpointErrors: 0, skippedNoEvidence: 0 };
  const { expectedKind } = await import('../test/fixtures/calibration-exam');
  for (const kind of ['control', ...CALIBRATION_CORRUPTIONS] as const) {
    const run = await calibrationRun(kind, caller, settings, fixture);
    report.endpointErrors += run.receipt.endpointErrors;
    report.skippedNoEvidence += run.receipt.skippedNoEvidence || 0;
    if (kind === 'control') {
      // Overall denominator counts unique audit units, not repeated verdicts or repeated runs.
      report.counts.clean = fixture.document.questions.length + fixture.images.length + 1; // unique questions + images + document-wide checks
      report.counts.falseAlarms = new Set(run.fixVerdicts.flatMap(v => v.imageId ? [`image:${v.imageId}`] : v.questionNumbers.length ? v.questionNumbers.map(n => `Q${n}`) : ['exam'])).size;
      for (const [kind, clean] of [['empty-stem', fixture.document.questions.length], ['missing-number', fixture.document.questions.length], ['duplicate-number', fixture.document.questions.length], ['points-sum-mismatch', 1]] as const) report.perKind[kind] = { ...counts(), clean };
      for (const verdict of run.receipt.codeVerdicts) { const c = report.perKind[verdict.kind] ||= { ...counts(), clean: 1 }; c.falseAlarms++; }
      for (const verdict of run.receipt.auditVerdicts) {
        const c = report.perKind[verdict.kind] ||= counts(); c.clean++;
        if ((verdict.probability ?? 1) <= .2) c.falseAlarms++;
      }
    } else {
      report.counts.planted++;
      const target = expectedKind[kind], caught = run.fixVerdicts.some(v => v.kind === target || v.merged?.some(m => m.kind === target));
      if (caught) report.counts.catches++;
      const c = report.perKind[target] ||= counts(); c.planted++; if (caught) c.catches++;
    }
  }
  return report;
}

async function main() {
  const live = process.argv.includes('--live');
  const endpoint = process.env.DECIDE_URL || 'http://127.0.0.1:8080/v1/systemone';
  const model = process.env.DECIDE_MODEL || 'local';
  const captureArg = process.argv.indexOf('--capture-score');
  const fixtureArg = process.argv.indexOf('--fixture');
  let fixture: CalibrationFixture = calibrationExam();
  if (fixtureArg >= 0) {
    if (!live) throw new Error('External field fixtures are live-only; the scripted oracle is specific to synthetic-65-v1.');
    const file = process.argv[fixtureArg + 1]; if (!file) throw new Error('--fixture requires a path');
    fixture = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!fixture.name || !fixture.document?.questions || fixture.document.questions.length < 65 || !Array.isArray(fixture.lines) || !Array.isArray(fixture.images)) throw new Error('Expected a named calibration package with document (65+ questions), lines, images and imagePayloads.');
  }
  let captured = false;
  if (live && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) throw new Error('Calibration is local-only; tunnel Lightning locally and set DECIDE_URL to that tunnel.');
  const settings = calibrationSettings(endpoint, live ? model : 'scripted');
  const caller: LoopDecisionCaller = live ? async body => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Decisions endpoint HTTP ${response.status}`);
    const data = await response.json();
    const decoded = LLMAdapter.parseDecisionResponse(settings.providers[0], body, data);
    if (!captured && captureArg >= 0 && Object.values(body.questions).some((q: any) => q.type === 'score')) {
      const file = process.argv[captureArg + 1]; if (!file) throw new Error('--capture-score requires a path');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ _provenance: { model, endpointHost: new URL(endpoint).host, captured: new Date().toISOString(), note: 'Live trained model; shape-only fixture, do not assert values.' }, request: body, response: data }, null, 2) + '\n'); captured = true;
    }
    return decoded;
  } : scriptedCalibrationJudge;
  console.log(`${live ? 'LIVE — report only, not a CI gate' : 'SCRIPTED — routing proof only, NOT measured model reliability'} · ${fixture.name || CALIBRATION_FIXTURE}`);
  const report = await calibrationReport(caller, settings, live ? 'live' : 'scripted', fixture);
  for (const [kind, c] of Object.entries(report.perKind)) console.log(`${kind}: catches ${c.catches}/${c.planted}; false indictments ${c.falseAlarms}/${c.clean}`);
  console.log(`Overall: catches ${report.counts.catches}/${report.counts.planted} planted errors; false indictments ${report.counts.falseAlarms}/${report.counts.clean} clean audit units; endpoint errors ${report.endpointErrors}; skipped-no-evidence ${report.skippedNoEvidence}`);
  const outArg = process.argv.indexOf('--out'), out = outArg >= 0 ? process.argv[outArg + 1] : 'data/decide-calibration.json';
  if (!out) throw new Error('--out requires a path');
  await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n'); console.log(`Settings report: ${out}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
