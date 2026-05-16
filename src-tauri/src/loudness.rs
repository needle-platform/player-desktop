use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread,
    time::UNIX_EPOCH,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::{
    backend,
    db::{
        self, BackendTrackLoudnessAnalysisRecord, TrackLoudnessAnalysisCandidate,
        TrackLoudnessAnalysisRecord,
    },
    models::{AppSettings, OfflineDownloadEntry, Track},
};

const FFMPEG_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    "ffmpeg",
];
pub const LOUDNESS_ANALYSIS_VERSION: i64 = 2;
const TARGET_LOUDNESS_LUFS: f32 = -20.0;
const TRUE_PEAK_LIMIT_DB: f32 = -1.0;
const MAX_NEGATIVE_GAIN_DB: f32 = -24.0;
const MAX_POSITIVE_GAIN_DB: f32 = 2.0;
const LOUDNESS_ANALYSIS_WORKERS: usize = 2;

#[derive(Debug, Default)]
pub struct LoudnessAnalysisSummary {
    pub analyzed_tracks: usize,
    pub unchanged_tracks: usize,
    pub missing_tracks: usize,
    pub failed_tracks: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoudnessAnalysisProgress {
    pub total_tracks: usize,
    pub processed_tracks: usize,
    pub analyzed_tracks: usize,
    pub unchanged_tracks: usize,
    pub missing_tracks: usize,
    pub failed_tracks: usize,
    pub failed_path: Option<String>,
    pub failed_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoudnormStats {
    input_i: String,
    input_tp: String,
}

enum CandidateAnalysisResult {
    Missing {
        path: String,
    },
    Unchanged,
    Analyzed {
        filename: String,
        record: TrackLoudnessAnalysisRecord,
    },
    Failed {
        path: String,
        reason: String,
    },
}

struct BackendTrackLoudnessAnalysisCandidate {
    track_path: String,
    title: String,
    analysis_input: String,
    source_fingerprint: String,
    cached_source_fingerprint: Option<String>,
    cached_analysis_version: Option<i64>,
}

enum BackendCandidateAnalysisResult {
    Unchanged,
    Analyzed {
        title: String,
        record: BackendTrackLoudnessAnalysisRecord,
    },
    Failed {
        path: String,
        reason: String,
    },
}

#[derive(Debug, Default)]
struct LoudnessCacheState {
    cached_tracks: usize,
    missing_cache_tracks: usize,
    stale_version_tracks: usize,
}

pub fn analyze_library<F, G>(
    db_path: &Path,
    mut emit_log: F,
    mut emit_progress: G,
) -> Result<LoudnessAnalysisSummary>
where
    F: FnMut(String),
    G: FnMut(LoudnessAnalysisProgress),
{
    let ffmpeg = resolve_ffmpeg_binary()
        .context("FFmpeg was not found. Install it with `brew install ffmpeg` and try again.")?;
    let candidates = db::list_tracks_for_loudness_analysis(db_path)?;
    let total_tracks = candidates.len();
    let cache_state = summarize_cache_state(&candidates);
    let mut summary = LoudnessAnalysisSummary::default();

    emit_log(format!(
        "Starting loudness analysis for {} track{} using {} with {} worker{}.",
        total_tracks,
        if total_tracks == 1 { "" } else { "s" },
        ffmpeg.display(),
        LOUDNESS_ANALYSIS_WORKERS.min(total_tracks.max(1)),
        if LOUDNESS_ANALYSIS_WORKERS.min(total_tracks.max(1)) == 1 {
            ""
        } else {
            "s"
        }
    ));
    if cache_state.stale_version_tracks > 0 {
        let cached_tracks = cache_state.cached_tracks;
        let refreshed_tracks = cache_state.stale_version_tracks;
        if refreshed_tracks == cached_tracks {
            emit_log(format!(
                "Refreshing all {} cached loudness result{} because this build uses analysis v{} and the saved results came from an older loudness-analysis pass.",
                cached_tracks,
                if cached_tracks == 1 { "" } else { "s" },
                LOUDNESS_ANALYSIS_VERSION
            ));
        } else {
            emit_log(format!(
                "Refreshing {} cached loudness result{} because this build uses analysis v{} and those saved results came from an older loudness-analysis pass.",
                refreshed_tracks,
                if refreshed_tracks == 1 { "" } else { "s" },
                LOUDNESS_ANALYSIS_VERSION
            ));
        }
    }
    if cache_state.missing_cache_tracks > 0 {
        emit_log(format!(
            "{} track{} {} no cached loudness data yet and will be analyzed for the first time.",
            cache_state.missing_cache_tracks,
            if cache_state.missing_cache_tracks == 1 {
                ""
            } else {
                "s"
            },
            if cache_state.missing_cache_tracks == 1 {
                "has"
            } else {
                "have"
            }
        ));
    }
    emit_progress(build_progress_event(total_tracks, 0, &summary, None, None));

    if total_tracks == 0 {
        db::record_loudness_analysis_run(db_path)?;
        emit_log("No tracks are in the library yet, so there was nothing to analyze.".to_string());
        return Ok(LoudnessAnalysisSummary::default());
    }

    let mut records = Vec::new();
    let worker_count = LOUDNESS_ANALYSIS_WORKERS.min(total_tracks.max(1));
    let candidates = Arc::new(candidates);
    let next_index = Arc::new(AtomicUsize::new(0));
    let (sender, receiver) = mpsc::channel::<CandidateAnalysisResult>();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let sender = sender.clone();
            let candidates = Arc::clone(&candidates);
            let next_index = Arc::clone(&next_index);
            let ffmpeg = ffmpeg.clone();

            scope.spawn(move || loop {
                let index = next_index.fetch_add(1, Ordering::Relaxed);
                if index >= candidates.len() {
                    break;
                }

                let result = analyze_candidate(&ffmpeg, &candidates[index]);
                if sender.send(result).is_err() {
                    break;
                }
            });
        }

        drop(sender);

        for processed_tracks in 1..=total_tracks {
            let result = match receiver.recv() {
                Ok(result) => result,
                Err(_) => break,
            };

            match result {
                CandidateAnalysisResult::Missing { path } => {
                    summary.missing_tracks += 1;
                    emit_log(format!(
                        "Skipped missing file {}/{}: {}",
                        processed_tracks, total_tracks, path
                    ));
                    emit_progress(build_progress_event(
                        total_tracks,
                        processed_tracks,
                        &summary,
                        None,
                        None,
                    ));
                }
                CandidateAnalysisResult::Unchanged => {
                    summary.unchanged_tracks += 1;
                    if processed_tracks % 250 == 0 {
                        emit_log(format!(
                            "Checked {}/{} tracks. {} already had fresh loudness data.",
                            processed_tracks, total_tracks, summary.unchanged_tracks
                        ));
                    }
                    emit_progress(build_progress_event(
                        total_tracks,
                        processed_tracks,
                        &summary,
                        None,
                        None,
                    ));
                }
                CandidateAnalysisResult::Analyzed { filename, record } => {
                    summary.analyzed_tracks += 1;
                    emit_log(format!(
                        "Analyzed {} track{} so far. Last: {} ({:+.1} dB).",
                        summary.analyzed_tracks,
                        if summary.analyzed_tracks == 1 {
                            ""
                        } else {
                            "s"
                        },
                        filename,
                        record.target_gain_db
                    ));
                    records.push(record);
                    emit_progress(build_progress_event(
                        total_tracks,
                        processed_tracks,
                        &summary,
                        None,
                        None,
                    ));
                }
                CandidateAnalysisResult::Failed { path, reason } => {
                    summary.failed_tracks += 1;
                    emit_log(format!(
                        "Failed to analyze {}/{}: {} ({})",
                        processed_tracks, total_tracks, path, reason
                    ));
                    emit_progress(build_progress_event(
                        total_tracks,
                        processed_tracks,
                        &summary,
                        Some(path),
                        Some(reason),
                    ));
                }
            }
        }
    });

    db::save_track_loudness_records(db_path, &records)?;
    db::record_loudness_analysis_run(db_path)?;

    emit_log(format!(
        "Loudness analysis finished. {} analyzed, {} already fresh, {} missing, {} failed.",
        summary.analyzed_tracks,
        summary.unchanged_tracks,
        summary.missing_tracks,
        summary.failed_tracks
    ));
    emit_progress(build_progress_event(
        total_tracks,
        total_tracks,
        &summary,
        None,
        None,
    ));

    Ok(summary)
}

