import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { getProfile } from '../lib/api';
import type { Profile } from '../lib/types';
import { getBiometricSetup, isLocked, setLocked } from '../lib/biometric';

interface AuthValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  profileError: string | null;
  refreshProfile: () => Promise<void>;
  /** Ends the session completely (password needed again). */
  signOut: () => Promise<void>;
  /** True while the app is locked behind fingerprint sign-in. */
  locked: boolean;
  /** Log out: locks the app when fingerprint sign-in is on, otherwise signs out completely. */
  logOut: () => Promise<void>;
  unlock: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [locked, setLockedState] = useState(isLocked);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); return; }
    try {
      setProfileError(null);
      const p = await getProfile(s.user.id);
      setProfile(p);
      if (!p) setProfileError('Your profile could not be found. Please contact support.');
    } catch (e) {
      setProfileError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await loadProfile(data.session);
      if (active) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Defer to avoid calling Supabase inside the auth callback (prevents deadlocks).
        setTimeout(() => { void loadProfile(s).finally(() => setLoading(false)); }, 0);
      }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadProfile]);

  const value = useMemo<AuthValue>(() => ({
    session,
    profile,
    loading,
    profileError,
    refreshProfile: async () => {
      // Read the live session (state may lag right after sign-in).
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      await loadProfile(data.session);
    },
    signOut: async () => {
      await supabase.auth.signOut();
      setLocked(false);
      setLockedState(false);
      setProfile(null);
    },
    locked,
    logOut: async () => {
      const setup = getBiometricSetup();
      if (setup && session && setup.userId === session.user.id) {
        // Fingerprint sign-in is on for this account: lock instead of ending the session.
        setLocked(true);
        setLockedState(true);
        return;
      }
      await supabase.auth.signOut();
      setProfile(null);
    },
    unlock: () => {
      setLocked(false);
      setLockedState(false);
    },
  }), [session, profile, loading, profileError, loadProfile, locked]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Use inside authenticated routes only: profile is guaranteed. */
export function useProfile(): Profile {
  const { profile } = useAuth();
  if (!profile) throw new Error('Profile not loaded');
  return profile;
}
