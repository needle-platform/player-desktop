import { useEffect, useState } from 'react';
import { getCoverArt } from './tauri';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const MAX_CONCURRENT_FETCHES = 4;
let activeFetches = 0;
const pendingFetches: Array<() => void> = [];

const drainFetchQueue = () => {
  while (activeFetches < MAX_CONCURRENT_FETCHES && pendingFetches.length > 0) {
    const next = pendingFetches.shift();
    if (!next) return;
    activeFetches += 1;
    next();
  }
};

const enqueueFetch = <T,>(task: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    pendingFetches.push(() => {
      void task()
        .then(resolve, reject)
        .finally(() => {
          activeFetches = Math.max(0, activeFetches - 1);
          drainFetchQueue();
        });
    });
    drainFetchQueue();
  });

const fetchCover = async (trackPath: string): Promise<string | null> => {
  if (cache.has(trackPath)) {
    return cache.get(trackPath) ?? null;
  }

  const existing = inflight.get(trackPath);
  if (existing) return existing;

  const promise = enqueueFetch(async () => {
    try {
      const result = await getCoverArt(trackPath);
      const url = result?.data_url ?? null;
      cache.set(trackPath, url);
      return url;
    } catch {
      cache.set(trackPath, null);
      return null;
    } finally {
      inflight.delete(trackPath);
    }
  });

  inflight.set(trackPath, promise);
  return promise;
};

interface UseCoverArtOptions {
  cacheOnly?: boolean;
  defer?: boolean;
  enabled?: boolean;
}

export function useCoverArt(
  trackPath: string | null | undefined,
  options?: UseCoverArtOptions,
): string | null {
  const cacheOnly = options?.cacheOnly === true;
  const defer = options?.defer === true;
  const enabled = options?.enabled !== false;
  const [url, setUrl] = useState<string | null>(() =>
    trackPath ? cache.get(trackPath) ?? null : null,
  );

  useEffect(() => {
    if (!trackPath) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    const cached = cache.get(trackPath);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }

    if (!enabled) {
      setUrl(null);
      return;
    }

    if (cacheOnly) {
      setUrl(null);
      return;
    }

    setUrl(null);
    const runFetch = () => {
      void fetchCover(trackPath).then((value) => {
        if (!cancelled) setUrl(value);
      });
    };

    if (defer) {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        const idleId = window.requestIdleCallback(() => runFetch(), { timeout: 1000 });
        return () => {
          cancelled = true;
          window.cancelIdleCallback(idleId);
        };
      }

      const timeoutId = globalThis.setTimeout(runFetch, 90);
      return () => {
        cancelled = true;
        globalThis.clearTimeout(timeoutId);
      };
    }

    runFetch();

    return () => {
      cancelled = true;
    };
  }, [cacheOnly, defer, enabled, trackPath]);

  return url;
}
