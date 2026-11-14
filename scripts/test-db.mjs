// Database test-suite for the Win Streak migrations.
// Runs the real SQL migrations inside PGlite (Postgres compiled to WASM) with a
// minimal stub of Supabase's `auth` schema and API roles, then exercises RLS,
// the RPCs, the streak engine and the reminder job as different users.
//
//   npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');

const db = new PGlite();
let passed = 0;
let failed = 0;

function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}
async function rejects(promise, pattern, name) {
  try {
    await promise;
    failed++; console.log(`  ✘ ${name} (expected an error, got success)`);
  } catch (e) {
    const msg = String(e.message || e);
    if (pattern.test(msg)) { passed++; console.log(`  ✔ ${name}`); }
    else { failed++; console.log(`  ✘ ${name} (unexpected error: ${msg})`); }
  }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;

// Run a callback as an authenticated user (mimics PostgREST).
async function as(uid, fn) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
  try { return await fn(); }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
async function asAnon(fn) {
  await db.exec(`set role anon;`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}

// ---------------------------------------------------------------------------
console.log('Bootstrapping Supabase-like environment...');
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  -- Minimal stand-in for Supabase Storage (schema "storage").
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
    name text, owner uuid default nullif(current_setting('request.jwt.claim.sub', true), '')::uuid, created_at timestamptz default now(),
    unique (bucket_id, name));
  create function storage.foldername(name text) returns text[] language plpgsql immutable as $f$
    declare _parts text[]; begin _parts := string_to_array(name, '/'); return _parts[1:array_length(_parts, 1) - 1]; end $f$;
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant all on storage.objects to authenticated;
  grant execute on function storage.foldername(text) to anon, authenticated;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, email_confirmed_at timestamptz default now(), last_sign_in_at timestamptz, encrypted_password text default 'hash');
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id) on delete cascade);
  create table auth.refresh_tokens (id bigserial primary key, token text, user_id varchar(255), session_id uuid references auth.sessions (id) on delete cascade);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Supabase's default privileges (so our revokes are tested realistically)
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && !f.includes('_cron')).sort();
for (const f of files) {
  console.log(`Applying ${f}`);
  await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
}

// ---------------------------------------------------------------------------
const T = '11111111-1111-1111-1111-111111111111';  // teacher
const T2 = '22222222-2222-2222-2222-222222222222'; // other teacher
const S1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // student
const S2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // other student

console.log('\n1. Sign-up creates profiles with the chosen role');
await db.exec(`
  insert into auth.users (id, email, raw_user_meta_data) values
   ('${T}',  't@x.com',  '{"role":"teacher","full_name":"Ms Teacher","timezone":"Asia/Karachi"}'),
   ('${T2}', 't2@x.com', '{"role":"teacher","full_name":"Other Teacher"}'),
   ('${S1}', 's1@x.com', '{"role":"student","full_name":"Sam Student","timezone":"UTC"}'),
   ('${S2}', 's2@x.com', '{"role":"admin","full_name":"Sneaky","timezone":"Not/AZone"}');
`);
const profs = await q(`select id, role, timezone from profiles order by email`);
ok(profs.find((p) => p.id === T).role === 'teacher', 'teacher role stored');
ok(profs.find((p) => p.id === T).timezone === 'Asia/Karachi', 'timezone stored');
ok(profs.find((p) => p.id === S2).role === 'student', 'unknown role falls back to student');
ok(profs.find((p) => p.id === S2).timezone === 'UTC', 'invalid timezone falls back to UTC');
ok((await q(`select * from streaks`)).length === 2, 'streak rows created for students only');

console.log('\n2. Profile protection');
await rejects(as(S1, () => q(`update profiles set role = 'teacher' where id = '${S1}'`)), /permission denied/, 'student cannot change own role');
await as(S1, () => q(`update profiles set full_name = 'Sam S.' where id = '${S1}'`));
ok((await q(`select full_name from profiles where id = '${S1}'`))[0].full_name === 'Sam S.', 'student can edit own name');
await rejects(as(S1, () => q(`update profiles set timezone = 'Mars/Base' where id = '${S1}'`)), /Unknown timezone/, 'invalid timezone rejected');
ok((await as(S1, () => q(`select id from profiles`))).length === 1, 'student sees only own profile (no class yet)');
await rejects(asAnon(() => q(`select * from tasks`)), /permission denied/, 'anonymous users cannot read tables');

console.log('\n3. Classes and joining by code');
const cls = (await as(T, () => q(`select * from create_class('Math 101')`)))[0];
ok(/^[A-Z0-9]{8}$/.test(cls.code), `class code generated (${cls.code})`);
await rejects(as(S1, () => q(`select create_class('Hack')`)), /Only teachers/, 'students cannot create classes');
await rejects(as(S1, () => q(`insert into classes (teacher_id, name, code) values ('${S1}', 'x', 'ABCDEFGH')`)), /permission denied/, 'direct class insert blocked');
await as(S1, () => q(`select join_class($1)`, [cls.code.toLowerCase()]));
ok((await q(`select * from class_members where student_id = '${S1}'`)).length === 1, 'student joined with case-insensitive code');
await rejects(as(S1, () => q(`select join_class($1)`, [cls.code])), /already in this class/, 'duplicate join blocked');
await rejects(as(S1, () => q(`select join_class('ZZZZZZZZ')`)), /No class found/, 'wrong code gives helpful error');
await rejects(as(T2, () => q(`select join_class($1)`, [cls.code])), /Only students/, 'teachers cannot join as students');
await rejects(as(S1, () => q(`insert into class_members (class_id, student_id) values ('${cls.id}', '${S2}')`)), /permission denied/, 'direct membership insert blocked');
ok((await q(`select * from notifications where user_id = '${T}' and type = 'class_joined'`)).length === 1, 'teacher notified of new student');
ok((await as(T, () => q(`select id from profiles`))).length === 2, 'teacher sees own + enrolled student profile');
ok((await as(T2, () => q(`select id from classes`))).length === 0, 'other teacher cannot see the class');
ok((await as(S1, () => q(`select id from classes`))).length === 1, 'member student can see the class');
ok((await as(S2, () => q(`select id from classes`))).length === 0, 'non-member student cannot see the class');

console.log('\n4. Tasks: creation and protection');
const today = (await q(`select local_today('${S1}') as d`))[0].d.toISOString().slice(0, 10);
const task = (await as(S1, () => q(
  `insert into tasks (title, description, due_date, due_time) values ('Essay', 'Write 500 words', $1, '18:00') returning *`, [today])))[0];
ok(task.status === 'pending' && task.student_id === S1, 'task created as pending for the caller');
ok(task.due_at instanceof Date, 'due_at derived on the server');
await rejects(as(S1, () => q(`insert into tasks (title, due_date, status) values ('x', $1, 'verified')`, [today])), /permission denied/, 'cannot insert a task with a status');
await rejects(as(S1, () => q(`update tasks set status = 'verified' where id = '${task.id}'`)), /permission denied/, 'cannot change status directly');
await rejects(as(S1, () => q(`insert into tasks (student_id, title, due_date) values ('${S2}', 'x', $1)`, [today])), /row-level security/, 'cannot create tasks for another student');
await rejects(as(T, () => q(`insert into tasks (title, due_date) values ('x', $1)`, [today])), /row-level security/, 'teachers cannot create student tasks');
ok((await as(S2, () => q(`select * from tasks`))).length === 0, 'other student cannot see the task');
ok((await as(T, () => q(`select * from tasks`))).length === 0, 'teacher cannot see private (unlinked) task');
await rejects(as(S1, () => q(`select submit_task('${task.id}', '${cls.id}', '')`)), /Mark the task as completed/, 'cannot submit before completing');
await rejects(as(S2, () => q(`select set_task_completed('${task.id}', true)`)), /Task not found/, 'other student cannot complete it');

console.log('\n5. Completing a task updates the streak');
await as(S1, () => q(`select set_task_completed('${task.id}', true)`));
ok((await q(`select status from tasks where id = '${task.id}'`))[0].status === 'completed', 'task marked completed');
ok((await q(`select * from task_completions where task_id = '${task.id}'`)).length === 1, 'one completion record');
let st = (await as(S1, () => q(`select * from get_my_streak()`)))[0];
ok(st.current_streak === 1 && st.longest_streak === 1, 'current streak = 1');
await rejects(as(S1, () => q(`select set_task_completed('${task.id}', true)`)), /already completed/, 'double completion blocked');
ok((await q(`select * from task_completions where task_id = '${task.id}'`)).length === 1, 'still exactly one completion (no double counting)');

console.log('\n6. Submission to the assigned teacher');
await rejects(as(S1, () => q(`select submit_task('${task.id}', null, '')`)), /Choose the class/, 'class required to submit');
const sub = (await as(S1, () => q(`select * from submit_task('${task.id}', '${cls.id}', 'Done, see doc')`)))[0];
ok(sub.status === 'submitted' && sub.teacher_id === T, 'submission routed to the class teacher');
await rejects(as(S1, () => q(`select submit_task('${task.id}', '${cls.id}', '')`)), /already waiting/, 'duplicate submission blocked');
await rejects(as(S1, () => q(`update tasks set class_id = null where id = '${task.id}'`)), /class is locked/, 'submitted task class is locked');
ok((await q(`select * from notifications where user_id = '${T}' and type = 'new_submission'`)).length === 1, 'teacher notified of submission');
ok((await as(T, () => q(`select * from tasks`))).length === 1, 'teacher can now see the linked task');
ok((await as(T2, () => q(`select * from submissions`))).length === 0, 'other teacher cannot see the submission');

