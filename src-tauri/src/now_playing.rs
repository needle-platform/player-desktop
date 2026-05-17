use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use std::ffi::CString;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_seconds: Option<f64>,
    pub elapsed_seconds: Option<f64>,
    pub playing: bool,
    pub artwork_data_url: Option<String>,
    pub preserve_artwork: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingPlayback {
    pub duration_seconds: Option<f64>,
    pub elapsed_seconds: Option<f64>,
    pub playing: bool,
}

pub fn update_metadata(metadata: NowPlayingMetadata) -> Result<()> {
    if metadata.title.trim().is_empty() {
        clear();
        return Ok(());
    }

    let title = cstring(metadata.title)?;
    let artist = optional_cstring(metadata.artist)?;
    let album = optional_cstring(metadata.album)?;
    let artwork = metadata
        .artwork_data_url
        .as_deref()
        .and_then(decode_data_url);

    platform_update_metadata(
        &title,
        artist.as_ref(),
        album.as_ref(),
        metadata.duration_seconds.unwrap_or(0.0).max(0.0),
        metadata.elapsed_seconds.unwrap_or(0.0).max(0.0),
        playback_rate(metadata.playing),
        artwork.as_deref(),
    );
    Ok(())
}

pub fn update_playback(playback: NowPlayingPlayback) {
    platform_update_playback(
        playback.duration_seconds.unwrap_or(0.0).max(0.0),
        playback.elapsed_seconds.unwrap_or(0.0).max(0.0),
        playback_rate(playback.playing),
    );
}

pub fn clear() {
    platform_clear();
}

fn playback_rate(playing: bool) -> f64 {
    if playing {
        1.0
    } else {
        0.0
    }
}

fn cstring(value: String) -> Result<CString> {
    CString::new(value).map_err(|_| anyhow!("Now Playing metadata cannot contain NUL bytes"))
}

fn optional_cstring(value: Option<String>) -> Result<Option<CString>> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(cstring)
        .transpose()
}

fn decode_data_url(value: &str) -> Option<Vec<u8>> {
    let (_, encoded) = value.split_once(";base64,")?;
    BASE64.decode(encoded).ok()
}

pub fn artwork_bytes_from_data_url(value: &str) -> Option<(Vec<u8>, &'static str)> {
    let (header, _) = value.split_once(";base64,")?;
    let extension = if header.eq_ignore_ascii_case("data:image/png") {
        "png"
    } else if header.eq_ignore_ascii_case("data:image/webp") {
        "webp"
    } else {
        "jpg"
    };
    decode_data_url(value).map(|bytes| (bytes, extension))
}

#[cfg(target_os = "macos")]
fn platform_update_metadata(
    title: &CString,
    artist: Option<&CString>,
    album: Option<&CString>,
    duration_seconds: f64,
    elapsed_seconds: f64,
    playback_rate: f64,
    artwork: Option<&[u8]>,
) {
    unsafe {
        needle_now_playing_update(
            title.as_ptr(),
            artist.map_or(std::ptr::null(), |value| value.as_ptr()),
            album.map_or(std::ptr::null(), |value| value.as_ptr()),
            duration_seconds,
            elapsed_seconds,
            playback_rate,
            artwork.map_or(std::ptr::null(), |bytes| bytes.as_ptr()),
            artwork.map_or(0, |bytes| bytes.len()),
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn platform_update_metadata(
    _title: &CString,
    _artist: Option<&CString>,
    _album: Option<&CString>,
    _duration_seconds: f64,
    _elapsed_seconds: f64,
    _playback_rate: f64,
    _artwork: Option<&[u8]>,
) {
}

#[cfg(target_os = "macos")]
fn platform_update_playback(duration_seconds: f64, elapsed_seconds: f64, playback_rate: f64) {
    unsafe {
        needle_now_playing_update_playback(duration_seconds, elapsed_seconds, playback_rate);
    }
}

#[cfg(not(target_os = "macos"))]
fn platform_update_playback(_duration_seconds: f64, _elapsed_seconds: f64, _playback_rate: f64) {}

#[cfg(target_os = "macos")]
fn platform_clear() {
    unsafe {
        needle_now_playing_clear();
    }
}

#[cfg(not(target_os = "macos"))]
fn platform_clear() {}

#[cfg(target_os = "macos")]
extern "C" {
    fn needle_now_playing_update(
        title: *const std::ffi::c_char,
        artist: *const std::ffi::c_char,
        album: *const std::ffi::c_char,
        duration_seconds: f64,
        elapsed_seconds: f64,
        playback_rate: f64,
        artwork_bytes: *const u8,
        artwork_length: usize,
    );
    fn needle_now_playing_update_playback(
        duration_seconds: f64,
        elapsed_seconds: f64,
        playback_rate: f64,
    );
    fn needle_now_playing_clear();
}
