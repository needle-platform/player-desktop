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

const decadeLabel = (year: number): string => {
  if (year < 1950) return 'Pre-50s';
  return `${Math.floor(year / 10) * 10}s`;
};

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

const HI_RES_FORMATS = new Set(['FLAC', 'ALAC', 'WAV', 'AIFF', 'AIF']);

const isHiRes = (track: Track): boolean => {
  if (track.format && HI_RES_FORMATS.has(track.format)) return true;
  if ((track.sample_rate ?? 0) >= 88200) return true;
  if ((track.bit_depth ?? 0) >= 24) return true;
  return false;
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

  // Most played
  const played = tracks.filter((t) => (t.play_count ?? 0) > 0);
  if (played.length >= 5) {
    const mostPlayed = played
      .slice()
      .sort((a, b) => (b.play_count ?? 0) - (a.play_count ?? 0))
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
    .sort((a, b) => (b.last_played_at ?? '').localeCompare(a.last_played_at ?? ''))
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

  // Decade × top genre mixes (e.g. "90s Rock")
  const decadeGenre = new Map<string, Track[]>();
  for (const t of tracks) {
    if (!t.year || !t.genre) continue;
    for (const g of splitGenres(t.genre)) {
      const key = `${decadeLabel(t.year)} · ${titleCase(g)}`;
      const existing = decadeGenre.get(key);
      if (existing) existing.push(t);
      else decadeGenre.set(key, [t]);
    }
  }
  const topDecadeGenre = Array.from(decadeGenre.entries())
    .filter(([, list]) => list.length >= 4)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4);
  for (const [name, list] of topDecadeGenre) {
    playlists.push({
      id: `dg:${name}`,
      name,
      description: `${list.length} tracks · era mix`,
      accent: accent(accentIndex++),
      tracks: list,
    });
  }

  // Pure genre buckets (top 4 genres not already represented above)
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
  const topGenres = Array.from(genreBuckets.entries())
    .filter(([, list]) => list.length >= 5)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4);
  for (const [genre, list] of topGenres) {
    playlists.push({
      id: `genre:${genre}`,
      name: `Best of ${genre}`,
      description: `${list.length} tracks across your library`,
      accent: accent(accentIndex++),
      tracks: list,
    });
  }

  // Decade-only buckets if we don't have great genre coverage
  if (playlists.length < 4) {
    const decadeOnly = new Map<string, Track[]>();
    for (const t of tracks) {
      if (!t.year) continue;
      const key = decadeLabel(t.year);
      const existing = decadeOnly.get(key);
      if (existing) existing.push(t);
      else decadeOnly.set(key, [t]);
    }
    const topDecades = Array.from(decadeOnly.entries())
      .filter(([, list]) => list.length >= 5)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3);
    for (const [decade, list] of topDecades) {
      playlists.push({
        id: `decade:${decade}`,
        name: `${decade} mix`,
        description: `${list.length} tracks from the ${decade}`,
        accent: accent(accentIndex++),
        tracks: list,
      });
    }
  }

  // Mood-ish buckets via duration heuristics
  const quickHits = tracks.filter((t) => (t.duration_seconds ?? 0) > 60 && (t.duration_seconds ?? 0) < 180);
  if (quickHits.length >= 6) {
    playlists.push({
      id: 'mood:quick',
      name: 'Quick hits',
      description: 'Punchy tracks under 3 minutes',
      accent: accent(accentIndex++),
      tracks: sample(quickHits, 60),
    });
  }

  const deepListens = tracks.filter((t) => (t.duration_seconds ?? 0) >= 8 * 60);
  if (deepListens.length >= 4) {
    playlists.push({
      id: 'mood:deep',
      name: 'Deep listens',
      description: 'Long-form tracks for focus',
      accent: accent(accentIndex++),
      tracks: deepListens,
    });
  }

  const slowDown = tracks.filter((t) => {
    const seconds = t.duration_seconds ?? 0;
    if (seconds < 4 * 60) return false;
    const g = (t.genre ?? '').toLowerCase();
    return /ambient|classical|jazz|chill|acoustic|piano|cinematic|score|soundtrack/.test(g);
  });
  if (slowDown.length >= 4) {
    playlists.push({
      id: 'mood:wind-down',
      name: 'Wind down',
      description: 'Mellow long-form selections',
      accent: accent(accentIndex++),
      tracks: slowDown,
    });
  }

  // Audiophile session: hi-res only
  const hiRes = tracks.filter(isHiRes);
  if (hiRes.length >= 6) {
    playlists.push({
      id: 'mood:hi-res',
      name: 'Audiophile session',
      description: 'Lossless and high-resolution tracks',
      accent: accent(accentIndex++),
      tracks: hiRes,
    });
  }

  return playlists;
}
