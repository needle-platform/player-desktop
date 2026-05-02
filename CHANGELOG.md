# Changelog

All notable changes to this project will be documented in this file.

This changelog follows a lightweight Keep a Changelog-style format and is organized around release versions declared in [package.json](/Users/davidrelich/CascadeProjects/music-player/package.json).

## [Unreleased]

### Added
- Added a README screenshot for the public GitHub repository.
- Added persistent 1-5 star ratings for tracks across the library, album, and artist views.
- Added a `Top rated` smart playlist generated from the listener's own track ratings.
- Added genre-focus pills for smart playlists so listeners can narrow a generated mix to one or more genres already present in that playlist.
- Added opt-in loudness analysis and volume leveling, with FFmpeg-backed per-track gain stored locally and applied through mpv during playback.
- Added vinyl-rip tag detection plus a record badge overlay on album artwork for tagged transfers.

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
- Expanded Settings with a background loudness-analysis workflow, live progress logging, and clearer guidance that the first pass can take a while while the app remains usable.

### Fixed
- Fixed album-page track clicks so choosing one song plays that track directly instead of queueing the rest of the album.
- Fixed album-page track-heading spacing so the `Tracks` label has a little breathing room above the list.

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
