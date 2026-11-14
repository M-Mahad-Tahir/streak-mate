import { Crown, GraduationCap, LayoutDashboard, ListTodo, Presentation, School, Users, Wallet } from 'lucide-react';

export type AdminSection = '' | 'payments' | 'users' | 'students' | 'teachers' | 'tasks' | 'classes' | 'admins';

/** The super admin's pages live under /super-admin, every other admin's under /admin. */
export const adminBase = (isSuperAdmin: boolean) => (isSuperAdmin ? '/super-admin' : '/admin');

export const ADMIN_SECTIONS: { key: AdminSection; label: string; subtitle: string; icon: typeof Wallet; superOnly?: boolean }[] = [
  { key: '', label: 'Dashboard', subtitle: '', icon: LayoutDashboard },
  { key: 'payments', label: 'Payments', subtitle: 'Every JazzCash payment: waiting, approved and rejected.', icon: Wallet },
  { key: 'users', label: 'All users', subtitle: 'Every account on the website.', icon: Users },
  { key: 'students', label: 'Students', subtitle: 'All student accounts.', icon: GraduationCap },
  { key: 'teachers', label: 'Teachers', subtitle: 'All teacher accounts.', icon: Presentation },
  { key: 'tasks', label: 'Tasks', subtitle: 'Tasks of every student.', icon: ListTodo },
  { key: 'classes', label: 'Classes', subtitle: 'Every class and its students.', icon: School },
  { key: 'admins', label: 'Admins', subtitle: 'Add or remove the admins who help you run the website.', icon: Crown, superOnly: true },
];

export const adminSections = (isSuperAdmin: boolean) => ADMIN_SECTIONS.filter((s) => !s.superOnly || isSuperAdmin);

export const adminPath = (isSuperAdmin: boolean, key: AdminSection) => adminBase(isSuperAdmin) + (key ? `/${key}` : '');
