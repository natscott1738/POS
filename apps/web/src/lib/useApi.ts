import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.js';
import { toast } from './store.js';

/**
 * Small data-fetching hook. Every screen needs load / loading / error / refetch,
 * and hand-rolling that per screen is where stale-state bugs come from.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<T>(path));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not load data';
      setError(message);
      // A permission problem is expected for some roles, and being offline is
      // already shown by the connection badge: neither needs an error on top.
      const quiet = err instanceof ApiError && (err.code === 'FORBIDDEN' || err.code === 'NETWORK');
      if (!quiet) toast.error(message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load, setData };
}

/** Wraps a mutation with busy state and consistent error reporting. */
export function useMutation() {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T,>(work: () => Promise<T>, options: { success?: string; onDone?: (result: T) => void } = {}) => {
      setBusy(true);
      try {
        const result = await work();
        if (options.success) toast.success(options.success);
        options.onDone?.(result);
        return result;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'NETWORK') {
          toast.warning('You are offline. This needs a connection to the server; try again when it is back.');
        } else {
          toast.error(err instanceof ApiError ? err.message : 'That did not work');
        }
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { busy, run };
}
