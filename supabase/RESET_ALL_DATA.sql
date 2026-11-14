-- =====================================================================
-- Win Streak: FRESH START.
-- Deletes ALL tasks, submissions, teacher reviews, completion history,
-- badges and notifications, and resets every streak to 0.
-- User accounts and classes are KEPT, so everyone can still log in and
-- students stay in their classes.
--
-- THIS CANNOT BE UNDONE.
-- Paste into Supabase > SQL Editor and click Run.
-- =====================================================================

begin;

truncate table
  public.verifications,
  public.submissions,
  public.task_completions,
  public.tasks,
  public.badges,
  public.notifications;

update public.streaks
   set current_streak = 0, longest_streak = 0, last_win_date = null, updated_at = now();

commit;

-- Check: every count below should be 0.
select
  (select count(*) from public.tasks)         as tasks,
  (select count(*) from public.submissions)   as submissions,
  (select count(*) from public.notifications) as notifications,
  (select count(*) from public.badges)        as badges,
  (select coalesce(sum(current_streak + longest_streak), 0) from public.streaks) as streak_days;


-- =====================================================================
-- OPTIONAL: ALSO DELETE EVERY ACCOUNT AND CLASS (a completely empty app).
-- Everyone would have to sign up again.
-- To use it, remove the two dashes at the start of the next line, then Run.
-- =====================================================================
-- delete from auth.users;
