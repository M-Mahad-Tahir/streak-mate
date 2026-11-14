import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { CheckCircle2, Clock, Gift, GraduationCap, Pencil, Presentation, Search, ShieldCheck, Users, XCircle } from 'lucide-react';
import { AdminsTab, ClassesTab, TasksTab, UserEditModal } from './AdminManage';
import { adminBase, adminPath, adminSections, type AdminSection } from '../components/adminNav';
import { Crown } from 'lucide-react';
import { useAuth, useProfile } from '../context/AuthContext';
import { Image as ImageIcon, KeyRound } from 'lucide-react';
import { relativeTime } from '../lib/dates';
import { useAccess } from '../context/AccessContext';
import { useToast } from '../context/ToastContext';
import { Button, Card, EmptyState, ErrorBanner, Modal, PageHeader, PageLoader, Skeleton, StatCard, Textarea, cx } from '../components/ui';
import * as api from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { formatDateTime } from '../lib/dates';

const rupees = (n: number) => `Rs ${Number(n).toLocaleString('en-PK')}`;
const fmtDate = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso)) : '-');

export default function AdminPage() {
  const { isAdmin, isSuperAdmin, loading } = useAccess();
  const { section = '' } = useParams();
  const { pathname } = useLocation();
  const overview = useAsync(() => (isAdmin ? api.adminOverview() : Promise.resolve(null)), [isAdmin]);

  if (loading) return <PageLoader />;
  if (!isAdmin) return <AdminAccessOff />;

  // Keep the address matching the account: /super-admin/... for the super admin, /admin/... for admins.
  const sections = adminSections(isSuperAdmin);
  const current = sections.find((s) => s.key === section);
  const base = adminBase(isSuperAdmin);
  if (!current || (pathname !== base && !pathname.startsWith(`${base}/`))) {
    return <Navigate to={adminPath(isSuperAdmin, current?.key ?? '')} replace />;
  }

  const o = overview.data;
  const onChanged = () => void overview.reload(true);
  return (
    <div className="space-y-6">
      {current.key === '' ? (
        <PageHeader title={isSuperAdmin ? 'Super Admin' : 'Admin'} subtitle={isSuperAdmin ? 'You manage the whole website, including the admins.' : 'Approve payments and manage accounts for the whole website.'} />
      ) : (
        <PageHeader title={current.label} subtitle={current.subtitle} />
      )}
      <SectionLinks current={current.key} />
      {current.key === '' && (
        <>
          {overview.error && <ErrorBanner message={overview.error} onRetry={() => void overview.reload()} />}
          {!o ? <Skeleton className="h-24" /> : (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <StatCard label="Pending payments" value={o.pending_payments} icon={<Clock className="h-5 w-5" />} tone="amber" />
              <StatCard label="Paid accounts" value={o.paid_active} icon={<ShieldCheck className="h-5 w-5" />} tone="emerald" hint={`${rupees(o.revenue_pkr)} approved`} />
              <StatCard label="On free trial" value={o.on_trial} icon={<Gift className="h-5 w-5" />} hint={`${o.free_accounts} free emails`} />
              <StatCard label="Users" value={o.users} icon={<Users className="h-5 w-5" />} tone="flame" hint={`${o.students} students, ${o.teachers} teachers`} />
            </div>
          )}
          <PaymentsTab onChanged={onChanged} />
        </>
      )}
      {current.key === 'payments' && <PaymentsTab onChanged={onChanged} initialFilter="all" />}
      {current.key === 'users' && <UsersTab key="users" onChanged={onChanged} />}
      {current.key === 'students' && <UsersTab key="students" onChanged={onChanged} role="student" />}
      {current.key === 'teachers' && <UsersTab key="teachers" onChanged={onChanged} role="teacher" />}
      {current.key === 'tasks' && <TasksTab />}
      {current.key === 'classes' && <ClassesTab />}
      {current.key === 'admins' && <AdminsTab />}
    </div>
  );
}

