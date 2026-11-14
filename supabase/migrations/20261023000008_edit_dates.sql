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
