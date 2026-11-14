-- =====================================================================
-- Win Streak: hardening after review.
-- 1. Deleted (archived) tasks can no longer be completed, reopened or submitted.
-- 2. A teacher's decision is only saved for the exact wording they reviewed:
--    review_submission accepts the title/description the teacher saw and
--    refuses if the student edited the task in the meantime.
-- Requires migrations 20261023000005 and 20261023000006.
-- =====================================================================

create or replace function public.set_task_completed(p_task uuid, p_done boolean)
returns public.tasks
language plpgsql security definer set search_path = public
as $$
declare v_task public.tasks;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_task from public.tasks where id = p_task and student_id = auth.uid() and archived_at is null for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;

  if p_done then
    if v_task.status not in ('pending', 'rejected') then
      raise exception 'This task is already completed.' using errcode = '22023';
    end if;
    update public.tasks set status = 'completed', completed_at = now()
      where id = p_task returning * into v_task;
    insert into public.task_completions (task_id, student_id, completed_on, completed_at)
      values (p_task, auth.uid(), public.local_today(auth.uid()), now())
      on conflict (task_id) do nothing;
  else
    if v_task.status <> 'completed' then
      raise exception 'Only completed tasks that are not yet submitted can be reopened.' using errcode = '22023';
    end if;
    update public.tasks set status = 'pending', completed_at = null
      where id = p_task returning * into v_task;
    delete from public.task_completions where task_id = p_task;
  end if;

  perform public.recompute_streak(auth.uid());
  return v_task;
end $$;

create or replace function public.submit_task(p_task uuid, p_class uuid default null, p_note text default '')
returns public.submissions
language plpgsql security definer set search_path = public
as $$
declare
  v_task    public.tasks;
  v_class   public.classes;
  v_sub     public.submissions;
  v_student text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_task from public.tasks where id = p_task and student_id = auth.uid() and archived_at is null for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  if v_task.status = 'submitted' then
    raise exception 'This task is already waiting for review.' using errcode = '23505';
  end if;
  if v_task.status = 'verified' then
    raise exception 'This task is already verified.' using errcode = '23505';
  end if;
  if v_task.status <> 'completed' then
    raise exception 'Mark the task as completed before submitting it.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_note, '')) > 2000 then
    raise exception 'Submission note is too long (max 2000 characters).' using errcode = '22023';
  end if;

  select * into v_class from public.classes where id = coalesce(p_class, v_task.class_id);
  if not found then
    raise exception 'Choose the class (teacher) to submit this task to.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.class_members where class_id = v_class.id and student_id = auth.uid()) then
    raise exception 'You are not a member of that class.' using errcode = '42501';
  end if;

  insert into public.submissions (task_id, student_id, class_id, teacher_id, note)
  values (p_task, auth.uid(), v_class.id, v_class.teacher_id, coalesce(trim(p_note), ''))
  returning * into v_sub;

  update public.tasks set status = 'submitted', class_id = v_class.id where id = p_task;

  select full_name into v_student from public.profiles where id = auth.uid();
  perform public.notify(v_class.teacher_id, 'new_submission',
    'New submission from ' || v_student,
    v_task.title || ' (' || v_class.name || ')', '/teacher/review?submission=' || v_sub.id,
    'submission:' || v_sub.id);
  return v_sub;
end $$;

drop function if exists public.review_submission(uuid, public.review_decision, text);
create or replace function public.review_submission(
  p_submission uuid, p_decision public.review_decision, p_feedback text default '',
  p_expected_title text default null, p_expected_description text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_sub    public.submissions;
  v_task   public.tasks;
  v_new    public.task_status;
  v_ver    public.verifications;
  v_fb     text := trim(coalesce(p_feedback, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.my_role() is distinct from 'teacher' then
    raise exception 'Only teachers can review submissions.' using errcode = '42501';
  end if;

  select * into v_sub from public.submissions where id = p_submission for update;
  if not found or v_sub.teacher_id <> auth.uid() then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if v_sub.status <> 'submitted' then
    raise exception 'This submission has already been reviewed.' using errcode = '23505';
  end if;
  -- The teacher must approve exactly the wording they were shown.
  if p_expected_title is not null and (v_sub.task_title is distinct from p_expected_title
       or coalesce(v_sub.task_description, '') is distinct from coalesce(p_expected_description, '')) then
    raise exception 'The student changed this task while you were reviewing it. Reload to see the latest version.' using errcode = '40001';
  end if;
  if not public.i_teach_student_in(v_sub.class_id, v_sub.student_id) then
    raise exception 'This student is no longer in your class.' using errcode = '42501';
  end if;
  if p_decision = 'rejected' and char_length(v_fb) < 3 then
    raise exception 'Please explain what needs improvement (at least 3 characters).' using errcode = '22023';
  end if;
  if char_length(v_fb) > 2000 then
    raise exception 'Feedback is too long (max 2000 characters).' using errcode = '22023';
  end if;

  v_new := case p_decision when 'approved' then 'verified' else 'rejected' end;

  update public.submissions
     set status = (case p_decision when 'approved' then 'verified' else 'rejected' end)::public.submission_status,
         reviewed_at = now()
   where id = p_submission;

  insert into public.verifications (submission_id, task_id, teacher_id, student_id, decision, feedback)
  values (v_sub.id, v_sub.task_id, auth.uid(), v_sub.student_id, p_decision, v_fb)
  returning * into v_ver;

  if v_new = 'rejected' then
    update public.tasks set status = 'rejected', completed_at = null where id = v_sub.task_id returning * into v_task;
    delete from public.task_completions where task_id = v_sub.task_id;
    perform public.recompute_streak(v_sub.student_id);
    perform public.notify(v_sub.student_id, 'task_rejected', 'Needs improvement: ' || v_task.title,
      v_fb, '/student/history', 'review:' || v_ver.id);
  else
    update public.tasks set status = 'verified' where id = v_sub.task_id returning * into v_task;
    perform public.notify(v_sub.student_id, 'task_approved', 'Verified: ' || v_task.title,
      coalesce(nullif(v_fb, ''), 'Your teacher approved your work. Great job!'),
      '/student/history', 'review:' || v_ver.id);
  end if;

  return json_build_object('submission_id', v_sub.id, 'task_id', v_sub.task_id,
                           'task_status', v_task.status, 'verification_id', v_ver.id,
                           'reviewed_at', v_ver.created_at);
end $$;

revoke execute on function public.set_task_completed(uuid, boolean) from public, anon;
revoke execute on function public.submit_task(uuid, uuid, text) from public, anon;
revoke execute on function public.review_submission(uuid, public.review_decision, text, text, text) from public, anon;
grant execute on function public.set_task_completed(uuid, boolean) to authenticated;
grant execute on function public.submit_task(uuid, uuid, text) to authenticated;
grant execute on function public.review_submission(uuid, public.review_decision, text, text, text) to authenticated;
