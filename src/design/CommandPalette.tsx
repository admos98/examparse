import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { ExamSummary } from '../store';
import { Badge, Input, Kbd, Modal } from './primitives';
import { UiLanguage, uiText } from './i18n';

export interface PaletteItem {
  id: string;
  title: string;
  keywords?: string;
  group: string;
  hint?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

const RECENTS_KEY = 'examparse_palette_recents_v1';

export function fuzzyScore(query: string, target: string): number {
  const needle = query.trim().toLocaleLowerCase();
  const haystack = target.toLocaleLowerCase();
  if (!needle) return 1;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return 100 - exact + (haystack.length === needle.length ? 50 : 0);
  let cursor = 0;
  let score = 0;
  let run = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return 0;
    run = found === cursor ? run + 1 : 0;
    score += 4 + run * 2 - Math.min(3, found - cursor);
    cursor = found + 1;
  }
  return score;
}

export function rankPaletteItems<T extends Pick<PaletteItem, 'title' | 'keywords' | 'id'>>(items: T[], query: string, recents: string[] = []): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, `${item.title} ${item.keywords || ''}`), recent: recents.indexOf(item.id) }))
    .filter(entry => !query.trim() || entry.score > 0)
    .sort((a, b) => query.trim()
      ? b.score - a.score || (a.recent < 0 ? Infinity : a.recent) - (b.recent < 0 ? Infinity : b.recent) || a.index - b.index
      : (a.recent < 0 ? Infinity : a.recent) - (b.recent < 0 ? Infinity : b.recent) || a.index - b.index)
    .map(entry => entry.item);
}

export function nextEnabledPaletteIndex(items: Pick<PaletteItem, 'disabled'>[], currentIndex: number, direction: -1 | 1): number {
  const start = currentIndex < 0 ? (direction > 0 ? -1 : items.length) : currentIndex;
  for (let index = start + direction; index >= 0 && index < items.length; index += direction) {
    if (!items[index].disabled) return index;
  }
  if (items[currentIndex] && !items[currentIndex].disabled) return currentIndex;
  if (currentIndex < 0) return -1;
  for (let index = currentIndex - direction; index >= 0 && index < items.length; index -= direction) {
    if (!items[index].disabled) return index;
  }
  return -1;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  summaries: ExamSummary[];
  language?: UiLanguage;
  currentStep: number;
  maxReachedStep: number;
  onNavigateStep: (step: 1 | 2 | 3 | 4 | 5) => void;
  onOpenExam: (summary: ExamSummary) => void | Promise<void>;
  onOpenLibrary: () => void;
  onAskAssistant: (verify?: boolean) => void;
  onOpenSettings: (tab?: string) => void;
  onRetry: () => void;
  onExport: () => void;
  onToggleTheme: () => void;
  onActionError?: () => void;
  hasExam: boolean;
  canRetry: boolean;
}

type PaletteContext = Pick<CommandPaletteProps, 'summaries' | 'language' | 'currentStep' | 'maxReachedStep' | 'onNavigateStep' | 'onOpenExam' | 'onOpenLibrary' | 'onAskAssistant' | 'onOpenSettings' | 'onRetry' | 'onExport' | 'onToggleTheme' | 'hasExam' | 'canRetry'>;

