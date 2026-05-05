import type { Track } from '../types';
import { splitTrackGenreKeys } from './genres';

export type VibeKey = 'slowdown' | 'cruise' | 'groove' | 'lift' | 'energy' | 'chaos';
export type VibeMixKey = 'wind_down' | 'cruise_and_groove' | 'lift_and_energy' | 'get_on_your_feet';
export type GenreFamily =
  | 'ambient_chill'
  | 'acoustic_folk'
  | 'soul_rnb'
  | 'jazz_blues'
  | 'indie_alt'
  | 'pop_mainstream'
  | 'dance_electronic'
  | 'house_disco'
  | 'hip_hop_rap'
  | 'rock_classic'
  | 'rock_hard'
  | 'metal_punk'
  | 'latin_global'
  | 'orchestral_cinematic';

export type VibeBucket = {
  key: VibeKey;
  label: string;
  minBpm: number | null;
  maxBpm: number | null;
};

type VibeMixProfile = {
  preferredVibes: readonly VibeKey[];
  supportingVibes: readonly VibeKey[];
  strongBoostFamilies: readonly GenreFamily[];
  softBoostFamilies: readonly GenreFamily[];
  softPenaltyFamilies: readonly GenreFamily[];
  hardVetoFamilies: readonly GenreFamily[];
  minimumGenreWeight?: number;
};

type FamilyMatcher = {
  family: GenreFamily;
  hints: readonly string[];
};

const FAMILY_MATCHERS: readonly FamilyMatcher[] = [
  {
    family: 'ambient_chill',
    hints: ['ambient', 'downtempo', 'chill', 'chillout', 'lounge', 'new age', 'trip hop', 'trip-hop', 'lo-fi', 'lofi', 'chillwave'],
  },
  {
    family: 'acoustic_folk',
    hints: ['folk', 'acoustic', 'americana', 'singer songwriter', 'singer-songwriter', 'alt country', 'alt-country', 'country folk', 'contemporary folk', 'country'],
  },
  {
    family: 'soul_rnb',
    hints: ['soul', 'neo soul', 'neo-soul', 'r&b', 'quiet storm', 'contemporary r&b', 'funk'],
  },
  {
    family: 'jazz_blues',
    hints: ['jazz', 'blues', 'bossa', 'bossa nova', 'vocal jazz', 'smooth jazz', 'bebop'],
  },
  {
    family: 'indie_alt',
    hints: ['indie', 'alternative', 'dream pop', 'shoegaze', 'art pop', 'bedroom pop', 'indie pop', 'indietronica'],
  },
  {
    family: 'pop_mainstream',
    hints: ['pop', 'electropop', 'synthpop', 'synth pop', 'teen pop', 'adult contemporary', 'dance pop', 'dance-pop'],
  },
  {
    family: 'dance_electronic',
    hints: ['electronic', 'edm', 'techno', 'electro', 'trance', 'drum and bass', 'dubstep', 'synthwave'],
  },
  {
    family: 'house_disco',
    hints: ['house', 'deep house', 'disco', 'nu disco', 'funky house'],
  },
  {
    family: 'hip_hop_rap',
    hints: ['hip hop', 'hip-hop', 'rap', 'trap', 'grime'],
  },
  {
    family: 'rock_classic',
    hints: ['rock', 'classic rock', 'soft rock', 'heartland rock', 'yacht rock', 'pop rock'],
  },
  {
    family: 'rock_hard',
    hints: ['hard rock', 'grunge', 'garage rock', 'arena rock'],
  },
  {
    family: 'metal_punk',
    hints: ['metal', 'punk', 'hardcore', 'industrial metal', 'screamo'],
  },
  {
    family: 'latin_global',
    hints: ['latin', 'reggaeton', 'brazilian', 'afrobeats', 'world', 'salsa', 'bachata', 'cumbia'],
  },
  {
    family: 'orchestral_cinematic',
    hints: ['soundtrack', 'score', 'orchestral', 'cinematic', 'classical', 'classical crossover'],
  },
];

const VIBE_MIX_PROFILES: Record<VibeMixKey, VibeMixProfile> = {
  wind_down: {
    preferredVibes: ['slowdown'],
    supportingVibes: [],
    strongBoostFamilies: ['ambient_chill', 'acoustic_folk', 'soul_rnb', 'jazz_blues'],
    softBoostFamilies: ['indie_alt', 'pop_mainstream'],
    softPenaltyFamilies: ['dance_electronic', 'hip_hop_rap', 'rock_hard', 'orchestral_cinematic'],
    hardVetoFamilies: ['metal_punk'],
    minimumGenreWeight: 2,
  },
  cruise_and_groove: {
    preferredVibes: ['cruise', 'groove'],
    supportingVibes: ['slowdown'],
    strongBoostFamilies: ['soul_rnb', 'jazz_blues', 'house_disco', 'ambient_chill'],
    softBoostFamilies: ['indie_alt', 'pop_mainstream', 'latin_global', 'dance_electronic'],
    softPenaltyFamilies: ['metal_punk', 'rock_hard', 'orchestral_cinematic'],
    hardVetoFamilies: [],
  },
  lift_and_energy: {
    preferredVibes: ['lift', 'energy'],
    supportingVibes: ['groove'],
    strongBoostFamilies: ['pop_mainstream', 'indie_alt', 'dance_electronic', 'house_disco'],
    softBoostFamilies: ['rock_classic', 'latin_global', 'soul_rnb'],
    softPenaltyFamilies: ['ambient_chill', 'jazz_blues', 'orchestral_cinematic'],
    hardVetoFamilies: [],
  },
  get_on_your_feet: {
    preferredVibes: ['energy', 'chaos'],
    supportingVibes: ['lift'],
    strongBoostFamilies: ['dance_electronic', 'house_disco', 'pop_mainstream', 'latin_global', 'hip_hop_rap'],
    softBoostFamilies: ['rock_classic', 'indie_alt', 'soul_rnb'],
    softPenaltyFamilies: ['ambient_chill', 'acoustic_folk', 'jazz_blues', 'orchestral_cinematic'],
    hardVetoFamilies: [],
  },
};

