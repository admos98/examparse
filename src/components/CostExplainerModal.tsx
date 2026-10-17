import React from 'react';
import { X, Zap, Database, Layers, GitCommit, ShieldCheck } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const CostExplainerModal: React.FC<Props> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                How ExamParse Keeps Costs Near Zero
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                The zero-waste Token-Thrift Engine explained
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 text-sm text-slate-600 dark:text-slate-300">
          {/* Item 1 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold">
              1
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-500" />
                Line-Addressed Source & Span References (85–95% Savings)
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                Traditional exam parsers ask the LLM to reproduce the entire text of every question, which inflates completion tokens and costs.
                ExamParse numbers every line locally (<code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[11px]">[L0041]</code>).
                The AI returns only span coordinates like <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[11px]">[[41, 45]]</code>.
                The browser slices the original text deterministically.
              </p>
            </div>
          </div>

          {/* Item 2 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold">
              2
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-500" />
                Content-Hash Cache (0 Calls, $0.00 on Re-runs)
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                Every stage (Extraction, OCR, Structure, Vision, Repair) is keyed by the SHA-256 hash of the source file, parser version, prompt version, and model parameters.
                If you re-run an already analyzed document or re-visit a step, zero API requests are dispatched.
              </p>
            </div>
          </div>

          {/* Item 3 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center font-bold">
              3
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-purple-500" />
                Batched Vision Mapping (Never 1 Call per Image)
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                All extracted diagram and formula images are sent together in a single batched vision request.
                The model only returns a compact JSON mapping of image ID → question reference and role, capped at &lt; 2 KB.
              </p>
            </div>
          </div>

          {/* Item 4 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center font-bold">
              4
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <GitCommit className="w-4 h-4 text-amber-500" />
                RFC 7386 Merge Patch Regeneration
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                When you click "Regenerate this question", ExamParse sends only that question's slice and ±5 context lines.
                The response is an RFC 7386 JSON Merge Patch (e.g. <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[11px]">{`{"points": 3}`}</code>),
                costing ~1k tokens instead of re-running the entire 40k-token exam.
              </p>
            </div>
          </div>

          {/* Item 5 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center font-bold">
              5
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-rose-500" />
                Two-Tier Escalation
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                The initial structure pass runs on low-cost models (e.g. Flash-Lite). High-tier models (Pro) are called only if validation fails, and only for the specific failing items (max 8 in 1 batch).
              </p>
            </div>
          </div>
        </div>

        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-medium text-xs hover:opacity-90 transition"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
