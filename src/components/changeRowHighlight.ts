import { createContext, useContext } from 'react';

type RowTarget = { repoId: string; path: string };
export const ChangeRowHighlightContext = createContext<{ selected?: RowTarget; context?: RowTarget }>({});

export function useChangeRowHighlight(repoId: string, path: string): string {
  const value = useContext(ChangeRowHighlightContext);
  if (value.selected?.repoId === repoId && value.selected.path === path) return 'selected';
  return value.context?.repoId === repoId && value.context.path === path ? 'context-active' : '';
}

