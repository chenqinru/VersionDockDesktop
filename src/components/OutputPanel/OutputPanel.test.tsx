import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../bindings/generated';
import { I18nContext, createTranslator } from '../../i18n';
import { MockBridge } from '../../platform/bridge';
import { BridgeContext } from '../../platform/context';
import { useAppStore } from '../../store/appStore';
import { OutputPanel } from './OutputPanel';
import { LogStatusBarItem } from '../StatusBar/LogStatusBarItem';

const sampleLogs: LogEntry[] = [
  {
    id: 'log-1',
    timestamp: '2026-08-31T12:00:00.000Z',
    level: 'info',
    channel: 'git',
    message: 'git status --porcelain',
    details: null,
    durationMs: 25,
    exitCode: 0,
    cwd: null,
  },
  {
    id: 'log-2',
    timestamp: '2026-08-31T12:00:05.000Z',
    level: 'warn',
    channel: 'svn',
    message: 'svn update with warning',
    details: 'Some server warning',
    durationMs: 120,
    exitCode: 0,
    cwd: null,
  },
  {
    id: 'log-3',
    timestamp: '2026-08-31T12:00:10.000Z',
    level: 'error',
    channel: 'core',
    message: 'Failed to connect to remote repository',
    details: 'fatal: connection timed out',
    durationMs: 3000,
    exitCode: 128,
    cwd: null,
  },
];

function renderWithProviders(ui: React.ReactElement, bridge: MockBridge) {
  const translator = createTranslator('en');
  return render(
    <BridgeContext.Provider value={bridge}>
      <I18nContext.Provider value={{ language: 'en', preference: 'en', t: translator }}>
        {ui}
      </I18nContext.Provider>
    </BridgeContext.Provider>,
  );
}

