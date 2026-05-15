import { invoke } from '@tauri-apps/api/core';
import type {
  AppBootstrapState,
  AppSettings,
  BootstrapPayload,
  NeedleBackendMigrationReport,
  NeedleBackendStatus,
  MetadataEditMode,
  OfflineDownloadEntry,
  PlaybackSession,
  PlaybackState,
  RepeatMode,
  RuntimeInfo,
  SavedPlaylistRule,
  TrackBpmAdjustment,
} from '../types';

export const backendConnectivityEventName = 'needle-backend-connectivity-error';

const isBackendConnectivityErrorMessage = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("couldn't reach the configured homeserver") ||
    normalized.includes('unable to reach needle backend') ||
    normalized.includes('unable to reach needle backend route') ||
    normalized.includes('error sending request') ||
    normalized.includes('connection refused') ||
    normalized.includes('connection reset') ||
    normalized.includes('operation timed out') ||
    normalized.includes('timed out') ||
    normalized.includes('deadline has elapsed') ||
    normalized.includes('dns error') ||
    normalized.includes('failed to lookup address') ||
    normalized.includes('network is unreachable') ||
    normalized.includes('broken pipe') ||
    normalized.includes('unexpected eof')
  );
};

const reportBackendConnectivityError = (message: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(backendConnectivityEventName, {
      detail: {
        message,
        happenedAt: Date.now(),
      },
    }),
  );
};

const invokeMonitored = async <T>(command: string, args?: Record<string, unknown>) => {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isBackendConnectivityErrorMessage(message)) {
      reportBackendConnectivityError(message);
    }
    throw error;
  }
};

export const bootstrapApp = () => invokeMonitored<BootstrapPayload>('bootstrap_app');

export const bootstrapAppState = () => invokeMonitored<AppBootstrapState>('bootstrap_app_state');

export const getRuntimeInfo = () => invokeMonitored<RuntimeInfo>('get_runtime_info');

export const openExternalUrl = (url: string) => invokeMonitored<void>('open_external_url', { url });

export const getNeedleBackendStatus = (backendUrl?: string | null) =>
  invokeMonitored<NeedleBackendStatus>('get_needle_backend_status', {
    backendUrl: backendUrl ?? null,
  });

export const migrateDesktopStateToNeedleBackend = (backendUrl?: string | null) =>
  invokeMonitored<NeedleBackendMigrationReport>('migrate_desktop_state_to_needle_backend', {
    backendUrl: backendUrl ?? null,
  });

export const listOfflineDownloads = () =>
  invokeMonitored<OfflineDownloadEntry[]>('list_offline_downloads');

export const downloadOfflineTracks = (trackPaths: string[]) =>
  invokeMonitored<OfflineDownloadEntry[]>('download_offline_tracks', { trackPaths });

export const removeOfflineTracks = (trackPaths: string[]) =>
  invokeMonitored<OfflineDownloadEntry[]>('remove_offline_tracks', { trackPaths });

export const scanLibrary = (folder: string) =>
  invoke<BootstrapPayload>('scan_library', { folder });

export const saveSettings = (settings: AppSettings) =>
  invokeMonitored<AppSettings>('save_settings', { settings });

export const playTrack = (path: string) => invokeMonitored<void>('play_track', { path });

export const playQueue = (paths: string[]) => invokeMonitored<void>('play_queue', { paths });

export const pausePlayback = () => invoke<void>('pause_playback');

export const resumePlayback = () => invoke<void>('resume_playback');

export const stopPlayback = () => invoke<void>('stop_playback');

export const seekPlayback = (positionSeconds: number) =>
  invoke<void>('seek_playback', { positionSeconds });

export const getPlaybackState = () => invoke<PlaybackState>('get_playback_state');

export const savePlaybackSession = (session: PlaybackSession) =>
  invokeMonitored<PlaybackSession>('save_playback_session', { session });

export const syncPlaybackSession = (session: PlaybackSession) =>
  invokeMonitored<void>('sync_playback_session', { session });

export const playQueueIndex = (index: number) =>
  invoke<void>('play_queue_index', { index });

export const appendQueue = (paths: string[]) =>
  invoke<void>('append_queue', { paths });

export const insertQueueAt = (paths: string[], index: number) =>
  invoke<void>('insert_queue_at', { paths, index });

export const removeQueueIndex = (index: number) =>
  invoke<void>('remove_queue_index', { index });

export const moveQueueIndex = (fromIndex: number, toIndex: number) =>
  invoke<void>('move_queue_index', { fromIndex, toIndex });

export const clearQueuePlayback = () =>
  invoke<void>('clear_queue', {});

export const setPlaybackVolume = (volumePercent: number) =>
  invoke<void>('set_playback_volume', { volumePercent });

export const setPlaybackMuted = (muted: boolean) =>
  invoke<void>('set_playback_muted', { muted });

export const setAudioDevice = (deviceName: string) =>
  invoke<void>('set_audio_device', { deviceName });

export const setRepeatMode = (repeatMode: RepeatMode) =>
  invoke<void>('set_repeat_mode', { repeatMode });

export const applyVolumeLevelingForTrack = (path: string | null) =>
  invoke<void>('apply_volume_leveling_for_track', { path });

export const runMaintenance = () => invoke<BootstrapPayload>('run_maintenance');

