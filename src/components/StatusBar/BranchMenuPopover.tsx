import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { promptDialog, confirmDialog } from '../dialogService';
import type { RepositoryStatus } from '../../bindings/generated';

interface BranchMenuPopoverProps {
  anchorRect: DOMRect | null;
  onClose: () => void;
}

export function BranchMenuPopover({ anchorRect, onClose }: BranchMenuPopoverProps) {
  const { t } = useI18n();
  const snapshot = useAppStore((state) => state.snapshot);
  const sync = useAppStore((state) => state.sync);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const abortRepositoryOperation = useAppStore((state) => state.abortRepositoryOperation);
  const submoduleOperation = useAppStore((state) => state.submoduleOperation);
  const svnOperation = useAppStore((state) => state.svnOperation);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const backToHistory = useAppStore((state) => state.backToHistory);
  const openBranchComparison = useAppStore((state) => state.openBranchComparison);
  const openRemoteManager = useAppStore((state) => state.openRemoteManager);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const refresh = useAppStore((state) => state.refresh);

  // 二级菜单状态
  const [activeSubmenuRepoId, setActiveSubmenuRepoId] = useState<string | null>(null);
  const [activeCommonBranch, setActiveCommonBranch] = useState<{ name: string; isRemote: boolean } | null>(null);
  const [activeCommonTag, setActiveCommonTag] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number; centerY: number; maxHeight: number } | null>(null);

  // 三级动作菜单状态
  const [activeBranchAction, setActiveBranchAction] = useState<{
    repoId: string;
    branchName: string;
    isRemote: boolean;
    isCurrent: boolean;
  } | null>(null);
  const [activeTagAction, setActiveTagAction] = useState<{
    repoId: string;
    tagName: string;
    isCurrent: boolean;
  } | null>(null);
  const [actionMenuPos, setActionMenuPos] = useState<{ left: number; top: number; centerY: number; maxHeight: number } | null>(null);

  const popoverRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  // 监听二级子菜单真实高度，使其正中心精确对齐被点击的一级条目中心
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
  }, [submenuPos, activeSubmenuRepoId, activeCommonBranch, activeCommonTag]);

  // 监听三级动作子菜单真实高度，使其正中心精确对齐被点击的二级分支条目中心
  useLayoutEffect(() => {
    if (actionMenuRef.current && actionMenuPos) {
      const h = actionMenuRef.current.offsetHeight;
      const minTop = 10;
      const maxBottom = window.innerHeight - 30;
      let nextTop = actionMenuPos.centerY - h / 2;
      if (nextTop + h > maxBottom) {
        nextTop = maxBottom - h;
      }
      if (nextTop < minTop) {
        nextTop = minTop;
      }
      if (Math.abs(actionMenuPos.top - nextTop) > 1) {
        setActionMenuPos((prev) => (prev ? { ...prev, top: nextTop } : null));
      }
    }
  }, [actionMenuPos, activeBranchAction, activeTagAction]);

  // 监听点击外部和 Escape 关闭
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        submenuRef.current?.contains(target) ||
        actionMenuRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (activeBranchAction || activeTagAction) {
          setActiveBranchAction(null);
          setActiveTagAction(null);
          setActionMenuPos(null);
        } else if (activeSubmenuRepoId || activeCommonBranch || activeCommonTag) {
          setActiveSubmenuRepoId(null);
          setActiveCommonBranch(null);
          setActiveCommonTag(null);
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
  }, [onClose, activeBranchAction, activeTagAction, activeSubmenuRepoId, activeCommonBranch, activeCommonTag]);

  const repositories = useMemo(() => snapshot?.repositories ?? [], [snapshot?.repositories]);
  const gitRepos = useMemo(() => repositories.filter((r) => r.meta.kind === 'git'), [repositories]);
  const conflictRepos = useMemo(() => repositories.filter((r) => r.conflicts > 0), [repositories]);

  // 计算公共分支与公共 Tag
  const { commonLocalBranches, commonRemoteBranches, commonTags } = useMemo(() => {
    if (gitRepos.length <= 1) {
      return { commonLocalBranches: [], commonRemoteBranches: [], commonTags: [] };
    }

    const localBranchMap: Record<string, number> = {};
    const remoteBranchMap: Record<string, number> = {};
    const tagMap: Record<string, number> = {};

    gitRepos.forEach((repo) => {
      const branches = branchesByRepo[repo.meta.id] ?? [];
      const tags = tagsByRepo[repo.meta.id] ?? [];

      branches.forEach((b) => {
        if (b.remote) {
          remoteBranchMap[b.name] = (remoteBranchMap[b.name] ?? 0) + 1;
        } else {
          localBranchMap[b.name] = (localBranchMap[b.name] ?? 0) + 1;
        }
      });

      tags.forEach((t) => {
        tagMap[t.name] = (tagMap[t.name] ?? 0) + 1;
      });
    });

    const totalGit = gitRepos.length;
    const commonLocal = Object.keys(localBranchMap).filter((name) => localBranchMap[name] === totalGit);
    const commonRemote = Object.keys(remoteBranchMap).filter((name) => remoteBranchMap[name] === totalGit);
    const commonT = Object.keys(tagMap).filter((name) => tagMap[name] === totalGit);

    return {
      commonLocalBranches: commonLocal,
      commonRemoteBranches: commonRemote,
      commonTags: commonT,
    };
  }, [branchesByRepo, gitRepos, tagsByRepo]);

  // 全局动作：更新全部仓库
  const handleUpdateAll = async () => {
    onClose();
    await Promise.allSettled(
      repositories.map((r) => sync(r.meta.id, r.meta.kind === 'git' ? 'pull' : 'update'))
    );
  };

  // 全局动作：推送全部仓库
  const handlePushAll = async () => {
    onClose();
    const needPushRepos = gitRepos.filter((r) => (r.ahead ?? 0) > 0 || !r.branch);
    if (needPushRepos.length > 0) {
      await Promise.allSettled(needPushRepos.map((r) => sync(r.meta.id, 'push')));
    } else {
      setActiveTab('push');
    }
  };

  // 全局动作：新建分支
  const handleNewBranch = async () => {
    onClose();
    const branchName = await promptDialog({
      title: t('New Branch'),
      message: t('Create new branch in repositories:'),
      inputLabel: t('Branch Name'),
    });
    if (!branchName) return;

    await Promise.allSettled(
      gitRepos.map((r) => branchOperation({ type: 'create', name: branchName, from: null }, r.meta.id))
    );
    await refresh(true);
  };

  // 展开仓库二级菜单
  // 通用子菜单自适应定位算法（使展开的菜单垂直中心完美对齐点击条目，底边绝不超出状态栏）
  const calculateMenuPos = (
    itemRect: DOMRect,
    parentRect: DOMRect | null,
    targetMaxHeight = 440
  ): { left: number; top: number; centerY: number; maxHeight: number } => {
    const minTop = 10;
    const maxBottom = window.innerHeight - 30; // 底部状态栏高度为 28px，预留 2px 安全间隙
    const left = parentRect ? parentRect.right + 4 : itemRect.right + 4;
    const centerY = itemRect.top + itemRect.height / 2;

    const estimatedHeight = Math.min(targetMaxHeight, 260);
    let initialTop = centerY - estimatedHeight / 2;
    if (initialTop + estimatedHeight > maxBottom) {
      initialTop = maxBottom - estimatedHeight;
    }
    if (initialTop < minTop) {
      initialTop = minTop;
    }
    const maxHeight = Math.min(targetMaxHeight, maxBottom - minTop);
    return { left, top: initialTop, centerY, maxHeight };
  };

  // 展开仓库二级菜单（中心对齐点击项，底边严格不超出状态栏）
  const handleOpenRepoSubmenu = (repo: RepositoryStatus, event: React.MouseEvent<HTMLElement>) => {
    setActiveSubmenuRepoId(repo.meta.id);
    setActiveCommonBranch(null);
    setActiveCommonTag(null);
    setActiveBranchAction(null);
    setActiveTagAction(null);
    setActionMenuPos(null);

    const itemRect = event.currentTarget.getBoundingClientRect();
    const pos = calculateMenuPos(itemRect, popoverRef.current?.getBoundingClientRect() ?? null, 440);
    setSubmenuPos(pos);
  };

  // 展开公共分支二级动作菜单（中心对齐点击项，底边严格不超出状态栏）
  const handleOpenCommonBranchSubmenu = (
    branchName: string,
    isRemote: boolean,
    event: React.MouseEvent<HTMLElement>
  ) => {
    setActiveCommonBranch({ name: branchName, isRemote });
    setActiveSubmenuRepoId(null);
    setActiveCommonTag(null);
    setActiveBranchAction(null);
    setActiveTagAction(null);
    setActionMenuPos(null);

    const itemRect = event.currentTarget.getBoundingClientRect();
    const pos = calculateMenuPos(itemRect, popoverRef.current?.getBoundingClientRect() ?? null, 440);
    setSubmenuPos(pos);
  };

  // 展开公共 Tag 二级动作菜单（中心对齐点击项，底边严格不超出状态栏）
  const handleOpenCommonTagSubmenu = (tagName: string, event: React.MouseEvent<HTMLElement>) => {
    setActiveCommonTag(tagName);
    setActiveSubmenuRepoId(null);
    setActiveCommonBranch(null);
    setActiveBranchAction(null);
    setActiveTagAction(null);
    setActionMenuPos(null);

    const itemRect = event.currentTarget.getBoundingClientRect();
    const pos = calculateMenuPos(itemRect, popoverRef.current?.getBoundingClientRect() ?? null, 440);
    setSubmenuPos(pos);
  };

  // 展开分支三级动作菜单（中心对齐点击项，底边严格不超出状态栏）
  const handleOpenBranchActionMenu = (
    repoId: string,
    branchName: string,
    isRemote: boolean,
    isCurrent: boolean,
    event: React.MouseEvent<HTMLElement>
  ) => {
    setActiveBranchAction({ repoId, branchName, isRemote, isCurrent });
    setActiveTagAction(null);

    const itemRect = event.currentTarget.getBoundingClientRect();
    const pos = calculateMenuPos(itemRect, submenuRef.current?.getBoundingClientRect() ?? null, 440);
    setActionMenuPos(pos);
  };

  // 展开 Tag 三级动作菜单（中心对齐点击项，底边严格不超出状态栏）
  const handleOpenTagActionMenu = (
    repoId: string,
    tagName: string,
    isCurrent: boolean,
    event: React.MouseEvent<HTMLElement>
  ) => {
    setActiveTagAction({ repoId, tagName, isCurrent });
    setActiveBranchAction(null);

    const itemRect = event.currentTarget.getBoundingClientRect();
    const pos = calculateMenuPos(itemRect, submenuRef.current?.getBoundingClientRect() ?? null, 440);
    setActionMenuPos(pos);
  };

  const activeSubmenuRepo = repositories.find((r) => r.meta.id === activeSubmenuRepoId);
  const activeRepoBranches = activeSubmenuRepoId ? branchesByRepo[activeSubmenuRepoId] ?? [] : [];
  const activeRepoTags = activeSubmenuRepoId ? tagsByRepo[activeSubmenuRepoId] ?? [] : [];
  const currentRepoBranch =
    activeSubmenuRepo?.branch ??
    repositories.find((r) => r.meta.id === activeBranchAction?.repoId)?.branch ??
    'HEAD';

  const currentCommonBranchName = useMemo(() => {
    const headNames = gitRepos.map((r) => r.branch).filter(Boolean);
    if (headNames.length > 0 && headNames.every((h) => h === headNames[0])) {
      return headNames[0]!;
    }
    return 'HEAD';
  }, [gitRepos]);

  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 28,
    left: anchorRect ? Math.max(8, anchorRect.left) : 8,
    maxHeight: 440,
    zIndex: 1000,
  };

  const totalAhead = useMemo(() => gitRepos.reduce((sum, r) => sum + (r.ahead ?? 0), 0), [gitRepos]);
  const hasBehind = useMemo(() => repositories.some((r) => (r.behind ?? 0) > 0), [repositories]);
  const hasUnpushed = totalAhead > 0 || gitRepos.some((r) => !r.branch);

  return (
    <>
      {/* ──────────────── 1. 一级主菜单面板 ──────────────── */}
      <div ref={popoverRef} className="statusbar-popover branch-menu-popover" style={popoverStyle}>
        <div className="statusbar-popover-content">
          {/* 冲突处理 */}
          {conflictRepos.length > 0 && (
            <div className="statusbar-menu-section warning-section">
              <button
                type="button"
                className="statusbar-menu-item danger"
                onClick={() => {
                  onClose();
                  setActiveTab('changes');
                }}
              >
                <Codicon name="git-merge" />
                <div className="statusbar-menu-item-text">
                  <span className="statusbar-menu-item-title">
                    {t('Resolve Conflicts in {0} repository', conflictRepos.length)}
                  </span>
                  <span className="statusbar-menu-item-desc">{t('Open the conflicts panel to resolve files')}</span>
                </div>
              </button>
              {conflictRepos.map((repo) => (
                <button
                  key={repo.meta.id}
                  type="button"
                  className="statusbar-menu-item danger-sub"
                  onClick={async () => {
                    onClose();
                    const confirmed = await confirmDialog({
                      title: t('Abort Operation'),
                      message: t('Abort merge/rebase in {0}?', repo.meta.name),
                      danger: true,
                    });
                    if (confirmed) {
                      await abortRepositoryOperation(repo.meta.id, 'merge');
                    }
                  }}
                >
                  <Codicon name="error" />
                  <div className="statusbar-menu-item-text">
                    <span className="statusbar-menu-item-title">{t('Abort Operation in {0}', repo.meta.name)}</span>
                  </div>
                </button>
              ))}
              <div className="statusbar-menu-divider" />
            </div>
          )}

          {/* 全局动作 */}
          <div className="statusbar-menu-section">
            <button type="button" className="statusbar-menu-item" onClick={handleUpdateAll}>
              <Codicon name={hasBehind ? 'arrow-down' : 'cloud-download'} />
              <div className="statusbar-menu-item-text">
                <span className="statusbar-menu-item-title">{t('Update Project…')}</span>
                <span className="statusbar-menu-item-desc">
                  {hasBehind ? t('Pull all repositories (incoming commits available)') : t('Pull all repositories')}
                </span>
              </div>
            </button>

            {gitRepos.length > 0 && (
              <button type="button" className="statusbar-menu-item" onClick={handlePushAll}>
                <Codicon name={hasUnpushed ? 'arrow-up' : 'cloud-upload'} />
                <div className="statusbar-menu-item-text">
                  <span className="statusbar-menu-item-title">{t('Push…')}</span>
                  <span className="statusbar-menu-item-desc">
                    {totalAhead > 0
                      ? t('Push commits to remote ({0} to push)', totalAhead)
                      : t('Push current branch to remote')}
                  </span>
                </div>
              </button>
            )}

            <button
              type="button"
              className="statusbar-menu-item"
              onClick={() => {
                onClose();
                setActiveTab('changes');
              }}
            >
              <Codicon name="git-commit" />
              <div className="statusbar-menu-item-text">
                <span className="statusbar-menu-item-title">{t('Commit')}</span>
                <span className="statusbar-menu-item-desc">{t('Open Commit panel')}</span>
              </div>
            </button>

            {gitRepos.length > 0 && (
              <button type="button" className="statusbar-menu-item" onClick={handleNewBranch}>
                <Codicon name="add" />
                <div className="statusbar-menu-item-text">
                  <span className="statusbar-menu-item-title">{t('New Branch…')}</span>
                  <span className="statusbar-menu-item-desc">{t('Create a new branch')}</span>
                </div>
              </button>
            )}

            <button
              type="button"
              className="statusbar-menu-item"
              onClick={() => {
                onClose();
                backToHistory();
              }}
            >
              <Codicon name="history" />
              <div className="statusbar-menu-item-text">
                <span className="statusbar-menu-item-title">{t('Log')}</span>
                <span className="statusbar-menu-item-desc">{t('Open Git Log panel')}</span>
              </div>
            </button>
          </div>

          <div className="statusbar-menu-divider" />

          {/* PROJECTS 项目列表 */}
          {repositories.length > 0 && (
            <div className="statusbar-menu-section">
              <div className="statusbar-menu-group-header">{t('PROJECTS')}</div>
              {repositories.map((repo) => {
                const isSelected = repo.meta.id === activeSubmenuRepoId;
                const ahead = repo.ahead ?? 0;
                const behind = repo.behind ?? 0;

                return (
                  <button
                    key={repo.meta.id}
                    type="button"
                    className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''}`}
                    onClick={(e) => handleOpenRepoSubmenu(repo, e)}
                  >
                    <Codicon name={repo.meta.isSubmodule ? 'package' : 'root-folder'} />
                    <div className="statusbar-menu-item-text">
                      <span className="statusbar-menu-item-title">{repo.meta.name}</span>
                      <span className="statusbar-menu-item-desc">
                        <Codicon name="git-branch" /> {repo.branch ?? 'HEAD'}
                        {ahead > 0 && <span className="statusbar-push-label"> ↑{ahead}</span>}
                        {behind > 0 && <span className="statusbar-pull-label"> ↓{behind}</span>}
                      </span>
                    </div>
                    <Codicon name="chevron-right" className="submenu-arrow" />
                  </button>
                );
              })}
            </div>
          )}

          {/* COMMON LOCAL BRANCHES 公共本地分支 */}
          {commonLocalBranches.length > 0 && (
            <div className="statusbar-menu-section">
              <div className="statusbar-menu-group-header">{t('COMMON LOCAL BRANCHES')}</div>
              {commonLocalBranches.map((branch) => {
                const isHead = repositories.every((r) => r.branch === branch);
                const isSelected = activeCommonBranch?.name === branch && !activeCommonBranch?.isRemote;
                return (
                  <button
                    key={branch}
                    type="button"
                    className={`statusbar-menu-item has-submenu ${isHead ? 'active-ref' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={(e) => handleOpenCommonBranchSubmenu(branch, false, e)}
                  >
                    <Codicon name={isHead ? 'check' : 'git-branch'} />
                    <div className="statusbar-menu-item-text">
                      <span className="statusbar-menu-item-title">{branch}</span>
                    </div>
                    {isHead && <span className="statusbar-badge">{t('current')}</span>}
                    <Codicon name="chevron-right" className="submenu-arrow" />
                  </button>
                );
              })}
            </div>
          )}

          {/* COMMON REMOTE BRANCHES 公共远程分支 */}
          {commonRemoteBranches.length > 0 && (
            <div className="statusbar-menu-section">
              <div className="statusbar-menu-group-header">{t('COMMON REMOTE BRANCHES')}</div>
              {commonRemoteBranches.map((branch) => {
                const isSelected = activeCommonBranch?.name === branch && activeCommonBranch?.isRemote;
                return (
                  <button
                    key={branch}
                    type="button"
                    className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''}`}
                    onClick={(e) => handleOpenCommonBranchSubmenu(branch, true, e)}
                  >
                    <Codicon name="cloud" />
                    <div className="statusbar-menu-item-text">
                      <span className="statusbar-menu-item-title">{branch}</span>
                    </div>
                    <Codicon name="chevron-right" className="submenu-arrow" />
                  </button>
                );
              })}
            </div>
          )}

          {/* COMMON TAGS 公共标签 */}
          {commonTags.length > 0 && (
            <div className="statusbar-menu-section">
              <div className="statusbar-menu-group-header">{t('COMMON TAGS')}</div>
              {commonTags.map((tag) => {
                const isSelected = activeCommonTag === tag;
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''}`}
                    onClick={(e) => handleOpenCommonTagSubmenu(tag, e)}
                  >
                    <Codicon name="tag" />
                    <div className="statusbar-menu-item-text">
                      <span className="statusbar-menu-item-title">{tag}</span>
                    </div>
                    <Codicon name="chevron-right" className="submenu-arrow" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ──────────────── 2. 二级菜单面板（仓库分支列表 / 公共分支动作 / 公共标签动作） ──────────────── */}
      {submenuPos && (activeSubmenuRepo || activeCommonBranch || activeCommonTag) && (
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
            {/* 情况 A：具体仓库的分支/标签列表 */}
            {activeSubmenuRepo && (
              <>
                {/* 仓库二级菜单顶部操作项（对齐原版 showRepoBranchMenu / showSvnRepoMenu） */}
                <div className="statusbar-menu-section">
                  {activeSubmenuRepo.meta.kind === 'git' && (
                    <>
                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          const name = await promptDialog({
                            title: t('New Branch in {0}', activeSubmenuRepo.meta.name),
                            message: t('Enter new branch name:'),
                            inputLabel: t('Branch Name'),
                          });
                          if (name) {
                            await branchOperation({ type: 'create', name, from: null }, activeSubmenuRepo.meta.id);
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="add" />
                        <span>{t('New Branch…')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={() => {
                          onClose();
                          openRemoteManager(activeSubmenuRepo.meta.id);
                        }}
                      >
                        <Codicon name="remote-explorer" />
                        <span>{t('Manage Remotes…')}</span>
                      </button>

                      {activeSubmenuRepo.operation === 'merge' && (
                        <button
                          type="button"
                          className="statusbar-menu-item danger"
                          onClick={async () => {
                            onClose();
                            const confirmed = await confirmDialog({
                              title: t('Abort Merge'),
                              message: t(
                                'Abort merge in {0}? This will restore the repository to its pre-merge state.',
                                activeSubmenuRepo.meta.name
                              ),
                              danger: true,
                            });
                            if (confirmed) {
                              await abortRepositoryOperation(activeSubmenuRepo.meta.id, 'merge');
                              await refresh(true);
                            }
                          }}
                        >
                          <Codicon name="error" />
                          <span>{t('Abort Merge')}</span>
                        </button>
                      )}

                      {activeSubmenuRepo.operation === 'rebase' && (
                        <button
                          type="button"
                          className="statusbar-menu-item danger"
                          onClick={async () => {
                            onClose();
                            const confirmed = await confirmDialog({
                              title: t('Abort Rebase'),
                              message: t(
                                'Abort {0} in {1}? This will restore the repository to its previous state.',
                                'rebase',
                                activeSubmenuRepo.meta.name
                              ),
                              danger: true,
                            });
                            if (confirmed) {
                              await abortRepositoryOperation(activeSubmenuRepo.meta.id, 'rebase');
                              await refresh(true);
                            }
                          }}
                        >
                          <Codicon name="error" />
                          <span>{t('Abort Rebase')}</span>
                        </button>
                      )}
                    </>
                  )}

                  {activeSubmenuRepo.meta.kind === 'svn' && (
                    <>
                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          await sync(activeSubmenuRepo.meta.id, 'update');
                        }}
                      >
                        <Codicon name="cloud-download" />
                        <span>{t('Update Project…')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={() => {
                          onClose();
                          setActiveTab('changes');
                        }}
                      >
                        <Codicon name="git-commit" />
                        <span>{t('Commit')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={() => {
                          onClose();
                          backToHistory();
                        }}
                      >
                        <Codicon name="history" />
                        <span>{t('Log')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          await svnOperation(activeSubmenuRepo.meta.id, {
                            type: 'cleanup',
                            break_locks: false,
                            remove_unversioned: false,
                            remove_ignored: false,
                            include_externals: false,
                          });
                          await refresh(true);
                        }}
                      >
                        <Codicon name="tools" />
                        <span>{t('SVN Cleanup')}</span>
                      </button>
                    </>
                  )}
                </div>

                <div className="statusbar-menu-divider" />

                {/* 本地分支列表 LOCAL */}
                {activeRepoBranches.filter((b) => !b.remote).length > 0 && (
                  <div className="statusbar-menu-section">
                    <div className="statusbar-menu-group-header">{t('LOCAL')}</div>
                    {activeRepoBranches
                      .filter((b) => !b.remote)
                      .map((b) => {
                        const isHead = b.current || b.name === activeSubmenuRepo.branch;
                        const isSelected =
                          activeBranchAction?.repoId === activeSubmenuRepo.meta.id &&
                          activeBranchAction?.branchName === b.name;
                        const ahead = b.ahead ?? (isHead ? activeSubmenuRepo.ahead ?? 0 : 0);
                        const behind = b.behind ?? (isHead ? activeSubmenuRepo.behind ?? 0 : 0);

                        return (
                          <button
                            key={b.name}
                            type="button"
                            className={`statusbar-menu-item has-submenu ${isHead ? 'active-ref' : ''} ${isSelected ? 'selected' : ''}`}
                            onClick={(e) =>
                              handleOpenBranchActionMenu(
                                activeSubmenuRepo.meta.id,
                                b.name,
                                false,
                                isHead,
                                e
                              )
                            }
                          >
                            <Codicon name={isHead ? 'check' : 'git-branch'} />
                            <div className="statusbar-menu-item-text">
                              <span className="statusbar-menu-item-title">{b.name}</span>
                              {(ahead > 0 || behind > 0) && (
                                <span className="statusbar-menu-item-desc">
                                  {ahead > 0 && <span className="statusbar-push-label"> ↑{ahead}</span>}
                                  {behind > 0 && <span className="statusbar-pull-label"> ↓{behind}</span>}
                                </span>
                              )}
                            </div>
                            {isHead && <span className="statusbar-badge">{t('current')}</span>}
                            <Codicon name="chevron-right" className="submenu-arrow" />
                          </button>
                        );
                      })}
                  </div>
                )}

                {/* 远程分支列表 REMOTE */}
                {activeRepoBranches.filter((b) => b.remote).length > 0 && (
                  <div className="statusbar-menu-section">
                    <div className="statusbar-menu-group-header">{t('REMOTE')}</div>
                    {activeRepoBranches
                      .filter((b) => b.remote)
                      .map((b) => {
                        const isSelected =
                          activeBranchAction?.repoId === activeSubmenuRepo.meta.id &&
                          activeBranchAction?.branchName === b.name;
                        return (
                          <button
                            key={b.name}
                            type="button"
                            className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''}`}
                            onClick={(e) =>
                              handleOpenBranchActionMenu(
                                activeSubmenuRepo.meta.id,
                                b.name,
                                true,
                                false,
                                e
                              )
                            }
                          >
                            <Codicon name="cloud" />
                            <div className="statusbar-menu-item-text">
                              <span className="statusbar-menu-item-title">{b.name}</span>
                            </div>
                            <Codicon name="chevron-right" className="submenu-arrow" />
                          </button>
                        );
                      })}
                  </div>
                )}

                {/* Tags 列表 TAGS */}
                {activeRepoTags.length > 0 && (
                  <div className="statusbar-menu-section">
                    <div className="statusbar-menu-group-header">{t('TAGS')}</div>
                    {activeRepoTags.map((tag) => {
                      const isSelected =
                        activeTagAction?.repoId === activeSubmenuRepo.meta.id &&
                        activeTagAction?.tagName === tag.name;
                      return (
                        <button
                          key={tag.name}
                          type="button"
                          className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''}`}
                          onClick={(e) =>
                            handleOpenTagActionMenu(activeSubmenuRepo.meta.id, tag.name, false, e)
                          }
                        >
                          <Codicon name="tag" />
                          <div className="statusbar-menu-item-text">
                            <span className="statusbar-menu-item-title">{tag.name}</span>
                          </div>
                          <Codicon name="chevron-right" className="submenu-arrow" />
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Submodule 分组（对齐原版 showRepoBranchMenu） */}
                {activeSubmenuRepo.meta.isSubmodule && (
                  <div className="statusbar-menu-section">
                    <div className="statusbar-menu-group-header">{t('SUBMODULE')}</div>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await submoduleOperation(activeSubmenuRepo.meta.id, {
                          type: 'update',
                          path: activeSubmenuRepo.meta.rootPath,
                          init: false,
                          recursive: false,
                          remote: false,
                        });
                      }}
                    >
                      <Codicon name="repo-sync" />
                      <span>{t('Update')}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await submoduleOperation(activeSubmenuRepo.meta.id, {
                          type: 'update',
                          path: activeSubmenuRepo.meta.rootPath,
                          init: true,
                          recursive: true,
                          remote: false,
                        });
                      }}
                    >
                      <Codicon name="repo-sync" />
                      <span>{t('Update (recursive)')}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await submoduleOperation(activeSubmenuRepo.meta.id, {
                          type: 'init',
                          path: activeSubmenuRepo.meta.rootPath,
                          recursive: false,
                        });
                      }}
                    >
                      <Codicon name="add" />
                      <span>{t('Init')}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item danger"
                      onClick={async () => {
                        onClose();
                        const confirmed = await confirmDialog({
                          title: t('Deinit'),
                          message: t('Deinit submodule "{0}"? The working directory will be cleared.', activeSubmenuRepo.meta.name),
                          danger: true,
                        });
                        if (confirmed) {
                          await submoduleOperation(activeSubmenuRepo.meta.id, {
                            type: 'deinit',
                            path: activeSubmenuRepo.meta.rootPath,
                            force: false,
                          });
                        }
                      }}
                    >
                      <Codicon name="trash" />
                      <span>{t('Deinit')}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await systemOpen(activeSubmenuRepo.meta.id, activeSubmenuRepo.meta.rootPath, true);
                      }}
                    >
                      <Codicon name="link-external" />
                      <span>{t('Open in New Window')}</span>
                    </button>
                  </div>
                )}
              </>
            )}

            {/* 情况 B：公共分支二级动作菜单（对齐原版 showCommonBranchActionMenu） */}
            {activeCommonBranch && (
              <div className="statusbar-menu-section">
                {/* 1. 检出 */}
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    const targetBranch = activeCommonBranch.isRemote
                      ? activeCommonBranch.name.replace(/^[^/]+\//, '')
                      : activeCommonBranch.name;
                    await Promise.allSettled(
                      gitRepos.map((r) => branchOperation({ type: 'checkout', name: targetBranch }, r.meta.id))
                    );
                    await refresh(true);
                  }}
                >
                  <Codicon name="arrow-right" />
                  <span>{t('Checkout')}</span>
                </button>

                {/* 2. 从当前公共分支新建分支 */}
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    const newName = await promptDialog({
                      title: t("New branch from '{0}'…", activeCommonBranch.name),
                      message: t('Enter new branch name:'),
                      inputLabel: t('Branch Name'),
                    });
                    if (newName) {
                      await Promise.allSettled(
                        gitRepos.map((r) =>
                          branchOperation({ type: 'create', name: newName, from: activeCommonBranch.name }, r.meta.id)
                        )
                      );
                      await refresh(true);
                    }
                  }}
                >
                  <Codicon name="add" />
                  <span>{t("New branch from '{0}'…", activeCommonBranch.name)}</span>
                </button>

                {/* 3. 本地分支特有动作：拉取更新与重命名 */}
                {!activeCommonBranch.isRemote && (
                  <>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await Promise.allSettled(gitRepos.map((r) => sync(r.meta.id, 'pull')));
                      }}
                    >
                      <Codicon name="cloud-download" />
                      <span>{t('Update (Pull)')}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        const newName = await promptDialog({
                          title: t("Rename branch '{0}'", activeCommonBranch.name),
                          message: t('Enter new branch name:'),
                          inputLabel: t('Branch Name'),
                          initialValue: activeCommonBranch.name,
                        });
                        if (newName && newName !== activeCommonBranch.name) {
                          await Promise.allSettled(
                            gitRepos.map((r) =>
                              branchOperation(
                                { type: 'rename', old_name: activeCommonBranch.name, new_name: newName },
                                r.meta.id
                              )
                            )
                          );
                          await refresh(true);
                        }
                      }}
                    >
                      <Codicon name="edit" />
                      <span>{t('Rename…')}</span>
                    </button>
                  </>
                )}

                {/* 4. 非当前分支特有动作：比较、变基、合并 */}
                {activeCommonBranch.name !== currentCommonBranchName && (
                  <>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={() => {
                        onClose();
                        if (gitRepos.length > 0) {
                          openBranchComparison(gitRepos[0].meta.id, activeCommonBranch.name);
                        }
                      }}
                    >
                      <Codicon name="git-compare" />
                      <span>{t("Compare '{0}' with '{1}'", currentCommonBranchName, activeCommonBranch.name)}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await Promise.allSettled(
                          gitRepos.map((r) =>
                            branchOperation({ type: 'rebase', name: activeCommonBranch.name }, r.meta.id)
                          )
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="repo-forked" />
                      <span>{t("Rebase '{0}' onto '{1}'", currentCommonBranchName, activeCommonBranch.name)}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await Promise.allSettled(
                          gitRepos.map((r) =>
                            branchOperation({ type: 'merge', name: activeCommonBranch.name }, r.meta.id)
                          )
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="git-merge" />
                      <span>{t("Merge '{0}' into '{1}'", activeCommonBranch.name, currentCommonBranchName)}</span>
                    </button>

                    {!activeCommonBranch.isRemote && (
                      <button
                        type="button"
                        className="statusbar-menu-item danger"
                        onClick={async () => {
                          onClose();
                          const confirmed = await confirmDialog({
                            title: t("Delete branch '{0}'?", activeCommonBranch.name),
                            message: t("Delete branch '{0}' in all repos?", activeCommonBranch.name),
                            danger: true,
                          });
                          if (confirmed) {
                            await Promise.allSettled(
                              gitRepos.map((r) =>
                                branchOperation(
                                  { type: 'delete', name: activeCommonBranch.name, force: false },
                                  r.meta.id
                                )
                              )
                            );
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="trash" />
                        <span>{t('Delete…')}</span>
                      </button>
                    )}
                  </>
                )}

                {/* 5. 远程分支特有动作：Pull using Rebase / Pull using Merge */}
                {activeCommonBranch.isRemote && (
                  <>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await Promise.allSettled(
                          gitRepos.map((r) =>
                            branchOperation({ type: 'rebase', name: activeCommonBranch.name }, r.meta.id)
                          )
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="repo-forked" />
                      <span>{t("Pull into '{0}' using Rebase", currentCommonBranchName)}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await Promise.allSettled(
                          gitRepos.map((r) =>
                            branchOperation({ type: 'merge', name: activeCommonBranch.name }, r.meta.id)
                          )
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="git-merge" />
                      <span>{t("Pull into '{0}' using Merge", currentCommonBranchName)}</span>
                    </button>
                  </>
                )}
              </div>
            )}

            {/* 情况 C：公共 Tag 二级动作菜单（对齐原版 showCommonTagActionMenu） */}
            {activeCommonTag && (
              <div className="statusbar-menu-section">
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    await Promise.allSettled(
                      gitRepos.map((r) => tagOperation({ type: 'checkout', name: activeCommonTag }, r.meta.id))
                    );
                    await refresh(true);
                  }}
                >
                  <Codicon name="arrow-right" />
                  <span>{t('Checkout')}</span>
                </button>

                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    await Promise.allSettled(
                      gitRepos.map((r) => tagOperation({ type: 'merge', name: activeCommonTag }, r.meta.id))
                    );
                    await refresh(true);
                  }}
                >
                  <Codicon name="git-merge" />
                  <span>{t('Merge "{0}" into "{1}"', activeCommonTag, currentCommonBranchName)}</span>
                </button>

                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    await Promise.allSettled(
                      gitRepos.map((r) =>
                        tagOperation({ type: 'push', name: activeCommonTag, remote: 'origin' }, r.meta.id)
                      )
                    );
                    await refresh(true);
                  }}
                >
                  <Codicon name="cloud-upload" />
                  <span>{t('Push tag')}</span>
                </button>

                <button
                  type="button"
                  className="statusbar-menu-item danger"
                  onClick={async () => {
                    onClose();
                    const confirmed = await confirmDialog({
                      title: t("Delete tag '{0}'?", activeCommonTag),
                      message: t("Delete tag '{0}' in all repos?", activeCommonTag),
                      danger: true,
                    });
                    if (confirmed) {
                      await Promise.allSettled(
                        gitRepos.map((r) => tagOperation({ type: 'delete', name: activeCommonTag }, r.meta.id))
                      );
                      await refresh(true);
                    }
                  }}
                >
                  <Codicon name="trash" />
                  <span>{t('Delete tag')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ──────────────── 3. 三级菜单面板（具体分支 / Tag 的动作菜单） ──────────────── */}
      {actionMenuPos && (activeBranchAction || activeTagAction) && (
        <div
          ref={actionMenuRef}
          className="statusbar-submenu"
          style={{
            position: 'fixed',
            top: actionMenuPos.top,
            left: actionMenuPos.left,
            maxHeight: actionMenuPos.maxHeight,
            zIndex: 1002,
          }}
        >
          <div className="statusbar-popover-content">
            {/* 分支三级动作菜单（对齐原版 showSingleBranchActionMenu） */}
            {activeBranchAction && (
              <div className="statusbar-menu-section">
                {/* 检出 */}
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    const targetName = activeBranchAction.isRemote
                      ? activeBranchAction.branchName.replace(/^[^/]+\//, '')
                      : activeBranchAction.branchName;
                    await branchOperation({ type: 'checkout', name: targetName }, activeBranchAction.repoId);
                    await refresh(true);
                  }}
                >
                  <Codicon name="arrow-right" />
                  <span>{t('Checkout')}</span>
                </button>

                {/* 新建分支 */}
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    const newBranch = await promptDialog({
                      title: t("New branch from '{0}'…", activeBranchAction.branchName),
                      message: t('Enter new branch name:'),
                      inputLabel: t('Branch Name'),
                    });
                    if (newBranch) {
                      await branchOperation(
                        { type: 'create', name: newBranch, from: activeBranchAction.branchName },
                        activeBranchAction.repoId
                      );
                      await refresh(true);
                    }
                  }}
                >
                  <Codicon name="add" />
                  <span>{t("New branch from '{0}'…", activeBranchAction.branchName)}</span>
                </button>

                {/* 本地分支拉取与重命名 */}
                {!activeBranchAction.isRemote && (
                  <>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await sync(activeBranchAction.repoId, 'pull');
                      }}
                    >
                      <Codicon name="cloud-download" />
                      <span>{t('Update (Pull)')}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        const newName = await promptDialog({
                          title: t("Rename branch '{0}'", activeBranchAction.branchName),
                          message: t('Enter new branch name:'),
                          inputLabel: t('Branch Name'),
                          initialValue: activeBranchAction.branchName,
                        });
                        if (newName && newName !== activeBranchAction.branchName) {
                          await branchOperation(
                            { type: 'rename', old_name: activeBranchAction.branchName, new_name: newName },
                            activeBranchAction.repoId
                          );
                          await refresh(true);
                        }
                      }}
                    >
                      <Codicon name="edit" />
                      <span>{t('Rename…')}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await sync(activeBranchAction.repoId, 'push');
                      }}
                    >
                      <Codicon name="cloud-upload" />
                      <span>{t('Push')}</span>
                    </button>
                  </>
                )}

                {/* 比较、变基、合并（非当前分支） */}
                {!activeBranchAction.isCurrent && (
                  <>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={() => {
                        onClose();
                        openBranchComparison(activeBranchAction.repoId, activeBranchAction.branchName);
                      }}
                    >
                      <Codicon name="git-compare" />
                      <span>{t("Compare '{0}' with '{1}'", currentRepoBranch, activeBranchAction.branchName)}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await branchOperation(
                          { type: 'rebase', name: activeBranchAction.branchName },
                          activeBranchAction.repoId
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="repo-forked" />
                      <span>{t("Rebase '{0}' onto '{1}'", currentRepoBranch, activeBranchAction.branchName)}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await branchOperation(
                          { type: 'merge', name: activeBranchAction.branchName },
                          activeBranchAction.repoId
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="git-merge" />
                      <span>{t("Merge '{0}' into '{1}'", activeBranchAction.branchName, currentRepoBranch)}</span>
                    </button>

                    {!activeBranchAction.isRemote && (
                      <button
                        type="button"
                        className="statusbar-menu-item danger"
                        onClick={async () => {
                          onClose();
                          const confirmed = await confirmDialog({
                            title: t("Delete branch '{0}'?", activeBranchAction.branchName),
                            message: t("Delete branch '{0}'?", activeBranchAction.branchName),
                            danger: true,
                          });
                          if (confirmed) {
                            await branchOperation(
                              { type: 'delete', name: activeBranchAction.branchName, force: false },
                              activeBranchAction.repoId
                            );
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="trash" />
                        <span>{t('Delete…')}</span>
                      </button>
                    )}
                  </>
                )}

                {/* 远程分支特有动作：Pull using Rebase / Pull using Merge */}
                {activeBranchAction.isRemote && (
                  <>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await branchOperation(
                          { type: 'rebase', name: activeBranchAction.branchName },
                          activeBranchAction.repoId
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="repo-forked" />
                      <span>{t("Pull into '{0}' using Rebase", currentRepoBranch)}</span>
                    </button>

                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await branchOperation(
                          { type: 'merge', name: activeBranchAction.branchName },
                          activeBranchAction.repoId
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="git-merge" />
                      <span>{t("Pull into '{0}' using Merge", currentRepoBranch)}</span>
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Tag 三级动作菜单（对齐原版 showSingleTagActionMenu） */}
            {activeTagAction && (
              <div className="statusbar-menu-section">
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    await tagOperation({ type: 'checkout', name: activeTagAction.tagName }, activeTagAction.repoId);
                    await refresh(true);
                  }}
                >
                  <Codicon name="arrow-right" />
                  <span>{t('Checkout')}</span>
                </button>

                {!activeTagAction.isCurrent && (
                  <button
                    type="button"
                    className="statusbar-menu-item"
                    onClick={async () => {
                      onClose();
                      await tagOperation({ type: 'merge', name: activeTagAction.tagName }, activeTagAction.repoId);
                      await refresh(true);
                    }}
                  >
                    <Codicon name="git-merge" />
                    <span>{t('Merge "{0}" into "{1}"', activeTagAction.tagName, currentRepoBranch)}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    await tagOperation(
                      { type: 'push', name: activeTagAction.tagName, remote: 'origin' },
                      activeTagAction.repoId
                    );
                    await refresh(true);
                  }}
                >
                  <Codicon name="cloud-upload" />
                  <span>{t('Push tag')}</span>
                </button>

                <button
                  type="button"
                  className="statusbar-menu-item danger"
                  onClick={async () => {
                    onClose();
                    const confirmed = await confirmDialog({
                      title: t("Delete tag '{0}'?", activeTagAction.tagName),
                      message: t("Delete tag '{0}'?", activeTagAction.tagName),
                      danger: true,
                    });
                    if (confirmed) {
                      await tagOperation({ type: 'delete', name: activeTagAction.tagName }, activeTagAction.repoId);
                      await refresh(true);
                    }
                  }}
                >
                  <Codicon name="trash" />
                  <span>{t('Delete tag')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