describe('OutputPanel & LogStatusBarItem', () => {
  let bridge: MockBridge;

  beforeEach(() => {
    bridge = new MockBridge(() => Promise.resolve());
    useAppStore.setState({
      ready: true,
      activeLogProject: 'all',
      logError: null, logStorageError: null,
      logPanelOpen: true,
      logPanelHeight: 240,
      logEntries: sampleLogs,
      activeLogChannel: 'all',
      activeLogLevel: 'all',
      logSearchQuery: '',
      logAutoScroll: true,
      unreadErrorCount: 1,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders output panel with all logs by default', () => {
    renderWithProviders(<OutputPanel />, bridge);
    expect(screen.getByText(/Output/)).toBeInTheDocument();
    expect(screen.getByText(/git status --porcelain/)).toBeInTheDocument();
    expect(screen.getByText(/svn update with warning/)).toBeInTheDocument();
    expect(screen.getByText(/Failed to connect to remote repository/)).toBeInTheDocument();
  });

  it('filters logs by channel', () => {
    renderWithProviders(<OutputPanel />, bridge);
    const channelTrigger = screen.getByLabelText(/Filter by channel/i);
    act(() => {
      fireEvent.click(channelTrigger);
    });
    const gitOption = screen.getByText('Git');
    act(() => {
      fireEvent.click(gitOption);
    });
    expect(screen.getByText(/git status --porcelain/)).toBeInTheDocument();
    expect(screen.queryByText(/svn update with warning/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to connect to remote repository/)).not.toBeInTheDocument();
  });

  it('filters logs by level', () => {
    renderWithProviders(<OutputPanel />, bridge);
    const levelTrigger = screen.getByLabelText(/Filter by level/i);
    act(() => {
      fireEvent.click(levelTrigger);
    });
    const errorOption = screen.getByText('Errors Only');
    act(() => {
      fireEvent.click(errorOption);
    });
    expect(screen.queryByText(/git status --porcelain/)).not.toBeInTheDocument();
    expect(screen.queryByText(/svn update with warning/)).not.toBeInTheDocument();
    expect(screen.getByText(/Failed to connect to remote repository/)).toBeInTheDocument();
  });

  it('filters logs by search query', () => {
    renderWithProviders(<OutputPanel />, bridge);
    const searchInput = screen.getByPlaceholderText(/Filter output…/i);
    act(() => {
      fireEvent.change(searchInput, { target: { value: 'timed out' } });
    });
    expect(screen.queryByText(/git status --porcelain/)).not.toBeInTheDocument();
    expect(screen.getByText(/Failed to connect to remote repository/)).toBeInTheDocument();
  });

  it('expands and collapses log details', () => {
    renderWithProviders(<OutputPanel />, bridge);
    const detailsButtons = screen.getAllByRole('button', { name: /Details/i });
    expect(detailsButtons.length).toBeGreaterThan(0);
    expect(screen.queryByText('fatal: connection timed out')).not.toBeInTheDocument();

    act(() => {
      fireEvent.click(detailsButtons[1]); // error log details
    });
    expect(screen.getByText('fatal: connection timed out')).toBeInTheDocument();
  });

  it('toggles log panel and unread error badge in LogStatusBarItem', () => {
    renderWithProviders(<LogStatusBarItem />, bridge);
    const statusBtn = screen.getByRole('button', { name: /Output and Logs/i });
    expect(statusBtn).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    act(() => {
      fireEvent.click(statusBtn);
    });
    expect(useAppStore.getState().logPanelOpen).toBe(false);
  });

  it('filters logs by project scope', () => {
    useAppStore.setState({
      tabs: [
        { id: 'tab-a', name: 'Project A', paths: ['/project-a'], lastOpenedAt: '', available: true },
        { id: 'tab-b', name: 'Project B', paths: ['/project-b'], lastOpenedAt: '', available: true },
      ],
      activeTabId: 'tab-a',
      activeLogProject: 'current',
      logEntries: [
        {
          id: 'log-a',
          timestamp: '2026-08-31T12:00:00.000Z',
          level: 'info',
          channel: 'git',
          message: 'git pull in Project A',
          details: null,
          durationMs: 25,
          exitCode: 0,
          cwd: '/project-a',
        },
        {
          id: 'log-b',
          timestamp: '2026-08-31T12:00:01.000Z',
          level: 'info',
          channel: 'git',
          message: 'git pull in Project B',
          details: null,
          durationMs: 30,
          exitCode: 0,
          cwd: '/project-b',
        },
        {
          id: 'log-global',
          timestamp: '2026-08-31T12:00:02.000Z',
          level: 'info',
          channel: 'core',
          message: 'Global system log',
          details: null,
          durationMs: 10,
          exitCode: 0,
          cwd: null,
        },
      ],
    });

    renderWithProviders(<OutputPanel />, bridge);

    // 默认 'current' (Project A): 应该能看到 A 的日志和全局日志，看不到 B 的日志
    expect(screen.getByText('git pull in Project A')).toBeInTheDocument();
    expect(screen.getByText('Global system log')).toBeInTheDocument();
    expect(screen.queryByText('git pull in Project B')).not.toBeInTheDocument();

    // 切换到 All Projects
    const projectTrigger = screen.getByLabelText(/Filter by project/i);
    act(() => {
      fireEvent.click(projectTrigger);
    });
    const allOption = screen.getByText('All Projects');
    act(() => {
      fireEvent.click(allOption);
    });

    // 此时全部可见，并且展示归属项目标签
    expect(screen.getByText('git pull in Project A')).toBeInTheDocument();
    expect(screen.getByText('git pull in Project B')).toBeInTheDocument();
    expect(screen.getByText('Global system log')).toBeInTheDocument();
    expect(screen.getByText('[Project A]')).toBeInTheDocument();
    expect(screen.getByText('[Project B]')).toBeInTheDocument();
  });

  it('isolates unread errors by active project workspace', () => {
    useAppStore.setState({
      tabs: [
        { id: 'tab-a', name: 'Project A', paths: ['/project-a'], lastOpenedAt: '', available: true },
        { id: 'tab-b', name: 'Project B', paths: ['/project-b'], lastOpenedAt: '', available: true },
      ],
      activeTabId: 'tab-a',
      logPanelOpen: false,
      unreadErrorCount: 0,
      logEntries: [],
    });

    // 在 Project B 中产生一个错误
    act(() => {
      useAppStore.getState().addLogEntry({
        id: 'err-b',
        timestamp: '2026-08-31T12:00:10.000Z',
        level: 'error',
        channel: 'git',
        message: 'Project B git checkout error',
        details: 'conflict in B',
        durationMs: 100,
        exitCode: 1,
        cwd: '/project-b',
      });
    });

    // 因为当前激活的是 tab-a，当前未读错误不应增加
    expect(useAppStore.getState().unreadErrorCount).toBe(0);

    // 在 Project A 中产生一个错误
    act(() => {
      useAppStore.getState().addLogEntry({
        id: 'err-a',
        timestamp: '2026-08-31T12:00:11.000Z',
        level: 'error',
        channel: 'git',
        message: 'Project A git push error',
        details: 'rejected',
        durationMs: 200,
        exitCode: 1,
        cwd: '/project-a',
      });
    });

    // Project A 未读错误应该增加为 1
    expect(useAppStore.getState().unreadErrorCount).toBe(1);
  });
  it('supports keyboard filtering, Escape, and focus return', () => {
    renderWithProviders(<OutputPanel />, bridge);
    const trigger = screen.getByLabelText('Filter by level');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'All Levels' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Errors Only' })).toHaveFocus();
    fireEvent.click(document.activeElement!);
    expect(trigger).toHaveFocus();
    expect(useAppStore.getState().activeLogLevel).toBe('error');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('pauses follow mode when reading upwards and follows when enabled again', () => {
    renderWithProviders(<OutputPanel />, bridge);
    const body = screen.getByRole('log');
    fireEvent.wheel(body, { deltaY: -20 });
    expect(useAppStore.getState().logAutoScroll).toBe(false);
    fireEvent.click(screen.getByLabelText('Toggle auto scroll'));
    expect(useAppStore.getState().logAutoScroll).toBe(true);
  });

  it('continues following when the 3000-record buffer changes without growing', () => {
    const entries = Array.from({ length: 3000 }, (_, index) => ({ ...sampleLogs[0], id: `entry-${index}` }));
    useAppStore.setState({ logEntries: entries });
    const { container } = renderWithProviders(<OutputPanel />, bridge);
    const body = screen.getByRole('log');
    Object.defineProperty(body, 'scrollHeight', { value: 10000, configurable: true });
    act(() => useAppStore.setState({ logEntries: [...entries.slice(1), { ...sampleLogs[0], id: 'new-last' }] }));
    expect(body.scrollTop).toBe(10000);
    expect(container.querySelectorAll('.output-log-row').length).toBeLessThan(100);
  });

  it('uses the shared formatter and surfaces copy failures locally', async () => {
    const formatter = vi.spyOn(bridge, 'formatLogs').mockResolvedValue('canonical logs');
    const write = vi.fn().mockRejectedValue(new Error('permission denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
    renderWithProviders(<OutputPanel />, bridge);
    await act(async () => fireEvent.click(screen.getByLabelText('Copy logs')));
    expect(formatter).toHaveBeenCalledWith(sampleLogs);
    expect(write).toHaveBeenCalledWith('canonical logs');
    expect(screen.getByText('Unable to copy logs.')).toBeInTheDocument();
  });

  it('starts clipboard writing during the click before native formatting resolves', async () => {
    let resolve!: (text: string) => void;
    const formatting = new Promise<string>((done) => { resolve = done; });
    vi.spyOn(bridge, 'formatLogs').mockReturnValue(formatting);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    vi.stubGlobal('ClipboardItem', class {
      constructor(public values: Record<string, Promise<Blob>>) {}
    });
    try {
      renderWithProviders(<OutputPanel />, bridge);
      fireEvent.click(screen.getByLabelText('Copy logs'));
      expect(write).toHaveBeenCalledOnce();
      await act(async () => resolve('canonical output'));
    } finally { vi.unstubAllGlobals(); }
  });

  it('exports only visible records through the native save dialog and handles cancellation', async () => {
    const save = vi.spyOn(bridge, 'saveFileDialog').mockResolvedValue('/tmp/visible.log');
    const exportLogs = vi.spyOn(bridge, 'exportLogs').mockResolvedValue(true);
    useAppStore.setState({ activeLogLevel: 'error' });
    renderWithProviders(<OutputPanel />, bridge);
    await act(async () => fireEvent.click(screen.getByLabelText('Export logs')));
    expect(exportLogs).toHaveBeenCalledWith('/tmp/visible.log', [sampleLogs[2]]);
    save.mockResolvedValue(null);
    exportLogs.mockClear();
    await act(async () => fireEvent.click(screen.getByLabelText('Export logs')));
    expect(exportLogs).not.toHaveBeenCalled();
  });

  it('searches captured sources after the originating project is closed', () => {
    useAppStore.setState({ tabs: [], logEntries: [{ ...sampleLogs[0], context: { workspaceId: 'closed', workspaceName: 'Closed Project', repositoryId: 'repo', repositoryName: 'Original repository', operationId: 'operation-42' } }] });
    renderWithProviders(<OutputPanel />, bridge);
    fireEvent.change(screen.getByPlaceholderText('Filter output…'), { target: { value: '  Original repository  ' } });
    expect(screen.getByText('[Closed Project]')).toBeInTheDocument();
    expect(screen.getByText('[Original repository]')).toBeInTheDocument();
  });

});

