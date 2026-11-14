-- Win Streak: complete database setup. Paste this whole file into Supabase > SQL Editor and click Run.
-- (For a NEW project only. If you already ran an older version, run RUN_THIS_UPDATE.sql instead.)
begin;

-- ===== migrations/20261022000001_schema.sql =====
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

-- ===== migrations/20261022000002_functions.sql =====
-- =====================================================================
-- Win Streak: helper functions, triggers, RPCs, streak engine, reminders
-- All state transitions (complete / submit / review / join) go through
-- SECURITY DEFINER functions that check auth.uid() on the server.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small helpers used by RLS policies. They only ever answer questions
-- about the *calling* user, so they cannot be used to probe other users.
-- ---------------------------------------------------------------------
create or replace function public.my_role()
returns public.user_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.i_am_member(p_class uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.class_members
                 where class_id = p_class and student_id = auth.uid())
$$;

create or replace function public.i_teach_class(p_class uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.classes
                 where id = p_class and teacher_id = auth.uid())
$$;

-- Caller teaches the given student in at least one class.
create or replace function public.i_teach(p_student uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.classes c
                 join public.class_members m on m.class_id = c.id
                 where c.teacher_id = auth.uid() and m.student_id = p_student)
$$;

-- Caller teaches the given student in this specific class.
create or replace function public.i_teach_student_in(p_class uuid, p_student uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.classes c
                 join public.class_members m on m.class_id = c.id
                 where c.id = p_class and c.teacher_id = auth.uid() and m.student_id = p_student)
$$;

-- Given user is a teacher of one of the caller's classes.
create or replace function public.is_my_teacher(p_teacher uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.classes c
                 join public.class_members m on m.class_id = c.id
                 where c.teacher_id = p_teacher and m.student_id = auth.uid())
$$;

-- Local "today" for a user, based on their profile timezone.
create or replace function public.local_today(p_user uuid)
returns date
language sql stable security definer set search_path = public
as $$
  select (now() at time zone coalesce((select timezone from public.profiles where id = p_user), 'UTC'))::date
$$;

-- Internal: insert a notification once per (user, dedupe_key).
create or replace function public.notify(
  p_user uuid, p_type text, p_title text, p_body text, p_link text, p_dedupe text default null)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_count int;
begin
  insert into public.notifications (user_id, type, title, body, link, dedupe_key)
  values (p_user, p_type, p_title, coalesce(p_body, ''), p_link, coalesce(p_dedupe, gen_random_uuid()::text))
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------
-- Profiles: created automatically on sign-up with the chosen role.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_role public.user_role;
  v_name text;
  v_tz   text;
begin
  v_role := case lower(coalesce(new.raw_user_meta_data ->> 'role', 'student'))
              when 'teacher' then 'teacher'::public.user_role
              else 'student'::public.user_role end;
  v_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  v_name := left(coalesce(v_name, split_part(coalesce(new.email, 'User'), '@', 1)), 100);
  v_tz   := coalesce(new.raw_user_meta_data ->> 'timezone', 'UTC');
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;

  insert into public.profiles (id, role, full_name, email, timezone)
  values (new.id, v_role, v_name, coalesce(new.email, ''), v_tz);

  if v_role = 'student' then
    insert into public.streaks (student_id) values (new.id);
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.profiles_validate()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.timezone is distinct from old.timezone
     and not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown timezone: %', new.timezone using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_validate before update on public.profiles
  for each row execute function public.profiles_validate();

-- ---------------------------------------------------------------------
-- Tasks: derive due_at, protect submitted/verified work from edits.
-- ---------------------------------------------------------------------
create or replace function public.tasks_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_tz text;
begin
  if tg_op = 'INSERT' then
    -- New tasks always start pending regardless of what the client sent.
    new.status := 'pending';
    new.completed_at := null;
  elsif old.status in ('submitted', 'verified') and (
          new.title is distinct from old.title or
          new.description is distinct from old.description or
          new.due_date is distinct from old.due_date or
          new.due_time is distinct from old.due_time or
          (new.class_id is distinct from old.class_id
            -- allow the FK "on delete set null" when the class itself was deleted
            and not (new.class_id is null and not exists (select 1 from public.classes where id = old.class_id)))) then
    raise exception 'This task has been submitted and can no longer be edited.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' or new.due_date is distinct from old.due_date or new.due_time is distinct from old.due_time then
    select timezone into v_tz from public.profiles where id = new.student_id;
    new.due_at := (new.due_date + new.due_time) at time zone coalesce(v_tz, 'UTC');
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- ---------------------------------------------------------------------
-- Streak engine
--
-- WIN DAY RULE (local date D in the student's timezone):
--   1. The student completed at least one task on D, and
--   2. every task due on D was completed on or before D.
-- Completion dates are stamped by the server in the student's timezone, and
-- each task has at most one completion row, so a task is never counted twice.
-- Rejected work loses its completion until it is redone.
--
-- CURRENT STREAK: consecutive win days ending today, or ending yesterday
-- if today is not won yet (today is still in progress).
-- ---------------------------------------------------------------------
create or replace function public.win_days(p_student uuid)
returns table (day date)
language sql stable security definer set search_path = public
as $$
  select c.completed_on
  from public.task_completions c
  where c.student_id = p_student
  group by c.completed_on
  having not exists (
    select 1 from public.tasks t
    left join public.task_completions tc on tc.task_id = t.id
    where t.student_id = p_student
      and t.due_date = c.completed_on
      and (tc.task_id is null or tc.completed_on > t.due_date)
  )
$$;

create or replace function public.recompute_streak(p_student uuid)
returns public.streaks
language plpgsql security definer set search_path = public
as $$
declare
  v_today   date := public.local_today(p_student);
  v_run     int := 0;
  v_longest int := 0;
  v_current int := 0;
  v_prev    date;
  v_day     date;
  v_badge   record;
  v_row     public.streaks;
begin
  for v_day in select w.day from public.win_days(p_student) w order by w.day loop
    if v_prev is not null and v_day = v_prev + 1 then
      v_run := v_run + 1;
    else
      v_run := 1;
    end if;
    v_longest := greatest(v_longest, v_run);
    v_prev := v_day;
  end loop;

  if v_prev is not null and v_prev >= v_today - 1 then
    v_current := v_run;
  end if;

  insert into public.streaks as s (student_id, current_streak, longest_streak, last_win_date, updated_at)
  values (p_student, v_current, v_longest, v_prev, now())
  on conflict (student_id) do update
    set current_streak = excluded.current_streak,
        longest_streak = excluded.longest_streak,
        last_win_date  = excluded.last_win_date,
        updated_at     = now()
  returning * into v_row;

  -- Milestone badges (awarded once, kept forever).
  for v_badge in
    select * from (values (3, 'streak_3', '3-day streak'), (7, 'streak_7', '1-week streak'),
                          (14, 'streak_14', '2-week streak'), (30, 'streak_30', '30-day streak'),
                          (50, 'streak_50', '50-day streak'), (100, 'streak_100', '100-day streak'))
      as b(threshold, code, label)
    where b.threshold <= v_longest
  loop
    insert into public.badges (student_id, code) values (p_student, v_badge.code)
    on conflict do nothing;
    if found then
      perform public.notify(p_student, 'badge_earned', 'New badge: ' || v_badge.label || '!',
        'Amazing consistency. You reached a ' || v_badge.threshold || '-day Win Streak.',
        '/student/streak', 'badge:' || v_badge.code);
    end if;
  end loop;

  return v_row;
end $$;

-- ---------------------------------------------------------------------
-- Classes
-- ---------------------------------------------------------------------
create or replace function public.generate_class_code()
returns text language plpgsql volatile set search_path = public
as $$
declare v_code text;
begin
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.classes where code = v_code);
  end loop;
  return v_code;
end $$;

