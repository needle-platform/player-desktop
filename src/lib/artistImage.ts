import { useEffect, useState } from 'react';
import { getArtistImage, peekArtistImage, refreshArtistImage } from './tauri';

const fullCache = new Map<string, string | null>();
const fullInflight = new Map<string, Promise<string | null>>();
const peekCache = new Map<string, string | null>();
const peekInflight = new Map<string, Promise<string | null>>();

const seedArtistImageCaches = (name: string, url: string | null) => {
  fullCache.set(name, url);
  peekCache.set(name, url);
};

const fetchOnce = (name: string): Promise<string | null> => {
  if (fullCache.has(name)) return Promise.resolve(fullCache.get(name) ?? null);
  const existing = fullInflight.get(name);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await getArtistImage(name);
      const url = result?.url ?? null;
      seedArtistImageCaches(name, url);
      return url;
    } catch {
      fullCache.set(name, null);
      return null;
    } finally {
      fullInflight.delete(name);
    }
  })();

  fullInflight.set(name, promise);
  return promise;
};

const peekOnce = (name: string): Promise<string | null> => {
  if (peekCache.has(name)) return Promise.resolve(peekCache.get(name) ?? null);
  const existing = peekInflight.get(name);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await peekArtistImage(name);
      const url = result?.url ?? null;
      peekCache.set(name, url);
      return url;
    } catch {
      peekCache.set(name, null);
      return null;
    } finally {
      peekInflight.delete(name);
    }
  })();

  peekInflight.set(name, promise);
  return promise;
};

export interface ArtistImageState {
  url: string | null;
  loading: boolean;
  retrying: boolean;
  retry: () => Promise<void>;
}

interface UseArtistImageOptions {
  cacheOnly?: boolean;
  enabled?: boolean;
}

export function useArtistImage(
  name: string | null | undefined,
  options?: UseArtistImageOptions,
): ArtistImageState {
  const cacheOnly = options?.cacheOnly === true;
  const enabled = options?.enabled !== false;
  const cache = cacheOnly ? peekCache : fullCache;
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

    if (!enabled) {
      setState({ url: null, loading: false, retrying: false });
      return;
    }

    let cancelled = false;
    setState((current) => ({ url: current.url, loading: true, retrying: false }));
    void (cacheOnly ? peekOnce(name) : fetchOnce(name)).then((value) => {
      if (!cancelled) setState({ url: value, loading: false, retrying: false });
    });

    return () => {
      cancelled = true;
    };
  }, [cache, cacheOnly, enabled, name]);

  const retry = async () => {
    if (!name) return;
    fullCache.delete(name);
    fullInflight.delete(name);
    peekCache.delete(name);
    peekInflight.delete(name);
    setState((current) => ({ ...current, loading: true, retrying: true }));
    try {
      const result = await refreshArtistImage(name);
      const url = result?.url ?? null;
      seedArtistImageCaches(name, url);
      setState({ url, loading: false, retrying: false });
    } catch {
      setState((current) => ({ url: current.url, loading: false, retrying: false }));
    }
  };

  return { ...state, retry };
}
