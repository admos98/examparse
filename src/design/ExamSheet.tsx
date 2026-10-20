import React from 'react';
import { Sheet } from './primitives';

export function ExamSheet({
  dir,
  className = '',
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { dir: 'ltr' | 'rtl' }) {
  return <Sheet dir={dir} className={['exam-sheet', className].filter(Boolean).join(' ')} {...props}>{children}</Sheet>;
}
