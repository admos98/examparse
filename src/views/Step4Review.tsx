import { applyExamMutation } from '../pipeline/patch';
import React, { useState } from 'react';
import {
  Edit3,
  RotateCcw,
  Sparkles,
  Check,
  X,
  AlertTriangle,
  ImageIcon,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  ShieldAlert,
  HelpCircle,
  Split,
  Combine,
  ListOrdered,
} from 'lucide-react';
import { AppSettings, ExamDoc, Flag, Question } from '../types';
import { regenerateQuestionPatch } from '../pipeline/patch';
import { saveExamDoc } from '../store';
import { ExamHealthBanner } from '../components/ExamHealthBanner';
import { getExamHealth } from '../pipeline/quality';
import { applyBulk, exportSelected } from '../pipeline/bulkOps';
import { retryMissingCoverage } from '../pipeline/retryCoverage';
import { buildQuestionTree } from '../utils/questionTree';
import { computeSuggestions } from '../pipeline/suggestions';
import { computeQualityScore } from '../utils/qualityScore';

interface Props {
  examDoc: ExamDoc;
  settings: AppSettings;
  onUpdateDoc: (updated: ExamDoc) => void;
  onProceedToExamView: () => void;
}

export const Step4Review: React.FC<Props> = ({
  examDoc,
  settings,
  onUpdateDoc,
  onProceedToExamView,
}) => {
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [patchModalQuestion, setPatchModalQuestion] = useState<Question | null>(null);
  const [patchInstruction, setPatchInstruction] = useState('');
  const [isPatching, setIsPatching] = useState(false);
  const [patchDiffResult, setPatchDiffResult] = useState<{
    patch: any;
    patchedQuestion: Question;
    diffSummary: string[];
    usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  } | null>(null);

  const [filterType, setFilterType] = useState<string>('all');
  const [showFlagsPanel, setShowFlagsPanel] = useState<boolean>(true);
  const [showImageManager, setShowImageManager] = useState<boolean>(false);
  const [isSolvingBatch, setIsSolvingBatch] = useState<boolean>(false);
  const [solverError, setSolverError] = useState<string | null>(null);
  const [solvingQuestionId, setSolvingQuestionId] = useState<string | null>(null);
  const [retryingCoverage, setRetryingCoverage] = useState(false);
  const [retryProgress, setRetryProgress] = useState('');
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [dismissedChips, setDismissedChips] = useState<Set<string>>(new Set());
  const [scoreExplain, setScoreExplain] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPts, setBulkPts] = useState(2);
  const [undoSnapshot, setUndoSnapshot] = useState<string | null>(null);

  // Group questions by section
  const sections = examDoc.sections.length > 0 ? examDoc.sections : [{ id: 'sec_default', index: 1, title: 'General Section', spans: [] }];
  const questionsBySection: Record<string, Question[]> = {};

  for (const sec of sections) {
    questionsBySection[sec.id] = [];
  }
  for (const q of examDoc.questions) {
    const secId = q.sectionId && questionsBySection[q.sectionId] ? q.sectionId : sections[0].id;
    questionsBySection[secId].push(q);
  }
  for (const questions of Object.values(questionsBySection)) questions.sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1) || a.no - b.no);

  const health = getExamHealth(examDoc);

  const handleRetryMissingCoverage = async () => {
    if (retryingCoverage || health.missing.length === 0) return;
    setRetryingCoverage(true);
    setRetryProgress('Preparing bounded, journal-aware section recovery…');
    setCoverageError(null);
    try {
      const updated = await retryMissingCoverage(examDoc, settings, setRetryProgress);
      onUpdateDoc(updated);
      setRetryProgress('');
    } catch (error: any) {
      setCoverageError(error?.message || 'Coverage recovery failed. The exam remains visibly partial.');
    } finally {
      setRetryingCoverage(false);
    }
  };

  const handleAssignImage = (imageId: string, questionId: string) => {
    const question = examDoc.questions.find(item => item.id === questionId);
    if (!question) return;
    const image = examDoc.images.find(item => item.id === imageId);
    const nextQuestions = examDoc.questions.map(item => ({
      ...item,
      images: (item.images || []).filter(ref => ref.imageId !== imageId),
    }));
    const target = nextQuestions.find(item => item.id === questionId)!;
    target.images ||= [];
    target.images.push({ imageId, role: image?.label?.role && image.label.role !== 'decoration' ? image.label.role as any : 'stem', anchorLine: image?.anchorLine });
    const nextImages: ExamDoc['images'] = examDoc.images.map(item => item.id === imageId ? { ...item, label: { ...(item.label || {}), role: 'stem' as const, questionRef: question.label || String(question.no) } } : item);
    const updated: ExamDoc = { ...examDoc, questions: nextQuestions, images: nextImages };
    onUpdateDoc(updated);
    saveExamDoc(updated);
  };

  // Update a question in examDoc
  const handleUpdateQuestion = (qId: string, updates: Partial<Question>) => {
    const updatedQuestions = examDoc.questions.map(q => (q.id === qId ? { ...q, ...updates } : q));
    const newDoc = { ...examDoc, questions: updatedQuestions };
    onUpdateDoc(newDoc);
    saveExamDoc(newDoc);
  };

  // Delete a question
  const handleDeleteQuestion = (qId: string) => {
    const newDoc = applyExamMutation(examDoc, { name: 'delete_question', questionId: qId });
    onUpdateDoc(newDoc);
    saveExamDoc(newDoc);
  };

  // Renumber all questions consecutively
  const handleRenumberQuestions = () => {
    const updated = examDoc.questions.map((q, idx) => ({
      ...q,
      no: idx + 1,
      label: String(idx + 1),
    }));
    const newDoc = { ...examDoc, questions: updated };
    onUpdateDoc(newDoc);
    saveExamDoc(newDoc);
  };

  // Trigger minimal patch regeneration call
  const handleRunPatch = async () => {
    if (!patchModalQuestion) return;
    setIsPatching(true);

    const patchRole = settings.roleMapping.fast;
    const provider = settings.providers.find(p => p.id === patchRole.providerId) || settings.providers[0];
    const providerConfig = { ...provider, model: patchRole.model };

    try {
      const result = await regenerateQuestionPatch({
        question: patchModalQuestion,
        sourceLines: examDoc.source.lines,
        instruction: patchInstruction,
        providerConfig,
        maxOutputTokens: settings.budget.maxOutputTokens,
      });

      // Log usage for patch call (§5.4 & §5.7)
      const { calculateActualCost } = await import('../utils/budget');
      const { appendUsageRecord } = await import('../store');

      const costUsd = calculateActualCost(
        result.usage.inputTokens,
        result.usage.outputTokens,
        providerConfig.model,
        settings.costTable
      );

      const patchUsageRec: any = {
        ts: new Date().toISOString(),
        role: 'patch',
        provider: providerConfig.name,
        model: providerConfig.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd,
        label: `Patch Question ${patchModalQuestion.label || patchModalQuestion.no}`,
      };
      appendUsageRecord(patchUsageRec);

      const updatedUsage = [...(examDoc.usage || []), patchUsageRec];
      onUpdateDoc({ ...examDoc, usage: updatedUsage });

      setPatchDiffResult(result);
    } catch (err: any) {
      alert(`Patch failed: ${err.message}`);
    } finally {
      setIsPatching(false);
    }
  };


  // Solver budget gate (C13): estimate target text cost at the standard-role model.
  const checkSolverBudget = async (targets: Question[]): Promise<boolean> => {
    const { estimateTextTokens, calculateActualCost } = await import('../utils/budget');
    const standardRole = settings.roleMapping.standard;
    const text = targets
      .map(q => [q.stem || '', ...(q.options || []).map(o => o.text || '')].join(' '))
      .join('\n');
    const estInput = estimateTextTokens(text, examDoc.meta.direction === 'rtl');
    const estOutput = Math.max(80, targets.length * 80);
    const estCost = calculateActualCost(estInput, estOutput, standardRole.model, settings.costTable);
    if (estCost > settings.budget.maxUsdPerRun) {
      setSolverError(
        `Solver estimate ($${estCost.toFixed(4)}) exceeds your configured budget cap ($${settings.budget.maxUsdPerRun}). Solving halted.`
      );
      return false;
    }
    setSolverError(null);
    return true;
  };

  // Solve all questions missing an answer in 1 batched call
  const handleSolveAllMissing = async () => {
    const targets = examDoc.questions.filter(q => !q.answer || !q.answer.text);
    if (!(await checkSolverBudget(targets))) return;
    setIsSolvingBatch(true);
    const standardRole = settings.roleMapping.standard;
    const provider = settings.providers.find(p => p.id === standardRole.providerId) || settings.providers[0];
    const providerConfig = { ...provider, model: standardRole.model };

    try {
      const { solveQuestionsWithAI } = await import('../pipeline/solver');
      const { calculateActualCost } = await import('../utils/budget');
      const { appendUsageRecord } = await import('../store');

      const res = await solveQuestionsWithAI({
        questions: examDoc.questions,
        providerConfig,
        maxOutputTokens: settings.budget.maxOutputTokens,
      });

      if (res.solvedCount > 0) {
        const costUsd = calculateActualCost(
          res.usageRecord.inputTokens,
          res.usageRecord.outputTokens,
          providerConfig.model,
          settings.costTable
        );
        res.usageRecord.costUsd = costUsd;
        appendUsageRecord(res.usageRecord);

        const newDoc: ExamDoc = {
          ...examDoc,
          questions: res.updatedQuestions,
          usage: [...(examDoc.usage || []), res.usageRecord],
        };
        onUpdateDoc(newDoc);
        saveExamDoc(newDoc);
      }
    } catch (err: any) {
      alert(`AI Solve failed: ${err.message}`);
    } finally {
      setIsSolvingBatch(false);
    }
  };

  // Solve single question with AI
  const handleSolveSingle = async (q: Question) => {
    if (!(await checkSolverBudget([q]))) return;
    setSolvingQuestionId(q.id);
    const standardRole = settings.roleMapping.standard;
    const provider = settings.providers.find(p => p.id === standardRole.providerId) || settings.providers[0];
    const providerConfig = { ...provider, model: standardRole.model };

    try {
      const { solveSingleQuestionWithAI } = await import('../pipeline/solver');
      const { calculateActualCost } = await import('../utils/budget');
      const { appendUsageRecord } = await import('../store');

      const res = await solveSingleQuestionWithAI({
        question: q,
        providerConfig,
        maxOutputTokens: settings.budget.maxOutputTokens,
      });

      const costUsd = calculateActualCost(
        res.usageRecord.inputTokens,
        res.usageRecord.outputTokens,
        providerConfig.model,
        settings.costTable
      );
      res.usageRecord.costUsd = costUsd;
      appendUsageRecord(res.usageRecord);

      const updatedQ: Question = {
        ...q,
        answer: {
          text: res.answerText,
          source: 'ai' as const,
        },
      };

      handleUpdateQuestion(q.id, updatedQ);
    } catch (err: any) {
      alert(`Failed to solve question: ${err.message}`);
    } finally {
      setSolvingQuestionId(null);
    }
  };

  // Accept proposed patch
  const handleAcceptPatch = () => {
    if (!patchDiffResult) return;
    handleUpdateQuestion(patchDiffResult.patchedQuestion.id, patchDiffResult.patchedQuestion);
    setPatchDiffResult(null);
    setPatchModalQuestion(null);
  };

  // Reassign image role or questionRef locally (0 API calls per §4)
  const handleReassignImage = (imgId: string, updates: any) => {
    const updatedImages = examDoc.images.map(img => {
      if (img.id === imgId) {
        return {
          ...img,
          label: { ...(img.label || { role: 'stem' }), ...updates },
        };
      }
      return img;
    });

    const updatedAsset = updatedImages.find(img => img.id === imgId)!;
    const target = examDoc.questions.find(q => updatedAsset.label?.questionRef && (q.id === updatedAsset.label.questionRef || q.label === updatedAsset.label.questionRef || String(q.no) === updatedAsset.label.questionRef));
    const updatedQuestions = examDoc.questions.map(q => {
      const withoutImage = (q.images || []).filter(ref => ref.imageId !== imgId);
      if (target?.id === q.id && updatedAsset.label?.role !== 'decoration') withoutImage.push({ imageId: imgId, role: updatedAsset.label?.role as any || 'stem', anchorLine: updatedAsset.anchorLine });
      return { ...q, images: withoutImage };
    });
    const newDoc = { ...examDoc, images: updatedImages, questions: updatedQuestions };
    onUpdateDoc(newDoc);
    saveExamDoc(newDoc);
  };

  return (
    <div className="max-w-6xl mx-auto py-6 px-4 space-y-6">
      {/* Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-xs">
        <div>
          <h1 className="text-sm font-bold text-slate-900 dark:text-white">
            Question Bank Review & Editor
          </h1>
          <p className="text-xs text-slate-500">
            {examDoc.questions.length} questions • {examDoc.sections.length} sections • {examDoc.flags.length} flags
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          {/* Solve Missing with AI Button */}
          {(() => {
            const missingCount = examDoc.questions.filter(q => !q.answer?.text).length;
            return (
              <button
                disabled={isSolvingBatch || missingCount === 0}
                onClick={handleSolveAllMissing}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium transition cursor-pointer ${
                  missingCount > 0
                    ? 'bg-purple-50 dark:bg-purple-950/40 border-purple-300 dark:border-purple-800 text-purple-700 dark:text-purple-300 hover:bg-purple-100'
                    : 'border-slate-200 dark:border-slate-800 text-slate-400 opacity-60'
                }`}
                title="Solve all questions lacking an answer with AI in 1 batched call"
              >
                <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                <span>
                  {isSolvingBatch
                    ? 'Solving Batch...'
                    : missingCount > 0
                    ? `Answer with AI (${missingCount})`
                    : 'All Answered'}
                </span>
              </button>
            );
          })()}

          <button
            onClick={handleRenumberQuestions}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium transition cursor-pointer"
            title="Renumber all questions sequentially 1..N"
          >
            <ListOrdered className="w-3.5 h-3.5 text-blue-500" />
            <span>Renumber</span>
          </button>

          <button
            onClick={() => setShowImageManager(!showImageManager)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition cursor-pointer ${
              showImageManager
                ? 'bg-purple-50 dark:bg-purple-950/40 border-purple-300 dark:border-purple-800 text-purple-700 dark:text-purple-300'
                : 'border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5 text-purple-500" />
            <span>Images ({examDoc.images.length})</span>
          </button>

          <button
            onClick={() => setShowFlagsPanel(!showFlagsPanel)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition cursor-pointer ${
              showFlagsPanel && examDoc.flags.length > 0
                ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                : 'border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            <span>Flags ({examDoc.flags.length})</span>
          </button>

          <button
            onClick={onProceedToExamView}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs transition cursor-pointer shadow-xs ml-2"
          >
            <span>Preview & Print Exam</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <ExamHealthBanner doc={examDoc} onExplainScore={(f)=> { if(f) setFilterType(f); setScoreExplain('Quality score: coverage 30 + points 15 + options 15 + images 15 + numbering 10 + confidence 10 + passage 5'); }} />
      {/* Proactive suggestions (F1): silent-by-default, dismissible, ≤3 chips */}
      {(() => {
        const chips = computeSuggestions(examDoc).filter(c=> !dismissedChips.has(c.id));
        if (chips.length===0) return null;
        return <div className="flex flex-wrap gap-2">{chips.map(c=> (
          <span key={c.id} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-600 text-white text-xs">
            <button onClick={()=> {
              if (c.id==='missing') handleRetryMissingCoverage();
              else if (c.id==='unplaced') setShowImageManager(true);
              else if (c.id==='quality') setScoreExplain((()=>{ const q=computeQualityScore(examDoc); return `Coverage ${q.coverage}/30, Points ${q.points}/15, Options ${q.optionsCleanliness}/15, Images ${q.imagePlacement}/15, Numbering ${q.numbering}/10, Confidence ${q.confidence}/10, Passage ${q.passage}/5 = Total ${q.total}/100`; })());
            }} className="font-medium hover:underline cursor-pointer">{c.label}</button>
            <button onClick={()=> setDismissedChips(s=> new Set([...s, c.id]))} className="opacity-80 hover:opacity-100 cursor-pointer"><X className="w-3 h-3" /></button>
          </span>
        ))}</div>;
      })()}
      {scoreExplain && <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-3 text-xs flex items-center justify-between"><span>{scoreExplain}</span><button onClick={()=> setScoreExplain(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button></div>}
      {/* Bulk ops bar (D2) */}
      {selectedIds.size>0 && (
        <div className="flex flex-wrap items-center gap-2 p-2 rounded-xl border bg-blue-50 dark:bg-blue-950/30 text-xs">
          <span className="font-semibold">{selectedIds.size} selected</span>
          <input type="number" value={bulkPts} onChange={e=> setBulkPts(Number(e.target.value))} className="w-16 px-1 py-0.5 rounded border text-xs" />
          <button onClick={()=> { const {doc:next, undo}=applyBulk(examDoc, [...selectedIds], {type:'setPoints', points:bulkPts}); setUndoSnapshot(undo); onUpdateDoc(next); saveExamDoc(next); }} className="px-2 py-1 rounded bg-blue-600 text-white text-xs">Set points</button>
          <button onClick={()=> { const {doc:next, undo}=applyBulk(examDoc, [...selectedIds], {type:'delete'}); setUndoSnapshot(undo); onUpdateDoc(next); saveExamDoc(next); setSelectedIds(new Set()); }} className="px-2 py-1 rounded bg-red-600 text-white text-xs">Delete</button>
          <button onClick={()=> { const exp=exportSelected(examDoc, [...selectedIds]); const blob=new Blob([JSON.stringify(exp.json,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='selected.json'; a.click(); URL.revokeObjectURL(url); }} className="px-2 py-1 rounded border text-xs">Export selected</button>
          {undoSnapshot && <button onClick={()=> { const prev=JSON.parse(undoSnapshot); onUpdateDoc(prev); saveExamDoc(prev); setUndoSnapshot(null); }} className="px-2 py-1 rounded border text-xs">Undo</button>}
          <button onClick={()=> setSelectedIds(new Set())} className="px-2 py-1 rounded border text-xs">Clear</button>
        </div>
      )}
      {health.missing.length > 0 && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><strong>PARTIAL COVERAGE — {health.missing.length} expected question(s) are missing.</strong><div className="mt-1">Missing printed numbers: {health.missing.join(', ')}. This document remains incomplete and exports require confirmation.</div></div>
            <button disabled={retryingCoverage} onClick={handleRetryMissingCoverage} className="rounded-lg bg-red-700 px-3 py-2 font-semibold text-white disabled:opacity-50">
              {retryingCoverage ? 'Recovering…' : 'Retry missing questions'}
            </button>
          </div>
          {retryProgress && <div role="status" className="mt-2 font-mono">{retryProgress}</div>}
          {coverageError && <div role="alert" className="mt-2 font-semibold">{coverageError}</div>}
        </div>
      )}
      {health.unplacedImages.length > 0 && (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs dark:border-amber-900 dark:bg-amber-950/30">
          <h2 className="font-bold text-amber-900 dark:text-amber-200">Unplaced image assets ({health.unplacedImages.length}) — none are hidden</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{health.unplacedImages.map(image => (
            <div key={image.id} className="flex gap-3 rounded-xl border border-amber-300 bg-white p-2 dark:border-amber-800 dark:bg-slate-900">
              {image.dataUrl ? <img src={image.dataUrl} alt={image.id} className="h-16 w-20 object-contain rounded bg-slate-100" /> : <div className="flex h-16 w-20 items-center justify-center rounded border border-dashed border-amber-500 text-[10px]">Missing asset</div>}
              <div className="min-w-0 flex-1"><div className="font-mono font-bold">{image.id} · page {image.page}</div><div className="truncate text-slate-600">{image.label?.caption || 'Unassigned extracted image'}</div><label className="mt-1 block text-[10px]">Assign to question<select value="" onChange={event => event.target.value && handleAssignImage(image.id, event.target.value)} className="mt-1 w-full rounded border border-amber-300 bg-white p-1 dark:bg-slate-900"><option value="">Choose question…</option>{examDoc.questions.filter(question => !question.parentId).map(question => <option key={question.id} value={question.id}>Q{question.label} — {(question.stem || '').slice(0, 60)}</option>)}</select></label></div>
            </div>
          ))}</div>
        </section>
      )}

      {/* Solver Budget Stop Banner */}
      {solverError && (
        <div className="p-4 rounded-2xl border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 flex items-start gap-3 text-xs">
          <ShieldAlert className="w-5 h-5 shrink-0 text-red-500 mt-0.5" />
          <div className="flex-1 space-y-1">
            <span className="font-bold">Budget / Execution Stop:</span>
            <p>{solverError}</p>
          </div>
          <button onClick={() => setSolverError(null)} className="text-red-400 hover:text-red-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Flags Panel (§4 & §6.3) */}
      {showFlagsPanel && examDoc.flags.length > 0 && (
        <div className="bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/60 rounded-2xl p-4 space-y-2 text-xs">
          <div className="font-bold text-amber-800 dark:text-amber-300 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              <span>Integrity Flags ({examDoc.flags.length})</span>
            </span>
            <button onClick={() => setShowFlagsPanel(false)} className="text-amber-600 hover:text-amber-800">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {examDoc.flags.map(f => (
              <div
                key={f.id}
                className="p-2.5 rounded-xl bg-white/80 dark:bg-slate-900/80 border border-amber-200 dark:border-amber-800/40 flex items-start gap-2"
              >
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase font-semibold shrink-0 ${
                    f.severity === 'error'
                      ? 'bg-red-500/10 text-red-600'
                      : f.severity === 'warn'
                      ? 'bg-amber-500/10 text-amber-600'
                      : 'bg-blue-500/10 text-blue-600'
                  }`}
                >
                  {f.code}
                </span>
                <span className="text-slate-700 dark:text-slate-300 leading-snug">{f.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Local Image Manager Modal / Panel */}
      {showImageManager && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 space-y-4 shadow-sm text-xs">
          <div className="flex justify-between items-center pb-2 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <ImageIcon className="w-4 h-4 text-purple-500" /> Local Image Manager
              </h3>
              <p className="text-[11px] text-slate-500">
                Reassign images to questions or mark as decoration locally (0 API calls)
              </p>
            </div>
            <button onClick={() => setShowImageManager(false)} className="text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {examDoc.images.map(img => (
              <div
                key={img.id}
                className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 space-y-2"
              >
                {img.dataUrl ? (
                  <img
                    src={img.dataUrl}
                    alt={img.id}
                    className="w-full h-28 object-contain rounded-lg bg-white border border-slate-200 dark:border-slate-800"
                  />
                ) : (
                  <div className="w-full h-28 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                    Image {img.id}
                  </div>
                )}

                <div className="space-y-1">
                  <div className="flex justify-between items-center font-mono text-[10px] text-slate-500">
                    <span>{img.id} (P{img.page})</span>
                    <span>{img.width}×{img.height}</span>
                  </div>

                  <div className="flex gap-2">
                    <select
                      value={img.label?.role || 'stem'}
                      onChange={e => handleReassignImage(img.id, { role: e.target.value })}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-[11px] flex-1"
                    >
                      <option value="stem">Stem</option>
                      <option value="option">Option</option>
                      <option value="table">Table</option>
                      <option value="decoration">Decoration</option>
                    </select>

                    <input
                      type="text"
                      placeholder="Q# Ref"
                      value={img.label?.questionRef || ''}
                      onChange={e => handleReassignImage(img.id, { questionRef: e.target.value })}
                      className="w-16 px-2 py-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-[11px] font-mono"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Question Cards by Section */}
      <div className="space-y-6">
        {sections.map(sec => {
          const secQuestions = questionsBySection[sec.id] || [];
          const hierarchy = buildQuestionTree(secQuestions);
          const rootQuestions = hierarchy.roots;
          const renderNestedChildren = (parentId: string, depth = 1): React.ReactNode => {
            const children = hierarchy.children.get(parentId) || [];
            if (!children.length) return null;
            return <div className={`${depth === 1 ? 'ml-4 border-l-2 border-indigo-300 pl-3 dark:border-indigo-700' : 'ml-4 border-l border-indigo-200 pl-3 dark:border-indigo-800'} space-y-2`}>
              {children.map((child, childIndex) => <div key={child.id} className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-xs dark:border-indigo-900 dark:bg-indigo-950/20">
                <div className="flex items-start justify-between gap-2"><div className="flex items-start gap-2"><span className="rounded bg-indigo-200 px-1.5 py-0.5 font-mono font-bold text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100">{String.fromCharCode(97 + childIndex % 26)}) · {child.label}</span><span className="text-[10px] text-slate-500">{((child.confidence ?? 1) * 100).toFixed(0)}% confidence · {child.spans.map(([start, end]) => `L${start}..L${end}`).join(', ')}</span></div><button onClick={() => setActiveQuestionId(activeQuestionId === child.id ? null : child.id)} className="text-[10px] font-semibold text-indigo-700 underline dark:text-indigo-300">{activeQuestionId === child.id ? 'Close edit' : 'Edit child'}</button></div>
                {activeQuestionId === child.id ? <textarea rows={2} value={child.stem || ''} onChange={event => handleUpdateQuestion(child.id, { stem: event.target.value })} className="mt-2 w-full rounded border border-indigo-300 bg-white p-2 dark:bg-slate-900" /> : <div dir="auto" className="mt-2 whitespace-pre-wrap">{child.stem}</div>}
                {(child.options || []).length > 0 && <div className="mt-2 grid gap-1 sm:grid-cols-2">{child.options?.map(option => <div key={option.key}><b>{option.key}.</b> {option.text}</div>)}</div>}
                {child.answer?.text && <div className="mt-2 border-t border-indigo-200 pt-2"><b>Answer:</b> {child.answer.text}</div>}
                {renderNestedChildren(child.id, depth + 1)}
              </div>)}
            </div>;
          };
          if (secQuestions.length === 0 && !sec.passage) return null;

          return (
            <div key={sec.id} className="space-y-3">
              {(hierarchy.cycleBreaks.size > 0 || hierarchy.orphanedParents.size > 0) && <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">Invalid nested-question links were flattened so all {hierarchy.cycleBreaks.size + hierarchy.orphanedParents.size} affected question(s) remain visible.</div>}
              {/* Section Header */}
              <div className="flex items-center justify-between pb-1 border-b border-slate-200 dark:border-slate-800">
                <div className="space-y-0.5">
                  <h2 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
                    {sec.title || `Section ${sec.index}`}
                  </h2>
                  {sec.instructions && <p dir="auto" className="text-[11px] text-slate-500 italic">{sec.instructions}</p>}
                  {sec.passage && <div dir="auto" className="mt-2 max-w-4xl whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">{sec.passage}</div>}
                </div>
                <span className="text-[11px] font-mono text-slate-400">
                  {sec.points !== undefined ? `${sec.points} pts · ` : ''}{secQuestions.length} question(s)
                </span>
              </div>

              {/* Question Cards List */}
              <div className="space-y-3">
                {rootQuestions.map(q => {
                  const isExpanded = activeQuestionId === q.id;
                  const groupChildren = hierarchy.children.get(q.id) || [];
                  const showChildren = Boolean(expandedGroups[q.id]);

                  return (
                    <div
                      key={q.id}
                      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-xs space-y-3 transition hover:border-slate-300 dark:hover:border-slate-700"
                    >
                      {/* Question Header Row */}
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <input type="checkbox" checked={selectedIds.has(q.id)} onChange={e=> setSelectedIds(s=> { const n=new Set(s); if(e.target.checked) n.add(q.id); else n.delete(q.id); return n; })} className="w-3.5 h-3.5" />
                          <span className="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold flex items-center justify-center font-mono">
                            {q.label}
                          </span>

                          <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                            {q.type}
                          </span>

                          {q.points !== undefined && (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold">
                              {q.points} pts
                            </span>
                          )}

                          <span className="text-[10px] text-slate-400 font-mono">
                            spans: {q.spans.map(([s, e]) => `L${s}..L${e}`).join(', ')}
                          </span>

                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                              q.confidence >= 0.8
                                ? 'bg-emerald-500/10 text-emerald-600'
                                : 'bg-amber-500/10 text-amber-600'
                            }`}
                          >
                            {((q.confidence ?? 1) * 100).toFixed(0)}% conf
                          </span>
                          {groupChildren.length > 0 && <button onClick={() => setExpandedGroups(current => ({ ...current, [q.id]: !current[q.id] }))} className="rounded bg-indigo-50 px-2 py-1 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">{groupChildren.length} subquestion(s) {showChildren ? '▲' : '▼'}</button>}
                        </div>

                        {/* Question Action Buttons */}
                        <div className="flex items-center gap-1.5">
                          {/* Solve single with AI */}
                          <button
                            disabled={solvingQuestionId === q.id}
                            onClick={() => handleSolveSingle(q)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-50 dark:bg-purple-950/40 border border-purple-300 dark:border-purple-800 text-purple-700 dark:text-purple-300 text-[11px] font-medium hover:bg-purple-100 dark:hover:bg-purple-900/40 transition cursor-pointer"
                            title="Solve or regenerate answer for this question with AI"
                          >
                            <Sparkles className="w-3 h-3 text-purple-500" />
                            <span>{solvingQuestionId === q.id ? 'Solving...' : q.answer?.text ? 'Re-solve' : 'AI Solve'}</span>
                          </button>

                          {/* Minimal-Patch Regeneration Button (§5.4) */}
                          <button
                            onClick={() => {
                              setPatchModalQuestion(q);
                              setPatchDiffResult(null);
                              setPatchInstruction('');
                            }}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-[11px] font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40 transition cursor-pointer"
                            title="Regenerate this single question using minimal RFC 7386 JSON Merge Patch"
                          >
                            <Sparkles className="w-3 h-3 text-amber-500" />
                            <span>Patch</span>
                          </button>

                          <button
                            onClick={() => setActiveQuestionId(isExpanded ? null : q.id)}
                            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                          >
                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>

                          <button
                            onClick={() => handleDeleteQuestion(q.id)}
                            className="p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Stem Text (Editable) */}
                      <div>
                        {isExpanded ? (
                          <textarea
                            rows={3}
                            value={q.stem || ''}
                            onChange={e => handleUpdateQuestion(q.id, { stem: e.target.value })}
                            className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-sans text-slate-900 dark:text-slate-100"
                          />
                        ) : (
                          <div className="text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                            {q.stem}
                          </div>
                        )}
                      </div>

                      {/* Attached Diagram / Image */}
                      {q.images && q.images.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {q.images.map(imgRef => {
                            const asset = examDoc.images.find(i => i.id === imgRef.imageId);
                            if (!asset || !asset.dataUrl) return (
                              <div key={imgRef.imageId} className="rounded-xl border-2 border-dashed border-amber-500 bg-amber-50 p-3 text-[10px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                Missing image {imgRef.imageId} — open original page {asset?.page ?? 'unknown'}
                              </div>
                            );
                            return (
                              <div
                                key={imgRef.imageId}
                                className="relative rounded-xl border border-slate-200 dark:border-slate-800 p-1 bg-slate-50 dark:bg-slate-950 inline-block"
                              >
                                <img
                                  src={asset.dataUrl}
                                  alt={asset.id}
                                  onError={event => { event.currentTarget.style.display = 'none'; const fallback = event.currentTarget.parentElement?.querySelector('[data-image-error]') as HTMLElement | null; if (fallback) fallback.hidden = false; }}
                                  className="max-h-24 rounded-lg object-contain bg-white"
                                />
                                <div hidden data-image-error className="p-2 text-[10px] text-amber-900">Image unavailable — open original page {asset.page}.</div>
                                <span className="absolute bottom-1 right-1 text-[9px] font-mono px-1 rounded bg-black/70 text-white">
                                  {imgRef.role}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Options Grid (MCQ) */}
                      {q.options && q.options.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-xs">
                          {q.options.map(opt => (
                            <div
                              key={opt.key}
                              className="flex items-center gap-2 p-2 rounded-xl border border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-950/40"
                            >
                              <span className="w-5 h-5 rounded-md bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold flex items-center justify-center text-[11px] shrink-0 font-mono">
                                {opt.key}
                              </span>
                              <span className="text-slate-800 dark:text-slate-200 truncate">
                                {opt.text}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Answer Key preview with Origin Badge & Inline Edit */}
                      <div className="pt-1">
                        {q.answer && q.answer.text ? (
                          <div className="text-[11px] bg-slate-50 dark:bg-slate-950/60 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-slate-800 dark:text-slate-200">Answer:</span>
                                <span
                                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-semibold uppercase ${
                                    q.answer.source === 'paper'
                                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                                      : q.answer.source === 'keyfile'
                                      ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
                                      : q.answer.source === 'ai'
                                      ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20'
                                      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                                  }`}
                                >
                                  {q.answer.source === 'paper'
                                    ? 'In-Doc Key'
                                    : q.answer.source === 'keyfile'
                                    ? 'Key File'
                                    : q.answer.source === 'ai'
                                    ? 'AI Solved'
                                    : 'Manual'}
                                </span>
                              </div>
                            </div>
                            {isExpanded ? (
                              <textarea
                                rows={2}
                                value={q.answer.text}
                                onChange={e =>
                                  handleUpdateQuestion(q.id, {
                                    answer: { ...q.answer, text: e.target.value, source: 'manual' },
                                  })
                                }
                                className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-mono"
                              />
                            ) : (
                              <div className="text-slate-700 dark:text-slate-300 font-medium whitespace-pre-wrap">
                                {q.answer.text}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center justify-between p-2 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-[11px] text-slate-400">
                            <span>No answer linked yet</span>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleSolveSingle(q)}
                                className="text-purple-600 dark:text-purple-400 hover:underline cursor-pointer flex items-center gap-1 font-medium"
                              >
                                <Sparkles className="w-3 h-3" />
                                <span>Solve with AI</span>
                              </button>
                              <span>•</span>
                              <button
                                onClick={() =>
                                  handleUpdateQuestion(q.id, {
                                    answer: { text: '', source: 'manual' },
                                  })
                                }
                                className="text-blue-500 hover:underline cursor-pointer"
                              >
                                + Add manual
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {showChildren && groupChildren.length > 0 && renderNestedChildren(q.id)}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Minimal-Patch Regeneration Modal (§5.4) */}
      {patchModalQuestion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                  Regenerate Question #{patchModalQuestion.label} (RFC 7386 Patch)
                </h3>
              </div>
              <button
                onClick={() => {
                  setPatchModalQuestion(null);
                  setPatchDiffResult(null);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              Sends only this question&apos;s source slice &plusmn;5 context lines (~1k tokens).
              The model returns a JSON merge patch instead of re-running the document.
            </p>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Instruction for AI (Optional)
              </label>
              <input
                type="text"
                placeholder="E.g., Normalize math with LaTeX, or re-detect MCQ options"
                value={patchInstruction}
                onChange={e => setPatchInstruction(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-sans"
              />
            </div>

            {/* Diff Preview */}
            {patchDiffResult && (
              <div className="space-y-2 p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs font-mono">
                <div className="font-bold text-emerald-600 flex items-center justify-between">
                  <span>Patch Received ({patchDiffResult.usage?.inputTokens || 0} toks):</span>
                  <span>Tokens saved: ~92%</span>
                </div>
                <div className="space-y-1 text-[11px] text-slate-700 dark:text-slate-300 max-h-36 overflow-y-auto">
                  {patchDiffResult.diffSummary.length > 0 ? (
                    patchDiffResult.diffSummary.map((d, i) => (
                      <div key={i} className="text-blue-600 dark:text-blue-400">
                        {d}
                      </div>
                    ))
                  ) : (
                    <div>No fields changed.</div>
                  )}
                </div>
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setPatchModalQuestion(null);
                  setPatchDiffResult(null);
                }}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>

              {patchDiffResult ? (
                <button
                  onClick={handleAcceptPatch}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium shadow-xs"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Accept Patch</span>
                </button>
              ) : (
                <button
                  disabled={isPatching}
                  onClick={handleRunPatch}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-xs disabled:opacity-50"
                >
                  {isPatching ? (
                    <>
                      <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                      <span>Dispatching Patch...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Generate Patch</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
