/**
 * Commit safety inspection utilities.
 * Ported from VersionDock host/utils/commitSafetyCheck.ts
 */

import { useAppStore } from '../store/appStore';

export const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(?:\.local|\.production|\.development|\.staging)?$/i,
  /\.(?:pem|key|pfx|p12|pkcs12|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
];

// Windows-reserved file base names
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Characters forbidden in Windows filenames: < > : " | ? * and ASCII control characters
// eslint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN_CHARS_REGEX = /[<>:"|?*\x00-\x1F]/;

export function isSensitivePath(filePath: string): boolean {
  const baseName = filePath.split('/').pop() || filePath;
  return SENSITIVE_FILENAME_PATTERNS.some((pattern) => pattern.test(baseName));
}

export interface LargeFileInfo {
  path: string;
  sizeBytes: number;
  sizeFormatted: string;
}

export interface InvalidFileNameInfo {
  path: string;
  reason: string;
}

export interface CommitSafetyCheckResult {
  hasIssues: boolean;
  sensitiveFiles: string[];
  invalidFileNameFiles: InvalidFileNameInfo[];
  largeFiles: LargeFileInfo[];
  crlfFiles: string[];
}

export interface CommitSafetyOptions {
  warnOnInvalidFileNames?: boolean;
}

export function checkCommitSafety(paths: string[], options?: CommitSafetyOptions): CommitSafetyCheckResult {
  const warnInvalid = options?.warnOnInvalidFileNames ?? useAppStore.getState?.()?.bootstrap?.state.settings?.warnOnInvalidFileNames ?? true;
  const sensitiveFiles: string[] = [];
  const invalidFileNameFiles: InvalidFileNameInfo[] = [];
  const seenLowercasePaths = new Map<string, string>();

  for (const relPath of paths) {
    const base = relPath.split('/').pop() || relPath;

    // 1. Sensitive filenames
    if (!base.endsWith('.example') && !base.endsWith('.sample') && !base.endsWith('.template')) {
      if (SENSITIVE_FILENAME_PATTERNS.some((pattern) => pattern.test(base))) {
        sensitiveFiles.push(relPath);
      }
    }

    // 2. Windows invalid or cross-platform collision
    if (warnInvalid) {
      const baseWithoutExt = base.split('.')[0]?.toLowerCase() ?? '';
      if (WINDOWS_FORBIDDEN_CHARS_REGEX.test(base)) {
        invalidFileNameFiles.push({ path: relPath, reason: 'contains characters forbidden on Windows (: * ? " < > |)' });
      } else if (base.endsWith(' ') || base.endsWith('.')) {
        invalidFileNameFiles.push({ path: relPath, reason: 'ends with space or dot' });
      } else if (WINDOWS_RESERVED_NAMES.has(baseWithoutExt)) {
        invalidFileNameFiles.push({ path: relPath, reason: `uses Windows-reserved name "${baseWithoutExt}"` });
      }

      const lowerKey = relPath.toLowerCase();
      const existing = seenLowercasePaths.get(lowerKey);
      if (existing && existing !== relPath) {
        invalidFileNameFiles.push({ path: relPath, reason: `case collision with "${existing}"` });
      } else {
        seenLowercasePaths.set(lowerKey, relPath);
      }
    }
  }

  return {
    hasIssues: sensitiveFiles.length > 0 || invalidFileNameFiles.length > 0,
    sensitiveFiles,
    invalidFileNameFiles,
    largeFiles: [],
    crlfFiles: [],
  };
}

export async function performCommitSafetyCheck(
  workspaceId: string,
  repoId: string,
  paths: string[],
): Promise<CommitSafetyCheckResult> {
  try {
    const bridge = useAppStore.getState?.()?.bridge;
    if (!bridge) {
      return checkCommitSafety(paths);
    }
    const res = await bridge.request<CommitSafetyCheckResult>({
      type: 'commitSafetyCheck',
      payload: {
        workspace_id: workspaceId,
        repo_id: repoId,
        paths,
      },
    });
    return res;
  } catch {
    return checkCommitSafety(paths);
  }
}
