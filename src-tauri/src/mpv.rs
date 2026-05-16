use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::models::{AudioDevice, EqualizerPreset, PlaybackSession, PlaybackState, RepeatMode};

// Global registry of mpv child PIDs so any code path (signal handler,
// graceful shutdown, Drop) can reliably terminate them.
fn mpv_pids() -> &'static Mutex<Vec<u32>> {
    static PIDS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
    PIDS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn register_mpv_pid(pid: u32) {
    if let Ok(mut guard) = mpv_pids().lock() {
        guard.push(pid);
    }
}

pub fn unregister_mpv_pid(pid: u32) {
    if let Ok(mut guard) = mpv_pids().lock() {
        guard.retain(|&p| p != pid);
    }
}

pub fn kill_all_mpv() {
    let pids: Vec<u32> = mpv_pids()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    for pid in pids {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    if let Ok(mut guard) = mpv_pids().lock() {
        guard.clear();
    }

    // Nuclear option: shell out to pkill so we catch any mpv we spawned this
    // session that may have been forgotten (e.g. lost across hot reloads in
    // dev). Pattern matches our exact spawn arguments so we don't kill an
    // unrelated mpv the user might be running.
    let _ = std::process::Command::new("pkill")
        .args(["-f", "mpv --idle=yes --force-window=no --no-video"])
        .status();
}

const MPV_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/mpv",
    "/usr/local/bin/mpv",
    "/opt/local/bin/mpv",
    "/usr/bin/mpv",
    "mpv",
];
const DEFAULT_VOLUME_PERCENT: u8 = 80;

pub struct MpvController {
    socket_path: PathBuf,
    playlist_path: PathBuf,
    child: Option<Child>,
    equalizer_preset: EqualizerPreset,
    equalizer_bands: [f32; 10],
    track_gain_db: Option<f32>,
    keep_gain_filter: bool,
    #[allow(dead_code)]
    app_handle: Option<AppHandle>,
    #[allow(dead_code)]
    listener_active: Arc<AtomicBool>,
}

