/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect } from 'react';
import { createLocalDraft } from './pipeline/localDraft';
import { sha256 } from './utils/hash';
import { ExamHealthBanner } from './components/ExamHealthBanner';
import { AssistantView } from './views/AssistantView';
import { ExamVersions } from './components/ExamVersions';
import { applyTheme } from './pipeline/agentTheme';
import { Header } from './components/Header';
import { Stepper, StepNumber } from './components/Stepper';
import { SettingsModal } from './components/SettingsModal';
import { CostExplainerModal } from './components/CostExplainerModal';
import { Step1Import } from './views/Step1Import';
import { Step2Source } from './views/Step2Source';
import { Step3Analyze } from './views/Step3Analyze';
import { Step4Review } from './views/Step4Review';
import { Step5Exam } from './views/Step5Exam';
import { LibraryView } from './views/LibraryView';
import { AppSettings, ExamDoc, StageStatus, UsageRecord } from './types';
import { hydrateServerStorage, loadExamDoc, loadSettings, saveSettings, loadUsageLog, saveExamDoc, getStorageBackend } from './store';
import { ExtractedDocument } from './pipeline/extract';
import { createDemoExamDoc } from './pipeline/demoData';

export default function App() {
  const [currentStep, setCurrentStep] = useState<StepNumber>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<StepNumber>(1);

  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>(loadUsageLog);

  const [extractedDoc, setExtractedDoc] = useState<ExtractedDocument | null>(null);
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [answerKeyFile, setAnswerKeyFile] = useState<File | null>(null);
  const [examDoc, setExamDoc] = useState<ExamDoc | null>(null);

  const [stages, setStages] = useState<StageStatus[]>([]);
  const [importedFileHash, setImportedFileHash] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isExplainerOpen, setIsExplainerOpen] = useState(false);
  const [verifyOnOpen, setVerifyOnOpen] = useState(false);
  const [assistantMode, setAssistantMode] = useState<'closed' | 'page' | 'panel'>('closed');
  useEffect(() => { applyTheme(settings); }, [settings.themeTokens]);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);

  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  useEffect(() => { getStorageBackend().then(info => { setStorageReady(info.mode === 'folder' && Boolean(info.configured)); setStorageError(info.error || ''); });
    const listener = (e: Event) => setStorageError((e as CustomEvent).detail);
    window.addEventListener('storage-error', listener); return () => window.removeEventListener('storage-error', listener);
  }, []);
  async function chooseFolder(dir: string) {
    try { const res = await fetch('/api/storage/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) }); if (!res.ok) throw new Error((await res.json()).error); window.location.reload(); }
    catch (error) { setStorageError(String(error)); }
  }
  // Esc closes open modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSettingsOpen(false);
        setIsExplainerOpen(false);
        setIsLibraryOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Folder usage/calibration hydrate on mount. Client settings remain in localStorage.
  useEffect(() => {
    let mounted = true;
    hydrateServerStorage()
      .then(hydrated => {
        if (mounted && hydrated) {
          setSettings(loadSettings());
          setUsageRecords(loadUsageLog());
        }
      })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const handleUpdateSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  const handleDocumentLoaded = (doc: ExtractedDocument, file: File, keyFile?: File | null, fileHash?: string) => {
    setExtractedDoc(doc);
    void (async () => {
      const hash = fileHash || await sha256(await file.arrayBuffer());
      const draft = createLocalDraft(doc, hash);
      const existing = await loadExamDoc(draft.id);
      if (!existing) await saveExamDoc(draft);
      setExamDoc(existing || draft);
    })().catch(error => setStorageError(String(error)));
    setImportedFileHash(fileHash || null);
    setRawFile(file);
    setAnswerKeyFile(keyFile || null);
    setCurrentStep(2);
    setMaxReachedStep(prev => (prev < 2 ? 2 : prev));
  };

  const handleDemoLoaded = (demo: ExamDoc, persist = true) => {
    if (persist) void saveExamDoc(demo).catch(error => setStorageError(String(error)));
    setExamDoc(demo);
    setImportedFileHash(null);
    setExtractedDoc({
      lines: demo.source.lines,
      pages: demo.source.pages,
      ocrUsed: demo.source.ocrUsed,
      fileName: demo.source.fileName,
      images: demo.images,
      scannedPageIndices: [],
      pageImages: demo.source.pageImages || [],
      pageThumbKeys: demo.source.pageThumbKeys || [],
    });
    // Create dummy File object so pipeline re-run is possible
    const dummyBlob = new Blob([demo.source.lines.map(l => l.text).join('\n')], { type: 'text/plain' });
    setRawFile(new File([dummyBlob], demo.source.fileName, { type: 'text/plain' }));

    setUsageRecords(demo.usage);
    setCurrentStep(4);
    setMaxReachedStep(5);
  };

  const handleAnalysisComplete = (resultDoc: ExamDoc) => {
    setExamDoc(resultDoc);
    setUsageRecords(loadUsageLog());
    setCurrentStep(4);
    setMaxReachedStep(prev => (prev < 4 ? 4 : prev));
  };


  // Library: opening an exam behaves exactly like loading the demo doc (Step 4).
  const handleOpenExamFromLibrary = (doc: ExamDoc) => {
    handleDemoLoaded(doc, false);
    setIsLibraryOpen(false);
  };

  const handleLibraryExamRenamed = (updated: ExamDoc) => {
    setExamDoc(prev => (prev && prev.id === updated.id ? updated : prev));
  };

  const handleLibraryExamDeleted = (id: string) => {
    if (examDoc && examDoc.id === id) {
      setExamDoc(null);
      setExtractedDoc(null);
      setRawFile(null);
      setAnswerKeyFile(null);
      setStages([]);
      setCurrentStep(1);
      setMaxReachedStep(1);
    }
  };

  const handleDocUpdated = (updated: ExamDoc) => {
    setExamDoc(updated);
    setUsageRecords(loadUsageLog());
  };

  if (!storageReady) return <main className="max-w-xl mx-auto mt-24 p-8 border rounded-2xl space-y-5">
    <h1 className="text-xl font-bold">ExamParse stores everything in a local folder.</h1>
    <p>Choose a folder on the computer running ExamParse. Browser storage is never used as a fallback.</p>
    <button className="border rounded p-3 mr-2" onClick={() => { const dir = window.prompt('Local folder path (on the server computer)'); if (dir) void chooseFolder(dir); }}>Choose folder</button>
    <button className="border rounded p-3" onClick={() => void chooseFolder('./examparse-data')}>Use default: ./examparse-data</button><p role="alert">{storageError}</p>
  </main>;
  return (
    <div style={{ backgroundColor: settings.themeTokens?.background ? 'var(--app-background)' : undefined, color: settings.themeTokens?.foreground ? 'var(--app-foreground)' : undefined }} className="min-h-screen flex flex-col bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 antialiased selection:bg-blue-500 selection:text-white">
      {storageError && <p role="alert" className="p-3 bg-red-100 text-red-900">{storageError}</p>}
      {/* Top Header */}
      <Header
        activeDoc={examDoc}
        usageRecords={usageRecords}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenExplainer={() => setIsExplainerOpen(true)}
        onLoadDemo={async () => {
          const demo = await createDemoExamDoc();
          handleDemoLoaded(demo);
        }}
        onOpenLibrary={() => setIsLibraryOpen(true)}
      />

      <nav className="px-5 py-2 flex items-center gap-3 print:hidden">
        <button aria-pressed={assistantMode === 'page'} disabled={!examDoc} className="border rounded-xl px-4 py-2 text-sm" onClick={() => { setVerifyOnOpen(false); setAssistantMode('page'); }}>{settings.uiLanguage === 'fa' ? 'دستیار' : 'Assistant'}</button>
        {examDoc && currentStep >= 4 && assistantMode !== 'page' && <button className="text-xs underline" onClick={() => { setVerifyOnOpen(true); setAssistantMode('panel'); }}>{settings.uiLanguage === 'fa' ? 'از دستیار بخواهید استخراج را بررسی کند' : 'Ask the assistant to verify this parse'}</button>}
      </nav>
      {assistantMode !== 'closed' && examDoc && <AssistantView mode={assistantMode} verifyOnOpen={verifyOnOpen} key={examDoc.id} doc={examDoc} settings={settings} onUpdateDoc={updated => { setExamDoc(current => current?.id === updated.id ? updated : current); setUsageRecords(loadUsageLog()); }} onSettings={handleUpdateSettings} onClose={() => setAssistantMode('closed')} />}
      {assistantMode !== 'page' && <React.Fragment>
      {examDoc && currentStep === 4 && <div className="max-w-6xl mx-auto w-full px-4"><ExamVersions doc={examDoc} onRestore={handleDocUpdated} /></div>}
      {/* Guided 5-Step Stepper Navigation */}
      <Stepper
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        onSelectStep={step => setCurrentStep(step)}
      />

      {currentStep === 2 && examDoc && <div className="max-w-6xl mx-auto w-full px-4"><ExamHealthBanner doc={examDoc} /></div>}
      {/* Step View Content */}
      <main className="flex-1 pb-16">
        {currentStep === 1 && (
          <Step1Import
            onDocumentLoaded={handleDocumentLoaded}
            onDemoLoaded={handleDemoLoaded}
            isLoading={false}
            cacheEnabled={settings.thrift.cacheEnabled}
            onOpenSavedExam={handleOpenExamFromLibrary}
          />
        )}

        {currentStep === 2 && extractedDoc && (
          <Step2Source
            diagnostics={extractedDoc.diagnostics}
            lines={extractedDoc.lines}
            pages={extractedDoc.pages}
            ocrUsed={extractedDoc.ocrUsed}
            pageImages={extractedDoc.pageImages}
            pageThumbKeys={extractedDoc.pageThumbKeys}
            images={extractedDoc.images}
            onProceedToAnalyze={() => {
              setCurrentStep(3);
              setMaxReachedStep(prev => (prev < 3 ? 3 : prev));
            }}
          />
        )}

        {currentStep === 3 && extractedDoc && (
          <Step3Analyze
            extractedDoc={extractedDoc}
            rawFile={rawFile}
            answerKeyFile={answerKeyFile}
            settings={settings}
            stages={stages}
            onStagesUpdate={setStages}
            onAnalysisComplete={handleAnalysisComplete}
            isAnalyzing={isAnalyzing}
            setIsAnalyzing={setIsAnalyzing}
            fileHash={importedFileHash || undefined}
            onOpenSavedExam={handleOpenExamFromLibrary}
          />
        )}

        {currentStep === 4 && examDoc && (
          <Step4Review
            examDoc={examDoc}
            settings={settings}
            onUpdateDoc={handleDocUpdated}
            onProceedToExamView={() => {
              setCurrentStep(5);
              setMaxReachedStep(5);
            }}
          />
        )}

        {currentStep === 5 && examDoc && (
          <Step5Exam defaultExamMode={settings.defaultExamMode} doc={examDoc} onUpdateDoc={handleDocUpdated} />
        )}
      </main>

      </React.Fragment>}

      {/* Exam Library (full-screen overlay, not a stepper step) */}
      <LibraryView
        isOpen={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
        activeExamId={examDoc?.id}
        onOpenExam={handleOpenExamFromLibrary}
        onExamRenamed={handleLibraryExamRenamed}
        onExamDeleted={handleLibraryExamDeleted}
        onGoToImport={() => {
          setIsLibraryOpen(false);
          setCurrentStep(1);
        }}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSaveSettings={handleUpdateSettings}
        onOpenExplainer={() => {
          setIsSettingsOpen(false);
          setIsExplainerOpen(true);
        }}
      />

      {/* Cost Explainer Modal */}
      <CostExplainerModal
        isOpen={isExplainerOpen}
        onClose={() => setIsExplainerOpen(false)}
      />
    </div>
  );
}