console.log('\n7. Only the assigned teacher can verify');
await rejects(as(T2, () => q(`select review_submission('${sub.id}', 'approved', '')`)), /Submission not found/, 'other teacher cannot verify');
await rejects(as(S1, () => q(`select review_submission('${sub.id}', 'approved', '')`)), /Only teachers/, 'student cannot verify own work');
await rejects(as(T, () => q(`update submissions set status = 'verified' where id = '${sub.id}'`)), /permission denied/, 'teacher cannot bypass RPC');
await rejects(as(T, () => q(`select review_submission('${sub.id}', 'rejected', '  ')`)), /explain what needs improvement/, 'rejection requires feedback');

console.log('\n8. Rejection with feedback');
const rej = (await as(T, () => q(`select review_submission('${sub.id}', 'rejected', 'Add a conclusion') as r`)))[0].r;
ok(rej.task_status === 'rejected', 'server confirms rejected');
ok((await q(`select status from tasks where id = '${task.id}'`))[0].status === 'rejected', 'task status = rejected');
ok((await q(`select * from task_completions where task_id = '${task.id}'`)).length === 0, 'completion revoked on rejection');
ok((await q(`select current_streak from streaks where student_id = '${S1}'`))[0].current_streak === 0, 'streak recalculated after rejection');
ok((await q(`select * from notifications where user_id = '${S1}' and type = 'task_rejected'`)).length === 1, 'student notified of rejection');
await rejects(as(T, () => q(`select review_submission('${sub.id}', 'approved', '')`)), /already been reviewed/, 'cannot review twice');
ok((await as(S1, () => q(`select feedback from verifications`)))[0].feedback === 'Add a conclusion', 'student can read feedback');

console.log('\n9. Redo, resubmit, approve');
await as(S1, () => q(`update tasks set description = 'Write 500 words + conclusion' where id = '${task.id}'`));
await as(S1, () => q(`select set_task_completed('${task.id}', true)`));
const sub2 = (await as(S1, () => q(`select * from submit_task('${task.id}', null, 'Added conclusion')`)))[0];
const appr = (await as(T, () => q(`select review_submission('${sub2.id}', 'approved', 'Great work') as r`)))[0].r;
ok(appr.task_status === 'verified', 'server confirms verified');
ok((await q(`select status from tasks where id = '${task.id}'`))[0].status === 'verified', 'task status = verified');
ok((await q(`select * from notifications where user_id = '${S1}' and type = 'task_approved'`)).length === 1, 'student notified of approval');
const dueBefore = (await q(`select due_at from tasks where id = '${task.id}'`))[0].due_at.getTime();
await as(S1, () => q(`update tasks set due_time = '08:00' where id = '${task.id}'`));
const rowT = (await q(`select due_time, due_at, status from tasks where id = '${task.id}'`))[0];
ok(rowT.due_time.startsWith('08:00') && rowT.due_at.getTime() !== dueBefore && rowT.status === 'verified', 'verified task due time can be edited (stays verified)');
await as(S1, () => q(`delete from tasks where id = '${task.id}'`));
ok((await q(`select * from tasks where id = '${task.id}'`)).length === 1, 'verified task cannot be deleted');
await rejects(as(S1, () => q(`select set_task_completed('${task.id}', false)`)), /Only completed tasks/, 'verified task cannot be reopened');

console.log('\n10. Notifications privacy');
ok((await as(S2, () => q(`select * from notifications`))).length === 0, 'other student sees no foreign notifications');
const n = (await as(S1, () => q(`select id from notifications limit 1`)))[0];
await as(S1, () => q(`update notifications set read_at = now() where id = '${n.id}'`));
ok((await q(`select read_at from notifications where id = '${n.id}'`))[0].read_at !== null, 'student can mark own notification read');
await rejects(as(S1, () => q(`update notifications set title = 'x' where id = '${n.id}'`)), /permission denied/, 'cannot alter notification content');
await rejects(as(S1, () => q(`select notify('${S2}', 'overdue', 'spam', '', null, null)`)), /permission denied/, 'cannot call internal notify()');
await rejects(as(S1, () => q(`select run_reminders()`)), /permission denied/, 'cannot trigger the reminder job');

console.log('\n11. Streak engine (consecutive win days, local dates)');
await db.exec(`
  -- S2: five consecutive win days ending yesterday, plus an older 2-day run.
  do $$
  declare d int; v_id uuid; v_today date := local_today('${S2}');
  begin
    foreach d in array array[1,2,3,4,5, 9,10] loop
      insert into tasks (student_id, title, due_date, due_time)
        values ('${S2}', 'Day -' || d, v_today - d, '20:00') returning id into v_id;
      update tasks set status = 'completed', completed_at = now() where id = v_id;
      insert into task_completions (task_id, student_id, completed_on) values (v_id, '${S2}', v_today - d);
    end loop;
  end $$;
`);
st = (await q(`select * from recompute_streak('${S2}')`))[0];
ok(st.current_streak === 5, `current streak = 5 (got ${st.current_streak})`);
ok(st.longest_streak === 5, `longest streak = 5 (got ${st.longest_streak})`);
const badges = await q(`select code from badges where student_id = '${S2}' order by code`);
ok(badges.length === 1 && badges[0].code === 'streak_3', '3-day badge awarded once');
await q(`select recompute_streak('${S2}')`);
ok((await q(`select * from notifications where user_id = '${S2}' and type = 'badge_earned'`)).length === 1, 'badge notification not duplicated');
// An incomplete task due 3 days ago breaks that day.
await db.exec(`insert into tasks (student_id, title, due_date) values ('${S2}', 'Missed', local_today('${S2}') - 3)`);
st = (await q(`select * from recompute_streak('${S2}')`))[0];
ok(st.current_streak === 2 && st.longest_streak === 2, `missed task breaks the run (current ${st.current_streak}, longest ${st.longest_streak})`);
const s2today = (await q(`select local_today('${S2}')::text as d`))[0].d;
const cal = await as(S2, () => q(`select * from get_win_calendar($1::date - 6, $1::date)`, [s2today]));
ok(cal.length === 7 && cal.filter((c) => c.is_win).length === 4, 'calendar returns 7 days with 4 wins');
await rejects(as(T2, () => q(`select * from get_win_calendar(current_date - 6, current_date, '${S2}')`)), /Not allowed/, 'unrelated teacher cannot see student calendar');
ok((await as(T, () => q(`select * from streaks`))).length === 1, 'teacher sees streaks of own students only');

console.log('\n12. Scheduled reminders');
await db.exec(`
  insert into tasks (student_id, title, due_date, due_time) values
    ('${S2}', 'Soon',    (now() + interval '30 minutes')::date, ((now() + interval '30 minutes')::time)),
    ('${S2}', 'Late',    (now() - interval '2 hours')::date,  ((now() - interval '2 hours')::time));
  insert into submissions (task_id, student_id, class_id, teacher_id, submitted_at)
    select id, '${S2}', '${cls.id}', '${T}', now() - interval '13 hours' from tasks where title = 'Day -1';
`);
const sent1 = (await q(`select run_reminders() as n`))[0].n;
const sent2 = (await q(`select run_reminders() as n`))[0].n;
ok(sent1 > 0, `reminders created (${sent1})`);
ok(sent2 === 0, 'second run creates no duplicates');
const types = (await q(`select distinct type from notifications where type in ('due_soon','overdue','pending_reviews')`)).map((r) => r.type).sort();
ok(types.join(',') === 'due_soon,overdue,pending_reviews', `due-soon, overdue and teacher reminders sent (${types})`);

console.log('\n13. Removing a student withdraws open submissions');
const t3 = (await as(S1, () => q(`insert into tasks (title, due_date, class_id) values ('Lab', $1, '${cls.id}') returning id`, [today])))[0];
await as(S1, () => q(`select set_task_completed('${t3.id}', true)`));
const sub3 = (await as(S1, () => q(`select * from submit_task('${t3.id}', null, '')`)))[0];
await as(T, () => q(`delete from class_members where student_id = '${S1}'`));
ok((await q(`select * from submissions where id = '${sub3.id}'`)).length === 0, 'open submission withdrawn');
ok((await q(`select status from tasks where id = '${t3.id}'`))[0].status === 'completed', 'task returns to completed');
ok((await as(T, () => q(`select * from tasks where student_id = '${S1}'`))).length === 0, 'teacher loses access after removal');
ok((await q(`select class_id from tasks where id = '${t3.id}'`))[0].class_id === null, 'unfinished task unlinked from the class');
await as(S1, () => q(`update tasks set title = 'Lab (redo)' where id = '${t3.id}'`));
ok((await q(`select title from tasks where id = '${t3.id}'`))[0].title === 'Lab (redo)', 'student can still edit the unlinked task');
ok((await q(`select class_id from tasks where id = '${task.id}'`))[0].class_id === cls.id, 'verified task keeps its class link');

