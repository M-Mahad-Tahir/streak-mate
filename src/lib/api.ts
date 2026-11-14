/**
 * Data-access layer. Every call goes to the real Supabase database; writes that
 * change task state use server-side RPCs that enforce authorization.
 */
import { signUpClient, supabase } from './supabase';
import type {
  AppNotification, Badge, CalendarDay, ClassRow, Decision, Profile, ReviewResult, Role, Streak,
  StudentClass, StudentOverview, SubmissionDetail, Task, TaskStatus, TeacherClass,
} from './types';

export class ApiError extends Error {}

interface PgError { message: string; code?: string; details?: string | null; hint?: string | null }

/** Convert database / network errors into messages a user can act on. */
export function friendlyError(err: unknown): string {
  if (!err) return 'Something went wrong.';
  if (err instanceof ApiError) return err.message;
  const e = err as PgError;
  const msg = e.message ?? String(err);
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Network error. Check your connection and try again.';
  if (e.code === '42501' && /permission denied|row-level security/i.test(msg)) return 'You do not have permission to do that.';
  if (/JWT expired|invalid JWT/i.test(msg)) return 'Your session expired. Please sign in again.';
  if (e.code === '23514') return 'Some values are invalid. Please check the form.';
  return msg;
}

function check<T>(res: { data: T; error: PgError | null }): T {
  if (res.error) throw new ApiError(friendlyError(res.error));
  return res.data;
}

/** PostgREST may return a one-to-one embed as an object or a single-item array. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// ---------------- Auth & profile ----------------
/** Creates the account without signing in; the person then signs in on the Sign in page. */
export async function signUp(input: { email: string; password: string; fullName: string; role: Role; timezone: string }) {
  const res = await signUpClient().auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: { full_name: input.fullName, role: input.role, timezone: input.timezone },
      emailRedirectTo: window.location.origin,
    },
  });
  if (res.error) throw new ApiError(authMessage(res.error.message));
  return res.data;
}

export async function signIn(email: string, password: string) {
  const res = await supabase.auth.signInWithPassword({ email, password });
  if (res.error) throw new ApiError(authMessage(res.error.message));
  return res.data;
}

