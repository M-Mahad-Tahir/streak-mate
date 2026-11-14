import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getMyAccess, type Access } from '../lib/api';
import { useAuth } from './AuthContext';
import { useOnDataChanged } from './NotificationsContext';

interface AccessValue {
  access: Access | null;      // null while loading, or when the database update is missing
  loading: boolean;
  readOnly: boolean;          // trial ended without payment: view only
  isAdmin: boolean;
  isSuperAdmin: boolean;     // the one super admin (manages admins)
  dbReady: boolean;           // false until RUN_THIS_UPDATE.sql has been run
  refresh: () => Promise<void>;
}

const Ctx = createContext<AccessValue>({
  access: null, loading: true, readOnly: false, isAdmin: false, isSuperAdmin: false, dbReady: true, refresh: async () => undefined,
});

export function AccessProvider({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(true);
  const [dbReady, setDbReady] = useState(true);
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;

  const refresh = useCallback(async () => {
    try {
      const a = await getMyAccess();
      setAccess(a);
      setDbReady(a !== null);
      // Admin rights were given or taken away while signed in: reload the profile
      // so the menu and the home page follow the new role.
      const { profile, refreshProfile } = authRef.current;
      if (a && profile && a.is_admin !== (profile.role === 'admin')) void refreshProfile();
    } catch {
      // Keep the last known state on network errors.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void refresh(), 5 * 60_000);
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, [refresh]);
  // A payment approval arrives as a notification: refresh access right away.
  useOnDataChanged(() => void refresh());

  return (
    <Ctx.Provider value={{
      access, loading, dbReady, refresh,
      readOnly: access?.read_only ?? false,
      isAdmin: access?.is_admin ?? false,
      isSuperAdmin: access?.is_super_admin ?? false,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAccess = () => useContext(Ctx);