/** Phones and tablets: quick section links (the sidebar is in the menu there). */
function SectionLinks({ current }: { current: AdminSection }) {
  const { isSuperAdmin } = useAccess();
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the current section's button in view in the sideways-scrolling row.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && active) list.scrollLeft = active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2;
  }, [current]);
  return (
    <div ref={listRef} className="relative -mx-4 flex gap-1 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 lg:hidden" role="tablist">
      {adminSections(isSuperAdmin).map((s) => (
        <Link key={s.key} to={adminPath(isSuperAdmin, s.key)} role="tab" aria-selected={s.key === current}
          className={cx('inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium', s.key === current ? 'bg-brand-gradient text-white' : 'bg-surface text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50')}>
          <s.icon className="h-4 w-4" aria-hidden />{s.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * Not an admin. Others go home; an account that still has the Admin role (its
 * admin access was just removed, or is not active yet) sees why, instead of
 * bouncing between "/" and "/admin".
 */
function AdminAccessOff() {
  const profile = useProfile();
  const { signOut } = useAuth();
  if (profile.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <Card className="mx-auto max-w-lg space-y-4 p-6">
      <div className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-5 w-5 text-brand-600" aria-hidden />Admin access is not active</div>
      <p className="text-sm text-slate-600">
        Your account cannot use the Admin page right now. The super admin may have removed your admin access,
        or your email is not confirmed yet. Sign out and sign in again to continue.
      </p>
      <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
    </Card>
  );
}

function PaymentsTab({ onChanged, initialFilter = 'pending' }: { onChanged: () => void; initialFilter?: 'pending' | 'all' }) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<'pending' | 'all'>(initialFilter);
  const list = useAsync(() => api.adminListPayments(filter === 'pending' ? 'pending' : undefined), [filter]);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<api.AdminPayment | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [proof, setProof] = useState<{ url: string; payment: api.AdminPayment } | null>(null);
  const openProof = async (p: api.AdminPayment) => {
    if (!p.screenshot_path) return;
    try { setProof({ url: await api.getProofUrl(p.screenshot_path), payment: p }); }
    catch (e) { toast('error', 'Could not open screenshot', api.friendlyError(e)); }
  };

  const review = async (p: api.AdminPayment, approve: boolean, note = '') => {
    setBusy(p.id);
    try {
      await api.adminReviewPayment(p.id, approve, note);
      toast('success', approve ? 'Payment approved' : 'Payment rejected', `${p.full_name} has been notified.`);
      setRejecting(null);
      await list.reload(true);
      onChanged();
    } catch (e) {
      const msg = api.friendlyError(e);
      if (rejecting) setReasonError(msg); else toast('error', 'Could not update payment', msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-4">
        <h2 className="font-semibold">JazzCash payments</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value as 'pending' | 'all')} aria-label="Filter payments"
          className="rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm">
          <option value="pending">Waiting for approval</option>
          <option value="all">All payments</option>
        </select>
      </div>
      {list.error && <div className="p-4"><ErrorBanner message={list.error} onRetry={() => void list.reload()} /></div>}
      {list.loading && !list.data ? <div className="p-4"><Skeleton className="h-24" /></div> : !list.data?.length ? (
        <div className="p-6"><EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title={filter === 'pending' ? 'No payments waiting' : 'No payments yet'} body="New JazzCash payments appear here for approval." /></div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.data.map((p) => (
            <li key={p.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900">{p.full_name} <span className="text-xs font-normal capitalize text-slate-500">· {p.role}</span></p>
                <p className="truncate text-xs text-slate-500">{p.email}</p>
                <p className="mt-1 text-sm text-slate-700">
                  {api.PLANS[p.plan].label} · <strong>{rupees(p.amount_pkr)}</strong> (${p.amount_usd}) · from <span className="font-mono">{p.sender_number}</span>
                </p>
                {p.sender_name && <p className="text-sm text-slate-700">Paid by <strong>{p.sender_name}</strong></p>}
                <p className="text-sm">TID <span className="font-mono font-semibold">{p.transaction_id}</span> <span className="text-xs text-slate-400">· {formatDateTime(p.created_at)}</span></p>
                {p.screenshot_path ? (
                  <button onClick={() => void openProof(p)} className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-brand-600 hover:underline">
                    <ImageIcon className="h-4 w-4" aria-hidden />View screenshot
                  </button>
                ) : <p className="text-xs text-amber-700">No screenshot (sent before screenshots were required)</p>}
                {p.status === 'rejected' && p.admin_note && <p className="text-xs text-rose-700">Reason: {p.admin_note}</p>}
              </div>
              {p.status === 'pending' ? (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => { setRejecting(p); setReason(''); setReasonError(null); }} disabled={!!busy}
                    icon={<XCircle className="h-4 w-4" />}>Reject</Button>
                  <Button variant="success" loading={busy === p.id} onClick={() => void review(p, true)} icon={<CheckCircle2 className="h-4 w-4" />}>Approve</Button>
                </div>
              ) : (
                <span className={cx('rounded-full px-3 py-1 text-xs font-semibold', p.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
                  {p.status === 'approved' ? 'Approved' : 'Rejected'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!proof} onClose={() => setProof(null)} title={`Payment screenshot: ${proof?.payment.full_name ?? ''}`} size="lg" footer={<>
        <a href={proof?.url} target="_blank" rel="noreferrer" className="mr-auto text-sm font-medium text-brand-600 hover:underline">Open full size</a>
        <Button variant="secondary" onClick={() => setProof(null)}>Close</Button>
      </>}>
        {proof && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Paid by <strong>{proof.payment.sender_name ?? '-'}</strong> · TID <span className="font-mono font-semibold">{proof.payment.transaction_id}</span> · {rupees(proof.payment.amount_pkr)}</p>
            <img src={proof.url} alt="Payment receipt screenshot" className="mx-auto max-h-[60vh] rounded-lg border border-slate-200 object-contain" />
          </div>
        )}
      </Modal>
      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Reject payment" footer={<>
        <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
        <Button variant="danger" loading={busy === rejecting?.id} onClick={() => rejecting && void review(rejecting, false, reason)}>Reject payment</Button>
      </>}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Tell {rejecting?.full_name} why, so they can fix it.</p>
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
            placeholder="e.g. TID not found in JazzCash, or amount was less than Rs 1,400" error={reasonError} />
        </div>
      </Modal>
    </Card>
  );
}

function UsersTab({ onChanged, role }: { onChanged: () => void; role?: 'student' | 'teacher' }) {
  const { toast } = useToast();
  const users = useAsync(() => api.adminListUsers(), []);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<api.AdminUser | null>(null);
  const { isSuperAdmin } = useAccess();
  const me = useProfile();
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users.data ?? []).filter((u) => (!role || u.role === role)
      && (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));
  }, [users.data, search, role]);

  // Passwords can never be shown; the admin can email a secure link to choose a new one.
  const sendReset = async (u: api.AdminUser) => {
    setBusy(`reset-${u.id}`);
    try {
      await api.sendPasswordResetEmail(u.email);
      toast('success', 'Reset link sent', `${u.email} will get an email to choose a new password.`);
    } catch (e) {
      toast('error', 'Could not send reset link', api.friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleFree = async (u: api.AdminUser) => {
    setBusy(u.id);
    try {
      await api.adminSetFreeAccess(u.email, !u.is_free);
      toast('success', u.is_free ? 'Free access removed' : 'Free access given', u.email);
      await users.reload(true);
      onChanged();
    } catch (e) {
      toast('error', 'Could not update access', api.friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const badge = (u: api.AdminUser) => {
    const m = {
      admin: [u.is_super_admin ? 'Super Admin' : 'Admin', u.is_super_admin ? 'bg-amber-50 text-amber-700' : 'bg-violet-50 text-violet-700'],
      free: ['Free', 'bg-emerald-50 text-emerald-700'],
      active: [`Paid until ${fmtDate(u.paid_until)}`, 'bg-emerald-50 text-emerald-700'],
      trial: [`Trial until ${fmtDate(u.trial_ends_at)}`, 'bg-brand-50 text-brand-700'],
      expired: ['Trial ended (view only)', 'bg-rose-50 text-rose-700'],
    }[u.status];
    return <span className={cx('whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', m[1])}>{m[0]}</span>;
  };

  const roleLabel = (u: api.AdminUser) => (
    <span className="inline-flex items-center gap-1 capitalize text-slate-600">
      {u.is_super_admin ? <Crown className="h-4 w-4" aria-hidden /> : u.role === 'admin' ? <ShieldCheck className="h-4 w-4" aria-hidden /> : u.role === 'teacher' ? <Presentation className="h-4 w-4" aria-hidden /> : <GraduationCap className="h-4 w-4" aria-hidden />}{u.is_super_admin ? 'super admin' : u.role}
    </span>
  );
  const lastSignIn = (u: api.AdminUser) => (u.last_sign_in_at ? relativeTime(u.last_sign_in_at) : 'Never');

  const actions = (u: api.AdminUser) => (
    <>
      {(!u.is_admin || isSuperAdmin || u.id === me.id) && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(u)}>Edit</Button>}
      <Button size="sm" variant="ghost" loading={busy === `reset-${u.id}`} icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => void sendReset(u)}
        title="Email this person a link to choose a new password">Reset link</Button>
      {!u.is_admin && (
        <Button size="sm" variant={u.is_free ? 'secondary' : 'ghost'} loading={busy === u.id} onClick={() => void toggleFree(u)}
          icon={<Gift className="h-3.5 w-3.5" />}>{u.is_free ? 'Remove free' : 'Make free'}</Button>
      )}
    </>
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="font-semibold">{role === 'student' ? 'Student accounts' : role === 'teacher' ? 'Teacher accounts' : 'All accounts'}{users.data && <span className="ml-2 text-sm font-normal text-slate-500">{visible.length}</span>}</h2>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" aria-label="Search users"
            className="w-full rounded-lg border border-slate-300 bg-surface py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </div>
      </div>
      {users.error && <div className="p-4"><ErrorBanner message={users.error} onRetry={() => void users.reload()} /></div>}
      {users.loading && !users.data ? <div className="p-4"><Skeleton className="h-32" /></div> : (
        <>
        {/* Phones: one card per account. */}
        <ul className="divide-y divide-slate-100 md:hidden">
          {visible.map((u) => (
            <li key={u.id} className="space-y-2 p-4">
              <div>
                <p className="font-medium text-slate-900 [overflow-wrap:anywhere]">{u.full_name}</p>
                <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">{u.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">{roleLabel(u)}{badge(u)}</div>
              <p className="text-xs text-slate-500">Joined {fmtDate(u.created_at)} · Last signed in {lastSignIn(u)}</p>
              <div className="-ml-2.5 flex flex-wrap gap-1">{actions(u)}</div>
            </li>
          ))}
          {!visible.length && <li className="px-4 py-8 text-center text-sm text-slate-500">No accounts match.</li>}
        </ul>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr><th className="px-4 py-2 font-semibold">User</th><th className="px-3 py-2 font-semibold">Role</th><th className="px-3 py-2 font-semibold">Access</th><th className="px-3 py-2 font-semibold">Joined</th><th className="px-3 py-2 font-semibold">Last signed in</th><th className="px-4 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3"><p className="font-medium text-slate-900">{u.full_name}</p><p className="text-xs text-slate-500">{u.email}</p></td>
                  <td className="px-3 py-3">{roleLabel(u)}</td>
                  <td className="px-3 py-3">{badge(u)}</td>
                  <td className="px-3 py-3 text-slate-500">{fmtDate(u.created_at)}</td>
                  <td className="px-3 py-3 text-slate-500" title={u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : undefined}>{lastSignIn(u)}</td>
                  <td className="px-4 py-3 text-right"><span className="inline-flex gap-1">{actions(u)}</span></td>
                </tr>
              ))}
              {!visible.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No accounts match.</td></tr>}
            </tbody>
          </table>
        </div>
        </>
      )}
      <UserEditModal user={editing} onClose={() => setEditing(null)} onSaved={() => { void users.reload(true); onChanged(); }} />
    </Card>
  );
}