function authMessage(msg: string): string {
  if (/Invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email address first. Check your inbox.';
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Try signing in.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
  return friendlyError({ message: msg });
}

export async function getProfile(userId: string): Promise<Profile | null> {
  return check(await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()) as Profile | null;
}

export async function updateProfile(userId: string, patch: { full_name?: string; timezone?: string }) {
  check(await supabase.from('profiles').update(patch).eq('id', userId));
}

// ---------------- Tasks (student) ----------------
export interface TaskInput {
  title: string;
  description: string;
  due_date: string;
  due_time: string;
  class_id: string | null;
}

/** True when the database has not received RUN_THIS_UPDATE.sql yet (no archived_at column / delete_task function). */
function needsDbUpdate(err: PgError | null): boolean {
  return !!err && (/archived_at/.test(err.message) || err.code === 'PGRST202' || err.code === '42703');
}

const DB_UPDATE_MSG = 'Deleting finished tasks needs a quick database update. Run supabase/RUN_THIS_UPDATE.sql in the Supabase SQL Editor, then try again.';
const DB_UPDATE_EDIT_MSG = 'Editing submitted or verified tasks needs a quick database update. Run supabase/RUN_THIS_UPDATE.sql in the Supabase SQL Editor, then try again.';

export async function listMyTasks(): Promise<Task[]> {
  const res = await supabase.from('tasks').select('*').is('archived_at', null).order('due_at', { ascending: true });
  // Older database without the archive column: show all tasks instead of failing.
  if (needsDbUpdate(res.error)) return check(await supabase.from('tasks').select('*').order('due_at', { ascending: true })) as Task[];
  return check(res) as Task[];
}

export async function createTask(input: TaskInput): Promise<Task> {
  return check(await supabase.from('tasks').insert(input).select('*').single()) as Task;
}

export async function updateTask(id: string, input: Partial<TaskInput>): Promise<Task> {
  const res = await supabase.from('tasks').update(input).eq('id', id).select('*').single();
  // The old database (before RUN_THIS_UPDATE.sql) locks every field of submitted/verified tasks.
  if (res.error && /can no longer be edited|due date and class are locked/.test(res.error.message)) throw new ApiError(DB_UPDATE_EDIT_MSG);
  // No row back means the task was removed or can no longer be edited by this user.
  if (res.error?.code === 'PGRST116') throw new ApiError('This task could not be saved. Refresh the page and try again.');
  return check(res) as Task;
}

/** Delete any task. Finished or reviewed work is archived so the streak and teacher records are kept. */
export async function deleteTask(id: string): Promise<'deleted' | 'archived'> {
  const res = await supabase.rpc('delete_task', { p_task: id });
  if (needsDbUpdate(res.error)) {
    // Older database: only delete a task that was never finished or submitted.
    // Anything else would erase streak history or the teacher's records, so ask for the update instead.
    const task = check(await supabase.from('tasks').select('status').eq('id', id).maybeSingle()) as { status: string } | null;
    if (!task) throw new ApiError('Task not found. Refresh the page and try again.');
    const subs = await supabase.from('submissions').select('id', { count: 'exact', head: true }).eq('task_id', id);
    if (task.status !== 'pending' || subs.error || (subs.count ?? 0) > 0) throw new ApiError(DB_UPDATE_MSG);
    const rows = check(await supabase.from('tasks').delete().eq('id', id).eq('status', 'pending').select('id')) as { id: string }[];
    if (!rows.length) throw new ApiError(DB_UPDATE_MSG);
    return 'deleted';
  }
  return check(res) as 'deleted' | 'archived';
}

export async function setTaskCompleted(id: string, done: boolean): Promise<Task> {
  return check(await supabase.rpc('set_task_completed', { p_task: id, p_done: done })) as Task;
}

export async function submitTask(id: string, classId: string, note: string) {
  return check(await supabase.rpc('submit_task', { p_task: id, p_class: classId, p_note: note }));
}

// ---------------- Submissions & verification ----------------
const SUBMISSION_SELECT =
  '*, task:tasks!submissions_task_id_fkey(id, title, description, due_date, due_time, due_at, completed_at, status),' +
  ' student:profiles!submissions_student_id_fkey(full_name, email),' +
  ' teacher:profiles!submissions_teacher_id_fkey(full_name),' +
  ' class:classes(name), verification:verifications(*)';

function normalizeSubmission(row: Record<string, unknown>): SubmissionDetail {
  return {
    ...(row as unknown as SubmissionDetail),
    task: one(row.task as SubmissionDetail['task']),
    student: one(row.student as SubmissionDetail['student']),
    teacher: one(row.teacher as SubmissionDetail['teacher']),
    class: one(row.class as SubmissionDetail['class']),
    verification: one(row.verification as SubmissionDetail['verification']),
  };
}

/** Submissions visible to the current user (RLS limits students to their own, teachers to theirs). */
export async function listSubmissions(opts: { status?: 'submitted' | 'reviewed'; studentId?: string; limit?: number } = {}): Promise<SubmissionDetail[]> {
  let query = supabase.from('submissions').select(SUBMISSION_SELECT);
  if (opts.status === 'submitted') query = query.eq('status', 'submitted');
  if (opts.status === 'reviewed') query = query.neq('status', 'submitted');
  if (opts.studentId) query = query.eq('student_id', opts.studentId);
  query = query.order(opts.status === 'reviewed' ? 'reviewed_at' : 'submitted_at', { ascending: opts.status === 'submitted' });
  if (opts.limit) query = query.limit(opts.limit);
  const rows = check(await query) as unknown as Record<string, unknown>[];
  return rows.map(normalizeSubmission);
}

export async function getSubmission(id: string): Promise<SubmissionDetail | null> {
  const row = check(await supabase.from('submissions').select(SUBMISSION_SELECT).eq('id', id).maybeSingle());
  return row ? normalizeSubmission(row as unknown as Record<string, unknown>) : null;
}

/**
 * Approve or reject. `shown` is the title/description the teacher was looking at; the
 * server refuses the decision if the student edited the task in the meantime.
 */
export async function reviewSubmission(
  id: string, decision: Decision, feedback: string, shown?: { title: string; description: string },
): Promise<ReviewResult> {
  const base = { p_submission: id, p_decision: decision, p_feedback: feedback };
  const res = shown
    ? await supabase.rpc('review_submission', { ...base, p_expected_title: shown.title, p_expected_description: shown.description })
    : await supabase.rpc('review_submission', base);
  // Older database (before RUN_THIS_UPDATE.sql) only knows the 3-argument version.
  if (shown && res.error?.code === 'PGRST202') return check(await supabase.rpc('review_submission', base)) as ReviewResult;
  return check(res) as ReviewResult;
}

export const STALE_REVIEW_RE = /changed this task while you were reviewing/;

// ---------------- Classes ----------------
export async function listStudentClasses(): Promise<StudentClass[]> {
  const rows = check(await supabase.from('class_members')
    .select('joined_at, class:classes(*, teacher:profiles!classes_teacher_id_fkey(full_name, email))')
    .order('joined_at', { ascending: true })) as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const cls = one(r.class as StudentClass['class']);
    return { joined_at: r.joined_at as string, class: cls ? { ...cls, teacher: one(cls.teacher) } : null };
  });
}

