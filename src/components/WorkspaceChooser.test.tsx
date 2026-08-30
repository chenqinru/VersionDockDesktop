import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceChooser } from './WorkspaceChooser';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';

const originalCloneRepository = useAppStore.getState().cloneRepository;

afterEach(() => {
  cleanup();
  useAppStore.setState({ bootstrap: undefined, operations: {}, cloneRepository: originalCloneRepository });
});

describe('WorkspaceChooser V5 setup actions', () => {
  it('infers an editable clone folder and forwards the explicit target', async () => {
    const cloneRepository = vi.fn(async () => true);
    const bridge = new MockBridge(() => true);
    useAppStore.setState({
      cloneRepository,
      operations: {},
      bootstrap: {
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
    await waitFor(() => expect(cloneRepository).toHaveBeenCalledWith('https://example.test/acme/demo.git', '/tmp/repos', 'demo', false, undefined));
  });
});
