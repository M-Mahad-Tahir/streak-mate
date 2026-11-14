import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Bot, MessageCircleQuestion, SendHorizontal, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { JAZZCASH_NUMBER, PLANS } from '../lib/api';
import { cx } from './ui';

type Who = 'guest' | 'student' | 'teacher' | 'admin';

interface Topic {
  /** Shown as a suggestion chip and as the heading of the answer. */
  q: string;
  who: Who[] | 'all';
  /** Words or phrases (English and Roman Urdu) that point to this topic. */
  keys: string[];
  a: string;
  link?: { to: string; label: string };
}

const SIGNED_IN: Who[] = ['student', 'teacher', 'admin'];
const MEMBERS: Who[] = ['student', 'teacher'];
const rs = (n: number) => `Rs ${n.toLocaleString('en-PK')}`;

const TOPICS: Topic[] = [
  // Before signing in
  { q: 'How do I create an account?', who: ['guest'], keys: ['sign up', 'signup', 'register', 'create account', 'new account', 'account', 'banana', 'banaon', 'join'],
    a: 'Press Sign up, enter your name, email and a password, and choose Student or Teacher. Open the confirmation email and click the link, then sign in.',
    link: { to: '/signup', label: 'Open Sign up' } },
  { q: 'I forgot my password', who: ['guest'], keys: ['forgot', 'forget', 'reset', 'password', 'bhool', 'bhul', 'yaad'],
    a: 'On the Sign in page press "Forgot password", enter your email and open the link we send you. There you choose a new password.',
    link: { to: '/forgot-password', label: 'Reset password' } },
  { q: 'I did not get the confirmation email', who: ['guest'], keys: ['confirm', 'confirmation', 'email', 'verify email', 'mail', 'link'],
    a: 'Check your Spam or Promotions folder. The email comes from Supabase. If it is still missing, sign up again with the same email after a few minutes.' },

  // Student
  { q: 'How do I add a task?', who: ['student'], keys: ['add task', 'new task', 'create task', 'task', 'add', 'create', 'banao', 'banaun', 'kaam', 'homework'],
    a: 'Open My Tasks and press New task. Enter a title, an optional description, the due date and time, and choose your class if the task is for a teacher. Then save it.',
    link: { to: '/student/tasks', label: 'Open My Tasks' } },
  { q: 'How do I send work to my teacher?', who: ['student'], keys: ['submit', 'send', 'teacher', 'verify', 'verification', 'complete', 'done', 'finish', 'bhejna', 'bhejo', 'jama'],
    a: 'In My Tasks press Mark complete when you finish a task. Then press Submit to teacher, choose the class and add a note if you like. Your teacher will approve it or send feedback.',
    link: { to: '/student/tasks', label: 'Open My Tasks' } },
  { q: 'How do I join my teacher\'s class?', who: ['student'], keys: ['join', 'class', 'code', 'invite', 'invitation'],
    a: 'Ask your teacher for the class code. Open My Classes, type the code and press Join class.',
    link: { to: '/student/classes', label: 'Open My Classes' } },
  { q: 'How does my streak work?', who: ['student'], keys: ['streak', 'win day', 'win', 'badge', 'calendar', 'broke', 'break', 'reset', 'toot', 'tut', 'zero'],
    a: 'A day is a Win Day when you complete at least one task that day and every task due that day is done on time. Win Days in a row make your streak. Missing a due task breaks it. You earn badges at 3, 7, 14, 30, 50 and 100 days.',
    link: { to: '/student/streak', label: 'Open My Streak' } },
  { q: 'My teacher rejected my work', who: ['student'], keys: ['rejected', 'reject', 'feedback', 'redo', 'improve', 'wrong', 'galat'],
    a: 'Open the task to read the teacher feedback (it is also in History & Feedback). Fix the work, press Mark complete again and submit it again.',
    link: { to: '/student/history', label: 'Open History & Feedback' } },
  { q: 'How do I edit or delete a task?', who: ['student'], keys: ['edit task', 'change task', 'edit', 'change', 'delete task', 'remove task', 'delete', 'badalna', 'mitana', 'hatana'],
    a: 'Press Edit or Delete on the task in My Tasks. Tasks that are already submitted or verified are locked, so they cannot be changed.',
    link: { to: '/student/tasks', label: 'Open My Tasks' } },

  // Teacher
  { q: 'How do I create a class?', who: ['teacher'], keys: ['create class', 'new class', 'class', 'code', 'share', 'invite', 'banao'],
    a: 'Open Classes & Students, type a class name and press Create class. Share the class code with your students so they can join. You can rename the class or generate a new code at any time.',
    link: { to: '/teacher/classes', label: 'Open Classes & Students' } },
  { q: 'How do I check student work?', who: ['teacher'], keys: ['review', 'approve', 'reject', 'verify', 'check', 'pending', 'submission', 'work'],
    a: 'Open Pending Reviews and press Review on a submission. Press Approve, or Reject and write what needs improvement. The student is notified right away.',
    link: { to: '/teacher/review', label: 'Open Pending Reviews' } },
  { q: 'How do I see a student\'s progress?', who: ['teacher'], keys: ['student', 'progress', 'remove student', 'history', 'calendar'],
    a: 'Open Classes & Students and click a student to see their calendar and history. Press Remove to take a student out of a class.',
    link: { to: '/teacher/classes', label: 'Open Classes & Students' } },

  // Admin
  { q: 'How do I approve a payment?', who: ['admin'], keys: ['payment', 'approve', 'jazzcash', 'pending', 'tid', 'receipt', 'paise'],
    a: 'Open Payments. Check the receipt screenshot and the Transaction ID (TID) in your JazzCash app, then press Approve. Press Reject and give a reason if it is wrong.',
    link: { to: '/admin/payments', label: 'Open Payments' } },
  { q: 'How do I manage users?', who: ['admin'], keys: ['user', 'users', 'student', 'teacher', 'account', 'trial', 'edit', 'free'],
    a: 'Open All users, Students or Teachers. Press Edit on an account to change the name, role, trial end date or paid plan.',
    link: { to: '/admin/users', label: 'Open All users' } },
  { q: 'How do I add another admin?', who: ['admin'], keys: ['admin', 'add admin', 'activate', 'super admin', 'remove admin'],
    a: 'Only the Super Admin can do this. Open Admins and add the email, or press Activate once that person has signed up and confirmed the email. They then choose a new password with "Forgot password".',
    link: { to: '/admin/admins', label: 'Open Admins' } },

  // Everyone signed in
  { q: 'How much does it cost?', who: MEMBERS, keys: ['price', 'cost', 'fee', 'fees', 'pay', 'payment', 'subscribe', 'subscription', 'plan', 'trial', 'jazzcash', 'paise', 'kitne', 'free'],
    a: `The first 30 days are free. After that it is ${rs(PLANS.monthly.pkr)} a month or ${rs(PLANS.yearly.pkr)} a year. Open Subscription, choose a plan and send the money by JazzCash to ${JAZZCASH_NUMBER}. Then enter your name, number and the Transaction ID (TID) and upload the receipt screenshot. An admin turns on your plan after checking it.`,
    link: { to: '/subscription', label: 'Open Subscription' } },
  { q: 'How do I delete notifications?', who: SIGNED_IN, keys: ['notification', 'notifications', 'bell', 'alert', 'delete notification', 'clear', 'unread'],
    a: 'Open Notifications. Press Delete on one notification, Delete read to remove the ones you have seen, or Delete all. You can also delete them from the bell menu at the top.',
    link: { to: '/notifications', label: 'Open Notifications' } },
  { q: 'How do I turn on reminders on my phone?', who: SIGNED_IN, keys: ['reminder', 'reminders', 'push', 'phone', 'mobile', 'alert'],
    a: 'Open Settings and turn on Browser push notifications, then allow notifications when your browser asks. Reminders come before a task is due and when it is overdue.',
    link: { to: '/settings', label: 'Open Settings' } },
  { q: 'How do I change my password?', who: SIGNED_IN, keys: ['password', 'change password', 'new password', 'forgot', 'bhool'],
    a: 'Open Settings and use the Password section to change your password.',
    link: { to: '/settings', label: 'Open Settings' } },
  { q: 'How do I sign in with my fingerprint?', who: SIGNED_IN, keys: ['fingerprint', 'biometric', 'face', 'passkey', 'finger'],
    a: 'Open Settings and turn on "Fingerprint sign-in on this device". Next time, sign in with your fingerprint or face instead of typing the password.',
    link: { to: '/settings', label: 'Open Settings' } },
  { q: 'How do I change my name or timezone?', who: SIGNED_IN, keys: ['name', 'profile', 'timezone', 'time zone', 'time', 'naam'],
    a: 'Open Settings, change your full name or timezone and press Save changes. Due dates and streak days follow your timezone.',
    link: { to: '/settings', label: 'Open Settings' } },
];

