/**
 * Exam Library (full-screen overlay, not a stepper step).
 * Lists stored exams from IndexedDB with open / rename / duplicate / export / delete.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  countBrowserExams,
  deleteExam,
  getStorageBackend,
  listExamSummaries,
  loadExamDoc,
  migrateBrowserToFolder,
  saveExamDoc,
} from '../store';
import { duplicateExamDoc, exportExamJson } from '../utils/examExport';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  activeExamId?: string | null;
  onOpenExam: (doc: ExamDoc) => void;
  onExamRenamed: (doc: ExamDoc) => void;
  onExamDeleted: (id: string) => void;
  onGoToImport: () => void;
}

type SortMode = 'newest' | 'oldest' | 'name';

export const LibraryView: React.FC<Props> = ({
  isOpen,
  onClose,
  activeExamId,
  onOpenExam,
  onExamRenamed,
  onExamDeleted,
  onGoToImport,
}) => {
  const [summaries, setSummaries] = useState<ExamSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('newest');
  const [storageMb, setStorageMb] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ExamSummary | null>(null);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [storageMode, setStorageMode] = useState<{ mode: string; dir?: string }>({ mode: 'browser' });
  const [browserExamCount, setBrowserExamCount] = useState(0);
  const [migrationMsg, setMigrationMsg] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
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
        if (backend.mode === 'folder') {
          setBrowserExamCount(await countBrowserExams());
        }
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

  useEffect(() => {
    if (isOpen) {
      refresh();
    }
  }, [isOpen, refresh]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? summaries.filter(s =>
          [s.displayName, s.subject || '', s.grade || '', s.fileName]
            .join(' ')
            .toLowerCase()
            .includes(q)
        )
      : [...summaries];
    switch (sort) {
      case 'oldest':
        filtered.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
        break;
      case 'name':
        filtered.sort((a, b) => a.displayName.localeCompare(b.displayName));
        break;
      default:
        filtered.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    }
    return filtered;
  }, [summaries, search, sort]);

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
    exportExamJson(doc);
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

  if (!isOpen) return null;

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 overflow-y-auto">
      <div className="max-w-5xl mx-auto py-6 px-4 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-600 text-white">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold">Exam Library</h1>
              <p className="text-xs text-slate-500">
                {summaries.length} exam(s) stored locally
                {storageMb !== null ? ` · ${storageMb.toFixed(1)} MB used` : ''} ·{' '}
                {storageMode.mode === 'folder' ? `Storage: Folder (${storageMode.dir || 'data'})` : 'Storage: Browser'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800"
            title="Close library"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, subject, grade, or file name…"
              className="w-full bg-transparent outline-hidden text-xs text-slate-900 dark:text-slate-200"
            />
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortMode)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs"
            title="Sort exams"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name (A–Z)</option>
          </select>
          <button
            onClick={handleClearCaches}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition text-xs font-medium"
            title="Delete cached pipeline stage results (exams are kept)"
          >
            <Database className="w-3.5 h-3.5 text-purple-500" />
            <span>{cacheCleared ? 'Caches cleared!' : 'Clear pipeline caches'}</span>
          </button>
        </div>

        {storageMode.mode === 'folder' && summaries.length === 0 && browserExamCount > 0 && (
          <div className="p-4 rounded-2xl border border-blue-500/30 bg-blue-500/10 text-blue-800 dark:text-blue-300 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div>
              <div className="font-bold">Migrate {browserExamCount} exams from browser storage to folder</div>
              <p>Folder storage is active ({storageMode.dir || 'data'}) but empty. Your browser copy is never deleted by migration.</p>
              {migrationMsg && <p className="mt-1 font-medium">{migrationMsg}</p>}
            </div>
            <button
              disabled={migrating}
              onClick={async () => {
                setMigrating(true);
                try {
                  const res = await migrateBrowserToFolder();
                  setMigrationMsg(
                    res.verified
                      ? `Migrated ${res.examsCopied} exams, ${res.imagesCopied} images, ${res.cachesCopied} caches — counts verified (${res.folderExamCount} in folder). Browser copy kept.`
                      : `Migration finished but counts differ: copied ${res.examsCopied}, folder has ${res.folderExamCount}. Browser copy kept.`
                  );
                  await refresh();
                } catch (err: any) {
                  setMigrationMsg(`Migration failed: ${err?.message || err}`);
                } finally {
                  setMigrating(false);
                }
              }}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium transition disabled:opacity-50"
            >
              {migrating ? 'Migrating…' : 'Migrate to folder'}
            </button>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="text-center text-xs text-slate-500 py-16">Loading library…</div>
        ) : summaries.length === 0 ? (
          <div className="text-center py-16 space-y-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl">
            <FileText className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No exams stored yet</p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Import an exam paper at Step 1 and run the analysis — every analyzed exam is saved here automatically.
            </p>
            <button
              onClick={onGoToImport}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition"
            >
              Go to Step 1 — Import
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-16">No exams match “{search}”.</div>
        ) : (
          <div className="space-y-3">
            {visible.map(s => {
              const termYear = [s.term, s.year].filter(Boolean).join(' ');
              const chips = [s.subject, s.grade, termYear].filter(Boolean) as string[];
              const isActive = activeExamId === s.id;
              return (
                <div
                  key={s.id}
                  className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2.5"
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
                            className="px-2.5 py-1.5 rounded-lg border border-blue-400 bg-white dark:bg-slate-950 text-sm font-semibold w-72 max-w-full"
                          />
                          <button
                            onClick={() => commitRename(s)}
                            className="p-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                            title="Save name"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setRenamingId(null)}
                            className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                            title="Cancel rename"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="font-semibold text-base text-slate-900 dark:text-white truncate">
                          {s.displayName}
                          {isActive && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 align-middle">
                              open
                            </span>
                          )}
                        </div>
                      )}
                      <div className="text-[11px] text-slate-400 truncate" title={s.fileName}>
                        {s.fileName}
                      </div>
                    </div>
                    {s.ocrUsed && (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                        <ScanText className="w-3 h-3" /> OCR
                      </span>
                    )}
                  </div>

                  {chips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {chips.map((chip, i) => (
                        <span
                          key={i}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                      <span>{s.pages} pages</span>
                      <span>{s.questionCount} questions</span>
                      <span>{s.imageCount} images</span>
                      <span>{s.sectionCount} sections</span>
                      <span title={s.createdAt}>{formatDate(s.createdAt)}</span>
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">
                        ${s.totalCostUsd.toFixed(4)} lifetime · {s.totalTokens.toLocaleString()} toks
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <button
                        onClick={() => handleOpen(s)}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => startRename(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                      >
                        <Pencil className="w-3 h-3" /> Rename
                      </button>
                      <button
                        onClick={() => handleDuplicate(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                      >
                        <Copy className="w-3 h-3" /> Duplicate
                      </button>
                      <button
                        onClick={() => handleExport(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                      >
                        <Download className="w-3 h-3" /> Export JSON
                      </button>
                      <button
                        onClick={() => setPendingDelete(s)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-300 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition"
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

      {/* Delete confirmation dialog */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-red-500/10 text-red-500 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">Delete this exam?</h2>
                <p className="text-xs text-slate-500 mt-1">
                  “{pendingDelete.displayName}” ({pendingDelete.fileName}) will be permanently deleted,
                  along with any image files no other exam uses. This cannot be undone. Your global usage log is not affected.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 rounded-xl text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition"
              >
                Delete exam
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
