use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Semaphore;

const USER_AGENT: &str = "Needle/0.1 (https://gitea.davidrelich.com/davidrelich/music-player)";

// Reuse the same MusicBrainz throttle as artist lookups.
static MB_LIMIT: tokio::sync::OnceCell<Semaphore> = tokio::sync::OnceCell::const_new();

async fn mb_permit() -> tokio::sync::SemaphorePermit<'static> {
    MB_LIMIT
        .get_or_init(|| async { Semaphore::new(1) })
        .await
        .acquire()
        .await
        .expect("semaphore closed")
}

#[derive(Debug, Clone, Serialize)]
pub struct AlbumInfo {
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub source: String,
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(10))
        .build()
        .context("Failed to build HTTP client")
}

fn escape_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn normalized_title(value: &str) -> String {
    value.trim().to_ascii_lowercase()
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

fn release_group_artist_credit(value: &Value) -> Option<String> {
    let credits = value["artist-credit"].as_array()?;
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

fn release_group_kind(value: &Value) -> &'static str {
    let is_live = value["secondary-types"]
        .as_array()
        .map(|types| {
            types
                .iter()
                .filter_map(|item| item.as_str())
                .any(|item| item.eq_ignore_ascii_case("live"))
        })
        .unwrap_or(false);

    match value["primary-type"].as_str() {
        Some(primary) if primary.eq_ignore_ascii_case("album") && is_live => "live album",
        Some(primary) if primary.eq_ignore_ascii_case("ep") && is_live => "live EP",
        Some(primary) if primary.eq_ignore_ascii_case("single") && is_live => "live single",
        Some(primary) if primary.eq_ignore_ascii_case("album") => "album",
        Some(primary) if primary.eq_ignore_ascii_case("ep") => "EP",
        Some(primary) if primary.eq_ignore_ascii_case("single") => "single",
        Some(primary) if primary.eq_ignore_ascii_case("compilation") => "compilation",
        Some(primary) if primary.eq_ignore_ascii_case("soundtrack") => "soundtrack",
        Some(_) if is_live => "live release",
        Some(_) => "release",
        None if is_live => "live release",
        None => "release",
    }
}

fn musicbrainz_fallback_info(value: &Value) -> Option<AlbumInfo> {
    let title = value["title"].as_str()?.trim();
    if title.is_empty() {
        return None;
    }

    let kind = release_group_kind(value);
    let artist_credit = release_group_artist_credit(value);
    let release_year = value["first-release-date"]
        .as_str()
        .and_then(|date| date.get(..4))
        .filter(|year| year.chars().all(|ch| ch.is_ascii_digit()));
    let mbid = value["id"].as_str()?.trim();

    let description = match (artist_credit.as_deref(), release_year) {
        (Some(artist), Some(year)) => {
            format!("{title} is a {kind} by {artist}, first released in {year}.")
        }
        (Some(artist), None) => format!("{title} is a {kind} by {artist}."),
        (None, Some(year)) => format!("{title} is a {kind}, first released in {year}."),
        (None, None) => format!("{title} is a {kind}."),
    };

    Some(AlbumInfo {
        description: Some(description),
        source_url: Some(format!("https://musicbrainz.org/release-group/{mbid}")),
        source: "musicbrainz".into(),
    })
}

fn release_group_type_rank(primary_type: Option<&str>) -> usize {
    match primary_type.map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "album" => 0,
        Some(value) if value == "ep" => 1,
        Some(value) if value == "soundtrack" => 2,
        Some(value) if value == "compilation" => 3,
        Some(value) if value == "live" => 4,
        Some(value) if value == "remix" => 5,
        Some(value) if value == "single" => 6,
        Some(_) => 7,
        None => 8,
    }
}

fn pick_release_group_id(results: &[Value], query_title: &str) -> Option<String> {
    let normalized_query = normalized_title(query_title);

    results
        .iter()
        .filter_map(|group| {
            let score = group["score"].as_i64().unwrap_or(0);
            if score < 80 {
                return None;
            }

            let id = group["id"].as_str()?.to_string();
            let title = group["title"].as_str().unwrap_or_default();
            let exact_title = normalized_title(title) == normalized_query;
            let type_rank = release_group_type_rank(group["primary-type"].as_str());

            Some((exact_title, type_rank, score, id))
        })
        .max_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| right.1.cmp(&left.1))
                .then_with(|| left.2.cmp(&right.2))
        })
        .map(|(_, _, _, id)| id)
}

