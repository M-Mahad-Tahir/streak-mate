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
