import { describe, expect, it } from 'vitest';
import { commandProgressVisibility, commandReadPriority, commandShowsProgressByDefault, MockBridge } from './bridge';

describe('VersionDockBridge', () => {
  it('keeps components independent from native command names', async () => {
    const bridge = new MockBridge((command) => command.type === 'bootstrap' ? { ok: true } : null);
    await expect(bridge.request({ type: 'bootstrap' })).resolves.toEqual({ ok: true });
    bridge.setState({ panel: 360 });
    expect(bridge.getState()).toEqual({ panel: 360 });
  });

  it('keeps passive reads silent while preserving progress for user mutations', () => {
    expect(commandShowsProgressByDefault({ type: 'gitIdentity', payload: { workspace_id: 'workspace', repo_id: 'repo' } })).toBe(false);
    expect(commandShowsProgressByDefault({ type: 'repositoryStatus', payload: { workspace_id: 'workspace', repo_id: 'repo' } })).toBe(false);
    expect(commandShowsProgressByDefault({ type: 'history', payload: { workspace_id: 'workspace', repo_id: 'repo', skip: 0, limit: 100, query: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null } } })).toBe(false);
    expect(commandShowsProgressByDefault({ type: 'sync', payload: { workspace_id: 'workspace', repo_id: 'repo', action: 'fetch', remote: null, branch: null } })).toBe(true);
  });

  it('cannot turn passive queries into progress popups through a caller override', () => {
    expect(commandProgressVisibility({ type: 'history', payload: { workspace_id: 'workspace', repo_id: 'repo', skip: 0, limit: 100, query: { text: null, author: null, fromDate: null, toDate: null, path: null, revision: null } } }, { showProgress: true })).toBe('background');
    expect(commandProgressVisibility({ type: 'conflicts', payload: { workspace_id: 'workspace', repo_id: null } }, { showProgress: true })).toBe('background');
    const fetch = { type: 'sync' as const, payload: { workspace_id: 'workspace', repo_id: 'repo', action: 'fetch' as const, remote: null, branch: null } };
    expect(commandProgressVisibility(fetch)).toBe('foreground');
    expect(commandProgressVisibility(fetch, { showProgress: false })).toBe('background');
  });

  it('prioritizes visible detail reads independently from progress visibility', () => {
    const detail = { type: 'commitDetail' as const, payload: { workspace_id: 'workspace', repo_id: 'repo', revision: 'hash' } };
    expect(commandReadPriority(detail)).toBe('interactive');
    expect(commandProgressVisibility(detail)).toBe('background');
    expect(commandReadPriority(detail, { readPriority: 'background' })).toBe('background');
    expect(commandReadPriority({ type: 'stashes', payload: { workspace_id: 'workspace', repo_id: 'repo' } })).toBe('background');
  });

  it('keeps checkpoint reads and writes silent even when callers request foreground progress', () => {
    const actions = [
      { type: 'overview' },
      { type: 'messages', task_id: 'task', checkpoint_id: 'point' },
      { type: 'begin', task_id: 'task', name: '' },
      { type: 'finish', task_id: 'task' },
      { type: 'execute', preview_id: 'preview' },
      { type: 'recover', transaction_id: 'restore' },
      { type: 'cleanup', task_id: 'task', keep_recent: 0, fingerprint: 'fp' },
      { type: 'installHooks' },
      { type: 'projectStorageUsage' },
      { type: 'previewProjectCleanup', keep_recent: 10 },
      { type: 'projectCleanup', keep_recent: 10, fingerprint: 'fp' },
    ] as const;
    for (const action of actions) {
      const command = { type: 'checkpoint', payload: { workspace_id: 'workspace', action } } as const;
      expect(commandShowsProgressByDefault(command)).toBe(false);
      expect(commandProgressVisibility(command, { showProgress: true, context: { visibility: 'foreground' } })).toBe('background');
    }
    for (const type of ['status', 'installHooks', 'openStorage'] as const) {
      const command = { type: 'checkpointSettings', payload: { action: { type } } } as const;
      expect(commandProgressVisibility(command, { showProgress: true, context: { visibility: 'foreground' } })).toBe('background');
    }
  });


});
