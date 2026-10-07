import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MockBridge } from '../../platform/bridge';
import { BridgeContext } from '../../platform/context';
import { useAppStore } from '../../store/appStore';
import { ProfileStatusTooltip } from './ProfileStatusTooltip';

const initial = useAppStore.getState();
afterEach(() => { cleanup(); useAppStore.setState(initial, true); });
it('uses the primary GitHub account avatar even when Gitee was connected first', async () => {
  window.dispatchEvent(new Event('versiondock-avatar-cache-clear'));
  const repository = { meta: { id: 'repo', name: 'Repo', kind: 'git' } } as never;
  useAppStore.setState({ bootstrap: { state: { settings: { onlineAvatarsEnabled: true } } } as never, branchesByRepo: { repo: [{ current: true, upstream: 'origin/main' } as never] } });
  const request = vi.fn((command) => command.type === 'providerAccountAvatar' ? 'data:image/png;base64,github' : null);
  const data = { git: {}, svn: {}, errors: {}, loading: false, reload: vi.fn(),
    accounts: [{ id:'gitee', provider:'gitee', host:'https://gitee.com', login:'alice', displayName:null, secureStorageRef:'unused' }, { id:'github', provider:'github', host:'https://github.com', login:'alice', displayName:null, secureStorageRef:'unused' }],
    remotes: { repo: [{ name:'mirror', fetchUrl:'https://gitee.com/org/repo.git', pushUrl:'' }, { name:'origin', fetchUrl:'https://github.com/org/repo.git', pushUrl:'' }] },
  } as never;
  render(<BridgeContext.Provider value={new MockBridge(request)}><ProfileStatusTooltip data={data} repo={repository} repositories={[repository]} anchor={new DOMRect()} onManage={vi.fn()} onLeave={vi.fn()} /></BridgeContext.Provider>);
  expect(await screen.findByRole('img', { name: 'alice' })).toHaveAttribute('src', 'data:image/png;base64,github');
  expect(request).toHaveBeenCalledWith({ type:'providerAccountAvatar', payload: { account_id:'github' } }, expect.anything());
  expect(request).not.toHaveBeenCalledWith({ type:'providerAccountAvatar', payload: { account_id:'gitee' } }, expect.anything());
});
