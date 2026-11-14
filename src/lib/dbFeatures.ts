import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/**
 * Detects whether the database has received RUN_THIS_UPDATE.sql.
 * Without it, the database only allows deleting pending tasks and editing tasks
 * that were not yet submitted, so the app shows Edit/Delete only where they work.
 * The check re-runs when the window regains focus, so the buttons appear on every
 * task as soon as the update has been run.
 */
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;
const listeners = new Set<(v: boolean) => void>();

async function detect(): Promise<boolean> {
  // Read-only probe: the archived_at column only exists after the update.
  const { error } = await supabase.from('tasks').select('archived_at').limit(1);
  if (!error) return true;
  if (error.code === '42703' || /archived_at/.test(error.message)) return false;
  return cached ?? false; // network or other error: keep the last known answer
}

export function refreshDbFeatures(): Promise<boolean> {
  if (!inflight) {
    inflight = detect()
      .then((v) => {
        cached = v;
        listeners.forEach((l) => l(v));
        return v;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** `true` once the database supports editing and deleting tasks of every status. */
export function useDbUpdated(): boolean {
  const [value, setValue] = useState<boolean>(cached ?? false);
  useEffect(() => {
    listeners.add(setValue);
    if (cached === null) void refreshDbFeatures();
    else setValue(cached);
    const onFocus = () => { if (!cached) void refreshDbFeatures(); };
    window.addEventListener('focus', onFocus);
    return () => { listeners.delete(setValue); window.removeEventListener('focus', onFocus); };
  }, []);
  return value;
}
