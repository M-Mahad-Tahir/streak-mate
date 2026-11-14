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
