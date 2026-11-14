-- =====================================================================
-- Win Streak: scheduled reminders with pg_cron (runs inside the database,
-- so reminders work even when nobody has the app open).
-- =====================================================================
create extension if not exists pg_cron;

-- Every 10 minutes: due-soon, overdue, submit, pending-review reminders and streak roll-over.
select cron.schedule(
  'win-streak-reminders',
  '*/10 * * * *',
  $$ select public.run_reminders(); $$
);
