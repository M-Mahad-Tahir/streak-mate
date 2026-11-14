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
