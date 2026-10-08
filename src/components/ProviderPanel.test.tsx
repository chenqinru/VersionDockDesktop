import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderPanel } from './ProviderPanel';
import { BridgeContext } from '../platform/context';
import { BridgeError, MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { createTranslator, I18nContext } from '../i18n';

afterEach(cleanup);
describe('ProviderPanel', () => {
  it('discards a late access error after switching accounts', async () => {
    let reject!: (reason: Error) => void;
    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') return ['alice', 'bob'].map(id => ({ id, provider: 'gitee', host: 'https://gitee.com', login: id, displayName: id, secureStorageRef: id }));
      if (command.type === 'providerRetryAccess') return new Promise((_, fail) => { reject = fail; });
      return null;
    });
    render(<BridgeContext.Provider value={bridge}><ProviderPanel mode="manage" close={vi.fn()} /></BridgeContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry secure storage access' }));
    await waitFor(() => expect(reject).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /bob \(bob\)/ }));
    expect(screen.getByText('@bob')).toBeInTheDocument();
    reject(new Error('late authorization error'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry secure storage access' })).not.toBeDisabled());
    expect(screen.queryByText('late authorization error')).toBeNull();
  });

  it('retries secure storage only on an explicit click and refreshes avatars after success', async () => {
    let allowed = false;
    const requests = vi.fn((command) => {
      if (command.type === 'providerAccounts') return [{ id: 'gitee', provider: 'gitee', host: 'https://gitee.com', login: 'alice', displayName: null, secureStorageRef: 'unused' }];
      if (command.type === 'providerRetryAccess') {
        if (!allowed) throw new BridgeError({ code: 'PROVIDER_KEY_ACCESS_FAILED', message: 'Access denied', command: null, stderr: null, exitCode: null, recoverable: true });
        return true;
      }
      return null;
    });
    const listener = vi.fn();
    window.addEventListener('versiondock-avatar-cache-clear', listener);
    try {
      const t = createTranslator('zh-CN');
      render(<I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t }}><BridgeContext.Provider value={new MockBridge(requests)}><ProviderPanel mode="manage" close={vi.fn()} /></BridgeContext.Provider></I18nContext.Provider>);
      const button = await screen.findByRole('button', { name: '重试安全存储访问' });
      expect(requests.mock.calls.filter(([command]) => command.type === 'providerRetryAccess')).toHaveLength(0);
      fireEvent.click(button);
      expect(await screen.findByText('无法读取安全存储中的账号令牌，请在账号管理中重试访问。')).toBeInTheDocument();
      expect(listener).not.toHaveBeenCalled();
      await waitFor(() => expect(button).not.toBeDisabled());
      allowed = true;
      fireEvent.click(button);
      await waitFor(() => expect(listener).toHaveBeenCalledOnce());
      expect(requests.mock.calls.filter(([command]) => command.type === 'providerRetryAccess').map(([command]) => command.payload)).toEqual([{ account_id: 'gitee' }, { account_id: 'gitee' }]);
      expect(screen.queryByText('无法读取安全存储中的账号令牌，请在账号管理中重试访问。')).toBeNull();
    } finally {
      window.removeEventListener('versiondock-avatar-cache-clear', listener);
    }
  });

  it('localizes invalid-token errors in the Chinese account connection form', async () => {
    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') return [];
      if (command.type === 'providerGiteeSave') throw new BridgeError({ code: 'PROVIDER_AUTH_REQUIRED', message: 'Provider request failed (401)', command: null, stderr: null, exitCode: null, recoverable: true });
      return null;
    });
    render(<I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t: createTranslator('zh-CN') }}><BridgeContext.Provider value={bridge}><ProviderPanel mode="manage" initialProvider="gitee" close={vi.fn()} /></BridgeContext.Provider></I18nContext.Provider>);
    fireEvent.change(await screen.findByPlaceholderText('个人访问令牌'), { target: { value: 'synthetic-token' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    expect(await screen.findByText('账号认证失败，请重新认证。')).toBeInTheDocument();
  });
  it.each(['zh-CN', 'en'] as const)('translates account details and reauthentication in %s', async (language) => {
    const bridge = new MockBridge((command) => command.type === 'providerAccounts'
      ? [{ id: 'gitee', provider: 'gitee', host: 'https://gitee.com', login: 'alice', displayName: null, secureStorageRef: 'unused' }] : null);
    const t = createTranslator(language);
    render(<I18nContext.Provider value={{ language, preference: language === 'zh-CN' ? 'zhCn' : 'en', t }}><BridgeContext.Provider value={bridge}><ProviderPanel mode="manage" close={vi.fn()} /></BridgeContext.Provider></I18nContext.Provider>);
    expect(await screen.findByRole('button', { name: t('Reauthenticate') })).toBeInTheDocument();
    if (language === 'zh-CN') expect(screen.queryByText('Reauthenticate')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('Reauthenticate') }));
    expect(await screen.findByText(t('Gitee Personal Access Token requires the projects and user_info scopes.'))).toBeInTheDocument();
  });
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
