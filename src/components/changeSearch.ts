import { createContext, useContext, type ContextType } from 'react';
import type { FileChange } from '../bindings/generated';

export function changeSearchKey(repoId: string, path: string, staged?: boolean): string {
  return JSON.stringify([repoId, staged ?? null, path]);
}
export const ChangeSearchContext = createContext<{ query: string; activeKey?: string; matchedKeys: ReadonlySet<string> }>({ query: '', matchedKeys: new Set() });
export function useChangeSearch() { return useContext(ChangeSearchContext); }
export function hasSearchMatch(search: ContextType<typeof ChangeSearchContext>, repoId: string, files: readonly FileChange[], staged?: boolean): boolean {
  return files.some(file => search.matchedKeys.has(changeSearchKey(repoId, file.path, staged)));
}
