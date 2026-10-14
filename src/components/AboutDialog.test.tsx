import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, createTranslator } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { AboutDialog } from './AboutDialog';
import * as updaterService from '../services/updater';
import { version } from '../../package.json';
import releaseHistory from '../release-notes.json';
import type { BootstrapData } from '../bindings/generated';

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const renderAboutDialog = (onClose = vi.fn(), initialTab: 'about' | 'changelog' = 'about', language: 'en' | 'zh-CN' = 'en') => {
  useAppStore.setState({
    ready: true,
    bootstrap: undefined,
    snapshot: {
      generation: 1,
      workspace: { id: 'ws-1', name: 'Test WS', paths: ['/path/to/repo'], available: true, lastOpenedAt: new Date().toISOString() },
      tools: { git: true, svn: true, svnadmin: true },
      repositories: [],
    },
  });

  const view = render(
    <I18nContext.Provider value={{ language, preference: 'system', t: createTranslator(language) }}>
      <AboutDialog onClose={onClose} initialTab={initialTab} />
    </I18nContext.Provider>,
  );
  return { onClose, ...view };
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ ready: false, bootstrap: undefined, snapshot: undefined, updateAvailableInfo: null });
  useAppUpdateStore.setState({ phase: 'idle', targetVersion: null, progress: null, error: null });
  vi.restoreAllMocks();
});

