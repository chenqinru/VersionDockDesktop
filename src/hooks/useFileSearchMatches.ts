import { useCallback, useMemo, useState } from 'react';

export interface SearchableFile {
  key: string;
  path: string;
  name?: string;
}

export function matchesFileQuery(file: Pick<SearchableFile, 'path' | 'name'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  const path = file.path.toLowerCase().replace(/\\/g, '/');
  const name = (file.name ?? path.split('/').at(-1) ?? path).toLowerCase();
  return (!needle.includes('/') && name.includes(needle)) || path.includes(needle);
}

// Standalone plugin details retain the active file; sidebar/changes retain its index.
export function useFileSearchMatches<T extends SearchableFile>(items: readonly T[], query: string, preserve: 'key' | 'index' = 'index') {
  const matches = useMemo(() => items.filter(file => matchesFileQuery(file, query)), [items, query]);
  const [selection, setSelection] = useState({ index: 0, key: '' });
  const retained = preserve === 'key' ? matches.findIndex(file => file.key === selection.key) : selection.index;
  const index = retained >= 0 && retained < matches.length ? retained : 0;
  const active = matches[index];
  const key = active?.key ?? '';
  if (selection.index !== index || selection.key !== key) setSelection({ index, key });
  const navigate = useCallback((direction: -1 | 1) => {
    if (!matches.length) return;
    const next = (index + direction + matches.length) % matches.length;
    setSelection({ index: next, key: matches[next].key });
  }, [index, matches]);
  return { matches, active, index, navigate };
}