create or replace function public.create_class(p_name text)
returns public.classes
language plpgsql security definer set search_path = public
as $$
declare v_row public.classes;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.my_role() is distinct from 'teacher' then
    raise exception 'Only teachers can create classes.' using errcode = '42501';
  end if;
  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'Class name is required.' using errcode = '22023';
  end if;
  insert into public.classes (teacher_id, name, code)
  values (auth.uid(), trim(p_name), public.generate_class_code())
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.regenerate_class_code(p_class uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_code text := public.generate_class_code();
begin
  update public.classes set code = v_code where id = p_class and teacher_id = auth.uid();
  if not found then raise exception 'Class not found.' using errcode = '42501'; end if;
  return v_code;
end $$;

create or replace function public.join_class(p_code text)
returns public.classes
language plpgsql security definer set search_path = public
as $$
declare
  v_class public.classes;
  v_name  text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.my_role() is distinct from 'student' then
    raise exception 'Only students can join a class.' using errcode = '42501';
  end if;
  select * into v_class from public.classes where code = upper(trim(coalesce(p_code, '')));
  if not found then
    raise exception 'No class found with that code. Check the code with your teacher.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.class_members where class_id = v_class.id and student_id = auth.uid()) then
    raise exception 'You are already in this class.' using errcode = '23505';
  end if;
  insert into public.class_members (class_id, student_id) values (v_class.id, auth.uid());

  select full_name into v_name from public.profiles where id = auth.uid();
  perform public.notify(v_class.teacher_id, 'class_joined', v_name || ' joined ' || v_class.name,
    'A new student joined your class.', '/teacher/classes',
    'joined:' || v_class.id || ':' || auth.uid());
  return v_class;
end $$;

-- When a student leaves / is removed, withdraw their open submissions to that class.
create or replace function public.class_members_after_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.tasks t set status = 'completed'
  from public.submissions s
  where s.task_id = t.id and s.class_id = old.class_id and s.student_id = old.student_id
    and s.status = 'submitted';
  delete from public.submissions
  where class_id = old.class_id and student_id = old.student_id and status = 'submitted';
  -- Unlink unfinished tasks so the student can keep editing them (verified work keeps its link as history).
  update public.tasks set class_id = null
  where class_id = old.class_id and student_id = old.student_id
    and status in ('pending', 'completed', 'rejected');
  return old;
end $$;

create trigger class_members_after_delete after delete on public.class_members
  for each row execute function public.class_members_after_delete();

-- Deleting a class returns its open submissions to "completed" before cascades run.
create or replace function public.classes_before_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.tasks t set status = 'completed'
  from public.submissions s
  where s.task_id = t.id and s.class_id = old.id and s.status = 'submitted';
  return old;
end $$;

create trigger classes_before_delete before delete on public.classes
  for each row execute function public.classes_before_delete();

-- ---------------------------------------------------------------------
-- Student actions
-- ---------------------------------------------------------------------
create or replace function public.set_task_completed(p_task uuid, p_done boolean)
returns public.tasks
language plpgsql security definer set search_path = public
as $$
declare v_task public.tasks;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_task from public.tasks where id = p_task and student_id = auth.uid() for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;

  if p_done then
    if v_task.status not in ('pending', 'rejected') then
      raise exception 'This task is already completed.' using errcode = '22023';
    end if;
    update public.tasks set status = 'completed', completed_at = now()
      where id = p_task returning * into v_task;
    insert into public.task_completions (task_id, student_id, completed_on, completed_at)
      values (p_task, auth.uid(), public.local_today(auth.uid()), now())
      on conflict (task_id) do nothing;
  else
    if v_task.status <> 'completed' then
      raise exception 'Only completed tasks that are not yet submitted can be reopened.' using errcode = '22023';
    end if;
    update public.tasks set status = 'pending', completed_at = null
      where id = p_task returning * into v_task;
    delete from public.task_completions where task_id = p_task;
  end if;

  perform public.recompute_streak(auth.uid());
  return v_task;
end $$;

create or replace function public.submit_task(p_task uuid, p_class uuid default null, p_note text default '')
returns public.submissions
language plpgsql security definer set search_path = public
as $$
declare
  v_task    public.tasks;
  v_class   public.classes;
  v_sub     public.submissions;
  v_student text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_task from public.tasks where id = p_task and student_id = auth.uid() for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  if v_task.status = 'submitted' then
    raise exception 'This task is already waiting for review.' using errcode = '23505';
  end if;
  if v_task.status = 'verified' then
    raise exception 'This task is already verified.' using errcode = '23505';
  end if;
  if v_task.status <> 'completed' then
    raise exception 'Mark the task as completed before submitting it.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_note, '')) > 2000 then
    raise exception 'Submission note is too long (max 2000 characters).' using errcode = '22023';
  end if;

  select * into v_class from public.classes where id = coalesce(p_class, v_task.class_id);
  if not found then
    raise exception 'Choose the class (teacher) to submit this task to.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.class_members where class_id = v_class.id and student_id = auth.uid()) then
    raise exception 'You are not a member of that class.' using errcode = '42501';
  end if;

  insert into public.submissions (task_id, student_id, class_id, teacher_id, note)
  values (p_task, auth.uid(), v_class.id, v_class.teacher_id, coalesce(trim(p_note), ''))
  returning * into v_sub;

  update public.tasks set status = 'submitted', class_id = v_class.id where id = p_task;

  select full_name into v_student from public.profiles where id = auth.uid();
  perform public.notify(v_class.teacher_id, 'new_submission',
    'New submission from ' || v_student,
    v_task.title || ' (' || v_class.name || ')', '/teacher/review?submission=' || v_sub.id,
    'submission:' || v_sub.id);
  return v_sub;
end $$;

-- ---------------------------------------------------------------------
-- Teacher action: approve or reject. Only the assigned teacher of a
-- current class member can do this; the server is the source of truth.
-- ---------------------------------------------------------------------
create or replace function public.review_submission(
  p_submission uuid, p_decision public.review_decision, p_feedback text default '')
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_sub    public.submissions;
  v_task   public.tasks;
  v_new    public.task_status;
  v_ver    public.verifications;
  v_fb     text := trim(coalesce(p_feedback, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.my_role() is distinct from 'teacher' then
    raise exception 'Only teachers can review submissions.' using errcode = '42501';
  end if;

  select * into v_sub from public.submissions where id = p_submission for update;
  if not found or v_sub.teacher_id <> auth.uid() then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if v_sub.status <> 'submitted' then
    raise exception 'This submission has already been reviewed.' using errcode = '23505';
  end if;
  if not public.i_teach_student_in(v_sub.class_id, v_sub.student_id) then
    raise exception 'This student is no longer in your class.' using errcode = '42501';
  end if;
  if p_decision = 'rejected' and char_length(v_fb) < 3 then
    raise exception 'Please explain what needs improvement (at least 3 characters).' using errcode = '22023';
  end if;
  if char_length(v_fb) > 2000 then
    raise exception 'Feedback is too long (max 2000 characters).' using errcode = '22023';
  end if;

  v_new := case p_decision when 'approved' then 'verified' else 'rejected' end;

  update public.submissions
     set status = (case p_decision when 'approved' then 'verified' else 'rejected' end)::public.submission_status,
         reviewed_at = now()
   where id = p_submission;

  insert into public.verifications (submission_id, task_id, teacher_id, student_id, decision, feedback)
  values (v_sub.id, v_sub.task_id, auth.uid(), v_sub.student_id, p_decision, v_fb)
  returning * into v_ver;

  if v_new = 'rejected' then
    update public.tasks set status = 'rejected', completed_at = null where id = v_sub.task_id returning * into v_task;
    delete from public.task_completions where task_id = v_sub.task_id;
    perform public.recompute_streak(v_sub.student_id);
    perform public.notify(v_sub.student_id, 'task_rejected', 'Needs improvement: ' || v_task.title,
      v_fb, '/student/history', 'review:' || v_ver.id);
  else
    update public.tasks set status = 'verified' where id = v_sub.task_id returning * into v_task;
    perform public.notify(v_sub.student_id, 'task_approved', 'Verified: ' || v_task.title,
      coalesce(nullif(v_fb, ''), 'Your teacher approved your work. Great job!'),
      '/student/history', 'review:' || v_ver.id);
  end if;

  return json_build_object('submission_id', v_sub.id, 'task_id', v_sub.task_id,
                           'task_status', v_task.status, 'verification_id', v_ver.id,
                           'reviewed_at', v_ver.created_at);
end $$;

-- ---------------------------------------------------------------------
-- Read helpers
-- ---------------------------------------------------------------------
create or replace function public.get_my_streak()
returns public.streaks
language plpgsql security definer set search_path = public
as $$
begin
  if public.my_role() is distinct from 'student' then
    raise exception 'Only students have streaks.' using errcode = '42501';
  end if;
  return public.recompute_streak(auth.uid());
end $$;

-- Calendar data for the student themself, or for a teacher of that student.
create or replace function public.get_win_calendar(p_from date, p_to date, p_student uuid default null)
returns table (day date, completed_count int, due_count int, is_win boolean)
language plpgsql stable security definer set search_path = public
as $$
declare v_student uuid := coalesce(p_student, auth.uid());
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if v_student <> auth.uid() and not public.i_teach(v_student) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'Invalid date range.' using errcode = '22023';
  end if;

  return query
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  wins as (select w.day from public.win_days(v_student) w)
  select days.day,
         (select count(*)::int from public.task_completions c
            where c.student_id = v_student and c.completed_on = days.day),
         (select count(*)::int from public.tasks t
            where t.student_id = v_student and t.due_date = days.day),
         exists (select 1 from wins where wins.day = days.day)
  from days order by days.day;
end $$;

-- Teacher overview of every student across their classes.
create or replace function public.teacher_student_overview()
returns table (
  student_id uuid, full_name text, email text, class_id uuid, class_name text, joined_at timestamptz,
  current_streak int, longest_streak int, class_tasks int, verified_tasks int, pending_reviews int)
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.my_role() is distinct from 'teacher' then
    raise exception 'Only teachers can view this.' using errcode = '42501';
  end if;
  return query
  select p.id, p.full_name, p.email, c.id, c.name, m.joined_at,
         coalesce(s.current_streak, 0), coalesce(s.longest_streak, 0),
         (select count(*)::int from public.tasks t where t.student_id = p.id and t.class_id = c.id),
         (select count(*)::int from public.tasks t where t.student_id = p.id and t.class_id = c.id and t.status = 'verified'),
         (select count(*)::int from public.submissions sb where sb.student_id = p.id and sb.class_id = c.id and sb.status = 'submitted')
  from public.classes c
  join public.class_members m on m.class_id = c.id
  join public.profiles p on p.id = m.student_id
  left join public.streaks s on s.student_id = p.id
  where c.teacher_id = auth.uid()
  order by c.name, p.full_name;
end $$;

-- Save (or move) a Web Push subscription for the current user.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Invalid push subscription.' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- ---------------------------------------------------------------------
-- Scheduled reminders (run by pg_cron; see the cron migration).
-- Dedupe keys guarantee each reminder is sent at most once.
-- ---------------------------------------------------------------------
create or replace function public.run_reminders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_sent int := 0;
  r record;
begin
  -- 1. Deadline approaching (24h and 1h windows).
  for r in
    select t.id, t.student_id, t.title, t.due_at
    from public.tasks t
    where t.status in ('pending', 'rejected') and t.due_at > now() and t.due_at <= now() + interval '24 hours'
  loop
    if r.due_at <= now() + interval '1 hour' then
      if public.notify(r.student_id, 'due_soon', 'Due within the hour: ' || r.title,
           'Finish it now to protect your Win Streak.', '/student/tasks', 'due1:' || r.id) then
        v_sent := v_sent + 1; end if;
    elsif public.notify(r.student_id, 'due_soon', 'Due soon: ' || r.title,
           'This task is due in less than 24 hours.', '/student/tasks', 'due24:' || r.id) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  -- 2. Overdue and still incomplete (looks back 7 days).
  for r in
    select t.id, t.student_id, t.title
    from public.tasks t
    where t.status in ('pending', 'rejected') and t.due_at <= now() and t.due_at > now() - interval '7 days'
  loop
    if public.notify(r.student_id, 'overdue', 'Overdue: ' || r.title,
         'This task passed its deadline and is not complete yet.', '/student/tasks', 'overdue:' || r.id) then
      v_sent := v_sent + 1; end if;
  end loop;

  -- 3. Completed but not submitted (once per local day, only if the student has a class).
  for r in
    select t.id, t.student_id, t.title
    from public.tasks t
    where t.status = 'completed' and t.completed_at <= now() - interval '1 hour'
      and exists (select 1 from public.class_members m where m.student_id = t.student_id)
  loop
    if public.notify(r.student_id, 'submit_reminder', 'Submit for verification: ' || r.title,
         'You finished this task. Send it to your teacher to get it verified.', '/student/tasks',
         'submit:' || r.id || ':' || public.local_today(r.student_id)) then
      v_sent := v_sent + 1; end if;
  end loop;

  -- 4. Teachers with submissions waiting more than 12 hours (one digest per local day).
  for r in
    select s.teacher_id, count(*) as waiting
    from public.submissions s
    where s.status = 'submitted' and s.submitted_at <= now() - interval '12 hours'
    group by s.teacher_id
  loop
    if public.notify(r.teacher_id, 'pending_reviews', r.waiting || ' submission(s) waiting for review',
         'Your students are waiting for verification.', '/teacher/review',
         'pending:' || public.local_today(r.teacher_id)) then
      v_sent := v_sent + 1; end if;
  end loop;

  -- 5. Roll over streaks that ended because a day passed without a win.
  for r in
    select s.student_id from public.streaks s
    where s.current_streak > 0 and s.last_win_date < public.local_today(s.student_id) - 1
  loop
    perform public.recompute_streak(r.student_id);
  end loop;

  return v_sent;
end $$;

-- ===== migrations/20261022000003_security.sql =====
-- =====================================================================
-- Win Streak: privileges and Row Level Security
-- Principle: clients may only read rows they are entitled to and may only
-- write "content" columns. Every status transition goes through an RPC.
-- =====================================================================

-- ---------- Table privileges ----------
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

-- profiles: users may edit their name and timezone (never their role).
grant update (full_name, timezone) on public.profiles to authenticated;

-- classes: teachers may rename / delete their own classes (created via RPC).
grant update (name) on public.classes to authenticated;
grant delete on public.classes to authenticated;

-- class_members: teacher removes a student, or a student leaves (joined via RPC).
grant delete on public.class_members to authenticated;

-- tasks: students write content columns only; status changes via RPC.
alter table public.tasks alter column student_id set default auth.uid();
grant insert (student_id, class_id, title, description, due_date, due_time) on public.tasks to authenticated;
grant update (class_id, title, description, due_date, due_time) on public.tasks to authenticated;
grant delete on public.tasks to authenticated;

-- notifications: mark read / dismiss.
grant update (read_at) on public.notifications to authenticated;
grant delete on public.notifications to authenticated;

-- push subscriptions: saved via RPC, removed directly.
grant delete on public.push_subscriptions to authenticated;

-- ---------- Function privileges ----------
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema public from authenticated;

-- Helpers referenced inside RLS policies (they only describe the caller).
grant execute on function public.my_role()                         to authenticated;
grant execute on function public.i_am_member(uuid)                 to authenticated;
grant execute on function public.i_teach_class(uuid)               to authenticated;
grant execute on function public.i_teach(uuid)                     to authenticated;
grant execute on function public.i_teach_student_in(uuid, uuid)    to authenticated;
grant execute on function public.is_my_teacher(uuid)               to authenticated;

-- Public API (RPCs).
grant execute on function public.create_class(text)                                     to authenticated;
grant execute on function public.regenerate_class_code(uuid)                            to authenticated;
grant execute on function public.join_class(text)                                       to authenticated;
grant execute on function public.set_task_completed(uuid, boolean)                      to authenticated;
grant execute on function public.submit_task(uuid, uuid, text)                          to authenticated;
grant execute on function public.review_submission(uuid, public.review_decision, text)  to authenticated;
grant execute on function public.get_my_streak()                                        to authenticated;
grant execute on function public.get_win_calendar(date, date, uuid)                     to authenticated;
grant execute on function public.teacher_student_overview()                             to authenticated;
grant execute on function public.save_push_subscription(text, text, text)               to authenticated;
-- Internal only (no grant): notify, recompute_streak, win_days, local_today,
-- run_reminders, generate_class_code, trigger functions.

-- ---------- Enable RLS everywhere ----------
alter table public.profiles           enable row level security;
alter table public.classes            enable row level security;
alter table public.class_members      enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_completions   enable row level security;
alter table public.submissions        enable row level security;
alter table public.verifications      enable row level security;
alter table public.notifications      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.streaks            enable row level security;
alter table public.badges             enable row level security;

-- ---------- profiles ----------
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.i_teach(id) or public.is_my_teacher(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------- classes ----------
create policy classes_select on public.classes for select to authenticated
  using (teacher_id = auth.uid() or public.i_am_member(id));
create policy classes_update on public.classes for update to authenticated
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy classes_delete on public.classes for delete to authenticated
  using (teacher_id = auth.uid());

-- ---------- class_members ----------
create policy members_select on public.class_members for select to authenticated
  using (student_id = auth.uid() or public.i_teach_class(class_id));
create policy members_delete on public.class_members for delete to authenticated
  using (student_id = auth.uid() or public.i_teach_class(class_id));

-- ---------- tasks ----------
-- Teachers only see tasks linked to their class, for students still enrolled.
create policy tasks_select on public.tasks for select to authenticated
  using (student_id = auth.uid()
         or (class_id is not null and public.i_teach_student_in(class_id, student_id)));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (student_id = auth.uid()
              and public.my_role() = 'student'
              and (class_id is null or public.i_am_member(class_id)));
create policy tasks_update on public.tasks for update to authenticated
  using (student_id = auth.uid())
  with check (student_id = auth.uid() and (class_id is null or public.i_am_member(class_id)));
create policy tasks_delete on public.tasks for delete to authenticated
  using (student_id = auth.uid() and status in ('pending', 'completed', 'rejected'));

-- ---------- task_completions (private to the student) ----------
create policy completions_select on public.task_completions for select to authenticated
  using (student_id = auth.uid());

-- ---------- submissions & verifications ----------
create policy submissions_select on public.submissions for select to authenticated
  using (student_id = auth.uid() or teacher_id = auth.uid());
create policy verifications_select on public.verifications for select to authenticated
  using (student_id = auth.uid() or teacher_id = auth.uid());

-- ---------- notifications ----------
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());

-- ---------- push_subscriptions ----------
create policy push_select on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy push_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- ---------- streaks & badges ----------
create policy streaks_select on public.streaks for select to authenticated
  using (student_id = auth.uid() or public.i_teach(student_id));
create policy badges_select on public.badges for select to authenticated
  using (student_id = auth.uid() or public.i_teach(student_id));

-- ---------- Realtime: stream new notifications to the app ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- ===== migrations/20261022000004_cron.sql =====
-- =====================================================================
-- Win Streak: scheduled reminders with pg_cron (runs inside the database,
-- so reminders work even when nobody has the app open).
-- =====================================================================
create extension if not exists pg_cron;

-- Every 10 minutes: due-soon, overdue, submit, pending-review reminders and streak roll-over.
select cron.schedule(
  'win-streak-reminders',
  '*/10 * * * *',
  $$ select public.run_reminders(); $$
);

-- ===== migrations/20261023000005_delete_any_task.sql =====
-- =====================================================================
-- Win Streak: delete any task (including verified ones) + rocket calendar
-- Finished or submitted work is archived instead of erased, so the student's
-- streak and the teacher's verification records stay intact.
-- =====================================================================

alter table public.tasks add column if not exists archived_at timestamptz;
create index if not exists tasks_student_active_idx on public.tasks (student_id, due_at) where archived_at is null;

-- Archived tasks can no longer be edited.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (student_id = auth.uid() and archived_at is null)
  with check (student_id = auth.uid() and (class_id is null or public.i_am_member(class_id)));

-- Direct deletes are only allowed for untouched tasks; everything else uses delete_task().
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (student_id = auth.uid() and status = 'pending'
         and not exists (select 1 from public.submissions s where s.task_id = tasks.id));

-- Delete a task of any status.
--  * never finished and never submitted  -> removed permanently
--  * waiting for review                  -> withdrawn from the teacher, then archived
--  * completed / verified / reviewed      -> archived (hidden from the list, history kept)
create or replace function public.delete_task(p_task uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_task public.tasks;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_task from public.tasks
   where id = p_task and student_id = auth.uid() and archived_at is null for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;

  if v_task.status = 'submitted' then
    delete from public.submissions where task_id = p_task and status = 'submitted';
    update public.tasks set status = 'completed' where id = p_task;
  end if;

  if exists (select 1 from public.task_completions where task_id = p_task)
     or exists (select 1 from public.submissions where task_id = p_task) then
    update public.tasks set archived_at = now() where id = p_task;
    perform public.recompute_streak(auth.uid());
    return 'archived';
  end if;

  delete from public.tasks where id = p_task;
  perform public.recompute_streak(auth.uid());
  return 'deleted';
end $$;

revoke execute on function public.delete_task(uuid) from public, anon;
grant execute on function public.delete_task(uuid) to authenticated;

-- Removed tasks no longer count as "due" for the Win Day rule.
create or replace function public.win_days(p_student uuid)
returns table (day date)
language sql stable security definer set search_path = public
as $$
  select c.completed_on
  from public.task_completions c
  where c.student_id = p_student
  group by c.completed_on
  having not exists (
    select 1 from public.tasks t
    left join public.task_completions tc on tc.task_id = t.id
    where t.student_id = p_student
      and t.due_date = c.completed_on
      and t.archived_at is null
      and (tc.task_id is null or tc.completed_on > t.due_date)
  )
$$;

-- Calendar now also reports work verified by a teacher (shown as a rocket).
drop function if exists public.get_win_calendar(date, date, uuid);
create function public.get_win_calendar(p_from date, p_to date, p_student uuid default null)
returns table (day date, completed_count int, due_count int, verified_count int, is_win boolean)
language plpgsql stable security definer set search_path = public
as $$
declare v_student uuid := coalesce(p_student, auth.uid());
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if v_student <> auth.uid() and not public.i_teach(v_student) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'Invalid date range.' using errcode = '22023';
  end if;

  return query
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  wins as (select w.day from public.win_days(v_student) w)
  select days.day,
         (select count(*)::int from public.task_completions c
            where c.student_id = v_student and c.completed_on = days.day),
         (select count(*)::int from public.tasks t
            where t.student_id = v_student and t.due_date = days.day and t.archived_at is null),
         (select count(*)::int from public.task_completions c
            join public.tasks t on t.id = c.task_id
            where c.student_id = v_student and c.completed_on = days.day and t.status = 'verified'),
         exists (select 1 from wins where wins.day = days.day)
  from days order by days.day;
end $$;

revoke execute on function public.get_win_calendar(date, date, uuid) from public, anon;
grant execute on function public.get_win_calendar(date, date, uuid) to authenticated;

-- Reminders skip tasks the student removed.
create or replace function public.run_reminders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_sent int := 0;
  r record;
begin
  -- 1. Deadline approaching (24h and 1h windows).
  for r in
    select t.id, t.student_id, t.title, t.due_at
    from public.tasks t
    where t.archived_at is null and t.status in ('pending', 'rejected') and t.due_at > now() and t.due_at <= now() + interval '24 hours'
  loop
    if r.due_at <= now() + interval '1 hour' then
      if public.notify(r.student_id, 'due_soon', 'Due within the hour: ' || r.title,
           'Finish it now to protect your Win Streak.', '/student/tasks', 'due1:' || r.id) then
        v_sent := v_sent + 1; end if;
    elsif public.notify(r.student_id, 'due_soon', 'Due soon: ' || r.title,
           'This task is due in less than 24 hours.', '/student/tasks', 'due24:' || r.id) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  -- 2. Overdue and still incomplete (looks back 7 days).
  for r in
    select t.id, t.student_id, t.title
    from public.tasks t
    where t.archived_at is null and t.status in ('pending', 'rejected') and t.due_at <= now() and t.due_at > now() - interval '7 days'
  loop
    if public.notify(r.student_id, 'overdue', 'Overdue: ' || r.title,
         'This task passed its deadline and is not complete yet.', '/student/tasks', 'overdue:' || r.id) then
      v_sent := v_sent + 1; end if;
  end loop;

  -- 3. Completed but not submitted (once per local day, only if the student has a class).
  for r in
    select t.id, t.student_id, t.title
    from public.tasks t
    where t.archived_at is null and t.status = 'completed' and t.completed_at <= now() - interval '1 hour'
      and exists (select 1 from public.class_members m where m.student_id = t.student_id)
  loop
    if public.notify(r.student_id, 'submit_reminder', 'Submit for verification: ' || r.title,
         'You finished this task. Send it to your teacher to get it verified.', '/student/tasks',
         'submit:' || r.id || ':' || public.local_today(r.student_id)) then
      v_sent := v_sent + 1; end if;
  end loop;

  -- 4. Teachers with submissions waiting more than 12 hours (one digest per local day).
  for r in
    select s.teacher_id, count(*) as waiting
    from public.submissions s
    where s.status = 'submitted' and s.submitted_at <= now() - interval '12 hours'
    group by s.teacher_id
  loop
    if public.notify(r.teacher_id, 'pending_reviews', r.waiting || ' submission(s) waiting for review',
         'Your students are waiting for verification.', '/teacher/review',
         'pending:' || public.local_today(r.teacher_id)) then
      v_sent := v_sent + 1; end if;
  end loop;

  -- 5. Roll over streaks that ended because a day passed without a win.
  for r in
    select s.student_id from public.streaks s
    where s.current_streak > 0 and s.last_win_date < public.local_today(s.student_id) - 1
  loop
    perform public.recompute_streak(r.student_id);
  end loop;

  return v_sent;
end $$;

-- ===== migrations/20261023000006_edit_any_task.sql =====
-- =====================================================================
-- Win Streak: edit any task.
-- Title and description stay editable after a task is submitted or verified.
-- The due date, due time and class are locked once submitted, so Win Day
-- history and the teacher's record stay accurate. Each submission keeps a
-- snapshot of the title and description the teacher actually reviewed.
-- Requires migration 20261023000005 (archived_at).
-- =====================================================================

-- ---------- Snapshot of what was submitted ----------
alter table public.submissions
  add column if not exists task_title text,
  add column if not exists task_description text;

update public.submissions s
   set task_title = t.title, task_description = t.description
  from public.tasks t
 where t.id = s.task_id and s.task_title is null;

create or replace function public.submissions_snapshot()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.task_title is null then
    select t.title, t.description into new.task_title, new.task_description
      from public.tasks t where t.id = new.task_id;
  end if;
  return new;
end $$;

drop trigger if exists submissions_snapshot on public.submissions;
create trigger submissions_snapshot before insert on public.submissions
  for each row execute function public.submissions_snapshot();

-- ---------- Tasks: only the due date / time / class are locked after submission ----------
create or replace function public.tasks_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_tz text;
begin
  if tg_op = 'INSERT' then
    -- New tasks always start pending regardless of what the client sent.
    new.status := 'pending';
    new.completed_at := null;
  elsif old.status in ('submitted', 'verified') and (
          new.due_date is distinct from old.due_date or
          new.due_time is distinct from old.due_time or
          (new.class_id is distinct from old.class_id
            -- allow the FK "on delete set null" when the class itself was deleted
            and not (new.class_id is null and not exists (select 1 from public.classes where id = old.class_id)))) then
    raise exception 'The due date and class are locked after a task is submitted. You can still edit the title and description.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' or new.due_date is distinct from old.due_date or new.due_time is distinct from old.due_time then
    select timezone into v_tz from public.profiles where id = new.student_id;
    new.due_at := (new.due_date + new.due_time) at time zone coalesce(v_tz, 'UTC');
  end if;
  new.updated_at := now();
  return new;
end $$;

-- While a task waits for review, the teacher reviews its latest wording.
create or replace function public.tasks_after_update_sync()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'submitted'
     and (new.title is distinct from old.title or new.description is distinct from old.description) then
    update public.submissions
       set task_title = new.title, task_description = new.description
     where task_id = new.id and status = 'submitted';
  end if;
  return null;
end $$;

drop trigger if exists tasks_after_update_sync on public.tasks;
create trigger tasks_after_update_sync after update on public.tasks
  for each row execute function public.tasks_after_update_sync();

-- Submitted / verified tasks keep their class link (locked above), so they stay
-- editable even if the student has since left that class.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (student_id = auth.uid() and archived_at is null)
  with check (student_id = auth.uid()
              and (class_id is null or public.i_am_member(class_id) or status in ('submitted', 'verified')));

revoke execute on function public.submissions_snapshot() from public, anon, authenticated;
revoke execute on function public.tasks_after_update_sync() from public, anon, authenticated;

-- ===== migrations/20261023000007_review_hardening.sql =====
-- =====================================================================
-- Win Streak: hardening after review.
-- 1. Deleted (archived) tasks can no longer be completed, reopened or submitted.
-- 2. A teacher's decision is only saved for the exact wording they reviewed:
--    review_submission accepts the title/description the teacher saw and
--    refuses if the student edited the task in the meantime.
-- Requires migrations 20261023000005 and 20261023000006.
-- =====================================================================

create or replace function public.set_task_completed(p_task uuid, p_done boolean)
returns public.tasks
language plpgsql security definer set search_path = public
as $$
declare v_task public.tasks;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_task from public.tasks where id = p_task and student_id = auth.uid() and archived_at is null for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;

  if p_done then
    if v_task.status not in ('pending', 'rejected') then
      raise exception 'This task is already completed.' using errcode = '22023';
    end if;
    update public.tasks set status = 'completed', completed_at = now()
      where id = p_task returning * into v_task;
    insert into public.task_completions (task_id, student_id, completed_on, completed_at)
      values (p_task, auth.uid(), public.local_today(auth.uid()), now())
      on conflict (task_id) do nothing;
  else
    if v_task.status <> 'completed' then
      raise exception 'Only completed tasks that are not yet submitted can be reopened.' using errcode = '22023';
    end if;
    update public.tasks set status = 'pending', completed_at = null
      where id = p_task returning * into v_task;
    delete from public.task_completions where task_id = p_task;
  end if;

  perform public.recompute_streak(auth.uid());
  return v_task;
end $$;

create or replace function public.submit_task(p_task uuid, p_class uuid default null, p_note text default '')
returns public.submissions
language plpgsql security definer set search_path = public
as $$
declare
  v_task    public.tasks;
  v_class   public.classes;
  v_sub     public.submissions;
  v_student text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_task from public.tasks where id = p_task and student_id = auth.uid() and archived_at is null for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  if v_task.status = 'submitted' then
    raise exception 'This task is already waiting for review.' using errcode = '23505';
  end if;
  if v_task.status = 'verified' then
    raise exception 'This task is already verified.' using errcode = '23505';
  end if;
  if v_task.status <> 'completed' then
    raise exception 'Mark the task as completed before submitting it.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_note, '')) > 2000 then
    raise exception 'Submission note is too long (max 2000 characters).' using errcode = '22023';
  end if;

  select * into v_class from public.classes where id = coalesce(p_class, v_task.class_id);
  if not found then
    raise exception 'Choose the class (teacher) to submit this task to.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.class_members where class_id = v_class.id and student_id = auth.uid()) then
    raise exception 'You are not a member of that class.' using errcode = '42501';
  end if;

  insert into public.submissions (task_id, student_id, class_id, teacher_id, note)
  values (p_task, auth.uid(), v_class.id, v_class.teacher_id, coalesce(trim(p_note), ''))
  returning * into v_sub;

  update public.tasks set status = 'submitted', class_id = v_class.id where id = p_task;

  select full_name into v_student from public.profiles where id = auth.uid();
  perform public.notify(v_class.teacher_id, 'new_submission',
    'New submission from ' || v_student,
    v_task.title || ' (' || v_class.name || ')', '/teacher/review?submission=' || v_sub.id,
    'submission:' || v_sub.id);
  return v_sub;
end $$;

drop function if exists public.review_submission(uuid, public.review_decision, text);
create or replace function public.review_submission(
  p_submission uuid, p_decision public.review_decision, p_feedback text default '',
  p_expected_title text default null, p_expected_description text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_sub    public.submissions;
  v_task   public.tasks;
  v_new    public.task_status;
  v_ver    public.verifications;
  v_fb     text := trim(coalesce(p_feedback, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.my_role() is distinct from 'teacher' then
    raise exception 'Only teachers can review submissions.' using errcode = '42501';
  end if;

  select * into v_sub from public.submissions where id = p_submission for update;
  if not found or v_sub.teacher_id <> auth.uid() then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if v_sub.status <> 'submitted' then
    raise exception 'This submission has already been reviewed.' using errcode = '23505';
  end if;
  -- The teacher must approve exactly the wording they were shown.
  if p_expected_title is not null and (v_sub.task_title is distinct from p_expected_title
       or coalesce(v_sub.task_description, '') is distinct from coalesce(p_expected_description, '')) then
    raise exception 'The student changed this task while you were reviewing it. Reload to see the latest version.' using errcode = '40001';
  end if;
  if not public.i_teach_student_in(v_sub.class_id, v_sub.student_id) then
    raise exception 'This student is no longer in your class.' using errcode = '42501';
  end if;
  if p_decision = 'rejected' and char_length(v_fb) < 3 then
    raise exception 'Please explain what needs improvement (at least 3 characters).' using errcode = '22023';
  end if;
  if char_length(v_fb) > 2000 then
    raise exception 'Feedback is too long (max 2000 characters).' using errcode = '22023';
  end if;

  v_new := case p_decision when 'approved' then 'verified' else 'rejected' end;

  update public.submissions
     set status = (case p_decision when 'approved' then 'verified' else 'rejected' end)::public.submission_status,
         reviewed_at = now()
   where id = p_submission;

  insert into public.verifications (submission_id, task_id, teacher_id, student_id, decision, feedback)
  values (v_sub.id, v_sub.task_id, auth.uid(), v_sub.student_id, p_decision, v_fb)
  returning * into v_ver;

  if v_new = 'rejected' then
    update public.tasks set status = 'rejected', completed_at = null where id = v_sub.task_id returning * into v_task;
    delete from public.task_completions where task_id = v_sub.task_id;
    perform public.recompute_streak(v_sub.student_id);
    perform public.notify(v_sub.student_id, 'task_rejected', 'Needs improvement: ' || v_task.title,
      v_fb, '/student/history', 'review:' || v_ver.id);
  else
    update public.tasks set status = 'verified' where id = v_sub.task_id returning * into v_task;
    perform public.notify(v_sub.student_id, 'task_approved', 'Verified: ' || v_task.title,
      coalesce(nullif(v_fb, ''), 'Your teacher approved your work. Great job!'),
      '/student/history', 'review:' || v_ver.id);
  end if;

  return json_build_object('submission_id', v_sub.id, 'task_id', v_sub.task_id,
                           'task_status', v_task.status, 'verification_id', v_ver.id,
                           'reviewed_at', v_ver.created_at);
end $$;

revoke execute on function public.set_task_completed(uuid, boolean) from public, anon;
revoke execute on function public.submit_task(uuid, uuid, text) from public, anon;
revoke execute on function public.review_submission(uuid, public.review_decision, text, text, text) from public, anon;
grant execute on function public.set_task_completed(uuid, boolean) to authenticated;
grant execute on function public.submit_task(uuid, uuid, text) to authenticated;
grant execute on function public.review_submission(uuid, public.review_decision, text, text, text) to authenticated;

-- ===== migrations/20261023000008_edit_dates.sql =====
-- =====================================================================
-- Win Streak: dates and times are editable on every task, including
-- submitted and verified ones. Only the class stays locked after
-- submission (so verified work cannot move to another teacher's class).
-- Changing a due date recalculates the student's streak immediately.
-- Requires migrations 20261023000005 to 20261023000007.
-- =====================================================================

create or replace function public.tasks_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_tz text;
begin
  if tg_op = 'INSERT' then
    -- New tasks always start pending regardless of what the client sent.
    new.status := 'pending';
    new.completed_at := null;
  elsif old.status in ('submitted', 'verified')
        and new.class_id is distinct from old.class_id
        -- allow the FK "on delete set null" when the class itself was deleted
        and not (new.class_id is null and not exists (select 1 from public.classes where id = old.class_id)) then
    raise exception 'The class is locked after a task is submitted. You can still edit everything else.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' or new.due_date is distinct from old.due_date or new.due_time is distinct from old.due_time then
    select timezone into v_tz from public.profiles where id = new.student_id;
    new.due_at := (new.due_date + new.due_time) at time zone coalesce(v_tz, 'UTC');
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Keep the teacher's open review in sync, and keep the streak correct when a due date moves.
create or replace function public.tasks_after_update_sync()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'submitted'
     and (new.title is distinct from old.title or new.description is distinct from old.description) then
    update public.submissions
       set task_title = new.title, task_description = new.description
     where task_id = new.id and status = 'submitted';
  end if;
  if new.due_date is distinct from old.due_date then
    perform public.recompute_streak(new.student_id);
  end if;
  return null;
end $$;

revoke execute on function public.tasks_after_update_sync() from public, anon, authenticated;

-- ===== migrations/20261024000009_subscriptions.sql =====
-- =====================================================================
-- Win Streak: 30-day free trial, paid plans and admin.
--   * Every account gets a 30-day free trial.
--   * Plans: monthly $5 (Rs 1,400) or yearly $50 (Rs 14,000), paid by JazzCash
--     transfer; the user submits the Transaction ID (TID) and an admin approves it.
--   * Some emails never pay (free access list). Admins manage everything.
--   * When the trial ends without payment the account becomes VIEW-ONLY:
--     everything can be read, but nothing can be added, completed, submitted
--     or verified. This is enforced in the database by triggers.
-- =====================================================================

-- ---------- Configuration tables (no client access) ----------
create table if not exists public.app_admins (
  email text primary key check (email = lower(email))
);
create table if not exists public.free_access_emails (
  email     text primary key check (email = lower(email)),
  note      text not null default '',
  added_at  timestamptz not null default now()
);

insert into public.app_admins (email) values ('m.mahadtahir8817api.key@gmail.com')
on conflict do nothing;

insert into public.free_access_emails (email, note) values
  ('huzaifatahir.edu233@gmail.com', 'Teacher'),
  ('hadiatahir700@gmail.com', 'Student'),
  ('tahirtufail1979@gmail.com', 'Teacher'),
  ('m.mahad881@gmail.com', 'Student'),
  ('m.mahadtahir8817@gmail.com', 'Student'),
  ('m.mahadtahir8817api.key@gmail.com', 'Student / admin')
on conflict do nothing;

-- ---------- Subscriptions: one row per account ----------
create table if not exists public.subscriptions (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  trial_ends_at  timestamptz not null,
  paid_until     timestamptz,
  plan           text check (plan in ('monthly', 'yearly')),
  updated_at     timestamptz not null default now()
);

-- Existing accounts: 30 days from when they joined.
insert into public.subscriptions (user_id, trial_ends_at)
select p.id, p.created_at + interval '30 days' from public.profiles p
on conflict do nothing;

create or replace function public.profiles_start_trial()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.subscriptions (user_id, trial_ends_at) values (new.id, now() + interval '30 days')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists profiles_start_trial on public.profiles;
create trigger profiles_start_trial after insert on public.profiles
  for each row execute function public.profiles_start_trial();

-- ---------- Payments (JazzCash transfer + TID) ----------
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  plan            text not null check (plan in ('monthly', 'yearly')),
  amount_pkr      integer not null check (amount_pkr > 0),
  amount_usd      numeric(10, 2) not null check (amount_usd > 0),
  method          text not null default 'jazzcash' check (method in ('jazzcash')),
  sender_number   text not null check (sender_number ~ '^[0-9]{10,13}$'),
  transaction_id  text not null check (char_length(transaction_id) between 6 and 40),
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_note      text not null default '' check (char_length(admin_note) <= 500),
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles (id) on delete set null
);
create unique index if not exists payments_tid_unique on public.payments (upper(transaction_id));
create unique index if not exists payments_one_pending_per_user on public.payments (user_id) where status = 'pending';
create index if not exists payments_status_idx on public.payments (status, created_at desc);

-- ---------- Notification types for payments ----------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'due_soon', 'overdue', 'submit_reminder', 'new_submission', 'pending_reviews', 'task_approved',
  'task_rejected', 'badge_earned', 'class_joined', 'payment_submitted', 'payment_approved', 'payment_rejected'));

-- ---------- Access rules ----------
-- Admin / free access only counts for a CONFIRMED email address.
create or replace function public.is_admin(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    join auth.users u on u.id = p.id
    join public.app_admins a on a.email = lower(p.email)
    where p.id = p_user and u.email_confirmed_at is not null)
$$;

create or replace function public.has_free_access(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    join auth.users u on u.id = p.id
    join public.free_access_emails f on f.email = lower(p.email)
    where p.id = p_user and u.email_confirmed_at is not null)
$$;

create or replace function public.has_full_access(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_admin(p_user) or public.has_free_access(p_user) or exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user and (s.trial_ends_at > now() or coalesce(s.paid_until, '-infinity'::timestamptz) > now()))
$$;

-- View-only enforcement: blocks writes by a signed-in user without access.
-- (Scheduled jobs and the SQL editor run without a user, so they are not affected.)
create or replace function public.require_full_access()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.has_full_access(auth.uid()) then
    raise exception 'Your free trial has ended. Subscribe to add, complete or submit work. You can still view everything.'
      using errcode = 'P0001', hint = 'subscription_required';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists zz_require_access on public.tasks;
create trigger zz_require_access before insert or update or delete on public.tasks
  for each row execute function public.require_full_access();
drop trigger if exists zz_require_access on public.submissions;
create trigger zz_require_access before insert or update or delete on public.submissions
  for each row execute function public.require_full_access();
drop trigger if exists zz_require_access on public.verifications;
create trigger zz_require_access before insert on public.verifications
  for each row execute function public.require_full_access();
drop trigger if exists zz_require_access on public.classes;
create trigger zz_require_access before insert or update or delete on public.classes
  for each row execute function public.require_full_access();
drop trigger if exists zz_require_access on public.class_members;
create trigger zz_require_access before insert or delete on public.class_members
  for each row execute function public.require_full_access();

-- ---------- What the signed-in user can do ----------
create or replace function public.my_access()
returns json language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions;
  v_admin boolean;
  v_free boolean;
  v_status text;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_sub from public.subscriptions where user_id = v_uid;
  v_admin := public.is_admin(v_uid);
  v_free := public.has_free_access(v_uid);
  v_status := case
    when v_admin then 'admin'
    when v_free then 'free'
    when coalesce(v_sub.paid_until, '-infinity'::timestamptz) > now() then 'active'
    when v_sub.trial_ends_at > now() then 'trial'
    else 'expired' end;
  return json_build_object(
    'status', v_status,
    'is_admin', v_admin,
    'read_only', v_status = 'expired',
    'trial_ends_at', v_sub.trial_ends_at,
    'paid_until', v_sub.paid_until,
    'plan', v_sub.plan,
    'pending_payment', exists (select 1 from public.payments where user_id = v_uid and status = 'pending'));
end $$;

-- ---------- User: submit a JazzCash payment for approval ----------
create or replace function public.submit_payment(p_plan text, p_sender text, p_tid text)
returns public.payments language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.payments;
  v_sender text := regexp_replace(coalesce(p_sender, ''), '[^0-9]', '', 'g');
  v_tid text := upper(regexp_replace(coalesce(p_tid, ''), '\s', '', 'g'));
  v_name text;
  r record;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_plan not in ('monthly', 'yearly') then
    raise exception 'Choose the monthly or the yearly plan.' using errcode = '22023';
  end if;
  if v_sender !~ '^[0-9]{10,13}$' then
    raise exception 'Enter the JazzCash number you paid from, for example 03001234567.' using errcode = '22023';
  end if;
  if v_tid !~ '^[A-Z0-9]{6,40}$' then
    raise exception 'Enter the Transaction ID (TID) from your JazzCash receipt. It has only letters and numbers.' using errcode = '22023';
  end if;
  if exists (select 1 from public.payments where user_id = v_uid and status = 'pending') then
    raise exception 'You already have a payment waiting for approval.' using errcode = '23505';
  end if;
  if exists (select 1 from public.payments where upper(transaction_id) = v_tid) then
    raise exception 'This Transaction ID was already submitted.' using errcode = '23505';
  end if;

  insert into public.payments (user_id, plan, amount_pkr, amount_usd, sender_number, transaction_id)
  values (v_uid, p_plan,
          case p_plan when 'monthly' then 1400 else 14000 end,
          case p_plan when 'monthly' then 5 else 50 end,
          v_sender, v_tid)
  returning * into v_row;

  select full_name into v_name from public.profiles where id = v_uid;
  for r in select p.id from public.profiles p join public.app_admins a on a.email = lower(p.email) loop
    perform public.notify(r.id, 'payment_submitted', 'New payment from ' || v_name,
      (case p_plan when 'monthly' then 'Monthly' else 'Yearly' end) || ' plan, Rs ' || v_row.amount_pkr || ', TID ' || v_tid,
      '/admin', 'payment:' || v_row.id);
  end loop;
  return v_row;
end $$;

-- ---------- Admin ----------
create or replace function public.require_admin()
returns void language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin(auth.uid()) then
    raise exception 'Only the admin can do this.' using errcode = '42501';
  end if;
end $$;

create or replace function public.admin_overview()
returns json language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_admin();
  return json_build_object(
    'users', (select count(*) from public.profiles),
    'students', (select count(*) from public.profiles where role = 'student'),
    'teachers', (select count(*) from public.profiles where role = 'teacher'),
    'on_trial', (select count(*) from public.subscriptions s where s.trial_ends_at > now()
                   and coalesce(s.paid_until, '-infinity'::timestamptz) <= now()),
    'paid_active', (select count(*) from public.subscriptions where paid_until > now()),
    'free_accounts', (select count(*) from public.free_access_emails),
    'pending_payments', (select count(*) from public.payments where status = 'pending'),
    'revenue_pkr', (select coalesce(sum(amount_pkr), 0) from public.payments where status = 'approved'),
    'tasks', (select count(*) from public.tasks),
    'classes', (select count(*) from public.classes));
end $$;

-- Dropped first so this file can be re-run after migration 011 changed the result columns.
drop function if exists public.admin_list_payments(text);
create or replace function public.admin_list_payments(p_status text default null)
returns table (id uuid, user_id uuid, full_name text, email text, role public.user_role, plan text, amount_pkr int,
               amount_usd numeric, sender_number text, transaction_id text, status text, admin_note text,
               created_at timestamptz, reviewed_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_admin();
  return query
  select pm.id, pm.user_id, p.full_name, p.email, p.role, pm.plan, pm.amount_pkr, pm.amount_usd, pm.sender_number,
         pm.transaction_id, pm.status, pm.admin_note, pm.created_at, pm.reviewed_at
  from public.payments pm join public.profiles p on p.id = pm.user_id
  where p_status is null or pm.status = p_status
  order by (pm.status = 'pending') desc, pm.created_at desc;
end $$;

create or replace function public.admin_review_payment(p_payment uuid, p_approve boolean, p_note text default '')
returns json language plpgsql security definer set search_path = public
as $$
declare
  v_pay public.payments;
  v_until timestamptz;
  v_note text := left(trim(coalesce(p_note, '')), 500);
begin
  perform public.require_admin();
  select * into v_pay from public.payments where id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'P0002'; end if;
  if v_pay.status <> 'pending' then raise exception 'This payment was already reviewed.' using errcode = '23505'; end if;
  if not p_approve and char_length(v_note) < 3 then
    raise exception 'Write a short reason for rejecting (for example: TID not found).' using errcode = '22023';
  end if;

  update public.payments
     set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = v_note, reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_payment;

  if p_approve then
    insert into public.subscriptions (user_id, trial_ends_at) values (v_pay.user_id, now())
    on conflict (user_id) do nothing;
    update public.subscriptions
       set paid_until = greatest(coalesce(paid_until, now()), now())
                        + case v_pay.plan when 'monthly' then interval '1 month' else interval '1 year' end,
           plan = v_pay.plan, updated_at = now()
     where user_id = v_pay.user_id
     returning paid_until into v_until;
    perform public.notify(v_pay.user_id, 'payment_approved', 'Payment approved. Thank you!',
      'Your ' || v_pay.plan || ' plan is active until ' || to_char(v_until, 'DD Mon YYYY') || '.',
      '/subscription', 'payment-review:' || v_pay.id);
  else
    perform public.notify(v_pay.user_id, 'payment_rejected', 'Payment not approved',
      v_note, '/subscription', 'payment-review:' || v_pay.id);
  end if;
  return json_build_object('payment_id', v_pay.id, 'status', case when p_approve then 'approved' else 'rejected' end,
                           'paid_until', v_until);
end $$;

-- Dropped first so this file can be re-run after migration 014 added a column.
drop function if exists public.admin_list_users();
create or replace function public.admin_list_users()
returns table (id uuid, full_name text, email text, role public.user_role, created_at timestamptz,
               status text, trial_ends_at timestamptz, paid_until timestamptz, plan text, is_free boolean, is_admin boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_admin();
  return query
  select p.id, p.full_name, p.email, p.role, p.created_at,
         case
           when public.is_admin(p.id) then 'admin'
           when public.has_free_access(p.id) then 'free'
           when coalesce(s.paid_until, '-infinity'::timestamptz) > now() then 'active'
           when s.trial_ends_at > now() then 'trial'
           else 'expired' end,
         s.trial_ends_at, s.paid_until, s.plan,
         exists (select 1 from public.free_access_emails f where f.email = lower(p.email)),
         public.is_admin(p.id)
  from public.profiles p left join public.subscriptions s on s.user_id = p.id
  order by p.created_at desc;
end $$;

create or replace function public.admin_set_free_access(p_email text, p_free boolean)
returns void language plpgsql security definer set search_path = public
as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform public.require_admin();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if p_free then
    insert into public.free_access_emails (email, note) values (v_email, 'Added by admin') on conflict do nothing;
  else
    delete from public.free_access_emails where email = v_email;
  end if;
end $$;

-- ---------- Privileges and Row Level Security ----------
alter table public.app_admins enable row level security;
alter table public.free_access_emails enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;

revoke all on public.app_admins, public.free_access_emails, public.subscriptions, public.payments from anon, authenticated;
grant select on public.subscriptions, public.payments to authenticated;

drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated using (user_id = auth.uid());

revoke execute on function public.is_admin(uuid), public.has_free_access(uuid), public.has_full_access(uuid),
  public.require_full_access(), public.profiles_start_trial(), public.require_admin() from public, anon, authenticated;
revoke execute on function public.my_access(), public.submit_payment(text, text, text), public.admin_overview(),
  public.admin_list_payments(text), public.admin_review_payment(uuid, boolean, text), public.admin_list_users(),
  public.admin_set_free_access(text, boolean) from public, anon;
grant execute on function public.my_access(), public.submit_payment(text, text, text), public.admin_overview(),
  public.admin_list_payments(text), public.admin_review_payment(uuid, boolean, text), public.admin_list_users(),
  public.admin_set_free_access(text, boolean) to authenticated;

-- ===== migrations/20261024000010_admin_manage.sql =====
-- =====================================================================
-- Win Streak: the admin can edit everything.
--   Users: name, role, delete account.   Subscriptions: trial end, paid until, plan.
--   Tasks: edit any task (title, description, date, time, status) or delete it.
--   Classes: rename, delete, add or remove students.
-- Every function checks that the caller is the admin (public.require_admin()).
-- Requires migration 20261024000009 (subscriptions / admin).
-- =====================================================================

-- ---------- Users ----------
create or replace function public.admin_update_user(p_user uuid, p_full_name text, p_role public.user_role)
returns void language plpgsql security definer set search_path = public
as $$
declare v_old public.profiles;
begin
  perform public.require_admin();
  if p_full_name is null or char_length(trim(p_full_name)) not between 1 and 100 then
    raise exception 'Name must be 1 to 100 characters.' using errcode = '22023';
  end if;
  select * into v_old from public.profiles where id = p_user for update;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;

  if v_old.role = 'teacher' and p_role = 'student'
     and exists (select 1 from public.classes where teacher_id = p_user) then
    raise exception 'This teacher still has classes. Delete their classes first (Classes tab), then change the role.' using errcode = '22023';
  end if;
  if v_old.role = 'student' and p_role = 'teacher' then
    delete from public.class_members where student_id = p_user;   -- a teacher cannot be a class member
  end if;

  update public.profiles set full_name = trim(p_full_name), role = p_role where id = p_user;
  if p_role = 'student' then
    insert into public.streaks (student_id) values (p_user) on conflict do nothing;
  end if;
end $$;

create or replace function public.admin_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_admin();
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own admin account.' using errcode = '22023';
  end if;
  delete from auth.users where id = p_user;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.admin_set_subscription(
  p_user uuid, p_trial_ends_at timestamptz, p_paid_until timestamptz, p_plan text default null)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_admin();
  if p_trial_ends_at is null then
    raise exception 'Trial end date is required.' using errcode = '22023';
  end if;
  if p_plan is not null and p_plan not in ('monthly', 'yearly') then
    raise exception 'Plan must be monthly or yearly.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;
  insert into public.subscriptions (user_id, trial_ends_at, paid_until, plan, updated_at)
  values (p_user, p_trial_ends_at, p_paid_until, case when p_paid_until is null then null else coalesce(p_plan, 'monthly') end, now())
  on conflict (user_id) do update
    set trial_ends_at = excluded.trial_ends_at, paid_until = excluded.paid_until,
        plan = excluded.plan, updated_at = now();
end $$;

-- ---------- Tasks ----------
create or replace function public.admin_list_tasks(p_search text default '', p_limit int default 300)
returns table (id uuid, student_id uuid, student_name text, student_email text, class_name text, title text,
               description text, due_date date, due_time time, status public.task_status, completed_at timestamptz,
               archived_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
declare v_q text := '%' || lower(trim(coalesce(p_search, ''))) || '%';
begin
  perform public.require_admin();
  return query
  select t.id, t.student_id, p.full_name, p.email, c.name, t.title, t.description, t.due_date, t.due_time,
         t.status, t.completed_at, t.archived_at, t.created_at
  from public.tasks t
  join public.profiles p on p.id = t.student_id
  left join public.classes c on c.id = t.class_id
  where lower(t.title) like v_q or lower(p.full_name) like v_q or lower(p.email) like v_q
  order by t.due_at desc
  limit greatest(1, least(coalesce(p_limit, 300), 1000));
end $$;

create or replace function public.admin_update_task(
  p_task uuid, p_title text, p_description text, p_due_date date, p_due_time time, p_status public.task_status)
returns public.tasks language plpgsql security definer set search_path = public
as $$
declare
  v_task public.tasks;
  v_done boolean := p_status in ('completed', 'submitted', 'verified');
begin
  perform public.require_admin();
  select * into v_task from public.tasks where id = p_task for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  if p_title is null or char_length(trim(p_title)) not between 1 and 150 then
    raise exception 'Title must be 1 to 150 characters.' using errcode = '22023';
  end if;
  if p_due_date is null or p_due_time is null then
    raise exception 'Due date and time are required.' using errcode = '22023';
  end if;
  if p_status = 'submitted' and v_task.status <> 'submitted' then
    raise exception 'Only the student can submit a task to a teacher. Choose another status.' using errcode = '22023';
  end if;

  -- Leaving "submitted" withdraws the open review.
  if v_task.status = 'submitted' and p_status <> 'submitted' then
    delete from public.submissions where task_id = p_task and status = 'submitted';
  end if;

  update public.tasks
     set title = trim(p_title), description = coalesce(p_description, ''), due_date = p_due_date, due_time = p_due_time,
         status = p_status,
         completed_at = case when v_done then coalesce(completed_at, now()) else null end
   where id = p_task
   returning * into v_task;

  if v_done then
    insert into public.task_completions (task_id, student_id, completed_on)
    values (p_task, v_task.student_id, public.local_today(v_task.student_id))
    on conflict (task_id) do nothing;
  else
    delete from public.task_completions where task_id = p_task;
  end if;

  perform public.recompute_streak(v_task.student_id);
  return v_task;
end $$;

create or replace function public.admin_delete_task(p_task uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare v_student uuid;
begin
  perform public.require_admin();
  delete from public.tasks where id = p_task returning student_id into v_student;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  perform public.recompute_streak(v_student);
end $$;

-- ---------- Classes ----------
create or replace function public.admin_list_classes()
returns table (id uuid, name text, code text, teacher_id uuid, teacher_name text, teacher_email text,
               created_at timestamptz, members json)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_admin();
  return query
  select c.id, c.name, c.code, c.teacher_id, tp.full_name, tp.email, c.created_at,
         coalesce((select json_agg(json_build_object('student_id', sp.id, 'full_name', sp.full_name, 'email', sp.email,
                                                    'joined_at', m.joined_at) order by sp.full_name)
                   from public.class_members m join public.profiles sp on sp.id = m.student_id
                   where m.class_id = c.id), '[]'::json)
  from public.classes c join public.profiles tp on tp.id = c.teacher_id
  order by c.created_at desc;
end $$;

create or replace function public.admin_update_class(p_class uuid, p_name text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_admin();
  if p_name is null or char_length(trim(p_name)) not between 1 and 80 then
    raise exception 'Class name must be 1 to 80 characters.' using errcode = '22023';
  end if;
  update public.classes set name = trim(p_name) where id = p_class;
  if not found then raise exception 'Class not found.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.admin_delete_class(p_class uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_admin();
  delete from public.classes where id = p_class;
  if not found then raise exception 'Class not found.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.admin_add_member(p_class uuid, p_email text)
returns void language plpgsql security definer set search_path = public
as $$
declare v_student public.profiles;
begin
  perform public.require_admin();
  if not exists (select 1 from public.classes where id = p_class) then
    raise exception 'Class not found.' using errcode = 'P0002';
  end if;
  select * into v_student from public.profiles where lower(email) = lower(trim(coalesce(p_email, '')));
  if not found then raise exception 'No account with that email.' using errcode = 'P0002'; end if;
  if v_student.role <> 'student' then
    raise exception 'Only students can be added to a class.' using errcode = '22023';
  end if;
  insert into public.class_members (class_id, student_id) values (p_class, v_student.id)
  on conflict do nothing;
  if not found then raise exception 'This student is already in the class.' using errcode = '23505'; end if;
end $$;

create or replace function public.admin_remove_member(p_class uuid, p_student uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_admin();
  delete from public.class_members where class_id = p_class and student_id = p_student;
  if not found then raise exception 'That student is not in this class.' using errcode = 'P0002'; end if;
end $$;

-- ---------- Privileges ----------
revoke execute on function
  public.admin_update_user(uuid, text, public.user_role), public.admin_delete_user(uuid),
  public.admin_set_subscription(uuid, timestamptz, timestamptz, text),
  public.admin_list_tasks(text, int), public.admin_update_task(uuid, text, text, date, time, public.task_status),
  public.admin_delete_task(uuid), public.admin_list_classes(), public.admin_update_class(uuid, text),
  public.admin_delete_class(uuid), public.admin_add_member(uuid, text), public.admin_remove_member(uuid, uuid)
from public, anon;
grant execute on function
  public.admin_update_user(uuid, text, public.user_role), public.admin_delete_user(uuid),
  public.admin_set_subscription(uuid, timestamptz, timestamptz, text),
  public.admin_list_tasks(text, int), public.admin_update_task(uuid, text, text, date, time, public.task_status),
  public.admin_delete_task(uuid), public.admin_list_classes(), public.admin_update_class(uuid, text),
  public.admin_delete_class(uuid), public.admin_add_member(uuid, text), public.admin_remove_member(uuid, uuid)
to authenticated;

-- ===== migrations/20261024000011_payment_proof.sql =====
-- =====================================================================
-- Win Streak: payment proof is mandatory.
-- Every JazzCash payment needs: the payer's name, the Transaction ID (TID)
-- and a screenshot of the receipt. Screenshots are stored privately in
-- Supabase Storage (bucket "payment-proofs"); only the payer and the admin
-- can open them. Requires migration 20261024000009.
-- =====================================================================

-- ---------- Columns ----------
alter table public.payments add column if not exists sender_name text;
alter table public.payments add column if not exists screenshot_path text;

-- ---------- Private storage bucket for receipts (images up to 5 MB) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- The caller is the admin (used by storage policies, so it only answers about the caller).
create or replace function public.i_am_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select auth.uid() is not null and public.is_admin(auth.uid()) $$;
revoke execute on function public.i_am_admin() from public, anon;
grant execute on function public.i_am_admin() to authenticated;

-- Users upload only into their own folder: payment-proofs/<their user id>/<file>
drop policy if exists "payment proofs: upload own" on storage.objects;
create policy "payment proofs: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-proofs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "payment proofs: read own or admin" on storage.objects;
create policy "payment proofs: read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.i_am_admin()));

drop policy if exists "payment proofs: delete own unused" on storage.objects;
create policy "payment proofs: delete own unused" on storage.objects for delete to authenticated
  using (bucket_id = 'payment-proofs' and (storage.foldername(name))[1] = auth.uid()::text
         and not exists (select 1 from public.payments p where p.screenshot_path = storage.objects.name));

-- ---------- submit_payment now requires name + TID + screenshot ----------
drop function if exists public.submit_payment(text, text, text);
create or replace function public.submit_payment(
  p_plan text, p_sender text, p_tid text, p_sender_name text, p_screenshot_path text)
returns public.payments language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.payments;
  v_sender text := regexp_replace(coalesce(p_sender, ''), '[^0-9]', '', 'g');
  v_tid text := upper(regexp_replace(coalesce(p_tid, ''), '\s', '', 'g'));
  v_name text := trim(coalesce(p_sender_name, ''));
  v_path text := trim(coalesce(p_screenshot_path, ''));
  v_user_name text;
  r record;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_plan not in ('monthly', 'yearly') then
    raise exception 'Choose the monthly or the yearly plan.' using errcode = '22023';
  end if;
  if char_length(v_name) not between 2 and 100 then
    raise exception 'Enter the name on the JazzCash account you paid from.' using errcode = '22023';
  end if;
  if v_sender !~ '^[0-9]{10,13}$' then
    raise exception 'Enter the JazzCash number you paid from, for example 03001234567.' using errcode = '22023';
  end if;
  if v_tid !~ '^[A-Z0-9]{6,40}$' then
    raise exception 'Enter the Transaction ID (TID) from your JazzCash receipt. It has only letters and numbers.' using errcode = '22023';
  end if;
  if v_path = '' or split_part(v_path, '/', 1) <> v_uid::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'payment-proofs' and o.name = v_path) then
    raise exception 'Upload a screenshot of your JazzCash payment receipt.' using errcode = '22023';
  end if;
  if exists (select 1 from public.payments where user_id = v_uid and status = 'pending') then
    raise exception 'You already have a payment waiting for approval.' using errcode = '23505';
  end if;
  if exists (select 1 from public.payments where upper(transaction_id) = v_tid) then
    raise exception 'This Transaction ID was already submitted.' using errcode = '23505';
  end if;
  if exists (select 1 from public.payments where screenshot_path = v_path) then
    raise exception 'This screenshot was already used for another payment.' using errcode = '23505';
  end if;

  insert into public.payments (user_id, plan, amount_pkr, amount_usd, sender_number, transaction_id, sender_name, screenshot_path)
  values (v_uid, p_plan,
          case p_plan when 'monthly' then 1400 else 14000 end,
          case p_plan when 'monthly' then 5 else 50 end,
          v_sender, v_tid, v_name, v_path)
  returning * into v_row;

  select full_name into v_user_name from public.profiles where id = v_uid;
  for r in select p.id from public.profiles p join public.app_admins a on a.email = lower(p.email) loop
    perform public.notify(r.id, 'payment_submitted', 'New payment from ' || v_user_name,
      (case p_plan when 'monthly' then 'Monthly' else 'Yearly' end) || ' plan, Rs ' || v_row.amount_pkr
        || ', paid by ' || v_name || ', TID ' || v_tid,
      '/admin', 'payment:' || v_row.id);
  end loop;
  return v_row;
end $$;

revoke execute on function public.submit_payment(text, text, text, text, text) from public, anon;
grant execute on function public.submit_payment(text, text, text, text, text) to authenticated;

-- ---------- Admin list now includes the payer name and screenshot ----------
drop function if exists public.admin_list_payments(text);
create function public.admin_list_payments(p_status text default null)
returns table (id uuid, user_id uuid, full_name text, email text, role public.user_role, plan text, amount_pkr int,
               amount_usd numeric, sender_number text, sender_name text, transaction_id text, screenshot_path text,
               status text, admin_note text, created_at timestamptz, reviewed_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_admin();
  return query
  select pm.id, pm.user_id, p.full_name, p.email, p.role, pm.plan, pm.amount_pkr, pm.amount_usd, pm.sender_number,
         pm.sender_name, pm.transaction_id, pm.screenshot_path, pm.status, pm.admin_note, pm.created_at, pm.reviewed_at
  from public.payments pm join public.profiles p on p.id = pm.user_id
  where p_status is null or pm.status = p_status
  order by (pm.status = 'pending') desc, pm.created_at desc;
end $$;

revoke execute on function public.admin_list_payments(text) from public, anon;
grant execute on function public.admin_list_payments(text) to authenticated;

-- ===== migrations/20261025000012_admin_role_value.sql =====
-- =====================================================================
-- Win Streak: add the "admin" role value.
-- Kept in its own migration (and its own transaction in RUN_THIS_UPDATE.sql)
-- because Postgres only allows a new enum value to be used after it is committed.
-- =====================================================================
alter type public.user_role add value if not exists 'admin';

commit;

begin;

-- ===== migrations/20261025000013_admin_no_role.sql =====
-- =====================================================================
-- Win Streak: the admin account has no Student or Teacher role.
-- Admin emails (public.app_admins) get the role 'admin'. They manage the
-- website from the Admin page only: they cannot join classes, create tasks
-- or classes, or review work (all of those already require 'student' or
-- 'teacher'). Requires migrations 009 (admins) and 012 (enum value).
-- =====================================================================

-- New sign-ups with an admin email become 'admin' (no streak row).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_role public.user_role;
  v_name text;
  v_tz   text;
begin
  if exists (select 1 from public.app_admins a where a.email = lower(coalesce(new.email, ''))) then
    v_role := 'admin';
  else
    v_role := case lower(coalesce(new.raw_user_meta_data ->> 'role', 'student'))
                when 'teacher' then 'teacher'::public.user_role
                else 'student'::public.user_role end;
  end if;
  v_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  v_name := left(coalesce(v_name, split_part(coalesce(new.email, 'User'), '@', 1)), 100);
  v_tz   := coalesce(new.raw_user_meta_data ->> 'timezone', 'UTC');
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;

  insert into public.profiles (id, role, full_name, email, timezone)
  values (new.id, v_role, v_name, coalesce(new.email, ''), v_tz);

  if v_role = 'student' then
    insert into public.streaks (student_id) values (new.id);
  end if;
  return new;
end $$;

-- Existing admin accounts get the Admin role in migration 016 (confirmed accounts
-- that own no classes only).

-- The admin can edit other accounts, but the admin account itself has no student/teacher role.
create or replace function public.admin_update_user(p_user uuid, p_full_name text, p_role public.user_role)
returns void language plpgsql security definer set search_path = public
as $$
declare v_old public.profiles;
begin
  perform public.require_admin();
  if p_full_name is null or char_length(trim(p_full_name)) not between 1 and 100 then
    raise exception 'Name must be 1 to 100 characters.' using errcode = '22023';
  end if;
  select * into v_old from public.profiles where id = p_user for update;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;

  if v_old.role = 'admin' then
    -- Only the name of an admin account can change.
    update public.profiles set full_name = trim(p_full_name) where id = p_user;
    return;
  end if;
  if p_role = 'admin' then
    raise exception 'Choose Student or Teacher. The admin role belongs only to the admin email.' using errcode = '22023';
  end if;
  if v_old.role = 'teacher' and p_role = 'student'
     and exists (select 1 from public.classes where teacher_id = p_user) then
    raise exception 'This teacher still has classes. Delete their classes first (Classes tab), then change the role.' using errcode = '22023';
  end if;
  if v_old.role = 'student' and p_role = 'teacher' then
    delete from public.class_members where student_id = p_user;
  end if;

  update public.profiles set full_name = trim(p_full_name), role = p_role where id = p_user;
  if p_role = 'student' then
    insert into public.streaks (student_id) values (p_user) on conflict do nothing;
  end if;
end $$;

revoke execute on function public.admin_update_user(uuid, text, public.user_role) from public, anon;
grant execute on function public.admin_update_user(uuid, text, public.user_role) to authenticated;

-- ===== migrations/20261025000014_admin_last_sign_in.sql =====
-- =====================================================================
-- Win Streak: the admin user list also shows when each account last signed in.
-- (Passwords are never readable; the admin can send a password reset link instead.)
-- Requires migrations 009 and 013.
-- =====================================================================
drop function if exists public.admin_list_users();
create function public.admin_list_users()
returns table (id uuid, full_name text, email text, role public.user_role, created_at timestamptz,
               status text, trial_ends_at timestamptz, paid_until timestamptz, plan text, is_free boolean,
               is_admin boolean, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_admin();
  return query
  select p.id, p.full_name, p.email, p.role, p.created_at,
         case
           when public.is_admin(p.id) then 'admin'
           when public.has_free_access(p.id) then 'free'
           when coalesce(s.paid_until, '-infinity'::timestamptz) > now() then 'active'
           when s.trial_ends_at > now() then 'trial'
           else 'expired' end,
         s.trial_ends_at, s.paid_until, s.plan,
         exists (select 1 from public.free_access_emails f where f.email = lower(p.email)),
         public.is_admin(p.id),
         u.last_sign_in_at
  from public.profiles p
  left join public.subscriptions s on s.user_id = p.id
  left join auth.users u on u.id = p.id
  order by p.created_at desc;
end $$;

revoke execute on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- ===== migrations/20261026000015_super_admin.sql =====
-- =====================================================================
-- Win Streak: Super Admin + Admin.
--   Super Admin : m.mahadtahir8817api.key@gmail.com
--   Admin       : m.mahadtahir322@gmail.com
-- Both manage the website (payments, users, tasks, classes) and have no
-- Student/Teacher role. Only the Super Admin can add or remove admins and
-- change or delete another admin's account. The Super Admin account can never
-- be deleted or removed. Requires migrations 009, 013 and 014.
-- =====================================================================

-- ---------- Admin levels ----------
alter table public.app_admins add column if not exists level text not null default 'admin';
alter table public.app_admins drop constraint if exists app_admins_level_check;
alter table public.app_admins add constraint app_admins_level_check check (level in ('admin', 'super_admin'));

-- Exactly these two accounts: one super admin, one admin.
update public.app_admins set level = 'admin'
 where level = 'super_admin' and email <> 'm.mahadtahir8817api.key@gmail.com';
insert into public.app_admins (email, level) values
  ('m.mahadtahir8817api.key@gmail.com', 'super_admin'),
  ('m.mahadtahir322@gmail.com', 'admin')
on conflict (email) do update set level = excluded.level;

create unique index if not exists app_admins_one_super on public.app_admins (level) where level = 'super_admin';

-- Existing accounts with an admin email get the Admin role in migration 016
-- (confirmed accounts that own no classes only).

-- ---------- Helpers ----------
create or replace function public.is_super_admin(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    join auth.users u on u.id = p.id
    join public.app_admins a on a.email = lower(p.email)
    where p.id = p_user and a.level = 'super_admin' and u.email_confirmed_at is not null)
$$;

-- The account belongs to an admin email (any level), confirmed or not.
create or replace function public.is_admin_account(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles p
                 where p.id = p_user
                   and (p.role = 'admin' or lower(p.email) in (select email from public.app_admins)))
$$;

create or replace function public.is_super_admin_account(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles p
                 join public.app_admins a on a.email = lower(p.email)
                 where p.id = p_user and a.level = 'super_admin')
$$;

create or replace function public.require_super_admin()
returns void language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_super_admin(auth.uid()) then
    raise exception 'Only the super admin can do this.' using errcode = '42501';
  end if;
end $$;

-- ---------- What the signed-in user can do (adds is_super_admin) ----------
create or replace function public.my_access()
returns json language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions;
  v_admin boolean;
  v_free boolean;
  v_status text;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_sub from public.subscriptions where user_id = v_uid;
  v_admin := public.is_admin(v_uid);
  v_free := public.has_free_access(v_uid);
  v_status := case
    when v_admin then 'admin'
    when v_free then 'free'
    when coalesce(v_sub.paid_until, '-infinity'::timestamptz) > now() then 'active'
    when v_sub.trial_ends_at > now() then 'trial'
    else 'expired' end;
  return json_build_object(
    'status', v_status,
    'is_admin', v_admin,
    'is_super_admin', public.is_super_admin(v_uid),
    'read_only', v_status = 'expired',
    'trial_ends_at', v_sub.trial_ends_at,
    'paid_until', v_sub.paid_until,
    'plan', v_sub.plan,
    'pending_payment', exists (select 1 from public.payments where user_id = v_uid and status = 'pending'));
end $$;

-- ---------- Admins cannot change other admins; only the super admin can ----------
create or replace function public.admin_update_user(p_user uuid, p_full_name text, p_role public.user_role)
returns void language plpgsql security definer set search_path = public
as $$
declare v_old public.profiles;
begin
  perform public.require_admin();
  if p_full_name is null or char_length(trim(p_full_name)) not between 1 and 100 then
    raise exception 'Name must be 1 to 100 characters.' using errcode = '22023';
  end if;
  select * into v_old from public.profiles where id = p_user for update;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;

  if public.is_admin_account(p_user) then
    -- Admin accounts: only the name changes, by the person themself or by the super admin.
    if p_user <> auth.uid() and not public.is_super_admin(auth.uid()) then
      raise exception 'Only the super admin can change another admin''s account.' using errcode = '42501';
    end if;
    update public.profiles set full_name = trim(p_full_name) where id = p_user;
    return;
  end if;
  if p_role = 'admin' then
    raise exception 'Choose Student or Teacher. Only the super admin can make someone an admin (Admins tab).' using errcode = '22023';
  end if;
  if v_old.role = 'teacher' and p_role = 'student'
     and exists (select 1 from public.classes where teacher_id = p_user) then
    raise exception 'This teacher still has classes. Delete their classes first (Classes tab), then change the role.' using errcode = '22023';
  end if;
  if v_old.role = 'student' and p_role = 'teacher' then
    delete from public.class_members where student_id = p_user;
  end if;

  update public.profiles set full_name = trim(p_full_name), role = p_role where id = p_user;
  if p_role = 'student' then
    insert into public.streaks (student_id) values (p_user) on conflict do nothing;
  end if;
end $$;

create or replace function public.admin_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare v_email text;
begin
  perform public.require_admin();
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own account here.' using errcode = '22023';
  end if;
  if public.is_super_admin_account(p_user) then
    raise exception 'The super admin account cannot be deleted.' using errcode = '42501';
  end if;
  if public.is_admin_account(p_user) then
    if not public.is_super_admin(auth.uid()) then
      raise exception 'Only the super admin can delete an admin account.' using errcode = '42501';
    end if;
    -- Removing the account also removes its admin email.
    select lower(email) into v_email from public.profiles where id = p_user;
    delete from public.app_admins where email = v_email and level <> 'super_admin';
  end if;
  delete from auth.users where id = p_user;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.admin_set_subscription(
  p_user uuid, p_trial_ends_at timestamptz, p_paid_until timestamptz, p_plan text default null)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_admin();
  if public.is_admin_account(p_user) and not public.is_super_admin(auth.uid()) then
    raise exception 'Only the super admin can change an admin account.' using errcode = '42501';
  end if;
  if p_trial_ends_at is null then
    raise exception 'Trial end date is required.' using errcode = '22023';
  end if;
  if p_plan is not null and p_plan not in ('monthly', 'yearly') then
    raise exception 'Plan must be monthly or yearly.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;
  insert into public.subscriptions (user_id, trial_ends_at, paid_until, plan, updated_at)
  values (p_user, p_trial_ends_at, p_paid_until, case when p_paid_until is null then null else coalesce(p_plan, 'monthly') end, now())
  on conflict (user_id) do update
    set trial_ends_at = excluded.trial_ends_at, paid_until = excluded.paid_until,
        plan = excluded.plan, updated_at = now();
end $$;

-- Admin emails cannot lose or gain "free access" through the free list (they are always free).
create or replace function public.admin_set_free_access(p_email text, p_free boolean)
returns void language plpgsql security definer set search_path = public
as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform public.require_admin();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if exists (select 1 from public.app_admins where email = v_email) and not public.is_super_admin(auth.uid()) then
    raise exception 'Only the super admin can change an admin account.' using errcode = '42501';
  end if;
  if p_free then
    insert into public.free_access_emails (email, note) values (v_email, 'Added by admin') on conflict do nothing;
  else
    delete from public.free_access_emails where email = v_email;
  end if;
end $$;

-- ---------- User list shows who is the super admin ----------
drop function if exists public.admin_list_users();
create function public.admin_list_users()
returns table (id uuid, full_name text, email text, role public.user_role, created_at timestamptz,
               status text, trial_ends_at timestamptz, paid_until timestamptz, plan text, is_free boolean,
               is_admin boolean, last_sign_in_at timestamptz, is_super_admin boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_admin();
  return query
  select p.id, p.full_name, p.email, p.role, p.created_at,
         case
           when public.is_admin(p.id) then 'admin'
           when public.has_free_access(p.id) then 'free'
           when coalesce(s.paid_until, '-infinity'::timestamptz) > now() then 'active'
           when s.trial_ends_at > now() then 'trial'
           else 'expired' end,
         s.trial_ends_at, s.paid_until, s.plan,
         exists (select 1 from public.free_access_emails f where f.email = lower(p.email)),
         public.is_admin_account(p.id),
         u.last_sign_in_at,
         public.is_super_admin_account(p.id)
  from public.profiles p
  left join public.subscriptions s on s.user_id = p.id
  left join auth.users u on u.id = p.id
  order by p.created_at desc;
end $$;

-- ---------- Super admin: manage admins ----------
drop function if exists public.super_list_admins();
create function public.super_list_admins()
returns table (email text, level text, user_id uuid, full_name text, last_sign_in_at timestamptz, email_confirmed boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_super_admin();
  return query
  select a.email, a.level, p.id, p.full_name, u.last_sign_in_at, u.email_confirmed_at is not null
  from public.app_admins a
  left join public.profiles p on lower(p.email) = a.email
  left join auth.users u on u.id = p.id
  order by (a.level = 'super_admin') desc, a.email;
end $$;

create or replace function public.super_add_admin(p_email text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_profile public.profiles;
begin
  perform public.require_super_admin();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if exists (select 1 from public.app_admins where email = v_email) then
    raise exception 'This email is already an admin.' using errcode = '23505';
  end if;
  select * into v_profile from public.profiles where lower(email) = v_email;
  if found and v_profile.role = 'teacher' and exists (select 1 from public.classes where teacher_id = v_profile.id) then
    raise exception 'This teacher still has classes. Delete their classes first (Classes tab), then make them an admin.' using errcode = '22023';
  end if;
  insert into public.app_admins (email, level) values (v_email, 'admin');
  if v_profile.id is not null then
    delete from public.class_members where student_id = v_profile.id;
    update public.profiles set role = 'admin' where id = v_profile.id;
  end if;
end $$;

create or replace function public.super_remove_admin(p_email text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_level text;
  v_id uuid;
begin
  perform public.require_super_admin();
  select level into v_level from public.app_admins where email = v_email;
  if not found then raise exception 'This email is not an admin.' using errcode = 'P0002'; end if;
  if v_level = 'super_admin' then
    raise exception 'The super admin cannot be removed.' using errcode = '42501';
  end if;
  delete from public.app_admins where email = v_email;
  -- The account becomes a normal student again (the super admin can change it to teacher in Users).
  update public.profiles set role = 'student' where lower(email) = v_email and role = 'admin' returning id into v_id;
  if v_id is not null then
    insert into public.streaks (student_id) values (v_id) on conflict do nothing;
  end if;
end $$;

-- ---------- Privileges ----------
revoke execute on function public.is_super_admin(uuid), public.is_admin_account(uuid), public.is_super_admin_account(uuid),
  public.require_super_admin() from public, anon, authenticated;
revoke execute on function public.my_access(), public.admin_update_user(uuid, text, public.user_role), public.admin_delete_user(uuid),
  public.admin_set_subscription(uuid, timestamptz, timestamptz, text), public.admin_set_free_access(text, boolean),
  public.admin_list_users(), public.super_list_admins(), public.super_add_admin(text), public.super_remove_admin(text)
from public, anon;
grant execute on function public.my_access(), public.admin_update_user(uuid, text, public.user_role), public.admin_delete_user(uuid),
  public.admin_set_subscription(uuid, timestamptz, timestamptz, text), public.admin_set_free_access(text, boolean),
  public.admin_list_users(), public.super_list_admins(), public.super_add_admin(text), public.super_remove_admin(text)
to authenticated;

-- ===== migrations/20261026000016_admin_accounts.sql =====
-- =====================================================================
-- Win Streak: admin powers belong to an account, not only to an email.
--   * Each admin email is linked to the account (user id) that owned it when it
--     was made admin. Someone who signs up first with an admin email, before
--     its real owner does, no longer becomes admin automatically.
--   * New sign-ups never get the Admin role. Other admin emails wait until the
--     super admin activates them in the Admins tab, after they sign up and confirm.
--     For the super admin email itself: sign up, confirm the email, then run
--     this update again (or: select public.link_admin_accounts();).
--   * Activating an admin signs that account out and removes its password, so
--     whoever created it with someone else's email cannot use it: the real owner
--     chooses a new password with "Forgot password".
--   * A teacher who still owns classes is never turned into an admin (the super
--     admin is the exception: delete such classes in the Classes tab).
--   * Admin accounts never pay. Only the super admin reviews a payment made by an
--     admin account, and nobody reviews their own payment.
-- Requires migrations 009 to 015. Safe to run more than once.
-- =====================================================================

alter table public.app_admins add column if not exists user_id uuid references auth.users (id) on delete set null;
create unique index if not exists app_admins_user_unique on public.app_admins (user_id) where user_id is not null;

-- ---------- Sign-ups never become admin by themselves ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_role public.user_role;
  v_name text;
  v_tz   text;
begin
  v_role := case lower(coalesce(new.raw_user_meta_data ->> 'role', 'student'))
              when 'teacher' then 'teacher'::public.user_role
              else 'student'::public.user_role end;
  v_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  v_name := left(coalesce(v_name, split_part(coalesce(new.email, 'User'), '@', 1)), 100);
  v_tz   := coalesce(new.raw_user_meta_data ->> 'timezone', 'UTC');
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;

  insert into public.profiles (id, role, full_name, email, timezone)
  values (new.id, v_role, v_name, coalesce(new.email, ''), v_tz);

  if v_role = 'student' then
    insert into public.streaks (student_id) values (new.id);
  end if;
  return new;
end $$;

-- ---------- Who is an admin (by account) ----------
create or replace function public.is_admin(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.app_admins a
    join auth.users u on u.id = a.user_id
    where a.user_id = p_user and u.email_confirmed_at is not null)
$$;

create or replace function public.is_super_admin(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.app_admins a
    join auth.users u on u.id = a.user_id
    where a.user_id = p_user and a.level = 'super_admin' and u.email_confirmed_at is not null)
$$;

create or replace function public.is_admin_account(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.app_admins a where a.user_id = p_user)
      or exists (select 1 from public.profiles p where p.id = p_user and p.role = 'admin')
$$;

create or replace function public.is_super_admin_account(p_user uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.app_admins a where a.user_id = p_user and a.level = 'super_admin')
$$;

-- ---------- Link the super admin to its account (run by the project owner) ----------
-- Only the super admin email is linked here, to its existing, confirmed account:
-- running this in the SQL Editor is the owner's own decision. Every other admin is
-- activated by the super admin in the Admins tab (super_add_admin), which refuses a
-- teacher who still owns classes. Then the Admin role is given to linked accounts only.
create or replace function public.link_admin_accounts()
returns void language plpgsql security definer set search_path = public
as $$
begin
  update public.app_admins a
     set user_id = u.id
    from auth.users u
   where a.user_id is null
     and a.level = 'super_admin'
     and lower(u.email) = a.email
     and u.email_confirmed_at is not null
     and not exists (select 1 from public.app_admins x where x.user_id = u.id);

  delete from public.class_members m using public.app_admins a where a.user_id = m.student_id;
  update public.profiles p set role = 'admin'
    from public.app_admins a
   where a.user_id = p.id and p.role <> 'admin';

  -- Accounts with the Admin role that are not linked go back to a normal role.
  update public.profiles p
     set role = case
                  when exists (select 1 from public.classes c where c.teacher_id = p.id) then 'teacher'::public.user_role
                  when lower(coalesce(u.raw_user_meta_data ->> 'role', '')) = 'teacher' then 'teacher'::public.user_role
                  else 'student'::public.user_role end
    from auth.users u
   where u.id = p.id and p.role = 'admin'
     and not exists (select 1 from public.app_admins a where a.user_id = p.id);
  insert into public.streaks (student_id)
  select p.id from public.profiles p where p.role = 'student'
  on conflict do nothing;
end $$;

select public.link_admin_accounts();

-- ---------- What the signed-in user can do (adds admin_pending) ----------
create or replace function public.my_access()
returns json language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions;
  v_admin boolean;
  v_free boolean;
  v_status text;
  v_pending text;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_sub from public.subscriptions where user_id = v_uid;
  v_admin := public.is_admin(v_uid);
  v_free := public.has_free_access(v_uid);
  v_status := case
    when v_admin then 'admin'
    when v_free then 'free'
    when coalesce(v_sub.paid_until, '-infinity'::timestamptz) > now() then 'active'
    when v_sub.trial_ends_at > now() then 'trial'
    else 'expired' end;
  -- This account's email is an admin email that is not active for this account yet.
  if not v_admin then
    select a.level into v_pending
      from public.app_admins a join auth.users u on lower(u.email) = a.email
     where u.id = v_uid and a.user_id is null;
  end if;
  return json_build_object(
    'status', v_status,
    'is_admin', v_admin,
    'is_super_admin', public.is_super_admin(v_uid),
    'admin_pending', v_pending,
    'read_only', v_status = 'expired',
    'trial_ends_at', v_sub.trial_ends_at,
    'paid_until', v_sub.paid_until,
    'plan', v_sub.plan,
    'pending_payment', exists (select 1 from public.payments where user_id = v_uid and status = 'pending'));
end $$;

-- ---------- Payments: admin accounts never pay; no reviewing your own ----------
create or replace function public.submit_payment(
  p_plan text, p_sender text, p_tid text, p_sender_name text, p_screenshot_path text)
returns public.payments language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.payments;
  v_sender text := regexp_replace(coalesce(p_sender, ''), '[^0-9]', '', 'g');
  v_tid text := upper(regexp_replace(coalesce(p_tid, ''), '\s', '', 'g'));
  v_name text := trim(coalesce(p_sender_name, ''));
  v_path text := trim(coalesce(p_screenshot_path, ''));
  v_user_name text;
  r record;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.is_admin_account(v_uid) then
    raise exception 'Admin accounts never pay. Your access is always free.' using errcode = '22023';
  end if;
  if p_plan not in ('monthly', 'yearly') then
    raise exception 'Choose the monthly or the yearly plan.' using errcode = '22023';
  end if;
  if char_length(v_name) not between 2 and 100 then
    raise exception 'Enter the name on the JazzCash account you paid from.' using errcode = '22023';
  end if;
  if v_sender !~ '^[0-9]{10,13}$' then
    raise exception 'Enter the JazzCash number you paid from, for example 03001234567.' using errcode = '22023';
  end if;
  if v_tid !~ '^[A-Z0-9]{6,40}$' then
    raise exception 'Enter the Transaction ID (TID) from your JazzCash receipt. It has only letters and numbers.' using errcode = '22023';
  end if;
  if v_path = '' or split_part(v_path, '/', 1) <> v_uid::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'payment-proofs' and o.name = v_path) then
    raise exception 'Upload a screenshot of your JazzCash payment receipt.' using errcode = '22023';
  end if;
  if exists (select 1 from public.payments where user_id = v_uid and status = 'pending') then
    raise exception 'You already have a payment waiting for approval.' using errcode = '23505';
  end if;
  if exists (select 1 from public.payments where upper(transaction_id) = v_tid) then
    raise exception 'This Transaction ID was already submitted.' using errcode = '23505';
  end if;
  if exists (select 1 from public.payments where screenshot_path = v_path) then
    raise exception 'This screenshot was already used for another payment.' using errcode = '23505';
  end if;

  insert into public.payments (user_id, plan, amount_pkr, amount_usd, sender_number, transaction_id, sender_name, screenshot_path)
  values (v_uid, p_plan,
          case p_plan when 'monthly' then 1400 else 14000 end,
          case p_plan when 'monthly' then 5 else 50 end,
          v_sender, v_tid, v_name, v_path)
  returning * into v_row;

  select full_name into v_user_name from public.profiles where id = v_uid;
  for r in select a.user_id as id from public.app_admins a where a.user_id is not null loop
    perform public.notify(r.id, 'payment_submitted', 'New payment from ' || v_user_name,
      (case p_plan when 'monthly' then 'Monthly' else 'Yearly' end) || ' plan, Rs ' || v_row.amount_pkr
        || ', paid by ' || v_name || ', TID ' || v_tid,
      '/admin', 'payment:' || v_row.id);
  end loop;
  return v_row;
end $$;

create or replace function public.admin_review_payment(p_payment uuid, p_approve boolean, p_note text default '')
returns json language plpgsql security definer set search_path = public
as $$
declare
  v_pay public.payments;
  v_until timestamptz;
  v_note text := left(trim(coalesce(p_note, '')), 500);
begin
  perform public.require_admin();
  select * into v_pay from public.payments where id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'P0002'; end if;
  if v_pay.user_id = auth.uid() then
    raise exception 'You cannot review your own payment.' using errcode = '42501';
  end if;
  if public.is_admin_account(v_pay.user_id) and not public.is_super_admin(auth.uid()) then
    raise exception 'Only the super admin can change an admin account.' using errcode = '42501';
  end if;
  if v_pay.status <> 'pending' then raise exception 'This payment was already reviewed.' using errcode = '23505'; end if;
  if not p_approve and char_length(v_note) < 3 then
    raise exception 'Write a short reason for rejecting (for example: TID not found).' using errcode = '22023';
  end if;

  update public.payments
     set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = v_note, reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_payment;

  if p_approve then
    insert into public.subscriptions (user_id, trial_ends_at) values (v_pay.user_id, now())
    on conflict (user_id) do nothing;
    update public.subscriptions
       set paid_until = greatest(coalesce(paid_until, now()), now())
                        + case v_pay.plan when 'monthly' then interval '1 month' else interval '1 year' end,
           plan = v_pay.plan, updated_at = now()
     where user_id = v_pay.user_id
     returning paid_until into v_until;
    perform public.notify(v_pay.user_id, 'payment_approved', 'Payment approved. Thank you!',
      'Your ' || v_pay.plan || ' plan is active until ' || to_char(v_until, 'DD Mon YYYY') || '.',
      '/subscription', 'payment-review:' || v_pay.id);
  else
    perform public.notify(v_pay.user_id, 'payment_rejected', 'Payment not approved',
      v_note, '/subscription', 'payment-review:' || v_pay.id);
  end if;
  return json_build_object('payment_id', v_pay.id, 'status', case when p_approve then 'approved' else 'rejected' end,
                           'paid_until', v_until);
end $$;

-- ---------- Deleting an admin account removes its admin row ----------
create or replace function public.admin_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_admin();
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own account here.' using errcode = '22023';
  end if;
  if public.is_super_admin_account(p_user) then
    raise exception 'The super admin account cannot be deleted.' using errcode = '42501';
  end if;
  if public.is_admin_account(p_user) then
    if not public.is_super_admin(auth.uid()) then
      raise exception 'Only the super admin can delete an admin account.' using errcode = '42501';
    end if;
    delete from public.app_admins where user_id = p_user and level <> 'super_admin';
  end if;
  delete from auth.users where id = p_user;
  if not found then raise exception 'User not found.' using errcode = 'P0002'; end if;
end $$;

-- ---------- Super admin: list, add (activate) and remove admins ----------
drop function if exists public.super_list_admins();
create function public.super_list_admins()
returns table (email text, level text, user_id uuid, full_name text, last_sign_in_at timestamptz,
               email_confirmed boolean, active boolean, has_account boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_super_admin();
  return query
  select a.email, a.level, u.id, p.full_name, u.last_sign_in_at, u.email_confirmed_at is not null,
         a.user_id is not null, u.id is not null
  from public.app_admins a
  left join lateral (
    select x.id, x.last_sign_in_at, x.email_confirmed_at from auth.users x
     where x.id = a.user_id or (a.user_id is null and lower(x.email) = a.email)
     limit 1) u on true
  left join public.profiles p on p.id = u.id
  order by (a.level = 'super_admin') desc, a.email;
end $$;

-- Makes an existing, confirmed account an admin, or activates an admin email
-- that is waiting for its account.
create or replace function public.super_add_admin(p_email text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_row public.app_admins;
  v_uid uuid;
  v_confirmed timestamptz;
begin
  perform public.require_super_admin();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  select * into v_row from public.app_admins where email = v_email;
  if v_row.user_id is not null then
    raise exception 'This email is already an admin.' using errcode = '23505';
  end if;
  select u.id, u.email_confirmed_at into v_uid, v_confirmed from auth.users u where lower(u.email) = v_email;
  if v_uid is null then
    raise exception 'No account uses this email yet. Ask them to sign up and confirm their email first, then add them here.' using errcode = 'P0002';
  end if;
  if v_confirmed is null then
    raise exception 'This account has not confirmed its email yet. Ask them to open the confirmation email first.' using errcode = '22023';
  end if;
  if exists (select 1 from public.app_admins where user_id = v_uid) then
    raise exception 'This account is already an admin.' using errcode = '23505';
  end if;
  if exists (select 1 from public.classes where teacher_id = v_uid) then
    raise exception 'This teacher still has classes. Delete their classes first (Classes tab), then make them an admin.' using errcode = '22023';
  end if;

  if v_row.email is not null then
    update public.app_admins set user_id = v_uid where email = v_email;
  else
    insert into public.app_admins (email, level, user_id) values (v_email, 'admin', v_uid);
  end if;
  delete from public.class_members where student_id = v_uid;
  update public.profiles set role = 'admin' where id = v_uid;
  -- Whoever created this account may not own the inbox (someone can sign up first with
  -- another person's email). Sign the account out everywhere and remove its password:
  -- only the inbox owner can get back in, with "Forgot password".
  delete from auth.refresh_tokens where user_id = v_uid::text;
  delete from auth.sessions where user_id = v_uid;
  update auth.users set encrypted_password = '' where id = v_uid;
end $$;

-- ---------- Admin tools refuse a sign-in session that was ended ----------
-- (an access token stays valid for up to an hour after its session is deleted)
create or replace function public.session_is_live()
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'session_id', '') = ''
      or exists (select 1 from auth.sessions s where s.id = (auth.jwt() ->> 'session_id')::uuid)
$$;

create or replace function public.require_admin()
returns void language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin(auth.uid()) or not public.session_is_live() then
    raise exception 'Only the admin can do this.' using errcode = '42501';
  end if;
end $$;

create or replace function public.require_super_admin()
returns void language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_super_admin(auth.uid()) or not public.session_is_live() then
    raise exception 'Only the super admin can do this.' using errcode = '42501';
  end if;
end $$;

create or replace function public.i_am_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select auth.uid() is not null and public.is_admin(auth.uid()) and public.session_is_live() $$;

create or replace function public.super_remove_admin(p_email text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_row public.app_admins;
begin
  perform public.require_super_admin();
  select * into v_row from public.app_admins where email = v_email;
  if not found then raise exception 'This email is not an admin.' using errcode = 'P0002'; end if;
  if v_row.level = 'super_admin' then
    raise exception 'The super admin cannot be removed.' using errcode = '42501';
  end if;
  delete from public.app_admins where email = v_email;
  if v_row.user_id is not null then
    -- The account becomes a normal student again (a teacher if it still owns classes).
    update public.profiles p
       set role = case when exists (select 1 from public.classes c where c.teacher_id = p.id)
                       then 'teacher'::public.user_role else 'student'::public.user_role end
     where p.id = v_row.user_id and p.role = 'admin';
    insert into public.streaks (student_id)
    select p.id from public.profiles p where p.id = v_row.user_id and p.role = 'student'
    on conflict do nothing;
  end if;
end $$;

-- ---------- Privileges ----------
revoke execute on function public.link_admin_accounts(), public.is_admin(uuid), public.is_super_admin(uuid),
  public.is_admin_account(uuid), public.is_super_admin_account(uuid), public.handle_new_user(),
  public.session_is_live(), public.require_admin(), public.require_super_admin()
from public, anon, authenticated;
revoke execute on function public.i_am_admin() from public, anon;
grant execute on function public.i_am_admin() to authenticated;
revoke execute on function public.my_access(), public.submit_payment(text, text, text, text, text),
  public.admin_review_payment(uuid, boolean, text), public.admin_delete_user(uuid),
  public.super_list_admins(), public.super_add_admin(text), public.super_remove_admin(text)
from public, anon;
grant execute on function public.my_access(), public.submit_payment(text, text, text, text, text),
  public.admin_review_payment(uuid, boolean, text), public.admin_delete_user(uuid),
  public.super_list_admins(), public.super_add_admin(text), public.super_remove_admin(text)
to authenticated;

commit;
