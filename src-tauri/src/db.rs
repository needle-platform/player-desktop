use std::path::Path;

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::models::{AppSettings, BootstrapPayload, EqualizerPreset, LibraryData, ThemeMode, Track};

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
            duration_seconds INTEGER,
            format TEXT,
            sample_rate INTEGER,
            bit_depth INTEGER,
            track_number INTEGER,
            genre TEXT,
            year INTEGER,
            added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            play_count INTEGER NOT NULL DEFAULT 0,
            last_played_at TEXT
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS library_roots (
            path TEXT PRIMARY KEY
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

    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN genre TEXT", []);
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN year INTEGER", []);
    // SQLite ALTER TABLE doesn't allow non-constant defaults; backfill below if needed.
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN added_at TEXT", []);
    let _ = connection.execute(
        "ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN last_played_at TEXT", []);
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
        equalizer_preset: match equalizer_preset.as_str() {
            "bass_boost" => EqualizerPreset::BassBoost,
            "vocal" => EqualizerPreset::Vocal,
            "treble_boost" => EqualizerPreset::TrebleBoost,
            "lounge" => EqualizerPreset::Lounge,
            _ => EqualizerPreset::Flat,
        },
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

    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            "equalizer_preset",
            equalizer_to_str(&settings.equalizer_preset)
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
    transaction.commit()?;
    Ok(())
}

pub fn purge_dotfile_tracks(db_path: &Path) -> Result<usize> {
    let connection = Connection::open(db_path)?;
    let removed = connection.execute(
        "DELETE FROM tracks WHERE path LIKE '%/.%'",
        [],
    )?;
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
        let mut stage = transaction.prepare("INSERT OR IGNORE INTO _scan_paths (path) VALUES (?1)")?;
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
                duration_seconds,
                format,
                sample_rate,
                bit_depth,
                track_number,
                genre,
                year,
                added_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP)
            ON CONFLICT(path) DO UPDATE SET
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                duration_seconds = excluded.duration_seconds,
                format = excluded.format,
                sample_rate = excluded.sample_rate,
                bit_depth = excluded.bit_depth,
                track_number = excluded.track_number,
                genre = excluded.genre,
                year = excluded.year
            ",
            params![
                track.path,
                track.title,
                track.artist,
                track.album,
                track.duration_seconds.map(|value| value as i64),
                track.format,
                track.sample_rate.map(|value| value as i64),
                track.bit_depth.map(|value| value as i64),
                track.track_number,
                track.genre,
                track.year,
            ],
        )?;
    }

    transaction.commit()?;
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

pub fn load_library(db_path: &Path) -> Result<LibraryData> {
    let connection = Connection::open(db_path)?;

    let mut statement = connection.prepare(
        "
        SELECT id, path, title, artist, album, duration_seconds, format, sample_rate, bit_depth,
               track_number, genre, year, added_at, play_count, last_played_at
        FROM tracks
        ORDER BY
            COALESCE(artist, ''),
            COALESCE(album, ''),
            COALESCE(track_number, 0),
            title,
            path
        ",
    )?;

    let tracks = statement
        .query_map([], |row| {
            Ok(Track {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album: row.get(4)?,
                duration_seconds: row.get::<_, Option<i64>>(5)?.map(|value| value as u64),
                format: row.get(6)?,
                sample_rate: row.get::<_, Option<i64>>(7)?.map(|value| value as u32),
                bit_depth: row.get::<_, Option<i64>>(8)?.map(|value| value as u8),
                track_number: row.get(9)?,
                genre: row.get(10)?,
                year: row.get(11)?,
                added_at: row.get(12)?,
                play_count: row.get::<_, i64>(13)?,
                last_played_at: row.get(14)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let track_count = query_count(&connection, "SELECT COUNT(*) FROM tracks")?;
    let album_count = query_count(
        &connection,
        "SELECT COUNT(DISTINCT album) FROM tracks WHERE album IS NOT NULL AND album != ''",
    )?;
    let artist_count = query_count(
        &connection,
        "SELECT COUNT(DISTINCT artist) FROM tracks WHERE artist IS NOT NULL AND artist != ''",
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
        EqualizerPreset::Vocal => "vocal",
        EqualizerPreset::TrebleBoost => "treble_boost",
        EqualizerPreset::Lounge => "lounge",
    }
}
