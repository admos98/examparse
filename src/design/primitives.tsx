import React, { forwardRef, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'ghost-danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', className = '', type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={`ep-button ep-button-${variant} ep-button-${size} ${className}`} {...props} />;
});

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...props }, ref,
) {
  return <input ref={ref} className={`ep-input ${className}`} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', ...props }, ref,
) {
  return <select ref={ref} className={`ep-select ${className}`} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...props }, ref,
) {
  return <textarea ref={ref} className={`ep-textarea ${className}`} {...props} />;
});

export function Checkbox({
  label,
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode }) {
  return <label className={`inline-flex min-h-10 items-center gap-2 ${className}`}>
    <input type="checkbox" className="ep-checkbox" {...props} />
    {label !== undefined && <span>{label}</span>}
  </label>;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  className = '',
  disabled,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return <button
    {...props}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={`ep-switch ${className}`}
    onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) onCheckedChange(!checked); }}
  />;
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
export function Badge({ tone = 'neutral', className = '', children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={`ep-badge ep-badge-${tone} ${className}`} {...props}>{children}</span>;
}

export function Card({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement> & { flat?: boolean }) {
  return <div className={`ep-card ${className}`} {...props}>{children}</div>;
}

export function Sheet({ className = '', children, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <article className={`ep-sheet ${className}`} {...props}>{children}</article>;
}

export function Rule({ label, className = '' }: { label?: React.ReactNode; className?: string }) {
  return label === undefined
    ? <hr className={`ep-rule ${className}`} />
    : <div className={`ep-rule-label ${className}`}><span>{label}</span></div>;
}

export function Stat({
  label,
  value,
  sub,
  className = '',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return <div className={`ep-stat ${className}`}>
    <span className="ep-stat-label">{label}</span>
    <span className="ep-stat-value">{value}</span>
    {sub !== undefined && <span className="ep-stat-sub">{sub}</span>}
  </div>;
}

export function ProgressBar({
  value,
  max = 100,
  active = false,
  label,
  className = '',
}: {
  value: number;
  max?: number;
  active?: boolean;
  label: string;
  className?: string;
}) {
  const safeMax = Math.max(1, max);
  const percent = Math.max(0, Math.min(100, (value / safeMax) * 100));
  return <div className={`ep-progress ${className}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={safeMax} aria-valuenow={Math.min(safeMax, Math.max(0, value))} data-active={active}>
    <span style={{ width: `${percent}%` }} />
  </div>;
}

export function Skeleton({ className = '', label }: { className?: string; label: string }) {
  return <span className={`ep-skeleton ${className}`} role="status" aria-label={label} />;
}

export interface TabItem { id: string; label: React.ReactNode; disabled?: boolean }
export function Tabs({
  items,
  value,
  onChange,
  label,
  className = '',
}: {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const available = items.filter(item => !item.disabled);
    const currentIndex = Math.max(0, available.findIndex(item => item.id === value));
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const moveForward = rtl ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? available.length - 1
        : (currentIndex + (moveForward ? 1 : -1) + available.length) % available.length;
    const next = available[nextIndex];
    if (!next) return;
    onChange(next.id);
    tabRefs.current[items.findIndex(item => item.id === next.id)]?.focus();
  };
  return <div className={`ep-tabs ${className}`} role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
    {items.map((item, index) => <button
      key={item.id}
      ref={element => { tabRefs.current[index] = element; }}
      id={`tab-${item.id}`}
      type="button"
      role="tab"
      aria-selected={value === item.id}
      aria-controls={`panel-${item.id}`}
      tabIndex={value === item.id ? 0 : -1}
      disabled={item.disabled}
      className="ep-tab"
      onClick={() => onChange(item.id)}
    >{item.label}</button>)}
  </div>;
}

export function Disclosure({ summary, children, className = '', ...props }: React.DetailsHTMLAttributes<HTMLDetailsElement> & { summary: React.ReactNode }) {
  return <details className={`ep-disclosure ${className}`} {...props}><summary>{summary}</summary>{children}</details>;
}

export function Tooltip({
  text,
  children,
  className = '',
}: {
  text: string;
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const trigger = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, { 'aria-describedby': id })
    : <span tabIndex={0} aria-describedby={id}>{children}</span>;
  return <span className={`ep-tooltip ${className}`}>
    {trigger}<span className="ep-tooltip-content" role="tooltip" id={id}>{text}</span>
  </span>;
}

export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
  duration = 4000,
}: {
  message: React.ReactNode;
  actionLabel?: React.ReactNode;
  onAction?: () => void;
  onDismiss: () => void;
  duration?: number;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timeout);
  }, [duration, onDismiss]);
  return <div className="ep-toast" role="status" aria-live="polite">
    <div className="flex items-center justify-between gap-3">
      <span>{message}</span>
      {actionLabel !== undefined && onAction && <Button size="sm" variant="ghost" onClick={onAction}>{actionLabel}</Button>}
    </div>
  </div>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
export function Modal({
  open,
  onClose,
  title,
  children,
  className = '',
  backdropClassName = '',
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  backdropClassName?: string;
  labelledBy?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const inertTargets = dialog
      ? Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(dialog))
      : [];
    const previousInertStates = inertTargets.map(element => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const element of inertTargets) { element.inert = true; element.setAttribute('aria-hidden', 'true'); }
    const isTopmost = () => {
      const dialogs = document.querySelectorAll<HTMLElement>('.ep-modal-window[aria-modal="true"]');
      return Boolean(dialog && dialogs[dialogs.length - 1] === dialog);
    };
    const getFocusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) || [])
      .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
    const focusFirst = () => (getFocusable()[0] || dialog)?.focus();
    const frame = window.requestAnimationFrame(focusFirst);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = getFocusable();
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      for (const state of previousInertStates) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden');
        else state.element.setAttribute('aria-hidden', state.ariaHidden);
      }
      previous?.focus();
    };
  }, [open]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<div className={`ep-modal-backdrop ${backdropClassName}`} onMouseDown={event => { if (event.target === event.currentTarget) onCloseRef.current(); }}>
    <div ref={dialogRef} className={`ep-modal-window ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy || titleId} tabIndex={-1}>
      {!labelledBy && <h2 id={titleId} className="sr-only">{title}</h2>}
      {children}
    </div>
  </div>, document.body);
}

export function ConfirmCard({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
  confirmLabel: React.ReactNode;
  cancelLabel: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return <section className="ep-confirm-card" aria-label={typeof title === 'string' ? title : undefined}>
    <h3 className="ep-display m-0 text-[length:var(--type-16)]">{title}</h3>
    <p className="ep-muted my-3">{description}</p>
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
      <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </section>;
}

export function EmptyState({
  icon,
  message,
  actionLabel,
  onAction,
  className = '',
}: {
  icon: React.ReactNode;
  message: React.ReactNode;
  actionLabel: React.ReactNode;
  onAction: () => void;
  className?: string;
}) {
  return <div className={`ep-empty-state ${className}`}>
    <span aria-hidden="true">{icon}</span>
    <p className="m-0">{message}</p>
    <Button variant="primary" onClick={onAction}>{actionLabel}</Button>
  </div>;
}

export function Kbd({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <kbd className={`ep-kbd ${className}`}>{children}</kbd>;
}
