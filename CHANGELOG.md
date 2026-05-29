# Changelog

All notable changes to this project will be documented in this file.

This changelog follows a lightweight Keep a Changelog-style format and is organized around release versions declared in [package.json](/Users/davidrelich/CascadeProjects/music-player/package.json).

## [Unreleased]

### Added
- Added backend runtime details in Settings so the current Needle app version and loudness-analysis version are visible in-app.
- Added backend-mode custom artist photo uploads from the artist page, including a quick “use automatic photo again” reset path.
- Added album-wide Vorbis `TAGS` editing for source labels, with `vinyl-rip`, `cd-rip`, and `digital-purchase` presets plus custom source tags.

### Changed
- Loudness analysis now runs from desktop backend mode too, using cached offline files when available and authenticated backend streams for the rest.
- Loudness analysis now explains when a full-library rerun is intentional because cached results came from an older loudness-analysis version.
- Artist-page enrichment in backend mode is now backend-owned for both photos and biographies, so clients share one source of truth instead of re-fetching artist data per app.
- Album-page enrichment in backend mode is now backend-owned too, so shared album notes and source links come from the homeserver instead of being fetched separately by each client.
- Backend-mode info toasts now dismiss themselves automatically after a short delay instead of lingering until manually closed.
- Backend-mode heartbeat checks now watch the homeserver `libraryChange` version and refresh the desktop library snapshot automatically when shared library state changes.
- Album grouping now treats source-tagged editions as separate albums, so a digital purchase and vinyl rip of the same release no longer collapse into one duplicated album view.

### Fixed
- Fixed backend-mode playlist management so desktop rename, delete, add, remove, and reorder actions call homeserver playlist APIs instead of being blocked by leftover backend-mode guards.
- Fixed desktop backend mode so homeserver outages no longer hang the app indefinitely, and the app now switches itself into a downloaded-only offline mode with a calm in-app notice instead of freezing or waiting for a manual backend check.
- Fixed backend-mode reconnects after laptop sleep so wake, focus, and visibility changes now force a fresh backend check instead of leaving the app stranded in offline mode until restart.
- Fixed backend-mode artist pages so a missing shared photo or biography now auto-triggers a one-shot backend refresh and re-renders when the homeserver finishes enrichment.
- Fixed backend-mode custom artist photo updates so replacing an existing portrait now repaints immediately on the current artist page instead of waiting for navigation.
- Fixed backend-mode album pages so missing shared album notes now auto-trigger a one-shot backend refresh and re-render when the homeserver finishes enrichment.
- Fixed backend-mode offline presentation so the normal dashboard stays intact, online-only actions are hidden, and the app switches back automatically once the homeserver is reachable again.
- Fixed backend-mode offline downloads so tracks and albums now surface active download progress and partial/full offline availability directly in the library UI.
- Fixed remote backend offline downloads so track streaming no longer uses the same short total-request timeout as lightweight backend heartbeat checks.
- Fixed backend-mode queue state so temporary offline or reconnect library snapshots no longer clear the visible Up Next queue while mpv playback continues.
- Fixed desktop playback recovery after sleep or background throttling by periodically resyncing the UI from mpv's current track, position, duration, volume, mute state, output device, and queue position.

## [0.1.2] - 2026-05-04

### Added
- Added a README screenshot for the public GitHub repository.
- Added persistent 1-5 star ratings for tracks across the library, album, and artist views.
- Added a `Top rated` smart playlist generated from the listener's own track ratings.
- Added genre-focus pills for smart playlists so listeners can narrow a generated mix to one or more genres already present in that playlist.
- Added opt-in loudness analysis and volume leveling, with FFmpeg-backed per-track gain stored locally and applied through mpv during playback.
- Added vinyl-rip tag detection plus a record badge overlay on album artwork for tagged transfers.
- Added structured loudness-analysis progress with checked/ analyzed/ fresh/ missing/ failed counts plus a failed-files list that can be copied from Settings.
- Added embedded-BPM import plus vibe bucketing so smart mixes can quietly use tempo without exposing raw BPM as a primary browsing filter.
- Added local BPM correction controls with halve / double / reset actions stored in Needle rather than written back to audio files.
- Added four vibe-led smart mixes on the dashboard: `Wind down`, `Cruise & groove`, `Lift & energy`, and `Get on your feet`.
- Added a metadata save-mode setting so genre and BPM edits can either stay in Needle or write directly into the music files.
- Added album-wide genre editing plus an in-app BPM editor modal that respect the selected metadata save mode.
- Added a searchable album-genre picker with multi-select pills so genre cleanup can reuse existing library genres instead of retyping long strings.

