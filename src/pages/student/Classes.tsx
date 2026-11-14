import { useState, type FormEvent } from 'react';
import { LogOut, School, UserRound } from 'lucide-react';
import { useProfile } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { Button, Card, ConfirmModal, EmptyState, ErrorBanner, Input, PageHeader, Skeleton } from '../../components/ui';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatDateKey } from '../../lib/dates';
import { normalizeClassCode, validateClassCode } from '../../lib/validation';

export default function StudentClasses() {
  const profile = useProfile();
  const { toast } = useToast();
  const { data, error, loading, reload } = useAsync(() => api.listStudentClasses(), []);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState<{ id: string; name: string } | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);

  const onJoin = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateClassCode(code);
    setCodeError(err);
    if (err) return;
    setJoining(true);
    try {
      const cls = await api.joinClass(normalizeClassCode(code));
      toast('success', `Joined ${cls.name}`, 'You can now submit work to this teacher.');
      setCode('');
      await reload(true);
    } catch (e2) {
      setCodeError(api.friendlyError(e2));
    } finally {
      setJoining(false);
    }
  };

  const onLeave = async () => {
    if (!leaving) return;
    setLeaveBusy(true);
    try {
      await api.leaveClass(leaving.id, profile.id);
      toast('success', `Left ${leaving.name}`);
      setLeaving(null);
      await reload(true);
    } catch (e) {
      toast('error', 'Could not leave class', api.friendlyError(e));
    } finally {
      setLeaveBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="My Classes" subtitle="Connect with your teachers using their class code." />
      <Card className="p-6">
        <form onSubmit={onJoin} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
          <div className="flex-1">
            <Input label="Class code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} error={codeError}
              placeholder="e.g. 7F3A9C21" maxLength={12} autoComplete="off" className="font-mono uppercase tracking-widest"
              hint="Ask your teacher for the code shown on their Classes page." />
          </div>
          <Button type="submit" loading={joining} className="sm:mt-7">Join class</Button>
        </form>
      </Card>

      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {loading && !data ? <Skeleton className="h-32" /> : !data?.length ? (
        <EmptyState icon={<School className="h-6 w-6" />} title="You haven't joined a class yet" body="Once you join, your teacher can verify the tasks you submit." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.filter((m) => m.class).map((m) => (
            <Card key={m.class!.id} className="p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-brand-50 p-3 text-brand-600"><School className="h-5 w-5" aria-hidden /></div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-900">{m.class!.name}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-600"><UserRound className="h-3.5 w-3.5" aria-hidden />{m.class!.teacher?.full_name ?? 'Teacher'}</p>
                  <p className="mt-1 text-xs text-slate-400">Joined {formatDateKey(m.joined_at.slice(0, 10))}</p>
                </div>
                <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" icon={<LogOut className="h-3.5 w-3.5" />}
                  onClick={() => setLeaving({ id: m.class!.id, name: m.class!.name })}>Leave</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <ConfirmModal open={!!leaving} onClose={() => setLeaving(null)} onConfirm={onLeave} loading={leaveBusy} danger confirmLabel="Leave class"
        title={`Leave ${leaving?.name ?? 'class'}?`} body="Any submissions still waiting for review in this class will be withdrawn. Your tasks stay in your list." />
    </div>
  );
}
