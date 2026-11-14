import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-5xl font-extrabold text-brand-600">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-slate-500">The page you are looking for doesn't exist.</p>
      <Link to="/" className="mt-2 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-medium text-white hover:brightness-110">Go home</Link>
    </div>
  );
}
