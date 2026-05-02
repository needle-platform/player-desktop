use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::UNIX_EPOCH,
};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::db::{self, TrackLoudnessAnalysisRecord};

const FFMPEG_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    "ffmpeg",
];
const TARGET_LOUDNESS_LUFS: f32 = -18.0;
const TRUE_PEAK_LIMIT_DB: f32 = -1.0;

#[derive(Debug, Default)]
pub struct LoudnessAnalysisSummary {
    pub analyzed_tracks: usize,
    pub unchanged_tracks: usize,
    pub missing_tracks: usize,
    pub failed_tracks: usize,
}

#[derive(Debug, Deserialize)]
struct LoudnormStats {
    input_i: String,
    input_tp: String,
}

pub fn analyze_library<F>(db_path: &Path, mut emit_log: F) -> Result<LoudnessAnalysisSummary>
where
    F: FnMut(String),
{
    let ffmpeg = resolve_ffmpeg_binary()
        .context("FFmpeg was not found. Install it with `brew install ffmpeg` and try again.")?;
    let candidates = db::list_tracks_for_loudness_analysis(db_path)?;
    let total_tracks = candidates.len();

    emit_log(format!(
        "Starting loudness analysis for {} track{} using {}.",
        total_tracks,
        if total_tracks == 1 { "" } else { "s" },
        ffmpeg.display()
    ));

    if total_tracks == 0 {
        db::record_loudness_analysis_run(db_path)?;
        emit_log("No tracks are in the library yet, so there was nothing to analyze.".to_string());
        return Ok(LoudnessAnalysisSummary::default());
    }

    let mut summary = LoudnessAnalysisSummary::default();
    let mut records = Vec::new();

    for (index, candidate) in candidates.iter().enumerate() {
        let path = Path::new(&candidate.path);
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => {
                summary.missing_tracks += 1;
                emit_log(format!(
                    "Skipped missing file {}/{}: {}",
                    index + 1,
                    total_tracks,
                    candidate.path
                ));
                continue;
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
            && candidate.cached_file_modified_at == Some(file_modified_at);
        if is_unchanged {
            summary.unchanged_tracks += 1;
            if (index + 1) % 250 == 0 {
                emit_log(format!(
                    "Checked {}/{} tracks. {} already had fresh loudness data.",
                    index + 1,
                    total_tracks,
                    summary.unchanged_tracks
                ));
            }
            continue;
        }

        match analyze_track(&ffmpeg, path, file_size, file_modified_at) {
            Ok(record) => {
                summary.analyzed_tracks += 1;
                let filename = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&candidate.path);
                if summary.analyzed_tracks == 1
                    || summary.analyzed_tracks % 10 == 0
                    || index + 1 == total_tracks
                {
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
                }
                records.push(record);
            }
            Err(error) => {
                summary.failed_tracks += 1;
                emit_log(format!(
                    "Failed to analyze {}/{}: {} ({error})",
                    index + 1,
                    total_tracks,
                    candidate.path
                ));
            }
        }
    }

    db::save_track_loudness_records(db_path, &records)?;
    db::record_loudness_analysis_run(db_path)?;

    emit_log(format!(
        "Loudness analysis finished. {} analyzed, {} already fresh, {} missing, {} failed.",
        summary.analyzed_tracks,
        summary.unchanged_tracks,
        summary.missing_tracks,
        summary.failed_tracks
    ));

    Ok(summary)
}

fn analyze_track(
    ffmpeg_binary: &Path,
    path: &Path,
    file_size: i64,
    file_modified_at: i64,
) -> Result<TrackLoudnessAnalysisRecord> {
    let filter = format!(
        "loudnorm=I={TARGET_LOUDNESS_LUFS}:TP={TRUE_PEAK_LIMIT_DB}:LRA=11:print_format=json:stats_file=-"
    );
    let output = Command::new(ffmpeg_binary)
        .arg("-v")
        .arg("error")
        .arg("-nostats")
        .arg("-i")
        .arg(path)
        .arg("-af")
        .arg(&filter)
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("Failed to launch FFmpeg for {}", path.display()))?;

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
    let target_gain_db = desired_gain.min(max_safe_gain).clamp(-24.0, 24.0);

    Ok(TrackLoudnessAnalysisRecord {
        path: path.to_string_lossy().to_string(),
        integrated_lufs,
        true_peak_db,
        target_gain_db,
        file_size,
        file_modified_at,
    })
}

fn extract_json_block(output: &str) -> Option<String> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    (end > start).then(|| output[start..=end].to_string())
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