export async function joinClass(code: string): Promise<ClassRow> {
  return check(await supabase.rpc('join_class', { p_code: code })) as ClassRow;
}

export async function leaveClass(classId: string, studentId: string) {
  check(await supabase.from('class_members').delete().eq('class_id', classId).eq('student_id', studentId));
}

export async function listTeacherClasses(teacherId: string): Promise<TeacherClass[]> {
  const rows = check(await supabase.from('classes')
    .select('*, class_members(student_id, joined_at, student:profiles(id, full_name, email))')
    .eq('teacher_id', teacherId)
    .order('created_at', { ascending: true })) as unknown as TeacherClass[];
  return rows.map((c) => ({ ...c, class_members: c.class_members.map((m) => ({ ...m, student: one(m.student) })) }));
}

export async function createClass(name: string): Promise<ClassRow> {
  return check(await supabase.rpc('create_class', { p_name: name })) as ClassRow;
}

export async function regenerateClassCode(classId: string): Promise<string> {
  return check(await supabase.rpc('regenerate_class_code', { p_class: classId })) as string;
}

export async function renameClass(classId: string, name: string) {
  check(await supabase.from('classes').update({ name }).eq('id', classId));
}

export async function deleteClass(classId: string) {
  check(await supabase.from('classes').delete().eq('id', classId));
}

export async function removeStudent(classId: string, studentId: string) {
  check(await supabase.from('class_members').delete().eq('class_id', classId).eq('student_id', studentId));
}

export async function teacherOverview(): Promise<StudentOverview[]> {
  return check(await supabase.rpc('teacher_student_overview')) as StudentOverview[];
}

/** Tasks a teacher may see for one student (only tasks linked to the teacher's classes). */
export async function listStudentTasksForTeacher(studentId: string): Promise<Task[]> {
  // Includes tasks the student removed from their own list: the teacher's record is kept.
  return check(await supabase.from('tasks').select('*').eq('student_id', studentId).order('due_at', { ascending: false })) as Task[];
}

export async function getProfileById(id: string): Promise<Profile | null> {
  return check(await supabase.from('profiles').select('*').eq('id', id).maybeSingle()) as Profile | null;
}

