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
use serde_json::json;
use tauri::{AppHandle, Emitter};

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

pub struct MpvController {
    socket_path: PathBuf,
    playlist_path: PathBuf,
    child: Option<Child>,
    #[allow(dead_code)]
    app_handle: Option<AppHandle>,
    #[allow(dead_code)]
    listener_active: Arc<AtomicBool>,
}

impl MpvController {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            playlist_path: socket_path.with_extension("m3u8"),
            socket_path,
            child: None,
            app_handle: None,
            listener_active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    pub fn play(&mut self, path: &str) -> Result<()> {
        let mut stream = self.connect_or_spawn()?;
        self.send(&mut stream, json!({ "command": ["loadfile", path, "replace"] }))
    }

    pub fn play_queue(&mut self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.write_playlist(paths)?;
        let mut stream = self.connect_or_spawn()?;
        let playlist_path = self.playlist_path.to_string_lossy().to_string();
        self.send(&mut stream, json!({ "command": ["loadlist", playlist_path, "replace"] }))
    }

    pub fn pause(&mut self) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.send(&mut stream, json!({ "command": ["set_property", "pause", true] }))
    }

    pub fn resume(&mut self) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.send(&mut stream, json!({ "command": ["set_property", "pause", false] }))
    }

    pub fn stop(&mut self) -> Result<()> {
        let mut stream = self.connect_existing()?;
        self.send(&mut stream, json!({ "command": ["stop"] }))
    }

    pub fn seek_to(&mut self, position_seconds: f64) -> Result<()> {
        let mut stream = self.connect_existing()?;
        let clamped = position_seconds.max(0.0);
        self.send(&mut stream, json!({ "command": ["seek", clamped, "absolute+exact"] }))
    }

    fn connect_or_spawn(&mut self) -> Result<UnixStream> {
        self.refresh_child_state()?;

        if !self.socket_path.exists() {
            self.spawn_mpv()?;
        }

        UnixStream::connect(&self.socket_path).or_else(|_| {
            let _ = fs::remove_file(&self.socket_path);
            self.spawn_mpv()?;
            UnixStream::connect(&self.socket_path).context("Unable to connect to mpv IPC socket")
        })
    }

    fn connect_existing(&mut self) -> Result<UnixStream> {
        self.refresh_child_state()?;

        if !self.socket_path.exists() {
            bail!("No active playback session")
        }

        UnixStream::connect(&self.socket_path).context("Unable to connect to mpv IPC socket")
    }

    fn send(&self, stream: &mut UnixStream, payload: serde_json::Value) -> Result<()> {
        stream.write_all(payload.to_string().as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        Ok(())
    }

    fn write_playlist(&self, paths: &[String]) -> Result<()> {
        let mut playlist = String::new();
        for path in paths {
            playlist.push_str(path);
            playlist.push('\n');
        }
        fs::write(&self.playlist_path, playlist)
            .with_context(|| format!("Failed to write playlist at {}", self.playlist_path.display()))
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
    let _ = writer.flush();

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("event").and_then(|v| v.as_str()) == Some("property-change") {
            let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let data = value.get("data").cloned().unwrap_or(serde_json::Value::Null);
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
