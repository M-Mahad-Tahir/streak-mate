import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Card, PasswordInput, cx } from './ui';
import { useToast } from '../context/ToastContext';
import { useProfile } from '../context/AuthContext';
import { changePassword } from '../lib/api';
import { offerToSavePassword } from '../lib/credentials';
import { passwordStrength, validatePassword } from '../lib/validation';

/**
 * Change password (for every user). The current password can never be shown: Supabase only
 * keeps a one-way hash of it. The eye buttons show what you are typing.
 */
export function PasswordCard() {
  const profile = useProfile();
  const { toast } = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string | null; confirm?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const strength = passwordStrength(password);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next = { password: validatePassword(password), confirm: confirm !== password ? 'Passwords do not match.' : null };
    setErrors(next);
    if (next.password || next.confirm) return;
    setSaving(true);
    setFormError(null);
    try {
      await changePassword(password);
      // Let the browser update its saved password for this site.
      await offerToSavePassword(profile.email, password, profile.full_name);
      toast('success', 'Password changed', 'Use your new password next time you sign in.');
      setPassword(''); setConfirm('');
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <div className="flex items-center gap-2 font-semibold"><KeyRound className="h-5 w-5 text-brand-600" aria-hidden />Password</div>
          <p className="mt-1 text-sm text-slate-600">
            For your safety, your current password is never stored in a readable form, so it cannot be shown here.
            Set a new one below, or see your saved password in your browser's password manager.
          </p>
        </div>
        {formError && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700" role="alert">{formError}</p>}
        {/* Hidden username helps the browser link the new password to this account. */}
        <input type="email" name="username" autoComplete="username" value={profile.email} readOnly hidden />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <PasswordInput label="New password" name="new-password" autoComplete="new-password" value={password}
              onChange={(e) => setPassword(e.target.value)} error={errors.password} hint="At least 8 characters with a letter and a number." />
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
            onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
        </div>
        <Button type="submit" loading={saving}>Change password</Button>
        <p className="text-xs text-slate-500">
          To see a password your browser saved: in Chrome open the menu (three dots), then Passwords and autofill, then Google Password Manager.
        </p>
      </form>
    </Card>
  );
}
