import { useState } from 'react';

/** Light or dark look. The choice is saved per device; index.html applies it before the page draws. */
export type Theme = 'light' | 'dark';
const KEY = 'winstreak:theme';

const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(current);
  const toggle = () => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try { localStorage.setItem(KEY, next); } catch { /* private mode: still switches for this visit */ }
    setTheme(next);
  };
  return { theme, toggle };
}
