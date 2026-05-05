import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { LogicalSize, PhysicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { CSSProperties, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  adjustTrackBpm as persistTrackBpmAdjustment,
  applyVolumeLevelingForTrack,
  appendTracksToPlaylist,
  appendQueue,
  bootstrapApp,
  createPlaylist,
  deletePlaylist,
  getPlaybackState,
  getRuntimeInfo,
  getMissingLibraryRoots,
  insertQueueAt,
  moveQueueIndex as tauriMoveQueueIndex,
  movePlaylistTrack,
  openExternalUrl,
  pausePlayback,
  playQueueIndex as tauriPlayQueueIndex,
  playQueue as tauriPlayQueue,
  playTrack,
  recordPlay,
  removePlaylistTrack,
  removeQueueIndex as tauriRemoveQueueIndex,
  removeLibraryRoot,
  renamePlaylist,
  refreshAlbumMetadataFromMusicBrainz,
  resumePlayback,
  runMaintenance,
  setAudioDevice as setPlaybackAudioDevice,
  saveAlbumGenre as persistAlbumGenre,
  saveTrackBpm as persistTrackBpmValue,
  setTrackFavorite as persistTrackFavorite,
  setTrackRating as persistTrackRating,
  setPlaybackMuted,
  setPlaybackVolume as setPlaybackVolumeLevel,
  setRepeatMode as tauriSetRepeatMode,
  saveSettings,
  savePlaybackSession,
  runLoudnessAnalysis,
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
  LoudnessAnalysisFailure,
  LoudnessAnalysisProgress,
  MetadataEditMode,
  PlaybackSession,
  RepeatMode,
  RuntimeInfo,
  SavedPlaylist,
  SavedPlaylistRule,
  ThemeMode,
  Track,
  TrackBpmAdjustment,
} from './types';
import { useCoverArt } from './lib/cover';
import { useArtistImage } from './lib/artistImage';
import { useArtistInfo } from './lib/artistInfo';
import { useAlbumInfo } from './lib/albumInfo';
import { findSuspiciousBpmTracks, type BpmAuditItem } from './lib/bpmAudit';
import {
  genreLabelFromKey,
  normalizeGenreKey,
  splitTrackGenreEntries,
  splitTrackGenreKeys,
  splitTrackGenres,
} from './lib/genres';
import { generateAutoPlaylists, type AutoPlaylist } from './lib/playlists';
import { formatBpm, vibeKeyForTrack, vibeLabelForTrack } from './lib/vibes';
import dashboardIdleBackdrop from './assets/bg.jpg';
import needleBrandMarkDark from './assets/needle-icon-flat-dark.png';
import needleBrandMarkLight from './assets/needle-icon-flat-light.png';
import vinylRipBadgeIcon from './assets/vinyl-rip-badge.svg';

type View = 'dashboard' | 'tracks' | 'albums' | 'album' | 'artists' | 'artist' | 'settings';
type PlaylistSelection = { kind: 'smart'; id: string } | { kind: 'manual'; id: number };
type TrackSortOption = 'title' | 'artist' | 'album' | 'recent' | 'plays' | 'rating' | 'duration';
type AlbumSortOption = 'album' | 'artist' | 'recent' | 'tracks';
type ArtistSortOption = 'artist' | 'tracks' | 'recent';
type ArtistBrowseMode = 'album' | 'all';
type ArtistLayoutMode = 'list' | 'grid';
type TrackYearBoundaryFilter = 'all' | string;
type PlaylistCreateSource = {
  id: string;
  label: string;
  description: string;
  suggestedName: string;
  tracks: Track[];
  rule?: SavedPlaylistRule | null;
};
type PlaylistComposerState = {
  sources: PlaylistCreateSource[];
  selectedSourceId: string;
  libraryTracks: Track[];
  artistOptions: string[];
  genreOptions: string[];
  initialArtist: string;
  initialGenre: string;
};
type PlaylistComposerSubmission = {
  name: string;
  tracks: Track[];
  rule: SavedPlaylistRule | null;
};
type PlaylistTargetState = {
  title: string;
  description: string;
  trackPaths: string[];
  suggestedName: string;
};
type SmartPlaylistGenreOption = {
  key: string;
  label: string;
  count: number;
};
type AlbumGenreEditorState = {
  album: string;
  albumArtist: string | null;
  trackPaths: string[];
  currentGenre: string | null;
  suggestedGenres: string[];
};
type TrackBpmEditorState = {
  track: Track;
  dismissFromAudit?: boolean;
};
type ResolvedPlaylist = {
  id: string;
  kind: 'smart' | 'manual';
  name: string;
  description: string;
  tracks: Track[];
  saved?: SavedPlaylist;
};
type DashboardPlaylistSection = {
  id: string;
  title: string;
  playlists: AutoPlaylist[];
};
type AlbumSummary = {
  key: string;
  album: string;
  artist: string | null;
  year: number | null;
  count: number;
  samplePath: string;
  is_vinyl_rip: boolean;
  addedAt: string | null;
};
type ArtistSummary = {
  artist: string;
  count: number;
  albumCount: number;
  samplePath: string;
  addedAt: string | null;
};
type WindowRestoreState = {
  size: {
    width: number;
    height: number;
  };
  alwaysOnTop: boolean;
  resizable: boolean;
};
type NotificationTone = 'info' | 'success' | 'warning' | 'error';

const inferNotificationTone = (message: string): NotificationTone => {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return 'info';

  if (
    normalized.includes('failed') ||
    normalized.includes("couldn't") ||
    normalized.includes('unable') ||
    normalized.includes('does not exist') ||
    normalized.includes('out of range') ||
    normalized.includes('rate-limit') ||
    normalized.includes('rate limiting') ||
    normalized.includes('try again later') ||
    normalized.includes('try again in a minute') ||
    normalized.includes('non-2xx')
  ) {
    return 'error';
  }

  if (
    normalized.includes('no confident') ||
    normalized.includes('no tracks') ||
    normalized.includes('left untouched') ||
    normalized.includes('already playing') ||
    normalized.includes('already playing') ||
    normalized.includes('already') ||
    normalized.includes('not found')
  ) {
    return 'warning';
  }

  if (
    normalized.includes('imported') ||
    normalized.includes('saved') ||
    normalized.includes('renamed') ||
    normalized.includes('deleted') ||
    normalized.includes('updated') ||
    normalized.includes('synced') ||
    normalized.includes('added') ||
    normalized.includes('removed') ||
    normalized.includes('cleared') ||
    normalized.includes('reordered') ||
    normalized.includes('plays next') ||
    normalized.includes('pinned') ||
    normalized.includes('halved bpm') ||
    normalized.includes('doubled bpm') ||
    normalized.includes('bpm correction') ||
    normalized.includes('mini player on') ||
    normalized.includes('mini player off')
  ) {
    return 'success';
  }

  return 'info';
};

const notificationToneLabel = (tone: NotificationTone): string => {
  if (tone === 'error') return 'Problem';
  if (tone === 'warning') return 'Heads up';
  if (tone === 'success') return 'Done';
  return 'Needle';
};

const notificationToneIcon = (tone: NotificationTone): string => {
  if (tone === 'error') return '!';
  if (tone === 'warning') return '•';
  if (tone === 'success') return '✓';
  return 'i';
};

const isPlaybackStatusMessage = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith('playing ') ||
    normalized.startsWith('playing album') ||
    normalized.startsWith('playing playlist') ||
    normalized.startsWith('shuffle play') ||
    normalized.startsWith('shuffle playlist') ||
    normalized.startsWith('artist mix') ||
    normalized.startsWith('selected ') ||
    normalized === 'that track is already playing' ||
    normalized === 'that album is already playing' ||
    normalized === 'that playlist is already playing'
  );
};

const formatMaintenanceLogLine = (message: string): string => {
  const timestamp = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `[${timestamp}] ${message}`;
};

const formatMaintenanceTimestamp = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  const isoValue = value.includes('T') ? value : value.replace(' ', 'T');
  const normalized = /z$/i.test(isoValue) ? isoValue : `${isoValue}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
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
  { value: 'bass_treble_boost', label: 'Bass/Treble Boost' },
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
  bass_treble_boost: [2.4, 2.7, 2.3, 1.3, 0.2, -0.2, 0.5, 1.4, 2.1, 1.7],
  vocal: [-0.8, -0.6, -0.3, 0.2, 1.0, 1.8, 2.2, 1.0, 0.4, -0.2],
  treble_boost: [-0.3, -0.2, 0.0, 0.0, 0.3, 0.9, 1.6, 2.2, 2.5, 1.4],
  lounge: [1.2, 1.4, 1.0, 0.5, 0.2, -0.3, -0.8, -0.2, 0.2, 0.4],
};

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const metadataEditModeOptions: Array<{
  value: MetadataEditMode;
  label: string;
  hint: string;
}> = [
  {
    value: 'needle_only',
    label: 'Needle only',
    hint: 'Save genre and BPM edits in Needle without modifying your music files.',
  },
  {
    value: 'write_to_files',
    label: 'Write to files',
    hint: 'Update the embedded genre and BPM tags so other apps see the same edits too.',
  },
];
const trackSortOptions: Array<{ value: TrackSortOption; label: string }> = [
  { value: 'title', label: 'Title (A-Z)' },
  { value: 'artist', label: 'Artist (A-Z)' },
  { value: 'album', label: 'Album (A-Z)' },
  { value: 'recent', label: 'Recently added' },
  { value: 'plays', label: 'Most played' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'duration', label: 'Longest first' },
];
const albumSortOptions: Array<{ value: AlbumSortOption; label: string }> = [
  { value: 'album', label: 'Album (A-Z)' },
  { value: 'artist', label: 'Artist (A-Z)' },
  { value: 'recent', label: 'Recently added' },
  { value: 'tracks', label: 'Most tracks' },
];
const artistSortOptions: Array<{ value: ArtistSortOption; label: string }> = [
  { value: 'artist', label: 'Artist (A-Z)' },
  { value: 'tracks', label: 'Most tracks' },
  { value: 'recent', label: 'Recently added' },
];
const artistBrowseModeOptions: Array<{ value: ArtistBrowseMode; label: string }> = [
  { value: 'album', label: 'Album artists' },
  { value: 'all', label: 'All artists' },
];
const trackPageSizeOptions = [25, 50, 100] as const;
const defaultTracksPageSize = 50;
const allTrackFilterValue = 'all';
const defaultVolumePercent = 80;
const maxTrackRating = 5;
const miniPlayerPinnedStorageKey = 'needle-mini-player-pinned';
const bpmAuditDismissedStorageKey = 'needle-bpm-audit-dismissed';
const bpmAuditDismissedPathStorageKey = 'needle-bpm-audit-dismissed-paths';
const bpmAuditReviewedStorageKey = 'needle-bpm-audit-reviewed';
const miniPlayerBaseSize = { width: 380, height: 420 };
const miniPlayerExpandedHeightDefault = 772;
const miniPlayerExpandedHeightMin = 720;
const miniPlayerExpandedHeightMax = 980;
const isDevBuild = import.meta.env.DEV;

const formatDuration = (seconds: number | null | undefined) => {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
const formatTrackRatingLabel = (rating: number) => `${rating} star${rating === 1 ? '' : 's'}`;
const bpmAuditDismissalKey = (track: Pick<Track, 'path' | 'bpm'>) => `${track.path}\u0000${track.bpm ?? ''}`;
const filteredPlaylistName = (artist: string, genre: string) => {
  const parts = [artist, genre].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' · ')} mix` : 'Filtered mix';
};
const effectiveTrackGenre = (track: Pick<Track, 'primary_genre' | 'genre'>) => track.primary_genre ?? track.genre;
const uniqueSorted = (values: string[]) =>
  Array.from(new Set(values.filter(Boolean))).sort((a, b) => compareText(a, b));
const dedupeTracksByPath = (tracks: Track[]) => Array.from(new Map(tracks.map((track) => [track.path, track])).values());
const yearFilterNumber = (value: TrackYearBoundaryFilter) => {
  if (value === allTrackFilterValue) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const formatTrackYearRange = (start: TrackYearBoundaryFilter, end: TrackYearBoundaryFilter) => {
  if (start !== allTrackFilterValue && end !== allTrackFilterValue) {
    return start === end ? `Year ${start}` : `${start}–${end}`;
  }
  if (start !== allTrackFilterValue) return `From ${start}`;
  if (end !== allTrackFilterValue) return `Up to ${end}`;
  return null;
};
function useNearViewport(lazyLoad: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(!lazyLoad);

  useEffect(() => {
    if (!lazyLoad) {
      setIsNearViewport(true);
      return;
    }
    if (isNearViewport) return;

    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [isNearViewport, lazyLoad]);

  return { ref, isNearViewport };
}

const formatArtistGenderLabel = (value: string | null | undefined) => {
  if (!value) return 'unknown';
  return value
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
};

const formatQuality = (track: Track) => {
  const parts = [
    track.format,
    track.sample_rate ? `${(track.sample_rate / 1000).toFixed(1)} kHz` : null,
    track.bit_depth ? `${track.bit_depth}-bit` : null,
  ].filter((v): v is string => Boolean(v));
  return parts.join(' · ') || null;
};

const formatTrackPace = (track: Pick<Track, 'bpm'>) => {
  const bpm = formatBpm(track.bpm);
  const vibe = vibeLabelForTrack(track);
  const parts = [bpm ? `${bpm} BPM` : null, vibe].filter((value): value is string => Boolean(value));
  return parts.join(' · ') || null;
};

const formatTrackTechDetails = (track: Track) => formatQuality(track);

const formatTrackDetails = (track: Track) => {
  const parts = [formatQuality(track), formatTrackPace(track)].filter((value): value is string => Boolean(value));
  return parts.join(' · ') || '—';
};

const albumTrackVibeToneClass = (track: Pick<Track, 'bpm'>) => {
  const vibeKey = vibeKeyForTrack(track);
  return vibeKey ? `is-${vibeKey}` : '';
};

const defaultAudioDevice: AudioDevice = { name: 'auto', description: 'System default' };

const clampVolume = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const clampIndex = (index: number, length: number) =>
  length <= 0 ? 0 : Math.max(0, Math.min(index, length - 1));
const audioDeviceKey = (description: string) => description.trim().toLowerCase();
const albumIdentitySeparator = '\u0000';
const compareText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base' });
const albumArtistForTrack = (track: Pick<Track, 'album_artist' | 'artist'>) =>
  track.album_artist ?? track.artist ?? null;
const artistNameForTrack = (track: Pick<Track, 'artist' | 'album_artist'>, mode: ArtistBrowseMode) =>
  mode === 'album' ? albumArtistForTrack(track) : track.artist;
const albumKey = (album: string | null | undefined, albumArtist: string | null | undefined) =>
  `${album ?? ''}${albumIdentitySeparator}${albumArtist ?? ''}`;
const trackAlbumKey = (track: Pick<Track, 'album' | 'album_artist' | 'artist'>) =>
  track.album ? albumKey(track.album, albumArtistForTrack(track)) : null;
const albumTitleFromKey = (key: string) => key.split(albumIdentitySeparator)[0] ?? key;
const normalizePlaylistRuleText = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
};
const formatPlaylistRuleSummary = (rule: SavedPlaylistRule) => {
  if (rule.kind === 'filtered_library') {
    const parts = [
      rule.search ? `Search: ${rule.search}` : null,
      rule.artist,
      rule.genre ? genreLabelFromKey(normalizeGenreKey(rule.genre) ?? rule.genre) : null,
      formatTrackYearRange(
        rule.year_from != null ? String(rule.year_from) : allTrackFilterValue,
        rule.year_to != null ? String(rule.year_to) : allTrackFilterValue,
      ) !== 'Any year'
        ? formatTrackYearRange(
            rule.year_from != null ? String(rule.year_from) : allTrackFilterValue,
            rule.year_to != null ? String(rule.year_to) : allTrackFilterValue,
          )
        : null,
    ].filter(Boolean);
    return `Auto-updating${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`;
  }

  return 'Auto-updating playlist';
};
const isPlaylistTrackEditable = (playlist: SavedPlaylist | null | undefined) => !playlist?.rule;
const timestampValue = (iso: string | null | undefined) => {
  if (!iso) return 0;
  const parsed = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
};
const formatArtistCounts = (albumCount: number, trackCount: number) =>
  `${albumCount} album${albumCount === 1 ? '' : 's'} · ${trackCount} track${trackCount === 1 ? '' : 's'}`;
const compareAlbumTracks = (a: Track, b: Track) =>
  (a.disc_number ?? 1) - (b.disc_number ?? 1) ||
  (a.track_number ?? 9999) - (b.track_number ?? 9999) ||
  compareText(a.title, b.title) ||
  compareText(a.path, b.path);
const compareTracksBySort = (sort: TrackSortOption) => (a: Track, b: Track) => {
  if (sort === 'artist') {
    return (
      compareText(a.artist, b.artist) ||
      compareText(a.album, b.album) ||
      compareAlbumTracks(a, b)
    );
  }
  if (sort === 'album') {
    return (
      compareText(a.album, b.album) ||
      compareText(albumArtistForTrack(a), albumArtistForTrack(b)) ||
      compareAlbumTracks(a, b)
    );
  }
  if (sort === 'recent') {
    return (
      timestampValue(b.added_at) - timestampValue(a.added_at) ||
      compareText(a.title, b.title) ||
      compareText(a.path, b.path)
    );
  }
  if (sort === 'plays') {
    return (
      (b.play_count ?? 0) - (a.play_count ?? 0) ||
      timestampValue(b.last_played_at) - timestampValue(a.last_played_at) ||
      compareText(a.title, b.title)
    );
  }
  if (sort === 'rating') {
    return (
      (b.rating ?? 0) - (a.rating ?? 0) ||
      (b.play_count ?? 0) - (a.play_count ?? 0) ||
      timestampValue(b.last_played_at) - timestampValue(a.last_played_at) ||
      compareText(a.title, b.title)
    );
  }
  if (sort === 'duration') {
    return (
      (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0) ||
      compareText(a.title, b.title) ||
      compareText(a.path, b.path)
    );
  }
  return (
    compareText(a.title, b.title) ||
    compareText(a.artist, b.artist) ||
    compareText(a.album, b.album) ||
    compareText(a.path, b.path)
  );
};
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
type RgbColor = { r: number; g: number; b: number };

const accentColorPattern = /^#?[0-9a-f]{6}$/i;
const normalizeAccentColor = (value: string | null | undefined) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!accentColorPattern.test(trimmed)) return null;
  return `#${trimmed.replace(/^#/, '').toLowerCase()}`;
};
const normalizeTracksPageSize = (value: number | null | undefined) =>
  trackPageSizeOptions.includes(value as (typeof trackPageSizeOptions)[number]) ? value! : defaultTracksPageSize;
const defaultAccentForTheme = (theme: 'light' | 'dark') => (theme === 'dark' ? '#87a0ff' : '#5b7cff');
const hexToRgb = (hex: string): RgbColor => {
  const normalized = normalizeAccentColor(hex) ?? '#5b7cff';
  const raw = normalized.slice(1);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
};
const rgbToHex = ({ r, g, b }: RgbColor) =>
  `#${[r, g, b]
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
    .join('')}`;
const mixRgb = (from: RgbColor, to: RgbColor, ratio: number): RgbColor => ({
  r: from.r + (to.r - from.r) * ratio,
  g: from.g + (to.g - from.g) * ratio,
  b: from.b + (to.b - from.b) * ratio,
});
const rgbaString = ({ r, g, b }: RgbColor, alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
const accentContrastColor = ({ r, g, b }: RgbColor) =>
  (r * 0.299 + g * 0.587 + b * 0.114) / 255 > 0.62 ? '#11131a' : '#ffffff';
const deriveAccentTheme = (accentColor: string, theme: 'light' | 'dark') => {
  const base = hexToRgb(accentColor);
  return {
    accent: accentColor,
    accent2:
      theme === 'dark'
        ? rgbToHex(mixRgb(base, { r: 255, g: 255, b: 255 }, 0.18))
        : rgbToHex(mixRgb(base, { r: 0, g: 0, b: 0 }, 0.18)),
    rowHover: rgbaString(base, 0.08),
    rowCurrent: rgbaString(base, theme === 'dark' ? 0.18 : 0.16),
    accentContrast: accentContrastColor(base),
  };
};
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

function MiniPlayerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 10h18" />
      <path d="m10 12 5 3-5 3z" />
    </svg>
  );
}

function RestoreWindowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h10v10H7z" />
      <path d="M11 3h10v10" />
      <path d="M11 3H7a4 4 0 0 0-4 4v4" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4h6" />
      <path d="M10 4v5l-3 4v1h10v-1l-3-4V4" />
      <path d="M12 14v6" />
    </svg>
  );
}

function PlaylistIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h11" />
      <path d="M4 12h8" />
      <path d="M4 17h8" />
      <path d="M18 10v8" />
      <path d="M14 14h8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function ListLayoutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 7h11" />
      <path d="M9 12h11" />
      <path d="M9 17h11" />
      <circle cx="5" cy="7" r="1.2" />
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="5" cy="17" r="1.2" />
    </svg>
  );
}

function GridLayoutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1.2" />
      <rect x="14" y="4" width="6" height="6" rx="1.2" />
      <rect x="4" y="14" width="6" height="6" rx="1.2" />
      <rect x="14" y="14" width="6" height="6" rx="1.2" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 20 4.5-1 9-9-3.5-3.5-9 9z" />
      <path d="m13.5 6.5 3.5 3.5" />
      <path d="M19 8l1.5-1.5a1.4 1.4 0 0 0 0-2L19.5 3a1.4 1.4 0 0 0-2 0L16 4.5" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg className="shuffle-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7h4.5a4.8 4.8 0 0 1 3.5 1.5L21 18M17 18H21V14M3 17h4.5a4.8 4.8 0 0 0 3.5-1.5L21 6M17 6H21V10" />
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

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.6 14.6 8.9l5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.8 1-5.8-4.2-4.1 5.9-.9L12 3.6Z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20.6 4.7 13.9a4.9 4.9 0 0 1 0-7 4.7 4.7 0 0 1 6.8 0L12 7.4l.5-.5a4.7 4.7 0 0 1 6.8 0 4.9 4.9 0 0 1 0 7L12 20.6Z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}

function TrackFavoriteControl({
  track,
  disabled,
  onToggleFavorite,
}: {
  track: Track;
  disabled?: boolean;
  onToggleFavorite: (track: Track, favorite: boolean) => void;
}) {
  const nextFavorite = !track.is_favorite;

  return (
    <button
      className={`row-icon-button track-favorite ${track.is_favorite ? 'is-active' : ''}`}
      type="button"
      disabled={disabled}
      title={nextFavorite ? `Mark ${track.title} as favourite` : `Remove ${track.title} from favourites`}
      aria-label={nextFavorite ? `Mark ${track.title} as favourite` : `Remove ${track.title} from favourites`}
      onClick={(event) => {
        event.stopPropagation();
        onToggleFavorite(track, nextFavorite);
      }}
    >
      <HeartIcon filled={track.is_favorite} />
    </button>
  );
}

function TrackRatingControl({
  track,
  disabled,
  onSetRating,
}: {
  track: Track;
  disabled?: boolean;
  onSetRating: (track: Track, rating: number | null) => void;
}) {
  const currentRating = track.rating ?? 0;

  return (
    <div className="track-rating" role="group" aria-label={`Rating for ${track.title}`}>
      {Array.from({ length: maxTrackRating }, (_, index) => {
        const value = index + 1;
        const filled = currentRating >= value;
        const nextRating = currentRating === value ? null : value;
        const label = formatTrackRatingLabel(value).toLowerCase();
        return (
          <button
            key={`${track.path}-rating-${value}`}
            className={`track-rating-star ${filled ? 'is-filled' : ''}`}
            type="button"
            disabled={disabled}
            title={nextRating == null ? `Clear ${label} rating` : `Set ${label} rating`}
            aria-label={
              nextRating == null
                ? `Clear ${label} rating for ${track.title}`
                : `Set ${label} rating for ${track.title}`
            }
            onClick={(event) => {
              event.stopPropagation();
              onSetRating(track, nextRating);
            }}
          >
            <StarIcon filled={filled} />
          </button>
        );
      })}
    </div>
  );
}

function TrackBpmControl({
  track,
  metadataEditMode,
  disabled,
  onAdjust,
  onOpenEditor,
}: {
  track: Track;
  metadataEditMode: MetadataEditMode;
  disabled?: boolean;
  onAdjust: (track: Track, adjustment: TrackBpmAdjustment) => void;
  onOpenEditor: (track: Track) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const bpmLabel = formatBpm(track.bpm);
  const vibeLabel = vibeLabelForTrack(track);
  const halfBpm = track.bpm != null ? Math.max(1, Math.round(track.bpm / 2)) : null;
  const doubleBpm = track.bpm != null ? Math.max(1, track.bpm * 2) : null;
  const hasBpm = track.bpm != null && track.bpm > 0;
  const modeCopy =
    metadataEditMode === 'write_to_files' ? 'Saving into music files' : 'Saving in Needle only';

  return (
    <div
      ref={menuRef}
      className={`track-bpm-adjust ${track.bpm_overridden ? 'is-overridden' : ''}`}
      role="group"
      aria-label={`BPM correction for ${track.title}`}
    >
      <button
        className={`track-bpm-chip ${isOpen ? 'is-open' : ''}`}
        type="button"
        disabled={disabled}
        title={
          bpmLabel
            ? vibeLabel
              ? `${bpmLabel} BPM · ${vibeLabel}`
              : `${bpmLabel} BPM`
            : 'Set BPM'
        }
        aria-label={
          bpmLabel
            ? `BPM ${bpmLabel}${vibeLabel ? `, ${vibeLabel}` : ''}. Open BPM correction options for ${track.title}`
            : `Set BPM for ${track.title}`
        }
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((open) => !open);
        }}
      >
        {bpmLabel ? `${bpmLabel} BPM` : 'Set BPM'}
      </button>

      {isOpen && (
        <div className="track-bpm-menu-panel" role="menu" aria-label={`BPM options for ${track.title}`}>
          <div className="track-bpm-menu-title">
            {bpmLabel ? `${bpmLabel} BPM` : 'BPM'}
            {vibeLabel ? ` · ${vibeLabel}` : ''}
          </div>
          <button
            className="track-bpm-menu-option"
            type="button"
            disabled={disabled}
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onOpenEditor(track);
              setIsOpen(false);
            }}
          >
            {hasBpm ? 'Edit BPM…' : 'Set BPM…'}
          </button>
          <button
            className="track-bpm-menu-option"
            type="button"
            disabled={disabled || halfBpm == null}
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onAdjust(track, 'half');
              setIsOpen(false);
            }}
          >
            {halfBpm != null ? `Halve to ${halfBpm} BPM` : 'Halve BPM'}
          </button>
          <button
            className="track-bpm-menu-option"
            type="button"
            disabled={disabled || doubleBpm == null}
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onAdjust(track, 'double');
              setIsOpen(false);
            }}
          >
            {doubleBpm != null ? `Double to ${doubleBpm} BPM` : 'Double BPM'}
          </button>
          {metadataEditMode === 'needle_only' && (
            <button
              className="track-bpm-menu-option"
              type="button"
              disabled={disabled || !track.bpm_overridden}
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                onAdjust(track, 'reset');
                setIsOpen(false);
              }}
            >
              Reset to imported BPM
            </button>
          )}
          <div className="track-bpm-menu-footnote">{modeCopy}</div>
      </div>
      )}
    </div>
  );
}

