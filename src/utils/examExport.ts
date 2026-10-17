/**
 * Shared ExamDoc export / duplicate helpers.
 * Used by Step5Exam and the Exam Library so both share identical semantics.
 */
import { ExamDoc, getDisplayName, sanitizeFileName } from '../types';

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
  return {
    ...doc,
    displayName: getDisplayName(doc),
    images: cleanImages,
    source: sourceWithoutPageImages,
  };
}

/** Download an ExamDoc as `<displayName>_structured.json` (filesystem-sanitized). */
export function exportExamJson(doc: ExamDoc): void {
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
