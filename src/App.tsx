/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createLocalDraft } from './pipeline/localDraft';
import { sha256 } from './utils/hash';
import { ExamHealthBanner } from './components/ExamHealthBanner';
import { AssistantView } from './views/AssistantView';
import { ExamVersions } from './components/ExamVersions';
import { applyTheme, nextThemeMode } from './pipeline/agentTheme';
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
import { hydrateServerStorage, loadExamDoc, loadSettings, saveSettings, loadUsageLog, saveExamDoc, getStorageBackend, getSourceFile, listExamSummaries, ExamSummary } from './store';
import { ExtractedDocument } from './pipeline/extract';
import { createDemoExamDoc } from './pipeline/demoData';
import { CommandPalette } from './design/CommandPalette';
import { Button, Kbd, Modal } from './design/primitives';
import { StyleGuideView } from './design/StyleGuideView';
import { UiLanguage, uiText } from './design/i18n';
import { getExamHealth } from './pipeline/quality';
import { revertTextRepairOverlays } from './pipeline/textRepair';
import { maybeRecordCorpusFixes } from './pipeline/corpusPromote';

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
  const [settingsTab, setSettingsTab] = useState<'providers' | 'assistant' | 'diagnostics' | 'privacy'>('providers');
  const [isExplainerOpen, setIsExplainerOpen] = useState(false);
  const [verifyOnOpen, setVerifyOnOpen] = useState(false);
  const [assistantMode, setAssistantMode] = useState<'closed' | 'page' | 'panel'>('closed');
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [summaries, setSummaries] = useState<ExamSummary[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [storageDir, setStorageDir] = useState('');
  const [folderPath, setFolderPath] = useState('./examparse-data');
  const [exportRequest, setExportRequest] = useState(0);
  const [exportQueued, setExportQueued] = useState(false);
  const [retryRequest, setRetryRequest] = useState(0);
  /** B3 — Step 4 → Step 2 orphan jump target (line number). */
  const [sourceFocusLine, setSourceFocusLine] = useState<number | undefined>(undefined);
  const gPrefix = useRef(false);
  const gPrefixTimer = useRef<number | null>(null);
  const language = (settings.uiLanguage || 'en') as UiLanguage;
  const t = (en: string, fa: string) => uiText(language, en, fa);

  useEffect(() => { applyTheme(settings); }, [settings.themeTokens, settings.themeMode]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'fa' ? 'rtl' : 'ltr';
  }, [language]);
  useEffect(() => {
    getStorageBackend().then(info => {
      setStorageReady(info.mode === 'folder' && Boolean(info.configured));
      setStorageDir(info.dir || '');
      setStorageError(info.error ? (language === 'fa' ? 'پوشه داده محلی در دسترس نیست.' : 'The local data folder is unavailable.') : '');
    }).catch(() => setStorageError(language === 'fa' ? 'بررسی فضای ذخیره‌سازی محلی ممکن نشد.' : 'Could not check local storage.'));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent)?.detail;
      const detailText = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : '';
      if (detailText.includes('PARTIAL-STORAGE')) {
        setStorageError(detailText);
        return;
      }
      setStorageError(language === 'fa' ? 'عملیات ذخیره‌سازی محلی ناموفق بود. پوشه داده را بررسی و دوباره تلاش کنید.' : 'A local storage operation failed. Check the configured data folder and try again.');
    };
    window.addEventListener('storage-error', listener);
    return () => window.removeEventListener('storage-error', listener);
  }, [language]);

  const refreshSummaries = useCallback(async () => {
    try { setSummaries(await listExamSummaries()); }
    catch { /* cached summary list is best-effort; palette still opens immediately */ }
  }, []);
  useEffect(() => { void refreshSummaries(); }, [refreshSummaries]);

  // Folder usage/calibration hydrate on mount. Client settings remain in localStorage.
  useEffect(() => {
    let mounted = true;
    hydrateServerStorage().then(hydrated => {
      if (mounted && hydrated) {
        setSettings(loadSettings());
        setUsageRecords(loadUsageLog());
      }
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const handleUpdateSettings = useCallback((newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
    applyTheme(newSettings);
  }, []);

  const chooseFolder = async (dir: string) => {
    try {
      const response = await fetch('/api/storage/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
      if (!response.ok) throw new Error('folder configuration failed');
      const info = await getStorageBackend();
      setStorageReady(info.mode === 'folder' && Boolean(info.configured));
      setStorageDir(info.dir || dir);
      setStorageError('');
      const hydrated = await hydrateServerStorage().catch(() => false);
      if (hydrated) {
        setSettings(loadSettings());
        setUsageRecords(loadUsageLog());
      }
      await refreshSummaries();
    } catch {
      setStorageError(t('The folder could not be configured. Verify the path on the computer running ExamParse.', 'پیکربندی پوشه ممکن نشد. مسیر را در رایانه‌ای که ExamParse اجرا می‌کند بررسی کنید.'));
    }
  };

  const handleDocumentLoaded = (doc: ExtractedDocument, file: File, keyFile?: File | null, fileHash?: string) => {
    setAssistantMode('closed');
    setExamDoc(null);
    setStages([]);
    setExtractedDoc(doc);
    void (async () => {
      const hash = fileHash || await sha256(await file.arrayBuffer());
      const draft = createLocalDraft(doc, hash);
      const existing = await loadExamDoc(draft.id);
      if (!existing) await saveExamDoc(draft);
      setExamDoc(existing || draft);
      await refreshSummaries();
    })().catch((err: any) => {
      console.error('Import draft could not be saved locally:', err);
      setStorageError(`${t('The imported exam could not be saved locally. Check the data folder.', 'ذخیره محلی آزمون واردشده ممکن نشد. پوشه داده را بررسی کنید.')} (${err?.message || err})`);
    });
    setImportedFileHash(fileHash || null);
    setRawFile(file);
    setAnswerKeyFile(keyFile || null);
    setCurrentStep(2);
    setMaxReachedStep(2);
  };

  const handleDemoLoaded = (demo: ExamDoc, persist = true) => {
    setAssistantMode('closed');
    if (persist) void saveExamDoc(demo).then(refreshSummaries).catch((err: any) => {
      console.error('Sample exam could not be saved locally:', err);
      setStorageError(`${t('The sample exam could not be saved locally.', 'ذخیره آزمون نمونه ممکن نشد.')} (${err?.message || err})`);
    });
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
    const dummyBlob = new Blob([demo.source.lines.map(line => line.text).join('\n')], { type: 'text/plain' });
    setRawFile(new File([dummyBlob], demo.source.fileName, { type: 'text/plain' }));
    if (demo.fileHash) {
      void getSourceFile(demo.fileHash, demo.source.fileName).then(stored => {
        if (stored) setRawFile(stored);
      });
    }
    setUsageRecords(demo.usage);
    setCurrentStep(4);
    setMaxReachedStep(5);
  };

  const handleAnalysisComplete = (resultDoc: ExamDoc) => {
    setExamDoc(resultDoc);
    setUsageRecords(loadUsageLog());
    setCurrentStep(4);
    setMaxReachedStep(prev => (prev < 4 ? 4 : prev));
    void refreshSummaries();
  };

  const handleOpenExamFromLibrary = (doc: ExamDoc) => {
    handleDemoLoaded(doc, false);
    setIsLibraryOpen(false);
    setPaletteOpen(false);
  };
  const handleLibraryExamRenamed = (updated: ExamDoc) => {
    setExamDoc(prev => (prev && prev.id === updated.id ? updated : prev));
    void refreshSummaries();
  };
  const handleLibraryExamDeleted = (id: string) => {
    if (examDoc && examDoc.id === id) {
      setExamDoc(null); setExtractedDoc(null); setRawFile(null); setAnswerKeyFile(null); setStages([]); setCurrentStep(1); setMaxReachedStep(1); setAssistantMode('closed');
    }
    void refreshSummaries();
  };
  const handleDocUpdated = (updated: ExamDoc) => {
    // B3 regression memory: fixes to a promoted exam are recorded in its corpus entry's
    // notes (kind/question/before+after hashes) — fire-and-forget, never edits truth.
    void maybeRecordCorpusFixes(examDoc, updated, 'step4-edit');
    setExamDoc(updated);
    setUsageRecords(loadUsageLog());
    void refreshSummaries();
  };
  const handleRevertTextRepair = (lineNo: number) => {
    if (!examDoc?.source.lineRepairs?.[String(lineNo)]) return;
    const reverted = revertTextRepairOverlays(examDoc, [lineNo]);
    handleDocUpdated(reverted);
    void saveExamDoc(reverted);
  };

  const navigateToStep = useCallback((step: StepNumber) => {
    setAssistantMode('closed');
    setCurrentStep(step);
  }, []);
  const navigateToLibrary = useCallback(() => {
    setAssistantMode('closed');
    setIsLibraryOpen(true);
  }, []);

  useEffect(() => {
    if (!exportQueued || currentStep !== 5) return;
    setExportRequest(value => value + 1);
    setExportQueued(false);
  }, [exportQueued, currentStep]);

  const handleOpenSettings = useCallback((tab: string = 'providers') => {
    setSettingsTab(tab as typeof settingsTab);
    setIsSettingsOpen(true);
  }, []);
  const handleOpenAssistant = useCallback((verify = false) => {
    if (!examDoc) return;
    setVerifyOnOpen(verify);
    setAssistantMode(verify ? 'panel' : 'page');
  }, [examDoc]);
  const handleToggleTheme = useCallback(() => {
    const systemDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
    handleUpdateSettings({ ...settings, themeMode: nextThemeMode(settings.themeMode, systemDark) });
  }, [settings, handleUpdateSettings]);

  const canRetry = (() => {
    try { return Boolean(examDoc && getExamHealth(examDoc).missing.length > 0); }
    catch { return false; }
  })();
  const contextTitle = assistantMode === 'page' ? t('Assistant', 'دستیار') : t((['Import', 'Source', 'Analyze', 'Review', 'Exam'] as const)[currentStep - 1], (['ورود', 'منبع', 'تحلیل', 'بازبینی', 'آزمون'] as const)[currentStep - 1]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const modalOpen = Boolean(document.querySelector('.ep-modal-window[aria-modal="true"]'));
      if (modalOpen && !paletteOpen) {
        gPrefix.current = false;
        if (gPrefixTimer.current) window.clearTimeout(gPrefixTimer.current);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setPaletteOpen(true); return;
      }
      if (isEditable(event.target) || event.metaKey || event.ctrlKey || event.altKey || paletteOpen || shortcutsOpen || isSettingsOpen || isExplainerOpen || isLibraryOpen) return;
      if (event.key === '?') { event.preventDefault(); setShortcutsOpen(true); return; }
      if (currentStep === 4 && ['j', 'k'].includes(event.key.toLowerCase())) {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-review-question]'));
        if (cards.length) {
          const activeCard = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-review-question]');
          const currentIndex = activeCard ? cards.indexOf(activeCard) : -1;
          const delta = event.key.toLowerCase() === 'j' ? 1 : -1;
          const nextIndex = currentIndex < 0 ? (delta > 0 ? 0 : cards.length - 1) : (currentIndex + delta + cards.length) % cards.length;
          event.preventDefault();
          cards[nextIndex]?.focus();
          return;
        }
      }
      if (gPrefix.current) {
        gPrefix.current = false;
        if (gPrefixTimer.current) window.clearTimeout(gPrefixTimer.current);
        const key = event.key.toLowerCase();
        if (key === 'l') navigateToLibrary();
        else if (key === 'i') navigateToStep(1);
        else if (key === 'a') handleOpenAssistant(false);
        else if (key === 's') handleOpenSettings('providers');
        return;
      }
      if (event.key.toLowerCase() === 'g') {
        gPrefix.current = true;
        gPrefixTimer.current = window.setTimeout(() => { gPrefix.current = false; }, 900);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [paletteOpen, shortcutsOpen, isSettingsOpen, isExplainerOpen, isLibraryOpen, currentStep, handleOpenAssistant, handleOpenSettings, navigateToLibrary, navigateToStep]);

  useEffect(() => {
    if (assistantMode === 'panel') return;
    const frame = window.requestAnimationFrame(() => document.getElementById('view-context-heading')?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [currentStep, assistantMode]);

  // The styleguide is intentionally route-addressable but never linked from production navigation.
  if (window.location.pathname === '/styleguide') return <StyleGuideView language={language} />;

  if (!storageReady) return <main className="max-w-xl mx-auto my-12 w-full p-6 border border-[var(--rule)] rounded-[var(--radius-card)] bg-[var(--paper-raised)] space-y-5">
    <p className="ep-eyebrow m-0">EXAMPARSE · LOCAL STORAGE</p>
    <h1 className="ep-display m-0 text-[length:var(--type-26)]">{t('Choose a local data folder', 'یک پوشه داده محلی انتخاب کنید')}</h1>
    <p className="ep-muted">{t('ExamParse stores exams and source files in a folder on the computer running the server. Browser storage is never used as a fallback.', 'ExamParse آزمون‌ها و فایل‌های منبع را در پوشه‌ای روی رایانهٔ میزبان ذخیره می‌کند. از فضای مرورگر به‌عنوان جایگزین استفاده نمی‌شود.')}</p>
    <label className="block text-[length:var(--type-12)]">{t('Folder path', 'مسیر پوشه')}<input className="ep-input mt-1 ep-mono" value={folderPath} onChange={event => setFolderPath(event.target.value)} /></label>
    <div className="flex flex-wrap gap-2"><Button variant="primary" onClick={() => void chooseFolder(folderPath)}>{t('Use this folder', 'استفاده از این پوشه')}</Button><Button variant="ghost" onClick={() => void chooseFolder('./examparse-data')}>{t('Use default', 'استفاده از پیش‌فرض')}</Button></div>
    {storageError && <p className="text-[var(--danger)]" role="status">{storageError}</p>}
  </main>;

  return <div className="ep-app-shell" data-app-shell="paperwork">
    <a href="#main-content" className="ep-skip-link">{t('Skip to content', 'پرش به محتوا')}</a>
    {assistantMode !== 'page' && <Stepper
      currentStep={currentStep}
      maxReachedStep={maxReachedStep}
      onSelectStep={navigateToStep}
      language={language}
      storageLabel={storageDir.split(/[\\/]/).filter(Boolean).at(-1) || t('Local', 'محلی')}
      engineLabel={isAnalyzing ? t('running', 'در حال اجرا') : t('ready', 'آماده')}
      onOpenLibrary={navigateToLibrary}
      onOpenAssistant={() => handleOpenAssistant(false)}
      hasExam={Boolean(examDoc)}
      onOpenSettings={handleOpenSettings}
    />}
    <div className="ep-app-main">
      <Header
        activeDoc={examDoc}
        usageRecords={usageRecords}
        onOpenSettings={() => handleOpenSettings('providers')}
        onOpenExplainer={() => setIsExplainerOpen(true)}
        onLoadDemo={async () => { const demo = await createDemoExamDoc(); handleDemoLoaded(demo); }}
        onOpenLibrary={navigateToLibrary}
        onOpenPalette={() => setPaletteOpen(true)}
        onShortcutHelp={() => setShortcutsOpen(true)}
        onToggleTheme={handleToggleTheme}
        themeMode={settings.themeMode || 'system'}
        language={language}
        contextTitle={contextTitle}
      />
      {storageError && <p className="mx-4 my-2 border-s-2 border-[var(--danger)] px-3 py-2 text-[length:var(--type-12)] text-[var(--danger)]" role="status">{storageError}</p>}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 print:hidden">
        <Button size="sm" variant="ghost" aria-pressed={assistantMode === 'page'} disabled={!examDoc} onClick={() => handleOpenAssistant(false)}>{t('Assistant', 'دستیار')}</Button>
        {examDoc && currentStep >= 4 && assistantMode !== 'page' && <Button size="sm" variant="ghost" onClick={() => handleOpenAssistant(true)}>{t('Check this exam', 'بررسی این آزمون')}</Button>}
      </div>
      {assistantMode !== 'closed' && examDoc && <AssistantView mode={assistantMode} verifyOnOpen={verifyOnOpen} key={examDoc.id} doc={examDoc} settings={settings} onUpdateDoc={updated => { void maybeRecordCorpusFixes(examDoc, updated, 'assistant-fix'); setExamDoc(current => current?.id === updated.id ? updated : current); setUsageRecords(loadUsageLog()); }} onSettings={handleUpdateSettings} onClose={() => setAssistantMode('closed')} />}
      {assistantMode !== 'page' && <React.Fragment>
        {examDoc && currentStep === 4 && <div className="ep-main-content print:hidden"><ExamVersions doc={examDoc} onRestore={handleDocUpdated} /></div>}
        {currentStep === 2 && examDoc && <div className="ep-main-content"><ExamHealthBanner doc={examDoc} /></div>}
        <main id="main-content" tabIndex={-1} className="ep-main-content flex-1 pb-16">
          {currentStep === 1 && <Step1Import onDocumentLoaded={handleDocumentLoaded} onDemoLoaded={handleDemoLoaded} isLoading={false} cacheEnabled={settings.thrift.cacheEnabled} onOpenSavedExam={handleOpenExamFromLibrary} />}
          {currentStep === 2 && extractedDoc && <Step2Source diagnostics={extractedDoc.diagnostics} lines={extractedDoc.lines} pages={extractedDoc.pages} ocrUsed={extractedDoc.ocrUsed} pageImages={extractedDoc.pageImages} pageThumbKeys={extractedDoc.pageThumbKeys} images={extractedDoc.images} fileHash={importedFileHash || undefined} taggedLines={examDoc && importedFileHash && examDoc.fileHash === importedFileHash ? examDoc.source.lines : undefined} lineRepairs={examDoc && importedFileHash && examDoc.fileHash === importedFileHash ? examDoc.source.lineRepairs : undefined} onRevertLineRepair={handleRevertTextRepair} focusLine={sourceFocusLine} orphanLineNos={examDoc && importedFileHash && examDoc.fileHash === importedFileHash ? examDoc.source.orphanLineNos : undefined} onProceedToAnalyze={() => { setSourceFocusLine(undefined); setCurrentStep(3); setMaxReachedStep(prev => Math.max(prev, 3) as StepNumber); }} />}
          {currentStep === 3 && extractedDoc && <Step3Analyze extractedDoc={extractedDoc} rawFile={rawFile} answerKeyFile={answerKeyFile} settings={settings} stages={stages} onStagesUpdate={setStages} onAnalysisComplete={handleAnalysisComplete} isAnalyzing={isAnalyzing} setIsAnalyzing={setIsAnalyzing} fileHash={importedFileHash || undefined} onOpenSavedExam={handleOpenExamFromLibrary} onSettingsUpdate={handleUpdateSettings} />}
          {currentStep === 4 && examDoc && <Step4Review key={examDoc.id} examDoc={examDoc} rawFile={rawFile} settings={settings} onUpdateDoc={handleDocUpdated} onProceedToExamView={() => { setCurrentStep(5); setMaxReachedStep(5); }} retryRequest={retryRequest} onRetryRequestHandled={() => setRetryRequest(0)} onJumpToSource={extractedDoc && importedFileHash && examDoc.fileHash === importedFileHash ? (lineNo) => { setSourceFocusLine(lineNo); navigateToStep(2); } : undefined} />}
          {currentStep === 5 && examDoc && <Step5Exam defaultExamMode={settings.defaultExamMode} doc={examDoc} onUpdateDoc={handleDocUpdated} exportRequest={exportRequest} />}
        </main>
      </React.Fragment>}

      <LibraryView
        isOpen={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
        activeExamId={examDoc?.id}
        onOpenExam={handleOpenExamFromLibrary}
        onExamRenamed={handleLibraryExamRenamed}
        onExamDeleted={handleLibraryExamDeleted}
        onGoToImport={() => { setIsLibraryOpen(false); navigateToStep(1); }}
      />
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} settings={settings} onSaveSettings={handleUpdateSettings} onOpenExplainer={() => { setIsSettingsOpen(false); setIsExplainerOpen(true); }} initialTab={settingsTab} />
      <CostExplainerModal isOpen={isExplainerOpen} onClose={() => setIsExplainerOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        summaries={summaries}
        language={language}
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        onNavigateStep={navigateToStep}
        onOpenExam={async summary => {
          const doc = await loadExamDoc(summary.id);
          if (doc) handleOpenExamFromLibrary(doc);
          else setStorageError(t('That exam is no longer available. Refresh the library and try again.', 'این آزمون دیگر در دسترس نیست. کتابخانه را تازه‌سازی و دوباره تلاش کنید.'));
        }}
        onOpenLibrary={navigateToLibrary}
        onActionError={() => setStorageError(t('That command could not be completed. Please try again.', 'اجرای این فرمان ممکن نشد. لطفاً دوباره تلاش کنید.'))}
        onAskAssistant={handleOpenAssistant}
        onOpenSettings={handleOpenSettings}
        onRetry={() => { navigateToStep(4); setRetryRequest(value => value + 1); }}
        onExport={() => { navigateToStep(5); setExportQueued(true); }}
        onToggleTheme={handleToggleTheme}
        hasExam={Boolean(examDoc)}
        canRetry={canRetry}
      />
      <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title={t('Keyboard shortcuts', 'میانبرهای صفحه‌کلید')}>
        <div className="p-5">
          <h2 className="ep-display m-0 text-[length:var(--type-20)]">{t('Keyboard shortcuts', 'میانبرهای صفحه‌کلید')}</h2>
          <div className="ep-ledger mt-4">
            {[[t('Open command palette', 'باز کردن فرمان‌ها'), '⌘K / Ctrl K'], [t('Library', 'کتابخانه'), 'g then l'], [t('Import', 'ورود'), 'g then i'], [t('Assistant', 'دستیار'), 'g then a'], [t('Settings', 'تنظیمات'), 'g then s'], [t('Review queue', 'صف بازبینی'), 'j / k'], [t('Close dialogs', 'بستن پنجره‌ها'), 'Esc'], [t('Show shortcuts', 'نمایش میانبرها'), '?']].map(([label, keys]) => <div key={label} className="ep-ledger-row"><span>{label}</span><Kbd>{keys}</Kbd></div>)}
          </div>
          <div className="mt-4 flex justify-end"><Button variant="primary" onClick={() => setShortcutsOpen(false)}>{t('Done', 'انجام شد')}</Button></div>
        </div>
      </Modal>
    </div>
  </div>;
}
