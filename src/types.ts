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

export interface Track {
  id: number;
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
  is_vinyl_rip: boolean;
  year: number | null;
  added_at: string | null;
  play_count: number;
  last_played_at: string | null;
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

export interface SavedPlaylistRule {
  kind: 'filtered_library';
  search: string | null;
  artist: string | null;
  genre: string | null;
  year_from: number | null;
  year_to: number | null;
}

export interface SavedPlaylist {
  id: number;
  name: string;
  track_paths: string[];
  rule: SavedPlaylistRule | null;
  created_at: string;
  updated_at: string;
}

export type TrackBpmAdjustment = 'half' | 'double' | 'reset';