console.log('\n14. Teacher overview');
await as(S1, () => q(`select join_class($1)`, [cls.code]));
const ov = await as(T, () => q(`select * from teacher_student_overview()`));
ok(ov.length === 1 && ov[0].student_id === S1, 'overview lists enrolled students');
await rejects(as(S1, () => q(`select * from teacher_student_overview()`)), /Only teachers/, 'students cannot use teacher overview');

console.log('\n15. Deleting a class releases open submissions');
const cls2 = (await as(T2, () => q(`select * from create_class('Art')`)))[0];
await as(S2, () => q(`select join_class($1)`, [cls2.code]));
const t4 = (await as(S2, () => q(`insert into tasks (title, due_date, class_id) values ('Sketch', current_date, '${cls2.id}') returning id`)))[0];
await as(S2, () => q(`select set_task_completed('${t4.id}', true)`));
await as(S2, () => q(`select submit_task('${t4.id}', null, '')`));
const blocked = await as(T, () => q(`delete from classes where id = '${cls2.id}' returning id`));
ok(blocked.length === 0, 'other teacher cannot delete the class');
await as(T2, () => q(`delete from classes where id = '${cls2.id}'`));
const t4row = (await q(`select status, class_id from tasks where id = '${t4.id}'`))[0];
ok(t4row.status === 'completed' && t4row.class_id === null, `task released to completed and unlinked (${t4row.status})`);
ok((await q(`select * from submissions where class_id = '${cls2.id}'`)).length === 0, 'class submissions removed');
// A class with verified history can still be deleted (FK sets class_id to null on locked tasks).
let delErr = null;
try { await as(T, () => q(`delete from classes where id = '${cls.id}'`)); } catch (e) { delErr = e.message; }
ok(delErr === null, `class with verified tasks can be deleted${delErr ? ` (${delErr})` : ''}`);
ok((await q(`select status from tasks where id = '${task.id}'`))[0].status === 'verified', 'verified task keeps its status');

console.log('\n16. Deleting any task (archive keeps history)');
{
  const t5 = (await as(S1, () => q(`insert into tasks (title, due_date) values ('Throwaway', current_date) returning id`)))[0];
  const r1 = (await as(S1, () => q(`select delete_task('${t5.id}') as r`)))[0].r;
  ok(r1 === 'deleted' && (await q(`select * from tasks where id = '${t5.id}'`)).length === 0, 'untouched task is removed permanently');

  const vBefore = (await q(`select count(*)::int as n from verifications where task_id = '${task.id}'`))[0].n;
  const r2 = (await as(S1, () => q(`select delete_task('${task.id}') as r`)))[0].r;
  ok(r2 === 'archived', 'verified task can be deleted (archived)');
  ok((await as(S1, () => q(`select * from tasks where id = '${task.id}' and archived_at is null`))).length === 0, 'archived task hidden from active list');
  ok((await q(`select count(*)::int as n from verifications where task_id = '${task.id}'`))[0].n === vBefore, 'teacher verification records kept');
  await rejects(as(S1, () => q(`select delete_task('${task.id}')`)), /Task not found/, 'cannot delete twice');
  await as(S1, () => q(`update tasks set title = 'x' where id = '${task.id}'`));
  ok((await q(`select title from tasks where id = '${task.id}'`))[0].title !== 'x', 'archived task cannot be edited');

  const cls3 = (await as(T, () => q(`select * from create_class('Bio')`)))[0];
  await as(S1, () => q(`select join_class($1)`, [cls3.code]));
  const t6 = (await as(S1, () => q(`insert into tasks (title, due_date, class_id) values ('Cells', current_date, '${cls3.id}') returning id`)))[0];
  await as(S1, () => q(`select set_task_completed('${t6.id}', true)`));
  await as(S1, () => q(`select submit_task('${t6.id}', null, '')`));
  const r3 = (await as(S1, () => q(`select delete_task('${t6.id}') as r`)))[0].r;
  ok(r3 === 'archived' && (await q(`select * from submissions where task_id = '${t6.id}' and status = 'submitted'`)).length === 0, 'submitted task withdrawn and archived');
  ok((await q(`select * from task_completions where task_id = '${t6.id}'`)).length === 1, 'completion kept, so the streak is not lost');

  await rejects(as(S2, () => q(`select delete_task('${t6.id}')`)), /Task not found/, 'other students cannot delete it');
  const t7 = (await as(S1, () => q(`insert into tasks (title, due_date) values ('Done', current_date) returning id`)))[0];
  await as(S1, () => q(`select set_task_completed('${t7.id}', true)`));
  const del = await as(S1, () => q(`delete from tasks where id = '${t7.id}' returning id`));
  ok(del.length === 0, 'direct delete of finished work is blocked (must use delete_task)');
  const cal2 = await as(S1, () => q(`select * from get_win_calendar(current_date, current_date)`));
  ok(cal2.length === 1 && 'verified_count' in cal2[0], 'calendar reports verified work');
}

console.log('\n17. Editing any task (title/description editable, dates locked)');
{
  const cls4 = (await as(T, () => q(`select * from create_class('Chem')`)))[0];
  await as(S2, () => q(`select join_class($1)`, [cls4.code]));
  const t8 = (await as(S2, () => q(`insert into tasks (title, description, due_date, class_id) values ('Titration', 'Lab 1', current_date, '${cls4.id}') returning id`)))[0];
  await as(S2, () => q(`select set_task_completed('${t8.id}', true)`));
  const s8 = (await as(S2, () => q(`select * from submit_task('${t8.id}', null, '')`)))[0];
  ok(s8.task_title === 'Titration' && s8.task_description === 'Lab 1', 'submission stores a snapshot of the task');

  await as(S2, () => q(`update tasks set title = 'Titration v2', description = 'Lab 1 + graphs' where id = '${t8.id}'`));
  const snapOpen = (await q(`select task_title, task_description from submissions where id = '${s8.id}'`))[0];
  ok(snapOpen.task_title === 'Titration v2' && snapOpen.task_description === 'Lab 1 + graphs', 'editing a waiting task updates what the teacher reviews');
  ok((await q(`select status from tasks where id = '${t8.id}'`))[0].status === 'submitted', 'edit keeps the task submitted');

  await as(T, () => q(`select review_submission('${s8.id}', 'approved', 'Nice')`));
  await as(S2, () => q(`update tasks set title = 'Titration final', description = 'Edited after approval' where id = '${t8.id}'`));
  const row8 = (await q(`select title, status from tasks where id = '${t8.id}'`))[0];
  ok(row8.title === 'Titration final' && row8.status === 'verified', 'verified task title/description can be edited and stays verified');
  ok((await q(`select task_title from submissions where id = '${s8.id}'`))[0].task_title === 'Titration v2', 'teacher record keeps the version that was verified');
  await rejects(as(S2, () => q(`update tasks set class_id = null where id = '${t8.id}'`)), /class is locked/, 'verified task class is locked');
  await rejects(as(S2, () => q(`update tasks set status = 'pending' where id = '${t8.id}'`)), /permission denied/, 'status still cannot be edited directly');

  // Leaving the class must not make the verified task uneditable.
  await as(S2, () => q(`delete from class_members where class_id = '${cls4.id}' and student_id = '${S2}'`));
  await as(S2, () => q(`update tasks set description = 'Edited after leaving' where id = '${t8.id}'`));
  ok((await q(`select description from tasks where id = '${t8.id}'`))[0].description === 'Edited after leaving', 'verified task still editable after leaving the class');
  const other = await as(S1, () => q(`update tasks set title = 'hack' where id = '${t8.id}' returning id`));
  ok(other.length === 0, 'other students cannot edit it');
}

