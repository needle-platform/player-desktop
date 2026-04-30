use std::path::Path;

use anyhow::Result;
use anyhow::{anyhow, bail};
use rusqlite::{params, Connection};

use crate::models::{
    default_equalizer_bands, default_tracks_page_size, AppSettings, BootstrapPayload,
    EqualizerPreset, LibraryData, PlaybackSession, SavedPlaylist, ThemeMode, Track,
};

fn normalize_hex_color(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", hex.to_ascii_lowercase()))
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

        CREATE TABLE IF NOT EXISTS artist_images (
            name TEXT PRIMARY KEY,
            url TEXT,
            fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS artist_info (
            name TEXT PRIMARY KEY,
            description TEXT,
            source_url TEXT,
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

        CREATE TABLE IF NOT EXISTS album_primary_genres (
            album TEXT NOT NULL,
            album_artist TEXT NOT NULL,
            primary_genre TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (album, album_artist)
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

    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN genre TEXT", []);
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN year INTEGER", []);
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN album_artist TEXT", []);
    let _ = connection.execute("ALTER TABLE tracks ADD COLUMN disc_number INTEGER", []);
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
            "vocal" => EqualizerPreset::Vocal,
            "treble_boost" => EqualizerPreset::TrebleBoost,
            "lounge" => EqualizerPreset::Lounge,
            "manual" => EqualizerPreset::Manual,
            _ => EqualizerPreset::Flat,
        },
        equalizer_bands,
        tracks_page_size,
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
            "equalizer_bands",
            serde_json::to_string(&settings.equalizer_bands)?
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
    prune_orphaned_playlist_tracks_tx(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub fn purge_dotfile_tracks(db_path: &Path) -> Result<usize> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    let removed = transaction.execute("DELETE FROM tracks WHERE path LIKE '%/.%'", [])?;
    prune_orphaned_playlist_tracks_tx(&transaction)?;
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
                genre,
                year,
                added_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP)
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
                genre = excluded.genre,
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
                track.genre,
                track.year,
            ],
        )?;
    }

    prune_orphaned_playlist_tracks_tx(&transaction)?;
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
}

pub fn get_artist_info(db_path: &Path, name: &str) -> Result<Option<Option<CachedArtistInfo>>> {
    let connection = Connection::open(db_path)?;
    let mut stmt = connection.prepare(
        "SELECT description, source_url FROM artist_info
         WHERE name = ?1
           AND datetime(fetched_at) > datetime('now', '-90 days')",
    )?;
    let mut rows = stmt.query(params![name])?;
    if let Some(row) = rows.next()? {
        let description: Option<String> = row.get(0)?;
        let source_url: Option<String> = row.get(1)?;
        if description.is_none() && source_url.is_none() {
            return Ok(Some(None));
        }
        return Ok(Some(Some(CachedArtistInfo {
            description,
            source_url,
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
    let (description, source_url) = match info {
        Some(info) => (info.description.as_deref(), info.source_url.as_deref()),
        None => (None, None),
    };
    connection.execute(
        "INSERT INTO artist_info (name, description, source_url, fetched_at)
         VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
         ON CONFLICT(name) DO UPDATE SET
            description = excluded.description,
            source_url = excluded.source_url,
            fetched_at = excluded.fetched_at",
        params![name, description, source_url],
    )?;
    Ok(())
}

pub fn delete_artist_info(db_path: &Path, name: &str) -> Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute("DELETE FROM artist_info WHERE name = ?1", params![name])?;
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

pub fn load_playlists(db_path: &Path) -> Result<Vec<SavedPlaylist>> {
    let mut connection = Connection::open(db_path)?;
    prune_orphaned_playlist_tracks(&mut connection)?;

    let mut playlist_stmt = connection.prepare(
        "
        SELECT id, name, created_at, updated_at
        FROM playlists
        ORDER BY lower(name), id
        ",
    )?;

    let rows = playlist_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
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
    for (id, name, created_at, updated_at) in rows {
        let track_paths = track_stmt
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        playlists.push(SavedPlaylist {
            id,
            name,
            track_paths,
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
    replace_playlist_tracks_tx(&transaction, playlist_id, track_paths)?;
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn rename_playlist(db_path: &Path, playlist_id: i64, name: &str) -> Result<Vec<SavedPlaylist>> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("Playlist name cannot be empty");
    }

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

pub fn delete_playlist(db_path: &Path, playlist_id: i64) -> Result<Vec<SavedPlaylist>> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
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
    playlist_id: i64,
    track_paths: &[String],
) -> Result<Vec<SavedPlaylist>> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
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
    playlist_id: i64,
    track_paths: &[String],
) -> Result<Vec<SavedPlaylist>> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
    replace_playlist_tracks_tx(&transaction, playlist_id, track_paths)?;
    transaction.commit()?;
    load_playlists(db_path)
}

pub fn remove_playlist_track(
    db_path: &Path,
    playlist_id: i64,
    index: usize,
) -> Result<Vec<SavedPlaylist>> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
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
    playlist_id: i64,
    from_index: usize,
    to_index: usize,
) -> Result<Vec<SavedPlaylist>> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;
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
               t.title,
               t.artist,
               t.album,
               t.album_artist,
               t.duration_seconds,
               t.format,
               t.sample_rate,
               t.bit_depth,
               t.disc_number,
               t.track_number,
               t.genre,
               apg.primary_genre,
               t.year,
               t.added_at,
               t.play_count,
               t.last_played_at
        FROM tracks t
        LEFT JOIN album_primary_genres apg
          ON apg.album = COALESCE(t.album, '')
         AND apg.album_artist = COALESCE(t.album_artist, t.artist, '')
        ORDER BY
            COALESCE(t.album_artist, t.artist, ''),
            COALESCE(t.album, ''),
            COALESCE(t.disc_number, 0),
            COALESCE(t.track_number, 0),
            t.title,
            t.path
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
                album_artist: row.get(5)?,
                duration_seconds: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
                format: row.get(7)?,
                sample_rate: row.get::<_, Option<i64>>(8)?.map(|value| value as u32),
                bit_depth: row.get::<_, Option<i64>>(9)?.map(|value| value as u8),
                disc_number: row.get(10)?,
                track_number: row.get(11)?,
                genre: row.get(12)?,
                primary_genre: row.get(13)?,
                year: row.get(14)?,
                added_at: row.get(15)?,
                play_count: row.get::<_, i64>(16)?,
                last_played_at: row.get(17)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let track_count = query_count(&connection, "SELECT COUNT(*) FROM tracks")?;
    let album_count = query_count(
        &connection,
        "SELECT COUNT(DISTINCT album || char(31) || COALESCE(album_artist, artist, ''))
         FROM tracks
         WHERE album IS NOT NULL AND album != ''",
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

fn prune_orphaned_playlist_tracks(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction()?;
    prune_orphaned_playlist_tracks_tx(&transaction)?;
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
        EqualizerPreset::Manual => "manual",
    }
}
