import React, { useEffect, useState } from 'react';
import { FileText, Zap, Settings, HelpCircle, Database, ChevronDown, FolderOpen, Moon, Sun, Command } from 'lucide-react';
import { ExamDoc, UsageRecord, getDisplayName } from '../types';
import { summarizeUsage } from '../utils/budget';
import { getStorageBackend, loadSettings } from '../store';
import { getExamHealth } from '../pipeline/quality';
import { computeQualityScore } from '../utils/qualityScore';
import { Button, Badge, Stat, Kbd } from '../design/primitives';
import { UiLanguage, uiText } from '../design/i18n';

interface Props {
  activeDoc: ExamDoc | null;
  usageRecords: UsageRecord[];
  onOpenSettings: () => void;
  onOpenExplainer: () => void;
  onLoadDemo: () => void;
  onOpenLibrary: () => void;
  onOpenPalette?: () => void;
  onShortcutHelp?: () => void;
  onToggleTheme?: () => void;
  themeMode?: 'system' | 'light' | 'dark';
  language?: UiLanguage;
  contextTitle?: string;
}

export const Header: React.FC<Props> = ({
  activeDoc,
  usageRecords,
  onOpenSettings,
  onOpenExplainer,
  onLoadDemo,
  onOpenLibrary,
  onOpenPalette,
  onShortcutHelp,
  onToggleTheme,
  themeMode = 'system',
  language,
  contextTitle,
}) => {
  const [showUsagePopover, setShowUsagePopover] = useState(false);
  const [storageChip, setStorageChip] = useState('');
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    let mounted = true;
    getStorageBackend().then(info => {
      if (mounted) setStorageChip(info.mode === 'folder' ? (info.dir || 'local folder') : 'not configured');
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener?.('change', sync);
    return () => media.removeEventListener?.('change', sync);
  }, []);
  const t = (en: string, fa: string) => uiText(language, en, fa);
  const settings = loadSettings();
  const summary = summarizeUsage(usageRecords, settings.costTable);
  let health: ReturnType<typeof getExamHealth> | null = null;
  let quality: ReturnType<typeof computeQualityScore> | null = null;
  try { if (activeDoc) { health = getExamHealth(activeDoc); quality = computeQualityScore(activeDoc); } } catch { /* incomplete drafts still render safely */ }
  const isDark = themeMode === 'dark' || (themeMode === 'system' && systemDark);
  const themeLabel = isDark ? t('Use light theme', 'استفاده از پوسته روشن') : t('Use dark theme', 'استفاده از پوسته تیره');

  return <header className="ep-context-header print:hidden">
    <div className="min-w-0 flex items-center gap-12">
      <div className="min-w-0">
        <h1 id="view-context-heading" tabIndex={-1} className="ep-context-title truncate">{contextTitle || (activeDoc ? getDisplayName(activeDoc) : 'ExamParse')}</h1>
        <div className="flex min-w-0 flex-wrap items-center gap-2 ep-caption">
          {activeDoc && <><span className="truncate max-w-64" title={getDisplayName(activeDoc)}>{getDisplayName(activeDoc)}</span><span aria-hidden="true">·</span><span className="ep-mono">{activeDoc.source.pages} {t('pages', 'صفحه')}</span>{activeDoc.source.ocrUsed && <Badge tone="warn">OCR</Badge>}</>}
          <span className="hidden md:inline truncate" title={storageChip}>{t('Folder', 'پوشه')}: {storageChip || t('checking', 'در حال بررسی')}</span>
        </div>
      </div>
      {activeDoc && health && quality && <div className="hidden xl:flex items-center gap-6 border-inline-start border-[var(--rule)] ps-4">
        <Stat label={t('Questions', 'سؤال')} value={`${health.parsedCount}/${health.expectedCount}`} />
        <Stat label={t('Points', 'نمره')} value={health.pointsExpected === undefined ? String(health.pointsParsed) : `${health.pointsParsed}/${health.pointsExpected}`} />
        <Stat label={t('Quality', 'کیفیت')} value={quality.total} />
      </div>}
    </div>

    <div className="flex shrink-0 items-center gap-1 sm:gap-2">
      <Button size="sm" variant="ghost" aria-label={t('Open command palette', 'باز کردن فرمان‌ها')} onClick={onOpenPalette} title={t('Command palette', 'فرمان‌ها')}><Command size={16} /><span className="hidden lg:inline">{t('Commands', 'فرمان‌ها')}</span><Kbd className="hidden xl:inline-flex">⌘K</Kbd></Button>
      <div className="relative">
        <Button size="sm" variant="ghost" aria-expanded={showUsagePopover} onClick={() => setShowUsagePopover(value => !value)} title={t('Token and cost summary', 'خلاصه توکن و هزینه')}>
          <Zap size={15} /><span className="ep-mono">{summary.totalTokens > 0 ? `${(summary.totalTokens / 1000).toFixed(1)}k` : '0'} {t('tokens', 'توکن')}</span><span className="ep-mono">${summary.totalCostUsd.toFixed(4)}</span><ChevronDown size={14} />
        </Button>
        {showUsagePopover && <section className="ep-card absolute end-0 top-full z-50 mt-2 w-72 p-4 text-[length:var(--type-12)]" aria-label={t('Session accounting', 'گزارش نشست')}>
          <div className="flex items-center justify-between border-b border-[var(--rule)] pb-2"><strong>{t('Session accounting', 'گزارش نشست')}</strong><span className="ep-mono">{summary.callCount} {t('calls', 'فراخوانی')}</span></div>
          <div className="space-y-2 py-3 ep-muted">
            <div className="flex justify-between"><span>{t('Input tokens', 'توکن ورودی')}</span><span className="ep-mono">{summary.totalInputTokens.toLocaleString()}</span></div>
            <div className="flex justify-between"><span>{t('Output tokens', 'توکن خروجی')}</span><span className="ep-mono">{summary.totalOutputTokens.toLocaleString()}</span></div>
            <div className="flex justify-between"><span><Database size={13} className="inline" /> {t('Cache hits', 'برخوردهای حافظه نهان')}</span><span className="ep-mono">{summary.cacheHitCount}</span></div>
            <div className="flex justify-between border-t border-[var(--rule)] pt-2"><span>{t('Total spent', 'هزینه کل')}</span><span className="ep-mono">${summary.totalCostUsd.toFixed(5)}</span></div>
            <div className="flex justify-between"><span>{t('Saved by cache', 'صرفه‌جویی حافظه نهان')}</span><span className="ep-mono">${summary.totalSavedUsd.toFixed(5)}</span></div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowUsagePopover(false)}>{t('Close', 'بستن')}</Button>
        </section>}
      </div>
      <Button size="sm" variant="ghost" onClick={onOpenLibrary} aria-label={t('Library', 'کتابخانه')}><FolderOpen size={16} /><span className="hidden md:inline">{t('Library', 'کتابخانه')}</span></Button>
      <Button size="sm" variant="ghost" className="hidden lg:inline-flex" onClick={onLoadDemo} title={t('Load the built-in physics and math exam', 'بارگذاری آزمون نمونه فیزیک و ریاضی')}><FileText size={15} /><span>{t('Demo', 'نمونه')}</span></Button>
      <Button size="sm" variant="ghost" onClick={onToggleTheme} aria-label={themeLabel} title={themeLabel}>{isDark ? <Sun size={16} /> : <Moon size={16} />}</Button>
      <Button size="sm" variant="ghost" onClick={onShortcutHelp} aria-label={t('Keyboard shortcuts', 'میانبرهای صفحه‌کلید')} title={t('Keyboard shortcuts', 'میانبرهای صفحه‌کلید')}><HelpCircle size={16} /></Button>
      <Button size="sm" variant="ghost" onClick={onOpenSettings} aria-label={t('Settings & Provider Config', 'تنظیمات و پیکربندی ارائه‌دهنده')} title={t('Settings & Provider Config', 'تنظیمات و پیکربندی ارائه‌دهنده')}><Settings size={16} /></Button>
    </div>
  </header>;
};