impl MpvController {
    pub fn new(
        socket_path: PathBuf,
        equalizer_preset: EqualizerPreset,
        equalizer_bands: [f32; 10],
    ) -> Self {
        Self {
            playlist_path: socket_path.with_extension("m3u8"),
            socket_path,
            child: None,
            equalizer_preset,
            equalizer_bands,
            track_gain_db: None,
            keep_gain_filter: false,
            app_handle: None,
            listener_active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    pub fn set_equalizer(&mut self, preset: EqualizerPreset, bands: [f32; 10]) -> Result<()> {
        if self.equalizer_preset == preset && self.equalizer_bands == bands {
            return Ok(());
        }
        self.equalizer_preset = preset;
        self.equalizer_bands = bands;
        self.refresh_child_state()?;

        if !self.socket_path.exists() {
            return Ok(());
        }

        let mut stream = UnixStream::connect(&self.socket_path)
            .context("Unable to connect to mpv IPC socket")?;
        self.apply_audio_filters(&mut stream)
    }

    pub fn set_track_gain_db(
        &mut self,
        gain_db: Option<f32>,
        keep_gain_filter: bool,
    ) -> Result<()> {
        let normalized_gain = normalize_track_gain(gain_db);
        let gain_changed = self.track_gain_db != normalized_gain;
        let keep_changed = self.keep_gain_filter != keep_gain_filter;
        if !gain_changed && !keep_changed {
            return Ok(());
        }
        self.track_gain_db = normalized_gain;
        self.keep_gain_filter = keep_gain_filter;
        self.refresh_child_state()?;

        if !self.socket_path.exists() {
            return Ok(());
        }

        let mut stream = UnixStream::connect(&self.socket_path)
            .context("Unable to connect to mpv IPC socket")?;
        if gain_changed && !keep_changed && self.try_update_gain_filter(&mut stream).is_ok() {
            return Ok(());
        }

        self.apply_audio_filters(&mut stream)
    }

    pub fn current_path(&mut self) -> Result<Option<String>> {
        self.refresh_child_state()?;

        if !self.socket_path.exists() {
            return Ok(None);
        }

        let mut stream = UnixStream::connect(&self.socket_path)
            .context("Unable to connect to mpv IPC socket")?;
        self.start_listener();
        self.property::<Option<String>>(&mut stream, "path")
    }

    pub fn play(&mut self, path: &str) -> Result<()> {
        let mut stream = self.connect_or_spawn()?;
        self.send(
            &mut stream,
            json!({ "command": ["loadfile", path, "replace"] }),
        )?;
        self.send(
            &mut stream,
            json!({ "command": ["set_property", "pause", false] }),
        )
    }

    pub fn play_queue(&mut self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.write_playlist(paths)?;
        let mut stream = self.connect_or_spawn()?;
        let playlist_path = self.playlist_path.to_string_lossy().to_string();
        self.send(
            &mut stream,
            json!({ "command": ["loadlist", playlist_path, "replace"] }),
        )?;
        self.send(
            &mut stream,
            json!({ "command": ["set_property", "pause", false] }),
        )
    }

    pub fn sync_playback_session(&mut self, session: &PlaybackSession) -> Result<()> {
        let paths: Vec<String> = session
            .queue_paths
            .iter()
            .filter(|path| is_playable_source(path))
            .cloned()
            .collect();

        if paths.is_empty() {
            return self.stop_if_active();
        }

        self.write_playlist(&paths)?;
        let mut stream = self.connect_or_spawn()?;
        let playlist_path = self.playlist_path.to_string_lossy().to_string();
        let target_index = session.current_index.min(paths.len().saturating_sub(1));

        self.request(
            &mut stream,
            json!({ "command": ["loadlist", playlist_path, "replace"] }),
        )?;
        if target_index > 0 {
            self.request(
                &mut stream,
                json!({ "command": ["set_property", "playlist-pos", target_index] }),
            )?;
        }
        self.apply_repeat_mode(&mut stream, &session.repeat_mode)?;

        if session.position_seconds > 0.0 {
            self.request(
                &mut stream,
                json!({ "command": ["seek", session.position_seconds.max(0.0), "absolute+exact"] }),
            )?;
        }

        self.request(
            &mut stream,
            json!({ "command": ["set_property", "pause", session.paused] }),
        )
        .map(|_| ())
    }

    pub fn play_queue_index(&mut self, index: usize) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.request(
            &mut stream,
            json!({ "command": ["set_property", "playlist-pos", index] }),
        )?;
        self.request(
            &mut stream,
            json!({ "command": ["set_property", "pause", false] }),
        )
        .map(|_| ())
    }

    pub fn append_queue(&mut self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.write_playlist(paths)?;
        let mut stream = self.connect_existing()?;
        let playlist_path = self.playlist_path.to_string_lossy().to_string();
        self.request(
            &mut stream,
            json!({ "command": ["loadlist", playlist_path, "append"] }),
        )
        .map(|_| ())
    }

    pub fn insert_queue_at(&mut self, paths: &[String], index: usize) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.write_playlist(paths)?;
        let mut stream = self.connect_existing()?;
        let playlist_path = self.playlist_path.to_string_lossy().to_string();
        self.request(
            &mut stream,
            json!({ "command": ["loadlist", playlist_path, "insert-at", index] }),
        )
        .map(|_| ())
    }

