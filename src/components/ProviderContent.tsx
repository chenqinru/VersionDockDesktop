import { RepositoryTaskProgress } from './RepositoryTaskProgress';
import { IconButton } from './IconButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearAuthorAvatarCache } from '../avatars/authorAvatarResolver';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  GithubDeviceFlow,
  PublishRepositoryResult,
  RepositoryStatus,
  RemoteInfo,
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
import { useAppStore } from '../store/appStore';
import { isAbortError } from '../platform/bridge';
import { ProviderAccountAvatar } from './ProviderAccountAvatar';

export interface ProviderPanelProps {
  mode: 'manage' | 'browse' | 'publish';
  initialProvider?: RemoteProviderKind;
  repoId?: string;
  workspaceId?: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  selectedRepositoryUrl?: string;
  onAccountFormChange?: (open: boolean) => void;
  onAccountChange?: () => void;
  onAccountConnected?: (accountId: string) => void;
  close: () => void;
  onClone?: (repository: RemoteRepository, accountId: string) => void;
}

type ActiveView = 'none' | 'detail' | 'github_flow' | 'github_form' | 'gitlab_form' | 'gitee_form';

const providerErrorKeys: Record<string, string> = {
  AVATAR_CACHE_CLEAR_FAILED: 'Unable to clear avatar cache',
  PROVIDER_KEY_ACCESS_FAILED: 'Unable to read the account token from secure storage. Retry access in account management.',
  PROVIDER_AUTH_REQUIRED: 'Account authentication failed. Please reauthenticate.',
  PROVIDER_FORBIDDEN: 'This token does not have the required permissions.',
  PROVIDER_RATE_LIMITED: 'The platform rate limit was reached. Please try again later.',
  PROVIDER_NETWORK_ERROR: 'Unable to connect to the platform. Check your network and proxy settings.',
  PROVIDER_TIMEOUT: 'The platform request timed out. Please try again.',
  PROVIDER_TOKEN_REQUIRED: 'Enter a personal access token.',
  INVALID_PROVIDER_HOST: 'Enter a valid platform URL.',
  PUBLISH_IN_PROGRESS: 'This repository is already being published. Wait for the current operation to finish.',
  INVALID_REPOSITORY_NAME: 'Repository name is invalid',
  REMOTE_ALREADY_EXISTS: 'Repository already has a remote',
  HEAD_MISSING: 'Create the initial commit before publishing',
  DETACHED_HEAD: 'Check out a local branch before publishing',
  REMOTE_APPEARED: 'A remote appeared while publishing',
  PUBLISH_STATE_CHANGED: 'The current branch changed while publishing',
  INSECURE_PROVIDER_HOST: 'Use an HTTPS platform URL.',
};
function formatProviderError(error: unknown, t: (key: string) => string): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const key = providerErrorKeys[code];
  return key ? t(key) : error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

