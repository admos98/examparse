import React, { useState, useEffect } from 'react';
import {
  Play,
  RotateCcw,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Layers,
  ArrowRight,
  Database,
  Coins,
  ShieldAlert,
} from 'lucide-react';
import { AppSettings, ExamDoc, StageStatus } from '../types';
import { calculatePreflightEstimate } from '../utils/budget';
import { ExtractedDocument } from '../pipeline/extract';
import { runFullPipeline } from '../pipeline';

interface Props {
  extractedDoc: ExtractedDocument;
  rawFile: File | null;
  answerKeyFile?: File | null;
  settings: AppSettings;
  stages: StageStatus[];
  onStagesUpdate: React.Dispatch<React.SetStateAction<StageStatus[]>>;
  onAnalysisComplete: (examDoc: ExamDoc) => void;
  isAnalyzing: boolean;
  setIsAnalyzing: (val: boolean) => void;
}

export const Step3Analyze: React.FC<Props> = ({
  extractedDoc,
  rawFile,
  answerKeyFile,
  settings,
  stages,
  onStagesUpdate,
  onAnalysisComplete,
  isAnalyzing,
  setIsAnalyzing,
}) => {
  const [forceRerun, setForceRerun] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPreflightCached, setIsPreflightCached] = useState<boolean>(false);
  const [cachedStages, setCachedStages] = useState<{
    structure: boolean;
    vision: boolean;
    ocr: boolean;
    repair: boolean;
  }>({ structure: false, vision: false, ocr: false, repair: true });

  // Selected role model for structure pass
  const activeRole = settings.roleMapping.fast;
  const activeProvider =
    settings.providers.find(p => p.id === activeRole.providerId) || settings.providers[0];

  // Check if pipeline stages are already cached in IndexedDB
  useEffect(() => {
    let isMounted = true;
    async function checkAllCaches() {
      if (!rawFile) return;
      try {
        const { sha256 } = await import('../utils/hash');
        const { getCachedStageResult } = await import('../pipeline/cache');
        const { assembleAndValidateQuestions } = await import('../pipeline/assemble');
        const buf = await rawFile.arrayBuffer();
        const hash = await sha256(buf);

        // 1. Structure stage
        const cachedStruct = await getCachedStageResult<any>({
          fileHash: hash,
          stage: 'structure',
          provider: activeProvider.id,
          model: activeRole.model,
          options: { latex: settings.thrift.latexNormalization },
        });

        // 2. Vision stage
        let visionCached = true;
        if (extractedDoc.images.length > 0) {
          const vRole = settings.roleMapping.vision;
          const vProv = settings.providers.find(p => p.id === vRole.providerId) || settings.providers[0];
          const cachedV = await getCachedStageResult({
            fileHash: hash,
            stage: 'vision',
            provider: vProv.id,
            model: vRole.model,
            options: { imgCount: extractedDoc.images.length },
          });
          visionCached = Boolean(cachedV);
        }

        // 3. OCR stage
        let ocrCached = true;
        if (extractedDoc.scannedPageIndices.length > 0) {
          const oRole = settings.roleMapping.vision;
          const oProv = settings.providers.find(p => p.id === oRole.providerId) || settings.providers[0];
          const cachedO = await getCachedStageResult({
            fileHash: hash,
            stage: 'ocr',
            provider: oProv.id,
            model: oRole.model,
            options: extractedDoc.scannedPageIndices,
          });
          ocrCached = Boolean(cachedO);
        }

        // 4. Repair stage
        let repairCached = true;
        if (cachedStruct && Array.isArray(cachedStruct.rawQuestions)) {
          const assembled = assembleAndValidateQuestions(cachedStruct.rawQuestions, extractedDoc.lines);
          if (assembled.failingQuestions.length > 0) {
            const rRole = settings.roleMapping.escalation;
            const rProv = settings.providers.find(p => p.id === rRole.providerId) || settings.providers[0];
            const rOpts = {
              failing: assembled.failingQuestions.map(f => ({
                id: f.question.id,
                errors: [...f.errors].sort(),
              })),
            };
            const cachedR = await getCachedStageResult({
              fileHash: hash,
              stage: 'repair',
              provider: rProv.id,
              model: rRole.model,
              options: rOpts,
            });
            repairCached = Boolean(cachedR);
          }
        }

        if (isMounted) {
          const status = {
            structure: Boolean(cachedStruct),
            vision: visionCached,
            ocr: ocrCached,
            repair: repairCached,
          };
          setCachedStages(status);
          const allCached = status.structure && status.vision && status.ocr && status.repair;
          setIsPreflightCached(allCached);
        }
      } catch {
        if (isMounted) setIsPreflightCached(false);
      }
    }
    checkAllCaches();
    return () => {
      isMounted = false;
    };
  }, [
    rawFile,
    activeProvider.id,
    activeRole.model,
    settings.thrift.latexNormalization,
    extractedDoc.images.length,
    extractedDoc.scannedPageIndices.length,
  ]);

  const isFullyCached =
    isPreflightCached &&
    cachedStages.structure &&
    (extractedDoc.images.length === 0 || cachedStages.vision) &&
    (extractedDoc.scannedPageIndices.length === 0 || cachedStages.ocr) &&
    cachedStages.repair;

  // Calculate pre-flight token & cost estimate for uncached stages only (§5.7)
  const fullText = extractedDoc.lines.map(l => l.text).join('\n');
  const estimate = isFullyCached && !forceRerun
    ? {
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        breakdown: { textTokens: 0, imageTokens: 0, visionCalls: 0, structureTokens: 0 },
        exceedsBudget: false,
        warning50Percent: false,
      }
    : calculatePreflightEstimate({
        text: cachedStages.structure && !forceRerun ? '' : fullText,
        isRtl: settings.document.defaultLanguage === 'rtl',
        images: cachedStages.vision && !forceRerun ? [] : extractedDoc.images,
        scannedPagesCount: cachedStages.ocr && !forceRerun ? 0 : extractedDoc.scannedPageIndices.length,
        isGemini: activeProvider.kind === 'gemini',
        model: activeRole.model,
        costTable: settings.costTable,
        maxUsdPerRun: settings.budget.maxUsdPerRun,
      });

  const handleStartAnalysis = async () => {
    if (!rawFile) {
      setErrorMsg('No raw file loaded. Please return to Step 1 to upload or load demo.');
      return;
    }

    // Never budget-block a fully cached run
    if (!isFullyCached && !forceRerun && estimate.exceedsBudget) {
      setErrorMsg(
        `Pre-flight cost ($${estimate.estimatedCostUsd.toFixed(4)}) exceeds your configured budget cap ($${settings.budget.maxUsdPerRun}). Analysis halted.`
      );
      return;
    }

    setErrorMsg(null);
    setIsAnalyzing(true);

    // Initial stage statuses
    const initialStages: StageStatus[] = [
      { id: 'extract', name: 'Local Text & Image Extraction', status: 'completed', message: '0 API calls (done)' },
      { id: 'ocr', name: 'Scanned Pages OCR', status: extractedDoc.scannedPageIndices.length > 0 ? 'idle' : 'skipped', message: 'Batched <= 3 pages' },
      { id: 'structure', name: 'Structure Pass (Span References)', status: 'idle', message: '1 text call' },
      { id: 'vision', name: 'Batched Vision Labeling', status: extractedDoc.images.length > 0 ? 'idle' : 'skipped', message: '1 batched call' },
      { id: 'assemble', name: 'Assemble & Validate', status: 'idle', message: 'Local assembly' },
      { id: 'repair', name: 'Escalation Repair', status: 'idle', message: 'Failing items only' },
    ];
    onStagesUpdate(initialStages);

    try {
      const resultDoc = await runFullPipeline(
        rawFile,
        settings,
        {
          onStageUpdate: updated => {
            onStagesUpdate(prev =>
              prev.map(s => (s.id === updated.id ? { ...s, ...updated } : s))
            );
          },
        },
        { forceRerun, answerKeyFile }
      );

      setIsAnalyzing(false);
      onAnalysisComplete(resultDoc);
    } catch (err: any) {
      setIsAnalyzing(false);
      setErrorMsg(`Analysis failed: ${err.message || err}`);
    }
  };

  // Keyboard shortcut: ⌘/Ctrl+Enter run
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isAnalyzing) {
        handleStartAnalysis();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAnalyzing, rawFile, estimate]);

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      {/* Step Header */}
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Analyze Exam Structure
        </h1>
        <p className="text-xs text-slate-500">
          Deterministic 1-call structure pass, batched vision, and span-referenced assembly
        </p>
      </div>

      {/* Error / Budget Stop Banner */}
      {errorMsg && (
        <div className="p-4 rounded-2xl border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 flex items-start gap-3 text-xs animate-in fade-in">
          <ShieldAlert className="w-5 h-5 shrink-0 text-red-500 mt-0.5" />
          <div className="flex-1 space-y-1">
            <span className="font-bold">Budget / Execution Stop:</span>
            <p>{errorMsg}</p>
          </div>
        </div>
      )}

      {/* Pre-Flight Estimator Panel (§5.7) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-xs space-y-5">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Coins className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Pre-Flight Usage & Cost Estimate
              </h2>
              <p className="text-[11px] text-slate-500">
                Calculated before any network call using self-calibrating token metrics
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400 font-mono">
              Provider: {activeProvider.name} ({activeRole.model})
            </span>
          </div>
        </div>

        {/* Metric Cards Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-slate-400">Est. Input</div>
            <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
              {isPreflightCached && !forceRerun ? '0 toks' : `~${(estimate.estimatedInputTokens / 1000).toFixed(1)}k`}
            </div>
            <div className="text-[10px] text-slate-400">
              {isPreflightCached && !forceRerun ? 'Cache hit' : `${estimate.breakdown.textTokens} text + ${estimate.breakdown.imageTokens} img`}
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-slate-400">Est. Output</div>
            <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
              {isPreflightCached && !forceRerun ? '0 toks' : `~${estimate.estimatedOutputTokens}`}
            </div>
            <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
              {isPreflightCached && !forceRerun ? 'From local store' : '~85% saved by spans'}
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-slate-400">Est. Cost</div>
            <div className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400">
              {isPreflightCached && !forceRerun ? '$0.00' : `$${estimate.estimatedCostUsd.toFixed(4)}`}
            </div>
            <div className="text-[10px] text-slate-400">
              {isPreflightCached && !forceRerun ? '0 calls · $0.00' : `Cap: $${settings.budget.maxUsdPerRun}`}
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-slate-400">API Calls</div>
            <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
              {isPreflightCached && !forceRerun ? '0 calls' : `1 text + ${estimate.breakdown.visionCalls} vision`}
            </div>
            <div className="text-[10px] text-purple-600 dark:text-purple-400 font-medium">
              {isPreflightCached && !forceRerun ? 'Cached result' : 'Target: ≤ 3 calls total'}
            </div>
          </div>
        </div>

        {/* Cache status banner if hit */}
        {isPreflightCached && !forceRerun && (
          <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-700 dark:text-purple-300 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 shrink-0 text-purple-500" />
              <span className="font-semibold">0 calls · $0.00 · cached</span>
              <span>— Document already analyzed with identical settings.</span>
            </div>
            <span className="text-[10px] font-mono bg-purple-500/20 px-2 py-0.5 rounded text-purple-800 dark:text-purple-200">
              Instant Load
            </span>
          </div>
        )}

        {/* Warning if 50% budget */}
        {estimate.warning50Percent && !estimate.exceedsBudget && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
            <span>Pre-flight estimate exceeds 50% of your configured budget. Proceed with caution.</span>
          </div>
        )}

        {/* Controls Bar: Force Re-run toggle & Run Button */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={forceRerun}
              onChange={e => setForceRerun(e.target.checked)}
              className="w-4 h-4 rounded text-blue-600"
            />
            <span>Force re-run (bypass content-hash cache)</span>
          </label>

          <button
            disabled={isAnalyzing || estimate.exceedsBudget}
            onClick={handleStartAnalysis}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-2xl font-semibold text-xs text-white transition cursor-pointer shadow-md ${
              isAnalyzing || estimate.exceedsBudget
                ? 'bg-slate-400 cursor-not-allowed'
                : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-blue-500/20'
            }`}
          >
            {isAnalyzing ? (
              <>
                <RotateCcw className="w-4 h-4 animate-spin" />
                <span>Running Pipeline...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-white" />
                <span>Run Analysis</span>
                <span className="text-[10px] opacity-75 font-mono ml-1">⌘↵</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Pipeline Stage Execution Card (§6) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-xs space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 font-bold text-xs text-slate-900 dark:text-white">
            <Layers className="w-4 h-4 text-blue-500" />
            <span>Pipeline Execution Stages</span>
          </div>
          <span className="text-[10px] text-slate-400">Order: Extract → OCR → Structure → Vision → Assemble → Repair</span>
        </div>

        <div className="space-y-2">
          {stages.map((stage, idx) => {
            const isCompleted = stage.status === 'completed';
            const isRunning = stage.status === 'running';
            const isCached = stage.status === 'cached';
            const isSkipped = stage.status === 'skipped';
            const isFailed = stage.status === 'failed';

            return (
              <div
                key={stage.id}
                className={`flex items-center justify-between p-3 rounded-2xl border transition text-xs ${
                  isRunning
                    ? 'border-blue-500 bg-blue-50/40 dark:bg-blue-950/20 shadow-xs'
                    : isCompleted
                    ? 'border-emerald-500/30 bg-emerald-50/20 dark:bg-emerald-950/10'
                    : isCached
                    ? 'border-purple-500/30 bg-purple-50/20 dark:bg-purple-950/10'
                    : isSkipped
                    ? 'border-slate-200 dark:border-slate-800/60 opacity-60'
                    : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-[10px] ${
                      isCompleted
                        ? 'bg-emerald-500 text-white'
                        : isCached
                        ? 'bg-purple-600 text-white'
                        : isRunning
                        ? 'bg-blue-600 text-white animate-pulse'
                        : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                    }`}
                  >
                    {isCompleted ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : isCached ? (
                      <Database className="w-3.5 h-3.5" />
                    ) : isRunning ? (
                      <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      idx + 1
                    )}
                  </div>

                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                      <span>{stage.name}</span>
                      {isCached && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                          0 calls · cached
                        </span>
                      )}
                    </div>
                    {stage.message && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {stage.message}
                      </p>
                    )}
                  </div>
                </div>

                {/* Stage Metrics */}
                <div className="flex items-center gap-3 text-right font-mono text-[11px]">
                  {stage.inputTokens !== undefined && (
                    <span className="text-slate-600 dark:text-slate-400">
                      {stage.inputTokens + (stage.outputTokens || 0)} toks
                    </span>
                  )}
                  {stage.costUsd !== undefined && (
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                      ${stage.costUsd.toFixed(5)}
                    </span>
                  )}
                  {stage.durationMs !== undefined && (
                    <span className="text-slate-400 flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      {(stage.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
