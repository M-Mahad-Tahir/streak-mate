import {
  forwardRef, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, Eye, EyeOff, Loader2, X } from 'lucide-react';
import type { TaskStatus } from '../lib/types';

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

// ---------------- Button ----------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-gradient text-white hover:brightness-110 focus-visible:ring-brand-500 shadow-sm',
  secondary: 'bg-surface text-slate-700 border border-slate-300 hover:bg-slate-50 focus-visible:ring-brand-500',
  ghost: 'text-slate-600 hover:bg-slate-100 focus-visible:ring-brand-500',
  danger: 'bg-[#e11d48] text-white hover:brightness-110 focus-visible:ring-rose-500 shadow-sm',
  success: 'bg-[#059669] text-white hover:brightness-110 focus-visible:ring-emerald-500 shadow-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref,
) {
  const sizes = { sm: 'px-2.5 py-1.5 text-xs gap-1.5', md: 'px-4 py-2 text-sm gap-2', lg: 'px-5 py-2.5 text-base gap-2' };
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------------- Form fields ----------------
interface FieldWrapProps { label?: string; error?: string | null; hint?: string; id: string; children: ReactNode; required?: boolean }
function FieldWrap({ label, error, hint, id, children, required }: FieldWrapProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          {label}{required && <span className="text-rose-500"> *</span>}
        </label>
      )}
      {children}
      {error ? <p id={`${id}-error`} className="text-xs font-medium text-rose-600">{error}</p>
        : hint ? <p id={`${id}-hint`} className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

const fieldClass = (error?: string | null) => cx(
  'block w-full rounded-lg border bg-surface px-3 py-2 text-sm text-slate-900 placeholder-slate-400 shadow-sm transition focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
  error ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200' : 'border-slate-300 focus:border-brand-500 focus:ring-brand-200',
);

interface InputProps extends InputHTMLAttributes<HTMLInputElement> { label?: string; error?: string | null; hint?: string }
export function Input({ label, error, hint, id, className, required, ...rest }: InputProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <FieldWrap label={label} error={error} hint={hint} id={fid} required={required}>
      <input id={fid} required={required} aria-invalid={!!error || undefined}
        aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
        className={cx(fieldClass(error), className)} {...rest} />
    </FieldWrap>
  );
}

export function PasswordInput({ label, error, hint, id, required, ...rest }: InputProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  const [show, setShow] = useState(false);
  return (
    <FieldWrap label={label} error={error} hint={hint} id={fid} required={required}>
      <div className="relative">
        <input id={fid} type={show ? 'text' : 'password'} required={required} aria-invalid={!!error || undefined}
          aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
          className={cx(fieldClass(error), 'pr-10')} {...rest} />
        <button type="button" onClick={() => setShow((s) => !s)}
          className="absolute inset-y-0 right-0 flex items-center rounded-r-lg px-3 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </FieldWrap>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { label?: string; error?: string | null; hint?: string }
export function Textarea({ label, error, hint, id, className, required, ...rest }: TextareaProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <FieldWrap label={label} error={error} hint={hint} id={fid} required={required}>
      <textarea id={fid} required={required} aria-invalid={!!error || undefined}
        aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
        className={cx(fieldClass(error), 'min-h-[90px]', className)} {...rest} />
    </FieldWrap>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> { label?: string; error?: string | null; hint?: string }
export function Select({ label, error, hint, id, className, children, required, ...rest }: SelectProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <FieldWrap label={label} error={error} hint={hint} id={fid} required={required}>
      <select id={fid} required={required} aria-invalid={!!error || undefined} className={cx(fieldClass(error), className)} {...rest}>
        {children}
      </select>
    </FieldWrap>
  );
}

// ---------------- Layout pieces ----------------
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-2xl border border-slate-200 bg-surface shadow-card', className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 [overflow-wrap:anywhere]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 [overflow-wrap:anywhere]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-brand-600', className)} aria-label="Loading" />;
}

export function PageLoader({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-slate-500" role="status">
      <Spinner className="h-7 w-7" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-slate-200/70', className)} />;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-surface/60 px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-brand-50 p-3 text-brand-600">{icon}</div>}
      <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-slate-500">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1">{message}</div>
      {onRetry && <button onClick={onRetry} className="font-semibold underline underline-offset-2 hover:text-rose-900">Retry</button>}
    </div>
  );
}

export function ProgressBar({ value, max, className, tone = 'brand' }: { value: number; max: number; className?: string; tone?: 'brand' | 'flame' | 'emerald' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tones = { brand: 'bg-brand-gradient', flame: 'bg-gradient-to-r from-flame-400 to-flame-600', emerald: 'bg-emerald-500' };
  return (
    <div className={cx('h-2.5 w-full overflow-hidden rounded-full bg-slate-100', className)} role="progressbar"
      aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={`${pct}% complete`}>
      <div className={cx('h-full rounded-full transition-all duration-500', tones[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

const statusStyles: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-slate-100 text-slate-700 ring-slate-200' },
  completed: { label: 'Completed', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  submitted: { label: 'Submitted', cls: 'bg-amber-50 text-amber-700 ring-amber-200' },
  verified: { label: 'Verified', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  rejected: { label: 'Rejected', cls: 'bg-rose-50 text-rose-700 ring-rose-200' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = statusStyles[status];
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', s.cls)}>{s.label}</span>;
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600', className)}>{children}</span>;
}

// ---------------- Modal ----------------
interface ModalProps { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg' }
export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
      first?.focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-fade-in" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={cx('relative flex max-h-[92vh] w-full animate-fade-in flex-col rounded-t-2xl bg-surface shadow-2xl sm:rounded-2xl', size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
          <button data-close onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close dialog">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger, loading }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; body: string; confirmLabel?: string; danger?: boolean; loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<>
      <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
    </>}>
      <p className="text-sm text-slate-600">{body}</p>
    </Modal>
  );
}

export function StatCard({ label, value, icon, tone = 'brand', hint }: { label: string; value: ReactNode; icon: ReactNode; tone?: 'brand' | 'flame' | 'emerald' | 'amber' | 'rose'; hint?: string }) {
  const tones = {
    brand: 'bg-brand-50 text-brand-600', flame: 'bg-flame-50 text-flame-600', emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600', rose: 'bg-rose-50 text-rose-600',
  };
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className={cx('w-fit rounded-xl p-2.5 sm:p-3', tones[tone])}>{icon}</div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="text-2xl font-bold text-slate-900">{value}</p>
          {hint && <p className="truncate text-xs text-slate-400">{hint}</p>}
        </div>
      </div>
    </Card>
  );
}
