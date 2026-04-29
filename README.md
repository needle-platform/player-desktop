# Needle

A local-first, hi-fi music player for macOS built with **Tauri**, **React + TypeScript**, and **Rust**. Audio playback is handled by **mpv** through its JSON IPC, so lossless formats (FLAC, ALAC, WAV, AIFF) sound exactly the way they should.

> Status: actively usable local-first player — library, queue, saved playlists, playback persistence, and equalizer are all in place, with smart playlists and deeper library tooling continuing to grow.

## Features

### Library
- **Local library** stored in SQLite under the OS app-data directory
- **Folder import** with recursive scan of FLAC, ALAC, WAV, AIFF, M4A, AAC, MP3, OGG, Opus
- **Tag extraction** via `lofty`: title, artist, album, track number, **genre**, **year**, sample rate, bit depth
- **Hidden files ignored** — dotfiles and dot-directories are skipped during scan
- **Maintenance command** rescans your folders for changes and purges any dotfile entries from the library (never touches your audio files)
- **Diff-based rescans** preserve `added_at` and play history across maintenance runs
- **Per-folder removal** from Settings

### Dashboard
- **Time-of-day greeting** with library summary, or a **Now spinning** hero when something's playing
- **Hero now-playing treatment** with an animated vinyl indicator, center-label album art, and album artwork stretched across the top dashboard band
- **Idle dashboard backdrop** from bundled artwork when nothing is playing, so the hero stays readable instead of falling back to empty white space
- **Quick actions**: Shuffle play · Add folder · Maintenance
- **Recently added albums** sorted by newest tracks with relative timestamps (Today / 3d ago / 2w ago…)
- **From your library** recommendations grounded in your own listening history and collection metadata:
  - **Most played** & **Recently played** (from real play history)
  - **Needs a first spin** for unplayed tracks still waiting in the library
  - **Rediscover** for tracks you played before but have not visited in a while
  - **From your top genre** for one focused genre mix instead of a wall of auto-generated buckets
- **Featured albums** & **Top artists** rows
- **Quick picks** — random tracks playable in one click

### Playback
- **mpv backend** for bit-perfect lossless playback through JSON IPC
- **Real Up Next queue** with visible current item, album covers, queue counts, and click-outside dismiss
- **Queue actions everywhere they matter**: Play next · Add to queue · album-level Play next / Add to queue
- **Queue editing**: reorder, remove individual items, clear upcoming tracks, direct jump to any queued track
- **Queue-aware playback**: play album · shuffle artist · play all Quick picks · shuffle a From-your-library playlist — mpv auto-advances through the queue
- **Playback persistence** restores queue, selected track, repeat mode, shuffle state, and last position between launches
- **Safe relaunch behavior** restores the last session in a stopped state, never surprise-autoplays on app launch
- **Repeat modes**: off · one · all
- **Shuffle state** is visible and persistent
- **Hover ▶ on the dashboard**: album cards (Recently added & Featured), artist tiles, and a "Play all" button on Quick picks
- **Per-track play counts** and `last_played_at` recorded automatically
- **Now-playing bar** with cover, metadata, transport controls, seek/progress scrubbing, volume + mute, and output-device selection — synced to actual mpv track changes during queue playback
- **Safer startup volume** defaults to 80% to reduce surprise-blast playback on first launch
- **Animated current-track indicator** in both the main track list and the album track list
- **Robust shutdown**: mpv is killed whenever the app exits via Drop, Tauri's exit event, *and* a SIGINT/SIGTERM/SIGHUP handler — with a `pkill` fallback so playback can never outlive the app
- Album art
  - sidecar files first: `cover.{jpg,png,webp}`, `folder.*`, `front.*`, `album.*`, `albumart.*`, `artwork.*`
  - falls back to embedded artwork via `lofty`
  - cached in-memory on the frontend

### Playlists
- **Sidebar Playlists section** with saved playlists and smart playlists
- **Manual playlists** stored in SQLite and editable in-app
- **Save visible track sets** from the Tracks view or album pages as playlists
- **Playlist management**: rename, delete, reorder tracks, remove tracks
- **Smart playlists** surfaced as first-class library views generated from your collection and listening history

