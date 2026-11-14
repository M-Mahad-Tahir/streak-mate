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