console.log('\n18. Review hardening (archived tasks, stale review)');
{
  const cls5 = (await as(T, () => q(`select * from create_class('Physics')`)))[0];
  await as(S2, () => q(`select join_class($1)`, [cls5.code]));
  // A deleted (archived) task cannot be submitted, completed or reopened from a stale tab.
  const t9 = (await as(S2, () => q(`insert into tasks (title, due_date, class_id) values ('Forces', current_date, '${cls5.id}') returning id`)))[0];
  await as(S2, () => q(`select set_task_completed('${t9.id}', true)`));
  ok((await as(S2, () => q(`select delete_task('${t9.id}') as r`)))[0].r === 'archived', 'completed task archived');
  await rejects(as(S2, () => q(`select submit_task('${t9.id}', null, '')`)), /Task not found/, 'archived task cannot be submitted');
  await rejects(as(S2, () => q(`select set_task_completed('${t9.id}', false)`)), /Task not found/, 'archived task cannot be reopened');
  ok((await q(`select * from task_completions where task_id = '${t9.id}'`)).length === 1, 'archived completion history is kept');
  ok((await q(`select * from submissions where task_id = '${t9.id}'`)).length === 0, 'no submission created for the deleted task');

  // The teacher's decision only applies to the wording they saw.
  const t10 = (await as(S2, () => q(`insert into tasks (title, description, due_date, class_id) values ('Essay', 'v1', current_date, '${cls5.id}') returning id`)))[0];
  await as(S2, () => q(`select set_task_completed('${t10.id}', true)`));
  const s10 = (await as(S2, () => q(`select * from submit_task('${t10.id}', null, '')`)))[0];
  await as(S2, () => q(`update tasks set title = 'Essay (rewritten)', description = 'v2' where id = '${t10.id}'`));
  await rejects(as(T, () => q(`select review_submission('${s10.id}', 'approved', '', 'Essay', 'v1')`)), /changed this task while you were reviewing/, 'stale approval is refused');
  ok((await q(`select status from submissions where id = '${s10.id}'`))[0].status === 'submitted', 'submission still waiting after the refused approval');
  const okRes = (await as(T, () => q(`select review_submission('${s10.id}', 'approved', '', 'Essay (rewritten)', 'v2') as r`)))[0].r;
  ok(okRes.task_status === 'verified', 'approval of the wording the teacher saw succeeds');
  ok((await q(`select task_title from submissions where id = '${s10.id}'`))[0].task_title === 'Essay (rewritten)', 'teacher record matches what was approved');
  await rejects(as(S2, () => q(`select review_submission('${s10.id}', 'approved', '', null, null)`)), /Only teachers/, 'students still cannot review');
}

console.log('\n19. Editing dates and times on any task');
{
  const SX = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${SX}', 'sx@x.com', '{"role":"student","full_name":"Date Tester"}')`);
  const cls6 = (await as(T, () => q(`select * from create_class('History')`)))[0];
  await as(SX, () => q(`select join_class($1)`, [cls6.code]));
  const today6 = (await q(`select local_today('${SX}')::text as d`))[0].d;

  // Verified task due today, completed today => today is a Win Day (streak 1).
  const tv = (await as(SX, () => q(`insert into tasks (title, due_date, class_id) values ('Ch 1', $1, '${cls6.id}') returning id`, [today6])))[0];
  await as(SX, () => q(`select set_task_completed('${tv.id}', true)`));
  const sv = (await as(SX, () => q(`select * from submit_task('${tv.id}', null, '')`)))[0];
  await as(T, () => q(`select review_submission('${sv.id}', 'approved', 'ok')`));
  ok((await q(`select current_streak from streaks where student_id = '${SX}'`))[0].current_streak === 1, 'starts with a 1-day streak');

  // Move the verified task's date and time: allowed, stays verified, due_at recomputed.
  await as(SX, () => q(`update tasks set due_date = $1::date + 2, due_time = '09:30' where id = '${tv.id}'`, [today6]));
  const rv = (await q(`select status, due_date::text as d, due_time::text as tm from tasks where id = '${tv.id}'`))[0];
  ok(rv.status === 'verified' && rv.tm.startsWith('09:30'), 'verified task date and time edited, still verified');

  // Another task due today that is NOT done: moving the verified one away leaves today unfinished => streak drops to 0 immediately.
  const tp = (await as(SX, () => q(`insert into tasks (title, due_date) values ('Unfinished', $1) returning id`, [today6])))[0];
  await as(SX, () => q(`update tasks set due_time = '22:00' where id = '${tp.id}'`)); // time-only edit does not recompute
  await as(SX, () => q(`update tasks set due_date = due_date where id = '${tv.id}'`));
  await as(SX, () => q(`update tasks set due_date = $1::date + 3 where id = '${tv.id}'`, [today6]));
  ok((await q(`select current_streak from streaks where student_id = '${SX}'`))[0].current_streak === 0, 'streak recalculated right after a date change');

  // Submitted task: date editable, class still locked.
  const ts = (await as(SX, () => q(`insert into tasks (title, due_date, class_id) values ('Ch 2', $1, '${cls6.id}') returning id`, [today6])))[0];
  await as(SX, () => q(`select set_task_completed('${ts.id}', true)`));
  await as(SX, () => q(`select submit_task('${ts.id}', null, '')`));
  await as(SX, () => q(`update tasks set due_date = $1::date + 1 where id = '${ts.id}'`, [today6]));
  ok((await q(`select status from tasks where id = '${ts.id}'`))[0].status === 'submitted', 'submitted task date edited, still waiting for review');
  await rejects(as(SX, () => q(`update tasks set class_id = null where id = '${ts.id}'`)), /class is locked/, 'submitted task class still locked');
  const hack = await as(S1, () => q(`update tasks set due_date = due_date + 5 where id = '${ts.id}' returning id`));
  ok(hack.length === 0, 'other students cannot change the date');
}