function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [featuredSeed, setFeaturedSeed] = useState(0);
  const [search, setSearch] = useState('');
  const [trackSort, setTrackSort] = useState<TrackSortOption>('title');
  const [trackArtistFilter, setTrackArtistFilter] = useState(allTrackFilterValue);
  const [trackGenreFilter, setTrackGenreFilter] = useState(allTrackFilterValue);
  const [trackYearFromFilter, setTrackYearFromFilter] = useState<TrackYearBoundaryFilter>(allTrackFilterValue);
  const [trackYearToFilter, setTrackYearToFilter] = useState<TrackYearBoundaryFilter>(allTrackFilterValue);
  const [albumSort, setAlbumSort] = useState<AlbumSortOption>('album');
  const [artistSort, setArtistSort] = useState<ArtistSortOption>('artist');
  const [artistSearch, setArtistSearch] = useState('');
  const [artistBrowseMode, setArtistBrowseMode] = useState<ArtistBrowseMode>('album');
  const [artistLayoutMode, setArtistLayoutMode] = useState<ArtistLayoutMode>('list');
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);
  const [selectedArtistMode, setSelectedArtistMode] = useState<ArtistBrowseMode>('all');
  const [selectedArtistProfile, setSelectedArtistProfile] = useState<string | null>(null);
  const [selectedArtistProfileMode, setSelectedArtistProfileMode] = useState<ArtistBrowseMode>('all');
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSelection | null>(null);
  const [tracksPage, setTracksPage] = useState(1);
  const [playlistComposer, setPlaylistComposer] = useState<PlaylistComposerState | null>(null);
  const [playlistTarget, setPlaylistTarget] = useState<PlaylistTargetState | null>(null);
  const [albumGenreEditor, setAlbumGenreEditor] = useState<AlbumGenreEditorState | null>(null);
  const [trackBpmEditor, setTrackBpmEditor] = useState<TrackBpmEditorState | null>(null);
  const [queuePaths, setQueuePaths] = useState<string[]>([]);
  const [baseQueuePaths, setBaseQueuePaths] = useState<string[]>([]);
  const [currentQueueIndex, setCurrentQueueIndex] = useState(0);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isMiniPlayer, setIsMiniPlayer] = useState(false);
  const [isMiniPlayerPinned, setIsMiniPlayerPinned] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(miniPlayerPinnedStorageKey) === 'true';
  });
  const [dismissedBpmAuditKeys, setDismissedBpmAuditKeys] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(bpmAuditDismissedStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  });
  const [dismissedBpmAuditPaths, setDismissedBpmAuditPaths] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(bpmAuditDismissedPathStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  });
  const [reviewedBpmAuditKeys, setReviewedBpmAuditKeys] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(bpmAuditReviewedStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  });
  const [isMiniQueueExpanded, setIsMiniQueueExpanded] = useState(false);
  const [miniPlayerExpandedHeight, setMiniPlayerExpandedHeight] = useState(miniPlayerExpandedHeightDefault);
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
  const [pendingTrackFavorites, setPendingTrackFavorites] = useState<string[]>([]);
  const [pendingTrackRatings, setPendingTrackRatings] = useState<string[]>([]);
  const [pendingTrackBpms, setPendingTrackBpms] = useState<string[]>([]);
  const [selectedSmartPlaylistGenres, setSelectedSmartPlaylistGenres] = useState<string[]>([]);
  const [isMaintenanceRunning, setIsMaintenanceRunning] = useState(false);
  const [maintenanceLog, setMaintenanceLog] = useState<string[]>([]);
  const [isLoudnessAnalysisRunning, setIsLoudnessAnalysisRunning] = useState(false);
  const [loudnessAnalysisLog, setLoudnessAnalysisLog] = useState<string[]>([]);
  const [loudnessAnalysisProgress, setLoudnessAnalysisProgress] = useState<LoudnessAnalysisProgress | null>(null);
  const [loudnessAnalysisFailures, setLoudnessAnalysisFailures] = useState<LoudnessAnalysisFailure[]>([]);
  const [missingLibraryRoots, setMissingLibraryRoots] = useState<string[]>([]);
  const [metadataRefreshAlbumKey, setMetadataRefreshAlbumKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [notification, setNotification] = useState<{
    id: number;
    message: string;
    tone: NotificationTone;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  const effectiveTheme: 'light' | 'dark' = isMiniPlayer ? 'dark' : resolvedTheme;
  const customAccentColor = useMemo(() => normalizeAccentColor(data?.settings.accent_color ?? null), [data?.settings.accent_color]);
  const metadataEditMode: MetadataEditMode = data?.settings.metadata_edit_mode ?? 'needle_only';
  const accentTheme = useMemo(
    () => (customAccentColor ? deriveAccentTheme(customAccentColor, effectiveTheme) : null),
    [customAccentColor, effectiveTheme],
  );
  const currentAccentColor = accentTheme?.accent ?? defaultAccentForTheme(effectiveTheme);
  const currentTracksPageSize = normalizeTracksPageSize(data?.settings.tracks_page_size);
  const dismissedBpmAuditKeySet = useMemo(() => new Set(dismissedBpmAuditKeys), [dismissedBpmAuditKeys]);
  const dismissedBpmAuditPathSet = useMemo(() => new Set(dismissedBpmAuditPaths), [dismissedBpmAuditPaths]);
  const reviewedBpmAuditKeySet = useMemo(() => new Set(reviewedBpmAuditKeys), [reviewedBpmAuditKeys]);
  const lastRecordedPath = useRef<string | null>(null);
  const suppressRecordPathRef = useRef<string | null>(null);
  const sessionHydratedRef = useRef(false);
  const scrubPositionRef = useRef<number | null>(null);
  const backendPathRef = useRef<string | null>(null);
  const backendPausedRef = useRef(true);
  const backendIdleRef = useRef(true);
  const albumReturnView = useRef<View>('albums');
  const artistReturnView = useRef<View>('artists');
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);
  const queueDrawerRef = useRef<HTMLElement | null>(null);
  const windowRestoreStateRef = useRef<WindowRestoreState | null>(null);
  const miniQueueResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const notificationIdRef = useRef(0);

  useEffect(() => {
    const message = status.trim();
    if (!message) {
      return;
    }

    if (isPlaybackStatusMessage(message)) {
      setStatus((current) => (current === message ? '' : current));
      return;
    }

    const tone = inferNotificationTone(message);
    const id = notificationIdRef.current + 1;
    notificationIdRef.current = id;
    setNotification({ id, message, tone });
    setStatus((current) => (current === message ? '' : current));
  }, [status]);

  useEffect(() => {
    if (!notification || notification.tone !== 'success') {
      return;
    }

    const dismissTimer =
      window.setTimeout(() => {
        setNotification((current) => (current?.id === notification.id ? null : current));
      }, 4200);

    return () => {
      window.clearTimeout(dismissTimer);
    };
  }, [notification]);

  const syncConfirmedPlaybackState = () => {
    setIsPlaying(
      Boolean(backendPathRef.current) && !backendPausedRef.current && !backendIdleRef.current,
    );
  };

  const openAlbum = (album: string) => {
    albumReturnView.current = view;
    setSelectedAlbum(album);
    setSelectedArtist(null);
    setSelectedPlaylist(null);
    setView('album');
  };

  const openArtist = (artist: string, mode: ArtistBrowseMode = 'all') => {
    artistReturnView.current = view;
    setSelectedArtistProfile(artist);
    setSelectedArtistProfileMode(mode);
    setSelectedAlbum(null);
    setSelectedPlaylist(null);
    setView('artist');
  };

  const openArtistTracks = (artist: string, mode: ArtistBrowseMode = 'all') => {
    setSelectedArtist(artist);
    setSelectedArtistMode(mode);
    setSelectedAlbum(null);
    setSelectedPlaylist(null);
    setView('tracks');
  };

  const clearBrowsingFilters = () => {
    setSelectedAlbum(null);
    setSelectedArtist(null);
    setSelectedPlaylist(null);
  };
  const clearTrackFilters = () => {
    setTrackArtistFilter(allTrackFilterValue);
    setTrackGenreFilter(allTrackFilterValue);
    setTrackYearFromFilter(allTrackFilterValue);
    setTrackYearToFilter(allTrackFilterValue);
  };
  const updateTrackFavorite = async (track: Track, favorite: boolean) => {
    const previousFavorite = track.is_favorite;
    setPendingTrackFavorites((current) =>
      current.includes(track.path) ? current : current.concat(track.path),
    );
    setData((prev) =>
      prev
        ? {
            ...prev,
            library: {
              ...prev.library,
              tracks: prev.library.tracks.map((entry) =>
                entry.path === track.path ? { ...entry, is_favorite: favorite } : entry,
              ),
            },
          }
        : prev,
    );

    try {
      const next = await persistTrackFavorite(track.path, favorite);
      setData(next);
      setStatus(`${favorite ? 'Added favourite' : 'Removed favourite'} · ${track.title}`);
    } catch (error) {
      setData((prev) =>
        prev
          ? {
              ...prev,
              library: {
                ...prev.library,
                tracks: prev.library.tracks.map((entry) =>
                  entry.path === track.path ? { ...entry, is_favorite: previousFavorite } : entry,
                ),
              },
            }
          : prev,
      );
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingTrackFavorites((current) => current.filter((path) => path !== track.path));
    }
  };
  const updateTrackRating = async (track: Track, rating: number | null) => {
    const previousRating = track.rating ?? null;
    setPendingTrackRatings((current) =>
      current.includes(track.path) ? current : current.concat(track.path),
    );
    setData((prev) =>
      prev
        ? {
            ...prev,
            library: {
              ...prev.library,
              tracks: prev.library.tracks.map((entry) =>
                entry.path === track.path ? { ...entry, rating } : entry,
              ),
            },
          }
        : prev,
    );

    try {
      const next = await persistTrackRating(track.path, rating);
      setData(next);
      setStatus(
        rating == null
          ? `Cleared rating · ${track.title}`
          : `Updated rating · ${track.title} · ${formatTrackRatingLabel(rating)}`,
      );
    } catch (error) {
      setData((prev) =>
        prev
          ? {
              ...prev,
              library: {
                ...prev.library,
                tracks: prev.library.tracks.map((entry) =>
                  entry.path === track.path ? { ...entry, rating: previousRating } : entry,
                ),
              },
            }
          : prev,
      );
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingTrackRatings((current) => current.filter((path) => path !== track.path));
    }
  };
  const adjustTrackBpmValue = async (track: Track, adjustment: TrackBpmAdjustment) => {
    setPendingTrackBpms((current) =>
      current.includes(track.path) ? current : current.concat(track.path),
    );

    try {
      const next =
        metadataEditMode === 'needle_only'
          ? await persistTrackBpmAdjustment(track.path, adjustment)
          : await (() => {
              if (adjustment === 'reset') {
                throw new Error('Reset is only available while Needle-only BPM edits are active');
              }
              if (track.bpm == null || track.bpm <= 0) {
                throw new Error('No BPM available for this track');
              }
              const nextBpm =
                adjustment === 'double'
                  ? Math.max(1, track.bpm * 2)
                  : Math.max(1, Math.round(track.bpm / 2));
              return persistTrackBpmValue(track.path, nextBpm, metadataEditMode);
            })();
      setData(next);
      setStatus(
        metadataEditMode === 'write_to_files'
          ? `Updated file BPM · ${track.title}`
          : adjustment === 'reset'
            ? `Reset BPM correction · ${track.title}`
            : `${adjustment === 'double' ? 'Doubled' : 'Halved'} BPM · ${track.title}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingTrackBpms((current) => current.filter((path) => path !== track.path));
    }
  };
  const saveExactTrackBpmValue = async (editorState: TrackBpmEditorState, bpm: number) => {
    const { track, dismissFromAudit } = editorState;
    setPendingTrackBpms((current) =>
      current.includes(track.path) ? current : current.concat(track.path),
    );

    try {
      setBusy('Saving BPM…');
      const next = await persistTrackBpmValue(track.path, bpm, metadataEditMode);
      const shouldAdvance = dismissFromAudit && track.path === currentBpmAuditReviewPath;
      const updatedTrack = next.library.tracks.find((entry) => entry.path === track.path) ?? { ...track, bpm };
      const nextReviewTrack =
        shouldAdvance
          ? bpmAuditItems[bpmAuditItems.findIndex((entry) => entry.track.path === track.path) + 1]?.track ?? null
          : null;
      setData(next);
      if (dismissFromAudit) {
        const reviewedKey = bpmAuditDismissalKey(updatedTrack);
        setReviewedBpmAuditKeys((current) => (current.includes(reviewedKey) ? current : current.concat(reviewedKey)));
      }
      setTrackBpmEditor(null);
      setStatus(
        `${metadataEditMode === 'write_to_files' ? 'Updated file BPM' : 'Saved BPM correction'} · ${track.title}`,
      );
      if (shouldAdvance && nextReviewTrack) {
        void startBpmAuditReview(nextReviewTrack);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      setPendingTrackBpms((current) => current.filter((path) => path !== track.path));
    }
  };
  const resizeMiniPlayerWindow = async (height: number) => {
    const appWindow = getCurrentWindow();
    await appWindow.setSize(new LogicalSize(miniPlayerBaseSize.width, height));
  };
  const enterMiniPlayer = async () => {
    try {
      const appWindow = getCurrentWindow();
      if (!windowRestoreStateRef.current) {
        const [size, alwaysOnTop, resizable] = await Promise.all([
          appWindow.innerSize(),
          appWindow.isAlwaysOnTop(),
          appWindow.isResizable(),
        ]);
        windowRestoreStateRef.current = {
          size: { width: size.width, height: size.height },
          alwaysOnTop,
          resizable,
        };
      }
      setIsQueueOpen(false);
      setIsDeviceMenuOpen(false);
      setIsMiniQueueExpanded(false);
      setMiniPlayerExpandedHeight(miniPlayerExpandedHeightDefault);
      await appWindow.setResizable(false);
      await appWindow.setSize(new LogicalSize(miniPlayerBaseSize.width, miniPlayerBaseSize.height));
      await appWindow.setAlwaysOnTop(isMiniPlayerPinned);
      setIsMiniPlayer(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const exitMiniPlayer = async (options?: { quiet?: boolean }) => {
    try {
      const appWindow = getCurrentWindow();
      const restoreState = windowRestoreStateRef.current;
      setIsMiniQueueExpanded(false);
      setIsMiniPlayer(false);
      await appWindow.setAlwaysOnTop(restoreState?.alwaysOnTop ?? false);
      await appWindow.setResizable(restoreState?.resizable ?? true);
      if (restoreState) {
        await appWindow.setSize(new PhysicalSize(restoreState.size.width, restoreState.size.height));
      }
      windowRestoreStateRef.current = null;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const toggleMiniPlayerPinned = async () => {
    const nextPinned = !isMiniPlayerPinned;
    setIsMiniPlayerPinned(nextPinned);
    if (!isMiniPlayer) return;
    try {
      await getCurrentWindow().setAlwaysOnTop(nextPinned);
      setStatus(nextPinned ? 'Mini player pinned' : 'Mini player unpinned');
    } catch (error) {
      setIsMiniPlayerPinned(!nextPinned);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const toggleMiniQueueExpanded = async () => {
    const nextExpanded = !isMiniQueueExpanded;
    setIsMiniQueueExpanded(nextExpanded);
    if (!isMiniPlayer) return;
    try {
      await resizeMiniPlayerWindow(nextExpanded ? miniPlayerExpandedHeight : miniPlayerBaseSize.height);
    } catch (error) {
      setIsMiniQueueExpanded(!nextExpanded);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const startMiniPlayerWindowDrag = async () => {
    try {
      await getCurrentWindow().startDragging();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const startMiniQueueResize = (clientY: number) => {
    miniQueueResizeRef.current = {
      startY: clientY,
      startHeight: miniPlayerExpandedHeight,
    };
  };
  const updateTrackYearFromFilter = (value: TrackYearBoundaryFilter) => {
    setTrackYearFromFilter(value);
    if (
      value !== allTrackFilterValue &&
      trackYearToFilter !== allTrackFilterValue &&
      Number(value) > Number(trackYearToFilter)
    ) {
      setTrackYearToFilter(value);
    }
  };
  const updateTrackYearToFilter = (value: TrackYearBoundaryFilter) => {
    setTrackYearToFilter(value);
    if (
      value !== allTrackFilterValue &&
      trackYearFromFilter !== allTrackFilterValue &&
      Number(value) < Number(trackYearFromFilter)
    ) {
      setTrackYearFromFilter(value);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const dispose = await listen<{ name: string; data: unknown }>(
        'mpv-property',
        (event) => {
          const { name, data } = event.payload;
          if (name === 'path') {
            const path = typeof data === 'string' ? data : null;
            backendPathRef.current = path;
            backendIdleRef.current = path == null;
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
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [queuePaths]);

  useEffect(() => {
    void (async () => {
      try {
        const [bootstrapResult, runtimeInfoResult] = await Promise.allSettled([
          bootstrapApp(),
          getRuntimeInfo(),
        ]);

        if (bootstrapResult.status === 'rejected') {
          throw bootstrapResult.reason;
        }

        setData(bootstrapResult.value);
        if (runtimeInfoResult.status === 'fulfilled') {
          setRuntimeInfo(runtimeInfoResult.value);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!data) {
      setMissingLibraryRoots([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const missingRoots = await getMissingLibraryRoots();
        if (!cancelled) {
          setMissingLibraryRoots(missingRoots);
        }
      } catch {
        if (!cancelled) {
          setMissingLibraryRoots([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data?.settings.library_roots]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const dispose = await listen<string>('maintenance-log', (event) => {
        const message = typeof event.payload === 'string' ? event.payload.trim() : '';
        if (!message) {
          return;
        }

        setMaintenanceLog((current) => [...current.slice(-79), formatMaintenanceLogLine(message)]);
      });
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const dispose = await listen<LoudnessAnalysisProgress>('loudness-analysis-progress', (event) => {
        const payload = event.payload;
        if (!payload || typeof payload !== 'object') {
          return;
        }

        setLoudnessAnalysisProgress(payload);
        if (payload.failed_path && payload.failed_reason) {
          const failedPath = payload.failed_path;
          const failedReason = payload.failed_reason;
          setLoudnessAnalysisFailures((current) => {
            if (current.some((entry) => entry.path === failedPath)) {
              return current;
            }
            return [
              ...current,
              {
                path: failedPath,
                reason: failedReason,
              },
            ];
          });
        }
      });
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const dispose = await listen<string>('loudness-analysis-log', (event) => {
        const message = typeof event.payload === 'string' ? event.payload.trim() : '';
        if (!message) {
          return;
        }

        setLoudnessAnalysisLog((current) => [...current.slice(-79), formatMaintenanceLogLine(message)]);
      });
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(miniPlayerPinnedStorageKey, String(isMiniPlayerPinned));
  }, [isMiniPlayerPinned]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = miniQueueResizeRef.current;
      if (!resizeState || !isMiniPlayer || !isMiniQueueExpanded) return;

      const nextHeight = Math.max(
        miniPlayerExpandedHeightMin,
        Math.min(miniPlayerExpandedHeightMax, resizeState.startHeight + (event.clientY - resizeState.startY)),
      );
      setMiniPlayerExpandedHeight(nextHeight);
      void resizeMiniPlayerWindow(nextHeight);
    };

    const handlePointerUp = () => {
      miniQueueResizeRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isMiniPlayer, isMiniQueueExpanded]);

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
    let cancelled = false;

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const [size, resizable, scaleFactor] = await Promise.all([
          appWindow.innerSize(),
          appWindow.isResizable(),
          appWindow.scaleFactor(),
        ]);
        if (cancelled || isMiniPlayer) return;
        const logicalSize = size.toLogical(scaleFactor);

        const isMiniSized =
          Math.round(logicalSize.width) === miniPlayerBaseSize.width &&
          Math.round(logicalSize.height) >= miniPlayerBaseSize.height &&
          Math.round(logicalSize.height) <= miniPlayerExpandedHeightMax;

        if (!resizable || isMiniSized) {
          await appWindow.setAlwaysOnTop(false);
          await appWindow.setResizable(true);
          if (isMiniSized) {
            await appWindow.setSize(new LogicalSize(1440, 960));
          }
          windowRestoreStateRef.current = null;
        }
      } catch {
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isMiniPlayer]);

  useEffect(() => {
    if (!data) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const t = data.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : data.settings.theme;
      setResolvedTheme(t);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [data]);

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
  }, [effectiveTheme]);

  useEffect(() => {
    if (!data) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await applyVolumeLevelingForTrack(currentPath);
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    currentPath,
    data?.settings.last_loudness_analysis_at,
    data?.settings.volume_leveling_enabled,
  ]);

  useEffect(() => {
    const rootStyle = document.documentElement.style;
    if (!accentTheme) {
      rootStyle.removeProperty('--accent');
      rootStyle.removeProperty('--accent-2');
      rootStyle.removeProperty('--row-hover');
      rootStyle.removeProperty('--row-current');
      rootStyle.removeProperty('--accent-contrast');
      return;
    }

    rootStyle.setProperty('--accent', accentTheme.accent);
    rootStyle.setProperty('--accent-2', accentTheme.accent2);
    rootStyle.setProperty('--row-hover', accentTheme.rowHover);
    rootStyle.setProperty('--row-current', accentTheme.rowCurrent);
    rootStyle.setProperty('--accent-contrast', accentTheme.accentContrast);
  }, [accentTheme]);

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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(bpmAuditDismissedStorageKey, JSON.stringify(dismissedBpmAuditKeys));
  }, [dismissedBpmAuditKeys]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(bpmAuditDismissedPathStorageKey, JSON.stringify(dismissedBpmAuditPaths));
  }, [dismissedBpmAuditPaths]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(bpmAuditReviewedStorageKey, JSON.stringify(reviewedBpmAuditKeys));
  }, [reviewedBpmAuditKeys]);

  const allTracks = data?.library.tracks ?? [];
  const rawBpmAuditItems = useMemo(() => findSuspiciousBpmTracks(allTracks), [allTracks]);
  const bpmAuditItems = useMemo(
    () =>
      rawBpmAuditItems.filter(
        (item) =>
          !dismissedBpmAuditKeySet.has(bpmAuditDismissalKey(item.track)) &&
          !dismissedBpmAuditPathSet.has(item.track.path) &&
          !reviewedBpmAuditKeySet.has(bpmAuditDismissalKey(item.track)),
      ),
    [dismissedBpmAuditKeySet, dismissedBpmAuditPathSet, rawBpmAuditItems, reviewedBpmAuditKeySet],
  );
  const dismissedBpmAuditCount = rawBpmAuditItems.length - bpmAuditItems.length;
  const bpmAuditTrackPaths = useMemo(
    () => bpmAuditItems.map((item) => item.track.path),
    [bpmAuditItems],
  );
  const bpmAuditTrackPathSet = useMemo(() => new Set(bpmAuditTrackPaths), [bpmAuditTrackPaths]);
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
  const dashboardPlaylistSections = useMemo(() => {
    const byId = new Map(smartPlaylists.map((playlist) => [playlist.id, playlist]));
    const signaturePlaylists = smartPlaylists.filter((playlist) => playlist.id.startsWith('signature:'));
    const section = (
      id: string,
      title: string,
      entries: Array<AutoPlaylist | null | undefined>,
    ): DashboardPlaylistSection | null => {
      const playlists = entries.filter((entry): entry is AutoPlaylist => Boolean(entry));
      return playlists.length > 0 ? { id, title, playlists } : null;
    };

    return [
      section('library', 'From your library', [
        byId.get('library:favorites'),
        byId.get('ratings:top-rated'),
        byId.get('history:most-played'),
        byId.get('history:recent'),
      ]),
      section('signatures', 'Library signatures', signaturePlaylists),
      section('vibes', 'Vibes', [
        byId.get('vibes:wind-down'),
        byId.get('vibes:cruise-and-groove'),
        byId.get('vibes:lift-and-energy'),
        byId.get('vibes:get-on-your-feet'),
      ]),
    ].filter((entry): entry is DashboardPlaylistSection => Boolean(entry));
  }, [smartPlaylists]);

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
      description: playlist.rule
        ? formatPlaylistRuleSummary(playlist.rule)
        : `${tracks.length} saved track${tracks.length === 1 ? '' : 's'}`,
      tracks,
      saved: playlist,
    };
  }, [manualPlaylists, selectedPlaylist, smartPlaylists, trackByPath]);
  const selectedManualPlaylist =
    selectedPlaylistData?.kind === 'manual' ? selectedPlaylistData.saved ?? null : null;
  const selectedSmartPlaylist = selectedPlaylistData?.kind === 'smart' ? selectedPlaylistData : null;
  const smartPlaylistGenreOptions = useMemo<SmartPlaylistGenreOption[]>(() => {
    if (!selectedSmartPlaylist) return [];

    const genres = new Map<string, SmartPlaylistGenreOption>();
    for (const track of selectedSmartPlaylist.tracks) {
      for (const genre of splitTrackGenreEntries(effectiveTrackGenre(track))) {
        const key = genre.key;
        const existing = genres.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          genres.set(key, { key, label: genre.label, count: 1 });
        }
      }
    }

    return Array.from(genres.values()).sort(
      (a, b) => b.count - a.count || compareText(a.label, b.label),
    );
  }, [selectedSmartPlaylist]);
  const playlistMode = Boolean(selectedPlaylistData);

  const scopedTracks = useMemo(() => {
    let list: Track[] = selectedPlaylistData ? selectedPlaylistData.tracks : allTracks;
    if (selectedAlbum) list = list.filter((t) => trackAlbumKey(t) === selectedAlbum);
    if (selectedArtist) list = list.filter((t) => artistNameForTrack(t, selectedArtistMode) === selectedArtist);
    return list;
  }, [allTracks, selectedAlbum, selectedArtist, selectedArtistMode, selectedPlaylistData]);
  const trackArtistOptions = useMemo(
    () => uniqueSorted(scopedTracks.map((track) => track.artist ?? '').filter(Boolean)),
    [scopedTracks],
  );
  const libraryGenreOptions = useMemo(
    () => uniqueSorted(allTracks.flatMap((track) => splitTrackGenres(effectiveTrackGenre(track)))),
    [allTracks],
  );
  const trackGenreOptions = useMemo(
    () => uniqueSorted(scopedTracks.flatMap((track) => splitTrackGenres(effectiveTrackGenre(track)))),
    [scopedTracks],
  );
  const trackYearOptions = useMemo(
    () =>
      Array.from(new Set(scopedTracks.map((track) => track.year).filter((year): year is number => year != null)))
        .sort((a, b) => a - b)
        .map(String),
    [scopedTracks],
  );
  const filteredTracks = useMemo(() => {
    let list = scopedTracks;
    if (selectedSmartPlaylist && selectedSmartPlaylistGenres.length > 0) {
      list = list.filter((track) => {
        const trackGenres = splitTrackGenreKeys(effectiveTrackGenre(track));
        return trackGenres.some((genre) => selectedSmartPlaylistGenres.includes(genre));
      });
    }
    if (!playlistMode && trackArtistFilter !== allTrackFilterValue) {
      list = list.filter((track) => (track.artist ?? '') === trackArtistFilter);
    }
    const expectedTrackGenre = trackGenreFilter !== allTrackFilterValue ? normalizeGenreKey(trackGenreFilter) : null;
    if (!playlistMode && trackGenreFilter !== allTrackFilterValue) {
      list = list.filter((track) =>
        expectedTrackGenre ? splitTrackGenreKeys(effectiveTrackGenre(track)).includes(expectedTrackGenre) : true,
      );
    }
    const startYear = playlistMode ? null : yearFilterNumber(trackYearFromFilter);
    const endYear = playlistMode ? null : yearFilterNumber(trackYearToFilter);
    if (!playlistMode && (startYear != null || endYear != null)) {
      list = list.filter((track) => {
        if (track.year == null) return false;
        if (startYear != null && track.year < startYear) return false;
        if (endYear != null && track.year > endYear) return false;
        return true;
      });
    }
    if (!selectedSmartPlaylist && search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.artist ?? '').toLowerCase().includes(q) ||
          (t.album ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [
    playlistMode,
    scopedTracks,
    trackArtistFilter,
    trackGenreFilter,
    trackYearFromFilter,
    trackYearToFilter,
    search,
    selectedSmartPlaylist,
    selectedSmartPlaylistGenres,
  ]);
  const sortedTracks = useMemo(() => {
    if (selectedPlaylistData) {
      return filteredTracks;
    }
    return filteredTracks.slice().sort(compareTracksBySort(trackSort));
  }, [filteredTracks, selectedPlaylistData, trackSort]);

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

  useEffect(() => {
    setSelectedSmartPlaylistGenres([]);
  }, [selectedSmartPlaylist?.id]);

  useEffect(() => {
    if (!selectedSmartPlaylist) {
      setSelectedSmartPlaylistGenres([]);
      return;
    }

    setSelectedSmartPlaylistGenres((current) =>
      current.filter((genre) => smartPlaylistGenreOptions.some((option) => option.key === genre)),
    );
  }, [selectedSmartPlaylist, smartPlaylistGenreOptions]);

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
        if (existing.year == null && t.year != null) {
          existing.year = t.year;
        }
        if (t.is_vinyl_rip) {
          existing.is_vinyl_rip = true;
        }
      } else {
        map.set(key, {
          key,
          album: t.album,
          artist: albumArtistForTrack(t),
          year: t.year ?? null,
          count: 1,
          samplePath: t.path,
          is_vinyl_rip: t.is_vinyl_rip,
          addedAt: t.added_at ?? null,
        });
      }
    }
    return Array.from(map.values());
  }, [allTracks]);
  const sortedAlbums = useMemo(() => {
    return albums.slice().sort((a, b) => {
      if (albumSort === 'artist') {
        return (
          compareText(a.artist, b.artist) ||
          compareText(a.album, b.album) ||
          compareText(a.key, b.key)
        );
      }
      if (albumSort === 'recent') {
        return (
          timestampValue(b.addedAt) - timestampValue(a.addedAt) ||
          compareText(a.album, b.album) ||
          compareText(a.key, b.key)
        );
      }
      if (albumSort === 'tracks') {
        return (
          b.count - a.count ||
          compareText(a.album, b.album) ||
          compareText(a.key, b.key)
        );
      }
      return (
        compareText(a.album, b.album) ||
        compareText(a.artist, b.artist) ||
        compareText(a.key, b.key)
      );
    });
  }, [albumSort, albums]);

  const recentAlbums = useMemo(() => {
    const withDate = albums.filter((a) => Boolean(a.addedAt));
    if (withDate.length === 0) return [];
    return withDate.slice().sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? '')).slice(0, 5);
  }, [albums]);

  const artistSummaries = useMemo(() => {
    const allMap = new Map<string, { count: number; addedAt: string | null; albumKeys: Set<string>; samplePath: string }>();
    const albumMap = new Map<string, { count: number; addedAt: string | null; albumKeys: Set<string>; samplePath: string }>();

    const updateSummaryMap = (
      map: Map<string, { count: number; addedAt: string | null; albumKeys: Set<string>; samplePath: string }>,
      artist: string | null,
      track: Track,
      albumKeyValue: string | null,
    ) => {
      if (!artist) return;
      const existing = map.get(artist);
      if (existing) {
        existing.count += 1;
        if (albumKeyValue) {
          existing.albumKeys.add(albumKeyValue);
        }
        if (track.added_at && (!existing.addedAt || track.added_at > existing.addedAt)) {
          existing.addedAt = track.added_at;
        }
        return;
      }

      map.set(artist, {
        count: 1,
        addedAt: track.added_at ?? null,
        albumKeys: new Set(albumKeyValue ? [albumKeyValue] : []),
        samplePath: track.path,
      });
    };

    for (const track of allTracks) {
      const albumKeyValue = trackAlbumKey(track);
      updateSummaryMap(allMap, artistNameForTrack(track, 'all'), track, albumKeyValue);
      updateSummaryMap(albumMap, artistNameForTrack(track, 'album'), track, albumKeyValue);
    }

    const toSummaries = (
      map: Map<string, { count: number; addedAt: string | null; albumKeys: Set<string>; samplePath: string }>,
    ): ArtistSummary[] =>
      Array.from(map.entries()).map(([artist, meta]) => ({
        artist,
        count: meta.count,
        albumCount: meta.albumKeys.size,
        samplePath: meta.samplePath,
        addedAt: meta.addedAt,
      }));

    return {
      all: toSummaries(allMap),
      album: toSummaries(albumMap),
    };
  }, [allTracks]);
  const allArtists = artistSummaries.all;
  const albumArtists = artistSummaries.album;
  const artists = artistBrowseMode === 'album' ? albumArtists : allArtists;
  const filteredArtists = useMemo(() => {
    if (!artistSearch.trim()) return artists;
    const query = artistSearch.trim().toLowerCase();
    return artists.filter((artist) => artist.artist.toLowerCase().includes(query));
  }, [artistSearch, artists]);
  const sortedArtists = useMemo(() => {
    return filteredArtists.slice().sort((a, b) => {
      if (artistSort === 'tracks') {
        return (
          b.count - a.count ||
          compareText(a.artist, b.artist)
        );
      }
      if (artistSort === 'recent') {
        return (
          timestampValue(b.addedAt) - timestampValue(a.addedAt) ||
          compareText(a.artist, b.artist)
        );
      }
      return compareText(a.artist, b.artist);
    });
  }, [artistSort, filteredArtists]);

  const currentTrack = useMemo(
    () => (currentPath ? trackByPath.get(currentPath) ?? null : currentQueueTrack),
    [currentPath, currentQueueTrack, trackByPath],
  );
  const currentBpmAuditReviewPath =
    currentTrack && bpmAuditTrackPathSet.has(currentTrack.path) ? currentTrack.path : null;
  const currentTrackFavoritePending = currentTrack ? pendingTrackFavorites.includes(currentTrack.path) : false;
  const activeTrack = useMemo(
    () => (currentPath ? trackByPath.get(currentPath) ?? currentQueueTrack ?? null : null),
    [currentPath, currentQueueTrack, trackByPath],
  );
  const selectedAlbumSummary = useMemo(
    () => albums.find((album) => album.key === selectedAlbum) ?? null,
    [albums, selectedAlbum],
  );
  const selectedArtistProfileSummary = useMemo(
    () =>
      (selectedArtistProfileMode === 'album' ? albumArtists : allArtists).find(
        (artist) => artist.artist === selectedArtistProfile,
      ) ?? null,
    [albumArtists, allArtists, selectedArtistProfile, selectedArtistProfileMode],
  );
  const visibleTracksForPlaylist = selectedManualPlaylist ? filteredTracks : sortedTracks;
  const playlistSourceTrackIndices = useMemo(() => {
    if (!selectedManualPlaylist || !selectedPlaylistData) return [] as number[];
    const indicesByPath = new Map<string, number[]>();
    selectedPlaylistData.tracks.forEach((track, index) => {
      const existing = indicesByPath.get(track.path);
      if (existing) {
        existing.push(index);
      } else {
        indicesByPath.set(track.path, [index]);
      }
    });
    const seenByPath = new Map<string, number>();
    return visibleTracksForPlaylist.map((track) => {
      const seenCount = seenByPath.get(track.path) ?? 0;
      const matches = indicesByPath.get(track.path) ?? [];
      seenByPath.set(track.path, seenCount + 1);
      return matches[seenCount] ?? -1;
    });
  }, [selectedManualPlaylist, selectedPlaylistData, visibleTracksForPlaylist]);
  const tracksTotalCount = visibleTracksForPlaylist.length;
  const tracksPageCount = Math.max(1, Math.ceil(tracksTotalCount / currentTracksPageSize));
  const tracksPageStartIndex = (tracksPage - 1) * currentTracksPageSize;
  const pagedTracks = useMemo(
    () => visibleTracksForPlaylist.slice(tracksPageStartIndex, tracksPageStartIndex + currentTracksPageSize),
    [currentTracksPageSize, tracksPageStartIndex, visibleTracksForPlaylist],
  );
  const pagedPlaylistSourceTrackIndices = useMemo(
    () => playlistSourceTrackIndices.slice(tracksPageStartIndex, tracksPageStartIndex + currentTracksPageSize),
    [currentTracksPageSize, playlistSourceTrackIndices, tracksPageStartIndex],
  );
  const playlistSourceTotalCount =
    selectedPlaylistData?.kind === 'manual' ? selectedPlaylistData.tracks.length : undefined;
  const smartPlaylistHasGenreFocus =
    selectedSmartPlaylist != null && selectedSmartPlaylistGenres.length > 0;
  const yearFilterSummary = playlistMode ? null : formatTrackYearRange(trackYearFromFilter, trackYearToFilter);
  const hasTrackFilters =
    (!playlistMode && trackArtistFilter !== allTrackFilterValue) ||
    (!playlistMode && trackGenreFilter !== allTrackFilterValue) ||
    yearFilterSummary !== null;
  const activeTrackFilterSummary = [
    !playlistMode && trackArtistFilter !== allTrackFilterValue ? trackArtistFilter : null,
    !playlistMode && trackGenreFilter !== allTrackFilterValue ? trackGenreFilter : null,
    yearFilterSummary,
  ]
    .filter(Boolean)
    .join(' · ');
  const selectedPlaylistActionTracks = selectedPlaylistData
    ? dedupeTracksByPath(visibleTracksForPlaylist)
    : [];
  const isSelectedPlaylistActive =
    Boolean(currentPath) &&
    selectedPlaylistActionTracks.length > 0 &&
    selectedPlaylistActionTracks.length === baseQueueTracks.length &&
    selectedPlaylistActionTracks.every((track, index) => baseQueueTracks[index]?.path === track.path) &&
    selectedPlaylistActionTracks.some((track) => track.path === currentPath);
  const selectedPlaylistPrimaryActionLabel = !selectedPlaylistData
    ? '▶ Play'
    : isSelectedPlaylistActive
      ? isPlaying
        ? '⏸ Pause'
        : '▶ Resume'
      : '▶ Play';

  useEffect(() => {
    setTracksPage(1);
  }, [
    view,
    search,
    trackSort,
    trackArtistFilter,
    trackGenreFilter,
    trackYearFromFilter,
    trackYearToFilter,
    selectedAlbum,
    selectedArtist,
    selectedArtistMode,
    selectedPlaylist?.kind,
    selectedPlaylist?.id,
    selectedSmartPlaylistGenres,
  ]);

  useEffect(() => {
    setTracksPage((current) => Math.min(Math.max(current, 1), tracksPageCount));
  }, [tracksPageCount]);

  const selectedRawOutputDevice = useMemo(
    () => audioDevices.find((device) => device.name === selectedAudioDevice) ?? null,
    [audioDevices, selectedAudioDevice],
  );
  const selectedOutputDeviceKey = audioDeviceKey(
    selectedRawOutputDevice?.description ??
      (selectedAudioDevice === 'auto' ? defaultAudioDevice.description : selectedAudioDevice),
  );
  const currentAlbum = activeTrack?.album ?? null;
  const currentAlbumKey = activeTrack ? trackAlbumKey(activeTrack) : null;
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
    const normalizedSettings = {
      ...next,
      accent_color: normalizeAccentColor(next.accent_color),
      tracks_page_size: normalizeTracksPageSize(next.tracks_page_size),
    };
    setData({ ...data, settings: normalizedSettings });
    try {
      await saveSettings(normalizedSettings);
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
      setIsMaintenanceRunning(true);
      setMaintenanceLog([formatMaintenanceLogLine('Queued maintenance run…')]);
      setBusy('Running maintenance…');
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const next = await runMaintenance();
      setData(next);
      setStatus(`Library synced · ${next.library.track_count} tracks`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMaintenanceLog((current) => [
        ...current.slice(-79),
        formatMaintenanceLogLine(`Maintenance failed · ${message}`),
      ]);
      setStatus(message);
    } finally {
      setIsMaintenanceRunning(false);
      setBusy(null);
    }
  };

  const analyzeLoudness = async () => {
    try {
      setIsLoudnessAnalysisRunning(true);
      setLoudnessAnalysisLog([formatMaintenanceLogLine('Queued loudness analysis…')]);
      setLoudnessAnalysisProgress(null);
      setLoudnessAnalysisFailures([]);
      setBusy('Analyzing loudness…');
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const next = await runLoudnessAnalysis();
      setData(next);
      setStatus('Volume leveling analysis finished');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoudnessAnalysisLog((current) => [
        ...current.slice(-79),
        formatMaintenanceLogLine(`Loudness analysis failed · ${message}`),
      ]);
      setStatus(message);
    } finally {
      setIsLoudnessAnalysisRunning(false);
      setBusy(null);
    }
  };

  const copyLoudnessAnalysisFailures = async () => {
    if (loudnessAnalysisFailures.length === 0) {
      return;
    }

    try {
      const payload = loudnessAnalysisFailures
        .map((entry) => `${entry.path}${entry.reason ? ` — ${entry.reason}` : ''}`)
        .join('\n');
      await navigator.clipboard.writeText(payload);
      setStatus(
        loudnessAnalysisFailures.length === 1
          ? 'Copied 1 failed file path'
          : `Copied ${loudnessAnalysisFailures.length} failed file paths`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshAlbumMetadata = async (
    album: string,
    albumArtist: string | null,
    albumKeyValue: string,
  ) => {
    try {
      setMetadataRefreshAlbumKey(albumKeyValue);
      setBusy('Refreshing MusicBrainz metadata…');
      setStatus(`Refreshing metadata for ${album}`);
      const result = await refreshAlbumMetadataFromMusicBrainz(album, albumArtist);
      setData(result.bootstrap);
      if (result.status === 'matched') {
        setSelectedAlbum(albumKey(result.release_title ?? album, result.release_artist ?? albumArtist));
      }
      if (result.status === 'matched') {
        setStatus(
          `Metadata updated from MusicBrainz · ${result.updated_track_count} track${
            result.updated_track_count === 1 ? '' : 's'
          } refined`,
        );
      } else if (result.status === 'ambiguous') {
        setStatus('Multiple MusicBrainz releases looked plausible · imported tags left untouched');
      } else if (result.status === 'no_match') {
        setStatus('No confident MusicBrainz match found');
      } else {
        setStatus(result.message);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setMetadataRefreshAlbumKey(null);
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

  const createManualPlaylist = async (
    name: string,
    trackPaths: string[],
    rule?: SavedPlaylistRule | null,
  ) => {
    try {
      setBusy('Saving playlist…');
      const next = await createPlaylist(name, trackPaths, rule);
      setData(next);
      const created = next.playlists
        .filter((playlist) => playlist.name === name)
        .sort((a, b) => b.id - a.id)[0];
      if (created) {
        setSelectedPlaylist({ kind: 'manual', id: created.id });
        setView('tracks');
      }
      setStatus(rule ? `Saved auto playlist · ${name}` : `Saved playlist · ${name}`);
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const promptPlaylistName = (initialValue: string) => {
    const value = window.prompt('Playlist name', initialValue)?.trim();
    return value ? value : null;
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
  const tracksForAlbum = (albumKeyValue: string) =>
    allTracks
      .filter((t) => trackAlbumKey(t) === albumKeyValue)
      .slice()
      .sort(compareAlbumTracks);

  const currentPlaylistSource = useMemo<PlaylistCreateSource | null>(() => {
    const currentTrackRule: SavedPlaylistRule | null =
      view === 'tracks' && !selectedPlaylistData
        ? (() => {
            const searchValue = normalizePlaylistRuleText(search);
            const artistValue =
              trackArtistFilter !== allTrackFilterValue
                ? trackArtistFilter
                : selectedArtist && selectedArtistMode === 'all'
                  ? selectedArtist
                  : null;
            const genreValue = trackGenreFilter !== allTrackFilterValue ? trackGenreFilter : null;
            const yearFromValue = yearFilterNumber(trackYearFromFilter);
            const yearToValue = yearFilterNumber(trackYearToFilter);
            if (!searchValue && !artistValue && !genreValue && yearFromValue == null && yearToValue == null) {
              return null;
            }
            return {
              kind: 'filtered_library',
              search: searchValue,
              artist: artistValue,
              genre: genreValue,
              year_from: yearFromValue,
              year_to: yearToValue,
            };
          })()
        : null;

    if (view === 'album' && selectedAlbumSummary) {
      const albumTracks = tracksForAlbum(selectedAlbumSummary.key);
      return {
        id: 'album',
        label: selectedAlbumSummary.album,
        description: `${albumTracks.length} track${albumTracks.length === 1 ? '' : 's'} from this album`,
        suggestedName: selectedAlbumSummary.album,
        tracks: albumTracks,
        rule: null,
      };
    }

    if (view === 'tracks' && filteredTracks.length > 0) {
      if (selectedPlaylistData) {
        return {
          id: 'current-playlist',
          label: selectedPlaylistData.name,
          description: `${visibleTracksForPlaylist.length} track${visibleTracksForPlaylist.length === 1 ? '' : 's'} from this ${selectedPlaylistData.kind === 'smart' ? 'smart ' : ''}playlist`,
          suggestedName:
            selectedPlaylistData.kind === 'manual'
              ? `${selectedPlaylistData.name} copy`
              : selectedPlaylistData.name,
          tracks: visibleTracksForPlaylist,
          rule: null,
        };
      }
      if (selectedArtist) {
        return {
          id: 'artist',
          label: activeTrackFilterSummary ? `${selectedArtist} · filtered` : selectedArtist,
          description: `${visibleTracksForPlaylist.length} track${visibleTracksForPlaylist.length === 1 ? '' : 's'} by this artist${activeTrackFilterSummary ? ` · ${activeTrackFilterSummary}` : ''}`,
          suggestedName: activeTrackFilterSummary ? `${selectedArtist} mix` : `${selectedArtist} mix`,
          tracks: visibleTracksForPlaylist,
          rule: currentTrackRule,
        };
      }
      if (hasTrackFilters) {
        return {
          id: 'filtered-tracks',
          label: 'Filtered tracks',
          description: `${visibleTracksForPlaylist.length} track${visibleTracksForPlaylist.length === 1 ? '' : 's'} · ${activeTrackFilterSummary}`,
          suggestedName: `${activeTrackFilterSummary} mix`,
          tracks: visibleTracksForPlaylist,
          rule: currentTrackRule,
        };
      }
      if (search.trim()) {
        const query = search.trim();
        return {
          id: 'search',
          label: `Search: ${query}`,
          description: `${visibleTracksForPlaylist.length} matching track${visibleTracksForPlaylist.length === 1 ? '' : 's'}`,
          suggestedName: `${query} mix`,
          tracks: visibleTracksForPlaylist,
          rule: currentTrackRule,
        };
      }
      return {
        id: 'tracks',
        label: 'All tracks',
        description: `${visibleTracksForPlaylist.length} track${visibleTracksForPlaylist.length === 1 ? '' : 's'} from your library`,
        suggestedName: `Playlist ${new Date().toLocaleDateString()}`,
        tracks: visibleTracksForPlaylist,
        rule: null,
      };
    }

    return null;
  }, [
    filteredTracks.length,
    hasTrackFilters,
    search,
    activeTrackFilterSummary,
    selectedAlbumSummary,
    selectedArtist,
    selectedArtistMode,
    selectedPlaylistData,
    trackArtistFilter,
    trackGenreFilter,
    trackYearFromFilter,
    trackYearToFilter,
    view,
    visibleTracksForPlaylist,
  ]);
  const openPlaylistComposer = (preferredSource: 'current' | 'custom' = 'current') => {
    const sortedLibraryTracks = allTracks.slice().sort(compareTracksBySort(trackSort));
    if (sortedLibraryTracks.length === 0) {
      setStatus('No tracks available to turn into a playlist yet');
      return;
    }

    const dedupedCurrentSource =
      currentPlaylistSource &&
      !(
        currentPlaylistSource.tracks.length === sortedLibraryTracks.length &&
        currentPlaylistSource.tracks.every((track, index) => track.path === sortedLibraryTracks[index]?.path)
      )
        ? currentPlaylistSource
        : null;
    const sources = [
      dedupedCurrentSource,
      {
        id: 'custom',
        label: 'Filtered library',
        description: 'Build a playlist from artist and genre filters.',
        suggestedName: 'Filtered mix',
        tracks: sortedLibraryTracks,
        rule: null,
      },
    ].filter((source): source is PlaylistCreateSource => Boolean(source));
    const artistOptions = Array.from(
      new Set(sortedLibraryTracks.map((track) => track.artist).filter((artist): artist is string => Boolean(artist))),
    ).sort((a, b) => compareText(a, b));
    const genreOptions = Array.from(
      new Set(sortedLibraryTracks.flatMap((track) => splitTrackGenres(effectiveTrackGenre(track)))),
    ).sort((a, b) => compareText(a, b));
    const sourceId =
      preferredSource === 'current' && dedupedCurrentSource ? dedupedCurrentSource.id : 'custom';

    setPlaylistComposer({
      sources,
      selectedSourceId: sourceId,
      libraryTracks: sortedLibraryTracks,
      artistOptions,
      genreOptions,
      initialArtist:
        trackArtistFilter !== allTrackFilterValue
          ? trackArtistFilter
          : selectedArtistMode === 'all'
            ? (selectedArtist ?? dedupedCurrentSource?.tracks[0]?.artist ?? '')
            : '',
      initialGenre: trackGenreFilter !== allTrackFilterValue ? trackGenreFilter : '',
    });
  };
  const submitPlaylistComposer = async ({ name, tracks, rule }: PlaylistComposerSubmission) => {
    if (tracks.length === 0) return;
    const created = await createManualPlaylist(
      name,
      tracks.map((track) => track.path),
      rule,
    );
    if (created) {
      setPlaylistComposer(null);
    }
  };
  const addTracksToManualPlaylist = async (playlist: SavedPlaylist, trackPaths: string[]) => {
    if (trackPaths.length === 0) return false;
    try {
      setBusy('Updating playlist…');
      const next = await appendTracksToPlaylist(playlist.id, trackPaths);
      setData(next);
      setSelectedPlaylist({ kind: 'manual', id: playlist.id });
      setView('tracks');
      setStatus(`Added to playlist · ${playlist.name}`);
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const openPlaylistTarget = (tracks: Track[], options?: { label?: string; suggestedName?: string }) => {
    const dedupedPaths = Array.from(new Set(tracks.map((track) => track.path)));
    setPlaylistTarget({
      title: dedupedPaths.length === 0 ? 'New playlist' : 'Add to playlist',
      description:
        dedupedPaths.length === 0
          ? 'Start with an empty playlist and fill it up whenever you like.'
          : `${dedupedPaths.length} item${dedupedPaths.length === 1 ? '' : 's'} ready to add${
              options?.label ? ` · ${options.label}` : ''
            }`,
      trackPaths: dedupedPaths,
      suggestedName:
        options?.suggestedName ??
        (dedupedPaths.length === 0 ? `Playlist ${new Date().toLocaleDateString()}` : 'New playlist'),
    });
  };
  const submitPlaylistTargetCreate = async (name: string, trackPaths: string[]) => {
    const created = await createManualPlaylist(name, trackPaths);
    if (created) {
      setPlaylistTarget(null);
    }
  };
  const submitPlaylistTargetAppend = async (playlist: SavedPlaylist, trackPaths: string[]) => {
    const appended = await addTracksToManualPlaylist(playlist, trackPaths);
    if (appended) {
      setPlaylistTarget(null);
    }
  };
  const saveAlbumGenre = async (
    album: string,
    albumArtist: string | null,
    trackPaths: string[],
    genre: string | null,
  ) => {
    try {
      setBusy('Saving genres…');
      const next = await persistAlbumGenre(album, albumArtist, trackPaths, genre, metadataEditMode);
      setData(next);
      setAlbumGenreEditor(null);
      setStatus(
        genre
          ? `${metadataEditMode === 'write_to_files' ? 'Updated file genres' : 'Saved Needle genres'} · ${album}`
          : `${metadataEditMode === 'write_to_files' ? 'Cleared file genres' : 'Cleared Needle genres'} · ${album}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
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
    const nextPath = normalized.queue_paths[normalized.current_index] ?? null;
    setQueuePaths(normalized.queue_paths);
    setBaseQueuePaths(
      normalized.base_queue_paths.length > 0 ? normalized.base_queue_paths : normalized.queue_paths,
    );
    setCurrentQueueIndex(normalized.current_index);
    setCurrentPath(nextPath);
    setPlaybackPosition(normalized.position_seconds);
    setPlaybackDuration(0);
    backendPathRef.current = nextPath;
    backendPausedRef.current = normalized.paused;
    backendIdleRef.current = normalized.queue_paths.length === 0 || nextPath == null;
    syncConfirmedPlaybackState();
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

  const dismissBpmAuditTrack = (track: Pick<Track, 'path' | 'bpm' | 'title'>) => {
    const key = bpmAuditDismissalKey(track);
    setDismissedBpmAuditKeys((current) => (current.includes(key) ? current : current.concat(key)));
    setDismissedBpmAuditPaths((current) => (current.includes(track.path) ? current : current.concat(track.path)));
  };

  const startBpmAuditReview = async (track: Track) => {
    const reviewTracks = bpmAuditItems.map((item) => item.track);
    if (reviewTracks.length === 0) return;
    await playQueue(reviewTracks, `BPM review · ${track.title}`, {
      baseTracks: reviewTracks,
      currentPath: track.path,
    });
  };

  const toggleBpmAuditReviewPlayback = async (fallbackTrack?: Track | null) => {
    if (currentBpmAuditReviewPath) {
      await togglePlayPause();
      return;
    }
    const target = fallbackTrack ?? bpmAuditItems[0]?.track ?? null;
    if (!target) return;
    await startBpmAuditReview(target);
  };

  const stepBpmAuditReview = async (delta: number) => {
    if (bpmAuditItems.length === 0 || delta === 0) return;
    const activeIndex = currentBpmAuditReviewPath
      ? bpmAuditItems.findIndex((item) => item.track.path === currentBpmAuditReviewPath)
      : -1;
    const fallbackIndex = delta > 0 ? 0 : bpmAuditItems.length - 1;
    const targetIndex = activeIndex >= 0 ? activeIndex + delta : fallbackIndex;
    if (targetIndex < 0 || targetIndex >= bpmAuditItems.length) return;
    const target = bpmAuditItems[targetIndex]?.track;
    if (!target) return;
    await startBpmAuditReview(target);
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

  const playAlbum = (albumKeyValue: string) => {
    const tracks = tracksForAlbum(albumKeyValue);
    const actualTracks = shuffleEnabled ? shuffleList(tracks) : tracks;
    void playQueue(actualTracks, `Playing album · ${albumTitleFromKey(albumKeyValue)}`, {
      baseTracks: tracks,
      shuffle: shuffleEnabled,
    });
  };

  const tracksForArtist = (artistName: string, mode: ArtistBrowseMode = 'all') =>
    allTracks.filter((track) => artistNameForTrack(track, mode) === artistName);
  const topTracksForArtist = (artistName: string, mode: ArtistBrowseMode = 'all') =>
    tracksForArtist(artistName, mode).slice().sort(compareTracksBySort('plays')).slice(0, 10);

  const playArtist = (artistName: string, mode: ArtistBrowseMode = 'all') => {
    const pool = tracksForArtist(artistName, mode);
    if (pool.length === 0) return;
    const shuffled = shuffleList(pool).slice(0, 50);
    const selected = new Set(shuffled.map((track) => track.path));
    void playQueue(shuffled, `Artist mix · ${artistName}`, {
      baseTracks: pool.filter((track) => selected.has(track.path)),
      shuffle: true,
    });
  };
  const playPlaylistSelection = (playlist: ResolvedPlaylist, tracksOverride?: Track[]) => {
    const baseTracks = dedupeTracksByPath(tracksOverride ?? playlist.tracks);
    const actualTracks = shuffleEnabled ? shuffleList(baseTracks) : baseTracks;
    void playQueue(actualTracks, `Playing playlist · ${playlist.name}`, {
      baseTracks,
      shuffle: shuffleEnabled,
    });
  };
  const shufflePlaylistSelection = (playlist: ResolvedPlaylist, tracksOverride?: Track[]) => {
    const baseTracks = dedupeTracksByPath(tracksOverride ?? playlist.tracks);
    if (baseTracks.length === 0) return;
    void playQueue(shuffleList(baseTracks), `Shuffle playlist · ${playlist.name}`, {
      baseTracks,
      shuffle: true,
    });
  };
  const queueTrackCollection = async (
    tracks: Track[],
    label: string,
    placement: 'next' | 'queue',
  ) => {
    const baseTracks = dedupeTracksByPath(tracks);
    if (baseTracks.length === 0) return;

    if (!currentTrack) {
      await playQueue(baseTracks, `Playing playlist · ${label}`, {
        baseTracks,
      });
      return;
    }

    const collectionPaths = baseTracks.map((track) => track.path).filter((path) => path !== currentTrack.path);
    if (collectionPaths.length === 0) {
      setStatus('That playlist is already playing');
      return;
    }

    const nextQueue = queueTracks.map((track) => track.path).filter((path) => !collectionPaths.includes(path));
    const nextBase = baseQueueTracks.map((track) => track.path).filter((path) => !collectionPaths.includes(path));

    if (placement === 'next') {
      const activeIndex = Math.max(queuePaths.indexOf(currentTrack.path), 0);
      nextQueue.splice(activeIndex + 1, 0, ...collectionPaths);
      nextBase.splice(activeIndex + 1, 0, ...collectionPaths);
    } else {
      nextQueue.push(...collectionPaths);
      nextBase.push(...collectionPaths);
    }

    if (!isBackendPlaybackLoaded) {
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: null });
      setStatus(
        placement === 'next' ? `Playlist plays next · ${label}` : `Added playlist to queue · ${label}`,
      );
      return;
    }

    try {
      const existingIndices = queueTracks
        .map((track, index) => (collectionPaths.includes(track.path) ? index : -1))
        .filter((index) => index >= 0)
        .sort((a, b) => b - a);
      for (const index of existingIndices) {
        await tauriRemoveQueueIndex(index);
      }
      if (placement === 'next') {
        const activeIndex = Math.max(queuePaths.indexOf(currentTrack.path), 0);
        await insertQueueAt(collectionPaths, activeIndex + 1);
      } else {
        await appendQueue(collectionPaths);
      }
      applyQueueLocally(nextQueue, nextBase, { keepCurrentPath: currentTrack.path });
      setStatus(
        placement === 'next' ? `Playlist plays next · ${label}` : `Added playlist to queue · ${label}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const togglePlayPause = async () => {
    if (!currentPath) {
      const restartTrack = currentQueueTrack ?? queueTracks[0] ?? filteredTracks[0] ?? null;
      if (!restartTrack) return;

      if (queueTracks.length > 0) {
        await syncSession(
          {
            ...playbackSession,
            current_index: Math.max(queueTracks.findIndex((track) => track.path === restartTrack.path), 0),
            position_seconds: 0,
            paused: false,
          },
          { label: `Playing ${restartTrack.title}` },
        );
      } else {
        await play(restartTrack);
      }
      return;
    }
    try {
      if (!isBackendPlaybackLoaded) {
        const resumeTrack = currentTrack ?? currentQueueTrack ?? queueTracks[currentQueueIndex] ?? null;
        if (!resumeTrack) return;
        await syncSession(
          {
            ...playbackSession,
            current_index: currentQueueIndex,
            position_seconds: 0,
            paused: false,
          },
          { label: `Playing ${resumeTrack.title}` },
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
  const hasLibraryTracks = allTracks.length > 0;
  const tracksEmptyTitle = !hasLibraryTracks
    ? 'No tracks yet'
    : !selectedSmartPlaylist && search.trim()
        ? 'No matching tracks'
      : smartPlaylistHasGenreFocus
        ? 'No tracks match this mix'
      : hasTrackFilters
        ? 'No tracks match these filters'
      : selectedManualPlaylist
        ? 'No tracks in this playlist'
        : selectedArtist
          ? 'No tracks for this artist'
          : selectedPlaylistData
            ? 'No tracks in this playlist'
            : 'No tracks found';
  const tracksEmptyMessage = !hasLibraryTracks
    ? 'Add a folder from the sidebar to import FLAC, ALAC, WAV, MP3, OGG, M4A, and more.'
    : !selectedSmartPlaylist && search.trim()
        ? `Try a different search than “${search.trim()}”.`
      : smartPlaylistHasGenreFocus
        ? 'Try a different genre combination or clear the mix focus.'
      : hasTrackFilters
        ? 'Try widening the artist, genre, or year range filters.'
      : selectedManualPlaylist
        ? 'This saved playlist is empty right now.'
      : selectedArtist
          ? `No imported tracks are currently linked to ${selectedArtist}.`
          : selectedPlaylistData
            ? 'This playlist does not have any tracks available right now.'
            : 'There is nothing to show in this view yet.';

  if (loading) {
    return <div className="fullscreen-message">Loading…</div>;
  }
  if (!data) {
    return <div className="fullscreen-message">Failed to initialize.</div>;
  }

  const lib = data.library;

  if (isMiniPlayer) {
    return (
      <MiniPlayerView
        currentTrack={currentTrack}
        currentPath={currentPath}
        isPlaying={isPlaying}
        isPinned={isMiniPlayerPinned}
        isQueueExpanded={isMiniQueueExpanded}
        queueTracks={visibleQueueTracks}
        upNextCount={upNextCount}
        progressMax={progressMax}
        clampedPosition={clampedPosition}
        remainingSeconds={remainingSeconds}
        effectiveDuration={effectiveDuration}
        progressStyle={progressStyle}
        onStartDragging={() => void startMiniPlayerWindowDrag()}
        onExit={() => void exitMiniPlayer()}
        onTogglePin={() => void toggleMiniPlayerPinned()}
        onToggleQueue={() => void toggleMiniQueueExpanded()}
        onPlayPause={togglePlayPause}
        onPrevious={() => void skip(-1)}
        onNext={() => void skip(1)}
        onStop={() => void stop()}
        onPlayTrack={(track) => {
          const index = queueTracks.findIndex((item) => item.path === track.path);
          if (index >= 0) {
            void jumpToQueueIndex(index, `Playing ${track.title}`);
          }
        }}
        onClearQueue={() => void clearQueue()}
        onQueueResizeStart={startMiniQueueResize}
        onScrubChange={updateScrubPosition}
        onCommitScrub={() => void commitSeek(scrubPositionRef.current)}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-mark"
            src={effectiveTheme === 'dark' ? needleBrandMarkDark : needleBrandMarkLight}
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
            className={`nav-item ${view === 'tracks' && !selectedPlaylist ? 'active' : ''}`}
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

        <div className="sidebar-scroll">
          <nav className="nav-section">
            <div className="nav-label">Playlists</div>
            <button className="nav-button" onClick={() => openPlaylistTarget([])}>
              + New playlist
            </button>
            <div className="nav-sub-label">Saved</div>
            {manualPlaylists.length === 0 && <div className="nav-empty">No saved playlists yet</div>}
            {manualPlaylists.map((playlist) => (
              <button
                key={playlist.id}
                className={`nav-item nav-item-compact ${
                  view === 'tracks' && selectedPlaylist?.kind === 'manual' && selectedPlaylist.id === playlist.id
                    ? 'active'
                    : ''
                }`}
                onClick={() => {
                  setSelectedPlaylist({ kind: 'manual', id: playlist.id });
                  setSelectedAlbum(null);
                  setSelectedArtist(null);
                  setView('tracks');
                }}
              >
                <span className="nav-icon">{playlist.rule ? '↻' : '≣'}</span>
                <span className="nav-item-copy">{playlist.name}</span>
                <span className="nav-count">{playlist.track_paths.length}</span>
              </button>
            ))}
            <div className="nav-sub-label">Smart</div>
            {smartPlaylists.map((playlist) => (
              <button
                key={playlist.id}
                className={`nav-item nav-item-compact ${
                  view === 'tracks' && selectedPlaylist?.kind === 'smart' && selectedPlaylist.id === playlist.id
                    ? 'active'
                    : ''
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
        </div>

        <nav className="nav-section sidebar-app-nav">
          <div className="nav-label">App</div>
          <button
            className={`nav-item ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            <span className="nav-icon">⚙</span>Settings
          </button>
        </nav>
      </aside>

      <main className="content">
        {view === 'dashboard' && (
          <DashboardView
            tracks={allTracks}
            albums={albums}
            recentAlbums={recentAlbums}
            artists={allArtists}
            playlistSections={dashboardPlaylistSections}
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            featuredSeed={featuredSeed}
            onShuffle={shufflePlay}
            onAddFolder={importFolder}
            onOpenSettings={() => setView('settings')}
            onShuffleFeatured={() => setFeaturedSeed((s) => s + 1)}
            onOpenAlbum={openAlbum}
            onOpenArtist={openArtist}
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
            tracks={pagedTracks}
            totalTracks={tracksTotalCount}
            currentPage={tracksPage}
            pageCount={tracksPageCount}
            pageStartIndex={tracksPageStartIndex}
            onPageChange={setTracksPage}
            pageSize={currentTracksPageSize}
            onPageSizeChange={(nextSize) => {
              if (!data) return;
              void updateSettings({
                ...data.settings,
                tracks_page_size: normalizeTracksPageSize(nextSize),
              });
            }}
            playlistSourceTrackIndices={pagedPlaylistSourceTrackIndices}
            playlistSourceTotalCount={playlistSourceTotalCount}
            search={search}
            onSearch={setSearch}
            sortValue={selectedPlaylistData ? undefined : trackSort}
            onSortChange={selectedPlaylistData ? undefined : setTrackSort}
            artistFilterValue={trackArtistFilter}
            onArtistFilterChange={setTrackArtistFilter}
            artistFilterOptions={trackArtistOptions}
            genreFilterValue={trackGenreFilter}
            onGenreFilterChange={setTrackGenreFilter}
            genreFilterOptions={trackGenreOptions}
            yearFilterFromValue={trackYearFromFilter}
            onYearFilterFromChange={updateTrackYearFromFilter}
            yearFilterToValue={trackYearToFilter}
            onYearFilterToChange={updateTrackYearToFilter}
            yearFilterOptions={trackYearOptions}
            hasTrackFilters={hasTrackFilters}
            onClearTrackFilters={clearTrackFilters}
            currentPath={currentPath}
            isPlaying={isPlaying}
            onPlay={play}
            onPlayNext={playNext}
            onAddToQueue={addToQueue}
            queuePaths={queueTracks.map((track) => track.path)}
            playlistMode={selectedManualPlaylist ?? undefined}
            playlistTracksEditable={isPlaylistTrackEditable(selectedManualPlaylist)}
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
            onSaveAsPlaylist={() => openPlaylistComposer('current')}
            saveActionLabel="+ Save view as playlist"
            onAddTrackToPlaylist={(track) =>
              openPlaylistTarget([track], {
                label: track.title,
                suggestedName: `${track.title} picks`,
              })
            }
            hideTrackToolbar={selectedPlaylistData?.kind === 'smart'}
            smartPlaylistGenreOptions={smartPlaylistGenreOptions}
            selectedSmartPlaylistGenres={selectedSmartPlaylistGenres}
            onToggleSmartPlaylistGenre={(genre) =>
              setSelectedSmartPlaylistGenres((current) =>
                current.includes(genre)
                  ? current.filter((entry) => entry !== genre)
                  : current.concat(genre),
              )
            }
            onClearSmartPlaylistGenres={() => setSelectedSmartPlaylistGenres([])}
            onToggleFavorite={updateTrackFavorite}
            pendingFavoritePaths={pendingTrackFavorites}
            onSetRating={updateTrackRating}
            pendingRatingPaths={pendingTrackRatings}
            metadataEditMode={metadataEditMode}
            onAdjustBpm={adjustTrackBpmValue}
            onOpenBpmEditor={(track) => setTrackBpmEditor({ track })}
            pendingBpmPaths={pendingTrackBpms}
            playlistPrimaryActionLabel={selectedPlaylistData ? selectedPlaylistPrimaryActionLabel : undefined}
            onPlayPlaylistPrimaryAction={
              selectedPlaylistData
                ? () => {
                    if (isSelectedPlaylistActive) {
                      void togglePlayPause();
                      return;
                    }
                    playPlaylistSelection(selectedPlaylistData, selectedPlaylistActionTracks);
                  }
                : undefined
            }
            onShufflePlaylist={
              selectedPlaylistData
                ? () => shufflePlaylistSelection(selectedPlaylistData, selectedPlaylistActionTracks)
                : undefined
            }
            onPlayPlaylistNext={
              selectedPlaylistData
                ? () => {
                    void queueTrackCollection(selectedPlaylistActionTracks, selectedPlaylistData.name, 'next');
                  }
                : undefined
            }
            onAddPlaylistToQueue={
              selectedPlaylistData
                ? () => {
                    void queueTrackCollection(selectedPlaylistActionTracks, selectedPlaylistData.name, 'queue');
                  }
                : undefined
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
                    ? selectedArtistMode === 'album'
                      ? 'Album artist'
                      : 'Artist'
                    : `${lib.track_count} tracks in your library`
            }
            onClearFilter={
              selectedAlbum || selectedArtist || selectedPlaylistData || hasTrackFilters
                ? () => {
                    clearBrowsingFilters();
                    clearTrackFilters();
                  }
                : undefined
            }
            onOpenAlbum={openAlbum}
            onOpenArtist={openArtist}
            emptyTitle={tracksEmptyTitle}
            emptyMessage={tracksEmptyMessage}
          />
        )}

        {view === 'albums' && (
          <AlbumsView
            albums={sortedAlbums}
            sortValue={albumSort}
            onSortChange={setAlbumSort}
            onSelect={openAlbum}
            onPlayNextAlbum={playAlbumNext}
            onAddAlbumToQueue={addAlbumToQueue}
            onAddAlbumToPlaylist={(albumKeyValue) =>
              openPlaylistTarget(tracksForAlbum(albumKeyValue), {
                label: albumTitleFromKey(albumKeyValue),
                suggestedName: albumTitleFromKey(albumKeyValue),
              })
            }
          />
        )}

        {view === 'album' && selectedAlbum && selectedAlbumSummary && (
          <AlbumDetailView
            album={selectedAlbumSummary.album}
            albumKey={selectedAlbum}
            albumArtist={selectedAlbumSummary.artist}
            isVinylRip={selectedAlbumSummary.is_vinyl_rip}
            tracks={allTracks}
            isMetadataRefreshing={metadataRefreshAlbumKey === selectedAlbum}
            currentPath={currentPath}
            isPlaying={isPlaying}
            isCurrentAlbumCurrent={currentAlbumKey === selectedAlbum}
            queuePaths={queueTracks.map((track) => track.path)}
            onBack={() => {
              setSelectedAlbum(null);
              setView(albumReturnView.current);
            }}
            onPlayTrack={play}
            onPlayNext={playNext}
            onAddToQueue={addToQueue}
            onPlayAlbumNext={() => playAlbumNext(selectedAlbum)}
            onAddAlbumToQueue={() => addAlbumToQueue(selectedAlbum)}
            onAddAlbumToPlaylist={() =>
              openPlaylistTarget(tracksForAlbum(selectedAlbum), {
                label: selectedAlbumSummary.album,
                suggestedName: selectedAlbumSummary.album,
              })
            }
            onAddTrackToPlaylist={(track) =>
              openPlaylistTarget([track], {
                label: track.title,
                suggestedName: `${selectedAlbumSummary.album} picks`,
              })
            }
            onToggleFavorite={updateTrackFavorite}
            pendingFavoritePaths={pendingTrackFavorites}
            onSetRating={updateTrackRating}
            pendingRatingPaths={pendingTrackRatings}
            metadataEditMode={metadataEditMode}
            onAdjustBpm={adjustTrackBpmValue}
            onOpenBpmEditor={(track) => setTrackBpmEditor({ track })}
            pendingBpmPaths={pendingTrackBpms}
            onEditGenre={(currentGenre, suggestedGenres, trackPaths) =>
              setAlbumGenreEditor({
                album: selectedAlbumSummary.album,
                albumArtist: selectedAlbumSummary.artist,
                trackPaths,
                currentGenre,
                suggestedGenres,
              })
            }
            onRefreshMetadata={() =>
              void refreshAlbumMetadata(
                selectedAlbumSummary.album,
                selectedAlbumSummary.artist,
                selectedAlbum,
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
            onOpenArtist={openArtist}
          />
        )}

        {view === 'artists' && (
          <ArtistsView
            artists={sortedArtists}
            sortValue={artistSort}
            onSortChange={setArtistSort}
            search={artistSearch}
            onSearch={setArtistSearch}
            browseMode={artistBrowseMode}
            onBrowseModeChange={setArtistBrowseMode}
            layoutMode={artistLayoutMode}
            onLayoutModeChange={setArtistLayoutMode}
            onSelect={(artist) => openArtist(artist, artistBrowseMode)}
          />
        )}

        {view === 'artist' && selectedArtistProfile && (
          <ArtistDetailView
            artist={selectedArtistProfile}
            mode={selectedArtistProfileMode}
            summary={selectedArtistProfileSummary}
            tracks={allTracks}
            albums={albums}
            currentPath={currentPath}
            queuePaths={queueTracks.map((track) => track.path)}
            onBack={() => {
              setView(artistReturnView.current);
            }}
            onPlayTrack={play}
            onPlayNext={playNext}
            onAddToQueue={addToQueue}
            onPlayArtist={() => playArtist(selectedArtistProfile, selectedArtistProfileMode)}
            onPlayArtistNext={() => {
              void queueTrackCollection(
                tracksForArtist(selectedArtistProfile, selectedArtistProfileMode),
                selectedArtistProfile,
                'next',
              );
            }}
            onAddArtistToQueue={() => {
              void queueTrackCollection(
                tracksForArtist(selectedArtistProfile, selectedArtistProfileMode),
                selectedArtistProfile,
                'queue',
              );
            }}
            onViewTracks={() => openArtistTracks(selectedArtistProfile, selectedArtistProfileMode)}
            onOpenAlbum={openAlbum}
            onPlayAlbum={playAlbum}
            onPlayAlbumNext={playAlbumNext}
            onAddAlbumToQueue={addAlbumToQueue}
            onAddAlbumToPlaylist={(albumKeyValue) =>
              openPlaylistTarget(tracksForAlbum(albumKeyValue), {
                label: albumTitleFromKey(albumKeyValue),
                suggestedName: albumTitleFromKey(albumKeyValue),
              })
            }
            onPlayTopTracks={() => {
              const artistTopTracks = topTracksForArtist(selectedArtistProfile, selectedArtistProfileMode);
              if (artistTopTracks.length === 0) return;
              void playQueue(artistTopTracks, `Top tracks · ${selectedArtistProfile}`, {
                baseTracks: artistTopTracks,
              });
            }}
            onShuffleTopTracks={() => {
              const artistTopTracks = topTracksForArtist(selectedArtistProfile, selectedArtistProfileMode);
              if (artistTopTracks.length === 0) return;
              void playQueue(shuffleList(artistTopTracks), `Shuffle top tracks · ${selectedArtistProfile}`, {
                baseTracks: artistTopTracks,
                shuffle: true,
              });
            }}
            onPlayTopTracksNext={() => {
              const artistTopTracks = topTracksForArtist(selectedArtistProfile, selectedArtistProfileMode);
              void queueTrackCollection(artistTopTracks, `${selectedArtistProfile} top tracks`, 'next');
            }}
            onAddTopTracksToQueue={() => {
              const artistTopTracks = topTracksForArtist(selectedArtistProfile, selectedArtistProfileMode);
              void queueTrackCollection(artistTopTracks, `${selectedArtistProfile} top tracks`, 'queue');
            }}
            onAddTrackToPlaylist={(track) =>
              openPlaylistTarget([track], {
                label: track.title,
                suggestedName: `${selectedArtistProfile} picks`,
              })
            }
            onToggleFavorite={updateTrackFavorite}
            pendingFavoritePaths={pendingTrackFavorites}
            onSetRating={updateTrackRating}
            pendingRatingPaths={pendingTrackRatings}
            metadataEditMode={metadataEditMode}
            onAdjustBpm={adjustTrackBpmValue}
            onOpenBpmEditor={(track) => setTrackBpmEditor({ track })}
            pendingBpmPaths={pendingTrackBpms}
          />
        )}

        {view === 'settings' && (
          <SettingsView
            settings={data.settings}
            runtimeInfo={runtimeInfo}
            currentAccentColor={currentAccentColor}
            onChange={updateSettings}
            onAddFolder={importFolder}
            onMaintenance={maintenance}
            onLoudnessAnalysis={analyzeLoudness}
            onRemoveRoot={removeRoot}
            busy={!!busy}
            maintenanceBusy={isMaintenanceRunning}
            maintenanceLog={maintenanceLog}
            loudnessAnalysisBusy={isLoudnessAnalysisRunning}
            loudnessAnalysisLog={loudnessAnalysisLog}
            loudnessAnalysisProgress={loudnessAnalysisProgress}
            loudnessAnalysisFailures={loudnessAnalysisFailures}
            onCopyLoudnessFailures={copyLoudnessAnalysisFailures}
            missingLibraryRoots={missingLibraryRoots}
            bpmAuditItems={bpmAuditItems}
            onAdjustBpm={adjustTrackBpmValue}
            onOpenBpmEditor={(track) => setTrackBpmEditor({ track, dismissFromAudit: true })}
            pendingBpmPaths={pendingTrackBpms}
            currentBpmAuditReviewPath={currentBpmAuditReviewPath}
            isBpmAuditReviewPlaying={Boolean(currentBpmAuditReviewPath && isPlaying)}
            onStartBpmAuditReview={(track) => void startBpmAuditReview(track)}
            onToggleBpmAuditReviewPlayback={(track) => void toggleBpmAuditReviewPlayback(track)}
            onStepBpmAuditReview={(delta) => void stepBpmAuditReview(delta)}
            dismissedBpmAuditCount={dismissedBpmAuditCount}
            onDismissBpmAuditItem={(track) => {
              dismissBpmAuditTrack(track);
              setStatus(`Marked BPM as intentional · ${track.title}`);
            }}
            onClearDismissedBpmAuditItems={() => {
              setDismissedBpmAuditKeys([]);
              setDismissedBpmAuditPaths([]);
              setStatus('Restored dismissed BPM audit candidates');
            }}
          />
        )}
      </main>

      {playlistComposer && (
        <PlaylistComposerModal
          composer={playlistComposer}
          busy={busy === 'Saving playlist…'}
          onClose={() => setPlaylistComposer(null)}
          onSubmit={(submission) => void submitPlaylistComposer(submission)}
        />
      )}

      {playlistTarget && (
        <PlaylistTargetModal
          state={playlistTarget}
          playlists={manualPlaylists.filter((playlist) => !playlist.rule)}
          busy={busy === 'Saving playlist…' || busy === 'Updating playlist…'}
          onClose={() => setPlaylistTarget(null)}
          onCreate={(name, trackPaths) => void submitPlaylistTargetCreate(name, trackPaths)}
          onAppend={(playlist, trackPaths) => void submitPlaylistTargetAppend(playlist, trackPaths)}
        />
      )}

      {albumGenreEditor && (
        <AlbumGenreEditorModal
          state={albumGenreEditor}
          availableGenres={libraryGenreOptions}
          metadataEditMode={metadataEditMode}
          busy={busy === 'Saving genres…'}
          onClose={() => setAlbumGenreEditor(null)}
          onSubmit={(genre) =>
            void saveAlbumGenre(
              albumGenreEditor.album,
              albumGenreEditor.albumArtist,
              albumGenreEditor.trackPaths,
              genre,
            )
          }
        />
      )}

      {trackBpmEditor && (
        <TrackBpmEditorModal
          state={trackBpmEditor}
          metadataEditMode={metadataEditMode}
          busy={busy === 'Saving BPM…'}
          isTrackPlaying={trackBpmEditor.track.path === currentPath && isPlaying}
          onClose={() => setTrackBpmEditor(null)}
          onSubmit={(bpm) => void saveExactTrackBpmValue(trackBpmEditor, bpm)}
        />
      )}

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

      {notification && (
        <div className="toast-layer" aria-live="polite" aria-atomic="true">
          <div
            className={`app-toast is-${notification.tone}`}
            role={notification.tone === 'error' ? 'alert' : 'status'}
          >
            <div className="app-toast-icon" aria-hidden="true">
              {notificationToneIcon(notification.tone)}
            </div>
            <div className="app-toast-copy">
              <div className="app-toast-title">{notificationToneLabel(notification.tone)}</div>
              <div className="app-toast-message">{notification.message}</div>
            </div>
            <button
              className="app-toast-close"
              onClick={() => setNotification(null)}
              aria-label="Dismiss notification"
              title="Dismiss notification"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <footer className="player-bar">
        <div className="player-now-cluster">
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
          <button
            className={`ctrl ctrl-favorite ${currentTrack?.is_favorite ? 'is-active' : ''}`}
            onClick={() => {
              if (!currentTrack) return;
              void updateTrackFavorite(currentTrack, !currentTrack.is_favorite);
            }}
            disabled={!currentTrack || currentTrackFavoritePending}
            title={
              currentTrack
                ? currentTrack.is_favorite
                  ? `Remove ${currentTrack.title} from favourites`
                  : `Mark ${currentTrack.title} as favourite`
                : 'Nothing playing'
            }
            aria-label={
              currentTrack
                ? currentTrack.is_favorite
                  ? `Remove ${currentTrack.title} from favourites`
                  : `Mark ${currentTrack.title} as favourite`
                : 'Nothing playing'
            }
          >
            <HeartIcon filled={Boolean(currentTrack?.is_favorite)} />
          </button>
        </div>

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
            className="ctrl"
            onClick={() => void enterMiniPlayer()}
            title="Open mini player"
            aria-label="Open mini player"
          >
            <MiniPlayerIcon />
          </button>
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

interface PlaylistComposerModalProps {
  composer: PlaylistComposerState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (submission: PlaylistComposerSubmission) => void;
}

function PlaylistComposerModal({ composer, busy, onClose, onSubmit }: PlaylistComposerModalProps) {
  const selectedSource =
    composer.sources.find((source) => source.id === composer.selectedSourceId) ?? composer.sources[0];
  const [name, setName] = useState(selectedSource?.suggestedName ?? '');
  const [sourceId, setSourceId] = useState(selectedSource?.id ?? '');
  const [artistFilter, setArtistFilter] = useState(composer.initialArtist);
  const [genreFilter, setGenreFilter] = useState(composer.initialGenre);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const lastAutoNameRef = useRef(selectedSource?.suggestedName ?? '');

  useEffect(() => {
    const nextSelectedSource =
      composer.sources.find((source) => source.id === composer.selectedSourceId) ?? composer.sources[0];
    setName(nextSelectedSource?.suggestedName ?? '');
    setSourceId(nextSelectedSource?.id ?? '');
    setArtistFilter(composer.initialArtist);
    setGenreFilter(composer.initialGenre);
    setAutoUpdate(false);
    lastAutoNameRef.current = nextSelectedSource?.suggestedName ?? '';
  }, [composer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const activeSource = composer.sources.find((source) => source.id === sourceId) ?? selectedSource;
  const activeSuggestedName =
    sourceId === 'custom'
      ? filteredPlaylistName(artistFilter, genreFilter)
      : (activeSource?.suggestedName ?? 'Playlist');
  const filteredTracks = useMemo(() => {
    if (sourceId !== 'custom') {
      return activeSource?.tracks ?? [];
    }

    const expectedGenre = normalizeGenreKey(genreFilter);
    return composer.libraryTracks.filter((track) => {
      if (artistFilter && track.artist !== artistFilter) {
        return false;
      }
      if (expectedGenre && !splitTrackGenreKeys(effectiveTrackGenre(track)).includes(expectedGenre)) {
        return false;
      }
      return true;
    });
  }, [activeSource?.tracks, artistFilter, composer.libraryTracks, genreFilter, sourceId]);
  useEffect(() => {
    if (!name.trim() || name === lastAutoNameRef.current) {
      setName(activeSuggestedName);
    }
    lastAutoNameRef.current = activeSuggestedName;
  }, [activeSuggestedName, name]);
  const trimmedName = name.trim();
  const isCustomSource = sourceId === 'custom';
  const selectedArtistLabel = artistFilter || 'Any artist';
  const selectedGenreLabel = genreFilter || 'Any genre';
  const availableRule = activeSource?.rule ?? null;
  const canAutoUpdate = availableRule != null;

  return (
    <div className="modal-scrim" onClick={() => !busy && onClose()}>
      <div
        className="modal-card playlist-composer"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-composer-title"
      >
        <div className="modal-head">
          <div>
            <div className="view-eyebrow">Playlists</div>
            <h2 className="modal-title" id="playlist-composer-title">
              Create playlist
            </h2>
            <p className="modal-copy">Pick the tracks to save, then give the playlist a name.</p>
          </div>
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="field-input"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Late night rotation"
            autoFocus
          />
        </label>

        <div className="field">
          <div className="field-label">Tracks to include</div>
          <div className="source-list">
            {composer.sources.map((source) => (
              <label key={source.id} className={`source-option ${source.id === sourceId ? 'is-selected' : ''}`}>
                <input
                  className="sr-only"
                  type="radio"
                  name="playlist-source"
                  value={source.id}
                  checked={source.id === sourceId}
                  onChange={() => setSourceId(source.id)}
                />
                <span className="source-option-title">{source.label}</span>
                <span className="source-option-copy">{source.description}</span>
              </label>
            ))}
          </div>
        </div>

        {isCustomSource && (
          <div className="field playlist-composer-advanced">
            <div className="field-label">Filter the library</div>
            <div className="filter-grid">
              <label className="field">
                <span className="field-hint">Artist</span>
                <select
                  className="view-select field-input"
                  value={artistFilter}
                  onChange={(event) => setArtistFilter(event.currentTarget.value)}
                >
                  <option value="">Any artist</option>
                  {composer.artistOptions.map((artist) => (
                    <option key={artist} value={artist}>
                      {artist}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-hint">Genre</span>
                <select
                  className="view-select field-input"
                  value={genreFilter}
                  onChange={(event) => setGenreFilter(event.currentTarget.value)}
                >
                  <option value="">Any genre</option>
                  {composer.genreOptions.map((genre) => (
                    <option key={genre} value={genre}>
                      {genre}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}

        {availableRule && (
          <label className="playlist-composer-toggle">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(event) => setAutoUpdate(event.currentTarget.checked)}
            />
            <span className="playlist-composer-toggle-copy">
              <span className="playlist-composer-toggle-title">Auto-update this playlist</span>
              <span className="playlist-composer-toggle-text">
                Needle will reuse this view’s current search and filter choices whenever your library changes.
              </span>
            </span>
          </label>
        )}

        {activeSource && (
          <div className="playlist-composer-summary">
            {filteredTracks.length} track{filteredTracks.length === 1 ? '' : 's'} will be saved
            {isCustomSource ? ` · ${selectedArtistLabel} · ${selectedGenreLabel}` : ''}
            {autoUpdate && canAutoUpdate ? ' · auto-updating' : ''}.
          </div>
        )}

        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={() =>
              onSubmit({
                name: trimmedName,
                tracks: filteredTracks,
                rule: autoUpdate && canAutoUpdate ? availableRule : null,
              })
            }
            disabled={!trimmedName || filteredTracks.length === 0 || busy}
          >
            {busy ? 'Creating…' : 'Create playlist'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PlaylistTargetModalProps {
  state: PlaylistTargetState;
  playlists: SavedPlaylist[];
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, trackPaths: string[]) => void;
  onAppend: (playlist: SavedPlaylist, trackPaths: string[]) => void;
}

function PlaylistTargetModal({
  state,
  playlists,
  busy,
  onClose,
  onCreate,
  onAppend,
}: PlaylistTargetModalProps) {
  const [name, setName] = useState(state.suggestedName);

  useEffect(() => {
    setName(state.suggestedName);
  }, [state.suggestedName]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const trimmedName = name.trim();
  const hasTracks = state.trackPaths.length > 0;

  return (
    <div className="modal-scrim" onClick={() => !busy && onClose()}>
      <div
        className="modal-card playlist-target"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-target-title"
      >
        <div className="modal-head">
          <div>
            <div className="view-eyebrow">Playlists</div>
            <h2 className="modal-title" id="playlist-target-title">
              {state.title}
            </h2>
            <p className="modal-copy">{state.description}</p>
          </div>
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        {hasTracks && (
          <div className="playlist-target-section">
            <div className="field-label">Add to an existing playlist</div>
            {playlists.length === 0 ? (
              <div className="playlist-target-empty">No editable saved playlists yet. Create one below.</div>
            ) : (
              <div className="playlist-target-list">
                {playlists.map((playlist) => (
                  <div key={playlist.id} className="playlist-target-row">
                    <div className="playlist-target-copy">
                      <div className="playlist-target-name">{playlist.name}</div>
                      <div className="playlist-target-meta">
                        {playlist.track_paths.length} track{playlist.track_paths.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button
                      className="row-action-button"
                      onClick={() => onAppend(playlist, state.trackPaths)}
                      disabled={busy}
                    >
                      Add here
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="playlist-target-section">
          <div className="field-label">{hasTracks ? 'Or create a new playlist' : 'Create an empty playlist'}</div>
          <label className="field">
            <span className="field-hint">Playlist name</span>
            <input
              className="field-input"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Late night rotation"
              autoFocus
            />
          </label>
        </div>

        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={() => onCreate(trimmedName, state.trackPaths)}
            disabled={!trimmedName || busy}
          >
            {busy ? 'Saving…' : hasTracks ? 'Create and add' : 'Create playlist'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AlbumGenreEditorModalProps {
  state: AlbumGenreEditorState;
  availableGenres: string[];
  metadataEditMode: MetadataEditMode;
  busy: boolean;
  onClose: () => void;
  onSubmit: (genre: string | null) => void;
}

function AlbumGenreEditorModal({
  state,
  availableGenres,
  metadataEditMode,
  busy,
  onClose,
  onSubmit,
}: AlbumGenreEditorModalProps) {
  const initialGenres = useMemo(
    () => splitTrackGenres(state.currentGenre ?? state.suggestedGenres[0] ?? ''),
    [state.currentGenre, state.suggestedGenres],
  );
  const [selectedGenres, setSelectedGenres] = useState<string[]>(initialGenres);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSelectedGenres(splitTrackGenres(state.currentGenre ?? state.suggestedGenres[0] ?? ''));
    setQuery('');
  }, [state.currentGenre, state.suggestedGenres]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const selectedGenreKeys = new Set(selectedGenres.map((genre) => normalizeGenreKey(genre)).filter(Boolean));
  const suggestedGenres = useMemo(
    () =>
      uniqueSorted(
        [state.currentGenre, ...state.suggestedGenres]
          .flatMap((value) => splitTrackGenres(value))
          .filter(Boolean),
      ),
    [state.currentGenre, state.suggestedGenres],
  );
  const normalizedQuery = normalizeGenreKey(query);
  const pendingGenres = useMemo(
    () =>
      uniqueSorted(splitTrackGenres(query)).filter(
        (genre) => !selectedGenreKeys.has(normalizeGenreKey(genre) ?? ''),
      ),
    [query, selectedGenreKeys],
  );
  const filteredGenres = useMemo(() => {
    const source = uniqueSorted([...suggestedGenres, ...availableGenres]);
    const loweredQuery = query.trim().toLocaleLowerCase();
    return source.filter((genre) => {
      const key = normalizeGenreKey(genre);
      if (!key || selectedGenreKeys.has(key)) return false;
      if (!loweredQuery) return true;
      return (
        genre.toLocaleLowerCase().includes(loweredQuery) ||
        key.includes(loweredQuery) ||
        (normalizedQuery ? key.includes(normalizedQuery) : false)
      );
    });
  }, [availableGenres, normalizedQuery, query, selectedGenreKeys, suggestedGenres]);
  const genreString = selectedGenres.join('; ');
  const modeCopy =
    metadataEditMode === 'write_to_files'
      ? 'This will update the embedded genre tags on every track on this album.'
      : 'This will stay inside Needle and leave the audio files untouched.';
  const addGenres = (genres: string[]) => {
    if (genres.length === 0) return;
    setSelectedGenres((current) => {
      const next = current.slice();
      const seen = new Set(current.map((genre) => normalizeGenreKey(genre)).filter(Boolean));
      for (const genre of genres) {
        const key = normalizeGenreKey(genre);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        next.push(genreLabelFromKey(key));
      }
      return next;
    });
    setQuery('');
    inputRef.current?.focus();
  };
  const addGenre = (genre: string) => addGenres([genre]);
  const addGenresFromText = (value: string) => {
    const parsed = splitTrackGenres(value);
    if (parsed.length > 0) {
      addGenres(parsed);
      return;
    }
    if (normalizedQuery) {
      addGenres([genreLabelFromKey(normalizedQuery)]);
    }
  };
  const removeGenre = (genre: string) => {
    const key = normalizeGenreKey(genre);
    setSelectedGenres((current) => current.filter((entry) => normalizeGenreKey(entry) !== key));
    inputRef.current?.focus();
  };

  return (
    <div className="modal-scrim" onClick={() => !busy && onClose()}>
      <div
        className="modal-card genre-editor"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-genre-editor-title"
      >
        <div className="modal-head">
          <div>
            <div className="view-eyebrow">Metadata</div>
            <h2 className="modal-title" id="album-genre-editor-title">
              Album genres
            </h2>
            <p className="modal-copy">
              Edit the full genre string for this album. {modeCopy} Change the save mode in Settings.
            </p>
          </div>
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        {suggestedGenres.length > 0 && (
          <div className="field">
            <div className="field-label">Suggestions from this album</div>
            <div className="genre-choice-grid">
              {suggestedGenres.map((genre) => (
                <button
                  key={genre}
                  className={`genre-choice ${
                    selectedGenreKeys.has(normalizeGenreKey(genre) ?? '') ? 'is-selected' : ''
                  }`}
                  onClick={() => addGenre(genre)}
                >
                  {genre}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <span className="field-label">Genres for every track on this album</span>
          <div className="genre-multiselect" onClick={() => inputRef.current?.focus()}>
            <div className="genre-multiselect-values">
              {selectedGenres.map((genre) => (
                <button
                  key={genre}
                  type="button"
                  className="genre-token"
                  onClick={() => removeGenre(genre)}
                  disabled={busy}
                  aria-label={`Remove ${genre}`}
                  title={`Remove ${genre}`}
                >
                  <span>{genre}</span>
                  <span className="genre-token-remove" aria-hidden="true">
                    ×
                  </span>
                </button>
              ))}
              <input
                ref={inputRef}
                className="genre-multiselect-input"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (query.trim()) addGenresFromText(query);
                  } else if (event.key === 'Backspace' && !query && selectedGenres.length > 0) {
                    event.preventDefault();
                    setSelectedGenres((current) => current.slice(0, -1));
                  }
                }}
                placeholder={selectedGenres.length > 0 ? 'Add another genre…' : 'Search or add genres…'}
                autoFocus
                disabled={busy}
              />
            </div>
          </div>
          <div className="genre-picker-panel" role="listbox" aria-label="Available genres">
            {pendingGenres.length > 0 &&
              !pendingGenres.every((genre) => filteredGenres.some((option) => normalizeGenreKey(option) === normalizeGenreKey(genre))) && (
              <button type="button" className="genre-picker-option is-create" onClick={() => addGenres(pendingGenres)}>
                Add <strong>{pendingGenres.length === 1 ? pendingGenres[0] : `${pendingGenres.length} genres`}</strong>
              </button>
              )}
            {filteredGenres.slice(0, 24).map((genre) => (
              <button
                key={genre}
                type="button"
                className="genre-picker-option"
                onClick={() => addGenre(genre)}
              >
                {genre}
              </button>
            ))}
            {pendingGenres.length === 0 && filteredGenres.length === 0 && (
              <div className="genre-picker-empty">No matching genres yet. Type a new one and press Enter.</div>
            )}
          </div>
          <div className="field-help">Needle will save this as: {genreString || 'No genres selected'}</div>
        </div>

        <div className="modal-actions">
          <button className="ghost-button" onClick={() => onSubmit(null)} disabled={!state.currentGenre || busy}>
            {metadataEditMode === 'write_to_files' ? 'Clear file genres' : 'Clear Needle genres'}
          </button>
          <button
            className="primary-button"
            onClick={() => onSubmit(genreString || null)}
            disabled={!genreString || busy}
          >
            {busy ? 'Saving…' : metadataEditMode === 'write_to_files' ? 'Write genres' : 'Save in Needle'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TrackBpmEditorModalProps {
  state: TrackBpmEditorState;
  metadataEditMode: MetadataEditMode;
  busy: boolean;
  isTrackPlaying: boolean;
  onClose: () => void;
  onSubmit: (bpm: number) => void;
}

function TrackBpmEditorModal({
  state,
  metadataEditMode,
  busy,
  isTrackPlaying,
  onClose,
  onSubmit,
}: TrackBpmEditorModalProps) {
  const [value, setValue] = useState(formatBpm(state.track.bpm) ?? '');
  const [tapTimes, setTapTimes] = useState<number[]>([]);

  useEffect(() => {
    setValue(formatBpm(state.track.bpm) ?? '');
    setTapTimes([]);
  }, [state]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
        return;
      }

      if (
        event.code === 'Space' &&
        !event.repeat &&
        !busy &&
        !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes((event.target as HTMLElement | null)?.tagName ?? '')
      ) {
        event.preventDefault();
        setTapTimes((current) => {
          const now = Date.now();
          const recent = current.length > 0 && now - current[current.length - 1]! <= 2600 ? current : [];
          return recent.concat(now).slice(-8);
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const parsed = Number.parseInt(value.trim(), 10);
  const canSubmit = Number.isFinite(parsed) && parsed > 0;
  const tappedBpm = useMemo(() => {
    if (tapTimes.length < 2) {
      return null;
    }

    const intervals: number[] = [];
    for (let index = 1; index < tapTimes.length; index += 1) {
      intervals.push(tapTimes[index]! - tapTimes[index - 1]!);
    }
    if (intervals.length === 0) {
      return null;
    }

    const sorted = intervals.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const medianInterval =
      sorted.length % 2 === 1
        ? sorted[middle]!
        : ((sorted[middle - 1] ?? sorted[middle]!) + (sorted[middle] ?? sorted[middle - 1]!)) / 2;
    if (!Number.isFinite(medianInterval) || medianInterval <= 0) {
      return null;
    }
    return Math.max(1, Math.round(60000 / medianInterval));
  }, [tapTimes]);
  const tapCountLabel =
    tapTimes.length === 0
      ? 'No taps captured yet'
      : tapTimes.length === 1
        ? '1 tap captured'
        : `${tapTimes.length} taps captured`;
  const registerTap = () => {
    if (busy) {
      return;
    }
    setTapTimes((current) => {
      const now = Date.now();
      const recent = current.length > 0 && now - current[current.length - 1]! <= 2600 ? current : [];
      return recent.concat(now).slice(-8);
    });
  };

  return (
    <div className="modal-scrim" onClick={() => !busy && onClose()}>
      <div
        className="modal-card genre-editor"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="track-bpm-editor-title"
      >
        <div className="modal-head">
          <div>
            <div className="view-eyebrow">Metadata</div>
            <h2 className="modal-title" id="track-bpm-editor-title">
              {state.track.bpm != null ? 'Edit BPM' : 'Set BPM'}
            </h2>
            <p className="modal-copy">
              {metadataEditMode === 'write_to_files'
                ? 'This will update the embedded BPM tag in the music file. Change the save mode in Settings.'
                : 'This will stay inside Needle as a local BPM correction. Change the save mode in Settings.'}
            </p>
          </div>
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        <label className="field">
          <span className="field-label">{state.track.title}</span>
          <input
            className="field-input"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            placeholder="128"
            inputMode="numeric"
            autoFocus
          />
        </label>

        <div className="bpm-tap-panel">
          <div className="bpm-tap-panel-head">
            <div>
              <div className="field-label">Tap tempo</div>
              <div className="field-help">
                {isTrackPlaying
                  ? 'Tap Space or the button in time with the music. Needle estimates BPM from your most recent taps.'
                  : 'Tap Space or the button in time with the music. This works best while the track is currently playing.'}
              </div>
            </div>
            <div className="bpm-tap-readout" aria-live="polite">
              <div className="bpm-tap-readout-value">{tappedBpm != null ? `${tappedBpm} BPM` : '—'}</div>
              <div className="bpm-tap-readout-meta">{tapCountLabel}</div>
            </div>
          </div>

          <div className="bpm-tap-actions">
            <button className="primary-button bpm-tap-button" type="button" onClick={registerTap} disabled={busy}>
              Tap now
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => tappedBpm != null && setValue(String(tappedBpm))}
              disabled={tappedBpm == null || busy}
            >
              Use tapped BPM
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => setTapTimes([])}
              disabled={tapTimes.length === 0 || busy}
            >
              Reset taps
            </button>
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={() => {
              if (!canSubmit) return;
              onSubmit(parsed);
            }}
            disabled={!canSubmit || busy}
          >
            {busy ? 'Saving…' : metadataEditMode === 'write_to_files' ? 'Write BPM' : 'Save BPM'}
          </button>
        </div>
      </div>
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
                    imageMode="deferred"
                    lazyLoad
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

interface MiniPlayerViewProps {
  currentTrack: Track | null;
  currentPath: string | null;
  isPlaying: boolean;
  isPinned: boolean;
  isQueueExpanded: boolean;
  queueTracks: Track[];
  upNextCount: number;
  progressMax: number;
  clampedPosition: number;
  remainingSeconds: number | null;
  effectiveDuration: number;
  progressStyle: CSSProperties;
  onStartDragging: () => void;
  onExit: () => void;
  onTogglePin: () => void;
  onToggleQueue: () => void;
  onPlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onStop: () => void;
  onPlayTrack: (track: Track) => void;
  onClearQueue: () => void;
  onQueueResizeStart: (clientY: number) => void;
  onScrubChange: (value: number) => void;
  onCommitScrub: () => void;
}

function MiniPlayerView({
  currentTrack,
  currentPath,
  isPlaying,
  isPinned,
  isQueueExpanded,
  queueTracks,
  upNextCount,
  progressMax,
  clampedPosition,
  remainingSeconds,
  effectiveDuration,
  progressStyle,
  onStartDragging,
  onExit,
  onTogglePin,
  onToggleQueue,
  onPlayPause,
  onPrevious,
  onNext,
  onStop,
  onPlayTrack,
  onClearQueue,
  onQueueResizeStart,
  onScrubChange,
  onCommitScrub,
}: MiniPlayerViewProps) {
  const albumLabel = currentTrack?.album ?? 'Nothing playing';
  const subtitle = currentTrack
    ? `${currentTrack.artist ?? 'Unknown artist'}${currentTrack.album ? ` — ${currentTrack.album}` : ''}`
    : 'Pick a track from your library';

  return (
    <div className={`mini-player ${isQueueExpanded ? 'is-queue-expanded' : ''}`}>
      <div className="mini-player-shell">
        <div className="mini-player-stage">
          <Cover
            trackPath={currentTrack?.path ?? null}
            fallback={currentTrack?.title?.[0]?.toUpperCase() ?? '♪'}
            size="mini"
          />
          <div
            className="mini-player-drag-surface"
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              void onStartDragging();
            }}
            title="Drag to move mini player"
            aria-hidden="true"
          />
          <div className="mini-player-topbar">
            <div className="mini-player-brand">Needle</div>
            <div className="mini-player-topbar-actions">
              <button
                className={`ctrl mini-player-chrome-button mini-player-pin-button ${
                  isPinned ? 'is-active is-pinned' : 'is-unpinned'
                }`}
                onClick={onTogglePin}
                title={isPinned ? 'Unpin mini player' : 'Pin mini player'}
                aria-label={isPinned ? 'Unpin mini player' : 'Pin mini player'}
              >
                <PinIcon />
              </button>
              <button
                className="ctrl mini-player-chrome-button"
                onClick={onExit}
                title="Return to full player"
                aria-label="Return to full player"
              >
                <RestoreWindowIcon />
              </button>
            </div>
          </div>
          <div className="mini-player-overlay">
            <div className="mini-player-copy">
              <div className="mini-player-title">{currentTrack?.title ?? 'Nothing playing'}</div>
              <div className="mini-player-sub">{subtitle}</div>
            </div>
            <div className="mini-player-overlay-actions">
              <div className="mini-player-controls">
                <button className="ctrl mini-player-control" onClick={onPrevious} disabled={!currentTrack} title="Previous">
                  <PreviousIcon />
                </button>
                <button
                  className="ctrl ctrl-primary mini-player-primary"
                  onClick={onPlayPause}
                  title={isPlaying ? 'Pause' : 'Play'}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button className="ctrl mini-player-control" onClick={onNext} disabled={!currentTrack} title="Next">
                  <NextIcon />
                </button>
                <button className="ctrl mini-player-control" onClick={onStop} disabled={!currentTrack} title="Stop">
                  <StopIcon />
                </button>
              </div>
              <button
                className={`ctrl mini-player-control mini-player-queue-button ${isQueueExpanded ? 'is-active' : ''}`}
                onClick={onToggleQueue}
                title={isQueueExpanded ? 'Hide Up Next' : 'Show Up Next'}
                aria-label={isQueueExpanded ? 'Hide Up Next' : 'Show Up Next'}
              >
                <QueueIcon />
                {queueTracks.length > 0 && <span className="ctrl-badge">{upNextCount}</span>}
              </button>
            </div>
          </div>
        </div>

        <div className="mini-player-progress-block">
          <div className="mini-player-progress-meta">
            <span>{currentTrack ? formatDuration(clampedPosition) : '—'}</span>
            <span>{currentTrack && remainingSeconds != null ? `-${formatDuration(remainingSeconds)}` : '—'}</span>
          </div>
          <input
            className="player-progress-input mini-player-progress-input"
            type="range"
            min={0}
            max={progressMax}
            step={0.1}
            value={currentTrack ? clampedPosition : 0}
            disabled={!currentTrack || effectiveDuration <= 0}
            onChange={(event) => onScrubChange(Number(event.currentTarget.value))}
            onMouseUp={onCommitScrub}
            onTouchEnd={onCommitScrub}
            onKeyUp={(event) => {
              if (
                ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(
                  event.key,
                )
              ) {
                onCommitScrub();
              }
            }}
            onBlur={onCommitScrub}
            style={progressStyle}
          />
        </div>

        {isQueueExpanded && (
          <section className="mini-player-queue">
            <div className="mini-player-queue-head">
              <div>
                <div className="mini-player-queue-label">Up Next</div>
                <div className="mini-player-queue-copy">
                  {queueTracks.length === 0
                    ? 'Nothing queued yet.'
                    : `${Math.max(queueTracks.length - 1, 0)} upcoming track${
                        Math.max(queueTracks.length - 1, 0) === 1 ? '' : 's'
                      }`}
                </div>
              </div>
              <button className="ghost-button" onClick={onClearQueue} disabled={queueTracks.length === 0}>
                Clear
              </button>
            </div>
            {queueTracks.length === 0 ? (
              <div className="mini-player-queue-empty">Start a track, album, artist mix, or playlist to build a queue.</div>
            ) : (
              <div className="mini-player-queue-list">
                {queueTracks.map((track, index) => {
                  const isCurrent = track.path === currentPath;
                  return (
                    <button
                      key={track.path}
                      className={`mini-player-queue-row ${isCurrent ? 'is-current' : ''}`}
                      onClick={() => onPlayTrack(track)}
                    >
                      <span className="mini-player-queue-index">
                        {isCurrent ? (isPlaying ? <PlayingIndicator /> : 'Now') : index + 1}
                      </span>
                      <Cover
                        trackPath={track.path}
                        fallback={track.title[0]?.toUpperCase() ?? '♪'}
                        size="queue"
                        imageMode="deferred"
                        lazyLoad
                      />
                      <span className="mini-player-queue-copy-block">
                        <span className="mini-player-queue-title">{track.title}</span>
                        <span className="mini-player-queue-sub">
                          {(track.artist ?? 'Unknown artist') + ' — ' + (track.album ?? 'Unknown album')}
                        </span>
                      </span>
                      <span className="mini-player-queue-time">{formatDuration(track.duration_seconds)}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div
              className="mini-player-queue-resize-handle"
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                onQueueResizeStart(event.clientY);
              }}
              title="Drag to resize Up Next"
              aria-hidden="true"
            >
              <span className="mini-player-queue-resize-grip" />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

interface TracksViewProps {
  tracks: Track[];
  totalTracks: number;
  currentPage: number;
  pageCount: number;
  pageStartIndex: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  playlistSourceTrackIndices?: number[];
  playlistSourceTotalCount?: number;
  search: string;
  onSearch: (value: string) => void;
  sortValue?: TrackSortOption;
  onSortChange?: (value: TrackSortOption) => void;
  artistFilterValue: string;
  onArtistFilterChange: (value: string) => void;
  artistFilterOptions: string[];
  genreFilterValue: string;
  onGenreFilterChange: (value: string) => void;
  genreFilterOptions: string[];
  yearFilterFromValue: TrackYearBoundaryFilter;
  onYearFilterFromChange: (value: TrackYearBoundaryFilter) => void;
  yearFilterToValue: TrackYearBoundaryFilter;
  onYearFilterToChange: (value: TrackYearBoundaryFilter) => void;
  yearFilterOptions: string[];
  hasTrackFilters: boolean;
  onClearTrackFilters: () => void;
  currentPath: string | null;
  isPlaying: boolean;
  onPlay: (track: Track) => void;
  onPlayNext: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  queuePaths: string[];
  playlistMode?: SavedPlaylist;
  playlistTracksEditable?: boolean;
  onMovePlaylistTrack?: (fromIndex: number, toIndex: number) => void;
  onRemovePlaylistTrack?: (index: number) => void;
  onRenamePlaylist?: () => void;
  onDeletePlaylist?: () => void;
  onSaveAsPlaylist?: () => void;
  saveActionLabel?: string;
  onAddTrackToPlaylist?: (track: Track) => void;
  hideTrackToolbar?: boolean;
  smartPlaylistGenreOptions?: SmartPlaylistGenreOption[];
  selectedSmartPlaylistGenres?: string[];
  onToggleSmartPlaylistGenre?: (genre: string) => void;
  onClearSmartPlaylistGenres?: () => void;
  onToggleFavorite: (track: Track, favorite: boolean) => void;
  pendingFavoritePaths: string[];
  onSetRating: (track: Track, rating: number | null) => void;
  pendingRatingPaths: string[];
  metadataEditMode: MetadataEditMode;
  onAdjustBpm: (track: Track, adjustment: TrackBpmAdjustment) => void;
  onOpenBpmEditor: (track: Track) => void;
  pendingBpmPaths: string[];
  playlistPrimaryActionLabel?: string;
  onPlayPlaylistPrimaryAction?: () => void;
  onShufflePlaylist?: () => void;
  onPlayPlaylistNext?: () => void;
  onAddPlaylistToQueue?: () => void;
  title: string;
  subtitle: string;
  onClearFilter?: () => void;
  onOpenAlbum: (albumKey: string) => void;
  onOpenArtist: (artist: string) => void;
  emptyTitle: string;
  emptyMessage: string;
}

function TracksView({
  tracks,
  totalTracks,
  currentPage,
  pageCount,
  pageStartIndex,
  onPageChange,
  pageSize,
  onPageSizeChange,
  playlistSourceTrackIndices,
  playlistSourceTotalCount,
  search,
  onSearch,
  sortValue,
  onSortChange,
  artistFilterValue,
  onArtistFilterChange,
  artistFilterOptions,
  genreFilterValue,
  onGenreFilterChange,
  genreFilterOptions,
  yearFilterFromValue,
  onYearFilterFromChange,
  yearFilterToValue,
  onYearFilterToChange,
  yearFilterOptions,
  hasTrackFilters,
  onClearTrackFilters,
  currentPath,
  isPlaying,
  onPlay,
  onPlayNext,
  onAddToQueue,
  queuePaths,
  playlistMode,
  playlistTracksEditable = true,
  onMovePlaylistTrack,
  onRemovePlaylistTrack,
  onRenamePlaylist,
  onDeletePlaylist,
  onSaveAsPlaylist,
  saveActionLabel,
  onAddTrackToPlaylist,
  hideTrackToolbar = false,
  smartPlaylistGenreOptions = [],
  selectedSmartPlaylistGenres = [],
  onToggleSmartPlaylistGenre,
  onClearSmartPlaylistGenres,
  onToggleFavorite,
  pendingFavoritePaths,
  onSetRating,
  pendingRatingPaths,
  metadataEditMode,
  onAdjustBpm,
  onOpenBpmEditor,
  pendingBpmPaths,
  playlistPrimaryActionLabel,
  onPlayPlaylistPrimaryAction,
  onShufflePlaylist,
  onPlayPlaylistNext,
  onAddPlaylistToQueue,
  title,
  subtitle,
  onClearFilter,
  onOpenAlbum,
  onOpenArtist,
  emptyTitle,
  emptyMessage,
}: TracksViewProps) {
  const rangeStart = totalTracks === 0 ? 0 : pageStartIndex + 1;
  const rangeEnd = totalTracks === 0 ? 0 : Math.min(pageStartIndex + tracks.length, totalTracks);
  const renderPagination = () =>
    totalTracks > 0 ? (
      <div className="tracks-pagination" aria-label="Track list pagination">
        <div className="tracks-pagination-summary">{`Showing ${rangeStart}-${rangeEnd} of ${totalTracks} tracks`}</div>
        <div className="tracks-pagination-actions">
          <label className="tracks-pagination-size">
            <span className="view-select-label">Page size</span>
            <select
              className="view-select tracks-select"
              value={String(pageSize)}
              onChange={(event) => onPageSizeChange(Number(event.currentTarget.value))}
            >
              {trackPageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option} tracks
                </option>
              ))}
            </select>
          </label>
          {pageCount > 1 && (
            <>
              <button className="ghost-button" onClick={() => onPageChange(1)} disabled={currentPage === 1}>
                « First
              </button>
              <button
                className="ghost-button"
                onClick={() => onPageChange(Math.max(currentPage - 1, 1))}
                disabled={currentPage === 1}
              >
                ‹ Prev
              </button>
              <span className="tracks-pagination-page">{`Page ${currentPage} of ${pageCount}`}</span>
              <button
                className="ghost-button"
                onClick={() => onPageChange(Math.min(currentPage + 1, pageCount))}
                disabled={currentPage === pageCount}
              >
                Next ›
              </button>
              <button
                className="ghost-button"
                onClick={() => onPageChange(pageCount)}
                disabled={currentPage === pageCount}
              >
                Last »
              </button>
            </>
          )}
        </div>
      </div>
    ) : null;

  return (
    <div className="view">
      <header className="view-header tracks-view-header">
        <div>
          <div className="view-eyebrow">{subtitle}</div>
          <h1 className="view-title">{title}</h1>
        </div>
        <div className="view-actions tracks-header-actions">
          {onClearFilter && (
            <button className="ghost-button" onClick={onClearFilter}>
              ← All tracks
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
        </div>
      </header>
      {(onPlayPlaylistPrimaryAction || onShufflePlaylist || onPlayPlaylistNext || onAddPlaylistToQueue) && (
        <div className="tracks-playlist-actions">
          {onPlayPlaylistPrimaryAction && (
            <button className="primary-button" onClick={onPlayPlaylistPrimaryAction}>
              {playlistPrimaryActionLabel ?? '▶ Play'}
            </button>
          )}
          {onPlayPlaylistNext && (
            <button className="ghost-button" onClick={onPlayPlaylistNext}>
              ≫ Play next
            </button>
          )}
          {onAddPlaylistToQueue && (
            <button className="ghost-button" onClick={onAddPlaylistToQueue}>
              + Add to queue
            </button>
          )}
          {onShufflePlaylist && (
            <button className="ghost-button" onClick={onShufflePlaylist}>
              ⤮ Shuffle
            </button>
          )}
        </div>
      )}
      {smartPlaylistGenreOptions.length > 0 && (
        <section className="playlist-focus" aria-label="Focus this mix by genre">
          <div className="playlist-focus-head">
            <div className="playlist-focus-title">Focus this mix</div>
            {selectedSmartPlaylistGenres.length > 0 && onClearSmartPlaylistGenres && (
              <button className="ghost-button playlist-focus-clear" onClick={onClearSmartPlaylistGenres}>
                Clear
              </button>
            )}
          </div>
          <div className="playlist-focus-pills">
            {smartPlaylistGenreOptions.map((genre) => {
              const selected = selectedSmartPlaylistGenres.includes(genre.key);
              return (
                <button
                  key={genre.key}
                  className={`playlist-focus-pill ${selected ? 'is-active' : ''}`}
                  onClick={() => onToggleSmartPlaylistGenre?.(genre.key)}
                >
                  <span>{genre.label}</span>
                  <span className="playlist-focus-pill-count">{genre.count}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {!hideTrackToolbar && (
        <section className={`tracks-toolbar ${playlistMode ? 'is-playlist-mode' : ''}`}>
          <div className="tracks-toolbar-main">
            <label className="tracks-search-wrap">
              <SearchIcon />
              <input
                className="search tracks-search"
                placeholder="Search title, artist, album…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            </label>
            <div className="tracks-toolbar-actions">
              {sortValue && onSortChange && (
                <label className="tracks-toolbar-control tracks-toolbar-sort">
                  <span className="view-select-label">Sort</span>
                  <select
                    className="view-select tracks-select"
                    value={sortValue}
                    onChange={(event) => onSortChange(event.currentTarget.value as TrackSortOption)}
                  >
                    {trackSortOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
          {!playlistMode && (
            <>
              <div className="tracks-filter-grid">
                <label className="tracks-filter-card">
                  <span className="view-select-label">Artist</span>
                  <select
                    className="view-select tracks-select"
                    value={artistFilterValue}
                    onChange={(event) => onArtistFilterChange(event.currentTarget.value)}
                  >
                    <option value={allTrackFilterValue}>All artists</option>
                    {artistFilterOptions.map((artist) => (
                      <option key={artist} value={artist}>
                        {artist}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tracks-filter-card">
                  <span className="view-select-label">Genre</span>
                  <select
                    className="view-select tracks-select"
                    value={genreFilterValue}
                    onChange={(event) => onGenreFilterChange(event.currentTarget.value)}
                  >
                    <option value={allTrackFilterValue}>All genres</option>
                    {genreFilterOptions.map((genre) => (
                      <option key={genre} value={genre}>
                        {genre}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tracks-filter-card tracks-filter-card-year">
                  <span className="view-select-label">Year</span>
                  <div className="tracks-year-range">
                    <select
                      className="view-select tracks-select"
                      value={yearFilterFromValue}
                      onChange={(event) => onYearFilterFromChange(event.currentTarget.value as TrackYearBoundaryFilter)}
                    >
                      <option value={allTrackFilterValue}>From</option>
                      {yearFilterOptions.map((year) => (
                        <option key={`from-${year}`} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                    <span className="tracks-year-range-separator">→</span>
                    <select
                      className="view-select tracks-select"
                      value={yearFilterToValue}
                      onChange={(event) => onYearFilterToChange(event.currentTarget.value as TrackYearBoundaryFilter)}
                    >
                      <option value={allTrackFilterValue}>To</option>
                      {yearFilterOptions.map((year) => (
                        <option key={`to-${year}`} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
              </div>
              <div className="tracks-toolbar-footer">
                <span className="tracks-filter-status">
                  {hasTrackFilters ? 'Filters are shaping this view' : 'Save this filtered view as a playlist snapshot'}
                </span>
                <div className="tracks-toolbar-footer-actions">
                  {hasTrackFilters && (
                    <button className="ghost-button" onClick={onClearTrackFilters}>
                      Clear filters
                    </button>
                  )}
                  {onSaveAsPlaylist && (
                    <button className="ghost-button" onClick={onSaveAsPlaylist} disabled={totalTracks === 0}>
                      {saveActionLabel ?? '+ Save as playlist'}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {totalTracks === 0 ? (
        <div className="empty">
          <div className="empty-icon">♪</div>
          <h2>{emptyTitle}</h2>
          <p>{emptyMessage}</p>
        </div>
      ) : (
        <>
          {renderPagination()}
          <div className="track-list">
            {tracks.map((track, index) => {
              const isCurrent = track.path === currentPath;
              const isQueued = queuePaths.includes(track.path);
              const albumKeyValue = trackAlbumKey(track);
              const displayIndex = pageStartIndex + index;
              const playlistSourceIndex = playlistSourceTrackIndices?.[index] ?? displayIndex;
              const playlistLastIndex =
                typeof playlistSourceTotalCount === 'number'
                  ? playlistSourceTotalCount - 1
                  : Math.max(totalTracks - 1, 0);
              const favoriteIsPending = pendingFavoritePaths.includes(track.path);
              const ratingIsPending = pendingRatingPaths.includes(track.path);
              const bpmIsPending = pendingBpmPaths.includes(track.path);
              return (
                <div key={track.id} className={`track-row ${isCurrent ? 'playing' : ''}`}>
                  <Cover
                    trackPath={track.path}
                    fallback={(track.album ?? track.title)[0]?.toUpperCase() ?? '♪'}
                    size="md"
                    imageMode="deferred"
                    lazyLoad
                  />
                  <button className="track-row-main" onClick={() => onPlay(track)}>
                    <span className="track-index">
                      {isCurrent ? <PlayingIndicator /> : displayIndex + 1}
                    </span>
                    <span className="track-title-wrap">
                      <span className="track-title">{track.title}</span>
                      <span className="track-play-meta">
                        {[
                          (track.play_count ?? 0) > 0
                            ? `${track.play_count} play${track.play_count === 1 ? '' : 's'}`
                            : 'Unplayed so far',
                          track.is_favorite ? 'Favourite' : null,
                          track.rating ? `Rated ${formatTrackRatingLabel(track.rating)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="track-duration">{formatDuration(track.duration_seconds)}</span>
                  </button>
                  <span className="track-context-wrap">
                    <span className="track-artist-wrap">
                      {track.artist ? (
                        <button className="track-detail-link" onClick={() => onOpenArtist(track.artist ?? '')}>
                          {track.artist}
                        </button>
                      ) : (
                        <span className="track-detail-link is-static">Unknown artist</span>
                      )}
                    </span>
                    <span className="track-album-wrap">
                      {track.album && albumKeyValue ? (
                        <button className="track-detail-link track-detail-subtle" onClick={() => onOpenAlbum(albumKeyValue)}>
                          {track.album}
                        </button>
                      ) : (
                        <span className="track-detail-link track-detail-subtle is-static">Standalone track</span>
                      )}
                    </span>
                  </span>
                  <span className="album-track-actions">
                    <TrackBpmControl
                      track={track}
                      metadataEditMode={metadataEditMode}
                      disabled={bpmIsPending}
                      onAdjust={onAdjustBpm}
                      onOpenEditor={onOpenBpmEditor}
                    />
                    <TrackFavoriteControl
                      track={track}
                      disabled={favoriteIsPending}
                      onToggleFavorite={onToggleFavorite}
                    />
                    <TrackRatingControl
                      track={track}
                      disabled={ratingIsPending}
                      onSetRating={onSetRating}
                    />
                    {playlistMode && playlistTracksEditable ? (
                      <>
                        <button
                          className="row-icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onMovePlaylistTrack?.(playlistSourceIndex, Math.max(playlistSourceIndex - 1, 0));
                          }}
                          disabled={playlistSourceIndex <= 0}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          className="row-icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onMovePlaylistTrack?.(
                              playlistSourceIndex,
                              Math.min(playlistSourceIndex + 1, playlistLastIndex),
                            );
                          }}
                          disabled={playlistSourceIndex < 0 || playlistSourceIndex >= playlistLastIndex}
                          title="Move down"
                        >
                          ↓
                        </button>
                        <button
                          className="row-icon-button is-danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemovePlaylistTrack?.(playlistSourceIndex);
                          }}
                          disabled={playlistSourceIndex < 0}
                          title="Remove"
                        >
                          ×
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="row-icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onPlayNext(track);
                          }}
                          title={`Play ${track.title} next`}
                          aria-label={`Play ${track.title} next`}
                        >
                          <NextIcon />
                        </button>
                        <button
                          className={`row-icon-button ${isQueued ? 'is-queued' : ''}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void onAddToQueue(track);
                          }}
                          title={`Add ${track.title} to queue`}
                          aria-label={`Add ${track.title} to queue`}
                        >
                          <QueueIcon />
                        </button>
                        {onAddTrackToPlaylist && (
                          <button
                            className="row-icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onAddTrackToPlaylist(track);
                            }}
                            title={`Add ${track.title} to a playlist`}
                            aria-label={`Add ${track.title} to a playlist`}
                          >
                            <PlaylistIcon />
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {renderPagination()}
        </>
      )}
    </div>
  );
}

interface AlbumDetailViewProps {
  album: string;
  albumKey: string;
  albumArtist: string | null;
  isVinylRip: boolean;
  tracks: Track[];
  isMetadataRefreshing: boolean;
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
  onAddAlbumToPlaylist: () => void;
  onAddTrackToPlaylist: (track: Track) => void;
  onToggleFavorite: (track: Track, favorite: boolean) => void;
  pendingFavoritePaths: string[];
  onSetRating: (track: Track, rating: number | null) => void;
  pendingRatingPaths: string[];
  metadataEditMode: MetadataEditMode;
  onAdjustBpm: (track: Track, adjustment: TrackBpmAdjustment) => void;
  onOpenBpmEditor: (track: Track) => void;
  pendingBpmPaths: string[];
  onEditGenre: (currentGenre: string | null, suggestedGenres: string[], trackPaths: string[]) => void;
  onRefreshMetadata: () => void;
  onPlayAlbum: () => void;
  onShuffleAlbum: () => void;
  onOpenArtist: (artist: string) => void;
}

function AlbumDetailView({
  album,
  albumKey,
  albumArtist,
  isVinylRip,
  tracks,
  isMetadataRefreshing,
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
  onAddAlbumToPlaylist,
  onAddTrackToPlaylist,
  onToggleFavorite,
  pendingFavoritePaths,
  onSetRating,
  pendingRatingPaths,
  metadataEditMode,
  onAdjustBpm,
  onOpenBpmEditor,
  pendingBpmPaths,
  onEditGenre,
  onRefreshMetadata,
  onPlayAlbum,
  onShuffleAlbum,
  onOpenArtist,
}: AlbumDetailViewProps) {
  const [isMetadataMenuOpen, setIsMetadataMenuOpen] = useState(false);
  const metadataMenuRef = useRef<HTMLDivElement | null>(null);
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
      for (const part of splitTrackGenres(effectiveTrackGenre(t))) {
        set.add(part);
      }
    }
    return Array.from(set);
  }, [albumTracks]);
  const suggestedGenreValues = useMemo(
    () => uniqueSorted(albumTracks.map((track) => effectiveTrackGenre(track) ?? '').filter(Boolean)),
    [albumTracks],
  );
  const currentGenreValue =
    suggestedGenreValues.length === 1 ? suggestedGenreValues[0] : (suggestedGenreValues[0] ?? null);

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
  const { info, loading: infoLoading, retrying: infoRetrying, retry: retryAlbumInfo } = useAlbumInfo(
    album,
    primaryArtist,
  );

  useEffect(() => {
    setIsMetadataMenuOpen(false);
  }, [album, albumArtist]);

  useEffect(() => {
    if (!isMetadataMenuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!metadataMenuRef.current?.contains(event.target as Node)) {
        setIsMetadataMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMetadataMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isMetadataMenuOpen]);

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
        <div
          className="artist-hero-media"
          ref={metadataMenuRef}
          onContextMenu={(event) => {
            event.preventDefault();
            setIsMetadataMenuOpen(true);
          }}
        >
          <Cover
            trackPath={samplePath}
            fallback={album[0]?.toUpperCase() ?? '◉'}
            size="hero"
            vinylRip={isVinylRip}
          />
          {isMetadataRefreshing && (
            <div className="artist-image-refresh-overlay" aria-hidden="true">
              <div className="artist-image-refresh-spinner" />
              <div className="artist-image-refresh-label">Refreshing metadata…</div>
            </div>
          )}
          {isMetadataMenuOpen && (
            <div className="artist-image-menu-panel" role="menu" aria-label={`Metadata options for ${album}`}>
              <button
                className="artist-image-menu-option"
                onClick={() => {
                  setIsMetadataMenuOpen(false);
                  onRefreshMetadata();
                }}
                disabled={isMetadataRefreshing}
                role="menuitem"
              >
                {isMetadataRefreshing ? 'Refreshing metadata…' : 'Refresh metadata from MusicBrainz'}
              </button>
            </div>
          )}
        </div>
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
          <div className="album-primary-genre">
            <span className="album-primary-genre-label">Genres</span>
            <span className={`album-primary-genre-pill ${genres.length > 0 ? 'is-set' : ''}`}>
              {genres.length === 0 ? 'Not set' : `${genres.length} tag${genres.length === 1 ? '' : 's'}`}
            </span>
            <button
              className="album-primary-genre-edit"
              onClick={() => onEditGenre(currentGenreValue, suggestedGenreValues, albumTracks.map((track) => track.path))}
              title={currentGenreValue ? `Edit genres · ${currentGenreValue}` : 'Edit genres'}
              aria-label={currentGenreValue ? `Edit genres · ${currentGenreValue}` : 'Edit genres'}
            >
              <PencilIcon />
            </button>
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
            <button className="ghost-button" onClick={onAddAlbumToPlaylist}>
              + Add to playlist
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
              <button
                className="album-about-link"
                onClick={() => void openExternalUrl(info.source_url ?? '')}
              >
                Read more on Wikipedia →
              </button>
            )}
          </p>
        ) : infoLoading ? (
          <p className="muted">Looking up album info…</p>
        ) : (
          <div className="album-about-empty">
            <p className="muted">
              No background info found for this album. (We pull these from
              Wikipedia via MusicBrainz — very obscure releases or non-album
              collections may not have anything.)
            </p>
            <button
              className="album-about-retry"
              onClick={() => void retryAlbumInfo()}
              disabled={infoRetrying}
            >
              {infoRetrying ? 'Retrying…' : 'Retry lookup'}
            </button>
          </div>
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
                  const favoriteIsPending = pendingFavoritePaths.includes(t.path);
                  const ratingIsPending = pendingRatingPaths.includes(t.path);
                  const bpmIsPending = pendingBpmPaths.includes(t.path);
                  const techDetails = formatTrackTechDetails(t);
                  const vibeLabel = vibeLabelForTrack(t);
                  return (
                    <div
                      key={t.id}
                      className={`album-track-row ${isCurrent ? 'playing' : ''}`}
                    >
                      <button
                        className="album-track-row-main"
                        onClick={() => onPlayTrack(t)}
                      >
                        <span className="album-track-num">
                          {isCurrent ? <PlayingIndicator /> : (t.track_number ?? '—')}
                        </span>
                        <span className="album-track-copy">
                          <span className="album-track-title">{t.title}</span>
                          {(techDetails || vibeLabel) && (
                            <span className="album-track-meta muted">
                              {techDetails && <span className="album-track-tech">{techDetails}</span>}
                              {vibeLabel && (
                                <span
                                  className={`album-track-vibe ${techDetails ? 'has-tech' : ''} ${albumTrackVibeToneClass(t)}`}
                                >
                                  {vibeLabel}
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                        <span className="album-track-duration">
                          {formatDuration(t.duration_seconds)}
                        </span>
                      </button>
                      <span className="album-track-actions">
                        <TrackBpmControl
                          track={t}
                          metadataEditMode={metadataEditMode}
                          disabled={bpmIsPending}
                          onAdjust={onAdjustBpm}
                          onOpenEditor={onOpenBpmEditor}
                        />
                        <TrackFavoriteControl
                          track={t}
                          disabled={favoriteIsPending}
                          onToggleFavorite={onToggleFavorite}
                        />
                        <TrackRatingControl
                          track={t}
                          disabled={ratingIsPending}
                          onSetRating={onSetRating}
                        />
                        <button
                          className="row-icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onPlayNext(t);
                          }}
                          title={`Play ${t.title} next`}
                          aria-label={`Play ${t.title} next`}
                        >
                          <NextIcon />
                        </button>
                        <button
                          className={`row-icon-button ${isQueued ? 'is-queued' : ''}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void onAddToQueue(t);
                          }}
                          title={`Add ${t.title} to queue`}
                          aria-label={`Add ${t.title} to queue`}
                        >
                          <QueueIcon />
                        </button>
                        <button
                          className="row-icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onAddTrackToPlaylist(t);
                          }}
                          title={`Add ${t.title} to a playlist`}
                          aria-label={`Add ${t.title} to a playlist`}
                        >
                          <PlaylistIcon />
                        </button>
                      </span>
                    </div>
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

