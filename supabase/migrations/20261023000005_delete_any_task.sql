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
