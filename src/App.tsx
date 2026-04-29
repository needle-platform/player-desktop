import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import type { CSSProperties, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  appendQueue,
  bootstrapApp,
  createPlaylist,
  deletePlaylist,
  getPlaybackState,
  insertQueueAt,
  moveQueueIndex as tauriMoveQueueIndex,
  movePlaylistTrack,
  pausePlayback,
  playQueueIndex as tauriPlayQueueIndex,
  playQueue as tauriPlayQueue,
  playTrack,
  recordPlay,
  removePlaylistTrack,
  removeQueueIndex as tauriRemoveQueueIndex,
  removeLibraryRoot,
  renamePlaylist,
  resumePlayback,
  runMaintenance,
  setAudioDevice as setPlaybackAudioDevice,
  setPlaybackMuted,
  setPlaybackVolume as setPlaybackVolumeLevel,
  setRepeatMode as tauriSetRepeatMode,
  saveSettings,
  savePlaybackSession,
  scanLibrary,
  seekPlayback,
  stopPlayback,
  syncPlaybackSession,
} from './lib/tauri';
import type {
  AudioDevice,
  AppSettings,
  BootstrapPayload,
  EqualizerPreset,
  PlaybackSession,
  RepeatMode,
  SavedPlaylist,
  ThemeMode,
  Track,
} from './types';
import { useCoverArt } from './lib/cover';
import { useArtistImage } from './lib/artistImage';
import { useAlbumInfo } from './lib/albumInfo';
import { generateAutoPlaylists, type AutoPlaylist } from './lib/playlists';
import dashboardIdleBackdrop from './assets/bg.jpg';
import needleBrandMarkDark from './assets/needle-icon-flat-dark.png';
import needleBrandMarkLight from './assets/needle-icon-flat-light.png';

type View = 'dashboard' | 'tracks' | 'albums' | 'album' | 'artists' | 'settings';
type PlaylistSelection = { kind: 'smart'; id: string } | { kind: 'manual'; id: number };
type ResolvedPlaylist = {
  id: string;
  kind: 'smart' | 'manual';
  name: string;
  description: string;
  tracks: Track[];
  saved?: SavedPlaylist;
};
type AlbumSummary = {
  key: string;
  album: string;
  artist: string | null;
  count: number;
  samplePath: string;
  addedAt: string | null;
};

const greeting = (): string => {
  const h = new Date().getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

const relativeAdded = (iso: string | null): string => {
  if (!iso) return 'Recently added';
  const ts = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ts)) return 'Recently added';
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return 'Today';
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
};

const sampleN = <T,>(arr: T[], n: number): T[] => {
  if (arr.length <= n) return arr.slice();
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};
const shuffleList = <T,>(arr: T[]): T[] => {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const equalizerOptions: Array<{ value: EqualizerPreset; label: string }> = [
  { value: 'flat', label: 'Flat' },
  { value: 'bass_boost', label: 'Bass Boost' },
  { value: 'vocal', label: 'Vocal' },
  { value: 'treble_boost', label: 'Treble Boost' },
  { value: 'lounge', label: 'Lounge' },
  { value: 'manual', label: 'Manual' },
];
const equalizerBandLabels = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const defaultEqualizerBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const maxEqualizerGain = 6;
const equalizerPresetBands: Record<Exclude<EqualizerPreset, 'manual'>, number[]> = {
  flat: defaultEqualizerBands,
  bass_boost: [2.3, 2.6, 2.2, 1.4, 0.5, 0.0, 0.0, -0.2, -0.3, 0.0],
  vocal: [-0.8, -0.6, -0.3, 0.2, 1.0, 1.8, 2.2, 1.0, 0.4, -0.2],
  treble_boost: [-0.3, -0.2, 0.0, 0.0, 0.3, 0.9, 1.6, 2.2, 2.5, 1.4],
  lounge: [1.2, 1.4, 1.0, 0.5, 0.2, -0.3, -0.8, -0.2, 0.2, 0.4],
};

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const defaultVolumePercent = 80;

const formatDuration = (seconds: number | null | undefined) => {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatQuality = (track: Track) => {
  const parts = [
    track.format,
    track.sample_rate ? `${(track.sample_rate / 1000).toFixed(1)} kHz` : null,
    track.bit_depth ? `${track.bit_depth}-bit` : null,
  ].filter((v): v is string => Boolean(v));
  return parts.join(' · ') || '—';
};

const defaultAudioDevice: AudioDevice = { name: 'auto', description: 'System default' };

const clampVolume = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const clampIndex = (index: number, length: number) =>
  length <= 0 ? 0 : Math.max(0, Math.min(index, length - 1));
const audioDeviceKey = (description: string) => description.trim().toLowerCase();
const albumIdentitySeparator = '\u0000';
const albumArtistForTrack = (track: Pick<Track, 'album_artist' | 'artist'>) =>
  track.album_artist ?? track.artist ?? null;
const albumKey = (album: string | null | undefined, albumArtist: string | null | undefined) =>
  `${album ?? ''}${albumIdentitySeparator}${albumArtist ?? ''}`;
const trackAlbumKey = (track: Pick<Track, 'album' | 'album_artist' | 'artist'>) =>
  track.album ? albumKey(track.album, albumArtistForTrack(track)) : null;
const albumTitleFromKey = (key: string) => key.split(albumIdentitySeparator)[0] ?? key;
const compareAlbumTracks = (a: Track, b: Track) =>
  (a.disc_number ?? 1) - (b.disc_number ?? 1) ||
  (a.track_number ?? 9999) - (b.track_number ?? 9999) ||
  a.title.localeCompare(b.title) ||
  a.path.localeCompare(b.path);
const clampEqualizerGain = (value: number) => Math.max(-maxEqualizerGain, Math.min(maxEqualizerGain, value));
const normalizeEqualizerBands = (bands: number[] | null | undefined) => {
  const next = defaultEqualizerBands.slice();
  if (!Array.isArray(bands)) return next;
  for (let i = 0; i < next.length; i += 1) {
    const value = bands[i];
    next[i] = clampEqualizerGain(typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }
  return next;
};
const displayedEqualizerBands = (settings: AppSettings) =>
  settings.equalizer_preset === 'manual'
    ? normalizeEqualizerBands(settings.equalizer_bands)
    : equalizerPresetBands[settings.equalizer_preset] ?? defaultEqualizerBands;
const normalizeSession = (session?: Partial<PlaybackSession> | null): PlaybackSession => {
  const queuePaths = Array.isArray(session?.queue_paths) ? session.queue_paths.filter(Boolean) : [];
  const baseQueuePaths = Array.isArray(session?.base_queue_paths)
    ? session.base_queue_paths.filter(Boolean)
    : queuePaths.slice();
  const currentIndex = clampIndex(
    typeof session?.current_index === 'number' ? session.current_index : 0,
    queuePaths.length,
  );

  return {
    queue_paths: queuePaths,
    base_queue_paths: baseQueuePaths.length > 0 ? baseQueuePaths : queuePaths.slice(),
    current_index: currentIndex,
    position_seconds:
      typeof session?.position_seconds === 'number' && Number.isFinite(session.position_seconds)
        ? Math.max(0, session.position_seconds)
        : 0,
    paused: session?.paused ?? true,
    repeat_mode: session?.repeat_mode ?? 'off',
    shuffle_enabled: session?.shuffle_enabled ?? false,
  };
};
const shuffleQueueKeepingCurrent = (paths: string[], currentIndex: number) => {
  if (paths.length <= 1) return paths.slice();
  const safeIndex = clampIndex(currentIndex, paths.length);
  const before = paths.slice(0, safeIndex);
  const current = paths[safeIndex];
  const after = shuffleList(paths.slice(safeIndex + 1));
  return [...before, current, ...after];
};

const normalizeAudioDevices = (data: unknown): AudioDevice[] => {
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();

  return data
    .map((device) => {
      if (!device || typeof device !== 'object') return null;
      const record = device as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : null;
      if (!name) return null;
      const description =
        typeof record.description === 'string' && record.description.trim().length > 0
          ? record.description
          : name === 'auto'
            ? defaultAudioDevice.description
            : name;
      return { name, description };
    })
    .filter((device): device is AudioDevice => {
      if (!device || seen.has(device.name)) return false;
      seen.add(device.name);
      return true;
    });
};

function PlayingIndicator() {
  return (
    <span className="playing-indicator" aria-hidden="true">
      <span className="playing-indicator-bar" />
      <span className="playing-indicator-bar" />
      <span className="playing-indicator-bar" />
    </span>
  );
}

function PreviousIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6v12" />
      <path d="M18 6.5 10 12l8 5.5z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6.5 18 12 8 17.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6.5v11" />
      <path d="M15 6.5v11" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 6v12" />
      <path d="M6 6.5 14 12l-8 5.5z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  );
}

function VolumeHighIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 9v6h4l5 4V5l-5 4z" />
      <path d="M18 9.5a4.5 4.5 0 0 1 0 5" />
      <path d="M20 7a8 8 0 0 1 0 10" />
    </svg>
  );
}

function VolumeLowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 9v6h4l5 4V5l-5 4z" />
      <path d="M18 10a3 3 0 0 1 0 4" />
    </svg>
  );
}

function VolumeMutedIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 9v6h4l5 4V5l-5 4z" />
      <path d="m17 9 4 6" />
      <path d="m21 9-4 6" />
    </svg>
  );
}

function OutputDeviceIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="6" width="16" height="10" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h10" />
      <path d="M4 12h10" />
      <path d="M4 17h6" />
      <path d="m16 14 4 3-4 3z" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h4l10 10h2" />
      <path d="M18 7h2v2" />
      <path d="m16 9 4-2-2-4" />
      <path d="M4 17h4l3-3" />
      <path d="m16 15 4 2-2 4" />
      <path d="M18 17h2v-2" />
    </svg>
  );
}

function RepeatIcon({ mode }: { mode: RepeatMode }) {
  return (
    <span className="repeat-icon-wrap">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11V9a3 3 0 0 1 3-3h15" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v2a3 3 0 0 1-3 3H3" />
      </svg>
      {mode === 'one' && <span className="repeat-icon-badge">1</span>}
    </span>
  );
}

