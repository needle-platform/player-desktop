import { useEffect, useState } from 'react';
import { getAlbumInfo, type AlbumInfo } from './tauri';

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
}

export function useAlbumInfo(
  album: string | null | undefined,
  artist: string | null | undefined,
): AlbumInfoState {
  const [state, setState] = useState<AlbumInfoState>(() => {
    if (!album) return { info: null, loading: false };
    const key = keyOf(album, artist ?? null);
    if (cache.has(key)) {
      return { info: cache.get(key) ?? null, loading: false };
    }
    return { info: null, loading: true };
  });

  useEffect(() => {
    if (!album) {
      setState({ info: null, loading: false });
      return;
    }
    const key = keyOf(album, artist ?? null);
    if (cache.has(key)) {
      setState({ info: cache.get(key) ?? null, loading: false });
      return;
    }

    let cancelled = false;
    setState({ info: null, loading: true });
    void fetchOnce(album, artist ?? null).then((value) => {
      if (!cancelled) setState({ info: value, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [album, artist]);

  return state;
}
