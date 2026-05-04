import type { Track } from '../types';
import { vibeKeyForTrack, type VibeKey } from './vibes';

export interface AutoPlaylist {
  id: string;
  name: string;
  description: string;
  accent: string;
  tracks: Track[];
}

const ACCENTS = [
  'linear-gradient(135deg, #5b7cff, #b667ff)',
  'linear-gradient(135deg, #ff7a59, #ffb74a)',
  'linear-gradient(135deg, #00b8a9, #5b7cff)',
  'linear-gradient(135deg, #ff5fa2, #ff7a59)',
  'linear-gradient(135deg, #6dd5ed, #2193b0)',
  'linear-gradient(135deg, #c471f5, #fa71cd)',
  'linear-gradient(135deg, #f7971e, #ffd200)',
  'linear-gradient(135deg, #11998e, #38ef7d)',
];

const accent = (n: number) => ACCENTS[n % ACCENTS.length];

const titleCase = (value: string) =>
  value
    .toLowerCase()
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const splitGenres = (raw: string): string[] =>
  raw
    .split(/[;,/]/)
    .map((s) => s.trim())
    .filter(Boolean);
const effectiveGenre = (track: Pick<Track, 'primary_genre' | 'genre'>) => track.primary_genre ?? track.genre;
const normalizedGenres = (track: Pick<Track, 'primary_genre' | 'genre'>) =>
  splitGenres(effectiveGenre(track) ?? '').map((genre) => genre.toLowerCase());

const REDISCOVER_AFTER_DAYS = 30;
const dayMs = 24 * 60 * 60 * 1000;
const CHILL_HINTS = [
  'ambient',
  'downtempo',
  'chill',
  'chillout',
  'lounge',
  'jazz',
  'soul',
  'neo soul',
  'r&b',
  'blues',
  'acoustic',
  'folk',
  'trip-hop',
  'trip hop',
  'bossa',
  'singer-songwriter',
  'singer songwriter',
] as const;
const DANCE_HINTS = [
  'dance',
  'disco',
  'house',
  'techno',
  'electronic',
  'electro',
  'synthpop',
  'synth-pop',
  'funk',
  'pop',
  'hip hop',
  'hip-hop',
  'rap',
  'latin',
  'reggaeton',
  'club',
] as const;
const GROOVE_HINTS = [
  'soul',
  'neo soul',
  'r&b',
  'funk',
  'jazz',
  'lounge',
  'pop',
  'electronic',
  'house',
  'downtempo',
] as const;
const UPLIFT_HINTS = [
  'pop',
  'dance',
  'disco',
  'funk',
  'house',
  'electronic',
  'electro',
  'synthpop',
  'indie pop',
  'rock',
] as const;

const timestampOf = (value: string | null | undefined): number => {
  if (!value) return Number.NaN;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? Number.NaN : timestamp;
};

const compareTimestamps = (
  left: string | null | undefined,
  right: string | null | undefined,
  direction: 'asc' | 'desc',
): number => {
  const leftTs = timestampOf(left);
  const rightTs = timestampOf(right);

  const leftMissing = Number.isNaN(leftTs);
  const rightMissing = Number.isNaN(rightTs);
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  return direction === 'asc' ? leftTs - rightTs : rightTs - leftTs;
};

const sample = <T,>(arr: T[], n: number): T[] => {
  if (arr.length <= n) return arr.slice();
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};

const countGenreHints = (genres: string[], hints: readonly string[]) =>
  genres.reduce(
    (count, genre) =>
      count +
      (hints.some((hint) => genre === hint || genre.includes(hint) || hint.includes(genre)) ? 1 : 0),
    0,
  );

const scoreTrackForVibeMix = (
  track: Track,
  preferredVibes: readonly VibeKey[],
  supportingVibes: readonly VibeKey[],
  hints: readonly string[],
) => {
  const vibe = vibeKeyForTrack(track);
  const genres = normalizedGenres(track);
  const hintMatches = countGenreHints(genres, hints);

  let score = 0;
  if (vibe && preferredVibes.includes(vibe)) score += 4;
  else if (vibe && supportingVibes.includes(vibe)) score += 2;

  score += hintMatches * 2;

  if ((track.rating ?? 0) >= 4) score += 1;
  if ((track.play_count ?? 0) >= 5) score += 1;

  return { score, vibe, hintMatches };
};

