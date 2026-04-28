import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, BootstrapPayload } from '../types';

export const bootstrapApp = () => invoke<BootstrapPayload>('bootstrap_app');

export const scanLibrary = (folder: string) =>
  invoke<BootstrapPayload>('scan_library', { folder });

export const saveSettings = (settings: AppSettings) =>
  invoke<AppSettings>('save_settings', { settings });

export const playTrack = (path: string) => invoke<void>('play_track', { path });

export const pausePlayback = () => invoke<void>('pause_playback');

export const resumePlayback = () => invoke<void>('resume_playback');

export const stopPlayback = () => invoke<void>('stop_playback');

export const runMaintenance = () => invoke<BootstrapPayload>('run_maintenance');

export const removeLibraryRoot = (folder: string) =>
  invoke<BootstrapPayload>('remove_library_root', { folder });

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

export const getArtistImage = (name: string) =>
  invoke<ArtistImage | null>('get_artist_image', { name });
