import React from 'react';
import type { ExamDoc } from '../types';
import { FLAG_TEMPLATES, flagSentence, triageFlags } from '../utils/flagPresentation';

export function IntegrityFlags({ doc }: { doc: ExamDoc }) {
  const { attention, repairs, technical } = triageFlags(doc.flags);
  return <section className="border border-[var(--rule)] rounded-[10px] p-4 space-y-3 text-xs" aria-label="Integrity Flags">
    <h2 className="font-bold">{attention.length} things need attention</h2>
    <h3 className="font-semibold">NEEDS ATTENTION</h3>
    {attention.length ? <ul className="space-y-2">{attention.map((flag, index) => <li key={`${flag.id}_${index}`}>{flagSentence(flag, doc)}</li>)}</ul> : <p>No content issues to check.</p>}
    <details><summary className="cursor-pointer font-semibold">WHAT THE APP ALREADY FIXED</summary>
      <div className="mt-2 space-y-2">{[...repairs].map(([code, flags]) => <details key={code}><summary className="cursor-pointer">{FLAG_TEMPLATES[code] || code.toLowerCase().replaceAll('_', ' ')} ×{flags.length} — view</summary>
        <ul>{flags.map((flag, index) => <li key={`${flag.id}_${index}`}>{flagSentence(flag, doc)}</li>)}</ul>
      </details>)}</div>
    </details>
    <details><summary className="cursor-pointer font-semibold">TECHNICAL LOG</summary><ul>{technical.map((flag, index) => <li key={`${flag.id}_${index}`}>{flag.code}: {flag.message}</li>)}</ul></details>
  </section>;
}
