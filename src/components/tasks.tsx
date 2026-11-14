import { useEffect, useState, type FormEvent } from 'react';
import { AlarmClock, CalendarDays, CheckCircle2, Pencil, RotateCcw, Rocket, Send, Trash2, MessageSquareWarning, School } from 'lucide-react';
import { useCelebrate } from './Celebration';
import { useDbUpdated } from '../lib/dbFeatures';
import { useAccess } from '../context/AccessContext';
import { Button, ConfirmModal, Input, Modal, Select, StatusBadge, Textarea, cx } from './ui';
import * as api from '../lib/api';
import { formatDateKey, formatTime, relativeTime, todayIn } from '../lib/dates';
import { validateTask } from '../lib/validation';
import type { StudentClass, Task, Verification } from '../lib/types';
import { useToast } from '../context/ToastContext';

// ---------------- Create / edit ----------------
interface TaskFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (task: Task) => void;
  task?: Task | null;
  classes: StudentClass[];
  timezone: string;
}

export function TaskFormModal({ open, onClose, onSaved, task, classes, timezone }: TaskFormModalProps) {
  const { toast } = useToast();
  const [values, setValues] = useState({ title: '', description: '', due_date: '', due_time: '23:59', class_id: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError(null);
    setValues(task
      ? { title: task.title, description: task.description, due_date: task.due_date, due_time: task.due_time.slice(0, 5), class_id: task.class_id ?? '' }
      : { title: '', description: '', due_date: todayIn(timezone), due_time: '23:59', class_id: classes.length === 1 && classes[0].class ? classes[0].class.id : '' });
  }, [open, task, timezone, classes]);

  const locked = !!task && (task.status === 'submitted' || task.status === 'verified');
  const lockedClassName = locked && task?.class_id
    ? classes.find((c) => c.class?.id === task.class_id)?.class?.name ?? "Your teacher's class"
    : null;

  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateTask(values);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setFormError(null);
    try {
      const input = { title: values.title.trim(), description: values.description.trim(), due_date: values.due_date, due_time: values.due_time, class_id: values.class_id || null };
      // After submission everything except the class can change (the class stays with the teacher who has the work).
      const saved = task
        ? await api.updateTask(task.id, locked
          ? { title: input.title, description: input.description, due_date: input.due_date, due_time: input.due_time }
          : input)
        : await api.createTask(input);
      toast('success', task ? 'Task updated' : 'Task added', saved.title);
      onSaved(saved);
      onClose();
    } catch (err) {
      setFormError(api.friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={task ? 'Edit task' : 'New task'} footer={<>
      <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button type="submit" form="task-form" loading={saving}>{task ? 'Save changes' : 'Add task'}</Button>
    </>}>
      <form id="task-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700" role="alert">{formError}</p>}
        <Input label="Title" value={values.title} onChange={set('title')} error={errors.title} maxLength={150} placeholder="e.g. Chapter 4 math exercises" required />
        <Textarea label="Description" value={values.description} onChange={set('description')} error={errors.description} maxLength={5000} placeholder="What needs to be done?" />
        {locked && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            This task is {task?.status === 'verified' ? 'verified' : 'waiting for review'}. You can change the title, description,
            date and time. The class stays the same so your teacher keeps your work. Changing the date updates your streak.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Due date" type="date" value={values.due_date} onChange={set('due_date')} error={errors.due_date} required />
          <Input label="Due time" type="time" value={values.due_time} onChange={set('due_time')} error={errors.due_time} required />
        </div>
        {locked ? (
          <Input label="Class (teacher)" value={lockedClassName ?? 'Personal task (not linked)'} disabled />
        ) : (
        <Select label="Class (teacher)" value={values.class_id} onChange={set('class_id')}
          hint={classes.length ? 'Linking a class lets that teacher see and verify this task.' : 'Join a class to submit work for verification.'}>
          <option value="">Personal task (not linked)</option>
          {classes.filter((c) => c.class).map((c) => (
            <option key={c.class!.id} value={c.class!.id}>{c.class!.name}{c.class!.teacher ? ` · ${c.class!.teacher.full_name}` : ''}</option>
          ))}
        </Select>
        )}
        <p className="text-xs text-slate-400">Times use your timezone: {timezone}</p>
      </form>
    </Modal>
  );
}

// ---------------- Submit for verification ----------------
export function SubmitModal({ open, onClose, task, classes, onSubmitted }: {
  open: boolean; onClose: () => void; task: Task | null; classes: StudentClass[]; onSubmitted: () => void;
}) {
  const { toast } = useToast();
  const [classId, setClassId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !task) return;
    setNote('');
    setError(null);
    setClassId(task.class_id ?? (classes.length === 1 && classes[0].class ? classes[0].class.id : ''));
  }, [open, task, classes]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!task) return;
    if (!classId) { setError('Choose which class (teacher) should verify this task.'); return; }
    setSaving(true);
    setError(null);
    try {
      await api.submitTask(task.id, classId, note.trim());
      toast('success', 'Submitted for verification', 'Your teacher has been notified.');
      onSubmitted();
      onClose();
    } catch (err) {
      setError(api.friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Submit for verification" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button type="submit" form="submit-form" loading={saving} icon={<Send className="h-4 w-4" />} disabled={!classes.length}>Submit</Button>
    </>}>
      <form id="submit-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {task && <p className="text-sm text-slate-600">Send <strong>{task.title}</strong> to your teacher for review.</p>}
        {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p>}
        {classes.length === 0 ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">You are not in any class yet. Join one with your teacher's class code first.</p>
        ) : (
          <Select label="Teacher / class" value={classId} onChange={(e) => setClassId(e.target.value)} required>
            <option value="">Select a class</option>
            {classes.filter((c) => c.class).map((c) => (
              <option key={c.class!.id} value={c.class!.id}>{c.class!.name}{c.class!.teacher ? ` · ${c.class!.teacher.full_name}` : ''}</option>
            ))}
          </Select>
        )}
        <Textarea label="Note for your teacher" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
          placeholder="Describe what you did, or paste a link to your work (optional)." hint={`${note.length}/2000`} />
      </form>
    </Modal>
  );
}

