import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, BookOpenCheck, CalendarCheck, ClipboardCheck, Flame, History, LayoutDashboard, ListTodo,
  CreditCard, LogOut, Menu, Moon, School, Settings, ShieldCheck, Sun, Trash2, Users, X,
} from 'lucide-react';
import { useAccess } from '../context/AccessContext';
import { useAuth, useProfile } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { useToast } from '../context/ToastContext';
import { browserTimeZone, relativeTime } from '../lib/dates';
import { updateProfile, friendlyError } from '../lib/api';
import { cx } from './ui';
import { adminPath, adminSections } from './adminNav';
import { BiometricOffer } from './BiometricOffer';
import { useTheme } from '../lib/theme';

const studentNav = [
  { to: '/student', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/student/tasks', label: 'My Tasks', icon: ListTodo },
  { to: '/student/streak', label: 'My Streak', icon: Flame },
  { to: '/student/history', label: 'History & Feedback', icon: History },
  { to: '/student/classes', label: 'My Classes', icon: School },
];
/** In a student or teacher menu, the admin Dashboard is called Admin dashboard so it is not confused with theirs. */
const adminNav = (isSuperAdmin: boolean, dashboardLabel = 'Dashboard') => adminSections(isSuperAdmin)
  .map((s) => ({ to: adminPath(isSuperAdmin, s.key), label: s.key === '' ? dashboardLabel : s.label, icon: s.icon, end: true }));
const teacherNav = [
  { to: '/teacher', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/teacher/review', label: 'Pending Reviews', icon: ClipboardCheck },
  { to: '/teacher/history', label: 'Verified History', icon: BookOpenCheck },
  { to: '/teacher/classes', label: 'Classes & Students', icon: Users },
];

function Logo() {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2 px-1 sm:gap-3 sm:px-2">
      <img src="/logo.svg" alt="" className="h-8 w-8 shrink-0 sm:h-10 sm:w-10 lg:h-12 lg:w-12" />
      <span className="whitespace-nowrap text-base font-extrabold tracking-tight text-slate-900 min-[360px]:text-lg sm:text-xl lg:text-2xl">Streak{' '}<span className="text-brand-gradient">Mate</span></span>
    </Link>
  );
}

export function AppLayout() {
  const profile = useProfile();
  const { logOut } = useAuth();
  const { unread } = useNotifications();
  const { isAdmin, isSuperAdmin } = useAccess();
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const nav = profile.role === 'admin' ? adminNav(isSuperAdmin) : profile.role === 'teacher' ? teacherNav : studentNav;

  useEffect(() => setDrawer(false), [location.pathname]);

  const handleSignOut = async () => {
    await logOut();
    navigate('/signin', { replace: true });
  };

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 overflow-y-auto p-4" aria-label="Main">
      <div className="mb-6 mt-1"><Logo /></div>
      <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{profile.role === 'admin' ? (isSuperAdmin ? 'Super Admin' : 'Admin') : profile.role === 'teacher' ? 'Teacher' : 'Student'}</p>
      {nav.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end}
          className={({ isActive }) => cx(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
          )}>
          <item.icon className="h-[18px] w-[18px]" aria-hidden />
          {item.label}
        </NavLink>
      ))}
      <div className="my-3 border-t border-slate-100" />
      <NavLink to="/notifications" className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
        <Bell className="h-[18px] w-[18px]" aria-hidden /> Notifications
        {unread > 0 && <span className="ml-auto rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">{unread}</span>}
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
        <Settings className="h-[18px] w-[18px]" aria-hidden /> Settings
      </NavLink>
      {profile.role !== 'admin' && <NavLink to="/subscription" className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
        <CreditCard className="h-[18px] w-[18px]" aria-hidden /> Subscription
      </NavLink>}
      {isAdmin && profile.role !== 'admin' && (
        <>
          <p className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />{isSuperAdmin ? 'Super Admin' : 'Admin'}
          </p>
          {adminNav(isSuperAdmin, 'Admin dashboard').map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-violet-50 text-violet-700' : 'text-slate-600 hover:bg-slate-100')}>
              <item.icon className="h-[18px] w-[18px]" aria-hidden /> {item.label}
            </NavLink>
          ))}
        </>
      )}
      <div className="mt-auto rounded-xl bg-brand-gradient p-4 text-white">
        <CalendarCheck className="mb-2 h-5 w-5 opacity-90" aria-hidden />
        <p className="text-sm font-semibold">Small wins, every day.</p>
        <p className="mt-0.5 text-xs text-white/80">Consistency beats intensity.</p>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200 bg-surface lg:block">{sidebar}</aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 animate-fade-in bg-surface shadow-xl">
            <button onClick={() => setDrawer(false)} className="absolute right-3 top-4 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-slate-200 bg-surface/85 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setDrawer(true)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="lg:hidden"><Logo /></div>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <NotificationBell />
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold leading-tight text-slate-900">{profile.full_name}</p>
              <p className="text-xs capitalize text-slate-500">{profile.role === 'admin' && isSuperAdmin ? 'Super Admin' : profile.role}</p>
            </div>
            <div className="hidden h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-700 min-[360px]:flex" aria-hidden>
              {profile.full_name.slice(0, 1).toUpperCase()}
            </div>
            <button onClick={handleSignOut} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label="Sign out" title="Sign out">
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </header>
        <AccessBanner />
        {profile.role !== 'admin' && <TimezoneNotice />}
        <BiometricOffer />
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-6 lg:pt-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button onClick={toggle} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}

