import { useEffect, useState } from 'react';
import { getCoverArt } from './tauri';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

const fetchCover = async (trackPath: string): Promise<string | null> => {
  if (cache.has(trackPath)) {
    return cache.get(trackPath) ?? null;
  }

  const existing = inflight.get(trackPath);
  if (existing) return existing;

  const promise = (async () => {
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
  })();

  inflight.set(trackPath, promise);
  return promise;
};

export function useCoverArt(trackPath: string | null | undefined): string | null {
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

    setUrl(null);
    void fetchCover(trackPath).then((value) => {
      if (!cancelled) setUrl(value);
    });

    return () => {
      cancelled = true;
    };
  }, [trackPath]);

  return url;
}
