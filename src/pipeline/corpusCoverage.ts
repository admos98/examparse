/**
 * Godlike Batch 1, Part B4 — corpus diversity coverage (report, don't gate).
 *
 * The coverage table is AUTO-GENERATED from each entry's truth metadata (`family`,
 * `features`, `status`); where metadata is absent it is derived from the truth/source
 * heuristics below. Empty cells are the shopping list for the next real exams to promote.
 */
import type { SourceLine } from '../types';

export const CORPUS_FEATURES = [
  'mcq-heavy',
  'matching',
  'dialogue',
  'writing-topics',
  'scanned-ocr',
  'two-column',
  'separate-key-file',
  'image-heavy',
] as const;
export type CorpusFeature = (typeof CORPUS_FEATURES)[number];

export type CorpusStatus = 'reviewed' | 'unreviewed';

export interface CorpusEntryMeta {
  slug: string;
  status: CorpusStatus;
  family: string;
  features: CorpusFeature[];
  probe?: string;
}

const FEATURE_SET = new Set<string>(CORPUS_FEATURES);

function validFeatures(value: unknown): CorpusFeature[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item)).filter(item => FEATURE_SET.has(item)))] as CorpusFeature[];
}

/** Heuristic feature derivation for entries whose truth carries no explicit `features`. */
export function deriveFeaturesFromCorpusData(params: {
  slug: string;
  truth: any;
  lines?: SourceLine[];
  imageCount?: number;
}): CorpusFeature[] {
  const out = new Set<CorpusFeature>();
  const truth = params.truth || {};
  const types = Object.values(truth.types || {}) as string[];
  if (params.slug.includes('mcq') || (types.length >= 4 && types.filter(type => type === 'mcq' || type === 'truefalse').length / types.length >= 0.6)) out.add('mcq-heavy');
  if (types.includes('matching') || (truth.groups || []).length) out.add('matching');
  if (types.includes('essay') || types.includes('long') || (truth.sectionTitles || []).some((title: string) => /writing/i.test(title))) out.add('writing-topics');
  if (params.slug.includes('scanned') || truth.probe === 'scanned-noise') out.add('scanned-ocr');
  if (params.slug.includes('two-column') || truth.probe === 'two-column') out.add('two-column');
  if (params.slug.includes('keyfile') || params.slug.includes('key-file')) out.add('separate-key-file');
  if (params.slug.includes('image-heavy') || (params.imageCount ?? 0) >= 5) out.add('image-heavy');
  const speakerLines = (params.lines || []).filter(line => /^\s*[AB]\s*:/.test(line.text)).length;
  if (speakerLines >= 4) out.add('dialogue');
  return CORPUS_FEATURES.filter(feature => out.has(feature));
}

export function entryMetaFromTruth(params: {
  slug: string;
  truth: any;
  lines?: SourceLine[];
  imageCount?: number;
}): CorpusEntryMeta {
  const truth = params.truth || {};
  const explicit = validFeatures(truth.features);
  return {
    slug: params.slug,
    status: truth.status === 'reviewed' ? 'reviewed' : 'unreviewed',
    family: typeof truth.family === 'string' && truth.family.trim() ? truth.family.trim() : 'unclassified',
    features: explicit.length ? explicit : deriveFeaturesFromCorpusData(params),
    ...(typeof truth.probe === 'string' ? { probe: truth.probe } : {}),
  };
}

export interface CoverageTable {
  families: string[];
  /** family → feature → covering entry slugs. */
  cells: Map<string, Map<CorpusFeature, string[]>>;
  /** Every family × feature cell with no covering entry. */
  emptyCells: Array<{ family: string; feature: CorpusFeature }>;
  /** Features no entry in the whole corpus covers (the top of the shopping list). */
  uncoveredFeatures: CorpusFeature[];
}

export function buildCoverageTable(entries: CorpusEntryMeta[]): CoverageTable {
  const families = [...new Set(entries.map(entry => entry.family))].sort();
  const cells = new Map<string, Map<CorpusFeature, string[]>>();
  const covered = new Set<CorpusFeature>();
  for (const family of families) cells.set(family, new Map(CORPUS_FEATURES.map(feature => [feature, []])));
  for (const entry of entries) {
    for (const feature of entry.features) {
      cells.get(entry.family)!.get(feature)!.push(entry.slug);
      covered.add(feature);
    }
  }
  const emptyCells: Array<{ family: string; feature: CorpusFeature }> = [];
  for (const family of families) {
    for (const feature of CORPUS_FEATURES) {
      if (!cells.get(family)!.get(feature)!.length) emptyCells.push({ family, feature });
    }
  }
  return {
    families,
    cells,
    emptyCells,
    uncoveredFeatures: CORPUS_FEATURES.filter(feature => !covered.has(feature)),
  };
}

/** Markdown family × features table plus the named empty cells (the shopping list). */
export function coverageMarkdown(entries: CorpusEntryMeta[]): string {
  const table = buildCoverageTable(entries);
  const header = `| family | ${CORPUS_FEATURES.join(' | ')} |`;
  const divider = `|---|${CORPUS_FEATURES.map(() => '---').join('|')}|`;
  const rows = table.families.map(family => {
    const cells = CORPUS_FEATURES.map(feature => {
      const slugs = table.cells.get(family)!.get(feature)!;
      return slugs.length ? slugs.join(', ') : '**EMPTY**';
    });
    return `| ${family} | ${cells.join(' | ')} |`;
  });
  const emptyByFeature = CORPUS_FEATURES.map(feature => {
    const families = table.emptyCells.filter(cell => cell.feature === feature).map(cell => cell.family);
    return `- \`${feature}\`: ${families.length ? `empty for ${families.join(', ')}` : 'covered for every family'}`;
  });
  return [
    header,
    divider,
    ...rows,
    '',
    `Entries: ${entries.length} (${entries.filter(entry => entry.status === 'reviewed').length} reviewed/gating, ${entries.filter(entry => entry.status !== 'reviewed').length} unreviewed/report-only).`,
    '',
    table.uncoveredFeatures.length
      ? `**Uncovered corpus-wide (promote a real exam with these first):** ${table.uncoveredFeatures.map(feature => `\`${feature}\``).join(', ')}.`
      : '**Uncovered corpus-wide:** none — every feature has at least one entry.',
    '',
    '**Empty cells by feature (shopping list):**',
    ...emptyByFeature,
  ].join('\n');
}
