use std::path::Path;

use anyhow::Result;
use anyhow::{anyhow, bail};
use rusqlite::{params, Connection, OptionalExtension};

use crate::artist::ArtistGender;
use crate::models::{
    default_equalizer_bands, default_tracks_page_size, AppSettings, BootstrapPayload,
    EqualizerPreset, ImportedAlbumInfo, ImportedAlbumPrimaryGenre, ImportedArtistImage,
    ImportedArtistInfo, ImportedDesktopPlaylist, ImportedTrackAppState, ImportedTrackLoudness,
    ImportedTrackMetadataOverride, LibraryData, LibrarySource, MetadataEditMode,
    OfflineDownloadEntry, PlaybackSession, SavedPlaylist, SavedPlaylistRule, ThemeMode, Track,
    TrackBpmAdjustment, TrackMetadataOverride,
};

fn parse_local_playlist_id(value: &str) -> Result<i64> {
    value
        .trim()
        .parse::<i64>()
        .map_err(|_| anyhow!("Playlist is not available in local-library mode"))
}

fn normalize_hex_color(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", hex.to_ascii_lowercase()))
}

#[derive(Debug, Clone)]
pub struct TrackLoudnessAnalysisCandidate {
    pub path: String,
    pub cached_file_size: Option<i64>,
    pub cached_file_modified_at: Option<i64>,
    pub cached_analysis_version: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct TrackLoudnessAnalysisRecord {
    pub path: String,
    pub integrated_lufs: f32,
    pub true_peak_db: f32,
    pub target_gain_db: f32,
    pub file_size: i64,
    pub file_modified_at: i64,
    pub analysis_version: i64,
}

#[derive(Debug, Clone)]
pub struct BackendTrackLoudnessCacheEntry {
    pub track_path: String,
    pub source_fingerprint: String,
    pub analysis_version: i64,
}

#[derive(Debug, Clone)]
pub struct BackendTrackLoudnessAnalysisRecord {
    pub track_path: String,
    pub integrated_lufs: f32,
    pub true_peak_db: f32,
    pub target_gain_db: f32,
    pub source_fingerprint: String,
    pub analysis_version: i64,
}

pub fn init_database(db_path: &Path) -> Result<()> {
    let connection = Connection::open(db_path)?;

    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            artist TEXT,
            album TEXT,
            album_artist TEXT,
            duration_seconds INTEGER,
            format TEXT,
            sample_rate INTEGER,
            bit_depth INTEGER,
            disc_number INTEGER,
            track_number INTEGER,
            bpm INTEGER,
            genre TEXT,
            is_vinyl_rip INTEGER NOT NULL DEFAULT 0,
            year INTEGER,
            added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            play_count INTEGER NOT NULL DEFAULT 0,
            last_played_at TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            rating INTEGER
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS library_roots (
            path TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS artist_images (
            name TEXT PRIMARY KEY,
            url TEXT,
            fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS artist_info (
            name TEXT PRIMARY KEY,
            description TEXT,
            source_url TEXT,
            gender TEXT,
            fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS album_info (
            key TEXT PRIMARY KEY,
            description TEXT,
            source_url TEXT,
            fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id INTEGER NOT NULL,
            track_path TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (playlist_id, track_path),
            UNIQUE (playlist_id, position)
        );

        CREATE TABLE IF NOT EXISTS playlist_rules (
            playlist_id INTEGER PRIMARY KEY,
            rule_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS album_primary_genres (
            album TEXT NOT NULL,
            album_artist TEXT NOT NULL,
            primary_genre TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (album, album_artist)
        );

        CREATE TABLE IF NOT EXISTS track_metadata_overrides (
            track_path TEXT PRIMARY KEY,
            title TEXT,
            artist TEXT,
            album TEXT,
            album_artist TEXT,
            disc_number INTEGER,
            track_number INTEGER,
            bpm INTEGER,
            genre TEXT,
            year INTEGER,
            recording_mbid TEXT,
            release_track_mbid TEXT,
            release_mbid TEXT,
            release_group_mbid TEXT,
            confidence REAL,
            source TEXT NOT NULL DEFAULT 'musicbrainz',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS track_loudness (
            track_path TEXT PRIMARY KEY,
            integrated_lufs REAL NOT NULL,
            true_peak_db REAL NOT NULL,
            target_gain_db REAL NOT NULL,
            file_size INTEGER NOT NULL,
            file_modified_at INTEGER NOT NULL,
            analysis_version INTEGER NOT NULL DEFAULT 1,
            analyzed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS backend_track_loudness (
            track_path TEXT PRIMARY KEY,
            integrated_lufs REAL NOT NULL,
            true_peak_db REAL NOT NULL,
            target_gain_db REAL NOT NULL,
            source_fingerprint TEXT NOT NULL,
            analysis_version INTEGER NOT NULL DEFAULT 1,
            analyzed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS offline_downloads (
            track_path TEXT PRIMARY KEY,
            local_path TEXT NOT NULL,
            content_type TEXT,
            file_size INTEGER,
            downloaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS backend_bootstrap_cache (
            cache_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        ",
    )?;

    connection.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        params!["theme", "system"],
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        params!["equalizer_preset", "flat"],
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        params![
            "equalizer_bands",
            serde_json::to_string(&default_equalizer_bands())?
        ],
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        params!["volume_leveling_enabled", "0"],
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        params!["metadata_edit_mode", "needle_only"],
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
        params!["library_source", "local_folders"],
    )?;

    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN genre TEXT", []);
    let _ = connection.execute(
        "ALTER TABLE tracks ADD COLUMN is_vinyl_rip INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN year INTEGER", []);
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN album_artist TEXT", []);
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN disc_number INTEGER", []);
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN bpm INTEGER", []);
    // SQLite ALTER TABLE doesn't allow non-constant defaults; backfill below if needed.
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN added_at TEXT", []);
    let _ = connection.execute(
        "ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN last_played_at TEXT", []);
    let _ = connection.execute(
        "ALTER TABLE tracks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN rating INTEGER", []);
    let _ = connection.execute("ALTER TABLE artist_info ADD COLUMN gender TEXT", []);
    let _ = connection.execute(
        "ALTER TABLE track_loudness ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 1",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE track_metadata_overrides ADD COLUMN bpm INTEGER",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE track_metadata_overrides ADD COLUMN genre TEXT",
        [],
    );
    let _ = connection.execute(
        "UPDATE tracks SET bpm = CAST(ROUND(bpm) AS INTEGER) WHERE bpm IS NOT NULL",
        [],
    );
    let _ = connection.execute(
        "UPDATE track_metadata_overrides SET bpm = CAST(ROUND(bpm) AS INTEGER) WHERE bpm IS NOT NULL",
        [],
    );
    let _ = connection.execute(
        "UPDATE tracks SET added_at = CURRENT_TIMESTAMP WHERE added_at IS NULL",
        [],
    );

    Ok(())
}

pub fn load_bootstrap(db_path: &Path) -> Result<BootstrapPayload> {
    Ok(BootstrapPayload {
        settings: load_settings(db_path)?,
        library: load_library(db_path)?,
        playlists: load_playlists(db_path)?,
        playback_session: load_playback_session(db_path)?,
    })
}

pub fn load_settings(db_path: &Path) -> Result<AppSettings> {
    let connection = Connection::open(db_path)?;

    let theme = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'theme'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "system".to_string());

    let equalizer_preset = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'equalizer_preset'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "flat".to_string());

    let accent_color = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'accent_color'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| normalize_hex_color(&value));

    let equalizer_bands = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'equalizer_bands'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| serde_json::from_str::<[f32; 10]>(&value).ok())
        .unwrap_or_else(default_equalizer_bands);

    let tracks_page_size = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'tracks_page_size'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| matches!(*value, 25 | 50 | 100))
        .unwrap_or_else(default_tracks_page_size);

    let volume_leveling_enabled = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'volume_leveling_enabled'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        });

    let metadata_edit_mode = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'metadata_edit_mode'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "needle_only".to_string());

