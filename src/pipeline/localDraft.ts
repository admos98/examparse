import type { ExtractedDocument } from './extract';
import { ExamDoc, fileNameWithoutExtension } from '../types';
import { enumerateExpectedQuestionNos } from './quality';
import { detectLanguageAndDirection } from '../utils/numbers';
import { validateAndFixDuplicateImageIds } from './assemble';
/** Import has a useful local document even before any provider has been configured. */
export function createLocalDraft(extracted: ExtractedDocument, fileHash: string): ExamDoc {
  const expected = enumerateExpectedQuestionNos(extracted.lines);
  const draft: ExamDoc = {
    id: `exam_${fileHash.slice(0, 12)}`, fileHash, createdAt: new Date().toISOString(),
    displayName: fileNameWithoutExtension(extracted.fileName),
    meta: detectLanguageAndDirection(extracted.lines.slice(0, 40).map(l => l.text).join(' ')),
    questions: [], sections: [], images: extracted.images, usage: [],
    source: { lines: extracted.lines, pages: extracted.pages, ocrUsed: extracted.ocrUsed, fileName: extracted.fileName,
      pageImages: extracted.pageImages, pageThumbKeys: extracted.pageThumbKeys, diagnostics: extracted.diagnostics,
      expectedQuestionNos: expected.numbers, keyTerritoryLineNos: [...expected.keyTerritory.lineNos] },
    flags: [{ id: 'source_only', code: 'SOURCE_ONLY', severity: 'info', message: 'Local source-only draft. No questions have been parsed and no model has been called.' },
      ...(extracted.diagnostics?.emptyPages || []).map(page => ({ id: `empty_${page}`, code: 'EXTRACTION_PAGE_EMPTY', severity: 'error' as const, message: `Page ${page} has no extracted or OCR text.` }))],
  };
  // A2: extraction can yield the same asset id twice; a draft never carries duplicate
  // ids into storage. Dedupe here (same page-aware path used after assembly), so the
  // import-time save is pure storage work.
  return Array.isArray(draft.source.lines) ? validateAndFixDuplicateImageIds(draft).doc : draft;
}
