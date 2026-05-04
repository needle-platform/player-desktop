use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::album;
use crate::models::{AlbumMetadataRefreshStatus, Track, TrackMetadataOverride};

const USER_AGENT: &str = "Needle/0.1 (https://gitea.davidrelich.com/davidrelich/music-player)";
static MB_LIMIT: tokio::sync::OnceCell<Semaphore> = tokio::sync::OnceCell::const_new();

async fn mb_permit() -> tokio::sync::SemaphorePermit<'static> {
    MB_LIMIT
        .get_or_init(|| async { Semaphore::new(1) })
        .await
        .acquire()
        .await
        .expect("semaphore closed")
}

fn http_client() -> Result<Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .context("Failed to build HTTP client")
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::TOO_MANY_REQUESTS
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

async fn fetch_json_with_retries(client: &Client, url: &str, action: &str) -> Result<Value> {
    let mut last_error = None;

    for attempt in 0..3 {
        let response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("{action} failed"))?;

        let status = response.status();
        if status.is_success() {
            return response
                .json()
                .await
                .with_context(|| format!("{action} returned invalid JSON"));
        }

        let body = response.text().await.unwrap_or_default();
        if is_retryable_status(status) && attempt < 2 {
            last_error = Some(anyhow!("{action} returned {status}: {body}"));
            tokio::time::sleep(Duration::from_millis(1200 * (attempt as u64 + 1))).await;
            continue;
        }

        return Err(anyhow!("{action} returned {status}: {body}"));
    }

    Err(last_error.unwrap_or_else(|| anyhow!("{action} failed after retries")))
}

fn escape_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn normalized_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut last_was_separator = true;

    for ch in value.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                normalized.push(lower);
            }
            last_was_separator = false;
        } else if !last_was_separator {
            normalized.push(' ');
            last_was_separator = true;
        }
    }

    normalized.trim().to_string()
}

fn collaboration_artist_candidates(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let separators = [
        " feat. ",
        " featuring ",
        " ft. ",
        " with ",
        " & ",
        " and ",
        " x ",
        " × ",
        ";",
        ",",
    ];

    let mut seen = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::from([trimmed.to_string()]);
    let mut candidates = Vec::new();

    while let Some(candidate) = queue.pop_front() {
        let normalized = candidate.trim().to_string();
        if normalized.is_empty() || !seen.insert(normalized.to_ascii_lowercase()) {
            continue;
        }
        candidates.push(normalized.clone());

        for separator in separators {
            if !normalized.to_ascii_lowercase().contains(separator.trim()) {
                continue;
            }
            for part in normalized.split(separator) {
                let part = part.trim();
                if !part.is_empty() {
                    queue.push_back(part.to_string());
                }
            }
        }
    }

    candidates
}

fn artist_credit_name(value: &Value) -> Option<String> {
    let credits = value.as_array()?;
    let mut combined = String::new();

    for credit in credits {
        let name = credit["name"]
            .as_str()
            .or_else(|| credit["artist"]["name"].as_str())?;
        combined.push_str(name);
        if let Some(joinphrase) = credit["joinphrase"].as_str() {
            combined.push_str(joinphrase);
        }
    }

    let combined = combined.trim();
    if combined.is_empty() {
        None
    } else {
        Some(combined.to_string())
    }
}

fn release_year(value: &Value) -> Option<i64> {
    value["date"]
        .as_str()
        .or_else(|| value["first-release-date"].as_str())
        .and_then(|date| date.get(..4))
        .filter(|year| year.chars().all(|ch| ch.is_ascii_digit()))
        .and_then(|year| year.parse::<i64>().ok())
}

#[derive(Debug, Clone)]
struct CandidateTrack {
    title: String,
    artist: Option<String>,
    disc_number: i64,
    track_number: i64,
    length_seconds: Option<u64>,
    recording_mbid: Option<String>,
    release_track_mbid: Option<String>,
}

#[derive(Debug, Clone)]
struct ReleaseCandidate {
    release_mbid: String,
    release_group_mbid: Option<String>,
    title: String,
    artist: Option<String>,
    year: Option<i64>,
    tracks: Vec<CandidateTrack>,
}

#[derive(Debug, Clone)]
pub struct AlbumMetadataMatch {
    pub status: AlbumMetadataRefreshStatus,
    pub confidence: Option<f64>,
    pub release_title: Option<String>,
    pub release_artist: Option<String>,
    pub source_url: Option<String>,
    pub message: String,
    pub overrides: Vec<TrackMetadataOverride>,
}

