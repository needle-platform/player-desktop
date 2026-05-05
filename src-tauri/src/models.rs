use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EqualizerPreset {
    #[default]
    Flat,
    BassBoost,
    BassTrebleBoost,
    Vocal,
    TrebleBoost,
    Lounge,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RepeatMode {
    #[default]
    Off,
    One,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetadataEditMode {
    #[default]
    NeedleOnly,
    WriteToFiles,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub duration_seconds: Option<u64>,
    pub format: Option<String>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub disc_number: Option<i64>,
    pub track_number: Option<i64>,
    pub bpm: Option<i64>,
    #[serde(default)]
    pub bpm_overridden: bool,
    pub genre: Option<String>,
    pub primary_genre: Option<String>,
    #[serde(default)]
    pub is_vinyl_rip: bool,
    pub year: Option<i64>,
    pub added_at: Option<String>,
    pub play_count: i64,
    pub last_played_at: Option<String>,
    pub rating: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct TrackMetadataOverride {
    pub track_path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub disc_number: Option<i64>,
    pub track_number: Option<i64>,
    pub bpm: Option<i64>,
    pub genre: Option<String>,
    pub year: Option<i64>,
    pub recording_mbid: Option<String>,
    pub release_track_mbid: Option<String>,
    pub release_mbid: Option<String>,
    pub release_group_mbid: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackBpmAdjustment {
    Half,
    Double,
    Reset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryData {
    pub tracks: Vec<Track>,
    pub track_count: usize,
    pub album_count: usize,
    pub artist_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    pub theme: ThemeMode,
    #[serde(default)]
    pub accent_color: Option<String>,
    pub equalizer_preset: EqualizerPreset,
    #[serde(default = "default_equalizer_bands")]
    pub equalizer_bands: [f32; 10],
    #[serde(default)]
    pub volume_leveling_enabled: bool,
    #[serde(default)]
    pub metadata_edit_mode: MetadataEditMode,
    #[serde(default = "default_tracks_page_size")]
    pub tracks_page_size: u32,
    #[serde(default)]
    pub last_maintenance_at: Option<String>,
    #[serde(default)]
    pub last_loudness_analysis_at: Option<String>,
    pub library_roots: Vec<String>,
}

pub fn default_equalizer_bands() -> [f32; 10] {
    [0.0; 10]
}

pub fn default_tracks_page_size() -> u32 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapPayload {
    pub settings: AppSettings,
    pub library: LibraryData,
    pub playlists: Vec<SavedPlaylist>,
    pub playback_session: PlaybackSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub app_version: String,
    pub loudness_analysis_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    pub volume: f64,
    pub muted: bool,
    pub audio_device: String,
    pub audio_devices: Vec<AudioDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaybackSession {
    #[serde(default)]
    pub queue_paths: Vec<String>,
    #[serde(default)]
    pub base_queue_paths: Vec<String>,
    #[serde(default)]
    pub current_index: usize,
    #[serde(default)]
    pub position_seconds: f64,
    #[serde(default = "default_paused")]
    pub paused: bool,
    #[serde(default)]
    pub repeat_mode: RepeatMode,
    #[serde(default)]
    pub shuffle_enabled: bool,
}

fn default_paused() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPlaylist {
    pub id: i64,
    pub name: String,
    pub track_paths: Vec<String>,
    #[serde(default)]
    pub rule: Option<SavedPlaylistRule>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SavedPlaylistRule {
    FilteredLibrary {
        search: Option<String>,
        artist: Option<String>,
        genre: Option<String>,
        year_from: Option<i64>,
        year_to: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlbumMetadataRefreshStatus {
    Matched,
    Ambiguous,
    NoMatch,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlbumMetadataRefreshResult {
    pub status: AlbumMetadataRefreshStatus,
    pub album: String,
    pub album_artist: Option<String>,
    pub updated_track_count: usize,
    pub confidence: Option<f64>,
    pub release_title: Option<String>,
    pub release_artist: Option<String>,
    pub source_url: Option<String>,
    pub message: String,
    pub bootstrap: BootstrapPayload,
}
