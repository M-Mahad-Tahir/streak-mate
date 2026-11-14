import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, Flame, ListTodo, Plus, School, Send, ShieldCheck, Trophy } from 'lucide-react';
import { useProfile } from '../../context/AuthContext';
import { useAccess } from '../../context/AccessContext';
import { Button, Card, EmptyState, ErrorBanner, PageHeader, ProgressBar, Skeleton, StatCard } from '../../components/ui';
import { SubmitModal, TaskCard, TaskFormModal } from '../../components/tasks';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { todayIn } from '../../lib/dates';
import { encouragement, nextBadge } from '../../lib/streak';
import type { Task } from '../../lib/types';

export default function StudentDashboard() {
  const profile = useProfile();
  const { readOnly } = useAccess();
  const today = todayIn(profile.timezone);
  const { data, error, loading, reload } = useAsync(async () => {
    const [tasks, streak, classes, reviews] = await Promise.all([
      api.listMyTasks(), api.getMyStreak(), api.listStudentClasses(), api.listSubmissions({ status: 'reviewed', limit: 5 }),
    ]);
    return { tasks, streak, classes, reviews };
  }, []);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [submitting, setSubmitting] = useState<Task | null>(null);

  const stats = useMemo(() => {
    const tasks = data?.tasks ?? [];
    const dueToday = tasks.filter((t) => t.due_date === today);
    const doneToday = dueToday.filter((t) => ['completed', 'submitted', 'verified'].includes(t.status));
    const open = tasks.filter((t) => t.status === 'pending' || t.status === 'rejected');
    const overdue = open.filter((t) => new Date(t.due_at).getTime() < Date.now());
    const upcoming = open.filter((t) => t.due_date > today).slice(0, 4);
    const toSubmit = tasks.filter((t) => t.status === 'completed');
    const verified = tasks.filter((t) => t.status === 'verified').length;
    return { dueToday, doneToday, overdue, upcoming, toSubmit, verified };
  }, [data, today]);

  const classNames = useMemo(() => new Map((data?.classes ?? []).filter((c) => c.class).map((c) => [c.class!.id, c.class!.name])), [data]);

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (error && !data) return <ErrorBanner message={error} onRetry={() => void reload()} />;
  if (!data) return null;

  const { streak } = data;
  const wonToday = streak.last_win_date === today;
  const next = nextBadge(streak.longest_streak);
  const firstName = profile.full_name.split(' ')[0];

  const cardProps = {
    timezone: profile.timezone,
    onChanged: () => void reload(true),
    onEdit: (t: Task) => { setEditing(t); setFormOpen(true); },
    onSubmit: (t: Task) => setSubmitting(t),
  };

  return (
    <div className="space-y-6">
      <PageHeader title={`Hi ${firstName} 👋`} subtitle="Here's your progress for today."
        actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }} disabled={readOnly} title={readOnly ? 'Free trial ended: subscribe to add tasks' : undefined}>New task</Button>} />

      {data.classes.length === 0 && (
        <Card className="flex flex-col gap-3 border-brand-200 bg-brand-50/60 p-5 sm:flex-row sm:items-center">
          <School className="h-8 w-8 text-brand-600" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold text-slate-900">Connect with your teacher</p>
            <p className="text-sm text-slate-600">Join a class with your teacher's code so you can submit work for verification.</p>
          </div>
          <Link to="/student/classes"><Button variant="secondary">Join a class</Button></Link>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="relative overflow-hidden p-6 lg:col-span-1">
          <div className="absolute -right-6 -top-6 h-28 w-28 rounded-full bg-flame-100" aria-hidden />
          <div className="relative">
            <p className="text-sm font-medium text-slate-500">Current streak</p>
            <div className="mt-1 flex items-end gap-2">
              <Flame className={`h-10 w-10 ${streak.current_streak ? 'text-flame-500' : 'text-slate-300'}`} aria-hidden />
              <span className="text-5xl font-extrabold text-slate-900">{streak.current_streak}</span>
              <span className="pb-1.5 text-sm text-slate-500">day{streak.current_streak === 1 ? '' : 's'}</span>
            </div>
            <p className="mt-3 text-sm text-slate-600">{encouragement(streak.current_streak, wonToday)}</p>
            <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
              <span className="inline-flex items-center gap-1"><Trophy className="h-3.5 w-3.5" aria-hidden /> Longest: {streak.longest_streak}</span>
              {next && <span>Next badge at {next.days} days</span>}
            </div>
            {next && <ProgressBar className="mt-2" tone="flame" value={streak.longest_streak} max={next.days} />}
            <Link to="/student/streak" className="mt-4 inline-block text-sm font-semibold text-brand-600 hover:underline">View calendar & badges</Link>
          </div>
        </Card>

        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">Today's progress</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{stats.doneToday.length} of {stats.dueToday.length} tasks done</p>
            </div>
            {wonToday && <span className="animate-pop rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">Today is a Win Day!</span>}
          </div>
          <ProgressBar className="mt-4" tone="emerald" value={stats.doneToday.length} max={Math.max(stats.dueToday.length, 1)} />
          <div className="mt-5 space-y-3">
            {stats.dueToday.length === 0 ? (
              <EmptyState icon={<ListTodo className="h-6 w-6" />} title="Nothing due today"
                body="Add a task for today and complete it to earn a Win Day."
                action={<Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }} disabled={readOnly}>Add a task</Button>} />
            ) : stats.dueToday.map((t) => <TaskCard key={t.id} task={t} compact classLabel={t.class_id ? classNames.get(t.class_id) : undefined} {...cardProps} />)}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Overdue" value={stats.overdue.length} icon={<Clock className="h-5 w-5" />} tone="rose" />
        <StatCard label="Ready to submit" value={stats.toSubmit.length} icon={<Send className="h-5 w-5" />} tone="amber" />
        <StatCard label="Verified" value={stats.verified} icon={<ShieldCheck className="h-5 w-5" />} tone="emerald" />
        <StatCard label="Total tasks" value={data.tasks.length} icon={<CheckCircle2 className="h-5 w-5" />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">Needs attention</h2>
            <Link to="/student/tasks" className="text-sm font-medium text-brand-600 hover:underline">All tasks</Link>
          </div>
          <div className="space-y-3">
            {[...stats.overdue, ...stats.toSubmit].slice(0, 5).map((t) => (
              <TaskCard key={t.id} task={t} compact classLabel={t.class_id ? classNames.get(t.class_id) : undefined} {...cardProps} />
            ))}
            {stats.overdue.length + stats.toSubmit.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No overdue or unsubmitted work. Great job!</p>}
            {stats.upcoming.length > 0 && <p className="pt-2 text-xs font-semibold uppercase text-slate-400">Coming up</p>}
            {stats.upcoming.map((t) => <TaskCard key={t.id} task={t} compact classLabel={t.class_id ? classNames.get(t.class_id) : undefined} {...cardProps} />)}
          </div>
        </Card>
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">Recent feedback</h2>
            <Link to="/student/history" className="text-sm font-medium text-brand-600 hover:underline">History</Link>
          </div>
          {data.reviews.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">Teacher feedback will appear here after your first review.</p> : (
            <ul className="divide-y divide-slate-100">
              {data.reviews.map((r) => (
                <li key={r.id} className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate font-medium text-slate-900">{r.task?.title ?? 'Task'}</p>
                    <span className={`shrink-0 text-xs font-semibold${r.status === 'verified' ? 'text-emerald-600' : 'text-rose-600'}`}>{r.status === 'verified' ? 'Verified' : 'Rejected'}</span>
                  </div>
                  {r.verification?.feedback && <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{r.verification.feedback}</p>}
                  <p className="mt-0.5 text-xs text-slate-400">{r.teacher?.full_name ?? 'Teacher'} · {r.class?.name}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <TaskFormModal open={formOpen} onClose={() => setFormOpen(false)} task={editing} classes={data.classes}
        timezone={profile.timezone} onSaved={() => void reload(true)} />
      <SubmitModal open={!!submitting} onClose={() => setSubmitting(null)} task={submitting} classes={data.classes} onSubmitted={() => void reload(true)} />
    </div>
  );
}
