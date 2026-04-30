export type ThemeMode = 'system' | 'light' | 'dark';

export type EqualizerPreset =
  | 'flat'
  | 'bass_boost'
  | 'vocal'
  | 'treble_boost'
  | 'lounge'
  | 'manual';

export type RepeatMode = 'off' | 'one' | 'all';

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
  genre: string | null;
  primary_genre: string | null;
  year: number | null;
  added_at: string | null;
  play_count: number;
  last_played_at: string | null;
}

export interface LibraryData {
  tracks: Track[];
  track_count: number;
  album_count: number;
  artist_count: number;
}

export interface AppSettings {
  theme: ThemeMode;
  equalizer_preset: EqualizerPreset;
  equalizer_bands: number[];
  library_roots: string[];
}

export interface BootstrapPayload {
  settings: AppSettings;
  library: LibraryData;
  playlists: SavedPlaylist[];
  playback_session: PlaybackSession;
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

export interface SavedPlaylist {
  id: number;
  name: string;
  track_paths: string[];
  created_at: string;
  updated_at: string;
}
