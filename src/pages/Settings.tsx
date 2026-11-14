import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BellRing, Fingerprint, Globe, UserRound } from 'lucide-react';
import { biometricError, disableBiometric, enableBiometric, getBiometricSetup, isBiometricSupported } from '../lib/biometric';
import { useAuth, useProfile } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Button, Card, Input, PageHeader, Select } from '../components/ui';
import { friendlyError, updateProfile } from '../lib/api';
import { allTimeZones, browserTimeZone } from '../lib/dates';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';
import { validateName } from '../lib/validation';
import { PasswordCard } from '../components/PasswordCard';
import { useAccess } from '../context/AccessContext';

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'This browser does not support push notifications. You will still see in-app notifications.',
  unconfigured: 'Push notifications are not configured on this deployment (missing VAPID public key).',
  denied: 'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
  enabled: 'Push notifications are on for this browser.',
  disabled: 'Get reminders and review updates even when Streak Mate is closed.',
};

export default function SettingsPage() {
  const profile = useProfile();
  const { isSuperAdmin } = useAccess();
  const { refreshProfile } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(profile.full_name);
  const [tz, setTz] = useState(profile.timezone);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const zones = useMemo(() => {
    const list = allTimeZones();
    return list.includes(profile.timezone) ? list : [profile.timezone, ...list];
  }, [profile.timezone]);

  useEffect(() => { void getPushState().then(setPush).catch(() => setPush('unsupported')); }, []);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateName(name);
    setNameError(err);
    if (err) return;
    setSaving(true);
    try {
      await updateProfile(profile.id, { full_name: name.trim(), timezone: tz });
      await refreshProfile();
      toast('success', 'Settings saved');
    } catch (e2) {
      toast('error', 'Could not save settings', friendlyError(e2));
    } finally {
      setSaving(false);
    }
  };

  const togglePush = async () => {
    setPushBusy(true);
    try {
      const next = push === 'enabled' ? await disablePush() : await enablePush();
      setPush(next);
      if (next === 'enabled') toast('success', 'Push notifications enabled');
      else if (next === 'denied') toast('error', 'Permission denied', PUSH_TEXT.denied);
    } catch (e) {
      toast('error', 'Push setup failed', friendlyError(e));
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Settings" subtitle="Manage your profile and notifications." />
      <Card className="p-6">
        <form onSubmit={onSave} className="space-y-5" noValidate>
          <div className="flex items-center gap-2 font-semibold"><UserRound className="h-5 w-5 text-brand-600" aria-hidden />Profile</div>
          <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} maxLength={100} required />
          <Input label="Email" value={profile.email} disabled hint="Email cannot be changed here." />
          <Input label="Role" value={profile.role === 'admin' ? (isSuperAdmin ? 'Super Admin' : 'Admin') : profile.role === 'teacher' ? 'Teacher' : 'Student'} disabled
            hint={profile.role === 'admin' ? 'The admin account manages the website and has no student or teacher role.' : 'Only the admin can change a role.'} />
          <div>
            <Select label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)}
              hint={profile.role === 'student' ? 'Due dates, reminders and Win Days are calculated in this timezone.' : 'Used for reminder digests.'}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </Select>
            {tz !== browserTimeZone() && (
              <button type="button" onClick={() => setTz(browserTimeZone())} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                <Globe className="h-3.5 w-3.5" aria-hidden />Use this device's timezone ({browserTimeZone()})
              </button>
            )}
          </div>
          <Button type="submit" loading={saving}>Save changes</Button>
        </form>
      </Card>
      <Card className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex-1">
            <div className="flex items-center gap-2 font-semibold"><BellRing className="h-5 w-5 text-brand-600" aria-hidden />Browser push notifications</div>
            <p className="mt-1 text-sm text-slate-600">{push ? PUSH_TEXT[push] : 'Checking...'}</p>
          </div>
          {(push === 'enabled' || push === 'disabled') && (
            <Button variant={push === 'enabled' ? 'secondary' : 'primary'} loading={pushBusy} onClick={() => void togglePush()}>
              {push === 'enabled' ? 'Turn off' : 'Enable push'}
            </Button>
          )}
        </div>
      </Card>
      <PasswordCard />
      <FingerprintCard />
    </div>
  );
}

function FingerprintCard() {
  const profile = useProfile();
  const { toast } = useToast();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [on, setOn] = useState(() => getBiometricSetup()?.userId === profile.id);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void isBiometricSupported().then(setSupported); }, []);

  const toggle = async () => {
    if (on) {
      disableBiometric();
      setOn(false);
      toast('success', 'Fingerprint sign-in is off', 'Log out now ends your session; sign in with your password.');
      return;
    }
    setBusy(true);
    try {
      await enableBiometric({ id: profile.id, email: profile.email, name: profile.full_name });
      setOn(true);
      toast('success', 'Fingerprint sign-in is on', 'Next time, tap "Sign in with fingerprint".');
    } catch (e) {
      toast('error', 'Could not turn on fingerprint sign-in', biometricError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex-1">
          <div className="flex items-center gap-2 font-semibold"><Fingerprint className="h-5 w-5 text-brand-600" aria-hidden />Fingerprint sign-in on this device</div>
          <p className="mt-1 text-sm text-slate-600">
            {supported === null ? 'Checking...'
              : !supported ? 'This device or browser has no fingerprint, face or PIN sign-in (Windows Hello, Touch ID or Android fingerprint).'
              : on ? 'On. Log out locks Streak Mate, and your fingerprint opens it again without a password.'
              : 'Sign in with your fingerprint instead of typing your password. Your fingerprint never leaves this device.'}
          </p>
        </div>
        {supported && (
          <Button variant={on ? 'secondary' : 'primary'} loading={busy} onClick={() => void toggle()}
            icon={<Fingerprint className="h-4 w-4" />}>{on ? 'Turn off' : 'Turn on'}</Button>
        )}
      </div>
    </Card>
  );
}