export function buildPaletteItems({
  summaries, language, currentStep, maxReachedStep, onNavigateStep, onOpenExam, onOpenLibrary, onAskAssistant,
  onOpenSettings, onRetry, onExport, onToggleTheme, hasExam, canRetry,
}: PaletteContext): PaletteItem[] {
  const t = (en: string, fa: string) => uiText(language, en, fa);
  const stepNames = [
    [1, 'Import', 'ورود'], [2, 'Source', 'منبع'], [3, 'Analyze', 'تحلیل'], [4, 'Review', 'بازبینی'], [5, 'Exam', 'آزمون'],
  ] as const;
  const base: PaletteItem[] = stepNames.map(([step, en, fa]) => ({
    id: `step-${step}`, title: `${step}. ${t(en, fa)}`, keywords: `${en} ${fa} workflow`, group: t('Workflow', 'گردش کار'), hint: currentStep === step ? t('Current', 'اکنون') : undefined, disabled: step > maxReachedStep, run: () => onNavigateStep(step),
  }));
  base.push(
    { id: 'library', title: t('Library', 'کتابخانه'), keywords: 'exams saved documents', group: t('Workspace', 'فضای کاری'), run: onOpenLibrary },
    { id: 'assistant', title: t('Ask assistant…', 'پرسش از دستیار…'), keywords: 'chat assistant help', group: t('Workspace', 'فضای کاری'), disabled: !hasExam, run: () => onAskAssistant(false) },
    { id: 'settings', title: t('Settings', 'تنظیمات'), keywords: 'preferences providers', group: t('System', 'سیستم'), run: () => onOpenSettings() },
    { id: 'diagnostics', title: t('Diagnostics', 'عیب‌یابی'), keywords: 'system health runs', group: t('System', 'سیستم'), run: () => onOpenSettings('diagnostics') },
    { id: 'memory', title: t('Memory', 'حافظه'), keywords: 'playbook skills learned', group: t('System', 'سیستم'), run: () => onOpenSettings('assistant') },
    { id: 'check-exam', title: t('Check this exam', 'بررسی این آزمون'), keywords: 'verify health assistant parse', group: t('Actions', 'اقدام‌ها'), disabled: !hasExam, run: () => onAskAssistant(true) },
    { id: 'retry-coverage', title: t('Run remediation', 'اجرای بازیابی'), keywords: 'retry recover missing coverage', group: t('Actions', 'اقدام‌ها'), disabled: !canRetry, run: onRetry },
    { id: 'export-json', title: t('Export JSON', 'خروجی JSON'), keywords: 'download exam', group: t('Actions', 'اقدام‌ها'), disabled: !hasExam || maxReachedStep < 5, run: onExport },
    { id: 'toggle-theme', title: t('Toggle dark mode', 'تغییر حالت تیره'), keywords: 'theme appearance light dark', group: t('Actions', 'اقدام‌ها'), run: onToggleTheme },
  );
  summaries.forEach(summary => base.push({
    id: `exam-${summary.id}`,
    title: summary.displayName || summary.fileName,
    keywords: `${summary.subject || ''} ${summary.grade || ''} ${summary.fileName} exam document`,
    group: t('Recent exams', 'آزمون‌های اخیر'),
    hint: summary.createdAt ? new Date(summary.createdAt).toLocaleDateString(language === 'fa' ? 'fa-IR' : 'en-US') : undefined,
    run: () => onOpenExam(summary),
  }));
  return base;
}

