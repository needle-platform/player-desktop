import type { Track } from '../types';
import { genreLabelFromKey, normalizeGenreKey, splitTrackGenreKeys } from './genres';
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

const effectiveGenre = (track: Pick<Track, 'primary_genre' | 'genre'>) => track.primary_genre ?? track.genre;
const normalizedGenres = (track: Pick<Track, 'primary_genre' | 'genre'>) =>
  splitTrackGenreKeys(effectiveGenre(track));
const normalizeHint = (value: string) => normalizeGenreKey(value) ?? value.toLocaleLowerCase();
const hasGenreKey = (track: Pick<Track, 'primary_genre' | 'genre'>, key: string) => normalizedGenres(track).includes(key);
const uniqueBy = <T,>(items: readonly T[], keyOf: (item: T) => string) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

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
const NORMALIZED_CHILL_HINTS = CHILL_HINTS.map(normalizeHint);
const NORMALIZED_DANCE_HINTS = DANCE_HINTS.map(normalizeHint);
const NORMALIZED_GROOVE_HINTS = GROOVE_HINTS.map(normalizeHint);
const NORMALIZED_UPLIFT_HINTS = UPLIFT_HINTS.map(normalizeHint);

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

const decadeOf = (year: number | null | undefined): number | null => {
  if (year == null || year < 1000 || year > 2999) return null;
  return Math.floor(year / 10) * 10;
};

const formatDecadeLabel = (decade: number) => `${decade}s`;

type SignatureCandidate = {
  id: string;
  genreKey: string;
  decade: number;
  label: string;
  description: string;
  tracks: Track[];
  score: number;
};

const minSignatureTracks = 12;
const minSignatureArtists = 4;
const minSignatureAlbums = 3;
const maxSignaturePlaylists = 4;
const maxSignatureTracks = 50;

const signatureAlbumKey = (track: Track) => {
  const album = track.album?.trim();
  const albumArtist = track.album_artist?.trim() ?? track.artist?.trim() ?? '';
  if (album) return `${album}\u001f${albumArtist}`;
  return `track:${track.path}`;
};

const roundRobinAlbumSelection = (tracks: Track[], limit: number) => {
  const groups = new Map<string, Track[]>();
  const order: string[] = [];

  for (const track of tracks) {
    const key = signatureAlbumKey(track);
    const existing = groups.get(key);
    if (existing) {
      existing.push(track);
      continue;
    }
    groups.set(key, [track]);
    order.push(key);
  }

  const selected: Track[] = [];
  let offset = 0;

  while (selected.length < limit) {
    let addedThisPass = false;
    for (const key of order) {
      const group = groups.get(key);
      if (!group || offset >= group.length) continue;
      selected.push(group[offset]);
      addedThisPass = true;
      if (selected.length >= limit) break;
    }
    if (!addedThisPass) break;
    offset += 1;
  }

  return selected;
};

