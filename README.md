# Streak Mate

Live address: **https://streakmate.novaex.pk**

Streak Mate helps students finish their daily work consistently. Students plan tasks, mark them complete and submit them to their teacher. Teachers approve the work or send feedback. Reminders and a motivational streak keep everyone on track.

**Stack:** React 18 + TypeScript + Vite, Tailwind CSS, Supabase (Auth, Postgres, Row Level Security, Realtime, pg_cron, Edge Functions), Web Push.

---

## Features

| Area | What it does |
| --- | --- |
| Authentication | Sign up with a Student or Teacher role, sign in and sign out. Includes form validation, a password visibility toggle, a password strength meter and clear error messages. Each role has its own dashboard. |
| Student dashboard | Create, edit and delete tasks with a title, description, due date and due time. Mark tasks complete and submit them to a teacher. Track status (Pending, Completed, Submitted, Verified, Rejected). Shows today's progress, the streak and a history of feedback. |
| Teacher verification | See pending submissions, open one to review it, then Approve it or Reject it with required feedback. Includes verified history, student progress and a per-student calendar and history. |
| Classes | Teachers create classes with a unique invitation code. They can copy, regenerate or rename a class, and remove students. Students join with the code. Only the class teacher can verify a student's work. |
| Notifications | An in-app notification center with an unread badge. New notifications arrive in real time through Supabase Realtime, with a polling fallback. Browser Web Push is available with the user's permission. |
| Scheduled reminders | `pg_cron` runs in the database every 10 minutes: deadline approaching (24h / 1h), overdue, "submit for verification", and a daily digest for teachers with pending reviews. Each reminder is sent at most once. |
| My Streak | Current and longest streak, a monthly calendar, milestone badges (3, 7, 14, 30, 50 and 100 days) and encouraging messages. All of it is computed on the server. |

### Win Day rule (streak logic)

A local date **D**, in the student's profile timezone, is a **Win Day** when:

1. the student completed at least one task on D, **and**
2. every task due on D was completed on or before D.

The **current streak** counts consecutive Win Days ending today. If today is not yet won, it counts the run ending yesterday, because today is still in progress. Other rules:

- Completion dates are stamped by the database in the student's timezone, never by the browser, so every device shows the same streak.
- Each task has at most one completion record, which is the primary key of `task_completions`. Completing a task twice, or a duplicate submission, can never count twice.
- When a teacher rejects work, its completion is removed until the student redoes it.
- Badges are awarded once and kept.

---

## Architecture

```
React SPA (Vite)  ── anon key + user JWT ──►  Supabase
  │                                            ├─ Auth (email + password)
  │  reads: tables via PostgREST (RLS)         ├─ Postgres
  │  writes: content columns only              │    ├─ RLS on every table + column-level grants
  │  state changes: RPC functions ────────────►│    ├─ SECURITY DEFINER RPCs (complete / submit / review / join)
  │                                            │    ├─ triggers → notifications, streak recompute
  │  ◄── Realtime (new notifications) ─────────│    └─ pg_cron → run_reminders() every 10 min
  │                                            └─ Edge Function `send-push` (cron every minute) ─► Web Push
  └─ Service worker (public/sw.js) shows push notifications
```

**Security model**

- The browser only ever has the public anon key. The service-role key and the VAPID private key live only in Edge Function secrets.
- Clients cannot write `status`, `role` or any verification field. Column-level grants allow editing only task content, profile name and timezone, and the notification `read_at` field.
- Every status transition runs in a server function that checks `auth.uid()`:
  - `set_task_completed`
  - `submit_task`
  - `review_submission`
  - `join_class`
  - `create_class`
- `review_submission` checks three things: the caller is a teacher, the caller is the teacher the submission was sent to, and the student is still in that class.
- The UI shows **Verified** only after `review_submission` returns the new status from the server.
- Teachers only see tasks linked to their class for students currently enrolled. Personal tasks stay private.
- Submitted and verified tasks are locked against edits and deletion.

### Project layout

```
win-streak/
├─ src/
│  ├─ lib/            supabase client, data API, types, dates, validation, push, streak helpers
│  ├─ context/        auth, notifications (realtime), toasts
│  ├─ components/     layout (sidebar/topbar/bell), UI kit, task components, streak calendar
│  └─ pages/          auth/, student/, teacher/, Notifications, Settings
├─ public/sw.js       service worker for Web Push
├─ supabase/
│  ├─ migrations/     001 schema · 002 functions/triggers/RPCs · 003 grants + RLS · 004 pg_cron
│  ├─ functions/send-push/   Edge Function that delivers Web Push
│  ├─ setup/push_cron.sql    one-time SQL to schedule push delivery
│  └─ config.toml
└─ scripts/test-db.mjs   database test-suite (runs the migrations in PGlite)
```

---

## Setup

### Prerequisites