fn is_variant_suffix(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    [
        "anthology",
        "anniversary",
        "bonus",
        "collector",
        "deluxe",
        "edition",
        "expanded",
        "extended",
        "reissue",
        "remaster",
        "remastered",
        "special",
        "super deluxe",
        "version",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn strip_bracketed_variant_suffix(title: &str) -> Option<String> {
    let trimmed = title.trim_end();
    for (open, close) in [('(', ')'), ('[', ']')] {
        if !trimmed.ends_with(close) {
            continue;
        }
        let start = trimmed.rfind(open)?;
        let suffix = trimmed.get(start + open.len_utf8()..trimmed.len() - close.len_utf8())?;
        if !is_variant_suffix(suffix) {
            return None;
        }
        let base = trimmed[..start].trim_end();
        if base.is_empty() {
            return None;
        }
        return Some(base.to_string());
    }
    None
}

fn strip_separator_variant_suffix(title: &str) -> Option<String> {
    for separator in [" - ", " – ", " — ", ": "] {
        let Some((base, suffix)) = title.rsplit_once(separator) else {
            continue;
        };
        if !is_variant_suffix(suffix) {
            continue;
        }
        let trimmed = base.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        return Some(trimmed.to_string());
    }
    None
}

pub fn lookup_title_candidates(album: &str) -> Vec<String> {
    let trimmed = album.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut candidates = vec![trimmed.to_string()];
    let mut current = trimmed.to_string();

    loop {
        let next = strip_bracketed_variant_suffix(&current)
            .or_else(|| strip_separator_variant_suffix(&current));
        let Some(next) = next else {
            break;
        };
        if candidates
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&next))
        {
            break;
        }
        current = next;
        candidates.push(current.clone());
    }

    candidates
}

