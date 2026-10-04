/**
 * Branch name sanitizer and protection utilities.
 * Ported from VersionDock git/utils/branchNameSanitizer.ts & branchProtection.ts
 */

import { useAppStore } from '../store/appStore';

export const DEFAULT_PROTECTED_BRANCHES = ['master', 'main'];

/**
 * Converts a glob-like pattern (e.g. "release/*", "main") into a RegExp.
 */
export function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return /^$/;
  }
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___GLOB_STAR_STAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___GLOB_STAR_STAR___/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Checks whether a branch name matches any protected branch pattern.
 */
export function isBranchProtected(branchName: string, customPatterns?: string[]): boolean {
  const name = branchName.trim().replace(/^refs\/heads\//, '');
  if (!name || name === 'HEAD') {
    return false;
  }

  const effectivePatterns = customPatterns ?? useAppStore.getState?.()?.bootstrap?.state.settings?.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;

  // Strip remote prefix if present (e.g. "origin/main" -> "main", "remotes/origin/main" -> "main")
  const withoutRemotesPrefix = name.replace(/^remotes\//, '');
  const slashIdx = withoutRemotesPrefix.indexOf('/');
  const normalized = slashIdx !== -1 ? withoutRemotesPrefix.slice(slashIdx + 1) : withoutRemotesPrefix;

  for (const value of effectivePatterns) {
    const pattern = value.trim();
    if (!pattern) continue;
    if (pattern.includes('*') || pattern.includes('?')) {
      const rx = globToRegExp(pattern);
      if (rx.test(normalized) || rx.test(withoutRemotesPrefix) || rx.test(name)) {
        return true;
      }
    } else {
      const p = pattern.toLowerCase();
      if (
        normalized.toLowerCase() === p ||
        withoutRemotesPrefix.toLowerCase() === p ||
        name.toLowerCase() === p ||
        name.toLowerCase().endsWith(`/${p}`)
      ) {
        return true;
      }
    }
  }

  return false;
}


/** Query the same repository rules used by native delete/push enforcement. */
export async function isRepositoryBranchProtected(repoId: string, branchName: string): Promise<boolean> {
  const state = useAppStore.getState();
  const workspaceId = state.snapshot?.workspace.id;
  if (!workspaceId || !state.bridge) return isBranchProtected(branchName);
  const patterns = await state.bridge.request<string[]>({ type: 'branchProtection', payload: {
    workspace_id: workspaceId, repo_id: repoId, refresh: true,
  } }, { showProgress: false });
  return isBranchProtected(branchName, Array.isArray(patterns) ? patterns : undefined);
}

/**
 * Sanitizes an input string into a valid Git branch name according to git-check-ref-format rules:
 * - Replaces whitespace and invalid Git characters (~, ^, :, ?, *, [, \, @{, .., control chars) with replacementChar.
 * - Collapses consecutive replacement characters and slashes.
 * - Trims leading and trailing dots, slashes, and replacement characters.
 * - Removes trailing '.lock'.
 */
export function sanitizeBranchName(input: string, replacementChar?: string): string {
  if (!input) return '';

  const rep = replacementChar ?? useAppStore.getState?.()?.bootstrap?.state.settings?.branchCleanCharacter ?? '-';
  const escapedRep = rep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let sanitized = input
    // Replace ASCII control characters (0-31, 127)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, rep)
    // Replace whitespace (space, tab, newline, non-breaking space)
    .replace(/\s+/g, rep)
    // Replace git ref invalid characters: ~, ^, :, ?, *, [, \, @{
    .replace(/[~^:?*[\\\]]/g, rep)
    .replace(/@\{/g, rep)
    // Replace consecutive dots (..)
    .replace(/\.{2,}/g, rep)
    // Collapse consecutive replacement characters
    .replace(new RegExp(`${escapedRep}{2,}`, 'g'), rep)
    // Collapse consecutive slashes
    .replace(/\/{2,}/g, '/');

  // Strip trailing .lock
  sanitized = sanitized.replace(/\.lock$/i, '');

  // Strip leading and trailing invalid characters (dots, slashes, replacement char)
  const trimRegex = new RegExp(`^[./${escapedRep}]+|[./${escapedRep}]+$`, 'g');
  sanitized = sanitized.replace(trimRegex, '');

  return sanitized;
}

/**
 * Validation helper for branch name input dialogs.
 */
export function validateBranchNameInput(
  input: string,
  t: (key: string, ...args: Array<string | number>) => string,
): { valid: boolean; error?: string; formatted?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, error: t('Branch name cannot be empty') };
  }

  const sanitized = sanitizeBranchName(trimmed, '-');
  if (!sanitized) {
    return { valid: false, error: t('Branch name must contain at least one valid character') };
  }

  if (sanitized !== trimmed) {
    return {
      valid: true,
      formatted: sanitized,
      error: t('Contains invalid characters. Will be formatted as: "{0}"', sanitized),
    };
  }

  return { valid: true, formatted: sanitized };
}
