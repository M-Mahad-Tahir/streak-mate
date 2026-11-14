import { useState } from 'react';
import { Flame, Info, Lock, Trophy } from 'lucide-react';
import { useProfile } from '../../context/AuthContext';
import { Card, ErrorBanner, PageHeader, ProgressBar, Skeleton, cx } from '../../components/ui';
import { StreakCalendar } from '../../components/StreakCalendar';
import * as api from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { addDays, formatDateKey, monthRange, todayIn } from '../../lib/dates';
import { BADGES, STREAK_RULE, encouragement, nextBadge } from '../../lib/streak';

export default function StudentStreak() {
  const profile = useProfile();
  const today = todayIn(profile.timezone);
  const [month, setMonth] = useState(today);
  const summary = useAsync(async () => {
    const [streak, badges] = await Promise.all([api.getMyStreak(), api.listBadges(profile.id)]);
    return { streak, badges };
  }, [profile.id]);
  const { start, end } = monthRange(month);
  const calendar = useAsync(() => api.getCalendar(start, end), [start, end]);

  if (summary.error && !summary.data) return <ErrorBanner message={summary.error} onRetry={() => void summary.reload()} />;
  const s = summary.data?.streak;
  const earned = new Map((summary.data?.badges ?? []).map((b) => [b.code, b]));
  const next = s ? nextBadge(s.longest_streak) : null;
  const wonToday = s?.last_win_date === today;
  const monthWins = (calendar.data ?? []).filter((d) => d.is_win).length;

  return (
    <div className="space-y-6">
      <PageHeader title="My Streak" subtitle="Consistency, visualized." />
      {!s ? <Skeleton className="h-40" /> : (
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="relative overflow-hidden bg-gradient-to-br from-flame-500 to-rose-500 p-6 text-white md:col-span-2">
            <Flame className="absolute -bottom-6 -right-6 h-40 w-40 opacity-15" aria-hidden />
            <p className="text-sm font-medium text-white/85">Current streak</p>
            <p className="mt-1 text-6xl font-extrabold">{s.current_streak}<span className="ml-2 text-xl font-semibold">day{s.current_streak === 1 ? '' : 's'}</span></p>
            <p className="mt-3 max-w-md text-white/90">{encouragement(s.current_streak, wonToday)}</p>
            {!wonToday && s.current_streak > 0 && <p className="mt-2 text-sm font-semibold">Today isn't won yet. Your streak is safe until the end of today.</p>}
          </Card>
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-amber-50 p-3 text-amber-600"><Trophy className="h-6 w-6" aria-hidden /></div>
              <div><p className="text-sm text-slate-500">Longest streak</p><p className="text-3xl font-bold">{s.longest_streak}</p></div>
            </div>
            {s.last_win_date && <p className="mt-4 text-sm text-slate-500">Last Win Day: {formatDateKey(s.last_win_date)}</p>}
            {next ? (
              <div className="mt-4">
                <p className="mb-1.5 text-sm text-slate-600">{next.days - s.longest_streak} more day{next.days - s.longest_streak === 1 ? '' : 's'} to <strong>{next.label}</strong></p>
                <ProgressBar tone="flame" value={s.longest_streak} max={next.days} />
              </div>
            ) : <p className="mt-4 text-sm font-semibold text-emerald-600">All badges earned. Legendary!</p>}
          </Card>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="p-6 lg:col-span-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">Calendar</h2>
            <span className="text-sm text-slate-500">{monthWins} win day{monthWins === 1 ? '' : 's'} this month</span>
          </div>
          {calendar.error && <ErrorBanner message={calendar.error} onRetry={() => void calendar.reload()} />}
          <StreakCalendar monthKey={month} days={calendar.data} today={today} loading={calendar.loading}
            onPrev={() => setMonth(addDays(start, -1))} onNext={() => setMonth(addDays(end, 1))} />
        </Card>
        <Card className="p-6 lg:col-span-2">
          <h2 className="mb-4 font-semibold text-slate-900">Badges</h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
            {BADGES.map((b) => {
              const got = earned.get(b.code);
              return (
                <li key={b.code} className={cx('flex flex-col items-center rounded-xl border p-3 text-center',
                  got ? 'animate-pop border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50 opacity-70')}>
                  <span className={cx('text-3xl', !got && 'grayscale')} aria-hidden>{got ? b.emoji : <Lock className="h-7 w-7 text-slate-400" />}</span>
                  <span className="mt-1 text-sm font-semibold">{b.label}</span>
                  <span className="text-xs text-slate-500">{b.days}-day streak</span>
                  {got && <span className="mt-1 text-[11px] text-amber-700">Earned {formatDateKey(got.earned_at.slice(0, 10))}</span>}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card className="flex gap-3 p-5">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" aria-hidden />
        <div className="text-sm text-slate-600">
          <p className="mb-1 font-semibold text-slate-900">How Win Days work</p>
          <p>{STREAK_RULE}</p>
          <p className="mt-1 text-xs text-slate-400">Days are counted in your timezone ({profile.timezone}) on the server, so your streak is the same on every device.</p>
        </div>
      </Card>
    </div>
  );
}
