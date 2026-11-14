/**
 * Fingerprint / face sign-in on this device (Windows Hello, Touch ID, Android fingerprint).
 *
 * How it works:
 * - The browser's WebAuthn API asks the device to check the user's fingerprint (or face / device PIN).
 *   The fingerprint never leaves the device and the app never sees it.
 * - When fingerprint sign-in is on, "Log out" LOCKS the app instead of ending the session.
 *   The sign-in page then offers "Sign in with fingerprint" to unlock without a password.
 * - "Sign out completely" ends the session for real; the password is needed again after that.
 *
 * This is a device-level unlock: it protects the saved session on this device with the fingerprint.
 */
const SETUP_KEY = 'winstreak:biometric';
const LOCK_KEY = 'winstreak:locked';
const DISMISS_KEY = 'winstreak:biometric-dismissed';

export interface BiometricSetup {
  credentialId: string; // base64url
  userId: string;
  email: string;
  name: string;
}

function read<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function remove(key: string) {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

const toB64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** True when this browser/device has a built-in fingerprint/face/PIN authenticator. */
export async function isBiometricSupported(): Promise<boolean> {
  try {
    if (!window.isSecureContext || !window.PublicKeyCredential) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export const getBiometricSetup = () => read<BiometricSetup>(SETUP_KEY);
export const isLocked = () => read<boolean>(LOCK_KEY) === true;
export const setLocked = (v: boolean) => (v ? write(LOCK_KEY, true) : remove(LOCK_KEY));
export const wasPromptDismissed = (userId: string) => read<string[]>(DISMISS_KEY)?.includes(userId) ?? false;
export const dismissPrompt = (userId: string) => write(DISMISS_KEY, [...(read<string[]>(DISMISS_KEY) ?? []), userId]);

/** Register this device's fingerprint for the signed-in user. Shows the system fingerprint prompt. */
export async function enableBiometric(user: { id: string; email: string; name: string }): Promise<void> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'Streak Mate', id: window.location.hostname },
      user: { id: new TextEncoder().encode(user.id), name: user.email, displayName: user.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60_000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Fingerprint setup was cancelled.');
  write(SETUP_KEY, { credentialId: toB64url(cred.rawId), userId: user.id, email: user.email, name: user.name } satisfies BiometricSetup);
}

export function disableBiometric() {
  remove(SETUP_KEY);
  setLocked(false);
}

/** Ask the device to check the fingerprint. Resolves only if the user passes. */
export async function verifyBiometric(): Promise<void> {
  const setup = getBiometricSetup();
  if (!setup) throw new Error('Fingerprint sign-in is not set up on this device.');
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: window.location.hostname,
      allowCredentials: [{ type: 'public-key', id: fromB64url(setup.credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  });
  if (!assertion) throw new Error('Fingerprint check was cancelled.');
}

/** Turn browser errors into short, helpful messages. */
export function biometricError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Fingerprint check was cancelled or timed out. Try again.';
  if (name === 'InvalidStateError') return 'This device is already set up for fingerprint sign-in.';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'This browser or device does not support fingerprint sign-in.';
  return (e as Error)?.message || 'Fingerprint sign-in failed. Use your password instead.';
}
