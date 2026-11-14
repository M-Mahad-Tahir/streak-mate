import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Crown, Pencil, Plus, School, Search, ShieldCheck, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { useAccess } from '../context/AccessContext';
import { useProfile } from '../context/AuthContext';
import { relativeTime } from '../lib/dates';
import { useToast } from '../context/ToastContext';
import {
  Button, Card, ConfirmModal, EmptyState, ErrorBanner, Input, Modal, Select, Skeleton, StatusBadge, Textarea,
} from '../components/ui';
import * as api from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { formatDateKey, formatTime } from '../lib/dates';
import type { Role, TaskStatus } from '../lib/types';

const toDateInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const endOfDayIso = (date: string) => new Date(`${date}T23:59:59`).toISOString();

// ---------------- Edit any user ----------------
export function UserEditModal({ user, onClose, onSaved }: { user: api.AdminUser | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('student');
  const [trial, setTrial] = useState('');
  const [paid, setPaid] = useState('');
  const [plan, setPlan] = useState<'monthly' | 'yearly'>('monthly');
  const [free, setFree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { isSuperAdmin } = useAccess();
  const me = useProfile();

  useEffect(() => {
    if (!user) return;
    setName(user.full_name); setRole(user.role); setTrial(toDateInput(user.trial_ends_at)); setPaid(toDateInput(user.paid_until));
    setPlan(user.plan === 'yearly' ? 'yearly' : 'monthly'); setFree(user.is_free); setError(null);
  }, [user]);

  if (!user) return null;
  // Admin accounts (admin or super admin) only have a name to change; they never pay.
  const adminAccount = user.is_admin || user.role === 'admin';
  const canDelete = !user.is_super_admin && user.id !== me.id && (!adminAccount || isSuperAdmin);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!adminAccount && !trial) { setError('Choose the trial end date.'); return; }
    setSaving(true);
    setError(null);
    try {
      if (name.trim() !== user.full_name || role !== user.role) await api.adminUpdateUser(user.id, name.trim(), role);
      if (!adminAccount) {
        await api.adminSetSubscription(user.id, endOfDayIso(trial), paid ? endOfDayIso(paid) : null, paid ? plan : null);
        if (free !== user.is_free) await api.adminSetFreeAccess(user.email, free);
      }
      toast('success', 'Account updated', user.email);
      onSaved();
      onClose();
    } catch (err) {
      setError(api.friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api.adminDeleteUser(user.id);
      toast('success', 'Account deleted', user.email);
      setConfirmDelete(false);
      onSaved();
      onClose();
    } catch (err) {
      setError(api.friendlyError(err));
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal open onClose={onClose} title="Edit account" size="lg" footer={<>
        {canDelete && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDelete(true)} disabled={saving}>Delete account</Button>}
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="submit" form="admin-user-form" loading={saving}>Save changes</Button>
      </>}>
        <form id="admin-user-form" onSubmit={save} className="space-y-4" noValidate>
          {error && <ErrorBanner message={error} />}
          <p className="text-sm text-slate-500">{user.email}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
            {adminAccount ? (
              <Input label="Role" value={user.is_super_admin ? 'Super Admin (no student or teacher role)' : 'Admin (no student or teacher role)'} disabled />
            ) : (
              <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="student">Student</option>
                <option value="teacher">Teacher</option>
              </Select>
            )}
          </div>
          {!adminAccount && <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Free trial ends" type="date" value={trial} onChange={(e) => setTrial(e.target.value)} required />
            <Input label="Paid until (optional)" type="date" value={paid} onChange={(e) => setPaid(e.target.value)} hint="Leave empty for no paid plan." />
            <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value as 'monthly' | 'yearly')} disabled={!paid}>
              <option value="monthly">Monthly ($5)</option>
              <option value="yearly">Yearly ($50)</option>
            </Select>
          </div>}
          {!adminAccount && (
            <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm">
              <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} className="h-4 w-4 accent-brand-600" />
              <span><span className="font-medium text-slate-900">Free access</span> <span className="text-slate-500">(never pays)</span></span>
            </label>
          )}
          <p className="text-xs text-slate-500">{adminAccount
            ? 'Admin accounts never pay and have no student or teacher role. Only the super admin can add or remove admins (Admins tab).'
            : 'Changing a student to teacher removes them from their classes. A teacher who still has classes cannot become a student.'}</p>
        </form>
      </Modal>
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} danger loading={saving}
        confirmLabel="Delete account" title={`Delete ${user.full_name}?`}
        body="The account and ALL its tasks, classes, reviews and payments are deleted permanently. This cannot be undone." />
    </>
  );
}

