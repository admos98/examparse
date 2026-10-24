import React from 'react';
import type { ExamDoc } from '../types';
import { FLAG_TEMPLATES, flagSentence, groupAttentionFlags, triageFlags } from '../utils/flagPresentation';

export function IntegrityFlags({ doc }: { doc: ExamDoc }) {
  const { repairs, technical } = triageFlags(doc.flags);
  const groups = groupAttentionFlags(doc.flags, doc);
  return <section className="border border-[var(--rule)] rounded-[10px] p-4 space-y-3 text-xs" aria-label="Integrity Flags">
    <h2 className="font-bold">{groups.length} {groups.length === 1 ? 'thing needs' : 'things need'} attention</h2>
    <h3 className="font-semibold">NEEDS ATTENTION</h3>
    {groups.length ? (
      <ul className="space-y-2">
        {groups.map((group, index) => (
          <li key={`${group.id}_${index}`}>
            {group.expandable ? (
              <details>
                <summary className="cursor-pointer">{group.summary}</summary>
                <ul className="mt-1 ps-4 space-y-1">
                  {group.flags.map((flag, fIdx) => (
                    <li key={`${flag.id}_${fIdx}`}>{flagSentence(flag, doc)}</li>
                  ))}
                </ul>
              </details>
            ) : (
              group.summary
            )}
          </li>
        ))}
      </ul>
    ) : (
      <p>No content issues to check.</p>
    )}
    <details><summary className="cursor-pointer font-semibold">WHAT THE APP ALREADY FIXED</summary>
      <div className="mt-2 space-y-2">{[...repairs].map(([code, flags]) => <details key={code}><summary className="cursor-pointer">{FLAG_TEMPLATES[code] || code.toLowerCase().replaceAll('_', ' ')} ×{flags.length} — view</summary>
        <ul>{flags.map((flag, index) => <li key={`${flag.id}_${index}`}>{flagSentence(flag, doc)}</li>)}</ul>
      </details>)}</div>
    </details>
    <details><summary className="cursor-pointer font-semibold">TECHNICAL LOG</summary><ul>{technical.map((flag, index) => <li key={`${flag.id}_${index}`}>{flag.code}: {flag.message}</li>)}</ul></details>
  </section>;
}
