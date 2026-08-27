import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useBridge } from '../../platform/context';
import { useI18n } from '../../i18n';
import type { GitIdentityState, RepositoryStatus, SvnAccountState } from '../../bindings/generated';

interface ProfileMenuPopoverProps {
  anchorRect: DOMRect | null;
  onClose: () => void;
}

export function ProfileMenuPopover({ anchorRect, onClose }: ProfileMenuPopoverProps) {
  const bridge = useBridge();
  const { t } = useI18n();
  const snapshot = useAppStore((state) => state.snapshot);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const openIdentityPanel = useAppStore((state) => state.openIdentityPanel);
  const refresh = useAppStore((state) => state.refresh);

  const repositories = useMemo(() => snapshot?.repositories ?? [], [snapshot?.repositories]);
  const gitRepos = useMemo(() => repositories.filter((r) => r.meta.kind === 'git'), [repositories]);
  const svnRepos = useMemo(() => repositories.filter((r) => r.meta.kind === 'svn'), [repositories]);
  const workspaceId = snapshot?.workspace.id;

  const [activeSubmenuRepoId, setActiveSubmenuRepoId] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number; centerY: number; maxHeight: number } | null>(null);
  const [identitiesByRepo, setIdentitiesByRepo] = useState<Record<string, GitIdentityState>>({});
  const [svnAccountsByRepo, setSvnAccountsByRepo] = useState<Record<string, SvnAccountState>>({});
  const popoverRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  // 批量异步加载所有仓库的生效身份，用于多仓库展示
  useEffect(() => {
    let active = true;
    if (!workspaceId || repositories.length === 0) return;

    const loadAllIdentities = async () => {
      const gitRepos = repositories.filter((r) => r.meta.kind === 'git');
      const svnRepos = repositories.filter((r) => r.meta.kind === 'svn');

      const gitPromises = gitRepos.map(async (repo) => {
        try {
          const data = await bridge.request<GitIdentityState>({
            type: 'gitIdentity',
            payload: { workspace_id: workspaceId, repo_id: repo.meta.id },
          });
          return { repoId: repo.meta.id, data };
        } catch {
          return null;
        }
      });

      const svnPromises = svnRepos.map(async (repo) => {
        try {
          const data = await bridge.request<SvnAccountState>({
            type: 'svnAccount',
            payload: { workspace_id: workspaceId, repo_id: repo.meta.id },
          });
          return { repoId: repo.meta.id, data };
        } catch {
          return null;
        }
      });

      const [gitResults, svnResults] = await Promise.all([
        Promise.all(gitPromises),
        Promise.all(svnPromises),
      ]);

      if (!active) return;

      const nextGit: Record<string, GitIdentityState> = {};
      gitResults.forEach((res) => {
        if (res?.data) nextGit[res.repoId] = res.data;
      });
      setIdentitiesByRepo(nextGit);

      const nextSvn: Record<string, SvnAccountState> = {};
      svnResults.forEach((res) => {
        if (res?.data) nextSvn[res.repoId] = res.data;
      });
      setSvnAccountsByRepo(nextSvn);
    };

    void loadAllIdentities();

    return () => {
      active = false;
    };
  }, [bridge, workspaceId, repositories]);

  // 监听子菜单真实高度，使展开位置的正中完美对齐点击项中心，并做视口边界保护
  useLayoutEffect(() => {
    if (submenuRef.current && submenuPos) {
      const h = submenuRef.current.offsetHeight;
      const minTop = 10;
      const maxBottom = window.innerHeight - 30; // 底部状态栏 28px + 2px 安全距离
      let nextTop = submenuPos.centerY - h / 2;
      if (nextTop + h > maxBottom) {
        nextTop = maxBottom - h;
      }
      if (nextTop < minTop) {
        nextTop = minTop;
      }
      if (Math.abs(submenuPos.top - nextTop) > 1) {
        setSubmenuPos((prev) => (prev ? { ...prev, top: nextTop } : null));
      }
    }
  }, [submenuPos, activeSubmenuRepoId]);

  // 监听点击外部和 Escape 关闭
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        submenuRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (activeSubmenuRepoId) {
          setActiveSubmenuRepoId(null);
          setSubmenuPos(null);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, activeSubmenuRepoId]);

  // 切换 profile
  const handleSelectProfile = async (repoId: string, profileId: string | null) => {
    if (!workspaceId) return;
    try {
      const nextState = await bridge.request<GitIdentityState>({
        type: 'gitProfileOperation',
        payload: {
          workspace_id: workspaceId,
          repo_id: repoId,
          operation: { type: 'select', profile_id: profileId },
        },
      });
      setIdentitiesByRepo((prev) => ({ ...prev, [repoId]: nextState }));
      await refresh(true);
    } catch {
      // ignore
    }
  };

  // 展开级联子菜单（中心垂直对齐点击项，底边绝不超出状态栏）
  const handleOpenSubmenu = (repo: RepositoryStatus, event: React.MouseEvent<HTMLElement>) => {
    setActiveSubmenuRepoId(repo.meta.id);
    const itemRect = event.currentTarget.getBoundingClientRect();
    const popoverRect = popoverRef.current?.getBoundingClientRect();
    const left = popoverRect ? popoverRect.right + 4 : itemRect.right + 4;
    const centerY = itemRect.top + itemRect.height / 2;
    const minTop = 10;
    const maxBottom = window.innerHeight - 30;
    const estimatedHeight = 240;
    let initialTop = centerY - estimatedHeight / 2;
    if (initialTop + estimatedHeight > maxBottom) {
      initialTop = maxBottom - estimatedHeight;
    }
    if (initialTop < minTop) {
      initialTop = minTop;
    }
    const maxHeight = Math.min(440, maxBottom - minTop);
    setSubmenuPos({ left, top: initialTop, centerY, maxHeight });
  };

  const isMultiRepo = repositories.length > 1;
  const singleRepo = !isMultiRepo ? repositories[0] : null;
  const targetRepo = isMultiRepo
    ? repositories.find((r) => r.meta.id === activeSubmenuRepoId)
    : singleRepo;

  const targetGitIdentity = targetRepo ? identitiesByRepo[targetRepo.meta.id] : null;
  const targetSvnAccount = targetRepo ? svnAccountsByRepo[targetRepo.meta.id] : null;

  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 28,
    left: anchorRect ? Math.max(8, anchorRect.left) : 120,
    maxHeight: 440,
    zIndex: 1000,
  };

  // 渲染单个 Git 仓库的 Profile 列表项（无论在单仓库视图还是在级联子菜单）
  const renderGitRepoProfiles = (repo: RepositoryStatus, identityState: GitIdentityState | null) => {
    if (!identityState) {
      return (
        <div className="statusbar-popover-loading">
          <Codicon name="loading codicon-modifier-spin" />
          <span>{t('Loading files...')}</span>
        </div>
      );
    }

    const namedProfiles = identityState.profiles ?? [];
    const activeProfileId = identityState.selectedProfileId;
    const isAuto = !activeProfileId;
    const isLocalEffective = identityState.effective.source === 'local';
    const isGlobalEffective = identityState.effective.source === 'global';

    return (
      <>
        {/* 命名 Profiles */}
        {namedProfiles.length > 0 && (
          <div className="statusbar-menu-section">
            <div className="statusbar-menu-group-header">{t('PROFILES')}</div>
            {namedProfiles.map((profile) => {
              const isActive = activeProfileId === profile.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={`statusbar-menu-item ${isActive ? 'active-ref' : ''}`}
                  onClick={() => handleSelectProfile(repo.meta.id, profile.id)}
                >
                  <Codicon name={isActive ? 'check' : 'account'} />
                  <div className="statusbar-menu-item-text">
                    <span className="statusbar-menu-item-title">
                      {profile.label}
                      {isActive && <span className="statusbar-badge">{t('active')}</span>}
                    </span>
                    <span className="statusbar-menu-item-desc">
                      {profile.userName} &lt;{profile.email}&gt;
                    </span>
                  </div>
                </button>
              );
            })}
            <div className="statusbar-menu-divider" />
          </div>
        )}

        {/* Local 身份 */}
        <div className="statusbar-menu-section">
          <button
            type="button"
            className={`statusbar-menu-item ${isAuto && isLocalEffective ? 'active-ref' : ''}`}
            onClick={() => handleSelectProfile(repo.meta.id, null)}
          >
            <Codicon name={isAuto && isLocalEffective ? 'check' : 'home'} />
            <div className="statusbar-menu-item-text">
              <span className="statusbar-menu-item-title">
                {t('Local')}
                {isAuto && isLocalEffective && <span className="statusbar-badge">{t('active')}</span>}
              </span>
              <span className="statusbar-menu-item-desc">
                {identityState.local
                  ? `${identityState.local.userName} <${identityState.local.email}> · ${t('from .git/config')}`
                  : t('No local git identity in this repo')}
              </span>
            </div>
          </button>

          {/* Global 身份 */}
          <button
            type="button"
            className={`statusbar-menu-item ${isAuto && isGlobalEffective ? 'active-ref' : ''}`}
            onClick={() => handleSelectProfile(repo.meta.id, null)}
          >
            <Codicon name={isAuto && isGlobalEffective ? 'check' : 'globe'} />
            <div className="statusbar-menu-item-text">
              <span className="statusbar-menu-item-title">
                {t('Global')}
                {isAuto && isGlobalEffective && <span className="statusbar-badge">{t('active')}</span>}
              </span>
              <span className="statusbar-menu-item-desc">
                {identityState.global
                  ? `${identityState.global.userName} <${identityState.global.email}> · ${t('from ~/.gitconfig')}`
                  : t('No global git identity configured')}
              </span>
            </div>
          </button>
        </div>

        <div className="statusbar-menu-divider" />

        {/* 底部操作 */}
        <div className="statusbar-menu-section footer-section">
          <button
            type="button"
            className="statusbar-menu-item"
            onClick={() => {
              onClose();
              openIdentityPanel(repo.meta.id);
            }}
          >
            <Codicon name="add" />
            <div className="statusbar-menu-item-text">
              <span className="statusbar-menu-item-title">{t('New Profile…')}</span>
            </div>
          </button>
          <button
            type="button"
            className="statusbar-menu-item"
            onClick={() => {
              onClose();
              openIdentityPanel(repo.meta.id);
            }}
          >
            <Codicon name="settings-gear" />
            <div className="statusbar-menu-item-text">
              <span className="statusbar-menu-item-title">{t('Manage Git identities…')}</span>
            </div>
          </button>
        </div>
      </>
    );
  };

  // 渲染单个 SVN 仓库的账号项
  const renderSvnRepoAccount = (repo: RepositoryStatus, accountState: SvnAccountState | null) => (
    <>
      <div className="statusbar-menu-section">
        <div className="statusbar-menu-group-header">{t('SVN Accounts')}</div>
        <div className="statusbar-menu-item active-ref">
          <Codicon name="account" />
          <div className="statusbar-menu-item-text">
            <span className="statusbar-menu-item-title">
              {accountState?.username || t('No account detected')}
              {accountState?.passwordStored && <span className="statusbar-badge">{t('Authenticated')}</span>}
            </span>
            <span className="statusbar-menu-item-desc">
              {accountState?.repositoryRoot ?? repo.meta.rootPath}
            </span>
          </div>
        </div>
      </div>

      <div className="statusbar-menu-divider" />

      <div className="statusbar-menu-section footer-section">
        <button
          type="button"
          className="statusbar-menu-item"
          onClick={() => {
            onClose();
            openIdentityPanel(repo.meta.id);
          }}
        >
          <Codicon name="settings-gear" />
          <div className="statusbar-menu-item-text">
            <span className="statusbar-menu-item-title">{t('Manage SVN accounts…')}</span>
          </div>
        </button>
      </div>
    </>
  );

  return (
    <>
      <div ref={popoverRef} className="statusbar-popover profile-menu-popover" style={popoverStyle}>
        <div className="statusbar-popover-content">
          {/* 多仓库视图：按 Git identities 和 SVN Accounts 列出仓库列表并级联展开 */}
          {isMultiRepo ? (
            <>
              {gitRepos.length > 0 && (
                <div className="statusbar-menu-section">
                  <div className="statusbar-menu-group-header">{t('Git identities')}</div>
                  {gitRepos.map((repo) => {
                    const identity = identitiesByRepo[repo.meta.id];
                    const isSelected = repo.meta.id === (selectedRepoId ?? repositories[0]?.meta.id);
                    const isSubmenuOpen = repo.meta.id === activeSubmenuRepoId;
                    const desc = identity
                      ? `${identity.effective.userName || t('No profile')} <${identity.effective.email || ''}>`
                      : t('Loading files...');

                    return (
                      <button
                        key={repo.meta.id}
                        type="button"
                        className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''} ${isSubmenuOpen ? 'submenu-open' : ''}`}
                        onClick={(e) => handleOpenSubmenu(repo, e)}
                      >
                        <Codicon name="root-folder" />
                        <div className="statusbar-menu-item-text">
                          <span className="statusbar-menu-item-title">{repo.meta.name}</span>
                          <span className="statusbar-menu-item-desc">{desc}</span>
                        </div>
                        <Codicon name="chevron-right" className="submenu-arrow" />
                      </button>
                    );
                  })}
                </div>
              )}

              {svnRepos.length > 0 && (
                <div className="statusbar-menu-section">
                  <div className="statusbar-menu-group-header">{t('SVN Accounts')}</div>
                  {svnRepos.map((repo) => {
                    const svn = svnAccountsByRepo[repo.meta.id];
                    const isSelected = repo.meta.id === (selectedRepoId ?? repositories[0]?.meta.id);
                    const isSubmenuOpen = repo.meta.id === activeSubmenuRepoId;
                    const desc = svn?.username || (svn?.passwordStored ? t('Authenticated') : t('No account detected'));

                    return (
                      <button
                        key={repo.meta.id}
                        type="button"
                        className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''} ${isSubmenuOpen ? 'submenu-open' : ''}`}
                        onClick={(e) => handleOpenSubmenu(repo, e)}
                      >
                        <Codicon name="repo" />
                        <div className="statusbar-menu-item-text">
                          <span className="statusbar-menu-item-title">{repo.meta.name}</span>
                          <span className="statusbar-menu-item-desc">{desc}</span>
                        </div>
                        <Codicon name="chevron-right" className="submenu-arrow" />
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="statusbar-menu-divider" />

              <div className="statusbar-menu-section footer-section">
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={() => {
                    onClose();
                    openIdentityPanel(selectedRepoId ?? repositories[0]?.meta.id);
                  }}
                >
                  <Codicon name="settings-gear" />
                  <div className="statusbar-menu-item-text">
                    <span className="statusbar-menu-item-title">{t('Manage Git identities…')}</span>
                  </div>
                </button>
              </div>
            </>
          ) : singleRepo ? (
            /* 单仓库视图：直接展示该仓库的 Profile 列表与配置 */
            singleRepo.meta.kind === 'git'
              ? renderGitRepoProfiles(singleRepo, targetGitIdentity)
              : renderSvnRepoAccount(singleRepo, targetSvnAccount)
          ) : (
            <div className="statusbar-popover-empty">{t('No profile')}</div>
          )}
        </div>
      </div>

      {/* 级联二级子菜单 Submenu */}
      {isMultiRepo && targetRepo && submenuPos && (
        <div
          ref={submenuRef}
          className="statusbar-submenu"
          style={{
            position: 'fixed',
            top: submenuPos.top,
            left: submenuPos.left,
            maxHeight: submenuPos.maxHeight,
            zIndex: 1001,
          }}
        >
          <div className="statusbar-popover-content">
            {targetRepo.meta.kind === 'git'
              ? renderGitRepoProfiles(targetRepo, targetGitIdentity)
              : renderSvnRepoAccount(targetRepo, targetSvnAccount)}
          </div>
        </div>
      )}
    </>
  );
}
