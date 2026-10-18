import React, { useState, useEffect, useRef } from 'react';
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
import { detectLanguageAndDirection } from '../utils/numbers';
import { ExtractedDocument } from '../pipeline/extract';
import { runFullPipeline } from '../pipeline';
import { loadJournal } from '../pipeline/journal';
import { getPipelineCache } from '../store';
import { PARSER_VERSION } from '../pipeline/prompts';

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
  fileHash?: string;
  onOpenSavedExam?: (examDoc: ExamDoc) => void;
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
  fileHash: fileHashProp,
  onOpenSavedExam,
}) => {
  const [forceRerun, setForceRerun] = useState(false);
  const [live, setLive] = useState({ stage: '', label: '', output: '', reasoning: '', info: '', attempts: [] as Array<{ stage: string; label: string; output: string; reasoning: string; ts?: string; finishReason?: string }> });
  const liveRef = useRef(live);
  const [liveOpen, setLiveOpen] = useState(true);
  const [attemptStage, setAttemptStage] = useState<string | null>(null);
  const liveScroll = useRef<HTMLDivElement>(null);
  const liveUserScrolledUp = useRef(false);
  useEffect(() => { const id = window.setInterval(() => setLive({ ...liveRef.current }), 200); return () => clearInterval(id); }, []);
  useEffect(() => { if (isAnalyzing && liveOpen && liveScroll.current && !liveUserScrolledUp.current) liveScroll.current.scrollTop = liveScroll.current.scrollHeight; }, [live, isAnalyzing, liveOpen]);
  const [forcedStages, setForcedStages] = useState<Set<string>>(new Set());
  const [savedExam, setSavedExam] = useState<ExamDoc | null>(null);
  const [probeFileHash, setProbeFileHash] = useState<string | null>(null);
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

  useEffect(() => {
    if (!probeFileHash) return;
    let active = true;
    (async () => {
      try {
        const { sha256 } = await import('../utils/hash');
        let journalKey = await getPipelineCache<string>(`journalkey:${probeFileHash}`);
        if (journalKey == null) {
          const linesHash = await sha256(JSON.stringify(extractedDoc.lines));
          journalKey = await sha256(`${probeFileHash}:${linesHash}:${activeProvider.id}:${activeRole.model}:${PARSER_VERSION}`);
        }
        const journal = await loadJournal(journalKey);
        if (!active || !journal) return;
        const calls = [...journal.calls].reverse().map(call => ({ stage: 'structure', label: call.label, output: call.rawText || '', reasoning: call.reasoningText || '', ts: call.ts, finishReason: call.finishReason }));
        liveRef.current = { ...liveRef.current, attempts: calls };
        setLive({ ...liveRef.current });
      } catch { /* journal history is best-effort */ }
    })();
    return () => { active = false; };
  }, [probeFileHash, extractedDoc.lines, activeProvider.id, activeRole.model]);

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
        const hash = fileHashProp || (await sha256(buf));
        if (isMounted) setProbeFileHash(hash);

        // Saved-exam fast-path (B6)
        try {
          const { loadExamDoc } = await import('../store');
          const saved = await loadExamDoc(`exam_${hash.slice(0, 12)}`);
          if (isMounted) setSavedExam(saved?.questions?.length ? saved : null);
        } catch {
          if (isMounted) setSavedExam(null);
        }

        // 3. OCR stage probe FIRST: the pipeline's real structure/vision keys
        // depend on the OCR-merged lines when an OCR cache entry exists.
        let ocrCached = true;
        let effectiveLines = extractedDoc.lines;
        if (extractedDoc.scannedPageIndices.length > 0) {
          const oRole = settings.roleMapping.vision;
          const oProv = settings.providers.find(p => p.id === oRole.providerId) || settings.providers[0];
          const cachedO: any = await getCachedStageResult({
            fileHash: hash,
            stage: 'ocr',
            provider: oProv.id,
            model: oRole.model,
            options: extractedDoc.scannedPageIndices,
          });
          ocrCached = Boolean(cachedO);
          if (cachedO && (cachedO.mergedLines || cachedO.lines)) {
            effectiveLines = cachedO.mergedLines || cachedO.lines;
          }
        }

        const linesHash = (await sha256(effectiveLines.map((l: any) => l.id + ' ' + l.text).join('\n'))).slice(0, 16);
        const imgShas = [...new Set(extractedDoc.images.map((i: any) => i.sha).filter(Boolean))].sort();

        // 1. Structure stage (dependency-correct key)
        const cachedStruct = await getCachedStageResult<any>({
          fileHash: hash,
          stage: 'structure',
          provider: activeProvider.id,
          model: activeRole.model,
          options: { latex: settings.thrift.latexNormalization, linesHash },
        });

        // 2. Vision stage (dependency-correct key)
        let visionCached = true;
        if (extractedDoc.images.length > 0) {
          const vRole = settings.roleMapping.vision;
          const vProv = settings.providers.find(p => p.id === vRole.providerId) || settings.providers[0];
          const cachedV = await getCachedStageResult({
            fileHash: hash,
            stage: 'vision',
            provider: vProv.id,
            model: vRole.model,
            options: { linesHash, imgShas },
          });
          visionCached = Boolean(cachedV);
        }

        // 4. Repair stage: assemble against the OCR cache's mergedLines when present.
        let repairCached = true;
        if (cachedStruct && Array.isArray(cachedStruct.rawQuestions)) {
          const assembled = assembleAndValidateQuestions(cachedStruct.rawQuestions, effectiveLines);
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
    extractedDoc.lines,
    fileHashProp,
    settings.roleMapping.vision.providerId,
    settings.roleMapping.vision.model,
    settings.roleMapping.escalation.providerId,
    settings.roleMapping.escalation.model,
  ]);

  const isFullyCached =
    isPreflightCached &&
    cachedStages.structure &&
    (extractedDoc.images.length === 0 || cachedStages.vision) &&
    (extractedDoc.scannedPageIndices.length === 0 || cachedStages.ocr) &&
    cachedStages.repair;

  // Calculate pre-flight token & cost estimate for uncached stages only (§5.7)
  // Detect RTL from extracted text rather than relying solely on settings
  const fullText = extractedDoc.lines.map(l => l.text).join('\n');
  const detectedDir = detectLanguageAndDirection(extractedDoc.lines.slice(0, 40).map(l => l.text).join(' '));
  const isRtl = settings.document.defaultLanguage === 'rtl' || (settings.document.defaultLanguage === 'auto' && detectedDir.direction === 'rtl');

  // Resolve per-stage models for pricing each stage at its own role model
  const resolveModel = (role: 'fast' | 'vision' | 'escalation') => {
    const sel = settings.roleMapping[role];
    const prov = settings.providers.find(p => p.id === sel.providerId) || settings.providers[0];
    return sel.model;
  };

  const stageModels = {
    structureModel: resolveModel('fast'),
    ocrModel: resolveModel('vision'),
    visionModel: resolveModel('vision'),
    repairModel: resolveModel('escalation'),
  };

  // Applicable estimate: full estimate when forceRerun, else uncached-stages estimate
  const estimate = isFullyCached && !forceRerun
    ? {
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        breakdown: { textTokens: 0, imageTokens: 0, visionCalls: 0, ocrCalls: 0 },
        exceedsBudget: false,
        warning50Percent: false,
      }
    : calculatePreflightEstimate({
        text: cachedStages.structure && !forceRerun ? '' : fullText,
        isRtl,
        images: cachedStages.vision && !forceRerun ? [] : extractedDoc.images,
        scannedPagesCount: cachedStages.ocr && !forceRerun ? 0 : extractedDoc.scannedPageIndices.length,
        isGemini: activeProvider.kind === 'gemini',
        model: activeRole.model,
        costTable: settings.costTable,
        maxUsdPerRun: settings.budget.maxUsdPerRun,
        stageModels,
        maxImagesPerVisionCall: settings.thrift.maxImagesPerVisionCall,
        providerKey: `${activeProvider.kind}:${activeProvider.id}`,
      });

  const handleStartAnalysis = async () => {
    if (!rawFile) {
      setErrorMsg('No raw file loaded. Please return to Step 1 to upload or load demo.');
      return;
    }

    // Block when applicable estimate exceeds budget cap; never block when applicable estimate is 0
    if (estimate.estimatedCostUsd > 0 && estimate.exceedsBudget) {
      setErrorMsg(
        `Pre-flight cost ($${estimate.estimatedCostUsd.toFixed(4)}) exceeds your configured budget cap ($${settings.budget.maxUsdPerRun}). Analysis halted.`
      );
      return;
    }

    setErrorMsg(null);
    liveUserScrolledUp.current = false;
    liveRef.current = { ...liveRef.current, stage: '', label: '', output: '', reasoning: '', info: '' };
    setLive(liveRef.current);
    setIsAnalyzing(true);

    // Initial stage statuses
    const initialStages: StageStatus[] = [
      { id: 'extract', name: 'Local Text & Image Extraction', status: 'completed', message: '0 API calls (done)' },
      { id: 'ocr', name: 'Scanned Pages OCR', status: extractedDoc.scannedPageIndices.length > 0 ? 'idle' : 'skipped', message: 'Batched <= 3 pages' },
      { id: 'structure', name: 'Structure Pass (Span References)', status: 'idle', message: '1 text call' },
      { id: 'vision', name: 'Batched Vision Labeling', status: extractedDoc.images.length > 0 ? 'idle' : 'skipped', message: `${Math.ceil(extractedDoc.images.length / Math.max(1, settings.thrift.maxImagesPerVisionCall))} batched call(s)` },
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
            onStagesUpdate(prev => prev.map(s => (s.id === updated.id ? { ...s, ...updated } : s)));
          },
          onLiveText: (stage, label, channel, fullText) => {
            const prev = liveRef.current;
            const attempts = [...prev.attempts];
            if (channel !== 'info') {
              const index = attempts.findIndex(item => item.stage === stage && item.label === label);
              const item = index >= 0 ? { ...attempts[index] } : { stage, label, output: '', reasoning: '' };
              if (channel === 'output') item.output = fullText; else item.reasoning = fullText;
              if (index >= 0) attempts[index] = item; else attempts.unshift(item);
            }
            liveRef.current = { ...prev, stage, label, attempts, ...(channel === 'output' ? { output: fullText } : channel === 'reasoning' ? { reasoning: fullText } : { info: `${prev.info}\n${fullText}`.trim() }) };
          },
        },
        {
          forceRerun,
          answerKeyFile,
          preExtracted: extractedDoc,
          fileHash: probeFileHash || fileHashProp || undefined,
          forceStages: [...forcedStages] as any,
        }
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

      {/* Saved-result fast-path */}
      {savedExam && onOpenSavedExam && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-xs flex items-center justify-between gap-3">
          <span>
            <span className="font-semibold">Already parsed — Open saved result</span> — “{savedExam.displayName}” ({savedExam.questions.length} questions). Re-analyze remains available below.
          </span>
          <button
            onClick={() => onOpenSavedExam(savedExam)}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium shrink-0"
          >
            Open saved result
          </button>
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
            disabled={isAnalyzing || (estimate.exceedsBudget && estimate.estimatedCostUsd > 0)}
            onClick={handleStartAnalysis}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-2xl font-semibold text-xs text-white transition cursor-pointer shadow-md ${
              isAnalyzing || (estimate.exceedsBudget && estimate.estimatedCostUsd > 0)
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
                      <button type="button" onClick={() => setAttemptStage(current => current === stage.id ? null : stage.id)} className="text-left hover:underline" title="Show this stage's model calls">{stage.name}</button>
                      {isCached && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                          0 calls · cached
                        </span>
                      )}
                    </div>
                    {stage.message && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {stage.message}
                        {stage.attempts !== undefined && stage.attempts > 1 ? ` (${stage.attempts} attempts)` : ''}
                      </p>
                    )}
                  </div>
                </div>

                {/* Stage Metrics */}
                <div className="flex items-center gap-3 text-right font-mono text-[11px]">
                  <button
                    onClick={() =>
                      setForcedStages(prev => {
                        const next = new Set(prev);
                        if (next.has(stage.id)) next.delete(stage.id);
                        else next.add(stage.id);
                        return next;
                      })
                    }
                    title={forcedStages.has(stage.id) ? `Cache bypass armed for ${stage.id} — click to disarm` : `Force re-run of ${stage.id} only`}
                    className={`px-1.5 py-0.5 rounded border text-[11px] cursor-pointer ${
                      forcedStages.has(stage.id)
                        ? 'bg-amber-500/20 border-amber-500/50 text-amber-600 dark:text-amber-400 font-bold'
                        : 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    ↻
                  </button>
                  {stage.inputTokens !== undefined && (
                    <span className="text-slate-600 dark:text-slate-400">
                      {stage.inputTokens} in · {stage.outputTokens || 0} out
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
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <button className="w-full px-3 py-2 text-left text-xs font-semibold bg-slate-50 dark:bg-slate-800" onClick={() => setLiveOpen(v => !v)}>Live AI {live.stage ? `— ${live.stage} / ${live.label}` : ''} {liveOpen ? '▾' : '▸'}</button>
          {liveOpen && <div ref={liveScroll} onScroll={e => { const el = e.currentTarget; liveUserScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 24; }} className="max-h-72 overflow-auto p-3 space-y-2 text-xs">
            {live.reasoning && <div className="text-slate-500"><div className="font-semibold">Model reasoning — live (not part of the answer)</div><pre className="whitespace-pre-wrap font-mono">{live.reasoning.slice(-6000)}</pre></div>}
            {live.output && <pre className="whitespace-pre-wrap font-mono text-slate-800 dark:text-slate-200">{live.output.length > 6000 ? '…earlier output elided in this view only\n' : ''}{live.output.slice(-6000)}</pre>}
            {live.info && <div className="whitespace-pre-wrap text-amber-600 dark:text-amber-400">{live.info}</div>}
            {!live.output && !live.reasoning && !live.info && <div className="text-slate-400">Waiting for model output…</div>}
            {live.attempts.length > 0 && <div className="border-t border-slate-200 dark:border-slate-700 pt-2 space-y-1"><div className="font-semibold text-slate-500">Call attempts {attemptStage ? `— ${attemptStage}` : ''} <button onClick={() => setAttemptStage(null)} className="ml-2 text-blue-500">All</button></div>{live.attempts.filter(attempt => !attemptStage || attempt.stage === attemptStage).map((attempt, i) => <details key={`${attempt.stage}-${attempt.label}-${i}`} className="rounded border border-slate-200 dark:border-slate-700 p-2"><summary className="cursor-pointer">{attempt.stage} · {attempt.label}{attempt.finishReason ? ` · ${attempt.finishReason}` : ''}{attempt.ts ? ` · ${new Date(attempt.ts).toLocaleString()}` : ''}</summary>{attempt.reasoning && <pre className="mt-2 whitespace-pre-wrap text-slate-500">{attempt.reasoning.slice(-6000)}</pre>}<pre className="mt-2 whitespace-pre-wrap font-mono">{attempt.output.slice(-6000)}</pre></details>)}</div>}
          </div>}
        </div>
      </div>
    </div>
  );
};
