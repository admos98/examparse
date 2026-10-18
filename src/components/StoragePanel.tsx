import React, { useEffect, useState } from 'react';
import { clearUsageLog } from '../store';
export function StoragePanel() {
  const [stats, setStats] = useState<{
    dir: string;
    buckets: Record<string, { bytes: number; count: number }>;
  }>();
  const [message, setMessage] = useState('');
  async function refresh() {
    const res = await fetch('/api/storage/stats');
    if (!res.ok) throw new Error(`Storage HTTP ${res.status}`);
    setStats(await res.json());
  }
  useEffect(() => {
    refresh().catch((e) => setMessage(String(e)));
  }, []);
  return (
    <section className="space-y-3 border rounded-xl p-4 text-xs">
      <h3 className="font-bold">Storage / فضای ذخیره‌سازی</h3>
      <p className="break-all">{stats?.dir}</p>
      {Object.entries(stats?.buckets || {}).map(([name, bucket]) => (
        <p key={name}>
          {name}: {bucket.count} entries · {(bucket.bytes / 1024).toFixed(1)}{' '}
          KiB
        </p>
      ))}
      {(['cache', 'journals', 'usage'] as const).map((bucket) => (
        <button
          key={bucket}
          className="border rounded p-2 mr-2"
          onClick={async () => {
            if (
              !window.confirm(
                `Clear ${stats?.buckets[bucket]?.count || 0} ${bucket} entries? Exams and images are untouched. No model calls.`,
              )
            )
              return;
            try {
              const res = await fetch(`/api/storage/buckets/${bucket}`, {
                method: 'DELETE',
              });
              if (!res.ok) throw new Error(await res.text());
              const result = await res.json();
              if (bucket === 'usage') clearUsageLog();
              setMessage(
                `Deleted ${result.deleted} ${bucket} entries. 0 model calls.`,
              );
              await refresh();
            } catch (error) {
              setMessage(String(error));
            }
          }}
        >
          {bucket === 'cache'
            ? 'Clear parse cache'
            : bucket === 'journals'
              ? 'Clear journals'
              : 'Clear usage history'}
        </button>
      ))}
      <p role="status">{message}</p>
    </section>
  );
}