const matchesGenreHint = (genre: string, hint: string) =>
  genre === hint || genre.includes(hint) || hint.includes(genre);

const familyWeightForTrack = (families: readonly GenreFamily[], profile: VibeMixProfile) =>
  families.reduce((score, family) => {
    if (profile.strongBoostFamilies.includes(family)) return score + 4;
    if (profile.softBoostFamilies.includes(family)) return score + 2;
    if (profile.softPenaltyFamilies.includes(family)) return score - 3;
    return score;
  }, 0);

export const VIBE_BUCKETS: VibeBucket[] = [
  { key: 'slowdown', label: 'Slowdown', minBpm: null, maxBpm: 90 },
  { key: 'cruise', label: 'Cruise', minBpm: 90, maxBpm: 110 },
  { key: 'groove', label: 'Groove', minBpm: 110, maxBpm: 120 },
  { key: 'lift', label: 'Lift', minBpm: 120, maxBpm: 130 },
  { key: 'energy', label: 'Energy', minBpm: 130, maxBpm: 145 },
  { key: 'chaos', label: 'Chaos', minBpm: 145, maxBpm: null },
];

export const vibeBucketForBpm = (bpm: number | null | undefined): VibeBucket | null => {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return null;
  return (
    VIBE_BUCKETS.find((bucket) => {
      const meetsMin = bucket.minBpm == null || bpm >= bucket.minBpm;
      const belowMax = bucket.maxBpm == null || bpm < bucket.maxBpm;
      return meetsMin && belowMax;
    }) ?? null
  );
};

export const vibeKeyForTrack = (track: Pick<Track, 'bpm'>): VibeKey | null => vibeBucketForBpm(track.bpm)?.key ?? null;

export const vibeLabelForTrack = (track: Pick<Track, 'bpm'>): string | null =>
  vibeBucketForBpm(track.bpm)?.label ?? null;

export const genreFamiliesForTrack = (track: Pick<Track, 'primary_genre' | 'genre'>): GenreFamily[] => {
  const genres = splitTrackGenreKeys(track.primary_genre ?? track.genre);
  const families = new Set<GenreFamily>();

  for (const genre of genres) {
    for (const matcher of FAMILY_MATCHERS) {
      if (matcher.hints.some((hint) => matchesGenreHint(genre, hint))) {
        families.add(matcher.family);
      }
    }
  }

  return Array.from(families);
};

export const scoreTrackForVibePlaylist = (
  track: Pick<Track, 'bpm' | 'primary_genre' | 'genre' | 'rating' | 'play_count' | 'is_favorite'>,
  mixKey: VibeMixKey,
) => {
  const profile = VIBE_MIX_PROFILES[mixKey];
  const vibe = vibeKeyForTrack(track);
  if (!vibe) {
    return { eligible: false, score: Number.NEGATIVE_INFINITY, vibe, families: [] as GenreFamily[] };
  }

  const matchesPreferred = profile.preferredVibes.includes(vibe);
  const matchesSupporting = profile.supportingVibes.includes(vibe);
  if (!matchesPreferred && !matchesSupporting) {
    return { eligible: false, score: Number.NEGATIVE_INFINITY, vibe, families: [] as GenreFamily[] };
  }

  const families = genreFamiliesForTrack(track);
  if (families.some((family) => profile.hardVetoFamilies.includes(family))) {
    return { eligible: false, score: Number.NEGATIVE_INFINITY, vibe, families };
  }

  const genreWeight = familyWeightForTrack(families, profile);
  if ((profile.minimumGenreWeight ?? Number.NEGATIVE_INFINITY) > genreWeight) {
    return { eligible: false, score: Number.NEGATIVE_INFINITY, vibe, families };
  }

  let score = matchesPreferred ? 6 : 3;
  score += genreWeight;
  if ((track.rating ?? 0) >= 4) score += 1;
  if ((track.play_count ?? 0) >= 5) score += 1;
  if (track.is_favorite) score += 1;

  return { eligible: true, score, vibe, families };
};

export const formatBpm = (bpm: number | null | undefined): string | null => {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return null;
  return String(Math.round(bpm));
};
