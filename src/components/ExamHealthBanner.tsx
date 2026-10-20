import React, { useState } from 'react';
import { ExamDoc } from '../types';
import { getExamHealth } from '../pipeline/quality';
import { computeQualityScore, qualityColor } from '../utils/qualityScore';

export const ExamHealthBanner: React.FC<{ doc: ExamDoc; className?: string; onExplainScore?: (filter?: string)=>void; /** B3 — jump to the first orphan line in Step 2. */ onJumpToSource?: (lineNo: number) => void }> = ({ doc, className = '', onExplainScore, onJumpToSource }) => {
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
    ? 'border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]   '
    : health.state === 'red'
      ? 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]   '
      : 'border-[var(--warn)] bg-[var(--warn-soft)] text-[var(--warn-ink)]   ';
  const points = health.pointsExpected === undefined ? `${health.pointsParsed}` : `${health.pointsParsed} / ${health.pointsExpected}`;
  const partialCoverage = health.missing.length > 0 || health.duplicates.length > 0 || (health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.51);
  const noQuestionsParsed = (doc.questions || []).length === 0;
  const qColor = qualityColor(quality.total);
  const qTone = qColor === 'green'
    ? 'border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]'
    : qColor === 'amber'
      ? 'border-[var(--warn)] bg-[var(--warn-soft)] text-[var(--warn-ink)]'
      : 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]';

  return <div role="status" aria-live="polite" className={`rounded-[10px] border px-4 py-3 text-xs ${colors} ${className}`}>
    <div className="flex items-center justify-between gap-3">
      <div className="font-bold">{health.state === 'green' ? 'Exam health: complete' : noQuestionsParsed ? 'PARTIAL EXAM — no questions parsed' : partialCoverage ? `PARTIAL EXAM — ${health.coveragePercent.toFixed(0)}% printed-number coverage` : health.state === 'red' ? 'PARTIAL EXAM — completeness is below 80%' : 'Exam health: review required'}</div>
      <button
        onClick={()=> setShowBreakdown(!showBreakdown)}
        className={`shrink-0 px-2.5 py-1 rounded-[6px] border text-xs font-bold ${qTone} hover:opacity-90 transition`}
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
      {(health.hollowQuestions?.length || 0) > 0 && <span className="font-semibold" title={health.hollowQuestions.map(h => `${h.label}: ${h.code}`).join(', ')}>{health.hollowQuestions.length} hollow/unverified question(s)</span>}
      {(health.orphanLines || 0) > 0 && (() => {
        const first = (doc.source?.orphanLineNos || [])[0];
        const territory = Math.max(1, (doc.source?.lines || []).length - (doc.source?.keyTerritoryLineNos || []).length);
        const rate = (health.orphanLines / territory) * 100;
        return <span className={rate > 2 ? 'font-semibold' : ''} title="Exam-territory lines owned by no question or section (ORPHAN_LINES)">
          {health.orphanLines} orphan line(s) ({rate.toFixed(1)}%)
          {onJumpToSource && first !== undefined && <button onClick={() => onJumpToSource(first)} className="ms-1 underline hover:opacity-80">jump to L{String(first).padStart(4, '0')}</button>}
        </span>;
      })()}
    </div>
    {showBreakdown && (
      <div className="mt-3 p-3 rounded-[10px] bg-[var(--paper-raised)]  border border-[var(--rule)]  text-xs">
        <div className="font-semibold mb-2">Quality Score {quality.total}/100 — breakdown (tripwire, never a gate):</div>
        <div className="grid grid-cols-2 gap-1">
          <button onClick={()=> onExplainScore?.('coverage')} className="text-start hover:underline">Coverage {quality.coverage}/30 — {quality.details.coveragePercent.toFixed(1)}% ({quality.details.missingNumbers} missing)</button>
          <button onClick={()=> onExplainScore?.('points')} className="text-start hover:underline">Points {quality.points}/15 — deficit {quality.details.pointDeficit}</button>
          <button onClick={()=> onExplainScore?.('options')} className="text-start hover:underline">Options {quality.optionsCleanliness}/15 — blobs {quality.details.optionBlobCount}</button>
          <button onClick={()=> onExplainScore?.('images')} className="text-start hover:underline">Images {quality.imagePlacement}/15 — unplaced {quality.details.unplacedImages}</button>
          <button onClick={()=> onExplainScore?.('numbering')} className="text-start hover:underline">Numbering {quality.numbering}/10 — dup {quality.details.duplicateNumbers}</button>
          <button onClick={()=> onExplainScore?.('confidence')} className="text-start hover:underline">Confidence {quality.confidence}/6 — low {quality.details.lowConfidenceCount}</button>
          <button onClick={()=> onExplainScore?.('orphan')} className="text-start hover:underline">Orphan lines {quality.orphan}/4 — {quality.details.orphanLines} line(s), {(quality.details.orphanRate * 100).toFixed(1)}%</button>
          <button onClick={()=> onExplainScore?.('passage')} className="text-start hover:underline col-span-2">Passage {quality.passage}/5 — {quality.details.passageMissing ? 'missing for reading/listening' : 'ok'}</button>
        </div>
        <div className="mt-2 text-[length:var(--type-12)] text-[var(--ink-2)]">Explain-my-score: clicking an item jumps to the exact questions/images causing it.</div>
      </div>
    )}
  </div>;
};
