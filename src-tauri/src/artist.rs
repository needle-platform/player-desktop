use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Semaphore;

const USER_AGENT: &str = "Needle/0.1 (https://gitea.davidrelich.com/davidrelich/music-player)";

// MusicBrainz asks for at most 1 req/sec. We allow a tiny bit of concurrency
// since we cache aggressively and every artist is looked up at most once.
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
pub struct ArtistImage {
    pub url: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArtistInfo {
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

fn normalized_artist_name(value: &str) -> String {
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

fn artist_type_rank(value: Option<&str>) -> usize {
    match value.map(|item| item.to_ascii_lowercase()) {
        Some(item) if item == "person" => 0,
        Some(item) if item == "group" => 1,
        Some(item) if item == "orchestra" => 2,
        Some(item) if item == "choir" => 3,
        Some(item) if item == "character" => 5,
        Some(_) => 4,
        None => 6,
    }
}

fn artist_matches_query(result: &Value, normalized_query: &str) -> (bool, bool) {
    let primary_exact = result["name"]
        .as_str()
        .map(|value| normalized_artist_name(value) == normalized_query)
        .unwrap_or(false);

    let alternate_exact = result["sort-name"]
        .as_str()
        .map(|value| normalized_artist_name(value) == normalized_query)
        .unwrap_or(false)
        || result["aliases"]
            .as_array()
            .map(|aliases| {
                aliases.iter().any(|alias| {
                    alias["name"]
                        .as_str()
                        .map(|value| normalized_artist_name(value) == normalized_query)
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);

    (primary_exact, alternate_exact)
}

fn pick_artist_id(results: &[Value], query_name: &str) -> Option<String> {
    let normalized_query = normalized_artist_name(query_name);
    if normalized_query.is_empty() {
        return None;
    }

    results
        .iter()
        .filter_map(|artist| {
            let id = artist["id"].as_str()?.to_string();
            let score = artist["score"].as_i64().unwrap_or(0);
            if score < 75 {
                return None;
            }

            let (primary_exact, alternate_exact) = artist_matches_query(artist, &normalized_query);
            if !primary_exact && !alternate_exact {
                return None;
            }

            let type_rank = artist_type_rank(artist["type"].as_str());
            Some((primary_exact, alternate_exact, type_rank, score, id))
        })
        .max_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| right.2.cmp(&left.2))
                .then_with(|| left.3.cmp(&right.3))
        })
        .map(|(_, _, _, _, id)| id)
}

async fn lookup_artist_relations(
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<Vec<Value>>> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    // Throttle MusicBrainz traffic; release before hitting other hosts.
    let mbid = {
        let _permit = mb_permit().await;
        let query = format!("artist:\"{}\"", escape_query(trimmed));
        let url = format!(
            "https://musicbrainz.org/ws/2/artist/?query={}&fmt=json&limit=10",
            urlencoding::encode(&query)
        );
        let resp: Value = client
            .get(&url)
            .send()
            .await
            .context("musicbrainz search failed")?
            .error_for_status()
            .context("musicbrainz search returned non-2xx")?
            .json()
            .await
            .context("musicbrainz search response invalid")?;

        let results = resp["artists"].as_array().cloned().unwrap_or_default();
        let Some(matched_id) = pick_artist_id(&results, trimmed) else {
            return Ok(None);
        };
        matched_id
    };

    let relations: Vec<Value> = {
        let _permit = mb_permit().await;
        let url = format!(
            "https://musicbrainz.org/ws/2/artist/{}?inc=url-rels&fmt=json",
            mbid
        );
        let resp: Value = client
            .get(&url)
            .send()
            .await
            .context("musicbrainz lookup failed")?
            .error_for_status()
            .context("musicbrainz lookup returned non-2xx")?
            .json()
            .await
            .context("musicbrainz lookup response invalid")?;
        resp["relations"].as_array().cloned().unwrap_or_default()
    };

    Ok(Some(relations))
}

async fn wikipedia_title_from_relations(
    client: &reqwest::Client,
    relations: &[Value],
) -> Result<Option<String>> {
    let mut wikipedia_title = relations.iter().find_map(|rel| {
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

    if wikipedia_title.is_none() {
        let qid = relations.iter().find_map(|rel| {
            if rel["type"] == "wikidata" {
                rel["url"]["resource"]
                    .as_str()
                    .and_then(|url| url.rsplit('/').next())
                    .map(|value| value.to_string())
            } else {
                None
            }
        });

        if let Some(qid) = qid.filter(|value| value.starts_with('Q')) {
            let url = format!(
                "https://www.wikidata.org/wiki/Special:EntityData/{}.json",
                qid
            );
            let resp: Value = client
                .get(&url)
                .send()
                .await
                .context("wikidata lookup failed")?
                .error_for_status()
                .context("wikidata lookup returned non-2xx")?
                .json()
                .await
                .context("wikidata response invalid")?;

            wikipedia_title = resp
                .pointer(&format!("/entities/{}/sitelinks/enwiki/title", qid))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
        }
    }

    Ok(wikipedia_title)
}

async fn wikipedia_summary(client: &reqwest::Client, title: &str) -> Result<Value> {
    let path = title.replace(' ', "_");
    let url = format!(
        "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
        urlencoding::encode(&path)
    );
    client
        .get(&url)
        .send()
        .await
        .context("wikipedia summary fetch failed")?
        .error_for_status()
        .context("wikipedia summary returned non-2xx")?
        .json()
        .await
        .context("wikipedia summary invalid")
}

fn wikipedia_image_url(summary: &Value) -> Option<String> {
    summary
        .pointer("/thumbnail/source")
        .and_then(|value| value.as_str())
        .or_else(|| {
            summary
                .pointer("/originalimage/source")
                .and_then(|value| value.as_str())
        })
        .map(|value| value.to_string())
}

pub async fn fetch_artist_image(name: &str) -> Result<Option<ArtistImage>> {
    let client = http_client()?;
    let Some(relations) = lookup_artist_relations(&client, name).await? else {
        return Ok(None);
    };

    // 1) Direct image relation if present
    for rel in &relations {
        if rel["type"] == "image" {
            if let Some(url) = rel["url"]["resource"].as_str() {
                if let Some(commons_url) = commons_thumbnail_from_page(url) {
                    return Ok(Some(ArtistImage {
                        url: commons_url,
                        source: "musicbrainz".into(),
                    }));
                }
            }
        }
    }

    // 2) Wikidata relation -> P18 (image filename) on Wikidata -> Commons file path
    let wikidata_qid = relations.iter().find_map(|rel| {
        if rel["type"] == "wikidata" {
            rel["url"]["resource"]
                .as_str()
                .and_then(|s| s.rsplit('/').next())
                .map(|s| s.to_string())
        } else {
            None
        }
    });

    if let Some(qid) = wikidata_qid.filter(|q| q.starts_with('Q')) {
        let url = format!(
            "https://www.wikidata.org/wiki/Special:EntityData/{}.json",
            qid
        );
        let resp: Value = client
            .get(&url)
            .send()
            .await
            .context("wikidata lookup failed")?
            .error_for_status()
            .context("wikidata lookup returned non-2xx")?
            .json()
            .await
            .context("wikidata response invalid")?;

        let filename = resp
            .pointer(&format!(
                "/entities/{}/claims/P18/0/mainsnak/datavalue/value",
                qid
            ))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        if let Some(filename) = filename {
            let encoded = urlencoding::encode(&filename);
            let url = format!(
                "https://commons.wikimedia.org/wiki/Special:FilePath/{}?width=480",
                encoded
            );
            return Ok(Some(ArtistImage {
                url,
                source: "wikidata".into(),
            }));
        }
    }

    if let Some(title) = wikipedia_title_from_relations(&client, &relations).await? {
        let summary = wikipedia_summary(&client, &title).await?;
        if let Some(url) = wikipedia_image_url(&summary) {
            return Ok(Some(ArtistImage {
                url,
                source: "wikipedia".into(),
            }));
        }
    }

    Ok(None)
}

pub async fn fetch_artist_info(name: &str) -> Result<Option<ArtistInfo>> {
    let client = http_client()?;
    let Some(relations) = lookup_artist_relations(&client, name).await? else {
        return Ok(None);
    };
    let Some(title) = wikipedia_title_from_relations(&client, &relations).await? else {
        return Ok(None);
    };

    let resp = wikipedia_summary(&client, &title).await?;

    let description = resp["extract"].as_str().map(|value| value.to_string());
    let source_url = resp
        .pointer("/content_urls/desktop/page")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());

    if description.is_some() || source_url.is_some() {
        return Ok(Some(ArtistInfo {
            description,
            source_url,
            source: "wikipedia".into(),
        }));
    }

    Ok(None)
}

// If MusicBrainz hands us a Wikimedia Commons "File:..." page URL, turn it
// into a direct thumbnail URL.
fn commons_thumbnail_from_page(page_url: &str) -> Option<String> {
    let needle = "/wiki/File:";
    if let Some(idx) = page_url.find(needle) {
        let filename = &page_url[idx + needle.len()..];
        return Some(format!(
            "https://commons.wikimedia.org/wiki/Special:FilePath/{}?width=480",
            filename
        ));
    }
    if page_url.starts_with("https://commons.wikimedia.org/") {
        return Some(page_url.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_artist_names_for_exact_matching() {
        assert_eq!(normalized_artist_name(" Anna K. "), "anna k");
        assert_eq!(normalized_artist_name("J.K. Rowling"), "j k rowling");
        assert_eq!(normalized_artist_name("AC/DC"), "ac dc");
    }

    #[test]
    fn prefers_exact_artist_name_over_higher_scoring_loose_match() {
        let results = vec![
            json!({
                "id": "rowling-id",
                "name": "J.K. Rowling",
                "sort-name": "Rowling, J. K.",
                "score": 100,
                "type": "Person"
            }),
            json!({
                "id": "anna-id",
                "name": "Anna K",
                "sort-name": "K, Anna",
                "score": 92,
                "type": "Person"
            }),
        ];

        assert_eq!(pick_artist_id(&results, "Anna K"), Some("anna-id".to_string()));
    }

    #[test]
    fn accepts_exact_alias_matches() {
        let results = vec![json!({
            "id": "anna-id",
            "name": "Lucianna Krecarová",
            "sort-name": "Krecarová, Lucianna",
            "score": 90,
            "type": "Person",
            "aliases": [
                { "name": "Anna K." }
            ]
        })];

        assert_eq!(pick_artist_id(&results, "Anna K"), Some("anna-id".to_string()));
    }

    #[test]
    fn rejects_non_exact_ambiguous_matches() {
        let results = vec![json!({
            "id": "rowling-id",
            "name": "J.K. Rowling",
            "sort-name": "Rowling, J. K.",
            "score": 100,
            "type": "Person"
        })];

        assert_eq!(pick_artist_id(&results, "Anna K"), None);
    }

    #[test]
    fn prefers_thumbnail_from_wikipedia_summary() {
        let summary = json!({
            "thumbnail": {
                "source": "https://upload.wikimedia.org/thumb/example.jpg"
            },
            "originalimage": {
                "source": "https://upload.wikimedia.org/example.jpg"
            }
        });

        assert_eq!(
            wikipedia_image_url(&summary),
            Some("https://upload.wikimedia.org/thumb/example.jpg".to_string())
        );
    }

    #[test]
    fn falls_back_to_original_wikipedia_image() {
        let summary = json!({
            "originalimage": {
                "source": "https://upload.wikimedia.org/example.jpg"
            }
        });

        assert_eq!(
            wikipedia_image_url(&summary),
            Some("https://upload.wikimedia.org/example.jpg".to_string())
        );
    }
}