    let library_source = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'library_source'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "local_folders".to_string());

    let needle_backend_url = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'needle_backend_url'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let needle_backend_username = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'needle_backend_username'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let needle_backend_password = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'needle_backend_password'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|value| !value.trim().is_empty());

    let last_maintenance_at = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_maintenance_at'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|value| !value.trim().is_empty());

    let last_loudness_analysis_at = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_loudness_analysis_at'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|value| !value.trim().is_empty());

    let mut roots_stmt = connection.prepare("SELECT path FROM library_roots ORDER BY path ASC")?;
    let library_roots = roots_stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(AppSettings {
        theme: match theme.as_str() {
            "light" => ThemeMode::Light,
            "dark" => ThemeMode::Dark,
            _ => ThemeMode::System,
        },
        accent_color,
        equalizer_preset: match equalizer_preset.as_str() {
            "bass_boost" => EqualizerPreset::BassBoost,
            "bass_treble_boost" => EqualizerPreset::BassTrebleBoost,
            "vocal" => EqualizerPreset::Vocal,
            "treble_boost" => EqualizerPreset::TrebleBoost,
            "lounge" => EqualizerPreset::Lounge,
            "manual" => EqualizerPreset::Manual,
            _ => EqualizerPreset::Flat,
        },
        equalizer_bands,
        volume_leveling_enabled,
        metadata_edit_mode: match metadata_edit_mode.as_str() {
            "write_to_files" => MetadataEditMode::WriteToFiles,
            _ => MetadataEditMode::NeedleOnly,
        },
        library_source: match library_source.as_str() {
            "needle_backend" => LibrarySource::NeedleBackend,
            _ => LibrarySource::LocalFolders,
        },
        needle_backend_url,
        needle_backend_username,
        needle_backend_password,
        tracks_page_size,
        last_maintenance_at,
        last_loudness_analysis_at,
        library_roots,
    })
}

pub fn save_settings(db_path: &Path, settings: &AppSettings) -> Result<AppSettings> {
    let connection = Connection::open(db_path)?;

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params!["theme", theme_to_str(&settings.theme)],
    )?;

    if let Some(accent_color) = settings
        .accent_color
        .as_deref()
        .and_then(normalize_hex_color)
    {
        connection.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params!["accent_color", accent_color],
        )?;
    } else {
        connection.execute("DELETE FROM settings WHERE key = 'accent_color'", [])?;
    }

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            "equalizer_preset",
            equalizer_to_str(&settings.equalizer_preset)
        ],
    )?;

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            "library_source",
            match settings.library_source {
                LibrarySource::NeedleBackend => "needle_backend",
                LibrarySource::LocalFolders => "local_folders",
            }
        ],
    )?;

    if let Some(backend_url) = settings
        .needle_backend_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        connection.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params!["needle_backend_url", backend_url],
        )?;
    } else {
        connection.execute("DELETE FROM settings WHERE key = 'needle_backend_url'", [])?;
    }

    if let Some(username) = settings
        .needle_backend_username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        connection.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params!["needle_backend_username", username],
        )?;
    } else {
        connection.execute(
            "DELETE FROM settings WHERE key = 'needle_backend_username'",
            [],
        )?;
    }

    if let Some(password) = settings
        .needle_backend_password
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        connection.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params!["needle_backend_password", password],
        )?;
    } else {
        connection.execute(
            "DELETE FROM settings WHERE key = 'needle_backend_password'",
            [],
        )?;
    }

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            "equalizer_bands",
            serde_json::to_string(&settings.equalizer_bands)?
        ],
    )?;

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            "volume_leveling_enabled",
            if settings.volume_leveling_enabled {
                "1"
            } else {
                "0"
            }
        ],
    )?;

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            "metadata_edit_mode",
            match settings.metadata_edit_mode {
                MetadataEditMode::WriteToFiles => "write_to_files",
                MetadataEditMode::NeedleOnly => "needle_only",
            }
        ],
    )?;

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            "tracks_page_size",
            match settings.tracks_page_size {
                25 | 50 | 100 => settings.tracks_page_size,
                _ => default_tracks_page_size(),
            }
            .to_string()
        ],
    )?;

    connection.execute("DELETE FROM library_roots", [])?;
    for root in &settings.library_roots {
        connection.execute(
            "INSERT OR IGNORE INTO library_roots (path) VALUES (?1)",
            params![root],
        )?;
    }

    load_settings(db_path)
}

pub fn insert_or_update_library_root(db_path: &Path, folder: &str) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "INSERT OR IGNORE INTO library_roots (path) VALUES (?1)",
        params![folder],
    )?;
    Ok(())
}

pub fn record_maintenance_run(db_path: &Path) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params!["last_maintenance_at"],
    )?;
    Ok(())
}

pub fn record_loudness_analysis_run(db_path: &Path) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params!["last_loudness_analysis_at"],
    )?;
    Ok(())
}

pub fn list_library_roots(db_path: &Path) -> Result<Vec<String>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare("SELECT path FROM library_roots ORDER BY path ASC")?;
    let roots = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(roots)
}

pub fn remove_library_root(db_path: &Path, folder: &str) -> Result<()> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    let pattern = format!("{}/%", folder.trim_end_matches('/'));
    transaction.execute(
        "DELETE FROM tracks WHERE path = ?1 OR path LIKE ?2",
        params![folder, pattern],
    )?;
    transaction.execute("DELETE FROM library_roots WHERE path = ?1", params![folder])?;
    prune_orphaned_track_metadata_overrides_tx(&transaction)?;
    prune_orphaned_playlist_tracks_tx(&transaction)?;
    prune_orphaned_track_loudness_tx(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub fn purge_dotfile_tracks(db_path: &Path) -> Result<usize> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    let removed = transaction.execute("DELETE FROM tracks WHERE path LIKE '%/.%'", [])?;
    prune_orphaned_track_metadata_overrides_tx(&transaction)?;
    prune_orphaned_playlist_tracks_tx(&transaction)?;
    prune_orphaned_track_loudness_tx(&transaction)?;
    transaction.commit()?;
    Ok(removed)
}

pub fn replace_tracks(db_path: &Path, folder: &str, tracks: &[Track]) -> Result<()> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;

    transaction.execute(
        "CREATE TEMP TABLE IF NOT EXISTS _scan_paths (path TEXT PRIMARY KEY)",
        [],
    )?;
    transaction.execute("DELETE FROM _scan_paths", [])?;

    {
        let mut stage =
            transaction.prepare("INSERT OR IGNORE INTO _scan_paths (path) VALUES (?1)")?;
        for track in tracks {
            stage.execute(params![track.path])?;
        }
    }

    let pattern = format!("{}/%", folder.trim_end_matches('/'));
    transaction.execute(
        "DELETE FROM tracks
         WHERE (path = ?1 OR path LIKE ?2)
           AND path NOT IN (SELECT path FROM _scan_paths)",
        params![folder, pattern],
    )?;

    for track in tracks {
        transaction.execute(
            "
            INSERT INTO tracks (
                path,
                title,
                artist,
                album,
                album_artist,
                duration_seconds,
                format,
                sample_rate,
                bit_depth,
                disc_number,
                track_number,
                bpm,
                genre,
                is_vinyl_rip,
                year,
                added_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, CURRENT_TIMESTAMP)
            ON CONFLICT(path) DO UPDATE SET
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                album_artist = excluded.album_artist,
                duration_seconds = excluded.duration_seconds,
                format = excluded.format,
                sample_rate = excluded.sample_rate,
                bit_depth = excluded.bit_depth,
                disc_number = excluded.disc_number,
                track_number = excluded.track_number,
                bpm = excluded.bpm,
                genre = excluded.genre,
                is_vinyl_rip = excluded.is_vinyl_rip,
                year = excluded.year
            ",
            params![
                track.path,
                track.title,
                track.artist,
                track.album,
                track.album_artist,
                track.duration_seconds.map(|value| value as i64),
                track.format,
                track.sample_rate.map(|value| value as i64),
                track.bit_depth.map(|value| value as i64),
                track.disc_number,
                track.track_number,
                track.bpm,
                track.genre,
                if track.is_vinyl_rip { 1 } else { 0 },
                track.year,
            ],
        )?;
    }

    prune_orphaned_playlist_tracks_tx(&transaction)?;
    prune_orphaned_track_metadata_overrides_tx(&transaction)?;
    prune_orphaned_track_loudness_tx(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub fn sync_tracks_from_files(db_path: &Path, tracks: &[Track]) -> Result<()> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;

    for track in tracks {
        transaction.execute(
            "
            UPDATE tracks
            SET title = ?2,
                artist = ?3,
                album = ?4,
                album_artist = ?5,
                duration_seconds = ?6,
                format = ?7,
                sample_rate = ?8,
                bit_depth = ?9,
                disc_number = ?10,
                track_number = ?11,
                bpm = ?12,
                genre = ?13,
                is_vinyl_rip = ?14,
                year = ?15
            WHERE path = ?1
            ",
            params![
                track.path,
                track.title,
                track.artist,
                track.album,
                track.album_artist,
                track.duration_seconds.map(|value| value as i64),
                track.format,
                track.sample_rate.map(|value| value as i64),
                track.bit_depth.map(|value| value as i64),
                track.disc_number,
                track.track_number,
                track.bpm,
                track.genre,
                if track.is_vinyl_rip { 1 } else { 0 },
                track.year,
            ],
        )?;
    }

    transaction.commit()?;
    Ok(())
}