// ---------------- Streaks ----------------
export async function getMyStreak(): Promise<Streak> {
  return check(await supabase.rpc('get_my_streak')) as Streak;
}

export async function getStreak(studentId: string): Promise<Streak | null> {
  return check(await supabase.from('streaks').select('*').eq('student_id', studentId).maybeSingle()) as Streak | null;
}

export async function getCalendar(from: string, to: string, studentId?: string): Promise<CalendarDay[]> {
  return check(await supabase.rpc('get_win_calendar', { p_from: from, p_to: to, p_student: studentId ?? null })) as CalendarDay[];
}

export async function listBadges(studentId: string): Promise<Badge[]> {
  return check(await supabase.from('badges').select('*').eq('student_id', studentId)) as Badge[];
}

// ---------------- Notifications ----------------
export async function listNotifications(limit = 50): Promise<AppNotification[]> {
  return check(await supabase.from('notifications')
    .select('id, user_id, type, title, body, link, read_at, created_at')
    .order('created_at', { ascending: false }).limit(limit)) as AppNotification[];
}

export async function unreadCount(): Promise<number> {
  const res = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  if (res.error) throw new ApiError(friendlyError(res.error));
  return res.count ?? 0;
}

export async function markRead(ids: string[]) {
  if (!ids.length) return;
  check(await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids).is('read_at', null));
}

export async function markAllRead() {
  check(await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null));
}

export async function deleteNotification(id: string) {
  check(await supabase.from('notifications').delete().eq('id', id));
}

/** Deletes every notification of this user (or only the read ones). */
export async function deleteAllNotifications(userId: string, onlyRead = false) {
  let q = supabase.from('notifications').delete().eq('user_id', userId);
  if (onlyRead) q = q.not('read_at', 'is', null);
  check(await q);
}

// ---------------- Web Push ----------------
export async function savePushSubscription(sub: PushSubscriptionJSON) {
  check(await supabase.rpc('save_push_subscription', {
    p_endpoint: sub.endpoint, p_p256dh: sub.keys?.p256dh ?? '', p_auth: sub.keys?.auth ?? '',
  }));
}

export async function deletePushSubscription(endpoint: string) {
  check(await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint));
}

// ---------------- Subscriptions & admin ----------------
export type AccessStatus = 'admin' | 'free' | 'active' | 'trial' | 'expired';

export interface Access {
  status: AccessStatus;
  is_admin: boolean;
  is_super_admin?: boolean;
  admin_pending?: 'admin' | 'super_admin' | null; // this email is an admin email, not active for this account yet
  read_only: boolean;
  trial_ends_at: string | null;
  paid_until: string | null;
  plan: 'monthly' | 'yearly' | null;
  pending_payment: boolean;
}

export interface Payment {
  id: string;
  user_id: string;
  plan: 'monthly' | 'yearly';
  amount_pkr: number;
  amount_usd: number;
  sender_number: string;
  sender_name: string | null;
  transaction_id: string;
  screenshot_path: string | null;
  status: 'pending' | 'approved' | 'rejected';
  admin_note: string;
  created_at: string;
  reviewed_at: string | null;
}

export interface AdminPayment extends Payment { full_name: string; email: string; role: Role }

export interface AdminUser {
  id: string; full_name: string; email: string; role: Role; created_at: string;
  status: AccessStatus; trial_ends_at: string | null; paid_until: string | null; plan: string | null;
  is_free: boolean; is_admin: boolean; last_sign_in_at: string | null; is_super_admin?: boolean;
}

export interface AdminOverview {
  users: number; students: number; teachers: number; on_trial: number; paid_active: number;
  free_accounts: number; pending_payments: number; revenue_pkr: number; tasks: number; classes: number;
}

/** Returns null when the database has not received the subscriptions update yet. */
export async function getMyAccess(): Promise<Access | null> {
  const res = await supabase.rpc('my_access');
  if (res.error?.code === 'PGRST202') return null;
  return check(res) as Access;
}

