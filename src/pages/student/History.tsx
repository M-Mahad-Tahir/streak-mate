import { useMemo, useState } from 'react';
import { CheckCircle2, Clock, History as HistoryIcon, XCircle } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton, cx } from '../../components/ui';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatDateTime } from '../../lib/dates';
import type { SubmissionDetail } from '../../lib/types';

type Filter = 'all' | 'submitted' | 'verified' | 'rejected';

export function SubmissionTimelineItem({ s, showStudent }: { s: SubmissionDetail; showStudent?: boolean }) {
  const meta = {
    submitted: { icon: Clock, cls: 'bg-amber-50 text-amber-600', label: 'Waiting for review' },
    verified: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-600', label: 'Verified' },
    rejected: { icon: XCircle, cls: 'bg-rose-50 text-rose-600', label: 'Needs improvement' },
  }[s.status];
  return (
    <li className="flex gap-4 py-4">
      <div className={cx('h-fit rounded-xl p-2.5', meta.cls)}><meta.icon className="h-5 w-5" aria-hidden /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="font-semibold text-slate-900">
            {/* Teachers see the version they reviewed; students see their task's current name. */}
            {(showStudent ? s.task_title ?? s.task?.title : s.task?.title ?? s.task_title) ?? 'Task no longer available'}
          </p>
          <span className={cx('text-xs font-semibold', meta.cls.split(' ')[1])}>{meta.label}</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {showStudent ? `${s.student?.full_name ?? 'Former student'} · ` : `${s.teacher?.full_name ?? 'Teacher'} · `}
          {s.class?.name ?? 'Class'} · Submitted {formatDateTime(s.submitted_at)}
        </p>
        {s.note && <p className="mt-2 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-sm text-slate-700"><span className="font-medium">Note: </span>{s.note}</p>}
        {s.verification && (
          <div className={cx('mt-2 rounded-lg p-3 text-sm', s.verification.decision === 'approved' ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-900')}>
            <p className="font-medium">{s.verification.decision === 'approved' ? 'Approved' : 'Rejected'} {formatDateTime(s.verification.created_at)}</p>
            {s.verification.feedback && <p className="mt-1 whitespace-pre-line">{s.verification.feedback}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

export default function StudentHistory() {
  const { data, error, loading, reload } = useAsync(() => api.listSubmissions(), []);
  const [filter, setFilter] = useState<Filter>('all');
  const list = useMemo(() => {
    const rows = [...(data ?? [])].sort((a, b) => (b.reviewed_at ?? b.submitted_at).localeCompare(a.reviewed_at ?? a.submitted_at));
    return filter === 'all' ? rows : rows.filter((s) => s.status === filter);
  }, [data, filter]);

  return (
    <div>
      <PageHeader title="History & Feedback" subtitle="Every submission and what your teacher said about it." />
      <div className="mb-4 flex flex-wrap gap-1">
        {(['all', 'submitted', 'verified', 'rejected'] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
            className={cx('rounded-full px-3 py-1.5 text-sm font-medium capitalize', filter === f ? 'bg-brand-gradient text-white' : 'bg-surface text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')}>
            {f === 'submitted' ? 'Waiting' : f}
          </button>
        ))}
      </div>
      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {loading && !data ? <Skeleton className="h-64" /> : list.length === 0 ? (
        <EmptyState icon={<HistoryIcon className="h-6 w-6" />} title="No submissions yet" body="Complete a task and submit it to your teacher to see it here." />
      ) : (
        <Card className="px-5"><ul className="divide-y divide-slate-100">{list.map((s) => <SubmissionTimelineItem key={s.id} s={s} />)}</ul></Card>
      )}
    </div>
  );
}