    pub fn remove_queue_index(&mut self, index: usize) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.request(
            &mut stream,
            json!({ "command": ["playlist-remove", index] }),
        )
        .map(|_| ())
    }

    pub fn move_queue_index(&mut self, from_index: usize, to_index: usize) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.request(
            &mut stream,
            json!({ "command": ["playlist-move", from_index, to_index] }),
        )
        .map(|_| ())
    }

    pub fn clear_queue(&mut self) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.request(&mut stream, json!({ "command": ["playlist-clear"] }))
            .map(|_| ())
    }

    pub fn pause(&mut self) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.send(
            &mut stream,
            json!({ "command": ["set_property", "pause", true] }),
        )
    }

    pub fn resume(&mut self) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.send(
            &mut stream,
            json!({ "command": ["set_property", "pause", false] }),
        )
    }

    pub fn stop(&mut self) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.send(&mut stream, json!({ "command": ["stop"] }))
    }

    pub fn seek_to(&mut self, position_seconds: f64) -> Result<()> {
        let mut stream = self.connect_existing()?;
        let clamped = position_seconds.max(0.0);
        self.send(
            &mut stream,
            json!({ "command": ["seek", clamped, "absolute+exact"] }),
        )
    }

    pub fn playback_state(&mut self) -> Result<PlaybackState> {
        let mut stream = self.connect_or_spawn()?;
        Ok(PlaybackState {
            volume: self
                .property::<f64>(&mut stream, "volume")?
                .clamp(0.0, 100.0),
            muted: self.property::<bool>(&mut stream, "mute")?,
            audio_device: self
                .property::<Option<String>>(&mut stream, "audio-device")?
                .unwrap_or_else(|| "auto".to_string()),
            audio_devices: self.audio_devices(&mut stream)?,
        })
    }

    pub fn set_volume(&mut self, volume_percent: f64) -> Result<()> {
        let mut stream = self.connect_or_spawn()?;
        let clamped = volume_percent.clamp(0.0, 100.0);
        self.send(
            &mut stream,
            json!({ "command": ["set_property", "volume", clamped] }),
        )
    }

    pub fn set_muted(&mut self, muted: bool) -> Result<()> {
        let mut stream = self.connect_or_spawn()?;
        self.send(
            &mut stream,
            json!({ "command": ["set_property", "mute", muted] }),
        )
    }

    pub fn set_audio_device(&mut self, device_name: &str) -> Result<()> {
        let mut stream = self.connect_or_spawn()?;
        self.send(
            &mut stream,
            json!({ "command": ["set_property", "audio-device", device_name] }),
        )
    }

    pub fn set_repeat_mode(&mut self, repeat_mode: &RepeatMode) -> Result<()> {
        let mut stream = self.connect_or_spawn()?;
        self.apply_repeat_mode(&mut stream, repeat_mode)
    }

    fn connect_or_spawn(&mut self) -> Result<UnixStream> {
        self.refresh_child_state()?;

        if !self.socket_path.exists() {
            self.spawn_mpv()?;
        }

        let mut stream = UnixStream::connect(&self.socket_path).or_else(|_| {
            let _ = fs::remove_file(&self.socket_path);
            self.spawn_mpv()?;
            UnixStream::connect(&self.socket_path).context("Unable to connect to mpv IPC socket")
        })?;

        self.start_listener();
        self.apply_audio_filters(&mut stream)?;

        Ok(stream)
    }

    fn connect_existing(&mut self) -> Result<UnixStream> {
        self.refresh_child_state()?;

        if !self.socket_path.exists() {
            bail!("No active playback session")
        }

        let stream = UnixStream::connect(&self.socket_path)
            .context("Unable to connect to mpv IPC socket")?;
        self.start_listener();
        Ok(stream)
    }

    fn stop_if_active(&mut self) -> Result<()> {
        self.refresh_child_state()?;
        if !self.socket_path.exists() {
            return Ok(());
        }

        let mut stream = UnixStream::connect(&self.socket_path)
            .context("Unable to connect to mpv IPC socket")?;
        self.start_listener();
        self.send(&mut stream, json!({ "command": ["stop"] }))
    }

    fn apply_repeat_mode(&self, stream: &mut UnixStream, repeat_mode: &RepeatMode) -> Result<()> {
        let (loop_file, loop_playlist) = match repeat_mode {
            RepeatMode::Off => ("no", "no"),
            RepeatMode::One => ("inf", "no"),
            RepeatMode::All => ("no", "inf"),
        };

        self.send(
            stream,
            json!({ "command": ["set_property", "loop-file", loop_file] }),
        )?;
        self.send(
            stream,
            json!({ "command": ["set_property", "loop-playlist", loop_playlist] }),
        )
    }

    fn apply_audio_filters(&self, stream: &mut UnixStream) -> Result<()> {
        let command = match audio_filter_value(
            self.track_gain_db,
            self.keep_gain_filter,
            &self.equalizer_preset,
            &self.equalizer_bands,
        ) {
            Some(graph) => json!({ "command": ["set_property", "af", format!("lavfi=[{graph}]")] }),
            None => json!({ "command": ["set_property", "af", []] }),
        };
        self.request(stream, command).map(|_| ())
    }

    fn try_update_gain_filter(&self, stream: &mut UnixStream) -> Result<()> {
        let gain_expression = match self.track_gain_db {
            Some(gain_db) => format!("{gain_db:.2}dB"),
            None => "0.00dB".to_string(),
        };
        self.request(
            stream,
            json!({
                "command": [
                    "af-command",
                    "needle_filters",
                    "volume",
                    gain_expression,
                    "volume@needle_gain"
                ]
            }),
        )
        .map(|_| ())
    }

    fn send(&self, stream: &mut UnixStream, payload: serde_json::Value) -> Result<()> {
        stream.write_all(payload.to_string().as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        Ok(())
    }

    fn request(
        &self,
        stream: &mut UnixStream,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.send(stream, payload)?;

        let mut reader = BufReader::new(
            stream
                .try_clone()
                .context("Unable to clone mpv IPC stream for response")?,
        );
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .context("Unable to read mpv IPC response")?;

        if line.trim().is_empty() {
            bail!("mpv returned an empty IPC response")
        }

        let value: serde_json::Value =
            serde_json::from_str(&line).context("Unable to decode mpv IPC response")?;

        match value.get("error").and_then(|error| error.as_str()) {
            Some("success") | None => {}
            Some(error) => bail!("mpv IPC error: {error}"),
        }

        Ok(value
            .get("data")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    fn property<T: DeserializeOwned>(&self, stream: &mut UnixStream, name: &str) -> Result<T> {
        let data = self.request(stream, json!({ "command": ["get_property", name] }))?;
        serde_json::from_value(data)
            .with_context(|| format!("Unable to parse mpv property `{name}`"))
    }

    fn audio_devices(&self, stream: &mut UnixStream) -> Result<Vec<AudioDevice>> {
        let mut devices = self.property::<Vec<AudioDevice>>(stream, "audio-device-list")?;
        if !devices.iter().any(|device| device.name == "auto") {
            devices.insert(
                0,
                AudioDevice {
                    name: "auto".to_string(),
                    description: "System default".to_string(),
                },
            );
        }
        Ok(devices)
    }

    fn write_playlist(&self, paths: &[String]) -> Result<()> {
        let mut playlist = String::new();
        for path in paths {
            playlist.push_str(path);
            playlist.push('\n');
        }
        fs::write(&self.playlist_path, playlist).with_context(|| {
            format!(
                "Failed to write playlist at {}",
                self.playlist_path.display()
            )
        })
    }

    fn spawn_mpv(&mut self) -> Result<()> {
        if self.socket_path.exists() {
            let _ = fs::remove_file(&self.socket_path);
        }

        let binary = resolve_mpv_binary().context(
            "mpv was not found. Install it with `brew install mpv` (Apple Silicon) and restart the app.",
        )?;

        let child = Command::new(&binary)
            .arg("--idle=yes")
            .arg("--force-window=no")
            .arg("--no-video")
            // Albums and live recordings need real continuous handoffs between
            // playlist entries, so opt into full gapless mode and warm the next
            // entry before the current one ends.
            .arg("--gapless-audio=yes")
            .arg("--prefetch-playlist=yes")
            .arg(format!("--volume={DEFAULT_VOLUME_PERCENT}"))
            .arg(format!("--input-ipc-server={}", self.socket_path.display()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("Failed to launch mpv at {}", binary.display()))?;

        register_mpv_pid(child.id());
        self.child = Some(child);

        let start = Instant::now();
        while !self.socket_path.exists() {
            if start.elapsed() > Duration::from_secs(3) {
                bail!("mpv IPC socket was not created")
            }
            thread::sleep(Duration::from_millis(50));
        }

        self.start_listener();

        Ok(())
    }

    #[allow(dead_code)]
    fn start_listener(&mut self) {
        if self.listener_active.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(handle) = self.app_handle.clone() else {
            self.listener_active.store(false, Ordering::SeqCst);
            return;
        };
        let socket = self.socket_path.clone();
        let active = self.listener_active.clone();

        thread::spawn(move || {
            run_property_listener(socket, handle);
            active.store(false, Ordering::SeqCst);
        });
    }

    pub fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            unregister_mpv_pid(pid);
        }
        if self.socket_path.exists() {
            let _ = fs::remove_file(&self.socket_path);
        }
        if self.playlist_path.exists() {
            let _ = fs::remove_file(&self.playlist_path);
        }
    }

    fn refresh_child_state(&mut self) -> Result<()> {
        if let Some(child) = self.child.as_mut() {
            if child.try_wait()?.is_some() {
                self.child = None;
                if self.socket_path.exists() {
                    let _ = fs::remove_file(&self.socket_path);
                }
            }
        }

        Ok(())
    }
}

fn is_playable_source(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://") || Path::new(value).exists()
}

impl Drop for MpvController {
    fn drop(&mut self) {
        self.shutdown();
        kill_all_mpv();
    }
}

#[allow(dead_code)]
fn run_property_listener(socket_path: PathBuf, app: AppHandle) {
    let stream = match UnixStream::connect(&socket_path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let writer_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut writer = writer_stream;

    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 1, "path"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 2, "pause"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 3, "time-pos"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 4, "duration"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 5, "volume"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 6, "mute"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 7, "audio-device"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 8, "audio-device-list"]})
    );
    let _ = writeln!(
        writer,
        "{}",
        json!({"command": ["observe_property", 9, "idle-active"]})
    );
    let _ = writer.flush();

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("event").and_then(|v| v.as_str()) == Some("property-change") {
            let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let data = value
                .get("data")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let _ = app.emit(
                "mpv-property",
                serde_json::json!({ "name": name, "data": data }),
            );
        }
    }
}

