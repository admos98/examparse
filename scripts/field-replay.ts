#!/usr/bin/env tsx
/**
 * Part F2 — Local Field Replay CLI
 *
 * Replays the `source.lines` of a saved/exported structured exam JSON (default:
 * `test/fixtures/field-exports/English — 11_structured (2).json`, or a path passed
 * as `argv[2]`) through the deterministic local pipeline (scripted anchor model,
 * 0 provider calls) and prints per-class diff summary counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { replayFieldExport, type FieldReplayReport } from '../src/pipeline/fieldReplay';

const DEFAULT_FIXTURE = path.join(
  process.cwd(),
  'test/fixtures/field-exports/English — 11_structured (2).json',
);

export function runFieldReplayCli(targetPath = DEFAULT_FIXTURE, print = true): FieldReplayReport {
  const raw = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  const report = replayFieldExport(raw, path.basename(targetPath));

  if (print) {
    const d = report.perClassDiffs;
    console.log(`=== Field Replay: ${report.fileName} ===`);
    console.log(`Source lines: ${report.sourceLineCount} (0 provider calls; scripted local anchor model)`);
    console.log(
      `Sections: ${report.sections.exported} -> ${report.sections.replayed} ` +
      `(bogus sub-header sections removed: ${d.bogusSubheaderSectionsRemoved}, order/slot diffs: ${d.sectionHeadersCorrected})`,
    );
    console.log(
      `Questions: ${report.questions.exportedCount} -> ${report.questions.replayedCount} ` +
      `(unique printed numbers: ${report.questions.exportedUniqueNos} -> ${report.questions.replayedUniqueNos}, ` +
      `phantom self-children removed: ${d.phantomSelfChildrenRemoved})`,
    );
    console.log(
      `Total points: ${report.totalPoints.exported ?? '—'} -> ${report.totalPoints.replayed ?? '—'}`,
    );
    console.log(
      `Shape audit (optionIncludesStem / duplicateSiblingStems / overlongStems): ` +
      `${report.shapeBefore.optionIncludesStem}/${report.shapeBefore.duplicateSiblingStems}/${report.shapeBefore.overlongStems} -> ` +
      `${report.shapeAfter.optionIncludesStem}/${report.shapeAfter.duplicateSiblingStems}/${report.shapeAfter.overlongStems}`,
    );
    console.log('Per-class diff counts:');
    console.log(`  - bogusSubheaderSectionsRemoved : ${d.bogusSubheaderSectionsRemoved}`);
    console.log(`  - inlineOptionsCarved           : ${d.inlineOptionsCarved}`);
    console.log(`  - stemsDecontaminated           : ${d.stemsDecontaminated}`);
    console.log(`  - overlongPassageStemsFixed     : ${d.overlongPassageStemsFixed}`);
    console.log(`  - siblingDuplicateStemsFixed    : ${d.siblingDuplicateStemsFixed}`);
    console.log(`  - phantomSelfChildrenRemoved    : ${d.phantomSelfChildrenRemoved}`);
    console.log(`  - typesCanonicalized            : ${d.typesCanonicalized}`);
    console.log(
      `  - formsApplied                  : ` +
      Object.entries(d.formsApplied).map(([k, v]) => `${k}=${v}`).join(', '),
    );
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const argPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FIXTURE;
  const report = runFieldReplayCli(argPath, true);
  if (
    report.shapeAfter.optionIncludesStem !== 0 ||
    report.shapeAfter.duplicateSiblingStems !== 0 ||
    report.shapeAfter.overlongStems !== 0
  ) {
    process.exitCode = 1;
  }
}