pub fn analyze_backend_library<F, G>(
    db_path: &Path,
    settings: &AppSettings,
    tracks: &[Track],
    offline_downloads: &[OfflineDownloadEntry],
    mut emit_log: F,
    mut emit_progress: G,
) -> Result<LoudnessAnalysisSummary>
where
    F: FnMut(String),
    G: FnMut(LoudnessAnalysisProgress),
{
    let ffmpeg = resolve_ffmpeg_binary()
        .context("FFmpeg was not found. Install it with `brew install ffmpeg` and try again.")?;
    let candidates = build_backend_candidates(db_path, settings, tracks, offline_downloads)?;
    let total_tracks = candidates.len();
    let cache_state = summarize_backend_cache_state(&candidates);
    let mut summary = LoudnessAnalysisSummary::default();
    let offline_tracks = candidates
        .iter()
        .filter(|candidate| Path::new(&candidate.analysis_input).exists())
        .count();
    let streamed_tracks = total_tracks.saturating_sub(offline_tracks);
    let streamed_tracks_label = if streamed_tracks == 1 {
        "1 track".to_string()
    } else {
        format!("{streamed_tracks} tracks")
    };

    emit_log(format!(
        "Starting backend loudness analysis for {} track{} using {} with {} worker{}.",
        total_tracks,
        if total_tracks == 1 { "" } else { "s" },
        ffmpeg.display(),
        analysis_worker_count(total_tracks),
        if analysis_worker_count(total_tracks) == 1 {
            ""
        } else {
            "s"
        }
    ));
    if offline_tracks > 0 || streamed_tracks > 0 {
        emit_log(format!(
            "{} track{} will use offline files and {} will stream from the Needle backend.",
            offline_tracks,
            if offline_tracks == 1 { "" } else { "s" },
            streamed_tracks_label
        ));
    }
    if cache_state.stale_version_tracks > 0 {
        let cached_tracks = cache_state.cached_tracks;
        let refreshed_tracks = cache_state.stale_version_tracks;
        if refreshed_tracks == cached_tracks {
            emit_log(format!(
                "Refreshing all {} cached backend loudness result{} because this build uses analysis v{} and the saved results came from an older loudness-analysis pass.",
                cached_tracks,
                if cached_tracks == 1 { "" } else { "s" },
                LOUDNESS_ANALYSIS_VERSION
            ));
        } else {
            emit_log(format!(
                "Refreshing {} cached backend loudness result{} because this build uses analysis v{} and those saved results came from an older loudness-analysis pass.",
                refreshed_tracks,
                if refreshed_tracks == 1 { "" } else { "s" },
                LOUDNESS_ANALYSIS_VERSION
            ));
        }
    }
    if cache_state.missing_cache_tracks > 0 {
        emit_log(format!(
            "{} backend track{} need fresh loudness data and will be analyzed in this pass.",
            cache_state.missing_cache_tracks,
            if cache_state.missing_cache_tracks == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    emit_progress(build_progress_event(total_tracks, 0, &summary, None, None));

    if total_tracks == 0 {
        db::record_loudness_analysis_run(db_path)?;
        emit_log(
            "No backend tracks are available yet, so there was nothing to analyze.".to_string(),
        );
        return Ok(LoudnessAnalysisSummary::default());
    }

    let mut records = Vec::new();
    let worker_count = analysis_worker_count(total_tracks);
    let candidates = std::sync::Arc::new(candidates);
    let next_index = std::sync::Arc::new(AtomicUsize::new(0));
    let (sender, receiver) = mpsc::channel::<BackendCandidateAnalysisResult>();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let sender = sender.clone();
            let candidates = std::sync::Arc::clone(&candidates);
            let next_index = std::sync::Arc::clone(&next_index);
            let ffmpeg = ffmpeg.clone();

            scope.spawn(move || loop {
                let index = next_index.fetch_add(1, Ordering::Relaxed);
                if index >= candidates.len() {
                    break;
                }

                let result = analyze_backend_candidate(&ffmpeg, &candidates[index]);
                if sender.send(result).is_err() {
                    break;
                }
            });
        }

        drop(sender);

        for processed_tracks in 1..=total_tracks {
            let result = match receiver.recv() {
                Ok(result) => result,
                Err(_) => break,
            };

            match result {
                BackendCandidateAnalysisResult::Unchanged => {
                    summary.unchanged_tracks += 1;
                    if processed_tracks % 250 == 0 {
                        emit_log(format!(
                            "Checked {}/{} backend tracks. {} already had fresh loudness data.",
                            processed_tracks, total_tracks, summary.unchanged_tracks
                        ));
                    }
                    emit_progress(build_progress_event(
                        total_tracks,
                        processed_tracks,
                        &summary,
                        None,
                        None,
                    ));
                }
                BackendCandidateAnalysisResult::Analyzed { title, record } => {
                    summary.analyzed_tracks += 1;
                    emit_log(format!(
                        "Analyzed {} backend track{} so far. Last: {} ({:+.1} dB).",
                        summary.analyzed_tracks,
                        if summary.analyzed_tracks == 1 {
                            ""
                        } else {
                            "s"
                        },
                        title,
                        record.target_gain_db
                    ));
                    records.push(record);
                    emit_progress(build_progress_event(
                        total_tracks,
                        processed_tracks,
                        &summary,
                        None,
                        None,
                    ));
                }
                BackendCandidateAnalysisResult::Failed { path, reason } => {
                    summary.failed_tracks += 1;
                    emit_log(format!(
                        "Failed to analyze backend track {}/{}: {} ({})",
                        processed_tracks, total_tracks, path, reason
                    ));
                    emit_progress(build_progress_event(
                        total_tracks,
                        processed_tracks,
                        &summary,
                        Some(path),
                        Some(reason),
                    ));
                }
            }
        }
    });

    db::save_backend_track_loudness_records(db_path, &records)?;
    db::record_loudness_analysis_run(db_path)?;

    emit_log(format!(
        "Backend loudness analysis finished. {} analyzed, {} already fresh, {} missing, {} failed.",
        summary.analyzed_tracks,
        summary.unchanged_tracks,
        summary.missing_tracks,
        summary.failed_tracks
    ));
    emit_progress(build_progress_event(
        total_tracks,
        total_tracks,
        &summary,
        None,
        None,
    ));

    Ok(summary)
}

