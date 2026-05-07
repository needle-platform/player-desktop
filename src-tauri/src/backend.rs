use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::{
    album, artist, cover, db,
    models::{
        AppSettings, BootstrapPayload, DesktopStateImportPayload, ImportedDesktopPlaybackSession,
        LibraryData, NeedleBackendImportSummary, NeedleBackendMigrationReport,
        NeedleBackendStatus, OfflineDownloadEntry, PlaybackSession, RootPathMapping, SavedPlaylist,
    },
};

const TRACK_TOKEN_PREFIX: &str = "needle-track:";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNeedleStatusResponse {
    enabled: bool,
    mode: Option<String>,
    scanning: bool,
    roots_configured: usize,
    #[serde(default)]
    roots: Vec<RawNeedleRoot>,
    track_count: Option<usize>,
    album_count: Option<usize>,
    artist_count: Option<usize>,
    last_scan: Option<RawNeedleScan>,
}

#[derive(Debug, Deserialize)]
struct RawNeedleRoot {
    path: String,
}

#[derive(Debug, Deserialize)]
struct RawNeedleScan {
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNeedleBackendImportSummary {
    source_database_path: Option<String>,
    playlists_imported: usize,
    playlist_tracks_imported: usize,
    playlist_tracks_missing: usize,
    artist_images_imported: usize,
    artist_infos_imported: usize,
    album_infos_imported: usize,
    album_primary_genres_imported: usize,
    track_metadata_overrides_imported: usize,
    track_metadata_overrides_missing: usize,
    track_loudness_imported: usize,
    track_loudness_missing: usize,
    track_app_state_imported: usize,
    track_app_state_missing: usize,
    playback_session_imported: bool,
    playback_session_tracks_missing: usize,
}

#[derive(Debug, Deserialize)]
struct RawDesktopBootstrap {
    library: LibraryData,
    playlists: Vec<SavedPlaylist>,
    playback_session: PlaybackSession,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubsonicArtist {
    id: String,
    name: String,
    artist_image_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawArtistDetailPayload {
    artist: RawSubsonicArtist,
    info: Option<RawArtistInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawArtistInfo {
    biography: Option<String>,
    small_image_url: Option<String>,
    medium_image_url: Option<String>,
    large_image_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubsonicAlbum {
    id: String,
    name: Option<String>,
    title: Option<String>,
    album: Option<String>,
    artist: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAlbumDetailPayload {
    info: Option<RawAlbumInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAlbumInfo {
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct RawTrackGain {
    gain_db: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawFavoritePayload<'a> {
    id: &'a str,
    starred: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawRatingPayload<'a> {
    id: &'a str,
    rating: i64,
}

#[derive(Debug, Serialize)]
struct RawScrobblePayload<'a> {
    id: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawCreatePlaylistPayload<'a> {
    name: &'a str,
    song_ids: &'a [String],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNeedlePlaybackSession {
    queue_track_ids: Vec<String>,
    base_queue_track_ids: Vec<String>,
    current_index: usize,
    position_seconds: f64,
    paused: bool,
    repeat_mode: crate::models::RepeatMode,
    shuffle_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawNeedlePlaybackSessionUpdate {
    id: String,
    queue_track_ids: Vec<String>,
    base_queue_track_ids: Vec<String>,
    current_index: usize,
    position_seconds: f64,
    paused: bool,
    repeat_mode: crate::models::RepeatMode,
    shuffle_enabled: bool,
    updated_at: String,
}

pub fn is_backend_track_path(path: &str) -> bool {
    path.starts_with(TRACK_TOKEN_PREFIX)
}

pub fn backend_track_id_from_path(path: &str) -> Option<&str> {
    path.strip_prefix(TRACK_TOKEN_PREFIX).filter(|value| !value.trim().is_empty())
}

pub fn backend_mode_url(settings: &AppSettings) -> Option<String> {
    matches!(settings.library_source, crate::models::LibrarySource::NeedleBackend)
        .then(|| settings.needle_backend_url.clone())
        .flatten()
}

pub async fn fetch_backend_status(raw_url: &str) -> Result<NeedleBackendStatus> {
    let url = normalize_backend_url(raw_url)?;
    let client = http_client()?;
    let payload = get_json::<RawNeedleStatusResponse>(&client, &url, "/api/needle/status")
        .await
        .with_context(|| format!("Unable to reach Needle backend at {url}"))?;

    Ok(NeedleBackendStatus {
        url,
        reachable: true,
        enabled: payload.enabled,
        mode: payload.mode,
        scanning: payload.scanning,
        roots_configured: payload.roots_configured,
        configured_roots: payload.roots.into_iter().map(|root| root.path).collect(),
        track_count: payload.track_count,
        album_count: payload.album_count,
        artist_count: payload.artist_count,
        last_scan_status: payload.last_scan.and_then(|scan| scan.status),
        error: None,
    })
}

pub async fn load_backend_bootstrap(settings: AppSettings) -> Result<BootstrapPayload> {
    let url = backend_mode_url(&settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let status = fetch_backend_status(&url).await?;
    if !status.enabled {
        bail!("The configured Needle backend is not enabled for local library mode");
    }

    let client = http_client()?;
    let mut payload = get_json::<RawDesktopBootstrap>(&client, &status.url, "/api/needle/desktop/bootstrap").await?;
    normalize_backend_bootstrap(&mut payload);

    Ok(BootstrapPayload {
        settings,
        library: payload.library,
        playlists: payload.playlists,
        playback_session: payload.playback_session,
    })
}

pub async fn migrate_desktop_state_to_backend(
    db_path: &Path,
    raw_url: &str,
) -> Result<NeedleBackendMigrationReport> {
    let status = fetch_backend_status(raw_url).await?;
    if !status.enabled {
        bail!("The configured Needle backend is not enabled for local library mode");
    }

    let root_mappings = infer_root_mappings(&db::list_library_roots(db_path)?, &status.configured_roots);
    let local_roots = db::list_library_roots(db_path)?;
    let unmapped_roots = local_roots
        .into_iter()
        .filter(|root| {
            !root_mappings
                .iter()
                .any(|mapping| normalize_path(&mapping.source_prefix) == normalize_path(root))
        })
        .collect::<Vec<_>>();

    let payload = build_import_payload(db_path, &root_mappings)?;
    let client = http_client()?;
    let response = client
        .post(format!("{}/api/needle/import/desktop-state", status.url))
        .json(&payload)
        .send()
        .await
        .with_context(|| format!("Unable to send desktop state to {}", status.url))?;

    if !response.status().is_success() {
        let status_code = response.status();
        let message = response.text().await.unwrap_or_default();
        bail!(
            "Needle backend import failed with {}{}",
            status_code,
            if message.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", message.trim())
            }
        );
    }

    let summary = response
        .json::<RawNeedleBackendImportSummary>()
        .await
        .context("Needle backend returned an unreadable import summary")?;

    Ok(NeedleBackendMigrationReport {
        backend_status: status,
        root_mappings,
        unmapped_roots,
        import_summary: NeedleBackendImportSummary {
            source_database_path: summary.source_database_path,
            playlists_imported: summary.playlists_imported,
            playlist_tracks_imported: summary.playlist_tracks_imported,
            playlist_tracks_missing: summary.playlist_tracks_missing,
            artist_images_imported: summary.artist_images_imported,
            artist_infos_imported: summary.artist_infos_imported,
            album_infos_imported: summary.album_infos_imported,
            album_primary_genres_imported: summary.album_primary_genres_imported,
            track_metadata_overrides_imported: summary.track_metadata_overrides_imported,
            track_metadata_overrides_missing: summary.track_metadata_overrides_missing,
            track_loudness_imported: summary.track_loudness_imported,
            track_loudness_missing: summary.track_loudness_missing,
            track_app_state_imported: summary.track_app_state_imported,
            track_app_state_missing: summary.track_app_state_missing,
            playback_session_imported: summary.playback_session_imported,
            playback_session_tracks_missing: summary.playback_session_tracks_missing,
        },
    })
}

pub async fn save_backend_playback_session(
    settings: &AppSettings,
    session: &PlaybackSession,
) -> Result<PlaybackSession> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let client = http_client()?;
    let update = RawNeedlePlaybackSessionUpdate {
        id: "shared".to_string(),
        queue_track_ids: session
            .queue_paths
            .iter()
            .filter_map(|path| backend_track_id_from_path(path).map(str::to_string))
            .collect(),
        base_queue_track_ids: session
            .base_queue_paths
            .iter()
            .filter_map(|path| backend_track_id_from_path(path).map(str::to_string))
            .collect(),
        current_index: session.current_index,
        position_seconds: session.position_seconds.max(0.0),
        paused: session.paused,
        repeat_mode: session.repeat_mode.clone(),
        shuffle_enabled: session.shuffle_enabled,
        updated_at: chrono_like_timestamp(),
    };

    let raw = put_json::<RawNeedlePlaybackSession, _>(&client, &url, "/api/needle/playback-session", &update).await?;
    Ok(map_remote_playback_session(raw))
}

pub async fn set_backend_track_favorite(
    settings: &AppSettings,
    track_path: &str,
    favorite: bool,
) -> Result<BootstrapPayload> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let track_id = backend_track_id_from_path(track_path).ok_or_else(|| anyhow!("Invalid backend track reference"))?;
    let client = http_client()?;
    post_json_expect_empty(&client, &url, "/api/tracks/favorite", &RawFavoritePayload { id: track_id, starred: favorite }).await?;
    load_backend_bootstrap(settings.clone()).await
}

pub async fn set_backend_track_rating(
    settings: &AppSettings,
    track_path: &str,
    rating: Option<i64>,
) -> Result<BootstrapPayload> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let track_id = backend_track_id_from_path(track_path).ok_or_else(|| anyhow!("Invalid backend track reference"))?;
    let client = http_client()?;
    let normalized_rating = rating.unwrap_or(0).clamp(0, 5);
    post_json_expect_empty(&client, &url, "/api/tracks/rating", &RawRatingPayload { id: track_id, rating: normalized_rating }).await?;
    load_backend_bootstrap(settings.clone()).await
}

pub async fn create_backend_playlist(
    settings: &AppSettings,
    name: &str,
    track_paths: &[String],
) -> Result<BootstrapPayload> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let client = http_client()?;
    let song_ids = track_paths
        .iter()
        .filter_map(|path| backend_track_id_from_path(path).map(str::to_string))
        .collect::<Vec<_>>();
    post_json::<Vec<serde_json::Value>, _>(&client, &url, "/api/playlists", &RawCreatePlaylistPayload { name, song_ids: &song_ids }).await?;
    load_backend_bootstrap(settings.clone()).await
}

pub async fn record_backend_play(settings: &AppSettings, track_path: &str) -> Result<()> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let track_id = backend_track_id_from_path(track_path).ok_or_else(|| anyhow!("Invalid backend track reference"))?;
    let client = http_client()?;
    post_json_expect_empty(&client, &url, "/api/scrobble", &RawScrobblePayload { id: track_id }).await
}

pub async fn get_backend_track_gain(settings: &AppSettings, track_path: &str) -> Result<Option<f32>> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let track_id = backend_track_id_from_path(track_path).ok_or_else(|| anyhow!("Invalid backend track reference"))?;
    let client = http_client()?;
    get_json_optional::<RawTrackGain>(&client, &url, &format!("/api/needle/desktop/track-gain/{track_id}"))
        .await
        .map(|payload| payload.map(|value| value.gain_db))
}

pub async fn get_backend_cover_art(settings: &AppSettings, track_path: &str) -> Result<Option<cover::CoverArt>> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let track_id = backend_track_id_from_path(track_path).ok_or_else(|| anyhow!("Invalid backend track reference"))?;
    let client = http_client()?;
    let response = client
        .get(format!("{url}/api/cover-art/{track_id}"))
        .send()
        .await
        .with_context(|| format!("Unable to load cover art from {url}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    if !response.status().is_success() {
        let status_code = response.status();
        let message = response.text().await.unwrap_or_default();
        bail!(
            "Needle backend cover-art request failed with {}{}",
            status_code,
            if message.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", message.trim())
            }
        );
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = response.bytes().await.context("Unable to read cover-art bytes")?;
    Ok(Some(cover::CoverArt {
        data_url: format!("data:{};base64,{}", mime, BASE64.encode(bytes)),
        source: "backend".into(),
    }))
}

pub async fn get_backend_artist_image(
    settings: &AppSettings,
    name: &str,
) -> Result<Option<artist::ArtistImage>> {
    let detail = find_backend_artist_detail(settings, name).await?;
    Ok(detail.and_then(|payload| {
        payload
            .artist
            .artist_image_url
            .or_else(|| payload.info.as_ref().and_then(|info| info.medium_image_url.clone()))
            .map(|url| artist::ArtistImage {
                url,
                source: "backend".into(),
            })
    }))
}

pub async fn get_backend_artist_info(
    settings: &AppSettings,
    name: &str,
) -> Result<Option<artist::ArtistInfo>> {
    let detail = find_backend_artist_detail(settings, name).await?;
    Ok(detail.and_then(|payload| {
        payload.info.map(|info| artist::ArtistInfo {
            description: info.biography,
            source_url: None,
            gender: None,
            source: "backend".into(),
        })
    }))
}

pub async fn get_backend_album_info(
    settings: &AppSettings,
    album_name: &str,
    artist_name: Option<&str>,
) -> Result<Option<album::AlbumInfo>> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let client = http_client()?;
    let albums = get_json::<Vec<RawSubsonicAlbum>>(&client, &url, "/api/albums").await?;
    let target = albums.into_iter().find(|album| album_matches(album, album_name, artist_name));
    let Some(album_summary) = target else {
        return Ok(None);
    };

