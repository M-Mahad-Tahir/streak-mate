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
