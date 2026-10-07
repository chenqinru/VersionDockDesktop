import { createContext, useContext } from 'react';
import { useChangeSearch, changeSearchKey } from './changeSearch';

type RowTarget = { repoId: string; path: string };
export const ChangeRowHighlightContext = createContext<{ selected?: RowTarget; context?: RowTarget }>({});

export function useChangeRowHighlight(repoId: string, path: string, staged?: boolean): string {
  const search = useChangeSearch();
  const active = search.activeKey === changeSearchKey(repoId, path, staged) ? ' speed-search-active' : '';
  const value = useContext(ChangeRowHighlightContext);
  if (value.selected?.repoId === repoId && value.selected.path === path) return `selected${active}`;
  return `${value.context?.repoId === repoId && value.context.path === path ? 'context-active' : ''}${active}`;
}

