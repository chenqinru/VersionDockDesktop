import { IconButton } from './IconButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  GithubDeviceFlow,
  PublishRepositoryResult,
  RemoteNamespace,
  RemoteProviderAccount,
  RemoteProviderKind,
  RemoteRepository,
  RemoteRepositoryPage,
  RemoteVisibility,
} from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { DialogSurface } from './DialogSurface';
import { useAppStore } from '../store/appStore';
import { isAbortError } from '../platform/bridge';

export interface ProviderPanelProps {
  mode: 'manage' | 'browse' | 'publish';
  initialProvider?: RemoteProviderKind;
  repoId?: string;
  close: () => void;
  onClone?: (repository: RemoteRepository, accountId: string) => void;
}

type ActiveView = 'none' | 'detail' | 'github_flow' | 'github_form' | 'gitlab_form' | 'gitee_form';

export function ProviderPanel({ mode, repoId, close, onClone, initialProvider }: ProviderPanelProps) {
  const bridge = useBridge();
  const { t } = useI18n();
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id ?? '');
  const providerAvailability = useAppStore((state) => state.bootstrap?.capabilities.availability);
  const authController = useRef<AbortController | null>(null);

  const isGithubDeviceFlowAvailable = providerAvailability?.githubDeviceFlow?.available === true;
  const isGithubAvailable = providerAvailability?.githubProvider?.available !== false;

  useEffect(() => () => authController.current?.abort(), []);

  const [accounts, setAccounts] = useState<RemoteProviderAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [activeView, setActiveView] = useState<ActiveView>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingAccountId, setEditingAccountId] = useState<string>();
  const [copiedCode, setCopiedCode] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // GitHub PAT 表单状态
  const [ghPat, setGhPat] = useState('');
  const [showGhPassword, setShowGhPassword] = useState(false);

  // GitLab 表单状态
  const [glHost, setGlHost] = useState('https://gitlab.com');
  const [glPat, setGlPat] = useState('');
  const [showGlPassword, setShowGlPassword] = useState(false);

  // Gitee 表单状态
  const [gtPat, setGtPat] = useState('');
  const [showGtPassword, setShowGtPassword] = useState(false);

  // GitHub Device Flow 状态
  const [flow, setFlow] = useState<GithubDeviceFlow>();

  // Browse 模式状态
  const [repositories, setRepositories] = useState<RemoteRepository[]>([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  // Publish 模式状态
  const [namespaces, setNamespaces] = useState<RemoteNamespace[]>([]);
  const [namespace, setNamespace] = useState('');
  const [publishName, setPublishName] = useState('');
  const [publishDescription, setPublishDescription] = useState('');
  const [visibility, setVisibility] = useState<RemoteVisibility>('private');
  const [pushAfterCreate, setPushAfterCreate] = useState(true);
  const [publishResult, setPublishResult] = useState<PublishRepositoryResult>();

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedProvider = selectedAccount?.provider;

  useEffect(() => {
    if (selectedProvider !== 'gitlab' && visibility === 'internal') {
      queueMicrotask(() => setVisibility('private'));
    }
  }, [selectedProvider, visibility]);

  const dialogRef = useRef<HTMLElement>(null);

  const clearAvatarCache = () => {
    window.dispatchEvent(new Event('versiondock-avatar-cache-clear'));
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2000);
  };

  const loadAccounts = useCallback(async () => {
    try {
      const values = await bridge.request<RemoteProviderAccount[]>({ type: 'providerAccounts' }, { showProgress: false });
      setAccounts(values);
      if (initialProvider && !values.some((account) => account.provider === initialProvider)) {
        setSelectedAccountId('');
        setActiveView(initialProvider === 'github' ? 'github_form' : initialProvider === 'gitlab' ? 'gitlab_form' : 'gitee_form');
        return;
      }
      if (values.length > 0) {
        setSelectedAccountId((current) => {
          const next = values.some((a) => a.id === current) ? current : (values.find((a) => a.provider === initialProvider) ?? values[0]).id;
          return next;
        });
        setActiveView((current) => (current === 'none' || current === 'detail' ? 'detail' : current));
      } else {
        setSelectedAccountId('');
        setActiveView((current) => (current === 'detail' ? 'none' : current));
      }
    } catch (err) {
      if (!isAbortError(err)) setError(String(err));
    }
  }, [bridge, initialProvider]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void loadAccounts();
    });
    return () => {
      active = false;
    };
  }, [loadAccounts]);

  // Browse 仓库加载
  const loadRepositories = useCallback(
    async (nextPage = 1, append = false) => {
      if (!selectedAccountId) return;
      setBusy(true);
      setError('');
      try {
        const value = await bridge.request<RemoteRepositoryPage>(
          {
            type: 'providerRepositories',
            payload: { account_id: selectedAccountId, query: query.trim() || null, page: nextPage, per_page: 50 },
          },
          { showProgress: false }
        );
        setRepositories((current) => (append ? [...current, ...value.items] : value.items));
        setPage(value.page);
        setHasMore(value.hasMore);
      } catch (reason) {
        if (!isAbortError(reason)) setError(String(reason));
      } finally {
        setBusy(false);
      }
    },
    [bridge, query, selectedAccountId]
  );

  useEffect(() => {
    if (mode === 'browse' && selectedAccountId) {
      let active = true;
      void Promise.resolve().then(() => {
        if (active) void loadRepositories();
      });
      return () => {
        active = false;
      };
    }
  }, [loadRepositories, mode, selectedAccountId]);

  // Publish 命名空间加载
  useEffect(() => {
    if (mode !== 'publish' || !selectedAccountId) return;
    void bridge
      .request<RemoteNamespace[]>({ type: 'providerNamespaces', payload: { account_id: selectedAccountId } }, { showProgress: false })
      .then((values) => {
        setNamespaces(values);
        const isPathNamespace = accounts.find((a) => a.id === selectedAccountId)?.provider !== 'gitlab';
        setNamespace(isPathNamespace ? values[0]?.fullPath ?? '' : values[0]?.id ?? '');
      })
      .catch((reason) => {
        if (!isAbortError(reason)) setError(String(reason));
      });
  }, [accounts, bridge, mode, selectedAccountId]);

  // 1. GitHub Device Flow
  const startGithubAuth = async (accountId?: string) => {
    authController.current?.abort();
    const controller = new AbortController();
    authController.current = controller;
    setBusy(true);
    setError('');
    setActiveView('github_flow');
    try {
      const value = await bridge.request<GithubDeviceFlow>(
        { type: 'providerGithubBegin', payload: { account_id: accountId ?? null } },
        { signal: controller.signal }
      );
      setFlow(value);
      try {
        await openUrl(value.verificationUri);
      } catch {
        // 如果系统默认浏览器拉起失败，界面上提供手动点击按钮
      }
      const account = await bridge.request<RemoteProviderAccount>(
        { type: 'providerGithubComplete', payload: { flow_id: value.flowId } },
        { timeoutMs: 900_000, signal: controller.signal }
      );
      clearAvatarCache();
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      setSelectedAccountId(account.id);
      setActiveView('detail');
      setFlow(undefined);
    } catch (reason) {
      if (!controller.signal.aborted && !isAbortError(reason)) {
        setError(String(reason));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const cancelGithubAuth = () => {
    authController.current?.abort();
    authController.current = null;
    setBusy(false);
    setFlow(undefined);
    setActiveView(accounts.length > 0 ? 'detail' : 'none');
  };

  // 1.2 GitHub 账号 Token 保存
  const saveGithubToken = async () => {
    if (!ghPat.trim()) return;
    setBusy(true);
    setError('');
    try {
      const account = await bridge.request<RemoteProviderAccount>({
        type: 'providerGithubSave',
        payload: { account_id: editingAccountId ?? null, token: ghPat.trim() },
      });
      clearAvatarCache();
      setGhPat('');
      setEditingAccountId(undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      setSelectedAccountId(account.id);
      setActiveView('detail');
    } catch (reason) {
      if (!isAbortError(reason)) setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  // 2. GitLab 账号保存
  const saveGitlab = async () => {
    if (!glPat.trim()) return;
    setBusy(true);
    setError('');
    try {
      const account = await bridge.request<RemoteProviderAccount>({
        type: 'providerGitlabSave',
        payload: { account_id: editingAccountId ?? null, host: glHost.trim(), token: glPat.trim() },
      });
      clearAvatarCache();
      setGlPat('');
      setEditingAccountId(undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      setSelectedAccountId(account.id);
      setActiveView('detail');
    } catch (reason) {
      if (!isAbortError(reason)) setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  // 3. Gitee 账号保存
  const saveGitee = async () => {
    if (!gtPat.trim()) return;
    setBusy(true);
    setError('');
    try {
      const account = await bridge.request<RemoteProviderAccount>({
        type: 'providerGiteeSave',
        payload: { account_id: editingAccountId ?? null, token: gtPat.trim() },
      });
      clearAvatarCache();
      setGtPat('');
      setEditingAccountId(undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      setSelectedAccountId(account.id);
      setActiveView('detail');
    } catch (reason) {
      if (!isAbortError(reason)) setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  // 4. 账号删除
  const removeAccount = async (id: string) => {
    try {
      await bridge.request({ type: 'providerRemove', payload: { account_id: id } });
      clearAvatarCache();
      setConfirmRemoveId(null);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
    } catch (reason) {
      if (!isAbortError(reason)) setError(String(reason));
    }
  };

  // 5. 发布仓库
  const handlePublish = async () => {
    if (!workspaceId || !repoId || !selectedAccountId || !publishName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const value = await bridge.request<PublishRepositoryResult>(
        {
          type: 'publishRepository',
          payload: {
            workspace_id: workspaceId,
            repo_id: repoId,
            account_id: selectedAccountId,
            namespace_id: namespace || null,
            name: publishName.trim(),
            description: publishDescription.trim(),
            visibility,
            push: pushAfterCreate,
          },
        },
        { timeoutMs: 600_000 }
      );
      setPublishResult(value);
    } catch (reason) {
      if (!isAbortError(reason)) setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyCode = async () => {
    if (!flow?.userCode) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // 忽略剪贴板写入异常
    }
  };

  const getProfileUrl = (account: RemoteProviderAccount) => {
    if (account.provider === 'github') {
      return `https://github.com/${encodeURIComponent(account.login)}`;
    }
    if (account.provider === 'gitee') {
      return `https://gitee.com/${encodeURIComponent(account.login)}`;
    }
    return `${account.host.replace(/\/$/, '')}/${encodeURIComponent(account.login)}`;
  };

  return (
    <DialogSurface preserveStyle ref={dialogRef} className="modal-panel provider-panel" onClose={close} aria-label={t('Remote Providers')}>
        <header className="modal-header">
          <div className="modal-header-title">
            <Codicon name="cloud" />
            <strong>
              {t(
                mode === 'browse'
                  ? 'Browse Remote Repositories'
                  : mode === 'publish'
                  ? 'Publish Repository'
                  : 'Remote Providers'
              )}
            </strong>
          </div>
          <IconButton type="button" className="modal-close-btn" onClick={close} title={t('Close')} aria-label={t('Close')}>
            <Codicon name="close" />
          </IconButton>
        </header>

        <div className="provider-body">
          {/* 左侧账号与平台侧边栏 */}
          <aside className="provider-accounts">
            <div className="provider-sidebar-header">
              <span className="provider-sidebar-title">{t('Connected Platforms')}</span>
              <span className="provider-account-count">{accounts.length}</span>
            </div>

            <div className="provider-accounts-list">
              {accounts.map((account) => {
                const isSelected = selectedAccountId === account.id && activeView === 'detail';
                return (
                  <button
                    key={account.id}
                    type="button"
                    className={`provider-account-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedAccountId(account.id);
                      setActiveView('detail');
                      setError('');
                    }}
                  >
                    <div className="provider-account-info">
                      <div className={`provider-platform-icon ${account.provider}`}>
                        <Codicon
                          name={account.provider === 'github' ? 'github' : account.provider === 'gitee' ? 'cloud' : 'key'}
                        />
                      </div>
                      <div className="provider-account-names">
                        <span className="provider-account-login">
                          {account.displayName ? `${account.displayName} (${account.login})` : account.login}
                        </span>
                        <span className="provider-account-host">
                          {account.provider.toUpperCase()} • {account.host.replace(/^https?:\/\//, '')}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}

              {accounts.length === 0 && (
                <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--versiondock-muted)', fontSize: '11px' }}>
                  {t('No connected accounts')}
                </div>
              )}
            </div>

            {/* 添加平台入口按钮组 */}
            <div className="provider-add-section">
              <button
                type="button"
                className="provider-add-btn"
                title={!isGithubAvailable ? (providerAvailability?.githubProvider?.detail ?? t('Secure storage is unavailable')) : undefined}
                disabled={busy || !isGithubAvailable}
                onClick={() => {
                  setEditingAccountId(undefined);
                  setError('');
                  if (isGithubDeviceFlowAvailable) {
                    void startGithubAuth();
                  } else {
                    setGhPat('');
                    setActiveView('github_form');
                  }
                }}
              >
                <Codicon name="github" />
                <span>{t('Add GitHub Account')}</span>
              </button>

              <button
                type="button"
                className="provider-add-btn"
                title={providerAvailability?.gitlabProvider?.detail ?? undefined}
                disabled={busy || providerAvailability?.gitlabProvider?.available === false}
                onClick={() => {
                  setEditingAccountId(undefined);
                  setGlHost('https://gitlab.com');
                  setGlPat('');
                  setActiveView('gitlab_form');
                  setError('');
                }}
              >
                <Codicon name="key" />
                <span>{t('Add GitLab Account')}</span>
              </button>

              <button
                type="button"
                className="provider-add-btn"
                title={providerAvailability?.giteeProvider?.detail ?? undefined}
                disabled={busy || providerAvailability?.giteeProvider?.available === false}
                onClick={() => {
                  setEditingAccountId(undefined);
                  setGtPat('');
                  setActiveView('gitee_form');
                  setError('');
                }}
              >
                <Codicon name="cloud" />
                <span>{t('Add Gitee Account')}</span>
              </button>
            </div>

            {/* 侧边栏底部操作 */}
            <div className="provider-sidebar-footer">
              <button
                type="button"
                className="provider-cache-btn"
                onClick={clearAvatarCache}
                title={t('Purge cached avatars and force reload')}
              >
                <Codicon name={cacheCleared ? 'check' : 'trash'} />
                <span>{cacheCleared ? t('Avatar cache cleared') : t('Clear Avatar Cache')}</span>
              </button>
            </div>
          </aside>

          {/* 右侧主视窗 */}
          <main className="provider-content">
            {error && <p className="dialog-error" style={{ marginBottom: 12 }}>{error}</p>}

            {/* 1. 账号管理模式 Manage */}
            {mode === 'manage' && (
              <>
                {/* 视图 A: 空状态 */}
                {activeView === 'none' && (
                  <div className="provider-empty-state">
                    <div className="provider-empty-icon">
                      <Codicon name="account" />
                    </div>
                    <div className="provider-empty-title">{t('Remote Providers')}</div>
                    <div className="provider-empty-desc">
                      {t('Connect your GitHub, GitLab, or Gitee accounts to browse repositories, publish projects, and resolve author avatars.')}
                    </div>
                  </div>
                )}

                {/* 视图 B: 账号详情卡片 */}
                {activeView === 'detail' && selectedAccount && (
                  <div className="provider-detail-card">
                    <div className="provider-detail-header">
                      <div className="provider-avatar-box">
                        <img
                          src={
                            selectedAccount.provider === 'github'
                              ? `https://avatars.githubusercontent.com/${encodeURIComponent(selectedAccount.login)}`
                              : './icons/versiondock-logo-dark.png'
                          }
                          alt={selectedAccount.login}
                          className="provider-avatar-img"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                        <Codicon name="account" />
                      </div>
                      <div className="provider-detail-headings">
                        <div className="provider-detail-title-row">
                          <span className="provider-detail-name">
                            {selectedAccount.displayName || selectedAccount.login}
                          </span>
                          <span className="provider-status-badge">
                            <span className="provider-status-dot" />
                            {t('Connected')}
                          </span>
                        </div>
                        <span className="provider-detail-login">@{selectedAccount.login}</span>
                      </div>
                    </div>

                    <div className="provider-detail-fields">
                      <div className="provider-detail-field-row">
                        <span className="provider-detail-field-label">{t('Provider')}</span>
                        <span className="provider-detail-field-val">
                          {selectedAccount.provider === 'github'
                            ? 'GitHub'
                            : selectedAccount.provider === 'gitlab'
                            ? 'GitLab'
                            : 'Gitee'}
                        </span>
                      </div>
                      <div className="provider-detail-field-row">
                        <span className="provider-detail-field-label">{t('Host')}</span>
                        <span className="provider-detail-field-val">{selectedAccount.host}</span>
                      </div>
                      <div className="provider-detail-field-row">
                        <span className="provider-detail-field-label">{t('Username')}</span>
                        <span className="provider-detail-field-val">{selectedAccount.login}</span>
                      </div>
                    </div>

                    {confirmRemoveId === selectedAccount.id ? (
                      <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: 'color-mix(in srgb, var(--versiondock-danger) 12%, transparent)', border: '1px solid var(--versiondock-danger)' }}>
                        <div style={{ fontSize: '11.5px', marginBottom: 8, color: 'var(--versiondock-text)' }}>
                          {t('Are you sure you want to disconnect account {0}?', selectedAccount.login)}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className="settings-action-btn"
                            style={{ background: 'var(--versiondock-danger)', color: '#fff', borderColor: 'var(--versiondock-danger)' }}
                            onClick={() => void removeAccount(selectedAccount.id)}
                          >
                            {t('Disconnect Account')}
                          </button>
                          <button
                            type="button"
                            className="settings-action-btn"
                            onClick={() => setConfirmRemoveId(null)}
                          >
                            {t('Cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="provider-detail-actions">
                        <button
                          type="button"
                          className="settings-action-btn primary"
                          onClick={() => void openUrl(getProfileUrl(selectedAccount))}
                        >
                          <Codicon name="globe" />
                          <span>{t('Open Profile')}</span>
                        </button>

                        <button
                          type="button"
                          className="settings-action-btn"
                          onClick={() => {
                            if (selectedAccount.provider === 'github') {
                              setEditingAccountId(selectedAccount.id);
                              if (isGithubDeviceFlowAvailable) {
                                void startGithubAuth(selectedAccount.id);
                              } else {
                                setGhPat('');
                                setActiveView('github_form');
                                setError('');
                              }
                            } else if (selectedAccount.provider === 'gitee') {
                              setEditingAccountId(selectedAccount.id);
                              setGtPat('');
                              setActiveView('gitee_form');
                            } else {
                              setEditingAccountId(selectedAccount.id);
                              setGlHost(selectedAccount.host);
                              setGlPat('');
                              setActiveView('gitlab_form');
                            }
                          }}
                        >
                          <Codicon name="refresh" />
                          <span>{t('Reauthenticate')}</span>
                        </button>

                        <button
                          type="button"
                          className="settings-action-btn danger"
                          onClick={() => setConfirmRemoveId(selectedAccount.id)}
                        >
                          <Codicon name="trash" />
                          <span>{t('Disconnect Account')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* 视图 C: GitHub Device Flow 授权卡片 */}
                {activeView === 'github_flow' && (
                  <div className="provider-form-card">
                    <div className="provider-form-header">
                      <Codicon name="github" />
                      <span>{editingAccountId ? t('Reauthenticate') : t('Add GitHub Account')}</span>
                    </div>

                    <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                      <button
                        type="button"
                        className="settings-action-btn primary"
                        style={{ fontSize: '11px', padding: '0 8px', height: 24 }}
                        disabled
                      >
                        <Codicon name="github" />
                        <span>{t('Device Authorization (OAuth)')}</span>
                      </button>
                      <button
                        type="button"
                        className="settings-action-btn"
                        style={{ fontSize: '11px', padding: '0 8px', height: 24 }}
                        onClick={() => {
                          cancelGithubAuth();
                          setGhPat('');
                          setActiveView('github_form');
                          setError('');
                        }}
                      >
                        <Codicon name="key" />
                        <span>{t('Personal Access Token (PAT)')}</span>
                      </button>
                    </div>

                    <div className="provider-field-hint">
                      {t('Enter this code in the opened GitHub page.')}
                    </div>

                    {flow && (
                      <div className="provider-device-code-box">
                        <span className="provider-device-code">{flow.userCode}</span>
                        <button
                          type="button"
                          className="settings-action-btn"
                          onClick={() => void handleCopyCode()}
                        >
                          <Codicon name={copiedCode ? 'check' : 'copy'} />
                          <span>{copiedCode ? t('Copied') : t('Copy Code')}</span>
                        </button>
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--versiondock-muted)', fontSize: '11.5px', marginTop: 4 }}>
                      <Codicon name="loading codicon-modifier-spin" />
                      <span>{t('Waiting for authorization…')}</span>
                    </div>

                    <div className="provider-form-actions">
                      {flow?.verificationUri && (
                        <button
                          type="button"
                          className="settings-action-btn primary"
                          onClick={() => void openUrl(flow.verificationUri)}
                        >
                          <Codicon name="link-external" />
                          <span>{t('Open Verification Page')}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="settings-action-btn"
                        onClick={cancelGithubAuth}
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {/* 视图 C2: GitHub PAT 表单 */}
                {activeView === 'github_form' && (
                  <div className="provider-form-card">
                    <div className="provider-form-header">
                      <Codicon name="github" />
                      <span>{editingAccountId ? t('Reauthenticate') : t('Add GitHub Account')}</span>
                    </div>

                    {isGithubDeviceFlowAvailable && (
                      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                        <button
                          type="button"
                          className="settings-action-btn"
                          style={{ fontSize: '11px', padding: '0 8px', height: 24 }}
                          onClick={() => {
                            setEditingAccountId(editingAccountId);
                            void startGithubAuth(editingAccountId);
                          }}
                        >
                          <Codicon name="github" />
                          <span>{t('Device Authorization (OAuth)')}</span>
                        </button>
                        <button
                          type="button"
                          className="settings-action-btn primary"
                          style={{ fontSize: '11px', padding: '0 8px', height: 24 }}
                          disabled
                        >
                          <Codicon name="key" />
                          <span>{t('Personal Access Token (PAT)')}</span>
                        </button>
                      </div>
                    )}

                    {!isGithubDeviceFlowAvailable && (
                      <div
                        style={{
                          marginBottom: 12,
                          padding: '8px 10px',
                          background: 'color-mix(in srgb, var(--versiondock-sidebar-active) 80%, transparent)',
                          border: '1px solid var(--versiondock-border)',
                          borderRadius: 4,
                          fontSize: '11.5px',
                          color: 'var(--versiondock-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <Codicon name="info" />
                        <span>{t('GitHub OAuth App Client ID is not configured. You can connect using a Personal Access Token.')}</span>
                      </div>
                    )}

                    <div className="provider-form-field">
                      <label htmlFor="gh-pat-input">{t('Personal Access Token')}</label>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <input
                          id="gh-pat-input"
                          type={showGhPassword ? 'text' : 'password'}
                          value={ghPat}
                          placeholder={t('Personal Access Token (ghp_…)')}
                          onChange={(e) => setGhPat(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveGithubToken();
                          }}
                        />
                        <IconButton
                          type="button"
                          style={{ position: 'absolute', right: 8, background: 'transparent', border: 'none', color: 'var(--versiondock-muted)', cursor: 'pointer' }}
                          onClick={() => setShowGhPassword(!showGhPassword)}
                          title={showGhPassword ? 'Hide' : 'Show'}
                        >
                          <Codicon name={showGhPassword ? 'eye-closed' : 'eye'} />
                        </IconButton>
                      </div>
                      <span className="provider-field-hint">
                        {t('GitHub Personal Access Token requires the repo and read:org scopes.')}
                      </span>
                    </div>

                    <div className="provider-form-actions">
                      <button
                        type="button"
                        className="settings-action-btn primary"
                        disabled={!ghPat.trim() || busy}
                        onClick={() => void saveGithubToken()}
                      >
                        {busy ? <Codicon name="loading codicon-modifier-spin" /> : <Codicon name="check" />}
                        <span>{t('Connect')}</span>
                      </button>

                      <button
                        type="button"
                        className="settings-action-btn"
                        onClick={() => {
                          setGhPat('');
                          setEditingAccountId(undefined);
                          setActiveView(accounts.length > 0 ? 'detail' : 'none');
                        }}
                      >
                        {t('Cancel')}
                      </button>

                      <button
                        type="button"
                        className="settings-action-btn"
                        style={{ marginLeft: 'auto' }}
                        onClick={() =>
                          void openUrl(
                            'https://github.com/settings/tokens/new?scopes=repo,read:org,read:user,user:email&description=VersionDock'
                          )
                        }
                      >
                        <Codicon name="link-external" />
                        <span>{t('Create Token')}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* 视图 D: GitLab Token 表单 */}
                {activeView === 'gitlab_form' && (
                  <div className="provider-form-card">
                    <div className="provider-form-header">
                      <Codicon name="key" />
                      <span>{editingAccountId ? t('Reauthenticate') : t('Add GitLab Account')}</span>
                    </div>

                    <div className="provider-form-field">
                      <label htmlFor="gl-host-input">{t('GitLab Host')}</label>
                      <input
                        id="gl-host-input"
                        value={glHost}
                        placeholder="https://gitlab.com"
                        onChange={(e) => setGlHost(e.target.value)}
                      />
                      <span className="provider-field-hint">
                        {t('Enter gitlab.com or a self-hosted GitLab URL')}
                      </span>
                    </div>

                    <div className="provider-form-field">
                      <label htmlFor="gl-pat-input">{t('Personal Access Token')}</label>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <input
                          id="gl-pat-input"
                          type={showGlPassword ? 'text' : 'password'}
                          value={glPat}
                          placeholder="glpat-..."
                          onChange={(e) => setGlPat(e.target.value)}
                        />
                        <IconButton
                          type="button"
                          style={{ position: 'absolute', right: 8, background: 'transparent', border: 'none', color: 'var(--versiondock-muted)', cursor: 'pointer' }}
                          onClick={() => setShowGlPassword(!showGlPassword)}
                          title={showGlPassword ? 'Hide' : 'Show'}
                        >
                          <Codicon name={showGlPassword ? 'eye-closed' : 'eye'} />
                        </IconButton>
                      </div>
                      <span className="provider-field-hint">
                        {t('GitLab Personal Access Token requires the api scope.')}
                      </span>
                    </div>

                    <div className="provider-form-actions">
                      <button
                        type="button"
                        className="settings-action-btn primary"
                        disabled={!glPat.trim() || busy}
                        onClick={() => void saveGitlab()}
                      >
                        {busy ? <Codicon name="loading codicon-modifier-spin" /> : <Codicon name="check" />}
                        <span>{t('Connect')}</span>
                      </button>

                      <button
                        type="button"
                        className="settings-action-btn"
                        onClick={() => {
                          setGlPat('');
                          setActiveView(accounts.length > 0 ? 'detail' : 'none');
                        }}
                      >
                        {t('Cancel')}
                      </button>

                      <button
                        type="button"
                        className="settings-action-btn"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => void openUrl(`${glHost.replace(/\/$/, '')}/-/user_settings/personal_access_tokens`)}
                      >
                        <Codicon name="link-external" />
                        <span>{t('Create Token')}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* 视图 E: Gitee Token 表单 */}
                {activeView === 'gitee_form' && (
                  <div className="provider-form-card">
                    <div className="provider-form-header">
                      <Codicon name="cloud" />
                      <span>{editingAccountId ? t('Reauthenticate') : t('Add Gitee Account')}</span>
                    </div>

                    <div className="provider-form-field">
                      <label htmlFor="gt-pat-input">{t('Personal Access Token')}</label>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <input
                          id="gt-pat-input"
                          type={showGtPassword ? 'text' : 'password'}
                          value={gtPat}
                          placeholder={t('Personal Access Token')}
                          onChange={(e) => setGtPat(e.target.value)}
                        />
                        <IconButton
                          type="button"
                          style={{ position: 'absolute', right: 8, background: 'transparent', border: 'none', color: 'var(--versiondock-muted)', cursor: 'pointer' }}
                          onClick={() => setShowGtPassword(!showGtPassword)}
                          title={showGtPassword ? t('Hide') : t('Show')}
                        >
                          <Codicon name={showGtPassword ? 'eye-closed' : 'eye'} />
                        </IconButton>
                      </div>
                      <span className="provider-field-hint">
                        {t('Gitee Personal Access Token requires the projects and user_info scopes.')}
                      </span>
                    </div>

                    <div className="provider-form-actions">
                      <button
                        type="button"
                        className="settings-action-btn primary"
                        disabled={!gtPat.trim() || busy}
                        onClick={() => void saveGitee()}
                      >
                        {busy ? <Codicon name="loading codicon-modifier-spin" /> : <Codicon name="check" />}
                        <span>{t('Connect')}</span>
                      </button>

                      <button
                        type="button"
                        className="settings-action-btn"
                        onClick={() => {
                          setGtPat('');
                          setActiveView(accounts.length > 0 ? 'detail' : 'none');
                        }}
                      >
                        {t('Cancel')}
                      </button>

                      <button
                        type="button"
                        className="settings-action-btn"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => void openUrl('https://gitee.com/profile/personal_access_tokens')}
                      >
                        <Codicon name="link-external" />
                        <span>{t('Create Token')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 2. 浏览仓库模式 Browse */}
            {mode === 'browse' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div className="provider-browse-header">
                  <div className="provider-search-box">
                    <Codicon name="search" className="provider-search-icon" />
                    <input
                      value={query}
                      placeholder={t('Search repositories…')}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void loadRepositories();
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={() => void loadRepositories()}
                    disabled={busy}
                  >
                    <Codicon name={busy ? 'loading codicon-modifier-spin' : 'refresh'} />
                    <span>{t('Search')}</span>
                  </button>
                </div>

                <div className="provider-repo-list">
                  {repositories.map((repo) => (
                    <div
                      key={`${repo.host}:${repo.id}`}
                      className="provider-repo-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => onClone?.(repo, selectedAccountId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') onClone?.(repo, selectedAccountId);
                      }}
                    >
                      <div className="provider-repo-name-group">
                        <Codicon name={repo.private ? 'lock' : 'repo'} />
                        <span className="provider-repo-name">{repo.fullName}</span>
                      </div>
                      <span className="provider-repo-branch">{repo.defaultBranch ?? t('No default branch')}</span>
                    </div>
                  ))}

                  {repositories.length === 0 && !busy && (
                    <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--versiondock-muted)', padding: '24px 0' }}>
                      {t('No matches')}
                    </div>
                  )}
                </div>

                {hasMore && (
                  <div style={{ marginTop: 10, textAlign: 'center' }}>
                    <button
                      type="button"
                      className="settings-action-btn"
                      disabled={busy}
                      onClick={() => void loadRepositories(page + 1, true)}
                    >
                      {busy ? <Codicon name="loading codicon-modifier-spin" /> : null}
                      <span>{t('Load more')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 3. 发布仓库模式 Publish */}
            {mode === 'publish' && (
              <div className="provider-form-card">
                <div className="provider-form-header">
                  <Codicon name="cloud-upload" />
                  <span>{t('Publish Repository')}</span>
                </div>

                <div className="provider-form-field">
                  <label htmlFor="pub-namespace-select">{t('Namespace')}</label>
                  <select
                    id="pub-namespace-select"
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                  >
                    {namespaces.map((item) => (
                      <option key={item.id} value={selectedProvider === 'gitlab' ? item.id : item.fullPath}>
                        {item.fullPath}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="provider-form-field">
                  <label htmlFor="pub-name-input">{t('Repository name')}</label>
                  <input
                    id="pub-name-input"
                    value={publishName}
                    placeholder="my-repo"
                    onChange={(e) => setPublishName(e.target.value)}
                  />
                </div>

                <div className="provider-form-field">
                  <label htmlFor="pub-desc-textarea">{t('Description')}</label>
                  <textarea
                    id="pub-desc-textarea"
                    value={publishDescription}
                    placeholder={t('Description')}
                    onChange={(e) => setPublishDescription(e.target.value)}
                  />
                </div>

                <div className="provider-form-field">
                  <label htmlFor="pub-visibility-select">{t('Visibility')}</label>
                  <select
                    id="pub-visibility-select"
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value as RemoteVisibility)}
                  >
                    <option value="private">{t('Private')}</option>
                    {selectedProvider === 'gitlab' && <option value="internal">{t('Internal')}</option>}
                    <option value="public">{t('Public')}</option>
                  </select>
                </div>

                <label className="dialog-check" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11.5px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={pushAfterCreate}
                    onChange={(e) => setPushAfterCreate(e.target.checked)}
                  />
                  <span>{t('Push after creating')}</span>
                </label>

                <div className="provider-form-actions">
                  <button
                    type="button"
                    className="settings-action-btn primary"
                    disabled={busy || !publishName.trim()}
                    onClick={() => void handlePublish()}
                  >
                    {busy ? <Codicon name="loading codicon-modifier-spin" /> : <Codicon name="cloud-upload" />}
                    <span>{t('Publish')}</span>
                  </button>

                  <button type="button" className="settings-action-btn" onClick={close}>
                    {t('Cancel')}
                  </button>
                </div>

                {publishResult && (
                  <div
                    className={publishResult.error ? 'dialog-error' : 'notice'}
                    style={{ marginTop: 8, padding: 8, borderRadius: 4 }}
                  >
                    <div>{publishResult.error?.message ?? t('Repository published successfully')}</div>
                    {publishResult.recoveryHint && <small style={{ display: 'block', marginTop: 4 }}>{publishResult.recoveryHint}</small>}
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
    </DialogSurface>
  );
}
