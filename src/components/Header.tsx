import React, { useEffect, useState } from 'react';
import {
  FileText,
  Zap,
  Settings,
  HelpCircle,
  Database,
  TrendingDown,
  ChevronDown,
  Sparkles,
  FolderOpen,
} from 'lucide-react';
import { ExamDoc, UsageRecord, getDisplayName } from '../types';
import { summarizeUsage } from '../utils/budget';
import { getStorageBackend, loadSettings } from '../store';

interface Props {
  activeDoc: ExamDoc | null;
  usageRecords: UsageRecord[];
  onOpenSettings: () => void;
  onOpenExplainer: () => void;
  onLoadDemo: () => void;
  onOpenLibrary: () => void;
}

export const Header: React.FC<Props> = ({
  activeDoc,
  usageRecords,
  onOpenSettings,
  onOpenExplainer,
  onLoadDemo,
  onOpenLibrary,
}) => {
  const [showUsagePopover, setShowUsagePopover] = useState(false);
  const [storageChip, setStorageChip] = useState('Storage: Checking…');
  useEffect(() => {
    let mounted = true;
    getStorageBackend()
      .then(info => {
        if (mounted) {
          setStorageChip(info.mode === 'folder' ? `Storage: Folder (${info.dir || 'data'})` : 'Storage: Not configured');
        }
      })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  const settings = loadSettings();
  const summary = summarizeUsage(usageRecords, settings.costTable);

  return (
    <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md px-4 flex items-center justify-between z-30 sticky top-0">
      {/* Brand & Active Document */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white tracking-tight text-base">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-blue-500 text-white flex items-center justify-center shadow-xs">
            <FileText className="w-4 h-4" />
          </div>
          <span>ExamParse</span>
          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            zero-waste
          </span>
          <span
            className="hidden md:inline text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-500 dark:text-slate-400 border border-slate-500/20 max-w-[260px] truncate"
            title={storageChip}
          >
            {storageChip}
          </span>
        </div>

        {activeDoc && (
          <div className="hidden sm:flex items-center gap-2 pl-3 border-l border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
            <span className="font-medium text-slate-900 dark:text-slate-200 max-w-[200px] truncate" title={getDisplayName(activeDoc)}>
              {getDisplayName(activeDoc)}
            </span>
            <span className="text-slate-400">•</span>
            <span>{activeDoc.source.pages} page(s)</span>
            {activeDoc.source.ocrUsed && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 border border-amber-500/20">
                OCR
              </span>
            )}
          </div>
        )}
      </div>

      {/* Usage Meter & Actions */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Persistent Usage Meter */}
        <div className="relative">
          <button
            onClick={() => setShowUsagePopover(!showUsagePopover)}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700/80 border border-slate-200 dark:border-slate-700/50 transition cursor-pointer text-xs"
            title="Click for detailed token & cost breakdown"
          >
            <div className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300 font-medium">
              <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
              <span>{summary.totalTokens > 0 ? `${(summary.totalTokens / 1000).toFixed(1)}k` : '0'} tokens</span>
            </div>
            <span className="text-slate-300 dark:text-slate-600">•</span>
            <div className="text-emerald-600 dark:text-emerald-400 font-semibold font-mono">
              ${summary.totalCostUsd.toFixed(4)}
            </div>

            {summary.totalSavedUsd > 0 && (
              <div className="hidden md:flex items-center gap-1 text-[11px] text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/40 px-1.5 py-0.5 rounded-md border border-purple-200 dark:border-purple-800/50">
                <TrendingDown className="w-3 h-3" />
                <span>Saved ${(summary.totalSavedUsd).toFixed(4)}</span>
              </div>
            )}
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {/* Usage Details Popover */}
          {showUsagePopover && (
            <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl p-4 text-xs z-50 animate-in fade-in zoom-in-95">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
                <span className="font-semibold text-slate-900 dark:text-white">Session API Accounting</span>
                <span className="text-[10px] text-slate-400">{summary.callCount} calls total</span>
              </div>
              <div className="py-2.5 space-y-1.5 text-slate-600 dark:text-slate-300">
                <div className="flex justify-between">
                  <span>Input Tokens:</span>
                  <span className="font-mono">{summary.totalInputTokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Output Tokens:</span>
                  <span className="font-mono">{summary.totalOutputTokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-purple-600 dark:text-purple-400">
                  <span className="flex items-center gap-1">
                    <Database className="w-3 h-3" /> Cache Hits:
                  </span>
                  <span className="font-mono">{summary.cacheHitCount} calls</span>
                </div>
                <div className="flex justify-between text-emerald-600 dark:text-emerald-400 pt-1 border-t border-slate-100 dark:border-slate-800 font-medium">
                  <span>Total Spent:</span>
                  <span className="font-mono font-bold">${summary.totalCostUsd.toFixed(5)}</span>
                </div>
                <div className="flex justify-between text-purple-600 dark:text-purple-400 font-medium">
                  <span>Est. Saved by Cache:</span>
                  <span className="font-mono font-bold">${summary.totalSavedUsd.toFixed(5)}</span>
                </div>
              </div>
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 flex justify-between items-center">
                <span>Hard budget stop: ${settings.budget.maxUsdPerRun}</span>
                <button
                  onClick={() => setShowUsagePopover(false)}
                  className="text-blue-500 hover:underline"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Exam Library Button */}
        <button
          onClick={onOpenLibrary}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700/80 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700/50 text-xs font-medium transition cursor-pointer"
          title="Open the exam library"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>Library</span>
        </button>

        {/* Demo Exam Button */}
        <button
          onClick={onLoadDemo}
          className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60 text-xs font-medium transition cursor-pointer"
          title="Load Physics & Math Demo Exam"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Demo Exam</span>
        </button>

        {/* Cost Explainer Info */}
        <button
          onClick={onOpenExplainer}
          className="p-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          title="Explain Token Savings"
        >
          <HelpCircle className="w-4 h-4" />
        </button>

        {/* Settings Gear */}
        <button
          onClick={onOpenSettings}
          className="p-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          title="Settings & Provider Config"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
