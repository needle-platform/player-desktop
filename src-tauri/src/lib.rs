mod album;
mod album_metadata;
mod artist;
mod cover;
mod db;
mod library;
mod loudness;
mod models;
mod mpv;

use std::{fs, path::Path, process::Command, sync::Mutex, time::Instant};

use models::{
    AlbumMetadataRefreshResult, AlbumMetadataRefreshStatus, AppSettings, BootstrapPayload,
    PlaybackSession, PlaybackState, RepeatMode, SavedPlaylistRule, TrackBpmAdjustment,
};
use mpv::MpvController;
use tauri::{Emitter, Manager};

struct AppState {
    db_path: std::path::PathBuf,
    player: Mutex<MpvController>,
}

const DB_FILENAME: &str = "library.sqlite";
const SOCKET_FILENAME: &str = "mpv.sock";
const LEGACY_BUNDLE_IDENTIFIER: &str = "com.davidrelich.musicplayer";

fn musicbrainz_refresh_error_message(error: &str) -> String {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("allowable rate limit")
        || normalized.contains("too many requests")
        || (normalized.contains("503 service unavailable") && normalized.contains("rate limit"))
        || normalized.contains("returned 429")
    {
        return "MusicBrainz is rate-limiting requests right now. Please try again in a minute or two."
            .to_string();
    }

    "Needle couldn't refresh metadata from MusicBrainz right now. Please try again later."
        .to_string()
}

fn volume_leveling_gain_for_path(
    db_path: &Path,
    path: Option<&str>,
) -> Result<Option<f32>, String> {
    let Some(track_path) = path.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };

    let settings = db::load_settings(db_path).map_err(|error| error.to_string())?;
    if !settings.volume_leveling_enabled {
        return Ok(None);
    }

    db::get_track_loudness_gain(db_path, track_path).map_err(|error| error.to_string())
}

fn apply_volume_leveling_to_player(
    player: &mut MpvController,
    db_path: &Path,
    path: Option<&str>,
) -> Result<(), String> {
    let gain = volume_leveling_gain_for_path(db_path, path)?;
    player
        .set_track_gain_db(gain)
        .map_err(|error| error.to_string())
}

fn migrate_legacy_app_data(app_data_dir: &Path) {
    let Some(parent) = app_data_dir.parent() else {
        return;
    };

    let legacy_dir = parent.join(LEGACY_BUNDLE_IDENTIFIER);
    if legacy_dir == app_data_dir {
        return;
    }

    for filename in [DB_FILENAME, "library.sqlite-shm", "library.sqlite-wal"] {
        let source = legacy_dir.join(filename);
        let target = app_data_dir.join(filename);
        if target.exists() || !source.exists() {
            continue;
        }

        if let Err(error) = fs::copy(&source, &target) {
            eprintln!(
                "Failed to migrate legacy app data from {} to {}: {error}",
                source.display(),
                target.display()
            );
        }
    }
}

#[tauri::command]
fn bootstrap_app(state: tauri::State<'_, AppState>) -> Result<BootstrapPayload, String> {
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http:// and https:// URLs can be opened".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(trimmed);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", trimmed]);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(trimmed);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to open external URL: {error}"))
}

