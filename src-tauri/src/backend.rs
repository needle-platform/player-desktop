use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use reqwest::Client;
use serde::Deserialize;

use crate::{
    db,
    models::{
        DesktopStateImportPayload, ImportedDesktopPlaybackSession, NeedleBackendImportSummary,
        NeedleBackendMigrationReport, NeedleBackendStatus, PlaybackSession, RootPathMapping,
    },
};

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

pub async fn fetch_backend_status(raw_url: &str) -> Result<NeedleBackendStatus> {
    let url = normalize_backend_url(raw_url)?;
    let client = http_client()?;
    let response = client
        .get(format!("{url}/api/needle/status"))
        .send()
        .await
        .with_context(|| format!("Unable to reach Needle backend at {url}"))?;

    if !response.status().is_success() {
        let status_code = response.status();
        let message = response.text().await.unwrap_or_default();
        bail!(
            "Needle backend status request failed with {}{}",
            status_code,
            if message.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", message.trim())
            }
        );
    }

    let payload = response
        .json::<RawNeedleStatusResponse>()
        .await
        .context("Needle backend returned an unreadable status response")?;

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
