import React from 'react';
import type { AppSettings, ReadFormat } from '../types';
import { readFormatDescription } from '../pipeline/readFormat';

interface Props {
  settings: AppSettings;
  value?: ReadFormat;
  onChange: (format: ReadFormat) => void;
  compact?: boolean;
}

const choices: Array<{ value: ReadFormat; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'verbose', label: 'Verbose — local models' },
  { value: 'compact', label: 'Compact — cloud' },
];

export const ReadFormatControl: React.FC<Props> = ({ settings, value = settings.readFormat || 'auto', onChange, compact = false }) => (
  <div className="space-y-1.5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-[var(--ink)]">Read format:</span>
      <div className="inline-flex rounded-[7px] border border-[var(--rule)] p-0.5 bg-[var(--paper)]" role="group" aria-label="Read format">
        {choices.map(choice => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={value === choice.value}
            onClick={() => onChange(choice.value)}
            className={`px-2 py-1 rounded-[5px] text-[length:var(--type-12)] transition-colors ${value === choice.value ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'text-[var(--ink-2)] hover:bg-[var(--paper-raised)]'}`}
          >{choice.label}</button>
        ))}
      </div>
      <span className="text-[length:var(--type-12)] text-[var(--ink-2)]">{readFormatDescription({ ...settings, readFormat: value })}</span>
    </div>
    {!compact && <p className="text-[length:var(--type-12)] text-[var(--ink-2)]">Verbose uses ~2–3× more output tokens but small local models read far more accurately in it. Compact suits large/cloud models.</p>}
  </div>
);