console.log('\n20. Free trial, subscriptions, free emails and admin');
{
  const ADMIN = 'adadadad-adad-adad-adad-adadadadadad';
  const FREE = 'fefefefe-fefe-fefe-fefe-fefefefefefe';
  const PAYER = 'abababab-abab-abab-abab-abababababab';
  const FAKE = 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0';
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
    ('${ADMIN}', 'M.MahadTahir8817api.key@gmail.com', '{"role":"student","full_name":"Site Admin"}', now()),
    ('${FREE}',  'hadiatahir700@gmail.com', '{"role":"student","full_name":"Free Student"}', now()),
    ('${PAYER}', 'payer@x.com', '{"role":"student","full_name":"Paying Student"}', now()),
    ('${FAKE}',  'tahirtufail1979@gmail.com', '{"role":"teacher","full_name":"Unconfirmed"}', null)`);

  const acc = async (uid) => (await as(uid, () => q(`select my_access() as a`)))[0].a;
  // Signing up with an admin email is not enough: the owner links it (runs the update again).
  const before = await acc(ADMIN);
  ok(before.is_admin === false && before.admin_pending === 'super_admin', 'super admin email is not admin until it is linked to its account');
  ok((await q(`select role from profiles where id = '${ADMIN}'`))[0].role === 'student', 'signing up with an admin email gives the chosen role, not Admin');
  await db.exec(`select public.link_admin_accounts()`);
  ok((await acc(ADMIN)).admin_pending === null, 'linked admin has nothing pending');
  ok((await acc(PAYER)).status === 'trial', 'new account starts a free trial');
  const trialDays = (await q(`select extract(day from trial_ends_at - now())::int as d from subscriptions where user_id = '${PAYER}'`))[0].d;
  ok(trialDays >= 29 && trialDays <= 30, `trial lasts 30 days (${trialDays})`);
  ok((await acc(ADMIN)).status === 'admin' && (await acc(ADMIN)).is_admin, 'admin email is admin (case-insensitive)');
  ok((await acc(FREE)).status === 'free', 'listed email has free access');
  ok((await acc(FAKE)).status === 'trial', 'unconfirmed email does NOT get free access');

  // Trial over: view only.
  await db.exec(`update subscriptions set trial_ends_at = now() - interval '1 day' where user_id in ('${PAYER}', '${FREE}', '${ADMIN}')`);
  const a1 = await acc(PAYER);
  ok(a1.status === 'expired' && a1.read_only === true, 'after the trial the account is view-only');
  await rejects(as(PAYER, () => q(`insert into tasks (title, due_date) values ('x', current_date)`)), /free trial has ended/, 'view-only: cannot add a task');
  ok(Array.isArray(await as(PAYER, () => q(`select * from tasks`))), 'view-only: can still read tasks');
  ok((await as(PAYER, () => q(`select * from get_my_streak()`))).length === 1, 'view-only: dashboard streak still loads');
  await rejects(as(PAYER, () => q(`select join_class('ABCDEFGH')`)), /No class found|free trial has ended/, 'view-only: join attempt refused');
  ok((await acc(FREE)).read_only === false, 'free email keeps full access after the trial');
  await as(FREE, () => q(`insert into tasks (title, due_date) values ('free task', current_date)`));
  ok((await q(`select count(*)::int as n from tasks where student_id = '${FREE}'`))[0].n === 1, 'free email can add tasks');

  // Payment flow.
  // Screenshot upload: only into your own folder.
  await as(PAYER, () => q(`insert into storage.objects (bucket_id, name) values ('payment-proofs', '${PAYER}/receipt1.png')`));
  await rejects(as(PAYER, () => q(`insert into storage.objects (bucket_id, name) values ('payment-proofs', '${FREE}/fake.png')`)), /row-level security/, "cannot upload into another user's folder");
  ok((await as(FREE, () => q(`select * from storage.objects where bucket_id = 'payment-proofs' and name like '${PAYER}/%'`))).length === 0, "users cannot see other users' screenshots");
  ok((await as(ADMIN, () => q(`select * from storage.objects where bucket_id = 'payment-proofs' and name like '${PAYER}/%'`))).length === 1, 'admin can open payment screenshots');
  const proof = `${PAYER}/receipt1.png`;
  await rejects(as(PAYER, () => q(`select submit_payment('weekly', '03001234567', 'ABC12345', 'Sam Payer', '${proof}')`)), /monthly or the yearly/, 'invalid plan rejected');
  await rejects(as(PAYER, () => q(`select submit_payment('monthly', '03001234567', 'ABC12345', ' ', '${proof}')`)), /name on the JazzCash account/, 'payer name is mandatory');
  await rejects(as(PAYER, () => q(`select submit_payment('monthly', '03001234567', '', 'Sam Payer', '${proof}')`)), /Transaction ID/, 'TID is mandatory');
  await rejects(as(PAYER, () => q(`select submit_payment('monthly', '03001234567', 'ABC12345', 'Sam Payer', '')`)), /Upload a screenshot/, 'screenshot is mandatory');
  await rejects(as(PAYER, () => q(`select submit_payment('monthly', '03001234567', 'ABC12345', 'Sam Payer', '${PAYER}/not-uploaded.png')`)), /Upload a screenshot/, 'screenshot must really be uploaded');
  await rejects(as(FREE, () => q(`select submit_payment('monthly', '03001234567', 'ABC12345', 'Hadia', '${proof}')`)), /Upload a screenshot/, "cannot use someone else's screenshot");
  await rejects(as(PAYER, () => q(`select submit_payment('monthly', '12', 'ABC12345', 'Sam Payer', '${proof}')`)), /JazzCash number/, 'invalid sender number rejected');
  await rejects(as(PAYER, () => q(`select submit_payment('monthly', '03001234567', 'ab', 'Sam Payer', '${proof}')`)), /Transaction ID/, 'invalid TID rejected');
  const pay = (await as(PAYER, () => q(`select * from submit_payment('yearly', '0300-1234567', ' tid 123456 ', ' Sam Payer ', '${proof}')`)))[0];
  ok(pay.sender_name === 'Sam Payer' && pay.screenshot_path === proof, 'payment stores payer name and screenshot');
  ok(pay.amount_pkr === 14000 && Number(pay.amount_usd) === 50 && pay.transaction_id === 'TID123456' && pay.status === 'pending', 'yearly payment recorded: Rs 14,000 / $50, TID normalized');
  await rejects(as(PAYER, () => q(`select submit_payment('monthly', '03001234567', 'OTHER999', 'Sam Payer', '${proof}')`)), /already have a payment waiting/, 'only one pending payment at a time');
  await as(FREE, () => q(`insert into storage.objects (bucket_id, name) values ('payment-proofs', '${FREE}/r.png')`));
  await rejects(as(FREE, () => q(`select submit_payment('monthly', '03001234567', 'tid123456', 'Hadia', '${FREE}/r.png')`)), /already submitted/, 'the same TID cannot be reused');
  await as(PAYER, () => q(`delete from storage.objects where name = '${proof}'`)); // blocked by policy: removes nothing
  ok((await q(`select count(*)::int as n from storage.objects where name = '${proof}'`))[0].n === 1, 'used screenshot is kept');
  ok((await q(`select count(*)::int as n from notifications where user_id = '${ADMIN}' and type = 'payment_submitted'`))[0].n === 1, 'admin notified of the new payment');
  await rejects(as(PAYER, () => q(`update payments set status = 'approved'`)), /permission denied/, 'users cannot approve their own payment');
  await rejects(as(PAYER, () => q(`update subscriptions set paid_until = now() + interval '9 years'`)), /permission denied/, 'users cannot extend their own subscription');
  ok((await as(FREE, () => q(`select * from payments`))).length === 0, "users cannot see other users' payments");

  // Admin only.
  await rejects(as(PAYER, () => q(`select admin_review_payment('${pay.id}', true, '')`)), /Only the admin/, 'non-admin cannot approve payments');
  await rejects(as(T, () => q(`select * from admin_list_users()`)), /Only the admin/, 'teachers are not admins');
  await rejects(as(FAKE, () => q(`select admin_overview()`)), /Only the admin/, 'unconfirmed account cannot act as admin');
  const ov = (await as(ADMIN, () => q(`select admin_overview() as o`)))[0].o;
  ok(ov.pending_payments === 1 && ov.users >= 4, 'admin overview counts users and pending payments');
  const pend = await as(ADMIN, () => q(`select * from admin_list_payments('pending')`));
  ok(pend.length === 1 && pend[0].email === 'payer@x.com', 'admin sees pending payments with the payer');
  ok(pend[0].sender_name === 'Sam Payer' && pend[0].screenshot_path === proof, 'admin sees payer name and screenshot');
  await rejects(as(ADMIN, () => q(`select admin_review_payment('${pay.id}', false, '')`)), /reason/, 'rejecting needs a reason');
  const res = (await as(ADMIN, () => q(`select admin_review_payment('${pay.id}', true, '') as r`)))[0].r;
  ok(res.status === 'approved', 'admin approves the payment');
  const a2 = await acc(PAYER);
  const years = (await q(`select extract(day from paid_until - now())::int as d from subscriptions where user_id = '${PAYER}'`))[0].d;
  ok(a2.status === 'active' && a2.read_only === false && years >= 364, `yearly plan active for a year (${years} days)`);
  ok((await q(`select count(*)::int as n from notifications where user_id = '${PAYER}' and type = 'payment_approved'`))[0].n === 1, 'payer notified of approval');
  await as(PAYER, () => q(`insert into tasks (title, due_date) values ('paid task', current_date)`));
  ok((await q(`select count(*)::int as n from tasks where student_id = '${PAYER}'`))[0].n === 1, 'paid account can add tasks again');
  await rejects(as(ADMIN, () => q(`select admin_review_payment('${pay.id}', false, 'again')`)), /already reviewed/, 'a payment cannot be reviewed twice');

  // Reject flow + admin free-access management.
  const pay2 = (await as(FREE, () => q(`select * from submit_payment('monthly', '03111111111', 'MONTH0001', 'Hadia Tahir', '${FREE}/r.png')`)))[0];
  ok(pay2.amount_pkr === 1400 && Number(pay2.amount_usd) === 5, 'monthly payment is Rs 1,400 / $5');
  await as(ADMIN, () => q(`select admin_review_payment('${pay2.id}', false, 'TID not found in JazzCash')`));
  ok((await q(`select status, admin_note from payments where id = '${pay2.id}'`))[0].status === 'rejected', 'admin rejects with a reason');
  await as(ADMIN, () => q(`select admin_set_free_access('Payer@X.com', true)`));
  await db.exec(`update subscriptions set paid_until = now() - interval '1 day' where user_id = '${PAYER}'`);
  ok((await acc(PAYER)).status === 'free', 'admin can give an account free access');
  await as(ADMIN, () => q(`select admin_set_free_access('payer@x.com', false)`));
  ok((await acc(PAYER)).status === 'expired', 'admin can remove free access');
  const users = await as(ADMIN, () => q(`select * from admin_list_users()`));
  ok(users.find((u) => u.id === FREE)?.is_free === true && users.find((u) => u.id === ADMIN)?.is_admin === true, 'admin user list shows free and admin flags');
}

console.log('\n21. Admin can edit everything');
{
  const ADMIN = 'adadadad-adad-adad-adad-adadadadadad';
  const TEACH = 'e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1';
  const STU = 'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2';
  const GONE = 'e3e3e3e3-e3e3-e3e3-e3e3-e3e3e3e3e3e3';
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
    ('${TEACH}', 'teach21@x.com', '{"role":"teacher","full_name":"Teacher 21"}'),
    ('${STU}', 'stu21@x.com', '{"role":"student","full_name":"Student 21"}'),
    ('${GONE}', 'gone21@x.com', '{"role":"student","full_name":"Gone 21"}')`);
  const cls = (await as(TEACH, () => q(`select * from create_class('Admin test class')`)))[0];
  await as(STU, () => q(`select join_class($1)`, [cls.code]));
  const tk = (await as(STU, () => q(`insert into tasks (title, due_date, class_id) values ('Essay 21', current_date, '${cls.id}') returning id`)))[0];

  // Non-admins are blocked from every admin tool.
  for (const sql of [
    `select admin_update_user('${STU}', 'x', 'teacher')`, `select admin_delete_user('${GONE}')`,
    `select admin_set_subscription('${STU}', now() + interval '1 year', null, null)`, `select * from admin_list_tasks('')`,
    `select admin_update_task('${tk.id}', 'x', '', current_date, '10:00', 'verified')`, `select admin_delete_task('${tk.id}')`,
    `select * from admin_list_classes()`, `select admin_update_class('${cls.id}', 'x')`, `select admin_delete_class('${cls.id}')`,
    `select admin_add_member('${cls.id}', 'gone21@x.com')`, `select admin_remove_member('${cls.id}', '${STU}')`,
  ]) {
    await rejects(as(TEACH, () => q(sql)), /Only the admin/, `teacher blocked: ${sql.slice(7, 40)}`);
  }

  // Users
  await as(ADMIN, () => q(`select admin_update_user('${STU}', 'Student Renamed', 'student')`));
  ok((await q(`select full_name from profiles where id = '${STU}'`))[0].full_name === 'Student Renamed', 'admin renames a user');
  await rejects(as(ADMIN, () => q(`select admin_update_user('${TEACH}', 'T', 'student')`)), /still has classes/, 'teacher with classes cannot become student');
  await as(ADMIN, () => q(`select admin_update_user('${GONE}', 'Gone 21', 'teacher')`));
  ok((await q(`select role from profiles where id = '${GONE}'`))[0].role === 'teacher', 'admin changes a role');
  await as(ADMIN, () => q(`select admin_set_subscription('${STU}', now() + interval '90 days', now() + interval '1 year', 'yearly')`));
  const sub = (await q(`select extract(day from trial_ends_at - now())::int as t, plan from subscriptions where user_id = '${STU}'`))[0];
  ok(sub.t >= 89 && sub.plan === 'yearly', 'admin sets trial and paid dates');
  await rejects(as(ADMIN, () => q(`select admin_delete_user('${ADMIN}')`)), /own account/, 'admin cannot delete themself');
  await as(ADMIN, () => q(`select admin_delete_user('${GONE}')`));
  ok((await q(`select * from profiles where id = '${GONE}'`)).length === 0, 'admin deletes an account');

  // Tasks
  const all = await as(ADMIN, () => q(`select * from admin_list_tasks('essay 21')`));
  ok(all.length === 1 && all[0].student_name === 'Student Renamed', 'admin searches all tasks');
  await rejects(as(ADMIN, () => q(`select admin_update_task('${tk.id}', 'x', '', current_date, '10:00', 'submitted')`)), /Only the student can submit/, 'admin cannot fake a submission');
  const upd = (await as(ADMIN, () => q(`select * from admin_update_task('${tk.id}', 'Essay (admin)', 'fixed', current_date, '10:00', 'verified')`)))[0];
  ok(upd.status === 'verified' && upd.title === 'Essay (admin)' && upd.completed_at !== null, 'admin edits title and sets status to verified');
  ok((await q(`select * from task_completions where task_id = '${tk.id}'`)).length === 1, 'completion recorded when admin marks it done');
  ok((await q(`select current_streak from streaks where student_id = '${STU}'`))[0].current_streak === 1, 'student streak recalculated');
  await as(ADMIN, () => q(`select admin_update_task('${tk.id}', 'Essay (admin)', 'fixed', current_date, '10:00', 'pending')`));
  ok((await q(`select * from task_completions where task_id = '${tk.id}'`)).length === 0 && (await q(`select current_streak from streaks where student_id = '${STU}'`))[0].current_streak === 0, 'setting back to pending removes the completion and the streak day');

  // Admin can change a submitted task: the open review is withdrawn.
  await as(STU, () => q(`select set_task_completed('${tk.id}', true)`));
  await as(STU, () => q(`select submit_task('${tk.id}', null, '')`));
  await as(ADMIN, () => q(`select admin_update_task('${tk.id}', 'Essay (admin)', 'fixed', current_date, '10:00', 'completed')`));
  ok((await q(`select * from submissions where task_id = '${tk.id}' and status = 'submitted'`)).length === 0, 'changing a submitted task withdraws the open review');

  // Classes
  await as(ADMIN, () => q(`select admin_update_class('${cls.id}', 'Renamed by admin')`));
  ok((await q(`select name from classes where id = '${cls.id}'`))[0].name === 'Renamed by admin', 'admin renames a class');
  const lc = (await as(ADMIN, () => q(`select * from admin_list_classes()`))).find((c) => c.id === cls.id);
  ok(lc && lc.members.length === 1 && lc.teacher_name === 'Teacher 21', 'admin lists classes with teacher and members');
  await as(ADMIN, () => q(`select admin_remove_member('${cls.id}', '${STU}')`));
  ok((await q(`select * from class_members where class_id = '${cls.id}'`)).length === 0, 'admin removes a student');
  await as(ADMIN, () => q(`select admin_add_member('${cls.id}', 'STU21@x.com')`));
  ok((await q(`select * from class_members where class_id = '${cls.id}'`)).length === 1, 'admin adds a student by email');
  await rejects(as(ADMIN, () => q(`select admin_add_member('${cls.id}', 'teach21@x.com')`)), /Only students/, 'teachers cannot be added as class members');
  await rejects(as(ADMIN, () => q(`select admin_add_member('${cls.id}', 'stu21@x.com')`)), /already in the class/, 'duplicate member refused');
  await as(ADMIN, () => q(`select admin_delete_task('${tk.id}')`));
  ok((await q(`select * from tasks where id = '${tk.id}'`)).length === 0, 'admin deletes any task');
  await as(ADMIN, () => q(`select admin_delete_class('${cls.id}')`));
  ok((await q(`select * from classes where id = '${cls.id}'`)).length === 0, 'admin deletes a class');
}

