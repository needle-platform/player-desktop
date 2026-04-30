import { useEffect, useState } from 'react';
import { getArtistImage, refreshArtistImage } from './tauri';

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

export interface ArtistImageState {
  url: string | null;
  loading: boolean;
  retrying: boolean;
  retry: () => Promise<void>;
}

export function useArtistImage(name: string | null | undefined): ArtistImageState {
  const [state, setState] = useState<Omit<ArtistImageState, 'retry'>>(() => {
    if (!name) return { url: null, loading: false, retrying: false };
    if (cache.has(name)) {
      return { url: cache.get(name) ?? null, loading: false, retrying: false };
    }
    return { url: null, loading: true, retrying: false };
  });

  useEffect(() => {
    if (!name) {
      setState({ url: null, loading: false, retrying: false });
      return;
    }

    if (cache.has(name)) {
      setState({ url: cache.get(name) ?? null, loading: false, retrying: false });
      return;
    }

    let cancelled = false;
    setState((current) => ({ url: current.url, loading: true, retrying: false }));
    void fetchOnce(name).then((value) => {
      if (!cancelled) setState({ url: value, loading: false, retrying: false });
    });

    return () => {
      cancelled = true;
    };
  }, [name]);

  const retry = async () => {
    if (!name) return;
    cache.delete(name);
    inflight.delete(name);
    setState((current) => ({ ...current, loading: true, retrying: true }));
    try {
      const result = await refreshArtistImage(name);
      const url = result?.url ?? null;
      cache.set(name, url);
      setState({ url, loading: false, retrying: false });
    } catch {
      setState((current) => ({ url: current.url, loading: false, retrying: false }));
    }
  };

  return { ...state, retry };
}
