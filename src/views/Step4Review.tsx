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

  // Update a question in examDoc
  const handleUpdateQuestion = (qId: string, updates: Partial<Question>) => {
    const updatedQuestions = examDoc.questions.map(q => (q.id === qId ? { ...q, ...updates } : q));
    const newDoc = { ...examDoc, questions: updatedQuestions };
    onUpdateDoc(newDoc);
    saveExamDoc(newDoc);
  };

  // Delete a question
  const handleDeleteQuestion = (qId: string) => {
    const updatedQuestions = examDoc.questions.filter(q => q.id !== qId);
    const newDoc = { ...examDoc, questions: updatedQuestions };
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

    const newDoc = { ...examDoc, images: updatedImages };
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
          if (secQuestions.length === 0) return null;

          return (
            <div key={sec.id} className="space-y-3">
              {/* Section Header */}
              <div className="flex items-center justify-between pb-1 border-b border-slate-200 dark:border-slate-800">
                <div className="space-y-0.5">
                  <h2 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
                    {sec.title || `Section ${sec.index}`}
                  </h2>
                  {sec.instructions && (
                    <p className="text-[11px] text-slate-500 italic">{sec.instructions}</p>
                  )}
                </div>
                <span className="text-[11px] font-mono text-slate-400">
                  {secQuestions.length} question(s)
                </span>
              </div>

              {/* Question Cards List */}
              <div className="space-y-3">
                {secQuestions.map(q => {
                  const isExpanded = activeQuestionId === q.id;

                  return (
                    <div
                      key={q.id}
                      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-xs space-y-3 transition hover:border-slate-300 dark:hover:border-slate-700"
                    >
                      {/* Question Header Row */}
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2">
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
                            {(q.confidence * 100).toFixed(0)}% conf
                          </span>
                        </div>

                        {/* Question Action Buttons */}
                        <div className="flex items-center gap-1.5">
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
                            if (!asset || !asset.dataUrl) return null;
                            return (
                              <div
                                key={imgRef.imageId}
                                className="relative rounded-xl border border-slate-200 dark:border-slate-800 p-1 bg-slate-50 dark:bg-slate-950 inline-block"
                              >
                                <img
                                  src={asset.dataUrl}
                                  alt={asset.id}
                                  className="max-h-24 rounded-lg object-contain bg-white"
                                />
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

                      {/* Answer Key preview */}
                      {q.answer && (
                        <div className="pt-1 text-[11px] text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 p-2 rounded-xl border border-emerald-200/50 dark:border-emerald-800/30">
                          <span className="font-semibold">Answer:</span> {q.answer.text}
                        </div>
                      )}
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