console.log('\n22. The admin account has no Student/Teacher role');
{
  const ADMIN = 'adadadad-adad-adad-adad-adadadadadad';
  const TEACH = 'e4e4e4e4-e4e4-e4e4-e4e4-e4e4e4e4e4e4';
  const STU = 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5';
  const OLDADM = 'e6e6e6e6-e6e6-e6e6-e6e6-e6e6e6e6e6e6';
  ok((await q(`select role from profiles where id = '${ADMIN}'`))[0].role === 'admin', 'linked admin account has role "admin" (not student/teacher)');
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
    ('${TEACH}', 'teach22@x.com', '{"role":"teacher","full_name":"Teacher 22"}'),
    ('${STU}', 'stu22@x.com', '{"role":"student","full_name":"Student 22"}'),
    ('${OLDADM}', 'second.admin@x.com', '{"role":"student","full_name":"Second Admin"}')`);
  const cls = (await as(TEACH, () => q(`select * from create_class('Class 22')`)))[0];

  // The admin cannot act as a student or a teacher.
  await rejects(as(ADMIN, () => q(`select join_class($1)`, [cls.code])), /Only students/, 'admin cannot join a class');
  await rejects(as(ADMIN, () => q(`insert into tasks (title, due_date) values ('x', current_date)`)), /row-level security/, 'admin cannot create student tasks');
  await rejects(as(ADMIN, () => q(`select create_class('Admin class')`)), /Only teachers/, 'admin cannot create a class');
  await rejects(as(ADMIN, () => q(`select * from teacher_student_overview()`)), /Only teachers/, 'admin has no teacher dashboard');
  await rejects(as(ADMIN, () => q(`select * from get_my_streak()`)), /Only students/, 'admin has no streak page');
  ok((await as(ADMIN, () => q(`select admin_overview() as o`)))[0].o.users > 0, 'admin tools still work');

  // Role editing rules.
  await as(ADMIN, () => q(`select admin_update_user('${ADMIN}', 'Site Admin', 'teacher')`));
  ok((await q(`select role from profiles where id = '${ADMIN}'`))[0].role === 'admin', 'admin account role cannot be changed to student/teacher');
  await rejects(as(ADMIN, () => q(`select admin_update_user('${STU}', 'Student 22', 'admin')`)), /Choose Student or Teacher/, 'nobody else can be given the admin role');
  await rejects(as(STU, () => q(`update profiles set role = 'admin' where id = '${STU}'`)), /permission denied/, 'users cannot make themselves admin');

  // An existing account whose email is put in the admin list stays a normal account when
  // the update runs again; the super admin converts it by activating it (Admins tab).
  await as(OLDADM, () => q(`select join_class($1)`, [cls.code]));
  await db.exec(`insert into app_admins (email) values ('second.admin@x.com')`);
  // Re-run the update from migration 013 onward, in order (like RUN_THIS_UPDATE.sql does).
  for (const f of readdirSync(migrationsDir).filter((x) => x >= '20261025000013' && x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  }
  ok((await q(`select role from profiles where id = '${OLDADM}'`))[0].role === 'student' && (await q(`select * from class_members where student_id = '${OLDADM}'`)).length === 1, 'the update does not convert a plain admin email by itself');
  await as(ADMIN, () => q(`select super_add_admin('second.admin@x.com')`));
  ok((await q(`select role from profiles where id = '${OLDADM}'`))[0].role === 'admin', 'existing account converted to role "admin" when the super admin activates it');
  ok((await q(`select * from class_members where student_id = '${OLDADM}'`)).length === 0, 'converted admin removed from classes');
  ok((await q(`select role from profiles where id = '${STU}'`))[0].role === 'student' && (await q(`select role from profiles where id = '${TEACH}'`))[0].role === 'teacher', 'other accounts keep their roles');
  const counts = (await as(ADMIN, () => q(`select admin_overview() as o`)))[0].o;
  const realStudents = (await q(`select count(*)::int as n from profiles where role = 'student'`))[0].n;
  ok(counts.students === realStudents, 'admins are not counted as students or teachers');
}

console.log('\n23. Admin sees when each account last signed in (never passwords)');
{
  const ADMIN = 'adadadad-adad-adad-adad-adadadadadad';
  await db.exec(`update auth.users set last_sign_in_at = now() - interval '2 hours' where id = '${S1}'`);
  const users = await as(ADMIN, () => q(`select * from admin_list_users()`));
  const s1 = users.find((u) => u.id === S1);
  ok(s1 && s1.last_sign_in_at instanceof Date, 'admin user list includes "last signed in"');
  ok(users.some((u) => u.last_sign_in_at === null), 'accounts that never signed in show no date');
  ok(!Object.keys(s1).some((k) => /pass|hash|encrypted/i.test(k)), 'no password information is returned');
  await rejects(as(T, () => q(`select * from admin_list_users()`)), /Only the admin/, 'only the admin can see the user list');
}

console.log('\n24. Super Admin and Admin');
{
  const SUPER = 'adadadad-adad-adad-adad-adadadadadad'; // m.mahadtahir8817api.key@gmail.com
  const ADM = 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2';   // m.mahadtahir322@gmail.com
  const ADM2 = 'a3a3a3a3-a3a3-a3a3-a3a3-a3a3a3a3a3a3';
  const STU = 'a4a4a4a4-a4a4-a4a4-a4a4-a4a4a4a4a4a4';
  const TCH = 'a5a5a5a5-a5a5-a5a5-a5a5-a5a5a5a5a5a5';
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
    ('${ADM}', 'M.MahadTahir322@gmail.com', '{"role":"teacher","full_name":"Mahad Admin"}'),
    ('${ADM2}', 'helper24@x.com', '{"role":"student","full_name":"Future Admin"}'),
    ('${STU}', 'stu24@x.com', '{"role":"student","full_name":"Student 24"}'),
    ('${TCH}', 'tch24@x.com', '{"role":"teacher","full_name":"Teacher 24"}')`);
  const acc = async (uid) => (await as(uid, () => q(`select my_access() as a`)))[0].a;

  // Levels
  const levels = await q(`select email, level from app_admins where email in ('m.mahadtahir8817api.key@gmail.com', 'm.mahadtahir322@gmail.com') order by level desc`);
  ok(levels.length === 2 && levels[0].level === 'super_admin' && levels[0].email === 'm.mahadtahir8817api.key@gmail.com' && levels[1].level === 'admin', 'super admin and admin emails stored with their level');
  // The admin email signed up after the update: it waits until the super admin activates it.
  const waiting = await acc(ADM);
  ok(!waiting.is_admin && waiting.admin_pending === 'admin' && (await q(`select role from profiles where id = '${ADM}'`))[0].role === 'teacher', 'new admin email is a normal account until activated');
  const pend = (await as(SUPER, () => q(`select * from super_list_admins()`))).find((a) => a.email === 'm.mahadtahir322@gmail.com');
  ok(pend && pend.active === false && pend.has_account === true && pend.email_confirmed === true && pend.user_id === ADM, 'Admins list shows it as signed up but not active');
  await as(SUPER, () => q(`select super_add_admin('m.mahadtahir322@gmail.com')`));
  ok((await q(`select role from profiles where id = '${ADM}'`))[0].role === 'admin', 'super admin activates the admin (no student/teacher role)');
  const sa = await acc(SUPER); const ad = await acc(ADM);
  ok(sa.is_admin && sa.is_super_admin, 'super admin: is_admin and is_super_admin');
  ok(ad.is_admin && !ad.is_super_admin && ad.read_only === false, 'admin: full admin access but not super admin');
  await rejects(db.exec(`insert into app_admins (email, level) values ('two@x.com', 'super_admin')`), /duplicate key|unique/, 'there can be only one super admin');

  // The admin can do daily work.
  ok((await as(ADM, () => q(`select admin_overview() as o`)))[0].o.users > 0, 'admin sees the admin overview');
  await as(ADM, () => q(`select admin_update_user('${STU}', 'Student 24 renamed', 'student')`));
  ok((await q(`select full_name from profiles where id = '${STU}'`))[0].full_name === 'Student 24 renamed', 'admin edits a student');
  await as(ADM, () => q(`select admin_set_subscription('${STU}', now() + interval '60 days', null, null)`));
  ok((await q(`select extract(day from trial_ends_at - now())::int as d from subscriptions where user_id = '${STU}'`))[0].d >= 59, 'admin changes a student trial (now about 60 days)');
  await as(ADM, () => q(`select admin_update_user('${ADM}', 'Mahad (Admin)', 'teacher')`));
  ok((await q(`select full_name, role from profiles where id = '${ADM}'`))[0].role === 'admin', 'admin can rename their own account; role stays Admin');

  // The admin cannot touch the super admin or other admins.
  await rejects(as(ADM, () => q(`select admin_update_user('${SUPER}', 'Hacked', 'student')`)), /Only the super admin/, 'admin cannot edit the super admin');
  await rejects(as(ADM, () => q(`select admin_delete_user('${SUPER}')`)), /super admin account cannot be deleted/, 'admin cannot delete the super admin');
  await rejects(as(ADM, () => q(`select admin_set_subscription('${SUPER}', now(), null, null)`)), /Only the super admin/, 'admin cannot change the super admin\'s subscription');
  await rejects(as(ADM, () => q(`select admin_set_free_access('m.mahadtahir8817api.key@gmail.com', false)`)), /Only the super admin/, 'admin cannot change an admin email\'s free access');
  await rejects(as(ADM, () => q(`select * from super_list_admins()`)), /Only the super admin/, 'admin cannot see the Admins list');
  await rejects(as(ADM, () => q(`select super_add_admin('stu24@x.com')`)), /Only the super admin/, 'admin cannot make someone an admin');
  await rejects(as(ADM, () => q(`select super_remove_admin('m.mahadtahir8817api.key@gmail.com')`)), /Only the super admin/, 'admin cannot remove admins');
  await rejects(as(ADM, () => q(`select admin_update_user('${STU}', 'x', 'admin')`)), /Only the super admin can make someone an admin/, 'admin cannot give the Admin role in Users');
  await rejects(as(ADM, () => q(`update app_admins set level = 'super_admin'`)), /permission denied/, 'admin cannot edit the admin table directly');

  // Super admin manages admins.
  await rejects(as(SUPER, () => q(`select admin_delete_user('${SUPER}')`)), /own account/, 'super admin cannot delete their own account');
  await rejects(as(SUPER, () => q(`select super_remove_admin('m.mahadtahir8817api.key@gmail.com')`)), /super admin cannot be removed/, 'the super admin can never be removed');
  const admins = await as(SUPER, () => q(`select * from super_list_admins()`));
  ok(admins[0].level === 'super_admin' && admins.some((a) => a.email === 'm.mahadtahir322@gmail.com' && a.user_id === ADM), 'super admin sees all admins, super admin first');
  const tcls = (await as(TCH, () => q(`select * from create_class('Class 24')`)))[0];
  await rejects(as(SUPER, () => q(`select super_add_admin('tch24@x.com')`)), /still has classes/, 'a teacher with classes cannot become admin');
  await as(ADM2, () => q(`select join_class($1)`, [tcls.code]));
  await as(SUPER, () => q(`select super_add_admin(' Helper24@X.com ')`));
  ok((await q(`select role from profiles where id = '${ADM2}'`))[0].role === 'admin' && (await q(`select * from class_members where student_id = '${ADM2}'`)).length === 0, 'super admin makes an account Admin (removed from classes)');
  ok((await acc(ADM2)).is_admin === true, 'new admin has admin access');
  await rejects(as(SUPER, () => q(`select super_add_admin('helper24@x.com')`)), /already an admin/, 'cannot add the same admin twice');
  await as(SUPER, () => q(`select admin_update_user('${ADM2}', 'Helper renamed', 'student')`));
  ok((await q(`select full_name, role from profiles where id = '${ADM2}'`))[0].full_name === 'Helper renamed', 'super admin can rename another admin');
  await rejects(as(ADM, () => q(`select admin_delete_user('${ADM2}')`)), /Only the super admin can delete an admin/, 'admin cannot delete another admin');
  await as(SUPER, () => q(`select super_remove_admin('helper24@x.com')`));
  const back = (await q(`select role from profiles where id = '${ADM2}'`))[0].role;
  ok(back === 'student' && (await acc(ADM2)).is_admin === false, 'removed admin becomes a normal student again');
  ok((await q(`select * from streaks where student_id = '${ADM2}'`)).length === 1, 'removed admin gets a streak again');
  await as(SUPER, () => q(`select super_add_admin('helper24@x.com')`));
  await as(SUPER, () => q(`select admin_delete_user('${ADM2}')`));
  ok((await q(`select * from app_admins where email = 'helper24@x.com'`)).length === 0 && (await q(`select * from profiles where id = '${ADM2}'`)).length === 0, 'super admin can delete an admin account (its admin email is removed too)');

  // User list flags.
  const list = await as(ADM, () => q(`select * from admin_list_users()`));
  ok(list.find((u) => u.id === SUPER)?.is_super_admin === true && list.find((u) => u.id === ADM)?.is_super_admin === false && list.find((u) => u.id === ADM)?.is_admin === true, 'user list marks the super admin and admins');
}

