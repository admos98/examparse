import React, { useState } from 'react';
import { ExamDoc } from '../types';
import { loadExamDoc } from '../store';
export function ExamVersions({
  doc,
  onRestore,
}: {
  doc: ExamDoc;
  onRestore: (doc: ExamDoc) => void;
}) {
  const [versions, setVersions] =
    useState<Array<{ id: string; ts: string; questions: unknown[] }>>();
  const [error, setError] = useState('');
  return (
    <section className="p-3 text-xs border rounded-xl print:hidden">
      <button
        className="underline"
        onClick={async () => {
          try {
            const res = await fetch(`/api/exams/${doc.id}/versions`);
            if (!res.ok) throw new Error(await res.text());
            setVersions(await res.json());
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Versions / نسخه‌ها (last 10)
      </button>
      {versions
        ?.slice()
        .reverse()
        .map((v) => (
          <div key={v.id} className="flex gap-3 mt-2">
            <span>
              {v.ts} · {v.questions.length} questions
            </span>
            <button
              className="underline"
              onClick={async () => {
                if (
                  !window.confirm(
                    `Restore ${v.questions.length} questions from ${v.ts}? Current state will also be saved as a version.`,
                  )
                )
                  return;
                try {
                  const res = await fetch(
                    `/api/exams/${doc.id}/restore/${v.id}`,
                    { method: 'POST' },
                  );
                  if (!res.ok) throw new Error(await res.text());
                  const restored = await loadExamDoc(doc.id);
                  if (!restored) throw new Error('Restored exam not found');
                  onRestore(restored);
                  setVersions(undefined);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Restore / بازیابی
            </button>
          </div>
        ))}
      {versions?.length === 0 && <p>No previous versions yet.</p>}
      <p role="alert">{error}</p>
    </section>
  );
}
