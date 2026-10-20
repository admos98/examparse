import React, { useEffect, useState } from 'react';
import { clearUsageLog, loadSettings } from '../store';
import { ConfirmCard, Skeleton } from '../design/primitives';

export function StoragePanel() {
  const [stats, setStats] = useState<{ dir: string; buckets: Record<string, { bytes: number; count: number }> }>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pendingBucket, setPendingBucket] = useState<'cache' | 'journals' | 'usage' | null>(null);
  const fa = loadSettings().uiLanguage === 'fa';
  const t = (en: string, faText: string) => fa ? faText : en;
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/storage/stats');
      if (!response.ok) throw new Error('Storage statistics unavailable');
      setStats(await response.json());
    } catch {
      setError(t('Storage details could not be loaded. Check the configured folder and try again.', 'جزئیات فضای ذخیره‌سازی بارگذاری نشد. پوشه پیکربندی‌شده را بررسی و دوباره تلاش کنید.'));
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function confirmClear() {
    if (!pendingBucket) return;
    const bucket = pendingBucket;
    setPendingBucket(null);
    try {
      const response = await fetch(`/api/storage/buckets/${bucket}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Storage cleanup failed');
      const result = await response.json();
      if (bucket === 'usage') clearUsageLog();
      setMessage(t(`Deleted ${result.deleted} ${bucket} entries. No model calls.`, `${result.deleted} مورد از ${bucket} حذف شد. هیچ فراخوانی مدلی انجام نشد.`));
      await refresh();
    } catch {
      setError(t('The selected data could not be cleared. Try again.', 'پاک‌سازی داده انتخاب‌شده ممکن نشد. دوباره تلاش کنید.'));
    }
  }
  const bucketLabel = (bucket: string) => bucket === 'cache' ? t('Parse cache', 'حافظه نهان استخراج') : bucket === 'journals' ? t('Run journals', 'گزارش اجرا') : t('Usage history', 'تاریخچه مصرف');
  return <section className="space-y-3 border border-[var(--rule)] rounded-[var(--radius-card)] p-4 text-[length:var(--type-12)]">
    <h3 className="font-bold">{t('Storage', 'فضای ذخیره‌سازی')}</h3>
    {loading && <Skeleton className="w-2/3" label={t('Loading storage details', 'بارگذاری جزئیات ذخیره‌سازی')} />}
    {error && <p className="text-[var(--danger)]" role="status">{error}</p>}
    {stats && <>
      <p className="ep-mono break-all">{stats.dir}</p>
      <div className="ep-ledger">{Object.entries(stats.buckets || {}).map(([name, bucket]) => <div className="ep-ledger-row" key={name}>
        <span>{bucketLabel(name)} · {bucket.count} {t('entries', 'مورد')}</span><span className="ep-mono">{(bucket.bytes / 1024).toFixed(1)} KiB</span>
      </div>)}</div>
      {(['cache', 'journals', 'usage'] as const).map(bucket => <button key={bucket} type="button" className="ep-button ep-button-ghost ep-button-sm me-2" onClick={() => setPendingBucket(bucket)}>{t('Clear', 'پاک‌سازی')} {bucketLabel(bucket)}</button>)}
    </>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    {pendingBucket && <ConfirmCard
      title={t('Clear selected data?', 'داده انتخاب‌شده پاک شود؟')}
      description={t(`Clear ${stats?.buckets[pendingBucket]?.count || 0} ${pendingBucket} entries? Exams and images are untouched; no model calls are made.`, `${stats?.buckets[pendingBucket]?.count || 0} مورد از ${pendingBucket} پاک شود؟ آزمون‌ها و تصاویر دست‌نخورده می‌مانند و هیچ فراخوانی مدلی انجام نمی‌شود.`)}
      confirmLabel={t('Clear data', 'پاک‌سازی داده')}
      cancelLabel={t('Cancel', 'لغو')}
      danger
      onConfirm={() => void confirmClear()}
      onCancel={() => setPendingBucket(null)}
    />}
  </section>;
}
