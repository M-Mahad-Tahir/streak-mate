-- =====================================================================
-- Win Streak: the admin user list also shows when each account last signed in.
-- (Passwords are never readable; the admin can send a password reset link instead.)
-- Requires migrations 009 and 013.
-- =====================================================================
drop function if exists public.admin_list_users();
create function public.admin_list_users()
returns table (id uuid, full_name text, email text, role public.user_role, created_at timestamptz,
               status text, trial_ends_at timestamptz, paid_until timestamptz, plan text, is_free boolean,
               is_admin boolean, last_sign_in_at timestamptz)
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
         public.is_admin(p.id),
         u.last_sign_in_at
  from public.profiles p
  left join public.subscriptions s on s.user_id = p.id
  left join auth.users u on u.id = p.id
  order by p.created_at desc;
end $$;

revoke execute on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;
