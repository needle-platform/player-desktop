import { invoke } from '@tauri-apps/api/core';
import type {
  AppSettings,
  BootstrapPayload,
  NeedleBackendMigrationReport,
  NeedleBackendStatus,
  MetadataEditMode,
  PlaybackSession,
  PlaybackState,
  RepeatMode,
  RuntimeInfo,
  SavedPlaylistRule,
  TrackBpmAdjustment,
} from '../types';

export const bootstrapApp = () => invoke<BootstrapPayload>('bootstrap_app');

export const getRuntimeInfo = () => invoke<RuntimeInfo>('get_runtime_info');

export const openExternalUrl = (url: string) => invoke<void>('open_external_url', { url });

export const getNeedleBackendStatus = (backendUrl?: string | null) =>
  invoke<NeedleBackendStatus>('get_needle_backend_status', {
    backendUrl: backendUrl ?? null,
  });

export const migrateDesktopStateToNeedleBackend = (backendUrl?: string | null) =>
  invoke<NeedleBackendMigrationReport>('migrate_desktop_state_to_needle_backend', {
    backendUrl: backendUrl ?? null,
  });

export const scanLibrary = (folder: string) =>
  invoke<BootstrapPayload>('scan_library', { folder });

export const saveSettings = (settings: AppSettings) =>
  invoke<AppSettings>('save_settings', { settings });

export const playTrack = (path: string) => invoke<void>('play_track', { path });

export const playQueue = (paths: string[]) => invoke<void>('play_queue', { paths });

export const pausePlayback = () => invoke<void>('pause_playback');

export const resumePlayback = () => invoke<void>('resume_playback');

export const stopPlayback = () => invoke<void>('stop_playback');

export const seekPlayback = (positionSeconds: number) =>
  invoke<void>('seek_playback', { positionSeconds });

export const getPlaybackState = () => invoke<PlaybackState>('get_playback_state');

export const savePlaybackSession = (session: PlaybackSession) =>
  invoke<PlaybackSession>('save_playback_session', { session });

export const syncPlaybackSession = (session: PlaybackSession) =>
  invoke<void>('sync_playback_session', { session });

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
) => invoke<BootstrapPayload>('create_playlist', { name, trackPaths, rule: rule ?? null });

export const renamePlaylist = (playlistId: number, name: string) =>
  invoke<BootstrapPayload>('rename_playlist', { playlistId, name });

export const deletePlaylist = (playlistId: number) =>
  invoke<BootstrapPayload>('delete_playlist', { playlistId });

export const appendTracksToPlaylist = (playlistId: number, trackPaths: string[]) =>
  invoke<BootstrapPayload>('append_tracks_to_playlist', { playlistId, trackPaths });

export const replacePlaylistTracks = (playlistId: number, trackPaths: string[]) =>
  invoke<BootstrapPayload>('replace_playlist_tracks', { playlistId, trackPaths });

export const removePlaylistTrack = (playlistId: number, index: number) =>
  invoke<BootstrapPayload>('remove_playlist_track', { playlistId, index });

export const movePlaylistTrack = (playlistId: number, fromIndex: number, toIndex: number) =>
  invoke<BootstrapPayload>('move_playlist_track', { playlistId, fromIndex, toIndex });

export const setAlbumPrimaryGenre = (
  album: string,
  albumArtist: string | null,
  primaryGenre: string | null,
) => invoke<BootstrapPayload>('set_album_primary_genre', { album, albumArtist, primaryGenre });

export const saveAlbumGenre = (
  album: string,
  albumArtist: string | null,
  trackPaths: string[],
  genre: string | null,
  mode: MetadataEditMode,
) => invoke<BootstrapPayload>('save_album_genre', { album, albumArtist, trackPaths, genre, mode });

export const setTrackRating = (path: string, rating: number | null) =>
  invoke<BootstrapPayload>('set_track_rating', { path, rating });

export const setTrackFavorite = (path: string, favorite: boolean) =>
  invoke<BootstrapPayload>('set_track_favorite', { path, favorite });

export const saveTrackBpm = (path: string, bpm: number, mode: MetadataEditMode) =>
  invoke<BootstrapPayload>('save_track_bpm', { path, bpm, mode });

export const adjustTrackBpm = (path: string, adjustment: TrackBpmAdjustment) =>
  invoke<BootstrapPayload>('adjust_track_bpm', { path, adjustment });

export interface CoverArt {
  data_url: string;
  source: string;
}

export const getCoverArt = (trackPath: string) =>
  invoke<CoverArt | null>('get_cover_art', { trackPath });

export const recordPlay = (path: string) => invoke<void>('record_play', { path });

export interface ArtistImage {
  url: string;
  source: string;
}

export type ArtistGender = 'female' | 'male' | 'non_binary' | 'other' | 'not_applicable';

export const getArtistImage = (name: string) =>
  invoke<ArtistImage | null>('get_artist_image', { name });

export const peekArtistImage = (name: string) =>
  invoke<ArtistImage | null>('peek_artist_image', { name });

export const refreshArtistImage = (name: string) =>
  invoke<ArtistImage | null>('refresh_artist_image', { name });

export interface ArtistInfo {
  description: string | null;
  source_url: string | null;
  gender: ArtistGender | null;
  source: string;
}

export const getArtistInfo = (name: string) =>
  invoke<ArtistInfo | null>('get_artist_info', { name });

export const refreshArtistInfo = (name: string) =>
  invoke<ArtistInfo | null>('refresh_artist_info', { name });

export interface AlbumInfo {
  description: string | null;
  source_url: string | null;
  source: string;
}

export const getAlbumInfo = (album: string, artist: string | null) =>
  invoke<AlbumInfo | null>('get_album_info', { album, artist });

export const refreshAlbumInfo = (album: string, artist: string | null) =>
  invoke<AlbumInfo | null>('refresh_album_info', { album, artist });

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
  invoke<AlbumMetadataRefreshResult>('refresh_album_metadata_from_musicbrainz', {
    album,
    albumArtist,
  });
