import React, { useState, useRef } from 'react';
import {
  Printer,
  Download,
  Upload,
  FileText,
  Copy,
  Check,
  Eye,
  FileSpreadsheet,
} from 'lucide-react';
import { ExamDoc, ImageAsset, getDisplayName, sanitizeFileName } from '../types';
import { DeterministicRenderer, ExamRenderMode } from './DeterministicRenderer';
import { saveExamDoc, getImageBlob } from '../store';
import { duplicateExamDoc, exportExamJson } from '../utils/examExport';

interface Props {
  doc: ExamDoc;
  onUpdateDoc: (updated: ExamDoc) => void;
}

export const Step5Exam: React.FC<Props> = ({ doc, onUpdateDoc }) => {
  const [renderMode, setRenderMode] = useState<ExamRenderMode>('paper');
  const [copiedJson, setCopiedJson] = useState(false);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // Trigger browser print dialog for A4 output
  const handlePrint = () => {
    window.print();
  };

  // Export JSON via the shared helper (also used by the Exam Library)
  const handleExportJson = () => {
    exportExamJson(doc);
  };

  // Import JSON to reconstruct exam view — re-links image dataUrls from IndexedDB by blobKey
  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result as string);

        // Validate parsed shape before accepting
        if (!parsed || typeof parsed !== 'object') throw new Error('Not a valid object');
        if (!Array.isArray(parsed.questions)) throw new Error('Missing questions array');
        if (!parsed.source || !Array.isArray(parsed.source.lines)) throw new Error('Missing source.lines');
        if (!parsed.meta || typeof parsed.meta !== 'object') throw new Error('Missing meta object');

        // Re-link image dataUrls from IndexedDB by blobKey (same restore logic as loadExamDoc)
        const restoredImages: ImageAsset[] = await Promise.all(
          (parsed.images || []).map(async (img: any) => {
            const blob = img.blobKey ? await getImageBlob(img.blobKey) : undefined;
            let dataUrl: string | undefined = undefined;
            if (blob) {
              dataUrl = URL.createObjectURL(blob);
            }
            return { ...img, dataUrl };
          })
        );

        const importedDoc: ExamDoc = {
          ...parsed,
          images: restoredImages,
        };

        onUpdateDoc(importedDoc);
        await saveExamDoc(importedDoc);
      } catch (err: any) {
        alert(`Invalid Exam JSON: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  // Duplicate exam -> new version (shared helper, same semantics as the Library)
  const handleDuplicate = () => {
    const newDoc = duplicateExamDoc(doc);
    onUpdateDoc(newDoc);
    saveExamDoc(newDoc);
  };

  // Export as DOCX format using HTML document MIME
  const handleExportDocx = () => {
    const printArea = document.getElementById('printable-exam-area');
    if (!printArea) return;

    const htmlContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset='utf-8'>
        <title>${getDisplayName(doc)}</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, sans-serif; font-size: 11pt; direction: ${doc.meta.direction}; }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #999; padding: 6px; }
        </style>
      </head>
      <body>
        ${printArea.innerHTML}
      </body>
      </html>
    `;

    const blob = new Blob(['\ufeff', htmlContent], {
      type: 'application/msword',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFileName(getDisplayName(doc))}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="py-6 px-4 space-y-6">
      {/* Top Action Bar (Hidden on print) */}
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-xs print:hidden">
        {/* Render Modes Selector */}
        <div className="inline-flex rounded-xl p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700/60 text-xs font-medium">
          <button
            onClick={() => setRenderMode('paper')}
            className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${
              renderMode === 'paper'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs font-semibold'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Exam Paper (Blank)
          </button>
          <button
            onClick={() => setRenderMode('answer-key')}
            className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${
              renderMode === 'answer-key'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs font-semibold'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Answer Key Mode
          </button>
          <button
            onClick={() => setRenderMode('review')}
            className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${
              renderMode === 'review'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs font-semibold'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Review (Anchors & Flags)
          </button>
        </div>

        {/* Export & Print Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={handleDuplicate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            title="Duplicate exam to create Version B"
          >
            <Copy className="w-3.5 h-3.5 text-slate-500" />
            <span>Duplicate</span>
          </button>

          <button
            onClick={handleExportDocx}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            title="Export DOCX document"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-blue-500" />
            <span>DOCX</span>
          </button>

          <button
            onClick={handleExportJson}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            title="Export clean ExamDoc JSON"
          >
            <Download className="w-3.5 h-3.5 text-emerald-500" />
            <span>Export JSON</span>
          </button>

          <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer">
            <Upload className="w-3.5 h-3.5 text-purple-500" />
            <span>Import JSON</span>
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json"
              onChange={handleImportJson}
              className="hidden"
            />
          </label>

          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition cursor-pointer shadow-xs ml-1"
          >
            <Printer className="w-4 h-4" />
            <span>Print / Save PDF</span>
          </button>
        </div>
      </div>

      {/* Rendered Printable Exam Container */}
      <div id="printable-exam-area" className="w-full overflow-x-auto pb-10">
        <DeterministicRenderer doc={doc} mode={renderMode} />
      </div>
    </div>
  );
};
