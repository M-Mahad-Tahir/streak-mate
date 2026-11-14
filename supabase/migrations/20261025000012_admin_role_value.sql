-- =====================================================================
-- Win Streak: add the "admin" role value.
-- Kept in its own migration (and its own transaction in RUN_THIS_UPDATE.sql)
-- because Postgres only allows a new enum value to be used after it is committed.
-- =====================================================================
alter type public.user_role add value if not exists 'admin';
