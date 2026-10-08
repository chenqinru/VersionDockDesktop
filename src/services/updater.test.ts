import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check, Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { version } from '../../package.json';
import { checkAppUpdate as nativeCheck, downloadAndInstallAppUpdate as nativeDownload, restartApp, generateDiagnosticReport, isNewerVersion, APP_CURRENT_VERSION, GITHUB_REPO_URL } from './updater';

vi.mock('@tauri-apps/plugin-updater', async (original) => ({ ...(await original<typeof import('@tauri-apps/plugin-updater')>()), check: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...(await original<typeof import('@tauri-apps/api/core')>()), invoke: vi.fn() }));

async function flushRetries<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}
const checkAppUpdate = () => flushRetries(nativeCheck());
const downloadAndInstallAppUpdate = () => flushRetries(nativeDownload());
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

function updateFixture() {
  return {
    available: true, version: '0.1.1', currentVersion: version, date: '2026-10-06', body: 'Release notes',
    download: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Update;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
  vi.mocked(check).mockReset().mockResolvedValue(null);
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('updater service', () => {
  it('does not silently install a different version after a background check changes the cache', async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValueOnce(update);
    await checkAppUpdate();
    await expect(flushRetries(nativeDownload(undefined, '0.0.1'))).rejects.toThrow('selected update version has changed');
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
  });
  it('recovers from a startup network failure within three attempts', async () => {
    const update = updateFixture();
    vi.mocked(check).mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce(update);
    expect(await checkAppUpdate()).toMatchObject({ available: true });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('switches a failed GitHub download to the same version on the configured mirror', async () => {
    const primary = updateFixture();
    vi.mocked(primary.download).mockRejectedValue(new Error('GitHub timed out'));
    vi.mocked(check).mockResolvedValueOnce(primary);
    vi.mocked(invoke).mockResolvedValueOnce({ rid: 1, version: primary.version, currentVersion: version, rawJson: {} });
    const mirrorDownload = vi.spyOn(Update.prototype, 'download').mockResolvedValue(undefined);
    const mirrorInstall = vi.spyOn(Update.prototype, 'install').mockResolvedValue(undefined);
    vi.spyOn(Update.prototype, 'close').mockResolvedValue(undefined);
    await checkAppUpdate();
    await downloadAndInstallAppUpdate();
    expect(invoke).toHaveBeenCalledWith('check_update_mirror');
    expect(mirrorDownload).toHaveBeenCalledOnce();
    expect(mirrorInstall).toHaveBeenCalledOnce();
    expect(primary.install).not.toHaveBeenCalled();
  });

  it('never repeats a failing native installer automatically', async () => {
    const update = updateFixture();
    vi.mocked(update.install).mockRejectedValue(new Error('installer failed'));
    vi.mocked(check).mockResolvedValueOnce(update);
    await checkAppUpdate();
    await expect(downloadAndInstallAppUpdate()).rejects.toThrow('installer failed');
    expect(update.install).toHaveBeenCalledOnce();
    expect(update.download).toHaveBeenCalledOnce();
  });

  it('rejects switching to a different mirror version', async () => {
    const update = updateFixture();
    vi.mocked(update.download).mockRejectedValue(new Error('GitHub timed out'));
    vi.mocked(check).mockResolvedValueOnce(update);
    vi.mocked(invoke).mockResolvedValueOnce({ rid: 1, version: '9.9.9', currentVersion: version, rawJson: {} });
    vi.spyOn(Update.prototype, 'close').mockResolvedValue(undefined);
    await checkAppUpdate();
    await expect(downloadAndInstallAppUpdate()).rejects.toThrow('selected version');
    expect(update.install).not.toHaveBeenCalled();
  });
  it('propagates native restart failure instead of refreshing the webview as a successful restart', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('restart unavailable'));
    await expect(restartApp()).rejects.toThrow('restart unavailable');
  });

  it('uses the backend restart path after an update', async () => {
    await restartApp();
    expect(invoke).toHaveBeenCalledWith('restart_app');
  });

  it('uses the package version and public releases repository', () => {
    expect(APP_CURRENT_VERSION).toBe(version);
    expect(GITHUB_REPO_URL).toBe('https://github.com/chenqinru/VersionDockDesktop');
  });

  it('reports up to date only after a successful native check', async () => {
    expect(await checkAppUpdate()).toMatchObject({ available: false, currentVersion: version, rawUpdate: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the native update required for installation', async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update);
    expect(await checkAppUpdate()).toMatchObject({ available: true, latestVersion: '0.1.1', rawUpdate: update });
  });

  it.each(['404', 'Could not fetch a valid release JSON', 'missing platform linux-x86_64', 'request timed out'])(
    'reports a native check failure instead of claiming up to date: %s', async (message) => {
      vi.mocked(check).mockRejectedValue(new Error(message));
      const result = await checkAppUpdate();
      expect(result).toMatchObject({ available: false, error: message });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/chenqinru/VersionDockDesktop/releases/latest', expect.any(Object),
      );
    },
  );

  it('API fallback preserves the native error and cannot offer a browser download as an installed update', async () => {
    vi.mocked(check).mockRejectedValue(new Error('invalid update manifest'));
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.2.0', body: 'New version' }) } as Response);
    expect(await checkAppUpdate()).toMatchObject({ available: false, error: 'invalid update manifest', latestVersion: '0.2.0', rawUpdate: null });
  });

  it('failed checks invalidate previously cached update packages', async () => {
    const obsolete = updateFixture();
    vi.mocked(check).mockResolvedValueOnce(obsolete).mockRejectedValueOnce(new Error('404')).mockRejectedValueOnce(new Error('404')).mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(null);
    await checkAppUpdate();
    await checkAppUpdate();
    await expect(downloadAndInstallAppUpdate()).rejects.toThrow('No update package');
    expect(obsolete.download).not.toHaveBeenCalled();
  });

  it('failed downloads report the error and clear the package before retrying', async () => {
    const failed = updateFixture();
    const retry = updateFixture();
    vi.mocked(failed.download).mockRejectedValue(new Error('download timed out'));
    vi.mocked(check).mockResolvedValueOnce(failed).mockResolvedValueOnce(retry);
    await checkAppUpdate();
    await expect(downloadAndInstallAppUpdate()).rejects.toThrow('download timed out');
    await downloadAndInstallAppUpdate();
    expect(retry.download).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('a slow older check cannot restore the cache after a newer check fails', async () => {
    const obsolete = updateFixture();
    let completeOlder!: (update: Update) => void;
    vi.mocked(check).mockReturnValueOnce(new Promise((resolve) => { completeOlder = resolve; }))
      .mockRejectedValueOnce(new Error('404')).mockRejectedValueOnce(new Error('404')).mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(null);
    const older = checkAppUpdate();
    await checkAppUpdate();
    completeOlder(obsolete);
    await older;
    await expect(downloadAndInstallAppUpdate()).rejects.toThrow('No update package');
    expect(obsolete.download).not.toHaveBeenCalled();
  });

  describe('isNewerVersion', () => {
    it('correctly compares semantic versions', () => {
      expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true);
      expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
      expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true);
      expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
      expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false);
      expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
    });
  });

  describe('generateDiagnosticReport', () => {
    it('generates markdown report with system and tools information', () => {
      const snapshot = {
        generation: 1,
        workspace: { id: 'ws-1', name: 'Test WS', paths: ['/path/to/repo'], available: true, lastOpenedAt: new Date().toISOString() },
        tools: { git: true, svn: false, svnadmin: false },
        repositories: [],
      };
      const settings = {
        theme: 'dark' as const,
        language: 'en' as const,
        uiFontSize: 'standard' as const,
        changesDisplayMode: 'simplified' as const,
        defaultCommitAction: 'commit' as const,
        defaultSaveAction: 'stash' as const,
        promptBeforeAddingUntracked: true,
        suppressDivergedWarning: false,
        autoRefreshInterval: 0,
        fetchOnStartup: false,
        resetViewLocationsOnStartup: false,
        notifyIncomingCommits: false,
        notifyUnpushedCommits: false,
        autoCheckUpdates: true,
        repositoryScanDepth: 4,
        ignoredFolders: [],
        maximumGraphCommits: 1000,
        projectColors: {},
        externalEditor: null,
      };

      const report = generateDiagnosticReport(snapshot, settings);
      expect(report).toContain(`- **App Version**: v${APP_CURRENT_VERSION}`);
      expect(report).toContain('- **Git**: Available / Installed');
      expect(report).toContain('- **SVN**: Not installed');
      expect(report).toContain('- **Auto Check Updates**: Enabled');
    });
  });
});
