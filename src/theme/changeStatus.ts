export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'ignored' | 'unknown';

const letters: Record<ChangeStatus, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C',
  untracked: 'U', conflicted: 'C', ignored: 'I', unknown: '?',
};

// Working files use full names; Git history uses codes such as R100/C100.
// A raw C means copied. Conflicts are explicit or use Git's unmerged U code.
export function changeStatus(status: string, conflicted = false): ChangeStatus {
  if (conflicted) return 'conflicted';
  const value = status.trim().toLowerCase();
  if (Object.hasOwn(letters, value)) return value as ChangeStatus;
  if (/^r\d*$/.test(value)) return 'renamed';
  if (/^c\d*$/.test(value)) return 'copied';
  switch (value) {
    case 'a': return 'added';
    case 'm': case 't': return 'modified';
    case 'd': return 'deleted';
    case '?': case '??': return 'untracked';
    case 'u': return 'conflicted';
    case '!': case '!!': return 'ignored';
    default: return 'unknown';
  }
}

export function changeStatusLetter(status: string, conflicted = false): string {
  return letters[changeStatus(status, conflicted)];
}

export function changeStatusColor(status: string, conflicted = false): string {
  const normalized = changeStatus(status, conflicted);
  return normalized === 'unknown' ? 'var(--versiondock-text)' : `var(--versiondock-change-${normalized})`;
}
