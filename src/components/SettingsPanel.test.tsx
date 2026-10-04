import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSnapshot, BootstrapData, BridgeCommand } from '../bindings/generated';
import { I18nContext, createTranslator } from '../i18n';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { SettingsPanel } from './SettingsPanel';

const state = (): AppStateSnapshot => ({
  schemaVersion: 3,
  settings: { theme: 'system', language: 'system', uiFontSize: 'standard', fileIconTheme: 'material', changesDisplayMode: 'simplified', defaultCommitAction: 'commit', defaultSaveAction: 'stash', promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false, notifyIncomingCommits: false, notifyUnpushedCommits: false, repositoryScanDepth: 4, ignoredFolders: ['node_modules'], maximumGraphCommits: 1000, projectColors: {}, externalEditor: null },
  layout: { panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] },
  lastWorkspaceId: null,
  recentWorkspaces: [],
});

const bootstrap = (): BootstrapData => ({
  applicationSessionId: 'test-session',
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
  it('changes layout density immediately and persists it from settings search', async () => {
    const { commands } = renderPanel();
    const select = screen.getByRole('combobox', { name: 'Layout density' });
    expect(select).toHaveValue('comfortable');
    fireEvent.change(select, { target: { value: 'compact' } });
    await vi.waitFor(() => expect(commands.some(command => command.type === 'updateSettings' && command.payload.settings.layoutDensity === 'compact')).toBe(true));
    expect(useAppStore.getState().bootstrap?.state.settings?.layoutDensity).toBe('compact');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings...' }), { target: { value: 'comfortable' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Layout density' }), { target: { value: 'comfortable' } });
    await vi.waitFor(() => expect(useAppStore.getState().bootstrap?.state.settings?.layoutDensity).toBe('comfortable'));
    const update = commands.filter(command => command.type === 'updateSettings').at(-1);
    expect(update?.type === 'updateSettings' && update.payload.changed_fields).toEqual(['layoutDensity']);
  });

  it('changes theme, language, and file view immediately', () => {
    renderPanel();

    const themes = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(themes.querySelectorAll('[role="radio"]')).toHaveLength(9);
    expect(screen.queryByRole('combobox', { name: 'Theme' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'GitHub Dark Dimmed' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'zhCn' } });
    const fontSize = screen.getByRole('combobox', { name: 'UI font size' });
    expect(Array.from(fontSize.querySelectorAll('option')).map((option) => option.value)).toEqual(['minimum', 'small', 'standard', 'large', 'maximum']);
    fireEvent.change(fontSize, { target: { value: 'maximum' } });

    expect(screen.getByRole('radiogroup', { name: 'File icon theme' }).querySelectorAll('[role="radio"]')).toHaveLength(4);
    fireEvent.click(screen.getByRole('radio', { name: 'Catppuccin Icons (Soft & Modern)' }));

    // 切换至 Changes and commit 分类
    fireEvent.click(screen.getByRole('link', { name: 'Changes and commit' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'File view' }), { target: { value: 'list' } });

    expect(useAppStore.getState().bootstrap?.state.settings).toMatchObject({ theme: 'githubDarkDimmed', language: 'zhCn', uiFontSize: 'maximum', fileIconTheme: 'catppuccin' });
    expect(useAppStore.getState().bootstrap?.state.layout).toMatchObject({ fileViewMode: 'list' });
  });

  it('does not steal focus from a theme card when the parent rerenders', () => {
    const { rerender } = renderPanel();
    const theme = screen.getByRole('radio', { name: 'System (Default 2026)' });
    theme.focus();
    expect(theme).toHaveFocus();

    rerender(
      <I18nContext.Provider value={{ language: 'en', preference: 'system', t: createTranslator('en') }}>
        <SettingsPanel onClose={vi.fn()} />
      </I18nContext.Provider>,
    );

    expect(theme).toHaveFocus();
  });

  it('saves external editor configuration and restores null when set to system default', async () => {
    const { bridge, commands } = renderPanel();
    // 切换至 External editor 分类
    fireEvent.click(screen.getByRole('link', { name: 'External editor' }));

    const trigger = screen.getByRole('button', { name: /External editor/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Custom' }));

    const executable = screen.getByRole('textbox', { name: 'Editor path or command' });
    fireEvent.change(executable, { target: { value: '/usr/local/bin/code' } });

    expect(useAppStore.getState().bootstrap?.state.settings?.externalEditor).toEqual({ executable: '/usr/local/bin/code', args: ['--reuse-window', '{path}'] });
    await waitFor(() => expect(commands.some((command) => command.type === 'updateSettings')).toBe(true), { timeout: 500 });
    await expect(bridge.request<BootstrapData>({ type: 'bootstrap' })).resolves.toMatchObject({
      state: { settings: { externalEditor: { executable: '/usr/local/bin/code', args: ['--reuse-window', '{path}'] } } },
    });

    const browseBtn = screen.getByRole('button', { name: 'Browse...' });
    fireEvent.click(browseBtn);
    await waitFor(() => expect(executable).toHaveValue('/usr/local/bin/mock-editor'));

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'System default' }));
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

    for (const link of screen.getByRole('navigation', { name: 'Settings categories' }).querySelectorAll('a')) {
      fireEvent.click(link);
      const target = link.getAttribute('href')?.slice(1);
      expect(target).toBeTruthy();
      expect(document.getElementById(target ?? '')).toHaveClass('settings-section-title');
      expect(document.getElementById(target ?? '')?.querySelector('.codicon')).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('link', { name: 'External editor' }));
    expect(screen.getByRole('link', { name: 'External editor' })).toHaveClass('active');

    fireEvent.click(screen.getByRole('link', { name: 'Changes and commit' }));
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

    fireEvent.click(screen.getByRole('link', { name: '仓库与历史' }));
    expect(screen.getByText('可见仓库')).toBeInTheDocument();
    expect(screen.getByText('隐藏的仓库仍会被扫描，可在此恢复显示。')).toBeInTheDocument();
  });

  it('persists supported Desktop settings and hides AI/editor-only settings', async () => {
    const { commands } = renderPanel();

    expect(screen.queryByLabelText('Enable Copilot')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Git ghost text')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Refresh and startup' }));
    fireEvent.change(screen.getByLabelText('Auto-refresh interval'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Fetch on startup'));
    await waitFor(() => expect(useAppStore.getState().bootstrap?.state.settings).toMatchObject({ autoRefreshInterval: 30, fetchOnStartup: true }));
    expect(commands.some((command) => command.type === 'updateSettings')).toBe(true);
  });

  it('selects external editor options via dropdown and supports custom editor configuration', async () => {
    const { commands } = renderPanel();
    
    // 切换至 External editor 分类
    fireEvent.click(screen.getByRole('link', { name: 'External editor' }));

    // 打开下拉框
    const trigger = screen.getByRole('button', { name: /External editor/i });
    fireEvent.click(trigger);

    // 选择 Cursor
    const cursorOption = screen.getByRole('option', { name: 'Cursor' });
    fireEvent.click(cursorOption);

    await waitFor(() => {
      expect(commands.some((c) => c.type === 'updateSettings')).toBe(true);
    });

    // 再次打开下拉框并选择自定义
    fireEvent.click(trigger);
    const customOption = screen.getByRole('option', { name: 'Custom' });
    fireEvent.click(customOption);

    // 展开了自定义输入框
    expect(screen.getByLabelText('Editor path or command')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Editor path or command'), { target: { value: 'zed' } });

    await waitFor(() => {
      expect(commands.some((c) => c.type === 'updateSettings')).toBe(true);
    });
  });
});

