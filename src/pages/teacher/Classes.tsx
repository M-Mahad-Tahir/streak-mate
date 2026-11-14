import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Pencil, Plus, RefreshCw, School, Trash2, UserMinus, Users } from 'lucide-react';
import { useProfile } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { Button, Card, ConfirmModal, EmptyState, ErrorBanner, Input, Modal, PageHeader, Skeleton } from '../../components/ui';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatDateKey } from '../../lib/dates';
import type { TeacherClass } from '../../lib/types';

type Confirm =
  | { kind: 'remove'; classId: string; studentId: string; name: string }
  | { kind: 'delete'; cls: TeacherClass }
  | { kind: 'regen'; cls: TeacherClass };

export default function TeacherClasses() {
  const profile = useProfile();
  const { toast } = useToast();
  const { data, error, loading, reload } = useAsync(() => api.listTeacherClasses(profile.id), [profile.id]);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<TeacherClass | null>(null);
  const [newName, setNewName] = useState('');

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setNameError('Give your class a name.'); return; }
    if (n.length > 80) { setNameError('Class names are limited to 80 characters.'); return; }
    setCreating(true);
    setNameError(null);
    try {
      const cls = await api.createClass(n);
      toast('success', `Created ${cls.name}`, `Share code ${cls.code} with your students.`);
      setName('');
      await reload(true);
    } catch (err) {
      setNameError(api.friendlyError(err));
    } finally {
      setCreating(false);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast('success', 'Code copied', code);
    } catch {
      toast('info', 'Class code', code);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'remove') {
        await api.removeStudent(confirm.classId, confirm.studentId);
        toast('success', `${confirm.name} removed`);
      } else if (confirm.kind === 'delete') {
        await api.deleteClass(confirm.cls.id);
        toast('success', `${confirm.cls.name} deleted`);
      } else {
        const code = await api.regenerateClassCode(confirm.cls.id);
        toast('success', 'New code generated', code);
      }
      setConfirm(null);
      await reload(true);
    } catch (e) {
      toast('error', 'Action failed', api.friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const onRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming || !newName.trim()) return;
    setBusy(true);
    try {
      await api.renameClass(renaming.id, newName.trim());
      toast('success', 'Class renamed');
      setRenaming(null);
      await reload(true);
    } catch (err) {
      toast('error', 'Could not rename', api.friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmText = confirm && {
    remove: { title: `Remove ${confirm.kind === 'remove' ? confirm.name : ''}?`, body: 'They will no longer be able to submit work to this class, and any pending submissions will be withdrawn. They can rejoin with the class code.', label: 'Remove student' },
    delete: { title: `Delete ${confirm.kind !== 'remove' ? confirm.cls.name : ''}?`, body: 'This removes the class, all memberships and its submission history. Students keep their tasks. This cannot be undone.', label: 'Delete class' },
    regen: { title: 'Generate a new class code?', body: 'The old code will stop working immediately. Students already in the class are not affected.', label: 'Generate new code' },
  }[confirm.kind];

  return (
    <div className="space-y-6">
      <PageHeader title="Classes & Students" subtitle="Create classes, share codes and manage who you verify." />
      <Card className="p-6">
        <form onSubmit={onCreate} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
          <div className="flex-1"><Input label="New class name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} maxLength={80} placeholder="e.g. Grade 8 Science" /></div>
          <Button type="submit" loading={creating} icon={<Plus className="h-4 w-4" />} className="sm:mt-7">Create class</Button>
        </form>
      </Card>

      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {loading && !data ? <Skeleton className="h-48" /> : !data?.length ? (
        <EmptyState icon={<School className="h-6 w-6" />} title="No classes yet" body="Create a class above to get a code your students can use to join." />
      ) : data.map((cls) => (
        <Card key={cls.id} className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-5 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">{cls.name}</h2>
              <p className="text-sm text-slate-500">{cls.class_members.length} student{cls.class_members.length === 1 ? '' : 's'} · Created {formatDateKey(cls.created_at.slice(0, 10))}</p>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-brand-50 px-4 py-2">
              <span className="text-xs font-medium text-brand-700">Code</span>
              <span className="font-mono text-lg font-bold tracking-widest text-brand-800">{cls.code}</span>
              <button onClick={() => void copy(cls.code)} className="tap-target rounded p-1 text-brand-600 hover:bg-brand-100" aria-label={`Copy code ${cls.code}`}><Copy className="h-4 w-4" /></button>
              <button onClick={() => setConfirm({ kind: 'regen', cls })} className="tap-target rounded p-1 text-brand-600 hover:bg-brand-100" aria-label="Generate a new code"><RefreshCw className="h-4 w-4" /></button>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setRenaming(cls); setNewName(cls.name); }}>Rename</Button>
              <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirm({ kind: 'delete', cls })}>Delete</Button>
            </div>
          </div>
          {cls.class_members.length === 0 ? (
            <p className="flex items-center gap-2 p-5 text-sm text-slate-500"><Users className="h-4 w-4" aria-hidden />No students yet. Share the code <strong className="font-mono">{cls.code}</strong> to invite them.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {cls.class_members.map((m) => (
                <li key={m.student_id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-600" aria-hidden>{(m.student?.full_name ?? '?').slice(0, 1).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <Link to={`/teacher/students/${m.student_id}`} className="font-medium text-slate-900 hover:text-brand-600">{m.student?.full_name ?? 'Student'}</Link>
                    <p className="truncate text-xs text-slate-500">{m.student?.email} · joined {formatDateKey(m.joined_at.slice(0, 10))}</p>
                  </div>
                  <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" icon={<UserMinus className="h-3.5 w-3.5" />}
                    onClick={() => setConfirm({ kind: 'remove', classId: cls.id, studentId: m.student_id, name: m.student?.full_name ?? 'student' })}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      <ConfirmModal open={!!confirm} onClose={() => setConfirm(null)} onConfirm={runConfirm} loading={busy}
        danger={confirm?.kind !== 'regen'} title={confirmText?.title ?? ''} body={confirmText?.body ?? ''} confirmLabel={confirmText?.label} />
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="Rename class" footer={<>
        <Button variant="secondary" onClick={() => setRenaming(null)}>Cancel</Button>
        <Button type="submit" form="rename-form" loading={busy}>Save</Button>
      </>}>
        <form id="rename-form" onSubmit={onRename}><Input label="Class name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} required /></form>
      </Modal>
    </div>
  );
}
