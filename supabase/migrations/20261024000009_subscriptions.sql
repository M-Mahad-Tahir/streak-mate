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
