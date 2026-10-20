import React, { useState } from 'react';
import { ExamDoc } from '../types';
import { loadExamDoc, loadSettings } from '../store';
import { Button, ConfirmCard, Skeleton } from '../design/primitives';

type Version = { id: string; ts: string; questions: unknown[] };
export function ExamVersions({ doc, onRestore }: { doc: ExamDoc; onRestore: (doc: ExamDoc) => void }) {
  const [versions, setVersions] = useState<Version[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingVersion, setPendingVersion] = useState<Version | null>(null);
  const fa = loadSettings().uiLanguage === 'fa';
  const t = (en: string, faText: string) => fa ? faText : en;
  const fetchVersions = async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/exams/${doc.id}/versions`);
      if (!response.ok) throw new Error('history unavailable');
      setVersions(await response.json());
    } catch {
      setError(t('Exam versions could not be loaded. Try again.', 'نسخه‌های آزمون بارگذاری نشد. دوباره تلاش کنید.'));
    } finally { setLoading(false); }
  };
  const restore = async () => {
    if (!pendingVersion) return;
    const target = pendingVersion;
    setPendingVersion(null);
    try {
      const response = await fetch(`/api/exams/${doc.id}/restore/${target.id}`, { method: 'POST' });
      if (!response.ok) throw new Error('restore failed');
      const restored = await loadExamDoc(doc.id);
      if (!restored) throw new Error('exam unavailable');
      onRestore(restored);
      setVersions(undefined);
    } catch {
      setError(t('The selected version could not be restored. The current exam was left unchanged.', 'بازیابی نسخه انتخاب‌شده ممکن نشد. آزمون فعلی تغییر نکرد.'));
    }
  };
  return <section className="space-y-3 border border-[var(--rule)] rounded-[var(--radius-card)] p-3 text-[length:var(--type-12)] print:hidden">
    <Button size="sm" variant="ghost" onClick={() => void fetchVersions()}>{t('Versions', 'نسخه‌ها')} / {t('last 10', '۱۰ مورد اخیر')}</Button>
    {loading && <Skeleton className="w-2/3" label={t('Loading exam versions', 'بارگذاری نسخه‌های آزمون')} />}
    {versions?.slice().reverse().map(version => <div key={version.id} className="ep-ledger-row">
      <span className="ep-mono">{version.ts} · {version.questions.length} {t('questions', 'سؤال')}</span>
      <Button size="sm" variant="ghost" onClick={() => setPendingVersion(version)}>{t('Restore', 'بازیابی')}</Button>
    </div>)}
    {versions?.length === 0 && <p className="ep-caption">{t('No previous versions yet.', 'هنوز نسخه پیشینی وجود ندارد.')}</p>}
    {error && <p className="text-[var(--danger)]" role="status">{error}</p>}
    {pendingVersion && <ConfirmCard
      title={t('Restore this version?', 'این نسخه بازیابی شود؟')}
      description={t(`Restore ${pendingVersion.questions.length} questions from ${pendingVersion.ts}? The current state will also be saved as a version.`, `نسخه ${pendingVersion.ts} با ${pendingVersion.questions.length} سؤال بازیابی شود؟ وضعیت فعلی نیز به‌عنوان نسخه ذخیره می‌شود.`)}
      confirmLabel={t('Restore version', 'بازیابی نسخه')}
      cancelLabel={t('Cancel', 'لغو')}
      onConfirm={() => void restore()}
      onCancel={() => setPendingVersion(null)}
    />}
  </section>;
}
