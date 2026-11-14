import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, CheckCircle2, ClipboardCheck, Clock, School, ThumbsDown, ThumbsUp, UserRound } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { Button, Card, EmptyState, ErrorBanner, Modal, PageHeader, Skeleton, Textarea, cx } from '../../components/ui';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatDateKey, formatDateTime, relativeTime } from '../../lib/dates';
import type { SubmissionDetail } from '../../lib/types';

export function ReviewModal({ submission, onClose, onDone }: { submission: SubmissionDetail | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'view' | 'reject'>('view');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => { setMode('view'); setFeedback(''); setError(null); }, [submission?.id]);

  if (!submission) return null;
  const t = submission.task;
  // What the teacher is shown (and therefore approves): the submitted wording.
  const shownTitle = submission.task_title ?? t?.title ?? 'Task';
  const shownDescription = submission.task_description ?? t?.description ?? '';
  const late = t?.completed_at && t.due_at && new Date(t.completed_at) > new Date(t.due_at);

  const decide = async (decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && feedback.trim().length < 3) {
      setError('Please explain what needs improvement (at least 3 characters).');
      return;
    }
    setBusy(decision === 'approved' ? 'approve' : 'reject');
    setError(null);
    try {
      // Only report success after the server confirms the new status.
      const result = await api.reviewSubmission(submission.id, decision, feedback.trim(),
        submission.task_title != null ? { title: shownTitle, description: shownDescription } : undefined);
      if (result.task_status === 'verified') toast('success', 'Task verified', `${submission.student?.full_name ?? 'The student'} has been notified.`);
      else toast('info', 'Feedback sent', 'The task was returned to the student for improvement.');
      onDone();
      onClose();
    } catch (e) {
      const msg = api.friendlyError(e);
      if (api.STALE_REVIEW_RE.test(msg)) {
        // The student edited the task while it was open: reload and let the teacher look again.
        toast('info', 'This task was just edited', 'Open it again to review the latest version.');
        onDone();
        onClose();
        return;
      }
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} size="lg" title="Review submission" footer={mode === 'view' ? <>
      <Button variant="secondary" onClick={() => setMode('reject')} icon={<ThumbsDown className="h-4 w-4" />} disabled={!!busy}>Reject</Button>
      <Button variant="success" onClick={() => void decide('approved')} loading={busy === 'approve'} icon={<ThumbsUp className="h-4 w-4" />}>Approve</Button>
    </> : <>
      <Button variant="secondary" onClick={() => setMode('view')} disabled={!!busy}>Back</Button>
      <Button variant="danger" onClick={() => void decide('rejected')} loading={busy === 'reject'}>Send feedback & reject</Button>
    </>}>
      <div className="space-y-4">
        {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p>}
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{shownTitle}</h3>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
            <span className="inline-flex items-center gap-1"><UserRound className="h-4 w-4" aria-hidden />{submission.student?.full_name ?? 'Student'}</span>
            <span className="inline-flex items-center gap-1"><School className="h-4 w-4" aria-hidden />{submission.class?.name}</span>
          </div>
        </div>
        {shownDescription && <div><p className="mb-1 text-xs font-semibold uppercase text-slate-400">Description</p><p className="whitespace-pre-line text-sm text-slate-700">{shownDescription}</p></div>}
        <div className="grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-3">
          <div><p className="text-xs text-slate-400">Due</p><p className="font-medium">{t ? formatDateTime(t.due_at) : '-'}</p></div>
          <div><p className="text-xs text-slate-400">Completed</p><p className={cx('font-medium', late && 'text-amber-700')}>{t?.completed_at ? formatDateTime(t.completed_at) : '-'}{late && ' (late)'}</p></div>
          <div><p className="text-xs text-slate-400">Submitted</p><p className="font-medium">{formatDateTime(submission.submitted_at)}</p></div>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase text-slate-400">Student's note</p>
          <p className="whitespace-pre-line rounded-lg border border-slate-200 p-3 text-sm text-slate-700">{submission.note || <span className="text-slate-400">No note provided.</span>}</p>
        </div>
        {mode === 'reject' ? (
          <Textarea label="What needs improvement?" value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={2000} required
            placeholder="Be specific so the student knows how to fix it." hint={`${feedback.length}/2000`} autoFocus />
        ) : (
          <Textarea label="Feedback (optional for approval)" value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={2000}
            placeholder="Add a word of encouragement..." />
        )}
      </div>
    </Modal>
  );
}

export default function TeacherReview() {
  const { data, error, loading, reload } = useAsync(() => api.listSubmissions({ status: 'submitted' }), []);
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<SubmissionDetail | null>(null);
  const [classFilter, setClassFilter] = useState('all');
  const focusId = params.get('submission');

  // Deep link from a notification: /teacher/review?submission=<id>
  useEffect(() => {
    if (!focusId || !data) return;
    const found = data.find((s) => s.id === focusId);
    if (found) setSelected(found);
    else void api.getSubmission(focusId).then((s) => { if (s?.status === 'submitted') setSelected(s); });
  }, [focusId, data]);

  const classes = useMemo(() => [...new Set((data ?? []).map((s) => s.class?.name ?? ''))].filter(Boolean), [data]);
  const list = (data ?? []).filter((s) => classFilter === 'all' || s.class?.name === classFilter);

  const close = () => { setSelected(null); if (focusId) { params.delete('submission'); setParams(params, { replace: true }); } };

  return (
    <div>
      <PageHeader title="Pending Reviews" subtitle="Approve great work or send feedback on what to improve."
        actions={classes.length > 1 && (
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} aria-label="Filter by class"
            className="rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm">
            <option value="all">All classes</option>
            {classes.map((c) => <option key={c}>{c}</option>)}
          </select>
        )} />
      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {loading && !data ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div> : list.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title="All caught up!" body="New submissions from your students will show up here." />
      ) : (
        <div className="space-y-3">
          {list.map((s) => {
            const waitingLong = Date.now() - new Date(s.submitted_at).getTime() > 24 * 3600 * 1000;
            return (
              <Card key={s.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="rounded-xl bg-amber-50 p-2.5 text-amber-600"><ClipboardCheck className="h-5 w-5" aria-hidden /></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-slate-900">{s.task?.title ?? 'Task'}</p>
                    <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-slate-500">
                      <span>{s.student?.full_name ?? 'Student'}</span><span>{s.class?.name}</span>
                      {s.task && <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" aria-hidden />Due {formatDateKey(s.task.due_date)}</span>}
                    </p>
                  </div>
                  <span className={cx('inline-flex items-center gap-1 text-xs', waitingLong ? 'font-semibold text-rose-600' : 'text-slate-400')}>
                    <Clock className="h-3.5 w-3.5" aria-hidden />Submitted {relativeTime(s.submitted_at)}
                  </span>
                  <Button onClick={() => setSelected(s)}>Review</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <ReviewModal submission={selected} onClose={close} onDone={() => void reload(true)} />
    </div>
  );
}
