export interface SourceTagToken {
  key: string;
  label: string;
}

export const sourceTagPresets = ['vinyl-rip', 'cd-rip', 'digital-purchase'];

const SOURCE_TAG_SPLIT_PATTERN = /[;,/|\n]/;
const SOURCE_TAG_ALIASES: Record<string, string> = {
  vinyl: 'vinyl-rip',
  'vinyl-rip': 'vinyl-rip',
  needledrop: 'vinyl-rip',
  'needle-drop': 'vinyl-rip',
  cd: 'cd-rip',
  'cd-rip': 'cd-rip',
  digital: 'digital-purchase',
  download: 'digital-purchase',
  'digital-download': 'digital-purchase',
  'digital-purchase': 'digital-purchase',
};

export const normalizeSourceTagKey = (value: string | null | undefined) => {
  const normalized = (value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[‐‑–—_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized) return null;
  return SOURCE_TAG_ALIASES[normalized] ?? normalized;
};

export const sourceTagLabelFromKey = (key: string) => key;

export const sourceTagDisplayLabelFromKey = (key: string) => {
  switch (key) {
    case 'vinyl-rip':
      return 'vinyl';
    case 'cd-rip':
      return 'cd';
    case 'digital-purchase':
      return 'digital';
    default:
      return key;
  }
};

export const splitSourceTagEntries = (value: string | string[] | null | undefined): SourceTagToken[] => {
  const rawParts = Array.isArray(value) ? value : (value ?? '').split(SOURCE_TAG_SPLIT_PATTERN);
  const seen = new Set<string>();
  const entries: SourceTagToken[] = [];

  for (const part of rawParts) {
    const key = normalizeSourceTagKey(part);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, label: sourceTagLabelFromKey(key) });
  }

  return entries;
};

export const splitSourceTags = (value: string | string[] | null | undefined) =>
  splitSourceTagEntries(value).map((entry) => entry.label);
