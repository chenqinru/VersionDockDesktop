const DARK_PALETTE = [
  '#6aaed0', '#cc6a9a', '#6ab86a', '#cc7070', '#8c70cc', '#cc7a50', '#4aaa9a', '#cc8060',
  '#a0cc6a', '#6a8ecc', '#cc6ab0', '#7acc80', '#cc6060', '#6accc0', '#b870cc', '#6ab0d0',
] as const;

const LIGHT_PALETTE = [
  '#2e6898', '#962860', '#2a7828', '#963232', '#4a2e96', '#963818', '#1a7a6a', '#964018',
  '#587818', '#2a4e98', '#962878', '#2a7840', '#982020', '#287878', '#6a2496', '#2a6890',
] as const;

const PRIMARY_BRANCH = /^(main|master|prod|develop|development|dev|trunk|release)(?:[/-].*)?$/i;

function normalizedBranchName(name: string): string {
  if (name.startsWith('refs/heads/')) return name.slice('refs/heads/'.length);
  if (name.startsWith('refs/remotes/')) {
    const remoteRef = name.slice('refs/remotes/'.length);
    const slash = remoteRef.indexOf('/');
    return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  }
  if (/^(origin|upstream|gitee|remotes)\//.test(name)) return name.slice(name.indexOf('/') + 1);
  return name;
}

export function primaryBranchColor(): string {
  return 'var(--versiondock-accent)';
}

export function headColor(): string {
  return 'var(--versiondock-warning)';
}

export function tagColor(): string {
  return 'var(--versiondock-muted)';
}

export function branchColor(name: string, isHead = false, isTag = false): string {
  const normalized = normalizedBranchName(name);
  if (isTag) return tagColor();
  if (PRIMARY_BRANCH.test(normalized)) return primaryBranchColor();
  if (isHead) return headColor();
  let hash = 0;
  for (const character of normalized) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const palette = document.documentElement.dataset.theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  return palette[hash % palette.length];
}

export function currentPalette(): readonly string[] {
  return document.documentElement.dataset.theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}

export function branchPaletteIndex(name: string): number {
  const normalized = normalizedBranchName(name);
  let hash = 0;
  for (const character of normalized) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % DARK_PALETTE.length;
}
