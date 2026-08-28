import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSnapshot, BootstrapData, BridgeCommand } from '../bindings/generated';
import { I18nContext, createTranslator } from '../i18n';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { SettingsPanel } from './SettingsPanel';

const state = (): AppStateSnapshot => ({
  schemaVersion: 3,
  settings: { theme: 'system', language: 'system', uiFontSize: 'standard', changesDisplayMode: 'simplified', defaultCommitAction: 'commit', defaultSaveAction: 'stash', promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false, notifyIncomingCommits: false, notifyUnpushedCommits: false, repositoryScanDepth: 4, ignoredFolders: ['node_modules'], maximumGraphCommits: 1000, projectColors: {}, externalEditor: null },
  layout: { panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] },
  lastWorkspaceId: null,
  recentWorkspaces: [],
});

const bootstrap = (): BootstrapData => ({
  state: state(),
  tools: { git: true, svn: true, svnadmin: true },
  capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
});

const renderPanel = (onClose = vi.fn()) => {
  const commands: BridgeCommand[] = [];
  const persisted = bootstrap();
  const bridge = new MockBridge((command) => {
    commands.push(command);
    if (command.type === 'updateSettings') { persisted.state.settings = structuredClone(command.payload.settings); return { settings: command.payload.settings, effects: { rescanWorkspace: false, reloadHistory: false, restartAutoRefresh: false } }; }
    if (command.type === 'updateLayout') { persisted.state.layout = structuredClone(command.payload.layout); return command.payload.layout; }
    if (command.type === 'bootstrap') return persisted;
    return true;
  });
  useAppStore.setState({ bridge, bootstrap: bootstrap(), ready: true });
  const view = render(
    <I18nContext.Provider value={{ language: 'en', preference: 'system', t: createTranslator('en') }}>
      <SettingsPanel onClose={onClose} />
    </I18nContext.Provider>,
  );
  return { bridge, commands, onClose, ...view };
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ bridge: undefined, bootstrap: undefined, ready: false });
  vi.restoreAllMocks();
});

describe('SettingsPanel', () => {
  it('changes theme, language, and file view immediately', () => {
    renderPanel();

    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'zhCn' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'File view' }), { target: { value: 'list' } });
    const fontSize = screen.getByRole('combobox', { name: 'UI font size' });
    expect(Array.from(fontSize.querySelectorAll('option')).map((option) => option.value)).toEqual(['minimum', 'small', 'standard', 'large', 'maximum']);
    fireEvent.change(fontSize, { target: { value: 'maximum' } });

    expect(useAppStore.getState().bootstrap?.state.settings).toMatchObject({ theme: 'dark', language: 'zhCn', uiFontSize: 'maximum' });
    expect(useAppStore.getState().bootstrap?.state.layout).toMatchObject({ fileViewMode: 'list' });
  });

  it('does not steal focus from a select when the parent rerenders', () => {
    const { rerender } = renderPanel();
    const theme = screen.getByRole('combobox', { name: 'Theme' });
    theme.focus();
    expect(theme).toHaveFocus();

    rerender(
      <I18nContext.Provider value={{ language: 'en', preference: 'system', t: createTranslator('en') }}>
        <SettingsPanel onClose={vi.fn()} />
      </I18nContext.Provider>,
    );

    expect(theme).toHaveFocus();
  });

  it('saves external editor arguments and restores null when the executable is cleared', async () => {
    const { bridge, commands } = renderPanel();
    const executable = screen.getByRole('textbox', { name: 'Executable path' });
    const argumentsField = screen.getByRole('textbox', { name: 'Arguments' });

    fireEvent.change(executable, { target: { value: '/usr/local/bin/code' } });
    fireEvent.change(argumentsField, { target: { value: '--reuse-window\n{path}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(useAppStore.getState().bootstrap?.state.settings?.externalEditor).toEqual({ executable: '/usr/local/bin/code', args: ['--reuse-window', '{path}'] });
    await waitFor(() => expect(commands.some((command) => command.type === 'updateSettings')).toBe(true), { timeout: 500 });
    await expect(bridge.request<BootstrapData>({ type: 'bootstrap' })).resolves.toMatchObject({
      state: { settings: { externalEditor: { executable: '/usr/local/bin/code', args: ['--reuse-window', '{path}'] } } },
    });

    const updatedExecutable = screen.getByRole('textbox', { name: 'Executable path' });
    fireEvent.change(updatedExecutable, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useAppStore.getState().bootstrap?.state.settings?.externalEditor).toBeNull();
  });

  it('closes from the close button and Escape', () => {
    const { onClose } = renderPanel();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-labelledby', 'settings-title');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('presentation'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('renders a fixed header, category anchors, and moves the branch warning into changes', () => {
    renderPanel();
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.settings-heading')).toBeInTheDocument();
    expect(dialog.querySelector('.settings-nav')).toBeInTheDocument();
    expect(dialog.querySelector('.settings-content')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Settings categories' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'External editor' })).toHaveAttribute('href', '#settings-section-external-editor-title');
    for (const link of screen.getByRole('navigation', { name: 'Settings categories' }).querySelectorAll('a')) {
      const target = link.getAttribute('href')?.slice(1);
      expect(target).toBeTruthy();
      expect(document.getElementById(target ?? '')).toHaveClass('settings-section-title');
      expect(document.getElementById(target ?? '')?.querySelector('.codicon')).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('link', { name: 'External editor' }));
    expect(screen.getByRole('link', { name: 'External editor' })).toHaveClass('active');
    expect(screen.getByRole('region', { name: 'Changes and commit' })).toContainElement(screen.getByLabelText('Suppress diverged branch warning'));
    expect(screen.queryByText('AI settings')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Git annotations')).not.toBeInTheDocument();
  });

  it('localizes the visible repositories section', () => {
    const { rerender } = renderPanel();
    rerender(
      <I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t: createTranslator('zh-CN') }}>
        <SettingsPanel onClose={vi.fn()} />
      </I18nContext.Provider>,
    );

    expect(screen.getByText('可见仓库')).toBeInTheDocument();
    expect(screen.getByText('隐藏的仓库仍会被扫描，可在此恢复显示。')).toBeInTheDocument();
  });

  it('persists supported Desktop settings and hides AI/editor-only settings', async () => {
    const { commands } = renderPanel();
    const supportedLabels = [
      'Changes display mode', 'Default commit action', 'Default save action', 'Prompt before adding untracked files',
      'Auto-refresh interval', 'Fetch on startup', 'Reset view locations on startup', 'Notify on incoming commits', 'Notify on unpushed commits',
      'Repository scan depth', 'Ignored folders', 'Maximum graph commits',
      'Suppress diverged branch warning',
    ];

    for (const label of supportedLabels) expect(screen.getByLabelText(label)).toBeEnabled();
    expect(screen.queryByLabelText('AI provider')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Git ghost text')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Auto-refresh interval'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Fetch on startup'));
    await waitFor(() => expect(useAppStore.getState().bootstrap?.state.settings).toMatchObject({ autoRefreshInterval: 30, fetchOnStartup: true }));
    expect(commands.some((command) => command.type === 'updateSettings')).toBe(true);
  });
});