export function ProviderContent({ mode, repoId, workspaceId: requestedWorkspaceId, close, onClone, initialProvider, disabled = false, selectedRepositoryUrl, onAccountChange, onAccountConnected, onBusyChange, onAccountFormChange }: ProviderPanelProps) {
  const bridge = useBridge();
  const { t } = useI18n();
  const [target] = useState(() => {
    const snapshot = useAppStore.getState().snapshot;
    return { workspaceId: requestedWorkspaceId ?? snapshot?.workspace.id ?? '', repository: snapshot?.repositories.find((repo) => repo.meta.id === repoId) };
  });
  const workspaceId = target.workspaceId;
  const [publishRepo, setPublishRepo] = useState(target.repository);
  const [publishPreflightError, setPublishPreflightError] = useState('');
  const [preflightReady, setPreflightReady] = useState(false);
  const providerAvailability = useAppStore((state) => state.bootstrap?.capabilities?.availability);
  const authController = useRef<AbortController | null>(null);
  const retryController = useRef<AbortController | null>(null);

  const isGithubDeviceFlowAvailable = providerAvailability?.githubDeviceFlow?.available === true;
  const isGithubAvailable = providerAvailability?.githubProvider?.available !== false;

  const accountsController = useRef<AbortController | null>(null);
  const repositoriesController = useRef<AbortController | null>(null);
  const repositoriesGeneration = useRef(0);
  const mounted = useRef(true);
  const publishing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      authController.current?.abort();
      accountsController.current?.abort();
      repositoriesController.current?.abort();
    };
  }, []);

  const [accounts, setAccounts] = useState<RemoteProviderAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  useEffect(() => () => retryController.current?.abort(), [selectedAccountId]);
  const [activeView, setActiveView] = useState<ActiveView>('none');
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy && publishing.current); }, [busy, mode, onBusyChange]);
  const [retryingAccountId, setRetryingAccountId] = useState<string | null>(null);
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
  const [publishName, setPublishName] = useState(target.repository?.meta.name ?? '');
  const [publishDescription, setPublishDescription] = useState('');
  const [visibility, setVisibility] = useState<RemoteVisibility>('private');
  const [pushAfterCreate, setPushAfterCreate] = useState(true);
  const [publishOperationId, setPublishOperationId] = useState<string>();
  const [publishUncertain, setPublishUncertain] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishRepositoryResult>();

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedProvider = selectedAccount?.provider;

  useEffect(() => {
    if (selectedProvider !== 'gitlab' && visibility === 'internal') {
      queueMicrotask(() => setVisibility('private'));
    }
  }, [selectedProvider, visibility]);

  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [namespacesLoading, setNamespacesLoading] = useState(false);
  const [repositoryContext, setRepositoryContext] = useState('');
  const [namespaceAccountId, setNamespaceAccountId] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const compactAccountActions = mode === 'browse' && accounts.length > 0;
  const accountFormOpen = activeView.endsWith('_form') || activeView === 'github_flow';
  useEffect(() => { onAccountFormChange?.(accountFormOpen); }, [accountFormOpen, onAccountFormChange]);
  useEffect(() => { onAccountChange?.(); }, [selectedAccountId, accountFormOpen, onAccountChange]);

  const clearAvatarCache = async () => {
    setBusy(true); setError('');
    try {
      await clearAuthorAvatarCache(bridge);
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 2000);
    } catch (reason) { setError(formatProviderError(reason, t)); }
    finally { setBusy(false); }
  };

  const loadAccounts = useCallback(async () => {
    accountsController.current?.abort();
    const controller = new AbortController();
    accountsController.current = controller;
    try {
      const values = await bridge.request<RemoteProviderAccount[]>({ type: 'providerAccounts' }, { showProgress: false, signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
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
      if (!controller.signal.aborted && mounted.current && !isAbortError(err)) setError(formatProviderError(err, t));
    }
  }, [bridge, initialProvider, t]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void loadAccounts();
    });
    return () => {
      active = false;
    };
  }, [loadAccounts]);

  // Account, query and generation all belong to one cancellable repository request.
  const loadRepositories = useCallback(async (nextPage = 1, append = false, search = submittedQuery) => {
    repositoriesController.current?.abort();
    const controller = new AbortController();
    repositoriesController.current = controller;
    const generation = ++repositoriesGeneration.current;
    if (!selectedAccountId) return;
    setRepositoriesLoading(true);
    setError('');
    try {
      const value = await bridge.request<RemoteRepositoryPage>({
        type: 'providerRepositories',
        payload: { account_id: selectedAccountId, query: search || null, page: nextPage, per_page: 50 },
      }, { signal: controller.signal, showProgress: false });
      if (controller.signal.aborted || generation !== repositoriesGeneration.current || !mounted.current) return;
      setRepositoryContext(`${selectedAccountId}:${search}`);
      setRepositories(current => {
        const items = append ? [...current, ...value.items] : value.items;
        return [...new Map(items.map(item => [`${item.host}:${item.id}`, item])).values()];
      });
      setPage(value.page);
      setHasMore(value.hasMore);
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current && !isAbortError(reason)) setError(formatProviderError(reason, t));
    } finally {
      if (!controller.signal.aborted && mounted.current) setRepositoriesLoading(false);
    }
  }, [bridge, selectedAccountId, submittedQuery, t]);

  useEffect(() => {
    if (mode !== 'browse' || accountFormOpen) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setRepositories([]);
      setHasMore(false);
      if (selectedAccountId) void loadRepositories();
    });
    return () => { active = false; repositoriesController.current?.abort(); };
  }, [mode, selectedAccountId, loadRepositories, accountFormOpen]);

  const searchRepositories = () => {
    if (query.trim() === submittedQuery) void loadRepositories();
    else setSubmittedQuery(query.trim());
  };

  useEffect(() => {
    if (mode !== 'publish' || !selectedAccountId || accountFormOpen) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return [];
      setNamespaces([]);
      setNamespace('');
      setNamespacesLoading(true);
      return bridge.request<RemoteNamespace[]>({ type: 'providerNamespaces', payload: { account_id: selectedAccountId } }, { signal: controller.signal, showProgress: false });
    }).then(values => {
        if (controller.signal.aborted) return;
        setNamespaceAccountId(selectedAccountId);
        setNamespaces(values);
        setNamespace(selectedProvider === 'gitlab' ? values[0]?.id ?? '' : values[0]?.fullPath ?? '');
      })
      .catch(reason => { if (!controller.signal.aborted && !isAbortError(reason)) setError(formatProviderError(reason, t)); })
      .finally(() => { if (!controller.signal.aborted) setNamespacesLoading(false); });
    return () => controller.abort();
  }, [bridge, mode, selectedAccountId, selectedProvider, accountFormOpen, t]);

  useEffect(() => {
    if (mode !== 'publish' || !workspaceId || !repoId) return;
    const controller = new AbortController();
    void Promise.all([
      bridge.request<RepositoryStatus>({ type: 'repositoryStatus', payload: { workspace_id: workspaceId, repo_id: repoId } }, { signal: controller.signal, showProgress: false }),
      bridge.request<RemoteInfo[]>({ type: 'remotes', payload: { workspace_id: workspaceId, repo_id: repoId } }, { signal: controller.signal, showProgress: false }),
    ]).then(([repo, remotes]) => {
      if (controller.signal.aborted) return;
      setPublishRepo(repo);
      setPublishName(current => current || repo.meta.name);
      setPublishPreflightError(remotes.length ? t('Repository already has a remote') : !repo.revision ? t('Create the initial commit before publishing') : !repo.branch || repo.branch.startsWith('HEAD') ? t('Check out a local branch before publishing') : '');
      setPreflightReady(true);
    }).catch(reason => { if (!controller.signal.aborted) setPublishPreflightError(formatProviderError(reason, t)); });
    return () => controller.abort();
  }, [bridge, mode, workspaceId, repoId, t]);

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
      if (controller.signal.aborted) return;
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
      if (controller.signal.aborted || !mounted.current) return;
      void clearAuthorAvatarCache(bridge).catch(() => undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      if (!mounted.current || controller.signal.aborted) return;
      setSelectedAccountId(account.id);
      setActiveView('detail');
      onAccountConnected?.(account.id);
      setFlow(undefined);
    } catch (reason) {
      if (!controller.signal.aborted && !isAbortError(reason)) {
        setError(formatProviderError(reason, t));
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
    authController.current?.abort();
    const controller = new AbortController();
    authController.current = controller;
    setBusy(true);
    setError('');
    try {
      const account = await bridge.request<RemoteProviderAccount>({
        type: 'providerGithubSave',
        payload: { account_id: editingAccountId ?? null, token: ghPat.trim() },
      }, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      void clearAuthorAvatarCache(bridge).catch(() => undefined);
      setGhPat('');
      setEditingAccountId(undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      if (!mounted.current || controller.signal.aborted) return;
      setSelectedAccountId(account.id);
      setActiveView('detail');
      onAccountConnected?.(account.id);
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current && !isAbortError(reason)) setError(formatProviderError(reason, t));
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
    }
  };

  // 2. GitLab 账号保存
  const saveGitlab = async () => {
    if (!glPat.trim()) return;
    authController.current?.abort();
    const controller = new AbortController();
    authController.current = controller;
    setBusy(true);
    setError('');
    try {
      const account = await bridge.request<RemoteProviderAccount>({
        type: 'providerGitlabSave',
        payload: { account_id: editingAccountId ?? null, host: glHost.trim(), token: glPat.trim() },
      }, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      void clearAuthorAvatarCache(bridge).catch(() => undefined);
      setGlPat('');
      setEditingAccountId(undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      if (!mounted.current || controller.signal.aborted) return;
      setSelectedAccountId(account.id);
      setActiveView('detail');
      onAccountConnected?.(account.id);
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current && !isAbortError(reason)) setError(formatProviderError(reason, t));
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
    }
  };

  // 3. Gitee 账号保存
  const saveGitee = async () => {
    if (!gtPat.trim()) return;
    authController.current?.abort();
    const controller = new AbortController();
    authController.current = controller;
    setBusy(true);
    setError('');
    try {
      const account = await bridge.request<RemoteProviderAccount>({
        type: 'providerGiteeSave',
        payload: { account_id: editingAccountId ?? null, token: gtPat.trim() },
      }, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      void clearAuthorAvatarCache(bridge).catch(() => undefined);
      setGtPat('');
      setEditingAccountId(undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
      if (!mounted.current || controller.signal.aborted) return;
      setSelectedAccountId(account.id);
      setActiveView('detail');
      onAccountConnected?.(account.id);
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current && !isAbortError(reason)) setError(formatProviderError(reason, t));
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
    }
  };

  const retryAccess = async (id: string) => {
    retryController.current?.abort();
    const controller = new AbortController();
    retryController.current = controller;
    setRetryingAccountId(id);
    setError('');
    try {
      await bridge.request({ type: 'providerRetryAccess', payload: { account_id: id } }, { signal: controller.signal, showProgress: false });
      if (controller.signal.aborted) return;
      if (controller.signal.aborted || !mounted.current) return;
      void clearAuthorAvatarCache(bridge).catch(() => undefined);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
    } catch (reason) {
      if (!controller.signal.aborted && !isAbortError(reason)) setError(formatProviderError(reason, t));
    } finally {
      if (retryController.current === controller) {
        retryController.current = null;
        setRetryingAccountId(null);
      }
    }
  };

  // 4. 账号删除
  const removeAccount = async (id: string) => {
    try {
      await bridge.request({ type: 'providerRemove', payload: { account_id: id } });
      if (!mounted.current) return;
      void clearAuthorAvatarCache(bridge).catch(() => undefined);
      setConfirmRemoveId(null);
      window.dispatchEvent(new Event('versiondock-provider-accounts-changed'));
      await loadAccounts();
    } catch (reason) {
      if (!isAbortError(reason)) setError(formatProviderError(reason, t));
    }
  };

  // 5. 发布仓库
  const handlePublish = async () => {
    if (publishing.current || publishUncertain || publishResult?.remoteCreated || !preflightReady || publishPreflightError || !workspaceId || !repoId || !selectedAccountId || namespacesLoading || namespaceAccountId !== selectedAccountId || !namespace || !/^[A-Za-z0-9._-]+$/.test(publishName.trim())) return;
    publishing.current = true;
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
        { timeoutMs: 600_000, onOperationId: setPublishOperationId }
      );
      if (mounted.current) setPublishResult(value);
      // The backend refresh event carries the captured workspace/repository target.
    } catch (reason) {
      if (mounted.current) {
        const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
        const uncertain = isAbortError(reason) || /TIMEOUT|CANCELLED|PROVIDER_NETWORK_ERROR|PROVIDER_RESPONSE_INVALID/.test(code);
        setPublishUncertain(uncertain);
        setError(uncertain ? t('Publish outcome is unknown. Check the remote platform before trying again.') : formatProviderError(reason, t));
      }
    } finally {
      publishing.current = false;
      if (mounted.current) setBusy(false);
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
        <fieldset className="provider-body provider-content-fieldset" disabled={disabled}>

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
                    title={`${account.displayName ? `${account.displayName} (${account.login})` : account.login} · ${account.host}`}
                    disabled={busy || publishUncertain || Boolean(publishResult?.remoteCreated)}
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
                          {{ github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee' }[account.provider]} • {account.host.replace(/^https?:\/\//, '')}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}

              {accounts.length === 0 && mode === 'manage' && (
                <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--versiondock-muted)', fontSize: '11px' }}>
                  {t('No connected accounts')}
                </div>
              )}
            </div>

            {/* 添加平台入口按钮组 */}
            <div className={`provider-add-section ${compactAccountActions ? 'compact' : ''}`}>
              <button
                type="button"
                className="provider-add-btn"
                aria-label={t('Add GitHub Account')}
                title={!isGithubAvailable ? (providerAvailability?.githubProvider?.detail ?? t('Secure storage is unavailable')) : t('Add GitHub Account')}
                disabled={busy || Boolean(publishResult?.remoteCreated) || !isGithubAvailable}
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
                <span>{compactAccountActions ? 'GitHub' : t('Add GitHub Account')}</span>
              </button>

              <button
                type="button"
                className="provider-add-btn"
                aria-label={t('Add GitLab Account')}
                title={providerAvailability?.gitlabProvider?.detail ?? t('Add GitLab Account')}
                disabled={busy || Boolean(publishResult?.remoteCreated) || providerAvailability?.gitlabProvider?.available === false}
                onClick={() => {
                  setEditingAccountId(undefined);
                  setGlHost('https://gitlab.com');
                  setGlPat('');
                  setActiveView('gitlab_form');
                  setError('');
                }}
              >
                <Codicon name="key" />
                <span>{compactAccountActions ? 'GitLab' : t('Add GitLab Account')}</span>
              </button>

              <button
                type="button"
                className="provider-add-btn"
                aria-label={t('Add Gitee Account')}
                title={providerAvailability?.giteeProvider?.detail ?? t('Add Gitee Account')}
                disabled={busy || Boolean(publishResult?.remoteCreated) || providerAvailability?.giteeProvider?.available === false}
                onClick={() => {
                  setEditingAccountId(undefined);
                  setGtPat('');
                  setActiveView('gitee_form');
                  setError('');
                }}
              >
                <Codicon name="cloud" />
                <span>{compactAccountActions ? 'Gitee' : t('Add Gitee Account')}</span>
              </button>
            </div>

            {/* 侧边栏底部操作 */}
            <div className="provider-sidebar-footer">
              <button
                type="button"
                className="provider-cache-btn"
                disabled={busy}
                onClick={clearAvatarCache}
                title={t('Purge cached avatars and force reload')}
              >
                <Codicon name={cacheCleared ? 'check' : 'trash'} />
                <span>{cacheCleared ? t('Avatar cache cleared') : t('Clear Avatar Cache')}</span>
              </button>
            </div>
          </aside>

          {/* 右侧主视窗 */}
          <div className="provider-content">
            {error && <p className="dialog-error" style={{ marginBottom: 12 }}>{error}</p>}

            {/* 1. 账号管理模式 Manage */}
            {(mode === 'manage' || accountFormOpen || !selectedAccount) && (
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
                      <ProviderAccountAvatar account={selectedAccount} />
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
                          className="settings-action-btn"
                          disabled={busy || retryingAccountId !== null}
                          onClick={() => void retryAccess(selectedAccount.id)}
                        >
                          <Codicon name="key" />
                          <span>{t('Retry secure storage access')}</span>
                        </button>
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
                          title={t(showGhPassword ? 'Hide' : 'Show')}
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
                          authController.current?.abort();
                          setBusy(false);
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
                          title={t(showGlPassword ? 'Hide' : 'Show')}
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
                          authController.current?.abort();
                          setBusy(false);
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
                          authController.current?.abort();
                          setBusy(false);
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
            {mode === 'browse' && !accountFormOpen && selectedAccount && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div className="provider-browse-header">
                  <div className="provider-search-box">
                    <Codicon name="search" className="provider-search-icon" />
                    <input
                      value={query}
                      placeholder={t('Search repositories…')}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') searchRepositories();
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={searchRepositories}
                    disabled={repositoriesLoading}
                  >
                    <Codicon name={repositoriesLoading ? 'loading codicon-modifier-spin' : 'refresh'} />
                    <span>{t('Search')}</span>
                  </button>
                </div>

                <div className="provider-repo-list">
                  {(repositoryContext === `${selectedAccountId}:${submittedQuery}` ? repositories : []).map((repo) => (
                    <div
                      key={`${repo.host}:${repo.id}`}
                      className={`provider-repo-item ${selectedRepositoryUrl === repo.cloneUrl ? 'selected' : ''}`}
                      aria-pressed={selectedRepositoryUrl === repo.cloneUrl}
                      role="button"
                      tabIndex={0}
                      onClick={() => { if (!disabled) onClone?.(repo, selectedAccountId); }}
                      onKeyDown={(e) => {
                        if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClone?.(repo, selectedAccountId); }
                      }}
                    >
                      <div className="provider-repo-name-group">
                        <Codicon name={repo.private ? 'lock' : 'repo'} />
                        <span className="provider-repo-name">{repo.fullName}</span>
                      </div>
                      <span className="provider-repo-branch">{repo.defaultBranch ?? t('No default branch')}</span>
                    </div>
                  ))}

                  {repositories.length === 0 && !repositoriesLoading && (
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
                      disabled={repositoriesLoading}
                      onClick={() => void loadRepositories(page + 1, true)}
                    >
                      {repositoriesLoading ? <Codicon name="loading codicon-modifier-spin" /> : null}
                      <span>{t('Load more')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 3. 发布仓库模式 Publish */}
            {mode === 'publish' && !accountFormOpen && selectedAccount && (
              <div className="provider-form-card">
                <div className="provider-form-header">
                  <Codicon name="cloud-upload" />
                  <span>{t('Publish Repository')}</span>
                </div>

                <p className="publish-target">{publishRepo?.meta.name} · {publishRepo?.branch}<small>{publishRepo?.meta.rootPath}</small></p>
                {publishPreflightError && <p className="dialog-error">{publishPreflightError}</p>}
                <fieldset className="provider-publish-fields" disabled={busy || publishUncertain || Boolean(publishResult?.remoteCreated)}>
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
                    disabled={busy || !preflightReady || publishUncertain || Boolean(publishPreflightError) || !selectedAccountId || namespacesLoading || namespaceAccountId !== selectedAccountId || !namespace || !/^[A-Za-z0-9._-]+$/.test(publishName.trim()) || Boolean(publishResult?.remoteCreated)}
                    onClick={() => void handlePublish()}
                  >
                    {busy ? <Codicon name="loading codicon-modifier-spin" /> : <Codicon name="cloud-upload" />}
                    <span>{t('Publish')}</span>
                  </button>

                  <button type="button" className="settings-action-btn" disabled={busy} onClick={close}>
                    {t('Cancel')}
                  </button>
                </div>

                </fieldset>
                <RepositoryTaskProgress operationId={publishOperationId} />
                {publishResult && (
                  <div
                    className={publishResult.error ? 'dialog-error' : 'notice'}
                    style={{ marginTop: 8, padding: 8, borderRadius: 4 }}
                  >
                    <div>{publishResult.error ? formatProviderError(publishResult.error, t) : t(publishResult.pushed ? 'Repository published successfully' : 'Remote repository created')}</div>
                    <ul>
                      <li>{t('Remote repository created')}: {t(publishResult.remoteCreated ? 'Yes' : 'No')}</li>
                      <li>{t('Origin configured')}: {t(publishResult.remoteConfigured ? 'Yes' : 'No')}</li>
                      <li>{t('Current branch pushed')}: {t(publishResult.pushed ? 'Yes' : 'No')}</li>
                    </ul>
                    <div className="provider-form-actions">
                      {publishResult.repository.webUrl && <button type="button" onClick={() => void openUrl(publishResult.repository.webUrl!)}>{t('Open Remote Repository')}</button>}
                      <button type="button" onClick={() => void navigator.clipboard.writeText(publishResult.repository.cloneUrl).catch(() => setError(t('Unable to copy remote URL')))}>{t('Copy Remote URL')}</button>
                      <button type="button" onClick={() => void (async () => {
                        close();
                        const state = useAppStore.getState();
                        if (state.snapshot?.workspace.id !== workspaceId) await state.switchTab(workspaceId);
                        const current = useAppStore.getState();
                        if (current.snapshot?.workspace.id === workspaceId && repoId) current.openRemoteManager(repoId);
                      })()}>{t('Manage Remotes')}</button>
                    </div>
                    {publishResult.recoveryHint && <small style={{ display: 'block', marginTop: 4 }}>{publishResult.recoveryHint}</small>}
                  </div>
                )}
              </div>
            )}
          </div>
        </fieldset>
  );
}
