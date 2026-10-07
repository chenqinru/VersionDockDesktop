import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { AuthorAvatar } from './AuthorAvatar';
import { useAppStore } from '../store/appStore';

const requested: string[] = [];
class SuccessfulImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(value: string) { requested.push(value); queueMicrotask(() => this.onload?.()); } }
const initial = useAppStore.getState();
afterEach(() => { cleanup(); requested.length = 0; useAppStore.setState(initial, true); window.dispatchEvent(new Event('versiondock-avatar-cache-clear')); });

describe('AuthorAvatar privacy', () => {
  it('isolates cache by workspace and re-resolves when the same repository remote changes', async () => {
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: SuccessfulImage });
    const resolve = vi.fn((command) => {
      if (command.type !== 'resolveAuthorAvatar') return null;
      const isGithub = command.payload.workspace_id === 'github-workspace' && useAppStore.getState().remotes.shared?.[0]?.fetchUrl.includes('github.com');
      return isGithub ? 'https://avatars.githubusercontent.com/github-user' : 'data:image/png;base64,gitee';
    });
    const bridge = new MockBridge(resolve);
    const settings = { onlineAvatarsEnabled: true, gravatarEnabled: false, avatarCrossPlatformFallback: true };
    useAppStore.setState({ bootstrap: { state: { settings } } as never, snapshot: { workspace: { id: 'gitee-workspace' } } as never, remotes: { shared: [{ name: 'origin', fetchUrl: 'https://gitee.com/user/repo.git', pushUrl: '' }] } });
    const view = render(<BridgeContext.Provider value={bridge}><AuthorAvatar name="chenqinru" email="chenqinru@qq.com" repoId="shared" /></BridgeContext.Provider>);
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('gitee'));
    useAppStore.setState({ snapshot: { workspace: { id: 'github-workspace' } } as never, remotes: { shared: [{ name: 'origin', fetchUrl: 'https://github.com/user/repo.git', pushUrl: '' }] } });
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('github-user'));
    expect(resolve).toHaveBeenCalledTimes(2);
    useAppStore.setState({ remotes: { shared: [{ name: 'origin', fetchUrl: 'https://gitee.com/user/repo.git', pushUrl: '' }] } });
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('gitee'));
    expect(resolve).toHaveBeenCalledTimes(3);
  });
  it('uses only the GitHub noreply username when enabled', async () => {
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: SuccessfulImage });
    useAppStore.setState({ bootstrap: { state: { settings: { onlineAvatarsEnabled: true, gravatarEnabled: false } } } as never });
    render(<AuthorAvatar name="Ada" email="123+octocat@users.noreply.github.com" />);
    await waitFor(() => expect(requested[0]).toContain('avatars.githubusercontent.com/octocat'));
    expect(requested[0]).not.toContain('123+');
  });
  it('hashes ordinary email before requesting Gravatar', async () => {
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: SuccessfulImage });
    useAppStore.setState({ bootstrap: { state: { settings: { onlineAvatarsEnabled: true, gravatarEnabled: true } } } as never });
    render(<AuthorAvatar name="Ada" email="Ada@Example.Test" />);
    await waitFor(() => expect(requested[0]).toContain('www.gravatar.com/avatar/'));
    expect(requested[0]).not.toContain('ada@example.test');
  });
});
