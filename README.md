# Resonance

A local-first, hi-fi music player for macOS built with **Tauri**, **React + TypeScript**, and **Rust**. Audio playback is handled by **mpv** through its JSON IPC, so lossless formats (FLAC, ALAC, WAV, AIFF) sound exactly the way they should.

> Status: early scaffold — playable, browsable, and looking like a real music app, with a clear path toward queueing, gapless playback, and a working equalizer.

## Features

### Library
- **Local library** stored in SQLite under the OS app-data directory
- **Folder import** with recursive scan of FLAC, ALAC, WAV, AIFF, M4A, AAC, MP3, OGG, Opus
- **Tag extraction** via `lofty`: title, artist, album, track number, **genre**, **year**, sample rate, bit depth
- **Hidden files ignored** — dotfiles and dot-directories are skipped during scan
- **Maintenance command** rescans your folders for changes and purges any dotfile entries from the library (never touches your audio files)
- **Diff-based rescans** preserve `added_at` and play history across maintenance runs
- **Per-folder removal** straight from the sidebar

### Dashboard
- **Time-of-day greeting** with library summary, or "Still spinning…" when something's playing
- **Quick actions**: Shuffle play · Add folder · Maintenance
- **Recently added albums** sorted by newest tracks with relative timestamps (Today / 3d ago / 2w ago…)
- **Made for you** auto-playlists generated from your library:
  - **Most played** & **Recently played** (from real play history)
  - **Decade × Genre** mixes (e.g. `90s · Rock`)
  - **Best of {Genre}** for top genres
  - **{Decade} mix** when genre data is sparse
  - **Quick hits** (under 3 min), **Deep listens** (≥8 min), **Wind down** (long ambient/classical/jazz/etc.)
  - **Audiophile session** (FLAC/ALAC or 24-bit / ≥88.2 kHz)
- **Featured albums** & **Top artists** rows
- **Quick picks** — random tracks playable in one click

### Playback
- **mpv backend** for bit-perfect lossless playback through JSON IPC
- **Real playlist queues**: play album · shuffle artist · play all Quick picks · shuffle a Made-for-you playlist — mpv auto-advances through the queue
- **Hover ▶ on the dashboard**: album cards (Recently added & Featured), artist tiles, and a "Play all" button on Quick picks
- **Per-track play counts** and `last_played_at` recorded automatically
- **Now-playing bar** with cover, metadata, transport controls, and audio quality readout
- **Robust shutdown**: mpv is killed whenever the app exits via Drop, Tauri's exit event, *and* a SIGINT/SIGTERM/SIGHUP handler — with a `pkill` fallback so playback can never outlive the app
- Album art
  - sidecar files first: `cover.{jpg,png,webp}`, `folder.*`, `front.*`, `album.*`, `albumart.*`, `artwork.*`
  - falls back to embedded artwork via `lofty`
  - cached in-memory on the frontend

### Artist portraits
- Pulled for free via **MusicBrainz → Wikidata → Wikimedia Commons**
- No API keys required; polite User-Agent + 1 req/sec serialization
- Cached in SQLite (`artist_images`) for 30 days, including misses so we don't keep hammering the API
- Graceful fallback to a gradient initial when no portrait is found

### Views
- **Dashboard** (default landing screen)
- **Tracks** with live search and filterable by album / artist / playlist
- **Albums** (cards with cover art)
- **Artists** (list with track counts)
- **Settings** with theme switcher, equalizer presets, and maintenance

### Themes & UX
- **Themes**: System, Light, Dark
- **Equalizer presets** (UI only for now — DSP wiring through mpv is the next milestone)

## Architecture

```
┌──────────────────────────┐         IPC         ┌──────────────────────┐
│ React + TS frontend      │◀──── Tauri ────────▶│ Rust backend         │
│  - Dashboard / views     │                     │  - SQLite library    │
│  - Auto-playlists        │                     │  - Folder scanner    │
│  - Cover art hook        │                     │  - Cover extractor   │
│  - Player controls       │                     │  - Play history      │
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
- `src/lib/artistImage.ts` — artist portrait hook with module-level cache
- `src/lib/playlists.ts` — auto-playlist generators from tags + heuristics
- `src/styles.css` — full theming + layout
- `src-tauri/src/lib.rs` — Tauri command surface and app setup
- `src-tauri/src/db.rs` — SQLite schema, migrations, library/playback persistence, artist-image cache
- `src-tauri/src/library.rs` — folder scanner, dotfile filter, metadata via `lofty`
- `src-tauri/src/cover.rs` — sidecar + embedded cover-art extraction
- `src-tauri/src/artist.rs` — MusicBrainz → Wikidata → Commons artist portrait lookup
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

## Auto-playlists & metadata

Resonance generates auto-playlists from data we already have, no machine learning required:

- **Tags** (genre, year) drive era and genre playlists
- **Duration** drives mood-ish buckets (Quick hits, Deep listens, Wind down)
- **Format / sample rate / bit depth** drives the Audiophile session
- **Play history** (`play_count`, `last_played_at`) drives Most played and Recently played
- **`added_at`** (preserved across rescans) drives the Recently added albums row

Real **BPM and key analysis** would unlock proper mood detection (energy, workout, slow groove). It's tractable in Rust via onset-detection / autocorrelation, but it's CPU-heavy and best done as an opt-in background "Analyze library" maintenance step. Tracked in the roadmap.

## Roadmap

- BPM + key analysis as an opt-in background step, with cached `audio_features` table
- Wire equalizer presets through mpv audio filters
- Queue / now-playing list
- Seek bar + playback progress + volume control
- Gapless playback hand-off
- Watch folders with incremental rescans
- User-curated playlists alongside auto-playlists
- Smarter sidecar handling (hidden FLAC metadata files, `.cue` sheets)
- Proper macOS / Windows / Linux icon set

## License

Currently unpublished personal project. License TBD.
