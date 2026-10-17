/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { Stepper, StepNumber } from './components/Stepper';
import { SettingsModal } from './components/SettingsModal';
import { CostExplainerModal } from './components/CostExplainerModal';
import { Step1Import } from './views/Step1Import';
import { Step2Source } from './views/Step2Source';
import { Step3Analyze } from './views/Step3Analyze';
import { Step4Review } from './views/Step4Review';
import { Step5Exam } from './views/Step5Exam';
import { AppSettings, ExamDoc, StageStatus, UsageRecord } from './types';
import { loadSettings, saveSettings, loadUsageLog, saveExamDoc } from './store';
import { ExtractedDocument } from './pipeline/extract';
import { createDemoExamDoc } from './pipeline/demoData';

export default function App() {
  const [currentStep, setCurrentStep] = useState<StepNumber>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<StepNumber>(1);

  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>(loadUsageLog);

  const [extractedDoc, setExtractedDoc] = useState<ExtractedDocument | null>(null);
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [examDoc, setExamDoc] = useState<ExamDoc | null>(null);

  const [stages, setStages] = useState<StageStatus[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isExplainerOpen, setIsExplainerOpen] = useState(false);

  // Esc closes open modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSettingsOpen(false);
        setIsExplainerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleUpdateSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  const handleDocumentLoaded = (doc: ExtractedDocument, file: File) => {
    setExtractedDoc(doc);
    setRawFile(file);
    setCurrentStep(2);
    setMaxReachedStep(prev => (prev < 2 ? 2 : prev));
  };

  const handleDemoLoaded = (demo: ExamDoc) => {
    setExamDoc(demo);
    setExtractedDoc({
      lines: demo.source.lines,
      pages: demo.source.pages,
      ocrUsed: demo.source.ocrUsed,
      fileName: demo.source.fileName,
      images: demo.images,
      scannedPageIndices: [],
      pageImages: demo.source.pageImages || [],
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

  const handleDocUpdated = (updated: ExamDoc) => {
    setExamDoc(updated);
    setUsageRecords(loadUsageLog());
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 antialiased selection:bg-blue-500 selection:text-white">
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
      />

      {/* Guided 5-Step Stepper Navigation */}
      <Stepper
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        onSelectStep={step => setCurrentStep(step)}
      />

      {/* Step View Content */}
      <main className="flex-1 pb-16">
        {currentStep === 1 && (
          <Step1Import
            onDocumentLoaded={handleDocumentLoaded}
            onDemoLoaded={handleDemoLoaded}
            isLoading={false}
          />
        )}

        {currentStep === 2 && extractedDoc && (
          <Step2Source
            lines={extractedDoc.lines}
            pages={extractedDoc.pages}
            ocrUsed={extractedDoc.ocrUsed}
            pageImages={extractedDoc.pageImages}
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
            settings={settings}
            stages={stages}
            onStagesUpdate={setStages}
            onAnalysisComplete={handleAnalysisComplete}
            isAnalyzing={isAnalyzing}
            setIsAnalyzing={setIsAnalyzing}
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
          <Step5Exam doc={examDoc} onUpdateDoc={handleDocUpdated} />
        )}
      </main>

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