pub fn analysis_version() -> i64 {
    LOUDNESS_ANALYSIS_VERSION
}

fn summarize_cache_state(candidates: &[TrackLoudnessAnalysisCandidate]) -> LoudnessCacheState {
    let mut state = LoudnessCacheState::default();

    for candidate in candidates {
        match candidate.cached_analysis_version {
            Some(version) => {
                state.cached_tracks += 1;
                if version != LOUDNESS_ANALYSIS_VERSION {
                    state.stale_version_tracks += 1;
                }
            }
            None => state.missing_cache_tracks += 1,
        }
    }

    state
}

fn summarize_backend_cache_state(
    candidates: &[BackendTrackLoudnessAnalysisCandidate],
) -> LoudnessCacheState {
    let mut state = LoudnessCacheState::default();

    for candidate in candidates {
        match candidate.cached_analysis_version {
            Some(version) => {
                state.cached_tracks += 1;
                if version != LOUDNESS_ANALYSIS_VERSION {
                    state.stale_version_tracks += 1;
                } else if candidate
                    .cached_source_fingerprint
                    .as_deref()
                    .map(|value| normalize_backend_source_fingerprint(&candidate.track_path, value))
                    .as_deref()
                    != Some(candidate.source_fingerprint.as_str())
                {
                    state.missing_cache_tracks += 1;
                }
            }
            None => state.missing_cache_tracks += 1,
        }
    }

    state
}