const buildLibrarySignaturePlaylists = (tracks: Track[], accentIndexStart: number) => {
  const buckets = new Map<string, Track[]>();

  for (const track of tracks) {
    const decade = decadeOf(track.year);
    if (decade == null) continue;

    const genres = normalizedGenres(track);
    if (genres.length === 0) continue;

    const uniqueGenres = Array.from(new Set(genres));
    for (const genreKey of uniqueGenres) {
      const bucketKey = `${decade}:${genreKey}`;
      const existing = buckets.get(bucketKey);
      if (existing) existing.push(track);
      else buckets.set(bucketKey, [track]);
    }
  }

  const candidates: SignatureCandidate[] = [];
  for (const [bucketKey, bucketTracks] of buckets.entries()) {
    const [decadeText, genreKey] = bucketKey.split(':');
    const decade = Number.parseInt(decadeText, 10);
    if (!Number.isFinite(decade)) continue;

    const uniqueArtists = new Set(
      bucketTracks.map((track) => track.artist?.trim()).filter((value): value is string => Boolean(value)),
    );
    const uniqueAlbums = new Set(
      bucketTracks
        .map((track) => `${track.album ?? ''}\u001f${track.album_artist ?? track.artist ?? ''}`)
        .filter((value) => value !== '\u001f'),
    );

    if (
      bucketTracks.length < minSignatureTracks ||
      uniqueArtists.size < minSignatureArtists ||
      uniqueAlbums.size < minSignatureAlbums
    ) {
      continue;
    }

    const rankedTracks = uniqueBy(
      bucketTracks
        .slice()
        .sort(
          (a, b) =>
            (b.rating ?? 0) - (a.rating ?? 0) ||
            Number(b.is_favorite) - Number(a.is_favorite) ||
            (b.play_count ?? 0) - (a.play_count ?? 0) ||
            compareTimestamps(a.last_played_at, b.last_played_at, 'desc') ||
            a.title.localeCompare(b.title),
        ),
      (track) => track.path,
    );
    const playlistTracks = roundRobinAlbumSelection(rankedTracks, maxSignatureTracks);

    const score =
      rankedTracks.length +
      uniqueArtists.size * 2.4 +
      uniqueAlbums.size * 1.4 +
      rankedTracks.filter((track) => track.is_favorite).length * 0.8 +
      rankedTracks.filter((track) => (track.rating ?? 0) >= 4).length * 0.6;

    candidates.push({
      id: `signature:${decade}:${genreKey}`,
      genreKey,
      decade,
      label: `${formatDecadeLabel(decade)} ${genreLabelFromKey(genreKey)}`,
      description: `${rankedTracks.length} matching tracks · ${uniqueArtists.size} artists · ${uniqueAlbums.size} albums`,
      tracks: playlistTracks,
      score,
    });
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.tracks.length - a.tracks.length ||
      a.label.localeCompare(b.label),
  );

  const selected: SignatureCandidate[] = [];
  const usedGenres = new Set<string>();
  const usedDecades = new Set<number>();

  const tryAddCandidates = (allowRepeatedDecades: boolean, allowRepeatedGenres: boolean) => {
    for (const candidate of candidates) {
      if (selected.some((entry) => entry.id === candidate.id)) continue;
      if (!allowRepeatedGenres && usedGenres.has(candidate.genreKey)) continue;
      if (!allowRepeatedDecades && usedDecades.has(candidate.decade)) continue;
      selected.push(candidate);
      usedGenres.add(candidate.genreKey);
      usedDecades.add(candidate.decade);
      if (selected.length >= maxSignaturePlaylists) break;
    }
  };

  tryAddCandidates(false, false);
  if (selected.length < maxSignaturePlaylists) tryAddCandidates(true, false);
  if (selected.length < maxSignaturePlaylists) tryAddCandidates(true, true);

  return {
    playlists: selected.slice(0, maxSignaturePlaylists).map((candidate, index) => ({
      id: candidate.id,
      name: candidate.label,
      description: candidate.description,
      accent: accent(accentIndexStart + index),
      tracks: candidate.tracks,
    })),
    nextAccentIndex: accentIndexStart + Math.min(selected.length, maxSignaturePlaylists),
  };
};

export function generateAutoPlaylists(tracks: Track[]): AutoPlaylist[] {
  if (tracks.length === 0) return [];

  const playlists: AutoPlaylist[] = [];
  let accentIndex = 0;
  const now = Date.now();
  const vibeEligibleTracks = tracks.filter((track) => !hasGenreKey(track, 'christmas'));

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

  const favoriteTracks = tracks
    .filter((track) => track.is_favorite)
    .slice()
    .sort(
      (a, b) =>
        (b.rating ?? 0) - (a.rating ?? 0) ||
        (b.play_count ?? 0) - (a.play_count ?? 0) ||
        compareTimestamps(a.last_played_at, b.last_played_at, 'desc') ||
        a.title.localeCompare(b.title),
    );
  if (favoriteTracks.length > 0) {
    playlists.push({
      id: 'library:favorites',
      name: 'Favourites',
      description: 'Tracks you marked with a heart',
      accent: accent(accentIndex++),
      tracks: favoriteTracks,
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

  const signaturePlaylists = buildLibrarySignaturePlaylists(tracks, accentIndex);
  playlists.push(...signaturePlaylists.playlists);
  accentIndex = signaturePlaylists.nextAccentIndex;

  const windDown = vibeEligibleTracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['slowdown'], [], NORMALIZED_CHILL_HINTS),
    }))
    .filter(({ vibe }) => vibe === 'slowdown')
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

  const cruiseAndGroove = vibeEligibleTracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['cruise', 'groove'], ['slowdown'], NORMALIZED_GROOVE_HINTS),
    }))
    .filter(({ vibe }) => vibe === 'cruise' || vibe === 'groove')
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

  const liftAndEnergy = vibeEligibleTracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['lift', 'energy'], ['groove'], NORMALIZED_UPLIFT_HINTS),
    }))
    .filter(({ vibe }) => vibe === 'lift' || vibe === 'energy')
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

  const getOnYourFeet = vibeEligibleTracks
    .map((track) => ({
      track,
      ...scoreTrackForVibeMix(track, ['energy', 'chaos'], ['lift'], NORMALIZED_DANCE_HINTS),
    }))
    .filter(({ vibe }) => vibe === 'energy' || vibe === 'chaos')
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
