import React, { useState } from 'react';
import type { AppSettings, ExamDoc } from '../types';
import { enrichPackage } from '../pipeline/packageEnrichment';
import { appendJournalCall } from '../pipeline/journal';
import { resolveDecisionProvider } from '../pipeline/loopAudit';
import { saveExamDoc } from '../store';

export function PackageAnalyze({ doc, settings, onComplete }: { doc: ExamDoc; settings: AppSettings; onComplete: (doc: ExamDoc) => void }) {
  const [running, setRunning] = useState(false); const [progress, setProgress] = useState(''); const [error, setError] = useState('');
  const run = async () => {
    setRunning(true); setError('');
    try {
      const next = await enrichPackage(doc, settings, { onProgress: setProgress, onJournal: entry => appendJournalCall(`package-enrichment:${doc.fileHash}`, { ...entry, ts: new Date().toISOString(), complete: true }) });
      await saveExamDoc(next); onComplete(next);
    } catch (e: any) { setError(e?.message || 'Enrichment failed.'); } finally { setRunning(false); }
  };
  return <div className="max-w-3xl mx-auto p-6 space-y-4">
    <h1 className="text-xl font-bold">Verify &amp; enrich</h1>
    <p className="text-sm">This package already contains {doc.questions.length} questions. A local read model first writes explanations for keyed questions, then the decision model checks and estimates. Package answers and stems are not changed.</p>
    {!resolveDecisionProvider(settings) && <p className="text-sm">No decision provider configured — judging will not run. Local explanation generation can still run if configured.</p>}
    {progress && <p aria-live="polite" className="text-xs">{progress}</p>}{error && <p role="alert">{error}</p>}
    <div className="flex gap-3"><button disabled={running} onClick={run} className="px-4 py-2 rounded bg-[var(--accent)] text-[var(--on-accent)] disabled:opacity-50">{running ? 'Checking…' : 'Verify & enrich'}</button>
    <button disabled={running} onClick={() => onComplete(doc)} className="px-4 py-2 rounded border">Review as-is</button></div>
  </div>;
}
