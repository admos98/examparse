import React from 'react';
import type { LoopReceipt as Receipt } from '../pipeline/localLoop';
import { MapOutline } from './MapOutline';

/** One receipt shared by Step 4 and the parse report. Comments never become save gates. */
export const LoopReceipt: React.FC<{ receipt: Receipt }> = ({ receipt }) => <details className="ep-card rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] p-4 text-xs" data-testid="loop-receipt">
  <summary className="cursor-pointer font-bold text-[var(--ink)]">{receipt.version === 'local-loop-v1' ? 'Loop receipt — six local steps (legacy receipt)' : 'Loop receipt — six phases'}</summary>
  <p className="mt-2 text-[var(--ink-2)]">Raw model-authored JSON is retained. Checkers comment; only model patches change questions. Nothing here blocks saving.</p>
  {receipt.map && <div className="mt-3"><MapOutline map={receipt.map} /></div>}
  <div className="mt-3 overflow-x-auto"><table className="w-full text-start text-[length:var(--type-12)]">
    <thead><tr className="border-b border-[var(--rule)] text-[var(--ink-2)]"><th className="p-2 text-start">{receipt.version === 'local-loop-v1' ? 'Step' : 'Phase'}</th><th className="p-2">Status</th><th className="p-2">Calls</th><th className="p-2">Patches applied</th><th className="p-2">Verdicts raised</th><th className="p-2">Verdicts closed</th><th className="p-2">Verdicts carried</th></tr></thead>
    <tbody>{receipt.steps.map(step => <tr key={step.step} className="border-b border-[var(--rule)]" data-loop-step={step.step}>
      <td className="p-2 font-medium">{step.name}</td><td className="p-2 text-center">{step.status}</td><td className="p-2 text-center font-mono">{step.calls}</td><td className="p-2 text-center font-mono">{step.correctionsApplied}</td><td className="p-2 text-center font-mono">{step.verdictsRaised}</td><td className="p-2 text-center font-mono">{step.verdictsClosed}</td><td className="p-2 text-center font-mono">{step.verdictsCarried ?? '—'}</td>
    </tr>)}</tbody>
  </table></div>
  <div className="mt-3 space-y-2" aria-live="polite">{receipt.steps.filter(step => step.notes.length).map(step => <div key={step.step}><strong>{step.name}</strong><ul className="mt-1 list-disc space-y-1 ps-5 text-[var(--ink-2)]">{step.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>)}</div>
  {receipt.pages.length > 0 && <details className="mt-3"><summary className="cursor-pointer font-semibold">Per-page READ receipt</summary><ul className="mt-2 space-y-1 text-[var(--ink-2)]">{receipt.pages.map(page => <li key={page.page}>Page {page.page}: {page.status} · {page.calls} call(s) · {page.questions} question(s){page.notes.length ? ` — ${page.notes.join(' ')}` : ''}</li>)}</ul></details>}
  {receipt.skippedNoEvidence !== undefined && <p className="mt-3 text-[var(--ink-2)]">Skipped-no-evidence: {receipt.skippedNoEvidence} item(s) — no vote was taken.</p>}
  {receipt.recheck && <p className="mt-3 text-[var(--ink-2)]" data-testid="loop-recheck">Re-check before Present: code re-ran with no model calls · decision re-voted {receipt.recheck.decisionRevoted} item(s), reused {receipt.recheck.decisionReused} · Fix changed {receipt.recheck.changedQuestions.length ? receipt.recheck.changedQuestions.map(n => `Q${n}`).join(', ') : 'nothing'}.</p>}
  <details className="mt-3"><summary className="cursor-pointer font-semibold">Surviving verdicts ({receipt.survivingVerdicts.length})</summary><ul className="mt-2 space-y-2">{receipt.survivingVerdicts.map(verdict => <li key={verdict.id}><span className="font-mono text-[var(--ink-2)]">{verdict.kind}{verdict.probability !== undefined ? ` p=${verdict.probability.toFixed(2)}` : ''} · {(verdict.sources || [verdict.source]).join('+')}</span> — {verdict.message}</li>)}</ul></details>
  <details className="mt-3"><summary className="cursor-pointer font-semibold">Raw authored working JSON</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-[var(--paper)] p-3 font-mono text-[length:var(--type-12)]">{JSON.stringify(receipt.document, null, 2)}</pre></details>
</details>;
