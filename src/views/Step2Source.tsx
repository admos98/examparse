import React, { useEffect, useState } from 'react';
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
import { getImageBlob } from '../store';

interface Props {
  diagnostics?: import('../pipeline/extractionQuality').ExtractionDiagnostics;
  lines: SourceLine[];
  pages: number;
  ocrUsed: boolean;
  pageImages?: string[];
  pageThumbKeys?: string[];
  images: ImageAsset[];
  onProceedToAnalyze: () => void;
}

export const Step2Source: React.FC<Props> = ({
  diagnostics,
  lines,
  pages,
  ocrUsed,
  pageImages = [],
  pageThumbKeys = [],
  images = [],
  onProceedToAnalyze,
}) => {
  const [showLineIds, setShowLineIds] = useState(true);
  const [activePage, setActivePage] = useState<number>(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [thumbUrls, setThumbUrls] = useState<string[]>([]);

  // Resolve page thumbnails through thumb blobs like regular images (A3).
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!pageThumbKeys || pageThumbKeys.length === 0) return;
      const urls: string[] = [];
      for (const k of pageThumbKeys) {
        const blob = await getImageBlob(k);
        urls.push(blob ? URL.createObjectURL(blob) : '');
      }
      if (mounted) setThumbUrls(urls);
    })();
    return () => { mounted = false; };
  }, [pageThumbKeys]);

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
      {diagnostics && <div className="p-3 border rounded-[10px] text-xs space-y-1">
        <p>Extraction: {diagnostics.pages} pages · lines/page {diagnostics.linesPerPage.join(', ')} · furniture {diagnostics.furnitureCount}</p>
        <p>Images found/merged/dropped: {diagnostics.imagesFound}/{diagnostics.imagesMerged}/{diagnostics.imagesDropped} · OCR pages {diagnostics.ocrPages.join(', ') || 'none'} · suspect strips {diagnostics.suspectStripCount}</p>
        {diagnostics.emptyPages.length > 0 && <p role="alert" className="text-[var(--danger)]">EXTRACTION_PAGE_EMPTY (error): {diagnostics.emptyPages.join(', ')}. OCR has not produced text. Review import before parsing.</p>}
      </div>}
      {/* Top Banner & Control Bar */}
      {ocrUsed && (
        <div className="p-3.5 rounded-[10px] border border-[var(--warn)] bg-[var(--warn-soft)] text-[var(--warn-ink)]  flex items-center gap-2.5 text-xs">
          <AlertCircle className="w-4 h-4 text-[var(--warn-ink)] shrink-0" />
          <span>Text produced by vision OCR — review for errors before parsing.</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-3.5">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-[10px] bg-[var(--paper)] text-[var(--accent-ink)] ">
            <FileCode2 className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-xs font-bold text-[var(--ink)] ">
              Line-Addressed Source (LAS)
            </h2>
            <p className="text-[length:var(--type-12)] text-[var(--ink-2)]">
              {lines.length} lines indexed • {images.length} images anchored • {pages} page(s)
            </p>
          </div>
        </div>

        {/* Search & Gutter Toggle */}
        <div className="flex items-center gap-2 text-xs">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[var(--ink-2)] absolute start-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search source..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="ps-8 pe-3 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper)]  text-xs w-44"
            />
          </div>

          <button
            onClick={() => setShowLineIds(!showLineIds)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border border-[var(--rule)]  hover:bg-[var(--paper)]  text-[var(--ink)]  text-xs transition cursor-pointer"
          >
            {showLineIds ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span>{showLineIds ? 'Hide Line IDs' : 'Show Line IDs'}</span>
          </button>

          <button
            onClick={onProceedToAnalyze}
            className="ep-directional-forward flex items-center gap-1.5 px-4 py-1.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] font-medium text-xs transition cursor-pointer  ms-2"
          >
            <span>Analyze Structure</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Dual-Pane: Thumbnails Sidebar + Code Gutter */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 h-[70vh]">
        {/* Page Thumbnails Sidebar */}
        <div className="md:col-span-3 bg-[var(--paper-raised)]  border border-[var(--rule)]  rounded-[10px] p-3 overflow-y-auto space-y-3">
          <div className="text-[length:var(--type-12)] font-semibold text-[var(--ink-2)] uppercase tracking-wider px-1">
            Pages ({pages})
          </div>

          <div className="space-y-2">
            {Array.from({ length: pages }, (_, i) => i + 1).map(pageNum => {
              const isSelected = activePage === pageNum && !searchQuery;
              const pageImg = pageImages[pageNum - 1] || thumbUrls[pageNum - 1];
              const lineCount = linesByPage[pageNum]?.length || 0;
              const pageAssetCount = images.filter(img => img.page === pageNum).length;

              return (
                <button
                  key={pageNum}
                  onClick={() => {
                    setActivePage(pageNum);
                    setSearchQuery('');
                  }}
                  className={`w-full p-2 rounded-[6px] text-start border transition cursor-pointer flex gap-2.5 items-center ${
                    isSelected
                      ? 'border-[var(--accent)] bg-[var(--paper)] '
                      : 'border-[var(--rule)]  hover:bg-[var(--paper)] '
                  }`}
                >
                  {pageImg ? (
                    <img
                      src={pageImg}
                      alt={`Page ${pageNum}`}
                      className="w-12 h-16 object-cover rounded-[6px] border border-[var(--rule)]  shrink-0 bg-[var(--paper-raised)]"
                    />
                  ) : (
                    <div className="w-12 h-16 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper)]  flex items-center justify-center text-[var(--ink-2)] font-mono text-xs shrink-0">
                      P{pageNum}
                    </div>
                  )}

                  <div className="space-y-0.5 min-w-0">
                    <div className="font-semibold text-xs text-[var(--ink)] ">
                      Page {pageNum}
                    </div>
                    <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">
                      {lineCount} lines
                    </div>
                    {pageAssetCount > 0 && (
                      <div className="flex items-center gap-1 text-[length:var(--type-12)] text-[var(--accent-ink)] ">
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
        <div className="md:col-span-9 bg-[var(--paper-raised)] text-[var(--ink)] rounded-[10px] border border-[var(--rule-strong)] p-4 font-mono text-xs overflow-y-auto  flex flex-col">
          {/* Page Marker Header */}
          <div className="text-[var(--ink-2)] select-none pb-2 mb-2 border-b border-[var(--rule-strong)] flex items-center justify-between">
            <span>=== PAGE {searchQuery ? 'SEARCH RESULTS' : activePage} ===</span>
            <span className="text-[length:var(--type-12)] text-[var(--ink-2)]">
              Only numbered source is sent to AI (Span Reference contract)
            </span>
          </div>

          <div className="space-y-1">
            {filteredLines.length === 0 ? (
              <div className="text-[var(--ink-2)] py-10 text-center">
                No lines found on this page.
              </div>
            ) : (
              filteredLines.map(line => (
                <div
                  key={line.id}
                  className="flex items-start gap-3 hover:bg-[var(--paper-raised)] px-1 py-0.5 rounded-[6px] transition group"
                >
                  {showLineIds && (
                    <span className="text-[var(--ink-2)]  select-none shrink-0 w-12 font-medium text-[length:var(--type-12)] group-hover:text-[var(--accent-ink)]">
                      [{line.id}]
                    </span>
                  )}
                  <span className="text-[var(--ink)] whitespace-pre-wrap break-words leading-relaxed flex-1">
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
