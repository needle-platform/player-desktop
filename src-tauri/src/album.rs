use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Semaphore;

const USER_AGENT: &str =
    "Resonance/0.1 (https://gitea.davidrelich.com/davidrelich/music-player)";

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
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

pub async fn fetch_album_info(
    album: &str,
    artist: Option<&str>,
) -> Result<Option<AlbumInfo>> {
    let album = album.trim();
    if album.is_empty() {
        return Ok(None);
    }

    let client = http_client()?;

    // 1) Search MusicBrainz release-group for "album" + optional "artist".
    let query = match artist {
        Some(artist) if !artist.trim().is_empty() => format!(
            "releasegroup:\"{}\" AND artist:\"{}\"",
            escape_query(album),
            escape_query(artist.trim())
        ),
        _ => format!("releasegroup:\"{}\"", escape_query(album)),
    };

    let mbid = {
        let _permit = mb_permit().await;
        let url = format!(
            "https://musicbrainz.org/ws/2/release-group/?query={}&fmt=json&limit=1",
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

        let top = resp["release-groups"]
            .as_array()
            .and_then(|arr| arr.first())
            .cloned();
        let Some(top) = top else {
            return Ok(None);
        };
        if top["score"].as_i64().unwrap_or(0) < 80 {
            return Ok(None);
        }
        match top["id"].as_str() {
            Some(id) => id.to_string(),
            None => return Ok(None),
        }
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

    Ok(None)
}
