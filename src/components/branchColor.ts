const DARK_PALETTE = [
  '#6aaed0', '#cc6a9a', '#6ab86a', '#cc7070', '#8c70cc', '#cc7a50', '#4aaa9a', '#cc8060',
  '#a0cc6a', '#6a8ecc', '#cc6ab0', '#7acc80', '#cc6060', '#6accc0', '#b870cc', '#6ab0d0',
] as const;

const LIGHT_PALETTE = [
  '#2e6898', '#962860', '#2a7828', '#963232', '#4a2e96', '#963818', '#1a7a6a', '#964018',
  '#587818', '#2a4e98', '#962878', '#2a7840', '#982020', '#287878', '#6a2496', '#2a6890',
] as const;

const PRIMARY_BRANCH = /^(main|master|develop|development|dev|trunk)$/i;

export function branchColor(name: string): string {
  if (PRIMARY_BRANCH.test(name)) return document.documentElement.dataset.theme === 'light' ? '#2e6898' : '#6aaed0';
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const palette = document.documentElement.dataset.theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  return palette[hash % palette.length];
}
