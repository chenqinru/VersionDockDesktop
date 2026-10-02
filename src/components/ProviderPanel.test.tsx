import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderPanel } from './ProviderPanel';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';

afterEach(cleanup);
describe('ProviderPanel', () => {
  it('opens the requested provider form when only another platform is connected', async () => {
    const bridge = new MockBridge((command) => command.type === 'providerAccounts'
      ? [{ id: 'github', provider: 'github', host: 'https://github.com', login: 'octocat', displayName: null, secureStorageRef: 'ref' }] : []);
    render(<BridgeContext.Provider value={bridge}><ProviderPanel mode="manage" initialProvider="gitlab" close={vi.fn()} /></BridgeContext.Provider>);
    expect(await screen.findByDisplayValue('https://gitlab.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('glpat-...')).toBeInTheDocument();
  });

  it('returns a paged private repository to the unified clone flow', async () => {
    const selected = vi.fn();
    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') return [{ id: 'account', provider: 'gitlab', host: 'https://gitlab.com', login: 'ada', displayName: 'Ada', secureStorageRef: 'ref' }];
      if (command.type === 'providerRepositories') return { items: [{ id: '1', provider: 'gitlab', host: 'https://gitlab.com', name: 'secret', fullName: 'ada/secret', cloneUrl: 'https://gitlab.com/ada/secret.git', webUrl: null, defaultBranch: 'main', namespace: null, private: true }], page: 1, hasMore: false };
      return [];
    });
    render(<BridgeContext.Provider value={bridge}><ProviderPanel mode="browse" close={vi.fn()} onClone={selected} /></BridgeContext.Provider>);
    await screen.findByText('ada/secret');
    fireEvent.click(screen.getByText('ada/secret'));
    await waitFor(() => expect(selected).toHaveBeenCalledWith(expect.objectContaining({ cloneUrl: 'https://gitlab.com/ada/secret.git', private: true }), 'account'));
  });

  it('renders connected accounts and details in manage mode', async () => {
    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') {
        return [
          { id: 'gh-1', provider: 'github', host: 'https://github.com', login: 'octocat', displayName: 'Monalisa Octocat', secureStorageRef: 'ref-gh' },
        ];
      }
      return [];
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <ProviderPanel mode="manage" close={vi.fn()} />
      </BridgeContext.Provider>
    );

    // 验证侧边栏和主视窗正确渲染账号信息
    expect(await screen.findByText('Monalisa Octocat')).toBeInTheDocument();
    expect(screen.getByText('@octocat')).toBeInTheDocument();
    expect(screen.getByText('https://github.com')).toBeInTheDocument();
  });

  it('clears avatar cache when clicking clear cache button', async () => {
    const clearListener = vi.fn();
    window.addEventListener('versiondock-avatar-cache-clear', clearListener);

    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') return [];
      return [];
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <ProviderPanel mode="manage" close={vi.fn()} />
      </BridgeContext.Provider>
    );

    const clearButton = await screen.findByText('Clear Avatar Cache');
    fireEvent.click(clearButton);

    expect(clearListener).toHaveBeenCalled();
    window.removeEventListener('versiondock-avatar-cache-clear', clearListener);
  });

  it('allows clicking Add GitHub Account and connects via PAT when client ID is missing', async () => {
    let savedPayload: unknown = null;
    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') return [];
      if (command.type === 'providerGithubSave') {
        savedPayload = command.payload;
        return {
          id: 'gh-pat-1',
          provider: 'github',
          host: 'https://github.com',
          login: 'pat-user',
          displayName: 'PAT User',
          secureStorageRef: 'ref-pat',
        };
      }
      return [];
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <ProviderPanel mode="manage" close={vi.fn()} />
      </BridgeContext.Provider>
    );

    const addBtn = await screen.findByText('Add GitHub Account');
    expect(addBtn.closest('button')).not.toBeDisabled();

    // 点击添加 GitHub 账号
    fireEvent.click(addBtn);

    // 验证出现 PAT 输入框
    const patInput = await screen.findByPlaceholderText('Personal Access Token (ghp_…)');
    expect(patInput).toBeInTheDocument();

    // 输入 token 并连接
    fireEvent.change(patInput, { target: { value: 'ghp_secrettoken123' } });
    const connectBtn = screen.getByText('Connect');
    fireEvent.click(connectBtn);

    await waitFor(() => {
      expect(savedPayload).toEqual({
        account_id: null,
        token: 'ghp_secrettoken123',
      });
    });
  });

  it('supports Device Flow and switching to PAT mode when client ID is available', async () => {
    const originalState = useAppStore.getState();
    useAppStore.setState({
      ...originalState,
      bootstrap: {
        ...((originalState.bootstrap as any) ?? {}),
        capabilities: {
          ...((originalState.bootstrap as any)?.capabilities ?? {}),
          availability: {
            ...((originalState.bootstrap as any)?.capabilities?.availability ?? {}),
            githubDeviceFlow: { available: true, reason: null, message: null, detail: null },
            githubProvider: { available: true, reason: null, message: null, detail: null },
          },
        },
      } as any,
    });

    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') return [];
      if (command.type === 'providerGithubBegin') {
        return {
          flowId: 'test-flow-1',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          interval: 5,
        };
      }
      if (command.type === 'providerGithubComplete') {
        return new Promise(() => {});
      }
      return [];
    });

    render(
      <BridgeContext.Provider value={bridge}>
        <ProviderPanel mode="manage" close={vi.fn()} />
      </BridgeContext.Provider>
    );

    const addBtn = await screen.findByText('Add GitHub Account');
    fireEvent.click(addBtn);

    // 验证出现设备码
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();

    // 点击切换为 PAT 模式
    const patSwitchBtn = screen.getByText('Personal Access Token (PAT)');
    fireEvent.click(patSwitchBtn);

    // 验证切换到了 PAT 输入框
    expect(await screen.findByPlaceholderText('Personal Access Token (ghp_…)')).toBeInTheDocument();

    useAppStore.setState(originalState);
  });
});

