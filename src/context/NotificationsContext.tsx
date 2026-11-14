import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import * as api from '../lib/api';
import type { AppNotification } from '../lib/types';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { useCelebrate } from '../components/Celebration';

interface NotificationsValue {
  items: AppNotification[];
  unread: number;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeAll: (onlyRead?: boolean) => Promise<void>;
}

const Ctx = createContext<NotificationsValue | null>(null);

/** Event fired whenever server data may have changed (e.g. a teacher reviewed a task). */
export const DATA_CHANGED = 'winstreak:data-changed';
export function emitDataChanged() { window.dispatchEvent(new Event(DATA_CHANGED)); }

/** Re-run `fn` whenever a realtime notification signals that data changed. */
export function useOnDataChanged(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener(DATA_CHANGED, handler);
    return () => window.removeEventListener(DATA_CHANGED, handler);
  }, []);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { session, profile } = useAuth();
  const { toast } = useToast();
  const celebrate = useCelebrate();
  const isStudent = profile?.role === 'student';
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const userId = session?.user.id;

  // Each teacher approval is celebrated once per device, even if it arrived while the app was closed.
  const seenKey = `winstreak:celebrated:${userId}`;
  const markSeen = useCallback((ids: string[]) => {
    try {
      const prev: string[] = JSON.parse(localStorage.getItem(seenKey) ?? '[]');
      localStorage.setItem(seenKey, JSON.stringify([...new Set([...ids, ...prev])].slice(0, 100)));
    } catch { /* storage unavailable */ }
  }, [seenKey]);
  const celebrateApproval = useCallback((list: AppNotification[]) => {
    if (!isStudent) return;
    let seen: string[] = [];
    try { seen = JSON.parse(localStorage.getItem(seenKey) ?? '[]'); } catch { /* ignore */ }
    const fresh = list.filter((n) => n.type === 'task_approved' && !n.read_at && !seen.includes(n.id)
      && Date.now() - new Date(n.created_at).getTime() < 3 * 86_400_000);
    if (!fresh.length) return;
    markSeen(fresh.map((n) => n.id));
    void api.getMyStreak()
      .then((st) => celebrate({ kind: 'verified', streak: st.current_streak, title: fresh[0].title.replace(/^Verified: /, '') }))
      .catch(() => undefined);
  }, [isStudent, seenKey, markSeen, celebrate]);

  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      setError(null);
      const [list, count] = await Promise.all([api.listNotifications(), api.unreadCount()]);
      setItems(list);
      setUnread(count);
      celebrateApproval(list);
    } catch (e) {
      setError(api.friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [userId, celebrateApproval]);

  useEffect(() => {
    if (!userId) { setItems([]); setUnread(0); return; }
    void reload();

    // Realtime: new notifications appear instantly (RLS ensures users only receive their own).
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (payload) => {
          const n = payload.new as AppNotification;
          setItems((prev) => (prev.some((p) => p.id === n.id) ? prev : [n, ...prev].slice(0, 50)));
          setUnread((u) => u + 1);
          toast(n.type === 'task_rejected' ? 'error' : n.type === 'task_approved' || n.type === 'badge_earned' ? 'success' : 'info', n.title, n.body);
          emitDataChanged();
          // Teacher verified the work: launch the rocket with the current streak.
          if (n.type === 'task_approved') celebrateApproval([n]);
        })
      .subscribe();

    // Fallback polling (covers networks that block websockets) and refresh on focus.
    const interval = window.setInterval(() => void reload(), 60_000);
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [userId, reload, toast, celebrateApproval]);

  const markRead = useCallback(async (ids: string[]) => {
    const unreadIds = ids.filter((id) => items.find((i) => i.id === id && !i.read_at));
    if (!unreadIds.length) return;
    await api.markRead(unreadIds);
    const now = new Date().toISOString();
    setItems((prev) => prev.map((i) => (unreadIds.includes(i.id) ? { ...i, read_at: now } : i)));
    setUnread((u) => Math.max(0, u - unreadIds.length));
  }, [items]);

  const markAllRead = useCallback(async () => {
    await api.markAllRead();
    const now = new Date().toISOString();
    setItems((prev) => prev.map((i) => (i.read_at ? i : { ...i, read_at: now })));
    setUnread(0);
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.deleteNotification(id);
    const target = items.find((i) => i.id === id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (target && !target.read_at) setUnread((u) => Math.max(0, u - 1));
  }, [items]);

  const removeAll = useCallback(async (onlyRead = false) => {
    if (!userId) return;
    await api.deleteAllNotifications(userId, onlyRead);
    if (onlyRead) {
      setItems((prev) => prev.filter((i) => !i.read_at));
    } else {
      setItems([]);
      setUnread(0);
    }
  }, [userId]);

  return (
    <Ctx.Provider value={{ items, unread, loading, error, reload, markRead, markAllRead, remove, removeAll }}>
      {children}
    </Ctx.Provider>
  );
}

export function useNotifications(): NotificationsValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useNotifications must be used inside NotificationsProvider');
  return ctx;
}