fn build_backend_candidates(
    db_path: &Path,
    settings: &AppSettings,
    tracks: &[Track],
    offline_downloads: &[OfflineDownloadEntry],
) -> Result<Vec<BackendTrackLoudnessAnalysisCandidate>> {
    let cache_entries = db::list_backend_track_loudness_cache(db_path)?
        .into_iter()
        .map(|entry| (entry.track_path.clone(), entry))
        .collect::<HashMap<_, _>>();
    let offline_by_track_path = offline_downloads
        .iter()
        .map(|entry| (entry.track_path.as_str(), entry))
        .collect::<HashMap<_, _>>();

    tracks
        .iter()
        .map(|track| {
            let (analysis_input, source_fingerprint) =
                if let Some(download) = offline_by_track_path.get(track.path.as_str()) {
                    let path = Path::new(&download.local_path);
                    if path.exists() {
                        let metadata = fs::metadata(path).with_context(|| {
                            format!(
                                "Unable to read offline download metadata for {}",
                                path.display()
                            )
                        })?;
                        let file_modified_at = metadata
                            .modified()
                            .ok()
                            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                            .map(|value| value.as_secs() as i64)
                            .unwrap_or_default();
                        (
                            download.local_path.clone(),
                            canonical_offline_source_fingerprint(
                                &track.path,
                                metadata.len(),
                                file_modified_at,
                            ),
                        )
                    } else {
                        let stream_url = backend::backend_stream_url(settings, &track.path)?;
                        (
                            backend::backend_analysis_stream_url(settings, &track.path)?,
                            canonical_stream_source_fingerprint(&track.path, Some(&stream_url)),
                        )
                    }
                } else {
                    let stream_url = backend::backend_stream_url(settings, &track.path)?;
                    (
                        backend::backend_analysis_stream_url(settings, &track.path)?,
                        canonical_stream_source_fingerprint(&track.path, Some(&stream_url)),
                    )
                };

            let cache_entry = cache_entries.get(&track.path);

            Ok(BackendTrackLoudnessAnalysisCandidate {
                track_path: track.path.clone(),
                title: track.title.clone(),
                analysis_input,
                source_fingerprint,
                cached_source_fingerprint: cache_entry
                    .map(|entry| entry.source_fingerprint.clone()),
                cached_analysis_version: cache_entry.map(|entry| entry.analysis_version),
            })
        })
        .collect()
}

