use std::{fs::File, io::Read, path::Path};

use anyhow::Result;
use lofty::{
    config::WriteOptions,
    file::TaggedFileExt,
    prelude::{Accessor, AudioFile},
    probe::Probe,
    tag::{ItemKey, Tag},
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

pub fn read_track(path: &Path) -> Track {
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
    let mut bpm = None;
    let mut genre = None;
    let mut source_tags = Vec::new();
    let mut is_vinyl_rip = false;
    let mut year = None;

    if let Ok(tagged_file) = Probe::open(path).and_then(|probe| probe.read()) {
        let properties = tagged_file.properties();
        duration_seconds = Some(properties.duration().as_secs());
        sample_rate = properties.sample_rate();
        bit_depth = properties.bit_depth();
        if sample_rate.is_none() || bit_depth.is_none() {
            if let Some((flac_sample_rate, flac_bit_depth)) = read_flac_stream_info(path) {
                sample_rate = sample_rate.or(flac_sample_rate);
                bit_depth = bit_depth.or(flac_bit_depth);
            }
        }

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
            bpm = read_bpm(tag);
            if bit_depth.is_none() {
                bit_depth = read_bit_depth(tag);
            }
            genre = tag.genre().map(|value| value.to_string());
            source_tags = read_source_tags(tag);
            is_vinyl_rip = tag_marks_vinyl_rip(tag);
            if is_vinyl_rip
                && !source_tags
                    .iter()
                    .any(|value| source_tag_marks_vinyl(value))
            {
                source_tags.push("vinyl".to_string());
            }
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
        id: "0".to_string(),
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
        bpm,
        bpm_overridden: false,
        genre,
        primary_genre: None,
        source_tags,
        is_vinyl_rip,
        year,
        added_at: None,
        play_count: 0,
        last_played_at: None,
        is_favorite: false,
        rating: None,
    }
}

pub fn write_track_genre(path: &Path, genre: Option<&str>) -> Result<Track> {
    let mut tagged_file = Probe::open(path)?.read()?;
    let normalized = genre.map(str::trim).filter(|value| !value.is_empty());
    let tag = editable_tag(&mut tagged_file);

    match normalized {
        Some(value) => tag.set_genre(value.to_string()),
        None => tag.remove_genre(),
    }

    tagged_file.save_to_path(path, WriteOptions::default())?;
    Ok(read_track(path))
}

pub fn write_track_bpm(path: &Path, bpm: Option<i64>) -> Result<Track> {
    let mut tagged_file = Probe::open(path)?.read()?;
    let tag = editable_tag(&mut tagged_file);
    tag.take(&ItemKey::Bpm).for_each(drop);
    tag.take(&ItemKey::IntegerBpm).for_each(drop);

    if let Some(value) = bpm.filter(|value| *value > 0) {
        if !tag.insert_text(ItemKey::IntegerBpm, value.to_string()) {
            let _ = tag.insert_text(ItemKey::Bpm, value.to_string());
        }
    }

    tagged_file.save_to_path(path, WriteOptions::default())?;
    Ok(read_track(path))
}

pub fn write_track_source_tags(path: &Path, source_tags: &[String]) -> Result<Track> {
    let mut tagged_file = Probe::open(path)?.read()?;
    let normalized = normalize_source_tags(source_tags.iter().map(String::as_str));
    let tag = editable_tag(&mut tagged_file);

    for key in source_tag_item_keys() {
        tag.take(&key).for_each(drop);
    }

    if !normalized.is_empty() {
        let _ = tag.insert_text(ItemKey::Unknown("TAGS".to_string()), normalized.join("; "));
    }

    tagged_file.save_to_path(path, WriteOptions::default())?;
    Ok(read_track(path))
}

fn editable_tag(tagged_file: &mut lofty::file::TaggedFile) -> &mut Tag {
    if tagged_file.primary_tag().is_none() && tagged_file.first_tag().is_none() {
        tagged_file.insert_tag(Tag::new(tagged_file.primary_tag_type()));
    }

    let primary_tag_type = tagged_file.primary_tag_type();
    let has_primary_tag = tagged_file.primary_tag().is_some();

    if has_primary_tag {
        tagged_file
            .tag_mut(primary_tag_type)
            .expect("primary tag should be available after insertion")
    } else {
        tagged_file
            .first_tag_mut()
            .expect("tagged file should provide a tag after insertion")
    }
}

fn read_bpm(tag: &lofty::tag::Tag) -> Option<i64> {
    tag.get_string(&ItemKey::Bpm)
        .or_else(|| tag.get_string(&ItemKey::IntegerBpm))
        .and_then(parse_bpm_value)
}

fn read_bit_depth(tag: &Tag) -> Option<u8> {
    tag.items().find_map(|item| {
        let matches_key = match item.key() {
            ItemKey::Unknown(key) => {
                let normalized = normalize_tag_key(key);
                matches!(
                    normalized.as_str(),
                    "bitdepth" | "bit_depth" | "bit_depths" | "bits_per_sample" | "bitspersample"
                )
            }
            _ => false,
        };

        matches_key
            .then(|| item.value().text())
            .flatten()
            .and_then(parse_bit_depth_value)
    })
}

fn read_flac_stream_info(path: &Path) -> Option<(Option<u32>, Option<u8>)> {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("flac"))
    {
        return None;
    }

    let mut file = File::open(path).ok()?;
    let mut marker = [0_u8; 4];
    file.read_exact(&mut marker).ok()?;
    if &marker != b"fLaC" {
        return None;
    }

    loop {
        let mut header = [0_u8; 4];
        file.read_exact(&mut header).ok()?;
        let is_last = header[0] & 0x80 != 0;
        let block_type = header[0] & 0x7f;
        let length =
            ((header[1] as usize) << 16) | ((header[2] as usize) << 8) | header[3] as usize;

        if block_type == 0 {
            if length < 18 {
                return None;
            }
            let mut stream_info = vec![0_u8; length];
            file.read_exact(&mut stream_info).ok()?;
            let packed = u64::from_be_bytes(stream_info[10..18].try_into().ok()?);
            let sample_rate = ((packed >> 44) & 0x000f_ffff) as u32;
            let bit_depth = (((packed >> 36) & 0x1f) as u8).saturating_add(1);
            return Some((
                (sample_rate > 0).then_some(sample_rate),
                (bit_depth > 1).then_some(bit_depth),
            ));
        }

        let mut skip = vec![0_u8; length];
        file.read_exact(&mut skip).ok()?;
        if is_last {
            return None;
        }
    }
}

