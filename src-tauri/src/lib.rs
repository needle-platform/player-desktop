mod artist;
mod cover;
mod db;
mod library;
mod models;
mod mpv;

use std::{fs, path::Path, sync::Mutex};

use models::{AppSettings, BootstrapPayload};
use mpv::MpvController;
use tauri::Manager;

struct AppState {
    db_path: std::path::PathBuf,
    player: Mutex<MpvController>,
}

#[tauri::command]
fn bootstrap_app(state: tauri::State<'_, AppState>) -> Result<BootstrapPayload, String> {
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn scan_library(folder: String, state: tauri::State<'_, AppState>) -> Result<BootstrapPayload, String> {
    if !Path::new(&folder).exists() {
        return Err("Selected folder does not exist".to_string());
    }

    let tracks = library::scan_folder(&folder).map_err(|error| error.to_string())?;
    db::insert_or_update_library_root(&state.db_path, &folder).map_err(|error| error.to_string())?;
    db::replace_tracks(&state.db_path, &folder, &tracks).map_err(|error| error.to_string())?;
    db::load_bootstrap(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_settings(
    settings: AppSettings,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings, String> {
    db::save_settings(&state.db_path, &settings).map_err(|error| error.to_string())
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

    if let Some(cached) = db::get_artist_image(&state.db_path, &trimmed)
        .map_err(|error| error.to_string())?
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
fn get_cover_art(track_path: String) -> Result<Option<cover::CoverArt>, String> {
    let path = Path::new(&track_path);
    if !path.exists() {
        return Ok(None);
    }
    cover::find_cover_for(path).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Unable to determine app data directory");
            fs::create_dir_all(&app_data_dir).expect("Unable to create app data directory");

            let db_path = app_data_dir.join("library.sqlite");
            db::init_database(&db_path).expect("Unable to initialize SQLite database");

            let socket_path = app_data_dir.join("mpv.sock");
            app.manage(AppState {
                db_path,
                player: Mutex::new(MpvController::new(socket_path)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_app,
            scan_library,
            save_settings,
            play_track,
            pause_playback,
            resume_playback,
            stop_playback,
            run_maintenance,
            remove_library_root,
            get_cover_art,
            record_play,
            get_artist_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
