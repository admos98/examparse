/**
 * Shared ExamDoc export / duplicate helpers.
 * Used by Step5Exam and the Exam Library so both share identical semantics.
 */
import { ExamDoc, getDisplayName, sanitizeFileName } from '../types';
import { getExamHealth, invariantViolationQuestionNos, validateExamInvariants } from '../pipeline/quality';
import { stripCredentialFields } from './validation';
import { buildParseReport, type ParseReport } from '../pipeline/provenance';

/** 2F exam-level Parse report — shared by Step 5 and the JSON export receipt (no secrets). */
export function parseReportForDoc(doc: ExamDoc): ParseReport {
  const health = getExamHealth(doc);
  const models: Record<string, string> = {};
  for (const u of doc.usage || []) if (u.role && u.model) models[u.role] = u.model;
  const verdicts = Object.values((doc as any).verdicts || {}).flat() as any[];
  const rawClassify = doc.spine?.classify;
  const cleanClassify = rawClassify
    ? (() => {
        const { pageProposals: _omit, ...rest } = rawClassify;
        return rest;
      })()
    : undefined;
  return buildParseReport(doc as any, {
    models,
    calls: (doc.usage || []).filter(u => !(u as any).isCachedHit).length,
    tokens: { input: (doc.usage || []).reduce((a, u) => a + (u.inputTokens || 0), 0), output: (doc.usage || []).reduce((a, u) => a + (u.outputTokens || 0), 0) },
    cost: Number((doc.usage || []).reduce((a, u) => a + ((u as any).costUsd || 0), 0).toFixed(4)),
    coverageAfter: health.coveragePercent,
    consensusSections: [...new Set((doc.flags || []).filter(f => f.code.startsWith('CONSENSUS')).map(f => f.questionId || 'section'))],
    critic: { calls: (doc.usage || []).filter(u => (u as any).role === 'critic').length, defects: verdicts.filter(v => v.verdict === 'defect').length, ok: verdicts.filter(v => v.verdict === 'ok').length },
    memory: { playbookIds: [...new Set<string>(((doc as any).traces || []).flatMap((t: any) => t.guidance?.playbookIds || []))], skillIds: [...new Set<string>(((doc as any).traces || []).flatMap((t: any) => t.guidance?.skillIds || []))], guidanceTokens: Number((doc as any).guidanceTokens) || 0 },
    classify: cleanClassify,
    ...(cleanClassify?.pages ? {
      pages: cleanClassify.pages,
      readOutputTokensByFormat: cleanClassify.pages.reduce((totals: Record<string, number>, page: any) => {
        if (page.format) totals[page.format] = (totals[page.format] || 0) + (Number(page.outputTokens) || 0);
        return totals;
      }, {}),
    } : {}),
    repairLoop: doc.spine?.repairLoop,
    ...(doc.spine?.compile ? { reconcile: { total: doc.spine.compile.reconciliations, byKind: doc.spine.compile.byKind } } : {}),
    audit: doc.spine?.audit,
    config: { models },
  });
}

