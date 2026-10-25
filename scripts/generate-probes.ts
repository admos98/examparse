#!/usr/bin/env tsx
/**
 * Godlike Batch 1, Part D1 — generate the two synthetic-but-realistic format probes from the
 * acceptance entry. Deterministic (fixed seeds in src/pipeline/corpusProbes.ts): re-running
 * rewrites byte-identical fixtures. Truth is copied UNCHANGED (only status/probe metadata is
 * added) and both entries stay "unreviewed" (report-only) until a human reviews them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { columnShuffleLines, injectOcrNoise, rewrapFurniture, REFURNISH_STYLE, OCR_NOISE_RATE, PROBE_SEED } from '../src/pipeline/corpusProbes';
import type { SourceLine } from '../src/types';

const CORPUS_DIR = path.join(process.cwd(), 'test/fixtures/corpus');
const ACCEPTANCE = 'english-final-13991009pq89w65173';

const acceptanceDir = path.join(CORPUS_DIR, ACCEPTANCE);
const lines = JSON.parse(fs.readFileSync(path.join(acceptanceDir, 'source-lines.json'), 'utf8')) as SourceLine[];
const truth = JSON.parse(fs.readFileSync(path.join(acceptanceDir, 'truth.json'), 'utf8'));

function writeProbe(slug: string, probe: string, probeLines: SourceLine[], extraFeatures: string[], how: string): void {
  const dir = path.join(CORPUS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'source-lines.json'), JSON.stringify(probeLines, null, 1) + '\n');
  const probeTruth = {
    ...truth,
    status: 'unreviewed',
    probe,
    family: truth.family || 'iranian-national-final-en',
    features: [...new Set([...(truth.features || ['matching', 'writing-topics', 'image-heavy']), ...extraFeatures])],
  };
  fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(probeTruth, null, 1) + '\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), [
    `# Format probe: ${probe} (generated, report-only)`,
    '',
    `Generated from \`${ACCEPTANCE}\` by \`scripts/generate-probes.ts\` (Godlike Batch 1, D1).`,
    how,
    'Truth is copied unchanged from the acceptance entry; status stays "unreviewed" so the',
    'runner executes this probe report-only and prints its score honestly. Deterministic:',
    `re-running the generator (seed ${PROBE_SEED}) reproduces these files byte-for-byte.`,
    '',
  ].join('\n'));
  console.log(`wrote ${slug} (${probeLines.length} lines)`);
}

writeProbe(
  'probe-two-column',
  'two-column',
  columnShuffleLines(lines),
  ['two-column'],
  'Method: per page, the run sequence is split into left/right column halves and interleaved\nrun-by-run (L1, R1, L2, R2, …) — the order a column-unaware extractor emits on a\ntwo-column page. Line texts and pages are untouched; ids are re-sequenced.',
);

// #38 Part E2 — held-out furniture probe: an existing reviewed entry (english-mcq) re-wrapped
// in page furniture the pipeline has never seen. Truth (numbers, total) copied unchanged.
{
  const base = 'english-mcq';
  const baseDir = path.join(CORPUS_DIR, base);
  const baseLines = JSON.parse(fs.readFileSync(path.join(baseDir, 'source-lines.json'), 'utf8')) as SourceLine[];
  const baseTruth = JSON.parse(fs.readFileSync(path.join(baseDir, 'truth.json'), 'utf8'));
  const wrapped = rewrapFurniture(baseLines);
  const dir = path.join(CORPUS_DIR, 'probe-refurnished');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'source-lines.json'), JSON.stringify(wrapped, null, 1) + '\n');
  fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify({
    ...baseTruth,
    status: 'unreviewed',
    probe: 'refurnished',
    family: baseTruth.family || 'unknown',
    features: [...new Set([...(baseTruth.features || []), 'mcq-heavy'])],
  }, null, 1) + '\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), [
    '# Held-out furniture probe: refurnished (generated, report-only)',
    '',
    `Generated from \`${base}\` by \`scripts/generate-probes.ts\` (#38 Part E2).`,
    `Every page was re-wrapped in NEW furniture never present in development: header "${REFURNISH_STYLE.header}",`,
    'a per-page footer ("sheet N of M"), and a differently-phrased continued line between pages.',
    'Original furniture flags were stripped; question/section text is byte-identical to the base entry.',
    'Pass condition (see test/ai-first-spine.test.ts): line classification still identifies the same',
    'questions and sections, and the new furniture stays furniture.',
    '',
  ].join('\n'));
  console.log(`wrote probe-refurnished (${wrapped.length} lines)`);
}

writeProbe(
  'probe-scanned-noise',
  'scanned-noise',
  injectOcrNoise(lines),
  ['scanned-ocr'],
  `Method: OCR-typical single-character substitutions from a fixed confusion table\n(O↔0, l↔1, S↔5, e↔c, a↔o, …) at rate ${OCR_NOISE_RATE} over confusable characters,\nseeded PRNG. Non-confusable characters (incl. Persian script) pass through unchanged.`,
);