console.log('\n25. Admin powers belong to the account, not just the email');
{
  const SUPER = 'adadadad-adad-adad-adad-adadadadadad';
  const ADM = 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2';
  const ATT = 'b1b1b1b1-0000-0000-0000-000000000025';  // signs up first with a waiting admin email
  const ATT2 = 'b2b2b2b2-0000-0000-0000-000000000025'; // re-uses the email of a deleted admin
  const PAYS = 'b3b3b3b3-0000-0000-0000-000000000025'; // student with a pending payment, then made admin
  const TC = 'b4b4b4b4-0000-0000-0000-000000000025';   // teacher who owns a class
  const TC2 = 'b5b5b5b5-0000-0000-0000-000000000025';  // linked admin who still owns a class (old data)
  const acc = async (uid) => (await as(uid, () => q(`select my_access() as a`)))[0].a;
  const role = async (uid) => (await q(`select role from profiles where id = '${uid}'`))[0]?.role;

  // Someone signs up first with an admin email that is waiting for its owner.
  await db.exec(`insert into app_admins (email, level) values ('waiting25@x.com', 'admin')`);
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
    ('${ATT}', 'Waiting25@x.com', '{"role":"student","full_name":"Early Bird"}', null)`);
  ok(await role(ATT) === 'student' && !(await acc(ATT)).is_admin, 'signing up with a waiting admin email does not give the Admin role');
  await rejects(as(SUPER, () => q(`select super_add_admin('waiting25@x.com')`)), /not confirmed/, 'super admin cannot activate an unconfirmed account');
  await rejects(as(SUPER, () => q(`select super_add_admin('nobody25@x.com')`)), /No account uses this email/, 'super admin cannot add an email that has no account');
  ok((await q(`select * from app_admins where email = 'nobody25@x.com'`)).length === 0, 'nothing is stored for an email without an account');
  await db.exec(`update auth.users set email_confirmed_at = now() where id = '${ATT}'`); // the real owner clicks the link
  const a1 = await acc(ATT);
  ok(!a1.is_admin && a1.admin_pending === 'admin' && await role(ATT) === 'student', 'confirming the email still does not make the account admin');
  await rejects(as(ATT, () => q(`select admin_overview()`)), /Only the admin/, 'the waiting account has no admin powers');
  await rejects(as(ADM, () => q(`select link_admin_accounts()`)), /permission denied/, 'admins cannot run the account linking');
  await rejects(as(ATT, () => q(`select link_admin_accounts()`)), /permission denied/, 'users cannot run the account linking');
  await as(SUPER, () => q(`select super_add_admin('waiting25@x.com')`));
  ok((await acc(ATT)).is_admin && await role(ATT) === 'admin', 'only the super admin activating it makes it admin');

  // An admin account deleted outside the app: the email waits again and a new sign-up is not admin.
  await db.exec(`delete from auth.users where id = '${ATT}'`);
  ok((await q(`select user_id from app_admins where email = 'waiting25@x.com'`))[0].user_id === null, 'deleting the account unlinks its admin email');
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${ATT2}', 'waiting25@x.com', '{"role":"teacher","full_name":"Second Bird"}')`);
  ok(!(await acc(ATT2)).is_admin && await role(ATT2) === 'teacher', 'a new account with that email is not admin');

  // Payments: admin accounts never pay, nobody reviews their own payment,
  // and only the super admin reviews a payment made by an admin account.
  await rejects(as(ADM, () => q(`select submit_payment('yearly', '03001234567', 'ADMPAY25', 'Mahad', 'x/y.png')`)), /Admin accounts never pay/, 'admin accounts cannot submit a payment');
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${PAYS}', 'pays25@x.com', '{"role":"student","full_name":"Pays 25"}')`);
  await as(PAYS, () => q(`insert into storage.objects (bucket_id, name) values ('payment-proofs', '${PAYS}/r.png')`));
  const p25 = (await as(PAYS, () => q(`select * from submit_payment('yearly', '03001234567', 'PAYS25TID', 'Pays', '${PAYS}/r.png')`)))[0];
  await as(SUPER, () => q(`select super_add_admin('pays25@x.com')`));
  await rejects(as(PAYS, () => q(`select admin_review_payment('${p25.id}', true, '')`)), /cannot review your own payment/, 'an admin cannot approve their own payment');
  await rejects(as(ADM, () => q(`select admin_review_payment('${p25.id}', true, '')`)), /Only the super admin/, "an admin cannot approve another admin's payment");
  ok((await q(`select status from payments where id = '${p25.id}'`))[0].status === 'pending', 'the payment is still waiting');
  await as(SUPER, () => q(`select admin_review_payment('${p25.id}', false, 'Admins do not pay')`));
  ok((await q(`select status from payments where id = '${p25.id}'`))[0].status === 'rejected', 'the super admin can review it');
  ok((await q(`select count(*)::int as n from notifications where type = 'payment_submitted' and user_id = '${SUPER}' and dedupe_key = 'payment:${p25.id}'`))[0].n === 1, 'linked admins are notified of new payments');

  // A teacher who owns classes is never turned into an admin by the update.
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${TC}', 'tc25@x.com', '{"role":"teacher","full_name":"Teacher 25"}')`);
  const c25 = (await as(TC, () => q(`select * from create_class('Class 25')`)))[0];
  await db.exec(`insert into app_admins (email, level) values ('tc25@x.com', 'admin')`);
  await db.exec(`select public.link_admin_accounts()`);
  ok(await role(TC) === 'teacher' && (await q(`select user_id from app_admins where email = 'tc25@x.com'`))[0].user_id === null, 'teacher with classes is not linked or converted');
  ok((await q(`select * from classes where id = '${c25.id}'`)).length === 1 && (await acc(TC)).admin_pending === 'admin', 'their class stays; the Admins list shows them waiting');
  // Old data: such a teacher was already given the Admin role by an earlier update. It goes back to Teacher.
  await db.exec(`update profiles set role = 'admin' where id = '${TC}'`);
  await db.exec(`select public.link_admin_accounts()`);
  ok(await role(TC) === 'teacher', 'an unlinked Admin role that owns classes is repaired back to Teacher');
  // Re-running the whole update keeps that.
  for (const f of readdirSync(migrationsDir).filter((x) => x >= '20261025000013' && x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  }
  ok(await role(TC) === 'teacher' && await role(SUPER) === 'admin' && await role(ADM) === 'admin', 're-running the update keeps teachers, admins and the super admin as they are');
  ok(!(await acc(ATT2)).is_admin && await role(ATT2) === 'teacher', 're-running the update does not activate a waiting admin email, even with a confirmed account');
  ok((await acc(SUPER)).is_super_admin && (await acc(ADM)).is_admin, 'admin powers survive re-running the update');

  // Removing a linked admin who still owns classes makes them a Teacher, not a Student.
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${TC2}', 'tc2-25@x.com', '{"role":"teacher","full_name":"Teacher 25b"}')`);
  await as(TC2, () => q(`select create_class('Class 25b')`));
  await db.exec(`insert into app_admins (email, level, user_id) values ('tc2-25@x.com', 'admin', '${TC2}'); update profiles set role = 'admin' where id = '${TC2}'`);
  await as(SUPER, () => q(`select super_remove_admin('tc2-25@x.com')`));
  ok(await role(TC2) === 'teacher', 'removed admin who owns classes becomes a Teacher');

  // The admin list shows each state.
  const list = await as(SUPER, () => q(`select * from super_list_admins()`));
  const w = list.find((a) => a.email === 'waiting25@x.com');
  ok(w && w.active === false && w.has_account === true && w.user_id === ATT2, 'Admins list: signed up but not active');
  ok(list.find((a) => a.email === 'm.mahadtahir322@gmail.com')?.active === true, 'Admins list: active admin');
}

