import React, { useEffect, useState } from 'react';
import { AlertCircle, BookOpen, CheckCircle2, FileText } from 'lucide-react';
import { ExamDoc } from '../types';
import { DeterministicRenderer } from '../views/DeterministicRenderer';
import { Button, Badge, Card, Checkbox, ConfirmCard, Disclosure, EmptyState, Input, Kbd, Modal, ProgressBar, Rule, Select, Skeleton, Stat, Switch, Tabs, Textarea, Toast, Tooltip } from './primitives';
import { UiLanguage, uiText } from './i18n';

const SPECIMEN = {
  id: 'styleguide-specimen', fileHash: 'local', createdAt: new Date(0).toISOString(), displayName: 'نمونه آزمون',
  meta: { title: 'آزمون نمونه پایان‌ترم', subject: 'علوم و ریاضی', school: 'دبیرستان نمونه', grade: 'پایه دوازدهم', language: 'fa', direction: 'rtl', durationMinutes: 60, totalPoints: 6 },
  source: { lines: [], pages: 1, fileName: 'specimen.pdf', ocrUsed: false, expectedQuestionNos: [1, 2, 3] },
  sections: [{ id: 'spec-section', index: 1, title: 'پرسش‌های نمونه', points: 6, spans: [], instructions: 'به پرسش‌ها با دقت پاسخ دهید.', passage: 'آب در دمای معمولی مایع است. این قطعه نمونه، بلوک متنِ محصور و دارای خط حاشیه را نشان می‌دهد.' }],
  questions: [
    { id: 'spec-q1', label: '۱', no: 1, sectionId: 'spec-section', spans: [[1, 1]], stem: 'عدد ۲ + ۲ برابر با چند است؟', type: 'mcq', points: 2, options: [{ key: 'الف', spans: [], text: '۳' }, { key: 'ب', spans: [], text: '۴' }], images: [], confidence: 0.96, answer: { text: '۴', source: 'manual' } },
    { id: 'spec-q2', label: '۲', no: 2, sectionId: 'spec-section', spans: [[2, 2]], stem: 'یک جمله دربارهٔ تبخیر بنویسید.', type: 'short', points: 2, images: [], confidence: 0.92, answer: { text: 'تبدیل مایع به گاز.', source: 'manual' } },
    { id: 'spec-q3', label: '۳', no: 3, sectionId: 'spec-section', spans: [[3, 3]], stem: 'حاصل ۵ × ۲ را بنویسید.', type: 'short', points: 2, images: [], confidence: 0.9, answer: { text: '۱۰', source: 'manual' } },
  ], images: [], flags: [], usage: [],
} as unknown as ExamDoc;

