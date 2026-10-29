import React, { useState, useEffect, useRef, useMemo } from 'react';
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
import { estimateTextTokens, estimateImageTokens, calculateActualCost } from '../utils/budget';
import { detectLanguageAndDirection } from '../utils/numbers';
import { ExtractedDocument } from '../pipeline/extract';
import { runFullPipeline } from '../pipeline';
import { loadJournal } from '../pipeline/journal';
import { getPipelineCache } from '../store';
import { MapOutline } from '../components/MapOutline';
import type { LoopMapReceipt } from '../pipeline/mapFirst';

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
  onSettingsUpdate?: (settings: AppSettings) => void;
}

export function initialLoopStages(settings: AppSettings): StageStatus[] {
  return [
    // #51: exactly the six loop phases, named 1:1 with the loop receipt.
    { id: 'extract', name: 'Extract', status: 'completed', message: 'Text, OCR, geometry, and images' },
    { id: 'map', name: 'Map', status: 'idle', message: `Whole-exam map → code count → decision audit (text${settings.decideMultimodal ? ' + page images' : ''}) → re-map of indicted entries` },
    { id: 'parse', name: 'Parse', status: 'idle', message: 'Each section against its map contract' },
    { id: 'check', name: 'Check', status: 'idle', message: `Code checks, then decision audit (${settings.decideMode || 'shadow'} mode) — comments only, one merged list` },
    { id: 'fix', name: 'Fix', status: 'idle', message: 'One patch pass on the merged verdicts, batched by section' },
    { id: 'present', name: 'Present', status: 'idle', message: 'Re-check what Fix changed, then save with the attention list' },
  ];
}
/** #51: the six phases, with the map outline (incl. visual seen markers) directly under Map — before Parse. */
export const LoopPhaseList: React.FC<{ stages: StageStatus[]; map?: LoopMapReceipt | null; onSelect?: (id: string) => void }> = ({ stages, map, onSelect }) =>
  <ol className="space-y-3">{stages.map((stage, index) => <li key={stage.id} className="flex items-start gap-3 text-xs" data-loop-stage={stage.id}>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${stage.status === 'running' ? 'animate-pulse border-[var(--accent)] text-[var(--accent-ink)]' : 'border-[var(--rule)] text-[var(--ink-2)]'}`}>{stage.status === 'completed' || stage.status === 'completed-with-problems' ? <CheckCircle2 className="h-4 w-4" /> : stage.status === 'running' ? <RotateCcw className="h-3.5 w-3.5 animate-spin" /> : index + 1}</span>
        <div className="min-w-0"><button className="font-semibold hover:underline" onClick={() => onSelect?.(stage.id)}>{stage.name}</button><span className="ms-2 text-[var(--ink-2)]">{stage.status}</span><p className="mt-0.5 text-[var(--ink-2)]" aria-live="polite">{stage.message || 'Waiting'}</p></div>
      </li>).flatMap(item => item.key === 'map' && map ? [item, <li key="map-outline" data-loop-stage-outline="map"><MapOutline map={map} /></li>] : [item])}</ol>;

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
  onSettingsUpdate,
}) => {
  const [map, setMap] = useState<LoopMapReceipt | null>(null);
  const [forceRerun, setForceRerun] = useState(false);
  const [savedExam, setSavedExam] = useState<ExamDoc | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [live, setLive] = useState({ stage: '', label: '', output: '', info: '' });
  const liveRef = useRef(live);
  const [liveOpen, setLiveOpen] = useState(settings.livePanel ?? true);
  const [attemptStage, setAttemptStage] = useState<string | null>(null);
  const liveScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { const id = window.setInterval(() => setLive({ ...liveRef.current }), 200); return () => clearInterval(id); }, []);
  useEffect(() => { if (isAnalyzing && liveScroll.current) liveScroll.current.scrollTop = liveScroll.current.scrollHeight; }, [live, isAnalyzing]);
  useEffect(() => {
    if (!fileHashProp) return;
    let active = true;
    void import('../store').then(({ loadExamDoc }) => loadExamDoc(`exam_${fileHashProp.slice(0, 12)}`)).then(doc => { if (active) setSavedExam(doc || null); }).catch(() => {});
    return () => { active = false; };
  }, [fileHashProp]);

  const selection = settings.roleMapping.read || settings.roleMapping.fast;
  const provider = settings.providers.find(p => p.id === selection.providerId);
  const pages = Math.max(1, extractedDoc.pages);
  const textTokens = estimateTextTokens(extractedDoc.lines.map(l => l.text).join('\n'), detectLanguageAndDirection(extractedDoc.lines.slice(0, 40).map(l => l.text).join(' ')).direction === 'rtl');
  const imageTokens = extractedDoc.images.reduce((sum, image) => sum + estimateImageTokens(image.width, image.height, false), 0);
  // Map + per-section Parse + one Fix pass (with source context). This is an estimate, never a cap.
  const estimatedInput = textTokens * 3 + imageTokens + extractedDoc.scannedPageIndices.length * 500;
  const estimatedOutput = Math.ceil(textTokens * 1.4) + extractedDoc.images.length * 40;
  const estimatedCost = calculateActualCost(estimatedInput, estimatedOutput, selection.model, settings.costTable);
  const initialStages = initialLoopStages(settings);
  const shownStages = stages.length ? stages : initialStages;

  const handleStartAnalysis = async () => {
    if (!rawFile) { setErrorMsg('No raw file loaded. Return to Step 1 to import an exam.'); return; }
    setErrorMsg(null); setMap(null); setIsAnalyzing(true); onStagesUpdate(initialStages);
    liveRef.current = { stage: '', label: '', output: '', info: '' }; setLive(liveRef.current);
    try {
      const result = await runFullPipeline(rawFile, settings, {
        onMapUpdate: updated => setMap(updated),
        onStageUpdate: updated => onStagesUpdate(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s)),
        onLiveText: (stage, label, channel, fullText) => {
          liveRef.current = { ...liveRef.current, stage, label,
            ...(channel === 'output' ? { output: fullText, ...(stage === 'check' ? { info: '' } : {}) } : channel === 'info' ? { info: `${liveRef.current.info}\n${fullText}`.trim() } : {}) };
        },
      }, { forceRerun, preExtracted: extractedDoc, fileHash: fileHashProp, answerKeyFile });
      onAnalysisComplete(result);
    } catch (error: any) {
      // Model/provider/payload failures are caught inside the loop. Only an input/extraction
      // failure before a document exists can reach this shell-level message.
      setErrorMsg(`Could not start extraction: ${error?.message || error}. Your source file has not been changed.`);
    } finally { setIsAnalyzing(false); }
  };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !isAnalyzing) void handleStartAnalysis(); };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [isAnalyzing, rawFile, forceRerun, settings]);

  return <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
    <div className="text-center space-y-1"><h1 className="text-2xl font-bold tracking-tight text-[var(--ink)]">Analyze Exam Structure</h1><p className="text-xs text-[var(--ink-2)]">The local loop: raw authored JSON, checked in layers, fixed in patches.</p></div>
    {errorMsg && <div role="alert" className="p-4 rounded-[10px] border border-[var(--danger)] bg-[var(--danger-soft)] text-xs text-[var(--danger)]">{errorMsg}</div>}
    {savedExam && onOpenSavedExam && <div className="p-3 rounded-[10px] bg-[var(--ok-soft)] border border-[var(--ok)] text-xs flex items-center justify-between gap-3"><span>Already parsed — “{savedExam.displayName}” ({savedExam.questions.length} questions).</span><button onClick={() => onOpenSavedExam(savedExam)} className="px-3 py-1.5 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)] font-medium">Open saved result</button></div>}
    <section className="ep-card rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold">Pre-flight usage estimate</h2><p className="text-xs text-[var(--ink-2)]">Display only. No budget counter can stop a parse or discard a document.</p></div><span className="text-xs font-mono">{provider?.name || 'Local provider'} · {selection.model}</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">{[['Est. input', `~${(estimatedInput / 1000).toFixed(1)}k tokens`], ['Est. output', `~${(estimatedOutput / 1000).toFixed(1)}k tokens`], ['Est. cost', `$${estimatedCost.toFixed(4)}`], ['READ', 'Map + sections']].map(([label, value]) => <div key={label} className="rounded-[10px] border border-[var(--rule)] bg-[var(--paper)] p-3"><div className="text-[length:var(--type-12)] text-[var(--ink-2)]">{label}</div><div className="mt-1 font-mono font-bold">{value}</div></div>)}</div>
      {estimatedCost > settings.budget.maxUsdPerRun && <p className="text-xs text-[var(--warn-ink)]">Estimate is above your ${settings.budget.maxUsdPerRun} display threshold. You can still run; all default model roles use local endpoints.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={forceRerun} onChange={event => setForceRerun(event.target.checked)} />Force re-run (bypass content-hash cache)</label><button disabled={isAnalyzing || !rawFile} onClick={() => void handleStartAnalysis()} className="flex items-center gap-2 rounded-[6px] bg-[var(--accent)] px-6 py-2.5 text-xs font-semibold text-[var(--on-accent)] disabled:opacity-50"><Play className="h-4 w-4" />{isAnalyzing ? 'Running local loop…' : 'Run Analysis'}</button></div>
    </section>
    <section className="ep-card rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] p-5 space-y-3" aria-label="Local loop progress">
      <h2 className="text-sm font-bold">Six-phase local loop</h2>
      <LoopPhaseList stages={shownStages} map={map} onSelect={id => { setAttemptStage(current => current === id ? null : id); setLiveOpen(true); }} />
    </section>
    <section className="rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] p-4 text-xs">
      <button className="font-semibold" onClick={() => setLiveOpen(value => !value)}>{liveOpen ? 'Hide' : 'Show'} live model output</button>
      {liveOpen && <div ref={liveScroll} className="mt-3 max-h-80 overflow-auto rounded-[6px] bg-[var(--paper)] p-3"><div className="mb-2 text-[var(--ink-2)]">{live.stage} · {live.label} {attemptStage ? `(filter: ${attemptStage})` : ''}</div>{live.info && <pre className="mb-2 whitespace-pre-wrap text-[var(--ink-2)]">{live.info.slice(-4000)}</pre>}<pre className="whitespace-pre-wrap font-mono">{(!attemptStage || live.stage === attemptStage ? live.output : '').slice(-12000)}</pre></div>}
    </section>
  </div>;
};