export function CommandPalette({
  open,
  onClose,
  summaries,
  language,
  currentStep,
  maxReachedStep,
  onNavigateStep,
  onOpenExam,
  onOpenLibrary,
  onAskAssistant,
  onOpenSettings,
  onRetry,
  onExport,
  onToggleTheme,
  onActionError,
  hasExam,
  canRetry,
}: CommandPaletteProps) {
  const t = (en: string, fa: string) => uiText(language, en, fa);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]').slice(0, 12); } catch { return []; }
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const openStarted = useRef(0);
  const [openElapsed, setOpenElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    openStarted.current = typeof performance !== 'undefined' ? performance.now() : 0;
    setQuery('');
    setActiveIndex(0);
    setOpenElapsed(null);
    const timeout = window.setTimeout(() => {
      const now = typeof performance !== 'undefined' ? performance.now() : openStarted.current;
      setOpenElapsed(Math.round((now - openStarted.current) * 100) / 100);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => buildPaletteItems({
    summaries, language, currentStep, maxReachedStep, onNavigateStep, onOpenExam, onOpenLibrary, onAskAssistant,
    onOpenSettings, onRetry, onExport, onToggleTheme, hasExam, canRetry,
  }), [summaries, language, currentStep, maxReachedStep, hasExam, canRetry, onNavigateStep, onOpenExam, onOpenLibrary, onAskAssistant, onOpenSettings, onRetry, onExport, onToggleTheme]);

  const ranked = useMemo(() => rankPaletteItems(items, query, recents), [items, query, recents]);
  const grouped = useMemo(() => {
    const groups = new Map<string, PaletteItem[]>();
    for (const item of ranked) groups.set(item.group, [...(groups.get(item.group) || []), item]);
    return [...groups.entries()];
  }, [ranked]);
  const flat = useMemo(() => grouped.flatMap(([, entries]) => entries), [grouped]);
  useEffect(() => {
    setActiveIndex(index => flat[index] && !flat[index].disabled ? index : flat.findIndex(item => !item.disabled));
  }, [flat]);

  const remember = (id: string) => {
    const next = [id, ...recents.filter(value => value !== id)].slice(0, 12);
    setRecents(next);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* storage can be disabled */ }
  };
  const select = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    remember(item.id);
    onClose();
    window.setTimeout(() => {
      try { void Promise.resolve(item.run()).catch(() => onActionError?.()); }
      catch { onActionError?.(); }
    }, 0);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(index => nextEnabledPaletteIndex(flat, index, direction));
    } else if (event.key === 'Enter') { event.preventDefault(); select(flat[activeIndex]); }
  };

  return <Modal open={open} onClose={onClose} title={t('Command palette', 'فرمان‌ها')} className="ep-palette-modal">
    <div className="flex items-center gap-3 border-b border-[var(--rule)] p-4">
      <Search size={18} aria-hidden="true" className="text-[var(--ink-3-text)]" />
      <Input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder={t('Search views, exams, actions…', 'جستجوی صفحه، آزمون یا اقدام…')} aria-label={t('Search commands', 'جستجوی فرمان‌ها')} role="combobox" aria-expanded={open} aria-controls="palette-list" aria-activedescendant={flat[activeIndex] ? `palette-option-${flat[activeIndex].id}` : undefined} autoComplete="off" />
      <Kbd>Esc</Kbd>
    </div>
    <div className="ep-palette-list p-3">
      {!flat.length && <p className="ep-caption px-2" role="status">{t('No matching commands.', 'فرمانی پیدا نشد.')}</p>}
      <div id="palette-list" role="listbox" aria-label={t('Commands and exams', 'فرمان‌ها و آزمون‌ها')}>
      {grouped.map(([group, entries]) => <div key={group} role="group" aria-label={group}>
        <div className="ep-palette-group" aria-hidden="true">{group}</div>
        {entries.map(item => {
          const index = flat.findIndex(candidate => candidate.id === item.id);
          return <button
            key={item.id}
            id={`palette-option-${item.id}`}
            type="button"
            role="option"
            aria-selected={activeIndex === index}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            className="ep-palette-row"
            onMouseMove={() => { if (!item.disabled) setActiveIndex(index); }}
            onClick={() => select(item)}
          >
            <span>{item.title}</span>
            <span className="flex items-center gap-2 ep-caption">{item.hint && <Badge>{item.hint}</Badge>}{activeIndex === index && <CornerDownLeft size={14} aria-hidden="true" />}</span>
          </button>;
        })}
      </div>)}
      </div>
    </div>
    <div className="flex items-center justify-between border-t border-[var(--rule)] p-3 ep-caption">
      <span>{t('↑↓ navigate · Enter run', '↑↓ جابه‌جایی · Enter اجرا')}</span>
      <span className="ep-mono" data-palette-open-ms={openElapsed ?? ''}>{t('Local summaries only', 'فقط خلاصه‌های محلی')}</span>
    </div>
  </Modal>;
}