interface ArtistDetailViewProps {
  artist: string;
  mode: ArtistBrowseMode;
  summary: ArtistSummary | null;
  tracks: Track[];
  albums: AlbumSummary[];
  currentPath: string | null;
  queuePaths: string[];
  onBack: () => void;
  onPlayTrack: (track: Track) => void;
  onPlayNext: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onPlayArtist: () => void;
  onPlayArtistNext: () => void;
  onAddArtistToQueue: () => void;
  onViewTracks: () => void;
  onOpenAlbum: (albumKey: string) => void;
  onPlayAlbum: (albumKey: string) => void;
  onPlayAlbumNext: (albumKey: string) => void;
  onAddAlbumToQueue: (albumKey: string) => void;
  onAddAlbumToPlaylist: (albumKey: string) => void;
  onPlayTopTracks: () => void;
  onShuffleTopTracks: () => void;
  onPlayTopTracksNext: () => void;
  onAddTopTracksToQueue: () => void;
  onAddTrackToPlaylist: (track: Track) => void;
  onToggleFavorite: (track: Track, favorite: boolean) => void;
  pendingFavoritePaths: string[];
  onSetRating: (track: Track, rating: number | null) => void;
  pendingRatingPaths: string[];
  metadataEditMode: MetadataEditMode;
  onAdjustBpm: (track: Track, adjustment: TrackBpmAdjustment) => void;
  onOpenBpmEditor: (track: Track) => void;
  pendingBpmPaths: string[];
}