    let detail = get_json::<RawAlbumDetailPayload>(&client, &url, &format!("/api/album/{}", album_summary.id)).await?;
    Ok(detail.info.map(|info| album::AlbumInfo {
        description: info.notes,
        source_url: None,
        source: "backend".into(),
    }))
}

pub fn backend_stream_url(settings: &AppSettings, track_path: &str) -> Result<String> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let track_id = backend_track_id_from_path(track_path).ok_or_else(|| anyhow!("Invalid backend track reference"))?;
    Ok(format!("{url}/api/stream/{track_id}?maxBitRate=320"))
}

pub async fn download_backend_track(
    settings: &AppSettings,
    track_path: &str,
    destination_dir: &Path,
) -> Result<OfflineDownloadEntry> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let track_id = backend_track_id_from_path(track_path).ok_or_else(|| anyhow!("Invalid backend track reference"))?;
    let client = http_client()?;
    let response = client
        .get(format!("{url}/api/stream/{track_id}"))
        .send()
        .await
        .with_context(|| format!("Unable to download track data from {url}"))?;

    if !response.status().is_success() {
        let status_code = response.status();
        let message = response.text().await.unwrap_or_default();
        bail!(
            "Needle backend download request failed with {}{}",
            status_code,
            if message.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", message.trim())
            }
        );
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let extension = extension_from_content_type(content_type.as_deref()).unwrap_or("audio");
    let bytes = response
        .bytes()
        .await
        .context("Unable to read downloaded track bytes from Needle backend")?;

    std::fs::create_dir_all(destination_dir).with_context(|| {
        format!(
            "Unable to create offline cache directory at {}",
            destination_dir.display()
        )
    })?;

    let final_path = destination_dir.join(format!("{track_id}.{extension}"));
    let temp_path = destination_dir.join(format!("{track_id}.{extension}.part"));
    std::fs::write(&temp_path, &bytes).with_context(|| {
        format!(
            "Unable to write offline track data to {}",
            temp_path.display()
        )
    })?;
    std::fs::rename(&temp_path, &final_path).with_context(|| {
        format!(
            "Unable to finalize offline track at {}",
            final_path.display()
        )
    })?;

    Ok(OfflineDownloadEntry {
        track_path: track_path.to_string(),
        local_path: final_path.to_string_lossy().to_string(),
        content_type,
        file_size: Some(bytes.len() as u64),
        downloaded_at: chrono_like_timestamp(),
    })
}

