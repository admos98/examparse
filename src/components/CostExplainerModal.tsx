import React from 'react';
import { Modal } from '../design/primitives';
import { uiText } from '../design/i18n';
import { loadSettings } from '../store';
import { X, Zap, Database, Layers, GitCommit, ShieldCheck } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const CostExplainerModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const closeLabel = uiText(loadSettings().uiLanguage, 'Close cost explainer', 'بستن توضیح هزینه');
  if (!isOpen) return null;

  return (
    <Modal open={isOpen} onClose={onClose} title="How ExamParse Keeps Costs Near Zero" labelledBy="cost-explainer-title" className="max-w-2xl">
        <div className="flex items-center justify-between p-6 border-b border-[var(--rule)] ">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-[10px] bg-[var(--ok-soft)] text-[var(--ok)] ">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 id="cost-explainer-title" className="text-lg font-bold text-[var(--ink)] ">
                How ExamParse Keeps Costs Near Zero
              </h2>
              <p className="text-xs text-[var(--ink-2)] ">
                The zero-waste Token-Thrift Engine explained
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="p-2 text-[var(--ink-2)] hover:text-[var(--ink-2)]  rounded-[6px] hover:bg-[var(--paper)]  transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 text-sm text-[var(--ink-2)] ">
          {/* Item 1 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-[10px] bg-[var(--paper)] text-[var(--accent-ink)]  flex items-center justify-center font-bold">
              1
            </div>
            <div>
              <h3 className="font-semibold text-[var(--ink)]  flex items-center gap-2">
                <Layers className="w-4 h-4 text-[var(--accent-ink)]" />
                Line-Addressed Source & Span References (85–95% Savings)
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                Traditional exam parsers ask the LLM to reproduce the entire text of every question, which inflates completion tokens and costs.
                ExamParse numbers every line locally (<code className="px-1 py-0.5 rounded-[6px] bg-[var(--paper)]  font-mono text-[length:var(--type-12)]">[L0041]</code>).
                The AI returns only span coordinates like <code className="px-1 py-0.5 rounded-[6px] bg-[var(--paper)]  font-mono text-[length:var(--type-12)]">[[41, 45]]</code>.
                The browser slices the original text deterministically.
              </p>
            </div>
          </div>

          {/* Item 2 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-[10px] bg-[var(--ok-soft)] text-[var(--ok)]  flex items-center justify-center font-bold">
              2
            </div>
            <div>
              <h3 className="font-semibold text-[var(--ink)]  flex items-center gap-2">
                <Database className="w-4 h-4 text-[var(--ok)]" />
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
            <div className="shrink-0 w-8 h-8 rounded-[10px] bg-[var(--paper)] text-[var(--accent-ink)]  flex items-center justify-center font-bold">
              3
            </div>
            <div>
              <h3 className="font-semibold text-[var(--ink)]  flex items-center gap-2">
                <Zap className="w-4 h-4 text-[var(--accent-ink)]" />
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
            <div className="shrink-0 w-8 h-8 rounded-[10px] bg-[var(--warn-soft)] text-[var(--warn-ink)]  flex items-center justify-center font-bold">
              4
            </div>
            <div>
              <h3 className="font-semibold text-[var(--ink)]  flex items-center gap-2">
                <GitCommit className="w-4 h-4 text-[var(--warn-ink)]" />
                RFC 7386 Merge Patch Regeneration
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                When you click "Regenerate this question", ExamParse sends only that question's slice and ±5 context lines.
                The response is an RFC 7386 JSON Merge Patch (e.g. <code className="px-1 py-0.5 rounded-[6px] bg-[var(--paper)]  font-mono text-[length:var(--type-12)]">{`{"points": 3}`}</code>),
                costing ~1k tokens instead of re-running the entire 40k-token exam.
              </p>
            </div>
          </div>

          {/* Item 5 */}
          <div className="flex gap-4">
            <div className="shrink-0 w-8 h-8 rounded-[10px] bg-[var(--danger-soft)] text-[var(--danger)]  flex items-center justify-center font-bold">
              5
            </div>
            <div>
              <h3 className="font-semibold text-[var(--ink)]  flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[var(--danger)]" />
                Two-Tier Escalation
              </h3>
              <p className="mt-1 leading-relaxed text-xs">
                The initial structure pass runs on low-cost models (e.g. Flash-Lite). High-tier models (Pro) are called only if validation fails, and only for the specific failing items (max 8 in 1 batch).
              </p>
            </div>
          </div>
        </div>

        <div className="p-4 bg-[var(--paper)]  border-t border-[var(--rule)]  flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)] font-medium text-xs hover:opacity-90 transition"
          >
            Got it
          </button>
        </div>
    </Modal>
  );
};
