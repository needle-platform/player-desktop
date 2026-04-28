import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bootstrapApp,
  pausePlayback,
  playQueue as tauriPlayQueue,
  playTrack,
  recordPlay,
  removeLibraryRoot,
  resumePlayback,
  runMaintenance,
  saveSettings,
  scanLibrary,
  stopPlayback,
} from './lib/tauri';
import type {
  AppSettings,
  BootstrapPayload,
  EqualizerPreset,
  ThemeMode,
  Track,
} from './types';
import { useCoverArt } from './lib/cover';
import { useArtistImage } from './lib/artistImage';
import { generateAutoPlaylists, type AutoPlaylist } from './lib/playlists';

type View = 'dashboard' | 'tracks' | 'albums' | 'artists' | 'settings';

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

const equalizerOptions: Array<{ value: EqualizerPreset; label: string }> = [
  { value: 'flat', label: 'Flat' },
  { value: 'bass_boost', label: 'Bass Boost' },
  { value: 'vocal', label: 'Vocal' },
  { value: 'treble_boost', label: 'Treble Boost' },
  { value: 'lounge', label: 'Lounge' },
];

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

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

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [featuredSeed, setFeaturedSeed] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<AutoPlaylist | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const lastRecordedPath = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      const dispose = await listen<{ name: string; data: unknown }>(
        'mpv-property',
        (event) => {
          const { name, data } = event.payload;
          if (name === 'path') {
            const path = typeof data === 'string' ? data : null;
            setCurrentPath(path);
            if (!path) {
              setIsPlaying(false);
              setStatus('');
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
            const paused = data === true;
            setIsPlaying(!paused);
          }
        },
      );
      unlisten = dispose;
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

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
    if (!data) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const t = data.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : data.settings.theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [data]);

  const allTracks = data?.library.tracks ?? [];

  const filteredTracks = useMemo(() => {
    let list: Track[] = selectedPlaylist ? selectedPlaylist.tracks : allTracks;
    if (selectedAlbum) list = list.filter((t) => t.album === selectedAlbum);
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
  }, [allTracks, search, selectedAlbum, selectedArtist, selectedPlaylist]);

  const playlists = useMemo(
    () => generateAutoPlaylists(allTracks),
    // featuredSeed reroll also rerolls playlist sampling
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTracks, featuredSeed],
  );

  const albums = useMemo(() => {
    const map = new Map<
      string,
      {
        album: string;
        artist: string | null;
        count: number;
        samplePath: string;
        addedAt: string | null;
      }
    >();
    for (const t of allTracks) {
      if (!t.album) continue;
      const existing = map.get(t.album);
      if (existing) {
        existing.count += 1;
        if (t.added_at && (!existing.addedAt || t.added_at > existing.addedAt)) {
          existing.addedAt = t.added_at;
        }
      } else {
        map.set(t.album, {
          album: t.album,
          artist: t.artist,
          count: 1,
          samplePath: t.path,
          addedAt: t.added_at ?? null,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.album.localeCompare(b.album));
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
    () => allTracks.find((t) => t.path === currentPath) ?? null,
    [allTracks, currentPath],
  );

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

  const play = async (track: Track) => {
    try {
      await playTrack(track.path);
      setCurrentPath(track.path);
      setIsPlaying(true);
      setStatus(`Playing ${track.title}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const playQueue = async (queue: Track[], label?: string) => {
    if (queue.length === 0) return;
    const first = queue[0];
    try {
      await tauriPlayQueue(queue.map((t) => t.path));
      setCurrentPath(first.path);
      setIsPlaying(true);
      setStatus(label ?? `Playing ${first.title}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const playAlbum = (albumName: string) => {
    const tracks = allTracks
      .filter((t) => t.album === albumName)
      .slice()
      .sort(
        (a, b) =>
          (a.track_number ?? 9999) - (b.track_number ?? 9999) ||
          a.title.localeCompare(b.title),
      );
    void playQueue(tracks, `Playing album · ${albumName}`);
  };

  const playArtist = (artistName: string) => {
    const pool = allTracks.filter((t) => t.artist === artistName);
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    void playQueue(shuffled.slice(0, 50), `Artist mix · ${artistName}`);
  };

  const togglePlayPause = async () => {
    if (!currentTrack) {
      const first = filteredTracks[0];
      if (first) await play(first);
      return;
    }
    try {
      if (isPlaying) {
        await pausePlayback();
        setIsPlaying(false);
      } else {
        await resumePlayback();
        setIsPlaying(true);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const shufflePlay = async () => {
    if (allTracks.length === 0) return;
    const pick = allTracks[Math.floor(Math.random() * allTracks.length)];
    await play(pick);
  };

  const skip = async (delta: 1 | -1) => {
    if (!currentTrack) return;
    const idx = filteredTracks.findIndex((t) => t.path === currentTrack.path);
    if (idx === -1) return;
    const next = filteredTracks[idx + delta];
    if (next) await play(next);
  };

  const stop = async () => {
    try {
      await stopPlayback();
      setIsPlaying(false);
      setCurrentPath(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

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
          <div className="brand-mark" />
          <div>
            <div className="brand-title">Resonance</div>
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
              setSelectedAlbum(null);
              setSelectedArtist(null);
              setSelectedPlaylist(null);
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
          <div className="nav-label">Folders</div>
          {data.settings.library_roots.length === 0 && (
            <div className="nav-empty">No folders yet</div>
          )}
          {data.settings.library_roots.map((root) => (
            <div className="folder-row" key={root} title={root}>
              <span className="folder-name">{folderName(root)}</span>
              <button
                className="folder-remove"
                onClick={() => removeRoot(root)}
                title="Remove from library"
              >
                ×
              </button>
            </div>
          ))}
          <button className="nav-button" onClick={importFolder} disabled={!!busy}>
            + Add folder
          </button>
          <button className="nav-button" onClick={maintenance} disabled={!!busy}>
            ↻ Run maintenance
          </button>
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
            playlists={playlists}
            currentTrack={currentTrack}
            featuredSeed={featuredSeed}
            onShuffle={shufflePlay}
            onAddFolder={importFolder}
            onMaintenance={maintenance}
            onShuffleFeatured={() => setFeaturedSeed((s) => s + 1)}
            onOpenAlbum={(album) => {
              setSelectedAlbum(album);
              setSelectedArtist(null);
              setSelectedPlaylist(null);
              setView('tracks');
            }}
            onOpenArtist={(artist) => {
              setSelectedArtist(artist);
              setSelectedAlbum(null);
              setSelectedPlaylist(null);
              setView('tracks');
            }}
            onOpenPlaylist={(pl) => {
              setSelectedPlaylist(pl);
              setSelectedAlbum(null);
              setSelectedArtist(null);
              setView('tracks');
            }}
            onPlayPlaylist={(pl) => {
              if (pl.tracks.length === 0) return;
              const shuffled = pl.tracks.slice();
              for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
              }
              void playQueue(shuffled, `Playlist · ${pl.name}`);
            }}
            onPlayAlbum={playAlbum}
            onPlayArtist={playArtist}
            onPlayQueue={(tracks) => void playQueue(tracks, 'Quick picks')}
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
            title={
              selectedPlaylist
                ? selectedPlaylist.name
                : (selectedAlbum ?? selectedArtist ?? 'All tracks')
            }
            subtitle={
              selectedPlaylist
                ? selectedPlaylist.description
                : selectedAlbum
                  ? 'Album'
                  : selectedArtist
                    ? 'Artist'
                    : `${lib.track_count} tracks in your library`
            }
            onClearFilter={
              selectedAlbum || selectedArtist || selectedPlaylist
                ? () => {
                    setSelectedAlbum(null);
                    setSelectedArtist(null);
                    setSelectedPlaylist(null);
                  }
                : undefined
            }
          />
        )}

        {view === 'albums' && (
          <AlbumsView
            albums={albums}
            onSelect={(album) => {
              setSelectedAlbum(album);
              setSelectedArtist(null);
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
            onMaintenance={maintenance}
            busy={!!busy}
          />
        )}
      </main>

      <footer className="player-bar">
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

        <div className="player-controls">
          <button className="ctrl" onClick={() => skip(-1)} disabled={!currentTrack} title="Previous">
            ⏮
          </button>
          <button className="ctrl ctrl-primary" onClick={togglePlayPause} title={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button className="ctrl" onClick={() => skip(1)} disabled={!currentTrack} title="Next">
            ⏭
          </button>
          <button className="ctrl" onClick={stop} disabled={!currentTrack} title="Stop">
            ⏹
          </button>
        </div>

        <div className="player-extra">
          {currentTrack && (
            <>
              <span className="player-quality">{formatQuality(currentTrack)}</span>
              <span className="player-duration">{formatDuration(currentTrack.duration_seconds)}</span>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}

interface TracksViewProps {
  tracks: Track[];
  search: string;
  onSearch: (value: string) => void;
  currentPath: string | null;
  isPlaying: boolean;
  onPlay: (track: Track) => void;
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
          </div>
          {tracks.map((track, index) => {
            const isCurrent = track.path === currentPath;
            return (
              <button
                key={track.id}
                className={`track-row ${isCurrent ? 'is-current' : ''}`}
                onDoubleClick={() => onPlay(track)}
                onClick={() => onPlay(track)}
              >
                <span className="track-index">
                  {isCurrent && isPlaying ? '♪' : index + 1}
                </span>
                <span className="track-title">{track.title}</span>
                <span className="track-cell">{track.artist ?? '—'}</span>
                <span className="track-cell">{track.album ?? '—'}</span>
                <span className="track-cell num">{formatDuration(track.duration_seconds)}</span>
                <span className="track-cell muted">{formatQuality(track)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

type AlbumSummary = {
  album: string;
  artist: string | null;
  count: number;
  samplePath: string;
  addedAt: string | null;
};

interface AlbumsViewProps {
  albums: AlbumSummary[];
  onSelect: (album: string) => void;
}

function AlbumsView({ albums, onSelect }: AlbumsViewProps) {
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
            <button key={a.album} className="card" onClick={() => onSelect(a.album)}>
              <Cover
                trackPath={a.samplePath}
                fallback={a.album[0]?.toUpperCase() ?? '◉'}
                size="card"
              />
              <div className="card-title">{a.album}</div>
              <div className="card-sub">{a.artist ?? 'Various artists'}</div>
              <div className="card-meta">{a.count} tracks</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface CoverProps {
  trackPath: string | null;
  fallback: string;
  size: 'md' | 'card';
}

function Cover({ trackPath, fallback, size }: CoverProps) {
  const url = useCoverArt(trackPath);
  const className = size === 'card' ? 'card-art' : 'cover';

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
  onMaintenance: () => void;
  busy: boolean;
}

function SettingsView({ settings, onChange, onMaintenance, busy }: SettingsViewProps) {
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-eyebrow">App</div>
          <h1 className="view-title">Settings</h1>
        </div>
      </header>

      <div className="settings">
        <section className="settings-card">
          <h3>Appearance</h3>
          <label>Theme</label>
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
        </section>

        <section className="settings-card">
          <h3>Equalizer</h3>
          <label>Preset</label>
          <div className="seg">
            {equalizerOptions.map((opt) => (
              <button
                key={opt.value}
                className={`seg-btn ${settings.equalizer_preset === opt.value ? 'on' : ''}`}
                onClick={() => onChange({ ...settings, equalizer_preset: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="hint">Equalizer presets are stored locally; DSP wiring through mpv comes next.</p>
        </section>

        <section className="settings-card">
          <h3>Library</h3>
          <p className="hint">
            Maintenance rescans your folders for changes and removes any dotfile entries from the library. Your audio
            files are never modified.
          </p>
          <button className="primary" onClick={onMaintenance} disabled={busy}>
            ↻ Run maintenance
          </button>
        </section>

        <section className="settings-card">
          <h3>Playback</h3>
          <p className="hint">
            Audio is played by mpv. On macOS install it with <code>brew install mpv</code> if it isn’t already
            available.
          </p>
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
  featuredSeed: number;
  onShuffle: () => void;
  onAddFolder: () => void;
  onMaintenance: () => void;
  onShuffleFeatured: () => void;
  onOpenAlbum: (album: string) => void;
  onOpenArtist: (artist: string) => void;
  onOpenPlaylist: (playlist: AutoPlaylist) => void;
  onPlayPlaylist: (playlist: AutoPlaylist) => void;
  onPlayAlbum: (album: string) => void;
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
  featuredSeed,
  onShuffle,
  onAddFolder,
  onMaintenance,
  onShuffleFeatured,
  onOpenAlbum,
  onOpenArtist,
  onOpenPlaylist,
  onPlayPlaylist,
  onPlayAlbum,
  onPlayArtist,
  onPlayQueue,
  onOpenView,
  onPlay,
  busy,
}: DashboardViewProps) {
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

  const isEmpty = tracks.length === 0;

  if (isEmpty) {
    return (
      <div className="view dashboard">
        <header className="dashboard-hero">
          <div>
            <div className="view-eyebrow">{greeting()}</div>
            <h1 className="view-title">Welcome to Resonance</h1>
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
      <header className="dashboard-hero">
        <div>
          <div className="view-eyebrow">{greeting()}</div>
          <h1 className="view-title">
            {currentTrack ? `Still spinning · ${currentTrack.title}` : 'What are we listening to?'}
          </h1>
          <p className="dashboard-lead">
            {currentTrack
              ? `${currentTrack.artist ?? 'Unknown artist'} — ${currentTrack.album ?? 'Unknown album'}`
              : `${tracks.length} tracks across ${albums.length} albums and ${artists.length} artists.`}
          </p>
        </div>
        <div className="dashboard-actions">
          <button className="primary" onClick={onShuffle} disabled={busy}>
            ▶ Shuffle play
          </button>
          <button className="ghost-button" onClick={onAddFolder} disabled={busy}>
            + Add folder
          </button>
          <button className="ghost-button" onClick={onMaintenance} disabled={busy}>
            ↻ Maintenance
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
              <div key={a.album} className="card-wrap">
                <button className="card" onClick={() => onOpenAlbum(a.album)}>
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
                  onClick={() => onPlayAlbum(a.album)}
                  title={`Play ${a.album}`}
                >
                  ▶
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {playlists.length > 0 && (
        <section className="dashboard-section">
          <div className="section-head">
            <h2 className="section-title">Made for you</h2>
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
              <div key={a.album} className="card-wrap">
                <button className="card" onClick={() => onOpenAlbum(a.album)}>
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
                  onClick={() => onPlayAlbum(a.album)}
                  title={`Play ${a.album}`}
                >
                  ▶
                </button>
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
