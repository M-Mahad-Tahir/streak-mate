/**
 * Password saving is handled by the browser's own password manager (Chrome, Edge,
 * Safari, Firefox). The app never stores passwords itself.
 *
 * - offerToSavePassword(): asks the browser to show its "Save password?" prompt
 *   (Credential Management API, supported in Chromium browsers; other browsers
 *   detect the sign-in form automatically).
 * - The last used email is remembered so the sign-in form is pre-filled after
 *   logout, and the browser then autofills the saved password.
 */
const LAST_EMAIL_KEY = 'winstreak:last-email';

interface PasswordCredentialCtor {
  new (data: { id: string; password: string; name?: string }): Credential;
}

export async function offerToSavePassword(email: string, password: string, name?: string) {
  const Ctor = (window as unknown as { PasswordCredential?: PasswordCredentialCtor }).PasswordCredential;
  if (!Ctor || !navigator.credentials?.store) return;
  try {
    await navigator.credentials.store(new Ctor({ id: email, password, name }));
  } catch {
    // The user dismissed the prompt or the browser blocked it; nothing to do.
  }
}

export function rememberEmail(email: string) {
  try { localStorage.setItem(LAST_EMAIL_KEY, email); } catch { /* storage unavailable */ }
}

export function lastEmail(): string {
  try { return localStorage.getItem(LAST_EMAIL_KEY) ?? ''; } catch { return ''; }
}
