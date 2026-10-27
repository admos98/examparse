import { prepareReviewDocument, reconcileFinalFlags, repairImageReferences, restoreMissingImageFromSource } from '../pipeline/reviewIntegrity';
import { IntegrityFlags } from '../components/IntegrityFlags';
import { attentionQuestionIds, computeAttention, type AttentionItem } from '../utils/attention';
import { getReviewImageBlob, getSourceFile } from '../store';
import { applyExamMutation } from '../pipeline/patch';
import { decontaminateStem } from '../pipeline/assemble';
import { revertTextRepairOverlays } from '../pipeline/textRepair';
import { formatSpans } from '../pipeline/spans';
import React, { useEffect, useRef, useState } from 'react';
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
import { retryFailedPage } from '../pipeline/pageRetry';
import { buildQuestionTree } from '../utils/questionTree';
import { computeSuggestions } from '../pipeline/suggestions';
import { computeQualityScore } from '../utils/qualityScore';
import { traceTimeline } from '../pipeline/provenance';
import { ConfirmCard, Modal } from '../design/primitives';

interface Props {
  examDoc: ExamDoc;
  rawFile?: File | null;
  settings: AppSettings;
  onUpdateDoc: (updated: ExamDoc) => void;
  onProceedToExamView: () => void;
  retryRequest?: number;
  onRetryRequestHandled?: () => void;
  /** B3 — orphan jump to Step 2 (only when the import is still open in this session). */
  onJumpToSource?: (lineNo: number) => void;
  initialExpandedSectionIds?: string[];
}

export const Step4Review: React.FC<Props> = (props) => {
  const [ready, setReady] = useState<{ input: ExamDoc; doc: ExamDoc } | null>(() =>
    props.examDoc.images.length === 0 ? { input: props.examDoc, doc: props.examDoc } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const imageIdentity = (doc: ExamDoc) => JSON.stringify(doc.images.map(image => [image.id, image.blobKey, Boolean(image.storageMissing), Boolean(image.dataUrl)]));
  const assetsReady =
    props.examDoc.images.length === 0 ||
    (ready?.input.id === props.examDoc.id && imageIdentity(ready.input) === imageIdentity(props.examDoc));
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (assetsReady) return;
    prepareReviewDocument(props.examDoc, getReviewImageBlob).then(doc => {
      if (cancelled) return;
      setReady({ input: props.examDoc, doc });
      const facts = (value: ExamDoc) => JSON.stringify([value.images.map(({ dataUrl, ...image }) => image), value.questions.map(q => q.images), value.flags]);
      if (facts(doc) !== facts(props.examDoc)) {
        props.onUpdateDoc(doc);
        void saveExamDoc(doc).catch(() => setError('The reviewed exam could not be saved; please try again.'));
      }
    })
      .catch(() => { if (!cancelled) setError('Image storage could not be checked. Please reopen this exam when storage is available.'); });
    return () => { cancelled = true; };
  }, [props.examDoc, assetsReady]);
  if (!assetsReady) return <p role="status" className="p-6">{error || 'Preparing your questions and images…'}</p>;
  // Keep editing state mounted on question/label edits; preserve dataUrl-free references for missing blobs.
  const readyDoc = ready?.doc || props.examDoc;
  const images = props.examDoc.images.map(image => {
    const resolved = readyDoc.images.find(asset => asset.id === image.id && asset.blobKey === image.blobKey);
    if (!resolved) return { ...image, dataUrl: undefined, storageMissing: true };
    const { storageMissing: _old, ...rest } = image;
    return {
      ...rest,
      dataUrl: resolved.dataUrl,
      ...(resolved.storageMissing ? { storageMissing: true } : {}),
    };
  });
  const absenceFlags = readyDoc.flags.filter(flag => flag.code === 'IMAGE_ASSET_ABSENT' && !props.examDoc.flags.some(existing => existing.id === flag.id));
  const reviewed = reconcileFinalFlags(repairImageReferences({ ...props.examDoc, images, flags: [...props.examDoc.flags, ...absenceFlags] }, props.examDoc.images));
  return <>{error && <p role="alert" className="p-4 text-[var(--danger)]">{error}</p>}<Step4ReviewContent {...props} examDoc={reviewed} /></>;

};

