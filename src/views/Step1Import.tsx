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
import { AppSettings, ExamDoc, getDisplayName } from '../types';
import { loadExamDoc, listExamSummaries, saveExamDoc } from '../store';
import { enrichPackage } from '../pipeline/packageEnrichment';
import { appendJournalCall } from '../pipeline/journal';
import { importPackageFolder } from '../pipeline/packageBatchImport';
import { sha256 } from '../utils/hash';
import { importQuestionPackage } from '../pipeline/packageImport';
import { MAX_SOURCE_FILE_BYTES } from '../utils/validation';

interface Props {
  onDocumentLoaded: (doc: ExtractedDocument, rawFile: File, answerKeyFile?: File | null, fileHash?: string) => void;
  onDemoLoaded: (demoDoc: ExamDoc) => void;
  onPackageLoaded: (doc: ExamDoc) => void | Promise<void>;
  settings: AppSettings;
  onBatchImported?: () => void | Promise<void>;
  isLoading: boolean;
  cacheEnabled?: boolean;
  onOpenSavedExam?: (doc: ExamDoc) => void;
}

export const Step1Import: React.FC<Props> = ({ onDocumentLoaded, onDemoLoaded, onPackageLoaded, onBatchImported, settings, isLoading, cacheEnabled = true, onOpenSavedExam }) => {
  const [importOnly, setImportOnly] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchMessage, setBatchMessage] = useState('');
  // #58 Part F — a bounded live log for the parent-folder chain (exam i/N, calls, errors/skips).
  const [batchLog, setBatchLog] = useState<string[]>([]);
  const pushBatchLog = (message: string) => setBatchLog(previous => [...previous.slice(-160), message]);
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

  const handlePackageFiles = async (files: File[]) => {
    setErrorMessage(null);
    try {
      if (files.reduce((sum, f) => sum + f.size, 0) > MAX_SOURCE_FILE_BYTES) throw new Error('Package exceeds the import size limit.');
      await onPackageLoaded(await importQuestionPackage(files));
    } catch (err: any) { setErrorMessage(`Failed to import package: ${err.message || err}`); }
  };

  const handleBatchFiles = async (files: File[]) => {
    if (batchRunning) return;
    setBatchRunning(true); setErrorMessage(null); setBatchMessage('Loading library…');
    try {
      const summaries = await listExamSummaries();
      const existing = (await Promise.all(summaries.map(s => loadExamDoc(s.id)))).filter((d): d is ExamDoc => !!d);
      setBatchLog([]);
      const result = await importPackageFolder(
        files,
        existing,
        doc => saveExamDoc(doc, undefined, { requireImages: true }),
        message => { setBatchMessage(message); pushBatchLog(message); },
        importOnly ? undefined : (doc, onProgress) => enrichPackage(doc, settings, {
          onProgress: message => { setBatchMessage(message); pushBatchLog(message); },
          onEvent: event => {
            if (event.kind === 'phase') pushBatchLog(`· ${event.message || ''}`);
            else if (event.kind === 'call') pushBatchLog(`· check ${event.completed} of ~${event.planned} (estimate) · ${event.label} · ${event.check}`);
            else if (event.kind === 'error' || event.kind === 'skip') pushBatchLog(`· ${event.kind}: ${event.label || ''} ${event.check || ''} ${event.message || ''}`.trim());
          },
          onStream: undefined,
          onJournal: entry => appendJournalCall(`package-enrichment:${doc.fileHash}`, { ...entry, ts: new Date().toISOString(), complete: true }),
        }),
      );
      await onBatchImported?.();
      setBatchMessage(`Imported ${result.imported} / duplicates ${result.duplicates} / failed ${result.failed} / not a package ${result.notPackage}\n${result.details.join('\n')}`);
    } catch (err: any) { setErrorMessage(`Batch import failed: ${err.message || err}`); setBatchMessage(''); } finally { setBatchRunning(false); }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const files = Array.from(e.dataTransfer.files);
      if (files.some(f => /\.json$/i.test(f.name))) void handlePackageFiles(files);
      else handleFileProcess(files[0]);
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
        <h1 className="text-2xl font-bold tracking-tight text-[var(--ink)] ">
          Import Exam Paper
        </h1>
        <p className="text-sm text-[var(--ink-2)] max-w-xl mx-auto">
          Convert your local exam paper (PDF, DOCX, or scanned images) into a structured JSON model with deterministic A4 reconstruction.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="inline-flex rounded-[10px] p-1 bg-[var(--paper)]  border border-[var(--rule)] ">
          <button
            onClick={() => setActiveTab('upload')}
            className={`px-4 py-1.5 rounded-[6px] text-xs font-medium transition cursor-pointer ${
              activeTab === 'upload'
                ? 'bg-[var(--paper-raised)]  text-[var(--ink)]  '
                : 'text-[var(--ink-2)] hover:text-[var(--ink)] '
            }`}
          >
            File Upload
          </button>
          <button
            onClick={() => setActiveTab('paste')}
            className={`px-4 py-1.5 rounded-[6px] text-xs font-medium transition cursor-pointer ${
              activeTab === 'paste'
                ? 'bg-[var(--paper-raised)]  text-[var(--ink)]  '
                : 'text-[var(--ink-2)] hover:text-[var(--ink)] '
            }`}
          >
            Paste Raw Text
          </button>
        </div>
      </div>

      {/* Error Message */}
      {errorMessage && (
        <div className="p-4 rounded-[10px] border border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]  flex items-start gap-3 text-xs  ">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--danger)]" />
          <div className="flex-1">
            <span className="font-semibold">Notice:</span> {errorMessage}
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-[var(--danger)] hover:text-[var(--danger)]">
            &times;
          </button>
        </div>
      )}

      {/* Saved-result fast-path */}
      {savedExam && pendingImport && (
        <div className="p-4 rounded-[10px] border border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]  flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-3">
            <FileCheck className="w-5 h-5 shrink-0 text-[var(--ok)] mt-0.5" />
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
              className="px-4 py-2 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] font-medium transition cursor-pointer"
            >
              Open saved result
            </button>
            <button
              onClick={() => {
                onDocumentLoaded(pendingImport.doc, pendingImport.file, answerKeyFile, pendingImport.fileHash);
                setSavedExam(null);
                setPendingImport(null);
              }}
              className="px-4 py-2 rounded-[6px] border border-[var(--ok)] hover:bg-[var(--ok-soft)] font-medium transition cursor-pointer"
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
          className={`border-2 border-dashed rounded-[10px] p-10 text-center transition cursor-pointer flex flex-col items-center justify-center space-y-4 ${
            dragOver
              ? 'border-[var(--accent)] bg-[var(--paper)]  scale-[0.99]'
              : 'border-[var(--rule-strong)]  hover:border-[var(--rule-strong)]  bg-[var(--paper-raised)] '
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.md"
            onChange={e => e.target.files?.[0] && handleFileProcess(e.target.files[0])}
            className="hidden"
          />

          <div className="w-16 h-16 rounded-[10px] bg-[var(--paper)]  text-[var(--accent-ink)]  flex items-center justify-center ">
            <Upload className="w-8 h-8" />
          </div>

          <div className="space-y-1">
            <h3 className="font-semibold text-[var(--ink)]  text-sm">
              {isLoading ? 'Extracting document locally...' : 'Drop your exam file here, or browse'}
            </h3>
            <p className="text-xs text-[var(--ink-2)]">
              PDF, DOCX, Scanned Images (PNG/JPG), TXT, Markdown
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-2 text-[length:var(--type-12)] text-[var(--ink-2)]">
            <span className="px-2.5 py-1 rounded-[10px] bg-[var(--paper)]  border border-[var(--rule)]  font-mono">
              .pdf (text & embedded images)
            </span>
            <span className="px-2.5 py-1 rounded-[10px] bg-[var(--paper)]  border border-[var(--rule)]  font-mono">
              .docx (Word)
            </span>
            <span className="px-2.5 py-1 rounded-[10px] bg-[var(--paper)]  border border-[var(--rule)]  font-mono">
              image/* (OCR scan)
            </span>
          </div>
        </div>
      ) : (
        /* Paste Raw Text Tab */
        <div className="bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-6 space-y-4">
          <div className="flex justify-between items-center text-xs">
            <label className="font-semibold text-[var(--ink)] ">
              Exam Document Name
            </label>
            <input
              type="text"
              value={pastedFileName}
              onChange={e => setPastedFileName(e.target.value)}
              className="px-2.5 py-1 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper)]  font-mono text-xs w-60"
            />
          </div>
          <textarea
            rows={12}
            placeholder="Paste your exam questions, sections, and answers here...&#10;E.g.:&#10;Section 1: Multiple Choice&#10;1. Which particle has positive charge?&#10;A) Electron  B) Proton  C) Neutron&#10;..."
            value={pastedText}
            onChange={e => setPastedText(e.target.value)}
            className="w-full p-3.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper)]  font-mono text-xs text-[var(--ink)]  focus:outline-hidden focus:ring-1 focus:ring-[var(--focus)]"
          />
          <div className="flex justify-end">
            <button
              disabled={!pastedText.trim()}
              onClick={handlePasteSubmit}
              className="ep-directional-forward flex items-center gap-2 px-5 py-2 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] text-xs font-medium transition cursor-pointer disabled:opacity-40"
            >
              <span>Load Text into Source</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="p-4 rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] space-y-2">
        <h2 className="font-semibold text-sm">Import question package</h2>
        <p className="text-xs text-[var(--ink-2)]">Select a package JSON with its images, or choose its folder. Appendix A batches are supported too.</p>
        <div className="flex gap-3 flex-wrap text-xs">
          <label className="border rounded px-3 py-2 cursor-pointer">Choose files<input type="file" multiple accept=".json,.md,image/*" className="hidden" onChange={e => { if (e.target.files?.length) void handlePackageFiles(Array.from(e.target.files)); e.target.value = ''; }} /></label>
          <label className="border rounded px-3 py-2 cursor-pointer">Choose parent folder (batch)<input type="file" multiple disabled={batchRunning} {...({ webkitdirectory: '' } as any)} className="hidden" onChange={e => { if (e.target.files?.length) void handleBatchFiles(Array.from(e.target.files)); e.target.value = ''; }} /></label>
          <label className="border rounded px-3 py-2 cursor-pointer">Choose folder<input type="file" multiple disabled={batchRunning} {...({ webkitdirectory: '' } as any)} className="hidden" onChange={e => { if (e.target.files?.length) void handlePackageFiles(Array.from(e.target.files)); e.target.value = ''; }} /></label>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={batchRunning} checked={importOnly} onChange={e => setImportOnly(e.target.checked)} /> Import only, don’t enrich</label>
      {batchMessage && <div role="status" className="whitespace-pre-line text-sm">{batchMessage}</div>}
      {batchLog.length > 0 && <details open={batchRunning} className="rounded border border-[var(--rule)] p-2 text-xs" data-batch-live="true">
        <summary className="cursor-pointer font-semibold">Live run log ({batchLog.length})</summary>
        <pre aria-live="polite" className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">{batchLog.join('\n')}</pre>
      </details>}

      {/* Secondary Options Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Built-in Demo Card */}
        <div className="p-4 rounded-[10px] border border-[var(--accent)]  bg-[var(--paper)]  flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-ink)] ">
              <Sparkles className="w-4 h-4 text-[var(--accent-ink)]" />
              <span>Physics & Math Demo Exam</span>
            </div>
            <p className="text-[length:var(--type-12)] text-[var(--accent-ink)] ">
              Pre-loaded with 6 questions, diagram asset, MCQ, blanks & Persian RTL support.
            </p>
          </div>
          <button
            onClick={handleLoadDemo}
            className="px-3.5 py-1.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] text-xs font-medium transition shrink-0 cursor-pointer "
          >
            Load Demo
          </button>
        </div>

        {/* Answer Key Options Card */}
        <div className="p-4 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper-raised)]  space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ink)] ">
              <KeyRound className="w-4 h-4 text-[var(--warn-ink)]" />
              <span>Answer Key Strategy</span>
            </div>
            <label className="px-3 py-1 rounded-[6px] border border-[var(--rule-strong)]  hover:bg-[var(--paper)]  text-[var(--ink)]  text-[length:var(--type-12)] font-medium transition cursor-pointer">
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

          <div className="text-[length:var(--type-12)] text-[var(--ink-2)] space-y-1">
            <div className="flex items-center gap-1.5 text-[var(--ok)]  font-medium">
              <span className="w-1.5 h-1.5 rounded-[10px] bg-[var(--ok)] shrink-0"></span>
              <span>In-Doc Detection: AI automatically detects embedded answer key tables or end solutions.</span>
            </div>
            {answerKeyFile ? (
              <div className="text-[var(--accent-ink)]  font-mono text-[length:var(--type-12)]">
                Attached file: {answerKeyFile.name} (will match by question #)
              </div>
            ) : (
              <div className="text-[var(--ink-2)] text-[length:var(--type-12)]">
                Or click &ldquo;Answer with AI&rdquo; in Step 4 to solve missing questions on demand.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