fn build_import_payload(db_path: &Path, root_mappings: &[RootPathMapping]) -> Result<DesktopStateImportPayload> {
    Ok(DesktopStateImportPayload {
        source_database_path: Some(db_path.display().to_string()),
        root_mappings: root_mappings.to_vec(),
        playlists: db::export_playlists_for_backend(db_path)?,
        artist_images: db::list_artist_images_for_backend(db_path)?,
        artist_infos: db::list_artist_info_for_backend(db_path)?,
        album_infos: db::list_album_info_for_backend(db_path)?,
        album_primary_genres: db::list_album_primary_genres_for_backend(db_path)?,
        track_metadata_overrides: db::list_track_metadata_overrides_for_backend(db_path)?,
        track_loudness: db::list_track_loudness_for_backend(db_path)?,
        track_app_state: db::list_track_app_state_for_backend(db_path)?,
        playback_session: Some(export_playback_session(
            db::load_playback_session(db_path)?,
            db::current_timestamp(db_path)?,
        )),
    })
}

fn export_playback_session(
    session: PlaybackSession,
    updated_at: String,
) -> ImportedDesktopPlaybackSession {
    ImportedDesktopPlaybackSession {
        queue_paths: session.queue_paths,
        base_queue_paths: session.base_queue_paths,
        current_index: session.current_index,
        position_seconds: session.position_seconds,
        paused: session.paused,
        repeat_mode: session.repeat_mode,
        shuffle_enabled: session.shuffle_enabled,
        updated_at,
    }
}

