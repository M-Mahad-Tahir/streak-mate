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
