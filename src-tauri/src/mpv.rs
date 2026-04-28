use std::{
    fs,
    io::Write,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde_json::json;

const MPV_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/mpv",
    "/usr/local/bin/mpv",
    "/opt/local/bin/mpv",
    "/usr/bin/mpv",
    "mpv",
];

pub struct MpvController {
    socket_path: PathBuf,
    child: Option<Child>,
}

impl MpvController {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            child: None,
        }
    }

    pub fn play(&mut self, path: &str) -> Result<()> {
        let mut stream = self.connect_or_spawn()?;
        self.send(&mut stream, json!({ "command": ["loadfile", path, "replace"] }))
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

        self.child = Some(child);

        let start = Instant::now();
        while !self.socket_path.exists() {
            if start.elapsed() > Duration::from_secs(3) {
                bail!("mpv IPC socket was not created")
            }
            thread::sleep(Duration::from_millis(50));
        }

        Ok(())
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
