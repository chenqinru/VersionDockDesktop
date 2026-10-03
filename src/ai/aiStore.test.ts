import { afterEach, expect, it, vi } from 'vitest';
import type { AiResult, BridgeCommand, WorkspaceSnapshot } from '../bindings/generated';
import { MockBridge, type BridgeEvent } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { aiRequest, aiWorkspaceChanged, listenAiView, sendAiView, useAiStore } from './aiStore';
const snapshot = (id: string): WorkspaceSnapshot => ({
  workspace: { id, name: id, paths: ['/tmp/ai'], lastOpenedAt: '', available: true },
  repositories: [],
  generation: 1,
  tools: { git: true, svn: true, svnadmin: true },
});
const result = (text: string): AiResult => ({
  text,
  provider: 'fixture',
  model: 'fixture',
  promptSource: 'builtin',
  inputTruncated: false,
  durationMs: 1,
  review: null,
  groups: [],
  resolutions: [],
  fileCount: 1,
  repositoryCount: 1,
});
const pending = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => {
  aiWorkspaceChanged(undefined);
  useAppStore.setState({ bridge: undefined, snapshot: undefined });
  vi.restoreAllMocks();
});
it('ignores old completion and streams when a task is replaced', async () => {
  const first = pending<AiResult>();
  const second = pending<AiResult>();
  let calls = 0;
  const bridge = new MockBridge((command) =>
    command.type === 'aiGenerate' ? (++calls === 1 ? first.promise : second.promise) : [],
  );
  const callbacks = new Set<(e: BridgeEvent) => void>();
  vi.spyOn(bridge, 'subscribe').mockImplementation((cb) => {
    if (!cb) return () => {};
    callbacks.add(cb);
    return () => {
      callbacks.delete(cb);
    };
  });
  useAppStore.setState({ bridge, snapshot: snapshot('w') });
  const a = aiRequest('commit-message');
  const old = useAiStore.getState().generate('message', a);
  const b = aiRequest('commit-message');
  const update = vi.fn();
  const newer = useAiStore.getState().generate('message', b, update);
  for (const cb of callbacks) {
    cb({ type: 'aiProgress', requestId: a.requestId, phase: 'analyzing', delta: 'old' });
    cb({ type: 'aiProgress', requestId: b.requestId, phase: 'analyzing', delta: 'new' });
  }
  first.resolve(result('old'));
  expect(await old).toBeUndefined();
  expect(useAiStore.getState().runs.message.text).toBe('new');
  second.resolve(result('completed'));
  expect((await newer)?.text).toBe('completed');
  expect(update).toHaveBeenLastCalledWith('completed');
  expect(callbacks.size).toBe(0);
});
it('workspace switches cancel runs and reject late completion', async () => {
  const value = pending<AiResult>();
  const bridge = new MockBridge(() => value.promise);
  useAppStore.setState({ bridge, snapshot: snapshot('w') });
  const done = useAiStore.getState().generate('merge', aiRequest('merge-conflict'));
  useAppStore.setState({ snapshot: snapshot('other') });
  aiWorkspaceChanged('other');
  value.resolve(result('late'));
  expect(await done).toBeUndefined();
  expect(useAiStore.getState().runs).toEqual({});
});
it('closing composer cancels preparation and does not publish an old source', async () => {
  const source = pending<unknown>();
  const commands: BridgeCommand[] = [];
  const bridge = new MockBridge((command) => {
    commands.push(command);
    return source.promise;
  });
  useAppStore.setState({ bridge, snapshot: snapshot('w') });
  useAiStore.getState().openComposer({ repoId: 'r', paths: ['f'], stagedOnly: false, hashes: [] });
  const events: unknown[] = [];
  const off = listenAiView((e) => events.push(e));
  sendAiView({ type: 'COMPOSER_READY' });
  useAiStore.getState().close();
  source.resolve({ sessionId: 'old', units: [], repoId: 'r' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(commands.map((c) => c.type)).toEqual(['aiComposerPrepare']);
  expect(useAiStore.getState().source).toBeUndefined();
  expect(events).toHaveLength(1);
  off();
});

it('reviews staged and working sources independently for a mixed selected file', () => {
  const state = snapshot('w');
  state.repositories = [
    {
      meta: {
        id: 'r',
        name: 'r',
        rootPath: '/tmp/r',
        kind: 'git',
        color: '#fff',
        parentRepoId: null,
        depth: 0,
        isWorktree: false,
        isSubmodule: false,
      },
      branch: 'main',
      revision: 'abc',
      ahead: 0,
      behind: 0,
      conflicts: 0,
      operation: null,
      files: [{ path: 'f.ts', status: 'modified', staged: true, unstaged: true, conflicted: false }],
    },
  ];
  useAppStore.setState({ snapshot: state });
  useAiStore.getState().openReview([{ repoId: 'r', paths: ['f.ts'], stagedOnly: false }]);
  expect(useAiStore.getState().reviewRequest?.candidates).toEqual([
    { repoId: 'r', paths: ['f.ts'], stagedOnly: true },
    { repoId: 'r', paths: ['f.ts'], stagedOnly: false },
  ]);
});

it('returns to the originating surface and leaves unrelated generation running', async () => {
  const value = pending<AiResult>();
  const bridge = new MockBridge(() => value.promise);
  useAppStore.setState({ bridge, snapshot: snapshot('w'), mode: 'changes' });
  const independent = useAiStore.getState().generate('historical-message:other', aiRequest('commit-message'));
  useAiStore.getState().openReview([{ repoId: 'r', paths: ['f'], stagedOnly: false }]);
  useAiStore.getState().openComposer({ repoId: 'r', paths: ['f'], stagedOnly: false, hashes: [] });
  useAiStore.getState().close();
  expect(useAppStore.getState().mode).toBe('changes');
  expect(useAiStore.getState().runs['historical-message:other'].running).toBe(true);
  value.resolve(result('kept'));
  expect((await independent)?.text).toBe('kept');
});

it('does not publish group message completion after the source is replaced', async () => {
  const value = pending<AiResult>();
  const bridge = new MockBridge(() => value.promise);
  useAppStore.setState({ bridge, snapshot: snapshot('w') });
  useAiStore.getState().openComposer({ repoId: 'r', paths: ['f'], stagedOnly: false, hashes: [] });
  useAiStore.setState({ source: { sessionId: 's', repoId: 'r' } as import('../bindings/generated').AiComposerSource });
  const events: unknown[] = [];
  const off = listenAiView(e => events.push(e));
  sendAiView({ type: 'COMPOSER_GENERATE_MESSAGE', requestId: 'm', groupId: 'g', unitIds: ['u1'] });
  useAiStore.getState().close();
  value.resolve(result('late'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(events).toEqual([]);
  off();
});