function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [featuredSeed, setFeaturedSeed] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSelection | null>(null);
  const [queuePaths, setQueuePaths] = useState<string[]>([]);
  const [baseQueuePaths, setBaseQueuePaths] = useState<string[]>([]);
  const [currentQueueIndex, setCurrentQueueIndex] = useState(0);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isBackendPlaybackLoaded, setIsBackendPlaybackLoaded] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(defaultVolumePercent);
  const [isMuted, setIsMuted] = useState(false);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([defaultAudioDevice]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState(defaultAudioDevice.name);
  const [isDeviceMenuOpen, setIsDeviceMenuOpen] = useState(false);
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  const lastRecordedPath = useRef<string | null>(null);
  const suppressRecordPathRef = useRef<string | null>(null);
  const sessionHydratedRef = useRef(false);
  const scrubPositionRef = useRef<number | null>(null);
  const backendPathRef = useRef<string | null>(null);
  const backendPausedRef = useRef(true);
  const backendIdleRef = useRef(true);
  const albumReturnView = useRef<View>('albums');
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);
  const queueDrawerRef = useRef<HTMLElement | null>(null);

  const syncConfirmedPlaybackState = () => {
    setIsPlaying(
      Boolean(backendPathRef.current) && !backendPausedRef.current && !backendIdleRef.current,
    );
  };

  const openAlbum = (album: string) => {
    albumReturnView.current = view === 'tracks' ? 'albums' : view;
    setSelectedAlbum(album);
    setSelectedArtist(null);
    setSelectedPlaylist(null);
    setView('album');
  };

  const clearBrowsingFilters = () => {
    setSelectedAlbum(null);
    setSelectedArtist(null);
    setSelectedPlaylist(null);
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      const dispose = await listen<{ name: string; data: unknown }>(
        'mpv-property',
        (event) => {
          const { name, data } = event.payload;
          if (name === 'path') {
            const path = typeof data === 'string' ? data : null;
            backendPathRef.current = path;
            setCurrentPath(path);
            if (!path) {
              scrubPositionRef.current = null;
              setScrubPosition(null);
              setPlaybackPosition(0);
              setPlaybackDuration(0);
              syncConfirmedPlaybackState();
              setStatus('');
              return;
            }
            setIsBackendPlaybackLoaded(true);
            const queueIndex = queuePaths.indexOf(path);
            if (queueIndex >= 0) {
              setCurrentQueueIndex(queueIndex);
            }
            scrubPositionRef.current = null;
            setScrubPosition(null);
            setPlaybackPosition(0);
            syncConfirmedPlaybackState();
            if (suppressRecordPathRef.current === path) {
              suppressRecordPathRef.current = null;
              lastRecordedPath.current = path;
              return;
            }
            if (lastRecordedPath.current !== path) {
              lastRecordedPath.current = path;
              const nowIso = new Date().toISOString();
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      library: {
                        ...prev.library,
                        tracks: prev.library.tracks.map((t) =>
                          t.path === path
                            ? {
                                ...t,
                                play_count: (t.play_count ?? 0) + 1,
                                last_played_at: nowIso,
                              }
                            : t,
                        ),
                      },
                    }
                  : prev,
              );
              void recordPlay(path).catch(() => {});
            }
          } else if (name === 'pause') {
            backendPausedRef.current = data === true;
            syncConfirmedPlaybackState();
          } else if (name === 'idle-active') {
            backendIdleRef.current = data === true;
            syncConfirmedPlaybackState();
          } else if (name === 'time-pos') {
            if (scrubPositionRef.current == null) {
              setPlaybackPosition(typeof data === 'number' ? data : 0);
            }
          } else if (name === 'duration') {
            setPlaybackDuration(typeof data === 'number' ? data : 0);
          } else if (name === 'volume') {
            setVolumeLevel(typeof data === 'number' ? clampVolume(data) : defaultVolumePercent);
          } else if (name === 'mute') {
            setIsMuted(data === true);
          } else if (name === 'audio-device') {
            if (typeof data === 'string' && data.length > 0) {
              setSelectedAudioDevice(data);
            }
          } else if (name === 'audio-device-list') {
            const devices = normalizeAudioDevices(data);
            if (devices.length > 0) {
              setAudioDevices(devices);
            }
          }
        },
      );
      unlisten = dispose;
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [queuePaths]);

  useEffect(() => {
    void (async () => {
      try {
        setData(await bootstrapApp());
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const playback = await getPlaybackState();
        if (cancelled) return;
        setVolumeLevel(clampVolume(playback.volume));
        setIsMuted(playback.muted);
        setSelectedAudioDevice(playback.audio_device || defaultAudioDevice.name);
        setAudioDevices(playback.audio_devices.length > 0 ? playback.audio_devices : [defaultAudioDevice]);
      } catch (error) {
        if (!cancelled) {
          setStatus((prev) => prev || (error instanceof Error ? error.message : String(error)));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!data) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const t = data.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : data.settings.theme;
      document.documentElement.dataset.theme = t;
      setResolvedTheme(t);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [data]);

  useEffect(() => {
    if (!isDeviceMenuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!deviceMenuRef.current?.contains(event.target as Node)) {
        setIsDeviceMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDeviceMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isDeviceMenuOpen]);

  useEffect(() => {
    if (!isQueueOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!queueDrawerRef.current?.contains(event.target as Node)) {
        setIsQueueOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsQueueOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isQueueOpen]);

  const allTracks = data?.library.tracks ?? [];
  const trackByPath = useMemo(() => new Map(allTracks.map((track) => [track.path, track])), [allTracks]);

  const restoreSession = async (
    session: PlaybackSession,
    options?: { forcePaused?: boolean; deferBackendLoad?: boolean },
  ) => {
    const filteredQueue = session.queue_paths.filter((path) => trackByPath.has(path));
    const filteredBase = (session.base_queue_paths.length > 0 ? session.base_queue_paths : session.queue_paths).filter(
      (path) => trackByPath.has(path),
    );
    const nextIndex = clampIndex(session.current_index, filteredQueue.length);
    const normalizedBase = filteredBase.length > 0 ? filteredBase : filteredQueue.slice();
    const normalizedSession: PlaybackSession = {
      ...session,
      queue_paths: filteredQueue,
      base_queue_paths: normalizedBase,
      current_index: nextIndex,
      paused: options?.forcePaused ?? session.paused,
    };

    setQueuePaths(normalizedSession.queue_paths);
    setBaseQueuePaths(normalizedSession.base_queue_paths);
    setCurrentQueueIndex(normalizedSession.current_index);
    setRepeatMode(normalizedSession.repeat_mode);
    setShuffleEnabled(normalizedSession.shuffle_enabled);
    setIsBackendPlaybackLoaded(!options?.deferBackendLoad && normalizedSession.queue_paths.length > 0);
    setCurrentPath(
      options?.deferBackendLoad ? null : (normalizedSession.queue_paths[normalizedSession.current_index] ?? null),
    );
    setPlaybackPosition(normalizedSession.position_seconds);
    setPlaybackDuration(0);
    setIsPlaying(!normalizedSession.paused);

    if (normalizedSession.queue_paths.length === 0 || options?.deferBackendLoad) {
      backendPathRef.current = null;
      backendPausedRef.current = true;
      backendIdleRef.current = true;
      return;
    }

    suppressRecordPathRef.current = normalizedSession.queue_paths[normalizedSession.current_index] ?? null;
    await syncPlaybackSession(normalizedSession);
  };

  const persistSession = async (session: PlaybackSession) => {
    try {
      await savePlaybackSession(session);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!data || sessionHydratedRef.current) return;
    sessionHydratedRef.current = true;

    const session = normalizeSession(data.playback_session);
    void restoreSession(session, { forcePaused: true, deferBackendLoad: true }).catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  }, [data, trackByPath]);

  useEffect(() => {
    if (!sessionHydratedRef.current) return;

    const normalizedQueue = queuePaths.filter((path) => trackByPath.has(path));
    const normalizedBase = baseQueuePaths.filter((path) => trackByPath.has(path));
    if (
      normalizedQueue.length !== queuePaths.length ||
      normalizedBase.length !== baseQueuePaths.length
    ) {
      setQueuePaths(normalizedQueue);
      setBaseQueuePaths(normalizedBase.length > 0 ? normalizedBase : normalizedQueue);
      setCurrentQueueIndex((prev) => clampIndex(prev, normalizedQueue.length));
      if (normalizedQueue.length === 0) {
        backendPathRef.current = null;
        backendPausedRef.current = true;
        backendIdleRef.current = true;
        setCurrentPath(null);
        setIsPlaying(false);
      } else if (currentPath && !normalizedQueue.includes(currentPath)) {
        const fallbackPath = normalizedQueue[clampIndex(currentQueueIndex, normalizedQueue.length)];
        setCurrentPath(fallbackPath ?? null);
      }
    }
  }, [baseQueuePaths, currentPath, currentQueueIndex, queuePaths, trackByPath]);

  const queueTracks = useMemo(
    () => queuePaths.map((path) => trackByPath.get(path)).filter((track): track is Track => Boolean(track)),
    [queuePaths, trackByPath],
  );
  const baseQueueTracks = useMemo(
    () => baseQueuePaths.map((path) => trackByPath.get(path)).filter((track): track is Track => Boolean(track)),
    [baseQueuePaths, trackByPath],
  );
  const currentQueueTrack = queueTracks[currentQueueIndex] ?? null;

  const playbackSession = useMemo<PlaybackSession>(
    () => ({
      queue_paths: queueTracks.map((track) => track.path),
      base_queue_paths:
        baseQueueTracks.length > 0
          ? baseQueueTracks.map((track) => track.path)
          : queueTracks.map((track) => track.path),
      current_index: clampIndex(
        currentPath ? queueTracks.findIndex((track) => track.path === currentPath) : currentQueueIndex,
        queueTracks.length,
      ),
      position_seconds: currentPath || currentQueueTrack ? playbackPosition : 0,
      paused: !isPlaying,
      repeat_mode: repeatMode,
      shuffle_enabled: shuffleEnabled,
    }),
    [
      baseQueueTracks,
      currentPath,
      currentQueueIndex,
      currentQueueTrack,
      isPlaying,
      playbackPosition,
      queueTracks,
      repeatMode,
      shuffleEnabled,
    ],
  );

  useEffect(() => {
    if (!sessionHydratedRef.current) return;

    const timeout = window.setTimeout(() => {
      void persistSession(playbackSession);
    }, currentPath ? 900 : 150);

    return () => window.clearTimeout(timeout);
  }, [currentPath, playbackSession]);

  const smartPlaylists = useMemo(
    () => generateAutoPlaylists(allTracks),
    // featuredSeed reroll also rerolls playlist sampling
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTracks, featuredSeed],
  );

  const manualPlaylists = data?.playlists ?? [];
  const selectedPlaylistData = useMemo<ResolvedPlaylist | null>(() => {
    if (!selectedPlaylist) return null;
    if (selectedPlaylist.kind === 'smart') {
      const playlist = smartPlaylists.find((entry) => entry.id === selectedPlaylist.id);
      if (!playlist) return null;
      return {
        id: playlist.id,
        kind: 'smart',
        name: playlist.name,
        description: playlist.description,
        tracks: playlist.tracks,
      };
    }

    const playlist = manualPlaylists.find((entry) => entry.id === selectedPlaylist.id);
    if (!playlist) return null;
    const tracks = playlist.track_paths
      .map((path) => trackByPath.get(path))
      .filter((track): track is Track => Boolean(track));
    return {
      id: `manual:${playlist.id}`,
      kind: 'manual',
      name: playlist.name,
      description: `${tracks.length} saved track${tracks.length === 1 ? '' : 's'}`,
      tracks,
      saved: playlist,
    };
  }, [manualPlaylists, selectedPlaylist, smartPlaylists, trackByPath]);

  const filteredTracks = useMemo(() => {
    let list: Track[] = selectedPlaylistData ? selectedPlaylistData.tracks : allTracks;
    if (selectedAlbum) list = list.filter((t) => trackAlbumKey(t) === selectedAlbum);
    if (selectedArtist) list = list.filter((t) => t.artist === selectedArtist);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.artist ?? '').toLowerCase().includes(q) ||
          (t.album ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [allTracks, search, selectedAlbum, selectedArtist, selectedPlaylistData]);

  useEffect(() => {
    if (!selectedPlaylist) return;
    if (selectedPlaylist.kind === 'smart') {
      if (!smartPlaylists.some((playlist) => playlist.id === selectedPlaylist.id)) {
        setSelectedPlaylist(null);
      }
      return;
    }

    if (!manualPlaylists.some((playlist) => playlist.id === selectedPlaylist.id)) {
      setSelectedPlaylist(null);
    }
  }, [manualPlaylists, selectedPlaylist, smartPlaylists]);

  const albums = useMemo(() => {
    const map = new Map<string, AlbumSummary>();
    for (const t of allTracks) {
      const key = trackAlbumKey(t);
      if (!key || !t.album) continue;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        if (t.added_at && (!existing.addedAt || t.added_at > existing.addedAt)) {
          existing.addedAt = t.added_at;
        }
      } else {
        map.set(key, {
          key,
          album: t.album,
          artist: albumArtistForTrack(t),
          count: 1,
          samplePath: t.path,
          addedAt: t.added_at ?? null,
        });
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => a.album.localeCompare(b.album) || (a.artist ?? '').localeCompare(b.artist ?? ''),
    );
  }, [allTracks]);

  const recentAlbums = useMemo(() => {
    const withDate = albums.filter((a) => Boolean(a.addedAt));
    if (withDate.length === 0) return [];
    return withDate.slice().sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? '')).slice(0, 8);
  }, [albums]);

  const artists = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of allTracks) {
      if (!t.artist) continue;
      map.set(t.artist, (map.get(t.artist) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([artist, count]) => ({ artist, count }))
      .sort((a, b) => a.artist.localeCompare(b.artist));
  }, [allTracks]);

  const currentTrack = useMemo(
    () => (currentPath ? trackByPath.get(currentPath) ?? null : currentQueueTrack),
    [currentPath, currentQueueTrack, trackByPath],
  );
  const selectedManualPlaylist =
    selectedPlaylistData?.kind === 'manual' ? selectedPlaylistData.saved ?? null : null;
  const selectedAlbumSummary = useMemo(
    () => albums.find((album) => album.key === selectedAlbum) ?? null,
    [albums, selectedAlbum],
  );

  const selectedRawOutputDevice = useMemo(
    () => audioDevices.find((device) => device.name === selectedAudioDevice) ?? null,
    [audioDevices, selectedAudioDevice],
  );
  const selectedOutputDeviceKey = audioDeviceKey(
    selectedRawOutputDevice?.description ??
      (selectedAudioDevice === 'auto' ? defaultAudioDevice.description : selectedAudioDevice),
  );
  const currentAlbum = currentTrack?.album ?? null;
  const currentAlbumKey = currentTrack ? trackAlbumKey(currentTrack) : null;
  const outputDevices = useMemo(() => {
    const devices = audioDevices.length > 0 ? audioDevices : [defaultAudioDevice];

    const deduped = new Map<string, AudioDevice>();
    for (const device of devices) {
      const key = audioDeviceKey(device.description);
      const existing = deduped.get(key);
      if (!existing || device.name === selectedAudioDevice) {
        deduped.set(key, device);
      }
    }

    const visibleDevices = Array.from(deduped.values());
    if (
      selectedAudioDevice &&
      !visibleDevices.some((device) => device.name === selectedAudioDevice) &&
      !visibleDevices.some((device) => audioDeviceKey(device.description) === selectedOutputDeviceKey)
    ) {
      visibleDevices.unshift({
        name: selectedAudioDevice,
        description: selectedRawOutputDevice?.description ??
          (selectedAudioDevice === 'auto' ? defaultAudioDevice.description : selectedAudioDevice),
      });
    }

    return visibleDevices;
  }, [audioDevices, selectedAudioDevice, selectedOutputDeviceKey, selectedRawOutputDevice]);
  const activeOutputDevice = useMemo(
    () =>
      outputDevices.find((device) => device.name === selectedAudioDevice) ??
      outputDevices.find((device) => audioDeviceKey(device.description) === selectedOutputDeviceKey) ??
      outputDevices[0] ??
      defaultAudioDevice,
    [outputDevices, selectedAudioDevice, selectedOutputDeviceKey],
  );
  const effectiveDuration = playbackDuration > 0 ? playbackDuration : (currentTrack?.duration_seconds ?? 0);
  const shownPosition = scrubPosition ?? playbackPosition;
  const clampedPosition = effectiveDuration > 0 ? Math.min(shownPosition, effectiveDuration) : shownPosition;
  const remainingSeconds = effectiveDuration > 0 ? Math.max(effectiveDuration - clampedPosition, 0) : null;
  const progressMax = effectiveDuration > 0 ? effectiveDuration : 1;
  const progressPercent = effectiveDuration > 0 ? Math.min((clampedPosition / effectiveDuration) * 100, 100) : 0;
  const progressStyle = {
    background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${progressPercent}%, var(--border) ${progressPercent}%, var(--border) 100%)`,
  };

  const commitSeek = async (position: number | null) => {
    const next = position == null ? null : Math.max(0, Math.min(position, progressMax));
    scrubPositionRef.current = null;
    setScrubPosition(null);

    if (next == null || !currentTrack || effectiveDuration <= 0) {
      return;
    }

    try {
      await seekPlayback(next);
      setPlaybackPosition(next);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const updateScrubPosition = (next: number) => {
    scrubPositionRef.current = next;
    setScrubPosition(next);
  };

  const updateSettings = async (next: AppSettings) => {
    if (!data) return;
    setData({ ...data, settings: next });
    try {
      await saveSettings(next);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const importFolder = async () => {
    try {
      const result = await open({ directory: true, multiple: false });
      if (!result || Array.isArray(result)) return;
      setBusy('Scanning…');
      setStatus(`Scanning ${result}`);
      const next = await scanLibrary(result);
      setData(next);
      setStatus(`Imported ${next.library.track_count} tracks`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const maintenance = async () => {
    try {
      setBusy('Running maintenance…');
      const next = await runMaintenance();
      setData(next);
      setStatus(`Library synced · ${next.library.track_count} tracks`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const removeRoot = async (folder: string) => {
    try {
      setBusy('Removing folder…');
      const next = await removeLibraryRoot(folder);
      setData(next);
      setStatus(`Removed ${folder}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const promptPlaylistName = (initialValue: string) => {
    const value = window.prompt('Playlist name', initialValue)?.trim();
    return value ? value : null;
  };

  const createManualPlaylist = async (trackPaths: string[], suggestedName: string) => {
    const name = promptPlaylistName(suggestedName);
    if (!name) return;

    try {
      setBusy('Saving playlist…');
      const next = await createPlaylist(name, trackPaths);
      setData(next);
      const created = next.playlists
        .filter((playlist) => playlist.name === name)
        .sort((a, b) => b.id - a.id)[0];
      if (created) {
        setSelectedPlaylist({ kind: 'manual', id: created.id });
        setView('tracks');
      }
      setStatus(`Saved playlist · ${name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const renameManualPlaylist = async (playlist: SavedPlaylist) => {
    const name = promptPlaylistName(playlist.name);
    if (!name || name === playlist.name) return;

    try {
      setBusy('Renaming playlist…');
      const next = await renamePlaylist(playlist.id, name);
      setData(next);
      setStatus(`Renamed playlist · ${name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const deleteManualPlaylistById = async (playlist: SavedPlaylist) => {
    if (!window.confirm(`Delete "${playlist.name}"?`)) return;

    try {
      setBusy('Deleting playlist…');
      const next = await deletePlaylist(playlist.id);
      setData(next);
      if (selectedPlaylist?.kind === 'manual' && selectedPlaylist.id === playlist.id) {
        setSelectedPlaylist(null);
      }
      setStatus(`Deleted playlist · ${playlist.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const saveVisibleTracksAsPlaylist = async (tracks: Track[], suggestedName: string) => {
    const paths = tracks.map((track) => track.path);
    if (paths.length === 0) return;
    await createManualPlaylist(paths, suggestedName);
  };

  const moveManualPlaylistTrack = async (playlistId: number, fromIndex: number, toIndex: number) => {
    try {
      const next = await movePlaylistTrack(playlistId, fromIndex, toIndex);
      setData(next);
      setStatus('Playlist reordered');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const removeManualPlaylistTrack = async (playlistId: number, index: number) => {
    try {
      const next = await removePlaylistTrack(playlistId, index);
      setData(next);
      setStatus('Removed from playlist');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const applySessionLocally = (session: PlaybackSession) => {
    const normalized = normalizeSession(session);
    setQueuePaths(normalized.queue_paths);
    setBaseQueuePaths(
      normalized.base_queue_paths.length > 0 ? normalized.base_queue_paths : normalized.queue_paths,
    );
    setCurrentQueueIndex(normalized.current_index);
    setCurrentPath(normalized.queue_paths[normalized.current_index] ?? null);
    setPlaybackPosition(normalized.position_seconds);
    setPlaybackDuration(0);
    if (normalized.paused || normalized.queue_paths.length === 0) {
      backendPausedRef.current = true;
      setIsPlaying(false);
    }
    setRepeatMode(normalized.repeat_mode);
    setShuffleEnabled(normalized.shuffle_enabled);
  };

  const syncSession = async (
    session: PlaybackSession,
    options?: { label?: string; suppressRecordPath?: string | null },
  ) => {
    const normalized = normalizeSession(session);
    if (options?.suppressRecordPath) {
      suppressRecordPathRef.current = options.suppressRecordPath;
    }
    await syncPlaybackSession(normalized);
    setIsBackendPlaybackLoaded(normalized.queue_paths.length > 0);
    applySessionLocally(normalized);
    if (options?.label) {
      setStatus(options.label);
    }
  };

  const applyQueueLocally = (
    nextQueuePaths: string[],
    nextBasePaths: string[],
    options?: { keepCurrentPath?: string | null },
  ) => {
    const filteredQueue = nextQueuePaths.filter((path) => trackByPath.has(path));
    const filteredBase = nextBasePaths.filter((path) => trackByPath.has(path));
    const keepCurrentPath = options?.keepCurrentPath ?? currentPath;
    const nextCurrentIndex = keepCurrentPath ? filteredQueue.indexOf(keepCurrentPath) : -1;

    setQueuePaths(filteredQueue);
    setBaseQueuePaths(filteredBase.length > 0 ? filteredBase : filteredQueue);
    if (nextCurrentIndex >= 0) {
      setCurrentQueueIndex(nextCurrentIndex);
    } else {
      setCurrentQueueIndex((prev) => clampIndex(prev, filteredQueue.length));
    }
  };

  const jumpToQueueIndex = async (index: number, label?: string) => {
    const targetTrack = queueTracks[index];
    if (!targetTrack) return;

    if (!isBackendPlaybackLoaded) {
      setCurrentQueueIndex(index);
      setPlaybackPosition(0);
      if (label) {
        setStatus(label.replace(/^Playing\b/, 'Selected'));
      }
      return;
    }

    try {
      await tauriPlayQueueIndex(index);
      setIsBackendPlaybackLoaded(true);
      if (label) {
        setStatus(label);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const startQueue = async (
    tracks: Track[],
    label?: string,
    options?: {
      baseTracks?: Track[];
      currentPath?: string;
      shuffle?: boolean;
      paused?: boolean;
    },
  ) => {
    if (tracks.length === 0) return;

    const actualPaths = tracks.map((track) => track.path);
    const basePaths = (options?.baseTracks ?? tracks).map((track) => track.path);
    const targetPath = options?.currentPath ?? actualPaths[0];
    const session = normalizeSession({
      queue_paths: actualPaths,
      base_queue_paths: basePaths,
      current_index: Math.max(actualPaths.indexOf(targetPath), 0),
      position_seconds: 0,
      paused: options?.paused ?? false,
      repeat_mode: repeatMode,
      shuffle_enabled: options?.shuffle ?? false,
    });

    try {
      if (session.position_seconds === 0 && !session.paused) {
        if (actualPaths.length === 1) {
          await playTrack(actualPaths[0]);
        } else {
          await tauriPlayQueue(actualPaths);
          if (session.current_index > 0) {
            await tauriPlayQueueIndex(session.current_index);
          }
        }
        await tauriSetRepeatMode(session.repeat_mode);
        setIsBackendPlaybackLoaded(true);
        applySessionLocally(session);
        setStatus(label ?? `Playing ${tracks[session.current_index]?.title ?? tracks[0].title}`);
        return;
      }

      await syncSession(session, {
        label: label ?? `Playing ${tracks[session.current_index]?.title ?? tracks[0].title}`,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const syncUpdatedQueue = async (
    nextQueuePaths: string[],
    nextBasePaths: string[],
    options?: {
      currentPath?: string | null;
      paused?: boolean;
      positionSeconds?: number;
      label?: string;
      suppressRecordPath?: string | null;
    },
  ) => {
    const filteredQueue = nextQueuePaths.filter((path) => trackByPath.has(path));
    const filteredBase = nextBasePaths.filter((path) => trackByPath.has(path));

    if (filteredQueue.length === 0) {
      try {
        await syncSession(
          {
            queue_paths: [],
            base_queue_paths: [],
            current_index: 0,
            position_seconds: 0,
            paused: true,
            repeat_mode: repeatMode,
            shuffle_enabled: shuffleEnabled,
          },
          { label: options?.label },
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const preferredPath = options?.currentPath ?? currentPath ?? filteredQueue[0];
    const nextIndex = Math.max(filteredQueue.indexOf(preferredPath ?? ''), 0);
    const sameCurrent = preferredPath != null && preferredPath === currentPath;
    const session = normalizeSession({
      queue_paths: filteredQueue,
      base_queue_paths: filteredBase.length > 0 ? filteredBase : filteredQueue,
      current_index: nextIndex,
      position_seconds: sameCurrent ? (options?.positionSeconds ?? clampedPosition) : 0,
      paused: options?.paused ?? !isPlaying,
      repeat_mode: repeatMode,
      shuffle_enabled: shuffleEnabled,
    });

    try {
      await syncSession(session, {
        label: options?.label,
        suppressRecordPath:
          options?.suppressRecordPath ?? (sameCurrent ? preferredPath : null),
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const play = async (track: Track) => {
    await startQueue([track], `Playing ${track.title}`);
  };

  const playQueue = async (
    queue: Track[],
    label?: string,
    options?: {
      baseTracks?: Track[];
      currentPath?: string;
      shuffle?: boolean;
      paused?: boolean;
    },
  ) => {
    await startQueue(queue, label, options);
  };

  const tracksForAlbum = (albumKeyValue: string) =>
    allTracks
      .filter((t) => trackAlbumKey(t) === albumKeyValue)
      .slice()
      .sort(compareAlbumTracks);

  const playAlbum = (albumKeyValue: string) => {
    const tracks = tracksForAlbum(albumKeyValue);
    const actualTracks = shuffleEnabled ? shuffleList(tracks) : tracks;
    void playQueue(actualTracks, `Playing album · ${albumTitleFromKey(albumKeyValue)}`, {
      baseTracks: tracks,
      shuffle: shuffleEnabled,
    });
  };

  const playAlbumFromTrack = (albumKeyValue: string, track: Track) => {
    const tracks = tracksForAlbum(albumKeyValue);
    const startIndex = tracks.findIndex((t) => t.path === track.path);
    const baseTracks = startIndex >= 0 ? tracks.slice(startIndex) : [track];
    const queue = shuffleEnabled
      ? [track, ...shuffleList(baseTracks.filter((item) => item.path !== track.path))]
      : baseTracks;
    void playQueue(queue, `Playing album · ${albumTitleFromKey(albumKeyValue)}`, {
      baseTracks,
      currentPath: track.path,
      shuffle: shuffleEnabled,
    });
  };

  const playArtist = (artistName: string) => {
    const pool = allTracks.filter((t) => t.artist === artistName);
    const shuffled = shuffleList(pool).slice(0, 50);
    const selected = new Set(shuffled.map((track) => track.path));
    void playQueue(shuffled, `Artist mix · ${artistName}`, {
      baseTracks: pool.filter((track) => selected.has(track.path)),
      shuffle: true,
    });
  };

  const togglePlayPause = async () => {
    if (!currentTrack) {
      const first = queueTracks[0] ?? filteredTracks[0];
      if (first) {
        if (queueTracks.length > 0) {
          await syncSession(
            {
              ...playbackSession,
              current_index: Math.max(queueTracks.findIndex((track) => track.path === first.path), 0),
              position_seconds: 0,
              paused: false,
            },
            { label: `Playing ${first.title}` },
          );
        } else {
          await play(first);
        }
      }
      return;
    }
    try {
      if (!isBackendPlaybackLoaded) {
        await syncSession(
          {
            ...playbackSession,
            current_index: currentQueueIndex,
            position_seconds: 0,
            paused: false,
          },
          { label: `Playing ${currentTrack.title}` },
        );
        return;
      }

      if (isPlaying) {
        await pausePlayback();
      } else {
        await resumePlayback();
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const shufflePlay = async () => {
    if (allTracks.length === 0) return;
    const shuffled = shuffleList(allTracks);
    await playQueue(shuffled, `Shuffle play · ${shuffled[0]?.title ?? 'library'}`, {
      baseTracks: allTracks,
      shuffle: true,
    });
  };

  const skip = async (delta: 1 | -1) => {
    if (queueTracks.length === 0) return;
    const activeIndex = currentPath
      ? Math.max(queueTracks.findIndex((track) => track.path === currentPath), currentQueueIndex)
      : currentQueueIndex;
    const lastIndex = queueTracks.length - 1;
    let nextIndex = activeIndex + delta;

    if (delta === -1 && clampedPosition > 3 && currentTrack) {
      void commitSeek(0);
      return;
    }

    if (repeatMode === 'all') {
      if (nextIndex < 0) nextIndex = lastIndex;
      if (nextIndex > lastIndex) nextIndex = 0;
    }

    if (nextIndex < 0 || nextIndex > lastIndex) {
      if (repeatMode === 'one' && currentTrack) {
        await jumpToQueueIndex(activeIndex, `Playing ${currentTrack.title}`);
        await seekPlayback(0);
        setPlaybackPosition(0);
      }
      return;
    }

    const nextTrack = queueTracks[nextIndex];
    if (!nextTrack) return;
    await jumpToQueueIndex(nextIndex, `Playing ${nextTrack.title}`);
  };

  const stop = async () => {
    try {
      await stopPlayback();
      backendPathRef.current = null;
      backendPausedRef.current = true;
      backendIdleRef.current = true;
      setIsBackendPlaybackLoaded(false);
      setIsPlaying(false);
      setCurrentPath(null);
      setPlaybackPosition(0);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const addToQueue = async (track: Track) => {
    if (currentTrack && track.path === currentTrack.path) {
      setStatus('That track is already playing');
      return;
    }

    const nextQueue = queueTracks.map((item) => item.path).filter((path) => path !== track.path);
    const nextBase = baseQueueTracks.map((item) => item.path).filter((path) => path !== track.path);
    nextQueue.push(track.path);
    nextBase.push(track.path);

    if (!currentTrack) {
      await playQueue([track], `Queued ${track.title}`);
      return;
    }

    if (!isBackendPlaybackLoaded) {
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: null });
      setStatus(`Added to queue · ${track.title}`);
      return;
    }

    try {
      const existingIndex = queueTracks.findIndex((item) => item.path === track.path);
      if (existingIndex >= 0) {
        await tauriRemoveQueueIndex(existingIndex);
      }
      await appendQueue([track.path]);
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: currentTrack.path });
      setStatus(`Added to queue · ${track.title}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const playNext = async (track: Track) => {
    if (!currentTrack) {
      await playQueue([track], `Playing ${track.title}`);
      return;
    }

    if (track.path === currentTrack.path) {
      setStatus('That track is already playing');
      return;
    }

    const activePath = currentTrack.path;
    const activeIndex = Math.max(queuePaths.indexOf(activePath), 0);
    const strippedQueue = queueTracks.map((item) => item.path).filter((path) => path !== track.path);
    const strippedBase = baseQueueTracks.map((item) => item.path).filter((path) => path !== track.path);
    strippedQueue.splice(activeIndex + 1, 0, track.path);
    strippedBase.splice(activeIndex + 1, 0, track.path);

    if (!isBackendPlaybackLoaded) {
      applyQueueLocally(strippedQueue, strippedBase, { keepCurrentPath: null });
      setStatus(`Plays next · ${track.title}`);
      return;
    }

    try {
      const existingIndex = queueTracks.findIndex((item) => item.path === track.path);
      if (existingIndex >= 0) {
        await tauriRemoveQueueIndex(existingIndex);
      }
      await insertQueueAt([track.path], activeIndex + 1);
      applyQueueLocally(strippedQueue, strippedBase, { keepCurrentPath: activePath });
      setStatus(`Plays next · ${track.title}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const moveQueueItem = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (index < 0 || target < 0 || index >= queueTracks.length || target >= queueTracks.length) return;
    const nextQueue = queueTracks.map((track) => track.path);
    [nextQueue[index], nextQueue[target]] = [nextQueue[target], nextQueue[index]];
    if (!isBackendPlaybackLoaded) {
      applyQueueLocally(nextQueue, nextQueue, { keepCurrentPath: null });
      setStatus('Queue reordered');
      return;
    }
    try {
      await tauriMoveQueueIndex(index, target);
      applyQueueLocally(nextQueue, nextQueue, { keepCurrentPath: currentPath });
      setStatus('Queue reordered');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const removeQueueItem = async (index: number) => {
    if (index < 0 || index >= queueTracks.length) return;
    const removedPath = queueTracks[index]?.path;
    if (!removedPath) return;
    const nextQueue = queueTracks.map((track) => track.path).filter((path) => path !== removedPath);
    const nextBase = baseQueueTracks.map((track) => track.path).filter((path) => path !== removedPath);

    if (!isBackendPlaybackLoaded) {
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: null });
      setStatus('Removed from queue');
      return;
    }

    try {
      await tauriRemoveQueueIndex(index);
      applyQueueLocally(nextQueue, nextBase, {
        keepCurrentPath: removedPath === currentPath ? null : currentPath,
      });
      if (removedPath === currentPath) {
        setCurrentPath(null);
      }
      setStatus('Removed from queue');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const clearQueue = async () => {
    if (currentTrack) {
      if (!isBackendPlaybackLoaded) {
        applyQueueLocally([currentTrack.path], [currentTrack.path], { keepCurrentPath: null });
        setStatus('Cleared Up Next');
        return;
      }
      try {
        const indicesToRemove = queueTracks
          .map((track, index) => (track.path === currentTrack.path ? -1 : index))
          .filter((index) => index >= 0)
          .sort((a, b) => b - a);
        for (const index of indicesToRemove) {
          await tauriRemoveQueueIndex(index);
        }
        applyQueueLocally([currentTrack.path], [currentTrack.path], { keepCurrentPath: currentTrack.path });
        setStatus('Cleared Up Next');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    await syncUpdatedQueue([], [], { label: 'Queue cleared' });
  };

  const addAlbumToQueue = async (albumKeyValue: string) => {
    const albumTracks = tracksForAlbum(albumKeyValue);
    if (albumTracks.length === 0) return;

    if (!currentTrack) {
      await playQueue(albumTracks, `Playing album · ${albumTitleFromKey(albumKeyValue)}`, {
        baseTracks: albumTracks,
      });
      return;
    }

    const albumPaths = albumTracks
      .map((track) => track.path)
      .filter((path) => path !== currentTrack.path);
    if (albumPaths.length === 0) {
      setStatus('That album is already playing');
      return;
    }
    const nextQueue = queueTracks
      .map((track) => track.path)
      .filter((path) => !albumPaths.includes(path))
      .concat(albumPaths);
    const nextBase = baseQueueTracks
      .map((track) => track.path)
      .filter((path) => !albumPaths.includes(path))
      .concat(albumPaths);

    if (!isBackendPlaybackLoaded) {
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: null });
      setStatus(`Added album to queue · ${albumTitleFromKey(albumKeyValue)}`);
      return;
    }

    try {
      const existingIndices = queueTracks
        .map((track, index) => (albumPaths.includes(track.path) ? index : -1))
        .filter((index) => index >= 0)
        .sort((a, b) => b - a);
      for (const index of existingIndices) {
        await tauriRemoveQueueIndex(index);
      }
      await appendQueue(albumPaths);
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: currentTrack.path });
      setStatus(`Added album to queue · ${albumTitleFromKey(albumKeyValue)}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const playAlbumNext = async (albumKeyValue: string) => {
    const albumTracks = tracksForAlbum(albumKeyValue);
    if (albumTracks.length === 0) return;

    if (!currentTrack) {
      await playQueue(albumTracks, `Playing album · ${albumTitleFromKey(albumKeyValue)}`, {
        baseTracks: albumTracks,
      });
      return;
    }

    const albumPaths = albumTracks
      .map((track) => track.path)
      .filter((path) => path !== currentTrack.path);
    if (albumPaths.length === 0) {
      setStatus('That album is already playing');
      return;
    }
    const activePath = currentTrack.path;
    const activeIndex = Math.max(queuePaths.indexOf(activePath), 0);
    const nextQueue = queueTracks
      .map((track) => track.path)
      .filter((path) => !albumPaths.includes(path));
    const nextBase = baseQueueTracks
      .map((track) => track.path)
      .filter((path) => !albumPaths.includes(path));

    nextQueue.splice(activeIndex + 1, 0, ...albumPaths);
    nextBase.splice(activeIndex + 1, 0, ...albumPaths);

    if (!isBackendPlaybackLoaded) {
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: null });
      setStatus(`Album plays next · ${albumTitleFromKey(albumKeyValue)}`);
      return;
    }

    try {
      const existingIndices = queueTracks
        .map((track, index) => (albumPaths.includes(track.path) ? index : -1))
        .filter((index) => index >= 0)
        .sort((a, b) => b - a);
      for (const index of existingIndices) {
        await tauriRemoveQueueIndex(index);
      }
      await insertQueueAt(albumPaths, activeIndex + 1);
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: activePath });
      setStatus(`Album plays next · ${albumTitleFromKey(albumKeyValue)}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleRepeat = async () => {
    const nextMode: RepeatMode =
      repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    setRepeatMode(nextMode);
    try {
      await tauriSetRepeatMode(nextMode);
      setStatus(
        nextMode === 'off'
          ? 'Repeat off'
          : nextMode === 'all'
            ? 'Repeat all'
            : 'Repeat one',
      );
    } catch (error) {
      setRepeatMode(repeatMode);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleShuffle = async () => {
    const nextShuffle = !shuffleEnabled;
    const activePath = currentTrack?.path ?? queueTracks[currentQueueIndex]?.path ?? null;

    if (queueTracks.length === 0) {
      setShuffleEnabled(nextShuffle);
      return;
    }

    const canonical = baseQueueTracks.map((track) => track.path);
    const nextQueue = nextShuffle
      ? shuffleQueueKeepingCurrent(
          canonical,
          activePath ? Math.max(canonical.indexOf(activePath), 0) : currentQueueIndex,
        )
      : canonical.slice();

    const nextIndex = activePath ? Math.max(nextQueue.indexOf(activePath), 0) : currentQueueIndex;
    const session = normalizeSession({
      queue_paths: nextQueue,
      base_queue_paths: canonical,
      current_index: nextIndex,
      position_seconds: currentTrack ? clampedPosition : 0,
      paused: !isPlaying,
      repeat_mode: repeatMode,
      shuffle_enabled: nextShuffle,
    });

    try {
      await syncSession(session, {
        label: nextShuffle ? 'Shuffle on' : 'Shuffle off',
        suppressRecordPath: activePath,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const updateVolume = async (nextVolume: number) => {
    const clamped = clampVolume(nextVolume);
    const previous = volumeLevel;
    setVolumeLevel(clamped);

    try {
      await setPlaybackVolumeLevel(clamped);
    } catch (error) {
      setVolumeLevel(previous);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleMute = async () => {
    const nextMuted = !isMuted;
    const previous = isMuted;
    setIsMuted(nextMuted);

    try {
      await setPlaybackMuted(nextMuted);
    } catch (error) {
      setIsMuted(previous);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const updateAudioDevice = async (deviceName: string) => {
    const previous = selectedAudioDevice;
    setSelectedAudioDevice(deviceName);
    setIsDeviceMenuOpen(false);

    try {
      await setPlaybackAudioDevice(deviceName);
    } catch (error) {
      setSelectedAudioDevice(previous);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const roundedVolume = Math.round(volumeLevel);
  const volumeLabel = isMuted ? 'Unmute' : 'Mute';
  const repeatLabel =
    repeatMode === 'off' ? 'Repeat off' : repeatMode === 'all' ? 'Repeat all' : 'Repeat one';
  const queueDisplayStartIndex = useMemo(() => {
    if (queueTracks.length === 0) return 0;
    const currentIndexFromPath = currentPath ? queueTracks.findIndex((track) => track.path === currentPath) : -1;
    return clampIndex(currentIndexFromPath >= 0 ? currentIndexFromPath : currentQueueIndex, queueTracks.length);
  }, [currentPath, currentQueueIndex, queueTracks]);
  const visibleQueueTracks = useMemo(
    () => queueTracks.slice(queueDisplayStartIndex),
    [queueDisplayStartIndex, queueTracks],
  );
  const upNextCount = Math.max(visibleQueueTracks.length - 1, 0);
  const volumeIcon =
    isMuted || roundedVolume === 0 ? (
      <VolumeMutedIcon />
    ) : roundedVolume < 45 ? (
      <VolumeLowIcon />
    ) : (
      <VolumeHighIcon />
    );

  if (loading) {
    return <div className="fullscreen-message">Loading…</div>;
  }
  if (!data) {
    return <div className="fullscreen-message">Failed to initialize.</div>;
  }

  const lib = data.library;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-mark"
            src={resolvedTheme === 'dark' ? needleBrandMarkDark : needleBrandMarkLight}
            alt=""
          />
          <div>
            <div className="brand-title">Needle</div>
            <div className="brand-sub">Local-first player</div>
          </div>
        </div>

        <nav className="nav-section">
          <div className="nav-label">Browse</div>
          <button
            className={`nav-item ${view === 'dashboard' ? 'active' : ''}`}
            onClick={() => setView('dashboard')}
          >
            <span className="nav-icon">⌂</span>Dashboard
          </button>
          <button
            className={`nav-item ${view === 'tracks' ? 'active' : ''}`}
            onClick={() => {
              setView('tracks');
              clearBrowsingFilters();
            }}
          >
            <span className="nav-icon">♪</span>Tracks
            <span className="nav-count">{lib.track_count}</span>
          </button>
          <button
            className={`nav-item ${view === 'albums' ? 'active' : ''}`}
            onClick={() => setView('albums')}
          >
            <span className="nav-icon">◉</span>Albums
            <span className="nav-count">{lib.album_count}</span>
          </button>
          <button
            className={`nav-item ${view === 'artists' ? 'active' : ''}`}
            onClick={() => setView('artists')}
          >
            <span className="nav-icon">☻</span>Artists
            <span className="nav-count">{lib.artist_count}</span>
          </button>
        </nav>

        <nav className="nav-section">
          <div className="nav-label">Playlists</div>
          <div className="nav-sub-label">Saved</div>
          {manualPlaylists.length === 0 && <div className="nav-empty">Save a track list to create one</div>}
          {manualPlaylists.map((playlist) => (
            <button
              key={playlist.id}
              className={`nav-item nav-item-compact ${
                selectedPlaylist?.kind === 'manual' && selectedPlaylist.id === playlist.id ? 'active' : ''
              }`}
              onClick={() => {
                setSelectedPlaylist({ kind: 'manual', id: playlist.id });
                setSelectedAlbum(null);
                setSelectedArtist(null);
                setView('tracks');
              }}
            >
              <span className="nav-icon">≣</span>
              <span className="nav-item-copy">{playlist.name}</span>
              <span className="nav-count">{playlist.track_paths.length}</span>
            </button>
          ))}
          <div className="nav-sub-label">Smart</div>
          {smartPlaylists.map((playlist) => (
            <button
              key={playlist.id}
              className={`nav-item nav-item-compact ${
                selectedPlaylist?.kind === 'smart' && selectedPlaylist.id === playlist.id ? 'active' : ''
              }`}
              onClick={() => {
                setSelectedPlaylist({ kind: 'smart', id: playlist.id });
                setSelectedAlbum(null);
                setSelectedArtist(null);
                setView('tracks');
              }}
            >
              <span className="nav-icon">✦</span>
              <span className="nav-item-copy">{playlist.name}</span>
              <span className="nav-count">{playlist.tracks.length}</span>
            </button>
          ))}
        </nav>

        <nav className="nav-section">
          <div className="nav-label">App</div>
          <button
            className={`nav-item ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            <span className="nav-icon">⚙</span>Settings
          </button>
        </nav>

        <div className="sidebar-footer">{status || (busy ?? 'Ready')}</div>
      </aside>

      <main className="content">
        {view === 'dashboard' && (
          <DashboardView
            tracks={allTracks}
            albums={albums}
            recentAlbums={recentAlbums}
            artists={artists}
            playlists={smartPlaylists}
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            featuredSeed={featuredSeed}
            onShuffle={shufflePlay}
            onAddFolder={importFolder}
            onOpenSettings={() => setView('settings')}
            onShuffleFeatured={() => setFeaturedSeed((s) => s + 1)}
            onOpenAlbum={openAlbum}
            onOpenArtist={(artist) => {
              setSelectedArtist(artist);
              setSelectedAlbum(null);
              setSelectedPlaylist(null);
              setView('tracks');
            }}
            onOpenPlaylist={(pl) => {
              setSelectedPlaylist({ kind: 'smart', id: pl.id });
              setSelectedAlbum(null);
              setSelectedArtist(null);
              setView('tracks');
            }}
            onPlayPlaylist={(pl) => {
              if (pl.tracks.length === 0) return;
              const shuffled = shuffleList(pl.tracks);
              void playQueue(shuffled, `Playlist · ${pl.name}`, {
                baseTracks: pl.tracks,
                shuffle: true,
              });
            }}
            onPlayAlbum={playAlbum}
            onPlayNextAlbum={playAlbumNext}
            onAddAlbumToQueue={addAlbumToQueue}
            onPlayArtist={playArtist}
            onPlayQueue={(tracks) =>
              void playQueue(shuffleEnabled ? shuffleList(tracks) : tracks, 'Quick picks', {
                baseTracks: tracks,
                shuffle: shuffleEnabled,
              })}
            onOpenView={(v) => setView(v)}
            onPlay={play}
            busy={!!busy}
          />
        )}

        {view === 'tracks' && (
          <TracksView
            tracks={filteredTracks}
            search={search}
            onSearch={setSearch}
            currentPath={currentPath}
            isPlaying={isPlaying}
            onPlay={play}
            onPlayNext={playNext}
            onAddToQueue={addToQueue}
            queuePaths={queueTracks.map((track) => track.path)}
            playlistMode={selectedManualPlaylist ?? undefined}
            onMovePlaylistTrack={
              selectedManualPlaylist
                ? (fromIndex, toIndex) => void moveManualPlaylistTrack(selectedManualPlaylist.id, fromIndex, toIndex)
                : undefined
            }
            onRemovePlaylistTrack={
              selectedManualPlaylist
                ? (index) => void removeManualPlaylistTrack(selectedManualPlaylist.id, index)
                : undefined
            }
            onRenamePlaylist={
              selectedManualPlaylist ? () => void renameManualPlaylist(selectedManualPlaylist) : undefined
            }
            onDeletePlaylist={
              selectedManualPlaylist ? () => void deleteManualPlaylistById(selectedManualPlaylist) : undefined
            }
            onSaveAsPlaylist={() =>
              void saveVisibleTracksAsPlaylist(
                filteredTracks,
                selectedAlbumSummary?.album ??
                  selectedArtist ??
                  selectedPlaylistData?.name ??
                  `Playlist ${new Date().toLocaleDateString()}`,
              )
            }
            title={
              selectedPlaylistData
                ? selectedPlaylistData.name
                : (selectedAlbumSummary?.album ?? selectedArtist ?? 'All tracks')
            }
            subtitle={
              selectedPlaylistData
                ? selectedPlaylistData.description
                : selectedAlbum
                  ? (selectedAlbumSummary?.artist ? `Album · ${selectedAlbumSummary.artist}` : 'Album')
                  : selectedArtist
                    ? 'Artist'
                    : `${lib.track_count} tracks in your library`
            }
            onClearFilter={
              selectedAlbum || selectedArtist || selectedPlaylistData
                ? () => clearBrowsingFilters()
                : undefined
            }
          />
        )}

        {view === 'albums' && (
          <AlbumsView
            albums={albums}
            onSelect={openAlbum}
            onPlayNextAlbum={playAlbumNext}
            onAddAlbumToQueue={addAlbumToQueue}
          />
        )}

        {view === 'album' && selectedAlbum && selectedAlbumSummary && (
          <AlbumDetailView
            album={selectedAlbumSummary.album}
            albumKey={selectedAlbum}
            albumArtist={selectedAlbumSummary.artist}
            tracks={allTracks}
            currentPath={currentPath}
            isPlaying={isPlaying}
            isCurrentAlbumCurrent={currentAlbumKey === selectedAlbum}
            queuePaths={queueTracks.map((track) => track.path)}
            onBack={() => {
              setSelectedAlbum(null);
              setView(albumReturnView.current);
            }}
            onPlayTrack={(track) => playAlbumFromTrack(selectedAlbum, track)}
            onPlayNext={playNext}
            onAddToQueue={addToQueue}
            onPlayAlbumNext={() => playAlbumNext(selectedAlbum)}
            onAddAlbumToQueue={() => addAlbumToQueue(selectedAlbum)}
            onSaveAsPlaylist={() =>
              void saveVisibleTracksAsPlaylist(
                tracksForAlbum(selectedAlbum),
                selectedAlbumSummary.album,
              )
            }
            onPlayAlbum={() => {
      if (currentAlbumKey === selectedAlbum) {
                void togglePlayPause();
                return;
              }
              void playAlbum(selectedAlbum);
            }}
            onShuffleAlbum={() => {
              const list = tracksForAlbum(selectedAlbum);
              const shuffled = shuffleList(list);
              void playQueue(shuffled, `Shuffling · ${selectedAlbumSummary.album}`, {
                baseTracks: list,
                shuffle: true,
              });
            }}
            onOpenArtist={(artist) => {
              setSelectedArtist(artist);
              setSelectedAlbum(null);
              setView('tracks');
            }}
          />
        )}

        {view === 'artists' && (
          <ArtistsView
            artists={artists}
            onSelect={(artist) => {
              setSelectedArtist(artist);
              setSelectedAlbum(null);
              setView('tracks');
            }}
          />
        )}

        {view === 'settings' && (
          <SettingsView
            settings={data.settings}
            onChange={updateSettings}
            onAddFolder={importFolder}
            onMaintenance={maintenance}
            onRemoveRoot={removeRoot}
            busy={!!busy}
          />
        )}
      </main>

      {isQueueOpen && (
        <QueueDrawer
          drawerRef={queueDrawerRef}
          tracks={visibleQueueTracks}
          currentIndex={0}
          currentPath={currentPath}
          isPlaying={isPlaying}
          onClose={() => setIsQueueOpen(false)}
          onPlayTrack={(track) => {
            const index = queueTracks.findIndex((item) => item.path === track.path);
            if (index >= 0) {
              void jumpToQueueIndex(index, `Playing ${track.title}`);
            }
          }}
          onMoveTrack={(index, delta) => moveQueueItem(queueDisplayStartIndex + index, delta)}
          onRemoveTrack={(index) => removeQueueItem(queueDisplayStartIndex + index)}
          onClearQueue={() => void clearQueue()}
        />
      )}

      <footer className="player-bar">
        {currentAlbum ? (
          <button
            className="player-now player-now-button"
            onClick={() => {
              if (currentAlbumKey) openAlbum(currentAlbumKey);
            }}
            title={`Open album · ${currentAlbum}`}
          >
            <Cover
              trackPath={currentTrack?.path ?? null}
              fallback={currentTrack?.title?.[0]?.toUpperCase() ?? '♪'}
              size="md"
            />
            <div className="player-meta">
              <div className="player-title">{currentTrack?.title ?? 'Nothing playing'}</div>
              <div className="player-sub">
                {currentTrack
                  ? `${currentTrack.artist ?? 'Unknown artist'} — ${currentTrack.album ?? 'Unknown album'}`
                  : 'Pick a track from your library'}
              </div>
            </div>
          </button>
        ) : (
          <div className="player-now">
            <Cover
              trackPath={currentTrack?.path ?? null}
              fallback={currentTrack?.title?.[0]?.toUpperCase() ?? '♪'}
              size="md"
            />
            <div className="player-meta">
              <div className="player-title">{currentTrack?.title ?? 'Nothing playing'}</div>
              <div className="player-sub">
                {currentTrack
                  ? `${currentTrack.artist ?? 'Unknown artist'} — ${currentTrack.album ?? 'Unknown album'}`
                  : 'Pick a track from your library'}
              </div>
            </div>
          </div>
        )}

        <div className="player-progress-wrap">
          <div className="player-progress">
            <span className="player-time">{currentTrack ? formatDuration(clampedPosition) : '—'}</span>
            <input
              className="player-progress-input"
              type="range"
              min={0}
              max={progressMax}
              step={0.1}
              value={currentTrack ? clampedPosition : 0}
              disabled={!currentTrack || effectiveDuration <= 0}
              onChange={(event) => updateScrubPosition(Number(event.currentTarget.value))}
              onMouseUp={() => void commitSeek(scrubPositionRef.current)}
              onTouchEnd={() => void commitSeek(scrubPositionRef.current)}
              onKeyUp={(event) => {
                if (
                  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(
                    event.key,
                  )
                ) {
                  void commitSeek(scrubPositionRef.current);
                }
              }}
              onBlur={() => void commitSeek(scrubPositionRef.current)}
              style={progressStyle}
            />
            <span className="player-time">
              {currentTrack && remainingSeconds != null ? `-${formatDuration(remainingSeconds)}` : '—'}
            </span>
          </div>
        </div>

        <div className="player-controls">
          <button
            className={`ctrl ctrl-toggle ${shuffleEnabled ? 'is-active' : ''}`}
            onClick={() => void toggleShuffle()}
            disabled={queueTracks.length === 0}
            title={shuffleEnabled ? 'Turn shuffle off' : 'Turn shuffle on'}
            aria-label={shuffleEnabled ? 'Turn shuffle off' : 'Turn shuffle on'}
          >
            <ShuffleIcon />
          </button>
          <button className="ctrl" onClick={() => skip(-1)} disabled={!currentTrack} title="Previous" aria-label="Previous">
            <PreviousIcon />
          </button>
          <button
            className="ctrl ctrl-primary"
            onClick={togglePlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="ctrl" onClick={() => skip(1)} disabled={!currentTrack} title="Next" aria-label="Next">
            <NextIcon />
          </button>
          <button className="ctrl" onClick={stop} disabled={!currentTrack} title="Stop" aria-label="Stop">
            <StopIcon />
          </button>
          <button
            className={`ctrl ctrl-toggle ${repeatMode !== 'off' ? 'is-active' : ''}`}
            onClick={() => void toggleRepeat()}
            title={repeatLabel}
            aria-label={repeatLabel}
          >
            <RepeatIcon mode={repeatMode} />
          </button>
        </div>

        <div className="player-extra">
          <button
            className={`ctrl ctrl-queue ${isQueueOpen ? 'is-open' : ''}`}
            onClick={() => setIsQueueOpen((open) => !open)}
            title={visibleQueueTracks.length === 0 ? 'Queue is empty' : `Up Next · ${upNextCount} upcoming`}
            aria-label={visibleQueueTracks.length === 0 ? 'Queue is empty' : `Up Next · ${upNextCount} upcoming`}
          >
            <QueueIcon />
            {visibleQueueTracks.length > 0 && <span className="ctrl-badge">{upNextCount}</span>}
          </button>

          <div className="volume-controls">
            <button
              className={`ctrl ctrl-volume ${isMuted ? 'is-muted' : ''}`}
              onClick={toggleMute}
              title={volumeLabel}
              aria-label={volumeLabel}
            >
              {volumeIcon}
            </button>
            <input
              className="volume-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={roundedVolume}
              onChange={(event) => void updateVolume(Number(event.currentTarget.value))}
              aria-label="Volume"
              style={{ ['--volume-percent' as string]: roundedVolume }}
            />
            <span className="volume-value">{roundedVolume}%</span>
          </div>

          <div className="device-menu" ref={deviceMenuRef}>
            <button
              className={`ctrl ctrl-device ${isDeviceMenuOpen ? 'is-open' : ''}`}
              onClick={() => setIsDeviceMenuOpen((open) => !open)}
              title={`Output device · ${activeOutputDevice.description}`}
              aria-label={`Output device · ${activeOutputDevice.description}`}
              aria-haspopup="menu"
              aria-expanded={isDeviceMenuOpen}
            >
              <OutputDeviceIcon />
            </button>

            {isDeviceMenuOpen && (
              <div className="device-menu-panel" role="menu" aria-label="Output devices">
                <div className="device-menu-title">Output device</div>
                {outputDevices.map((device) => (
                  <button
                    key={device.name}
                    className={`device-option ${device.name === activeOutputDevice.name ? 'is-active' : ''}`}
                    onClick={() => void updateAudioDevice(device.name)}
                    role="menuitemradio"
                    aria-checked={device.name === activeOutputDevice.name}
                  >
                    <span className="device-option-name">{device.description}</span>
                    {device.name === activeOutputDevice.name && <span className="device-option-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

interface QueueDrawerProps {
  drawerRef: RefObject<HTMLElement>;
  tracks: Track[];
  currentIndex: number;
  currentPath: string | null;
  isPlaying: boolean;
  onClose: () => void;
  onPlayTrack: (track: Track) => void;
  onMoveTrack: (index: number, delta: -1 | 1) => void;
  onRemoveTrack: (index: number) => void;
  onClearQueue: () => void;
}

function QueueDrawer({
  drawerRef,
  tracks,
  currentIndex,
  currentPath,
  isPlaying,
  onClose,
  onPlayTrack,
  onMoveTrack,
  onRemoveTrack,
  onClearQueue,
}: QueueDrawerProps) {
  const upcoming = Math.max(tracks.length - currentIndex - 1, 0);

  return (
    <aside className="queue-drawer" ref={drawerRef}>
      <div className="queue-drawer-head">
        <div>
          <div className="queue-drawer-eyebrow">Playback</div>
          <h2 className="queue-drawer-title">Up Next</h2>
          <p className="queue-drawer-copy">
            {tracks.length === 0
              ? 'Nothing queued yet.'
              : `${tracks.length} track${tracks.length === 1 ? '' : 's'} in line · ${upcoming} still to go`}
          </p>
        </div>
        <div className="queue-drawer-actions">
          <button className="ghost-button" onClick={onClearQueue} disabled={tracks.length === 0}>
            Clear
          </button>
          <button className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="queue-empty">Start a track, album, artist mix, or playlist to build a queue.</div>
      ) : (
        <div className="queue-list">
          {tracks.map((track, index) => {
            const isCurrent = currentPath ? track.path === currentPath : index === currentIndex;

            return (
              <div key={track.path} className={`queue-row ${isCurrent ? 'is-current' : ''}`}>
                <button className="queue-row-main" onClick={() => onPlayTrack(track)}>
                  <span className="queue-row-index">
                    {isCurrent ? (isPlaying ? <PlayingIndicator /> : 'Now') : index + 1}
                  </span>
                  <Cover
                    trackPath={track.path}
                    fallback={track.title[0]?.toUpperCase() ?? '♪'}
                    size="queue"
                  />
                  <span className="queue-row-copy">
                    <span className="queue-row-title">{track.title}</span>
                    <span className="queue-row-sub">
                      {(track.artist ?? 'Unknown artist') + ' — ' + (track.album ?? 'Unknown album')}
                    </span>
                  </span>
                  <span className="queue-row-time">{formatDuration(track.duration_seconds)}</span>
                </button>
                <span className="queue-row-actions">
                  <button
                    className="row-icon-button"
                    onClick={() => onMoveTrack(index, -1)}
                    disabled={index === 0}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    className="row-icon-button"
                    onClick={() => onMoveTrack(index, 1)}
                    disabled={index === tracks.length - 1}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button className="row-icon-button is-danger" onClick={() => onRemoveTrack(index)} title="Remove">
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

interface TracksViewProps {
  tracks: Track[];
  search: string;
  onSearch: (value: string) => void;
  currentPath: string | null;
  isPlaying: boolean;
  onPlay: (track: Track) => void;
  onPlayNext: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  queuePaths: string[];
  playlistMode?: SavedPlaylist;
  onMovePlaylistTrack?: (fromIndex: number, toIndex: number) => void;
  onRemovePlaylistTrack?: (index: number) => void;
  onRenamePlaylist?: () => void;
  onDeletePlaylist?: () => void;
  onSaveAsPlaylist?: () => void;
  title: string;
  subtitle: string;
  onClearFilter?: () => void;
}

function TracksView({
  tracks,
  search,
  onSearch,
  currentPath,
  isPlaying,
  onPlay,
  onPlayNext,
  onAddToQueue,
  queuePaths,
  playlistMode,
  onMovePlaylistTrack,
  onRemovePlaylistTrack,
  onRenamePlaylist,
  onDeletePlaylist,
  onSaveAsPlaylist,
  title,
  subtitle,
  onClearFilter,
}: TracksViewProps) {
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-eyebrow">{subtitle}</div>
          <h1 className="view-title">{title}</h1>
        </div>
        <div className="view-actions">
          {onClearFilter && (
            <button className="ghost-button" onClick={onClearFilter}>
              ← All tracks
            </button>
          )}
          {onSaveAsPlaylist && !playlistMode && (
            <button className="ghost-button" onClick={onSaveAsPlaylist} disabled={tracks.length === 0}>
              + Save as playlist
            </button>
          )}
          {playlistMode && onRenamePlaylist && (
            <button className="ghost-button" onClick={onRenamePlaylist}>
              Rename
            </button>
          )}
          {playlistMode && onDeletePlaylist && (
            <button className="ghost-button" onClick={onDeletePlaylist}>
              Delete
            </button>
          )}
          <input
            className="search"
            placeholder="Search title, artist, album…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
      </header>

      {tracks.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">♪</div>
          <h2>No tracks yet</h2>
          <p>Add a folder from the sidebar to import FLAC, ALAC, WAV, MP3, OGG, M4A, and more.</p>
        </div>
      ) : (
        <div className="track-list">
          <div className="track-list-head">
            <span>#</span>
            <span>Title</span>
            <span>Artist</span>
            <span>Album</span>
            <span className="num">Time</span>
            <span>Quality</span>
            <span className="track-actions-head">Queue</span>
          </div>
          {tracks.map((track, index) => {
            const isCurrent = track.path === currentPath;
            const isQueued = queuePaths.includes(track.path);
            return (
              <button
                key={track.id}
                className={`track-row ${isCurrent ? 'is-current' : ''}`}
                onDoubleClick={() => onPlay(track)}
                onClick={() => onPlay(track)}
              >
                <span className="track-index">
                  {isCurrent ? <PlayingIndicator /> : index + 1}
                </span>
                <span className="track-title">{track.title}</span>
                <span className="track-cell">{track.artist ?? '—'}</span>
                <span className="track-cell">{track.album ?? '—'}</span>
                <span className="track-cell num">{formatDuration(track.duration_seconds)}</span>
                <span className="track-cell muted">{formatQuality(track)}</span>
                <span className="track-row-actions">
                  {playlistMode ? (
                    <>
                      <button
                        className="row-icon-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onMovePlaylistTrack?.(index, Math.max(index - 1, 0));
                        }}
                        disabled={index === 0}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        className="row-icon-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onMovePlaylistTrack?.(index, Math.min(index + 1, tracks.length - 1));
                        }}
                        disabled={index === tracks.length - 1}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        className="row-icon-button is-danger"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemovePlaylistTrack?.(index);
                        }}
                        title="Remove"
                      >
                        ×
                      </button>
                    </>
                  ) : (
                    <>
                      {isQueued && <span className="queue-pill">Queued</span>}
                      <button
                        className="row-action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onPlayNext(track);
                        }}
                      >
                        Play next
                      </button>
                      <button
                        className="row-action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onAddToQueue(track);
                        }}
                      >
                        Add
                      </button>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface AlbumDetailViewProps {
  album: string;
  albumKey: string;
  albumArtist: string | null;
  tracks: Track[];
  currentPath: string | null;
  isPlaying: boolean;
  isCurrentAlbumCurrent: boolean;
  queuePaths: string[];
  onBack: () => void;
  onPlayTrack: (track: Track) => void;
  onPlayNext: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onPlayAlbumNext: () => void;
  onAddAlbumToQueue: () => void;
  onSaveAsPlaylist: () => void;
  onPlayAlbum: () => void;
  onShuffleAlbum: () => void;
  onOpenArtist: (artist: string) => void;
}

function AlbumDetailView({
  album,
  albumKey,
  albumArtist,
  tracks,
  currentPath,
  isPlaying,
  isCurrentAlbumCurrent,
  queuePaths,
  onBack,
  onPlayTrack,
  onPlayNext,
  onAddToQueue,
  onPlayAlbumNext,
  onAddAlbumToQueue,
  onSaveAsPlaylist,
  onPlayAlbum,
  onShuffleAlbum,
  onOpenArtist,
}: AlbumDetailViewProps) {
  const albumTracks = useMemo(
    () =>
      tracks
        .filter((t) => trackAlbumKey(t) === albumKey)
        .slice()
        .sort(compareAlbumTracks),
    [tracks, albumKey],
  );
  const discGroups = useMemo(() => {
    const groups = new Map<number, Track[]>();
    for (const track of albumTracks) {
      const disc = track.disc_number ?? 1;
      const existing = groups.get(disc);
      if (existing) {
        existing.push(track);
      } else {
        groups.set(disc, [track]);
      }
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([disc, tracks]) => ({ disc, tracks }));
  }, [albumTracks]);
  const hasMultipleDiscs = discGroups.length > 1;

  const primaryArtist = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of albumTracks) {
      if (!t.artist) continue;
      counts.set(t.artist, (counts.get(t.artist) ?? 0) + 1);
    }
    if (albumArtist) return albumArtist;
    if (counts.size === 0) return null;
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }, [albumArtist, albumTracks]);

  const variousArtists = useMemo(() => {
    const distinct = new Set(albumTracks.map((t) => t.artist).filter(Boolean));
    return distinct.size > 1;
  }, [albumTracks]);

  const totalSeconds = useMemo(
    () => albumTracks.reduce((sum, t) => sum + (t.duration_seconds ?? 0), 0),
    [albumTracks],
  );

  const year = useMemo(
    () => albumTracks.find((t) => t.year)?.year ?? null,
    [albumTracks],
  );

  const genres = useMemo(() => {
    const set = new Set<string>();
    for (const t of albumTracks) {
      if (!t.genre) continue;
      for (const part of t.genre.split(/[;,/]/)) {
        const trimmed = part.trim();
        if (trimmed) set.add(trimmed);
      }
    }
    return Array.from(set).slice(0, 5);
  }, [albumTracks]);

  const qualityHint = useMemo(() => {
    if (albumTracks.length === 0) return null;
    const formats = new Map<string, number>();
    let maxRate = 0;
    let maxBits = 0;
    for (const t of albumTracks) {
      if (t.format) formats.set(t.format, (formats.get(t.format) ?? 0) + 1);
      if (t.sample_rate && t.sample_rate > maxRate) maxRate = t.sample_rate;
      if (t.bit_depth && t.bit_depth > maxBits) maxBits = t.bit_depth;
    }
    const topFormat =
      Array.from(formats.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const parts: string[] = [];
    if (topFormat) parts.push(topFormat);
    if (maxRate) parts.push(`${(maxRate / 1000).toFixed(1)} kHz`);
    if (maxBits) parts.push(`${maxBits}-bit`);
    return parts.length ? parts.join(' · ') : null;
  }, [albumTracks]);

  const samplePath = albumTracks[0]?.path ?? null;
  const { info, loading: infoLoading } = useAlbumInfo(album, primaryArtist);

  const formatTotalDuration = (seconds: number): string => {
    if (seconds <= 0) return '—';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins} min`;
  };

  return (
    <div className="view album-detail">
      <button className="back-button" onClick={onBack}>
        ← Back
      </button>

      <header className="album-hero">
        <Cover
          trackPath={samplePath}
          fallback={album[0]?.toUpperCase() ?? '◉'}
          size="hero"
        />
        <div className="album-hero-meta">
          <div className="album-hero-eyebrow">Album</div>
          <h1 className="album-hero-title">{album}</h1>
          {primaryArtist && (
            <button
              className="album-hero-artist"
              onClick={() => onOpenArtist(primaryArtist)}
            >
              {variousArtists ? `${primaryArtist} & others` : primaryArtist}
            </button>
          )}
          <div className="album-hero-line">
            {[
              year,
              `${albumTracks.length} track${albumTracks.length === 1 ? '' : 's'}`,
              formatTotalDuration(totalSeconds),
              qualityHint,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {genres.length > 0 && (
            <div className="album-hero-genres">
              {genres.map((g) => (
                <span key={g} className="album-genre-pill">
                  {g}
                </span>
              ))}
            </div>
          )}
          <div className="album-hero-actions">
            <button className="primary-button" onClick={onPlayAlbum}>
              {isCurrentAlbumCurrent ? (isPlaying ? '⏸ Pause' : '▶ Resume') : '▶ Play'}
            </button>
            <button className="ghost-button" onClick={onPlayAlbumNext}>
              ≫ Play next
            </button>
            <button className="ghost-button" onClick={onAddAlbumToQueue}>
              + Add to queue
            </button>
            <button className="ghost-button" onClick={onSaveAsPlaylist}>
              + Save as playlist
            </button>
            <button className="ghost-button" onClick={onShuffleAlbum}>
              ⤮ Shuffle
            </button>
          </div>
        </div>
      </header>

      <section className="album-about">
        <h2 className="section-title">About this album</h2>
        {info?.description ? (
          <p className="album-about-text">
            {info.description}
            {info.source_url && (
              <a
                className="album-about-link"
                href={info.source_url}
                target="_blank"
                rel="noreferrer"
              >
                Read more on Wikipedia →
              </a>
            )}
          </p>
        ) : infoLoading ? (
          <p className="muted">Looking up album info…</p>
        ) : (
          <p className="muted">
            No background info found for this album. (We pull these from
            Wikipedia via MusicBrainz — very obscure releases or non-album
            collections may not have anything.)
          </p>
        )}
      </section>

      <section className="album-tracks">
        <h2 className="section-title">Tracks</h2>
        <div className="album-track-groups">
          {discGroups.map(({ disc, tracks }) => (
            <section key={disc} className="album-disc-group">
              {hasMultipleDiscs && <div className="album-disc-heading">{`Disc ${disc}`}</div>}
              <div className="album-track-list">
                {tracks.map((t) => {
                  const isCurrent = currentPath === t.path;
                  const isQueued = queuePaths.includes(t.path);
                  return (
                    <button
                      key={t.id}
                      className={`album-track-row ${isCurrent ? 'playing' : ''}`}
                      onClick={() => onPlayTrack(t)}
                    >
                      <span className="album-track-num">
                        {isCurrent ? <PlayingIndicator /> : (t.track_number ?? '—')}
                      </span>
                      <span className="album-track-title">{t.title}</span>
                      <span className="album-track-meta muted">
                        {formatQuality(t)}
                      </span>
                      <span className="album-track-duration">
                        {formatDuration(t.duration_seconds)}
                      </span>
                      <span className="album-track-actions">
                        {isQueued && <span className="queue-pill">Queued</span>}
                        <button
                          className="row-action-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onPlayNext(t);
                          }}
                        >
                          Next
                        </button>
                        <button
                          className="row-action-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onAddToQueue(t);
                          }}
                        >
                          Add
                        </button>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

interface AlbumsViewProps {
  albums: AlbumSummary[];
  onSelect: (albumKey: string) => void;
  onPlayNextAlbum: (albumKey: string) => void;
  onAddAlbumToQueue: (albumKey: string) => void;
}

function AlbumsView({ albums, onSelect, onPlayNextAlbum, onAddAlbumToQueue }: AlbumsViewProps) {
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-eyebrow">Library</div>
          <h1 className="view-title">Albums</h1>
        </div>
      </header>
      {albums.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">◉</div>
          <h2>No albums</h2>
        </div>
      ) : (
        <div className="card-grid">
          {albums.map((a) => (
            <div key={a.key} className="card-wrap">
              <button className="card" onClick={() => onSelect(a.key)}>
                <Cover
                  trackPath={a.samplePath}
                  fallback={a.album[0]?.toUpperCase() ?? '◉'}
                  size="card"
                />
                <div className="card-title">{a.album}</div>
                <div className="card-sub">{a.artist ?? 'Various artists'}</div>
                <div className="card-meta">{a.count} tracks</div>
              </button>
              <div className="card-actions">
                <button
                  className="card-mini-action"
                  onClick={() => onPlayNextAlbum(a.key)}
                  title={`Play ${a.album} next`}
                >
                  Next
                </button>
                <button
                  className="card-mini-action"
                  onClick={() => onAddAlbumToQueue(a.key)}
                  title={`Add ${a.album} to queue`}
                >
                  + Queue
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface CoverProps {
  trackPath: string | null;
  fallback: string;
  size: 'md' | 'card' | 'hero' | 'queue';
}

function Cover({ trackPath, fallback, size }: CoverProps) {
  const url = useCoverArt(trackPath);
  const className =
    size === 'hero'
      ? 'cover-hero'
      : size === 'card'
        ? 'card-art'
        : size === 'queue'
          ? 'cover cover-queue'
          : 'cover';

  if (url) {
    return (
      <div className={className}>
        <img src={url} alt="" className="cover-img" />
      </div>
    );
  }

  return <div className={className}>{fallback}</div>;
}

interface ArtistAvatarProps {
  name: string;
  size: 'sm' | 'lg';
}

function ArtistAvatar({ name, size }: ArtistAvatarProps) {
  const url = useArtistImage(name);
  const className = size === 'lg' ? 'avatar avatar-lg' : 'avatar';
  const initial = name[0]?.toUpperCase() ?? '?';

  if (url) {
    return (
      <div className={className}>
        <img
          src={url}
          alt=""
          className="avatar-img"
          referrerPolicy="no-referrer"
          onError={(event) => {
            (event.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      </div>
    );
  }

  return <div className={className}>{initial}</div>;
}

interface ArtistsViewProps {
  artists: Array<{ artist: string; count: number }>;
  onSelect: (artist: string) => void;
}

function ArtistsView({ artists, onSelect }: ArtistsViewProps) {
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-eyebrow">Library</div>
          <h1 className="view-title">Artists</h1>
        </div>
      </header>
      {artists.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">☻</div>
          <h2>No artists</h2>
        </div>
      ) : (
        <div className="list">
          {artists.map((a) => (
            <button key={a.artist} className="list-row" onClick={() => onSelect(a.artist)}>
              <ArtistAvatar name={a.artist} size="sm" />
              <div className="list-main">
                <div className="list-title">{a.artist}</div>
                <div className="list-sub">{a.count} tracks</div>
              </div>
              <span className="chev">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface SettingsViewProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onAddFolder: () => void;
  onMaintenance: () => void;
  onRemoveRoot: (folder: string) => void;
  busy: boolean;
}

function SettingsView({ settings, onChange, onAddFolder, onMaintenance, onRemoveRoot, busy }: SettingsViewProps) {
  const isManualEqualizer = settings.equalizer_preset === 'manual';
  const [manualBandsDraft, setManualBandsDraft] = useState(() =>
    normalizeEqualizerBands(settings.equalizer_bands),
  );

  useEffect(() => {
    setManualBandsDraft(normalizeEqualizerBands(settings.equalizer_bands));
  }, [settings.equalizer_bands, settings.equalizer_preset]);

  const equalizerBands = isManualEqualizer ? manualBandsDraft : displayedEqualizerBands(settings);

  const applyEqualizerPreset = (preset: EqualizerPreset) => {
    if (preset === 'manual') {
      onChange({
        ...settings,
        equalizer_preset: 'manual',
      });
      return;
    }

    onChange({
      ...settings,
      equalizer_preset: preset,
    });
  };

  const updateManualBandDraft = (index: number, value: number) => {
    if (!isManualEqualizer) return;
    const nextBands = normalizeEqualizerBands(manualBandsDraft);
    nextBands[index] = clampEqualizerGain(value);
    setManualBandsDraft(nextBands);
  };

  const commitManualBands = () => {
    if (!isManualEqualizer) return;
    const nextBands = normalizeEqualizerBands(manualBandsDraft);
    const currentBands = normalizeEqualizerBands(settings.equalizer_bands);
    const changed = nextBands.some((value, index) => value !== currentBands[index]);
    if (!changed) return;
    onChange({
      ...settings,
      equalizer_preset: 'manual',
      equalizer_bands: nextBands,
    });
  };

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-eyebrow">App</div>
          <h1 className="view-title">Settings</h1>
        </div>
      </header>

      <div className="settings">
        <section className="settings-section">
          <div className="settings-section-head">
            <h2>Appearance</h2>
            <p>Choose how Needle should look while you browse and listen.</p>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-label">Theme</label>
              <p className="settings-hint">Match the system or lock the app to light or dark mode.</p>
            </div>
            <div className="settings-row-control">
              <div className="seg">
                {themeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    className={`seg-btn ${settings.theme === opt.value ? 'on' : ''}`}
                    onClick={() => onChange({ ...settings, theme: opt.value })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h2>Equalizer</h2>
            <p>Shape playback with quick presets that apply immediately through mpv.</p>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-label">Preset</label>
              <p className="settings-hint">Choose a curve for the current session and future playback.</p>
            </div>
            <div className="settings-row-control">
              <div className="seg">
                {equalizerOptions.map((opt) => (
                  <button
                    key={opt.value}
                    className={`seg-btn ${settings.equalizer_preset === opt.value ? 'on' : ''}`}
                    onClick={() => applyEqualizerPreset(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="settings-row settings-row-block">
            <div className="settings-row-copy">
              <label className="settings-label">10-Band Curve</label>
              <p className="settings-hint">
                {isManualEqualizer
                  ? 'Manual mode is live. Drag the bands to sculpt the current EQ curve.'
                  : 'This graph reflects the selected preset. Switch to Manual to unlock the sliders and tweak from this shape.'}
              </p>
            </div>
            <div className="equalizer-graph" role="img" aria-label="10 band equalizer curve">
              {equalizerBandLabels.map((label, index) => {
                const gain = clampEqualizerGain(equalizerBands[index] ?? 0);
                const bandStyle = {
                  '--band-height': `${(Math.abs(gain) / maxEqualizerGain) * 50}%`,
                } as CSSProperties;

                return (
                  <div
                    key={label}
                    className={`equalizer-band ${gain >= 0 ? 'positive' : 'negative'}`}
                    style={bandStyle}
                  >
                    <div className="equalizer-band-value">
                      {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
                    </div>
                    <div className="equalizer-band-track">
                      <div className="equalizer-band-fill" />
                      <input
                        className="equalizer-band-slider"
                        type="range"
                        min={-maxEqualizerGain}
                        max={maxEqualizerGain}
                        step={0.1}
                        value={gain}
                        disabled={!isManualEqualizer}
                        aria-label={`${label} hertz`}
                        onChange={(event) => updateManualBandDraft(index, Number(event.currentTarget.value))}
                        onPointerUp={commitManualBands}
                        onKeyUp={(event) => {
                          if (
                            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(
                              event.key,
                            )
                          ) {
                            commitManualBands();
                          }
                        }}
                        onBlur={commitManualBands}
                      />
                    </div>
                    <div className="equalizer-band-label">{label}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h2>Library</h2>
            <p>Keep your library database in sync without touching the underlying audio files.</p>
          </div>
          <div className="settings-row settings-row-block">
            <div className="settings-row-copy">
              <label className="settings-label">Folders</label>
              <p className="settings-hint">Manage the local folders Needle scans into your library.</p>
            </div>
            <div className="settings-library-roots">
              {settings.library_roots.length === 0 ? (
                <div className="settings-library-empty">No folders added yet.</div>
              ) : (
                settings.library_roots.map((root) => (
                  <div key={root} className="settings-library-root" title={root}>
                    <span className="settings-library-root-name">{root}</span>
                    <button className="ghost-button" onClick={() => onRemoveRoot(root)}>
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="settings-row-control">
              <button className="primary" onClick={onAddFolder} disabled={busy}>
                + Add folder
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-label">Maintenance</label>
              <p className="settings-hint">
                Rescans watched folders for changes and removes dotfile entries from the library only.
              </p>
            </div>
            <div className="settings-row-control">
              <button className="primary" onClick={onMaintenance} disabled={busy}>
                ↻ Run maintenance
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h2>Playback</h2>
            <p>Needle plays through mpv for local, bit-perfect playback.</p>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-label">Backend</label>
              <p className="settings-hint">
                On macOS install it with <code>brew install mpv</code> if it is not already available.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

interface DashboardViewProps {
  tracks: Track[];
  albums: AlbumSummary[];
  recentAlbums: AlbumSummary[];
  artists: Array<{ artist: string; count: number }>;
  playlists: AutoPlaylist[];
  currentTrack: Track | null;
  isPlaying: boolean;
  featuredSeed: number;
  onShuffle: () => void;
  onAddFolder: () => void;
  onOpenSettings: () => void;
  onShuffleFeatured: () => void;
  onOpenAlbum: (albumKey: string) => void;
  onOpenArtist: (artist: string) => void;
  onOpenPlaylist: (playlist: AutoPlaylist) => void;
  onPlayPlaylist: (playlist: AutoPlaylist) => void;
  onPlayAlbum: (albumKey: string) => void;
  onPlayNextAlbum: (albumKey: string) => void;
  onAddAlbumToQueue: (albumKey: string) => void;
  onPlayArtist: (artist: string) => void;
  onPlayQueue: (tracks: Track[]) => void;
  onOpenView: (view: View) => void;
  onPlay: (track: Track) => void;
  busy: boolean;
}

function DashboardView({
  tracks,
  albums,
  recentAlbums,
  artists,
  playlists,
  currentTrack,
  isPlaying,
  featuredSeed,
  onShuffle,
  onAddFolder,
  onOpenSettings,
  onShuffleFeatured,
  onOpenAlbum,
  onOpenArtist,
  onOpenPlaylist,
  onPlayPlaylist,
  onPlayAlbum,
  onPlayNextAlbum,
  onAddAlbumToQueue,
  onPlayArtist,
  onPlayQueue,
  onOpenView,
  onPlay,
  busy,
}: DashboardViewProps) {
  const currentArtwork = useCoverArt(currentTrack?.path);
  const dashboardBackdrop = currentArtwork ?? dashboardIdleBackdrop;
  const featured = useMemo(
    () => sampleN(albums, 6),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [albums, featuredSeed],
  );

  const quickPicks = useMemo(
    () => sampleN(tracks, 10),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, featuredSeed],
  );

  const topArtists = useMemo(
    () => artists.slice().sort((a, b) => b.count - a.count).slice(0, 6),
    [artists],
  );
  const heroBackdropStyle = { backgroundImage: `url(${dashboardBackdrop})` };
  const recordLabelStyle = currentArtwork ? ({ backgroundImage: `url(${currentArtwork})` } as CSSProperties) : undefined;

  const isEmpty = tracks.length === 0;

  if (isEmpty) {
    return (
      <div className="view dashboard">
        <header className="dashboard-hero">
          <div>
            <div className="view-eyebrow">{greeting()}</div>
            <h1 className="view-title">Welcome to Needle</h1>
            <p className="dashboard-lead">
              Your library is empty. Import a folder of music to get started — FLAC, ALAC, WAV, AIFF, M4A, AAC, MP3,
              OGG, and Opus are all supported.
            </p>
          </div>
        </header>
        <div className="empty">
          <div className="empty-icon">♪</div>
          <h2>No music yet</h2>
          <p>Add a folder to begin scanning. Your audio files are never modified.</p>
          <button className="primary" onClick={onAddFolder} disabled={busy} style={{ marginTop: 12 }}>
            + Add folder
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view dashboard">
      <div className="dashboard-backdrop" aria-hidden="true">
        <div className="dashboard-backdrop-image" style={heroBackdropStyle} />
      </div>
      <header className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <div className="view-eyebrow">{greeting()}</div>
          <div className="dashboard-now">
            <div className={`dashboard-record ${isPlaying ? 'is-spinning' : ''}`} aria-hidden="true">
              <span className="dashboard-record-disc">
                <span className="dashboard-record-label" style={recordLabelStyle}>
                  <span className="dashboard-record-hole" />
                </span>
              </span>
            </div>
            <div>
              <h1 className="view-title">
                {currentTrack ? `Now spinning · ${currentTrack.title}` : 'What are we listening to?'}
              </h1>
              <p className="dashboard-lead">
                {currentTrack
                  ? `${currentTrack.artist ?? 'Unknown artist'} — ${currentTrack.album ?? 'Unknown album'}`
                  : `${tracks.length} tracks across ${albums.length} albums and ${artists.length} artists.`}
              </p>
            </div>
          </div>
        </div>
        <div className="dashboard-actions">
          <button className="primary" onClick={onShuffle} disabled={busy}>
            ▶ Shuffle play
          </button>
          <button className="ghost-button" onClick={onOpenSettings}>
            ⚙ Settings
          </button>
        </div>
      </header>

      <section className="dashboard-stats">
        <button className="stat-tile" onClick={() => onOpenView('tracks')}>
          <span className="stat-label">Tracks</span>
          <span className="stat-value">{tracks.length}</span>
        </button>
        <button className="stat-tile" onClick={() => onOpenView('albums')}>
          <span className="stat-label">Albums</span>
          <span className="stat-value">{albums.length}</span>
        </button>
        <button className="stat-tile" onClick={() => onOpenView('artists')}>
          <span className="stat-label">Artists</span>
          <span className="stat-value">{artists.length}</span>
        </button>
      </section>

      {recentAlbums.length > 0 && (
        <section className="dashboard-section">
          <div className="section-head">
            <h2 className="section-title">Recently added</h2>
            <button className="ghost-button" onClick={() => onOpenView('albums')}>
              See all →
            </button>
          </div>
          <div className="card-grid">
            {recentAlbums.map((a) => (
              <div key={a.key} className="card-wrap">
                <button className="card" onClick={() => onOpenAlbum(a.key)}>
                  <Cover
                    trackPath={a.samplePath}
                    fallback={a.album[0]?.toUpperCase() ?? '◉'}
                    size="card"
                  />
                  <div className="card-title">{a.album}</div>
                  <div className="card-sub">{a.artist ?? 'Various artists'}</div>
                  <div className="card-meta">{relativeAdded(a.addedAt)} · {a.count} tracks</div>
                </button>
                <button
                  className="card-play"
                  onClick={() => onPlayAlbum(a.key)}
                  title={`Play ${a.album}`}
                >
                  ▶
                </button>
                <div className="card-actions">
                  <button
                    className="card-mini-action"
                    onClick={() => onPlayNextAlbum(a.key)}
                    title={`Play ${a.album} next`}
                  >
                    Next
                  </button>
                  <button
                    className="card-mini-action"
                    onClick={() => onAddAlbumToQueue(a.key)}
                    title={`Add ${a.album} to queue`}
                  >
                    + Queue
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {playlists.length > 0 && (
        <section className="dashboard-section">
          <div className="section-head">
            <h2 className="section-title">From your library</h2>
            <div className="section-actions">
              <button className="ghost-button" onClick={onShuffleFeatured}>
                ↻ Refresh
              </button>
            </div>
          </div>
          <div className="playlist-grid">
            {playlists.map((pl) => (
              <div key={pl.id} className="playlist-card" style={{ background: pl.accent }}>
                <button
                  className="playlist-open"
                  onClick={() => onOpenPlaylist(pl)}
                  title={`Open ${pl.name}`}
                >
                  <div className="playlist-name">{pl.name}</div>
                  <div className="playlist-desc">{pl.description}</div>
                  <div className="playlist-meta">{pl.tracks.length} tracks</div>
                </button>
                <button
                  className="playlist-play"
                  onClick={() => onPlayPlaylist(pl)}
                  title="Shuffle play"
                >
                  ▶
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {featured.length > 0 && (
        <section className="dashboard-section">
          <div className="section-head">
            <h2 className="section-title">Featured albums</h2>
            <div className="section-actions">
              <button className="ghost-button" onClick={onShuffleFeatured}>
                ↻ Shuffle
              </button>
              <button className="ghost-button" onClick={() => onOpenView('albums')}>
                See all →
              </button>
            </div>
          </div>
          <div className="card-grid">
            {featured.map((a) => (
              <div key={a.key} className="card-wrap">
                <button className="card" onClick={() => onOpenAlbum(a.key)}>
                  <Cover
                    trackPath={a.samplePath}
                    fallback={a.album[0]?.toUpperCase() ?? '◉'}
                    size="card"
                  />
                  <div className="card-title">{a.album}</div>
                  <div className="card-sub">{a.artist ?? 'Various artists'}</div>
                  <div className="card-meta">{a.count} tracks</div>
                </button>
                <button
                  className="card-play"
                  onClick={() => onPlayAlbum(a.key)}
                  title={`Play ${a.album}`}
                >
                  ▶
                </button>
                <div className="card-actions">
                  <button
                    className="card-mini-action"
                    onClick={() => onPlayNextAlbum(a.key)}
                    title={`Play ${a.album} next`}
                  >
                    Next
                  </button>
                  <button
                    className="card-mini-action"
                    onClick={() => onAddAlbumToQueue(a.key)}
                    title={`Add ${a.album} to queue`}
                  >
                    + Queue
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {topArtists.length > 0 && (
        <section className="dashboard-section">
          <div className="section-head">
            <h2 className="section-title">Top artists</h2>
            <button className="ghost-button" onClick={() => onOpenView('artists')}>
              See all →
            </button>
          </div>
          <div className="artist-row">
            {topArtists.map((a) => (
              <div key={a.artist} className="artist-tile-wrap">
                <button
                  className="artist-tile"
                  onClick={() => onOpenArtist(a.artist)}
                >
                  <ArtistAvatar name={a.artist} size="lg" />
                  <div className="artist-tile-name">{a.artist}</div>
                  <div className="artist-tile-meta">{a.count} tracks</div>
                </button>
                <button
                  className="artist-tile-play"
                  onClick={() => onPlayArtist(a.artist)}
                  title={`Shuffle play · ${a.artist}`}
                >
                  ▶
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="dashboard-section">
        <div className="section-head">
          <h2 className="section-title">Quick picks</h2>
          <div className="section-actions">
            <button
              className="ghost-button"
              onClick={() => onPlayQueue(quickPicks)}
              disabled={quickPicks.length === 0}
            >
              ▶ Play all
            </button>
            <button className="ghost-button" onClick={onShuffle}>
              ↻ Shuffle one
            </button>
          </div>
        </div>
        <div className="quick-list">
          {quickPicks.map((t) => (
            <button key={t.id} className="quick-item" onClick={() => onPlay(t)}>
              <Cover trackPath={t.path} fallback={t.title[0]?.toUpperCase() ?? '♪'} size="md" />
              <div className="quick-meta">
                <div className="quick-title">{t.title}</div>
                <div className="quick-sub">
                  {(t.artist ?? 'Unknown artist') + ' — ' + (t.album ?? 'Unknown album')}
                </div>
              </div>
              <span className="quick-duration">{formatDuration(t.duration_seconds)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export default App;
