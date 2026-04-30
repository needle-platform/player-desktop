# Needle

A local-first, hi-fi music player for macOS built with **Tauri**, **React + TypeScript**, and **Rust**. Audio playback is handled by **mpv** through its JSON IPC, so lossless formats (FLAC, ALAC, WAV, AIFF) sound exactly the way they should.

> Status: actively usable local-first player — library, queue, saved playlists, playback persistence, equalizer, and richer library curation tools are all in place, with smarter playlisting and metadata refinement continuing to grow.

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
- **Artwork-first mini player** with full-bleed cover art, drag-to-move behavior, pinned always-on-top mode, and an expandable / resizable Up Next queue
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
- **Empty playlist creation** directly from the sidebar
- **Add to playlist** actions on tracks and albums, with in-app creation of a new playlist during the add flow
- **Playlist pages as playback views** with top-level Play / Shuffle / Play next / Add to queue actions
- **Save visible track sets** from the Tracks view or album pages as playlist snapshots
- **Filtered playlist creation** from library metadata such as artist and genre
- **Playlist management**: rename, delete, reorder tracks, remove tracks
- **Smart playlists** surfaced as first-class library views generated from your collection and listening history

### Artist portraits & bios
- **Artist portraits** pulled for free via **MusicBrainz → Wikidata → Wikimedia Commons**
- **Artist biographies** pulled via **MusicBrainz → Wikidata → Wikipedia** when linked metadata is available
- **Artist photo fallback chain** now checks direct MusicBrainz image relations, Wikidata `P18`, and finally the linked Wikipedia page image when available
- No API keys required; polite User-Agent + 1 req/sec serialization
- Cached in SQLite (`artist_images`) for 30 days, including misses so we don't keep hammering the API
- Cached in SQLite (`artist_info`) for 90 days, including misses, with manual retry from the artist page
- **Artist-page recovery tools** are hidden behind a right-click menu on the hero portrait for Refresh photo / Refresh bio, with loading feedback during background refreshes
- **Graceful artwork fallback** uses the artist's album art before falling back to a gradient initial when no portrait loads

### Views
- **Dashboard** (default landing screen)
- **Tracks** with live search, sorting, and filters for artist / genre / year range, plus album / artist / playlist context
- **Albums** with cover art, sorting, and direct playlist actions
- **Album detail page** with hero artwork, metadata, play/shuffle actions, multi-disc track grouping, editable primary genre, artist deep links, and background album info when available
- **Artists** with sorting, track counts, dedicated artist pages, biographies, album grids, most-played-track actions, inline bio actions, and photo-context refresh tools
- **Settings** with theme switcher, custom accent color, library folders, maintenance, live equalizer presets, and manual 10-band EQ

### Album info
- **Background album notes** pulled via **MusicBrainz release-group → Wikidata → Wikipedia**
- Artist-aware album matching improves lookups for releases with ambiguous or very common titles
- Cached in SQLite (`album_info`) so repeat opens are instant and we avoid repeat lookups
- **Album page genres** are derived from the imported track tags already embedded in your files
- **Primary genre override** lets you set a local album-level genre Needle should prefer for browsing, filtering, and smart-playlist logic without rewriting the source files
- Graceful fallback when no article exists for obscure releases, compilations, or local-only metadata

### Themes & UX
- **Themes**: System, Light, Dark
- **Custom accent color** persisted in SQLite and applied across playback controls, queue highlights, buttons, and selection states
- **Theme-aware branding** with separate light/dark app icons and a dock-tuned macOS icon set
- **Mini player runtime dark override** keeps the compact artwork-first window in a dark presentation without changing the user's saved theme preference
- **Wikipedia links** from album and artist metadata open in the system browser instead of relying on webview behavior
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
- `src/lib/artistImage.ts` — artist portrait hook with module-level cache, refresh support, and album-art fallback behavior
- `src/lib/artistInfo.ts` — artist-info hook with module-level cache
- `src/lib/albumInfo.ts` — album-info hook with module-level cache
- `src/lib/playlists.ts` — auto-playlist generators from tags + heuristics
- `src/styles.css` — full theming + layout
- `src-tauri/src/lib.rs` — Tauri command surface, app setup, and native external-URL opening
- `src-tauri/src/db.rs` — SQLite schema, migrations, library/playback persistence, saved playlists, artist-image cache, artist-info cache, album-info cache, album primary-genre overrides
- `src-tauri/src/library.rs` — folder scanner, dotfile filter, metadata via `lofty`
- `src-tauri/src/artist.rs` — MusicBrainz → Wikidata → Commons artist portrait lookup with Wikipedia image fallback + Wikipedia-backed artist biography lookup
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
- **Tags** and local overrides (`primary_genre`) drive one top-genre mix when your collection has a clear favorite
- **`added_at`** (preserved across rescans) drives the Recently added albums row

Needle treats imported metadata as a starting point, not untouchable truth:

- **Raw embedded tags** stay preserved exactly as imported
- **Local overrides** can refine how the app interprets your library without modifying audio files
- **Album-level primary genre** currently flows down to tracks from that album for filtering and smarter playlist generation

Real **BPM and key analysis** would unlock proper mood detection (energy, workout, slow groove). It's tractable in Rust via onset-detection / autocorrelation, but it's CPU-heavy and best done as an opt-in background "Analyze library" maintenance step. Tracked in the roadmap.

## Roadmap

- BPM + key analysis as an opt-in background step, with cached `audio_features` table
- Gapless playback hand-off
- Watch folders with incremental rescans
- Custom smart-playlist rules and editor
- Smarter sidecar handling (hidden FLAC metadata files, `.cue` sheets)
- Proper macOS / Windows / Linux icon set

## License

Currently unpublished personal project. License TBD.