fn extract_release_candidate(value: &Value) -> Option<ReleaseCandidate> {
    let release_mbid = value["id"].as_str()?.to_string();
    let title = value["title"].as_str()?.trim().to_string();
    if title.is_empty() {
        return None;
    }

    let artist = artist_credit_name(&value["artist-credit"]);
    let year = release_year(value);
    let release_group_mbid = value["release-group"]["id"]
        .as_str()
        .map(|id| id.to_string());

    let mut tracks = Vec::new();
    for (disc_index, medium) in value["media"].as_array().into_iter().flatten().enumerate() {
        let disc_number = medium["position"]
            .as_i64()
            .or_else(|| {
                medium["position"]
                    .as_str()
                    .and_then(|s| s.parse::<i64>().ok())
            })
            .unwrap_or(disc_index as i64 + 1);

        for (track_index, track) in medium["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let track_number = track["position"]
                .as_i64()
                .or_else(|| {
                    track["position"]
                        .as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                })
                .unwrap_or(track_index as i64 + 1);
            let title = track["title"]
                .as_str()
                .or_else(|| track["recording"]["title"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if title.is_empty() {
                continue;
            }

            let length_ms = track["length"]
                .as_i64()
                .or_else(|| track["recording"]["length"].as_i64());

            tracks.push(CandidateTrack {
                title,
                artist: artist_credit_name(&track["artist-credit"])
                    .or_else(|| artist_credit_name(&track["recording"]["artist-credit"])),
                disc_number,
                track_number,
                length_seconds: length_ms
                    .filter(|value| *value > 0)
                    .map(|value| (value as u64 + 500) / 1000),
                recording_mbid: track["recording"]["id"].as_str().map(|id| id.to_string()),
                release_track_mbid: track["id"].as_str().map(|id| id.to_string()),
            });
        }
    }

    if tracks.is_empty() {
        return None;
    }

    Some(ReleaseCandidate {
        release_mbid,
        release_group_mbid,
        title,
        artist,
        year,
        tracks,
    })
}

async fn search_release_ids(
    client: &Client,
    album_name: &str,
    album_artist: Option<&str>,
) -> Result<Vec<String>> {
    let mut queries = Vec::new();
    if let Some(artist) = album_artist.filter(|value| !value.trim().is_empty()) {
        for candidate in collaboration_artist_candidates(artist) {
            queries.push(format!(
                "release:\"{}\" AND artist:\"{}\"",
                escape_query(album_name),
                escape_query(&candidate)
            ));
        }
    }
    queries.push(format!("release:\"{}\"", escape_query(album_name)));

    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut last_error = None;

    for query in queries {
        let _permit = mb_permit().await;
        let url = format!(
            "https://musicbrainz.org/ws/2/release/?query={}&fmt=json&limit=8",
            urlencoding::encode(&query)
        );
        let resp = match fetch_json_with_retries(client, &url, "MusicBrainz release search").await {
            Ok(value) => value,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };

        for release in resp["releases"].as_array().into_iter().flatten() {
            let score = release["score"].as_i64().unwrap_or(0);
            let id = release["id"].as_str().unwrap_or("").trim();
            if id.is_empty() || score < 70 || !seen.insert(id.to_string()) {
                continue;
            }
            ids.push(id.to_string());
        }
    }

    if ids.is_empty() {
        if let Some(error) = last_error {
            return Err(error);
        }
    }

    Ok(ids)
}

async fn fetch_release_candidate(
    client: &Client,
    release_mbid: &str,
) -> Result<Option<ReleaseCandidate>> {
    let _permit = mb_permit().await;
    let url = format!(
        "https://musicbrainz.org/ws/2/release/{}?inc=recordings+artist-credits&fmt=json",
        release_mbid
    );
    let resp = fetch_json_with_retries(client, &url, "MusicBrainz release lookup").await?;
    Ok(extract_release_candidate(&resp))
}

fn sort_local_tracks<'a>(tracks: &'a [Track]) -> Vec<&'a Track> {
    let mut sorted = tracks.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        left.disc_number
            .unwrap_or(1)
            .cmp(&right.disc_number.unwrap_or(1))
            .then(
                left.track_number
                    .unwrap_or(9999)
                    .cmp(&right.track_number.unwrap_or(9999)),
            )
            .then(normalized_text(&left.title).cmp(&normalized_text(&right.title)))
            .then(left.path.cmp(&right.path))
    });
    sorted
}

