export type ThemeMode = 'system' | 'light' | 'dark';

export type EqualizerPreset =
  | 'flat'
  | 'bass_boost'
  | 'bass_treble_boost'
  | 'vocal'
  | 'treble_boost'
  | 'lounge'
  | 'manual';

export type RepeatMode = 'off' | 'one' | 'all';
export type MetadataEditMode = 'needle_only' | 'write_to_files';
export type LibrarySource = 'local_folders' | 'needle_backend';

export interface Track {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  duration_seconds: number | null;
  format: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  disc_number: number | null;
  track_number: number | null;
  bpm: number | null;
  bpm_overridden: boolean;
  genre: string | null;
  primary_genre: string | null;
  source_tags: string[];
  is_vinyl_rip: boolean;
  year: number | null;
  added_at: string | null;
  play_count: number;
  last_played_at: string | null;
  is_favorite: boolean;
  rating: number | null;
}

export interface LibraryData {
  tracks: Track[];
  track_count: number;
  album_count: number;
  artist_count: number;
}

export interface AppSettings {
  theme: ThemeMode;
  accent_color: string | null;
  equalizer_preset: EqualizerPreset;
  equalizer_bands: number[];
  volume_leveling_enabled: boolean;
  metadata_edit_mode: MetadataEditMode;
  library_source: LibrarySource;
  needle_backend_url: string | null;
  needle_backend_username: string | null;
  needle_backend_password: string | null;
  tracks_page_size: number;
  last_maintenance_at: string | null;
  last_loudness_analysis_at: string | null;
  library_roots: string[];
}

export interface BootstrapPayload {
  settings: AppSettings;
  library: LibraryData;
  playlists: SavedPlaylist[];
  playback_session: PlaybackSession;
}

export interface AppBootstrapState {
  bootstrap: BootstrapPayload;
  startup_notice: string | null;
  offline_mode: boolean;
}

export interface RuntimeInfo {
  app_version: string;
  loudness_analysis_version: number;
}

export interface LoudnessAnalysisProgress {
  total_tracks: number;
  processed_tracks: number;
  analyzed_tracks: number;
  unchanged_tracks: number;
  missing_tracks: number;
  failed_tracks: number;
  failed_path: string | null;
  failed_reason: string | null;
}

export interface LoudnessAnalysisFailure {
  path: string;
  reason: string;
}

export interface AudioDevice {
  name: string;
  description: string;
}

export interface PlaybackState {
  volume: number;
  muted: boolean;
  audio_device: string;
  audio_devices: AudioDevice[];
}

export interface PlaybackSession {
  queue_paths: string[];
  base_queue_paths: string[];
  current_index: number;
  position_seconds: number;
  paused: boolean;
  repeat_mode: RepeatMode;
  shuffle_enabled: boolean;
}

export interface OfflineDownloadEntry {
  track_path: string;
  local_path: string;
  content_type: string | null;
  file_size: number | null;
  downloaded_at: string;
}

export type OfflineDownloadOperation = 'download' | 'remove';
export type OfflineDownloadProgressStatus = 'running' | 'completed' | 'error';

export interface OfflineDownloadProgress {
  operation: OfflineDownloadOperation;
  status: OfflineDownloadProgressStatus;
  total_tracks: number;
  completed_tracks: number;
  current_track_path: string | null;
  current_track_downloaded_bytes: number | null;
  current_track_total_bytes: number | null;
  error_message: string | null;
}

export interface SavedPlaylistRule {
  kind: 'filtered_library';
  search: string | null;
  artist: string | null;
  genre: string | null;
  vibe: string | null;
  year_from: number | null;
  year_to: number | null;
}

export interface SavedPlaylist {
  id: string;
  name: string;
  track_paths: string[];
  rule: SavedPlaylistRule | null;
  created_at: string;
  updated_at: string;
}

export interface RootPathMapping {
  source_prefix: string;
  target_prefix: string;
}

export interface NeedleBackendStatus {
  url: string;
  reachable: boolean;
  enabled: boolean;
  mode: string | null;
  scanning: boolean;
  roots_configured: number;
  configured_roots: string[];
  track_count: number | null;
  album_count: number | null;
  artist_count: number | null;
  last_scan_status: string | null;
  error: string | null;
}

export interface NeedleBackendImportSummary {
  source_database_path: string | null;
  playlists_imported: number;
  playlist_tracks_imported: number;
  playlist_tracks_missing: number;
  artist_images_imported: number;
  artist_infos_imported: number;
  album_infos_imported: number;
  album_primary_genres_imported: number;
  track_metadata_overrides_imported: number;
  track_metadata_overrides_missing: number;
  track_loudness_imported: number;
  track_loudness_missing: number;
  track_app_state_imported: number;
  track_app_state_missing: number;
  playback_session_imported: boolean;
  playback_session_tracks_missing: number;
}

export interface NeedleBackendMigrationReport {
  backend_status: NeedleBackendStatus;
  root_mappings: RootPathMapping[];
  unmapped_roots: string[];
  import_summary: NeedleBackendImportSummary;
}

export type TrackBpmAdjustment = 'half' | 'double' | 'reset';
