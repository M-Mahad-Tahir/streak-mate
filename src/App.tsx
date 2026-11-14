import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './context/AuthContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { AppLayout } from './components/AppLayout';
import { CelebrationProvider } from './components/Celebration';
import { ErrorBanner, PageLoader, Button } from './components/ui';
import { isConfigured } from './lib/supabase';
import { homeFor, type Role } from './lib/types';
import SignIn from './pages/auth/SignIn';
import SignUp from './pages/auth/SignUp';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
import { supabase } from './lib/supabase';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import StudentDashboard from './pages/student/Dashboard';
import StudentTasks from './pages/student/Tasks';
import StudentHistory from './pages/student/History';
import StudentStreak from './pages/student/Streak';
import StudentClasses from './pages/student/Classes';
import TeacherDashboard from './pages/teacher/Dashboard';
import TeacherReview from './pages/teacher/Review';
import TeacherHistory from './pages/teacher/History';
import TeacherClasses from './pages/teacher/Classes';
import TeacherStudent from './pages/teacher/StudentDetail';
import NotificationsPage from './pages/Notifications';
import SettingsPage from './pages/Settings';
import SubscriptionPage from './pages/Subscription';
import AdminPage from './pages/Admin';
import { AccessProvider } from './context/AccessContext';
import NotFound from './pages/NotFound';
import { HelpBot } from './components/HelpBot';

function SetupRequired() {
  return (
    <div className="mx-auto mt-20 max-w-xl px-4">
      <h1 className="mb-2 text-2xl font-bold">Supabase is not configured</h1>
      <p className="mb-4 text-slate-600">
        Create a <code className="rounded bg-slate-100 px-1">.env.local</code> file with{' '}
        <code className="rounded bg-slate-100 px-1">VITE_SUPABASE_URL</code> and{' '}
        <code className="rounded bg-slate-100 px-1">VITE_SUPABASE_ANON_KEY</code>, then restart the dev server.{' '}
        See the README for step-by-step setup.
      </p>
    </div>
  );
}

/** Requires a signed-in user with a loaded profile, optionally with a specific role. */
function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { session, profile, loading, profileError, signOut, locked } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader label="Loading your workspace..." />;
  if (!session || locked) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  if (!profile) {
    return (
      <div className="mx-auto mt-20 max-w-md space-y-4 px-4">
        <ErrorBanner message={profileError ?? 'Loading profile...'} />
        <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
      </div>
    );
  }
  if (role && profile.role !== role) return <Navigate to={homeFor(profile.role)} replace />;
  return <>{children}</>;
}

function HomeRedirect() {
  const { session, profile, loading, locked } = useAuth();
  if (loading) return <PageLoader />;
  if (!session || locked) return <Navigate to="/signin" replace />;
  if (!profile) return <RequireAuth><></></RequireAuth>;
  return <Navigate to={homeFor(profile.role)} replace />;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { session, profile, loading, locked } = useAuth();
  if (loading) return <PageLoader />;
  if (session && profile && !locked) return <Navigate to={homeFor(profile.role)} replace />;
  return <>{children}</>;
}

/** A password reset link always opens the "choose a new password" page. */
function RecoveryRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' && window.location.pathname !== '/reset-password') navigate('/reset-password', { replace: true });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);
  return null;
}

export default function App() {
  if (!isConfigured) return <SetupRequired />;
  return (
    <>
    <RecoveryRedirect />
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/signin" element={<GuestOnly><SignIn /></GuestOnly>} />
      <Route path="/signup" element={<GuestOnly><SignUp /></GuestOnly>} />
      <Route path="/forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route element={<RequireAuth><CelebrationProvider><NotificationsProvider><AccessProvider><AppLayout /></AccessProvider></NotificationsProvider></CelebrationProvider></RequireAuth>}>
        <Route path="/student" element={<RequireAuth role="student"><StudentDashboard /></RequireAuth>} />
        <Route path="/student/tasks" element={<RequireAuth role="student"><StudentTasks /></RequireAuth>} />
        <Route path="/student/history" element={<RequireAuth role="student"><StudentHistory /></RequireAuth>} />
        <Route path="/student/streak" element={<RequireAuth role="student"><StudentStreak /></RequireAuth>} />
        <Route path="/student/classes" element={<RequireAuth role="student"><StudentClasses /></RequireAuth>} />

        <Route path="/teacher" element={<RequireAuth role="teacher"><TeacherDashboard /></RequireAuth>} />
        <Route path="/teacher/review" element={<RequireAuth role="teacher"><TeacherReview /></RequireAuth>} />
        <Route path="/teacher/history" element={<RequireAuth role="teacher"><TeacherHistory /></RequireAuth>} />
        <Route path="/teacher/classes" element={<RequireAuth role="teacher"><TeacherClasses /></RequireAuth>} />
        <Route path="/teacher/students/:id" element={<RequireAuth role="teacher"><TeacherStudent /></RequireAuth>} />

        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/subscription" element={<SubscriptionPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/:section" element={<AdminPage />} />
        <Route path="/super-admin" element={<AdminPage />} />
        <Route path="/super-admin/:section" element={<AdminPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
    <HelpBot />
    </>
  );
}