export const runLoudnessAnalysis = () => invoke<BootstrapPayload>('run_loudness_analysis');

export const removeLibraryRoot = (folder: string) =>
  invoke<BootstrapPayload>('remove_library_root', { folder });

export const getMissingLibraryRoots = () => invoke<string[]>('get_missing_library_roots');

export const createPlaylist = (
  name: string,
  trackPaths: string[],
  rule?: SavedPlaylistRule | null,
) => invokeMonitored<BootstrapPayload>('create_playlist', { name, trackPaths, rule: rule ?? null });

export const renamePlaylist = (playlistId: string, name: string) =>
  invoke<BootstrapPayload>('rename_playlist', { playlistId, name });

export const deletePlaylist = (playlistId: string) =>
  invoke<BootstrapPayload>('delete_playlist', { playlistId });

export const appendTracksToPlaylist = (playlistId: string, trackPaths: string[]) =>
  invoke<BootstrapPayload>('append_tracks_to_playlist', { playlistId, trackPaths });

export const replacePlaylistTracks = (playlistId: string, trackPaths: string[]) =>
  invoke<BootstrapPayload>('replace_playlist_tracks', { playlistId, trackPaths });

export const removePlaylistTrack = (playlistId: string, index: number) =>
  invoke<BootstrapPayload>('remove_playlist_track', { playlistId, index });

export const movePlaylistTrack = (playlistId: string, fromIndex: number, toIndex: number) =>
  invoke<BootstrapPayload>('move_playlist_track', { playlistId, fromIndex, toIndex });

export const setAlbumPrimaryGenre = (
  album: string,
  albumArtist: string | null,
  primaryGenre: string | null,
) => invokeMonitored<BootstrapPayload>('set_album_primary_genre', { album, albumArtist, primaryGenre });

export const saveAlbumGenre = (
  album: string,
  albumArtist: string | null,
  trackPaths: string[],
  genre: string | null,
  mode: MetadataEditMode,
) => invokeMonitored<BootstrapPayload>('save_album_genre', { album, albumArtist, trackPaths, genre, mode });

export const setTrackRating = (path: string, rating: number | null) =>
  invokeMonitored<BootstrapPayload>('set_track_rating', { path, rating });

export const setTrackFavorite = (path: string, favorite: boolean) =>
  invokeMonitored<BootstrapPayload>('set_track_favorite', { path, favorite });

export const saveTrackBpm = (path: string, bpm: number, mode: MetadataEditMode) =>
  invokeMonitored<BootstrapPayload>('save_track_bpm', { path, bpm, mode });

export const adjustTrackBpm = (path: string, adjustment: TrackBpmAdjustment) =>
  invokeMonitored<BootstrapPayload>('adjust_track_bpm', { path, adjustment });

export interface CoverArt {
  data_url: string;
  source: string;
}

export const getCoverArt = (trackPath: string) =>
  invokeMonitored<CoverArt | null>('get_cover_art', { trackPath });

export const recordPlay = (path: string) => invokeMonitored<void>('record_play', { path });

export interface ArtistImage {
  url: string;
  source: string;
}

export type ArtistGender = 'female' | 'male' | 'non_binary' | 'other' | 'not_applicable';

export const getArtistImage = (name: string) =>
  invokeMonitored<ArtistImage | null>('get_artist_image', { name });

export const peekArtistImage = (name: string) =>
  invokeMonitored<ArtistImage | null>('peek_artist_image', { name });

export const refreshArtistImage = (name: string) =>
  invokeMonitored<ArtistImage | null>('refresh_artist_image', { name });

export const uploadCustomArtistImage = (name: string, imagePath: string) =>
  invokeMonitored<ArtistImage | null>('upload_custom_artist_image', { name, imagePath });

export const restoreAutomaticArtistImage = (name: string) =>
  invokeMonitored<ArtistImage | null>('restore_automatic_artist_image', { name });

export interface ArtistInfo {
  description: string | null;
  source_url: string | null;
  gender: ArtistGender | null;
  source: string;
}

export const getArtistInfo = (name: string) =>
  invokeMonitored<ArtistInfo | null>('get_artist_info', { name });

export const refreshArtistInfo = (name: string) =>
  invokeMonitored<ArtistInfo | null>('refresh_artist_info', { name });

export interface AlbumInfo {
  description: string | null;
  source_url: string | null;
  source: string;
}

export const getAlbumInfo = (album: string, artist: string | null) =>
  invokeMonitored<AlbumInfo | null>('get_album_info', { album, artist });

export const refreshAlbumInfo = (album: string, artist: string | null) =>
  invokeMonitored<AlbumInfo | null>('refresh_album_info', { album, artist });

export type AlbumMetadataRefreshStatus = 'matched' | 'ambiguous' | 'no_match' | 'error';

export interface AlbumMetadataRefreshResult {
  status: AlbumMetadataRefreshStatus;
  album: string;
  album_artist: string | null;
  updated_track_count: number;
  confidence: number | null;
  release_title: string | null;
  release_artist: string | null;
  source_url: string | null;
  message: string;
  bootstrap: BootstrapPayload;
}

export const refreshAlbumMetadataFromMusicBrainz = (
  album: string,
  albumArtist: string | null,
) =>
  invokeMonitored<AlbumMetadataRefreshResult>('refresh_album_metadata_from_musicbrainz', {
    album,
    albumArtist,
  });
