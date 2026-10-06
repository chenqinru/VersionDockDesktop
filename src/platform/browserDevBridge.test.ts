import { describe, expect, it } from 'vitest';
import type { BootstrapData, BridgeCommand, CommitBranches, CommitDetail, HistoryPage, WorkspaceSnapshot } from '../bindings/generated';
import { BrowserDevBridge } from './browserDevBridge';

describe('BrowserDevBridge', () => {
  it('boots directly into an isolated multi-repository demo workspace', async () => {
    const bridge = new BrowserDevBridge();
    const bootstrap = await bridge.request<BootstrapData>({ type: 'bootstrap' });
    const snapshot = await bridge.request<WorkspaceSnapshot>({ type: 'workspaceOpen', payload: { paths: ['/browser-demo'] } });
    expect(bootstrap.capabilities).toMatchObject({ ai: false, subtree: true, worktree: true });
    expect(snapshot.repositories.length).toBeGreaterThanOrEqual(5);
    expect(snapshot.repositories.every((repo) => repo.meta.rootPath.startsWith('/browser-demo/'))).toBe(true);
  });

  it('provides history, commit detail and memory-only mutations without cwd', async () => {
    const bridge = new BrowserDevBridge();
    const page = await bridge.request<HistoryPage>({ type: 'history', payload: { workspace_id: 'browser-demo', repo_id: 'admin', skip: 0, limit: 100, query: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null } } });
    const detail = await bridge.request<CommitDetail>({ type: 'commitDetail', payload: { workspace_id: 'browser-demo', repo_id: 'admin', revision: page.commits[0].hash } });
    const command: BridgeCommand = { type: 'stage', payload: { workspace_id: 'browser-demo', repo_id: 'admin', paths: ['apps/web-antd/src/api/infra/config/index.ts'] } };
    await bridge.request(command);
    expect(detail.files).toHaveLength(2);
    expect(detail.branchesPending).toBe(true);
    expect(detail.branches.local).toEqual([]);
    const branches = await bridge.request<CommitBranches>({ type: 'commitBranches', payload: { workspace_id: 'browser-demo', repo_id: 'admin', revision: page.commits[0].hash } });
    expect(branches.remote).toEqual(expect.any(Array));
    expect(branches).not.toEqual(detail.branches);
    expect(JSON.stringify(command)).not.toContain('cwd');
    const status = await bridge.request<{ files: Array<{ path: string; staged: boolean }> }>({ type: 'repositoryStatus', payload: { workspace_id: 'browser-demo', repo_id: 'admin' } });
    expect(status.files.find((file) => file.path.endsWith('/index.ts'))?.staged).toBe(true);
  });
});
