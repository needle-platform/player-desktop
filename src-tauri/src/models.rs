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
    Vocal,
    TrebleBoost,
    Lounge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_seconds: Option<u64>,
    pub format: Option<String>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub track_number: Option<i64>,
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
    pub equalizer_preset: EqualizerPreset,
    pub library_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapPayload {
    pub settings: AppSettings,
    pub library: LibraryData,
}
