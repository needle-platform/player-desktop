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

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(10))
        .build()
        .context("Failed to build HTTP client")
}

pub async fn fetch_artist_image(name: &str) -> Result<Option<ArtistImage>> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let client = http_client()?;

    // Throttle MusicBrainz traffic; release before hitting other hosts.
    let mbid = {
        let _permit = mb_permit().await;
        let url = format!(
            "https://musicbrainz.org/ws/2/artist/?query=artist:{}&fmt=json&limit=1",
            urlencoding::encode(trimmed)
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

        let result = resp["artists"]
            .as_array()
            .and_then(|arr| arr.first())
            .cloned();
        let Some(top) = result else {
            return Ok(None);
        };
        // Light sanity check: the search hit should at least loosely match the requested name.
        let hit_name = top["name"].as_str().unwrap_or("").to_lowercase();
        if hit_name != trimmed.to_lowercase() && top["score"].as_i64().unwrap_or(0) < 90 {
            return Ok(None);
        }
        match top["id"].as_str() {
            Some(id) => id.to_string(),
            None => return Ok(None),
        }
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
