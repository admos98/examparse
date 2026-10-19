import React, { useState } from 'react';
import { ExamDoc } from '../types';
import { getExamHealth } from '../pipeline/quality';
import { computeQualityScore, qualityColor } from '../utils/qualityScore';

export const ExamHealthBanner: React.FC<{ doc: ExamDoc; className?: string; onExplainScore?: (filter?: string)=>void }> = ({ doc, className = '', onExplainScore }) => {
  // getExamHealth throws if doc is incomplete (e.g. missing source.lines) — degrade to partial instead of white-screen
  let health: ReturnType<typeof getExamHealth>;
  try { health = getExamHealth(doc); } catch {
    health = { expectedCount: doc.questions?.length || 0, parsedCount: doc.questions?.length || 0, missing:[], duplicates:[], pointsParsed:0, pointDeficit:0, unplacedImages:[], unresolvedImageRefs:[], lowConfidenceCount:0, coveragePercent: doc.questions?.length ? 100 : 0, state:'amber', complete:false } as any;
  }
  let quality: ReturnType<typeof computeQualityScore>;
  try { quality = computeQualityScore(doc); } catch {
    quality = { total:0, coverage:0, points:0, optionsCleanliness:0, imagePlacement:0, numbering:0, confidence:0, passage:0, details:{ coveragePercent:0, pointDeficit:0, optionBlobCount:0, unplacedImages:0, duplicateNumbers:0, missingNumbers:0, lowConfidenceCount:0, passageMissing:false } } as any;
  }
  const [showBreakdown, setShowBreakdown] = useState(false);
  const colors = health.state === 'green'
    ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
    : health.state === 'red'
      ? 'border-red-400 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200'
      : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200';
  const points = health.pointsExpected === undefined ? `${health.pointsParsed}` : `${health.pointsParsed} / ${health.pointsExpected}`;
  const partialCoverage = health.missing.length > 0 || health.duplicates.length > 0 || (health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.51);
  const noQuestionsParsed = (doc.questions || []).length === 0;
  const qColor = qualityColor(quality.total);
  const qBg = qColor === 'green' ? 'bg-emerald-600 text-white' : qColor === 'amber' ? 'bg-amber-500 text-white' : 'bg-red-500 text-white';

  return <div role="status" aria-live="polite" className={`rounded-xl border px-4 py-3 text-xs ${colors} ${className}`}>
    <div className="flex items-center justify-between gap-3">
      <div className="font-bold">{health.state === 'green' ? 'Exam health: complete' : noQuestionsParsed ? 'PARTIAL EXAM — no questions parsed' : partialCoverage ? `PARTIAL EXAM — ${health.coveragePercent.toFixed(0)}% printed-number coverage` : health.state === 'red' ? 'PARTIAL EXAM — completeness is below 80%' : 'Exam health: review required'}</div>
      <button
        onClick={()=> setShowBreakdown(!showBreakdown)}
        className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-bold ${qBg} hover:opacity-90 transition`}
        title="Quality Score: click for breakdown (tripwire, never a gate on export)"
        aria-label={`Quality Score ${quality.total} out of 100`}
      >
        Quality {quality.total}
      </button>
    </div>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
      <span>{health.parsedCount} questions parsed / {health.expectedCount} expected</span>
      <span>Points {points}{health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.51 ? ` (deficit ${health.pointDeficit})` : ''}</span>
      {health.missing.length > 0 && <span className="font-semibold">Missing: {health.missing.join(', ')}</span>}
      {health.duplicates.length > 0 && <span className="font-semibold">Duplicate numbers: {health.duplicates.join(', ')}</span>}
      {health.unplacedImages.length > 0 && <span>{health.unplacedImages.length} unplaced image(s)</span>}
      {health.unresolvedImageRefs.length > 0 && <span>{health.unresolvedImageRefs.length} unresolved image reference(s)</span>}
      {health.lowConfidenceCount > 0 && <span>{health.lowConfidenceCount} low-confidence question(s)</span>}
      {(health.parentLinkIssueCount || 0) > 0 && <span className="font-semibold">{health.parentLinkIssueCount} invalid nested-question link(s)</span>}
    </div>
    {showBreakdown && (
      <div className="mt-3 p-3 rounded-lg bg-white/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 text-xs">
        <div className="font-semibold mb-2">Quality Score {quality.total}/100 — breakdown (tripwire, never a gate):</div>
        <div className="grid grid-cols-2 gap-1">
          <button onClick={()=> onExplainScore?.('coverage')} className="text-left hover:underline">Coverage {quality.coverage}/30 — {quality.details.coveragePercent.toFixed(1)}% ({quality.details.missingNumbers} missing)</button>
          <button onClick={()=> onExplainScore?.('points')} className="text-left hover:underline">Points {quality.points}/15 — deficit {quality.details.pointDeficit}</button>
          <button onClick={()=> onExplainScore?.('options')} className="text-left hover:underline">Options {quality.optionsCleanliness}/15 — blobs {quality.details.optionBlobCount}</button>
          <button onClick={()=> onExplainScore?.('images')} className="text-left hover:underline">Images {quality.imagePlacement}/15 — unplaced {quality.details.unplacedImages}</button>
          <button onClick={()=> onExplainScore?.('numbering')} className="text-left hover:underline">Numbering {quality.numbering}/10 — dup {quality.details.duplicateNumbers}</button>
          <button onClick={()=> onExplainScore?.('confidence')} className="text-left hover:underline">Confidence {quality.confidence}/10 — low {quality.details.lowConfidenceCount}</button>
          <button onClick={()=> onExplainScore?.('passage')} className="text-left hover:underline col-span-2">Passage {quality.passage}/5 — {quality.details.passageMissing ? 'missing for reading/listening' : 'ok'}</button>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">Explain-my-score: clicking an item jumps to the exact questions/images causing it.</div>
      </div>
    )}
  </div>;
};