// ---------------- Task card ----------------
interface TaskCardProps {
  task: Task;
  timezone: string;
  className?: string;
  feedback?: Verification | null;
  onChanged: () => void;
  onEdit: (t: Task) => void;
  onSubmit: (t: Task) => void;
  classLabel?: string;
  compact?: boolean;
}

export function TaskCard({ task, timezone, feedback, onChanged, onEdit, onSubmit, classLabel, compact }: TaskCardProps) {
  const { toast } = useToast();
  const celebrate = useCelebrate();
  // Before RUN_THIS_UPDATE.sql the database only allows deleting pending tasks and editing
  // tasks that were not submitted yet, so Edit/Delete are only shown where they work.
  const dbUpdated = useDbUpdated();
  // After the free trial without a subscription the account is view-only.
  const { readOnly } = useAccess();
  const canDelete = !readOnly && (dbUpdated || task.status === 'pending');
  const canEdit = !readOnly && (dbUpdated || task.status === 'pending' || task.status === 'completed' || task.status === 'rejected');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const today = todayIn(timezone);
  const open = task.status === 'pending' || task.status === 'rejected';
  const overdue = open && new Date(task.due_at).getTime() < Date.now();
  const dueSoon = open && !overdue && new Date(task.due_at).getTime() - Date.now() < 24 * 3600 * 1000;

  // Completing work launches the rocket and shows the updated streak.
  const complete = async () => {
    setBusy('complete');
    try {
      await api.setTaskCompleted(task.id, true);
      const streak = await api.getMyStreak().catch(() => null);
      celebrate({ kind: 'completed', streak: streak?.current_streak ?? 0, title: task.title });
      onChanged();
    } catch (e) {
      toast('error', 'Action failed', api.friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('delete');
    try {
      const result = await api.deleteTask(task.id);
      toast('success', 'Task deleted', result === 'archived' ? "Your streak and your teacher's records are kept." : undefined);
      setConfirmDelete(false);
      onChanged();
    } catch (e) {
      toast('error', 'Could not delete task', api.friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const deleteBody = task.status === 'submitted'
    ? `"${task.title}" will be withdrawn from your teacher's review and removed from your list.`
    : task.status === 'pending' && !task.completed_at
      ? `"${task.title}" will be permanently removed.`
      : `"${task.title}" will be removed from your list. Your streak and your teacher's records are kept.`;

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast('success', success);
      onChanged();
    } catch (e) {
      toast('error', 'Action failed', api.friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cx('group rounded-xl border bg-surface p-4 transition hover:shadow-card',
      overdue ? 'border-rose-200' : task.status === 'verified' ? 'border-emerald-200' : 'border-slate-200')}>
      <div className="flex items-start gap-3">
        <button
          onClick={() => open
            ? void complete()
            : task.status === 'completed' && act('reopen', () => api.setTaskCompleted(task.id, false), 'Task reopened')}
          disabled={readOnly || !!busy || !(open || task.status === 'completed')}
          className={cx('tap-target mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition sm:h-6 sm:w-6',
            open ? 'border-slate-300 hover:border-emerald-500 hover:bg-emerald-50'
              : task.status === 'verified' ? 'border-flame-500 bg-gradient-to-br from-flame-400 to-flame-600 text-white'
              : 'border-emerald-500 bg-emerald-500 text-white',
            !(open || task.status === 'completed') && 'cursor-default')}
          aria-label={open ? `Mark "${task.title}" as completed` : task.status === 'completed' ? `Reopen "${task.title}"` : task.status === 'verified' ? 'Verified' : 'Completed'}>
          {task.status === 'verified' ? <Rocket className="h-3.5 w-3.5" aria-hidden /> : !open && <CheckCircle2 className="h-4 w-4" aria-hidden />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cx('break-words font-semibold [overflow-wrap:anywhere]', open ? 'text-slate-900' : 'text-slate-600')}>{task.title}</h3>
            <StatusBadge status={task.status} />
            {overdue && <span className="text-xs font-semibold text-rose-600">Overdue</span>}
            {dueSoon && <span className="text-xs font-semibold text-amber-600">Due soon</span>}
            {compact && (canEdit || canDelete) && (
              <span className="ml-auto flex gap-0.5">
                {canEdit && (
                  <button onClick={() => onEdit(task)} aria-label={`Edit "${task.title}"`} title="Edit"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
                {canDelete && (
                  <button onClick={() => setConfirmDelete(true)} aria-label={`Delete "${task.title}"`} title="Delete"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </span>
            )}
          </div>
          {!compact && task.description && <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{task.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" aria-hidden />
              {task.due_date === today ? 'Today' : formatDateKey(task.due_date)} at {formatTime(task.due_time)}</span>
            {open && <span className="inline-flex items-center gap-1"><AlarmClock className="h-3.5 w-3.5" aria-hidden />{relativeTime(task.due_at)}</span>}
            {classLabel && <span className="inline-flex items-center gap-1"><School className="h-3.5 w-3.5" aria-hidden />{classLabel}</span>}
          </div>
          {task.status === 'rejected' && feedback && (
            <div className="mt-3 flex gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
              <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div><p className="font-semibold">Teacher feedback</p><p className="whitespace-pre-line">{feedback.feedback}</p></div>
            </div>
          )}
          {task.status === 'verified' && feedback?.feedback && (
            <p className="mt-2 text-sm text-emerald-700">"{feedback.feedback}"</p>
          )}
          {!compact && !readOnly && (
            <div className="mt-3 flex flex-wrap gap-2">
              {open && <Button size="sm" variant="success" loading={busy === 'complete'} icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                onClick={() => void complete()}>Mark complete</Button>}
              {task.status === 'completed' && <>
                <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} onClick={() => onSubmit(task)}>Submit to teacher</Button>
                <Button size="sm" variant="ghost" loading={busy === 'reopen'} icon={<RotateCcw className="h-3.5 w-3.5" />}
                  onClick={() => act('reopen', () => api.setTaskCompleted(task.id, false), 'Task reopened')}>Reopen</Button>
              </>}
              {canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => onEdit(task)}>Edit</Button>}
              {canDelete && <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDelete(true)}>Delete</Button>}
              {task.status === 'submitted' && <span className="text-xs text-amber-700">Waiting for your teacher to verify.</span>}
            </div>
          )}
        </div>
      </div>
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} danger confirmLabel="Delete task"
        title="Delete this task?" body={deleteBody}
        loading={busy === 'delete'}
        onConfirm={() => void remove()} />
    </div>
  );
}
