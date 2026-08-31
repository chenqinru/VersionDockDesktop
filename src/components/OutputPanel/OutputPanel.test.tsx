import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