pub fn load_album_tracks_for_match(
    db_path: &Path,
    album: &str,
    album_artist: Option<&str>,
) -> Result<Vec<Track>> {
    let connection = Connection::open(db_path)?;
    let normalized_album = album.trim();
    if normalized_album.is_empty() {
        return Ok(Vec::new());
    }
    let normalized_album_artist = album_artist.unwrap_or("").trim();

    let mut statement = connection.prepare(
        "
        SELECT t.id,
               t.path,
               COALESCE(tmo.title, t.title) AS title,
               COALESCE(tmo.artist, t.artist) AS artist,
               COALESCE(tmo.album, t.album) AS album,
               COALESCE(tmo.album_artist, t.album_artist) AS album_artist,
               t.duration_seconds,
               t.format,
               t.sample_rate,
               t.bit_depth,
               COALESCE(tmo.disc_number, t.disc_number) AS disc_number,
               COALESCE(tmo.track_number, t.track_number) AS track_number,
               CAST(ROUND(COALESCE(tmo.bpm, t.bpm)) AS INTEGER) AS bpm,
               tmo.bpm IS NOT NULL AS bpm_overridden,
               COALESCE(tmo.genre, t.genre) AS genre,
               apg.primary_genre,
               t.is_vinyl_rip,
               COALESCE(tmo.year, t.year) AS year,
               t.added_at,
               t.play_count,
               t.last_played_at,
               t.is_favorite,
               t.rating
        FROM tracks t
        LEFT JOIN track_metadata_overrides tmo ON tmo.track_path = t.path
        LEFT JOIN album_primary_genres apg
          ON apg.album = COALESCE(tmo.album, t.album, '')
         AND apg.album_artist = COALESCE(tmo.album_artist, tmo.artist, t.album_artist, t.artist, '')
        WHERE COALESCE(tmo.album, t.album, '') = ?1
          AND COALESCE(tmo.album_artist, tmo.artist, t.album_artist, t.artist, '') = ?2
        ORDER BY
            COALESCE(tmo.disc_number, t.disc_number, 0),
            COALESCE(tmo.track_number, t.track_number, 0),
            COALESCE(tmo.title, t.title),
            t.path
        ",
    )?;

    let tracks = statement
        .query_map(params![normalized_album, normalized_album_artist], |row| {
            Ok(Track {
                id: row.get::<_, i64>(0)?.to_string(),
                path: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album: row.get(4)?,
                album_artist: row.get(5)?,
                duration_seconds: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
                format: row.get(7)?,
                sample_rate: row.get::<_, Option<i64>>(8)?.map(|value| value as u32),
                bit_depth: row.get::<_, Option<i64>>(9)?.map(|value| value as u8),
                disc_number: row.get(10)?,
                track_number: row.get(11)?,
                bpm: row.get(12)?,
                bpm_overridden: row.get::<_, i64>(13)? != 0,
                genre: row.get(14)?,
                primary_genre: row.get(15)?,
                is_vinyl_rip: row.get::<_, i64>(16)? != 0,
                year: row.get(17)?,
                added_at: row.get(18)?,
                play_count: row.get::<_, i64>(19)?,
                last_played_at: row.get(20)?,
                is_favorite: row.get::<_, i64>(21)? != 0,
                rating: row.get(22)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(tracks)
}

pub fn replace_track_metadata_overrides(
    db_path: &Path,
    overrides: &[TrackMetadataOverride],
) -> Result<()> {
    if overrides.is_empty() {
        return Ok(());
    }

    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    let mut statement = transaction.prepare(
        "
        INSERT INTO track_metadata_overrides (
            track_path,
            title,
            artist,
            album,
            album_artist,
            disc_number,
            track_number,
            bpm,
            genre,
            year,
            recording_mbid,
            release_track_mbid,
            release_mbid,
            release_group_mbid,
            confidence,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, CURRENT_TIMESTAMP)
        ON CONFLICT(track_path) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            album_artist = excluded.album_artist,
            disc_number = excluded.disc_number,
            track_number = excluded.track_number,
            bpm = COALESCE(excluded.bpm, track_metadata_overrides.bpm),
            genre = COALESCE(excluded.genre, track_metadata_overrides.genre),
            year = excluded.year,
            recording_mbid = excluded.recording_mbid,
            release_track_mbid = excluded.release_track_mbid,
            release_mbid = excluded.release_mbid,
            release_group_mbid = excluded.release_group_mbid,
            confidence = excluded.confidence,
            updated_at = excluded.updated_at
        ",
    )?;

    for item in overrides {
        statement.execute(params![
            item.track_path,
            item.title,
            item.artist,
            item.album,
            item.album_artist,
            item.disc_number,
            item.track_number,
            item.bpm,
            item.genre,
            item.year,
            item.recording_mbid,
            item.release_track_mbid,
            item.release_mbid,
            item.release_group_mbid,
            item.confidence,
        ])?;
    }

    drop(statement);
    transaction.commit()?;
    Ok(())
}

pub fn load_track_bpm_values(
    connection: &Connection,
    path: &str,
) -> Result<(Option<i64>, Option<i64>, Option<i64>)> {
    let (raw_bpm, current_override): (Option<i64>, Option<i64>) = connection.query_row(
        "
        SELECT CAST(ROUND(bpm) AS INTEGER) AS raw_bpm,
               (
                 SELECT CAST(ROUND(bpm) AS INTEGER)
                 FROM track_metadata_overrides
                 WHERE track_path = tracks.path
               ) AS bpm_override
        FROM tracks
        WHERE path = ?1
        ",
        params![path],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((raw_bpm, current_override, current_override.or(raw_bpm)))
}

pub fn set_track_bpm_override(db_path: &Path, path: &str, bpm: Option<i64>) -> Result<()> {
    let connection = Connection::open(db_path)?;
    if let Some(value) = bpm {
        connection.execute(
            "
            INSERT INTO track_metadata_overrides (track_path, bpm, source, updated_at)
            VALUES (?1, ?2, 'user', CURRENT_TIMESTAMP)
            ON CONFLICT(track_path) DO UPDATE SET
                bpm = excluded.bpm,
                source = 'user',
                updated_at = excluded.updated_at
            ",
            params![path, value.max(1)],
        )?;
    } else {
        connection.execute(
            "UPDATE track_metadata_overrides
             SET bpm = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE track_path = ?1",
            params![path],
        )?;
    }

    Ok(())
}

pub fn adjust_track_bpm(db_path: &Path, path: &str, adjustment: TrackBpmAdjustment) -> Result<()> {
    let connection = Connection::open(db_path)?;
    let (_, _, effective_bpm) = load_track_bpm_values(&connection, path)?;
    let next_override = match adjustment {
        TrackBpmAdjustment::Reset => None,
        TrackBpmAdjustment::Double => {
            let current =
                effective_bpm.ok_or_else(|| anyhow!("No BPM available for this track"))?;
            Some(current.saturating_mul(2).max(1))
        }
        TrackBpmAdjustment::Half => {
            let current =
                effective_bpm.ok_or_else(|| anyhow!("No BPM available for this track"))?;
            Some(((current as f64) / 2.0).round().max(1.0) as i64)
        }
    };

    drop(connection);
    set_track_bpm_override(db_path, path, next_override)
}

pub fn set_album_genre_override(
    db_path: &Path,
    album: &str,
    album_artist: Option<&str>,
    track_paths: &[String],
    genre: Option<&str>,
) -> Result<()> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    let normalized = genre.map(str::trim).filter(|value| !value.is_empty());

    for path in track_paths {
        if let Some(value) = normalized {
            transaction.execute(
                "
                INSERT INTO track_metadata_overrides (track_path, genre, source, updated_at)
                VALUES (?1, ?2, 'user', CURRENT_TIMESTAMP)
                ON CONFLICT(track_path) DO UPDATE SET
                    genre = excluded.genre,
                    source = 'user',
                    updated_at = excluded.updated_at
                ",
                params![path, value],
            )?;
        } else {
            transaction.execute(
                "UPDATE track_metadata_overrides
                 SET genre = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE track_path = ?1",
                params![path],
            )?;
        }
    }

    transaction.execute(
        "DELETE FROM album_primary_genres WHERE album = ?1 AND album_artist = ?2",
        params![album.trim(), album_artist.unwrap_or("").trim()],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn get_artist_image(db_path: &Path, name: &str) -> Result<Option<Option<String>>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "SELECT url FROM artist_images WHERE name = ?1
         AND datetime(fetched_at) > datetime('now', '-30 days')",
    )?;
    let mut rows = stmt.query(params![name])?;
    if let Some(row) = rows.next()? {
        let url: Option<String> = row.get(0)?;
        return Ok(Some(url));
    }
    Ok(None)
}

pub struct CachedArtistInfo {
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub gender: Option<ArtistGender>,
}

pub fn get_artist_info(db_path: &Path, name: &str) -> Result<Option<Option<CachedArtistInfo>>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "SELECT description, source_url, gender FROM artist_info
         WHERE name = ?1
           AND (
                (
                    description IS NULL
                    AND source_url IS NULL
                    AND gender IS NULL
                    AND datetime(fetched_at) > datetime('now', '-6 hours')
                )
                OR
                (
                    (description IS NOT NULL OR source_url IS NOT NULL OR gender IS NOT NULL)
                    AND datetime(fetched_at) > datetime('now', '-90 days')
                )
           )",
    )?;
    let mut rows = stmt.query(params![name])?;
    if let Some(row) = rows.next()? {
        let description: Option<String> = row.get(0)?;
        let source_url: Option<String> = row.get(1)?;
        let gender = row
            .get::<_, Option<String>>(2)?
            .as_deref()
            .and_then(ArtistGender::from_db_str);
        if description.is_none() && source_url.is_none() && gender.is_none() {
            return Ok(Some(None));
        }
        return Ok(Some(Some(CachedArtistInfo {
            description,
            source_url,
            gender,
        })));
    }
    Ok(None)
}

pub fn cache_artist_info(
    db_path: &Path,
    name: &str,
    info: Option<&CachedArtistInfo>,
) -> Result<()> {
    let connection = Connection::open(db_path)?;
    let (description, source_url, gender) = match info {
        Some(info) => (
            info.description.as_deref(),
            info.source_url.as_deref(),
            info.gender.map(ArtistGender::as_db_str),
        ),
        None => (None, None, None),
    };
    connection.execute(
        "INSERT INTO artist_info (name, description, source_url, gender, fetched_at)
         VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
         ON CONFLICT(name) DO UPDATE SET
            description = excluded.description,
            source_url = excluded.source_url,
            gender = excluded.gender,
            fetched_at = excluded.fetched_at",
        params![name, description, source_url, gender],
    )?;
    Ok(())
}

pub struct CachedAlbumInfo {
    pub description: Option<String>,
    pub source_url: Option<String>,
}

pub fn get_album_info(db_path: &Path, key: &str) -> Result<Option<Option<CachedAlbumInfo>>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "SELECT description, source_url FROM album_info
         WHERE key = ?1
           AND datetime(fetched_at) > datetime('now', '-90 days')",
    )?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        let description: Option<String> = row.get(0)?;
        let source_url: Option<String> = row.get(1)?;
        if description.is_none() && source_url.is_none() {
            return Ok(Some(None));
        }
        return Ok(Some(Some(CachedAlbumInfo {
            description,
            source_url,
        })));
    }
    Ok(None)
}

