import type { ReactNode } from 'react';
import { CheckCircle2, Flame } from 'lucide-react';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-brand-gradient p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="" className="h-10 w-10 rounded-xl ring-2 ring-white/30" />
          <span className="text-xl font-extrabold tracking-tight">Streak <span className="text-white/75">Mate</span></span>
        </div>
        <div className="max-w-md">
          <h2 className="text-4xl font-extrabold leading-tight">Build the habit of finishing.</h2>
          <p className="mt-4 text-white/80">Plan your daily work, get it verified by your teacher, and watch your streak grow one win at a time.</p>
          <ul className="mt-8 space-y-3 text-sm">
            {['Daily tasks with due dates and reminders', 'Teacher verification with feedback', 'Streaks, calendars and milestone badges'].map((t) => (
              <li key={t} className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-300" aria-hidden />{t}</li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-3 rounded-2xl bg-white/10 p-4 backdrop-blur">
          <div className="rounded-xl bg-flame-500 p-2.5"><Flame className="h-6 w-6" aria-hidden /></div>
          <div>
            <p className="text-sm font-semibold">"Small daily wins add up to big results."</p>
            <p className="text-xs text-white/80">Keep the streak alive.</p>
          </div>
        </div>
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" aria-hidden />
      </div>
      <div className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <img src="/logo.svg" alt="" className="h-10 w-10" />
            <span className="whitespace-nowrap text-xl font-extrabold tracking-tight">Streak{' '}<span className="text-brand-gradient">Mate</span></span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          <p className="mb-8 mt-1 text-sm text-slate-500">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