export function generateAutoPlaylists(tracks: Track[]): AutoPlaylist[] {
  if (tracks.length === 0) return [];

  const playlists: AutoPlaylist[] = [];
  let accentIndex = 0;
  const now = Date.now();

  const ratedTracks = tracks
    .filter((track) => (track.rating ?? 0) > 0)
    .slice()
    .sort(
      (a, b) =>
        (b.rating ?? 0) - (a.rating ?? 0) ||
        (b.play_count ?? 0) - (a.play_count ?? 0) ||
        compareTimestamps(a.last_played_at, b.last_played_at, 'desc') ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 50);
  if (ratedTracks.length >= 3) {
    const favoriteRatedTracks = ratedTracks.filter((track) => (track.rating ?? 0) >= 4);
    const playlistTracks = favoriteRatedTracks.length >= 3 ? favoriteRatedTracks : ratedTracks;
    playlists.push({
      id: 'ratings:top-rated',
      name: 'Top rated',
      description:
        favoriteRatedTracks.length >= 3
          ? `Tracks you marked 4 or 5 stars`
          : 'Tracks ordered by the stars you gave them',
      accent: accent(accentIndex++),
      tracks: playlistTracks,
    });
  }

  // Most played
  const played = tracks.filter((t) => (t.play_count ?? 0) > 0);
  if (played.length >= 5) {
    const mostPlayed = played
      .slice()
      .sort(
        (a, b) =>
          (b.play_count ?? 0) - (a.play_count ?? 0) ||
          compareTimestamps(a.last_played_at, b.last_played_at, 'desc') ||
          a.title.localeCompare(b.title),
      )
      .slice(0, 50);
    playlists.push({
      id: 'history:most-played',
      name: 'Most played',
      description: `Top ${mostPlayed.length} tracks you keep coming back to`,
      accent: accent(accentIndex++),
      tracks: mostPlayed,
    });
  }

  // Recently played
  const recentlyPlayed = tracks
    .filter((t) => Boolean(t.last_played_at))
    .slice()
    .sort(
      (a, b) =>
        compareTimestamps(a.last_played_at, b.last_played_at, 'desc') || a.title.localeCompare(b.title),
    )
    .slice(0, 50);
  if (recentlyPlayed.length >= 3) {
    playlists.push({
      id: 'history:recent',
      name: 'Recently played',
      description: 'Your last few sessions',
      accent: accent(accentIndex++),
      tracks: recentlyPlayed,
    });
  }

  // One top-genre mix, placed early so it stays on the first dashboard row.
  const genreBuckets = new Map<string, Track[]>();
  for (const t of tracks) {
    const rawGenre = effectiveGenre(t);
    if (!rawGenre) continue;
    for (const g of splitGenres(rawGenre)) {
      const key = titleCase(g);
      const existing = genreBuckets.get(key);
      if (existing) existing.push(t);
      else genreBuckets.set(key, [t]);
    }
  }
  const topGenre = Array.from(genreBuckets.entries())
    .filter(([, list]) => list.length >= 5)
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (topGenre) {
    const [genre, list] = topGenre;
    playlists.push({
      id: `genre:${genre}`,
      name: 'From your top genre',
      description: `${genre} · ${list.length} tracks across your library`,
      accent: accent(accentIndex++),
      tracks: sample(list, 60),
    });
  }

  const windDown = tracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['slowdown'], [], CHILL_HINTS),
    }))
    .filter(
      ({ vibe, hintMatches }) => vibe === 'slowdown' || (vibe == null && hintMatches >= 2),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.track.rating ?? 0) - (a.track.rating ?? 0) ||
        compareTimestamps(a.track.last_played_at, b.track.last_played_at, 'asc') ||
        a.track.title.localeCompare(b.track.title),
    )
    .map(({ track }) => track);
  if (windDown.length >= 8) {
    playlists.push({
      id: 'vibes:wind-down',
      name: 'Wind down',
      description: 'Slower songs to help the room exhale',
      accent: accent(accentIndex++),
      tracks: windDown,
    });
  }

  const cruiseAndGroove = tracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['cruise', 'groove'], ['slowdown'], GROOVE_HINTS),
    }))
    .filter(
      ({ score, vibe, hintMatches }) =>
        score >= 4 || vibe === 'cruise' || vibe === 'groove' || hintMatches >= 2,
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.track.rating ?? 0) - (a.track.rating ?? 0) ||
        compareTimestamps(a.track.last_played_at, b.track.last_played_at, 'asc') ||
        a.track.title.localeCompare(b.track.title),
    )
    .map(({ track }) => track);
  if (cruiseAndGroove.length >= 8) {
    playlists.push({
      id: 'vibes:cruise-and-groove',
      name: 'Cruise & groove',
      description: 'Easy motion, warm rhythm, no rush',
      accent: accent(accentIndex++),
      tracks: cruiseAndGroove,
    });
  }

  const liftAndEnergy = tracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['lift', 'energy'], ['groove'], UPLIFT_HINTS),
    }))
    .filter(
      ({ score, vibe, hintMatches }) =>
        score >= 4 || vibe === 'lift' || vibe === 'energy' || hintMatches >= 2,
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.track.rating ?? 0) - (a.track.rating ?? 0) ||
        (b.track.play_count ?? 0) - (a.track.play_count ?? 0) ||
        a.track.title.localeCompare(b.track.title),
    )
    .map(({ track }) => track);
  if (liftAndEnergy.length >= 8) {
    playlists.push({
      id: 'vibes:lift-and-energy',
      name: 'Lift & energy',
      description: 'Bright momentum when you want to feel lighter',
      accent: accent(accentIndex++),
      tracks: liftAndEnergy,
    });
  }

  const getOnYourFeet = tracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['energy', 'chaos'], ['lift'], DANCE_HINTS),
    }))
    .filter(
      ({ score, vibe, hintMatches }) =>
        score >= 5 || vibe === 'energy' || vibe === 'chaos' || hintMatches >= 2,
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.track.rating ?? 0) - (a.track.rating ?? 0) ||
        (b.track.play_count ?? 0) - (a.track.play_count ?? 0) ||
        a.track.title.localeCompare(b.track.title),
    )
    .map(({ track }) => track);
  if (getOnYourFeet.length >= 8) {
    playlists.push({
      id: 'vibes:get-on-your-feet',
      name: 'Get on your feet',
      description: 'The ones that make standing still unlikely',
      accent: accent(accentIndex++),
      tracks: getOnYourFeet,
    });
  }

  // Needs a first spin
  const needsFirstSpin = tracks
    .filter((t) => (t.play_count ?? 0) === 0)
    .slice()
    .sort(
      (a, b) =>
        compareTimestamps(a.added_at, b.added_at, 'asc') ||
        (a.album ?? '').localeCompare(b.album ?? '') ||
        a.title.localeCompare(b.title),
    );
  if (needsFirstSpin.length >= 5) {
    playlists.push({
      id: 'library:first-spin',
      name: 'Needs a first spin',
      description: 'Unplayed tracks still waiting in your library',
      accent: accent(accentIndex++),
      tracks: needsFirstSpin,
    });
  }

  // Rediscover: tracks you played before, but not recently.
  const rediscover = tracks
    .filter((t) => {
      if ((t.play_count ?? 0) <= 0 || !t.last_played_at) return false;
      const lastPlayed = timestampOf(t.last_played_at);
      if (Number.isNaN(lastPlayed)) return false;
      return now - lastPlayed >= REDISCOVER_AFTER_DAYS * dayMs;
    })
    .slice()
    .sort(
      (a, b) =>
        compareTimestamps(a.last_played_at, b.last_played_at, 'asc') ||
        (b.play_count ?? 0) - (a.play_count ?? 0) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 50);
  if (rediscover.length >= 5) {
    playlists.push({
      id: 'library:rediscover',
      name: 'Rediscover',
      description: 'Played before, not recently',
      accent: accent(accentIndex++),
      tracks: rediscover,
    });
  }

  return playlists;
}
