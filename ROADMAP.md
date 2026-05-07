# Roadmap

This file is for planned features and product ideas that are not shipped yet.

## Near Term

- Backend library mode for the desktop app
  Add a library-source setting so Needle can boot either from local folders or from the Needle backend, while keeping native desktop playback and power-user workflows intact.

- Desktop-to-backend migration tool
  Import existing Needle desktop state into the backend, including playlists, favourites, ratings, play counts, album and artist caches, metadata overrides, loudness-analysis results, and shared playback session state.

- Backend connection and status in Settings
  Add a backend URL/configuration flow, health/status surface, and explicit sync/migration actions so the desktop app can switch modes with confidence.

- Shared playback session across devices
  Persist queue, current track, playback position, repeat, and shuffle state to the Needle backend so playback can resume cleanly on another desktop client.

- Backend-backed album and artist data hydration
  Teach the desktop app to read backend-provided library, artwork, and enrichment data when backend mode is active, without giving up local-first editing and playback behavior.

- Seasonal smart playlists and dashboard banners
  Surface timely playlists such as Christmas or Halloween when matching tagged tracks exist in the library, with a full-width dashboard banner, contextual artwork, and direct play / shuffle actions.

## Later Ideas

- BPM and key analysis as an opt-in background task for files with missing or obviously unreliable tempo data.
- Artist radio built from local library context, genres, and artist enrichment data.
- Custom smart-playlist rules and a proper in-app smart-playlist editor.
- More metadata cleanup tools for direct file-tag editing where it makes sense.
