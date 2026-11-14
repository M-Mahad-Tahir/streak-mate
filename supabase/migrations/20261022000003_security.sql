-- =====================================================================
-- Win Streak: privileges and Row Level Security
-- Principle: clients may only read rows they are entitled to and may only
-- write "content" columns. Every status transition goes through an RPC.
-- =====================================================================

-- ---------- Table privileges ----------
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

-- profiles: users may edit their name and timezone (never their role).
grant update (full_name, timezone) on public.profiles to authenticated;

-- classes: teachers may rename / delete their own classes (created via RPC).
grant update (name) on public.classes to authenticated;
grant delete on public.classes to authenticated;

-- class_members: teacher removes a student, or a student leaves (joined via RPC).
grant delete on public.class_members to authenticated;

-- tasks: students write content columns only; status changes via RPC.
alter table public.tasks alter column student_id set default auth.uid();
grant insert (student_id, class_id, title, description, due_date, due_time) on public.tasks to authenticated;
grant update (class_id, title, description, due_date, due_time) on public.tasks to authenticated;
grant delete on public.tasks to authenticated;

-- notifications: mark read / dismiss.
grant update (read_at) on public.notifications to authenticated;
grant delete on public.notifications to authenticated;

-- push subscriptions: saved via RPC, removed directly.
grant delete on public.push_subscriptions to authenticated;

-- ---------- Function privileges ----------
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema public from authenticated;

-- Helpers referenced inside RLS policies (they only describe the caller).
grant execute on function public.my_role()                         to authenticated;
grant execute on function public.i_am_member(uuid)                 to authenticated;
grant execute on function public.i_teach_class(uuid)               to authenticated;
grant execute on function public.i_teach(uuid)                     to authenticated;
grant execute on function public.i_teach_student_in(uuid, uuid)    to authenticated;
grant execute on function public.is_my_teacher(uuid)               to authenticated;

-- Public API (RPCs).
grant execute on function public.create_class(text)                                     to authenticated;
grant execute on function public.regenerate_class_code(uuid)                            to authenticated;
grant execute on function public.join_class(text)                                       to authenticated;
grant execute on function public.set_task_completed(uuid, boolean)                      to authenticated;
grant execute on function public.submit_task(uuid, uuid, text)                          to authenticated;
grant execute on function public.review_submission(uuid, public.review_decision, text)  to authenticated;
grant execute on function public.get_my_streak()                                        to authenticated;
grant execute on function public.get_win_calendar(date, date, uuid)                     to authenticated;
grant execute on function public.teacher_student_overview()                             to authenticated;
grant execute on function public.save_push_subscription(text, text, text)               to authenticated;
-- Internal only (no grant): notify, recompute_streak, win_days, local_today,
-- run_reminders, generate_class_code, trigger functions.

-- ---------- Enable RLS everywhere ----------
alter table public.profiles           enable row level security;
alter table public.classes            enable row level security;
alter table public.class_members      enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_completions   enable row level security;
alter table public.submissions        enable row level security;
alter table public.verifications      enable row level security;
alter table public.notifications      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.streaks            enable row level security;
alter table public.badges             enable row level security;

-- ---------- profiles ----------
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.i_teach(id) or public.is_my_teacher(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------- classes ----------
create policy classes_select on public.classes for select to authenticated
  using (teacher_id = auth.uid() or public.i_am_member(id));
create policy classes_update on public.classes for update to authenticated
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy classes_delete on public.classes for delete to authenticated
  using (teacher_id = auth.uid());

-- ---------- class_members ----------
create policy members_select on public.class_members for select to authenticated
  using (student_id = auth.uid() or public.i_teach_class(class_id));
create policy members_delete on public.class_members for delete to authenticated
  using (student_id = auth.uid() or public.i_teach_class(class_id));

-- ---------- tasks ----------
-- Teachers only see tasks linked to their class, for students still enrolled.
create policy tasks_select on public.tasks for select to authenticated
  using (student_id = auth.uid()
         or (class_id is not null and public.i_teach_student_in(class_id, student_id)));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (student_id = auth.uid()
              and public.my_role() = 'student'
              and (class_id is null or public.i_am_member(class_id)));
create policy tasks_update on public.tasks for update to authenticated
  using (student_id = auth.uid())
  with check (student_id = auth.uid() and (class_id is null or public.i_am_member(class_id)));
create policy tasks_delete on public.tasks for delete to authenticated
  using (student_id = auth.uid() and status in ('pending', 'completed', 'rejected'));

-- ---------- task_completions (private to the student) ----------
create policy completions_select on public.task_completions for select to authenticated
  using (student_id = auth.uid());

-- ---------- submissions & verifications ----------
create policy submissions_select on public.submissions for select to authenticated
  using (student_id = auth.uid() or teacher_id = auth.uid());
create policy verifications_select on public.verifications for select to authenticated
  using (student_id = auth.uid() or teacher_id = auth.uid());

-- ---------- notifications ----------
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());

-- ---------- push_subscriptions ----------
create policy push_select on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy push_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- ---------- streaks & badges ----------
create policy streaks_select on public.streaks for select to authenticated
  using (student_id = auth.uid() or public.i_teach(student_id));
create policy badges_select on public.badges for select to authenticated
  using (student_id = auth.uid() or public.i_teach(student_id));

-- ---------- Realtime: stream new notifications to the app ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
