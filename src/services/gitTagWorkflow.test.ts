import { createTranslator } from '../i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, RepositoryStatus } from '../bindings/generated';
import { MockBridge } from '../platform/bridge';
import * as dialogs from '../components/dialogService';
import { runGitTagWorkflow, type TagWorkflowContext } from './gitTagWorkflow';
import { useAppStore } from '../store/appStore';

const repo = (id: string): RepositoryStatus => ({ meta: { id, name: id, rootPath: `/tmp/tags/${id}`, color: '#4ec9b0', kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null });
let commands: BridgeCommand[];
let handler: (command: BridgeCommand) => unknown;
let ctx: TagWorkflowContext;
const original = useAppStore.getState();
beforeEach(() => {
  commands = [];
  handler = command => command.type === 'remotes' ? [{ name: 'origin' }] : command.type === 'tagPreflight' || command.type === 'tagResolveCommit' ? 'resolved-commit' : true;
  ctx = { bridge: new MockBridge(command => { commands.push(command); return handler(command); }), workspaceId: 'tags', repositories: [repo('a'), repo('b')], t: (key, ...args) => args.reduce<string>((s, value, i) => s.replaceAll(`{${i}}`, String(value)), key), isAvailable: () => true, manageRemotes: vi.fn(), created: vi.fn(), notify: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) };
  vi.spyOn(dialogs, 'multiChoiceDialog').mockResolvedValue(['a', 'b']);
  vi.spyOn(dialogs, 'choiceDialog').mockResolvedValue('both');
  vi.spyOn(dialogs, 'confirmDialog').mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(original, true); });
const writes = () => commands.filter(command => command.type === 'tagOperation');

