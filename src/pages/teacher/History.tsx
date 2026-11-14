import { useMemo, useState } from 'react';
import { BookOpenCheck, Search } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton, cx } from '../../components/ui';
import { SubmissionTimelineItem } from '../student/History';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';

export default function TeacherHistory() {
  const { data, error, loading, reload } = useAsync(() => api.listSubmissions({ status: 'reviewed', limit: 500 }), []);
  const [filter, setFilter] = useState<'all' | 'verified' | 'rejected'>('all');
  const [search, setSearch] = useState('');
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((s) => (filter === 'all' || s.status === filter) &&
      (!q || (s.task?.title ?? '').toLowerCase().includes(q) || (s.student?.full_name ?? '').toLowerCase().includes(q)));
  }, [data, filter, search]);

  return (
    <div>
      <PageHeader title="Verified History" subtitle="Every decision you've made, with your feedback." />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1">
          {(['all', 'verified', 'rejected'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={cx('rounded-full px-3 py-1.5 text-sm font-medium capitalize', filter === f ? 'bg-brand-gradient text-white' : 'bg-surface text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')}>{f}</button>
          ))}
        </div>
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search task or student" aria-label="Search history"
            className="w-full rounded-lg border border-slate-300 bg-surface py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200" />
        </div>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {loading && !data ? <Skeleton className="h-64" /> : list.length === 0 ? (
        <EmptyState icon={<BookOpenCheck className="h-6 w-6" />} title="No reviews yet" body="Submissions you approve or reject will be listed here." />
      ) : (
        <Card className="px-5"><ul className="divide-y divide-slate-100">{list.map((s) => <SubmissionTimelineItem key={s.id} s={s} showStudent />)}</ul></Card>
      )}
    </div>
  );
}