const START: Record<Who, string[]> = {
  guest: ['How do I create an account?', 'I forgot my password'],
  student: ['How do I add a task?', 'How do I send work to my teacher?', 'How does my streak work?', 'How much does it cost?'],
  teacher: ['How do I create a class?', 'How do I check student work?', 'How much does it cost?'],
  admin: ['How do I approve a payment?', 'How do I manage users?', 'How do I add another admin?'],
};

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Best matching topic for a question, or null. Phrases count double, single words also match plurals. */
export function findTopic(text: string, who: Who): Topic | null {
  const t = norm(text);
  let best: Topic | null = null;
  let bestScore = 0;
  for (const topic of TOPICS) {
    if (topic.who !== 'all' && !topic.who.includes(who)) continue;
    let score = norm(topic.q) === t ? 100 : 0;
    for (const k of topic.keys) {
      if (k.includes(' ')) { if (t.includes(` ${k} `)) score += 2; }
      else if (t.includes(` ${k} `) || t.includes(` ${k}s `)) score += 1;
    }
    if (score > bestScore) { best = topic; bestScore = score; }
  }
  return best;
}

interface Msg { id: number; from: 'bot' | 'me'; text: string; link?: Topic['link']; chips?: string[] }

export function HelpBot() {
  const { profile, session } = useAuth();
  const who: Who = session && profile ? profile.role : 'guest';
  const first = profile?.full_name.split(' ')[0];
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const nextId = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const greeting: Msg = {
    id: 0, from: 'bot', chips: START[who],
    text: `Hi${first ? ` ${first}` : ''}! I'm the Streak Mate helper. Ask me how to do anything in the app, or pick a question below.`,
  };

  // Start a fresh chat when the person signs in or out.
  useEffect(() => { setMsgs([]); }, [who]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [msgs]);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q) return;
    const topic = findTopic(q, who);
    const t = norm(q);
    let reply: Omit<Msg, 'id'>;
    if (topic) reply = { from: 'bot', text: topic.a, link: topic.link };
    else if (/ (hi|hello|hey|salam|assalam|aoa|assalamualaikum) /.test(t)) reply = { from: 'bot', text: 'Hello! What would you like to do?', chips: START[who] };
    else if (/ (thanks|thank|shukriya|shukria|thx|ok|okay) /.test(t)) reply = { from: 'bot', text: "You're welcome! Ask me anything else any time." };
    else reply = { from: 'bot', chips: START[who], text: "Sorry, I don't know that one yet. Try asking in a few simple words, or pick one of these questions. For anything else, ask your teacher or the admin." };
    setMsgs((m) => [...m, { id: nextId.current++, from: 'me', text: q }, { id: nextId.current++, ...reply }]);
    setText('');
  };

  const submit = (e: FormEvent) => { e.preventDefault(); ask(text); };

  return (
    <>
      {open && (
        <section role="dialog" aria-label="Streak Mate helper"
          className="fixed inset-x-3 bottom-20 z-[35] flex max-h-[calc(100dvh-6.5rem)] animate-fade-in flex-col overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-2xl sm:inset-x-auto sm:right-6 sm:w-[23rem] sm:max-h-[34rem]">
          <header className="flex items-center gap-3 bg-brand-gradient px-4 py-3 text-white">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15"><Bot className="h-5 w-5" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight">Streak Mate helper</p>
              <p className="text-xs text-white/80">Ask how to use the app</p>
            </div>
            <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-white/80 hover:bg-white/10 hover:text-white" aria-label="Close helper">
              <X className="h-5 w-5" />
            </button>
          </header>
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4" aria-live="polite">
            {[greeting, ...msgs].map((m) => (
              <div key={m.id} className={cx('flex', m.from === 'me' ? 'justify-end' : 'justify-start')}>
                <div className={cx('max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm [overflow-wrap:anywhere]',
                  m.from === 'me' ? 'rounded-br-md bg-brand-gradient text-white' : 'rounded-bl-md border border-slate-200 bg-surface text-slate-700')}>
                  <p className="whitespace-pre-line">{m.text}</p>
                  {m.link && (
                    <button onClick={() => { navigate(m.link!.to); if (window.innerWidth < 640) setOpen(false); }}
                      className="mt-2 inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline">
                      {m.link.label}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                  {m.chips && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {m.chips.map((c) => (
                        <button key={c} onClick={() => ask(c)}
                          className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-left text-xs font-medium text-brand-700 hover:bg-brand-100">
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={submit} className="flex items-center gap-2 border-t border-slate-200 bg-surface p-3">
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
              placeholder="Type your question..." aria-label="Your question"
              className="min-w-0 flex-1 rounded-full border border-slate-300 px-4 py-2 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 sm:text-sm" />
            <button type="submit" disabled={!text.trim()} aria-label="Send"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white hover:brightness-110 disabled:opacity-40">
              <SendHorizontal className="h-4 w-4" />
            </button>
          </form>
        </section>
      )}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Hide helper' : 'Need help? Ask the helper'}
        title="Need help?"
        className="fixed bottom-4 right-4 z-[35] flex h-14 w-14 items-center justify-center rounded-full bg-brand-gradient text-white shadow-lg shadow-brand-900/25 ring-4 ring-surface transition-transform hover:scale-105 sm:right-6">
        {open ? <X className="h-6 w-6" /> : <MessageCircleQuestion className="h-6 w-6" />}
      </button>
    </>
  );
}