/** Build the clean export payload: strips heavy inline binary dataUrls while keeping resolvable image references and explicit export metadata. */
export function buildExportDoc(doc: ExamDoc): any {
  const cleanImages = (doc.images || []).map(img => {
    const { dataUrl, _blob, ...rest } = img as any;
    const ext = ((img.mime || 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const key = img.blobKey || img.sha || '';
    return {
      ...rest,
      exportPath: `images/${img.id}.${ext}`,
      ...(key ? { localUrl: `/api/images/${encodeURIComponent(key)}` } : {}),
    };
  });

  const { pageImages, ...sourceWithoutPageImages } = (doc.source || {}) as any;
  return stripCredentialFields({
    ...doc,
    exportMeta: {
      binariesStripped: true,
      imageMode: 'folder-blob-reference',
      imageCount: cleanImages.length,
      note: 'Binary image dataUrls and pageImages are intentionally stripped from JSON exports; each entry in images[] retains its resolvable blobKey, localUrl (/api/images/{blobKey}), and exportPath.',
    },
    parseReport: parseReportForDoc(doc),
    displayName: getDisplayName(doc),
    images: cleanImages,
    source: sourceWithoutPageImages,
  });
}

/** Return factual completeness findings so the calling view can use ConfirmCard instead of a native dialog. */
export function partialExportIssues(doc: ExamDoc): string[] {
  // Export keeps the teeth the save boundary gave up: a demoted PARTIAL doc — or any doc
  // whose residual error violations were never confirmed — always routes through the
  // in-product partial-export confirmation. This reads invariants live, so it also catches
  // docs saved before the marker existed.
  const errorViolations = validateExamInvariants(doc).violations.filter(violation => violation.severity === 'error');
  const violationNos = invariantViolationQuestionNos(doc, errorViolations);
  const invariantIssues = errorViolations.length
    ? [`invariant violations: ${[...new Set(errorViolations.map(violation => violation.code))].join(', ')}${violationNos.length ? ` (questions ${violationNos.join(', ')})` : ''}`]
    : [];
  const health = getExamHealth(doc);
  if (health.complete && invariantIssues.length === 0) return [];
  const failedPages = (doc.spine?.classify?.pages || []).filter(p => p.status === 'failed').map(p => p.page);
  return [
    ...invariantIssues,
    ...(health.complete ? [] : [
      failedPages.length ? `unread pages: ${failedPages.join(', ')}` : '',
      health.missing.length ? `missing questions: ${health.missing.join(', ')}` : '',
      health.duplicates.length ? `duplicate question numbers: ${health.duplicates.join(', ')}` : '',
      health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.51 ? `points deficit: ${health.pointDeficit}` : '',
      health.unplacedImages.length ? `${health.unplacedImages.length} unplaced image(s)` : '',
      health.unresolvedImageRefs.length ? `${health.unresolvedImageRefs.length} unresolved image reference(s)` : '',
      (health.parentLinkIssueCount || 0) ? `${health.parentLinkIssueCount} invalid nested-question link(s)` : '',
    ]),
  ].filter(Boolean);
}

/** Backwards-compatible pure predicate; it never opens a browser dialog. */
export function confirmPartialExport(doc: ExamDoc, _action = 'export'): boolean {
  return partialExportIssues(doc).length === 0;
}

/** Canonical source key grouping re-parses of the same exam file (by fileHash first, else stripped base fileName). */
export function canonicalSourceKey(entry: { fileHash?: string; fileName?: string; displayName?: string; id?: string }): string {
  if (entry.fileHash && entry.fileHash.trim()) return `hash:${entry.fileHash.trim()}`;
  const rawName = (entry.fileName || entry.displayName || '').trim();
  if (rawName) {
    const normalized = rawName
      .replace(/\.[^./\\]+$/, '')
      .replace(/\s*\(\d+\)\s*$/, '')
      .trim()
      .toLowerCase();
    if (normalized) return `name:${normalized}`;
  }
  return `id:${entry.id || ''}`;
}

export type LibrarySortMode = 'newest' | 'oldest' | 'name' | 'quality-desc' | 'quality-asc';

export interface AnnotatedLibrarySummary<T> {
  item: T;
  isLatest: boolean;
  reparseIndex: number;
}

/**
 * Sort library entries (default: newest-first) and mark the newest parse of each source with `isLatest = true`
 * while computing deterministic `reparseIndex` (`0` = initial parse, `1` = `(1)`, `2` = `(2)`, ...).
 */
export function annotateLibrarySummaries<
  T extends {
    id: string;
    displayName: string;
    createdAt: string;
    fileHash?: string;
    fileName?: string;
    qualityScore?: number;
  },
>(summaries: T[], sort: LibrarySortMode = 'newest'): Array<T & { isLatest: boolean; reparseIndex: number }> {
  const bySource = new Map<string, T[]>();
  for (const s of summaries) {
    const key = canonicalSourceKey(s);
    const arr = bySource.get(key) || [];
    arr.push(s);
    bySource.set(key, arr);
  }
  const latestIds = new Set<string>();
  const reparseById = new Map<string, number>();
  for (const group of bySource.values()) {
    const chronological = [...group].sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0;
      const tb = Date.parse(b.createdAt) || 0;
      return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
    });
    chronological.forEach((entry, idx) => reparseById.set(entry.id, idx));
    if (chronological.length) latestIds.add(chronological[chronological.length - 1].id);
  }

  const out = summaries.map(s => ({
    ...s,
    isLatest: latestIds.has(s.id),
    reparseIndex: reparseById.get(s.id) ?? 0,
  }));

  switch (sort) {
    case 'oldest':
      out.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
      break;
    case 'name':
      out.sort((a, b) => a.displayName.localeCompare(b.displayName));
      break;
    case 'quality-desc':
      out.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
      break;
    case 'quality-asc':
      out.sort((a, b) => (a.qualityScore ?? 0) - (b.qualityScore ?? 0));
      break;
    case 'newest':
    default:
      out.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      break;
  }
  return out;
}

