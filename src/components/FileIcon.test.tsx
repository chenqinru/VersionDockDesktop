import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileIcon } from './FileIcon';
import { useAppStore } from '../store/appStore';

describe('FileIcon Component', () => {
  it('renders SVG icon for material theme by default', () => {
    useAppStore.setState({
      bootstrap: {
        applicationSessionId: 'session',
        state: {
          schemaVersion: 7,
          lastWorkspaceId: null,
          recentWorkspaces: [],
          settings: {
            theme: 'dark',
            language: 'en',
            uiFontSize: 'standard',
            fileIconTheme: 'material',
            changesDisplayMode: 'simplified',
            defaultCommitAction: 'commit',
            defaultSaveAction: 'stash',
            promptBeforeAddingUntracked: true,
            suppressDivergedWarning: false,
            autoRefreshInterval: 0,
            fetchOnStartup: false,
            resetViewLocationsOnStartup: false,
            notifyIncomingCommits: true,
            notifyUnpushedCommits: true,
            repositoryScanDepth: 4,
            ignoredFolders: [],
            maximumGraphCommits: 1000,
            projectColors: {},
            externalEditor: null,
            autoCheckUpdates: true,
            skippedUpdateVersion: null,
          },
          layout: {
            panelSizes: { commit: 360, branches: 220, detail: 360 },
            activeTab: 'changes',
            fileViewMode: 'tree',
            stashViewMode: 'tree',
            branchSidebarCollapsed: false,
            branchSidebarCollapsedSections: [],
          },
        },
        tools: { git: true, svn: true, svnadmin: true },
        capabilities: { ai: false, stash: false, shelf: false, changelist: false, worktree: false, subtree: false, compare: false, remoteManagement: false },
      },
    });

    const { container } = render(<FileIcon name="test.tsx" />);
    expect(container.querySelector('.file-svg-icon')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders codicon when codicon theme is specified', () => {
    const { container } = render(<FileIcon name="index.ts" theme="codicon" />);
    expect(container.querySelector('.file-type-icon.tone-typescript')).toBeInTheDocument();
    expect(container.querySelector('.codicon-symbol-variable')).toBeInTheDocument();
  });

  it('renders folder icon with open state', () => {
    const { container: closed } = render(<FileIcon name="src" folder open={false} theme="material" />);
    expect(closed.querySelector('.file-svg-icon.folder')).toBeInTheDocument();

    const { container: opened } = render(<FileIcon name="src" folder open theme="catppuccin" />);
    expect(opened.querySelector('.file-svg-icon.folder')).toBeInTheDocument();
  });
});
