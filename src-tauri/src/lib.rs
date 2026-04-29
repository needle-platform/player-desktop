mod album;
mod artist;
mod cover;
mod db;
mod library;
mod models;
mod mpv;

use std::{fs, path::Path, sync::Mutex};

use models::{AppSettings, BootstrapPayload, PlaybackSession, PlaybackState, RepeatMode};
use mpv::MpvController;
use tauri::Manager;

struct AppState {
    db_path: std::path::PathBuf,
    player: Mutex<MpvController>,
}

const DB_FILENAME: &str = "library.sqlite";
const SOCKET_FILENAME: &str = "mpv.sock";
const LEGACY_BUNDLE_IDENTIFIER: &str = "com.davidrelich.musicplayer";

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

    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
    player
        .set_equalizer(settings.equalizer_preset.clone(), settings.equalizer_bands)
        .map_err(|error| error.to_string())?;

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
fn play_queue_index(index: usize, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut player = state
        .player
        .lock()
        .map_err(|_| "Unable to acquire player state".to_string())?;
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
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    db::create_playlist(&state.db_path, &name, &track_paths).map_err(|error| error.to_string())?;
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
fn run_maintenance(state: tauri::State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let roots = db::list_library_roots(&state.db_path).map_err(|error| error.to_string())?;

    db::purge_dotfile_tracks(&state.db_path).map_err(|error| error.to_string())?;

    for root in &roots {
        if !Path::new(root).exists() {
            db::remove_library_root(&state.db_path, root).map_err(|error| error.to_string())?;
            continue;
        }

        let tracks = library::scan_folder(root).map_err(|error| error.to_string())?;
        db::replace_tracks(&state.db_path, root, &tracks).map_err(|error| error.to_string())?;
    }

    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
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

    let key = format!(
        "{}|{}",
        album_trim.to_lowercase(),
        artist_trim.as_deref().unwrap_or("").to_lowercase(),
    );

    if let Some(cached) =
        db::get_album_info(&state.db_path, &key).map_err(|error| error.to_string())?
    {
        return Ok(cached.map(|info| album::AlbumInfo {
            description: info.description,
            source_url: info.source_url,
            source: "cache".into(),
        }));
    }

    match album::fetch_album_info(&album_trim, artist_trim.as_deref()).await {
        Ok(Some(info)) => {
            let cached = db::CachedAlbumInfo {
                description: info.description.clone(),
                source_url: info.source_url.clone(),
            };
            let _ = db::cache_album_info(&state.db_path, &key, Some(&cached));
            Ok(Some(info))
        }
        Ok(None) => {
            let _ = db::cache_album_info(&state.db_path, &key, None);
            Ok(None)
        }
        Err(error) => Err(error.to_string()),
    }
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
            set_playback_volume,
            set_playback_muted,
            set_audio_device,
            set_repeat_mode,
            run_maintenance,
            remove_library_root,
            get_cover_art,
            record_play,
            get_artist_image,
            get_album_info
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut player) = state.player.lock() {
                        player.shutdown();
                    }
                }
                // Belt-and-suspenders: kill any mpv pid still tracked.
                mpv::kill_all_mpv();
            }
        });
}
