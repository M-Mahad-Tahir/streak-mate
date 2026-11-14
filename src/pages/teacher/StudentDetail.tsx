import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Flame, ShieldCheck, Trophy } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton, StatCard, StatusBadge } from '../../components/ui';
import { StreakCalendar } from '../../components/StreakCalendar';
import { SubmissionTimelineItem } from '../student/History';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { addDays, formatDateKey, formatTime, monthRange, todayIn } from '../../lib/dates';

export default function TeacherStudentDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(async () => {
    const [student, streak, tasks, submissions, badges] = await Promise.all([
      api.getProfileById(id), api.getStreak(id), api.listStudentTasksForTeacher(id), api.listSubmissions({ studentId: id }), api.listBadges(id),
    ]);
    return { student, streak, tasks, submissions, badges };
  }, [id]);
  const tz = data?.student?.timezone ?? 'UTC';
  const today = todayIn(tz);
  const [month, setMonth] = useState(today);
  const { start, end } = monthRange(month);
  const calendar = useAsync(() => (data?.student ? api.getCalendar(start, end, id) : Promise.resolve(null)), [start, end, id, !!data?.student]);

  if (loading && !data) return <Skeleton className="h-64" />;
  if (error && !data) return <ErrorBanner message={error} onRetry={() => void reload()} />;
  if (!data?.student) {
    return <EmptyState title="Student not found" body="This student is not in any of your classes."
      action={<Link to="/teacher/classes" className="text-sm font-semibold text-brand-600">Back to classes</Link>} />;
  }
  const { student, streak, tasks, submissions, badges } = data;
  const verified = tasks.filter((t) => t.status === 'verified').length;

  return (
    <div className="space-y-6">
      <Link to="/teacher" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden />Back</Link>
      <PageHeader title={student.full_name} subtitle={`${student.email} · ${student.timezone}`} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Current streak" value={streak?.current_streak ?? 0} icon={<Flame className="h-5 w-5" />} tone="flame" />
        <StatCard label="Longest streak" value={streak?.longest_streak ?? 0} icon={<Trophy className="h-5 w-5" />} tone="amber" hint={`${badges.length} badge${badges.length === 1 ? '' : 's'}`} />
        <StatCard label="Verified class tasks" value={`${verified}/${tasks.length}`} icon={<ShieldCheck className="h-5 w-5" />} tone="emerald" />
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="p-6 lg:col-span-2">
          <h2 className="mb-2 font-semibold">Win calendar</h2>
          {calendar.error && <ErrorBanner message={calendar.error} />}
          <StreakCalendar monthKey={month} days={calendar.data} today={today} loading={calendar.loading}
            onPrev={() => setMonth(addDays(start, -1))} onNext={() => setMonth(addDays(end, 1))} />
        </Card>
        <Card className="p-6 lg:col-span-3">
          <h2 className="mb-1 font-semibold">Class tasks</h2>
          <p className="mb-3 text-xs text-slate-500">Only tasks linked to your classes are visible to you.</p>
          {tasks.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No tasks linked to your classes yet.</p> : (
            <ul className="divide-y divide-slate-100">
              {tasks.slice(0, 15).map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{t.title}</p>
                    <p className="text-xs text-slate-500">Due {formatDateKey(t.due_date)} {formatTime(t.due_time)}</p>
                  </div>
                  {t.archived_at && <span className="text-xs text-slate-400" title="The student removed this from their own task list. Your record is kept.">Removed by student</span>}
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card className="px-5">
        <h2 className="pt-5 font-semibold">Submission history</h2>
        {submissions.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No submissions yet.</p> : (
          <ul className="divide-y divide-slate-100">{submissions.map((s) => <SubmissionTimelineItem key={s.id} s={s} showStudent />)}</ul>
        )}
      </Card>
    </div>
  );
}
