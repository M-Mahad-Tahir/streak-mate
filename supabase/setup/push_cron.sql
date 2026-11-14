-- =====================================================================
-- OPTIONAL: Web Push delivery schedule.
-- Run this once in the Supabase SQL editor AFTER deploying the
-- `send-push` Edge Function and setting its secrets (see README).
-- Replace the two placeholder values first.
-- =====================================================================
create extension if not exists pg_net;

-- Store the values in Supabase Vault (encrypted at rest).
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'win_streak_project_url');
select vault.create_secret('REPLACE-WITH-THE-SAME-PUSH_CRON_SECRET-YOU-SET-ON-THE-FUNCTION', 'win_streak_push_secret');

-- Every minute, ask the Edge Function to push any notifications not yet pushed.
select cron.schedule(
  'win-streak-push',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'win_streak_project_url')
           || '/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'win_streak_push_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
