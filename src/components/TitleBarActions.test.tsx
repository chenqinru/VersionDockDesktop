import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { useAppStore } from '../store/appStore';
import { TitleBarActions } from './TitleBarActions';
import * as updaterService from '../services/updater';

const original = useAppStore.getState();
beforeEach(() => useAppStore.setState({
  operations: {},
  aboutOpen: false,
  bootstrap: { state: { settings: DEFAULT_SETTINGS, recentWorkspaces: [] }, tools: { git: true }, capabilities: { availability: {} } } as any,
}));
afterEach(() => { cleanup(); useAppStore.setState(original, true); });

describe('TitleBarActions', () => {
  it.each([
    ['Clone Git Repository', 'Clone Git Repository'],
    ['Manage Remote Accounts (GitHub / GitLab / Gitee)', 'Remote Providers'],
    ['Settings', 'Settings'],
  ])('opens and closes the existing dialog from %s in the applicable contexts', (action, dialogName) => {
    for (const workspaceId of action === 'Clone Git Repository' ? ['ws'] : ['ws', undefined]) {
      render(<BridgeContext.Provider value={new MockBridge(() => [])}><TitleBarActions workspaceId={workspaceId} /></BridgeContext.Provider>);
      const button = screen.getByRole('button', { name: action });
      fireEvent.click(button);
      const dialog = screen.getByRole('dialog', { name: dialogName });
      if (action === 'Settings') {
        expect(within(dialog).queryByRole('link', { name: 'Changes and commit' }) !== null).toBe(Boolean(workspaceId));
        expect(within(dialog).getByRole('link', { name: 'Accounts and privacy' })).toBeInTheDocument();
      }
      expect(button).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(button).toHaveAttribute('aria-expanded', 'false');
      cleanup();
    }
  });

  it('keeps clone in the welcome body and exposes accounts, settings, GitHub and about in its title bar', () => {
    render(<BridgeContext.Provider value={new MockBridge(() => [])}><TitleBarActions /></BridgeContext.Provider>);
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Clone Git Repository' })).not.toBeInTheDocument();
  });

  it.each(['ws', undefined])('opens the product GitHub repository and the shared about dialog with workspace %s', (workspaceId) => {
    const open = vi.spyOn(updaterService, 'openExternalLink').mockResolvedValue(undefined);
    render(<BridgeContext.Provider value={new MockBridge(() => [])}><TitleBarActions workspaceId={workspaceId} /></BridgeContext.Provider>);
    const github = screen.getByRole('button', { name: 'GitHub Repository' });
    expect(github.querySelector('.codicon-github')).toBeInTheDocument();
    fireEvent.click(github);
    expect(open).toHaveBeenCalledWith(updaterService.GITHUB_REPO_URL);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const about = screen.getByRole('button', { name: 'About VersionDock & Check Updates' });
    fireEvent.click(about);
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(useAppStore.getState()).toMatchObject({ aboutOpen: true, aboutInitialTab: 'about' });
    expect(about).toHaveAttribute('aria-expanded', 'true');
    vi.restoreAllMocks();
  });

  it('honors clone availability and does not bubble pointer events into the drag region', () => {
    useAppStore.setState({ bootstrap: { state: {}, tools: { git: false } } as any });
    const pointerDown = vi.fn();
    render(<BridgeContext.Provider value={new MockBridge(() => [])}><div onPointerDown={pointerDown}><TitleBarActions workspaceId="ws" /></div></BridgeContext.Provider>);
    const clone = screen.getByRole('button', { name: 'Clone Git Repository' });
    expect(clone).toBeDisabled();
    fireEvent.click(clone);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Settings' }));
    expect(pointerDown).not.toHaveBeenCalled();
  });
});
