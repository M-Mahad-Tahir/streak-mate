import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, Flame, Plus, ShieldCheck, Users } from 'lucide-react';
import { useProfile } from '../../context/AuthContext';
import { Button, Card, EmptyState, ErrorBanner, PageHeader, Skeleton, StatCard } from '../../components/ui';
import { ReviewModal } from './Review';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { relativeTime } from '../../lib/dates';
import type { SubmissionDetail } from '../../lib/types';

export default function TeacherDashboard() {
  const profile = useProfile();
  const { data, error, loading, reload } = useAsync(async () => {
    const [pending, reviewed, students, classes] = await Promise.all([
      api.listSubmissions({ status: 'submitted' }), api.listSubmissions({ status: 'reviewed', limit: 200 }),
      api.teacherOverview(), api.listTeacherClasses(profile.id),
    ]);
    return { pending, reviewed, students, classes };
  }, [profile.id]);
  const [selected, setSelected] = useState<SubmissionDetail | null>(null);

  const stats = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    const verifiedWeek = (data?.reviewed ?? []).filter((s) => s.status === 'verified' && s.reviewed_at && new Date(s.reviewed_at).getTime() > weekAgo).length;
    const uniqueStudents = new Set((data?.students ?? []).map((s) => s.student_id)).size;
    const activeStreaks = new Set((data?.students ?? []).filter((s) => s.current_streak > 0).map((s) => s.student_id)).size;
    return { verifiedWeek, uniqueStudents, activeStreaks };
  }, [data]);

  if (loading && !data) return <div className="space-y-6"><Skeleton className="h-10 w-64" /><div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div><Skeleton className="h-64" /></div>;
  if (error && !data) return <ErrorBanner message={error} onRetry={() => void reload()} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${profile.full_name.split(' ')[0]}`} subtitle="Here's what your students have been working on." />

      {data.classes.length === 0 && (
        <Card className="flex flex-col gap-3 border-brand-200 bg-brand-50/60 p-5 sm:flex-row sm:items-center">
          <Users className="h-8 w-8 text-brand-600" aria-hidden />
          <div className="flex-1">
            <p className="font-semibold">Create your first class</p>
            <p className="text-sm text-slate-600">You'll get a class code to share with students so they can submit work to you.</p>
          </div>
          <Link to="/teacher/classes"><Button icon={<Plus className="h-4 w-4" />}>Create class</Button></Link>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Pending reviews" value={data.pending.length} icon={<ClipboardCheck className="h-5 w-5" />} tone="amber" />
        <StatCard label="Verified this week" value={stats.verifiedWeek} icon={<ShieldCheck className="h-5 w-5" />} tone="emerald" />
        <StatCard label="Students" value={stats.uniqueStudents} icon={<Users className="h-5 w-5" />} hint={`${data.classes.length} class${data.classes.length === 1 ? '' : 'es'}`} />
        <StatCard label="Active streaks" value={stats.activeStreaks} icon={<Flame className="h-5 w-5" />} tone="flame" />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="p-6 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Waiting for you</h2>
            <Link to="/teacher/review" className="text-sm font-medium text-brand-600 hover:underline">See all</Link>
          </div>
          {data.pending.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">No submissions waiting. Nice!</p> : (
            <ul className="divide-y divide-slate-100">
              {data.pending.slice(0, 6).map((s) => (
                <li key={s.id}>
                  <button onClick={() => setSelected(s)} className="flex w-full items-center gap-3 rounded-lg py-3 text-left hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-900">{s.task?.title ?? 'Task'}</p>
                      <p className="text-xs text-slate-500">{s.student?.full_name} · {relativeTime(s.submitted_at)}</p>
                    </div>
                    <span className="text-sm font-semibold text-brand-600">Review</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden lg:col-span-3">
          <div className="flex items-center justify-between p-6 pb-3">
            <h2 className="font-semibold">Student progress</h2>
            <Link to="/teacher/classes" className="text-sm font-medium text-brand-600 hover:underline">Manage</Link>
          </div>
          {data.students.length === 0 ? (
            <div className="p-6 pt-0"><EmptyState icon={<Users className="h-6 w-6" />} title="No students yet" body="Share a class code so students can join." /></div>
          ) : (
            <>
            {/* Phones: one row per student, tap to open. */}
            <ul className="divide-y divide-slate-100 border-t border-slate-100 sm:hidden">
              {data.students.map((s) => (
                <li key={`${s.class_id}-${s.student_id}`}>
                  <Link to={`/teacher/students/${s.student_id}`} className="flex items-center gap-3 px-6 py-3 active:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-900">{s.full_name}</p>
                      <p className="truncate text-xs text-slate-500">{s.class_name} · {s.verified_tasks}/{s.class_tasks} verified</p>
                    </div>
                    {s.pending_reviews > 0 && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700" title="Waiting for review">{s.pending_reviews}</span>}
                    <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-flame-600"><Flame className="h-4 w-4" aria-hidden />{s.current_streak}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr><th className="px-6 py-2 font-semibold">Student</th><th className="px-3 py-2 font-semibold">Class</th><th className="px-3 py-2 font-semibold">Streak</th><th className="px-3 py-2 font-semibold">Verified</th><th className="px-3 py-2 font-semibold">Pending</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.students.map((s) => (
                    <tr key={`${s.class_id}-${s.student_id}`} className="hover:bg-slate-50">
                      <td className="px-6 py-3"><Link to={`/teacher/students/${s.student_id}`} className="font-medium text-slate-900 hover:text-brand-600">{s.full_name}</Link></td>
                      <td className="px-3 py-3 text-slate-600">{s.class_name}</td>
                      <td className="px-3 py-3"><span className="inline-flex items-center gap-1 font-semibold text-flame-600"><Flame className="h-4 w-4" aria-hidden />{s.current_streak}</span></td>
                      <td className="px-3 py-3 text-slate-600">{s.verified_tasks}/{s.class_tasks}</td>
                      <td className="px-3 py-3">{s.pending_reviews > 0 ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">{s.pending_reviews}</span> : <span className="text-slate-400">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>
      </div>
      <ReviewModal submission={selected} onClose={() => setSelected(null)} onDone={() => void reload(true)} />
    </div>
  );
}
