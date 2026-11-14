import { useMemo, useState } from 'react';
import { ListTodo, Plus, Search } from 'lucide-react';
import { useProfile } from '../../context/AuthContext';
import { useAccess } from '../../context/AccessContext';
import { Button, EmptyState, ErrorBanner, PageHeader, Skeleton, cx } from '../../components/ui';
import { SubmitModal, TaskCard, TaskFormModal } from '../../components/tasks';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { todayIn } from '../../lib/dates';
import type { Task, TaskStatus, Verification } from '../../lib/types';

type Filter = 'all' | 'today' | TaskStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'today', label: 'Due today' }, { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed' }, { value: 'submitted', label: 'Submitted' },
  { value: 'verified', label: 'Verified' }, { value: 'rejected', label: 'Rejected' },
];

export default function StudentTasks() {
  const profile = useProfile();
  const { readOnly } = useAccess();
  const today = todayIn(profile.timezone);
  const { data, error, loading, reload } = useAsync(async () => {
    const [tasks, classes, reviewed] = await Promise.all([api.listMyTasks(), api.listStudentClasses(), api.listSubmissions({ status: 'reviewed' })]);
    // Latest teacher feedback per task (reviewed list is newest first).
    const feedback = new Map<string, Verification>();
    for (const s of reviewed) if (s.verification && !feedback.has(s.task_id)) feedback.set(s.task_id, s.verification);
    return { tasks, classes, feedback };
  }, []);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [submitting, setSubmitting] = useState<Task | null>(null);

  const classNames = useMemo(() => new Map((data?.classes ?? []).filter((c) => c.class).map((c) => [c.class!.id, c.class!.name])), [data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.tasks.length ?? 0, today: 0 };
    for (const t of data?.tasks ?? []) { c[t.status] = (c[t.status] ?? 0) + 1; if (t.due_date === today) c.today++; }
    return c;
  }, [data, today]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (data?.tasks ?? []).filter((t) =>
      (filter === 'all' || (filter === 'today' ? t.due_date === today : t.status === filter)) &&
      (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)));
    // Open work first (by due date), finished work after (newest first).
    const isOpen = (t: Task) => t.status === 'pending' || t.status === 'rejected' || t.status === 'completed';
    return [...list.filter(isOpen), ...list.filter((t) => !isOpen(t)).reverse()];
  }, [data, filter, search, today]);

  return (
    <div>
      <PageHeader title="My Tasks" subtitle="Plan your work, complete it, and submit it for verification."
        actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }} disabled={readOnly} title={readOnly ? 'Free trial ended: subscribe to add tasks' : undefined}>New task</Button>} />

      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filter tasks">
          {FILTERS.map((f) => (
            <button key={f.value} role="tab" aria-selected={filter === f.value} onClick={() => setFilter(f.value)}
              className={cx('whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition',
                filter === f.value ? 'bg-brand-gradient text-white' : 'bg-surface text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')}>
              {f.label} <span className={cx('ml-1 text-xs', filter === f.value ? 'text-white/80' : 'text-slate-400')}>{counts[f.value] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="relative lg:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" aria-label="Search tasks"
            className="w-full rounded-lg border border-slate-300 bg-surface py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </div>
      </div>

      {error && <div className="mb-4"><ErrorBanner message={error} onRetry={() => void reload()} /></div>}
      {loading && !data ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : visible.length === 0 ? (
        <EmptyState icon={<ListTodo className="h-6 w-6" />}
          title={data?.tasks.length ? 'No tasks match this filter' : 'No tasks yet'}
          body={data?.tasks.length ? 'Try another filter or search term.' : 'Add your first task to start building your streak.'}
          action={!data?.tasks.length && <Button onClick={() => { setEditing(null); setFormOpen(true); }} icon={<Plus className="h-4 w-4" />} disabled={readOnly}>Add a task</Button>} />
      ) : (
        <div className="space-y-3">
          {visible.map((t) => (
            <TaskCard key={t.id} task={t} timezone={profile.timezone} feedback={data?.feedback.get(t.id)}
              classLabel={t.class_id ? classNames.get(t.class_id) : undefined}
              onChanged={() => void reload(true)}
              onEdit={(task) => { setEditing(task); setFormOpen(true); }}
              onSubmit={(task) => setSubmitting(task)} />
          ))}
        </div>
      )}

      <TaskFormModal open={formOpen} onClose={() => setFormOpen(false)} task={editing} classes={data?.classes ?? []}
        timezone={profile.timezone} onSaved={() => void reload(true)} />
      <SubmitModal open={!!submitting} onClose={() => setSubmitting(null)} task={submitting} classes={data?.classes ?? []} onSubmitted={() => void reload(true)} />
    </div>
  );
}