it('finds and persists automatic fetch and identity visibility through settings search', async () => {
  const { commands } = renderPanel();
  const search = screen.getByPlaceholderText('Search settings...');
  fireEvent.change(search, { target: { value: 'Automatic fetch interval' } });
  const interval = screen.getByRole('spinbutton', { name: 'Automatic fetch interval' });
  expect(interval).toHaveValue(15); fireEvent.change(interval, { target: { value: '0' } }); fireEvent.blur(interval);
  await waitFor(() => expect(commands.some(c => c.type === 'updateSettings' && c.payload.settings.autoFetchIntervalMinutes === 0)).toBe(true));
  fireEvent.change(search, { target: { value: 'Show account and identity status bar' } });
  const toggle = screen.getByRole('checkbox', { name: /Show account and identity status bar/ });
  expect(toggle).toBeChecked(); fireEvent.click(toggle);
  await waitFor(() => expect(commands.some(c => c.type === 'updateSettings' && c.payload.settings.showProfileStatusBar === false)).toBe(true));
});

it('uses the plugin scan-depth default in both category and search, preserving explicit values', () => {
  renderPanel();
  fireEvent.click(screen.getByRole('link', { name: 'Repository and history' }));
  expect(screen.getByRole('spinbutton', { name: 'Repository scan depth' })).toHaveValue(4);
  const bootstrap = useAppStore.getState().bootstrap!;
  act(() => useAppStore.setState({ bootstrap: { ...bootstrap, state: { ...bootstrap.state, settings: undefined } } }));
  expect(screen.getByRole('spinbutton', { name: 'Repository scan depth' })).toHaveValue(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search settings...' }), { target: { value: 'Repository scan depth' } });
  expect(screen.getByRole('spinbutton', { name: 'Repository scan depth' })).toHaveValue(1);
});

it('shows defaults, lists modified settings across categories and restores only one setting', async () => {
  const { commands } = renderPanel();
  const before = structuredClone(useAppStore.getState().bootstrap!.state.settings!);
  fireEvent.click(screen.getByRole('link', { name:'Repository and history' }));
  const row = screen.getByRole('spinbutton', { name:'Repository scan depth' }).closest('[data-setting]')!;
  expect(row).toHaveAttribute('data-setting-modified','true'); expect(row).toHaveTextContent('Default: 1');
  fireEvent.click(screen.getByRole('button', { name:/Modified settings \(/ }));
  expect(screen.getByRole('button', { name:'Restore default: Repository scan depth' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name:'Restore default: Repository scan depth' }));
  await waitFor(() => expect(useAppStore.getState().bootstrap!.state.settings!.repositoryScanDepth).toBe(1));
  expect(screen.queryByRole('button', { name:'Restore default: Repository scan depth' })).not.toBeInTheDocument();
  expect(useAppStore.getState().bootstrap!.state.settings!.ignoredFolders).toEqual(before.ignoredFolders);
  expect(commands.find(command => command.type === 'updateSettings')?.type).toBe('updateSettings');
});
it('searches modified settings and returns to its editor without changing the value', async () => {
  renderPanel(); fireEvent.click(screen.getByRole('button', { name:/Modified settings \(/ }));
  fireEvent.change(screen.getByRole('textbox', { name:'Search settings...' }), { target:{ value:'scan' } });
  expect(screen.queryByRole('button', { name:'Restore default: Notify on incoming commits' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name:'Edit setting: Repository scan depth' }));
  expect(screen.getByRole('spinbutton', { name:'Repository scan depth' })).toHaveValue(4);
  expect(screen.getByRole('button', { name:/Modified settings \(/ })).toHaveAttribute('aria-pressed','false');
});
it('clears a numeric edit draft when resetting to the default', async () => {
  renderPanel(); fireEvent.click(screen.getByRole('link', { name:'Repository and history' }));
  const row = screen.getByRole('spinbutton', { name:'Repository scan depth' }).closest('[data-setting]')!;
  const visible = row.querySelector<HTMLInputElement>('.settings-stepper-input')!;
  fireEvent.focus(visible); fireEvent.change(visible,{ target:{ value:'7' } });
  fireEvent.click(screen.getByRole('button', { name:'Restore default: Repository scan depth' }));
  await waitFor(() => expect(visible).toHaveValue('1'));
});

it('keeps only the centered title in the settings header', () => {
  renderPanel();
  expect(document.querySelector('.settings-heading .settings-title')?.textContent).toBe('Settings');
  expect(document.querySelector('.settings-heading p')).toBeNull();
});

it('does not toggle a checkbox when its separate reset button is clicked', async () => {
  renderPanel(); fireEvent.click(screen.getByRole('link', { name:'Refresh and startup' }));
  const checkbox = screen.getByRole('checkbox', { name:'Notify on incoming commits' }); expect(checkbox).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name:'Restore default: Notify on incoming commits' }));
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(useAppStore.getState().bootstrap!.state.settings!.notifyUnpushedCommits).toBe(false);
});
it('keeps a modified value visible when restoring fails', async () => {
  const { bridge } = renderPanel();
  vi.spyOn(bridge,'request').mockRejectedValue(new Error('settings write failed'));
  fireEvent.click(screen.getByRole('link', { name:'Repository and history' }));
  fireEvent.click(screen.getByRole('button', { name:'Restore default: Repository scan depth' }));
  await waitFor(() => expect(useAppStore.getState().bootstrap!.state.settings!.repositoryScanDepth).toBe(4));
  expect(screen.getByRole('button', { name:'Restore default: Repository scan depth' })).toBeInTheDocument();
});