pub fn cache_album_info(db_path: &Path, key: &str, info: Option<&CachedAlbumInfo>) -> Result<()> {
    let connection = Connection::open(db_path)?;
    let (description, source_url) = match info {
        Some(info) => (info.description.as_deref(), info.source_url.as_deref()),
        None => (None, None),
    };
    connection.execute(
        "INSERT INTO album_info (key, description, source_url, fetched_at)
         VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
            description = excluded.description,
            source_url = excluded.source_url,
            fetched_at = excluded.fetched_at",
        params![key, description, source_url],
    )?;
    Ok(())
}

pub fn delete_album_info(db_path: &Path, key: &str) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute("DELETE FROM album_info WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn cache_artist_image(db_path: &Path, name: &str, url: Option<&str>) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "INSERT INTO artist_images (name, url, fetched_at)
         VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(name) DO UPDATE SET
            url = excluded.url,
            fetched_at = excluded.fetched_at",
        params![name, url],
    )?;
    Ok(())
}

pub fn record_play(db_path: &Path, path: &str) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "UPDATE tracks
         SET play_count = play_count + 1,
             last_played_at = CURRENT_TIMESTAMP
         WHERE path = ?1",
        params![path],
    )?;
    Ok(())
}

pub fn set_track_rating(db_path: &Path, path: &str, rating: Option<i64>) -> Result<()> {
    let normalized_rating = rating.filter(|value| (1..=5).contains(value));
    if rating.is_some() && normalized_rating.is_none() {
        bail!("Track rating must be between 1 and 5 stars");
    }

    let connection = Connection::open(db_path)?;
    let updated = connection.execute(
        "UPDATE tracks
         SET rating = ?2
         WHERE path = ?1",
        params![path, normalized_rating],
    )?;
    if updated == 0 {
        bail!("Track not found");
    }

    Ok(())
}

pub fn set_track_favorite(db_path: &Path, path: &str, favorite: bool) -> Result<()> {
    let connection = Connection::open(db_path)?;
    let updated = connection.execute(
        "UPDATE tracks
         SET is_favorite = ?2
         WHERE path = ?1",
        params![path, if favorite { 1 } else { 0 }],
    )?;
    if updated == 0 {
        bail!("Track not found");
    }

    Ok(())
}

pub fn get_track_loudness_gain(db_path: &Path, path: &str) -> Result<Option<f32>> {
    let connection = Connection::open(db_path)?;
    connection
        .query_row(
            "SELECT target_gain_db FROM track_loudness WHERE track_path = ?1",
            params![path],
            |row| row.get::<_, f32>(0),
        )
        .optional()
        .map_err(Into::into)
}

pub fn get_backend_track_loudness_gain(db_path: &Path, path: &str) -> Result<Option<f32>> {
    let connection = Connection::open(db_path)?;
    connection
        .query_row(
            "SELECT target_gain_db FROM backend_track_loudness WHERE track_path = ?1",
            params![path],
            |row| row.get::<_, f32>(0),
        )
        .optional()
        .map_err(Into::into)
}

