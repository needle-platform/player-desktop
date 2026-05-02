use std::path::Path;

use anyhow::Result;
use lofty::{
    prelude::{Accessor, AudioFile, TaggedFileExt},
    probe::Probe,
    tag::ItemKey,
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
            .then(left.disc_number.cmp(&right.disc_number))
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
    let mut album_artist = None;
    let mut duration_seconds = None;
    let mut sample_rate = None;
    let mut bit_depth = None;
    let mut disc_number = None;
    let mut track_number = None;
    let mut genre = None;
    let mut is_vinyl_rip = false;
    let mut year = None;

    if let Ok(tagged_file) = Probe::open(path).and_then(|probe| probe.read()) {
        let properties = tagged_file.properties();
        duration_seconds = Some(properties.duration().as_secs());
        sample_rate = properties.sample_rate();
        bit_depth = properties.bit_depth();

        if let Some(tag) = tagged_file
            .primary_tag()
            .or_else(|| tagged_file.first_tag())
        {
            if let Some(value) = tag.title() {
                title = value.to_string();
            }
            artist = tag.artist().map(|value| value.to_string());
            album = tag.album().map(|value| value.to_string());
            album_artist = tag
                .get_string(&ItemKey::AlbumArtist)
                .map(|value| value.to_string());
            disc_number = tag.disk().map(|value| value as i64);
            track_number = tag.track().map(|value| value as i64);
            genre = tag.genre().map(|value| value.to_string());
            is_vinyl_rip = tag_marks_vinyl_rip(tag);
            year = tag.year().map(|value| value as i64);
        }
    }

    let (inferred_disc_number, inferred_track_number) = infer_disc_and_track(path);
    if disc_number.is_none() {
        disc_number = inferred_disc_number;
    }
    if track_number.is_none() {
        track_number = inferred_track_number;
    }

    Track {
        id: 0,
        path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        album_artist,
        duration_seconds,
        format: path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_uppercase()),
        sample_rate,
        bit_depth,
        disc_number,
        track_number,
        genre,
        primary_genre: None,
        is_vinyl_rip,
        year,
        added_at: None,
        play_count: 0,
        last_played_at: None,
        rating: None,
    }
}

fn tag_marks_vinyl_rip(tag: &lofty::tag::Tag) -> bool {
    tag.items().any(|item| {
        let matches_key = match item.key() {
            ItemKey::PodcastKeywords | ItemKey::Comment => true,
            ItemKey::Unknown(key) => {
                let normalized = key.trim().to_ascii_lowercase();
                normalized == "tags" || normalized == "tag" || normalized == "keywords"
            }
            _ => false,
        };

        matches_key && item.value().text().is_some_and(value_marks_vinyl_rip)
    })
}

fn value_marks_vinyl_rip(value: &str) -> bool {
    value
        .split(|ch| matches!(ch, ',' | ';' | '/' | '|'))
        .map(str::trim)
        .any(|part| {
            let normalized = part.to_ascii_lowercase();
            matches!(
                normalized.as_str(),
                "vinyl" | "vinyl-rip" | "needledrop" | "needle-drop"
            )
        })
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

fn infer_disc_and_track(path: &Path) -> (Option<i64>, Option<i64>) {
    let disc_number = path
        .ancestors()
        .skip(1)
        .filter_map(|ancestor| ancestor.file_name().and_then(|value| value.to_str()))
        .find_map(parse_disc_hint);

    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let file_numbers = parse_disc_track_prefix(stem);

    let inferred_disc = disc_number.or(file_numbers.map(|(disc, _)| disc));
    let inferred_track = file_numbers
        .map(|(_, track)| track)
        .or_else(|| parse_track_prefix(stem));

    (inferred_disc, inferred_track)
}

fn parse_disc_hint(input: &str) -> Option<i64> {
    let lower = input.to_ascii_lowercase();
    for marker in ["disc", "disk", "cd"] {
        if let Some(index) = lower.find(marker) {
            let suffix = &lower[index + marker.len()..];
            if let Some(number) = leading_number(suffix) {
                return Some(number);
            }
        }
    }
    None
}

fn parse_disc_track_prefix(input: &str) -> Option<(i64, i64)> {
    let mut chars = input.chars().peekable();
    let disc = take_number(&mut chars)?;
    match chars.peek() {
        Some('-') | Some('_') | Some('.') | Some(' ') => {
            chars.next();
        }
        _ => return None,
    }
    let track = take_number(&mut chars)?;
    Some((disc, track))
}

fn parse_track_prefix(input: &str) -> Option<i64> {
    leading_number(input)
}

fn leading_number(input: &str) -> Option<i64> {
    let mut chars = input.chars().peekable();
    take_number(&mut chars)
}

fn take_number<I>(chars: &mut std::iter::Peekable<I>) -> Option<i64>
where
    I: Iterator<Item = char>,
{
    while matches!(chars.peek(), Some(ch) if ch.is_whitespace()) {
        chars.next();
    }

    let mut value = String::new();
    while matches!(chars.peek(), Some(ch) if ch.is_ascii_digit()) {
        if let Some(ch) = chars.next() {
            value.push(ch);
        }
    }

    if value.is_empty() {
        None
    } else {
        value.parse::<i64>().ok()
    }
}
