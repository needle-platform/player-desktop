import type { Track } from '../types';

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

const REDISCOVER_AFTER_DAYS = 30;
const dayMs = 24 * 60 * 60 * 1000;

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

export function generateAutoPlaylists(tracks: Track[]): AutoPlaylist[] {
  if (tracks.length === 0) return [];

  const playlists: AutoPlaylist[] = [];
  let accentIndex = 0;
  const now = Date.now();

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

  // Needs a first spin
  const needsFirstSpin = tracks
    .filter((t) => (t.play_count ?? 0) === 0)
    .slice()
    .sort(
      (a, b) =>
        compareTimestamps(a.added_at, b.added_at, 'asc') ||
        (a.album ?? '').localeCompare(b.album ?? '') ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 50);
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

  // One top-genre mix, not a wall of genre cards.
  const genreBuckets = new Map<string, Track[]>();
  for (const t of tracks) {
    if (!t.genre) continue;
    for (const g of splitGenres(t.genre)) {
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

  return playlists;
}
