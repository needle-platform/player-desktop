use std::{fs, path::Path};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lofty::{
    picture::MimeType,
    prelude::TaggedFileExt,
    probe::Probe,
};
use serde::Serialize;

const SIDECAR_NAMES: &[&str] = &[
    "cover", "folder", "front", "album", "albumart", "artwork",
];
const SIDECAR_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

#[derive(Debug, Clone, Serialize)]
pub struct CoverArt {
    pub data_url: String,
    pub source: String,
}

pub fn find_cover_for(track_path: &Path) -> Result<Option<CoverArt>> {
    if let Some(parent) = track_path.parent() {
        if let Some(found) = find_sidecar(parent)? {
            return Ok(Some(found));
        }
    }

    extract_embedded(track_path)
}

fn find_sidecar(dir: &Path) -> Result<Option<CoverArt>> {
    if !dir.is_dir() {
        return Ok(None);
    }

    let entries: Vec<_> = fs::read_dir(dir)
        .with_context(|| format!("read_dir failed for {}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .collect();

    for name in SIDECAR_NAMES {
        for ext in SIDECAR_EXTS {
            for entry in &entries {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }

                let stem = path
                    .file_stem()
                    .and_then(|v| v.to_str())
                    .map(|v| v.to_ascii_lowercase());
                let extension = path
                    .extension()
                    .and_then(|v| v.to_str())
                    .map(|v| v.to_ascii_lowercase());

                if stem.as_deref() == Some(*name) && extension.as_deref() == Some(*ext) {
                    let bytes = fs::read(&path)
                        .with_context(|| format!("read failed for {}", path.display()))?;
                    return Ok(Some(CoverArt {
                        data_url: encode_data_url(mime_for_ext(ext), &bytes),
                        source: "sidecar".to_string(),
                    }));
                }
            }
        }
    }

    Ok(None)
}

fn extract_embedded(path: &Path) -> Result<Option<CoverArt>> {
    let tagged = match Probe::open(path).and_then(|probe| probe.read()) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };

    let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(tag) => tag,
        None => return Ok(None),
    };

    let picture = match tag.pictures().first() {
        Some(picture) => picture,
        None => return Ok(None),
    };

    let mime = match picture.mime_type() {
        Some(MimeType::Jpeg) => "image/jpeg",
        Some(MimeType::Png) => "image/png",
        Some(MimeType::Gif) => "image/gif",
        Some(MimeType::Bmp) => "image/bmp",
        Some(MimeType::Tiff) => "image/tiff",
        _ => "image/jpeg",
    };

    Ok(Some(CoverArt {
        data_url: encode_data_url(mime, picture.data()),
        source: "embedded".to_string(),
    }))
}

fn encode_data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", mime, BASE64.encode(bytes))
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}