fn analyze_audio_source(
    ffmpeg_binary: &Path,
    input: &str,
    input_label: &str,
) -> Result<(f32, f32, f32)> {
    let filter = format!(
        "loudnorm=I={TARGET_LOUDNESS_LUFS}:TP={TRUE_PEAK_LIMIT_DB}:LRA=11:print_format=json:stats_file=-"
    );
    let output = Command::new(ffmpeg_binary)
        .arg("-v")
        .arg("error")
        .arg("-nostats")
        .arg("-i")
        .arg(input)
        .arg("-af")
        .arg(&filter)
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("Failed to launch FFmpeg for {input_label}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            bail!("FFmpeg returned a non-zero exit status")
        } else {
            bail!("{stderr}")
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let payload =
        extract_json_block(stdout.as_ref()).or_else(|| extract_json_block(stderr.as_ref()));
    let payload = payload.context("FFmpeg did not return loudness stats")?;
    let stats: LoudnormStats =
        serde_json::from_str(&payload).context("Unable to parse FFmpeg loudness stats")?;

    let integrated_lufs = stats
        .input_i
        .trim()
        .parse::<f32>()
        .context("Unable to parse input loudness")?;
    let true_peak_db = stats
        .input_tp
        .trim()
        .parse::<f32>()
        .context("Unable to parse true peak")?;

    let desired_gain = TARGET_LOUDNESS_LUFS - integrated_lufs;
    let max_safe_gain = TRUE_PEAK_LIMIT_DB - true_peak_db;
    let target_gain_db = desired_gain
        .min(max_safe_gain)
        .clamp(MAX_NEGATIVE_GAIN_DB, MAX_POSITIVE_GAIN_DB);

    Ok((integrated_lufs, true_peak_db, target_gain_db))
}

fn analyze_track(
    ffmpeg_binary: &Path,
    path: &Path,
    file_size: i64,
    file_modified_at: i64,
) -> Result<TrackLoudnessAnalysisRecord> {
    let (integrated_lufs, true_peak_db, target_gain_db) = analyze_audio_source(
        ffmpeg_binary,
        &path.to_string_lossy(),
        &path.display().to_string(),
    )?;

    Ok(TrackLoudnessAnalysisRecord {
        path: path.to_string_lossy().to_string(),
        integrated_lufs,
        true_peak_db,
        target_gain_db,
        file_size,
        file_modified_at,
        analysis_version: LOUDNESS_ANALYSIS_VERSION,
    })
}

fn analyze_candidate(
    ffmpeg_binary: &Path,
    candidate: &TrackLoudnessAnalysisCandidate,
) -> CandidateAnalysisResult {
    let path = Path::new(&candidate.path);
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return CandidateAnalysisResult::Missing {
                path: candidate.path.clone(),
            };
        }
    };

    let file_size = metadata.len() as i64;
    let file_modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs() as i64)
        .unwrap_or_default();

    let is_unchanged = candidate.cached_file_size == Some(file_size)
        && candidate.cached_file_modified_at == Some(file_modified_at)
        && candidate.cached_analysis_version == Some(LOUDNESS_ANALYSIS_VERSION);
    if is_unchanged {
        return CandidateAnalysisResult::Unchanged;
    }

    match analyze_track(ffmpeg_binary, path, file_size, file_modified_at) {
        Ok(record) => CandidateAnalysisResult::Analyzed {
            filename: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&candidate.path)
                .to_string(),
            record,
        },
        Err(error) => CandidateAnalysisResult::Failed {
            path: candidate.path.clone(),
            reason: summarize_analysis_error(&error.to_string()),
        },
    }
}