fn infer_root_mappings(local_roots: &[String], backend_roots: &[String]) -> Vec<RootPathMapping> {
    local_roots
        .iter()
        .filter_map(|local_root| {
            match_backend_root(local_root, backend_roots).map(|backend_root| RootPathMapping {
                source_prefix: local_root.clone(),
                target_prefix: backend_root,
            })
        })
        .collect()
}

fn match_backend_root(local_root: &str, backend_roots: &[String]) -> Option<String> {
    let normalized_local = normalize_path(local_root);

    if let Some(exact) = backend_roots
        .iter()
        .find(|candidate| normalize_path(candidate) == normalized_local)
    {
        return Some(exact.clone());
    }

    let local_name = Path::new(local_root).file_name()?.to_string_lossy().to_string();
    let mut candidates = backend_roots
        .iter()
        .filter(|candidate| {
            Path::new(candidate)
                .file_name()
                .map(|name| name.to_string_lossy().eq_ignore_ascii_case(&local_name))
                .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<_>>();

    if candidates.len() == 1 {
        return candidates.pop();
    }

    None
}

fn normalize_backend_url(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("Needle backend URL is required");
    }

    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };

    let parsed = reqwest::Url::parse(&with_scheme)
        .with_context(|| format!("Invalid Needle backend URL: {trimmed}"))?;
    let mut normalized = parsed.to_string();
    while normalized.ends_with('/') {
        normalized.pop();
    }
    Ok(normalized)
}

