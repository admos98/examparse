/**
 * Exam Library (full-screen overlay, not a stepper step).
 * Lists stored exams from the local folder with open / rename / duplicate / export / delete.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { cleanRateTrend, regressionAlarm } from '../pipeline/liveBench';
import {
  X,
  Search,
  FolderOpen,
  FileText,
  Copy,
  Download,
  Pencil,
  Trash2,
  Check,
  Database,
  ScanText,
  AlertTriangle,
} from 'lucide-react';
import { ExamDoc } from '../types';
import {
  ExamSummary,
  clearPipelineCaches,
  deleteExam,
  getStorageBackend,
  listExamSummaries,
  loadExamDoc,
  saveExamDoc,
} from '../store';
import { duplicateExamDoc, exportExamJson, partialExportIssues } from '../utils/examExport';
import { ConfirmCard, Modal } from '../design/primitives';
import { loadSettings } from '../store';
import { answerLibraryQuestion } from '../pipeline/multiExamChat';
import { createBackup, restoreBackup } from '../utils/backup';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  activeExamId?: string | null;
  onOpenExam: (doc: ExamDoc) => void;
  onExamRenamed: (doc: ExamDoc) => void;
  onExamDeleted: (id: string) => void;
  onGoToImport: () => void;
}

type SortMode = 'newest' | 'oldest' | 'name' | 'quality-desc' | 'quality-asc';

export const LibraryView: React.FC<Props> = ({
  isOpen,
  onClose,
  activeExamId,
  onOpenExam,
  onExamRenamed,
  onExamDeleted,
  onGoToImport,
}) => {
  const [legacyNotice, setLegacyNotice] = useState(() => localStorage.getItem('examparse_legacy_notice_seen') !== '1');
  const [summaries, setSummaries] = useState<ExamSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('newest');
  const [qualityFilter, setQualityFilter] = useState<'all' | 'needs-review' | 'good'>('all');
  const [storageMb, setStorageMb] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ExamSummary | null>(null);
  const [pendingExport, setPendingExport] = useState<ExamDoc | null>(null);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [storageMode, setStorageMode] = useState<{ mode: string; dir?: string }>({ mode: 'unavailable' });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refreshStorage = useCallback(async () => {
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        setStorageMb(typeof est.usage === 'number' ? est.usage / (1024 * 1024) : null);
      } else {
        setStorageMb(null);
      }
    } catch {
      setStorageMb(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const list = await listExamSummaries();
      setSummaries(list);
      try {
        const backend = await getStorageBackend();
        setStorageMode(backend);

      } catch {
        // storage probe is best-effort
      }
      await refreshStorage();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load the exam library.');
    } finally {
      setLoading(false);
    }
  }, [refreshStorage]);

  const [engineHealth, setEngineHealth] = useState<{ coverages: number[]; livebench: any[] }>({ coverages: [], livebench: [] });
  const [alarmDismissed, setAlarmDismissed] = useState(false);
  useEffect(() => {
    if (isOpen) {
      refresh();
      (async () => {
        try {
          const [runsRes, lbRes] = await Promise.all([fetch('/api/memory/runs'), fetch('/api/memory/livebench')]);
          const runs = runsRes.ok ? await runsRes.json() : [];
          const livebench = lbRes.ok ? await lbRes.json() : [];
          setEngineHealth({ coverages: (Array.isArray(runs) ? runs : []).map((r: any) => Number(r?.outcome?.health?.coveragePercent) || 0), livebench: Array.isArray(livebench) ? livebench : [] });
        } catch { /* offline — health strip says not benchmarked */ }
      })();
    }
  }, [isOpen, refresh]);

  const qualityLabel = (score: number) => {
    if (score >= 80) return { text: `${score}`, cls: 'border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]', label: 'good' };
    if (score >= 50) return { text: `${score}`, cls: 'border-[var(--warn)] bg-[var(--warn-soft)] text-[var(--warn-ink)]', label: 'review' };
    return { text: `${score}`, cls: 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]', label: 'poor' };
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let filtered = q
      ? summaries.filter(s =>
          [s.displayName, s.subject || '', s.grade || '', s.fileName]
            .join(' ')
            .toLowerCase()
            .includes(q)
        )
      : [...summaries];
    if (qualityFilter !== 'all') {
      filtered = filtered.filter(s => {
        const sc = (s as any).qualityScore ?? 0;
        return qualityFilter === 'needs-review' ? sc < 80 : sc >= 80;
      });
    }
    switch (sort) {
      case 'oldest':
        filtered.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
        break;
      case 'name':
        filtered.sort((a, b) => a.displayName.localeCompare(b.displayName));
        break;
      case 'quality-desc':
        filtered.sort((a, b) => ((b as any).qualityScore ?? 0) - ((a as any).qualityScore ?? 0));
        break;
      case 'quality-asc':
        filtered.sort((a, b) => ((a as any).qualityScore ?? 0) - ((b as any).qualityScore ?? 0));
        break;
      default:
        filtered.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    }
    return filtered;
  }, [summaries, search, sort, qualityFilter]);

  const handleOpen = async (summary: ExamSummary) => {
    const doc = await loadExamDoc(summary.id);
    if (!doc) {
      setErrorMsg('That exam could not be loaded (it may have been deleted).');
      refresh();
      return;
    }
    onOpenExam(doc);
  };

  const startRename = (summary: ExamSummary) => {
    setRenamingId(summary.id);
    setRenameValue(summary.displayName);
  };

  const commitRename = async (summary: ExamSummary) => {
    const next = renameValue.trim();
    if (!next) return;
    const doc = await loadExamDoc(summary.id);
    if (!doc) {
      setErrorMsg('That exam could not be loaded for renaming.');
      return;
    }
    const updated: ExamDoc = { ...doc, displayName: next, nameSource: 'manual' };
    await saveExamDoc(updated);
    setSummaries(prev =>
      prev.map(s => (s.id === summary.id ? { ...s, displayName: next } : s))
    );
    setRenamingId(null);
    onExamRenamed(updated);
  };

  const handleDuplicate = async (summary: ExamSummary) => {
    const doc = await loadExamDoc(summary.id);
    if (!doc) {
      setErrorMsg('That exam could not be loaded for duplication.');
      return;
    }
    const copy = duplicateExamDoc(doc);
    await saveExamDoc(copy);
    await refresh();
  };

  const handleExport = async (summary: ExamSummary) => {
    const doc = await loadExamDoc(summary.id);
    if (!doc) {
      setErrorMsg('That exam could not be loaded for export.');
      return;
    }
    if (partialExportIssues(doc).length) {
      setPendingExport(doc);
      return;
    }
    exportExamJson(doc);
  };

  const confirmPendingExport = () => {
    if (!pendingExport) return;
    exportExamJson(pendingExport);
    setPendingExport(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    await deleteExam(id);
    onExamDeleted(id);
    await refresh();
  };

  const handleClearCaches = async () => {
    await clearPipelineCaches();
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2500);
    await refreshStorage();
  };

  // F3 multi-exam picker + library-scope QA (dossiers only, All exams)
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryAnswer, setLibraryAnswer] = useState<string | null>(null);
  const handleLibraryQuery = () => {
    const q = libraryQuery.trim(); if (!q) return;
    // Minimal dossiers from summaries — no model source text, no keys; respects F3 contract
    const dossiers: any[] = summaries.map(s=> ({ identity:{title:s.displayName}, healthSnapshot:{ state: s.complete ? 'green':'red', unplacedImages: (s as any).unplacedImages ?? 0, missingNumbers: s.missingQuestionNos?.length ?? 0 }}));
    const ans = answerLibraryQuestion(q, dossiers as any);
    setLibraryAnswer(ans);
  };

  if (!isOpen) return null;
  const fa = loadSettings().uiLanguage === 'fa';
  const pendingExportIssues = pendingExport ? partialExportIssues(pendingExport) : [];

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  return (
    <Modal open={isOpen} onClose={onClose} title={fa ? 'کتابخانه آزمون' : 'Exam Library'} labelledBy="exam-library-title" className="ep-library-window" backdropClassName="ep-library-backdrop">
      <div className="h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]">
      <div className="max-w-5xl mx-auto py-6 px-4 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-[10px] bg-[var(--accent)] text-[var(--on-accent)]">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div>
              <h1 id="exam-library-title" className="text-lg font-bold">{fa ? 'کتابخانه آزمون' : 'Exam Library'}</h1>
              <p className="text-xs text-[var(--ink-2)]">
                {summaries.length} exam(s) stored locally
                {storageMb !== null ? ` · ${storageMb.toFixed(1)} MB used` : ''} ·{' '}
                {storageMode.mode === 'folder' ? `Storage: Folder (${storageMode.dir || 'data'})` : 'Storage: Folder unavailable'}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={fa ? 'بستن کتابخانه' : 'Close library'}
            onClick={onClose}
            className="p-2 text-[var(--ink-2)] hover:text-[var(--ink-2)]  rounded-[6px] hover:bg-[var(--paper)] "
            title={fa ? 'بستن کتابخانه' : 'Close library'}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 2G Engine health strip */}
        {(() => {
          const trend = cleanRateTrend(engineHealth.coverages);
          const alarm = regressionAlarm(engineHealth.coverages);
          const lastBench = engineHealth.livebench[engineHealth.livebench.length - 1];
          return (<>
            <div className="flex flex-wrap gap-x-4 gap-y-1 bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] px-3 py-2 text-[length:var(--type-12)] text-[var(--ink-2)] ">
              <span>Engine health:</span>
              <span>Last live bench: {lastBench ? `${lastBench.modelId} · ${lastBench.meanCoverage}% coverage · ${new Date(lastBench.ts).toLocaleDateString()}` : 'not benchmarked'}</span>
              <span>Offline bench: PASS (merge gate — run npm run bench)</span>
              <span>Clean-rate trend: {trend.recent !== null ? `last 20 jobs ${trend.recent}% vs prior 20 ${trend.prior ?? '—'}% (n=${trend.n})` : 'insufficient jobs yet'}</span>
            </div>
            {alarm.alarm && !alarmDismissed && (
              <div role="alert" className="flex items-center gap-2 bg-[var(--warn-soft)]  border border-[var(--warn)] rounded-[10px] px-3 py-2 text-xs text-[var(--warn-ink)] ">
                <span>{alarm.message}</span>
                <button onClick={() => setAlarmDismissed(true)} className="ms-auto underline shrink-0">Dismiss</button>
              </div>
            )}
          </>);
        })()}

        {/* Library-scope QA (F3) — dossiers only, no raw PDF text; All exams / scoped */}
        <div className="flex flex-wrap items-center gap-2 bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-3 text-xs">
          <input type="text" value={libraryQuery} onChange={e=> setLibraryQuery(e.target.value)} onKeyDown={e=> e.key==='Enter' && handleLibraryQuery()} placeholder='Try “which exams are incomplete?” or “list exams”' className="flex-[250px] px-2 py-1 rounded-[6px] border text-xs" aria-label="Ask library" />
          <button onClick={handleLibraryQuery} className="px-3 py-1 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)] text-xs shrink-0">Ask library</button>
          {libraryAnswer && <div role="status" className="w-full mt-2 p-2 rounded-[6px] bg-[var(--paper)]  text-xs">{libraryAnswer} <button onClick={()=> setLibraryAnswer(null)} className="ms-2 underline">dismiss</button></div>}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px] px-2.5 py-1.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)] ">
            <Search className="w-3.5 h-3.5 text-[var(--ink-2)] shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={fa ? 'جستجوی نام، درس، پایه یا نام فایل…' : 'Search name, subject, grade, or file name…'}
              className="w-full bg-[var(--surface-transparent)] outline-hidden text-xs text-[var(--ink)] "
            />
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortMode)}
            className="px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-xs"
            title="Sort exams"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name (A–Z)</option>
            <option value="quality-desc">Quality ↑</option>
            <option value="quality-asc">Quality ↓</option>
          </select>
          <select
            value={qualityFilter}
            onChange={e => setQualityFilter(e.target.value as any)}
            className="px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-xs"
            title="Filter by quality"
          >
            <option value="all">All quality</option>
            <option value="needs-review">Needs review (&lt;80)</option>
            <option value="good">Good (≥80)</option>
          </select>
          <button
            onClick={handleClearCaches}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border border-[var(--rule)]  hover:bg-[var(--paper)]  transition text-xs font-medium"
            title="Delete cached pipeline stage results (exams are kept)"
          >
            <Database className="w-3.5 h-3.5 text-[var(--accent-ink)]" />
            <span>{cacheCleared ? 'Caches cleared!' : 'Clear pipeline caches'}</span>
          </button>
        </div>

        <div className="p-3 text-xs border rounded-[10px]">
          {legacyNotice && <p>Old browser-stored exams are read-only from this version; export them from Library if needed. <button className="underline" onClick={() => { localStorage.setItem('examparse_legacy_notice_seen', '1'); setLegacyNotice(false); }}>Dismiss</button></p>}
          <button className="underline ms-2" onClick={async () => {
            try { const { exportLegacyExams } = await import('../store/legacy'); await exportLegacyExams(); }
            catch (error) { setErrorMsg(String(error)); }
          }}>Export old browser exams (read-only)</button>
        </div>

        {errorMsg && (
          <div className="p-3 rounded-[10px] bg-[var(--danger-soft)] border border-[var(--danger)] text-[var(--danger)]  text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="text-center text-xs text-[var(--ink-2)] py-16">Loading library…</div>
        ) : summaries.length === 0 ? (
          <div className="text-center py-16 space-y-3 bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px]">
            <FileText className="w-10 h-10 mx-auto text-[var(--ink-2)] " />
            <p className="text-sm font-medium text-[var(--ink)] ">No exams stored yet</p>
            <p className="text-xs text-[var(--ink-2)] max-w-sm mx-auto">
              Import an exam paper at Step 1 and run the analysis — every analyzed exam is saved here automatically.
            </p>
            <button
              onClick={onGoToImport}
              className="px-4 py-2 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] text-xs font-medium transition"
            >
              Go to Step 1 — Import
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center text-xs text-[var(--ink-2)] py-16">No exams match “{search}”.</div>
        ) : (
          <div className="space-y-3">
            {visible.map(s => {
              const termYear = [s.term, s.year].filter(Boolean).join(' ');
              const chips = [s.subject, s.grade, termYear].filter(Boolean) as string[];
              const isActive = activeExamId === s.id;
              const summaryCoverage = Number.isFinite(s.coveragePercent) ? s.coveragePercent : 0;
              const summaryMissing = Array.isArray(s.missingQuestionNos) ? s.missingQuestionNos : [];
              const summaryDuplicates = Array.isArray(s.duplicateQuestionNos) ? s.duplicateQuestionNos : [];
              const q = qualityLabel((s as any).qualityScore ?? 0);
              return (
                <div
                  key={s.id}
                  className="p-4 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper-raised)]  space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {renamingId === s.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={renameValue}
                            autoFocus
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitRename(s);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            className="px-2.5 py-1.5 rounded-[6px] border border-[var(--accent)] bg-[var(--paper-raised)]  text-sm font-semibold w-72 max-w-full"
                          />
                          <button
                            onClick={() => commitRename(s)}
                            className="p-1.5 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent)]"
                            title="Save name"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setRenamingId(null)}
                            className="p-1.5 rounded-[6px] border border-[var(--rule-strong)]  hover:bg-[var(--paper)] "
                            title="Cancel rename"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="font-semibold text-base text-[var(--ink)]  truncate">
                          {s.displayName}
                          {s.complete !== true && <span title={`Coverage ${summaryCoverage.toFixed(0)}%${summaryMissing.length ? `; missing ${summaryMissing.join(', ')}` : ''}${summaryDuplicates.length ? `; duplicates ${summaryDuplicates.join(', ')}` : ''}`} className="ms-2 text-[length:var(--type-12)] px-1.5 py-0.5 rounded-[6px] bg-[var(--warn-soft)] text-[var(--warn-ink)]  border border-[var(--warn)] align-middle">PARTIAL — {s.parsedQuestionCount ?? s.questionCount}/{s.expectedQuestionCount ?? '?'}</span>}
                          {isActive && (
                            <span className="ms-2 text-[length:var(--type-12)] px-1.5 py-0.5 rounded-[6px] bg-[var(--paper)] text-[var(--accent-ink)]  border border-[var(--accent)] align-middle">
                              open
                            </span>
                          )}
                        </div>
                      )}
                      <div className="text-[length:var(--type-12)] text-[var(--ink-2)] truncate" title={s.fileName}>
                        {s.fileName}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`px-2 py-0.5 rounded-[6px] border text-[length:var(--type-12)] font-bold ${q.cls}`} title="Local quality score (never a gate)">Q {q.text}</span>
                      {s.ocrUsed && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-[6px] text-[length:var(--type-12)] bg-[var(--warn-soft)] text-[var(--warn-ink)]  border border-[var(--warn)] shrink-0">
                          <ScanText className="w-3 h-3" /> OCR
                        </span>
                      )}
                    </div>
                  </div>

                  {chips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {chips.map((chip, i) => (
                        <span
                          key={i}
                          className="text-[length:var(--type-12)] px-2 py-0.5 rounded-[10px] bg-[var(--paper)]  text-[var(--ink-2)]  border border-[var(--rule)] "
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[length:var(--type-12)] text-[var(--ink-2)] flex flex-wrap gap-x-3 gap-y-1">
                      <span>{s.pages} pages</span>
                      <span>{s.questionCount} questions</span>
                      <span>{s.imageCount} images</span>
                      <span>{s.sectionCount} sections</span>
                      <span title={s.createdAt}>{formatDate(s.createdAt)}</span>
                      <span className="font-mono text-[var(--ok)] ">
                        ${s.totalCostUsd.toFixed(4)} lifetime · {s.totalTokens.toLocaleString()} toks
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[length:var(--type-12)]">
                      <button
                        onClick={() => handleOpen(s)}
                        className="px-3 py-1.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] font-medium transition"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => startRename(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  hover:bg-[var(--paper)]  transition"
                      >
                        <Pencil className="w-3 h-3" /> Rename
                      </button>
                      <button
                        onClick={() => handleDuplicate(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  hover:bg-[var(--paper)]  transition"
                      >
                        <Copy className="w-3 h-3" /> Duplicate
                      </button>
                      <button
                        onClick={() => handleExport(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  hover:bg-[var(--paper)]  transition"
                      >
                        <Download className="w-3 h-3" /> Export JSON
                      </button>
                      <button
                        onClick={() => setPendingDelete(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] border border-[var(--danger)]  text-[var(--danger)]  hover:bg-[var(--danger-soft)]  transition"
                      >
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} title={fa ? 'حذف آزمون' : 'Delete exam'}>
        {pendingDelete && <div className="p-4"><ConfirmCard
          title={fa ? 'این آزمون حذف شود؟' : 'Delete this exam?'}
          description={fa ? `«${pendingDelete.displayName}» به‌همراه فایل‌های تصویریِ بدون استفاده حذف می‌شود. این کار بازگشت‌پذیر نیست؛ گزارش مصرف کلی دست‌نخورده می‌ماند.` : `“${pendingDelete.displayName}” and image files no other exam uses will be permanently deleted. This cannot be undone. The global usage log is not affected.`}
          confirmLabel={fa ? 'حذف آزمون' : 'Delete exam'}
          cancelLabel={fa ? 'لغو' : 'Cancel'}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        /></div>}
      </Modal>
      <Modal open={Boolean(pendingExport)} onClose={() => setPendingExport(null)} title={fa ? 'تأیید خروجی آزمون ناقص' : 'Confirm partial exam export'}>
        {pendingExport && <div className="p-4"><ConfirmCard
          title={fa ? 'آزمون ناقص است' : 'This exam is partial'}
          description={fa ? `موارد نیازمند بررسی: ${pendingExportIssues.length}. با خروجی همین وضعیت ادامه دهید؟` : `Items to review: ${pendingExportIssues.join('; ')}. Export this state anyway?`}
          confirmLabel={fa ? 'خروجی بگیر' : 'Export anyway'}
          cancelLabel={fa ? 'لغو' : 'Cancel'}
          danger
          onConfirm={confirmPendingExport}
          onCancel={() => setPendingExport(null)}
        /></div>}
      </Modal>
      </div>
    </Modal>
  );
};