function Preview({ language, dir, theme }: { language?: UiLanguage; dir: 'ltr' | 'rtl'; theme: 'light' | 'dark' }) {
  const t = (en: string, fa: string) => uiText(language, en, fa);
  const [check, setCheck] = useState(true);
  const [switchOn, setSwitchOn] = useState(false);
  const [activeTab, setActiveTab] = useState('controls');
  const [toast, setToast] = useState(false);
  const [modal, setModal] = useState(false);
  const [feedback, setFeedback] = useState('');
  const closeModal = () => setModal(false);
  return <section className="ep-theme-preview" data-theme-preview={theme} dir={dir} lang={language === 'fa' ? 'fa' : 'en'}>
    <h2 className="ep-display m-0 text-[length:var(--type-20)]">{t(theme === 'light' ? 'Light theme' : 'Dark theme', theme === 'light' ? 'پوسته روشن' : 'پوسته تیره')} · {dir.toUpperCase()}</h2>
    <p className="ep-caption">{t('A complete primitive pass in both directions.', 'نمای کامل اجزا در هر دو جهت نوشتار.')}</p>
    <div className="ep-styleguide-grid">
      <div className="space-y-3">
        <Rule label={t('Controls', 'کنترل‌ها')} />
        <div className="flex flex-wrap gap-2"><Button variant="primary">{t('Primary', 'اصلی')}</Button><Button variant="ghost">{t('Ghost', 'ساده')}</Button><Button variant="danger">{t('Danger', 'خطر')}</Button><Button variant="ghost-danger">{t('Ghost danger', 'خطر ساده')}</Button><Button size="sm">{t('Small', 'کوچک')}</Button><Button disabled>{t('Disabled', 'غیرفعال')}</Button></div>
        <label className="block text-[length:var(--type-12)]">{t('Input', 'ورودی')}<Input aria-label={t('Example input', 'ورودی نمونه')} placeholder={t('Write a name', 'نامی بنویسید')} /></label>
        <label className="block text-[length:var(--type-12)]">{t('Select', 'گزینش')}<Select aria-label={t('Example select', 'گزینش نمونه')} defaultValue="one"><option value="one">{t('First option', 'گزینه نخست')}</option><option value="two">{t('Second option', 'گزینه دوم')}</option></Select></label>
        <label className="block text-[length:var(--type-12)]">{t('Textarea', 'متن چندخطی')}<Textarea aria-label={t('Example notes', 'یادداشت نمونه')} rows={2} defaultValue={t('Reserved content; no layout shift.', 'فضای رزروشده؛ بدون جابه‌جایی چیدمان.')} /></label>
        <Checkbox checked={check} onChange={event => setCheck(event.target.checked)} label={t('Checkbox', 'چک‌باکس')} />
        <div className="flex items-center gap-3"><Switch checked={switchOn} onCheckedChange={setSwitchOn} label={t('Sample switch', 'کلید نمونه')} /><span>{t('Switch', 'کلید')}</span></div>
        <div className="flex flex-wrap gap-2"><Badge>{t('Neutral', 'خنثی')}</Badge><Badge tone="accent">{t('Current', 'فعال')}</Badge><Badge tone="ok"><CheckCircle2 size={12} />{t('Ready', 'آماده')}</Badge><Badge tone="warn"><AlertCircle size={12} />{t('Review', 'بازبینی')}</Badge><Badge tone="danger">{t('Error', 'خطا')}</Badge></div>
        <Card className="p-3"><strong>{t('Flat card', 'کارت تخت')}</strong><p className="ep-caption m-0">{t('One hairline. No shadow.', 'یک خط باریک، بدون سایه.')}</p></Card>
      </div>
      <div className="space-y-3">
        <Rule label={t('Data and feedback', 'داده و بازخورد')} />
        <div className="flex flex-wrap gap-4"><Stat label={t('Parsed', 'استخراج‌شده')} value="61 / 67" sub={t('6 missing', '۶ مورد جاافتاده')} /><Stat label={t('Cost', 'هزینه')} value="$0.0042" sub={t('4 calls', '۴ فراخوانی')} /></div>
        <ProgressBar value={61} max={67} active label={t('Exam parse progress', 'پیشرفت استخراج آزمون')} />
        <Skeleton className="w-2/3" label={t('Loading summary', 'بارگذاری خلاصه')} />
        <Tabs label={t('Sample tabs', 'زبانه‌های نمونه')} value={activeTab} onChange={setActiveTab} items={[{ id: 'controls', label: t('Controls', 'کنترل‌ها') }, { id: 'specimen', label: t('Specimen', 'نمونه') }]} />
        <div id={`panel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`} tabIndex={0} className="ep-caption">
          {activeTab === 'controls' ? t('Control examples and form states.', 'نمونه‌های کنترل و وضعیت‌های فرم.') : t('Sheet and feedback primitives are demonstrated below.', 'نمونه‌های برگه و بازخورد در ادامه آمده‌اند.')}
        </div>
        <Disclosure summary={t('Disclosure', 'بخش بازشونده')}><p className="ep-caption">{t('Native details stays keyboard-operable.', 'عنصر بومی برای صفحه‌کلید قابل استفاده است.')}</p></Disclosure>
        <Tooltip text={t('Keyboard and pointer users can reach this note.', 'کاربران صفحه‌کلید و اشاره‌گر به این توضیح دسترسی دارند.')}><Button variant="ghost">{t('Tooltip', 'راهنما')}</Button></Tooltip>
        <div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={() => setToast(true)}>{t('Show toast', 'نمایش پیام')}</Button><Button variant="ghost" onClick={() => setModal(true)}>{t('Open modal', 'باز کردن پنجره')}</Button><Kbd>⌘K</Kbd><Kbd>Esc</Kbd></div>
        {feedback && <p role="status" className="ep-caption">{feedback}</p>}
        <ConfirmCard title={t('Confirm change', 'تأیید تغییر')} description={t('This specimen has no side effects.', 'این نمونه هیچ تغییری ایجاد نمی‌کند.')} confirmLabel={t('Confirm', 'تأیید')} cancelLabel={t('Cancel', 'لغو')} onConfirm={() => setFeedback(t('Confirmed.', 'تأیید شد.'))} onCancel={() => setFeedback(t('Cancelled.', 'لغو شد.'))} />
        <EmptyState icon={<FileText size={20} />} message={t('No exams in this specimen.', 'در این نمونه آزمونی نیست.')} actionLabel={t('Import an exam', 'وارد کردن آزمون')} onAction={() => setFeedback(t('Import action specimen.', 'نمونهٔ اقدام ورود آزمون.'))} />
      </div>
    </div>
    {toast && <Toast message={t('Saved locally.', 'به‌صورت محلی ذخیره شد.')} onDismiss={() => setToast(false)} />}
    <Modal open={modal} onClose={closeModal} title={t('Modal specimen', 'نمونه پنجره')}>
      <div className="p-5"><h3 className="ep-display m-0 text-[length:var(--type-20)]">{t('Modal focus trap', 'تله تمرکز پنجره')}</h3><p className="ep-muted">{t('Escape closes this dialog and focus returns to its opener.', 'با Escape پنجره بسته می‌شود و تمرکز به دکمهٔ بازکننده برمی‌گردد.')}</p><Button variant="primary" onClick={closeModal}>{t('Close', 'بستن')}</Button></div>
    </Modal>
  </section>;
}

