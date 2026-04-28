export type ThemeMode = 'system' | 'light' | 'dark';

export type EqualizerPreset =
  | 'flat'
  | 'bass_boost'
  | 'vocal'
  | 'treble_boost'
  | 'lounge';

export interface Track {
  id: number;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_seconds: number | null;
  format: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  track_number: number | null;
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
  library_roots: string[];
}

export interface BootstrapPayload {
  settings: AppSettings;
  library: LibraryData;
}
