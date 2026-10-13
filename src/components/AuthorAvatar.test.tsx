import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { AuthorAvatar } from './AuthorAvatar';
import { useAppStore } from '../store/appStore';
import { avatarIdentity, authorAvatarRemoteScope, clearAuthorAvatarCache, primeAuthorAvatars } from '../avatars/authorAvatarResolver';

const requested: string[] = [];
class SuccessfulImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(value: string) { requested.push(value); queueMicrotask(() => this.onload?.()); } }
const initial = useAppStore.getState();
afterEach(() => { cleanup(); vi.restoreAllMocks(); requested.length = 0; useAppStore.setState(initial, true); window.dispatchEvent(new Event('versiondock-avatar-cache-clear')); });
function setup(workspaceId = 'workspace') {
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: SuccessfulImage });
  useAppStore.setState({ bootstrap: { state: { settings: { onlineAvatarsEnabled: true } } } as never, snapshot: { workspace: { id: workspaceId } } as never });
}
function batchResult(command: BridgeCommand, resolve: (email: string, name: string) => string | null) {
  const results: Record<string, string | null> = {};
  if (command.type === 'resolveAuthorAvatars') for (const author of command.payload.authors) {
    const key = avatarIdentity(author.email, author.name);
    results[key] = results[key] || resolve(author.email, author.name);
  }
  return results;
}
const avatar = (name: string, email = '915860729@qq.com', size = 20) => <AuthorAvatar name={name} email={email} repoId="repo" size={size} />;

