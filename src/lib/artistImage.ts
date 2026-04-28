import { useEffect, useState } from 'react';
import { getArtistImage } from './tauri';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

const fetchOnce = (name: string): Promise<string | null> => {
  if (cache.has(name)) return Promise.resolve(cache.get(name) ?? null);
  const existing = inflight.get(name);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await getArtistImage(name);
      const url = result?.url ?? null;
      cache.set(name, url);
      return url;
    } catch {
      cache.set(name, null);
      return null;
    } finally {
      inflight.delete(name);
    }
  })();

  inflight.set(name, promise);
  return promise;
};

export function useArtistImage(name: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    name ? cache.get(name) ?? null : null,
  );

  useEffect(() => {
    if (!name) {
      setUrl(null);
      return;
    }

    const cached = cache.get(name);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }

    let cancelled = false;
    setUrl(null);
    void fetchOnce(name).then((value) => {
      if (!cancelled) setUrl(value);
    });

    return () => {
      cancelled = true;
    };
  }, [name]);

  return url;
}
