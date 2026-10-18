import React from 'react';
import { ExamDoc } from '../types';
import { getExamHealth } from '../pipeline/quality';

export const ExamHealthBanner: React.FC<{ doc: ExamDoc; className?: string }> = ({ doc, className = '' }) => {
  const health = getExamHealth(doc);
  const colors = health.state === 'green'
    ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
    : health.state === 'red'
      ? 'border-red-400 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200'
      : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200';
  const points = health.pointsExpected === undefined ? `${health.pointsParsed}` : `${health.pointsParsed} / ${health.pointsExpected}`;
  const partialCoverage = health.missing.length > 0 || health.duplicates.length > 0 || (health.pointsExpected !== undefined && Math.abs(health.pointDeficit) > 0.51);
  const noQuestionsParsed = (doc.questions || []).length === 0;
  return <div role="status" aria-live="polite" className={`rounded-xl border px-4 py-3 text-xs ${colors} ${className}`}>
    <div className="font-bold">{health.state === 'green' ? 'Exam health: complete' : noQuestionsParsed ? 'PARTIAL EXAM — no questions parsed' : partialCoverage ? `PARTIAL EXAM — ${health.coveragePercent.toFixed(0)}% printed-number coverage` : health.state === 'red' ? 'PARTIAL EXAM — completeness is below 80%' : 'Exam health: review required'}</div>
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
  </div>;
};