#[tauri::command]
fn scan_library(
    folder: String,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    if !Path::new(&folder).exists() {
        return Err("Selected folder does not exist".to_string());
    }

    let tracks = library::scan_folder(&folder).map_err(|error| error.to_string())?;
    db::insert_or_update_library_root(&state.db_path, &folder)
        .map_err(|error| error.to_string())?;
    db::replace_tracks(&state.db_path, &folder, &tracks).map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_settings(
    settings: AppSettings,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings, String> {
    db::save_settings(&state.db_path, &settings).map_err(|error| error.to_string())?;
    let current_session =
        db::load_playback_session(&state.db_path).map_err(|error| error.to_string())?;
    let current_path = current_session
        .queue_paths
        .get(current_session.current_index)
        .cloned();

    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .set_equalizer(settings.equalizer_preset.clone(), settings.equalizer_bands)
        .map_err(|error| error.to_string())?;
    apply_volume_leveling_to_player(&mut player, &state.db_path, current_path.as_deref())?;

    Ok(settings)
}

#[tauri::command]
fn play_track(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Audio file does not exist".to_string());
    }

    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    apply_volume_leveling_to_player(&mut player, &state.db_path, Some(&path))?;
    player.play(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn play_queue(paths: Vec<String>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let existing: Vec<String> = paths
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .collect();
    if existing.is_empty() {
        return Err("None of the requested files exist".to_string());
    }

    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    apply_volume_leveling_to_player(
        &mut player,
        &state.db_path,
        existing.first().map(String::as_str),
    )?;
    player
        .play_queue(&existing)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn pause_playback(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player.pause().map_err(|error| error.to_string())
}

#[tauri::command]
fn resume_playback(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player.resume().map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_playback(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player.stop().map_err(|error| error.to_string())
}

#[tauri::command]
fn seek_playback(position_seconds: f64, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .seek_to(position_seconds)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_playback_state(state: tauri::State<'_, AppState>) -> Result<PlaybackState, String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player.playback_state().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_playback_session(
    session: PlaybackSession,
    state: tauri::State<'_, AppState>,
) -> Result<PlaybackSession, String> {
    db::save_playback_session(&state.db_path, &session).map_err(|error| error.to_string())
}

#[tauri::command]
fn sync_playback_session(
    session: PlaybackSession,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let filtered_paths: Vec<String> = session
        .queue_paths
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .collect();

    let normalized = PlaybackSession {
        current_index: session
            .current_index
            .min(filtered_paths.len().saturating_sub(1)),
        queue_paths: filtered_paths,
        base_queue_paths: session.base_queue_paths,
        position_seconds: session.position_seconds.max(0.0),
        paused: session.paused,
        repeat_mode: session.repeat_mode,
        shuffle_enabled: session.shuffle_enabled,
    };

    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    apply_volume_leveling_to_player(
        &mut player,
        &state.db_path,
        normalized
            .queue_paths
            .get(normalized.current_index)
            .map(String::as_str),
    )?;
    player
        .sync_playback_session(&normalized)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_repeat_mode(
    repeat_mode: RepeatMode,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .set_repeat_mode(&repeat_mode)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_volume_leveling_for_track(
    path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    apply_volume_leveling_to_player(&mut player, &state.db_path, path.as_deref())
}

#[tauri::command]
fn play_queue_index(index: usize, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let session = db::load_playback_session(&state.db_path).map_err(|error| error.to_string())?;
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    apply_volume_leveling_to_player(
        &mut player,
        &state.db_path,
        session.queue_paths.get(index).map(String::as_str),
    )?;
    player
        .play_queue_index(index)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn append_queue(paths: Vec<String>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let existing: Vec<String> = paths
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .collect();
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .append_queue(&existing)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn insert_queue_at(
    paths: Vec<String>,
    index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let existing: Vec<String> = paths
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .collect();
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .insert_queue_at(&existing, index)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_queue_index(index: usize, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .remove_queue_index(index)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn move_queue_index(
    from_index: usize,
    to_index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .move_queue_index(from_index, to_index)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_queue(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player.clear_queue().map_err(|error| error.to_string())
}

#[tauri::command]
fn create_playlist(
    name: String,
    track_paths: Vec<String>,
    rule: Option<SavedPlaylistRule>,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::create_playlist(&state.db_path, &name, &track_paths, rule.as_ref())
        .map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_playlist(
    playlist_id: i64,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::rename_playlist(&state.db_path, playlist_id, &name).map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_playlist(
    playlist_id: i64,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::delete_playlist(&state.db_path, playlist_id).map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn append_tracks_to_playlist(
    playlist_id: i64,
    track_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::append_tracks_to_playlist(&state.db_path, playlist_id, &track_paths)
        .map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn replace_playlist_tracks(
    playlist_id: i64,
    track_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::replace_playlist_tracks(&state.db_path, playlist_id, &track_paths)
        .map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_playlist_track(
    playlist_id: i64,
    index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::remove_playlist_track(&state.db_path, playlist_id, index)
        .map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn move_playlist_track(
    playlist_id: i64,
    from_index: usize,
    to_index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::move_playlist_track(&state.db_path, playlist_id, from_index, to_index)
        .map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_album_primary_genre(
    album: String,
    album_artist: Option<String>,
    primary_genre: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::set_album_primary_genre(
        &state.db_path,
        &album,
        album_artist.as_deref(),
        primary_genre.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_track_rating(
    path: String,
    rating: Option<i64>,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::set_track_rating(&state.db_path, &path, rating).map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn adjust_track_bpm(
    path: String,
    adjustment: TrackBpmAdjustment,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::adjust_track_bpm(&state.db_path, &path, adjustment).map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_playback_volume(
    volume_percent: f64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .set_volume(volume_percent)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_playback_muted(muted: bool, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player.set_muted(muted).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_audio_device(device_name: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .set_audio_device(&device_name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_missing_library_roots(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let roots = db::list_library_roots(&state.db_path).map_err(|error| error.to_string())?;
    Ok(roots
        .into_iter()
        .filter(|root| !Path::new(root).exists())
        .collect())
}

#[tauri::command]
async fn run_maintenance(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    let db_path = state.db_path.clone();
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let emit_log = |message: String| {
            let _ = app_handle.emit("maintenance-log", message);
        };

        let roots = db::list_library_roots(&db_path).map_err(|error| error.to_string())?;

        emit_log(format!(
            "Starting library maintenance for {} folder{}.",
            roots.len(),
            if roots.len() == 1 { "" } else { "s" }
        ));

        let removed_dotfile_tracks =
            db::purge_dotfile_tracks(&db_path).map_err(|error| error.to_string())?;
        emit_log(format!(
            "Removed {} dotfile entr{} from the library database.",
            removed_dotfile_tracks,
            if removed_dotfile_tracks == 1 {
                "y"
            } else {
                "ies"
            }
        ));

        if roots.is_empty() {
            emit_log(
                "No library folders are configured, so there was nothing to rescan.".to_string(),
            );
        }

        for (index, root) in roots.iter().enumerate() {
            emit_log(format!(
                "Checking folder {}/{}: {}",
                index + 1,
                roots.len(),
                root
            ));

            let started_at = Instant::now();
            if !Path::new(root).exists() {
                db::remove_library_root(&db_path, root).map_err(|error| error.to_string())?;
                emit_log(format!(
                    "Removed missing folder in {} ms: {}",
                    started_at.elapsed().as_millis(),
                    root
                ));
                continue;
            }

            let tracks = library::scan_folder(root).map_err(|error| error.to_string())?;
            let track_count = tracks.len();
            db::replace_tracks(&db_path, root, &tracks).map_err(|error| error.to_string())?;
            emit_log(format!(
                "Scanned {} track{} in {} ms: {}",
                track_count,
                if track_count == 1 { "" } else { "s" },
                started_at.elapsed().as_millis(),
                root
            ));
        }

        db::record_maintenance_run(&db_path).map_err(|error| error.to_string())?;
        let bootstrap = db::load_bootstrap(&db_path).map_err(|error| error.to_string())?;
        emit_log(format!(
            "Maintenance finished. Library now has {} track{}, {} album{}, and {} artist{}.",
            bootstrap.library.track_count,
            if bootstrap.library.track_count == 1 {
                ""
            } else {
                "s"
            },
            bootstrap.library.album_count,
            if bootstrap.library.album_count == 1 {
                ""
            } else {
                "s"
            },
            bootstrap.library.artist_count,
            if bootstrap.library.artist_count == 1 {
                ""
            } else {
                "s"
            }
        ));

        Ok(bootstrap)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_loudness_analysis(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    let db_path = state.db_path.clone();
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let emit_log = |message: String| {
            let _ = app_handle.emit("loudness-analysis-log", message);
        };
        let emit_progress = |progress: loudness::LoudnessAnalysisProgress| {
            let _ = app_handle.emit("loudness-analysis-progress", progress);
        };

        loudness::analyze_library(&db_path, emit_log, emit_progress)
            .map_err(|error| error.to_string())?;
        db::load_bootstrap(&db_path).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn remove_library_root(
    folder: String,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::remove_library_root(&state.db_path, &folder).map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn record_play(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    db::record_play(&state.db_path, &path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_artist_image(
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<artist::ArtistImage>, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if let Some(cached) =
        db::get_artist_image(&state.db_path, &trimmed).map_err(|error| error.to_string())?
    {
        return Ok(cached.map(|url| artist::ArtistImage {
            url,
            source: "cache".into(),
        }));
    }

    match artist::fetch_artist_image(&trimmed).await {
        Ok(Some(image)) => {
            let _ = db::cache_artist_image(&state.db_path, &trimmed, Some(&image.url));
            Ok(Some(image))
        }
        Ok(None) => {
            let _ = db::cache_artist_image(&state.db_path, &trimmed, None);
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn peek_artist_image(
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<artist::ArtistImage>, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let cached =
        db::get_artist_image(&state.db_path, &trimmed).map_err(|error| error.to_string())?;
    Ok(cached.flatten().map(|url| artist::ArtistImage {
        url,
        source: "cache".into(),
    }))
}

#[tauri::command]
async fn refresh_artist_image(
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<artist::ArtistImage>, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let existing = db::get_artist_image(&state.db_path, &trimmed)
        .map_err(|error| error.to_string())?
        .flatten();

    match artist::fetch_artist_image(&trimmed).await {
        Ok(Some(image)) => {
            let _ = db::cache_artist_image(&state.db_path, &trimmed, Some(&image.url));
            Ok(Some(image))
        }
        Ok(None) => {
            if let Some(url) = existing {
                return Ok(Some(artist::ArtistImage {
                    url,
                    source: "cache".into(),
                }));
            }
            let _ = db::cache_artist_image(&state.db_path, &trimmed, None);
            Ok(None)
        }
        Err(error) => {
            if let Some(url) = existing {
                return Ok(Some(artist::ArtistImage {
                    url,
                    source: "cache".into(),
                }));
            }
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn get_artist_info(
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<artist::ArtistInfo>, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if let Some(cached) =
        db::get_artist_info(&state.db_path, &trimmed).map_err(|error| error.to_string())?
    {
        return Ok(cached.map(|info| artist::ArtistInfo {
            description: info.description,
            source_url: info.source_url,
            gender: info.gender,
            source: "cache".into(),
        }));
    }

    match artist::fetch_artist_info(&trimmed).await {
        Ok(Some(info)) => {
            let cached = db::CachedArtistInfo {
                description: info.description.clone(),
                source_url: info.source_url.clone(),
                gender: info.gender,
            };
            let _ = db::cache_artist_info(&state.db_path, &trimmed, Some(&cached));
            Ok(Some(info))
        }
        Ok(None) => {
            let _ = db::cache_artist_info(&state.db_path, &trimmed, None);
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn refresh_artist_info(
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<artist::ArtistInfo>, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let existing = db::get_artist_info(&state.db_path, &trimmed)
        .map_err(|error| error.to_string())?
        .flatten();

    match artist::fetch_artist_info(&trimmed).await {
        Ok(Some(info)) => {
            let merged = if let Some(existing) = existing {
                artist::ArtistInfo {
                    description: info.description.or(existing.description),
                    source_url: info.source_url.or(existing.source_url),
                    gender: info.gender.or(existing.gender),
                    source: info.source,
                }
            } else {
                info
            };
            let cached = db::CachedArtistInfo {
                description: merged.description.clone(),
                source_url: merged.source_url.clone(),
                gender: merged.gender,
            };
            let _ = db::cache_artist_info(&state.db_path, &trimmed, Some(&cached));
            Ok(Some(merged))
        }
        Ok(None) => {
            if let Some(existing) = existing {
                return Ok(Some(artist::ArtistInfo {
                    description: existing.description,
                    source_url: existing.source_url,
                    gender: existing.gender,
                    source: "cache".into(),
                }));
            }
            let _ = db::cache_artist_info(&state.db_path, &trimmed, None);
            Ok(None)
        }
        Err(error) => {
            if let Some(existing) = existing {
                return Ok(Some(artist::ArtistInfo {
                    description: existing.description,
                    source_url: existing.source_url,
                    gender: existing.gender,
                    source: "cache".into(),
                }));
            }
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn get_album_info(
    album: String,
    artist: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<album::AlbumInfo>, String> {
    let album_trim = album.trim().to_string();
    if album_trim.is_empty() {
        return Ok(None);
    }
    let artist_trim = artist
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let lookup_keys = album_info_lookup_keys(&album_trim, artist_trim.as_deref());
    let primary_key = lookup_keys
        .first()
        .cloned()
        .unwrap_or_else(|| album_info_cache_key(&album_trim, artist_trim.as_deref()));

    let mut saw_uncached_lookup = false;
    for lookup_key in &lookup_keys {
        match db::get_album_info(&state.db_path, lookup_key).map_err(|error| error.to_string())? {
            Some(Some(info)) => {
                if lookup_key != &primary_key {
                    let _ = db::cache_album_info(&state.db_path, &primary_key, Some(&info));
                }
                return Ok(Some(album::AlbumInfo {
                    description: info.description,
                    source_url: info.source_url,
                    source: "cache".into(),
                }));
            }
            Some(None) => {}
            None => saw_uncached_lookup = true,
        }
    }

    if !saw_uncached_lookup && !lookup_keys.is_empty() {
        return Ok(None);
    }

    match album::fetch_album_info(&album_trim, artist_trim.as_deref()).await {
        Ok(Some(info)) => {
            let cached = db::CachedAlbumInfo {
                description: info.description.clone(),
                source_url: info.source_url.clone(),
            };
            for lookup_key in &lookup_keys {
                let _ = db::cache_album_info(&state.db_path, lookup_key, Some(&cached));
            }
            Ok(Some(info))
        }
        Ok(None) => {
            for lookup_key in &lookup_keys {
                let _ = db::cache_album_info(&state.db_path, lookup_key, None);
            }
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn refresh_album_info(
    album: String,
    artist: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<album::AlbumInfo>, String> {
    let album_trim = album.trim().to_string();
    if album_trim.is_empty() {
        return Ok(None);
    }
    let artist_trim = artist
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let lookup_keys = album_info_lookup_keys(&album_trim, artist_trim.as_deref());
    for lookup_key in &lookup_keys {
        let _ = db::delete_album_info(&state.db_path, lookup_key);
    }

    match album::fetch_album_info(&album_trim, artist_trim.as_deref()).await {
        Ok(Some(info)) => {
            let cached = db::CachedAlbumInfo {
                description: info.description.clone(),
                source_url: info.source_url.clone(),
            };
            for lookup_key in &lookup_keys {
                let _ = db::cache_album_info(&state.db_path, lookup_key, Some(&cached));
            }
            Ok(Some(info))
        }
        Ok(None) => {
            for lookup_key in &lookup_keys {
                let _ = db::cache_album_info(&state.db_path, lookup_key, None);
            }
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn refresh_album_metadata_from_musicbrainz(
    album: String,
    album_artist: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<AlbumMetadataRefreshResult, String> {
    let album_trim = album.trim().to_string();
    if album_trim.is_empty() {
        return Err("Album name is required".to_string());
    }
    let album_artist_trim = album_artist
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let tracks =
        db::load_album_tracks_for_match(&state.db_path, &album_trim, album_artist_trim.as_deref())
            .map_err(|error| error.to_string())?;
    if tracks.is_empty() {
        return Err("No tracks found for this album".to_string());
    }

    let result = match album_metadata::refresh_album_metadata(
        &album_trim,
        album_artist_trim.as_deref(),
        &tracks,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let bootstrap =
                db::load_bootstrap(&state.db_path).map_err(|db_error| db_error.to_string())?;
            return Ok(AlbumMetadataRefreshResult {
                status: AlbumMetadataRefreshStatus::Error,
                album: album_trim,
                album_artist: album_artist_trim,
                updated_track_count: 0,
                confidence: None,
                release_title: None,
                release_artist: None,
                source_url: None,
                message: musicbrainz_refresh_error_message(&error.to_string()),
                bootstrap,
            });
        }
    };

    if matches!(result.status, AlbumMetadataRefreshStatus::Matched) {
        db::replace_track_metadata_overrides(&state.db_path, &result.overrides)
            .map_err(|error| error.to_string())?;
    }

    let bootstrap = db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())?;
    Ok(AlbumMetadataRefreshResult {
        status: result.status,
        album: album_trim,
        album_artist: album_artist_trim,
        updated_track_count: result.overrides.len(),
        confidence: result.confidence,
        release_title: result.release_title,
        release_artist: result.release_artist,
        source_url: result.source_url,
        message: result.message,
        bootstrap,
    })
}

const ALBUM_INFO_CACHE_VERSION: &str = "v2";

fn album_info_cache_key(album: &str, artist: Option<&str>) -> String {
    format!(
        "{}|{}|{}",
        ALBUM_INFO_CACHE_VERSION,
        album.trim().to_lowercase(),
        artist.unwrap_or("").trim().to_lowercase(),
    )
}

fn album_info_lookup_keys(album: &str, artist: Option<&str>) -> Vec<String> {
    album::lookup_title_candidates(album)
        .into_iter()
        .map(|title| album_info_cache_key(&title, artist))
        .collect()
}

#[tauri::command]
fn get_cover_art(track_path: String) -> Result<Option<cover::CoverArt>, String> {
    let path = Path::new(&track_path);
    if !path.exists() {
        return Ok(None);
    }
    cover::find_cover_for(path).map_err(|error| error.to_string())
}

pub fn run() {
    // Catch SIGINT / SIGTERM / SIGHUP so we always reap mpv child processes,
    // even when the OS bypasses Drop / RunEvent::Exit (Cmd-Q on macOS, Ctrl-C
    // in the dev terminal, parent shell hangup, etc.).
    let _ = ctrlc::set_handler(|| {
        mpv::kill_all_mpv();
        std::process::exit(0);
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Unable to determine app data directory");
            fs::create_dir_all(&app_data_dir).expect("Unable to create app data directory");
            migrate_legacy_app_data(&app_data_dir);

            let db_path = app_data_dir.join(DB_FILENAME);
            db::init_database(&db_path).expect("Unable to initialize SQLite database");

            let socket_path = app_data_dir.join(SOCKET_FILENAME);
            let settings = db::load_bootstrap(&db_path)
                .expect("Unable to load app settings for mpv initialization")
                .settings;
            let mut player = MpvController::new(
                socket_path,
                settings.equalizer_preset,
                settings.equalizer_bands,
            );
            player.set_app_handle(app.handle().clone());
            app.manage(AppState {
                db_path,
                player: Mutex::new(player),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_app,
            open_external_url,
            scan_library,
            save_settings,
            play_track,
            play_queue,
            pause_playback,
            resume_playback,
            stop_playback,
            seek_playback,
            get_playback_state,
            save_playback_session,
            sync_playback_session,
            play_queue_index,
            append_queue,
            insert_queue_at,
            remove_queue_index,
            move_queue_index,
            clear_queue,
            create_playlist,
            rename_playlist,
            delete_playlist,
            append_tracks_to_playlist,
            replace_playlist_tracks,
            remove_playlist_track,
            move_playlist_track,
            set_album_primary_genre,
            set_track_rating,
            adjust_track_bpm,
            set_playback_volume,
            set_playback_muted,
            set_audio_device,
            get_missing_library_roots,
            set_repeat_mode,
            apply_volume_leveling_for_track,
            run_maintenance,
            run_loudness_analysis,
            remove_library_root,
            get_cover_art,
            record_play,
            get_artist_image,
            peek_artist_image,
            refresh_artist_image,
            get_artist_info,
            refresh_artist_info,
            get_album_info,
            refresh_album_info,
            refresh_album_metadata_from_musicbrainz
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        if let Ok(mut player) = state.player.lock() {
                            player.shutdown();
                        }
                    }
                    // Belt-and-suspenders: kill any mpv pid still tracked.
                    mpv::kill_all_mpv();
                }
                _ => {}
            }
        });
}
