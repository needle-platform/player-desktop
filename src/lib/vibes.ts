import type { Track } from '../types';

export type VibeKey = 'slowdown' | 'cruise' | 'groove' | 'lift' | 'energy' | 'chaos';

export type VibeBucket = {
  key: VibeKey;
  label: string;
  minBpm: number | null;
  maxBpm: number | null;
};

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

export const formatBpm = (bpm: number | null | undefined): string | null => {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return null;
  return String(Math.round(bpm));
};
