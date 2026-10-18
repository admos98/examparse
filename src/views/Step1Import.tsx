import React, { useState, useRef } from 'react';
import {
  Upload,
  FileText,
  AlertTriangle,
  FileCheck,
  Sparkles,
  KeyRound,
  FileCode,
  ArrowRight,
} from 'lucide-react';
import { ExtractedDocument } from '../pipeline/extract';
import { getOrExtractDocument } from '../pipeline/extractCache';
import { createDemoExamDoc } from '../pipeline/demoData';
import { ExamDoc, getDisplayName } from '../types';
import { loadExamDoc } from '../store';
import { sha256 } from '../utils/hash';
import { MAX_SOURCE_FILE_BYTES } from '../utils/validation';

interface Props {
  onDocumentLoaded: (doc: ExtractedDocument, rawFile: File, answerKeyFile?: File | null, fileHash?: string) => void;
  onDemoLoaded: (demoDoc: ExamDoc) => void;
  isLoading: boolean;
  cacheEnabled?: boolean;
  onOpenSavedExam?: (doc: ExamDoc) => void;
}

export const Step1Import: React.FC<Props> = ({ onDocumentLoaded, onDemoLoaded, isLoading, cacheEnabled = true, onOpenSavedExam }) => {
  const [dragOver, setDragOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'upload' | 'paste'>('upload');
  const [pastedText, setPastedText] = useState('');
  const [pastedFileName, setPastedFileName] = useState('pasted_exam.txt');
  const [answerKeyFile, setAnswerKeyFile] = useState<File | null>(null);
  const [savedExam, setSavedExam] = useState<ExamDoc | null>(null);
  const [pendingImport, setPendingImport] = useState<{ doc: ExtractedDocument; file: File; fileHash: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const answerKeyInputRef = useRef<HTMLInputElement>(null);

  const handleFileProcess = async (file: File) => {
    setErrorMessage(null);
    if (!file || file.size <= 0) { setErrorMessage('The selected file is empty.'); return; }
    if (file.size > MAX_SOURCE_FILE_BYTES) { setErrorMessage(`File exceeds the ${Math.round(MAX_SOURCE_FILE_BYTES / 1024 / 1024)} MiB import limit.`); return; }
    if (file.name.length > 255 || /[\u0000-\u001f]/.test(file.name)) { setErrorMessage('Invalid file name.'); return; }
    const ext = file.name.split('.').pop()?.toLowerCase();

    // Reject legacy .doc with friendly message
    if (ext === 'doc') {
      setErrorMessage(
        'Legacy .doc binary format is not supported. Please convert your file to .docx or .pdf in Word/LibreOffice and re-upload.'
      );
      return;
    }

    const validExtensions = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md'];
    if (!validExtensions.includes(ext || '')) {
      setErrorMessage(`Unsupported format .${ext}. Please provide PDF, DOCX, image scan, or text.`);
      return;
    }

    try {
      // Hash first: extraction cache + saved-exam fast-path key off the file hash.
      const fileHash = await sha256(await file.arrayBuffer());
      const { extracted } = await getOrExtractDocument(file, {
        fileHash,
        useCache: cacheEnabled,
      });

      // Exam fast-path (B6): a saved result for this exact file already exists.
      try {
        const saved = await loadExamDoc(`exam_${fileHash.slice(0, 12)}`);
        if (saved && Array.isArray(saved.questions) && saved.questions.length > 0) {
          setSavedExam(saved);
          setPendingImport({ doc: extracted, file, fileHash });
          return;
        }
      } catch {
        // No saved exam / storage unavailable — proceed with the fresh import.
      }

      onDocumentLoaded(extracted, file, answerKeyFile, fileHash);
    } catch (err: any) {
      setErrorMessage(`Failed to process document: ${err.message || 'Corrupt or unreadable file'}`);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileProcess(e.dataTransfer.files[0]);
    }
  };

  const handlePasteSubmit = async () => {
    if (!pastedText.trim()) return;
    if (new TextEncoder().encode(pastedText).length > MAX_SOURCE_FILE_BYTES) { setErrorMessage('Pasted text exceeds the 50 MiB import limit.'); return; }
    const blob = new Blob([pastedText], { type: 'text/plain' });
    const file = new File([blob], pastedFileName || 'exam.txt', { type: 'text/plain' });
    handleFileProcess(file);
  };

  const handleLoadDemo = async () => {
    try {
      const demo = await createDemoExamDoc();
      onDemoLoaded(demo);
    } catch (err: any) {
      setErrorMessage(`Failed to load demo exam: ${err.message}`);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      {/* Intro Header */}
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Import Exam Paper
        </h1>
        <p className="text-sm text-slate-500 max-w-xl mx-auto">
          Convert your local exam paper (PDF, DOCX, or scanned images) into a structured JSON model with deterministic A4 reconstruction.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="inline-flex rounded-xl p-1 bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60">
          <button
            onClick={() => setActiveTab('upload')}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
              activeTab === 'upload'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            File Upload
          </button>
          <button
            onClick={() => setActiveTab('paste')}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
              activeTab === 'paste'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Paste Raw Text
          </button>
        </div>
      </div>

      {/* Error Message */}
      {errorMessage && (
        <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 flex items-start gap-3 text-xs animate-in fade-in">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
          <div className="flex-1">
            <span className="font-semibold">Notice:</span> {errorMessage}
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-red-600">
            &times;
          </button>
        </div>
      )}

      {/* Saved-result fast-path */}
      {savedExam && pendingImport && (
        <div className="p-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-3">
            <FileCheck className="w-5 h-5 shrink-0 text-emerald-500 mt-0.5" />
            <div>
              <div className="font-bold">Already parsed — Open saved result</div>
              <p>
                “{getDisplayName(savedExam)}” was analyzed before ({savedExam.questions.length} questions,{' '}
                {new Date(savedExam.createdAt).toLocaleDateString()}). Re-analyze remains available.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onOpenSavedExam?.(savedExam)}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition cursor-pointer"
            >
              Open saved result
            </button>
            <button
              onClick={() => {
                onDocumentLoaded(pendingImport.doc, pendingImport.file, answerKeyFile, pendingImport.fileHash);
                setSavedExam(null);
                setPendingImport(null);
              }}
              className="px-4 py-2 rounded-xl border border-emerald-600/40 hover:bg-emerald-500/10 font-medium transition cursor-pointer"
            >
              Import &amp; re-analyze
            </button>
          </div>
        </div>
      )}

      {/* Main Upload Zone */}
      {activeTab === 'upload' ? (
        <div
          onDragOver={e => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-3xl p-10 text-center transition cursor-pointer flex flex-col items-center justify-center space-y-4 ${
            dragOver
              ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 scale-[0.99]'
              : 'border-slate-300 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-700 bg-white/50 dark:bg-slate-900/40'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.md"
            onChange={e => e.target.files?.[0] && handleFileProcess(e.target.files[0])}
            className="hidden"
          />

          <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shadow-inner">
            <Upload className="w-8 h-8" />
          </div>

          <div className="space-y-1">
            <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">
              {isLoading ? 'Extracting document locally...' : 'Drop your exam file here, or browse'}
            </h3>
            <p className="text-xs text-slate-400">
              PDF, DOCX, Scanned Images (PNG/JPG), TXT, Markdown
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-2 text-[11px] text-slate-500">
            <span className="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">
              .pdf (text & embedded images)
            </span>
            <span className="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">
              .docx (Word)
            </span>
            <span className="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">
              image/* (OCR scan)
            </span>
          </div>
        </div>
      ) : (
        /* Paste Raw Text Tab */
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex justify-between items-center text-xs">
            <label className="font-semibold text-slate-800 dark:text-slate-200">
              Exam Document Name
            </label>
            <input
              type="text"
              value={pastedFileName}
              onChange={e => setPastedFileName(e.target.value)}
              className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono text-xs w-60"
            />
          </div>
          <textarea
            rows={12}
            placeholder="Paste your exam questions, sections, and answers here...&#10;E.g.:&#10;Section 1: Multiple Choice&#10;1. Which particle has positive charge?&#10;A) Electron  B) Proton  C) Neutron&#10;..."
            value={pastedText}
            onChange={e => setPastedText(e.target.value)}
            className="w-full p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono text-xs text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          />
          <div className="flex justify-end">
            <button
              disabled={!pastedText.trim()}
              onClick={handlePasteSubmit}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition cursor-pointer disabled:opacity-40"
            >
              <span>Load Text into Source</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Secondary Options Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Built-in Demo Card */}
        <div className="p-4 rounded-2xl border border-indigo-200 dark:border-indigo-800/60 bg-indigo-50/40 dark:bg-indigo-950/20 flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-900 dark:text-indigo-300">
              <Sparkles className="w-4 h-4 text-indigo-500" />
              <span>Physics & Math Demo Exam</span>
            </div>
            <p className="text-[11px] text-indigo-700/80 dark:text-indigo-400/80">
              Pre-loaded with 6 questions, diagram asset, MCQ, blanks & Persian RTL support.
            </p>
          </div>
          <button
            onClick={handleLoadDemo}
            className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition shrink-0 cursor-pointer shadow-xs"
          >
            Load Demo
          </button>
        </div>

        {/* Answer Key Options Card */}
        <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
              <KeyRound className="w-4 h-4 text-amber-500" />
              <span>Answer Key Strategy</span>
            </div>
            <label className="px-3 py-1 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px] font-medium transition cursor-pointer">
              {answerKeyFile ? 'Change File' : 'Attach File'}
              <input
                ref={answerKeyInputRef}
                type="file"
                accept=".pdf,.txt,.docx"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const ext = file.name.split('.').pop()?.toLowerCase();
                  if (!['pdf', 'txt', 'docx'].includes(ext || '') || file.size <= 0 || file.size > MAX_SOURCE_FILE_BYTES) {
                    setErrorMessage(`Answer-key file must be PDF, TXT, or DOCX and no larger than ${Math.round(MAX_SOURCE_FILE_BYTES / 1024 / 1024)} MiB.`);
                    e.target.value = '';
                    return;
                  }
                  setErrorMessage(null);
                  setAnswerKeyFile(file);
                }}
                className="hidden"
              />
            </label>
          </div>

          <div className="text-[11px] text-slate-500 space-y-1">
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
              <span>In-Doc Detection: AI automatically detects embedded answer key tables or end solutions.</span>
            </div>
            {answerKeyFile ? (
              <div className="text-blue-600 dark:text-blue-400 font-mono text-[10px]">
                Attached file: {answerKeyFile.name} (will match by question #)
              </div>
            ) : (
              <div className="text-slate-400 text-[10px]">
                Or click &ldquo;Answer with AI&rdquo; in Step 4 to solve missing questions on demand.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
