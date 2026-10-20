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
import { ImageAsset, LineTag, SourceLine } from '../types';
import { getImageBlob, getPipelineCache, setPipelineCache } from '../store';
import { runCleanupStage, isPromptOmitted } from '../pipeline/cleanup';
import { enumerateExpectedQuestionNos } from '../pipeline/quality';

interface Props {
  diagnostics?: import('../pipeline/extractionQuality').ExtractionDiagnostics;
  lines: SourceLine[];
  pages: number;
  ocrUsed: boolean;
  pageImages?: string[];
  pageThumbKeys?: string[];
  images: ImageAsset[];
  onProceedToAnalyze: () => void;
  /** A4 — Cleanup lens: overrides are stored per file hash and respected by the pipeline. */
  fileHash?: string;
  /** Post-parse lines carrying AI verdict tags (when the open exam matches this import). */
  taggedLines?: SourceLine[];
  /** Line number to scroll to (Step 4 → Step 2 orphan jump). */
  focusLine?: number;
}

type CleanupLens = 'all' | 'kept' | 'junk' | 'suspect';
const JUNK_TAGS = new Set<LineTag>(['junk', 'pagenum', 'furniture']);
export function lensMatches(line: SourceLine, lens: CleanupLens): boolean {
  if (lens === 'all') return true;
  if (lens === 'junk') return Boolean(line.tag && JUNK_TAGS.has(line.tag));
  if (lens === 'suspect') return line.tag === 'suspect-junk' || Boolean(line.garbled);
  return !(line.tag && JUNK_TAGS.has(line.tag)) && line.tag !== 'suspect-junk';
}
const TAG_LABEL: Record<string, string> = { keep: 'KEEP', junk: 'JUNK', 'suspect-junk': 'SUSPECT', furniture: 'FURNITURE', pagenum: 'PAGE#', key: 'KEY', header: 'HDR', instruction: 'INSTR', question: 'Q', option: 'OPT', passage: 'PASSAGE', dialogue: 'DIALOGUE', 'table-row': 'ROW' };