export function StyleGuideView({ language = 'en' }: { language?: UiLanguage }) {
  const t = (en: string, fa: string) => uiText(language, en, fa);
  const [dir, setDir] = useState<'ltr' | 'rtl'>(language === 'fa' ? 'rtl' : 'ltr');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [showSheet, setShowSheet] = useState(true);
  const [sheetMode, setSheetMode] = useState<'paper' | 'answer-key' | 'review'>('paper');
  useEffect(() => {
    const root = document.documentElement;
    const oldTheme = root.dataset.theme;
    const oldDir = root.dir;
    root.dataset.theme = theme;
    root.dir = dir;
    return () => {
      if (oldTheme) root.dataset.theme = oldTheme;
      else delete root.dataset.theme;
      root.dir = oldDir;
    };
  }, [theme, dir]);
  return <main className="ep-styleguide" data-styleguide="true" dir={dir}>
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--rule)] pb-4">
      <div><p className="ep-eyebrow m-0">EXAMPARSE · DESIGN CONTRACT</p><h1 className="ep-display m-0 text-[length:var(--type-34)]">PAPERWORK</h1><p className="ep-muted m-0">{t('Paper & ink · token and primitive reference', 'کاغذ و جوهر · مرجع توکن‌ها و اجزا')}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant={theme === 'light' ? 'primary' : 'ghost'} onClick={() => setTheme('light')}>{t('Light', 'روشن')}</Button><Button variant={theme === 'dark' ? 'primary' : 'ghost'} onClick={() => setTheme('dark')}>{t('Dark', 'تیره')}</Button>
        <Button variant={dir === 'ltr' ? 'primary' : 'ghost'} onClick={() => setDir('ltr')}>LTR</Button><Button variant={dir === 'rtl' ? 'primary' : 'ghost'} onClick={() => setDir('rtl')}>RTL</Button>
      </div>
    </header>
    <section className="my-6 space-y-3">
      <Rule label={t('Color tokens', 'توکن‌های رنگ')} />
      <div className="ep-ledger text-[length:var(--type-12)]">
        {[
          ['paper', 'var(--paper)'], ['paper-raised', 'var(--paper-raised)'], ['ink', 'var(--ink)'], ['ink-2', 'var(--ink-2)'], ['ink-3', 'var(--ink-3)'], ['rule', 'var(--rule)'], ['rule-strong', 'var(--rule-strong)'], ['accent', 'var(--accent)'], ['accent-ink', 'var(--accent-ink)'], ['ok', 'var(--ok)'], ['warn', 'var(--warn)'], ['danger', 'var(--danger)'], ['focus', 'var(--focus)'],
        ].map(([name, value]) => <div className="ep-ledger-row" key={name}><span className="ep-mono">--{name}</span><span className="flex items-center gap-2"><i aria-hidden="true" style={{ display: 'inline-block', width: 18, height: 18, background: value, border: '1px solid var(--rule-strong)' }} />{value}</span></div>)}
      </div>
    </section>
    <section className="my-6 space-y-3">
      <Rule label={t('Primitive states', 'حالت‌های اجزا')} />
      <Preview language={language} dir={dir} theme={theme} />
    </section>
    <section className="my-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><Rule label={t('ExamSheet specimen · 3 questions', 'نمونه برگه آزمون · ۳ سؤال')} /><div className="flex items-center gap-2"><Button size="sm" variant="ghost" aria-pressed={showSheet} onClick={() => setShowSheet(value => !value)}>{showSheet ? t('Hide sheet', 'پنهان‌کردن برگه') : t('Show sheet', 'نمایش برگه')}</Button><Select aria-label={t('Sheet mode', 'حالت برگه')} value={sheetMode} onChange={event => setSheetMode(event.target.value as typeof sheetMode)}><option value="paper">{t('Exam', 'آزمون')}</option><option value="answer-key">{t('Answer key', 'پاسخ‌نامه')}</option><option value="review">{t('Review', 'بازبینی')}</option></Select></div></div>
      {showSheet && <DeterministicRenderer doc={SPECIMEN} mode={sheetMode} />}
    </section>
  </main>;
}
