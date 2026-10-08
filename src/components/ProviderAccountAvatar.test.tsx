import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, RemoteProviderAccount } from '../bindings/generated';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { ProviderAccountAvatar } from './ProviderAccountAvatar';

const avatar = 'data:image/png;base64,iVBORw0KGgo=';
const account = (provider: RemoteProviderAccount['provider'], id = provider): RemoteProviderAccount => ({ id, provider, host: `https://${provider}.example`, login: 'alice', displayName: 'Alice', secureStorageRef: 'unused' });
beforeEach(() => window.dispatchEvent(new Event('versiondock-avatar-cache-clear')));
afterEach(cleanup);

describe('provider account avatars', () => {
  it('shares an in-flight request across StrictMode and multiple mounted avatars', async () => {
    let resolve!: (value: string) => void;
    const request = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const bridge = new MockBridge(request);
    render(<StrictMode><BridgeContext.Provider value={bridge}><ProviderAccountAvatar account={account('gitee')} /><ProviderAccountAvatar account={account('gitee')} /></BridgeContext.Provider></StrictMode>);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    resolve(avatar);
    expect(await screen.findAllByRole('img')).toHaveLength(2);
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not automatically retry failed access on remount and ignores responses before cache clearing', async () => {
    let resolve!: (value: string) => void;
    const request = vi.fn().mockRejectedValueOnce(new Error('access denied'))
      .mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }))
      .mockResolvedValueOnce(null);
    const bridge = new MockBridge(request);
    const ui = <BridgeContext.Provider value={bridge}><ProviderAccountAvatar account={account('gitee')} /></BridgeContext.Provider>;
    const first = render(ui);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await new Promise((done) => setTimeout(done, 0));
    first.unmount();
    render(ui);
    await new Promise((done) => setTimeout(done, 0));
    expect(request).toHaveBeenCalledOnce();
    fireEvent(window, new Event('versiondock-avatar-cache-clear'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    fireEvent(window, new Event('versiondock-avatar-cache-clear'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    resolve(avatar);
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it.each(['github', 'gitlab', 'gitee'] as const)('uses the authenticated %s profile with a single centered image', async (provider) => {
    const request = vi.fn((command: BridgeCommand) => command.type === 'providerAccountAvatar' ? avatar : null);
    const bridge = new MockBridge(request);
    const view = render(<BridgeContext.Provider value={bridge}><ProviderAccountAvatar account={account(provider)} /></BridgeContext.Provider>);
    expect(await screen.findByRole('img', { name: 'alice' })).toHaveAttribute('src', avatar);
    expect(view.container.querySelector('.codicon-account')).toBeNull();
    expect(request.mock.calls[0][0]).toEqual({ type: 'providerAccountAvatar', payload: { account_id: provider } });
  });

  it('shows a neutral fallback on missing or broken images and recovers after clearing cache', async () => {
    let value: string | null = null;
    const request = vi.fn(() => value);
    const bridge = new MockBridge(request);
    const view = render(<BridgeContext.Provider value={bridge}><ProviderAccountAvatar account={account('gitee')} /></BridgeContext.Provider>);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(screen.queryByRole('img')).toBeNull(); expect(view.container.querySelector('.codicon-account')).not.toBeNull();
    value = avatar;
    fireEvent(window, new Event('versiondock-avatar-cache-clear'));
    const image = await screen.findByRole('img'); fireEvent.error(image);
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent(window, new Event('versiondock-avatar-cache-clear'));
    expect(await screen.findByRole('img')).toHaveAttribute('src', avatar);
  });

  it('discards a late response from the previously selected account', async () => {
    let resolve!: (url: string) => void;
    const bridge = new MockBridge((command) => command.type === 'providerAccountAvatar' && command.payload.account_id === 'github'
      ? new Promise((done) => { resolve = done; }) : null);
    const view = render(<BridgeContext.Provider value={bridge}><ProviderAccountAvatar account={account('github')} /></BridgeContext.Provider>);
    view.rerender(<BridgeContext.Provider value={bridge}><ProviderAccountAvatar account={account('gitlab')} /></BridgeContext.Provider>);
    resolve(avatar); await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByRole('img')).toBeNull();
  });
});
