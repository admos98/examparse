import React, { useMemo, useState } from 'react';
import type { AppSettings, ExamDoc } from '../types';
import { Modal } from '../design/primitives';
import { bankOptions, bankProvenance, bankQuestions, bankStem, createQuestionBankExport, defaultBankDataset, downloadQuestionBankExport, type BankExport } from '../utils/questionBankExport';
import { tagBankQuestions } from '../pipeline/bankTagging';
import { curriculumLessons, keywordCurriculumHint } from '../pipeline/curriculumHints';

export function QuestionBankExportDialog({ doc, settings, onClose, onTagged }: { doc: ExamDoc; settings: AppSettings; onClose: () => void; onTagged?: (doc: ExamDoc) => void | Promise<void> }) {
  const provenance = bankProvenance(doc);
  const [sourceDataset, setSourceDataset] = useState(() => defaultBankDataset(doc));
  const [sourceRef, setSourceRef] = useState(() => provenance.source_ref || '');
  const [includeModelDifficulty, setIncludeModelDifficulty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<BankExport | null>(null);
  const [warning, setWarning] = useState('');
  const summary = useMemo(() => {
    const questions = bankQuestions(doc); const lessons = curriculumLessons(doc.meta.grade, doc.meta.subject);
    const tagged = questions.filter(q => doc.source.kind === 'package' ? Boolean(q.enrichment?.teacherLesson || q.curriculumHints?.lesson) : Boolean(q.curriculumHints?.lesson || keywordCurriculumHint(lessons, `${bankStem(doc, q)} ${bankOptions(doc, q).map(o => o.text).join(' ')}`))).length;
    return { total: questions.length, tagged, untagged: questions.length - tagged };
  }, [doc]);
  const invalidate = () => { setResult(null); setError(''); setWarning(''); };
  const generate = async () => {
    setBusy(true); setError(''); setResult(null); setWarning('');
    try {
      const tagged = doc.source.kind === 'package' ? { doc, skipped: false, endpointErrors: 0 } : await tagBankQuestions({ doc, settings, includeModelDifficulty, onProgress: p => {
        setStatus(p.total ? `Tagging ${p.total} questions… ${p.completed}/${p.total}${p.skipped ? ` · endpoint unreachable — skipping (${p.endpointErrors} errors)` : ''}` : 'Preparing question bank…');
      } });
      if (tagged.skipped) setWarning(`Decision endpoint unreachable — tagging stopped after ${tagged.endpointErrors} errors. Untagged questions are still exported.`);
      if (onTagged) try { await onTagged(tagged.doc); } catch { setWarning('Tag proposals could not be saved to the exam; they are included in this export only.'); }
      setStatus('Packaging and verifying assets…');
      const output = await createQuestionBankExport(tagged.doc, { sourceDataset, sourceRef, includeModelDifficulty });
      setResult(output); setStatus('Export ready.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStatus(''); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Export · Question Bank batch">
    <div className="space-y-4 p-4 text-xs">
      <p>Exports a ZIP containing batch.json, a report, and content-named image assets. Missing answers remain unkeyed.</p>
      <label className="block font-medium">Source dataset<input className="mt-1 w-full rounded border bg-[var(--paper-raised)] p-2" value={sourceDataset} onChange={e => { setSourceDataset(e.target.value); invalidate(); }} disabled={busy} /></label>
      <div><strong>Provenance:</strong> {provenance.source_type === 'official_cited' ? 'Official cited' : 'Authored'}{provenance.source_type === 'authored' && ' · source reference: null'}</div>
      {provenance.source_type === 'official_cited' && <label className="block font-medium">Source reference<input className="mt-1 w-full rounded border bg-[var(--paper-raised)] p-2" value={sourceRef} onChange={e => { setSourceRef(e.target.value); invalidate(); }} disabled={busy} /></label>}
      {doc.source.kind !== 'package' && <label className="flex items-center gap-2"><input type="checkbox" checked={includeModelDifficulty} disabled={busy} onChange={e => { setIncludeModelDifficulty(e.target.checked); invalidate(); }} />Include model-estimated difficulty proposals (shadow mode)</label>}
      <p>Curriculum hints: {summary.tagged} tagged · {summary.untagged} untagged of {summary.total}. {doc.source.kind === 'package' ? 'Package exports use teacher-confirmed or margin-qualified enrichment lessons.' : 'Active decision mode may add hints during export.'}</p>
      {status && <p role="status" aria-live="polite">{status}</p>}
      {warning && <p role="status" className="text-[var(--warn-ink)]">{warning}</p>}
      {error && <p role="alert" className="text-[var(--danger)]">{error}</p>}
      {result && <div className="rounded border border-[var(--rule)] p-3 space-y-1" aria-label="Export report">
        <p><strong>Export report</strong> · {result.report.exported} questions · {result.report.tagged} tagged · {result.report.untagged} untagged</p>
        {/* #57 Part C — truthful image counts: assets emitted vs questions referencing them. */}
        <p data-export-images="true">{result.report.images_placed} image(s) placed ({result.report.image_references} question(s) reference an asset) · {result.report.asset_count} in pool · {result.report.total_bytes} asset bytes</p>
        <p>{result.report.needs_answer_key.length} need answer keys</p>
        {result.report.missing_assets.length > 0 && <p className="text-[var(--warn-ink)]">Missing image assets (exported with explicit markers): {result.report.missing_assets.map(entry => `${entry.question} → ${entry.image}`).join(', ')}</p>}
        {result.report.needs_answer_key.length > 0 && <p>Needs answer key: {result.report.needs_answer_key.map(q => q.question).join(', ')}</p>}
        {result.report.image_options.length > 0 && <p>Image options exported as placeholders: {result.report.image_options.join(', ')}</p>}
        {result.report.notes.map(note => <p key={note}>{note}</p>)}
      </div>}
      <div className="flex flex-wrap gap-2"><button disabled={busy || !sourceDataset.trim() || (provenance.source_type === 'official_cited' && !sourceRef.trim())} onClick={() => void generate()} className="rounded bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--on-accent)] disabled:opacity-50">{busy ? 'Preparing…' : 'Generate batch'}</button>
        {result && <button onClick={() => downloadQuestionBankExport(result)} className="rounded border px-4 py-2 font-semibold">Download ZIP</button>}
        <button disabled={busy} onClick={onClose} className="rounded border px-4 py-2">Close</button></div>
    </div>
  </Modal>;
}