### Artist portraits
- Pulled for free via **MusicBrainz → Wikidata → Wikimedia Commons**
- No API keys required; polite User-Agent + 1 req/sec serialization
- Cached in SQLite (`artist_images`) for 30 days, including misses so we don't keep hammering the API
- Graceful fallback to a gradient initial when no portrait is found

### Views
- **Dashboard** (default landing screen)
- **Tracks** with live search and filterable by album / artist / playlist
- **Albums** (cards with cover art)
- **Album detail page** with hero artwork, metadata, play/shuffle actions, full track list, and background album info when available
- **Artists** (list with track counts)
- **Settings** with theme switcher, library folders, maintenance, live equalizer presets, and manual 10-band EQ

### Album info
- **Background album notes** pulled via **MusicBrainz release-group → Wikidata → Wikipedia**
- Cached in SQLite (`album_info`) so repeat opens are instant and we avoid repeat lookups
- **Album page genres** are derived from the imported track tags already embedded in your files; we currently do not fetch canonical album genres from Wikipedia / MusicBrainz
- Graceful fallback when no article exists for obscure releases, compilations, or local-only metadata

### Themes & UX
- **Themes**: System, Light, Dark
- **Theme-aware branding** with separate light/dark app icons and a dock-tuned macOS icon set
- **Equalizer presets** wired through **mpv** audio filters: Flat, Bass Boost, Vocal, Treble Boost, Lounge
- **Manual 10-band EQ** with preset curve visualization; manual slider edits are applied on release to avoid playback stutter

## Architecture

```
┌──────────────────────────┐         IPC         ┌──────────────────────┐
│ React + TS frontend      │◀──── Tauri ────────▶│ Rust backend         │
│  - Dashboard / views     │                     │  - SQLite library    │
│  - Queue + playlists     │                     │  - Folder scanner    │
│  - Cover art hook        │                     │  - Cover extractor   │
│  - Player controls       │                     │  - Play history      │
│  - Session restore       │                     │  - Playlist storage  │
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
- `src/lib/albumInfo.ts` — album-info hook with module-level cache
- `src/lib/playlists.ts` — auto-playlist generators from tags + heuristics
- `src/styles.css` — full theming + layout
- `src-tauri/src/lib.rs` — Tauri command surface and app setup
- `src-tauri/src/db.rs` — SQLite schema, migrations, library/playback persistence, saved playlists, artist-image cache, album-info cache
- `src-tauri/src/library.rs` — folder scanner, dotfile filter, metadata via `lofty`
- `src-tauri/src/cover.rs` — sidecar + embedded cover-art extraction
- `src-tauri/src/artist.rs` — MusicBrainz → Wikidata → Commons artist portrait lookup
- `src-tauri/src/album.rs` — MusicBrainz → Wikidata → Wikipedia album lookup
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

- **Library DB**: `library.sqlite` inside the OS app-data dir for the bundle id `com.davidrelich.needle`
- **mpv IPC socket**: `mpv.sock` in the same directory

On first launch after the rename from `Resonance`, Needle copies the existing database and SQLite sidecar files forward from the legacy app-data directory under `com.davidrelich.musicplayer`.

Maintenance and remove-folder actions only touch the database — your audio files are never modified or deleted.

## Auto-playlists & metadata

Needle generates dashboard recommendations and smart-playlist views from data we already have, no machine learning required:

- **Play history** (`play_count`, `last_played_at`) drives Most played, Recently played, and Rediscover
- **Library state** (`play_count = 0`) drives Needs a first spin
- **Tags** (genre) drive one top-genre mix when your collection has a clear favorite
- **`added_at`** (preserved across rescans) drives the Recently added albums row

Real **BPM and key analysis** would unlock proper mood detection (energy, workout, slow groove). It's tractable in Rust via onset-detection / autocorrelation, but it's CPU-heavy and best done as an opt-in background "Analyze library" maintenance step. Tracked in the roadmap.

## Roadmap

- BPM + key analysis as an opt-in background step, with cached `audio_features` table
- Gapless playback hand-off
- Watch folders with incremental rescans
- Add tracks/albums to existing saved playlists from more entry points
- Custom smart-playlist rules and editor
- Smarter sidecar handling (hidden FLAC metadata files, `.cue` sheets)
- Proper macOS / Windows / Linux icon set

## License

Currently unpublished personal project. License TBD.