fn compare_title_match(left: &str, right: &str) -> f64 {
    let left_norm = normalized_text(left);
    let right_norm = normalized_text(right);
    if left_norm.is_empty() || right_norm.is_empty() {
        return 0.0;
    }
    if left_norm == right_norm {
        return 1.0;
    }
    if left_norm.contains(&right_norm) || right_norm.contains(&left_norm) {
        return 0.7;
    }
    let left_words: std::collections::HashSet<_> = left_norm.split_whitespace().collect();
    let right_words: std::collections::HashSet<_> = right_norm.split_whitespace().collect();
    let shared = left_words.intersection(&right_words).count() as f64;
    let total = left_words.union(&right_words).count() as f64;
    if total <= 0.0 {
        0.0
    } else {
        shared / total
    }
}

fn track_alignment_for_candidate<'a>(
    local_tracks: &'a [Track],
    candidate: &'a ReleaseCandidate,
) -> Option<Vec<(&'a Track, &'a CandidateTrack)>> {
    if local_tracks.len() != candidate.tracks.len() {
        return None;
    }

    let mut by_position = std::collections::HashMap::new();
    for track in &candidate.tracks {
        by_position.insert((track.disc_number, track.track_number), track);
    }

    let mut aligned = Vec::with_capacity(local_tracks.len());
    let mut all_positioned = true;
    for local in local_tracks {
        let disc = local.disc_number.unwrap_or(1);
        let number = local.track_number.unwrap_or(0);
        if number <= 0 {
            all_positioned = false;
            break;
        }
        let Some(candidate_track) = by_position.get(&(disc, number)).copied() else {
            all_positioned = false;
            break;
        };
        aligned.push((local, candidate_track));
    }

    if all_positioned {
        return Some(aligned);
    }

    let sorted_candidate = {
        let mut tracks = candidate.tracks.iter().collect::<Vec<_>>();
        tracks.sort_by(|left, right| {
            left.disc_number
                .cmp(&right.disc_number)
                .then(left.track_number.cmp(&right.track_number))
                .then(normalized_text(&left.title).cmp(&normalized_text(&right.title)))
        });
        tracks
    };

    Some(
        sort_local_tracks(local_tracks)
            .into_iter()
            .zip(sorted_candidate)
            .map(|(local, candidate_track)| (local, candidate_track))
            .collect(),
    )
}

fn score_candidate<'a>(
    requested_album: &str,
    requested_artist: Option<&str>,
    local_tracks: &'a [Track],
    candidate: &'a ReleaseCandidate,
) -> (f64, Option<Vec<(&'a Track, &'a CandidateTrack)>>) {
    let Some(aligned_tracks) = track_alignment_for_candidate(local_tracks, candidate) else {
        return (0.0, None);
    };

    let album_score = compare_title_match(requested_album, &candidate.title);
    let artist_score = match (requested_artist, candidate.artist.as_deref()) {
        (Some(left), Some(right)) => compare_title_match(left, right),
        (None, _) => 0.6,
        _ => 0.0,
    };

    let local_disc_count = local_tracks
        .iter()
        .map(|track| track.disc_number.unwrap_or(1))
        .collect::<std::collections::HashSet<_>>()
        .len();
    let candidate_disc_count = candidate
        .tracks
        .iter()
        .map(|track| track.disc_number)
        .collect::<std::collections::HashSet<_>>()
        .len();
    let disc_score = if local_disc_count == candidate_disc_count {
        1.0
    } else {
        0.0
    };

    let track_count_score = if local_tracks.len() == candidate.tracks.len() {
        1.0
    } else {
        0.0
    };

    let mut title_total = 0.0;
    let mut duration_total = 0.0;
    let mut position_hits = 0.0;
    for (local, remote) in &aligned_tracks {
        title_total += compare_title_match(&local.title, &remote.title);
        if let Some(length) = remote.length_seconds {
            if let Some(local_length) = local.duration_seconds {
                let diff = local_length.abs_diff(length);
                duration_total += if diff <= 2 {
                    1.0
                } else if diff <= 5 {
                    0.7
                } else if diff <= 10 {
                    0.35
                } else {
                    0.0
                };
            } else {
                duration_total += 0.5;
            }
        } else {
            duration_total += 0.4;
        }

        if local.disc_number.unwrap_or(1) == remote.disc_number
            && local.track_number.unwrap_or(remote.track_number) == remote.track_number
        {
            position_hits += 1.0;
        }
    }

    let track_count = aligned_tracks.len() as f64;
    let avg_title = if track_count > 0.0 {
        title_total / track_count
    } else {
        0.0
    };
    let avg_duration = if track_count > 0.0 {
        duration_total / track_count
    } else {
        0.0
    };
    let avg_position = if track_count > 0.0 {
        position_hits / track_count
    } else {
        0.0
    };

    let score = (album_score * 0.26)
        + (artist_score * 0.20)
        + (track_count_score * 0.18)
        + (disc_score * 0.08)
        + (avg_position * 0.14)
        + (avg_title * 0.10)
        + (avg_duration * 0.04);

    (score, Some(aligned_tracks))
}