### Changed
- Licensed the project under `GPL-3.0-only` and added the full license text.
- Updated project metadata and documentation to reflect the public open-source license.
- Deferred Up Next queue artwork loading so long queues open more quickly instead of resolving every cover up front.
- Expanded `Needs a first spin` to use the full set of unplayed tracks instead of a 50-track cap, so focused smart-playlist listening has a broader pool to draw from.
- Streamlined track rows by stacking artist and album metadata, removing the `Queued` pill, and using the queue button itself as the queued-state indicator.
- Simplified smart-playlist pages by hiding the generic track search/filter toolbar and preserving Needle's generated ordering.
- Made smart-playlist playback and queue actions respect the currently focused subset instead of always using the full underlying playlist.
- Removed the redundant sidebar status footer to free more vertical space for growing playlist lists.
- Tightened sidebar active states so Tracks and playlist highlights only appear when that exact library or playlist view is on screen.
- Expanded Settings with a background loudness-analysis workflow, live progress logging, structured progress feedback, and clearer guidance that the first pass can take a while while the app remains usable.
- Made volume leveling gentler by targeting a lower loudness and capping upward gain, so mixed playback feels more natural.
- Increased loudness-analysis throughput by running two FFmpeg workers in parallel instead of processing the whole library strictly one track at a time.
- Reworked the dashboard playlist lineup so the top row stays utility/history-focused and the second row is reserved for the four vibe mixes.
- Replaced cramped inline BPM math buttons with a compact BPM chip that opens a clearer correction menu.
- Reworked album genre editing around the actual genre string used for filtering, rather than the older single “primary genre” shortcut.
- Normalized genre labels and matching so casing and common formatting variants collapse into one clean filter vocabulary across the UI and saved playlist rules.

### Fixed
- Fixed album-page track clicks so choosing one song plays that track directly instead of queueing the rest of the album.
- Fixed album-page track-heading spacing so the `Tracks` label has a little breathing room above the list.
- Fixed stale end-of-album playback state so finished albums return to a working `Play` state instead of getting stuck behind a dead `Resume`.
- Fixed sidebar scrolling so Settings no longer disappears behind the now-playing bar when playlist lists grow.
- Fixed track-row alignment when BPM controls are unavailable for some rows.
- Fixed BPM-correction toasts so they auto-dismiss like other success confirmations.
- Fixed vibe playlists so they now follow the actual BPM buckets only, excluding tracks with no BPM and preventing cross-bucket bleed from metadata hints.
- Fixed album queue handoffs so consecutive tracks can play truly gaplessly instead of inserting a short pause between songs.
- Fixed backend-mode volume leveling to trust the desktop loudness cache first and ignore stale post-transition gain updates that could make playback sound inconsistent.
- Fixed the remaining post-transition dip by updating mpv's gain stage in place instead of rebuilding the full audio filter chain after each seamless track change.
- Fixed backend loudness-analysis cache matching so changing backend URLs or toggling between streamed and offline backend sources no longer makes the whole library look unanalyzed again.

## [0.1.0] - 2026-05-01

### Added
- Public initial release of Needle as a local-first hi-fi music player for macOS built with Tauri, React, TypeScript, Rust, and mpv.
- Local library import with recursive folder scanning, SQLite-backed storage, hidden-file filtering, maintenance rescans, and per-folder removal.
- Rich playback experience with queue management, session restore, repeat and shuffle modes, output device selection, scrubbing, volume and mute controls, and robust mpv shutdown handling.
- Artwork-first mini player with draggable positioning, always-on-top pinning, and expandable Up Next queue behavior.
- Playlist support including manual playlists, smart playlists, saved filtered playlists, playlist editing, and playlist-aware playback actions.
- Dashboard surfaces for recently added albums, featured albums, top artists, quick picks, and listening-history-driven recommendations.
- Album pages with hero artwork, metadata, multi-disc grouping, local primary genre overrides, and MusicBrainz-powered album metadata refresh.
- Artist pages with portraits, biographies, cached enrichment, manual refresh tools, and artwork fallback behavior sourced through MusicBrainz, Wikidata, Wikimedia Commons, and Wikipedia.
- Equalizer support with built-in presets plus manual 10-band EQ controls.
- Theme support for system, light, and dark modes with custom accent colors, toast notifications, and app branding refresh.

### Changed
- Rebranded the app as Needle and refreshed the player UI, dashboard, mini player, and icon set for the public release.
- Improved large-library browsing performance with deferred cover and portrait loading, cached media lookups, and more responsive browsing surfaces.
- Hardened metadata fallback behavior for albums and artists, including collaboration-credit matching and clearer refresh error handling.

### Fixed
- Fixed now-playing and queue synchronization issues during playback progression.
- Fixed album playback resume behavior and several queue-related playback edge cases.
- Fixed playlist and filtered-playlist behavior when browsing and playing from playlist views.
