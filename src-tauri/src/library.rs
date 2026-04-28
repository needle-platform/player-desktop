use std::path::Path;

use anyhow::Result;
use lofty::{
    prelude::{Accessor, AudioFile, TaggedFileExt},
    probe::Probe,
};
use walkdir::{DirEntry, WalkDir};

use crate::models::Track;

pub fn scan_folder(folder: &str) -> Result<Vec<Track>> {
    let mut tracks = Vec::new();

    for entry in WalkDir::new(folder)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_hidden_entry(entry))
        .filter_map(|entry| entry.ok())
    {
        let path = entry.path();
        if !path.is_file() || is_hidden_path(path) || !is_supported_audio_file(path) {
            continue;
        }

        tracks.push(read_track(path));
    }

    tracks.sort_by(|left, right| {
        left.artist
            .cmp(&right.artist)
            .then(left.album.cmp(&right.album))
            .then(left.track_number.cmp(&right.track_number))
            .then(left.title.cmp(&right.title))
            .then(left.path.cmp(&right.path))
    });

    Ok(tracks)
}

fn read_track(path: &Path) -> Track {
    let inferred_title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.display().to_string());

    let mut title = inferred_title.clone();
    let mut artist = None;
    let mut album = None;
    let mut duration_seconds = None;
    let mut sample_rate = None;
    let mut bit_depth = None;
    let mut track_number = None;

    if let Ok(tagged_file) = Probe::open(path).and_then(|probe| probe.read()) {
        let properties = tagged_file.properties();
        duration_seconds = Some(properties.duration().as_secs());
        sample_rate = properties.sample_rate();
        bit_depth = properties.bit_depth();

        if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
            if let Some(value) = tag.title() {
                title = value.to_string();
            }
            artist = tag.artist().map(|value| value.to_string());
            album = tag.album().map(|value| value.to_string());
            track_number = tag.track().map(|value| value as i64);
        }
    }

    Track {
        id: 0,
        path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        duration_seconds,
        format: path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_uppercase()),
        sample_rate,
        bit_depth,
        track_number,
    }
}

fn is_supported_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "flac" | "wav" | "aiff" | "aif" | "alac" | "m4a" | "aac" | "mp3" | "ogg" | "opus"
            )
        })
        .unwrap_or(false)
}

fn is_hidden_entry(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|value| value.starts_with('.'))
        .unwrap_or(false)
}

fn is_hidden_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.starts_with('.'))
        .unwrap_or(false)
}