fn resolve_mpv_binary() -> Option<PathBuf> {
    for candidate in MPV_CANDIDATES {
        let path = Path::new(candidate);
        if path.is_absolute() {
            if path.exists() {
                return Some(path.to_path_buf());
            }
            continue;
        }

        if Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return Some(PathBuf::from(candidate));
        }
    }

    None
}

fn audio_filter_value(
    track_gain_db: Option<f32>,
    keep_gain_filter: bool,
    preset: &EqualizerPreset,
    manual_bands: &[f32; 10],
) -> Option<String> {
    let mut filters = vec![];
    if keep_gain_filter || normalize_track_gain(track_gain_db).is_some() {
        let gain_db = normalize_track_gain(track_gain_db).unwrap_or(0.0);
        filters.push(format!(
            "volume@needle_gain=volume={gain_db:.2}dB:precision=float:eval=once"
        ));
    }
    if let Some(graph) = equalizer_filter_value(preset, manual_bands) {
        filters.push(graph);
    }
    if filters.is_empty() {
        None
    } else {
        Some(filters.join(","))
    }
}

fn equalizer_filter_value(preset: &EqualizerPreset, manual_bands: &[f32; 10]) -> Option<String> {
    let bands = match preset {
        EqualizerPreset::Flat => return None,
        EqualizerPreset::BassBoost => [2.3, 2.6, 2.2, 1.4, 0.5, 0.0, 0.0, -0.2, -0.3, 0.0],
        EqualizerPreset::BassTrebleBoost => [2.4, 2.7, 2.3, 1.3, 0.2, -0.2, 0.5, 1.4, 2.1, 1.7],
        EqualizerPreset::Vocal => [-0.8, -0.6, -0.3, 0.2, 1.0, 1.8, 2.2, 1.0, 0.4, -0.2],
        EqualizerPreset::TrebleBoost => [-0.3, -0.2, 0.0, 0.0, 0.3, 0.9, 1.6, 2.2, 2.5, 1.4],
        EqualizerPreset::Lounge => [1.2, 1.4, 1.0, 0.5, 0.2, -0.3, -0.8, -0.2, 0.2, 0.4],
        EqualizerPreset::Manual => *manual_bands,
    };

    let frequencies = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    let max_gain = bands.iter().copied().fold(0.0_f32, f32::max).max(0.0);
    let preamp = -(max_gain * 0.3).min(1.5);

    let mut entries = vec![format!("entry(0,{:.1})", bands[0])];
    for (frequency, gain) in frequencies.iter().zip(bands.iter()) {
        entries.push(format!("entry({frequency},{gain:.1})"));
    }
    entries.push(format!("entry(20000,{:.1})", bands[bands.len() - 1]));

    Some(format!(
        "volume={preamp:.1}dB,firequalizer=gain_entry='{}':delay=0.05:accuracy=4:zero_phase=on",
        entries.join(";")
    ))
}

fn normalize_track_gain(gain_db: Option<f32>) -> Option<f32> {
    gain_db.and_then(|value| {
        if value.is_finite() && value.abs() >= 0.05 {
            Some(value.clamp(-24.0, 24.0))
        } else {
            None
        }
    })
}