pub async fn fetch_album_info(album: &str, artist: Option<&str>) -> Result<Option<AlbumInfo>> {
    let titles = lookup_title_candidates(album);
    if titles.is_empty() {
        return Ok(None);
    }

    let client = http_client()?;
    let artist_candidates = match artist {
        Some(value) if !value.trim().is_empty() => collaboration_artist_candidates(value),
        _ => Vec::new(),
    };

    for album in titles {
        let mut queries = Vec::new();
        if artist_candidates.is_empty() {
            queries.push(format!("releasegroup:\"{}\"", escape_query(&album)));
        } else {
            for candidate in &artist_candidates {
                queries.push(format!(
                    "releasegroup:\"{}\" AND artist:\"{}\"",
                    escape_query(&album),
                    escape_query(candidate)
                ));
            }
            queries.push(format!("releasegroup:\"{}\"", escape_query(&album)));
        }

        let mut mbid = None;
        let mut matched_group = None;
        for query in queries {
            let _permit = mb_permit().await;
            let url = format!(
                "https://musicbrainz.org/ws/2/release-group/?query={}&fmt=json&limit=5",
                urlencoding::encode(&query)
            );
            let resp: Value = client
                .get(&url)
                .send()
                .await
                .context("MusicBrainz release-group search failed")?
                .error_for_status()
                .context("MusicBrainz release-group search non-2xx")?
                .json()
                .await
                .context("MusicBrainz release-group search invalid JSON")?;

            let groups = resp["release-groups"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if let Some(id) = pick_release_group_id(&groups, &album) {
                matched_group = groups
                    .iter()
                    .find(|group| group["id"].as_str() == Some(id.as_str()))
                    .cloned();
                mbid = Some(id);
                break;
            }
        }

        let Some(mbid) = mbid else {
            continue;
        };

        // 2) Fetch the release-group with url-rels so we can find Wikipedia / Wikidata.
        let relations: Vec<Value> = {
            let _permit = mb_permit().await;
            let url = format!(
                "https://musicbrainz.org/ws/2/release-group/{}?inc=url-rels&fmt=json",
                mbid
            );
            let resp: Value = client
                .get(&url)
                .send()
                .await
                .context("MusicBrainz release-group lookup failed")?
                .error_for_status()
                .context("MusicBrainz release-group lookup non-2xx")?
                .json()
                .await
                .context("MusicBrainz release-group lookup invalid JSON")?;
            resp["relations"].as_array().cloned().unwrap_or_default()
        };

        // 3) Direct Wikipedia URL relation.
        let mut wikipedia_title: Option<String> = relations.iter().find_map(|rel| {
            if rel["type"] == "wikipedia" {
                rel["url"]["resource"]
                    .as_str()
                    .and_then(|url| url.rsplit('/').next())
                    .map(|raw| {
                        urlencoding::decode(raw)
                            .map(|cow| cow.into_owned())
                            .unwrap_or_else(|_| raw.to_string())
                    })
            } else {
                None
            }
        });

        // 4) Fallback: Wikidata relation -> sitelinks.enwiki.title
        if wikipedia_title.is_none() {
            let qid = relations.iter().find_map(|rel| {
                if rel["type"] == "wikidata" {
                    rel["url"]["resource"]
                        .as_str()
                        .and_then(|url| url.rsplit('/').next())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            });
            if let Some(qid) = qid.filter(|q| q.starts_with('Q')) {
                let url = format!(
                    "https://www.wikidata.org/wiki/Special:EntityData/{}.json",
                    qid
                );
                let resp: Value = client
                    .get(&url)
                    .send()
                    .await
                    .context("Wikidata lookup failed")?
                    .error_for_status()
                    .context("Wikidata non-2xx")?
                    .json()
                    .await
                    .context("Wikidata invalid JSON")?;
                wikipedia_title = resp
                    .pointer(&format!("/entities/{}/sitelinks/enwiki/title", qid))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }

        // 5) Fetch Wikipedia summary if we found a title.
        if let Some(title) = wikipedia_title {
            let path = title.replace(' ', "_");
            let url = format!(
                "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
                urlencoding::encode(&path)
            );
            let resp: Value = client
                .get(&url)
                .send()
                .await
                .context("Wikipedia summary fetch failed")?
                .error_for_status()
                .context("Wikipedia summary non-2xx")?
                .json()
                .await
                .context("Wikipedia summary invalid JSON")?;

            let extract = resp["extract"].as_str().map(|s| s.to_string());
            let page_url = resp
                .pointer("/content_urls/desktop/page")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if extract.is_some() || page_url.is_some() {
                return Ok(Some(AlbumInfo {
                    description: extract,
                    source_url: page_url,
                    source: "wikipedia".into(),
                }));
            }
        }

        if let Some(group) = matched_group.as_ref().and_then(musicbrainz_fallback_info) {
            return Ok(Some(group));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{
        collaboration_artist_candidates, lookup_title_candidates, musicbrainz_fallback_info,
        pick_release_group_id,
    };
    use serde_json::json;

    #[test]
    fn keeps_original_title_first() {
        assert_eq!(lookup_title_candidates("She Wolf"), vec!["She Wolf"]);
    }

    #[test]
    fn strips_common_edition_suffixes() {
        assert_eq!(
            lookup_title_candidates("She Wolf (Extended Edition)"),
            vec!["She Wolf (Extended Edition)", "She Wolf"]
        );
        assert_eq!(
            lookup_title_candidates("Future Nostalgia - Deluxe Edition"),
            vec!["Future Nostalgia - Deluxe Edition", "Future Nostalgia"]
        );
        assert_eq!(
            lookup_title_candidates("THE TORTURED POETS DEPARTMENT: THE ANTHOLOGY"),
            vec![
                "THE TORTURED POETS DEPARTMENT: THE ANTHOLOGY",
                "THE TORTURED POETS DEPARTMENT",
            ]
        );
    }

    #[test]
    fn strips_multiple_variant_suffixes() {
        assert_eq!(
            lookup_title_candidates("Album Title (Expanded Edition) [Remastered]"),
            vec![
                "Album Title (Expanded Edition) [Remastered]",
                "Album Title (Expanded Edition)",
                "Album Title",
            ]
        );
    }

    #[test]
    fn prefers_album_over_single_for_same_title() {
        let results = vec![
            json!({
                "id": "single-id",
                "title": "She Wolf",
                "score": 100,
                "primary-type": "Single"
            }),
            json!({
                "id": "album-id",
                "title": "She Wolf",
                "score": 100,
                "primary-type": "Album"
            }),
        ];

        assert_eq!(
            pick_release_group_id(&results, "She Wolf"),
            Some("album-id".to_string())
        );
    }

    #[test]
    fn splits_collaboration_artist_candidates() {
        assert_eq!(
            collaboration_artist_candidates("Tata Bojs & SOČR"),
            vec!["Tata Bojs & SOČR", "Tata Bojs", "SOČR"]
        );
    }

    #[test]
    fn builds_musicbrainz_fallback_info() {
        let info = musicbrainz_fallback_info(&json!({
            "id": "7f304b30-114c-4020-887a-3d43c59233d2",
            "title": "Live",
            "first-release-date": "2017-05-26",
            "primary-type": "Album",
            "secondary-types": ["Live"],
            "artist-credit": [
                { "name": "Tata Bojs", "joinphrase": " & " },
                { "name": "SOČR" }
            ]
        }))
        .expect("fallback info");

        assert_eq!(
            info.description.as_deref(),
            Some("Live is a live album by Tata Bojs & SOČR, first released in 2017.")
        );
        assert_eq!(
            info.source_url.as_deref(),
            Some("https://musicbrainz.org/release-group/7f304b30-114c-4020-887a-3d43c59233d2")
        );
        assert_eq!(info.source, "musicbrainz");
    }
}
