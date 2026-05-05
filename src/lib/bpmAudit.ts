import type { Track, TrackBpmAdjustment } from '../types';
import { genreFamiliesForTrack, type GenreFamily } from './vibes';

export interface BpmAuditReason {
  id: string;
  label: string;
  suggestedAdjustment?: TrackBpmAdjustment;
}

export type BpmAuditConfidence = 'low' | 'medium' | 'high';

export interface BpmAuditItem {
  track: Track;
  score: number;
  reasons: BpmAuditReason[];
  suggestedAdjustment: TrackBpmAdjustment | null;
  albumMedianBpm: number | null;
  confidence: BpmAuditConfidence;
  autoFixEligible: boolean;
}

const calmFamilies = new Set<GenreFamily>(['ambient_chill', 'acoustic_folk', 'soul_rnb', 'jazz_blues']);
const energeticFamilies = new Set<GenreFamily>([
  'dance_electronic',
  'house_disco',
  'hip_hop_rap',
  'rock_hard',
  'metal_punk',
]);

const albumKeyForTrack = (track: Pick<Track, 'album' | 'album_artist' | 'artist' | 'path'>) => {
  const album = track.album?.trim();
  if (!album) return `track:${track.path}`;
  return `${album}\u001f${track.album_artist?.trim() ?? track.artist?.trim() ?? ''}`;
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left == null || right == null) return sorted[middle] ?? null;
  return Math.round((left + right) / 2);
};

const collectAlbumMedians = (tracks: Track[]) => {
  const groups = new Map<string, number[]>();
  for (const track of tracks) {
    if (track.bpm == null || track.bpm <= 0) continue;
    const key = albumKeyForTrack(track);
    const existing = groups.get(key);
    if (existing) existing.push(track.bpm);
    else groups.set(key, [track.bpm]);
  }

  const medians = new Map<string, number>();
  for (const [key, values] of groups.entries()) {
    if (values.length < 4) continue;
    const value = median(values);
    if (value != null) medians.set(key, value);
  }
  return medians;
};

const chooseSuggestedAdjustment = (reasons: BpmAuditReason[]) => {
  const halfVotes = reasons.filter((reason) => reason.suggestedAdjustment === 'half').length;
  const doubleVotes = reasons.filter((reason) => reason.suggestedAdjustment === 'double').length;
  if (halfVotes === 0 && doubleVotes === 0) return null;
  return halfVotes >= doubleVotes ? 'half' : 'double';
};

const adjustedBpmForSuggestion = (
  bpm: number,
  suggestion: TrackBpmAdjustment | null,
): number | null => {
  if (suggestion === 'half') {
    return Math.max(1, Math.round(bpm / 2));
  }
  if (suggestion === 'double') {
    return Math.max(1, bpm * 2);
  }
  return null;
};

const albumReasonIds = new Set(['album-outlier-high', 'album-outlier-low']);
const globalReasonIds = new Set([
  'very-high-bpm',
  'very-low-bpm',
  'calm-family-high-bpm',
  'energetic-family-low-bpm',
]);