console.log('\n26. Activating an admin locks out whoever created the account');
{
  const SUPER = 'adadadad-adad-adad-adad-adadadadadad';
  const EARLY = 'c1c1c1c1-0000-0000-0000-000000000026';
  await db.exec(`insert into app_admins (email, level) values ('early26@x.com', 'admin')`);
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values ('${EARLY}', 'early26@x.com', '{"role":"student","full_name":"Early"}', 'attacker-hash')`);
  const sess = (await q(`insert into auth.sessions (user_id) values ('${EARLY}') returning id`))[0].id;
  await db.exec(`insert into auth.refresh_tokens (token, user_id, session_id) values ('rt', '${EARLY}', '${sess}')`);
  await as(SUPER, () => q(`select super_add_admin('early26@x.com')`));
  ok((await q(`select encrypted_password from auth.users where id = '${EARLY}'`))[0].encrypted_password === '', 'activation removes the password the account was created with');
  ok((await q(`select * from auth.sessions where user_id = '${EARLY}'`)).length === 0 && (await q(`select * from auth.refresh_tokens where user_id = '${EARLY}'`)).length === 0, 'activation signs the account out everywhere');
  // A still-unexpired token from the ended session cannot use admin tools.
  await db.exec(`select set_config('request.jwt.claims', '{"session_id":"${sess}"}', false)`);
  await rejects(as(EARLY, () => q(`select admin_overview()`)), /Only the admin/, 'an old token from an ended session cannot use admin tools');
  ok((await as(EARLY, () => q(`select i_am_admin() as a`)))[0].a === false, 'an old token cannot open payment screenshots');
  // After "Forgot password" the owner signs in again with a new session.
  const fresh = (await q(`insert into auth.sessions (user_id) values ('${EARLY}') returning id`))[0].id;
  await db.exec(`select set_config('request.jwt.claims', '{"session_id":"${fresh}"}', false)`);
  ok((await as(EARLY, () => q(`select admin_overview() as o`)))[0].o.users > 0, 'a new sign-in has admin powers');
  await db.exec(`select set_config('request.jwt.claims', '', false)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
