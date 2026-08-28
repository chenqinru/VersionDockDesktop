import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, createTranslator } from '../i18n';
import { useAppStore } from '../store/appStore';
import { AboutDialog } from './AboutDialog';
import * as updaterService from '../services/updater';

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const renderAboutDialog = (onClose = vi.fn(), initialTab: 'about' | 'changelog' = 'about') => {
  useAppStore.setState({
    ready: true,
    snapshot: {
      generation: 1,
      workspace: { id: 'ws-1', name: 'Test WS', paths: ['/path/to/repo'], available: true, lastOpenedAt: new Date().toISOString() },
      tools: { git: true, svn: true, svnadmin: true },
      repositories: [],
    },
  });

  const view = render(
    <I18nContext.Provider value={{ language: 'en', preference: 'system', t: createTranslator('en') }}>
      <AboutDialog onClose={onClose} initialTab={initialTab} />
    </I18nContext.Provider>,
  );
  return { onClose, ...view };
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ ready: false, snapshot: undefined });
  vi.restoreAllMocks();
});

describe('AboutDialog', () => {
  it('renders app name, version, and author info', () => {
    renderAboutDialog();
    expect(screen.getByText('VersionDock Desktop')).toBeInTheDocument();
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
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