/** Build lightweight library summary directly from an ExamDoc (mirrors server summarizeStoredExam). */
export function summarizeExamForLibrary(doc: ExamDoc) {
  const health = getExamHealth(doc);
  const usage = doc.usage || [];
  const isPartialDoc = Boolean((doc as any).partial === true || (doc.flags || []).some(f => f.code === 'PARTIAL_EXAM'));
  const healthState: 'green' | 'amber' | 'red' | 'PARTIAL' = isPartialDoc
    ? 'PARTIAL'
    : (health.state || (health.complete ? 'green' : 'amber'));
  const modelUsed =
    doc.modelInfo?.fast ||
    usage.find(u => (u.role as string) === 'standard' || (u.role as string) === 'fast')?.model ||
    usage.find(u => u.role === 'escalation')?.model ||
    usage.find(u => Boolean(u.model))?.model ||
    doc.modelInfo?.escalation ||
    undefined;
  return {
    id: doc.id,
    fileHash: doc.fileHash || undefined,
    displayName: getDisplayName(doc),
    subject: doc.meta?.subject,
    grade: doc.meta?.grade,
    term: doc.meta?.term,
    year: doc.meta?.year,
    createdAt: doc.createdAt,
    fileName: doc.source?.fileName || '',
    pages: doc.source?.pages || 0,
    questionCount: (doc.questions || []).length,
    expectedQuestionCount: health.expectedCount,
    parsedQuestionCount: health.parsedCount,
    pointsParsed: health.pointsParsed,
    pointsExpected: health.pointsExpected ?? doc.meta?.totalPoints,
    healthState,
    attentionCount: health.attentionCount ?? 0,
    modelUsed,
    coveragePercent: health.coveragePercent,
    missingQuestionNos: health.missing,
    duplicateQuestionNos: health.duplicates,
    complete: health.complete,
    sectionCount: (doc.sections || []).length,
    imageCount: (doc.images || []).length,
    ocrUsed: Boolean(doc.source?.ocrUsed),
    qualityScore: 0,
    totalCostUsd: usage.reduce((a, u) => a + (u.costUsd || 0), 0),
    totalTokens: usage.reduce((a, u) => a + (u.inputTokens || 0) + (u.outputTokens || 0), 0),
  };
}

/** Compute filesystem-safe export JSON filename, preserving `(1), (2), ...` suffix on re-parses. */
export function exportExamFileName(
  doc: ExamDoc,
  options?: {
    reparseIndex?: number;
    siblingSummaries?: Array<{ id: string; fileHash?: string; fileName?: string; displayName?: string; createdAt: string }>;
  },
): string {
  const baseDisplay = sanitizeFileName(getDisplayName(doc));
  const explicitMatch = (doc.source?.fileName || '').replace(/\.[^./\\]+$/, '').match(/\((\d+)\)\s*$/);
  let idx = options?.reparseIndex;
  if (idx === undefined && options?.siblingSummaries?.length) {
    const annotated = annotateLibrarySummaries(
      options.siblingSummaries.map(s => ({
        id: s.id,
        displayName: s.displayName || '',
        createdAt: s.createdAt,
        fileHash: s.fileHash,
        fileName: s.fileName,
      })),
    );
    idx = annotated.find(a => a.id === doc.id)?.reparseIndex;
  }
  if ((idx === undefined || idx === 0) && explicitMatch && !/\(\d+\)\s*$/.test(baseDisplay)) {
    idx = Number(explicitMatch[1]);
  }
  const withReparseSuffix =
    idx && idx >= 1 && !/\(\d+\)\s*$/.test(baseDisplay)
      ? `${baseDisplay} (${idx})`
      : baseDisplay;
  return `${sanitizeFileName(withReparseSuffix)}_structured.json`;
}

/** Download an ExamDoc as `<displayName>_structured.json` (preserving `(1),(2)...` re-parse suffix). */
export function exportExamJson(
  doc: ExamDoc,
  options?: {
    reparseIndex?: number;
    siblingSummaries?: Array<{ id: string; fileHash?: string; fileName?: string; displayName?: string; createdAt: string }>;
  },
): string {
  const fileName = exportExamFileName(doc, options);
  const jsonStr = JSON.stringify(buildExportDoc(doc), null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return fileName;
}

/**
 * Duplicate an exam (Step5 handleDuplicate semantics): new id + createdAt,
 * named `${displayName} (Copy)`. Image blobKeys are intentionally shared
 * with the original — deleteExam only frees blobs no remaining exam uses.
 */
export function duplicateExamDoc(doc: ExamDoc): ExamDoc {
  return {
    ...doc,
    id: `exam_${Date.now()}`,
    displayName: `${getDisplayName(doc)} (Copy)`,
    createdAt: new Date().toISOString(),
  };
}