describe('AboutDialog', () => {
  it.each(['en', 'zh-CN'] as const)('keeps diagnostics and log actions visible in %s', (language) => {
    renderAboutDialog(vi.fn(), 'about', language);
    const t = createTranslator(language);
    expect(screen.getByText(t('Environment & Diagnostics'))).toBeVisible();
    expect(screen.getAllByText(t('Available'))).toHaveLength(2);
    expect(screen.getByRole('button', { name: t('View Output & Logs') })).toBeVisible();
    expect(screen.getByRole('button', { name: t('Open Log Folder') })).toBeVisible();
    expect(screen.getByRole('button', { name: t('Copy Diagnostics') })).toBeVisible();
    expect(screen.queryByRole('button', { name: t('Environment & Diagnostics') })).not.toBeInTheDocument();
  });

  it.each(['en', 'zh-CN'] as const)('uses startup tool detection on welcome and copies the same diagnostic state in %s', async (language) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderAboutDialog(vi.fn(), 'about', language);
    act(() => useAppStore.setState({
      snapshot: undefined,
      bootstrap: { state: {}, tools: { git: true, svn: false, svnadmin: false } } as BootstrapData,
    }));
    const t = createTranslator(language);
    expect(screen.getByText(t('Available'))).toBeVisible();
    expect(screen.getByText(t('Not detected'))).toBeVisible();
    expect(screen.getByText(`${t('Workspace')}:`)).toBeVisible();
    expect(screen.getByText(t('Not opened'))).toBeVisible();
    expect(screen.queryByText(`${t('Repositories')}:`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('Copy Diagnostics') }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const report = writeText.mock.calls[0][0];
    expect(report).toContain('- **Git**: Available');
    expect(report).toContain('- **SVN**: Not detected');
    expect(report).toContain('- **Workspace**: Not opened');
    expect(report).not.toContain('Repositories Loaded');
  });

  it('does not claim tools are missing before detection completes', () => {
    renderAboutDialog();
    act(() => useAppStore.setState({ snapshot: undefined }));
    expect(screen.getAllByText('Not checked')).toHaveLength(2);
    expect(screen.queryByText('Not installed')).not.toBeInTheDocument();
    expect(screen.queryByText('Not detected')).not.toBeInTheDocument();
  });

  it('prefers startup tool detection over workspace snapshots while retaining workspace repository counts', () => {
    renderAboutDialog();
    act(() => useAppStore.setState({ bootstrap: { state: {}, tools: { git: false, svn: false, svnadmin: false } } as BootstrapData }));
    expect(screen.getAllByText('Not detected')).toHaveLength(2);
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
    expect(screen.getByText('Repositories:').parentElement).toHaveTextContent('0');
  });

  it.each(['en', 'zh-CN'] as const)('shows versioned release history in %s', (language) => {
    const view = renderAboutDialog(vi.fn(), 'changelog', language);
    const entries = view.baseElement.querySelectorAll('.changelog-entry');
    expect(entries[0].querySelector('.changelog-ver')).toHaveTextContent(`v${releaseHistory[0].version}`);
    const current = releaseHistory.find((entry) => entry.version === version)!;
    expect(screen.getByText(current.highlights[language][0])).toBeInTheDocument();
    const otherLanguage = language === 'en' ? 'zh-CN' : 'en';
    expect(screen.queryByText(current.highlights[otherLanguage][0])).not.toBeInTheDocument();
  });

  it('renders the available version notes as Markdown and opens release links externally', async () => {
    vi.spyOn(updaterService, 'checkAppUpdate').mockResolvedValue({
      available: true, currentVersion: version, latestVersion: '0.2.0',
      releaseNotes: '## New in 0.2.0\n\n- Fix **SVN paths**\n- Improve download retries\n\n[Details](https://example.test/releases/v0.2.0)',
    });
    const open = vi.spyOn(updaterService, 'openExternalLink').mockResolvedValue(undefined);
    renderAboutDialog();
    fireEvent.click(screen.getByRole('button', { name: /Check for Updates/i }));
    expect(await screen.findByRole('heading', { name: 'New in 0.2.0' })).toBeInTheDocument();
    expect(screen.getByText('SVN paths').tagName).toBe('STRONG');
    expect(screen.getByText('Improve download retries').tagName).toBe('LI');
    fireEvent.click(screen.getByRole('link', { name: 'Details' }));
    expect(open).toHaveBeenCalledWith('https://example.test/releases/v0.2.0');
  });

  it('explains missing notes instead of showing a fixed product introduction', async () => {
    vi.spyOn(updaterService, 'checkAppUpdate').mockResolvedValue({
      available: true, currentVersion: version, latestVersion: '0.2.0',
    });
    renderAboutDialog(vi.fn(), 'about', 'zh-CN');
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(await screen.findByText('此版本尚未提供更新说明。')).toBeInTheDocument();
  });

  it('renders Chinese about, update actions and built-in release notes without an external language bundle', async () => {
    vi.spyOn(updaterService, 'checkAppUpdate').mockResolvedValue({
      available: true, currentVersion: version, latestVersion: '0.2.0',
    });
    renderAboutDialog(vi.fn(), 'about', 'zh-CN');
    expect(screen.getByRole('tab', { name: '关于与更新' })).toBeInTheDocument();
    expect(screen.getByText('软件更新')).toBeInTheDocument();
    expect(screen.getByText(`当前使用 VersionDock Desktop v${version}`)).toBeInTheDocument();
    expect(screen.getByText('作者与项目')).toBeInTheDocument();
    expect(screen.getByText('许可证:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '赞助项目' })).toBeInTheDocument();
    expect(screen.getByText('环境与诊断')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制诊断信息' })).toBeInTheDocument();
    expect(screen.getAllByText('已安装')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(await screen.findByText('发现新版本')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载并安装更新' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跳过此版本' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '更新日志' }));
    expect(screen.getByText('VersionDock 版本历史')).toBeInTheDocument();
    expect(screen.getByText('🚀 VersionDock Desktop 首次发布')).toBeInTheDocument();
  });

  it('renders app name, version, and author info', () => {
    renderAboutDialog();
    expect(screen.getByText('VersionDock Desktop')).toBeInTheDocument();
    expect(screen.getByText(`v${version}`)).toBeInTheDocument();
    expect(screen.getByText('chenqinru')).toBeInTheDocument();
    expect(screen.getByText('GPL-3.0')).toBeInTheDocument();
  });

  it('switches between About tab and Release Notes tab', () => {
    renderAboutDialog();
    const changelogTab = screen.getByRole('tab', { name: /Release Notes/i });
    fireEvent.click(changelogTab);
    expect(screen.getByText('VersionDock Release History')).toBeInTheDocument();
    expect(screen.getAllByText('v0.1.0').length).toBeGreaterThan(0);

    const aboutTab = screen.getByRole('tab', { name: /About & Updates/i });
    fireEvent.click(aboutTab);
    expect(screen.getByText('Software Update')).toBeInTheDocument();
  });

  it('handles update checking when up to date', async () => {
    vi.spyOn(updaterService, 'checkAppUpdate').mockResolvedValue({
      available: false,
      currentVersion: '0.1.0',
    });

    renderAboutDialog();
    const checkBtn = screen.getByRole('button', { name: /Check for Updates/i });
    fireEvent.click(checkBtn);

    await waitFor(() => {
      expect(screen.getByText(/VersionDock is up to date/i)).toBeInTheDocument();
    });
  });

  it('handles update checking when a new version is available', async () => {
    vi.spyOn(updaterService, 'checkAppUpdate').mockResolvedValue({
      available: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      releaseNotes: 'Fixed bugs and improved performance',
    });

    renderAboutDialog();
    const checkBtn = screen.getByRole('button', { name: /Check for Updates/i });
    fireEvent.click(checkBtn);

    await waitFor(() => {
      expect(screen.getByText('v0.2.0')).toBeInTheDocument();
      expect(screen.getByText('New Version Available')).toBeInTheDocument();
      expect(screen.getByText('Fixed bugs and improved performance')).toBeInTheDocument();
      expect(screen.getByText('Download and Install Update')).toBeInTheDocument();
    });
  });

  it('shows an update endpoint error without claiming the installed version is current', async () => {
    vi.spyOn(updaterService, 'checkAppUpdate').mockResolvedValue({
      available: false, currentVersion: version, latestVersion: '0.2.0', error: '404', rawUpdate: null,
    });
    renderAboutDialog();
    fireEvent.click(screen.getByRole('button', { name: /Check for Updates/i }));
    await waitFor(() => expect(screen.getByText('Update check error: 404')).toBeInTheDocument());
    expect(screen.queryByText(/VersionDock is up to date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download and Install Update/i })).not.toBeInTheDocument();
  });

  it('downloads and installs the native package before offering restart', async () => {
    const rawUpdate = { available: true } as NonNullable<updaterService.AppUpdateCheckResult['rawUpdate']>;
    vi.spyOn(updaterService, 'checkAppUpdate').mockResolvedValue({
      available: true, currentVersion: version, latestVersion: '0.2.0', rawUpdate,
    });
    const install = vi.spyOn(updaterService, 'downloadAndInstallAppUpdate').mockResolvedValue(undefined);
    const open = vi.spyOn(updaterService, 'openExternalLink').mockResolvedValue(undefined);
    renderAboutDialog();
    fireEvent.click(screen.getByRole('button', { name: /Check for Updates/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Download and Install Update/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Restart to Install Update/i })).toBeInTheDocument());
    expect(install).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('copies diagnostic report to clipboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    renderAboutDialog();
    const copyBtn = screen.getByRole('button', { name: /Copy Diagnostics/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
      expect(screen.getByText(/Copied to Clipboard!/i)).toBeInTheDocument();
    });
  });
});