describe('shared Git tag workflow', () => {
  it('cancels a repository selection without any bridge requests', async () => {
    vi.mocked(dialogs.multiChoiceDialog).mockResolvedValue(null);
    expect((await runGitTagWorkflow({ action: 'push', repoIds: ['a', 'b'], tagName: 'v1' }, ctx)).outcome).toBe('cancelled');
    expect(commands).toEqual([]);
  });
  it('finishes all remote choices before deleting anything', async () => {
    handler = command => command.type === 'remotes' ? [{ name: 'origin' }, { name: 'other' }] : 'commit';
    vi.mocked(dialogs.choiceDialog).mockResolvedValueOnce('both').mockResolvedValueOnce('origin').mockResolvedValueOnce(null);
    expect((await runGitTagWorkflow({ action: 'delete', repoIds: ['a', 'b'], tagName: 'v1' }, ctx)).outcome).toBe('cancelled');
    expect(writes()).toEqual([]);
    expect(ctx.refresh).not.toHaveBeenCalled();
  });
  it('localizes tag validation errors with the actual target name', async () => {
    ctx.t = createTranslator('zh-CN');
    handler = command => { if (command.type === 'tagPreflight') throw new Error('Tag "v1" already exists.'); return true; };
    const result = await runGitTagWorkflow({ action: 'merge', repoId: 'a', tagName: 'v1' }, ctx);
    expect(result.targets[0].error).toBe('标签“v1”已存在。');
  });
  it('blocks the entire batch if one repository fails preflight', async () => {
    handler = command => { if (command.type === 'tagPreflight' && command.payload.repo_id === 'b') throw new Error('detached'); return 'commit'; };
    const result = await runGitTagWorkflow({ action: 'merge', repoIds: ['a', 'b'], tagName: 'v1' }, ctx);
    expect(result).toMatchObject({ outcome: 'failed', targets: [{ repoId: 'a', outcome: 'noop' }, { repoId: 'b', outcome: 'failed', error: 'detached' }] });
    expect(writes()).toEqual([]);
  });
  it('requires confirmation for detached checkout and allows cancellation', async () => {
    vi.mocked(dialogs.confirmDialog).mockResolvedValue(false);
    const result = await runGitTagWorkflow({ action: 'checkout', repoId: 'a', tagName: 'v1' }, ctx);
    expect(result.outcome).toBe('cancelled');
    expect(dialogs.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Checkout enters detached HEAD.') }));
    expect(writes()).toEqual([]);
  });
  it('rejects creating tags before the first commit without opening input dialogs', async () => {
    const prompt = vi.spyOn(dialogs, 'promptDialog');
    handler = command => { if (command.type === 'tagResolveCommit') throw new Error('unborn'); return true; };
    expect((await runGitTagWorkflow({ action: 'create', repoId: 'a' }, ctx)).outcome).toBe('failed');
    expect(prompt).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(ctx.notify).toHaveBeenCalledWith('failed', 'Create a commit before creating a tag.');
  });
  it('creates annotated tags at the commit resolved before execution', async () => {
    vi.spyOn(dialogs, 'promptDialog').mockResolvedValueOnce('main~2').mockResolvedValueOnce('v1').mockResolvedValueOnce('发布说明');
    const result = await runGitTagWorkflow({ action: 'create', repoId: 'a' }, ctx);
    expect(result.outcome).toBe('success');
    expect(writes()[0]).toMatchObject({ payload: { workspace_id: 'tags', repo_id: 'a', operation: { type: 'create', name: 'v1', revision: 'resolved-commit', message: '发布说明' } } });
    expect(ctx.created).toHaveBeenCalledWith('a', 'v1');
    expect(ctx.refresh).toHaveBeenCalledWith(['a']);
  });
  it('creates lightweight tags from a commit context and allows more than one tag per commit', async () => {
    vi.spyOn(dialogs, 'promptDialog').mockResolvedValueOnce('v2').mockResolvedValueOnce('');
    await runGitTagWorkflow({ action: 'create', repoId: 'a', hash: 'abc' }, ctx);
    expect(writes()[0]).toMatchObject({ payload: { operation: { type: 'create', name: 'v2', message: null } } });
    expect(dialogs.promptDialog).toHaveBeenCalledTimes(2);
  });
  it('never deletes the local tag after a failed remote deletion, and continues other repositories', async () => {
    handler = command => {
      if (command.type === 'remotes') return [{ name: 'origin' }];
      if (command.type === 'tagOperation' && command.payload.repo_id === 'a') throw new Error('remote rejected');
      return 'commit';
    };
    const result = await runGitTagWorkflow({ action: 'delete', repoIds: ['a', 'b'], tagName: 'v1' }, ctx);
    expect(result).toMatchObject({ outcome: 'partial', targets: [{ repoId: 'a', outcome: 'failed', remoteResult: 'failed' }, { repoId: 'b', outcome: 'success', remoteResult: 'success', local: 'success' }] });
    expect(writes().map(command => [command.payload.repo_id, command.payload.operation])).toEqual([
      ['a', { type: 'delete', name: 'v1', remote: 'origin' }], ['b', { type: 'delete', name: 'v1', remote: 'origin' }], ['b', { type: 'delete', name: 'v1', remote: null }],
    ]);
    expect(ctx.refresh).toHaveBeenCalledWith(['a', 'b']);
  });
  it('reports partial deletion when remote succeeded and local failed', async () => {
    handler = command => {
      if (command.type === 'remotes') return [{ name: 'origin' }];
      if (command.type === 'tagOperation' && command.payload.operation.type === 'delete' && !command.payload.operation.remote) throw new Error('local lock');
      return 'commit';
    };
    expect(await runGitTagWorkflow({ action: 'delete', repoId: 'a', tagName: 'v1' }, ctx)).toMatchObject({ outcome: 'partial', targets: [{ outcome: 'partial', remoteResult: 'success', local: 'failed', error: 'local lock' }] });
  });
  it('checks the preferred remote for every selected repository', async () => {
    handler = command => command.type === 'remotes' ? [{ name: command.payload.repo_id === 'a' ? 'origin' : 'other' }] : 'commit';
    expect((await runGitTagWorkflow({ action: 'push', repoIds: ['a', 'b'], tagName: 'v1', remote: 'origin' }, ctx)).outcome).toBe('failed');
    expect(writes()).toEqual([]);
  });
  it('opens remote management for a repository without remotes', async () => {
    handler = command => command.type === 'remotes' ? [] : true;
    expect((await runGitTagWorkflow({ action: 'push', repoId: 'a', tagName: 'v1' }, ctx)).outcome).toBe('failed');
    expect(ctx.manageRemotes).toHaveBeenCalledWith('a');
    expect(writes()).toEqual([]);
  });
  it('rechecks workspace ownership after confirmation', async () => {
    vi.mocked(dialogs.confirmDialog).mockImplementation(async () => { ctx.isAvailable = () => false; return true; });
    expect((await runGitTagWorkflow({ action: 'checkout', repoId: 'a', tagName: 'v1' }, ctx)).outcome).toBe('failed');
    expect(writes()).toEqual([]);
  });
  it('retains operation results if refresh fails', async () => {
    vi.mocked(ctx.refresh).mockRejectedValue(new Error('refresh failed'));
    expect((await runGitTagWorkflow({ action: 'push', repoId: 'a', tagName: 'v1' }, ctx)).outcome).toBe('success');
  });
  it('shares one busy guard across entry points and resets it after cancellation', async () => {
    let resolve: (value: string[] | null) => void = () => {};
    vi.mocked(dialogs.multiChoiceDialog).mockImplementation(() => new Promise(r => { resolve = r; }));
    useAppStore.setState({ bridge: ctx.bridge, snapshot: { workspace: { id: 'tags', name: 'tags', paths: ['/tmp/tags'], available: true, lastOpenedAt: '' }, generation: 1, repositories: ctx.repositories, tools: { git: true, svn: true, svnadmin: true } }, tagBusy: false });
    const first = useAppStore.getState().runTagWorkflow({ action: 'push', repoIds: ['a', 'b'], tagName: 'v1' });
    expect(useAppStore.getState().tagBusy).toBe(true);
    expect((await useAppStore.getState().runTagWorkflow({ action: 'checkout', repoId: 'a', tagName: 'v1' })).outcome).toBe('cancelled');
    resolve(null);
    await first;
    expect(useAppStore.getState().tagBusy).toBe(false);
  });
});
