import React, { useMemo, useState } from 'react';
import type { AppSettings, ExamDoc } from '../types';
import { Modal } from '../design/primitives';
import { bankOptions, bankProvenance, bankQuestions, bankStem, createQuestionBankExport, defaultBankDataset, downloadQuestionBankExport, type BankExport } from '../utils/questionBankExport';
import type { BankContractProfile } from '../utils/bankContract';
import { tagBankQuestions } from '../pipeline/bankTagging';
import { curriculumLessons, keywordCurriculumHint } from '../pipeline/curriculumHints';

export function QuestionBankExportDialog({ doc, settings, onClose, onTagged }: { doc: ExamDoc; settings: AppSettings; onClose: () => void; onTagged?: (doc: ExamDoc) => void | Promise<void> }) {
  const provenance = bankProvenance(doc);
  const [sourceDataset, setSourceDataset] = useState(() => defaultBankDataset(doc));
  const [sourceRef, setSourceRef] = useState(() => provenance.source_ref || '');
  const [includeModelDifficulty, setIncludeModelDifficulty] = useState(true);
  // #58 — the destination contract is unverified: the profile is explicit and the report always
  // says so. The conservative profile writes only the option-key answer into batch.json.
  const [contract, setContract] = useState<BankContractProfile>('bank-v2-provisional');
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
      const output = await createQuestionBankExport(tagged.doc, { sourceDataset, sourceRef: sourceRef.trim() || undefined, includeModelDifficulty, contract });
      setResult(output); setStatus('Export ready.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStatus(''); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Export · Question Bank batch">
    <div className="space-y-4 p-4 text-xs">
      <p>Exports a ZIP containing batch.json, a report, content-named image assets, a lossless <code>preserved/answers.json</code> bridge and <code>contract/requests.json</code>. A model proposal never becomes an answer key; a genuine source answer is preserved by type.</p>
      <p role="status" data-contract-status="unverified" className="rounded border border-[var(--warn)] bg-[var(--warn-soft)] p-2 text-[var(--warn-ink)]">
        Destination contract not verified: the real bank adapter and <code>validateImportBatch</code> have not been run against this ZIP. Treat it as pending compatibility, not as bank-ready.
      </p>
      <label className="block font-medium">Source dataset<input className="mt-1 w-full rounded border bg-[var(--paper-raised)] p-2" value={sourceDataset} onChange={e => { setSourceDataset(e.target.value); invalidate(); }} disabled={busy} /></label>
      <div><strong>Provenance:</strong> {provenance.source_type === 'official_cited' ? 'Official cited' : provenance.source_type === 'claimed' ? 'Claimed by the source (never remapped automatically)' : 'Authored'}</div>
      <label className="block font-medium">Source reference {provenance.source_type === 'official_cited' ? '(required)' : '(optional)'}<input className="mt-1 w-full rounded border bg-[var(--paper-raised)] p-2" value={sourceRef} onChange={e => { setSourceRef(e.target.value); invalidate(); }} disabled={busy} /><span className="text-[var(--ink-2)]">A reference you type here is kept in the compact bank reference; the full source prose stays in the structured export.</span></label>
      <label className="block font-medium">Destination contract<select className="mt-1 w-full rounded border bg-[var(--paper-raised)] p-2" value={contract} onChange={e => { setContract(e.target.value as BankContractProfile); invalidate(); }} disabled={busy}>
        <option value="bank-v2-provisional">Bank fields as reported (unverified)</option>
        <option value="appendix-a-1.1">Conservative: option keys only</option>
      </select></label>
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
        <p data-contract-report="true">Contract: {result.report.contract.profile} · verified: no · {result.report.contract.pending.length} pending mapping(s) — see contract/requests.json in the ZIP.</p>
        <p data-artifact-report="true">Samples/rubrics: {result.report.artifacts.verified} verified · {result.report.artifacts.teacher} teacher-confirmed · {result.report.artifacts.pending} awaiting a rubric{result.report.artifacts.stale ? ` · ${result.report.artifacts.stale} stale` : ''}</p>
        {result.report.stale_verdicts.length > 0 && <p className="text-[var(--warn-ink)]">Stale verdicts not exported (evidence changed): {result.report.stale_verdicts.join(', ')}</p>}
        {result.report.missing_assets.length > 0 && <p className="text-[var(--warn-ink)]">Missing image assets (exported with explicit markers): {result.report.missing_assets.map(entry => `${entry.question} → ${entry.image}`).join(', ')}</p>}
        {result.report.needs_answer_key.length > 0 && <p>Needs answer key: {result.report.needs_answer_key.map(q => q.question).join(', ')}</p>}
        {result.report.image_options.length > 0 && <p>Picture options could not be represented by this contract (asset shipped, question held): {result.report.image_options.join(', ')}</p>}
        {result.report.notes.map(note => <p key={note}>{note}</p>)}
      </div>}
      <div className="flex flex-wrap gap-2"><button disabled={busy || !sourceDataset.trim() || (provenance.source_type === 'official_cited' && !sourceRef.trim())} onClick={() => void generate()} className="rounded bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--on-accent)] disabled:opacity-50">{busy ? 'Preparing…' : 'Generate batch'}</button>
        {result && <button onClick={() => downloadQuestionBankExport(result)} className="rounded border px-4 py-2 font-semibold">Download ZIP</button>}
        <button disabled={busy} onClick={onClose} className="rounded border px-4 py-2">Close</button></div>
    </div>
  </Modal>;
}
