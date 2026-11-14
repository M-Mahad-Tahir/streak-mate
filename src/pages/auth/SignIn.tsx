import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Fingerprint } from 'lucide-react';
import { AuthShell } from './AuthShell';
import { Button, ErrorBanner, Input, PasswordInput } from '../../components/ui';
import { signIn } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { validateEmail } from '../../lib/validation';
import { useAuth } from '../../context/AuthContext';
import { lastEmail, offerToSavePassword, rememberEmail } from '../../lib/credentials';
import {
  biometricError, getBiometricSetup, isBiometricSupported, verifyBiometric,
} from '../../lib/biometric';

export default function SignIn() {
  const location = useLocation();
  const state = location.state as { from?: string; created?: boolean; email?: string } | null;
  const [email, setEmail] = useState(() => state?.email ?? getBiometricSetup()?.email ?? lastEmail());
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bioSupported, setBioSupported] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const navigate = useNavigate();
  const { refreshProfile, unlock, locked, signOut } = useAuth();
  const from = state?.from;
  const setup = getBiometricSetup();
  const goNext = () => navigate(from && from !== '/signin' ? from : '/', { replace: true });

  useEffect(() => { void isBiometricSupported().then(setBioSupported); }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next = { email: validateEmail(email), password: password ? null : 'Password is required.' };
    setErrors(next);
    if (next.email || next.password) return;
    setLoading(true);
    setFormError(null);
    try {
      const data = await signIn(email.trim(), password);
      rememberEmail(email.trim());
      // Ask the browser to save the password so it can be filled in next time.
      const name = (data.user?.user_metadata?.full_name as string | undefined) ?? email.trim();
      await offerToSavePassword(email.trim(), password, name);
      unlock();
      await refreshProfile();
      goNext();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const signInWithFingerprint = async () => {
    setFormError(null);
    if (!setup) {
      setFormError('Fingerprint sign-in is not set up on this device yet. Sign in with your password once, then choose "Use fingerprint".');
      return;
    }
    setBioBusy(true);
    try {
      await verifyBiometric();
      const { data } = await supabase.auth.getSession();
      if (!data.session || data.session.user.id !== setup.userId) {
        setFormError('Your saved sign-in on this device has ended. Sign in with your password once to use your fingerprint again.');
        return;
      }
      unlock();
      await refreshProfile();
      goNext();
    } catch (err) {
      setFormError(biometricError(err));
    } finally {
      setBioBusy(false);
    }
  };

  const signOutCompletely = async () => {
    await signOut();
    setFormError(null);
    setPassword('');
  };

  return (
    <AuthShell
      title={locked && setup ? `Welcome back, ${setup.name.split(' ')[0]}` : 'Welcome back'}
      subtitle={locked && setup ? 'Use your fingerprint or your password to continue.' : 'Sign in to continue your streak.'}>
      <form onSubmit={onSubmit} className="space-y-5" noValidate method="post" action="/signin" name="signin">
        {state?.created && !formError && (
          <div role="status" className="flex gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-sm text-emerald-900">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
            <span><strong>Account created.</strong> Sign in with your email and password to continue.</span>
          </div>
        )}
        {formError && <ErrorBanner message={formError} />}
        <Input label="Email" type="email" name="email" id="signin-email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
          error={errors.email} placeholder="you@school.edu" required />
        <PasswordInput label="Password" name="password" id="signin-password" autoComplete="current-password" autoFocus={!!email && !setup} value={password} onChange={(e) => setPassword(e.target.value)}
          error={errors.password} placeholder="Your password" required />
        <div className="-mt-2 flex flex-wrap items-start justify-between gap-2">
          <p className="text-xs text-slate-500">You stay signed in on this device until you log out.</p>
          <Link to="/forgot-password" className="text-xs font-semibold text-brand-600 hover:underline">Forgot password?</Link>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={loading}>Sign in</Button>

        {bioSupported && (
          <>
            <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wider text-slate-400" aria-hidden>
              <span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" />
            </div>
            <Button variant="secondary" size="lg" className="w-full" loading={bioBusy} onClick={() => void signInWithFingerprint()}
              icon={<Fingerprint className="h-5 w-5 text-brand-600" />}>
              Sign in with fingerprint
            </Button>
            {locked && setup && (
              <p className="text-center text-xs text-slate-500">
                Not {setup.name.split(' ')[0]}?{' '}
                <button type="button" onClick={() => void signOutCompletely()} className="font-semibold text-brand-600 hover:underline">Sign out completely</button>
              </p>
            )}
          </>
        )}

        <p className="text-center text-sm text-slate-500">
          New to Streak Mate? <Link to="/signup" className="font-semibold text-brand-600 hover:underline">Create an account</Link>
        </p>
      </form>

    </AuthShell>
  );
}
