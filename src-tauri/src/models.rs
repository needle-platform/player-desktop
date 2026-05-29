use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibrarySource {
    #[default]
    LocalFolders,
    NeedleBackend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub path: String,
    #[serde(default, alias = "relativePath")]
    pub relative_path: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    #[serde(alias = "albumArtist")]
    pub album_artist: Option<String>,
    #[serde(alias = "durationSeconds")]
    pub duration_seconds: Option<u64>,
    pub format: Option<String>,
    #[serde(alias = "sampleRate", alias = "samplingRate")]
    pub sample_rate: Option<u32>,
    #[serde(alias = "bitDepth", alias = "bitsPerSample")]
    pub bit_depth: Option<u8>,
    #[serde(alias = "discNumber")]
    pub disc_number: Option<i64>,
    #[serde(alias = "trackNumber")]
    pub track_number: Option<i64>,
    pub bpm: Option<i64>,
    #[serde(default, alias = "bpmOverridden")]
    pub bpm_overridden: bool,
    pub genre: Option<String>,
    #[serde(alias = "primaryGenre")]
    pub primary_genre: Option<String>,
    #[serde(default, alias = "sourceTags")]
    pub source_tags: Vec<String>,
    #[serde(default, alias = "isVinylRip")]
    pub is_vinyl_rip: bool,
    pub year: Option<i64>,
    #[serde(alias = "addedAt")]
    pub added_at: Option<String>,
    #[serde(alias = "playCount")]
    pub play_count: i64,
    #[serde(alias = "lastPlayedAt")]
    pub last_played_at: Option<String>,
    #[serde(default, alias = "isFavorite")]
    pub is_favorite: bool,
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
    #[serde(default)]
    pub library_source: LibrarySource,
    #[serde(default)]
    pub needle_backend_url: Option<String>,
    #[serde(default)]
    pub needle_backend_username: Option<String>,
    #[serde(default)]
    pub needle_backend_password: Option<String>,
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
    #[serde(default)]
    pub library_change: Option<LibraryChangeState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppBootstrapState {
    pub bootstrap: BootstrapPayload,
    pub startup_notice: Option<String>,
    pub offline_mode: bool,
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
    pub path: Option<String>,
    pub paused: bool,
    pub idle: bool,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub playlist_position: Option<usize>,
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
pub struct OfflineDownloadEntry {
    pub track_path: String,
    pub local_path: String,
    pub content_type: Option<String>,
    pub file_size: Option<u64>,
    pub downloaded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OfflineDownloadOperation {
    Download,
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OfflineDownloadProgressStatus {
    Running,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineDownloadProgress {
    pub operation: OfflineDownloadOperation,
    pub status: OfflineDownloadProgressStatus,
    pub total_tracks: usize,
    pub completed_tracks: usize,
    pub current_track_path: Option<String>,
    pub current_track_downloaded_bytes: Option<u64>,
    pub current_track_total_bytes: Option<u64>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPlaylist {
    pub id: String,
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
        vibe: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootPathMapping {
    pub source_prefix: String,
    pub target_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDesktopPlaylist {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub track_paths: Vec<String>,
    #[serde(default)]
    pub rule_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedArtistImage {
    pub name: String,
    pub url: Option<String>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedArtistInfo {
    pub name: String,
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub gender: Option<String>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAlbumInfo {
    pub key: String,
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAlbumPrimaryGenre {
    pub album: String,
    pub album_artist: String,
    pub primary_genre: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTrackMetadataOverride {
    pub track_path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub disc_number: Option<i64>,
    pub track_number: Option<i64>,
    pub bpm: Option<i64>,
    pub genre: Option<String>,
    pub source_tags: Option<Vec<String>>,
    pub year: Option<i64>,
    pub recording_mbid: Option<String>,
    pub release_track_mbid: Option<String>,
    pub release_mbid: Option<String>,
    pub release_group_mbid: Option<String>,
    pub confidence: Option<f64>,
    pub source: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTrackLoudness {
    pub track_path: String,
    pub integrated_lufs: f32,
    pub true_peak_db: f32,
    pub target_gain_db: f32,
    pub file_size: i64,
    pub file_modified_at: i64,
    pub analysis_version: i64,
    pub analyzed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTrackAppState {
    pub track_path: String,
    pub favorite: bool,
    pub rating: Option<i64>,
    pub play_count: i64,
    pub last_played_at: Option<String>,
    pub date_added: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDesktopPlaybackSession {
    pub queue_paths: Vec<String>,
    pub base_queue_paths: Vec<String>,
    pub current_index: usize,
    pub position_seconds: f64,
    pub paused: bool,
    pub repeat_mode: RepeatMode,
    pub shuffle_enabled: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStateImportPayload {
    pub source_database_path: Option<String>,
    pub root_mappings: Vec<RootPathMapping>,
    pub playlists: Vec<ImportedDesktopPlaylist>,
    pub artist_images: Vec<ImportedArtistImage>,
    pub artist_infos: Vec<ImportedArtistInfo>,
    pub album_infos: Vec<ImportedAlbumInfo>,
    pub album_primary_genres: Vec<ImportedAlbumPrimaryGenre>,
    pub track_metadata_overrides: Vec<ImportedTrackMetadataOverride>,
    pub track_loudness: Vec<ImportedTrackLoudness>,
    pub track_app_state: Vec<ImportedTrackAppState>,
    pub playback_session: Option<ImportedDesktopPlaybackSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeedleBackendStatus {
    pub url: String,
    pub reachable: bool,
    pub enabled: bool,
    pub mode: Option<String>,
    pub scanning: bool,
    pub roots_configured: usize,
    pub configured_roots: Vec<String>,
    pub track_count: Option<usize>,
    pub album_count: Option<usize>,
    pub artist_count: Option<usize>,
    pub last_scan_status: Option<String>,
    pub library_change: Option<LibraryChangeState>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChangeState {
    pub version: i64,
    pub changed_at: String,
    pub change_source: Option<String>,
    pub change_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeedleBackendImportSummary {
    pub source_database_path: Option<String>,
    pub playlists_imported: usize,
    pub playlist_tracks_imported: usize,
    pub playlist_tracks_missing: usize,
    pub artist_images_imported: usize,
    pub artist_infos_imported: usize,
    pub album_infos_imported: usize,
    pub album_primary_genres_imported: usize,
    pub track_metadata_overrides_imported: usize,
    pub track_metadata_overrides_missing: usize,
    pub track_loudness_imported: usize,
    pub track_loudness_missing: usize,
    pub track_app_state_imported: usize,
    pub track_app_state_missing: usize,
    pub playback_session_imported: bool,
    pub playback_session_tracks_missing: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeedleBackendMigrationReport {
    pub backend_status: NeedleBackendStatus,
    pub root_mappings: Vec<RootPathMapping>,
    pub unmapped_roots: Vec<String>,
    pub import_summary: NeedleBackendImportSummary,
}
