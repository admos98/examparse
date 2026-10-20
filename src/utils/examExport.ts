/**
 * Shared ExamDoc export / duplicate helpers.
 * Used by Step5Exam and the Exam Library so both share identical semantics.
 */
import { ExamDoc, getDisplayName, sanitizeFileName } from '../types';
import { getExamHealth } from '../pipeline/quality';
import { stripCredentialFields } from './validation';
import { buildParseReport, type ParseReport } from '../pipeline/provenance';

/** 2F exam-level Parse report — shared by Step 5 and the JSON export receipt (no secrets). */
export function parseReportForDoc(doc: ExamDoc): ParseReport {
  const health = getExamHealth(doc);
  const models: Record<string, string> = {};
  for (const u of doc.usage || []) if (u.role && u.model) models[u.role] = u.model;
  const verdicts = Object.values((doc as any).verdicts || {}).flat() as any[];
  return buildParseReport(doc as any, {
    models,
    calls: (doc.usage || []).filter(u => !(u as any).isCachedHit).length,
    tokens: { input: (doc.usage || []).reduce((a, u) => a + (u.inputTokens || 0), 0), output: (doc.usage || []).reduce((a, u) => a + (u.outputTokens || 0), 0) },
    cost: Number((doc.usage || []).reduce((a, u) => a + ((u as any).costUsd || 0), 0).toFixed(4)),
    coverageAfter: health.coveragePercent,
    consensusSections: [...new Set((doc.flags || []).filter(f => f.code.startsWith('CONSENSUS')).map(f => f.questionId || 'section'))],
    critic: { calls: (doc.usage || []).filter(u => (u as any).role === 'critic').length, defects: verdicts.filter(v => v.verdict === 'defect').length, ok: verdicts.filter(v => v.verdict === 'ok').length },
    memory: { playbookIds: [...new Set<string>(((doc as any).traces || []).flatMap((t: any) => t.guidance?.playbookIds || []))], skillIds: [...new Set<string>(((doc as any).traces || []).flatMap((t: any) => t.guidance?.skillIds || []))], guidanceTokens: 0 },
    config: { models },
  });
}

/** Build the clean export payload: no image dataUrls, no heavy page-image data URLs. */
export function buildExportDoc(doc: ExamDoc): any {
  const cleanImages = (doc.images || []).map(img => {
    const { dataUrl, ...rest } = img as any;
    return {
      ...rest,
      exportPath: `images/${img.id}.${(img.mime || 'image/jpeg').split('/')[1] || 'jpg'}`,
    };
  });

  const { pageImages, ...sourceWithoutPageImages } = (doc.source || {}) as any;
  return stripCredentialFields({
    ...doc,
    parseReport: parseReportForDoc(doc),
    displayName: getDisplayName(doc),
    images: cleanImages,
    source: sourceWithoutPageImages,
  });
}

/** Never silently export an incomplete exam; native confirmation works for every export surface. */
export function confirmPartialExport(doc: ExamDoc, action = 'export'): boolean {
  const health = getExamHealth(doc);
  if (health.complete) return true;
  const issues = [
    health.missing.length ? `missing questions: ${health.missing.join(', ')}` : '',
    health.duplicates.length ? `duplicate question numbers: ${health.duplicates.join(', ')}` : '',
    health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.51 ? `points deficit: ${health.pointDeficit}` : '',
    health.unplacedImages.length ? `${health.unplacedImages.length} unplaced image(s)` : '',
    health.unresolvedImageRefs.length ? `${health.unresolvedImageRefs.length} unresolved image reference(s)` : '',
    (health.parentLinkIssueCount || 0) ? `${health.parentLinkIssueCount} invalid nested-question link(s)` : '',
  ].filter(Boolean).join('; ') || 'integrity checks need review';
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
  return window.confirm(`This exam is PARTIAL (${issues}). ${action} it anyway?`);
}

/** Download an ExamDoc as `<displayName>_structured.json` (filesystem-sanitized). */
export function exportExamJson(doc: ExamDoc): void {
  if (!confirmPartialExport(doc, 'Export')) return;
  const jsonStr = JSON.stringify(buildExportDoc(doc), null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFileName(getDisplayName(doc))}_structured.json`;
  a.click();
  URL.revokeObjectURL(url);
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
