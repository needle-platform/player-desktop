export interface GenreToken {
  key: string;
  label: string;
}

const GENRE_SPLIT_PATTERN = /[;,/]/;
const GENRE_ALIASES: Record<string, string> = {
  'drum and base': 'drum and bass',
  'drum n bass': 'drum and bass',
  'r and b': 'r&b',
  rnb: 'r&b',
};
const GENRE_LABEL_OVERRIDES: Record<string, string> = {
  'r&b': 'R&B',
};
const LOWERCASE_WORDS = new Set(['a', 'an', 'and', 'of', 'or', 'the']);

const titleCaseGenreLabel = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .map((part, index) => {
      if (index > 0 && LOWERCASE_WORDS.has(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');

export const normalizeGenreKey = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;

  const normalized = trimmed
    .toLocaleLowerCase()
    .replace(/[‐‑–—_-]+/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .replace(/^and\s+/, '')
    .replace(/\s+and$/, '')
    .trim();

  if (!normalized) return null;
  return GENRE_ALIASES[normalized] ?? normalized;
};

export const genreLabelFromKey = (key: string) => GENRE_LABEL_OVERRIDES[key] ?? titleCaseGenreLabel(key);

export const splitTrackGenreEntries = (value: string | null | undefined): GenreToken[] => {
  const seen = new Set<string>();
  const entries: GenreToken[] = [];

  for (const part of (value ?? '').split(GENRE_SPLIT_PATTERN)) {
    const key = normalizeGenreKey(part);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, label: genreLabelFromKey(key) });
  }

  return entries;
};

export const splitTrackGenres = (value: string | null | undefined) =>
  splitTrackGenreEntries(value).map((entry) => entry.label);

export const splitTrackGenreKeys = (value: string | null | undefined) =>
  splitTrackGenreEntries(value).map((entry) => entry.key);
