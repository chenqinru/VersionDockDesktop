import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, createTranslator } from '../../i18n';
import * as updater from '../../services/updater';
import { useAppStore } from '../../store/appStore';
import { useAppUpdateStore } from '../../store/appUpdateStore';
import { AboutDialog } from '../AboutDialog';
import { UpdateStatusBarItem } from './UpdateStatusBarItem';

function renderUpdate(includeAbout = false) {
  return render(
    <I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t: createTranslator('zh-CN') }}>
      <UpdateStatusBarItem />
      {includeAbout && <AboutDialog onClose={vi.fn()} />}
    </I18nContext.Provider>,
  );
}

beforeEach(() => {
  useAppUpdateStore.setState({ phase: 'idle', targetVersion: null, progress: null, error: null });
  useAppStore.setState({
    aboutOpen: false,
    updateChecking: false,
    updateAvailableInfo: { available: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
  });
  vi.spyOn(updater, 'downloadAndInstallAppUpdate').mockResolvedValue(undefined);
  vi.spyOn(updater, 'restartApp').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useAppUpdateStore.setState({ phase: 'idle', targetVersion: null, progress: null, error: null });
  useAppStore.setState({ updateChecking: false, updateAvailableInfo: null, aboutOpen: false });
  vi.restoreAllMocks();
});

describe('UpdateStatusBarItem', () => {
  it('only shows an update notice after finding a new version', () => {
    useAppStore.setState({ updateChecking: true, updateAvailableInfo: null });
    renderUpdate();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => useAppStore.setState({ updateChecking: false, updateAvailableInfo: { available: false, currentVersion: '0.1.0', error: 'timeout' } }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => useAppStore.setState({ updateAvailableInfo: { available: false, currentVersion: '0.1.0' } }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => useAppStore.setState({ updateAvailableInfo: { available: true, currentVersion: '0.1.0', latestVersion: '0.2.0' } }));
    expect(screen.getByRole('button', { name: '发现新版本 v0.2.0，点击更新' })).toBeInTheDocument();
  });
  it('starts native installation directly and offers restart only after success', async () => {
    renderUpdate();
    fireEvent.click(screen.getByRole('button', { name: '发现新版本 v0.2.0，点击更新' }));
    expect(updater.downloadAndInstallAppUpdate).toHaveBeenCalledOnce();
    expect(useAppStore.getState().aboutOpen).toBe(false);
    const restart = await screen.findByRole('button', { name: '重启以完成更新' });
    expect(updater.restartApp).not.toHaveBeenCalled();
    fireEvent.click(restart);
    await waitFor(() => expect(updater.restartApp).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '正在重启…' })).toBeDisabled();
  });

  it('shares progress with About and prevents a second installation from either entry point', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(updater.downloadAndInstallAppUpdate).mockImplementation(async (onProgress) => {
      onProgress?.({ chunkLength: 37, downloadedBytes: 37, totalBytes: 100, contentLength: 100, percent: 37 });
      await pending;
    });
    renderUpdate(true);
    const start = screen.getByRole('button', { name: '发现新版本 v0.2.0，点击更新' });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(screen.getByRole('button', { name: '正在更新至 v0.2.0… 37%' })).toBeDisabled();
    const aboutDownload = screen.getByRole('button', { name: '正在下载…' });
    expect(aboutDownload).toBeDisabled();
    fireEvent.click(aboutDownload);
    await act(async () => { await useAppUpdateStore.getState().install('0.2.0'); });
    expect(updater.downloadAndInstallAppUpdate).toHaveBeenCalledOnce();
    await act(async () => { finish(); await pending; });
    expect(await screen.findAllByRole('button', { name: '重启以完成更新' })).toHaveLength(2);
  });

  it('retains active progress and the restart entry after remounting or clearing the update notice', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(updater.downloadAndInstallAppUpdate).mockReturnValue(pending);
    const first = renderUpdate();
    fireEvent.click(screen.getByRole('button', { name: '发现新版本 v0.2.0，点击更新' }));
    first.unmount();
    useAppStore.setState({ updateAvailableInfo: null });
    renderUpdate();
    expect(screen.getByRole('button', { name: '正在更新至 v0.2.0…' })).toBeDisabled();
    await act(async () => { finish(); await pending; });
    expect(await screen.findByRole('button', { name: '重启以完成更新' })).toBeInTheDocument();
    expect(updater.downloadAndInstallAppUpdate).toHaveBeenCalledOnce();
  });

  it('shows the installation error and retries without showing restart prematurely', async () => {
    vi.mocked(updater.downloadAndInstallAppUpdate).mockRejectedValueOnce(new Error('signature invalid'));
    renderUpdate();
    fireEvent.click(screen.getByRole('button', { name: '发现新版本 v0.2.0，点击更新' }));
    const retry = await screen.findByRole('button', { name: '更新失败，点击重试' });
    expect(retry).toHaveAttribute('title', '下载更新失败：signature invalid');
    expect(screen.queryByRole('button', { name: '重启以完成更新' })).not.toBeInTheDocument();
    expect(useAppStore.getState().aboutOpen).toBe(false);
    fireEvent.click(retry);
    expect(await screen.findByRole('button', { name: '重启以完成更新' })).toBeInTheDocument();
    expect(updater.downloadAndInstallAppUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed restart retryable without reinstalling the package', async () => {
    vi.mocked(updater.restartApp).mockRejectedValueOnce(new Error('restart unavailable'));
    renderUpdate();
    fireEvent.click(screen.getByRole('button', { name: '发现新版本 v0.2.0，点击更新' }));
    fireEvent.click(await screen.findByRole('button', { name: '重启以完成更新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重启以完成更新' })).toHaveAttribute('title', '重启失败：restart unavailable'));
    fireEvent.click(screen.getByRole('button', { name: '重启以完成更新' }));
    await waitFor(() => expect(updater.restartApp).toHaveBeenCalledTimes(2));
    expect(updater.downloadAndInstallAppUpdate).toHaveBeenCalledOnce();
  });
});
