import React, { useState } from 'react';
import {
  FileCode2,
  AlertCircle,
  Eye,
  EyeOff,
  Search,
  ArrowRight,
  ImageIcon,
} from 'lucide-react';
import { ImageAsset, SourceLine } from '../types';

interface Props {
  lines: SourceLine[];
  pages: number;
  ocrUsed: boolean;
  pageImages?: string[];
  images: ImageAsset[];
  onProceedToAnalyze: () => void;
}

export const Step2Source: React.FC<Props> = ({
  lines,
  pages,
  ocrUsed,
  pageImages = [],
  images = [],
  onProceedToAnalyze,
}) => {
  const [showLineIds, setShowLineIds] = useState(true);
  const [activePage, setActivePage] = useState<number>(1);
  const [searchQuery, setSearchQuery] = useState('');

  // Group lines by page
  const linesByPage: Record<number, SourceLine[]> = {};
  for (let p = 1; p <= pages; p++) {
    linesByPage[p] = [];
  }
  for (const line of lines) {
    if (!linesByPage[line.page]) linesByPage[line.page] = [];
    linesByPage[line.page].push(line);
  }

  // Filter lines if search query is active
  const filteredLines = searchQuery.trim()
    ? lines.filter(l => l.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : (linesByPage[activePage] || lines);

  return (
    <div className="max-w-6xl mx-auto py-6 px-4 space-y-4">
      {/* Top Banner & Control Bar */}
      {ocrUsed && (
        <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300 flex items-center gap-2.5 text-xs">
          <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
          <span>Text produced by vision OCR — review for errors before parsing.</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <FileCode2 className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-xs font-bold text-slate-900 dark:text-white">
              Line-Addressed Source (LAS)
            </h2>
            <p className="text-[11px] text-slate-500">
              {lines.length} lines indexed • {images.length} images anchored • {pages} page(s)
            </p>
          </div>
        </div>

        {/* Search & Gutter Toggle */}
        <div className="flex items-center gap-2 text-xs">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search source..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs w-44"
            />
          </div>

          <button
            onClick={() => setShowLineIds(!showLineIds)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs transition cursor-pointer"
          >
            {showLineIds ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span>{showLineIds ? 'Hide Line IDs' : 'Show Line IDs'}</span>
          </button>

          <button
            onClick={onProceedToAnalyze}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs transition cursor-pointer shadow-xs ml-2"
          >
            <span>Analyze Structure</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Dual-Pane: Thumbnails Sidebar + Code Gutter */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 h-[70vh]">
        {/* Page Thumbnails Sidebar */}
        <div className="md:col-span-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-3 overflow-y-auto space-y-3">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-1">
            Pages ({pages})
          </div>

          <div className="space-y-2">
            {Array.from({ length: pages }, (_, i) => i + 1).map(pageNum => {
              const isSelected = activePage === pageNum && !searchQuery;
              const pageImg = pageImages[pageNum - 1];
              const lineCount = linesByPage[pageNum]?.length || 0;
              const pageAssetCount = images.filter(img => img.page === pageNum).length;

              return (
                <button
                  key={pageNum}
                  onClick={() => {
                    setActivePage(pageNum);
                    setSearchQuery('');
                  }}
                  className={`w-full p-2 rounded-xl text-left border transition cursor-pointer flex gap-2.5 items-center ${
                    isSelected
                      ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/30'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  {pageImg ? (
                    <img
                      src={pageImg}
                      alt={`Page ${pageNum}`}
                      className="w-12 h-16 object-cover rounded border border-slate-200 dark:border-slate-700 shrink-0 bg-white"
                    />
                  ) : (
                    <div className="w-12 h-16 rounded border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 font-mono text-xs shrink-0">
                      P{pageNum}
                    </div>
                  )}

                  <div className="space-y-0.5 min-w-0">
                    <div className="font-semibold text-xs text-slate-800 dark:text-slate-200">
                      Page {pageNum}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {lineCount} lines
                    </div>
                    {pageAssetCount > 0 && (
                      <div className="flex items-center gap-1 text-[10px] text-purple-600 dark:text-purple-400">
                        <ImageIcon className="w-2.5 h-2.5" />
                        <span>{pageAssetCount} image(s)</span>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Monospace Line-Addressed Source Gutter */}
        <div className="md:col-span-9 bg-slate-950 text-slate-100 rounded-2xl border border-slate-800 p-4 font-mono text-xs overflow-y-auto shadow-inner flex flex-col">
          {/* Page Marker Header */}
          <div className="text-slate-500 select-none pb-2 mb-2 border-b border-slate-800 flex items-center justify-between">
            <span>=== PAGE {searchQuery ? 'SEARCH RESULTS' : activePage} ===</span>
            <span className="text-[10px] text-slate-400">
              Only numbered source is sent to AI (Span Reference contract)
            </span>
          </div>

          <div className="space-y-1">
            {filteredLines.length === 0 ? (
              <div className="text-slate-500 py-10 text-center">
                No lines found on this page.
              </div>
            ) : (
              filteredLines.map(line => (
                <div
                  key={line.id}
                  className="flex items-start gap-3 hover:bg-slate-900/80 px-1 py-0.5 rounded transition group"
                >
                  {showLineIds && (
                    <span className="text-slate-600 dark:text-slate-500 select-none shrink-0 w-12 font-medium text-[11px] group-hover:text-blue-400">
                      [{line.id}]
                    </span>
                  )}
                  <span className="text-slate-200 whitespace-pre-wrap break-words leading-relaxed flex-1">
                    {line.text}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
