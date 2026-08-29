import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PushPanel } from './PushPanel';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, UnpushedCommit } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

const gitRepo1: RepositoryStatus = {
  meta: {
    id: 'repo-1',
    name: 'SOCIAL-PRATICE2',
    rootPath: '/tmp/social-pratice2',
    color: '#4ec9b0',
    kind: 'git',
    parentRepoId: null,
    depth: 0,
    isSubmodule: false,
    isWorktree: false,
  },
  branch: 'main',
  revision: '4b6dcc02',
  ahead: 232,
  behind: 0,
  files: [],
  conflicts: 0,
  operation: null,
};

const gitRepo2: RepositoryStatus = {
  meta: {
    id: 'repo-2',
    name: 'BACKEND-SERVICE',
    rootPath: '/tmp/backend-service',
    color: '#569cd6',
    kind: 'git',
    parentRepoId: null,
    depth: 0,
    isSubmodule: false,
    isWorktree: false,
  },
  branch: 'feature/login',
  revision: 'def',
  ahead: 0,
  behind: 0,
  files: [],
  conflicts: 0,
  operation: null,
};

const sampleUnpushed: UnpushedCommit[] = [
  {
    hash: '4b6dcc02931a78e9b8f',
    shortHash: '4b6dcc02',
    message: 'feat(file): 增强文件上传类型校验功能',
    author: 'chenqinru',
    date: '2026-08-20T08:00:00Z',
    filesChanged: 6,
    additions: 180,
    deletions: 42,
  },
  {
    hash: '7ca73a3982bc54e1a09',
    shortHash: '7ca73a39',
    message: 'feat(api): 增强删除功能的权限控制',
    author: 'chenqinru',
    date: '2026-08-19T08:00:00Z',
    filesChanged: 22,
    additions: 141,
    deletions: 70,
  },
];

const snapshot = {
  workspace: { id: 'workspace-1', name: 'Workspace', paths: ['/tmp/repo'], lastOpenedAt: '', available: true },
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
  repositories: [gitRepo1, gitRepo2],
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ unpushedCommits: {}, branchesByRepo: {}, snapshot: undefined, bridge: undefined });
});

describe('PushPanel', () => {
  it('renders repository headers and unpushed commit list with exact visual layout', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({
      bridge,
      snapshot,
      unpushedCommits: { 'repo-1': sampleUnpushed },
      branchesByRepo: { 'repo-1': [{ name: 'main', current: true, remote: false, upstream: null, ahead: 232, behind: 0 }] },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <PushPanel repos={[gitRepo1]} />
      </BridgeContext.Provider>,
    );

    // Repository header
    expect(screen.getByText('SOCIAL-PRATICE2')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    // Commit rows
    expect(screen.getByText('4b6dcc02')).toBeInTheDocument();
    expect(screen.getByText('feat(file): 增强文件上传类型校验功能')).toBeInTheDocument();
    expect(screen.getByText('+180')).toBeInTheDocument();
    expect(screen.getByText('-42')).toBeInTheDocument();

    expect(screen.getByText('7ca73a39')).toBeInTheDocument();
    expect(screen.getByText('feat(api): 增强删除功能的权限控制')).toBeInTheDocument();
    expect(screen.getByText('+141')).toBeInTheDocument();
    expect(screen.getByText('-70')).toBeInTheDocument();

    // Bottom action button: unpublished branch
    expect(screen.getByRole('button', { name: /发布分支|Publish Branch/ })).toBeInTheDocument();
  });

  it('renders multi-repo push selection pills and checkboxes', () => {
    const bridge = new MockBridge(() => []);
    useAppStore.setState({
      bridge,
      snapshot,
      unpushedCommits: { 'repo-1': sampleUnpushed, 'repo-2': [] },
      branchesByRepo: {
        'repo-1': [{ name: 'main', current: true, remote: false, upstream: null, ahead: 232, behind: 0 }],
        'repo-2': [{ name: 'feature/login', current: true, remote: false, upstream: 'origin/feature/login', ahead: 0, behind: 0 }],
      },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <PushPanel repos={[gitRepo1, gitRepo2]} />
      </BridgeContext.Provider>,
    );

    expect(screen.getByText('SOCIAL-PRATICE2')).toBeInTheDocument();
    expect(screen.getByText('BACKEND-SERVICE')).toBeInTheDocument();
  });

  it('toggles aggregated changes view when clicking mode button', async () => {
    const bridge = new MockBridge((command) => {
      if (command.type === 'commitDetail') {
        return {
          files: [
            { path: 'src/upload.ts', status: 'modified', added: 10, removed: 2 },
          ],
        };
      }
      return [];
    });
    useAppStore.setState({
      bridge,
      snapshot,
      unpushedCommits: { 'repo-1': sampleUnpushed },
      branchesByRepo: { 'repo-1': [{ name: 'main', current: true, remote: false, upstream: null, ahead: 232, behind: 0 }] },
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <PushPanel repos={[gitRepo1]} />
      </BridgeContext.Provider>,
    );

    const toggleBtn = screen.getByTitle(/Show aggregated changes|显示汇总更改/);
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText(/Aggregated changes|所有待推送提交的汇总更改/)).toBeInTheDocument();
    });
  });
});