fn normalize_path(value: &str) -> PathBuf {
    PathBuf::from(value)
}

fn http_client() -> Result<Client> {
    reqwest::Client::builder()
        .user_agent("NeedleDesktop/0.1")
        .build()
        .map_err(|error| anyhow!("Unable to create Needle backend HTTP client: {error}"))
}

async fn get_json<T: DeserializeOwned>(client: &Client, base_url: &str, route: &str) -> Result<T> {
    let response = client
        .get(format!("{base_url}{route}"))
        .send()
        .await
        .with_context(|| format!("Unable to reach Needle backend route {route}"))?;

    decode_json_response(response, route).await
}

async fn get_json_optional<T: DeserializeOwned>(client: &Client, base_url: &str, route: &str) -> Result<Option<T>> {
    let response = client
        .get(format!("{base_url}{route}"))
        .send()
        .await
        .with_context(|| format!("Unable to reach Needle backend route {route}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    decode_json_response(response, route).await.map(Some)
}

async fn post_json<T: DeserializeOwned, B: Serialize>(
    client: &Client,
    base_url: &str,
    route: &str,
    body: &B,
) -> Result<T> {
    let response = client
        .post(format!("{base_url}{route}"))
        .json(body)
        .send()
        .await
        .with_context(|| format!("Unable to reach Needle backend route {route}"))?;

    decode_json_response(response, route).await
}

async fn put_json<T: DeserializeOwned, B: Serialize>(
    client: &Client,
    base_url: &str,
    route: &str,
    body: &B,
) -> Result<T> {
    let response = client
        .put(format!("{base_url}{route}"))
        .json(body)
        .send()
        .await
        .with_context(|| format!("Unable to reach Needle backend route {route}"))?;

    decode_json_response(response, route).await
}

async fn post_json_expect_empty<B: Serialize>(
    client: &Client,
    base_url: &str,
    route: &str,
    body: &B,
) -> Result<()> {
    let response = client
        .post(format!("{base_url}{route}"))
        .json(body)
        .send()
        .await
        .with_context(|| format!("Unable to reach Needle backend route {route}"))?;

    if !response.status().is_success() {
        let status_code = response.status();
        let message = response.text().await.unwrap_or_default();
        bail!(
            "Needle backend request to {route} failed with {}{}",
            status_code,
            if message.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", message.trim())
            }
        );
    }

    Ok(())
}

async fn decode_json_response<T: DeserializeOwned>(response: reqwest::Response, route: &str) -> Result<T> {
    if !response.status().is_success() {
        let status_code = response.status();
        let message = response.text().await.unwrap_or_default();
        bail!(
            "Needle backend request to {route} failed with {}{}",
            status_code,
            if message.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", message.trim())
            }
        );
    }

    response
        .json::<T>()
        .await
        .with_context(|| format!("Needle backend returned unreadable JSON for {route}"))
}

