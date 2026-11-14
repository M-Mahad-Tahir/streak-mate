import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlarmClock, Award, Bell, CheckCircle2, ClipboardCheck, CreditCard, Send, Trash2, UserPlus, XCircle } from 'lucide-react';
import { useNotifications } from '../context/NotificationsContext';
import { useToast } from '../context/ToastContext';
import { Button, Card, ConfirmModal, EmptyState, ErrorBanner, PageHeader, Skeleton, cx } from '../components/ui';
import { formatDateTime, relativeTime } from '../lib/dates';
import { friendlyError } from '../lib/api';

const ICONS: Record<string, { icon: typeof Bell; cls: string }> = {
  due_soon: { icon: AlarmClock, cls: 'bg-amber-50 text-amber-600' },
  overdue: { icon: AlarmClock, cls: 'bg-rose-50 text-rose-600' },
  submit_reminder: { icon: Send, cls: 'bg-sky-50 text-sky-600' },
  new_submission: { icon: ClipboardCheck, cls: 'bg-brand-50 text-brand-600' },
  pending_reviews: { icon: ClipboardCheck, cls: 'bg-amber-50 text-amber-600' },
  task_approved: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-600' },
  task_rejected: { icon: XCircle, cls: 'bg-rose-50 text-rose-600' },
  badge_earned: { icon: Award, cls: 'bg-flame-50 text-flame-600' },
  class_joined: { icon: UserPlus, cls: 'bg-brand-50 text-brand-600' },
  payment_submitted: { icon: CreditCard, cls: 'bg-violet-50 text-violet-600' },
  payment_approved: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-600' },
  payment_rejected: { icon: XCircle, cls: 'bg-rose-50 text-rose-600' },
};

export default function NotificationsPage() {
  const { items, unread, loading, error, reload, markRead, markAllRead, remove, removeAll } = useNotifications();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState<'read' | 'all' | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const list = onlyUnread ? items.filter((n) => !n.read_at) : items;
  const readCount = items.length - items.filter((n) => !n.read_at).length;

  const guard = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { toast('error', 'Action failed', friendlyError(e)); }
  };

  const runClear = async () => {
    if (!clearing) return;
    setClearBusy(true);
    try {
      await removeAll(clearing === 'read');
      toast('success', clearing === 'read' ? 'Read notifications deleted' : 'All notifications deleted');
      setClearing(null);
    } catch (e) {
      toast('error', 'Could not delete', friendlyError(e));
    } finally {
      setClearBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Notifications" subtitle={unread ? `${unread} unread` : "You're all caught up."}
        actions={<>
          <Button variant="secondary" onClick={() => setOnlyUnread((v) => !v)} aria-pressed={onlyUnread}>{onlyUnread ? 'Show all' : 'Unread only'}</Button>
          {unread > 0 && <Button loading={busy} onClick={() => { setBusy(true); void guard(markAllRead).finally(() => setBusy(false)); }}>Mark all read</Button>}
          {readCount > 0 && readCount < items.length && <Button variant="secondary" icon={<Trash2 className="h-4 w-4" />} onClick={() => setClearing('read')}>Delete read</Button>}
          {items.length > 0 && <Button variant="secondary" className="text-rose-600 hover:bg-rose-50" icon={<Trash2 className="h-4 w-4" />} onClick={() => setClearing('all')}>Delete all</Button>}
        </>} />
      {error && <div className="mb-4"><ErrorBanner message={error} onRetry={() => void reload()} /></div>}
      {loading && !items.length ? <Skeleton className="h-64" /> : list.length === 0 ? (
        <EmptyState icon={<Bell className="h-6 w-6" />} title={onlyUnread ? 'No unread notifications' : 'No notifications yet'}
          body="Reminders, reviews and achievements will appear here." />
      ) : (
        <Card className="divide-y divide-slate-100 overflow-hidden">
          {list.map((n) => {
            const meta = ICONS[n.type] ?? { icon: Bell, cls: 'bg-slate-100 text-slate-600' };
            return (
              <div key={n.id} className={cx('flex items-start gap-3 p-4 transition', !n.read_at && 'bg-brand-50/40')}>
                <div className={cx('rounded-xl p-2.5', meta.cls)}><meta.icon className="h-5 w-5" aria-hidden /></div>
                <button className="min-w-0 flex-1 text-left" onClick={() => { void guard(() => markRead([n.id])); if (n.link) navigate(n.link); }}>
                  <p className={cx('text-sm text-slate-900', !n.read_at ? 'font-semibold' : 'font-medium')}>{n.title}</p>
                  {n.body && <p className="mt-0.5 text-sm text-slate-600">{n.body}</p>}
                  <p className="mt-1 text-xs text-slate-400" title={formatDateTime(n.created_at)}>{relativeTime(n.created_at)}</p>
                </button>
                <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
                  {!n.read_at && <button onClick={() => void guard(() => markRead([n.id]))} className="tap-target rounded-lg px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50">Mark read</button>}
                  <button onClick={() => void guard(() => remove(n.id))} className="tap-target inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-600" aria-label={`Delete notification: ${n.title}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />Delete
                  </button>
                </div>
              </div>
            );
          })}
        </Card>
      )}
      <ConfirmModal open={!!clearing} onClose={() => setClearing(null)} onConfirm={() => void runClear()} loading={clearBusy} danger
        title={clearing === 'read' ? 'Delete read notifications?' : 'Delete all notifications?'}
        body={clearing === 'read'
          ? 'All notifications you have already read will be removed. Unread ones stay. This cannot be undone.'
          : 'Every notification will be removed, including unread ones. This cannot be undone.'}
        confirmLabel={clearing === 'read' ? 'Delete read' : 'Delete all'} />
    </div>
  );
}