export async function listMyPayments(): Promise<Payment[]> {
  const res = await supabase.from('payments').select('*').order('created_at', { ascending: false });
  if (res.error && (res.error.code === '42P01' || res.error.code === 'PGRST205')) return [];
  return check(res) as Payment[];
}

const PROOF_BUCKET = 'payment-proofs';
const PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Returns a problem message, or null when the file can be used as a payment screenshot. */
export function checkProofFile(file: File): string | null {
  if (!PROOF_TYPES.includes(file.type)) return 'Choose a PNG, JPG or WEBP image of your receipt.';
  if (file.size > 5 * 1024 * 1024) return 'The screenshot is larger than 5 MB. Choose a smaller image.';
  return null;
}

/** Uploads the receipt screenshot into the user's private folder and returns its path. */
export async function uploadPaymentProof(userId: string, file: File): Promise<string> {
  const problem = checkProofFile(file);
  if (problem) throw new ApiError(problem);
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const res = await supabase.storage.from(PROOF_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (res.error) {
    if (/bucket not found/i.test(res.error.message)) throw new ApiError('Screenshot upload needs a quick database update. Run supabase/RUN_THIS_UPDATE.sql in the Supabase SQL Editor.');
    throw new ApiError(`Could not upload the screenshot: ${res.error.message}`);
  }
  return path;
}

export async function removePaymentProof(path: string) {
  await supabase.storage.from(PROOF_BUCKET).remove([path]);
}

/** Short-lived private link to view a payment screenshot (payer or admin only). */
export async function getProofUrl(path: string): Promise<string> {
  const res = await supabase.storage.from(PROOF_BUCKET).createSignedUrl(path, 600);
  if (res.error || !res.data) throw new ApiError('Could not open the screenshot.');
  return res.data.signedUrl;
}

export async function submitPayment(
  plan: 'monthly' | 'yearly', sender: string, tid: string, senderName: string, screenshotPath: string,
): Promise<Payment> {
  return check(await supabase.rpc('submit_payment', {
    p_plan: plan, p_sender: sender, p_tid: tid, p_sender_name: senderName, p_screenshot_path: screenshotPath,
  })) as Payment;
}

export async function adminOverview(): Promise<AdminOverview> {
  return check(await supabase.rpc('admin_overview')) as AdminOverview;
}

export async function adminListPayments(status?: 'pending' | 'approved' | 'rejected'): Promise<AdminPayment[]> {
  return check(await supabase.rpc('admin_list_payments', { p_status: status ?? null })) as AdminPayment[];
}

export async function adminReviewPayment(id: string, approve: boolean, note: string) {
  return check(await supabase.rpc('admin_review_payment', { p_payment: id, p_approve: approve, p_note: note }));
}

export async function adminListUsers(): Promise<AdminUser[]> {
  return check(await supabase.rpc('admin_list_users')) as AdminUser[];
}

export async function adminSetFreeAccess(email: string, free: boolean) {
  check(await supabase.rpc('admin_set_free_access', { p_email: email, p_free: free }));
}

export const JAZZCASH_NUMBER = '03086011789';
export const PLANS = {
  monthly: { label: 'Monthly', usd: 5, pkr: 1400, period: 'month' },
  yearly: { label: 'Yearly', usd: 50, pkr: 14000, period: 'year' },
} as const;

// ---------------- Admin: edit everything ----------------
export interface AdminTask {
  id: string; student_id: string; student_name: string; student_email: string; class_name: string | null;
  title: string; description: string; due_date: string; due_time: string; status: TaskStatus;
  completed_at: string | null; archived_at: string | null; created_at: string;
}

export interface AdminClass {
  id: string; name: string; code: string; teacher_id: string; teacher_name: string; teacher_email: string; created_at: string;
  members: { student_id: string; full_name: string; email: string; joined_at: string }[];
}

export async function adminUpdateUser(id: string, fullName: string, role: Role) {
  check(await supabase.rpc('admin_update_user', { p_user: id, p_full_name: fullName, p_role: role }));
}
export async function adminDeleteUser(id: string) {
  check(await supabase.rpc('admin_delete_user', { p_user: id }));
}
export async function adminSetSubscription(id: string, trialEndsAt: string, paidUntil: string | null, plan: 'monthly' | 'yearly' | null) {
  check(await supabase.rpc('admin_set_subscription', { p_user: id, p_trial_ends_at: trialEndsAt, p_paid_until: paidUntil, p_plan: plan }));
}
export async function adminListTasks(search: string): Promise<AdminTask[]> {
  return check(await supabase.rpc('admin_list_tasks', { p_search: search, p_limit: 300 })) as AdminTask[];
}
export async function adminUpdateTask(id: string, input: { title: string; description: string; due_date: string; due_time: string; status: TaskStatus }) {
  check(await supabase.rpc('admin_update_task', {
    p_task: id, p_title: input.title, p_description: input.description, p_due_date: input.due_date, p_due_time: input.due_time, p_status: input.status,
  }));
}
export async function adminDeleteTask(id: string) {
  check(await supabase.rpc('admin_delete_task', { p_task: id }));
}
export async function adminListClasses(): Promise<AdminClass[]> {
  return check(await supabase.rpc('admin_list_classes')) as AdminClass[];
}
export async function adminUpdateClass(id: string, name: string) {
  check(await supabase.rpc('admin_update_class', { p_class: id, p_name: name }));
}
export async function adminDeleteClass(id: string) {
  check(await supabase.rpc('admin_delete_class', { p_class: id }));
}
export async function adminAddMember(classId: string, email: string) {
  check(await supabase.rpc('admin_add_member', { p_class: classId, p_email: email }));
}
export async function adminRemoveMember(classId: string, studentId: string) {
  check(await supabase.rpc('admin_remove_member', { p_class: classId, p_student: studentId }));
}

// ---------------- Password ----------------
/**
 * Emails a secure link to choose a new password. Passwords themselves are never
 * readable by anyone, including the admin.
 */
export async function sendPasswordResetEmail(email: string) {
  const res = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
  if (res.error) {
    if (/rate limit|too many|seconds/i.test(res.error.message)) {
      throw new ApiError('Too many emails were sent recently. Wait a few minutes, then try again.');
    }
    throw new ApiError(friendlyError(res.error));
  }
}

export async function changePassword(newPassword: string) {
  const res = await supabase.auth.updateUser({ password: newPassword });
  if (res.error) {
    const msg = res.error.message;
    if (/different from the old|same password/i.test(msg)) throw new ApiError('The new password must be different from your current one.');
    if (/reauthenticat|nonce/i.test(msg)) throw new ApiError('For security, sign out and sign in again, then change your password.');
    if (/weak|at least/i.test(msg)) throw new ApiError('That password is too weak. Use at least 8 characters with a letter and a number.');
    throw new ApiError(friendlyError(res.error));
  }
}

// ---------------- Super admin ----------------
export interface AdminAccount {
  email: string;
  level: 'admin' | 'super_admin';
  user_id: string | null;
  full_name: string | null;
  last_sign_in_at: string | null;
  email_confirmed: boolean | null;
  active?: boolean;       // linked to its account (admin powers work)
  has_account?: boolean;  // an account with this email exists
}

export async function superListAdmins(): Promise<AdminAccount[]> {
  return check(await supabase.rpc('super_list_admins')) as AdminAccount[];
}

export async function superAddAdmin(email: string) {
  check(await supabase.rpc('super_add_admin', { p_email: email }));
}

export async function superRemoveAdmin(email: string) {
  check(await supabase.rpc('super_remove_admin', { p_email: email }));
}