describe('author avatar batch loading', () => {
  it('coalesces aliases and sizes into one repository request and shares the successful email avatar', async () => {
    setup();
    const request = vi.fn((command: BridgeCommand) => batchResult(command, (_, name) => name === '胡国梁' ? 'data:image/png;base64,hugl' : null));
    const bridge = new MockBridge(request);
    const view = render(<BridgeContext.Provider value={bridge}>{avatar('huguoliang')}{avatar('胡国梁', undefined, 36)}{avatar('huguoliang', undefined, 14)}</BridgeContext.Provider>);
    await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(3));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ type: 'resolveAuthorAvatars', payload: { workspace_id: 'workspace', repo_id: 'repo', authors: [{email:'915860729@qq.com',name:'huguoliang'}, {email:'915860729@qq.com',name:'胡国梁'}] } });
  });
  it('publishes the whole batch only after every image has finished preloading', async () => {
    setup();
    const loads = new Map<string, () => void>();
    class ControlledImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(value: string) { loads.set(value, () => this.onload?.()); } }
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: ControlledImage });
    const bridge = new MockBridge(command => batchResult(command, (_, name) => `data:image/png;base64,${name}`));
    const view = render(<BridgeContext.Provider value={bridge}>{avatar('Alice','alice@test')}{avatar('Bob','bob@test')}</BridgeContext.Provider>);
    await waitFor(() => expect(loads.size).toBe(2));
    await act(async () => { loads.get('data:image/png;base64,Alice')!(); });
    expect(view.container.querySelectorAll('img')).toHaveLength(0);
    await act(async () => { loads.get('data:image/png;base64,Bob')!(); });
    expect(view.container.querySelectorAll('img')).toHaveLength(2);
  });
  it('does not let an older failed batch replace a later successful alias result', async () => {
    setup();
    let finish!: (result: Record<string, null>) => void;
    const pending = new Promise<Record<string, null>>(resolve => { finish = resolve; });
    const request = vi.fn((command: BridgeCommand) => command.type === 'resolveAuthorAvatars' && command.payload.authors.some(a => a.name === '胡国梁') ? batchResult(command, () => 'data:image/png;base64,hugl') : pending);
    const bridge = new MockBridge(request);
    const alias = render(<BridgeContext.Provider value={bridge}>{avatar('huguoliang')}</BridgeContext.Provider>);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    render(<BridgeContext.Provider value={bridge}>{avatar('胡国梁')}</BridgeContext.Provider>);
    await waitFor(() => expect(alias.container.querySelector('img')?.src).toContain('hugl'));
    await act(async () => { finish({'email:915860729@qq.com':null}); await pending; });
    expect(alias.container.querySelector('img')?.src).toContain('hugl');
  });
  it('retries misses after ten minutes and allows another author name to resolve the same email earlier', async () => {
    setup();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = vi.fn((command: BridgeCommand) => batchResult(command, () => request.mock.calls.length > 1 ? 'data:image/png;base64,recovered' : null));
    const bridge = new MockBridge(request);
    const ui = <BridgeContext.Provider value={bridge}>{avatar('huguoliang')}</BridgeContext.Provider>;
    let view = render(ui);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    now += 9 * 60_000;
    view = render(ui);
    await act(async () => { await Promise.resolve(); });
    expect(request).toHaveBeenCalledTimes(1);
    view.unmount();
    now += 60_000 + 1;
    view = render(ui);
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('recovered'));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('isolates cached avatars by workspace and remote scope', async () => {
    setup('gitee-workspace');
    const request = vi.fn((command: BridgeCommand) => batchResult(command, () => useAppStore.getState().remotes.repo?.[0]?.fetchUrl.includes('github.com') ? 'data:image/png;base64,github' : 'data:image/png;base64,gitee'));
    const bridge = new MockBridge(request);
    useAppStore.setState({ remotes: { repo: [{name:'origin',fetchUrl:'https://gitee.com/user/repo.git',pushUrl:''}] } });
    const view = render(<BridgeContext.Provider value={bridge}>{avatar('Alice','alice@test')}</BridgeContext.Provider>);
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('gitee'));
    useAppStore.setState({ snapshot: {workspace:{id:'github-workspace'}} as never, remotes: {repo:[{name:'origin',fetchUrl:'https://github.com/user/repo.git',pushUrl:''}]} });
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('github'));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('clears native caches and discards an in-flight stale batch', async () => {
    setup();
    let finish!: (result: Record<string, string>) => void;
    const pending = new Promise<Record<string, string>>(resolve => { finish = resolve; });
    let batches = 0;
    const request = vi.fn((command: BridgeCommand) => {
      if (command.type === 'clearAuthorAvatarCache') return true;
      return ++batches === 1 ? pending : batchResult(command, () => 'data:image/png;base64,new');
    });
    const bridge = new MockBridge(request);
    const view = render(<BridgeContext.Provider value={bridge}>{avatar('胡国梁')}</BridgeContext.Provider>);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await act(async () => { await clearAuthorAvatarCache(bridge); });
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('new'));
    await act(async () => { finish({'email:915860729@qq.com':'data:image/png;base64,old'}); await pending; });
    expect(view.container.querySelector('img')?.src).toContain('new');
    const alias = render(<BridgeContext.Provider value={bridge}>{avatar('huguoliang')}</BridgeContext.Provider>);
    await waitFor(() => expect(alias.container.querySelector('img')?.src).toContain('new'));
    expect(batches).toBe(2);
  });
  it('uses cached history avatars immediately without another provider request', async () => {
    setup();
    const request = vi.fn();const bridge = new MockBridge(request);
    primeAuthorAvatars({bridge,workspaceId:'workspace',repoId:'repo',remoteScope:authorAvatarRemoteScope(),gravatar:false,crossPlatformFallback:false}, {'email:915860729@qq.com':'data:image/png;base64,cached'});
    const view = render(<BridgeContext.Provider value={bridge}>{avatar('huguoliang')}</BridgeContext.Provider>);
    expect(view.container.querySelector('img')?.src).toContain('cached');
    await act(async () => { await Promise.resolve(); });
    expect(request).not.toHaveBeenCalled();
  });
  it('does not share avatars between different names without email', async () => {
    setup();
    const bridge = new MockBridge(command => batchResult(command, (_, name) => name === 'Alice' ? 'data:image/png;base64,alice' : null));
    const view = render(<BridgeContext.Provider value={bridge}>{avatar('Alice','')}{avatar('Bob','')}</BridgeContext.Provider>);
    await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(1));
    expect(view.getByText('BO')).toBeInTheDocument();
  });
  it('extracts only the GitHub noreply username when no repository is provided', async () => {
    setup();
    render(<AuthorAvatar name="Ada" email="123+octocat@users.noreply.github.com" />);
    await waitFor(() => expect(requested[0]).toContain('avatars.githubusercontent.com/octocat'));
    expect(requested[0]).not.toContain('123+');
  });
  it('hashes ordinary email before requesting Gravatar', async () => {
    setup();
    useAppStore.setState({ bootstrap: {state:{settings:{onlineAvatarsEnabled:true,gravatarEnabled:true}}} as never });
    render(<AuthorAvatar name="Ada" email="Ada@Example.Test" />);
    await waitFor(() => expect(requested[0]).toContain('www.gravatar.com/avatar/'));
    expect(requested[0]).not.toContain('ada@example.test');
  });
});
