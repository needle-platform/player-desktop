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

fn strip_dash_variant_suffix(title: &str) -> Option<String> {
    for separator in [" - ", " – ", " — "] {
        let (base, suffix) = title.rsplit_once(separator)?;
        if !is_variant_suffix(suffix) {
            return None;
        }
        let trimmed = base.trim_end();
        if trimmed.is_empty() {
            return None;
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
            .or_else(|| strip_dash_variant_suffix(&current));
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

    for album in titles {
        // 1) Search MusicBrainz release-group for "album" + optional "artist".
        let query = match artist {
            Some(artist) if !artist.trim().is_empty() => format!(
                "releasegroup:\"{}\" AND artist:\"{}\"",
                escape_query(&album),
                escape_query(artist.trim())
            ),
            _ => format!("releasegroup:\"{}\"", escape_query(&album)),
        };

        let mbid = {
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
            let Some(id) = pick_release_group_id(&groups, &album) else {
                continue;
            };
            id
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
            let Some(qid) = qid.filter(|q| q.starts_with('Q')) else {
                continue;
            };
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
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{lookup_title_candidates, pick_release_group_id};
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
}