// ---------------- All tasks ----------------
const STATUSES: TaskStatus[] = ['pending', 'completed', 'submitted', 'verified', 'rejected'];

export function TasksTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const list = useAsync(() => api.adminListTasks(query), [query]);
  const [editing, setEditing] = useState<api.AdminTask | null>(null);
  const [deleting, setDeleting] = useState<api.AdminTask | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { const t = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(t); }, [search]);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.adminDeleteTask(deleting.id);
      toast('success', 'Task deleted', deleting.title);
      setDeleting(null);
      await list.reload(true);
    } catch (e) {
      toast('error', 'Could not delete task', api.friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="font-semibold">All tasks</h2>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search task, student or email" aria-label="Search tasks"
            className="w-full rounded-lg border border-slate-300 bg-surface py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </div>
      </div>
      {list.error && <div className="p-4"><ErrorBanner message={list.error} onRetry={() => void list.reload()} /></div>}
      {list.loading && !list.data ? <div className="p-4"><Skeleton className="h-32" /></div> : !list.data?.length ? (
        <div className="p-6"><EmptyState title="No tasks found" body="Tasks from every student appear here." /></div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.data.map((t) => (
            <li key={t.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-slate-900">{t.title}</p>
                  <StatusBadge status={t.status} />
                  {t.archived_at && <span className="text-xs text-slate-400">Removed by student</span>}
                </div>
                <p className="text-xs text-slate-500">{t.student_name} · {t.student_email}{t.class_name ? ` · ${t.class_name}` : ''} · Due {formatDateKey(t.due_date)} {formatTime(t.due_time)}</p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(t)}>Edit</Button>
                <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDeleting(t)}>Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <TaskEditModal task={editing} onClose={() => setEditing(null)} onSaved={() => void list.reload(true)} />
      <ConfirmModal open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => void remove()} danger loading={busy}
        confirmLabel="Delete task" title={`Delete "${deleting?.title ?? ''}"?`}
        body="The task, its submissions and its reviews are deleted permanently. The student's streak is recalculated." />
    </Card>
  );
}

function TaskEditModal({ task, onClose, onSaved }: { task: api.AdminTask | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [v, setV] = useState({ title: '', description: '', due_date: '', due_time: '', status: 'pending' as TaskStatus });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (task) setV({ title: task.title, description: task.description, due_date: task.due_date, due_time: task.due_time.slice(0, 5), status: task.status });
    setError(null);
  }, [task]);
  if (!task) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!v.title.trim()) { setError('Title is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      await api.adminUpdateTask(task.id, { ...v, title: v.title.trim() });
      toast('success', 'Task updated', v.title);
      onSaved();
      onClose();
    } catch (err) {
      setError(api.friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit task of ${task.student_name}`} footer={<>
      <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button type="submit" form="admin-task-form" loading={saving}>Save changes</Button>
    </>}>
      <form id="admin-task-form" onSubmit={save} className="space-y-4" noValidate>
        {error && <ErrorBanner message={error} />}
        <Input label="Title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={150} required />
        <Textarea label="Description" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={5000} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Due date" type="date" value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value })} required />
          <Input label="Due time" type="time" value={v.due_time} onChange={(e) => setV({ ...v, due_time: e.target.value })} required />
        </div>
        <Select label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as TaskStatus })}
          hint="Completed and Verified count for the student's streak. Only the student can submit a task.">
          {STATUSES.filter((s) => s !== 'submitted' || task.status === 'submitted').map((s) => (
            <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </Select>
      </form>
    </Modal>
  );
}

// ---------------- All classes ----------------
export function ClassesTab() {
  const { toast } = useToast();
  const list = useAsync(() => api.adminListClasses(), []);
  const [editing, setEditing] = useState<api.AdminClass | null>(null);
  const [deleting, setDeleting] = useState<api.AdminClass | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useMemo(() => (editing ? list.data?.find((c) => c.id === editing.id) ?? editing : null), [editing, list.data]);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.adminDeleteClass(deleting.id);
      toast('success', 'Class deleted', deleting.name);
      setDeleting(null);
      await list.reload(true);
    } catch (e) {
      toast('error', 'Could not delete class', api.friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 p-4"><h2 className="font-semibold">All classes</h2></div>
      {list.error && <div className="p-4"><ErrorBanner message={list.error} onRetry={() => void list.reload()} /></div>}
      {list.loading && !list.data ? <div className="p-4"><Skeleton className="h-32" /></div> : !list.data?.length ? (
        <div className="p-6"><EmptyState icon={<School className="h-6 w-6" />} title="No classes yet" body="Classes created by teachers appear here." /></div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.data.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">{c.name} <span className="font-mono text-xs text-slate-400">{c.code}</span></p>
                <p className="text-xs text-slate-500">Teacher: {c.teacher_name} ({c.teacher_email}) · {c.members.length} student{c.members.length === 1 ? '' : 's'}</p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(c)}>Edit</Button>
                <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDeleting(c)}>Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {current && <ClassEditModal cls={current} onClose={() => setEditing(null)} onChanged={() => void list.reload(true)} />}
      <ConfirmModal open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => void remove()} danger loading={busy}
        confirmLabel="Delete class" title={`Delete ${deleting?.name ?? 'class'}?`}
        body="The class, its memberships and its review history are deleted. Students keep their tasks." />
    </Card>
  );
}

function ClassEditModal({ cls, onClose, onChanged }: { cls: api.AdminClass; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(cls.name);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    setError(null);
    try { await fn(); toast('success', ok); onChanged(); } catch (e) { setError(api.friendlyError(e)); } finally { setBusy(null); }
  };

  return (
    <Modal open onClose={onClose} title="Edit class" size="lg" footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        {error && <ErrorBanner message={error} />}
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run('name', () => api.adminUpdateClass(cls.id, name.trim()), 'Class renamed'); }}>
          <div className="flex-1"><Input label="Class name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></div>
          <Button type="submit" loading={busy === 'name'}>Save name</Button>
        </form>
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Students ({cls.members.length})</p>
          {cls.members.length === 0 ? <p className="text-sm text-slate-500">No students in this class.</p> : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {cls.members.map((m) => (
                <li key={m.student_id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium">{m.full_name}</p><p className="truncate text-xs text-slate-500">{m.email}</p></div>
                  <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" loading={busy === m.student_id} icon={<UserMinus className="h-3.5 w-3.5" />}
                    onClick={() => void run(m.student_id, () => api.adminRemoveMember(cls.id, m.student_id), `${m.full_name} removed`)}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run('add', async () => { await api.adminAddMember(cls.id, email.trim()); setEmail(''); }, 'Student added'); }}>
          <div className="flex-1"><Input label="Add a student by email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="student@school.edu" /></div>
          <Button type="submit" loading={busy === 'add'} icon={<Plus className="h-4 w-4" />}>Add</Button>
        </form>
      </div>
    </Modal>
  );
}

// ---------------- Super admin: manage admins ----------------
export function AdminsTab() {
  const { toast } = useToast();
  const list = useAsync(() => api.superListAdmins(), []);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<api.AdminAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const v = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { setError('Enter a valid email address.'); return; }
    setAdding(true);
    setError(null);
    try {
      await api.superAddAdmin(v);
      toast('success', 'Admin added', `${v} was signed out. They choose a new password with "Forgot password", then manage the website.`);
      setEmail('');
      await list.reload(true);
    } catch (err) {
      setError(api.friendlyError(err));
    } finally {
      setAdding(false);
    }
  };

  // An admin email waiting for its account: link it once they have signed up and confirmed.
  const activate = async (a: api.AdminAccount) => {
    setActivating(a.email);
    try {
      await api.superAddAdmin(a.email);
      toast('success', 'Admin activated', `${a.email} was signed out. They choose a new password with "Forgot password", then manage the website.`);
      await list.reload(true);
    } catch (err) {
      toast('error', 'Could not activate admin', api.friendlyError(err));
    } finally {
      setActivating(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.superRemoveAdmin(removing.email);
      toast('success', 'Admin removed', `${removing.email} is no longer an admin.`);
      setRemoving(null);
      await list.reload(true);
    } catch (err) {
      toast('error', 'Could not remove admin', api.friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 p-4">
        <h2 className="font-semibold">Admins</h2>
        <p className="text-sm text-slate-500">Only you, the super admin, can see this tab, add admins or remove them.</p>
      </div>
      {list.error && <div className="p-4"><ErrorBanner message={list.error} onRetry={() => void list.reload()} /></div>}
      {list.loading && !list.data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
        <ul className="divide-y divide-slate-100">
          {(list.data ?? []).map((a) => (
            <li key={a.email} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                  {a.full_name ?? a.email}
                  <span className={a.level === 'super_admin'
                    ? 'inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700'
                    : 'inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700'}>
                    {a.level === 'super_admin' ? <Crown className="h-3.5 w-3.5" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
                    {a.level === 'super_admin' ? 'Super Admin' : 'Admin'}
                  </span>
                </p>
                <p className="text-xs text-slate-500">
                  {a.email} · {adminStatus(a)}
                </p>
              </div>
              {a.active === false && a.has_account && a.email_confirmed && a.level !== 'super_admin' && (
                <Button size="sm" loading={activating === a.email} icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => void activate(a)}>Activate</Button>
              )}
              {a.level !== 'super_admin' && (
                <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" icon={<UserMinus className="h-3.5 w-3.5" />} onClick={() => setRemoving(a)}>Remove admin</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-col gap-2 border-t border-slate-100 p-4 sm:flex-row sm:items-end" noValidate>
        <div className="flex-1">
          <Input label="Add an admin by email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }}
            placeholder="name@gmail.com" error={error} hint="They must sign up and confirm their email first. They become Admin (no student or teacher role), are signed out, and choose a new password with Forgot password." />
        </div>
        <Button type="submit" loading={adding} icon={<UserPlus className="h-4 w-4" />} className="sm:mb-6">Add admin</Button>
      </form>
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()} danger loading={busy}
        confirmLabel="Remove admin" title={`Remove ${removing?.email ?? ''} as admin?`}
        body="They lose access to the Admin page right away. Their account stays and becomes a normal student account (a teacher if they still own classes), which you can change in Users." />
    </Card>
  );
}

function adminStatus(a: api.AdminAccount) {
  if (a.active === false) {
    if (!a.has_account) return 'Not active yet: has not signed up';
    if (!a.email_confirmed) return 'Not active yet: email not confirmed';
    return a.level === 'super_admin'
      ? 'Not active yet: run the update query in Supabase again'
      : 'Signed up. Press Activate: they are signed out and set a new password with Forgot password';
  }
  if (!a.user_id) return 'Has not signed up yet';
  if (!a.email_confirmed) return 'Email not confirmed yet (admin powers start after confirming)';
  return a.last_sign_in_at ? `Last signed in ${relativeTime(a.last_sign_in_at)}` : 'Never signed in';
}