fn normalize_tag_key(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn parse_bit_depth_value(value: &str) -> Option<u8> {
    let numeric: String = value
        .trim()
        .chars()
        .skip_while(|ch| !ch.is_ascii_digit())
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    numeric
        .parse::<u8>()
        .ok()
        .filter(|value| (1..=64).contains(value))
}

fn parse_bpm_value(value: &str) -> Option<i64> {
    let numeric: String = value
        .trim()
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || matches!(ch, '.' | ','))
        .collect();
    if numeric.is_empty() {
        return None;
    }

    numeric
        .replace(',', ".")
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.round() as i64)
        .filter(|value| *value > 0)
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

fn read_source_tags(tag: &Tag) -> Vec<String> {
    let mut raw_tags: Vec<String> = Vec::new();
    for item in tag.items() {
        if !source_tag_item_key_matches(item.key()) {
            continue;
        }
        if let Some(value) = item.value().text() {
            raw_tags.extend(split_source_tag_value(value));
        }
    }
    normalize_source_tags(raw_tags.iter().map(String::as_str))
}

fn split_source_tag_value(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(|ch| matches!(ch, ',' | ';' | '/' | '|' | '\n'))
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .filter(|part| !part.is_empty())
}

fn normalize_source_tags<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut tags = Vec::new();
    for value in values {
        let normalized = normalize_source_tag_label(value);
        if normalized.is_empty() {
            continue;
        }
        if !tags
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&normalized))
        {
            tags.push(normalized);
        }
    }
    tags
}

fn normalize_source_tag_label(value: &str) -> String {
    let normalized = value
        .trim()
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let lower = normalized.to_ascii_lowercase();
    match lower.as_str() {
        "vinyl" | "vinyl rip" | "needledrop" | "needle drop" => "vinyl-rip".to_string(),
        "cd" | "cd rip" => "cd-rip".to_string(),
        "flac" | "alac" | "wav" | "aiff" | "aif" | "aac" | "mp3" | "ogg" | "opus" => {
            lower.to_ascii_uppercase()
        }
        "digital purchase" | "download" | "digital download" => "digital-purchase".to_string(),
        _ => lower.replace(' ', "-"),
    }
}

fn source_tag_item_key_matches(key: &ItemKey) -> bool {
    match key {
        ItemKey::PodcastKeywords => true,
        ItemKey::Unknown(key) => {
            let normalized = key.trim().to_ascii_lowercase();
            matches!(
                normalized.as_str(),
                "tags" | "tag" | "keywords" | "source" | "media_source" | "release_source"
            )
        }
        _ => false,
    }
}

fn source_tag_item_keys() -> Vec<ItemKey> {
    vec![
        ItemKey::PodcastKeywords,
        ItemKey::Unknown("TAGS".to_string()),
        ItemKey::Unknown("Tags".to_string()),
        ItemKey::Unknown("tags".to_string()),
        ItemKey::Unknown("TAG".to_string()),
        ItemKey::Unknown("Tag".to_string()),
        ItemKey::Unknown("tag".to_string()),
        ItemKey::Unknown("KEYWORDS".to_string()),
        ItemKey::Unknown("Keywords".to_string()),
        ItemKey::Unknown("keywords".to_string()),
        ItemKey::Unknown("SOURCE".to_string()),
        ItemKey::Unknown("Source".to_string()),
        ItemKey::Unknown("source".to_string()),
        ItemKey::Unknown("MEDIA_SOURCE".to_string()),
        ItemKey::Unknown("media_source".to_string()),
        ItemKey::Unknown("RELEASE_SOURCE".to_string()),
        ItemKey::Unknown("release_source".to_string()),
    ]
}

fn source_tag_marks_vinyl(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "vinyl" | "vinyl rip" | "vinyl-rip" | "needledrop" | "needle drop" | "needle-drop"
    )
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
