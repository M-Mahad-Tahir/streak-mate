import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { friendlyError } from './api';
import { useOnDataChanged } from '../context/NotificationsContext';

/** Load data with loading / error state; reloads when realtime signals a change. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);

  const reload = useCallback(async (silent = false) => {
    const id = ++seq.current;
    if (!silent) setLoading(true);
    try {
      const result = await run();
      if (id === seq.current) { setData(result); setError(null); }
    } catch (e) {
      if (id === seq.current) setError(friendlyError(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [run]);

  useEffect(() => { void reload(); }, [reload]);
  useOnDataChanged(() => void reload(true));

  return { data, error, loading, reload, setData };
}
