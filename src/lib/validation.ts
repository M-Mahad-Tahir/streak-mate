/** Client-side validation (the database enforces the same limits server-side). */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email: string): string | null {
  if (!email.trim()) return 'Email is required.';
  if (!EMAIL_RE.test(email.trim())) return 'Enter a valid email address.';
  return null;
}

export function validatePassword(pw: string): string | null {
  if (!pw) return 'Password is required.';
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include at least one letter and one number.';
  return null;
}

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score: score as 0 | 1 | 2 | 3 | 4, label: labels[score] };
}

export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Name is required.';
  if (n.length > 100) return 'Name must be 100 characters or fewer.';
  return null;
}

export interface TaskFormValues { title: string; description: string; due_date: string; due_time: string }

export function validateTask(v: TaskFormValues): Partial<Record<keyof TaskFormValues, string>> {
  const errors: Partial<Record<keyof TaskFormValues, string>> = {};
  if (!v.title.trim()) errors.title = 'Title is required.';
  else if (v.title.trim().length > 150) errors.title = 'Title must be 150 characters or fewer.';
  if (v.description.length > 5000) errors.description = 'Description must be 5000 characters or fewer.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.due_date)) errors.due_date = 'Choose a due date.';
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(v.due_time)) errors.due_time = 'Choose a due time.';
  return errors;
}

export function normalizeClassCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function validateClassCode(code: string): string | null {
  const c = normalizeClassCode(code);
  if (!c) return 'Enter the class code from your teacher.';
  if (c.length < 6 || c.length > 10) return 'Class codes are 6 to 10 letters or numbers.';
  return null;
}