fn analyze_backend_candidate(
    ffmpeg_binary: &Path,
    candidate: &BackendTrackLoudnessAnalysisCandidate,
) -> BackendCandidateAnalysisResult {
    let is_unchanged = candidate
        .cached_source_fingerprint
        .as_deref()
        .map(|value| normalize_backend_source_fingerprint(&candidate.track_path, value))
        == Some(candidate.source_fingerprint.clone())
        && candidate.cached_analysis_version == Some(LOUDNESS_ANALYSIS_VERSION);
    if is_unchanged {
        return BackendCandidateAnalysisResult::Unchanged;
    }

    match analyze_audio_source(ffmpeg_binary, &candidate.analysis_input, &candidate.title) {
        Ok((integrated_lufs, true_peak_db, target_gain_db)) => {
            BackendCandidateAnalysisResult::Analyzed {
                title: candidate.title.clone(),
                record: BackendTrackLoudnessAnalysisRecord {
                    track_path: candidate.track_path.clone(),
                    integrated_lufs,
                    true_peak_db,
                    target_gain_db,
                    source_fingerprint: candidate.source_fingerprint.clone(),
                    analysis_version: LOUDNESS_ANALYSIS_VERSION,
                },
            }
        }
        Err(error) => BackendCandidateAnalysisResult::Failed {
            path: candidate.track_path.clone(),
            reason: summarize_analysis_error(&error.to_string()),
        },
    }
}