function NotificationBell() {
  const { items, unread, markRead, markAllRead, remove } = useNotifications();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} aria-haspopup="true">
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white ring-2 ring-surface">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="fixed inset-x-4 top-[4.25rem] animate-fade-in overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-[22rem]">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && <button onClick={() => void markAllRead()} className="text-xs font-medium text-brand-600 hover:underline">Mark all read</button>}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-500">You're all caught up.</li>}
            {items.slice(0, 6).map((n) => (
              <li key={n.id} className={cx('flex items-start hover:bg-slate-50', !n.read_at && 'bg-brand-50/40')}>
                <button onClick={() => { void markRead([n.id]); setOpen(false); if (n.link) navigate(n.link); }}
                  className="flex min-w-0 flex-1 gap-3 py-3 pl-4 text-left">
                  <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-brand-500')} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-900">{n.title}</span>
                    {n.body && <span className="line-clamp-2 block text-xs text-slate-500">{n.body}</span>}
                    <span className="mt-0.5 block text-[11px] text-slate-400">{relativeTime(n.created_at)}</span>
                  </span>
                </button>
                <button onClick={() => void remove(n.id).catch((e) => toast('error', 'Could not delete', friendlyError(e)))}
                  className="tap-target mx-2 mt-2.5 shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
                  aria-label={`Delete notification: ${n.title}`} title="Delete">
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-slate-100 px-4 py-2.5 text-center text-sm font-medium text-brand-600 hover:bg-slate-50">
            View all
          </Link>
        </div>
      )}
    </div>
  );
}

/** Streak days are based on the profile timezone; offer to sync it with this device. */
function TimezoneNotice() {
  const profile = useProfile();
  const { refreshProfile } = useAuth();
  const { toast } = useToast();
  const device = browserTimeZone();
  const key = `winstreak:tz-dismissed:${device}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const [saving, setSaving] = useState(false);
  if (dismissed || device === profile.timezone) return null;

  const dismiss = () => {
    try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };
  const apply = async () => {
    setSaving(true);
    try {
      await updateProfile(profile.id, { timezone: device });
      await refreshProfile();
      toast('success', 'Timezone updated', `Win days now follow ${device}.`);
    } catch (e) {
      toast('error', 'Could not update timezone', friendlyError(e));
    } finally { setSaving(false); }
  };

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1">
        <span>This device is in <strong>{device}</strong>, but your account uses <strong>{profile.timezone}</strong> for due dates and streak days.</span>
        <span className="flex gap-3">
          <button onClick={apply} disabled={saving} className="font-semibold underline underline-offset-2">{saving ? 'Updating...' : `Use ${device}`}</button>
          <button onClick={dismiss} className="text-amber-700 hover:underline">Keep {profile.timezone}</button>
        </span>
      </div>
    </div>
  );
}


/** Trial / subscription status shown at the top of every page when it matters. */
function AccessBanner() {
  const { access } = useAccess();
  if (!access) return null;
  const days = access.trial_ends_at ? Math.max(0, Math.ceil((new Date(access.trial_ends_at).getTime() - Date.now()) / 86_400_000)) : 0;
  let tone = '';
  let text = '';
  if (access.admin_pending) {
    tone = 'border-violet-200 bg-violet-50 text-violet-900';
    text = access.admin_pending === 'super_admin'
      ? 'This email is the Super Admin. To turn on your admin powers, run the update query in the Supabase SQL Editor again, then sign out and sign in.'
      : 'This email is set as an Admin. The super admin will activate your admin access in the Admins tab. You will then be signed out: choose a new password with "Forgot password" and sign in.';
    return (
      <div className={cx('border-b px-4 py-2.5 text-sm sm:px-6', tone)}>
        <div className="mx-auto max-w-6xl">{text}</div>
      </div>
    );
  }
  if (access.pending_payment) {
    tone = 'border-sky-200 bg-sky-50 text-sky-900';
    text = 'Your payment is waiting for admin approval. You will be notified as soon as it is approved.';
  } else if (access.status === 'expired') {
    tone = 'border-rose-200 bg-rose-50 text-rose-900';
    text = 'Your 30-day free trial has ended. You can still view everything; subscribe to add, complete or submit work.';
  } else if (access.status === 'trial' && days <= 7) {
    tone = 'border-amber-200 bg-amber-50 text-amber-900';
    text = `Your free trial ends in ${days} day${days === 1 ? '' : 's'}. Subscribe for $5 a month or $50 a year.`;
  } else {
    return null;
  }
  return (
    <div className={cx('border-b px-4 py-2.5 text-sm sm:px-6', tone)}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1">
        <span>{text}</span>
        {!access.pending_payment && <Link to="/subscription" className="font-semibold underline underline-offset-2">Subscribe</Link>}
      </div>
    </div>
  );
}
