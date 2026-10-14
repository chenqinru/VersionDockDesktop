import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceChooser } from './WorkspaceChooser';
import { TitleBar } from './TitleBar';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { version } from '../../package.json';
import { DialogHost } from './DialogHost';
import { publishDialog } from './dialogService';

const originalCloneRepository = useAppStore.getState().cloneRepository;
const originalOpenWorkspace = useAppStore.getState().openWorkspace;

afterEach(() => {
  cleanup();
  publishDialog(undefined);
  useAppStore.setState({ bootstrap: undefined, operations: {}, cloneRepository: originalCloneRepository, openWorkspace: originalOpenWorkspace });
});

describe('WorkspaceChooser V5 setup actions', () => {
  it.each([
    { kind: 'Open Local Folder', paths: ['/tmp/a', '/tmp/b'], newWindow: false },
    { kind: 'Open VS Code Workspace', paths: ['/tmp/team.code-workspace'], newWindow: false },
    { kind: 'Open Local Folder', paths: ['/tmp/a', '/tmp/b'], newWindow: true },
    { kind: 'Open VS Code Workspace', paths: ['/tmp/team.code-workspace'], newWindow: true },
  ])('opens $kind from the single action (new window: $newWindow)', async ({ kind, paths, newWindow }) => {
    const bridge = new MockBridge(() => true);
    bridge.selectWorkspaceFolders = vi.fn().mockResolvedValue(['/tmp/a', '/tmp/b']);
    bridge.selectWorkspaceFile = vi.fn().mockResolvedValue('/tmp/team.code-workspace');
    bridge.openInNewWindow = vi.fn().mockResolvedValue('new-window');
    const openWorkspace = vi.fn().mockResolvedValue(true);
    useAppStore.setState({ openWorkspace, operations: {}, bootstrap: { state: { recentWorkspaces: [] } } as never });
    render(<BridgeContext.Provider value={bridge}><WorkspaceChooser /><DialogHost /></BridgeContext.Provider>);
    expect(screen.queryByRole('button', { name: /Open Local Folder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open VS Code Workspace/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open Workspace/ }), { metaKey: newWindow });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(kind) }));
    await waitFor(() => expect(newWindow ? bridge.openInNewWindow : openWorkspace).toHaveBeenCalledWith(paths));
    expect(newWindow ? openWorkspace : bridge.openInNewWindow).not.toHaveBeenCalled();
  });

  it('cancels the type choice without opening a native picker', async () => {
    const bridge = new MockBridge(() => true);
    const folderPicker = vi.spyOn(bridge, 'selectWorkspaceFolders');
    const filePicker = vi.spyOn(bridge, 'selectWorkspaceFile');
    useAppStore.setState({ operations: {}, bootstrap: { state: { recentWorkspaces: [] } } as never });
    render(<BridgeContext.Provider value={bridge}><WorkspaceChooser /><DialogHost /></BridgeContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: /Open Workspace/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(folderPicker).not.toHaveBeenCalled();
    expect(filePicker).not.toHaveBeenCalled();
  });

  it('reopens recent file workspaces from their source file rather than the old folder list', () => {
    const bridge = new MockBridge(() => true);
    const openWorkspace = vi.fn().mockResolvedValue(true);
    useAppStore.setState({ openWorkspace, operations: {}, bootstrap: { state: { recentWorkspaces: [{ id: 'team', name: 'Team', workspaceFile: '/tmp/team.code-workspace', paths: ['/tmp/a', '/tmp/b'], available: true }] } } as never });
    render(<BridgeContext.Provider value={bridge}><WorkspaceChooser /></BridgeContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: /Team/ }));
    expect(openWorkspace).toHaveBeenCalledWith(['/tmp/team.code-workspace']);
  });
  it.each([false, true])('gates SVN checkout on tool availability (%s) and explains the disabled state', (svnAvailable) => {
    const bridge = new MockBridge(() => true);
    useAppStore.setState({
      operations: {},
      bootstrap: { state: { recentWorkspaces: [] }, tools: { svn: svnAvailable } } as any,
    });
    render(<BridgeContext.Provider value={bridge}><WorkspaceChooser /></BridgeContext.Provider>);
    const checkout = screen.getByRole('button', { name: /Checkout SVN Repository/ });
    if (svnAvailable) {
      expect(checkout).toBeEnabled();
      expect(checkout).not.toHaveAttribute('title');
    } else {
      expect(checkout).toBeDisabled();
      expect(checkout).toHaveAttribute('title', 'SVN command-line client was not detected. Install SVN and restart the app.');
      fireEvent.click(checkout);
      expect(screen.queryByLabelText('SVN URL')).not.toBeInTheDocument();
    }
  });

  it('uses the package version and retries a saved unavailable workspace only after a click', () => {
    const openWorkspace = vi.fn(async () => true);
    const bridge = new MockBridge(() => true);
    useAppStore.setState({
      openWorkspace,
      operations: {},
      bootstrap: {
        state: { recentWorkspaces: [{ id: 'external', name: 'External project', paths: ['/Volumes/WorkSSD/project'], lastOpenedAt: '', available: false }] },
      } as any,
    });
    render(<BridgeContext.Provider value={bridge}><WorkspaceChooser /></BridgeContext.Provider>);
    expect(screen.getByRole('button', { name: `v${version}` })).toBeInTheDocument();
    expect(openWorkspace).not.toHaveBeenCalled();
    const recent = screen.getByRole('button', { name: /External project/ });
    expect(recent).toBeEnabled();
    fireEvent.click(recent);
    expect(openWorkspace).toHaveBeenCalledWith(['/Volumes/WorkSSD/project']);
  });

  it('infers an editable clone folder and forwards the explicit target', async () => {
    const cloneRepository = vi.fn(async () => true);
    const bridge = new MockBridge(() => true);
    useAppStore.setState({
      cloneRepository,
      operations: {},
      bootstrap: {
        applicationSessionId: 'test-session',
        state: { schemaVersion: 4, settings: { theme: 'system', language: 'system', uiFontSize: 'standard', changesDisplayMode: 'simplified', defaultCommitAction: 'commit', defaultSaveAction: 'stash', promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false, notifyIncomingCommits: false, notifyUnpushedCommits: false, repositoryScanDepth: 4, ignoredFolders: [], maximumGraphCommits: 1000, projectColors: {}, hiddenRepositoryIds: [], externalEditor: null, autoCheckUpdates: true, skippedUpdateVersion: null }, layout: { panelSizes: { commit: 360, branches: 220, detail: 360 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] }, lastWorkspaceId: null, openWorkspaceIds: [], activeWorkspaceId: null, recentWorkspaces: [], theme: null, language: null, uiFontSize: null, panelSizes: null, activeTab: null, fileViewMode: null, stashViewMode: null, externalEditor: null, branchSidebarCollapsed: null, branchSidebarCollapsedSections: null },
        tools: { git: true, svn: false, svnadmin: false },
        capabilities: { ai: false, initializeRepository: true, cloneRepository: true, stash: false, shelf: true, changelist: true, worktree: true, subtree: true, submodule: true, compare: true, remoteManagement: true, identity: true, svnAccount: false, fileHistory: true, secureCredentials: false, systemNotifications: false, availability: { cloneRepository: { available: true, reasonCode: null, detail: null } } },
        launchWorkspaceId: null,
        runtime: { systemNotifications: { available: false, reasonCode: null, detail: null }, notificationPermission: 'unavailable', secureCredentials: { status: { available: false, reasonCode: null, detail: null }, backend: null, passwordStdinSupported: false } },
      },
    });
    render(<BridgeContext.Provider value={bridge}><WorkspaceChooser /></BridgeContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: /Clone Repository/i }));
    fireEvent.change(screen.getByLabelText('Git URL'), { target: { value: 'https://example.test/acme/demo.git' } });
    fireEvent.change(screen.getByLabelText('Parent folder'), { target: { value: '/tmp/repos' } });
    expect(screen.getByLabelText('Folder name')).toHaveValue('demo');
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(cloneRepository).toHaveBeenCalledWith('https://example.test/acme/demo.git', '/tmp/repos', 'demo', false, undefined, expect.any(Function)));
  });

  it('renders JetBrains-style project initials in recent workspaces list', () => {
    const bridge = new MockBridge(() => true);
    useAppStore.setState({
      bootstrap: {
        state: {
          recentWorkspaces: [
            {
              id: 'recent-1',
              name: 'yudao-cloud',
              paths: ['/Users/chenqinru/Project/yudao-cloud'],
              lastOpenedAt: '',
              available: true,
            },
            {
              id: 'recent-2',
              name: 'api',
              paths: ['/Users/chenqinru/Project/monthly-report/api'],
              lastOpenedAt: '',
              available: true,
            },
          ],
        },
      } as any,
    });

    render(<BridgeContext.Provider value={bridge}><WorkspaceChooser /></BridgeContext.Provider>);

    const icons = screen.getAllByTestId('project-icon');
    expect(icons).toHaveLength(2);
    expect(icons[0]).toHaveTextContent('YC');
    expect(icons[1]).toHaveTextContent('A');
  });
});

