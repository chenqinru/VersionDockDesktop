import { describe, expect, it } from 'vitest';
import { commandProgressVisibility, commandShowsProgressByDefault, MockBridge } from './bridge';

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


});