export const Step4ReviewContent: React.FC<Props> = ({
  examDoc,
  rawFile,
  settings,
  onUpdateDoc,
  onProceedToExamView,
  retryRequest = 0,
  onRetryRequestHandled,
  onJumpToSource,
  initialExpandedSectionIds,
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
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
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
  // Part C — ONE definition: the header sentence, the collapsed chip and the panel all read this.
  const attentionItems = computeAttention(examDoc);
  const attentionQuestionIdSet = new Set<string>(attentionQuestionIds(examDoc));

  // Part C — Calm by default: all sections start collapsed; ONLY questions with attention items auto-expand.
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set(initialExpandedSectionIds));
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(() => new Set(attentionQuestionIdSet));
  const [restoringImageId, setRestoringImageId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRestoreIdRef = useRef<string | null>(null);

  const toggleSection = (secId: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(secId)) next.delete(secId);
      else next.add(secId);
      return next;
    });
  };
  const handleRetryFailedPage = async (page: number) => {
    if (retryingCoverage) return;
    setRetryingCoverage(true);
    setRetryProgress(`Retrying page ${page}…`);
    setCoverageError(null);
    try {
      const result = await retryFailedPage(examDoc, page, settings, { onProgress: setRetryProgress });
      onUpdateDoc(result.doc);
      if (result.status === 'failed') setCoverageError(result.message);
      setRetryProgress('');
    } catch (error: any) {
      setCoverageError(error?.message || `Page ${page} retry failed. The exam remains visibly partial.`);
    } finally {
      setRetryingCoverage(false);
    }
  };

  // C3 — every attention row IS the button: scroll to + expand exactly that question, retry a failed page, or open the tray.
  const openAttentionItem = (item: AttentionItem) => {
    if (item.action.target === 'page-retry' && item.action.page) {
      void handleRetryFailedPage(item.action.page);
      return;
    }
    if (item.action.target === 'source-page' && item.action.lineNo) {
      onJumpToSource?.(item.action.lineNo);
      return;
    }
    if (item.action.target === 'image-tray') {
      setShowImageManager(true);
      setShowFlagsPanel(true);
      if (item.kind === 'image-unplaced') {
        document.getElementById('unplaced-images')?.scrollIntoView({ behavior: 'smooth' });
      } else if (typeof document !== 'undefined') {
        document.getElementById('image-manager')?.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }
    setShowFlagsPanel(true);
    const questionId = item.action.questionId;
    if (!questionId) {
      document.getElementById('review-issues')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    setExpandedQuestions(prev => new Set([...prev, questionId]));
    const question = examDoc.questions.find(candidate => candidate.id === questionId);
    if (question) setExpandedSections(prev => new Set([...prev, question.sectionId || sections[0].id]));
    document.getElementById(`review-q-${questionId}`)?.scrollIntoView({ behavior: 'smooth' });
  };

  const openAttentionSecondary = (item: AttentionItem) => {
    if (item.secondaryAction?.target === 'source-page' && item.secondaryAction.lineNo) {
      onJumpToSource?.(item.secondaryAction.lineNo);
    }
  };

  const toggleQuestionExpanded = (qId: string) => {
    setExpandedQuestions(prev => {
      const next = new Set(prev);
      if (next.has(qId)) next.delete(qId);
      else next.add(qId);
      return next;
    });
    setActiveQuestionId(prev => (prev === qId ? null : qId));
  };

  const missingBlobImages = examDoc.images.filter(img => img.storageMissing || !img.dataUrl);

  const runRestoreForImage = async (imageId: string, overrideFile?: File) => {
    setRestoringImageId(imageId);
    setRestoreError(null);
    try {
      let source: File | undefined = overrideFile || (rawFile && rawFile.type !== 'text/plain' ? rawFile : undefined);
      if (!source && examDoc.fileHash) {
        source = await getSourceFile(examDoc.fileHash, examDoc.source.fileName);
      }
      if (!source) {
        pendingRestoreIdRef.current = imageId;
        restoreFileInputRef.current?.click();
        setRestoringImageId(null);
        return;
      }
      const restored = await restoreMissingImageFromSource(examDoc, imageId, source);
      onUpdateDoc(restored);
      await saveExamDoc(restored);
    } catch (err: any) {
      setRestoreError(err?.message || `Could not restore image ${imageId} from source.`);
    } finally {
      setRestoringImageId(null);
    }
  };

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
  const lastRetryRequest = useRef(0);
  useEffect(() => {
    if (retryRequest <= lastRetryRequest.current) return;
    lastRetryRequest.current = retryRequest;
    onRetryRequestHandled?.();
    void handleRetryMissingCoverage();
  }, [retryRequest, onRetryRequestHandled]);

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

  // D — one-click revert of a model rewrite: drop the rewrite and re-slice the stem from the ORIGINAL lines.
  const handleRevertRewrite = (qId: string, lineNo?: number) => {
    const q = examDoc.questions.find(item => item.id === qId);
    if (!q) return;
    const remaining = (q.rewrites || []).filter(r => lineNo !== undefined && r.line !== lineNo);
    const stem = decontaminateStem(q.spans, (q.options || []).flatMap(o => o.spans || []), examDoc.source.lines, q.no, remaining.length ? remaining : undefined);
    const flags = remaining.length ? q.flags : (q.flags || []).filter(code => code !== 'REWRITE_APPLIED');
    handleUpdateQuestion(qId, { rewrites: remaining.length ? remaining : undefined, stem, flags });
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
      setSolverError(`Patch failed: ${err?.message || 'The provider request could not be completed.'}`);
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
      setSolverError(`AI Solve failed: ${err?.message || 'The provider request could not be completed.'}`);
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
      setSolverError(`Failed to solve question: ${err?.message || 'The provider request could not be completed.'}`);
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

  const handleRevertAllTextRepairs = () => {
    if (!Object.keys(examDoc.source.lineRepairs || {}).length) return;
    const updated = revertTextRepairOverlays(examDoc);
    onUpdateDoc(updated);
    saveExamDoc(updated);
  };

  return (
    <div className="max-w-6xl mx-auto py-6 px-4 space-y-6">
      <section className="p-4 rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] space-y-3">
        <h1 className="font-bold text-sm">{health.parsedCount} of {health.expectedCount} questions · {health.pointsParsed} of {health.pointsExpected ?? health.pointsParsed} points · {health.unplacedImages.length} images to place · {attentionItems.length} {attentionItems.length === 1 ? 'thing needs' : 'things need'} attention</h1>
        <button className="px-4 py-2 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)] text-xs font-semibold" onClick={() => {
          if (health.unplacedImages.length) document.getElementById('unplaced-images')?.scrollIntoView({ behavior: 'smooth' });
          else if (attentionItems.length || health.missing.length) { setShowFlagsPanel(true); document.getElementById('review-issues')?.scrollIntoView({ behavior: 'smooth' }); }
          else onProceedToExamView();
        }}>{health.unplacedImages.length ? 'Place images' : attentionItems.length || health.missing.length ? 'Review questions' : 'Preview & Print'}</button>
      </section>
      <details><summary className="cursor-pointer text-xs text-[var(--ink-2)]">Editing tools & exam details</summary>
      {/* Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-4 ">
        <div>
          <h1 className="text-sm font-bold text-[var(--ink)] ">
            Question Bank Review & Editor
          </h1>
          <p className="text-xs text-[var(--ink-2)]">
            {examDoc.questions.length} questions · {examDoc.sections.length} sections
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
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border font-medium transition cursor-pointer ${
                  missingCount > 0
                    ? 'bg-[var(--paper)]  border-[var(--accent)]  text-[var(--accent-ink)]  hover:bg-[var(--paper)]'
                    : 'border-[var(--rule)]  text-[var(--ink-2)] opacity-60'
                }`}
                title="Solve all questions lacking an answer with AI in 1 batched call"
              >
                <Sparkles className="w-3.5 h-3.5 text-[var(--accent-ink)]" />
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border border-[var(--rule)]  hover:bg-[var(--paper)]  font-medium transition cursor-pointer"
            title="Renumber all questions sequentially 1..N"
          >
            <ListOrdered className="w-3.5 h-3.5 text-[var(--accent-ink)]" />
            <span>Renumber</span>
          </button>

          <button
            onClick={() => setShowImageManager(!showImageManager)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border transition cursor-pointer ${
              showImageManager
                ? 'bg-[var(--paper)]  border-[var(--accent)]  text-[var(--accent-ink)] '
                : 'border-[var(--rule)]  hover:bg-[var(--paper)] '
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5 text-[var(--accent-ink)]" />
            <span>Images ({examDoc.images.length})</span>
          </button>

          <button
            onClick={() => setShowFlagsPanel(!showFlagsPanel)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border transition cursor-pointer ${
              showFlagsPanel && attentionItems.length > 0
                ? 'bg-[var(--warn-soft)]  border-[var(--warn)]  text-[var(--warn-ink)] '
                : 'border-[var(--rule)]  hover:bg-[var(--paper)] '
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-[var(--warn-ink)]" />
            <span data-attention-chip={attentionItems.length}>{attentionItems.length} {attentionItems.length === 1 ? 'thing needs' : 'things need'} attention</span>
          </button>

          <button
            onClick={onProceedToExamView}
            className="ep-directional-forward flex items-center gap-1.5 px-4 py-2 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] font-medium text-xs transition cursor-pointer  ms-2"
          >
            <span>Preview & Print Exam</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <ExamHealthBanner doc={examDoc} onJumpToSource={onJumpToSource} onExplainScore={(f)=> { if(f) setFilterType(f); setScoreExplain('Quality score: coverage 30 + points 15 + options 15 + images 15 + numbering 10 + confidence 6 + orphan lines 4 + passage 5'); }} />
      {Object.keys(examDoc.source.lineRepairs || {}).length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-[10px] border border-[var(--accent)] bg-[var(--paper-raised)] text-xs">
          <div><strong>{Object.keys(examDoc.source.lineRepairs || {}).length} Stage 2.75 text overlay(s)</strong> — proposed repairs are reversible; the original source lines remain stored and exported.</div>
          <div className="flex items-center gap-2">
            {onJumpToSource && <button type="button" onClick={() => onJumpToSource(Number(Object.keys(examDoc.source.lineRepairs || {})[0]))} className="px-2.5 py-1 rounded-[6px] border border-[var(--rule)]">Inspect first line</button>}
            <button type="button" onClick={handleRevertAllTextRepairs} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] border border-[var(--danger)] text-[var(--danger)]"><RotateCcw className="w-3 h-3" /> Revert all</button>
          </div>
        </div>
      )}
      </details>
      {/* Proactive suggestions (F1): silent-by-default, dismissible, ≤3 chips */}
      {(() => {
        const chips = computeSuggestions(examDoc).filter(c=> !dismissedChips.has(c.id));
        if (chips.length===0) return null;
        return <div className="flex flex-wrap gap-2">{chips.map(c=> (
          <span key={c.id} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-[10px] bg-[var(--accent)] text-[var(--on-accent)] text-xs">
            <button onClick={()=> {
              if (c.id==='missing') handleRetryMissingCoverage();
              else if (c.id==='unplaced') setShowImageManager(true);
              else if (c.id==='quality') setScoreExplain((()=>{ const q=computeQualityScore(examDoc); return `Coverage ${q.coverage}/30, Points ${q.points}/15, Options ${q.optionsCleanliness}/15, Images ${q.imagePlacement}/15, Numbering ${q.numbering}/10, Confidence ${q.confidence}/6, Orphan lines ${q.orphan}/4, Passage ${q.passage}/5 = Total ${q.total}/100`; })());
            }} className="font-medium hover:underline cursor-pointer">{c.label}</button>
            <button onClick={()=> setDismissedChips(s=> new Set([...s, c.id]))} className="opacity-80 hover:opacity-100 cursor-pointer"><X className="w-3 h-3" /></button>
          </span>
        ))}</div>;
      })()}
      {scoreExplain && <div className="rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  p-3 text-xs flex items-center justify-between"><span>{scoreExplain}</span><button onClick={()=> setScoreExplain(null)} className="text-[var(--ink-2)] hover:text-[var(--ink-2)]"><X className="w-4 h-4" /></button></div>}
      {/* Bulk ops bar (D2) — confirm destructive */}
      {selectedIds.size>0 && (
        <div role="toolbar" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 p-2 rounded-[10px] border bg-[var(--paper)]  text-xs">
          <span className="font-semibold">{selectedIds.size} selected</span>
          <label className="flex items-center gap-1">Points <input type="number" min={0} max={50} step={1} value={bulkPts} onChange={e=> setBulkPts(Number(e.target.value))} className="w-16 px-1 py-0.5 rounded-[6px] border text-xs" /></label>
          <button onClick={()=> { const {doc:next, undo}=applyBulk(examDoc, [...selectedIds], {type:'setPoints', points:bulkPts}); setUndoSnapshot(undo); onUpdateDoc(next); saveExamDoc(next); }} className="px-2 py-1 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)] text-xs">Set points</button>
          <button onClick={()=> setPendingBulkDelete(true)} className="px-2 py-1 rounded-[6px] border border-[var(--danger)] text-[var(--danger)] text-xs">Delete</button>
          <button onClick={()=> { const exp=exportSelected(examDoc, [...selectedIds]); const blob=new Blob([JSON.stringify(exp.json,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='selected.json'; a.click(); URL.revokeObjectURL(url); }} className="px-2 py-1 rounded-[6px] border text-xs">Export selected</button>
          {undoSnapshot && <button onClick={()=> { const prev=JSON.parse(undoSnapshot); onUpdateDoc(prev); saveExamDoc(prev); setUndoSnapshot(null); }} className="px-2 py-1 rounded-[6px] border text-xs font-semibold">Undo</button>}
          <button onClick={()=> setSelectedIds(new Set())} className="px-2 py-1 rounded-[6px] border text-xs">Clear</button>
        </div>
      )}
      {pendingBulkDelete && <ConfirmCard title={settings.uiLanguage === 'fa' ? 'حذف پرسش‌های انتخاب‌شده؟' : 'Delete selected questions?'} description={settings.uiLanguage === 'fa' ? `تعداد ${selectedIds.size} پرسش حذف می‌شود. این تغییر قابل بازگردانی است.` : `${selectedIds.size} selected question(s) will be removed. This change can be undone.`} confirmLabel={settings.uiLanguage === 'fa' ? 'حذف پرسش‌ها' : 'Delete questions'} cancelLabel={settings.uiLanguage === 'fa' ? 'لغو' : 'Cancel'} danger onConfirm={() => { const { doc: next, undo } = applyBulk(examDoc, [...selectedIds], { type: 'delete' }); setUndoSnapshot(undo); onUpdateDoc(next); saveExamDoc(next); setSelectedIds(new Set()); setPendingBulkDelete(false); }} onCancel={() => setPendingBulkDelete(false)} />}
      {undoSnapshot && selectedIds.size===0 && <div className="text-xs flex items-center gap-2"><span>Bulk change applied.</span><button onClick={()=> { const prev=JSON.parse(undoSnapshot); onUpdateDoc(prev); saveExamDoc(prev); setUndoSnapshot(null); }} className="px-2 py-1 rounded-[6px] border text-xs font-semibold">Undo</button></div>}
      {health.missing.length > 0 && (
        <details><summary className="cursor-pointer text-xs">Coverage details</summary>
        <div className="rounded-[10px] border border-[var(--danger)] bg-[var(--danger-soft)] p-4 text-xs text-[var(--danger)]   ">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><strong>PARTIAL COVERAGE — {health.missing.length} expected question(s) are missing.</strong><div className="mt-1">Missing printed numbers: {health.missing.join(', ')}. This document remains incomplete and exports require confirmation.</div></div>
            <button disabled={retryingCoverage} onClick={handleRetryMissingCoverage} className="rounded-[6px] bg-[var(--danger)] px-3 py-2 font-semibold text-[var(--on-accent)] disabled:opacity-50">
              {retryingCoverage ? 'Recovering…' : 'Retry missing questions'}
            </button>
          </div>
          {retryProgress && <div role="status" className="mt-2 font-mono">{retryProgress}</div>}
          {coverageError && <div role="alert" className="mt-2 font-semibold">{coverageError}</div>}
        </div>
        </details>
      )}
      <input
        ref={restoreFileInputRef}
        type="file"
        accept=".pdf,.docx,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={event => {
          const picked = event.target.files?.[0];
          const targetId = pendingRestoreIdRef.current;
          pendingRestoreIdRef.current = null;
          event.currentTarget.value = '';
          if (picked && targetId) void runRestoreForImage(targetId, picked);
        }}
      />
      {missingBlobImages.length > 0 && (
        <section data-missing-images-tray="true" className="rounded-[10px] border border-[var(--warn)] bg-[var(--warn-soft)] p-4 text-xs space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold text-[var(--warn-ink)]">
              Missing image blobs ({missingBlobImages.length}) — restore individually from source
            </h2>
          </div>
          {restoreError && <div role="alert" className="text-[var(--danger)] font-medium">{restoreError}</div>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {missingBlobImages.map(image => (
              <div key={image.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--warn)] bg-[var(--paper-raised)] p-3">
                <div className="min-w-0">
                  <div className="font-mono font-bold text-[var(--ink)]">{image.id} · page {image.page}</div>
                  <div className="truncate text-[var(--ink-2)]">{image.label?.questionRef ? `Q${image.label.questionRef}` : 'Unassigned'} · {image.width}×{image.height}</div>
                </div>
                <button
                  type="button"
                  disabled={restoringImageId === image.id}
                  onClick={() => void runRestoreForImage(image.id)}
                  className="shrink-0 rounded-[6px] border border-[var(--accent)] bg-[var(--paper)] px-2.5 py-1.5 font-semibold text-[var(--accent-ink)] hover:bg-[var(--paper-raised)] disabled:opacity-50 cursor-pointer"
                >
                  {restoringImageId === image.id ? 'Restoring…' : 'Restore from source'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {health.unplacedImages.length > 0 && (
        <section className="rounded-[10px] border border-[var(--warn)] bg-[var(--warn-soft)] p-4 text-xs  ">
          <h2 id="unplaced-images" className="font-bold text-[var(--warn-ink)] ">Unplaced image assets ({health.unplacedImages.length}) — none are hidden</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{health.unplacedImages.map(image => (
            <div key={image.id} className="flex gap-3 rounded-[10px] border border-[var(--warn)] bg-[var(--paper-raised)] p-2  ">
              <img src={image.dataUrl} alt={image.label?.caption || image.id} className="h-16 w-20 object-contain rounded-[6px] bg-[var(--paper)]" />
              <div className="min-w-0 flex-1"><div className="font-mono font-bold">{image.id} · page {image.page}</div><div className="truncate text-[var(--ink-2)]">{image.label?.caption || 'Unassigned extracted image'}</div><label className="mt-1 block text-[length:var(--type-12)]">Assign to question<select value="" onChange={event => event.target.value && handleAssignImage(image.id, event.target.value)} className="mt-1 w-full rounded-[6px] border border-[var(--warn)] bg-[var(--paper-raised)] p-1 "><option value="">Choose question…</option>{examDoc.questions.filter(question => !question.parentId).map(question => <option key={question.id} value={question.id}>Q{question.label} — {(question.stem || '').slice(0, 60)}</option>)}</select></label></div>
            </div>
          ))}</div>
        </section>
      )}

      {/* Solver Budget Stop Banner */}
      {solverError && (
        <div className="p-4 rounded-[10px] border border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]  flex items-start gap-3 text-xs">
          <ShieldAlert className="w-5 h-5 shrink-0 text-[var(--danger)] mt-0.5" />
          <div className="flex-1 space-y-1">
            <span className="font-bold">Budget / Execution Stop:</span>
            <p>{solverError}</p>
          </div>
          <button onClick={() => setSolverError(null)} className="text-[var(--danger)] hover:text-[var(--danger)]">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div id="review-issues">{showFlagsPanel && <IntegrityFlags doc={examDoc} onOpenItem={openAttentionItem} onSecondaryAction={openAttentionSecondary} />}</div>

      {/* 2F Provenance — per-question Trace disclosure + 2B critic verdict badges */}
      {(((examDoc as any).traces?.length || Object.keys((examDoc as any).verdicts || {}).length) ? (
        <details className="bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-4 space-y-2 text-xs">
          <summary className="cursor-pointer font-bold text-[var(--ink)] ">Provenance — Trace & Critic verdicts</summary>
          <div className="space-y-1.5">
            {examDoc.questions.map(q => {
              const trace = ((examDoc as any).traces || []).find((t: any) => t.questionId === q.id);
              const verdicts = ((examDoc as any).verdicts || {})[q.id] || [];
              if (!trace && !verdicts.length) return null;
              return (
                <details key={q.id} className="rounded-[10px] border border-[var(--rule)]  p-2.5">
                  <summary className="cursor-pointer font-medium text-[var(--ink)] ">
                    Trace — Q{q.no}
                    {verdicts.map((v: any, i: number) => (
                      <span key={i} className={`ms-2 text-[length:var(--type-12)] font-mono px-1.5 py-0.5 rounded-[6px] uppercase ${v.verdict === 'defect' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--ok-soft)] text-[var(--ok)]'}`}>critic: {v.verdict}{v.defectKind ? ` · ${v.defectKind}` : ''} → {v.suggestedAction}</span>
                    ))}
                  </summary>
                  {trace ? traceTimeline(trace).map((line: any, i: number) => (
                    <div key={i} className="mt-1.5 text-[var(--ink-2)] ">
                      <div>{line.en}</div>
                      <div dir="rtl" className="text-[var(--ink-2)]">{line.fa}</div>
                    </div>
                  )) : <div className="mt-1.5 text-[var(--ink-2)]">No trace recorded for this question.</div>}
                  {verdicts.map((v: any, i: number) => <div key={`v${i}`} className="mt-1 text-[var(--ink-2)]">Critic note: {v.note}</div>)}
                  {q.spans?.length ? <div className="mt-1 text-[var(--ink-2)]">Source: lines {formatSpans(q.spans)} (Step 2)</div> : null}
                </details>
              );
            })}
          </div>
        </details>
      ) : null)}

      {/* Local Image Manager Modal / Panel */}
      {showImageManager && (
        <div id="image-manager" className="bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-4 space-y-4  text-xs">
          <div className="flex justify-between items-center pb-2 border-b border-[var(--rule)] ">
            <div>
              <h3 className="font-bold text-[var(--ink)]  flex items-center gap-1.5">
                <ImageIcon className="w-4 h-4 text-[var(--accent-ink)]" /> Local Image Manager
              </h3>
              <p className="text-[length:var(--type-12)] text-[var(--ink-2)]">
                Reassign images to questions or mark as decoration locally (0 API calls)
              </p>
            </div>
            <button onClick={() => setShowImageManager(false)} className="text-[var(--ink-2)] hover:text-[var(--ink-2)]">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {examDoc.images.map(img => (
              <div
                key={img.id}
                className="p-3 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-2"
              >
                {img.dataUrl ? (
                  <img
                    src={img.dataUrl}
                    alt={img.id}
                    className="w-full h-28 object-contain rounded-[10px] bg-[var(--paper-raised)] border border-[var(--rule)] "
                  />
                ) : (
                  <div className="w-full h-28 rounded-[10px] bg-[var(--paper)] flex flex-col items-center justify-center gap-2 text-[var(--ink-2)] p-2">
                    <span>Image {img.id} (missing blob)</span>
                    <button
                      type="button"
                      disabled={restoringImageId === img.id}
                      onClick={() => void runRestoreForImage(img.id)}
                      className="rounded-[6px] border border-[var(--accent)] bg-[var(--paper-raised)] px-2 py-1 text-[length:var(--type-12)] font-semibold text-[var(--accent-ink)] cursor-pointer"
                    >
                      {restoringImageId === img.id ? 'Restoring…' : 'Restore from source'}
                    </button>
                  </div>
                )}

                <div className="space-y-1">
                  <div className="flex justify-between items-center font-mono text-[length:var(--type-12)] text-[var(--ink-2)]">
                    <span>{img.id} (P{img.page})</span>
                    <span>{img.width}×{img.height}</span>
                  </div>
                  {img.label?.assignment && (
                    <div data-image-assignment-rule={img.label.assignment.ruleChain.join('>')} className="text-[length:var(--type-12)] text-[var(--ink-2)]">
                      {img.label.caption ? `"${img.label.caption}" · ` : ''}{img.label.assignment.ruleChain.join(' → ')}{img.label.assignment.note ? ` · ${img.label.assignment.note}` : ''}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <select
                      value={img.label?.role || 'stem'}
                      onChange={e => handleReassignImage(img.id, { role: e.target.value })}
                      className="px-2 py-1 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-[length:var(--type-12)] flex-1"
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
                      className="w-16 px-2 py-1 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-[length:var(--type-12)] font-mono"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Question Cards by Section (Part C: Sections collapsed by default; calm review cards) */}
      <div className="flex items-center justify-between text-xs text-[var(--ink-2)]">
        <span>{sections.length} section(s) · click a section to expand its questions</span>
        <button
          type="button"
          onClick={() => {
            const allOpen = sections.every(s => expandedSections.has(s.id));
            setExpandedSections(allOpen ? new Set() : new Set(sections.map(s => s.id)));
          }}
          className="px-2.5 py-1 rounded-[6px] border border-[var(--rule)] bg-[var(--paper-raised)] text-[var(--ink)] font-medium cursor-pointer"
        >
          {sections.every(s => expandedSections.has(s.id)) ? 'Collapse all sections' : 'Expand all sections'}
        </button>
      </div>
      <div className="space-y-3">
        {sections.map(sec => {
          const secQuestions = questionsBySection[sec.id] || [];
          const hierarchy = buildQuestionTree(secQuestions);
          const rootQuestions = hierarchy.roots;
          const renderNestedChildren = (parentId: string, depth = 1): React.ReactNode => {
            const children = hierarchy.children.get(parentId) || [];
            if (!children.length) return null;
            return <div className={`${depth === 1 ? 'ms-4 border-s-2 border-[var(--accent)] ps-3 ' : 'ms-4 border-s border-[var(--accent)] ps-3 '} space-y-2`}>
              {children.map((child, childIndex) => {
                const childExpanded = expandedQuestions.has(child.id) || activeQuestionId === child.id;
                return <div key={child.id} id={`review-q-${child.id}`} data-review-question={child.id} className="rounded-[10px] border border-[var(--accent)] bg-[var(--paper)] p-3 text-xs  ">
                  <div className="flex items-start justify-between gap-2"><div className="flex items-start gap-2"><span className="rounded-[6px] bg-[var(--paper)] px-1.5 py-0.5 font-mono font-bold text-[var(--accent-ink)]  ">{String.fromCharCode(97 + childIndex % 26)}) · {child.label}</span>{child.points !== undefined && <span className="font-mono text-[var(--ok)]">{child.points} pts</span>}{childExpanded && <span className="text-[length:var(--type-12)] text-[var(--ink-2)]">{((child.confidence ?? 1) * 100).toFixed(0)}% confidence · {formatSpans(child.spans)}</span>}</div><button onClick={() => toggleQuestionExpanded(child.id)} className="text-[length:var(--type-12)] font-semibold text-[var(--accent-ink)] underline ">{childExpanded ? 'Close edit' : 'Inspect / Edit'}</button></div>
                  {childExpanded ? <textarea rows={2} value={child.stem || ''} onChange={event => handleUpdateQuestion(child.id, { stem: event.target.value })} className="mt-2 w-full rounded-[6px] border border-[var(--accent)] bg-[var(--paper-raised)] p-2 " /> : <div dir="auto" className="mt-2 whitespace-pre-wrap">{child.stem}</div>}
                  {(child.options || []).length > 0 && <div className="mt-2 grid gap-1 sm:grid-cols-2">{child.options?.map(option => <div key={option.key}><b>{option.key}.</b> {option.text}</div>)}</div>}
                  {child.answer?.text && <div className="mt-2 border-t border-[var(--accent)] pt-2"><b>Answer:</b> {child.answer.text}</div>}
                  {renderNestedChildren(child.id, depth + 1)}
                </div>;
              })}
            </div>;
          };
          if (secQuestions.length === 0 && !sec.passage) return null;

          const secPoints = sec.points !== undefined
            ? sec.points
            : Number(secQuestions.reduce((sum, q) => sum + (q.points || 0), 0).toFixed(2));
          const secAttentionCount = secQuestions.filter(q => attentionQuestionIdSet.has(q.id)).length;
          const isSectionExpanded = expandedSections.has(sec.id) || filterType !== 'all';

          return (
            <div key={sec.id} data-review-section={sec.id} className="rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)]">
              {(hierarchy.cycleBreaks.size > 0 || hierarchy.orphanedParents.size > 0) && <div role="status" className="m-3 rounded-[10px] border border-[var(--warn)] bg-[var(--warn-soft)] p-2 text-[length:var(--type-12)] text-[var(--warn-ink)]   ">Invalid nested-question links were flattened so all {hierarchy.cycleBreaks.size + hierarchy.orphanedParents.size} affected question(s) remain visible.</div>}
              {/* Section Header (collapsed by default) */}
              <button
                type="button"
                aria-expanded={isSectionExpanded}
                onClick={() => toggleSection(sec.id)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-start cursor-pointer hover:bg-[var(--paper)] rounded-[10px] transition"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {secAttentionCount > 0 && (
                    <span
                      data-attention-dot="true"
                      aria-label="Section has items needing attention"
                      className="w-2.5 h-2.5 rounded-full bg-[var(--warn)] shrink-0"
                    />
                  )}
                  <h2 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider truncate">
                    {sec.title || `Section ${sec.index}`}
                  </h2>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-[length:var(--type-12)] font-mono text-[var(--ink-2)]">
                  <span>{secQuestions.length} question(s)</span>
                  <span>·</span>
                  <span>{secPoints} pts</span>
                  <span>·</span>
                  <span className={secAttentionCount > 0 ? 'font-semibold text-[var(--warn-ink)]' : ''}>
                    {secAttentionCount} attention
                  </span>
                  {isSectionExpanded ? <ChevronUp className="w-4 h-4 text-[var(--ink-2)]" /> : <ChevronDown className="w-4 h-4 text-[var(--ink-2)]" />}
                </div>
              </button>

              {isSectionExpanded && (
                <div className="px-4 pb-4 pt-1 space-y-3 border-t border-[var(--rule)]">
                  {sec.instructions && <p dir="auto" className="text-[length:var(--type-12)] text-[var(--ink-2)] italic">{sec.instructions}</p>}
                  {sec.passage && <div dir="auto" className="max-w-4xl max-h-60 overflow-y-auto whitespace-pre-wrap rounded-[10px] border border-[var(--rule)] bg-[var(--paper)] p-3 text-xs leading-relaxed text-[var(--ink)]">{sec.passage}</div>}

                  {/* Question Cards List */}
                  <div className="space-y-3">
                    {rootQuestions.map(q => {
                      const hasAttention = attentionQuestionIdSet.has(q.id);
                      const isExpanded = expandedQuestions.has(q.id) || activeQuestionId === q.id;
                      const groupChildren = hierarchy.children.get(q.id) || [];
                      const showChildren = Boolean(expandedGroups[q.id]);

                      return (
                        <div
                          key={q.id}
                          id={`review-q-${q.id}`}
                          data-review-question={q.id}
                          data-question-expanded={isExpanded ? 'true' : 'false'}
                          tabIndex={-1}
                          className="bg-[var(--paper)] border border-[var(--rule)] rounded-[10px] p-4 space-y-2.5 transition hover:border-[var(--rule-strong)]"
                        >
                          {/* Question Header Row (Calm Review Form: number, type chip, points, actions) */}
                          <div className="flex items-center justify-between gap-3 text-xs">
                            <div className="flex items-center gap-2 flex-wrap">
                              <input type="checkbox" checked={selectedIds.has(q.id)} onChange={e=> setSelectedIds(s=> { const n=new Set(s); if(e.target.checked) n.add(q.id); else n.delete(q.id); return n; })} className="w-3.5 h-3.5" />
                              <span className="w-7 h-7 rounded-[10px] bg-[var(--paper-raised)] text-[var(--accent-ink)] font-bold flex items-center justify-center font-mono">
                                {q.label}
                              </span>

                              <span className="px-2 py-0.5 rounded-[6px] text-[length:var(--type-12)] font-mono uppercase bg-[var(--paper-raised)] text-[var(--ink-2)]">
                                {q.type}
                              </span>

                              {q.points !== undefined && (
                                <span className="px-2 py-0.5 rounded-[6px] text-[length:var(--type-12)] font-mono bg-[var(--ok-soft)] text-[var(--ok)] font-semibold">
                                  {q.points} pts
                                </span>
                              )}

                              {hasAttention && (
                                <span
                                  data-question-attention-dot="true"
                                  title="Needs attention"
                                  className="w-2 h-2 rounded-full bg-[var(--warn)] inline-block"
                                />
                              )}

                              {groupChildren.length > 0 && <button onClick={() => setExpandedGroups(current => ({ ...current, [q.id]: !current[q.id] }))} className="rounded-[6px] bg-[var(--paper-raised)] px-2 py-1 text-[length:var(--type-12)] font-semibold text-[var(--accent-ink)]">{groupChildren.length} subquestion(s) {showChildren ? '▲' : '▼'}</button>}
                            </div>

                            {/* Question Action Buttons */}
                            <div className="flex items-center gap-1.5">
                              {/* Solve single with AI */}
                              <button
                                disabled={solvingQuestionId === q.id}
                                onClick={() => handleSolveSingle(q)}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-[6px] bg-[var(--paper-raised)] border border-[var(--accent)] text-[var(--accent-ink)] text-[length:var(--type-12)] font-medium hover:bg-[var(--paper)] transition cursor-pointer"
                                title="Solve or regenerate answer for this question with AI"
                              >
                                <Sparkles className="w-3 h-3 text-[var(--accent-ink)]" />
                                <span>{solvingQuestionId === q.id ? 'Solving...' : q.answer?.text ? 'Re-solve' : 'AI Solve'}</span>
                              </button>

                              {/* Minimal-Patch Regeneration Button (§5.4) */}
                              <button
                                onClick={() => {
                                  setPatchModalQuestion(q);
                                  setPatchDiffResult(null);
                                  setPatchInstruction('');
                                }}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-[6px] bg-[var(--warn-soft)] border border-[var(--warn)] text-[var(--warn-ink)] text-[length:var(--type-12)] font-medium hover:bg-[var(--warn-soft)] transition cursor-pointer"
                                title={settings.uiLanguage === 'fa' ? 'بازسازی همین پرسش با وصلهٔ کمینهٔ RFC 7386' : 'Regenerate this single question using minimal RFC 7386 JSON Merge Patch'}
                              >
                                <Sparkles className="w-3 h-3 text-[var(--warn-ink)]" />
                                <span>{settings.uiLanguage === 'fa' ? 'وصله' : 'Patch'}</span>
                              </button>

                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? `Collapse inspector for question ${q.label}` : `Expand inspector for question ${q.label}`}
                                onClick={() => toggleQuestionExpanded(q.id)}
                                className="p-1.5 text-[var(--ink-2)] hover:text-[var(--ink)] rounded-[6px] hover:bg-[var(--paper-raised)] transition cursor-pointer"
                              >
                                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              </button>

                              <button
                                onClick={() => handleDeleteQuestion(q.id)}
                                className="p-1.5 text-[var(--ink-2)] hover:text-[var(--danger)] rounded-[6px] hover:bg-[var(--danger-soft)] transition cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          {/* Inspector Internals (spans, confidence %, Built-by receipt, per-question flags) — shown ONLY when expanded */}
                          {isExpanded && (
                            <div data-question-internals={q.id} className="flex flex-wrap items-center gap-2 rounded-[6px] border border-[var(--rule)] bg-[var(--paper-raised)] px-2.5 py-1.5 text-[length:var(--type-12)] font-mono text-[var(--ink-2)]">
                              <span>spans: {formatSpans(q.spans)}</span>
                              <span
                                className={`px-1.5 py-0.5 rounded-[6px] ${
                                  q.confidence >= 0.8
                                    ? 'bg-[var(--ok-soft)] text-[var(--ok)]'
                                    : 'bg-[var(--warn-soft)] text-[var(--warn-ink)]'
                                }`}
                              >
                                {((q.confidence ?? 1) * 100).toFixed(0)}% conf
                              </span>
                              {q.receipt && (
                                <span aria-label="Deterministic parse provenance">
                                  Built by: {q.receipt.ruleChain.map(rule => rule === 'question-start' ? 'seg-number' : rule === 'watermark-excised' ? 'excision' : rule).join(' → ')} · conf {Math.round(q.receipt.ruleConfidence)}
                                </span>
                              )}

                            </div>
                          )}

                          {/* Stem Text */}
                          <div>
                            {isExpanded ? (
                              <textarea
                                rows={3}
                                value={q.stem || ''}
                                onChange={e => handleUpdateQuestion(q.id, { stem: e.target.value })}
                                className="w-full p-2.5 rounded-[6px] border border-[var(--rule)] bg-[var(--paper-raised)] text-xs font-sans text-[var(--ink)]"
                              />
                            ) : (
                              <div dir="auto" className="max-h-56 overflow-y-auto text-xs text-[var(--ink)] whitespace-pre-wrap leading-relaxed">
                                {q.stem}
                              </div>
                            )}
                            {/* D — rewrites are rendering-only: show original ⮕ rewrite with one-click revert when expanded */}
                            {isExpanded && (q.rewrites || []).length > 0 && (
                              <div className="mt-1.5 space-y-1 rounded-[6px] border border-[var(--warn)] bg-[var(--warn-soft)] p-2 text-[length:var(--type-12)] text-[var(--warn-ink)]">
                                <div className="font-semibold">REWRITE_APPLIED — {(q.rewrites || []).length} garbled line(s) rendered from the model's rewrite (original retained)</div>
                                {(q.rewrites || []).map(r => {
                                  const original = examDoc.source.lines.find(l => Number(l.id.replace(/\D/g, '')) === r.line)?.text || '';
                                  return (
                                    <div key={r.line} className="flex items-start gap-2">
                                      <span className="font-mono shrink-0">L{String(r.line).padStart(4, '0')}</span>
                                      <span className="min-w-0 flex-1 break-words"><span className="line-through opacity-70">{original}</span> ⮕ <span className="font-medium">{r.text}</span></span>
                                      <button onClick={() => handleRevertRewrite(q.id, r.line)} className="shrink-0 rounded-[4px] border border-[var(--warn)] px-1.5 py-0.5 hover:bg-[var(--paper)]">Revert</button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          {/* Word Bank (when present on fill-in-the-blank items) */}
                          {q.wordBank && q.wordBank.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--type-12)] text-[var(--ink-2)]">
                              <span className="font-semibold">Word bank:</span>
                              {q.wordBank.map(word => (
                                <span key={word} className="px-2 py-0.5 rounded-[6px] border border-[var(--rule)] bg-[var(--paper-raised)] font-mono text-[var(--ink)]">{word}</span>
                              ))}
                            </div>
                          )}

                          {/* Attached Diagram / Image */}
                          {q.images && q.images.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1">
                              {q.images.map(imgRef => {
                                const asset = examDoc.images.find(i => i.id === imgRef.imageId);
                                if (!asset || !asset.dataUrl || asset.storageMissing) return (
                                  <div key={imgRef.imageId} className="flex items-center gap-2 rounded-[10px] border-2 border-dashed border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-[length:var(--type-12)] text-[var(--warn-ink)]">
                                    <span>Missing image {imgRef.imageId} (page {asset?.page ?? 'unknown'})</span>
                                    {asset && (
                                      <button
                                        type="button"
                                        disabled={restoringImageId === asset.id}
                                        onClick={() => void runRestoreForImage(asset.id)}
                                        className="rounded-[6px] border border-[var(--accent)] bg-[var(--paper-raised)] px-2 py-0.5 font-semibold text-[var(--accent-ink)] cursor-pointer"
                                      >
                                        {restoringImageId === asset.id ? 'Restoring…' : 'Restore from source'}
                                      </button>
                                    )}
                                  </div>
                                );
                                return (
                                  <div
                                    key={imgRef.imageId}
                                    className="relative rounded-[10px] border border-[var(--rule)] p-1 bg-[var(--paper-raised)] inline-block"
                                  >
                                    <img
                                      src={asset.dataUrl}
                                      alt={asset.id}
                                      onError={event => { event.currentTarget.style.display = 'none'; const fallback = event.currentTarget.parentElement?.querySelector('[data-image-error]') as HTMLElement | null; if (fallback) fallback.hidden = false; }}
                                      className="max-h-24 rounded-[10px] object-contain bg-[var(--paper-raised)]"
                                    />
                                    <div hidden data-image-error className="p-2 text-[length:var(--type-12)] text-[var(--warn-ink)]">Image unavailable — open original page {asset.page}.</div>
                                    <span className="absolute bottom-1 end-1 text-[length:var(--type-12)] font-mono px-1 rounded-[6px] ep-scrim text-[var(--scrim-fg)]">
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
                                  className="flex items-center gap-2 p-2 rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)]"
                                >
                                  <span className="w-5 h-5 rounded-[10px] bg-[var(--paper)] text-[var(--ink)] font-bold flex items-center justify-center text-[length:var(--type-12)] shrink-0 font-mono">
                                    {opt.key}
                                  </span>
                                  <span className="text-[var(--ink)] truncate">
                                    {opt.text}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Answer Key preview with Origin Badge & Inline Edit */}
                          <div className="pt-1">
                            {q.answer && q.answer.text ? (
                              <div className="text-[length:var(--type-12)] bg-[var(--paper-raised)] p-2.5 rounded-[10px] border border-[var(--rule)] space-y-1.5">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-[var(--ink)]">Answer:</span>
                                    <span
                                      className={`text-[length:var(--type-12)] font-mono px-1.5 py-0.5 rounded-[6px] font-semibold uppercase ${
                                        q.answer.source === 'paper'
                                          ? 'bg-[var(--ok-soft)] text-[var(--ok)] border border-[var(--ok)]'
                                          : q.answer.source === 'keyfile'
                                          ? 'bg-[var(--paper)] text-[var(--accent-ink)] border border-[var(--accent)]'
                                          : q.answer.source === 'ai'
                                          ? 'bg-[var(--paper)] text-[var(--accent-ink)] border border-[var(--accent)]'
                                          : 'bg-[var(--warn-soft)] text-[var(--warn-ink)] border border-[var(--warn)]'
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
                                    className="w-full p-2 rounded-[6px] border border-[var(--rule)] bg-[var(--paper)] text-xs font-mono"
                                  />
                                ) : (
                                  <div className="text-[var(--ink)] font-medium whitespace-pre-wrap">
                                    {q.answer.text}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center justify-between p-2 rounded-[10px] border border-dashed border-[var(--rule-strong)] text-[length:var(--type-12)] text-[var(--ink-2)]">
                                <span>No answer linked yet</span>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => handleSolveSingle(q)}
                                    className="text-[var(--accent-ink)] hover:underline cursor-pointer flex items-center gap-1 font-medium"
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
                                    className="text-[var(--accent-ink)] hover:underline cursor-pointer"
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
              )}
            </div>
          );
        })}
      </div>

      {/* Minimal-Patch Regeneration Modal (§5.4) */}
      {patchModalQuestion && (
        <Modal open onClose={() => { setPatchModalQuestion(null); setPatchDiffResult(null); }} title={settings.uiLanguage === 'fa' ? 'بازسازی پرسش' : 'Regenerate question'} labelledBy="patch-question-title" className="ep-patch-window">
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--rule)] ">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[var(--warn-ink)]" />
                <h3 id="patch-question-title" className="font-bold text-sm text-[var(--ink)] ">
                  {settings.uiLanguage === 'fa' ? `بازسازی پرسش ${patchModalQuestion.label}` : `Regenerate Question #${patchModalQuestion.label} (RFC 7386 Patch)`}
                </h3>
              </div>
              <button
                type="button"
                aria-label={settings.uiLanguage === 'fa' ? 'بستن پنجره بازسازی' : 'Close regeneration dialog'}
                onClick={() => {
                  setPatchModalQuestion(null);
                  setPatchDiffResult(null);
                }}
                className="text-[var(--ink-2)] hover:text-[var(--ink-2)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[var(--ink-2)] leading-relaxed">
              {settings.uiLanguage === 'fa'
                ? 'فقط برش منبع همین پرسش و پنج خط پیرامون آن (حدود ۱۰۰۰ توکن) ارسال می‌شود؛ مدل یک وصله JSON برمی‌گرداند، نه بازتحلیل کل سند.'
                : 'Sends only this question’s source slice and five context lines (~1k tokens). The model returns a JSON merge patch instead of re-running the document.'}
            </p>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[var(--ink)] ">
                {settings.uiLanguage === 'fa' ? 'دستور برای هوش مصنوعی (اختیاری)' : 'Instruction for AI (optional)'}
              </label>
              <input
                type="text"
                placeholder={settings.uiLanguage === 'fa' ? 'مثلاً: ریاضی را با LaTeX یکدست کن یا گزینه‌ها را دوباره تشخیص بده' : 'E.g., normalize math with LaTeX or re-detect MCQ options'}
                value={patchInstruction}
                onChange={e => setPatchInstruction(e.target.value)}
                className="w-full px-3 py-2 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper)]  text-xs font-sans"
              />
            </div>

            {/* Diff Preview */}
            {patchDiffResult && (
              <div className="space-y-2 p-3.5 rounded-[10px] bg-[var(--paper)]  border border-[var(--rule)]  text-xs font-mono">
                <div className="font-bold text-[var(--ok)] flex items-center justify-between">
                  <span>{settings.uiLanguage === 'fa' ? `وصله دریافت شد (${patchDiffResult.usage?.inputTokens || 0} توکن):` : `Patch received (${patchDiffResult.usage?.inputTokens || 0} tokens):`}</span>
                  <span>{settings.uiLanguage === 'fa' ? 'صرفه‌جویی توکن: حدود ۹۲٪' : 'Tokens saved: ~92%'}</span>
                </div>
                <div className="space-y-1 text-[length:var(--type-12)] text-[var(--ink)]  max-h-36 overflow-y-auto">
                  {patchDiffResult.diffSummary.length > 0 ? (
                    patchDiffResult.diffSummary.map((d, i) => (
                      <div key={i} className="text-[var(--accent-ink)] ">
                        {d}
                      </div>
                    ))
                  ) : (
                    <div>{settings.uiLanguage === 'fa' ? 'هیچ فیلدی تغییر نکرد.' : 'No fields changed.'}</div>
                  )}
                </div>
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPatchModalQuestion(null);
                  setPatchDiffResult(null);
                }}
                className="px-4 py-2 rounded-[6px] border border-[var(--rule)]  text-xs font-medium text-[var(--ink-2)] hover:bg-[var(--paper)] "
              >
                {settings.uiLanguage === 'fa' ? 'لغو' : 'Cancel'}
              </button>

              {patchDiffResult ? (
                <button
                  type="button"
                  onClick={handleAcceptPatch}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] text-xs font-medium "
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{settings.uiLanguage === 'fa' ? 'پذیرفتن وصله' : 'Accept patch'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isPatching}
                  onClick={handleRunPatch}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] text-xs font-medium  disabled:opacity-50"
                >
                  {isPatching ? (
                    <>
                      <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                      <span>{settings.uiLanguage === 'fa' ? 'در حال ارسال وصله…' : 'Sending patch…'}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{settings.uiLanguage === 'fa' ? 'ساخت وصله' : 'Generate patch'}</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
