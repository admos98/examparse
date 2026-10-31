import React, { useState } from 'react';
import type { AppSettings, ExamDoc } from '../types';
import { enrichPackage, type EnrichmentEvent } from '../pipeline/packageEnrichment';
import { appendJournalCall } from '../pipeline/journal';
import { resolveDecisionProvider } from '../pipeline/loopAudit';
import { saveExamDoc } from '../store';

/**
 * #58 Part F — the primary package path shows real progress, not a frozen "checking…" line:
 * per-exam phase, completed/planned calls (the planned number is an estimate and says so),
 * the current label/check, errors/skips, and a collapsible live view of the ONE underlying
 * generative call's streamed output. No duplicate model call is issued to make progress visible.
 */
export function PackageAnalyze({ doc, settings, onComplete }: { doc: ExamDoc; settings: AppSettings; onComplete: (doc: ExamDoc) => void }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [phase, setPhase] = useState('');
  const [counts, setCounts] = useState<{ completed: number; planned: number }>({ completed: 0, planned: 0 });
  const [live, setLive] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [showLive, setShowLive] = useState(true);
  const [error, setError] = useState('');
  const handleEvent = (event: EnrichmentEvent) => {
    if (event.kind === 'phase' && event.message) setPhase(`Exam 1 of 1 · ${event.message}`);
    if (event.kind === 'call') setCounts({ completed: event.completed || 0, planned: event.planned || 0 });
    if (event.kind === 'error' || event.kind === 'skip') setIssues(previous => [...previous.slice(-20), `${event.label || ''}${event.check ? ` · ${event.check}` : ''}: ${event.message || event.kind}`]);
  };
  const run = async () => {
    setRunning(true); setError(''); setIssues([]); setLive(''); setCounts({ completed: 0, planned: 0 });
    try {
      const next = await enrichPackage(doc, settings, {
        onProgress: setProgress,
        onEvent: handleEvent,
        onStream: text => setLive(text.slice(-4000)),
        onJournal: entry => appendJournalCall(`package-enrichment:${doc.fileHash}`, { ...entry, ts: new Date().toISOString(), complete: true }),
      });
      await saveExamDoc(next); onComplete(next);
    } catch (e: any) { setError(e?.message || 'Enrichment failed.'); } finally { setRunning(false); }
  };
  return <div className="max-w-3xl mx-auto p-6 space-y-4">
    <h1 className="text-xl font-bold">Verify &amp; enrich</h1>
    <p className="text-sm">This package already contains {doc.questions.length} questions. A local read model first writes explanations for keyed questions and sample answers for keyless descriptive items, then the decision model checks and estimates. Source answers and stems are not changed, and model proposals never become answer keys.</p>
    {!resolveDecisionProvider(settings) && <p className="text-sm">No decision provider configured — judging will not run. Local generation can still run if configured, and unchecked items will say so.</p>}
    {running && <p className="text-xs font-mono" data-progress-counts="true">
      {phase || 'Exam 1 of 1 · preparing'}
      {counts.planned ? ` · check ${counts.completed} of ~${counts.planned} (estimate)` : ''}
      {progress ? ` · ${progress}` : ''}
    </p>}
    {!running && progress && <p aria-live="polite" className="text-xs">{progress}</p>}
    {issues.length > 0 && <ul className="text-xs text-[var(--warn-ink)]" data-progress-issues="true">{issues.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul>}
    {(running || live) && <details open={showLive} onToggle={event => setShowLive((event.target as HTMLDetailsElement).open)} className="rounded border border-[var(--rule)] p-2 text-xs" data-live-output="true">
      <summary className="cursor-pointer font-semibold">Live model output</summary>
      <pre aria-live="polite" className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{live || 'waiting for the first token…'}</pre>
    </details>}
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-3"><button disabled={running} onClick={run} className="px-4 py-2 rounded bg-[var(--accent)] text-[var(--on-accent)] disabled:opacity-50">{running ? 'Checking…' : 'Verify & enrich'}</button>
      <button disabled={running} onClick={() => onComplete(doc)} className="px-4 py-2 rounded border">Review as-is</button></div>
  </div>;
}