it('manages remote accounts from the welcome title bar without opening a workspace', async () => {
  let connected = false;
  const bridge = new MockBridge(command => {
    if (command.type === 'providerAccounts') return connected ? [{ id: 'gitee', provider: 'gitee', host: 'https://gitee.com', login: 'ada', displayName: null, secureStorageRef: 'test' }] : [];
    if (command.type === 'providerGiteeSave') { connected = true; return { id: 'gitee', provider: 'gitee', host: 'https://gitee.com', login: 'ada', displayName: null, secureStorageRef: 'test' }; }
    return [];
  });
  useAppStore.setState({ bootstrap: { state: { recentWorkspaces: [] }, tools: {} } as any, snapshot: undefined });
  const { container } = render(<BridgeContext.Provider value={bridge}><TitleBar /><WorkspaceChooser /></BridgeContext.Provider>);
  expect(container.querySelectorAll('.titlebar-actions button')).toHaveLength(2);
  expect(container.querySelectorAll('.welcome-action-btn')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: /Connect Remote Accounts/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Manage Remote Accounts (GitHub / GitLab / Gitee)' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add Gitee Account' }));
  fireEvent.change(screen.getByPlaceholderText('Personal Access Token'), { target: { value: 'test-only-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByText('ada');
  expect(useAppStore.getState().snapshot).toBeUndefined();
});