function ArtistDetailView({
  artist,
  mode,
  summary,
  tracks,
  albums,
  currentPath,
  queuePaths,
  onBack,
  onPlayTrack,
  onPlayNext,
  onAddToQueue,
  onPlayArtist,
  onPlayArtistNext,
  onAddArtistToQueue,
  onViewTracks,
  onOpenAlbum,
  onPlayAlbum,
  onPlayAlbumNext,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
  onPlayTopTracks,
  onShuffleTopTracks,
  onPlayTopTracksNext,
  onAddTopTracksToQueue,
  onAddTrackToPlaylist,
  onToggleFavorite,
  pendingFavoritePaths,
  onSetRating,
  pendingRatingPaths,
  metadataEditMode,
  onAdjustBpm,
  onOpenBpmEditor,
  pendingBpmPaths,
}: ArtistDetailViewProps) {
  const [isBioExpanded, setIsBioExpanded] = useState(false);
  const [isImageMenuOpen, setIsImageMenuOpen] = useState(false);
  const imageMenuRef = useRef<HTMLDivElement | null>(null);
  const {
    url: artistImageUrl,
    retrying: artistImageRetrying,
    retry: retryArtistImage,
  } = useArtistImage(artist);
  const { info, loading: infoLoading, retrying: infoRetrying, retry: retryArtistInfo } = useArtistInfo(artist);
  const artistTracks = useMemo(
    () => tracks.filter((track) => artistNameForTrack(track, mode) === artist),
    [artist, mode, tracks],
  );
  const artistAlbumKeys = useMemo(
    () => new Set(artistTracks.map((track) => trackAlbumKey(track)).filter((key): key is string => Boolean(key))),
    [artistTracks],
  );
  const artistAlbums = useMemo(
    () =>
      albums
        .filter((album) => artistAlbumKeys.has(album.key))
        .slice()
        .sort(
          (a, b) =>
            (b.year ?? Number.NEGATIVE_INFINITY) - (a.year ?? Number.NEGATIVE_INFINITY) ||
            compareText(a.album, b.album) ||
            compareText(a.key, b.key),
        ),
    [albums, artistAlbumKeys],
  );
  const topTracks = useMemo(
    () => artistTracks.slice().sort(compareTracksBySort('plays')).slice(0, 10),
    [artistTracks],
  );
  const totalPlays = useMemo(
    () => artistTracks.reduce((sum, track) => sum + (track.play_count ?? 0), 0),
    [artistTracks],
  );
  const yearLine = useMemo(() => {
    const years = artistTracks
      .map((track) => track.year)
      .filter((year): year is number => typeof year === 'number')
      .sort((a, b) => a - b);
    if (years.length === 0) return null;
    const first = years[0];
    const last = years[years.length - 1];
    return first === last ? `${first}` : `${first}–${last}`;
  }, [artistTracks]);
  const fallbackArtworkPath = artistAlbums[0]?.samplePath ?? artistTracks[0]?.path ?? null;
  const shouldClampBio = (info?.description?.length ?? 0) > 320;
  const canRefreshBio = infoLoading || infoRetrying ? false : true;
  useEffect(() => {
    setIsBioExpanded(false);
    setIsImageMenuOpen(false);
  }, [artist, info?.description]);

  useEffect(() => {
    if (!isImageMenuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!imageMenuRef.current?.contains(event.target as Node)) {
        setIsImageMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsImageMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isImageMenuOpen]);

  return (
    <div className="view artist-detail">
      <button className="back-button" onClick={onBack}>
        ← Back
      </button>

      <header className="artist-hero">
        <div
          className="artist-hero-media"
          ref={imageMenuRef}
          onContextMenu={(event) => {
            event.preventDefault();
            setIsImageMenuOpen(true);
          }}
        >
          <ArtistAvatar
            name={artist}
            size="hero"
            urlOverride={artistImageUrl}
            fallbackTrackPath={fallbackArtworkPath}
          />
          {artistImageRetrying && (
            <div className="artist-image-refresh-overlay" aria-hidden="true">
              <div className="artist-image-refresh-spinner" />
              <div className="artist-image-refresh-label">Refreshing photo…</div>
            </div>
          )}
          {isImageMenuOpen && (
            <div className="artist-image-menu-panel" role="menu" aria-label={`Refresh options for ${artist}`}>
              <button
                className="artist-image-menu-option"
                onClick={() => {
                  setIsImageMenuOpen(false);
                  void retryArtistImage();
                }}
                disabled={artistImageRetrying}
                role="menuitem"
              >
                {artistImageRetrying ? 'Refreshing photo…' : 'Refresh photo'}
              </button>
              <button
                className="artist-image-menu-option"
                onClick={() => {
                  setIsImageMenuOpen(false);
                  void retryArtistInfo();
                }}
                disabled={!canRefreshBio}
                role="menuitem"
              >
                {infoRetrying ? 'Refreshing bio…' : 'Refresh bio'}
              </button>
            </div>
          )}
        </div>
        <div className="artist-hero-meta">
          <div className="album-hero-eyebrow">Artist</div>
          <h1 className="album-hero-title">{artist}</h1>
          <div className="artist-hero-line">
            {[
              `${summary?.albumCount ?? artistAlbums.length} album${(summary?.albumCount ?? artistAlbums.length) === 1 ? '' : 's'}`,
              `${summary?.count ?? artistTracks.length} track${(summary?.count ?? artistTracks.length) === 1 ? '' : 's'}`,
              totalPlays > 0 ? `${totalPlays} play${totalPlays === 1 ? '' : 's'}` : null,
              yearLine,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {isDevBuild && (
            <div className="artist-debug-line">Debug · MusicBrainz gender: {formatArtistGenderLabel(info?.gender)}</div>
          )}
          <div className="album-hero-actions">
            <button className="primary-button" onClick={onPlayArtist}>
              ⤮ Shuffle artist
            </button>
            <button className="ghost-button" onClick={onPlayArtistNext}>
              ≫ Play next
            </button>
            <button className="ghost-button" onClick={onAddArtistToQueue}>
              + Add to queue
            </button>
            <button className="ghost-button" onClick={onViewTracks}>
              View tracks
            </button>
          </div>
          <div className="artist-hero-about">
            <h2 className="section-title">About this artist</h2>
            {info?.description ? (
              <>
                <p
                  className={`album-about-text artist-about-text ${
                    shouldClampBio && !isBioExpanded ? 'is-clamped' : ''
                  }`}
                >
                  {info.description}
                  {shouldClampBio && (
                    <>
                      {' '}
                      <button
                        className="album-about-retry artist-about-toggle"
                        onClick={() => setIsBioExpanded((value) => !value)}
                      >
                        {isBioExpanded ? 'Show less' : 'Read more'}
                      </button>
                    </>
                  )}
                  {info.source_url && (
                    <>
                      {' '}
                      <button
                        className="album-about-link"
                        onClick={() => void openExternalUrl(info.source_url ?? '')}
                      >
                        Read more on Wikipedia →
                      </button>
                    </>
                  )}
                </p>
              </>
            ) : infoLoading ? (
              <p className="muted">Looking up artist info…</p>
            ) : (
              <div className="album-about-empty">
                <p className="muted">
                  No background info found for this artist yet. (We currently pull these from
                  Wikipedia via MusicBrainz when linked metadata is available.)
                </p>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className="artist-albums">
        <div className="section-head">
          <h2 className="section-title">Albums</h2>
          {artistAlbums.length > 0 && (
            <div className="section-actions">
              <button className="ghost-button" onClick={onViewTracks}>
                View tracks
              </button>
            </div>
          )}
        </div>
        {artistAlbums.length === 0 ? (
          <p className="muted">No albums in your library are currently grouped under this artist.</p>
        ) : (
          <div className="card-grid artist-album-grid">
            {artistAlbums.map((album) => (
              <div key={album.key} className="card-wrap">
                <button
                  className="card-play"
                  onClick={() => onPlayAlbum(album.key)}
                  title={`Play ${album.album}`}
                  aria-label={`Play ${album.album}`}
                >
                  ▶
                </button>
                <button className="card" onClick={() => onOpenAlbum(album.key)}>
                  <Cover
                    trackPath={album.samplePath}
                    fallback={album.album[0]?.toUpperCase() ?? '◉'}
                    size="card"
                    vinylRip={album.is_vinyl_rip}
                  />
                  <div className="card-title">{album.album}</div>
                  <div className="card-sub">{album.year ?? relativeAdded(album.addedAt)}</div>
                  <div className="card-meta">{album.count} tracks</div>
                </button>
                <div className="card-actions">
                  <button
                    className="card-mini-action"
                    onClick={() => onPlayAlbumNext(album.key)}
                    title={`Play ${album.album} next`}
                    aria-label={`Play ${album.album} next`}
                  >
                    <NextIcon />
                  </button>
                  <button
                    className="card-mini-action"
                    onClick={() => onAddAlbumToQueue(album.key)}
                    title={`Add ${album.album} to queue`}
                    aria-label={`Add ${album.album} to queue`}
                  >
                    <QueueIcon />
                  </button>
                  <button
                    className="card-mini-action"
                    onClick={() => onAddAlbumToPlaylist(album.key)}
                    title={`Add ${album.album} to a playlist`}
                    aria-label={`Add ${album.album} to a playlist`}
                  >
                    <PlaylistIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="artist-top-tracks">
        <div className="section-head artist-section-head">
          <h2 className="section-title">Most played tracks</h2>
          {topTracks.length > 0 && (
            <div className="section-actions artist-track-actions-bar">
              <button className="primary-button" onClick={onPlayTopTracks}>
                ▶ Play
              </button>
              <button className="ghost-button" onClick={onPlayTopTracksNext}>
                ≫ Play next
              </button>
              <button className="ghost-button" onClick={onAddTopTracksToQueue}>
                + Add to queue
              </button>
              <button className="ghost-button" onClick={onShuffleTopTracks}>
                ⤮ Shuffle
              </button>
            </div>
          )}
        </div>
        {topTracks.length === 0 ? (
          <p className="muted">No tracks from this artist are in your library yet.</p>
        ) : (
          <div className="album-track-list artist-track-list">
            {topTracks.map((track, index) => {
              const isCurrent = currentPath === track.path;
              const isQueued = queuePaths.includes(track.path);
              const albumKeyValue = trackAlbumKey(track);
              const favoriteIsPending = pendingFavoritePaths.includes(track.path);
              const ratingIsPending = pendingRatingPaths.includes(track.path);
              const bpmIsPending = pendingBpmPaths.includes(track.path);
              return (
                <div key={track.id} className={`album-track-row artist-top-track-row ${isCurrent ? 'playing' : ''}`}>
                  <Cover
                    trackPath={track.path}
                    fallback={(track.album ?? track.title)[0]?.toUpperCase() ?? '♪'}
                    size="md"
                  />
                  <button className="album-track-row-main artist-top-track-main" onClick={() => onPlayTrack(track)}>
                    <span className="album-track-num">
                      {isCurrent ? <PlayingIndicator /> : index + 1}
                    </span>
                    <span className="artist-track-title-wrap">
                      <span className="album-track-title">{track.title}</span>
                      <span className="artist-track-play-meta">
                        {[
                          (track.play_count ?? 0) > 0
                            ? `${track.play_count} play${track.play_count === 1 ? '' : 's'}`
                            : 'Unplayed so far',
                          track.is_favorite ? 'Favourite' : null,
                          track.rating ? `Rated ${formatTrackRatingLabel(track.rating)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                  <span className="artist-track-duration">{formatDuration(track.duration_seconds)}</span>
                  <span className="artist-track-album-wrap">
                    {track.album && albumKeyValue ? (
                      <button className="artist-track-album-link" onClick={() => onOpenAlbum(albumKeyValue)}>
                        {track.album}
                      </button>
                    ) : (
                      <span className="artist-track-album-link is-static">Standalone track</span>
                    )}
                  </span>
                  <span className="artist-track-format">{formatTrackDetails(track)}</span>
                  <span className="album-track-actions">
                    <TrackBpmControl
                      track={track}
                      metadataEditMode={metadataEditMode}
                      disabled={bpmIsPending}
                      onAdjust={onAdjustBpm}
                      onOpenEditor={onOpenBpmEditor}
                    />
                    <TrackFavoriteControl
                      track={track}
                      disabled={favoriteIsPending}
                      onToggleFavorite={onToggleFavorite}
                    />
                    <TrackRatingControl
                      track={track}
                      disabled={ratingIsPending}
                      onSetRating={onSetRating}
                    />
                    <button
                      className="row-icon-button"
                      onClick={() => void onPlayNext(track)}
                      title={`Play ${track.title} next`}
                      aria-label={`Play ${track.title} next`}
                    >
                      <NextIcon />
                    </button>
                    <button
                      className={`row-icon-button ${isQueued ? 'is-queued' : ''}`}
                      onClick={() => void onAddToQueue(track)}
                      title={`Add ${track.title} to queue`}
                      aria-label={`Add ${track.title} to queue`}
                    >
                      <QueueIcon />
                    </button>
                    <button
                      className="row-icon-button"
                      onClick={() => onAddTrackToPlaylist(track)}
                      title={`Add ${track.title} to a playlist`}
                      aria-label={`Add ${track.title} to a playlist`}
                    >
                      <PlaylistIcon />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

interface AlbumsViewProps {
  albums: AlbumSummary[];
  sortValue: AlbumSortOption;
  onSortChange: (value: AlbumSortOption) => void;
  onSelect: (albumKey: string) => void;
  onPlayNextAlbum: (albumKey: string) => void;
  onAddAlbumToQueue: (albumKey: string) => void;
  onAddAlbumToPlaylist: (albumKey: string) => void;
}

function AlbumsView({
  albums,
  sortValue,
  onSortChange,
  onSelect,
  onPlayNextAlbum,
  onAddAlbumToQueue,
  onAddAlbumToPlaylist,
}: AlbumsViewProps) {
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-eyebrow">Library</div>
          <h1 className="view-title">Albums</h1>
        </div>
        <div className="view-actions">
          <label className="view-select-wrap">
            <span className="view-select-label">Sort</span>
            <select
              className="view-select"
              value={sortValue}
              onChange={(event) => onSortChange(event.currentTarget.value as AlbumSortOption)}
            >
              {albumSortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
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
                    vinylRip={a.is_vinyl_rip}
                    imageMode="deferred"
                    lazyLoad
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
                  aria-label={`Play ${a.album} next`}
                >
                  <NextIcon />
                </button>
                <button
                  className="card-mini-action"
                  onClick={() => onAddAlbumToQueue(a.key)}
                  title={`Add ${a.album} to queue`}
                  aria-label={`Add ${a.album} to queue`}
                >
                  <QueueIcon />
                </button>
                <button
                  className="card-mini-action"
                  onClick={() => onAddAlbumToPlaylist(a.key)}
                  title={`Add ${a.album} to a playlist`}
                  aria-label={`Add ${a.album} to a playlist`}
                >
                  <PlaylistIcon />
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
  size: 'md' | 'card' | 'hero' | 'queue' | 'mini';
  vinylRip?: boolean;
  imageMode?: 'default' | 'cache_only' | 'deferred';
  lazyLoad?: boolean;
}

function Cover({
  trackPath,
  fallback,
  size,
  vinylRip = false,
  imageMode = 'default',
  lazyLoad = false,
}: CoverProps) {
  const { ref, isNearViewport } = useNearViewport(lazyLoad);
  const url = useCoverArt(trackPath, {
    cacheOnly: imageMode === 'cache_only',
    defer: imageMode === 'deferred',
    enabled: isNearViewport,
  });
  const className =
    size === 'hero'
      ? 'cover-hero'
      : size === 'mini'
        ? 'mini-player-artwork'
      : size === 'card'
        ? 'card-art'
        : size === 'queue'
          ? 'cover cover-queue'
          : 'cover';

  if (url) {
    return (
      <div className={className} ref={ref}>
        <img src={url} alt="" className="cover-img" />
        {vinylRip && <VinylRipBadge size={size} />}
      </div>
    );
  }

  return (
    <div className={className} ref={ref}>
      {fallback}
      {vinylRip && <VinylRipBadge size={size} />}
    </div>
  );
}

function VinylRipBadge({ size }: { size: CoverProps['size'] }) {
  return (
    <span className={`vinyl-rip-badge vinyl-rip-badge-${size}`} title="Vinyl rip" aria-label="Vinyl rip">
      <img src={vinylRipBadgeIcon} alt="" className="vinyl-rip-badge-img" />
    </span>
  );
}

interface ArtistAvatarProps {
  name: string;
  size: 'sm' | 'lg' | 'hero';
  urlOverride?: string | null;
  fallbackTrackPath?: string | null;
  imageMode?: 'default' | 'cache_only';
  lazyLoad?: boolean;
}

function ArtistAvatar({
  name,
  size,
  urlOverride,
  fallbackTrackPath,
  imageMode = 'default',
  lazyLoad = false,
}: ArtistAvatarProps) {
  const { ref, isNearViewport } = useNearViewport(lazyLoad);
  const { url } = useArtistImage(urlOverride === undefined ? name : null, {
    cacheOnly: imageMode === 'cache_only',
    enabled: isNearViewport,
  });
  const fallbackArtworkUrl = useCoverArt(fallbackTrackPath ?? null, {
    cacheOnly: imageMode === 'cache_only',
    enabled: isNearViewport,
  });
  const resolvedUrl = urlOverride ?? url;
  const [imageFailed, setImageFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  const displayUrl = !imageFailed && resolvedUrl ? resolvedUrl : !fallbackFailed ? fallbackArtworkUrl : null;
  const className =
    size === 'hero'
      ? 'artist-portrait'
      : size === 'lg'
        ? 'avatar avatar-lg'
        : 'avatar';
  const initial = name[0]?.toUpperCase() ?? '?';

  useEffect(() => {
    setImageFailed(false);
    setFallbackFailed(false);
  }, [resolvedUrl, fallbackArtworkUrl, fallbackTrackPath]);

  if (displayUrl) {
    return (
      <div className={className} ref={ref}>
        <img
          src={displayUrl}
          alt=""
          className="avatar-img"
          referrerPolicy="no-referrer"
          onError={() => {
            if (!imageFailed && resolvedUrl) {
              setImageFailed(true);
              return;
            }
            setFallbackFailed(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className={className} ref={ref}>
      {initial}
    </div>
  );
}

interface ArtistsViewProps {
  artists: ArtistSummary[];
  sortValue: ArtistSortOption;
  onSortChange: (value: ArtistSortOption) => void;
  search: string;
  onSearch: (value: string) => void;
  browseMode: ArtistBrowseMode;
  onBrowseModeChange: (value: ArtistBrowseMode) => void;
  layoutMode: ArtistLayoutMode;
  onLayoutModeChange: (value: ArtistLayoutMode) => void;
  onSelect: (artist: string) => void;
}

function ArtistsView({
  artists,
  sortValue,
  onSortChange,
  search,
  onSearch,
  browseMode,
  onBrowseModeChange,
  layoutMode,
  onLayoutModeChange,
  onSelect,
}: ArtistsViewProps) {
  const scopeLabel = browseMode === 'album' ? 'Album artists' : 'All artists';
  const emptyTitle = search.trim() ? 'No matching artists' : `No ${browseMode === 'album' ? 'album artists' : 'artists'}`;
  const emptyMessage = search.trim()
    ? `Try a different search than “${search.trim()}”.`
    : browseMode === 'album'
      ? 'No album artists are available from your imported library yet.'
      : 'No artists are available from your imported library yet.';

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-eyebrow">{scopeLabel}</div>
          <h1 className="view-title">Artists</h1>
        </div>
      </header>
      <section className="tracks-toolbar artists-toolbar">
        <div className="tracks-toolbar-main artists-toolbar-main">
          <label className="tracks-search-wrap">
            <SearchIcon />
            <input
              className="search tracks-search"
              placeholder={`Search ${browseMode === 'album' ? 'album artists' : 'artists'}…`}
              value={search}
              onChange={(event) => onSearch(event.currentTarget.value)}
            />
          </label>
          <div className="tracks-toolbar-actions artists-toolbar-actions">
            <label className="tracks-toolbar-control">
              <span className="view-select-label">Show</span>
              <select
                className="view-select tracks-select"
                value={browseMode}
                onChange={(event) => onBrowseModeChange(event.currentTarget.value as ArtistBrowseMode)}
              >
                {artistBrowseModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="tracks-toolbar-control">
              <span className="view-select-label">Sort</span>
              <select
                className="view-select tracks-select"
                value={sortValue}
                onChange={(event) => onSortChange(event.currentTarget.value as ArtistSortOption)}
              >
                {artistSortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>
      <div className="section-head artist-browser-head">
        <h2 className="section-title">{artists.length} shown</h2>
        <div className="artist-browser-layout-toggle" role="group" aria-label="Artist layout">
          <button
            className={`row-icon-button artist-layout-button ${layoutMode === 'list' ? 'is-active' : ''}`}
            onClick={() => onLayoutModeChange('list')}
            aria-label="List view"
            aria-pressed={layoutMode === 'list'}
            title="List view"
          >
            <ListLayoutIcon />
          </button>
          <button
            className={`row-icon-button artist-layout-button ${layoutMode === 'grid' ? 'is-active' : ''}`}
            onClick={() => onLayoutModeChange('grid')}
            aria-label="Grid view"
            aria-pressed={layoutMode === 'grid'}
            title="Grid view"
          >
            <GridLayoutIcon />
          </button>
        </div>
      </div>
      {artists.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">☻</div>
          <h2>{emptyTitle}</h2>
          <p className="muted">{emptyMessage}</p>
        </div>
      ) : layoutMode === 'grid' ? (
        <div className="artist-row artist-browser-grid">
          {artists.map((artist) => (
            <button key={artist.artist} className="artist-tile artist-browser-tile" onClick={() => onSelect(artist.artist)}>
              <ArtistAvatar
                name={artist.artist}
                size="lg"
                fallbackTrackPath={artist.samplePath}
                imageMode="cache_only"
                lazyLoad
              />
              <div className="artist-tile-name">{artist.artist}</div>
              <div className="artist-tile-meta">{formatArtistCounts(artist.albumCount, artist.count)}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="list">
          {artists.map((artist) => (
            <button key={artist.artist} className="list-row" onClick={() => onSelect(artist.artist)}>
              <ArtistAvatar
                name={artist.artist}
                size="sm"
                fallbackTrackPath={artist.samplePath}
                imageMode="cache_only"
                lazyLoad
              />
              <div className="list-main">
                <div className="list-title">{artist.artist}</div>
                <div className="list-sub">{formatArtistCounts(artist.albumCount, artist.count)}</div>
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
  runtimeInfo: RuntimeInfo | null;
  currentAccentColor: string;
  onChange: (next: AppSettings) => void;
  onAddFolder: () => void;
  onMaintenance: () => void;
  onLoudnessAnalysis: () => void;
  onRemoveRoot: (folder: string) => void;
  busy: boolean;
  maintenanceBusy: boolean;
  maintenanceLog: string[];
  loudnessAnalysisBusy: boolean;
  loudnessAnalysisLog: string[];
  loudnessAnalysisProgress: LoudnessAnalysisProgress | null;
  loudnessAnalysisFailures: LoudnessAnalysisFailure[];
  onCopyLoudnessFailures: () => void;
  missingLibraryRoots: string[];
  bpmAuditItems: BpmAuditItem[];
  onAdjustBpm: (track: Track, adjustment: TrackBpmAdjustment) => Promise<void>;
  onOpenBpmEditor: (track: Track) => void;
  pendingBpmPaths: string[];
  currentBpmAuditReviewPath: string | null;
  isBpmAuditReviewPlaying: boolean;
  onStartBpmAuditReview: (track: Track) => void;
  onToggleBpmAuditReviewPlayback: (track: Track | null) => void;
  onStepBpmAuditReview: (delta: number) => void;
  dismissedBpmAuditCount: number;
  onDismissBpmAuditItem: (track: Track) => void;
  onClearDismissedBpmAuditItems: () => void;
}

function SettingsView({
  settings,
  runtimeInfo,
  currentAccentColor,
  onChange,
  onAddFolder,
  onMaintenance,
  onLoudnessAnalysis,
  onRemoveRoot,
  busy,
  maintenanceBusy,
  maintenanceLog,
  loudnessAnalysisBusy,
  loudnessAnalysisLog,
  loudnessAnalysisProgress,
  loudnessAnalysisFailures,
  onCopyLoudnessFailures,
  missingLibraryRoots,
  bpmAuditItems,
  onAdjustBpm,
  onOpenBpmEditor,
  pendingBpmPaths,
  currentBpmAuditReviewPath,
  isBpmAuditReviewPlaying,
  onStartBpmAuditReview,
  onToggleBpmAuditReviewPlayback,
  onStepBpmAuditReview,
  dismissedBpmAuditCount,
  onDismissBpmAuditItem,
  onClearDismissedBpmAuditItems,
}: SettingsViewProps) {
  const isManualEqualizer = settings.equalizer_preset === 'manual';
  const accentColorValue = normalizeAccentColor(settings.accent_color) ?? currentAccentColor;
  const lastMaintenanceLabel = formatMaintenanceTimestamp(settings.last_maintenance_at);
  const lastLoudnessAnalysisLabel = formatMaintenanceTimestamp(settings.last_loudness_analysis_at);
  const [manualBandsDraft, setManualBandsDraft] = useState(() =>
    normalizeEqualizerBands(settings.equalizer_bands),
  );
  const maintenanceLogRef = useRef<HTMLDivElement | null>(null);
  const loudnessAnalysisLogRef = useRef<HTMLDivElement | null>(null);
  const bpmAuditBulkToggleRef = useRef<HTMLInputElement | null>(null);
  const missingRootsSet = useMemo(() => new Set(missingLibraryRoots), [missingLibraryRoots]);
  const selectableBpmAuditPaths = useMemo(
    () =>
      bpmAuditItems
        .filter((item) => item.suggestedAdjustment != null)
        .map((item) => item.track.path),
    [bpmAuditItems],
  );
  const selectableBpmAuditPathSet = useMemo(
    () => new Set(selectableBpmAuditPaths),
    [selectableBpmAuditPaths],
  );
  const [selectedBpmAuditPaths, setSelectedBpmAuditPaths] = useState<string[]>([]);
  const [isApplyingBpmAuditSelection, setIsApplyingBpmAuditSelection] = useState(false);
  const [isApplyingBpmAuditAutoFix, setIsApplyingBpmAuditAutoFix] = useState(false);
  const loudnessProgressRatio = loudnessAnalysisProgress?.total_tracks
    ? Math.min(1, loudnessAnalysisProgress.processed_tracks / loudnessAnalysisProgress.total_tracks)
    : 0;
  const loudnessProgressPercent = Math.round(loudnessProgressRatio * 100);
  const selectedBpmAuditPathSet = useMemo(
    () => new Set(selectedBpmAuditPaths),
    [selectedBpmAuditPaths],
  );
  const selectedSuggestedBpmAuditCount = selectedBpmAuditPaths.length;
  const hasSelectableBpmAuditItems = selectableBpmAuditPaths.length > 0;
  const areAllSuggestedBpmAuditItemsSelected =
    hasSelectableBpmAuditItems && selectedSuggestedBpmAuditCount === selectableBpmAuditPaths.length;
  const hasSomeSuggestedBpmAuditItemsSelected =
    selectedSuggestedBpmAuditCount > 0 && !areAllSuggestedBpmAuditItemsSelected;
  const selectedSuggestedBpmAuditItems = useMemo(
    () =>
      bpmAuditItems.filter(
        (item) =>
          selectedBpmAuditPathSet.has(item.track.path) &&
          item.suggestedAdjustment != null &&
          !pendingBpmPaths.includes(item.track.path),
      ),
    [bpmAuditItems, pendingBpmPaths, selectedBpmAuditPathSet],
  );
  const highConfidenceBpmAuditItems = useMemo(
    () =>
      bpmAuditItems.filter(
        (item) =>
          item.autoFixEligible &&
          item.suggestedAdjustment != null &&
          !pendingBpmPaths.includes(item.track.path),
      ),
    [bpmAuditItems, pendingBpmPaths],
  );
  const isApplyingAnyBpmAuditChange = isApplyingBpmAuditSelection || isApplyingBpmAuditAutoFix;
  const currentBpmAuditReviewIndex = currentBpmAuditReviewPath
    ? bpmAuditItems.findIndex((item) => item.track.path === currentBpmAuditReviewPath)
    : -1;
  const currentBpmAuditReviewItem =
    currentBpmAuditReviewIndex >= 0 ? bpmAuditItems[currentBpmAuditReviewIndex] ?? null : null;
  const hasPreviousBpmAuditReviewItem = currentBpmAuditReviewIndex > 0;
  const hasNextBpmAuditReviewItem =
    currentBpmAuditReviewIndex >= 0 && currentBpmAuditReviewIndex < bpmAuditItems.length - 1;

  useEffect(() => {
    setManualBandsDraft(normalizeEqualizerBands(settings.equalizer_bands));
  }, [settings.equalizer_bands, settings.equalizer_preset]);

  useEffect(() => {
    const node = maintenanceLogRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [maintenanceLog]);

  useEffect(() => {
    const node = loudnessAnalysisLogRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [loudnessAnalysisLog]);

  useEffect(() => {
    setSelectedBpmAuditPaths((current) => {
      const next = current.filter((path) => selectableBpmAuditPathSet.has(path));
      return next.length === current.length ? current : next;
    });
  }, [selectableBpmAuditPathSet]);

  useEffect(() => {
    if (!bpmAuditBulkToggleRef.current) {
      return;
    }
    bpmAuditBulkToggleRef.current.indeterminate = hasSomeSuggestedBpmAuditItemsSelected;
  }, [hasSomeSuggestedBpmAuditItemsSelected]);

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

  const toggleBpmAuditSelection = (path: string, checked: boolean) => {
    setSelectedBpmAuditPaths((current) => {
      if (checked) {
        return current.includes(path) ? current : current.concat(path);
      }
      return current.filter((entry) => entry !== path);
    });
  };

  const setAllSuggestedBpmAuditSelections = (checked: boolean) => {
    setSelectedBpmAuditPaths(checked ? selectableBpmAuditPaths : []);
  };

  const applySelectedBpmAuditSuggestions = async () => {
    if (selectedSuggestedBpmAuditItems.length === 0 || isApplyingAnyBpmAuditChange) {
      return;
    }

    setIsApplyingBpmAuditSelection(true);
    try {
      for (const item of selectedSuggestedBpmAuditItems) {
        if (!item.suggestedAdjustment) {
          continue;
        }
        await onAdjustBpm(item.track, item.suggestedAdjustment);
      }
      setSelectedBpmAuditPaths([]);
    } finally {
      setIsApplyingBpmAuditSelection(false);
    }
  };

  const applyHighConfidenceBpmAuditSuggestions = async () => {
    if (highConfidenceBpmAuditItems.length === 0 || isApplyingAnyBpmAuditChange) {
      return;
    }

    setIsApplyingBpmAuditAutoFix(true);
    try {
      for (const item of highConfidenceBpmAuditItems) {
        if (!item.suggestedAdjustment) {
          continue;
        }
        await onAdjustBpm(item.track, item.suggestedAdjustment);
      }
      setSelectedBpmAuditPaths((current) =>
        current.filter((path) => !highConfidenceBpmAuditItems.some((item) => item.track.path === path)),
      );
    } finally {
      setIsApplyingBpmAuditAutoFix(false);
    }
  };

  const applyBpmAuditAdjustment = async (
    item: BpmAuditItem,
    adjustment: Exclude<TrackBpmAdjustment, 'reset'>,
  ) => {
    const shouldAdvance = item.track.path === currentBpmAuditReviewPath;
    const nextReviewTrack =
      shouldAdvance
        ? bpmAuditItems[
            bpmAuditItems.findIndex((entry) => entry.track.path === item.track.path) + 1
          ]?.track ?? null
        : null;

    await onAdjustBpm(item.track, adjustment);

    if (shouldAdvance && nextReviewTrack) {
      onStartBpmAuditReview(nextReviewTrack);
    }
  };

  const dismissBpmAuditItem = (item: BpmAuditItem) => {
    const currentIndex = bpmAuditItems.findIndex((entry) => entry.track.path === item.track.path);
    const nextReviewTrack =
      item.track.path === currentBpmAuditReviewPath
        ? bpmAuditItems[currentIndex + 1]?.track ?? bpmAuditItems[currentIndex - 1]?.track ?? null
        : null;
    onDismissBpmAuditItem(item.track);
    if (nextReviewTrack) {
      onStartBpmAuditReview(nextReviewTrack);
    }
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
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-label">Accent color</label>
              <p className="settings-hint">
                Pick a custom accent for playback controls, buttons, queue highlights, and selection states across Needle.
              </p>
            </div>
            <div className="settings-row-control">
              <div className="settings-accent-control">
                <input
                  className="settings-accent-input"
                  type="color"
                  value={accentColorValue}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      accent_color: normalizeAccentColor(event.currentTarget.value),
                    })
                  }
                  aria-label="Accent color"
                />
                <div className="settings-accent-meta">
                  <div className="settings-accent-value">{accentColorValue.toUpperCase()}</div>
                  <div className="settings-accent-note">
                    {settings.accent_color ? 'Custom accent active' : 'Using theme default'}
                  </div>
                </div>
                <button className="ghost-button" onClick={() => onChange({ ...settings, accent_color: null })} disabled={!settings.accent_color}>
                  Reset
                </button>
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
            <h2>Metadata edits</h2>
            <p>Choose whether genre and BPM changes should stay inside Needle or update the files themselves.</p>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-label">Save mode</label>
              <p className="settings-hint">
                Needle will only show the currently selected behavior inside genre and BPM editors.
              </p>
            </div>
            <div className="settings-row-control">
              <div className="seg">
                {metadataEditModeOptions.map((option) => (
                  <button
                    key={option.value}
                    className={`seg-btn ${settings.metadata_edit_mode === option.value ? 'on' : ''}`}
                    onClick={() =>
                      onChange({
                        ...settings,
                        metadata_edit_mode: option.value,
                      })
                    }
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="settings-inline-note">
                {metadataEditModeOptions.find((option) => option.value === settings.metadata_edit_mode)?.hint}
              </p>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h2>BPM sanity check</h2>
            <p>
              Review tracks whose BPM looks suspicious for their range, genre families, or album context, then fix them
              with one click.
            </p>
          </div>
          <div className="settings-row settings-row-block">
            <div className="settings-row-copy">
              <label className="settings-label">Flagged tracks</label>
              <p className="settings-hint">
                Needle highlights likely half-time and double-time mistakes such as `95` vs `190`, plus obvious album
                outliers.
              </p>
            </div>
            {bpmAuditItems.length === 0 ? (
              <div className="settings-bpm-audit-empty">
                <div className="settings-library-empty">
                  {dismissedBpmAuditCount > 0
                    ? 'All current BPM audit candidates are marked as intentional.'
                    : 'No suspicious BPMs stood out in the current library snapshot.'}
                </div>
                {dismissedBpmAuditCount > 0 && (
                  <button className="ghost-button" type="button" onClick={onClearDismissedBpmAuditItems}>
                    Restore {dismissedBpmAuditCount} dismissed
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="settings-bpm-audit-toolbar">
                  <div className="settings-bpm-audit-toolbar-copy">
                    <div className="settings-maintenance-meta">
                      Showing the {bpmAuditItems.length} strongest BPM candidates to review.
                    </div>
                    {hasSelectableBpmAuditItems && (
                      <label className="settings-bpm-audit-toggle">
                        <input
                          ref={bpmAuditBulkToggleRef}
                          type="checkbox"
                          checked={areAllSuggestedBpmAuditItemsSelected}
                          onChange={(event) => setAllSuggestedBpmAuditSelections(event.currentTarget.checked)}
                          disabled={isApplyingAnyBpmAuditChange}
                        />
                        <span>
                          Select all suggested fixes
                          {selectedSuggestedBpmAuditCount > 0
                            ? ` · ${selectedSuggestedBpmAuditCount} selected`
                            : ''}
                        </span>
                      </label>
                    )}
                  </div>
                  <div className="settings-bpm-audit-toolbar-actions">
                    {dismissedBpmAuditCount > 0 && (
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={onClearDismissedBpmAuditItems}
                        disabled={isApplyingAnyBpmAuditChange}
                        title="Show BPMs you previously marked as intentional again"
                      >
                        Restore {dismissedBpmAuditCount} dismissed
                      </button>
                    )}
                    {selectedSuggestedBpmAuditCount > 0 && (
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => setSelectedBpmAuditPaths([])}
                        disabled={isApplyingAnyBpmAuditChange}
                      >
                        Clear
                      </button>
                    )}
                    {highConfidenceBpmAuditItems.length > 0 && (
                      <button
                        className="row-action-button settings-bpm-audit-apply-button is-auto"
                        type="button"
                        onClick={() => void applyHighConfidenceBpmAuditSuggestions()}
                        disabled={isApplyingAnyBpmAuditChange}
                        title="Best-effort album-based auto-fixes for the strongest half/double-time BPM candidates"
                      >
                        {isApplyingBpmAuditAutoFix
                          ? 'Auto-fixing…'
                          : `Auto-fix ${highConfidenceBpmAuditItems.length} high-confidence candidate${
                              highConfidenceBpmAuditItems.length === 1 ? '' : 's'
                            }`}
                      </button>
                    )}
                    <button
                      className="row-action-button settings-bpm-audit-apply-button is-suggested"
                      type="button"
                      onClick={() => void applySelectedBpmAuditSuggestions()}
                      disabled={selectedSuggestedBpmAuditItems.length === 0 || isApplyingAnyBpmAuditChange}
                    >
                      {isApplyingBpmAuditSelection
                        ? 'Applying…'
                        : `Apply ${selectedSuggestedBpmAuditItems.length} suggestion${
                            selectedSuggestedBpmAuditItems.length === 1 ? '' : 's'
                          }`}
                    </button>
                  </div>
                </div>
                <div className="settings-bpm-review-bar">
                  <div className="settings-bpm-review-copy">
                    <div className="settings-bpm-review-title">Review mode</div>
                    <div className="settings-bpm-review-sub">
                      {currentBpmAuditReviewItem
                        ? `${currentBpmAuditReviewItem.track.title} · ${
                            currentBpmAuditReviewItem.track.artist ?? 'Unknown artist'
                          }`
                        : 'Preview flagged tracks before you accept a halve or double suggestion.'}
                    </div>
                    {highConfidenceBpmAuditItems.length > 0 && (
                      <div className="settings-bpm-review-note">
                        Needle can auto-fix the strongest album-based BPM spikes, but it is still a best-effort heuristic.
                      </div>
                    )}
                    {dismissedBpmAuditCount > 0 && (
                      <div className="settings-bpm-review-note">
                        {dismissedBpmAuditCount} track{dismissedBpmAuditCount === 1 ? '' : 's'} marked as intentional
                        BPM {dismissedBpmAuditCount === 1 ? 'is' : 'are'} hidden from this queue.
                      </div>
                    )}
                  </div>
                  <div className="settings-bpm-review-controls">
                    <button
                      className="row-icon-button"
                      type="button"
                      onClick={() => onStepBpmAuditReview(-1)}
                      disabled={!hasPreviousBpmAuditReviewItem}
                      title="Previous flagged track"
                      aria-label="Previous flagged track"
                    >
                      <PreviousIcon />
                    </button>
                    <button
                      className="row-icon-button settings-bpm-review-toggle"
                      type="button"
                      onClick={() =>
                        onToggleBpmAuditReviewPlayback(currentBpmAuditReviewItem?.track ?? bpmAuditItems[0]?.track ?? null)
                      }
                      disabled={bpmAuditItems.length === 0}
                      title={
                        currentBpmAuditReviewItem
                          ? isBpmAuditReviewPlaying
                            ? 'Pause BPM review'
                            : 'Resume BPM review'
                          : 'Start BPM review'
                      }
                      aria-label={
                        currentBpmAuditReviewItem
                          ? isBpmAuditReviewPlaying
                            ? 'Pause BPM review'
                            : 'Resume BPM review'
                          : 'Start BPM review'
                      }
                    >
                      {currentBpmAuditReviewItem && isBpmAuditReviewPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <button
                      className="row-icon-button"
                      type="button"
                      onClick={() => onStepBpmAuditReview(1)}
                      disabled={!hasNextBpmAuditReviewItem}
                      title="Next flagged track"
                      aria-label="Next flagged track"
                    >
                      <NextIcon />
                    </button>
                  </div>
                </div>
                <div className="settings-bpm-audit-list">
                  {bpmAuditItems.map((item) => {
                    const bpmPending = pendingBpmPaths.includes(item.track.path);
                    const isSelectable = item.suggestedAdjustment != null;
                    const isSelected = selectedBpmAuditPathSet.has(item.track.path);
                    const isReviewing = item.track.path === currentBpmAuditReviewPath;
                    const suggestedActionLabel =
                      item.suggestedAdjustment === 'half'
                        ? `Apply halve${item.track.bpm ? ` to ${Math.max(1, Math.round(item.track.bpm / 2))} BPM` : ''}`
                        : item.suggestedAdjustment === 'double'
                          ? `Apply double${item.track.bpm ? ` to ${Math.max(1, item.track.bpm * 2)} BPM` : ''}`
                          : null;
                    return (
                      <div
                        key={item.track.path}
                        className={`settings-bpm-audit-item ${isReviewing ? 'is-reviewing' : ''}`}
                      >
                        <label
                          className={`settings-bpm-audit-select ${isSelectable ? '' : 'is-disabled'}`}
                          title={isSelectable ? 'Select this suggested fix' : 'No automatic suggestion yet'}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(event) => toggleBpmAuditSelection(item.track.path, event.currentTarget.checked)}
                            disabled={!isSelectable || isApplyingAnyBpmAuditChange}
                          />
                        </label>
                        <div className="settings-bpm-audit-copy">
                          <div className="settings-bpm-audit-head">
                            <div className="settings-bpm-audit-title">{item.track.title}</div>
                          </div>
                          <div className="settings-bpm-audit-sub">
                            {(item.track.artist ?? 'Unknown artist') + ' — ' + (item.track.album ?? 'Unknown album')}
                          </div>
                          <div className="settings-bpm-audit-meta">
                            {formatTrackDetails(item.track)}
                            {item.suggestedAdjustment && (
                              <span className="settings-bpm-audit-suggestion">
                                {item.suggestedAdjustment === 'half' ? 'Suggested: halve' : 'Suggested: double'}
                              </span>
                            )}
                            {item.confidence !== 'low' && (
                              <span
                                className={`settings-bpm-audit-confidence is-${item.confidence}`}
                                title={
                                  item.confidence === 'high'
                                    ? 'Strong album-based half/double-time candidate'
                                    : 'Multiple audit signals point in the same direction'
                                }
                              >
                                {item.confidence === 'high' ? 'High confidence' : 'Medium confidence'}
                              </span>
                            )}
                          </div>
                          <div className="settings-bpm-audit-reasons">
                            {item.reasons.map((reason) => (
                              <span key={`${item.track.path}-${reason.id}`} className="settings-bpm-audit-reason">
                                {reason.label}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="settings-bpm-audit-actions">
                          <button
                            className={`row-icon-button ${isReviewing ? 'is-queued' : ''}`}
                            type="button"
                            onClick={() =>
                              isReviewing
                                ? onToggleBpmAuditReviewPlayback(item.track)
                                : onStartBpmAuditReview(item.track)
                            }
                            disabled={isApplyingAnyBpmAuditChange}
                            title={
                              isReviewing
                                ? isBpmAuditReviewPlaying
                                  ? `Pause ${item.track.title}`
                                  : `Resume ${item.track.title}`
                                : `Preview ${item.track.title}`
                            }
                            aria-label={
                              isReviewing
                                ? isBpmAuditReviewPlaying
                                  ? `Pause ${item.track.title}`
                                  : `Resume ${item.track.title}`
                                : `Preview ${item.track.title}`
                            }
                          >
                            {isReviewing && isBpmAuditReviewPlaying ? <PauseIcon /> : <PlayIcon />}
                          </button>
                          {item.suggestedAdjustment ? (
                            <button
                              className="row-action-button settings-bpm-audit-apply-button is-suggested"
                              type="button"
                              onClick={() => {
                                if (item.suggestedAdjustment === 'half' || item.suggestedAdjustment === 'double') {
                                  void applyBpmAuditAdjustment(item, item.suggestedAdjustment);
                                }
                              }}
                              disabled={bpmPending || isApplyingAnyBpmAuditChange}
                            >
                              {suggestedActionLabel}
                            </button>
                          ) : (
                            <>
                              <button
                                className="row-action-button"
                                type="button"
                                onClick={() => void applyBpmAuditAdjustment(item, 'half')}
                                disabled={bpmPending || isApplyingAnyBpmAuditChange}
                              >
                                Halve
                              </button>
                              <button
                                className="row-action-button"
                                type="button"
                                onClick={() => void applyBpmAuditAdjustment(item, 'double')}
                                disabled={bpmPending || isApplyingAnyBpmAuditChange}
                              >
                                Double
                              </button>
                            </>
                          )}
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => onOpenBpmEditor(item.track)}
                            disabled={bpmPending || isApplyingAnyBpmAuditChange}
                          >
                            Edit BPM…
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => dismissBpmAuditItem(item)}
                            disabled={isApplyingAnyBpmAuditChange}
                            title="Mark this BPM as intentional so it stops appearing in the audit queue"
                          >
                            Mark intentional
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
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
              <p className="settings-hint">
                Manage the local folders Needle scans into your library.
              </p>
            </div>
            {missingLibraryRoots.length > 0 && (
              <div className="settings-library-health" role="status">
                {missingLibraryRoots.length === 1
                  ? '1 watched folder is missing on disk. Needle will remove it on the next maintenance run.'
                  : `${missingLibraryRoots.length} watched folders are missing on disk. Needle will remove them on the next maintenance run.`}
              </div>
            )}
            <div className="settings-library-roots">
              {settings.library_roots.length === 0 ? (
                <div className="settings-library-empty">No folders added yet.</div>
              ) : (
                settings.library_roots.map((root) => (
                  <div
                    key={root}
                    className={`settings-library-root ${missingRootsSet.has(root) ? 'is-missing' : ''}`}
                    title={root}
                  >
                    <div className="settings-library-root-copy">
                      <span className="settings-library-root-name">{root}</span>
                      {missingRootsSet.has(root) && (
                        <span className="settings-library-root-status">Missing on disk</span>
                      )}
                    </div>
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
          <div className="settings-row settings-row-block">
            <div className="settings-row-copy">
              <label className="settings-label">Maintenance</label>
              <p className="settings-hint">
                Rescans watched folders for changes and removes dotfile entries from the library only.
              </p>
            </div>
            <div className="settings-row-control">
              <button
                className="primary settings-maintenance-button"
                onClick={onMaintenance}
                disabled={busy}
              >
                <span
                  className={`settings-maintenance-icon ${maintenanceBusy ? 'is-spinning' : ''}`}
                  aria-hidden="true"
                >
                  ↻
                </span>
                <span>{maintenanceBusy ? 'Running maintenance…' : 'Run maintenance'}</span>
              </button>
            </div>
            <div className="settings-maintenance-meta">
              {lastMaintenanceLabel ? `Last run ${lastMaintenanceLabel}` : 'No maintenance run recorded yet.'}
            </div>
            <div
              className={`settings-maintenance-console ${maintenanceBusy ? 'is-live' : ''}`}
              aria-live="polite"
              aria-busy={maintenanceBusy}
            >
              {maintenanceLog.length === 0 ? (
                <div className="settings-maintenance-empty">
                  No maintenance run yet. The next run will stream its progress here.
                </div>
              ) : (
                <div className="settings-maintenance-log" ref={maintenanceLogRef}>
                  {maintenanceLog.map((line, index) => (
                    <div key={`${index}-${line}`} className="settings-maintenance-line">
                      {line}
                    </div>
                  ))}
                </div>
              )}
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
              <label className="settings-label">Volume leveling</label>
              <p className="settings-hint">
                Analyze your library once, then let Needle nudge mixed queues toward a steadier loudness without changing your main listening volume.
              </p>
            </div>
            <div className="settings-row-control">
              <div className="seg">
                {[
                  { value: false, label: 'Off' },
                  { value: true, label: 'On' },
                ].map((opt) => (
                  <button
                    key={String(opt.value)}
                    className={`seg-btn ${settings.volume_leveling_enabled === opt.value ? 'on' : ''}`}
                    onClick={() => onChange({ ...settings, volume_leveling_enabled: opt.value })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="settings-row settings-row-block">
            <div className="settings-row-copy">
              <label className="settings-label">Loudness analysis</label>
              <p className="settings-hint">
                Runs a local FFmpeg pass across your library, stores LUFS and peak data in Needle’s database, and only re-checks files that changed.
              </p>
              <p className="settings-hint">
                It keeps running while you browse or play music. The first pass can take a while on larger libraries, but later runs only revisit changed files.
              </p>
              <p className="settings-hint">
                If Needle upgrades its loudness-analysis method, one run may intentionally refresh older cached results across the library.
              </p>
            </div>
            <div className="settings-row-control">
              <button
                className="primary settings-maintenance-button"
                onClick={onLoudnessAnalysis}
                disabled={busy}
              >
                <span
                  className={`settings-maintenance-icon ${loudnessAnalysisBusy ? 'is-spinning' : ''}`}
                  aria-hidden="true"
                >
                  ↻
                </span>
                <span>{loudnessAnalysisBusy ? 'Analyzing loudness…' : 'Analyze library'}</span>
              </button>
            </div>
            <div className="settings-maintenance-meta">
              {lastLoudnessAnalysisLabel
                ? `Last run ${lastLoudnessAnalysisLabel}`
                : 'No loudness analysis recorded yet.'}
            </div>
            {loudnessAnalysisProgress && (
              <div className="settings-analysis-summary" aria-live="polite">
                <div className="settings-analysis-summary-head">
                  <div className="settings-analysis-summary-copy">
                    <strong>
                      {loudnessAnalysisProgress.processed_tracks.toLocaleString()} /{' '}
                      {loudnessAnalysisProgress.total_tracks.toLocaleString()}
                    </strong>{' '}
                    tracks checked
                  </div>
                  <div className="settings-analysis-summary-copy">
                    {loudnessAnalysisProgress.total_tracks > 0 ? `${loudnessProgressPercent}% complete` : 'Ready'}
                  </div>
                </div>
                <div className="settings-analysis-progress" aria-hidden="true">
                  <div
                    className="settings-analysis-progress-bar"
                    style={{ width: `${loudnessProgressPercent}%` }}
                  />
                </div>
                <div className="settings-analysis-stats">
                  <div className="settings-analysis-stat">
                    <span className="settings-analysis-stat-label">Analyzed</span>
                    <strong>{loudnessAnalysisProgress.analyzed_tracks.toLocaleString()}</strong>
                  </div>
                  <div className="settings-analysis-stat">
                    <span className="settings-analysis-stat-label">Fresh</span>
                    <strong>{loudnessAnalysisProgress.unchanged_tracks.toLocaleString()}</strong>
                  </div>
                  <div className="settings-analysis-stat">
                    <span className="settings-analysis-stat-label">Missing</span>
                    <strong>{loudnessAnalysisProgress.missing_tracks.toLocaleString()}</strong>
                  </div>
                  <div className="settings-analysis-stat">
                    <span className="settings-analysis-stat-label">Failed</span>
                    <strong>{loudnessAnalysisProgress.failed_tracks.toLocaleString()}</strong>
                  </div>
                </div>
              </div>
            )}
            <div
              className={`settings-maintenance-console ${loudnessAnalysisBusy ? 'is-live' : ''}`}
              aria-live="polite"
              aria-busy={loudnessAnalysisBusy}
            >
              {loudnessAnalysisLog.length === 0 ? (
                <div className="settings-maintenance-empty">
                  No loudness analysis yet. The next run will stream its progress here.
                </div>
              ) : (
                <div className="settings-maintenance-log" ref={loudnessAnalysisLogRef}>
                  {loudnessAnalysisLog.map((line, index) => (
                    <div key={`${index}-${line}`} className="settings-maintenance-line">
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {loudnessAnalysisFailures.length > 0 && (
              <div className="settings-analysis-failures">
                <div className="settings-analysis-failures-head">
                  <div>
                    <label className="settings-label">Failed files</label>
                    <p className="settings-hint">
                      Needle skipped these files during analysis. They can still stay in your library.
                    </p>
                  </div>
                  <button className="ghost-button" onClick={onCopyLoudnessFailures}>
                    Copy failed paths
                  </button>
                </div>
                <div className="settings-analysis-failure-list">
                  {loudnessAnalysisFailures.map((entry) => (
                    <div key={entry.path} className="settings-analysis-failure-item">
                      <div className="settings-analysis-failure-path">{entry.path}</div>
                      <div className="settings-analysis-failure-reason">{entry.reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-label">Backend</label>
              <p className="settings-hint">
                On macOS install it with <code>brew install mpv</code> if it is not already available.
              </p>
              <p className="settings-hint">
                App version: <code>{runtimeInfo?.app_version ?? 'Loading…'}</code>
              </p>
              <p className="settings-hint">
                Loudness analysis version:{' '}
                <code>
                  {runtimeInfo ? `v${runtimeInfo.loudness_analysis_version}` : 'Loading…'}
                </code>
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
  playlistSections: DashboardPlaylistSection[];
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
  playlistSections,
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
    () => sampleN(albums, 5),
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
  const fromYourLibrarySection = playlistSections.find((section) => section.id === 'library') ?? null;
  const signaturesSection = playlistSections.find((section) => section.id === 'signatures') ?? null;
  const vibesSection = playlistSections.find((section) => section.id === 'vibes') ?? null;

  const isEmpty = tracks.length === 0;

  const renderPlaylistSection = (section: DashboardPlaylistSection) => (
    <section key={section.id} className="dashboard-section">
      <div className="section-head">
        <h2 className="section-title">{section.title}</h2>
      </div>
      <div
        className="playlist-grid"
        style={
          {
            ['--playlist-grid-columns' as string]: String(Math.min(Math.max(section.playlists.length, 1), 4)),
          } as CSSProperties
        }
      >
        {section.playlists.map((pl) => (
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
  );

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
                    vinylRip={a.is_vinyl_rip}
                    imageMode="deferred"
                    lazyLoad
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
                    aria-label={`Play ${a.album} next`}
                  >
                    <NextIcon />
                  </button>
                  <button
                    className="card-mini-action"
                    onClick={() => onAddAlbumToQueue(a.key)}
                    title={`Add ${a.album} to queue`}
                    aria-label={`Add ${a.album} to queue`}
                  >
                    <QueueIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {fromYourLibrarySection && renderPlaylistSection(fromYourLibrarySection)}

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
                    vinylRip={a.is_vinyl_rip}
                    imageMode="deferred"
                    lazyLoad
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
                    aria-label={`Play ${a.album} next`}
                  >
                    <NextIcon />
                  </button>
                  <button
                    className="card-mini-action"
                    onClick={() => onAddAlbumToQueue(a.key)}
                    title={`Add ${a.album} to queue`}
                    aria-label={`Add ${a.album} to queue`}
                  >
                    <QueueIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {signaturesSection && renderPlaylistSection(signaturesSection)}

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
                  <ArtistAvatar name={a.artist} size="lg" imageMode="cache_only" lazyLoad />
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

      {vibesSection && renderPlaylistSection(vibesSection)}

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
              <Cover
                trackPath={t.path}
                fallback={t.title[0]?.toUpperCase() ?? '♪'}
                size="md"
                imageMode="deferred"
                lazyLoad
              />
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
