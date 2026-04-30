import { useEffect, useState } from 'react';
import { getAlbumInfo, refreshAlbumInfo, type AlbumInfo } from './tauri';

const cache = new Map<string, AlbumInfo | null>();
const inflight = new Map<string, Promise<AlbumInfo | null>>();

const keyOf = (album: string, artist: string | null) =>
  `${album.toLowerCase()}|${(artist ?? '').toLowerCase()}`;

const fetchOnce = (album: string, artist: string | null): Promise<AlbumInfo | null> => {
  const key = keyOf(album, artist);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await getAlbumInfo(album, artist);
      cache.set(key, result);
      return result;
    } catch {
      cache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
};

export interface AlbumInfoState {
  info: AlbumInfo | null;
  loading: boolean;
  retrying: boolean;
  retry: () => Promise<void>;
}

export function useAlbumInfo(
  album: string | null | undefined,
  artist: string | null | undefined,
): AlbumInfoState {
  const [state, setState] = useState<Omit<AlbumInfoState, 'retry'>>(() => {
    if (!album) return { info: null, loading: false, retrying: false };
    const key = keyOf(album, artist ?? null);
    if (cache.has(key)) {
      return { info: cache.get(key) ?? null, loading: false, retrying: false };
    }
    return { info: null, loading: true, retrying: false };
  });

  useEffect(() => {
    if (!album) {
      setState({ info: null, loading: false, retrying: false });
      return;
    }
    const key = keyOf(album, artist ?? null);
    if (cache.has(key)) {
      setState({ info: cache.get(key) ?? null, loading: false, retrying: false });
      return;
    }

    let cancelled = false;
    setState((current) => ({ info: current.info, loading: true, retrying: false }));
    void fetchOnce(album, artist ?? null).then((value) => {
      if (!cancelled) setState({ info: value, loading: false, retrying: false });
    });
    return () => {
      cancelled = true;
    };
  }, [album, artist]);

  const retry = async () => {
    if (!album) return;
    const normalizedArtist = artist ?? null;
    const key = keyOf(album, normalizedArtist);
    cache.delete(key);
    inflight.delete(key);
    setState((current) => ({ ...current, loading: true, retrying: true }));
    try {
      const result = await refreshAlbumInfo(album, normalizedArtist);
      cache.set(key, result);
      setState({ info: result, loading: false, retrying: false });
    } catch {
      setState({ info: null, loading: false, retrying: false });
    }
  };

  return { ...state, retry };
}
