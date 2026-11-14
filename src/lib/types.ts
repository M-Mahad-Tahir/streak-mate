export type Role = 'student' | 'teacher' | 'admin';

/** Where each role lands after signing in. */
export const homeFor = (role: Role) => (role === 'admin' ? '/admin' : role === 'teacher' ? '/teacher' : '/student');
export type TaskStatus = 'pending' | 'completed' | 'submitted' | 'verified' | 'rejected';
export type SubmissionStatus = 'submitted' | 'verified' | 'rejected';
export type Decision = 'approved' | 'rejected';

export interface Profile {
  id: string;
  role: Role;
  full_name: string;
  email: string;
  timezone: string;
  created_at: string;
}

export interface ClassRow {
  id: string;
  teacher_id: string;
  name: string;
  code: string;
  created_at: string;
}

export interface StudentClass {
  joined_at: string;
  class: (ClassRow & { teacher: Pick<Profile, 'full_name' | 'email'> | null }) | null;
}

export interface TeacherClass extends ClassRow {
  class_members: { student_id: string; joined_at: string; student: Pick<Profile, 'id' | 'full_name' | 'email'> | null }[];
}

export interface Task {
  id: string;
  student_id: string;
  class_id: string | null;
  title: string;
  description: string;
  due_date: string; // YYYY-MM-DD (student local)
  due_time: string; // HH:MM:SS (student local)
  due_at: string;   // ISO timestamp
  status: TaskStatus;
  completed_at: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Verification {
  id: string;
  submission_id: string;
  task_id: string;
  teacher_id: string;
  student_id: string;
  decision: Decision;
  feedback: string;
  created_at: string;
}

export interface Submission {
  id: string;
  task_id: string;
  student_id: string;
  class_id: string;
  teacher_id: string;
  note: string;
  status: SubmissionStatus;
  task_title?: string | null;       // snapshot of what was submitted (after RUN_THIS_UPDATE.sql)
  task_description?: string | null;
  submitted_at: string;
  reviewed_at: string | null;
}

export interface SubmissionDetail extends Submission {
  task: Pick<Task, 'id' | 'title' | 'description' | 'due_date' | 'due_time' | 'due_at' | 'completed_at' | 'status'> | null;
  student: Pick<Profile, 'full_name' | 'email'> | null;
  teacher: Pick<Profile, 'full_name'> | null;
  class: Pick<ClassRow, 'name'> | null;
  verification: Verification | null;
}

export interface AppNotification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface Streak {
  student_id: string;
  current_streak: number;
  longest_streak: number;
  last_win_date: string | null;
  updated_at: string;
}

export interface Badge {
  student_id: string;
  code: string;
  earned_at: string;
}

export interface CalendarDay {
  day: string;
  completed_count: number;
  due_count: number;
  verified_count: number;
  is_win: boolean;
}

export interface StudentOverview {
  student_id: string;
  full_name: string;
  email: string;
  class_id: string;
  class_name: string;
  joined_at: string;
  current_streak: number;
  longest_streak: number;
  class_tasks: number;
  verified_tasks: number;
  pending_reviews: number;
}

export interface ReviewResult {
  submission_id: string;
  task_id: string;
  task_status: TaskStatus;
  verification_id: string;
  reviewed_at: string;
}
