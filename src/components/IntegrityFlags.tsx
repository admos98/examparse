import React from 'react';
import type { ExamDoc } from '../types';
import { FLAG_TEMPLATES, flagSentence, triageFlags } from '../utils/flagPresentation';
import { computeAttention, type AttentionItem } from '../utils/attention';

/**
 * Part C — the attention panel lists exactly `computeAttention(doc)` items: one number shared with
 * the Step-4 header sentence, the collapsed chip, Library health and the Assistant. Every row IS a
 * button that takes the user to the thing that needs finishing (never a dead-end statement).
 * App-internal events stay in "What the app already fixed" / "Technical log".
 */
export function IntegrityFlags({
  doc,
  onOpenItem,
  onSecondaryAction,
}: {
  doc: ExamDoc;
  onOpenItem?: (item: AttentionItem) => void;
  onSecondaryAction?: (item: AttentionItem) => void;
}) {
  const { repairs, technical } = triageFlags(doc.flags || []);
  const items = computeAttention(doc);
  return <section className="border border-[var(--rule)] rounded-[10px] p-4 space-y-3 text-xs" aria-label="Integrity Flags">
    <h2 className="font-bold" data-attention-count={items.length}>{items.length} {items.length === 1 ? 'thing needs' : 'things need'} attention</h2>
    <h3 className="font-semibold">NEEDS ATTENTION</h3>
    {items.length ? (
      <ul className="space-y-2">
        {items.map((item, index) => {
          const secondarySuffix = item.secondaryAction ? ` [${item.secondaryAction.label}]` : '';
          const primaryText = secondarySuffix && item.plainSentence.endsWith(secondarySuffix)
            ? item.plainSentence.slice(0, -secondarySuffix.length)
            : item.plainSentence;
          return (
            <li key={`${item.id}_${index}`} className={item.secondaryAction ? 'flex items-center gap-1.5' : undefined}>
              <button
                type="button"
                data-attention-kind={item.kind}
                data-attention-target={item.action.target}
                data-attention-question={item.action.questionId || ''}
                onClick={() => onOpenItem?.(item)}
                className="flex-1 w-full text-start rounded-[6px] px-2 py-1.5 border border-[var(--rule)] bg-[var(--paper)] hover:bg-[var(--paper-raised)] cursor-pointer"
                title={item.action.target === 'image-tray' ? 'Open the image tray' : item.action.target === 'page-retry' ? `Retry reading page ${item.action.page}` : 'Go to this question'}
              >
                {primaryText}
              </button>
              {item.secondaryAction && (
                <button
                  type="button"
                  data-attention-secondary-target={item.secondaryAction.target}
                  onClick={() => onSecondaryAction?.(item)}
                  className="shrink-0 rounded-[6px] px-2 py-1.5 border border-[var(--rule)] bg-[var(--paper)] hover:bg-[var(--paper-raised)] cursor-pointer"
                  title={`Open page ${item.secondaryAction.page} in Source`}
                >
                  [{item.secondaryAction.label}]
                </button>
              )}
            </li>
          );
        })}
      </ul>
    ) : (
      <p>Nothing needs your attention.</p>
    )}
    <details><summary className="cursor-pointer font-semibold">WHAT THE APP ALREADY FIXED</summary>
      <div className="mt-2 space-y-2">{[...repairs].map(([code, flags]) => <details key={code}><summary className="cursor-pointer">{FLAG_TEMPLATES[code] || code.toLowerCase().replaceAll('_', ' ')} ×{flags.length} — view</summary>
        <ul>{flags.map((flag, index) => <li key={`${flag.id}_${index}`}>{flagSentence(flag, doc)}</li>)}</ul>
      </details>)}</div>
    </details>
    <details><summary className="cursor-pointer font-semibold">TECHNICAL LOG</summary><ul>{technical.map((flag, index) => <li key={`${flag.id}_${index}`}>{flag.code}: {flag.message}</li>)}</ul></details>
  </section>;
}
