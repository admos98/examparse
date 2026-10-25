/**
 * Godlike Batch 1, Part B — the corpus flywheel.
 *
 * B1: `buildCorpusEntry(doc)` turns any parsed exam into a corpus citizen skeleton
 * (stored source lines, binary-free image manifest, truth prefilled from the doc's final
 * state and marked "unreviewed", provenance notes). The Library action POSTs it to the
 * dev server, which writes `test/fixtures/corpus/<slug>/`.
 * B3: fixes applied to a promoted exam in Step 4 / by the Assistant are recorded into the
 * entry's notes (kind, question, before/after hashes) — recording only; truth changes
 * remain human commits.
 */
import type { ExamDoc, Question } from '../types';
import { getDisplayName } from '../types';
import { getExamHealth } from './quality';
import { CORPUS_FEATURES, type CorpusFeature } from './corpusCoverage';

export function corpusSlugFor(doc: Pick<ExamDoc, 'displayName' | 'fileHash' | 'source' | 'meta'>): string {
  const base = (getDisplayName(doc as ExamDoc) || doc.source?.fileName || 'exam')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'exam';
  const suffix = (doc.fileHash || '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return suffix ? `${base}-${suffix}` : base;
}

/** Feature tags for the coverage table, derived from the parsed doc itself. */
export function deriveDocFeatures(doc: ExamDoc): CorpusFeature[] {
  const found = new Set<CorpusFeature>();
  const leaves = (doc.questions || []).filter(question => !(doc.questions || []).some(item => item.parentId === question.id));
  const mcqLike = leaves.filter(question => question.type === 'mcq' || question.type === 'truefalse').length;
  if (leaves.length >= 5 && mcqLike / leaves.length >= 0.5) found.add('mcq-heavy');
  if (leaves.some(question => question.type === 'matching')) found.add('matching');
  if ((doc.questions || []).some(question => question.receipt?.ruleChain?.includes('dialogue-group'))
    || (doc.source?.lines || []).filter(line => /^\s*[AB]\s*:/.test(line.text)).length >= 4) found.add('dialogue');
  if (leaves.some(question => question.type === 'essay' || question.type === 'long')) found.add('writing-topics');
  if (doc.source?.ocrUsed) found.add('scanned-ocr');
  if ((doc.source?.lines || []).some(line => /column/i.test(line.layoutWarning || ''))) found.add('two-column');
  if ((doc.questions || []).some(question => question.answer?.source === 'keyfile')) found.add('separate-key-file');
  const contentImages = (doc.images || []).filter(image => !image.duplicateOf && image.label?.role !== 'decoration' && image.label?.kind !== 'decoration');
  if (contentImages.length >= 5) found.add('image-heavy');
  return CORPUS_FEATURES.filter(feature => found.has(feature));
}

export interface CorpusEntryBuild {
  slug: string;
  files: {
    'source-lines.json': string;
    'images.json': string;
    'truth.json': string;
    'notes.md': string;
  };
  truth: Record<string, unknown>;
}

/** B1 — corpus entry skeleton for one parsed exam. Pure; no file I/O, no binaries. */
export function buildCorpusEntry(doc: ExamDoc, opts: { slug?: string; now?: Date; family?: string } = {}): CorpusEntryBuild {
  const slug = opts.slug || corpusSlugFor(doc);
  const now = opts.now || new Date();
  const questions = doc.questions || [];
  const expectedNumbers = [...new Set(questions.map(question => question.no))].sort((a, b) => a - b);
  const types: Record<string, Question['type']> = {};
  for (const question of questions) {
    const key = String(question.no);
    if (types[key] === undefined || question.parentId) types[key] = question.type;
  }
  const groups: Array<{ parent: number; children: number[] }> = [];
  for (const question of questions) {
    if (question.parentId) continue;
    const children = questions.filter(item => item.parentId === question.id).map(item => item.no).sort((a, b) => a - b);
    if (children.length) groups.push({ parent: question.no, children });
  }
  const totalPoints = doc.meta?.totalPoints
    ?? questions.reduce((sum, question) => sum + (question.points || 0), 0);
  const truth: Record<string, unknown> = {
    status: 'unreviewed',
    family: opts.family || (doc.meta?.subject ? `${doc.meta.subject}`.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unclassified'),
    features: deriveDocFeatures(doc),
    expectedNumbers,
    types,
    sectionTitles: (doc.sections || []).map(section => section.title || ''),
    totalPoints,
    ...(groups.length ? { groups } : {}),
    spotChecks: [],
  };
  const imagesManifest = (doc.images || []).map(image => ({
    id: image.id,
    page: image.page,
    bbox: image.bbox,
    width: image.width,
    height: image.height,
    ...(image.anchorLine !== undefined ? { anchorLine: image.anchorLine } : {}),
    sha: image.sha,
    mime: image.mime,
    ...(image.label?.caption ? { caption: image.label.caption } : {}),
    ...(image.label?.role ? { role: image.label.role } : {}),
    ...(image.label?.kind ? { kind: image.label.kind } : {}),
  }));
  const models: Record<string, string> = {};
  for (const record of doc.usage || []) if (record.role && record.model) models[record.role] = record.model;
  if (doc.modelInfo) for (const [role, model] of Object.entries(doc.modelInfo)) if (model && !models[role]) models[role] = model;
  let healthLine = 'health unavailable';
  try {
    const health: any = getExamHealth(doc);
    healthLine = `coverage ${health.coveragePercent}% (${health.parsedCount}/${health.expectedCount}), state ${health.state}, complete=${Boolean(health.complete)}${health.missing?.length ? `, missing ${health.missing.join(',')}` : ''}`;
  } catch { /* provenance is best-effort; the entry itself never depends on it */ }
  const notes = [
    `# ${getDisplayName(doc)} (promoted corpus entry \`${slug}\`)`,
    '',
    `- Promoted: ${now.toISOString()} via Library "Promote to corpus" (Godlike Batch 1, B1).`,
    `- Source file: ${doc.source?.fileName || 'unknown'} (exam \`${doc.id}\`, fileHash \`${doc.fileHash}\`).`,
    `- Models used: ${Object.entries(models).map(([role, model]) => `${role}=${model}`).join(', ') || 'none recorded'}.`,
    `- Health at promotion: ${healthLine}.`,
    '- truth.json was PREFILLED from the parsed doc and is "unreviewed": the runner executes',
    '  this entry report-only until a human spot-checks truth (see corpus README) and flips',
    '  "status" to "reviewed".',
    '',
    '## Field fixes (recorded automatically; truth changes are human commits)',
    '',
  ].join('\n');
  return {
    slug,
    truth,
    files: {
      'source-lines.json': JSON.stringify(doc.source?.lines || [], null, 1) + '\n',
      'images.json': JSON.stringify(imagesManifest, null, 1) + '\n',
      'truth.json': JSON.stringify(truth, null, 1) + '\n',
      'notes.md': notes,
    },
  };
}

// ---------------------------------------------------------------------------
// B3 — regression memory: field fixes on promoted exams become corpus citizens
// ---------------------------------------------------------------------------

/** Stable JSON (sorted keys) so before/after hashes survive key-order churn. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** cyrb53 — a tiny sync content hash for fix records (not a security boundary). */
export function hashSync(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function hashQuestion(question: Question | undefined): string {
  return question ? hashSync(stableStringify(question)) : '∅';
}

export interface CorpusFixRecord {
  ts: string;
  kind: string; // 'step4-edit' | 'assistant-fix' | caller-defined
  questionId: string;
  questionNo: number | null;
  change: 'edited' | 'added' | 'removed';
  beforeHash: string;
  afterHash: string;
}

/** Per-question diff between two doc states, as first-class field-failure records. */
export function diffCorpusFixes(before: ExamDoc, after: ExamDoc, kind: string, now: Date = new Date()): CorpusFixRecord[] {
  const beforeById = new Map((before.questions || []).map(question => [question.id, question]));
  const afterById = new Map((after.questions || []).map(question => [question.id, question]));
  const records: CorpusFixRecord[] = [];
  const ts = now.toISOString();
  for (const [id, afterQuestion] of afterById) {
    const beforeQuestion = beforeById.get(id);
    const beforeHash = hashQuestion(beforeQuestion);
    const afterHash = hashQuestion(afterQuestion);
    if (beforeHash === afterHash) continue;
    records.push({
      ts, kind, questionId: id, questionNo: afterQuestion.no ?? beforeQuestion?.no ?? null,
      change: beforeQuestion ? 'edited' : 'added', beforeHash, afterHash,
    });
  }
  for (const [id, beforeQuestion] of beforeById) {
    if (afterById.has(id)) continue;
    records.push({ ts, kind, questionId: id, questionNo: beforeQuestion.no ?? null, change: 'removed', beforeHash: hashQuestion(beforeQuestion), afterHash: '∅' });
  }
  return records.sort((a, b) => (a.questionNo ?? 0) - (b.questionNo ?? 0) || a.questionId.localeCompare(b.questionId));
}

/** Markdown lines appended to the entry's notes.md (server-side write; truth untouched). */
export function formatCorpusFixNotes(records: CorpusFixRecord[]): string {
  return records.map(record =>
    `- ${record.ts} · ${record.kind} · Q${record.questionNo ?? '?'} (\`${record.questionId}\`) ${record.change}: \`${record.beforeHash}\` → \`${record.afterHash}\``,
  ).join('\n');
}

/**
 * Browser fire-and-forget recorder: when `after` is a promoted exam, diff and append the
 * field fixes to its corpus entry's notes. Never blocks or fails a save; never edits truth.
 */
export async function maybeRecordCorpusFixes(before: ExamDoc | null | undefined, after: ExamDoc, kind: string): Promise<CorpusFixRecord[]> {
  try {
    const slug = after.corpus?.slug;
    if (!slug || !before || before.id !== after.id) return [];
    const records = diffCorpusFixes(before, after, kind);
    if (!records.length) return [];
    await fetch(`/api/corpus/${encodeURIComponent(slug)}/fixes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    }).catch(() => undefined);
    return records;
  } catch {
    return [];
  }
}