async fn find_backend_artist_detail(settings: &AppSettings, name: &str) -> Result<Option<RawArtistDetailPayload>> {
    let url = backend_mode_url(settings).ok_or_else(|| anyhow!("Needle backend URL is not configured"))?;
    let client = http_client()?;
    let artists = get_json::<Vec<RawSubsonicArtist>>(&client, &url, "/api/artists").await?;
    let Some(artist) = artists
        .into_iter()
        .find(|artist| artist.name.trim().eq_ignore_ascii_case(name.trim()))
    else {
        return Ok(None);
    };

    get_json_optional::<RawArtistDetailPayload>(&client, &url, &format!("/api/artist/{}", artist.id)).await
}

fn normalize_backend_bootstrap(payload: &mut RawDesktopBootstrap) {
    payload.library.tracks.sort_by(|left, right| left.path.cmp(&right.path));
    payload.playback_session = normalize_backend_playback_session(&payload.playback_session);
}

fn normalize_backend_playback_session(session: &PlaybackSession) -> PlaybackSession {
    PlaybackSession {
        queue_paths: session.queue_paths.clone(),
        base_queue_paths: if session.base_queue_paths.is_empty() {
            session.queue_paths.clone()
        } else {
            session.base_queue_paths.clone()
        },
        current_index: session.current_index.min(session.queue_paths.len().saturating_sub(1)),
        position_seconds: session.position_seconds.max(0.0),
        paused: session.paused,
        repeat_mode: session.repeat_mode.clone(),
        shuffle_enabled: session.shuffle_enabled,
    }
}

fn map_remote_playback_session(session: RawNeedlePlaybackSession) -> PlaybackSession {
    normalize_backend_playback_session(&PlaybackSession {
        queue_paths: session
            .queue_track_ids
            .into_iter()
            .map(|track_id| format!("{TRACK_TOKEN_PREFIX}{track_id}"))
            .collect(),
        base_queue_paths: session
            .base_queue_track_ids
            .into_iter()
            .map(|track_id| format!("{TRACK_TOKEN_PREFIX}{track_id}"))
            .collect(),
        current_index: session.current_index,
        position_seconds: session.position_seconds,
        paused: session.paused,
        repeat_mode: session.repeat_mode,
        shuffle_enabled: session.shuffle_enabled,
    })
}

fn album_matches(album: &RawSubsonicAlbum, target_album: &str, target_artist: Option<&str>) -> bool {
    let name = album
        .name
        .as_deref()
        .or(album.title.as_deref())
        .or(album.album.as_deref())
        .unwrap_or("")
        .trim();
    if !name.eq_ignore_ascii_case(target_album.trim()) {
        return false;
    }

    match target_artist.map(str::trim).filter(|value| !value.is_empty()) {
        Some(artist_name) => album
            .artist
            .as_deref()
            .map(|value| value.trim().eq_ignore_ascii_case(artist_name))
            .unwrap_or(false),
        None => true,
    }
}

fn extension_from_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let normalized = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "audio/mpeg" => Some("mp3"),
        "audio/flac" => Some("flac"),
        "audio/x-flac" => Some("flac"),
        "audio/wav" => Some("wav"),
        "audio/x-wav" => Some("wav"),
        "audio/mp4" => Some("m4a"),
        "audio/aac" => Some("aac"),
        "audio/ogg" => Some("ogg"),
        "audio/opus" => Some("opus"),
        "audio/x-aiff" => Some("aiff"),
        "audio/aiff" => Some("aiff"),
        _ => None,
    }
}

fn chrono_like_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