fn build_overrides(
    confidence: f64,
    candidate: &ReleaseCandidate,
    aligned_tracks: Vec<(&Track, &CandidateTrack)>,
) -> Vec<TrackMetadataOverride> {
    aligned_tracks
        .into_iter()
        .map(|(local, remote)| TrackMetadataOverride {
            track_path: local.path.clone(),
            title: Some(remote.title.clone()),
            artist: remote.artist.clone().or_else(|| local.artist.clone()),
            album: Some(candidate.title.clone()),
            album_artist: candidate
                .artist
                .clone()
                .or_else(|| local.album_artist.clone()),
            disc_number: Some(remote.disc_number),
            track_number: Some(remote.track_number),
            bpm: None,
            year: candidate.year.or(local.year),
            recording_mbid: remote.recording_mbid.clone(),
            release_track_mbid: remote.release_track_mbid.clone(),
            release_mbid: Some(candidate.release_mbid.clone()),
            release_group_mbid: candidate.release_group_mbid.clone(),
            confidence: Some(confidence),
        })
        .collect()
}

pub async fn refresh_album_metadata(
    requested_album: &str,
    requested_artist: Option<&str>,
    tracks: &[Track],
) -> Result<AlbumMetadataMatch> {
    let titles = album::lookup_title_candidates(requested_album);
    if titles.is_empty() || tracks.is_empty() {
        return Ok(AlbumMetadataMatch {
            status: AlbumMetadataRefreshStatus::NoMatch,
            confidence: None,
            release_title: None,
            release_artist: None,
            source_url: None,
            message: "No eligible tracks were found for this album.".into(),
            overrides: Vec::new(),
        });
    }

    let client = http_client()?;
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for title in titles {
        for release_id in search_release_ids(&client, &title, requested_artist).await? {
            if !seen.insert(release_id.clone()) {
                continue;
            }
            if let Some(candidate) = fetch_release_candidate(&client, &release_id).await? {
                candidates.push(candidate);
            }
        }
    }

    if candidates.is_empty() {
        return Ok(AlbumMetadataMatch {
            status: AlbumMetadataRefreshStatus::NoMatch,
            confidence: None,
            release_title: None,
            release_artist: None,
            source_url: None,
            message: "No MusicBrainz release candidates were found for this album.".into(),
            overrides: Vec::new(),
        });
    }

    let mut scored = candidates
        .iter()
        .filter_map(|candidate| {
            let (score, alignment) =
                score_candidate(requested_album, requested_artist, tracks, candidate);
            alignment.map(|aligned| (score, candidate, aligned))
        })
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| right.0.total_cmp(&left.0));
    let Some((best_score, best_candidate, best_alignment)) = scored.first() else {
        return Ok(AlbumMetadataMatch {
            status: AlbumMetadataRefreshStatus::NoMatch,
            confidence: None,
            release_title: None,
            release_artist: None,
            source_url: None,
            message: "No usable MusicBrainz release data was returned for this album.".into(),
            overrides: Vec::new(),
        });
    };

    let runner_up = scored.get(1).map(|value| value.0).unwrap_or(0.0);
    let source_url = Some(format!(
        "https://musicbrainz.org/release/{}",
        best_candidate.release_mbid
    ));

    if *best_score < 0.72 {
        return Ok(AlbumMetadataMatch {
            status: AlbumMetadataRefreshStatus::NoMatch,
            confidence: Some(*best_score),
            release_title: Some(best_candidate.title.clone()),
            release_artist: best_candidate.artist.clone(),
            source_url,
            message: "No confident MusicBrainz match was found for this album.".into(),
            overrides: Vec::new(),
        });
    }

    if *best_score - runner_up < 0.08 {
        return Ok(AlbumMetadataMatch {
            status: AlbumMetadataRefreshStatus::Ambiguous,
            confidence: Some(*best_score),
            release_title: Some(best_candidate.title.clone()),
            release_artist: best_candidate.artist.clone(),
            source_url,
            message: "Multiple MusicBrainz releases looked similarly plausible, so Needle left your imported tags untouched.".into(),
            overrides: Vec::new(),
        });
    }

    Ok(AlbumMetadataMatch {
        status: AlbumMetadataRefreshStatus::Matched,
        confidence: Some(*best_score),
        release_title: Some(best_candidate.title.clone()),
        release_artist: best_candidate.artist.clone(),
        source_url,
        message: "Metadata refreshed from MusicBrainz.".into(),
        overrides: build_overrides(*best_score, best_candidate, (*best_alignment).clone()),
    })
}
