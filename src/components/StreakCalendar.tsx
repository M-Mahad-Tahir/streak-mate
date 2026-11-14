import { ChevronLeft, ChevronRight, Flame, Rocket } from 'lucide-react';
import type { CalendarDay } from '../lib/types';
import { formatDateKey, formatMonth, monthRange, weekday, addDays } from '../lib/dates';
import { Spinner, cx } from './ui';

interface Props {
  monthKey: string;           // any YYYY-MM-DD inside the month to show
  days: CalendarDay[] | null; // data for that month
  today: string;
  loading?: boolean;
  onPrev: () => void;
  onNext: () => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function StreakCalendar({ monthKey, days, today, loading, onPrev, onNext }: Props) {
  const { start, end } = monthRange(monthKey);
  const lead = weekday(start);
  const byDay = new Map((days ?? []).map((d) => [d.day, d]));
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = start; d <= end; d = addDays(d, 1)) cells.push(d);
  const isFutureMonth = start > today;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <button onClick={onPrev} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Previous month"><ChevronLeft className="h-5 w-5" /></button>
        <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">{formatMonth(start)}{loading && <Spinner className="h-4 w-4" />}</h3>
        <button onClick={onNext} disabled={monthRange(addDays(end, 1)).start > today} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="Next month"><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1.5 text-center" role="grid" aria-label={`Win days in ${formatMonth(start)}`}>
        {WEEKDAYS.map((w) => <div key={w} className="pb-1 text-[11px] font-semibold uppercase text-slate-400" role="columnheader">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} aria-hidden />;
          const info = byDay.get(d);
          const win = info?.is_win;
          const isToday = d === today;
          const future = d > today;
          const missed = !win && !future && (info?.due_count ?? 0) > 0;
          const label = `${formatDateKey(d)}: ${win ? 'Win day' : future ? 'Upcoming' : missed ? 'Missed' : 'No wins'}; ${info?.completed_count ?? 0} completed, ${info?.verified_count ?? 0} verified, ${info?.due_count ?? 0} due`;
          return (
            <div key={d} role="gridcell" title={label} aria-label={label}
              className={cx('relative flex aspect-square flex-col items-center justify-center rounded-lg text-sm transition',
                win ? 'bg-gradient-to-br from-flame-400 to-flame-600 font-semibold text-white shadow-sm'
                  : missed ? 'bg-rose-50 text-rose-700'
                  : future ? 'text-slate-300' : 'bg-slate-50 text-slate-600',
                isToday && 'ring-2 ring-brand-500 ring-offset-1')}>
              {win
                ? (info?.verified_count ?? 0) > 0 ? <Rocket className="h-4 w-4" aria-hidden /> : <Flame className="h-4 w-4" aria-hidden />
                : <span>{Number(d.slice(8))}</span>}
              {win && <span className="text-[10px] leading-none">{Number(d.slice(8))}</span>}
              {!win && !future && (info?.completed_count ?? 0) > 0 && <span className="absolute bottom-1 h-1 w-1 rounded-full bg-emerald-500" aria-hidden />}
            </div>
          );
        })}
      </div>
      {isFutureMonth ? null : (
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-flame-500" />Win day</span>
          <span className="flex items-center gap-1.5"><Rocket className="h-3.5 w-3.5 text-flame-600" aria-hidden />Verified by teacher</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-rose-100" />Missed (tasks due, not all done)</span>
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Some work completed</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded ring-2 ring-brand-500" />Today</span>
        </div>
      )}
    </div>
  );
}
