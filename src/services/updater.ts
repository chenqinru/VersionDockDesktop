import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl } from '@tauri-apps/plugin-opener';
import { APP_CURRENT_VERSION } from '../version';
import type { WorkspaceSnapshot, DesktopSettings } from '../bindings/generated';

export interface AppUpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseDate?: string;
  releaseNotes?: string;
  rawUpdate?: Update | null;
  error?: string | null;
  isDevelopmentMode?: boolean;
}

export interface UpdateDownloadProgress {
  chunkLength: number;
  contentLength?: number;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export { APP_CURRENT_VERSION } from '../version';
export const GITHUB_REPO_URL = 'https://github.com/chenqinru/VersionDockDesktop-Releases';
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues/new`;
export const AUTHOR_GITHUB_URL = 'https://github.com/chenqinru';
export const AUTHOR_NAME = 'chenqinru';
export const SPONSOR_URL = 'https://github.com/sponsors/chenqinru';
export const LICENSE_NAME = 'GPL-3.0';

let cachedUpdateInstance: Update | null = null;
let checkGeneration = 0;

/**
 * 检查应用是否有新版本
 */
export async function checkAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = APP_CURRENT_VERSION;
  const generation = ++checkGeneration;
  cachedUpdateInstance = null;
  try {
    const update = await check({ timeout: 30_000 });
    if (!update) {
      return {
        available: false,
        currentVersion,
        rawUpdate: null,
      };
    }

    if (generation === checkGeneration) cachedUpdateInstance = update;
    return {
      available: update.available,
      currentVersion: update.currentVersion || currentVersion,
      latestVersion: update.version,
      releaseDate: update.date,
      releaseNotes: update.body || '',
      rawUpdate: update,
    };
  } catch (error) {
    if (generation === checkGeneration) cachedUpdateInstance = null;
    const message = error instanceof Error ? error.message : String(error);
    const isDev = message.includes('pubkey') || message.includes('target not set') || !('__TAURI_INTERNALS__' in window);

    // 尝试通过 GitHub API 获取最新 Release 信息供展示
    try {
      const res = await fetch(`${GITHUB_REPO_URL.replace('https://github.com/', 'https://api.github.com/repos/')}/releases/latest`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json();
        const latestTag = (data.tag_name || '').replace(/^v/, '');
        return {
          available: false,
          currentVersion,
          latestVersion: latestTag || currentVersion,
          releaseDate: data.published_at,
          releaseNotes: data.body || '',
          rawUpdate: null,
          error: message,
          isDevelopmentMode: isDev,
        };
      }
    } catch {
      // 忽略 GitHub API 备选探测错误
    }

    return {
      available: false,
      currentVersion,
      error: message,
      isDevelopmentMode: isDev,
    };
  }
}

/**
 * 比较两语义版本号，target 是否高于 current
 */
export function isNewerVersion(current: string, target: string): boolean {
  if (!target || !current) return false;
  const currentParts = current.split('.').map((p) => parseInt(p, 10) || 0);
  const targetParts = target.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(currentParts.length, targetParts.length); i++) {
    const c = currentParts[i] ?? 0;
    const t = targetParts[i] ?? 0;
    if (t > c) return true;
    if (t < c) return false;
  }
  return false;
}

/**
 * 下载并安装更新
 */
export async function downloadAndInstallAppUpdate(
  onProgress?: (progress: UpdateDownloadProgress) => void,
): Promise<void> {
  const update = cachedUpdateInstance || (await check({ timeout: 30_000 }));
  if (!update) {
    throw new Error('No update package available to install.');
  }

  let downloaded = 0;
  let total = 0;

  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? 0;
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          onProgress?.({
            chunkLength: event.data.chunkLength,
            contentLength: total,
            downloadedBytes: downloaded,
            totalBytes: total,
            percent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
          });
          break;
        case 'Finished':
          break;
      }
    });
  } finally {
    cachedUpdateInstance = null;
  }
}

/**
 * 重启应用程序以完成更新
 */
export async function restartApp(): Promise<void> {
  // Reloading the webview does not restart the native app or finish an update.
  await relaunch();
}

/**
 * 在外部浏览器中打开链接
 */
export async function openExternalLink(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * 生成用于复制的系统环境与诊断信息
 */
export function generateDiagnosticReport(
  snapshot: WorkspaceSnapshot | null | undefined,
  settings: DesktopSettings | null | undefined,
): string {
  const osInfo = typeof navigator !== 'undefined' ? `${navigator.userAgent}` : 'Unknown OS';
  const platform = typeof navigator !== 'undefined' && 'platform' in navigator ? (navigator as { platform?: string }).platform : 'Desktop';
  const tools = snapshot?.tools;
  const gitVer = tools?.git ? 'Available / Installed' : 'Not installed';
  const svnVer = tools?.svn ? 'Available / Installed' : 'Not installed';
  const repoCount = snapshot?.repositories?.length ?? 0;

  return [
    '### VersionDock Desktop Diagnostic Information',
    `- **App Version**: v${APP_CURRENT_VERSION}`,
    `- **Platform / User Agent**: ${platform} (${osInfo})`,
    `- **Git**: ${gitVer}`,
    `- **SVN**: ${svnVer}`,
    `- **Repositories Loaded**: ${repoCount}`,
    `- **Theme**: ${settings?.theme ?? 'system'}`,
    `- **Language**: ${settings?.language ?? 'system'}`,
    `- **Font Size**: ${settings?.uiFontSize ?? 'standard'}`,
    `- **Auto Check Updates**: ${settings?.autoCheckUpdates !== false ? 'Enabled' : 'Disabled'}`,
    `- **Report Generated**: ${new Date().toISOString()}`,
  ].join('\n');
}
