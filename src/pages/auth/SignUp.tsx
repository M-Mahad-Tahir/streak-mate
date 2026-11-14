import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { GraduationCap, MailCheck, Presentation } from 'lucide-react';
import { AuthShell } from './AuthShell';
import { Button, ErrorBanner, Input, PasswordInput, cx } from '../../components/ui';
import { signUp } from '../../lib/api';
import { browserTimeZone } from '../../lib/dates';
import { passwordStrength, validateEmail, validateName, validatePassword } from '../../lib/validation';
import { offerToSavePassword, rememberEmail } from '../../lib/credentials';
import type { Role } from '../../lib/types';

type Errors = Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'role', string | null>>;

export default function SignUp() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  const navigate = useNavigate();
  const strength = passwordStrength(password);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validatePassword(password),
      confirm: confirm !== password ? 'Passwords do not match.' : null,
      role: role ? null : 'Choose whether you are a student or a teacher.',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean) || !role) return;
    setLoading(true);
    setFormError(null);
    try {
      const data = await signUp({ email: email.trim(), password, fullName: name.trim(), role, timezone: browserTimeZone() });
      rememberEmail(email.trim());
      await offerToSavePassword(email.trim(), password, name.trim());
      if (data.session) {
        // The account is ready (email confirmation is off): the person signs in themselves.
        navigate('/signin', { replace: true, state: { created: true, email: email.trim() } });
      } else {
        setCheckEmail(true); // email confirmation is enabled in Supabase
      }
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (checkEmail) {
    return (
      <AuthShell title="Check your inbox" subtitle="One more step to activate your account.">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-900">
          <MailCheck className="mb-3 h-8 w-8 text-emerald-600" aria-hidden />
          We sent a confirmation link to <strong>{email}</strong>. Open it to finish creating your account, then sign in.
        </div>
        <Link to="/signin" className="mt-6 block text-center text-sm font-semibold text-brand-600 hover:underline">Back to sign in</Link>
      </AuthShell>
    );
  }

  const roles: { value: Role; title: string; body: string; icon: typeof GraduationCap }[] = [
    { value: 'student', title: 'Student', body: 'Track tasks and build streaks', icon: GraduationCap },
    { value: 'teacher', title: 'Teacher', body: 'Verify work and guide students', icon: Presentation },
  ];

  return (
    <AuthShell title="Create your account" subtitle="Start building your daily streak.">
      <form onSubmit={onSubmit} className="space-y-5" noValidate method="post" action="/signup" name="signup">
        {formError && <ErrorBanner message={formError} />}
        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-slate-700">I am a<span className="text-rose-500"> *</span></legend>
          <div className="grid grid-cols-2 gap-3" role="radiogroup">
            {roles.map((r) => (
              <label key={r.value} className={cx(
                'flex cursor-pointer flex-col gap-1 rounded-xl border-2 p-4 transition focus-within:ring-2 focus-within:ring-brand-300',
                role === r.value ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-surface hover:border-slate-300',
              )}>
                <input type="radio" name="role" value={r.value} checked={role === r.value} onChange={() => setRole(r.value)} className="sr-only" />
                <r.icon className={cx('h-6 w-6', role === r.value ? 'text-brand-600' : 'text-slate-400')} aria-hidden />
                <span className="text-sm font-semibold text-slate-900">{r.title}</span>
                <span className="text-xs text-slate-500">{r.body}</span>
              </label>
            ))}
          </div>
          {errors.role && <p className="mt-1.5 text-xs font-medium text-rose-600">{errors.role}</p>}
        </fieldset>
        <Input label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="Alex Johnson" required />
        <Input label="Email" type="email" name="email" id="signup-email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} placeholder="you@school.edu" required />
        <div>
          <PasswordInput label="Password" name="new-password" id="signup-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
            error={errors.password} hint="At least 8 characters with a letter and a number." required />
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
        <PasswordInput label="Confirm password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} required />
        <Button type="submit" size="lg" className="w-full" loading={loading}>Create account</Button>
        <p className="text-center text-sm text-slate-500">
          Already have an account? <Link to="/signin" className="font-semibold text-brand-600 hover:underline">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