pub fn list_tracks_for_loudness_analysis(
    db_path: &Path,
) -> Result<Vec<TrackLoudnessAnalysisCandidate>> {
    let connection = Connection::open(db_path)?;
    let mut statement = connection.prepare(
        "
        SELECT t.path,
               tl.file_size,
               tl.file_modified_at,
               tl.analysis_version
        FROM tracks t
        LEFT JOIN track_loudness tl ON tl.track_path = t.path
        ORDER BY t.path
        ",
    )?;

    let rows = statement
        .query_map([], |row| {
            Ok(TrackLoudnessAnalysisCandidate {
                path: row.get(0)?,
                cached_file_size: row.get(1)?,
                cached_file_modified_at: row.get(2)?,
                cached_analysis_version: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;

    Ok(rows)
}

pub fn save_track_loudness_records(
    db_path: &Path,
    records: &[TrackLoudnessAnalysisRecord],
) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }

    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    let mut statement = transaction.prepare(
        "
        INSERT INTO track_loudness (
            track_path,
            integrated_lufs,
            true_peak_db,
            target_gain_db,
            file_size,
            file_modified_at,
            analysis_version,
            analyzed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
        ON CONFLICT(track_path) DO UPDATE SET
            integrated_lufs = excluded.integrated_lufs,
            true_peak_db = excluded.true_peak_db,
            target_gain_db = excluded.target_gain_db,
            file_size = excluded.file_size,
            file_modified_at = excluded.file_modified_at,
            analysis_version = excluded.analysis_version,
            analyzed_at = excluded.analyzed_at
        ",
    )?;

    for record in records {
        statement.execute(params![
            record.path,
            record.integrated_lufs,
            record.true_peak_db,
            record.target_gain_db,
            record.file_size,
            record.file_modified_at,
            record.analysis_version,
        ])?;
    }

    drop(statement);
    transaction.commit()?;
    Ok(())
}

pub fn load_playback_session(db_path: &Path) -> Result<PlaybackSession> {
    let connection = Connection::open(db_path)?;
    let value = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'playback_session'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok();

    Ok(value
        .and_then(|json| serde_json::from_str::<PlaybackSession>(&json).ok())
        .unwrap_or_default())
}

pub fn save_playback_session(db_path: &Path, session: &PlaybackSession) -> Result<PlaybackSession> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params!["playback_session", serde_json::to_string(session)?],
    )?;
    load_playback_session(db_path)
}

pub fn load_backend_bootstrap_cache(db_path: &Path) -> Result<Option<BootstrapPayload>> {
    let connection = Connection::open(db_path)?;
    let value = connection
        .query_row(
            "SELECT payload_json FROM backend_bootstrap_cache WHERE cache_key = 'needle_backend'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    value
        .map(|json| serde_json::from_str::<BootstrapPayload>(&json).map_err(anyhow::Error::from))
        .transpose()
}

pub fn save_backend_bootstrap_cache(db_path: &Path, payload: &BootstrapPayload) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "
        INSERT INTO backend_bootstrap_cache (cache_key, payload_json, updated_at)
        VALUES ('needle_backend', ?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        ON CONFLICT(cache_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        ",
        params![serde_json::to_string(payload)?],
    )?;
    Ok(())
}

pub fn list_offline_downloads(db_path: &Path) -> Result<Vec<OfflineDownloadEntry>> {
    let connection = Connection::open(db_path)?;
    let mut statement = connection.prepare(
        "
        SELECT track_path, local_path, content_type, file_size, downloaded_at
        FROM offline_downloads
        ORDER BY downloaded_at DESC, track_path ASC
        ",
    )?;

    let downloads = statement
        .query_map([], |row| {
            Ok(OfflineDownloadEntry {
                track_path: row.get::<_, String>(0)?,
                local_path: row.get::<_, String>(1)?,
                content_type: row.get::<_, Option<String>>(2)?,
                file_size: row
                    .get::<_, Option<i64>>(3)?
                    .map(|value| value.max(0) as u64),
                downloaded_at: row.get::<_, String>(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;

    Ok(downloads)
}

pub fn get_offline_download(
    db_path: &Path,
    track_path: &str,
) -> Result<Option<OfflineDownloadEntry>> {
    let connection = Connection::open(db_path)?;
    connection
        .query_row(
            "
            SELECT track_path, local_path, content_type, file_size, downloaded_at
            FROM offline_downloads
            WHERE track_path = ?1
            ",
            params![track_path],
            |row| {
                Ok(OfflineDownloadEntry {
                    track_path: row.get::<_, String>(0)?,
                    local_path: row.get::<_, String>(1)?,
                    content_type: row.get::<_, Option<String>>(2)?,
                    file_size: row
                        .get::<_, Option<i64>>(3)?
                        .map(|value| value.max(0) as u64),
                    downloaded_at: row.get::<_, String>(4)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub fn upsert_offline_download(db_path: &Path, entry: &OfflineDownloadEntry) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "
        INSERT INTO offline_downloads (
            track_path,
            local_path,
            content_type,
            file_size,
            downloaded_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(track_path) DO UPDATE SET
            local_path = excluded.local_path,
            content_type = excluded.content_type,
            file_size = excluded.file_size,
            downloaded_at = excluded.downloaded_at
        ",
        params![
            entry.track_path,
            entry.local_path,
            entry.content_type,
            entry.file_size.map(|value| value as i64),
            entry.downloaded_at,
        ],
    )?;
    Ok(())
}

pub fn remove_offline_download(db_path: &Path, track_path: &str) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "DELETE FROM offline_downloads WHERE track_path = ?1",
        params![track_path],
    )?;
    Ok(())
}

pub fn current_timestamp(db_path: &Path) -> Result<String> {
    let connection = Connection::open(db_path)?;
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Into::into)
}

pub fn export_playlists_for_backend(db_path: &Path) -> Result<Vec<ImportedDesktopPlaylist>> {
    let playlists = load_playlists(db_path)?;
    let mut exported = Vec::with_capacity(playlists.len());

    for playlist in playlists {
        exported.push(ImportedDesktopPlaylist {
            id: format!("desktop-playlist-{}", playlist.id),
            name: playlist.name,
            created_at: playlist.created_at,
            updated_at: playlist.updated_at,
            track_paths: playlist.track_paths,
            rule_json: playlist
                .rule
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        });
    }

    Ok(exported)
}

pub fn list_artist_images_for_backend(db_path: &Path) -> Result<Vec<ImportedArtistImage>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection
        .prepare("SELECT name, url, fetched_at FROM artist_images ORDER BY lower(name), name")?;

    let rows = stmt.query_map([], |row| {
        Ok(ImportedArtistImage {
            name: row.get(0)?,
            url: row.get(1)?,
            fetched_at: row.get(2)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_artist_info_for_backend(db_path: &Path) -> Result<Vec<ImportedArtistInfo>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "SELECT name, description, source_url, gender, fetched_at
         FROM artist_info
         ORDER BY lower(name), name",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ImportedArtistInfo {
            name: row.get(0)?,
            description: row.get(1)?,
            source_url: row.get(2)?,
            gender: row.get(3)?,
            fetched_at: row.get(4)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_album_info_for_backend(db_path: &Path) -> Result<Vec<ImportedAlbumInfo>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "SELECT key, description, source_url, fetched_at
         FROM album_info
         ORDER BY key",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ImportedAlbumInfo {
            key: row.get(0)?,
            description: row.get(1)?,
            source_url: row.get(2)?,
            fetched_at: row.get(3)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_album_primary_genres_for_backend(
    db_path: &Path,
) -> Result<Vec<ImportedAlbumPrimaryGenre>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "SELECT album, album_artist, primary_genre, updated_at
         FROM album_primary_genres
         ORDER BY lower(album), lower(album_artist), album, album_artist",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ImportedAlbumPrimaryGenre {
            album: row.get(0)?,
            album_artist: row.get(1)?,
            primary_genre: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_track_metadata_overrides_for_backend(
    db_path: &Path,
) -> Result<Vec<ImportedTrackMetadataOverride>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "
        SELECT track_path, title, artist, album, album_artist, disc_number, track_number,
               bpm, genre, year, recording_mbid, release_track_mbid, release_mbid,
               release_group_mbid, confidence, source, updated_at
        FROM track_metadata_overrides
        ORDER BY track_path
        ",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ImportedTrackMetadataOverride {
            track_path: row.get(0)?,
            title: row.get(1)?,
            artist: row.get(2)?,
            album: row.get(3)?,
            album_artist: row.get(4)?,
            disc_number: row.get(5)?,
            track_number: row.get(6)?,
            bpm: row.get(7)?,
            genre: row.get(8)?,
            year: row.get(9)?,
            recording_mbid: row.get(10)?,
            release_track_mbid: row.get(11)?,
            release_mbid: row.get(12)?,
            release_group_mbid: row.get(13)?,
            confidence: row.get(14)?,
            source: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_track_loudness_for_backend(db_path: &Path) -> Result<Vec<ImportedTrackLoudness>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "
        SELECT track_path, integrated_lufs, true_peak_db, target_gain_db,
               file_size, file_modified_at, analysis_version, analyzed_at
        FROM track_loudness
        ORDER BY track_path
        ",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ImportedTrackLoudness {
            track_path: row.get(0)?,
            integrated_lufs: row.get(1)?,
            true_peak_db: row.get(2)?,
            target_gain_db: row.get(3)?,
            file_size: row.get(4)?,
            file_modified_at: row.get(5)?,
            analysis_version: row.get(6)?,
            analyzed_at: row.get(7)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_track_app_state_for_backend(db_path: &Path) -> Result<Vec<ImportedTrackAppState>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "
        SELECT path, is_favorite, rating, play_count, last_played_at, added_at
        FROM tracks
        ORDER BY path
        ",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ImportedTrackAppState {
            track_path: row.get(0)?,
            favorite: row.get::<_, i64>(1)? != 0,
            rating: row.get(2)?,
            play_count: row.get(3)?,
            last_played_at: row.get(4)?,
            date_added: row.get(5)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn load_playlists(db_path: &Path) -> Result<Vec<SavedPlaylist>> {
    let mut connection = Connection::open(db_path)?;
    prune_orphaned_playlist_tracks(&mut connection)?;

    let mut playlist_stmt = connection.prepare(
        "
        SELECT p.id, p.name, p.created_at, p.updated_at, pr.rule_json
        FROM playlists p
        LEFT JOIN playlist_rules pr ON pr.playlist_id = p.id
        ORDER BY lower(p.name), p.id
        ",
    )?;

    let rows = playlist_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut track_stmt = connection.prepare(
        "
        SELECT pt.track_path
        FROM playlist_tracks pt
        INNER JOIN tracks t ON t.path = pt.track_path
        WHERE pt.playlist_id = ?1
        ORDER BY pt.position ASC
        ",
    )?;

    let mut playlists = Vec::with_capacity(rows.len());
    for (id, name, created_at, updated_at, rule_json) in rows {
        let rule = rule_json
            .as_deref()
            .map(serde_json::from_str::<SavedPlaylistRule>)
            .transpose()?;
        let track_paths = if let Some(rule) = rule.as_ref() {
            track_paths_for_playlist_rule(&connection, rule)?
        } else {
            track_stmt
                .query_map(params![id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        playlists.push(SavedPlaylist {
            id: id.to_string(),
            name,
            track_paths,
            rule,
            created_at,
            updated_at,
        });
    }

    Ok(playlists)
}

pub fn create_playlist(
    db_path: &Path,
    name: &str,
    track_paths: &[String],
    rule: Option<&SavedPlaylistRule>,
) -> Result<Vec<SavedPlaylist>> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("Playlist name cannot be empty");
    }

    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO playlists (name, created_at, updated_at) VALUES (?1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        params![trimmed],
    )?;
    let playlist_id = transaction.last_insert_rowid();
    if let Some(rule_value) = rule {
        validate_playlist_rule(rule_value)?;
        transaction.execute(
            "INSERT INTO playlist_rules (playlist_id, rule_json) VALUES (?1, ?2)",
            params![playlist_id, serde_json::to_string(rule_value)?],
        )?;
    } else {
        replace_playlist_tracks_tx(&transaction, playlist_id, track_paths)?;
    }
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn rename_playlist(
    db_path: &Path,
    playlist_id: &str,
    name: &str,
) -> Result<Vec<SavedPlaylist>> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("Playlist name cannot be empty");
    }
    let playlist_id = parse_local_playlist_id(playlist_id)?;

    let connection = Connection::open(db_path)?;
    let updated = connection.execute(
        "UPDATE playlists SET name = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![trimmed, playlist_id],
    )?;
    if updated == 0 {
        return Err(anyhow!("Playlist not found"));
    }
    load_playlists(db_path)
}

pub fn delete_playlist(db_path: &Path, playlist_id: &str) -> Result<Vec<SavedPlaylist>> {
    let playlist_id = parse_local_playlist_id(playlist_id)?;
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM playlist_rules WHERE playlist_id = ?1",
        params![playlist_id],
    )?;
    transaction.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist_id],
    )?;
    let deleted =
        transaction.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
    if deleted == 0 {
        return Err(anyhow!("Playlist not found"));
    }
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn append_tracks_to_playlist(
    db_path: &Path,
    playlist_id: &str,
    track_paths: &[String],
) -> Result<Vec<SavedPlaylist>> {
    let playlist_id = parse_local_playlist_id(playlist_id)?;
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    ensure_playlist_is_track_editable_tx(&transaction, playlist_id)?;
    let mut combined = load_playlist_track_paths_tx(&transaction, playlist_id)?;
    for path in dedupe_paths(track_paths) {
        if !combined.iter().any(|existing| existing == &path) {
            combined.push(path);
        }
    }
    replace_playlist_tracks_tx(&transaction, playlist_id, &combined)?;
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn replace_playlist_tracks(
    db_path: &Path,
    playlist_id: &str,
    track_paths: &[String],
) -> Result<Vec<SavedPlaylist>> {
    let playlist_id = parse_local_playlist_id(playlist_id)?;
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    ensure_playlist_is_track_editable_tx(&transaction, playlist_id)?;
    replace_playlist_tracks_tx(&transaction, playlist_id, track_paths)?;
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn remove_playlist_track(
    db_path: &Path,
    playlist_id: &str,
    index: usize,
) -> Result<Vec<SavedPlaylist>> {
    let playlist_id = parse_local_playlist_id(playlist_id)?;
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    ensure_playlist_is_track_editable_tx(&transaction, playlist_id)?;
    let mut track_paths = load_playlist_track_paths_tx(&transaction, playlist_id)?;
    if index >= track_paths.len() {
        bail!("Track is out of range for this playlist");
    }
    track_paths.remove(index);
    replace_playlist_tracks_tx(&transaction, playlist_id, &track_paths)?;
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn move_playlist_track(
    db_path: &Path,
    playlist_id: &str,
    from_index: usize,
    to_index: usize,
) -> Result<Vec<SavedPlaylist>> {
    let playlist_id = parse_local_playlist_id(playlist_id)?;
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    ensure_playlist_is_track_editable_tx(&transaction, playlist_id)?;
    let mut track_paths = load_playlist_track_paths_tx(&transaction, playlist_id)?;
    if from_index >= track_paths.len() || to_index >= track_paths.len() {
        bail!("Track is out of range for this playlist");
    }
    let track = track_paths.remove(from_index);
    track_paths.insert(to_index, track);
    replace_playlist_tracks_tx(&transaction, playlist_id, &track_paths)?;
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn set_album_primary_genre(
    db_path: &Path,
    album: &str,
    album_artist: Option<&str>,
    primary_genre: Option<&str>,
) -> Result<()> {
    let normalized_album = album.trim();
    if normalized_album.is_empty() {
        bail!("Album name is required");
    }

    let normalized_album_artist = album_artist.unwrap_or("").trim();
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;

    if let Some(value) = primary_genre
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        transaction.execute(
            "INSERT INTO album_primary_genres (album, album_artist, primary_genre, updated_at)
             VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
             ON CONFLICT(album, album_artist) DO UPDATE SET
                primary_genre = excluded.primary_genre,
                updated_at = CURRENT_TIMESTAMP",
            params![normalized_album, normalized_album_artist, value],
        )?;
    } else {
        transaction.execute(
            "DELETE FROM album_primary_genres WHERE album = ?1 AND album_artist = ?2",
            params![normalized_album, normalized_album_artist],
        )?;
    }

    transaction.commit()?;
    Ok(())
}

pub fn load_library(db_path: &Path) -> Result<LibraryData> {
    let connection = Connection::open(db_path)?;

    let mut statement = connection.prepare(
        "
        SELECT t.id,
               t.path,
               COALESCE(tmo.title, t.title) AS title,
               COALESCE(tmo.artist, t.artist) AS artist,
               COALESCE(tmo.album, t.album) AS album,
               COALESCE(tmo.album_artist, t.album_artist) AS album_artist,
               t.duration_seconds,
               t.format,
               t.sample_rate,
               t.bit_depth,
               COALESCE(tmo.disc_number, t.disc_number) AS disc_number,
               COALESCE(tmo.track_number, t.track_number) AS track_number,
               CAST(ROUND(COALESCE(tmo.bpm, t.bpm)) AS INTEGER) AS bpm,
               tmo.bpm IS NOT NULL AS bpm_overridden,
               COALESCE(tmo.genre, t.genre) AS genre,
               apg.primary_genre,
               t.is_vinyl_rip,
               COALESCE(tmo.year, t.year) AS year,
               t.added_at,
               t.play_count,
               t.last_played_at,
               t.is_favorite,
               t.rating
        FROM tracks t
        LEFT JOIN track_metadata_overrides tmo
          ON tmo.track_path = t.path
        LEFT JOIN album_primary_genres apg
          ON apg.album = COALESCE(tmo.album, t.album, '')
         AND apg.album_artist = COALESCE(tmo.album_artist, tmo.artist, t.album_artist, t.artist, '')
        ORDER BY
            COALESCE(tmo.album_artist, tmo.artist, t.album_artist, t.artist, ''),
            COALESCE(tmo.album, t.album, ''),
            COALESCE(tmo.disc_number, t.disc_number, 0),
            COALESCE(tmo.track_number, t.track_number, 0),
            COALESCE(tmo.title, t.title),
            t.path
        ",
    )?;

    let tracks = statement
        .query_map([], |row| {
            Ok(Track {
                id: row.get::<_, i64>(0)?.to_string(),
                path: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album: row.get(4)?,
                album_artist: row.get(5)?,
                duration_seconds: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
                format: row.get(7)?,
                sample_rate: row.get::<_, Option<i64>>(8)?.map(|value| value as u32),
                bit_depth: row.get::<_, Option<i64>>(9)?.map(|value| value as u8),
                disc_number: row.get(10)?,
                track_number: row.get(11)?,
                bpm: row.get(12)?,
                bpm_overridden: row.get::<_, i64>(13)? != 0,
                genre: row.get(14)?,
                primary_genre: row.get(15)?,
                is_vinyl_rip: row.get::<_, i64>(16)? != 0,
                year: row.get(17)?,
                added_at: row.get(18)?,
                play_count: row.get::<_, i64>(19)?,
                last_played_at: row.get(20)?,
                is_favorite: row.get::<_, i64>(21)? != 0,
                rating: row.get(22)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let track_count = query_count(&connection, "SELECT COUNT(*) FROM tracks")?;
    let album_count = query_count(
        &connection,
        "SELECT COUNT(DISTINCT COALESCE(tmo.album, t.album, '') || char(31) || COALESCE(tmo.album_artist, tmo.artist, t.album_artist, t.artist, ''))
         FROM tracks t
         LEFT JOIN track_metadata_overrides tmo ON tmo.track_path = t.path
         WHERE COALESCE(tmo.album, t.album, '') != ''",
    )?;
    let artist_count = query_count(
        &connection,
        "SELECT COUNT(DISTINCT COALESCE(tmo.artist, t.artist, ''))
         FROM tracks t
         LEFT JOIN track_metadata_overrides tmo ON tmo.track_path = t.path
         WHERE COALESCE(tmo.artist, t.artist, '') != ''",
    )?;

    Ok(LibraryData {
        tracks,
        track_count,
        album_count,
        artist_count,
    })
}

fn query_count(connection: &Connection, sql: &str) -> Result<usize> {
    Ok(connection.query_row(sql, [], |row| row.get::<_, i64>(0))? as usize)
}

fn dedupe_paths(track_paths: &[String]) -> Vec<String> {
    let mut deduped = Vec::new();
    for path in track_paths {
        if path.trim().is_empty() || deduped.iter().any(|existing| existing == path) {
            continue;
        }
        deduped.push(path.clone());
    }
    deduped
}

fn load_playlist_track_paths_tx(
    transaction: &rusqlite::Transaction<'_>,
    playlist_id: i64,
) -> Result<Vec<String>> {
    let mut exists_stmt = transaction.prepare("SELECT 1 FROM playlists WHERE id = ?1 LIMIT 1")?;
    let exists = exists_stmt.exists(params![playlist_id])?;
    if !exists {
        return Err(anyhow!("Playlist not found"));
    }

    let mut stmt = transaction.prepare(
        "SELECT track_path FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC",
    )?;
    let paths = stmt
        .query_map(params![playlist_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(paths)
}

fn load_playlist_rule_tx(
    transaction: &rusqlite::Transaction<'_>,
    playlist_id: i64,
) -> Result<Option<SavedPlaylistRule>> {
    let rule_json = transaction
        .query_row(
            "SELECT rule_json FROM playlist_rules WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    rule_json
        .as_deref()
        .map(serde_json::from_str::<SavedPlaylistRule>)
        .transpose()
        .map_err(Into::into)
}

fn ensure_playlist_is_track_editable_tx(
    transaction: &rusqlite::Transaction<'_>,
    playlist_id: i64,
) -> Result<()> {
    if load_playlist_rule_tx(transaction, playlist_id)?.is_some() {
        bail!("Auto-updating playlists can't be edited manually");
    }

    Ok(())
}

pub fn list_backend_track_loudness_cache(
    db_path: &Path,
) -> Result<Vec<BackendTrackLoudnessCacheEntry>> {
    let connection = Connection::open(db_path)?;
    let mut statement = connection.prepare(
        "
        SELECT track_path, source_fingerprint, analysis_version
        FROM backend_track_loudness
        ",
    )?;

    let rows = statement
        .query_map([], |row| {
            Ok(BackendTrackLoudnessCacheEntry {
                track_path: row.get(0)?,
                source_fingerprint: row.get(1)?,
                analysis_version: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;

    Ok(rows)
}

pub fn save_backend_track_loudness_records(
    db_path: &Path,
    records: &[BackendTrackLoudnessAnalysisRecord],
) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }

    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    let mut statement = transaction.prepare(
        "
        INSERT INTO backend_track_loudness (
            track_path,
            integrated_lufs,
            true_peak_db,
            target_gain_db,
            source_fingerprint,
            analysis_version,
            analyzed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
        ON CONFLICT(track_path) DO UPDATE SET
            integrated_lufs = excluded.integrated_lufs,
            true_peak_db = excluded.true_peak_db,
            target_gain_db = excluded.target_gain_db,
            source_fingerprint = excluded.source_fingerprint,
            analysis_version = excluded.analysis_version,
            analyzed_at = excluded.analyzed_at
        ",
    )?;

    for record in records {
        statement.execute(params![
            record.track_path,
            record.integrated_lufs,
            record.true_peak_db,
            record.target_gain_db,
            record.source_fingerprint,
            record.analysis_version,
        ])?;
    }

    drop(statement);
    transaction.commit()?;

    Ok(())
}

fn replace_playlist_tracks_tx(
    transaction: &rusqlite::Transaction<'_>,
    playlist_id: i64,
    track_paths: &[String],
) -> Result<()> {
    let normalized = dedupe_paths(track_paths);

    let mut exists_stmt = transaction.prepare("SELECT 1 FROM playlists WHERE id = ?1 LIMIT 1")?;
    let exists = exists_stmt.exists(params![playlist_id])?;
    if !exists {
        return Err(anyhow!("Playlist not found"));
    }

    transaction.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist_id],
    )?;

    for (index, path) in normalized.iter().enumerate() {
        let exists_in_library = transaction
            .prepare("SELECT 1 FROM tracks WHERE path = ?1 LIMIT 1")?
            .exists(params![path])?;
        if !exists_in_library {
            continue;
        }

        transaction.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_path, position) VALUES (?1, ?2, ?3)",
            params![playlist_id, path, index as i64],
        )?;
    }

    transaction.execute(
        "UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![playlist_id],
    )?;
    Ok(())
}

fn validate_playlist_rule(rule: &SavedPlaylistRule) -> Result<()> {
    match rule {
        SavedPlaylistRule::FilteredLibrary {
            search,
            artist,
            genre,
            vibe,
            year_from,
            year_to,
        } => {
            let has_search = search
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
            let has_artist = artist
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
            let has_genre = genre
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
            let has_vibe = vibe
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
            let has_year = year_from.is_some() || year_to.is_some();
            if !has_search && !has_artist && !has_genre && !has_vibe && !has_year {
                bail!("Auto-updating playlists need at least one filter");
            }
            if let (Some(start), Some(end)) = (year_from, year_to) {
                if start > end {
                    bail!("Auto-updating playlist year range is invalid");
                }
            }
        }
    }

    Ok(())
}

fn effective_genre<'a>(primary_genre: Option<&'a str>, genre: Option<&'a str>) -> Option<&'a str> {
    primary_genre.or(genre)
}

fn normalize_genre_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut normalized = String::with_capacity(trimmed.len());
    for ch in trimmed.chars().flat_map(char::to_lowercase) {
        match ch {
            '&' => normalized.push_str(" and "),
            '-' | '_' | '‐' | '‑' | '–' | '—' => normalized.push(' '),
            _ => normalized.push(ch),
        }
    }

    let mut normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(stripped) = normalized.strip_prefix("and ") {
        normalized = stripped.to_string();
    }
    if let Some(stripped) = normalized.strip_suffix(" and") {
        normalized = stripped.to_string();
    }
    if normalized.is_empty() {
        return None;
    }

    let alias = match normalized.as_str() {
        "drum and base" | "drum n bass" => "drum and bass",
        "r and b" | "rnb" => "r&b",
        _ => normalized.as_str(),
    };

    Some(alias.to_string())
}

fn split_track_genres(genre: &str) -> impl Iterator<Item = String> + '_ {
    genre
        .split(|ch| matches!(ch, ';' | ',' | '/'))
        .filter_map(normalize_genre_key)
}

fn vibe_key_for_bpm(bpm: i64) -> Option<&'static str> {
    match bpm {
        value if value <= 0 => None,
        value if value < 90 => Some("slowdown"),
        value if value < 110 => Some("cruise"),
        value if value < 120 => Some("groove"),
        value if value < 130 => Some("lift"),
        value if value < 145 => Some("energy"),
        _ => Some("chaos"),
    }
}

fn track_paths_for_playlist_rule(
    connection: &Connection,
    rule: &SavedPlaylistRule,
) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        "
        SELECT t.path,
               COALESCE(tmo.title, t.title) AS title,
               COALESCE(tmo.artist, t.artist) AS artist,
               COALESCE(tmo.album, t.album) AS album,
               COALESCE(tmo.genre, t.genre) AS genre,
               apg.primary_genre,
               COALESCE(tmo.year, t.year) AS year,
               CAST(ROUND(COALESCE(tmo.bpm, t.bpm)) AS INTEGER) AS bpm
        FROM tracks t
        LEFT JOIN track_metadata_overrides tmo ON tmo.track_path = t.path
        LEFT JOIN album_primary_genres apg
          ON apg.album = COALESCE(tmo.album, t.album, '')
         AND apg.album_artist = COALESCE(tmo.album_artist, tmo.artist, t.album_artist, t.artist, '')
        ORDER BY
            COALESCE(tmo.album_artist, tmo.artist, t.album_artist, t.artist, ''),
            COALESCE(tmo.album, t.album, ''),
            COALESCE(tmo.disc_number, t.disc_number, 0),
            COALESCE(tmo.track_number, t.track_number, 0),
            COALESCE(tmo.title, t.title),
            t.path
        ",
    )?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let matches_rule = |title: Option<&str>,
                        artist_value: Option<&str>,
                        album: Option<&str>,
                        genre_value: Option<&str>,
                        bpm: Option<i64>,
                        year_value: Option<i64>| match rule {
        SavedPlaylistRule::FilteredLibrary {
            search,
            artist,
            genre,
            vibe,
            year_from,
            year_to,
        } => {
            if let Some(query) = search
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let query_lower = query.to_lowercase();
                let matches_search = [title, artist_value, album]
                    .into_iter()
                    .flatten()
                    .any(|value| value.to_lowercase().contains(&query_lower));
                if !matches_search {
                    return false;
                }
            }

            if let Some(expected_artist) = artist
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if artist_value != Some(expected_artist) {
                    return false;
                }
            }

            if let Some(expected_genre) = genre.as_deref().and_then(normalize_genre_key) {
                let Some(current_genre) = genre_value else {
                    return false;
                };
                if !split_track_genres(current_genre).any(|part| part == expected_genre) {
                    return false;
                }
            }

            if let Some(expected_vibe) = vibe
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if bpm.and_then(vibe_key_for_bpm) != Some(expected_vibe) {
                    return false;
                }
            }

            if year_from.is_some() || year_to.is_some() {
                let Some(year) = year_value else {
                    return false;
                };
                if let Some(start) = year_from {
                    if year < *start {
                        return false;
                    }
                }
                if let Some(end) = year_to {
                    if year > *end {
                        return false;
                    }
                }
            }

            true
        }
    };

    Ok(rows
        .into_iter()
        .filter(
            |(_, title, artist, album, genre, primary_genre, year, bpm)| {
                matches_rule(
                    title.as_deref(),
                    artist.as_deref(),
                    album.as_deref(),
                    effective_genre(primary_genre.as_deref(), genre.as_deref()),
                    *bpm,
                    *year,
                )
            },
        )
        .map(|(path, _, _, _, _, _, _, _)| path)
        .collect())
}

fn prune_orphaned_playlist_tracks(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction()?;
    prune_orphaned_playlist_tracks_tx(&transaction)?;
    prune_orphaned_track_metadata_overrides_tx(&transaction)?;
    prune_orphaned_track_loudness_tx(&transaction)?;
    transaction.commit()?;
    Ok(())
}

fn prune_orphaned_playlist_tracks_tx(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute(
        "DELETE FROM playlist_tracks WHERE track_path NOT IN (SELECT path FROM tracks)",
        [],
    )?;
    Ok(())
}

fn prune_orphaned_track_metadata_overrides_tx(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<()> {
    transaction.execute(
        "DELETE FROM track_metadata_overrides WHERE track_path NOT IN (SELECT path FROM tracks)",
        [],
    )?;
    Ok(())
}

fn prune_orphaned_track_loudness_tx(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute(
        "DELETE FROM track_loudness WHERE track_path NOT IN (SELECT path FROM tracks)",
        [],
    )?;
    Ok(())
}

fn theme_to_str(theme: &ThemeMode) -> &'static str {
    match theme {
        ThemeMode::System => "system",
        ThemeMode::Light => "light",
        ThemeMode::Dark => "dark",
    }
}

fn equalizer_to_str(equalizer: &EqualizerPreset) -> &'static str {
    match equalizer {
        EqualizerPreset::Flat => "flat",
        EqualizerPreset::BassBoost => "bass_boost",
        EqualizerPreset::BassTrebleBoost => "bass_treble_boost",
        EqualizerPreset::Vocal => "vocal",
        EqualizerPreset::TrebleBoost => "treble_boost",
        EqualizerPreset::Lounge => "lounge",
        EqualizerPreset::Manual => "manual",
    }
}
