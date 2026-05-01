import { useEffect, useState } from 'react';
import { getArtistInfo, refreshArtistInfo, type ArtistInfo } from './tauri';

const cache = new Map<string, ArtistInfo | null>();
const inflight = new Map<string, Promise<ArtistInfo | null>>();

const fetchOnce = (name: string): Promise<ArtistInfo | null> => {
  if (cache.has(name)) return Promise.resolve(cache.get(name) ?? null);
  const existing = inflight.get(name);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await getArtistInfo(name);
      cache.set(name, result);
      return result;
    } catch {
      return null;
    } finally {
      inflight.delete(name);
    }
  })();

  inflight.set(name, promise);
  return promise;
};

export interface ArtistInfoState {
  info: ArtistInfo | null;
  loading: boolean;
  retrying: boolean;
  retry: () => Promise<void>;
}

export function useArtistInfo(name: string | null | undefined): ArtistInfoState {
  const [state, setState] = useState<Omit<ArtistInfoState, 'retry'>>(() => {
    if (!name) return { info: null, loading: false, retrying: false };
    if (cache.has(name)) {
      return { info: cache.get(name) ?? null, loading: false, retrying: false };
    }
    return { info: null, loading: true, retrying: false };
  });

  useEffect(() => {
    if (!name) {
      setState({ info: null, loading: false, retrying: false });
      return;
    }

    if (cache.has(name)) {
      setState({ info: cache.get(name) ?? null, loading: false, retrying: false });
      return;
    }

    let cancelled = false;
    setState((current) => ({ info: current.info, loading: true, retrying: false }));
    void fetchOnce(name).then((value) => {
      if (!cancelled) setState({ info: value, loading: false, retrying: false });
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
      const result = await refreshArtistInfo(name);
      cache.set(name, result);
      setState({ info: result, loading: false, retrying: false });
    } catch {
      setState((current) => ({ info: current.info, loading: false, retrying: false }));
    }
  };

  return { ...state, retry };
}