fn extract_json_block(output: &str) -> Option<String> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    (end > start).then(|| output[start..=end].to_string())
}

fn build_progress_event(
    total_tracks: usize,
    processed_tracks: usize,
    summary: &LoudnessAnalysisSummary,
    failed_path: Option<String>,
    failed_reason: Option<String>,
) -> LoudnessAnalysisProgress {
    LoudnessAnalysisProgress {
        total_tracks,
        processed_tracks,
        analyzed_tracks: summary.analyzed_tracks,
        unchanged_tracks: summary.unchanged_tracks,
        missing_tracks: summary.missing_tracks,
        failed_tracks: summary.failed_tracks,
        failed_path,
        failed_reason,
    }
}

fn summarize_analysis_error(error: &str) -> String {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("invalid data found when processing input")
        || normalized.contains("cannot determine format of input")
        || normalized.contains("error while decoding stream")
        || normalized.contains("end of file")
        || normalized.contains("moov atom not found")
    {
        return "File appears corrupted or incomplete.".to_string();
    }

    error
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .unwrap_or_else(|| "FFmpeg analysis failed.".to_string())
}

fn canonical_stream_source_fingerprint(track_path: &str, stream_url: Option<&str>) -> String {
    if let Some(track_id) = backend::backend_track_id_from_path(track_path) {
        return format!("stream|needle-track:{track_id}");
    }

    if let Some(track_id) = stream_url.and_then(extract_track_id_from_stream_url) {
        return format!("stream|needle-track:{track_id}");
    }

    format!("stream|{track_path}")
}

fn canonical_offline_source_fingerprint(
    track_path: &str,
    file_size: u64,
    file_modified_at: i64,
) -> String {
    format!("offline|{track_path}|{file_size}|{file_modified_at}")
}

fn normalize_backend_source_fingerprint(track_path: &str, fingerprint: &str) -> String {
    if let Some(track_id) = fingerprint
        .strip_prefix("stream:")
        .and_then(extract_track_id_from_stream_url)
    {
        return format!("stream|needle-track:{track_id}");
    }

    if let Some(track_id) = fingerprint.strip_prefix("stream|needle-track:") {
        return format!("stream|needle-track:{}", track_id.trim());
    }

    if let Some(track_id) = fingerprint
        .strip_prefix("stream:")
        .filter(|value| value.starts_with("needle-track:"))
    {
        return format!("stream|{}", track_id.trim());
    }

    if let Some(rest) = fingerprint.strip_prefix("offline:") {
        let parts = rest.splitn(3, ':').collect::<Vec<_>>();
        if parts.len() == 3
            && parts[0].chars().all(|ch| ch.is_ascii_digit())
            && parts[1].chars().all(|ch| ch == '-' || ch.is_ascii_digit())
        {
            return format!("offline|{track_path}|{}|{}", parts[0], parts[1]);
        }
    }

    if let Some(rest) = fingerprint.strip_prefix("offline|") {
        let parts = rest.rsplitn(3, '|').collect::<Vec<_>>();
        if parts.len() == 3 {
            return format!("offline|{}|{}|{}", parts[2], parts[1], parts[0]);
        }
    }

    fingerprint.to_string()
}

fn extract_track_id_from_stream_url(value: &str) -> Option<&str> {
    let marker = "/api/stream/";
    let (_, tail) = value.split_once(marker)?;
    let track_id = tail.split('?').next()?.trim();
    (!track_id.is_empty()).then_some(track_id)
}

fn resolve_ffmpeg_binary() -> Option<PathBuf> {
    for candidate in FFMPEG_CANDIDATES {
        let path = Path::new(candidate);
        if path.is_absolute() {
            if path.exists() {
                return Some(path.to_path_buf());
            }
            continue;
        }

        if Command::new(candidate)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return Some(PathBuf::from(candidate));
        }
    }

    None
}

fn analysis_worker_count(total_tracks: usize) -> usize {
    LOUDNESS_ANALYSIS_WORKERS.min(total_tracks.max(1))
}
