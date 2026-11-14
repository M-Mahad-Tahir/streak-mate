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
