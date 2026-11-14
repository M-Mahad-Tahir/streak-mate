import { useState, type FormEvent } from 'react';
import { ArrowLeft, CheckCircle2, Clock, Copy, Crown, Gift, ImageUp, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { useProfile } from '../context/AuthContext';
import { useAccess } from '../context/AccessContext';
import { useToast } from '../context/ToastContext';
import { Button, Card, EmptyState, ErrorBanner, Input, PageHeader, Skeleton, cx } from '../components/ui';
import * as api from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { formatDateTime } from '../lib/dates';

type PlanKey = keyof typeof api.PLANS;

const fmtDate = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso)) : '');
const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0);
const rupees = (n: number) => `Rs ${n.toLocaleString('en-PK')}`;

export default function SubscriptionPage() {
  const { access, loading, dbReady, refresh } = useAccess();
  const { toast } = useToast();
  const payments = useAsync(() => api.listMyPayments(), []);
  const [plan, setPlan] = useState<PlanKey>('yearly');
  const [step, setStep] = useState<'choose' | 'pay'>('choose');
  const [sender, setSender] = useState('');
  const [tid, setTid] = useState('');
  const [payerName, setPayerName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const profile = useProfile();
  const [errors, setErrors] = useState<{ name?: string; sender?: string; tid?: string; file?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!dbReady) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Subscription" />
        <ErrorBanner message="Subscriptions need a quick database update. Run supabase/RUN_THIS_UPDATE.sql in the Supabase SQL Editor, then reload this page." />
      </div>
    );
  }
  if (loading || !access) return <Skeleton className="h-64" />;

  const pending = (payments.data ?? []).find((p) => p.status === 'pending');
  const needsPlan = access.status === 'trial' || access.status === 'expired' || access.status === 'active';
  const selected = api.PLANS[plan];

  const copyNumber = async () => {
    try { await navigator.clipboard.writeText(api.JAZZCASH_NUMBER); toast('success', 'Number copied', api.JAZZCASH_NUMBER); }
    catch { toast('info', 'JazzCash number', api.JAZZCASH_NUMBER); }
  };

  const pickFile = (f: File | null) => {
    setErrors((x) => ({ ...x, file: undefined }));
    if (preview) URL.revokeObjectURL(preview);
    if (!f) { setFile(null); setPreview(null); return; }
    const problem = api.checkProofFile(f);
    if (problem) { setErrors((x) => ({ ...x, file: problem })); setFile(null); setPreview(null); return; }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const digits = sender.replace(/\D/g, '');
    const cleanTid = tid.replace(/\s/g, '');
    const next = {
      name: payerName.trim().length >= 2 ? undefined : 'Enter the name on the JazzCash account you paid from.',
      sender: /^\d{10,13}$/.test(digits) ? undefined : 'Enter the JazzCash number you paid from, for example 03001234567.',
      tid: /^[A-Za-z0-9]{6,40}$/.test(cleanTid) ? undefined : 'Enter the Transaction ID (TID) from your JazzCash receipt.',
      file: file ? undefined : 'Upload a screenshot of your JazzCash payment receipt.',
    };
    setErrors(next);
    if (next.name || next.sender || next.tid || next.file || !file) return;
    setSaving(true);
    setFormError(null);
    let uploaded: string | null = null;
    try {
      uploaded = await api.uploadPaymentProof(profile.id, file);
      await api.submitPayment(plan, digits, cleanTid, payerName.trim(), uploaded);
      toast('success', 'Payment sent for approval', 'You will get a notification as soon as it is approved.');
      setSender(''); setTid(''); setPayerName(''); pickFile(null); setStep('choose');
      await Promise.all([payments.reload(true), refresh()]);
    } catch (err) {
      // The payment was not saved: remove the uploaded screenshot so it can be sent again.
      if (uploaded) void api.removePaymentProof(uploaded);
      setFormError(api.friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Subscription" subtitle="30 days free, then a small monthly or yearly plan." />

      <StatusCard access={access} />

      {pending && (
        <Card className="flex items-start gap-3 border-amber-200 bg-amber-50/70 p-5">
          <Clock className="mt-0.5 h-5 w-5 text-amber-600" aria-hidden />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">Payment waiting for approval</p>
            <p>{api.PLANS[pending.plan].label} plan, {rupees(pending.amount_pkr)}, TID {pending.transaction_id}. Sent {formatDateTime(pending.created_at)}.</p>
          </div>
        </Card>
      )}

      {needsPlan && !pending && (
        <Card className="p-6">
          {step === 'choose' ? (
            <>
              <h2 className="text-lg font-semibold text-slate-900">{access.status === 'active' ? 'Renew or extend your plan' : 'Choose a plan'}</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Plans">
                {(Object.keys(api.PLANS) as PlanKey[]).map((key) => {
                  const p = api.PLANS[key];
                  const active = plan === key;
                  return (
                    <label key={key} className={cx('relative flex cursor-pointer flex-col rounded-2xl border-2 p-5 transition focus-within:ring-2 focus-within:ring-brand-300',
                      active ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-300')}>
                      <input type="radio" name="plan" value={key} checked={active} onChange={() => setPlan(key)} className="sr-only" />
                      {key === 'yearly' && <span className="absolute -top-2.5 right-4 rounded-full bg-flame-500 px-2.5 py-0.5 text-xs font-bold text-white">Save $10 a year</span>}
                      <span className="text-sm font-semibold text-slate-600">{p.label}</span>
                      <span className="mt-1 text-3xl font-extrabold text-slate-900">${p.usd}<span className="text-base font-medium text-slate-500"> / {p.period}</span></span>
                      <span className="mt-1 text-sm text-slate-600">{rupees(p.pkr)} by JazzCash</span>
                    </label>
                  );
                })}
              </div>
              <Button className="mt-5 w-full sm:w-auto" size="lg" onClick={() => setStep('pay')} icon={<Smartphone className="h-4 w-4" />}>
                Continue to payment
              </Button>
            </>
          ) : (
            <form onSubmit={onSubmit} className="space-y-5" noValidate>
              <button type="button" onClick={() => setStep('choose')} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800">
                <ArrowLeft className="h-4 w-4" aria-hidden />Change plan
              </button>
              <div className="rounded-2xl border-2 border-dashed border-brand-200 bg-brand-50/50 p-5">
                <p className="text-sm font-semibold text-slate-600">Send {rupees(selected.pkr)} ({selected.label}, ${selected.usd}) by JazzCash to:</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span className="font-mono text-3xl font-bold tracking-wider text-slate-900">{api.JAZZCASH_NUMBER}</span>
                  <Button size="sm" variant="secondary" onClick={() => void copyNumber()} icon={<Copy className="h-3.5 w-3.5" />}>Copy</Button>
                </div>
                <p className="mt-1 text-sm text-slate-600">JazzCash account</p>
                <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-slate-600">
                  <li>Open the JazzCash app (or any bank app) and send <strong>{rupees(selected.pkr)}</strong> to the number above.</li>
                  <li>Copy the <strong>Transaction ID (TID)</strong> from the receipt.</li>
                  <li>Take a <strong>screenshot</strong> of the receipt.</li>
                  <li>Fill in your name, number and TID, and upload the screenshot. The admin checks it and turns on your plan.</li>
                </ol>
              </div>
              {formError && <ErrorBanner message={formError} />}
              <Input label="Name on the JazzCash account" placeholder="e.g. Muhammad Ali" value={payerName}
                onChange={(e) => { setPayerName(e.target.value); setErrors((x) => ({ ...x, name: undefined })); }} error={errors.name} required autoComplete="name" maxLength={100} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Your JazzCash number" inputMode="tel" placeholder="03001234567" value={sender}
                  onChange={(e) => { setSender(e.target.value); setErrors((x) => ({ ...x, sender: undefined })); }} error={errors.sender} required autoComplete="tel" />
                <Input label="Transaction ID (TID)" placeholder="e.g. 012345678901" value={tid}
                  onChange={(e) => { setTid(e.target.value); setErrors((x) => ({ ...x, tid: undefined })); }} error={errors.tid} required autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="proof-file" className="block text-sm font-medium text-slate-700">Screenshot of the payment receipt<span className="text-rose-500"> *</span></label>
                <label htmlFor="proof-file" className={cx('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition hover:bg-slate-50',
                  errors.file ? 'border-rose-300 bg-rose-50/40' : 'border-slate-300')}>
                  {preview ? (
                    <img src={preview} alt="Selected payment screenshot" className="max-h-56 rounded-lg border border-slate-200 object-contain" />
                  ) : (
                    <ImageUp className="h-8 w-8 text-slate-400" aria-hidden />
                  )}
                  <span className="text-sm font-medium text-brand-600">{file ? 'Change screenshot' : 'Choose a screenshot'}</span>
                  <span className="text-xs text-slate-500">{file ? file.name : 'PNG, JPG or WEBP, up to 5 MB'}</span>
                </label>
                <input id="proof-file" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" required
                  aria-invalid={!!errors.file || undefined} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
                {errors.file && <p className="text-xs font-medium text-rose-600">{errors.file}</p>}
              </div>
              <Button type="submit" size="lg" loading={saving}>Submit payment</Button>
            </form>
          )}
        </Card>
      )}

      <Card className="p-6">
        <h2 className="mb-3 font-semibold text-slate-900">Payment history</h2>
        {payments.error && <ErrorBanner message={payments.error} onRetry={() => void payments.reload()} />}
        {payments.loading && !payments.data ? <Skeleton className="h-20" /> : !payments.data?.length ? (
          <EmptyState title="No payments yet" body="Payments you submit will appear here with their status." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {payments.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <PaymentStatus status={p.status} />
                <span className="font-medium text-slate-900">{api.PLANS[p.plan].label} · {rupees(p.amount_pkr)}</span>
                <span className="font-mono text-xs text-slate-500">TID {p.transaction_id}</span>
                <span className="ml-auto text-xs text-slate-400">{formatDateTime(p.created_at)}</span>
                {p.status === 'rejected' && p.admin_note && <p className="w-full text-xs text-rose-700">Reason: {p.admin_note}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function StatusCard({ access }: { access: api.Access }) {
  const map = {
    admin: { icon: Crown, tone: 'bg-violet-50 text-violet-700', title: 'Admin account', body: 'Full access, free forever. You manage payments and users on the Admin page.' },
    free: { icon: Gift, tone: 'bg-emerald-50 text-emerald-700', title: 'Free access', body: 'Your account has full access at no cost.' },
    active: { icon: ShieldCheck, tone: 'bg-emerald-50 text-emerald-700', title: `${access.plan === 'yearly' ? 'Yearly' : 'Monthly'} plan active`, body: `Full access until ${fmtDate(access.paid_until)}.` },
    trial: { icon: Clock, tone: 'bg-brand-50 text-brand-700', title: `Free trial: ${daysLeft(access.trial_ends_at)} day${daysLeft(access.trial_ends_at) === 1 ? '' : 's'} left`, body: `Your trial ends on ${fmtDate(access.trial_ends_at)}. Subscribe any time to keep full access.` },
    expired: { icon: XCircle, tone: 'bg-rose-50 text-rose-700', title: 'Free trial ended', body: 'You can still view everything. Subscribe to add, complete, submit or verify work.' },
  }[access.status];
  return (
    <Card className="flex items-start gap-4 p-5">
      <div className={cx('rounded-xl p-3', map.tone)}><map.icon className="h-6 w-6" aria-hidden /></div>
      <div>
        <p className="text-lg font-semibold text-slate-900">{map.title}</p>
        <p className="text-sm text-slate-600">{map.body}</p>
      </div>
    </Card>
  );
}

function PaymentStatus({ status }: { status: api.Payment['status'] }) {
  const s = {
    pending: { icon: Clock, cls: 'bg-amber-50 text-amber-700', label: 'Waiting' },
    approved: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-700', label: 'Approved' },
    rejected: { icon: XCircle, cls: 'bg-rose-50 text-rose-700', label: 'Rejected' },
  }[status];
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', s.cls)}><s.icon className="h-3.5 w-3.5" aria-hidden />{s.label}</span>;
}
