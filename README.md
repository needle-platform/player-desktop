# Resonance

A local-first, hi-fi music player for macOS built with **Tauri**, **React + TypeScript**, and **Rust**. Audio playback is handled by **mpv** through its JSON IPC, so lossless formats (FLAC, ALAC, WAV, AIFF) sound exactly the way they should.

> Status: early scaffold — playable, browsable, and looking like a real music app, with a clear path toward queueing, gapless playback, and a working equalizer.

## Features

- **Local library** stored in SQLite under the OS app-data directory
- **Folder import** with recursive scan of FLAC, ALAC, WAV, AIFF, M4A, AAC, MP3, OGG, Opus
- **Hidden files ignored** — dotfiles and dot-directories are skipped during scan
- **Maintenance command** rescans your folders for changes and purges any dotfile entries from the library (never touches your audio files)
- **Per-folder removal** straight from the sidebar
- **Album art**
  - sidecar files first: `cover.{jpg,png,webp}`, `folder.*`, `front.*`, `album.*`, `albumart.*`, `artwork.*`
  - falls back to embedded artwork via `lofty`
  - cached in-memory on the frontend
- **Views**: Tracks (with live search), Albums (cards), Artists, Settings
- **Now-playing bar** with cover, metadata, transport controls, and audio quality readout
- **Themes**: System, Light, Dark
- **Equalizer presets** (UI only for now — DSP wiring through mpv is the next milestone)

## Architecture

```
┌──────────────────────────┐         IPC         ┌──────────────────────┐
│ React + TS frontend      │◀──── Tauri ────────▶│ Rust backend         │
│  - Sidebar / views       │                     │  - SQLite library    │
│  - Cover art hook        │                     │  - Folder scanner    │
│  - Player controls       │                     │  - Cover extractor   │
└──────────────────────────┘                     │  - mpv controller    │
                                                 └──────────┬───────────┘
                                                            │  Unix socket
                                                            ▼
                                                       ┌─────────┐
                                                       │  mpv    │
                                                       └─────────┘
```

### Key files

- `src/App.tsx` — UI, layout, routing-by-state
- `src/lib/tauri.ts` — typed wrappers around all Tauri commands
- `src/lib/cover.ts` — cover-art hook with module-level cache
- `src/styles.css` — full theming + layout
- `src-tauri/src/lib.rs` — Tauri command surface and app setup
- `src-tauri/src/db.rs` — SQLite schema, settings, library roots, tracks
- `src-tauri/src/library.rs` — folder scanner, dotfile filter, metadata via `lofty`
- `src-tauri/src/cover.rs` — sidecar + embedded cover-art extraction
- `src-tauri/src/mpv.rs` — IPC controller, spawns mpv with `--no-video --idle=yes`

## Requirements

- **Node.js** 18+
- **Rust** (stable) with the Tauri toolchain set up
- **mpv** installed and reachable

```bash
brew install mpv
```

The app will look for mpv at `/opt/homebrew/bin/mpv`, `/usr/local/bin/mpv`, `/opt/local/bin/mpv`, `/usr/bin/mpv`, then fall back to whatever `mpv` resolves to on `PATH`.

## Development

```bash
npm install
npm run tauri dev
```

Build a production bundle:

```bash
npm run tauri build
```

## Data locations

- **Library DB**: `library.sqlite` inside the OS app-data dir for the bundle id `com.davidrelich.musicplayer`
- **mpv IPC socket**: `mpv.sock` in the same directory

Maintenance and remove-folder actions only touch the database — your audio files are never modified or deleted.

## Roadmap

- Wire equalizer presets through mpv audio filters
- Queue / now-playing list
- Seek bar + playback progress + volume control
- Gapless playback hand-off
- Watch folders with incremental rescans
- Smarter sidecar handling (hidden FLAC metadata files, `.cue` sheets)
- Proper macOS / Windows / Linux icon set

## License

Currently unpublished personal project. License TBD.
