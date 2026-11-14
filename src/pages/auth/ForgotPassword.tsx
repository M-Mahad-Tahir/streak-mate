import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { AuthShell } from './AuthShell';
import { Button, ErrorBanner, Input } from '../../components/ui';
import { sendPasswordResetEmail } from '../../lib/api';
import { validateEmail } from '../../lib/validation';
import { lastEmail } from '../../lib/credentials';

/** Anyone who forgot their password can get a secure reset link by email. */
export default function ForgotPassword() {
  const [email, setEmail] = useState(lastEmail);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateEmail(email);
    setError(err);
    if (err) return;
    setSending(true);
    setFormError(null);
    try {
      await sendPasswordResetEmail(email.trim());
      setSent(true);
    } catch (e2) {
      setFormError((e2 as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <AuthShell title="Check your inbox" subtitle="We sent you a link to choose a new password.">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-900">
          <MailCheck className="mb-3 h-8 w-8 text-emerald-600" aria-hidden />
          If an account exists for <strong>{email.trim()}</strong>, it will get an email with a reset link in a few minutes.
          Open it on this device to set a new password. Check your spam folder too.
        </div>
        <Link to="/signin" className="mt-6 block text-center text-sm font-semibold text-brand-600 hover:underline">Back to sign in</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Forgot your password?" subtitle="Enter your email and we'll send you a link to choose a new one.">
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {formError && <ErrorBanner message={formError} />}
        <Input label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
          error={error} placeholder="you@school.edu" required />
        <Button type="submit" size="lg" className="w-full" loading={sending}>Send reset link</Button>
        <p className="text-center text-sm text-slate-500">
          Remembered it? <Link to="/signin" className="font-semibold text-brand-600 hover:underline">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