- Node.js 18 or newer (developed on Node 24)
- A free [Supabase](https://supabase.com) project
- Optional: the [Supabase CLI](https://supabase.com/docs/guides/cli), used here through `npx supabase`

### 1. Install

```bash
cd win-streak
npm install
```

### 2. Create the database

**Option A: Supabase CLI (recommended)**

```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase db push          # applies supabase/migrations/*
```

**Option B: SQL editor.** Open *Supabase Dashboard > SQL Editor*, paste all of `supabase/ONE_CLICK_SETUP.sql` and click **Run** (new project). For a project that already has the first migrations, paste `supabase/RUN_THIS_UPDATE.sql` instead; it is safe to run more than once.

> Migration 004 enables `pg_cron`. If it fails, enable **pg_cron** under *Database > Extensions* first and run the file again.

### 3. Configure Auth

In *Authentication > URL Configuration*, set **Site URL** to `http://localhost:5173`. Add your production URL later.

Keep **Confirm email** on. Admin powers and free access only work for confirmed emails.

### Admins

- **Super Admin:** `m.mahadtahir8817api.key@gmail.com` (set in migration 015). Sign up with it and confirm the email. Then run `select public.link_admin_accounts();` in the SQL editor, or run `RUN_THIS_UPDATE.sql` again. This links the email to that account.
- **Other admins**, for example `m.mahadtahir322@gmail.com`: the person signs up and confirms their email. Then the Super Admin opens *Admin > Admins* and presses **Activate** (or adds the email there).
- Admin powers belong to the linked account, not just the email address. Someone who registers an admin email before its owner does not become an admin.

### 4. Environment variables

```bash
cp .env.example .env.local
```

Fill in the values from *Project Settings > API*:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
VITE_VAPID_PUBLIC_KEY=            # optional, see step 6
```

Never put the `service_role` key or the VAPID **private** key in `.env.local`, because every `VITE_` variable is shipped to the browser.

### 5. Run locally

```bash
npm run dev        # http://localhost:5173
```

To try the whole flow:

1. Register a **Teacher**.
2. Go to *Classes & Students* and create a class, then copy its code.
3. In another browser or a private window, register a **Student**.
4. As the student, open *My Classes*, enter the code, then create a task, complete it and submit it.
5. As the teacher, approve the task from *Pending Reviews*. The student gets a notification in real time and the task shows **Verified**.

### 6. Web Push (optional)

```bash
npx web-push generate-vapid-keys
```

1. Put the **public** key in `.env.local` as `VITE_VAPID_PUBLIC_KEY`.
2. Deploy the function and set its secrets:

   ```bash
   npx supabase functions deploy send-push --no-verify-jwt
   npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com PUSH_CRON_SECRET=$(openssl rand -hex 32)
   ```

3. Edit the two placeholders in `supabase/setup/push_cron.sql`: your project URL and the same `PUSH_CRON_SECRET`. Then run the file once in the SQL editor. It enables `pg_net`, stores the values in Vault and schedules delivery every minute.
4. In the app, open *Settings* and choose **Enable push**.

Push requires HTTPS in production. `localhost` also works.

---

## Testing

```bash
npm run test:db    # 289 database tests: RLS, RPC authorization, streak engine, reminders, subscriptions, admins (PGlite)
npm test           # unit tests for date, validation and streak helpers (Vitest)
npm run typecheck  # TypeScript
npm run build      # production build
```

`test:db` runs the real migrations in [PGlite](https://pglite.dev), which is Postgres compiled to WebAssembly. It uses a small stub of Supabase's `auth` schema and API roles, then acts as different users. Among other things it checks that:

- a student cannot change their role, set a task status, or verify work;
- another teacher cannot see or verify a submission;
- duplicate submissions and double completions are rejected;
- rejection requires feedback and revokes the completion;
- the streak and badges are computed correctly;
- reminders are never duplicated.

The `pg_cron` migration, Realtime and the Edge Function are Supabase services and are not covered by this suite.

---

## Deployment

**Frontend:** a static site, deployable to Vercel, Netlify, Cloudflare Pages or similar.

1. Set the build command to `npm run build` and the output directory to `dist`. If the repository root is the parent folder, set the root directory to `win-streak`.
2. Add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and, if you use push, `VITE_VAPID_PUBLIC_KEY`.
3. Deep links already work. The SPA fallback files `vercel.json` (Vercel) and `public/_redirects` (Netlify) are included.
4. In Supabase *Auth > URL Configuration*, set **Site URL** to `https://streakmate.novaex.pk` and add `https://streakmate.novaex.pk/**` to **Redirect URLs** (keep `http://localhost:5173/**` for local testing).
5. In Cloudflare DNS (where novaex.pk is managed), add the record the host shows for `streakmate.novaex.pk`, usually a CNAME. HTTPS is required for fingerprint sign-in and push notifications.

Fingerprint sign-in and push notifications are tied to the web address, so each user turns them on again once on the new address.

**Backend:** run `npx supabase db push` for the migrations. Then follow step 6 for the push function and its cron job.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Supabase is not configured" screen | `.env.local` is missing or still has the placeholder values. Restart `npm run dev` after editing it. |
| "Your profile could not be found" | The migrations were not applied before the user signed up. Apply them, then register again. |
| No reminders arrive | Check that the cron job exists by running `select * from cron.job;`. Run `select public.run_reminders();` manually as the postgres role to test it. |
| Push button missing | `VITE_VAPID_PUBLIC_KEY` is not set, or the browser has no push support. iOS supports push only for installed home-screen apps. |
| Times look off by hours | Update your timezone in *Settings*. Due dates and Win Days use the profile timezone. |
| Admin email has no Admin page, or the banner says the admin access is not active | Confirm the email first. For the Super Admin, run `select public.link_admin_accounts();` in the SQL editor. For any other admin, the Super Admin presses **Activate** in *Admin > Admins*. Then sign out and sign in. |
