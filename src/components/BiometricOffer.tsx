import { useEffect, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { Button, Modal } from './ui';
import { useProfile } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  biometricError, dismissPrompt, enableBiometric, getBiometricSetup, isBiometricSupported, wasPromptDismissed,
} from '../lib/biometric';

/** Asks once per account on this device whether to turn on fingerprint sign-in. */
export function BiometricOffer() {
  const profile = useProfile();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void isBiometricSupported().then((ok) => {
      const already = getBiometricSetup()?.userId === profile.id;
      if (active && ok && !already && !wasPromptDismissed(profile.id)) setOpen(true);
    });
    return () => { active = false; };
  }, [profile.id]);

  const later = () => { dismissPrompt(profile.id); setOpen(false); };
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await enableBiometric({ id: profile.id, email: profile.email, name: profile.full_name });
      setOpen(false);
      toast('success', 'Fingerprint sign-in is on', 'Next time, tap "Sign in with fingerprint".');
    } catch (e) {
      setError(biometricError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={later} title="Use your fingerprint next time?" footer={<>
      <Button variant="secondary" onClick={later} disabled={busy}>Not now</Button>
      <Button onClick={() => void accept()} loading={busy} icon={<Fingerprint className="h-4 w-4" />}>Use fingerprint</Button>
    </>}>
      <div className="space-y-3 text-sm text-slate-600">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-brand-50 p-3 text-brand-600"><Fingerprint className="h-6 w-6" aria-hidden /></div>
          <p>Sign in on this device with your fingerprint instead of typing your password.</p>
        </div>
        <p className="text-xs text-slate-500">Your fingerprint stays on your device. Streak Mate never sees it. You can turn this off any time in Settings.</p>
        {error && <p className="rounded-lg bg-rose-50 p-3 text-rose-700" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
