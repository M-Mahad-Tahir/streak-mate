-- =====================================================================
-- Win Streak: core schema (tables, constraints, indexes)
-- =====================================================================

-- ---------- Enumerated types ----------
create type public.user_role         as enum ('student', 'teacher');
create type public.task_status       as enum ('pending', 'completed', 'submitted', 'verified', 'rejected');
create type public.submission_status as enum ('submitted', 'verified', 'rejected');
create type public.review_decision   as enum ('approved', 'rejected');

-- ---------- Profiles (1:1 with auth.users) ----------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        public.user_role not null,
  full_name   text not null check (char_length(trim(full_name)) between 1 and 100),
  email       text not null,
  timezone    text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index profiles_role_idx on public.profiles (role);

-- ---------- Classes (owned by a teacher, joined with a code) ----------
create table public.classes (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references public.profiles (id) on delete cascade,
  name        text not null check (char_length(trim(name)) between 1 and 80),
  code        text not null unique check (code ~ '^[A-Z0-9]{6,10}$'),
  created_at  timestamptz not null default now()
);
create index classes_teacher_idx on public.classes (teacher_id);

-- ---------- Class membership (teacher-student relationship) ----------
create table public.class_members (
  class_id    uuid not null references public.classes (id) on delete cascade,
  student_id  uuid not null references public.profiles (id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (class_id, student_id)
);
create index class_members_student_idx on public.class_members (student_id);

-- ---------- Tasks / assignments ----------
create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles (id) on delete cascade,
  class_id      uuid references public.classes (id) on delete set null,
  title         text not null check (char_length(trim(title)) between 1 and 150),
  description   text not null default '' check (char_length(description) <= 5000),
  due_date      date not null,                 -- student's local calendar date
  due_time      time not null default '23:59', -- student's local wall-clock time
  due_at        timestamptz not null,          -- derived by trigger from due_date/due_time/timezone
  status        public.task_status not null default 'pending',
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tasks_completed_at_matches_status check (
    (status in ('pending', 'rejected') and completed_at is null) or
    (status in ('completed', 'submitted', 'verified') and completed_at is not null)
  )
);
create index tasks_student_due_idx   on public.tasks (student_id, due_date);
create index tasks_class_idx         on public.tasks (class_id);
create index tasks_status_due_at_idx on public.tasks (status, due_at);

-- ---------- Completion history (one row per task => a task can never be counted twice) ----------
create table public.task_completions (
  task_id       uuid primary key references public.tasks (id) on delete cascade,
  student_id    uuid not null references public.profiles (id) on delete cascade,
  completed_on  date not null,        -- local date in the student's timezone, stamped by the server
  completed_at  timestamptz not null default now()
);
create index task_completions_student_day_idx on public.task_completions (student_id, completed_on);

-- ---------- Submissions to a teacher ----------
create table public.submissions (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks (id) on delete cascade,
  student_id    uuid not null references public.profiles (id) on delete cascade,
  class_id      uuid not null references public.classes (id) on delete cascade,
  teacher_id    uuid not null references public.profiles (id) on delete cascade,
  note          text not null default '' check (char_length(note) <= 2000),
  status        public.submission_status not null default 'submitted',
  submitted_at  timestamptz not null default now(),
  reviewed_at   timestamptz,
  constraint submissions_review_consistency check (
    (status = 'submitted' and reviewed_at is null) or
    (status <> 'submitted' and reviewed_at is not null)
  )
);
-- At most one open submission per task: blocks duplicate submissions.
create unique index submissions_one_open_per_task on public.submissions (task_id) where status = 'submitted';
create index submissions_teacher_status_idx on public.submissions (teacher_id, status, submitted_at desc);
create index submissions_student_idx        on public.submissions (student_id, submitted_at desc);

-- ---------- Teacher verification records ----------
create table public.verifications (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null unique references public.submissions (id) on delete cascade,
  task_id        uuid not null references public.tasks (id) on delete cascade,
  teacher_id     uuid not null references public.profiles (id) on delete cascade,
  student_id     uuid not null references public.profiles (id) on delete cascade,
  decision       public.review_decision not null,
  feedback       text not null default '' check (char_length(feedback) <= 2000),
  created_at     timestamptz not null default now(),
  constraint verifications_reject_needs_feedback check (
    decision = 'approved' or char_length(trim(feedback)) >= 3
  )
);
create index verifications_student_idx on public.verifications (student_id, created_at desc);
create index verifications_teacher_idx on public.verifications (teacher_id, created_at desc);

-- ---------- Notifications ----------
create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  type          text not null check (type in (
                  'due_soon', 'overdue', 'submit_reminder', 'new_submission',
                  'pending_reviews', 'task_approved', 'task_rejected', 'badge_earned', 'class_joined')),
  title         text not null,
  body          text not null default '',
  link          text,
  dedupe_key    text not null default gen_random_uuid()::text,
  read_at       timestamptz,
  push_sent_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint notifications_dedupe unique (user_id, dedupe_key)
);
create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx  on public.notifications (user_id) where read_at is null;
create index notifications_push_pending_idx on public.notifications (created_at) where push_sent_at is null;

-- ---------- Web Push subscriptions ----------
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique check (endpoint like 'https://%'),
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ---------- Streaks ----------
create table public.streaks (
  student_id      uuid primary key references public.profiles (id) on delete cascade,
  current_streak  integer not null default 0 check (current_streak >= 0),
  longest_streak  integer not null default 0 check (longest_streak >= 0),
  last_win_date   date,
  updated_at      timestamptz not null default now(),
  constraint streaks_longest_ge_current check (longest_streak >= current_streak)
);

-- ---------- Badges (milestones) ----------
create table public.badges (
  student_id  uuid not null references public.profiles (id) on delete cascade,
  code        text not null check (code in ('streak_3', 'streak_7', 'streak_14', 'streak_30', 'streak_50', 'streak_100')),
  earned_at   timestamptz not null default now(),
  primary key (student_id, code)
);
