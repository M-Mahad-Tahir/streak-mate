import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthShell } from './AuthShell';
import { Button, ErrorBanner, PageLoader, PasswordInput, cx } from '../../components/ui';
import { supabase } from '../../lib/supabase';
import { changePassword } from '../../lib/api';
import { offerToSavePassword, rememberEmail } from '../../lib/credentials';
import { passwordStrength, validatePassword } from '../../lib/validation';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

/**
 * Opened from the password reset email. Supabase signs the user in with a short-lived
 * recovery session; here they choose a new password.
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { unlock, refreshProfile } = useAuth();
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string | null; confirm?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const strength = passwordStrength(password);

  useEffect(() => {
    let active = true;
    // The reset link signs the user in; give the client a moment to read the link.
    const check = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setEmail(data.session?.user.email ?? null);
      setChecking(false);
    };
    void check();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active && session) { setEmail(session.user.email ?? null); setChecking(false); }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next = { password: validatePassword(password), confirm: confirm !== password ? 'Passwords do not match.' : null };
    setErrors(next);
    if (next.password || next.confirm) return;
    setSaving(true);
    setFormError(null);
    try {
      await changePassword(password);
      if (email) {
        rememberEmail(email);
        await offerToSavePassword(email, password);
      }
      unlock();
      await refreshProfile();
      toast('success', 'Password changed', 'You are signed in with your new password.');
      navigate('/', { replace: true });
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (checking) return <PageLoader label="Opening your reset link..." />;

  if (!email) {
    return (
      <AuthShell title="This link has expired" subtitle="Password reset links work once and only for a short time.">
        <ErrorBanner message="Request a new reset link and open it straight away on this device." />
        <Link to="/forgot-password" className="mt-6 block text-center text-sm font-semibold text-brand-600 hover:underline">Send a new reset link</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle={`For ${email}`}>
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {formError && <ErrorBanner message={formError} />}
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <div>
          <PasswordInput label="New password" name="new-password" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} error={errors.password} hint="At least 8 characters with a letter and a number." required />
          {password && (
            <div className="mt-2 flex items-center gap-2" aria-live="polite">
              <div className="flex flex-1 gap-1">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className={cx('h-1.5 flex-1 rounded-full', i < strength.score
                    ? strength.score <= 1 ? 'bg-rose-400' : strength.score === 2 ? 'bg-amber-400' : 'bg-emerald-500' : 'bg-slate-200')} />
                ))}
              </div>
              <span className="text-xs text-slate-500">{strength.label}</span>
            </div>
          )}
        </div>
        <PasswordInput label="Confirm new password" name="confirm-password" autoComplete="new-password" value={confirm}
          onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} required />
        <Button type="submit" size="lg" className="w-full" loading={saving}>Save new password</Button>
      </form>
    </AuthShell>
  );
}
