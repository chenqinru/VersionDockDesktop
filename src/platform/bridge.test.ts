import { describe, expect, it } from 'vitest';
import { commandShowsProgressByDefault, MockBridge } from './bridge';

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
    expect(commandShowsProgressByDefault({ type: 'history', payload: { workspace_id: 'workspace', repo_id: 'repo', skip: 0, limit: 100, filter: null, revision: null } })).toBe(false);
    expect(commandShowsProgressByDefault({ type: 'sync', payload: { workspace_id: 'workspace', repo_id: 'repo', action: 'fetch', remote: null } })).toBe(true);
  });
});