export const Step2Source: React.FC<Props> = ({
  diagnostics,
  lines,
  pages,
  ocrUsed,
  pageImages = [],
  pageThumbKeys = [],
  images = [],
  onProceedToAnalyze,
  fileHash,
  taggedLines,
  focusLine,
}) => {
  const [showLineIds, setShowLineIds] = useState(true);
  const [activePage, setActivePage] = useState<number>(() => (focusLine ? (lines.find(l => Number(l.id.replace(/\D/g, '')) === focusLine)?.page || 1) : 1));
  const [searchQuery, setSearchQuery] = useState('');
  const [thumbUrls, setThumbUrls] = useState<string[]>([]);
  // A4 — Cleanup lens state: local pre-pass tags (0 calls) or the post-parse AI tags, plus user overrides.
  const [lens, setLens] = useState<CleanupLens>('all');
  const [overrides, setOverrides] = useState<Record<string, LineTag>>({});
  const [tagged, setTagged] = useState<SourceLine[]>(lines);
  const [cleanupNote, setCleanupNote] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!fileHash) return;
      const stored = (await getPipelineCache<Record<string, LineTag>>(`cleanupOverrides:${fileHash}`)) || {};
      if (mounted) setOverrides(stored);
    })();
    return () => { mounted = false; };
  }, [fileHash]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const base = taggedLines && taggedLines.length === lines.length ? taggedLines : lines;
      const keyLines = enumerateExpectedQuestionNos(lines).keyTerritory.lineNos;
      if (taggedLines && taggedLines.length === lines.length && Object.keys(overrides).length === 0) {
        if (mounted) { setTagged(base); setCleanupNote('AI verdicts from the last parse'); }
        return;
      }
      const result = await runCleanupStage({ lines: base, keyLines, pages, enabled: false, overrides });
      if (!mounted) return;
      // Keep AI tags from the parse where no local/user verdict exists.
      const merged = result.lines.map((l, i) => (!l.tag && base[i]?.tag ? { ...l, tag: base[i].tag, tagSource: base[i].tagSource, tagConf: base[i].tagConf } : l));
      setTagged(merged);
      setCleanupNote(`${taggedLines ? 'AI verdicts + ' : ''}local pre-pass (0 calls) · junk ${result.stats.junk} · ${Object.keys(overrides).length} override(s)`);
    })();
    return () => { mounted = false; };
  }, [lines, taggedLines, overrides, pages]);

  useEffect(() => {
    if (!focusLine) return;
    const el = document.getElementById(`las-line-${focusLine}`);
    el?.scrollIntoView({ block: 'center' });
  }, [focusLine, tagged, activePage]);

  const setOverride = async (lineNo: number, tag: LineTag | '') => {
    const next = { ...overrides };
    if (tag) next[String(lineNo)] = tag; else delete next[String(lineNo)];
    setOverrides(next);
    if (fileHash) { try { await setPipelineCache(`cleanupOverrides:${fileHash}`, next); } catch { /* local-only until storage is back */ } }
  };
  const lensCounts = {
    all: tagged.length,
    kept: tagged.filter(l => lensMatches(l, 'kept')).length,
    junk: tagged.filter(l => lensMatches(l, 'junk')).length,
    suspect: tagged.filter(l => lensMatches(l, 'suspect')).length,
  };

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
  for (const line of tagged) {
    if (!linesByPage[line.page]) linesByPage[line.page] = [];
    linesByPage[line.page].push(line);
  }

  // Filter lines if search query is active, then by the Cleanup lens
  const filteredLines = (searchQuery.trim()
    ? tagged.filter(l => l.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : (linesByPage[activePage] || tagged)).filter(l => lensMatches(l, lens));

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
        <div className="flex items-center gap-2 text-xs flex-wrap">
          {/* A4 — Cleanup lens */}
          <div role="group" aria-label="Cleanup lens" title={cleanupNote} className="flex items-center rounded-[6px] border border-[var(--rule)] overflow-hidden">
            {(['all', 'kept', 'junk', 'suspect'] as CleanupLens[]).map(value => (
              <button
                key={value}
                onClick={() => setLens(value)}
                aria-pressed={lens === value}
                className={`px-2.5 py-1.5 text-xs capitalize cursor-pointer ${lens === value ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'hover:bg-[var(--paper)] text-[var(--ink)]'}`}
              >
                {value} <span className="opacity-70">{lensCounts[value]}</span>
              </button>
            ))}
          </div>
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
              filteredLines.map(line => {
                const lineNo = Number(line.id.replace(/\D/g, ''));
                const omitted = isPromptOmitted(line);
                const override = overrides[String(lineNo)];
                const isFocus = focusLine === lineNo;
                return (
                <div
                  key={line.id}
                  id={`las-line-${lineNo}`}
                  className={`flex items-start gap-3 hover:bg-[var(--paper-raised)] px-1 py-0.5 rounded-[6px] transition group ${isFocus ? 'ring-1 ring-[var(--accent)]' : ''} ${omitted ? 'opacity-60' : ''}`}
                >
                  {showLineIds && (
                    <span className="text-[var(--ink-2)]  select-none shrink-0 w-12 font-medium text-[length:var(--type-12)] group-hover:text-[var(--accent-ink)]">
                      [{line.id}]
                    </span>
                  )}
                  {(line.tag || line.garbled) && (
                    <span
                      title={`${line.tag ? `${line.tag} (${line.tagSource || 'local'}${line.tagConf !== undefined ? ` · conf ${line.tagConf}` : ''})` : ''}${line.garbled ? ' · low readability [GARBLED?]' : ''}${omitted ? ' · omitted from structure prompts' : ''}`}
                      className={`select-none shrink-0 text-[length:var(--type-12)] px-1 rounded-[4px] border ${line.tag === 'junk' ? 'border-[var(--danger)] text-[var(--danger)]' : line.tag === 'suspect-junk' || line.garbled ? 'border-[var(--warn)] text-[var(--warn-ink)]' : 'border-[var(--rule)] text-[var(--ink-2)]'}`}
                    >
                      {line.tag ? TAG_LABEL[line.tag] || line.tag : ''}{line.garbled ? (line.tag ? ' ?' : 'GARBLED?') : ''}
                    </span>
                  )}
                  <span className={`whitespace-pre-wrap break-words leading-relaxed flex-1 ${omitted ? 'line-through text-[var(--ink-2)]' : 'text-[var(--ink)]'}`}>
                    {line.text}
                  </span>
                  {fileHash && (
                    <select
                      aria-label={`Cleanup override for ${line.id}`}
                      value={override || ''}
                      onChange={e => void setOverride(lineNo, e.target.value as LineTag | '')}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 text-[length:var(--type-12)] border border-[var(--rule)] rounded-[4px] bg-[var(--paper)] px-1"
                      style={override ? { opacity: 1 } : undefined}
                    >
                      <option value="">auto</option>
                      <option value="keep">keep</option>
                      <option value="junk">junk</option>
                      <option value="header">header</option>
                      <option value="instruction">instruction</option>
                    </select>
                  )}
                </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
