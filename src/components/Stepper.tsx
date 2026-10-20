import React, { useState } from 'react';
import { Activity, Bot, BookOpen, Brain, Check, ChevronLeft, ChevronRight, FileCode2, Printer, Settings, Upload } from 'lucide-react';
import { Button } from '../design/primitives';
import { UiLanguage, uiText } from '../design/i18n';

export type StepNumber = 1 | 2 | 3 | 4 | 5;

interface Props {
  currentStep: StepNumber;
  maxReachedStep: StepNumber;
  onSelectStep: (step: StepNumber) => void;
  language?: UiLanguage;
  storageLabel?: string;
  engineLabel?: string;
  onOpenLibrary?: () => void;
  onOpenAssistant?: () => void;
  hasExam?: boolean;
  onOpenSettings?: (tab?: string) => void;
}

const STEPS: { step: StepNumber; en: string; fa: string; icon: React.ElementType }[] = [
  { step: 1, en: 'Import', fa: 'ورود', icon: Upload },
  { step: 2, en: 'Source', fa: 'منبع', icon: FileCode2 },
  { step: 3, en: 'Analyze', fa: 'تحلیل', icon: Activity },
  { step: 4, en: 'Review', fa: 'بازبینی', icon: BookOpen },
  { step: 5, en: 'Exam', fa: 'آزمون', icon: Printer },
];

export const Stepper: React.FC<Props> = ({
  currentStep,
  maxReachedStep,
  onSelectStep,
  language,
  storageLabel,
  engineLabel,
  onOpenLibrary,
  onOpenAssistant,
  hasExam = false,
  onOpenSettings,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const t = (en: string, fa: string) => uiText(language, en, fa);
  const workflow = (mobile = false) => <nav className={mobile ? 'ep-mobile-stepper' : 'ep-rail-section'} aria-label={t('Workflow steps', 'مراحل کار')}>
    {!mobile && <div className="ep-rail-label">{t('WORKFLOW', 'گردش کار')}</div>}
    {STEPS.map(({ step, en, fa, icon: Icon }) => {
      const active = step === currentStep;
      const complete = maxReachedStep >= step && !active;
      const accessible = maxReachedStep >= step;
      const title = t(en, fa);
      return <button
        key={step}
        type="button"
        disabled={!accessible}
        onClick={() => onSelectStep(step)}
        aria-current={active ? 'page' : undefined}
        aria-label={`${step}. ${title}`}
        title={collapsed ? `${step}. ${title}` : undefined}
        className="ep-rail-link"
        data-complete={complete}
      >
        <span className="ep-rail-index">{complete ? <Check size={14} aria-hidden="true" /> : mobile ? step : <Icon size={15} aria-hidden="true" />}</span>
        <span className="ep-rail-text"><span>{step}. {title}</span></span>
      </button>;
    })}
  </nav>;

  const sidebar = <aside className="ep-sidebar" data-collapsed={collapsed} aria-label={t('Main navigation', 'ناوبری اصلی')}>
    <div className="ep-sidebar-brand">
      <span className="ep-brand-mark" aria-hidden="true"><FileCode2 size={17} strokeWidth={1.5} /></span>
      <strong className="ep-brand-name ep-display">ExamParse</strong>
      <Button className="ep-sidebar-toggle ms-auto" size="sm" variant="ghost" aria-label={collapsed ? t('Expand navigation', 'باز کردن ناوبری') : t('Collapse navigation', 'جمع کردن ناوبری')} aria-pressed={collapsed} onClick={() => setCollapsed(value => !value)}>
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </Button>
    </div>
    {workflow()}
    <div className="ep-rail-section">
      <div className="ep-rail-label">{t('WORKSPACE', 'فضای کاری')}</div>
      <button type="button" className="ep-rail-link" aria-label={t('Library', 'کتابخانه')} onClick={onOpenLibrary} title={collapsed ? t('Library', 'کتابخانه') : undefined}>
        <span className="ep-rail-index"><BookOpen size={15} aria-hidden="true" /></span><span className="ep-rail-text">{t('Library', 'کتابخانه')}</span>
      </button>
      <button type="button" className="ep-rail-link" aria-label={t('Assistant', 'دستیار')} disabled={!hasExam} onClick={onOpenAssistant} title={collapsed ? t(hasExam ? 'Assistant' : 'Load an exam first', hasExam ? 'دستیار' : 'ابتدا یک آزمون بارگذاری کنید') : undefined}>
        <span className="ep-rail-index"><Bot size={15} aria-hidden="true" /></span><span className="ep-rail-text">{t('Assistant', 'دستیار')}</span>
      </button>
    </div>
    <div className="ep-rail-section">
      <div className="ep-rail-label">{t('SYSTEM', 'سیستم')}</div>
      <button type="button" className="ep-rail-link" aria-label={t('Settings', 'تنظیمات')} onClick={() => onOpenSettings?.()} title={collapsed ? t('Settings', 'تنظیمات') : undefined}>
        <span className="ep-rail-index"><Settings size={15} aria-hidden="true" /></span><span className="ep-rail-text">{t('Settings', 'تنظیمات')}</span>
      </button>
      <button type="button" className="ep-rail-link" aria-label={t('Diagnostics', 'عیب‌یابی')} onClick={() => onOpenSettings?.('diagnostics')} title={collapsed ? t('Diagnostics', 'عیب‌یابی') : undefined}>
        <span className="ep-rail-index"><Activity size={15} aria-hidden="true" /></span><span className="ep-rail-text">{t('Diagnostics', 'عیب‌یابی')}</span>
      </button>
      <button type="button" className="ep-rail-link" aria-label={t('Memory', 'حافظه')} onClick={() => onOpenSettings?.('assistant')} title={collapsed ? t('Memory', 'حافظه') : undefined}>
        <span className="ep-rail-index"><Brain size={15} aria-hidden="true" /></span><span className="ep-rail-text">{t('Memory', 'حافظه')}</span>
      </button>
    </div>
    <div className="ep-rail-footer">
      <div className="ep-rail-footer-text ep-caption">{t('ENGINE', 'موتور')}: {engineLabel || t('ready', 'آماده')}</div>
      <div className="ep-rail-footer-text ep-caption">{t('FOLDER', 'پوشه')}: {storageLabel || t('local', 'محلی')}</div>
      {!collapsed && <div className="ep-ledger-row ep-caption"><span>{t('Step', 'مرحله')}</span><span className="ep-mono">{currentStep}/5</span></div>}
    </div>
  </aside>;

  return <>
    {sidebar}
    {workflow(true)}
  </>;
};
