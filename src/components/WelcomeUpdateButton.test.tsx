import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTranslator, I18nContext } from '../i18n';
import { MockBridge } from '../platform/bridge';
import { BridgeContext } from '../platform/context';
import * as updater from '../services/updater';
import { useAppStore } from '../store/appStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { APP_CURRENT_VERSION } from '../version';
import { AboutDialog } from './AboutDialog';
import { UpdateStatusBarItem } from './StatusBar/UpdateStatusBarItem';
import { WorkspaceChooser } from './WorkspaceChooser';

const update = { canInstall: true, available: true, currentVersion: APP_CURRENT_VERSION, latestVersion: '0.2.0' };

function renderWelcome(language: 'en' | 'zh-CN' = 'zh-CN') {
  return render(<BridgeContext.Provider value={new MockBridge(() => true)}>
    <I18nContext.Provider value={{ language, preference: 'system', t: createTranslator(language) }}>
      <WorkspaceChooser />
    </I18nContext.Provider>
  </BridgeContext.Provider>);
}

beforeEach(() => {
  useAppStore.setState({ bootstrap: undefined, updateAvailableInfo: null, aboutOpen: false, operations: {} });
  useAppUpdateStore.setState({ phase: 'idle', targetVersion: null, progress: null, error: null });
  vi.spyOn(updater, 'downloadAndInstallAppUpdate').mockResolvedValue(undefined);
  vi.spyOn(updater, 'restartApp').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ updateAvailableInfo: null, aboutOpen: false });
  useAppUpdateStore.setState({ phase: 'idle', targetVersion: null, progress: null, error: null });
  vi.restoreAllMocks();
});

it('shows the current version as text without opening About when no update is available', () => {
  const view = renderWelcome();
  expect(view.container.querySelector('.welcome-update-button')).toBeNull();
  expect(screen.queryByRole('button', { name: `v${APP_CURRENT_VERSION}` })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(`v${APP_CURRENT_VERSION}`));
  expect(useAppStore.getState().aboutOpen).toBe(false);
  act(() => useAppStore.setState({ updateAvailableInfo: { ...update, available: false, error: 'offline' } }));
  expect(view.container.querySelector('.welcome-update-button')).toBeNull();
});

it.each([['zh-CN', '更新至 v0.2.0'], ['en', 'Update to v0.2.0']] as const)('starts updating directly from the single version capsule in %s', async (language, label) => {
  useAppStore.setState({ updateAvailableInfo: update });
  renderWelcome(language);
  expect(screen.queryByText(`v${APP_CURRENT_VERSION}`)).not.toBeInTheDocument();
  expect(document.querySelectorAll('.welcome-version-badge')).toHaveLength(1);
  expect(screen.getByRole('button', { name: label })).toHaveTextContent('v0.2.0');
  expect(document.querySelector('.welcome-version-badge .codicon')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(updater.downloadAndInstallAppUpdate).toHaveBeenCalledOnce());
  expect(useAppStore.getState().aboutOpen).toBe(false);
});

it('shares native download progress with About and disables the welcome entry until installation finishes', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(updater.downloadAndInstallAppUpdate).mockImplementation(async onProgress => {
    onProgress?.({ chunkLength: 45, downloadedBytes: 45, totalBytes: 100, percent: 45 });
    await pending;
  });
  useAppStore.setState({ updateAvailableInfo: { ...update, canInstall: true } });
  renderWelcome();
  render(<I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t: createTranslator('zh-CN') }}>
    <AboutDialog onClose={vi.fn()} />
  </I18nContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: '下载并安装更新' }));
  const progress = screen.getByRole('button', { name: '正在更新 45%' });
  expect(progress).toBeDisabled();
  expect(progress).toHaveClass('welcome-version-badge');
  expect(progress.textContent).toBe('45%');
  expect(progress.querySelector('.codicon')).toBeNull();
  expect(progress.style.getPropertyValue('--update-progress')).toBe('45%');
  expect(document.querySelectorAll('.welcome-version-badge')).toHaveLength(1);
  fireEvent.click(progress);
  expect(updater.downloadAndInstallAppUpdate).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '正在下载…' })).toBeDisabled();
  await act(async () => { finish(); await pending; });
  fireEvent.click(await screen.findByRole('button', { name: '重启并更新' }));
  await waitFor(() => expect(updater.restartApp).toHaveBeenCalledOnce());
  for (const button of screen.getAllByRole('button', { name: '正在重启…' })) expect(button).toBeDisabled();
});

it('keeps progress and restart available after switching from the workbench and clearing its notice', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(updater.downloadAndInstallAppUpdate).mockReturnValue(pending);
  useAppStore.setState({ updateAvailableInfo: update });
  const workbench = render(<UpdateStatusBarItem />);
  fireEvent.click(screen.getByRole('button'));
  workbench.unmount();
  useAppStore.setState({ updateAvailableInfo: null });
  const welcome = renderWelcome();
  expect(screen.getByRole('button', { name: '正在更新…' })).toBeDisabled();
  await act(async () => { finish(); await pending; });
  expect(await screen.findByRole('button', { name: '重启并更新' })).toBeEnabled();
  welcome.unmount();
  renderWelcome();
  expect(screen.getByRole('button', { name: '重启并更新' })).toBeEnabled();
});

it('retains a failed installation and retries the selected version after the notice changes', async () => {
  vi.mocked(updater.downloadAndInstallAppUpdate).mockRejectedValueOnce(new Error('signature invalid'));
  useAppStore.setState({ updateAvailableInfo: update });
  renderWelcome();
  await act(async () => { await useAppUpdateStore.getState().install('0.2.0').catch(() => undefined); });
  act(() => useAppStore.setState({ updateAvailableInfo: null }));
  const retry = screen.getByRole('button', { name: '更新失败，重试' });
  expect(retry).toHaveAttribute('title', '下载更新失败：signature invalid');
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: '重启并更新' })).toBeEnabled();
  expect(updater.downloadAndInstallAppUpdate).toHaveBeenLastCalledWith(expect.any(Function), '0.2.0');
  expect(useAppStore.getState().aboutOpen).toBe(false);
});

it('retries a failed restart without downloading again', async () => {
  useAppUpdateStore.setState({ phase: 'ready', targetVersion: '0.2.0' });
  vi.mocked(updater.restartApp).mockRejectedValueOnce(new Error('restart unavailable'));
  renderWelcome();
  fireEvent.click(screen.getByRole('button', { name: '重启并更新' }));
  const retry = await screen.findByRole('button', { name: '重启失败，重试' });
  expect(retry).toHaveAttribute('title', '重启失败：restart unavailable');
  fireEvent.click(retry);
  await waitFor(() => expect(updater.restartApp).toHaveBeenCalledTimes(2));
  expect(updater.downloadAndInstallAppUpdate).not.toHaveBeenCalled();
});