export const findSuspiciousBpmTracks = (tracks: Track[], limit = 40): BpmAuditItem[] => {
  const albumMedians = collectAlbumMedians(tracks);
  const items: BpmAuditItem[] = [];

  for (const track of tracks) {
    const bpm = track.bpm;
    if (bpm == null || bpm <= 0) continue;

    const reasons: BpmAuditReason[] = [];
    let score = 0;
    const families = genreFamiliesForTrack(track);
    const hasCalmFamily = families.some((family) => calmFamilies.has(family));
    const hasEnergeticFamily = families.some((family) => energeticFamilies.has(family));

    if (bpm >= 185) {
      reasons.push({
        id: 'very-high-bpm',
        label: 'Very high BPM; often a half-time tagging issue',
        suggestedAdjustment: 'half',
      });
      score += 4;
    } else if (bpm <= 55) {
      reasons.push({
        id: 'very-low-bpm',
        label: 'Very low BPM; often a double-time tagging issue',
        suggestedAdjustment: 'double',
      });
      score += 4;
    }

    if (hasCalmFamily && bpm >= 150) {
      reasons.push({
        id: 'calm-family-high-bpm',
        label: 'Higher than expected for calmer genre families',
        suggestedAdjustment: 'half',
      });
      score += 3;
    }

    if (hasEnergeticFamily && bpm <= 75) {
      reasons.push({
        id: 'energetic-family-low-bpm',
        label: 'Lower than expected for more energetic genre families',
        suggestedAdjustment: 'double',
      });
      score += 3;
    }

    const albumMedianBpm = albumMedians.get(albumKeyForTrack(track)) ?? null;
    if (albumMedianBpm != null) {
      if (bpm >= albumMedianBpm * 1.75 && bpm - albumMedianBpm >= 35) {
        const halfCandidateDistance = Math.abs(Math.round(bpm / 2) - albumMedianBpm);
        reasons.push({
          id: 'album-outlier-high',
          label:
            halfCandidateDistance <= 12
              ? `Far above this album's usual BPM range (album median ${albumMedianBpm})`
              : `Noticeably above this album's usual BPM range (album median ${albumMedianBpm})`,
          suggestedAdjustment: halfCandidateDistance <= 12 ? 'half' : undefined,
        });
        score += halfCandidateDistance <= 12 ? 5 : 3;
      } else if (bpm <= albumMedianBpm * 0.6 && albumMedianBpm - bpm >= 35) {
        const doubleCandidateDistance = Math.abs(bpm * 2 - albumMedianBpm);
        reasons.push({
          id: 'album-outlier-low',
          label:
            doubleCandidateDistance <= 18
              ? `Far below this album's usual BPM range (album median ${albumMedianBpm})`
              : `Noticeably below this album's usual BPM range (album median ${albumMedianBpm})`,
          suggestedAdjustment: doubleCandidateDistance <= 18 ? 'double' : undefined,
        });
        score += doubleCandidateDistance <= 18 ? 5 : 3;
      }
    }

    if (reasons.length === 0) continue;

    const suggestedAdjustment = chooseSuggestedAdjustment(reasons);
    const adjustedBpm =
      suggestedAdjustment != null ? adjustedBpmForSuggestion(bpm, suggestedAdjustment) : null;
    const supportingReasons =
      suggestedAdjustment != null
        ? reasons.filter((reason) => reason.suggestedAdjustment === suggestedAdjustment)
        : [];
    const albumAgreementDistance =
      albumMedianBpm != null && adjustedBpm != null ? Math.abs(adjustedBpm - albumMedianBpm) : null;
    const hasAlbumSupport = supportingReasons.some((reason) => albumReasonIds.has(reason.id));
    const hasGlobalSupport = supportingReasons.some((reason) => globalReasonIds.has(reason.id));
    const autoFixEligible =
      suggestedAdjustment != null &&
      albumMedianBpm != null &&
      albumAgreementDistance != null &&
      albumAgreementDistance <= 8 &&
      hasAlbumSupport &&
      hasGlobalSupport;
    const confidence: BpmAuditConfidence = autoFixEligible
      ? 'high'
      : suggestedAdjustment != null &&
          albumMedianBpm != null &&
          albumAgreementDistance != null &&
          albumAgreementDistance <= 14 &&
          supportingReasons.length >= 2
        ? 'medium'
        : suggestedAdjustment != null && supportingReasons.length >= 2
          ? 'medium'
          : 'low';

    items.push({
      track,
      score,
      reasons,
      suggestedAdjustment,
      albumMedianBpm,
      confidence,
      autoFixEligible,
    });
  }

  return items
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.reasons.length - a.reasons.length ||
        (b.track.bpm ?? 0) - (a.track.bpm ?? 0) ||
        a.track.title.localeCompare(b.track.title),
    )
    .slice(0, limit);
};
