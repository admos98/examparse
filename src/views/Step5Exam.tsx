import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Printer, Download, Upload, Copy, FileSpreadsheet } from 'lucide-react';
import { ExamDoc, ImageAsset, getDisplayName, sanitizeFileName } from '../types';
import { DeterministicRenderer, ExamRenderMode } from './DeterministicRenderer';
import { saveExamDoc, getImageBlob } from '../store';
import { duplicateExamDoc, exportExamJson, partialExportIssues, parseReportForDoc } from '../utils/examExport';
import { ExamHealthBanner } from '../components/ExamHealthBanner';
import { MAX_EXAM_JSON_BYTES, parseExamDocImport } from '../utils/validation';
import { printStyles, checkPrintLayout } from '../utils/printCheck';
import { Button, ConfirmCard, Tabs } from '../design/primitives';

interface Props {
  defaultExamMode?: 'exam' | 'review';
  doc: ExamDoc;
  onUpdateDoc: (updated: ExamDoc) => void;
  exportRequest?: number;
}

type PendingAction = 'print' | 'docx' | 'json';

export const Step5Exam: React.FC<Props> = ({ defaultExamMode, doc, onUpdateDoc, exportRequest = 0 }) => {
  const [renderMode, setRenderMode] = useState<ExamRenderMode>(defaultExamMode === 'review' ? 'review' : 'paper');
  useEffect(() => { setRenderMode(defaultExamMode === 'review' ? 'review' : 'paper'); }, [defaultExamMode]);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const [printRisks, setPrintRisks] = useState<ReturnType<typeof checkPrintLayout>>([]);
  const [showReport, setShowReport] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [importNotice, setImportNotice] = useState('');
  const printAreaRef = useRef<HTMLDivElement>(null);
  const lastExportRequest = useRef(exportRequest);
  const isPersian = /^fa|^ar/i.test(doc.meta.language || '');
  const t = (en: string, fa: string) => isPersian ? fa : en;
  const partialIssues = partialExportIssues(doc);
  const localizedPartialIssues = isPersian ? partialIssues.map(issue => {
    if (issue.startsWith('missing questions:')) return issue.replace('missing questions:', 'سؤال‌های جاافتاده:');
    if (issue.startsWith('duplicate question numbers:')) return issue.replace('duplicate question numbers:', 'شمارهٔ سؤال‌های تکراری:');
    if (issue.startsWith('points deficit:')) return issue.replace('points deficit:', 'کسری نمره:');
    const unplaced = issue.match(/^(\d+) unplaced image\(s\)$/);
    if (unplaced) return `${unplaced[1]} تصویرِ بدون جایگاه`;
    const unresolved = issue.match(/^(\d+) unresolved image reference\(s\)$/);
    if (unresolved) return `${unresolved[1]} ارجاع تصویریِ حل‌نشده`;
    const nested = issue.match(/^(\d+) invalid nested-question link\(s\)$/);
    if (nested) return `${nested[1]} پیوندِ پرسشِ تو‌در‌توی نامعتبر`;
    return t('Integrity checks need review.', 'بررسی یکپارچگی نیاز است.');
  }) : partialIssues;

  useEffect(() => {
    const id = 'examparse-print-styles';
    if (!document.getElementById(id)) {
      const el = document.createElement('style');
      el.id = id;
      el.textContent = printStyles;
      document.head.appendChild(el);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setPrintRisks(checkPrintLayout(printAreaRef.current || undefined)), 300);
    return () => window.clearTimeout(timeout);
  }, [doc, renderMode]);

  const executePrint = useCallback(() => {
    setPendingAction(null);
    window.print();
  }, []);
  const executeDocx = useCallback(() => {
    setPendingAction(null);
    const printArea = document.getElementById('printable-exam-area');
    if (!printArea) return;
    const safeTitle = getDisplayName(doc).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const ruleColor = getComputedStyle(document.documentElement).getPropertyValue('--rule-strong').trim() || 'currentColor';
    const htmlContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head><meta charset='utf-8'><title>${safeTitle}</title><style>
      body { font-family: Georgia, Tahoma, serif; font-size: 11pt; direction: ${doc.meta.direction}; }
      table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid ${ruleColor}; padding: 6px; }
      </style></head><body>${printArea.innerHTML}</body></html>`;
    const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeFileName(getDisplayName(doc))}.doc`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [doc]);
  const executeJson = useCallback(() => {
    setPendingAction(null);
    exportExamJson(doc);
  }, [doc]);

  const requestAction = useCallback((action: PendingAction) => {
    const hasPrintRisk = action === 'print' && checkPrintLayout(printAreaRef.current || undefined).length > 0;
    if (partialIssues.length || hasPrintRisk) setPendingAction(action);
    else if (action === 'print') executePrint();
    else if (action === 'docx') executeDocx();
    else executeJson();
  }, [executeDocx, executeJson, executePrint, partialIssues.length]);

  useEffect(() => {
    if (exportRequest === lastExportRequest.current) return;
    lastExportRequest.current = exportRequest;
    requestAction('json');
  }, [exportRequest, requestAction]);

  const confirmPendingAction = () => {
    if (pendingAction === 'print') executePrint();
    else if (pendingAction === 'docx') executeDocx();
    else if (pendingAction === 'json') executeJson();
  };

  const handleImportJson = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_EXAM_JSON_BYTES) {
      setImportNotice(t(`Exam JSON exceeds the ${Math.round(MAX_EXAM_JSON_BYTES / 1024 / 1024)} MiB import limit.`, `حجم فایل JSON آزمون از سقف ${Math.round(MAX_EXAM_JSON_BYTES / 1024 / 1024)} مگابایت بیشتر است.`));
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = parseExamDocImport(String(reader.result || ''));
        if (!parsed.doc) throw new Error(parsed.error || 'ExamDoc validation failed');
        const imported = parsed.doc;
        const restoredImages: ImageAsset[] = await Promise.all(imported.images.map(async image => {
          const blob = image.blobKey ? await getImageBlob(image.blobKey) : undefined;
          return { ...image, dataUrl: blob ? URL.createObjectURL(blob) : undefined };
        }));
        const importedDoc: ExamDoc = { ...imported, images: restoredImages };
        onUpdateDoc(importedDoc);
        await saveExamDoc(importedDoc);
        setImportNotice(t('Exam JSON imported.', 'فایل JSON آزمون وارد شد.'));
      } catch (error: any) {
        setImportNotice(t(`Invalid Exam JSON: ${error?.message || 'validation failed'}`, `فایل JSON آزمون معتبر نیست: ${error?.message || 'اعتبارسنجی ناموفق بود'}`));
      } finally { event.target.value = ''; }
    };
    reader.onerror = () => {
      setImportNotice(t('Could not read the Exam JSON file.', 'خواندن فایل JSON آزمون ممکن نشد.'));
      event.target.value = '';
    };
    reader.readAsText(file);
  };

  const handleDuplicate = () => {
    const newDoc = duplicateExamDoc(doc);
    onUpdateDoc(newDoc);
    void saveExamDoc(newDoc);
  };

  const report = showReport ? parseReportForDoc(doc) : null;
  const pendingDescription = pendingAction
    ? [
      partialIssues.length ? t(`This exam is partial: ${partialIssues.join('; ')}.`, `این آزمون ناقص است: ${localizedPartialIssues.join('؛ ')}.`) : '',
      pendingAction === 'print' && printRisks.length ? t(`${printRisks.length} question(s) may split across printed pages.`, `${printRisks.length} سؤال ممکن است بین صفحات چاپ شکسته شود.`) : '',
      t('Continue only if you intend to export this state.', 'فقط در صورت تأیید این وضعیت ادامه دهید.'),
    ].filter(Boolean).join(' ')
    : '';

  return <div className="ep-exam-view py-6 px-4">
    <div className="max-w-5xl mx-auto print:hidden"><ExamHealthBanner doc={doc} /></div>
    {pendingAction && <div className="max-w-5xl mx-auto my-4 print:hidden">
      <ConfirmCard
        title={t('Confirm export', 'تأیید خروجی')}
        description={pendingDescription}
        confirmLabel={t('Continue', 'ادامه')}
        cancelLabel={t('Cancel', 'لغو')}
        onConfirm={confirmPendingAction}
        onCancel={() => setPendingAction(null)}
      />
    </div>}
    <div className="ep-exam-toolbar max-w-5xl mx-auto my-6 flex flex-wrap items-center justify-between gap-3 border border-[var(--rule)] rounded-[var(--radius-card)] bg-[var(--paper-raised)] p-4 print:hidden">
      <Tabs
        label={t('Exam view mode', 'حالت نمایش آزمون')}
        value={renderMode}
        onChange={value => setRenderMode(value as ExamRenderMode)}
        items={[
          { id: 'paper', label: t('Exam', 'آزمون') },
          { id: 'answer-key', label: t('Answer key', 'پاسخ‌نامه') },
          { id: 'review', label: t('Review', 'بازبینی') },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--type-12)]">
        <Button size="sm" variant="ghost" onClick={handleDuplicate} title={t('Duplicate exam to create Version B', 'برای ساخت نسخه ب از آزمون یک کپی بسازید')}><Copy aria-hidden="true" size={16} /><span>{t('Duplicate', 'کپی')}</span></Button>
        <Button size="sm" variant="ghost" onClick={() => requestAction('docx')} title={t('Export DOCX document', 'خروجی فایل DOCX')}><FileSpreadsheet aria-hidden="true" size={16} /><span>DOCX</span></Button>
        <Button size="sm" variant="ghost" onClick={() => requestAction('json')} title={t('Export clean ExamDoc JSON', 'خروجی JSON پاک آزمون')}><Download aria-hidden="true" size={16} /><span>{t('Export JSON', 'خروجی JSON')}</span></Button>
        <label className="ep-button ep-button-ghost ep-button-sm cursor-pointer">
          <Upload aria-hidden="true" size={16} /><span>{t('Import JSON', 'ورود JSON')}</span>
          <input ref={jsonInputRef} type="file" accept=".json" onChange={handleImportJson} className="sr-only" />
        </label>
        <Button size="sm" variant="primary" onClick={() => requestAction('print')}><Printer aria-hidden="true" size={16} /><span>{t('Print / Save PDF', 'چاپ / ذخیره PDF')}</span></Button>
        <Button size="sm" variant="ghost" aria-expanded={showReport} onClick={() => setShowReport(value => !value)}>{showReport ? t('Hide report', 'پنهان کردن گزارش') : t('Parse report', 'گزارش استخراج')}</Button>
      </div>
    </div>

    {importNotice && <p className="max-w-5xl mx-auto text-[length:var(--type-12)]" role="status" aria-live="polite">{importNotice}</p>}
    {report && <section className="ep-card ep-parse-report max-w-5xl mx-auto my-3 p-3 text-[length:var(--type-12)]" aria-label={t('Parse report', 'گزارش استخراج')}>
      <div className="font-semibold">{t('Parse report', 'گزارش استخراج')} — <span className="ep-mono">{doc.id}</span></div>
      <div>{t('Models', 'مدل‌ها')}: {Object.entries(report.models).map(([key, value]) => `${key}: ${value}`).join(' · ') || '—'}</div>
      <div>{t('Calls', 'فراخوانی')}: {report.calls} · {t('Input tokens', 'توکن ورودی')}: {report.tokens.input} · {t('Output tokens', 'توکن خروجی')}: {report.tokens.output} · ${report.cost.toFixed(4)}</div>
      {report.readOutputTokensByFormat && <div>Read output by format: {Object.entries(report.readOutputTokensByFormat).map(([format, tokens]) => `${format}: ${tokens} tokens`).join(' · ') || '—'}</div>}
      <div>{t('Coverage after', 'پوشش پس از اجرا')}: {report.coverageAfter ?? '—'}% · {t('Consensus sections', 'بخش‌های اجماع')}: {report.consensusSections.length} · {t('Critic', 'ممیز')}: {report.critic.calls} {t('calls', 'فراخوانی')}, {report.critic.defects} {t('defects', 'ایراد')}, {report.critic.ok} {t('ok', 'مورد تأیید')}</div>
      <div>{t('Memory injected', 'حافظه تزریق‌شده')}: {t('playbook', 'راهنمای پایه')} [{report.memory.playbookIds.join(', ') || t('none', 'هیچ')}] · {t('skills', 'مهارت‌ها')} [{report.memory.skillIds.join(', ') || t('none', 'هیچ')}] · {report.memory.guidanceTokens} {t('tokens', 'توکن')}</div>
      {report.classify && <div>{t('Line sorting', 'مرتب‌سازی خط‌ها')}: {report.classify.status === 'fallback' || report.classify.status === 'unavailable' || report.classify.status === 'skipped'
        ? t(`unavailable — no fallback parser used (${report.classify.reason || 'AI read failed'})`, `انجام نشد (${report.classify.reason || 'خوانش هوش مصنوعی ناموفق بود'})`)
        : t(`done by AI — ${report.classify.model || 'model'}${report.classify.status === 'cached' ? ', from cache (0 calls)' : `, ${report.classify.calls} call(s)`}${report.classify.labelledLines ? `, ${report.classify.labelledLines} lines sorted` : ''}`, `با هوش مصنوعی — ${report.classify.model || 'مدل'}${report.classify.status === 'cached' ? '، از حافظه (۰ فراخوانی)' : `، ${report.classify.calls} فراخوانی`}`)}</div>}
      {(report.pages || report.classify?.pages)?.length ? (
        <div data-testid="parse-report-pages">
          {t('Pages', 'صفحه‌ها')}: {(report.pages || report.classify?.pages || []).map(p => {
            // #42: cloud attempts + the provider error make weather (503 / timeout) distinguishable from refusal.
            const attempts = p.cloudAttempts && p.cloudAttempts > 1 ? ` ×${p.cloudAttempts}` : '';
            const weather = p.cloudError ? ` — ${String(p.cloudError).replace(/\s+/g, ' ').slice(0, 80)}` : '';
            return `page ${p.page}: ${p.status}${p.format ? ` · ${p.format}, ${p.outputTokens || 0} output tokens` : ''}${attempts}${weather}`;
          }).join(' · ')}
        </div>
      ) : null}
      {report.repairLoop && report.repairLoop.status !== 'skipped' && <div>{t('Automatic fixes', 'اصلاحات خودکار')}: {report.repairLoop.status === 'no-defects'
        ? (report.repairLoop.droppedReadFailedDefects
          ? t(`nothing repair could fix — ${report.repairLoop.droppedReadFailedDefects} checked item(s) sit on unread pages and need [Retry page]`, `چیزی برای اصلاح خودکار نبود؛ ${report.repairLoop.droppedReadFailedDefects} مورد روی صفحه‌های خوانده‌نشده است و به «تلاش دوباره صفحه» نیاز دارد`)
          : t('none needed — the paper\'s numbers and marks already add up', 'نیازی نبود؛ شماره‌ها و نمره‌های برگه از پیش درست بودند'))
        : t(`${report.repairLoop.rounds} round(s) · ${report.repairLoop.opsProposed ?? ((report.repairLoop.opsAccepted || 0) + (report.repairLoop.opsRejected || 0) + (report.repairLoop.opsDeduped || 0))} suggested · ${report.repairLoop.opsAccepted} fix(es) applied · ${report.repairLoop.opsRejected} suggestion(s) rejected · ${report.repairLoop.opsDeduped || 0} duplicate(s) skipped${report.repairLoop.abandonedKinds?.length ? ` · ${report.repairLoop.abandonedKinds.join(', ')} abandoned` : ''} · ${report.repairLoop.escalations} second opinion(s) · ${report.repairLoop.defectsRemaining} thing(s) still open`, `${report.repairLoop.rounds} دور · ${report.repairLoop.opsProposed ?? ((report.repairLoop.opsAccepted || 0) + (report.repairLoop.opsRejected || 0) + (report.repairLoop.opsDeduped || 0))} پیشنهاد · ${report.repairLoop.opsAccepted} اصلاح اعمال شد · ${report.repairLoop.opsRejected} پیشنهاد رد شد · ${report.repairLoop.opsDeduped || 0} تکراری نادیده · ${report.repairLoop.escalations} نظر دوم · ${report.repairLoop.defectsRemaining} مورد باز`)}</div>}
      <div>{t('Config hash', 'هش پیکربندی')}: <span className="ep-mono">{report.configHash}</span> · {t('Generated', 'ساخته‌شده')}: {report.generatedAt}</div>
      <p className="ep-caption m-0">{t('The JSON export embeds this report as a receipt; no keys are included.', 'فایل JSON خروجی این گزارش را به‌عنوان رسید دارد و هیچ کلیدی در آن نیست.')}</p>
    </section>}
    {printRisks.length > 0 && <div className="max-w-5xl mx-auto my-3 border border-[var(--warn)] p-3 text-[length:var(--type-12)] print:hidden" role="status">
      {t(`Print check: ${printRisks.length} question(s) may split across pages.`, `بررسی چاپ: ${printRisks.length} سؤال ممکن است بین صفحات شکسته شود.`)}{' '}
      <Button size="sm" variant="ghost" onClick={() => requestAction('print')}>{t('Review and print', 'بازبینی و چاپ')}</Button>
    </div>}
    <div id={`panel-${renderMode}`} role="tabpanel" aria-labelledby={`tab-${renderMode}`} tabIndex={0}>
      <div id="printable-exam-area" ref={printAreaRef} className="w-full overflow-x-auto pb-10">
        <DeterministicRenderer doc={doc} mode={renderMode} />
      </div>
    </div>
  </div>;
};
