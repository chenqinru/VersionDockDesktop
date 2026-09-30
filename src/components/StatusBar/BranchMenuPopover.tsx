import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore, type AppNotificationAction } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { promptDialog, confirmDialog, choiceDialog, multiChoiceDialog, currentDialog } from '../dialogService';
import type { RepositoryStatus, BranchCompareResult } from '../../bindings/generated';
import { useBridge } from '../../platform/context';
import { resolveSubmoduleOperationTarget } from './submoduleTarget';
import { isBranchProtected, sanitizeBranchName } from '../../history/branchProtection';
import {
  getRepoCompareBase,
  getRepoEffectiveRef,
  getRepoRefIcon,
  formatRepoOperationLabel,
  isMixedRepoWorkspace,
  formatRepoDisplayName,
  isAbortableVcsOperation,
  getAbortOperationLabels,
} from './branchRef';
import { IgnoreRulesPanel } from '../IgnoreRulesPanel';

const RECENT_BRANCHES_KEY = 'versiondock:recent_branches';

function getRecentBranches(repoId: string): string[] {
  try {
    const raw = localStorage.getItem(RECENT_BRANCHES_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, string[]>;
    return Array.isArray(map[repoId]) ? map[repoId] : [];
  } catch {
    return [];
  }
}

function recordRecentBranch(repoId: string, branchName: string) {
  if (!branchName || branchName === 'HEAD') return;
  try {
    const raw = localStorage.getItem(RECENT_BRANCHES_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    const existing = Array.isArray(map[repoId]) ? map[repoId] : [];
    const filtered = existing.filter((name) => name !== branchName);
    filtered.unshift(branchName);
    map[repoId] = filtered.slice(0, 3);
    localStorage.setItem(RECENT_BRANCHES_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

interface BranchMenuPopoverProps {
  anchorRect: DOMRect | null;
  onClose: () => void;
  initialRepoId?: string;
  repoOnly?: boolean;
  directBranch?: { repoId: string; branchName: string; isCurrent: boolean };
  onManageIgnore?: (repoId: string, directory?: string) => void;
}

export function BranchMenuPopover({ anchorRect, onClose, initialRepoId, repoOnly = false, directBranch, onManageIgnore }: BranchMenuPopoverProps) {
  const { t } = useI18n();
  const bridge = useBridge();
  const snapshot = useAppStore((state) => state.snapshot);
  const sync = useAppStore((state) => state.sync);
  const updateProject = useAppStore((state) => state.updateProject);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const abortRepositoryOperation = useAppStore((state) => state.abortRepositoryOperation);
  const submoduleOperation = useAppStore((state) => state.submoduleOperation);
  const svnOperation = useAppStore((state) => state.svnOperation);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const backToHistory = useAppStore((state) => state.backToHistory);
  const openBranchComparison = useAppStore((state) => state.openBranchComparison);
  const openRemoteManager = useAppStore((state) => state.openRemoteManager);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const refresh = useAppStore((state) => state.refresh);
  const fetchRepositories = useAppStore((state) => state.fetchRepositories);
  const remotes = useAppStore((state) => state.remotes);
  const loadRemotes = useAppStore((state) => state.loadRemotes);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const selectRepo = useAppStore((state) => state.selectRepo);
  const addNotification = useAppStore((state) => state.addNotification);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const initializeRepository = useAppStore((state) => state.initializeRepository);
  const initializeAvailable = bootstrap?.capabilities?.availability?.initializeRepository?.available ?? bootstrap?.tools?.git ?? false;

  // 忽略规则面板状态（包含 repoId 与相对目录）
  const [ignoreManagerTarget, setIgnoreManagerTarget] = useState<{ repoId: string; directory: string } | null>(null);
  const ignoreManagerRepoId = ignoreManagerTarget?.repoId ?? null;

  // 辅助函数：选取指定仓库的目标远端
  const pickRemote = async (repoId: string, title: string): Promise<string | null> => {
    await loadRemotes(repoId);
    const repoRemotes = useAppStore.getState().remotes[repoId] ?? [];
    const names = repoRemotes.map((r) => r.name);
    if (names.length === 0) return null;
    if (names.length === 1) return names[0];
    return await choiceDialog({
      title,
      message: t('Select a remote repository:'),
      choices: names.map((name) => ({ id: name, label: name, icon: 'cloud-upload' })),
    });
  };

  // 近期分支更新计数
  const [, setRecentVersion] = useState(0);
  const markRecentBranch = (repoId: string, branchName: string) => {
    recordRecentBranch(repoId, branchName);
    setRecentVersion((v) => v + 1);
  };

  // 二级菜单状态
  const [activeSubmenuRepoId, setActiveSubmenuRepoId] = useState<string | null>(() => {
    if (directBranch) return null;
    if (initialRepoId) return initialRepoId;
    if (repoOnly && snapshot?.repositories.length === 1) return snapshot.repositories[0].meta.id;
    return null;
  });
  const [activeCommonBranch, setActiveCommonBranch] = useState<{ name: string; isRemote: boolean } | null>(null);
  const [activeCommonTag, setActiveCommonTag] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number; centerY: number; maxHeight: number } | null>(() => {
    const targetRepoId = initialRepoId ?? (repoOnly && snapshot?.repositories.length === 1 ? snapshot.repositories[0].meta.id : null);
    if (!targetRepoId || !anchorRect) return null;
    return {
      left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 288)),
      top: anchorRect.bottom + 4,
      centerY: anchorRect.top + anchorRect.height / 2,
      maxHeight: Math.max(160, window.innerHeight - 20),
    };
  });

  // 三级动作菜单状态
  const [activeBranchAction, setActiveBranchAction] = useState<{
    repoId: string;
    branchName: string;
    isRemote: boolean;
    isCurrent: boolean;
  } | null>(directBranch ? { ...directBranch, isRemote: false } : null);
  const [activeTagAction, setActiveTagAction] = useState<{
    repoId: string;
    tagName: string;
    isCurrent: boolean;
  } | null>(null);
  const [actionMenuPos, setActionMenuPos] = useState<{ left: number; top: number; centerY: number; maxHeight: number } | null>(() => directBranch && anchorRect ? {
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 288)),
    top: anchorRect.bottom + 4,
    centerY: anchorRect.bottom + 4,
    maxHeight: Math.max(160, window.innerHeight - 20),
  } : null);

  const popoverRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const ignorePanelRef = useRef<HTMLDivElement>(null);

  // 监听二级子菜单真实高度，使其正中心精确对齐被点击的一级条目中心
  useLayoutEffect(() => {
    if (submenuRef.current && submenuPos) {
      const h = submenuRef.current.offsetHeight;
      const minTop = 10;
      const maxBottom = window.innerHeight - 30; // 底部状态栏 28px + 2px 安全距离
      let nextTop = repoOnly && anchorRect ? anchorRect.bottom + 4 : submenuPos.centerY - h / 2;
      if (nextTop + h > maxBottom) {
        nextTop = repoOnly && anchorRect ? anchorRect.top - h - 4 : maxBottom - h;
      }
      if (nextTop < minTop) {
        nextTop = minTop;
      }
      if (Math.abs(submenuPos.top - nextTop) > 1) {
        setSubmenuPos((prev) => (prev ? { ...prev, top: nextTop } : null));
      }
    }
  }, [submenuPos, activeSubmenuRepoId, activeCommonBranch, activeCommonTag, anchorRect, repoOnly]);

  // 监听三级动作子菜单真实高度，使其正中心精确对齐被点击的二级分支条目中心
  useLayoutEffect(() => {
    if (actionMenuRef.current && actionMenuPos) {
      const h = actionMenuRef.current.offsetHeight;
      const minTop = 10;
      const maxBottom = window.innerHeight - 30;
      let nextTop = directBranch && anchorRect ? anchorRect.bottom + 4 : actionMenuPos.centerY - h / 2;
      if (nextTop + h > maxBottom) {
        nextTop = directBranch && anchorRect ? anchorRect.top - h - 4 : maxBottom - h;
      }
      if (nextTop < minTop) {
        nextTop = minTop;
      }
      if (Math.abs(actionMenuPos.top - nextTop) > 1) {
        setActionMenuPos((prev) => (prev ? { ...prev, top: nextTop } : null));
      }
    }
  }, [actionMenuPos, activeBranchAction, activeTagAction, anchorRect, directBranch]);

  // 监听点击外部和 Escape 关闭
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        submenuRef.current?.contains(target) ||
        actionMenuRef.current?.contains(target) ||
        ignorePanelRef.current?.contains(target) ||
        (target instanceof Element && Boolean(target.closest('.dialog-backdrop, .app-dialog')))
      ) {
        return;
      }
      // 当全局对话框打开或忽略规则管理面板处于激活显示状态时，不触发菜单外部点击关闭
      if (currentDialog() || ignoreManagerRepoId) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // 全局对话框打开或忽略规则面板激活时，由其自身的键盘处理逻辑负责响应，菜单不抢先关闭
      if (currentDialog() || ignoreManagerRepoId) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (directBranch || (repoOnly && !activeBranchAction && !activeTagAction)) {
          onClose();
        } else if (activeBranchAction || activeTagAction) {
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
  }, [onClose, activeBranchAction, activeTagAction, activeSubmenuRepoId, activeCommonBranch, activeCommonTag, repoOnly, directBranch, ignoreManagerRepoId]);

  const repositories = useMemo(() => snapshot?.repositories ?? [], [snapshot?.repositories]);
  const gitRepos = useMemo(() => repositories.filter((r) => r.meta.kind === 'git'), [repositories]);
  const conflictRepos = useMemo(() => repositories.filter((r) => r.conflicts > 0), [repositories]);
  const operationRepos = useMemo(() => repositories.filter((r) => isAbortableVcsOperation(r.operation)), [repositories]);

  // 分支分歧判定（对齐插件与 BranchStatusBarItem）
  const nonWorktreeRepos = useMemo(() => repositories.filter((r) => !r.meta.isWorktree), [repositories]);
  const targetRepos = nonWorktreeRepos.length > 0 ? nonWorktreeRepos : repositories;
  const targetGitRepos = useMemo(() => targetRepos.filter((r) => r.meta.kind === 'git'), [targetRepos]);
  const topLevelGitRepos = useMemo(() => targetGitRepos.filter((r) => !r.meta.isSubmodule), [targetGitRepos]);
  const topLevelEffectiveNames = useMemo(
    () => Array.from(new Set(topLevelGitRepos.map((r) => getRepoEffectiveRef(r, branchesByRepo)))),
    [topLevelGitRepos, branchesByRepo]
  );
  const branchesDiverged = topLevelGitRepos.length > 1 && topLevelEffectiveNames.length > 1;
  const suppressDivergedWarning = bootstrap?.state.settings?.suppressDivergedWarning ?? false;
  const showDivergedWarning = branchesDiverged && !suppressDivergedWarning;

  // 计算公共分支与公共 Tag
  const { commonLocalBranches, commonRemoteBranches, commonTags } = useMemo(() => {
    if (gitRepos.length === 0) {
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

  // 全局动作：更新全部仓库（遵循设置中的 rebase/merge/prompt 策略）
  const handleUpdateAll = async () => {
    onClose();
    await updateProject();
  };

  // 挂载时主动刷新所有Git仓库的远端列表
  useEffect(() => {
    if (gitRepos.length > 0) {
      void Promise.allSettled(gitRepos.map((r) => loadRemotes(r.meta.id)));
    }
  }, [gitRepos, loadRemotes]);

  // 全局动作：Fetch All
  const handleFetchAll = async () => {
    onClose();
    await fetchRepositories(gitRepos.map((repo) => repo.meta.id));
  };

  // 全局动作：推送（对齐插件版 pushMenu：选择仓库与远端）
  const handlePushMenu = async () => {
    onClose();
    if (gitRepos.length === 0) return;

    type RepoRemoteItem = { id: string; repoId: string; remote?: string; label: string; description: string };
    const items: RepoRemoteItem[] = [];

    for (const r of gitRepos) {
      let repoRemotes = (remotes[r.meta.id] ?? []).map((rm) => rm.name);
      if (repoRemotes.length === 0) {
        try {
          const wid = snapshot?.workspace.id;
          if (wid) {
            const values = await bridge.request<Array<{ name: string }>>({
              type: 'remotes',
              payload: { workspace_id: wid, repo_id: r.meta.id },
            });
            repoRemotes = (values ?? []).map((v) => v.name);
          }
        } catch {
          // ignore error
        }
      }
      const targets = repoRemotes.length > 0 ? repoRemotes : [undefined];
      for (const remote of targets) {
        items.push({
          id: `${r.meta.id}:::${remote ?? ''}`,
          repoId: r.meta.id,
          remote,
          label: r.meta.name,
          description: remote ? `→ ${remote}` : t('No remote — configure or publish'),
        });
      }
    }

    if (items.length === 0) {
      const confirmed = await confirmDialog({
        title: t('Push'),
        message: t('VersionDock: No remotes configured in any repository. Open Remote Manager to configure or publish?'),
        confirmLabel: t('Manage Remotes…'),
      });
      if (confirmed && gitRepos.length > 0) {
        openRemoteManager(gitRepos[0].meta.id);
      }
      return;
    }

    let pickedId: string | null = null;
    if (items.length === 1) {
      pickedId = items[0].id;
    } else {
      pickedId = await choiceDialog({
        title: t('Push: Select Repository and Remote'),
        message: t('Choose target repository and remote to push to:'),
        choices: items.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          icon: 'cloud-upload',
        })),
      });
    }

    if (!pickedId) return;
    const selectedItem = items.find((item) => item.id === pickedId);
    if (!selectedItem) return;

    if (!selectedItem.remote) {
      const confirmed = await confirmDialog({
        title: t('Publish Repository'),
        message: t('VersionDock [{0}]: No remotes configured. Would you like to configure remotes or publish this repository?', selectedItem.label),
        confirmLabel: t('Manage Remotes…'),
      });
      if (confirmed) {
        openRemoteManager(selectedItem.repoId);
      }
      return;
    }

    await sync(selectedItem.repoId, 'push', true, { remote: selectedItem.remote });
    await refresh(true);
  };

  // 全局动作：新建分支（对齐插件版 5 步流程：分支名 -> 基准分支 -> 目标仓库多选 -> 是否检出）
  const handleNewBranch = async () => {
    onClose();
    // 步骤 1：分支名
    const branchName = await promptDialog({
      title: t('New Branch — Name'),
      message: t('Enter the new branch name:'),
      inputLabel: t('Branch Name'),
    });
    if (!branchName) return;
    const sanitized = sanitizeBranchName(branchName.trim());
    if (!sanitized) return;

    // 步骤 2：基准分支
    const allLocalBranches = new Set<string>();
    gitRepos.forEach((r) => {
      const bList = branchesByRepo[r.meta.id] ?? [];
      bList.filter((b) => !b.remote).forEach((b) => allLocalBranches.add(b.name));
    });
    const uniqueBaseNames = Array.from(allLocalBranches).sort();
    const currentHeads = Array.from(new Set(gitRepos.map((r) => r.branch).filter(Boolean)));
    const currentLabel = currentHeads.length > 0 ? currentHeads.join(', ') : 'current branch';

    const BASE_CURRENT = '__current__';
    const baseChoices = [
      { id: BASE_CURRENT, label: currentLabel, description: t('Current HEAD of each repo'), icon: 'git-branch' },
      ...uniqueBaseNames.map((n) => {
        const repoCount = gitRepos.filter((r) => (branchesByRepo[r.meta.id] ?? []).some((b) => b.name === n)).length;
        return {
          id: n,
          label: n,
          description: t('Available in {0} repositories', repoCount),
          icon: 'git-branch',
        };
      }),
    ];
    const pickedBase = await choiceDialog({
      title: t('New Branch — Base'),
      message: t('Select the base branch:'),
      choices: baseChoices,
    });
    if (!pickedBase) return;
    const baseFrom = pickedBase === BASE_CURRENT ? null : pickedBase;

    // 步骤 3：目标仓库（基准分支若为特定分支，则限定在包含该分支的仓库中；支持任意子集多选）
    const candidateRepos = baseFrom
      ? gitRepos.filter((r) => (branchesByRepo[r.meta.id] ?? []).some((b) => b.name === baseFrom))
      : gitRepos;

    if (candidateRepos.length === 0) {
      await confirmDialog({
        title: t('New Branch'),
        message: t('Base branch "{0}" does not exist in any repository.', baseFrom ?? ''),
        confirmLabel: t('OK'),
      });
      return;
    }

    let targetRepos = candidateRepos;
    if (candidateRepos.length > 1) {
      const pickedRepoIds = await multiChoiceDialog({
        title: t('New Branch — Repositories'),
        message: t('Select repositories to create the branch in:'),
        choices: candidateRepos.map((r) => ({
          id: r.meta.id,
          label: r.meta.name,
          description: r.meta.rootPath,
          icon: r.meta.isSubmodule ? 'package' : 'root-folder',
        })),
        initialSelected: candidateRepos.map((r) => r.meta.id),
      });
      if (!pickedRepoIds || pickedRepoIds.length === 0) return;
      targetRepos = candidateRepos.filter((r) => pickedRepoIds.includes(r.meta.id));
    }

    // 步骤 4：是否立即检出
    const checkoutChoice = await choiceDialog({
      title: t('New Branch — Checkout?'),
      message: t('Do you want to switch to the new branch immediately?'),
      choices: [
        { id: 'yes', label: t('Yes, checkout immediately'), icon: 'check' },
        { id: 'no', label: t('No, just create the branch'), icon: 'close' },
      ],
    });
    if (!checkoutChoice) return;
    const shouldCheckout = checkoutChoice === 'yes';

    // 步骤 5：执行分支创建
    const results = await Promise.allSettled(
      targetRepos.map((r) =>
        branchOperation(
          { type: 'create', name: sanitized, from: baseFrom, checkout: shouldCheckout },
          r.meta.id
        )
      )
    );
    if (shouldCheckout) {
      results.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value?.completed) {
          markRecentBranch(targetRepos[i].meta.id, sanitized);
        }
      });
    }
    await refresh(true);
  };

  // 解析拉取更新策略（遵循设置中的 updateProjectMethod）
  const resolvePullAction = async (isCurrent: boolean): Promise<'pull' | 'pullRebase' | null> => {
    if (!isCurrent) return 'pull';
    const currentSettings = useAppStore.getState().bootstrap?.state.settings;
    const updateMethod = currentSettings?.updateProjectMethod ?? 'rebase';
    if (updateMethod === 'prompt') {
      const selected = await choiceDialog({
        title: t('Update Project — Strategy'),
        message: t('Choose how incoming Git changes are integrated.'),
        choices: [
          { id: 'rebase', label: t('Rebase the current branch on top of incoming changes'), icon: 'repo-forked' },
          { id: 'merge', label: t('Merge incoming changes into the current branch'), icon: 'git-merge' },
        ],
      });
      if (!selected) return null;
      return selected === 'rebase' ? 'pullRebase' : 'pull';
    }
    return updateMethod === 'rebase' ? 'pullRebase' : 'pull';
  };

  // 单仓库新建分支（对齐插件版 newBranchSingleRepo，支持指定默认 base 或从列表挑选，并询问是否立即检出）
  const handleNewBranchInSingleRepo = async (repo: RepositoryStatus, defaultBase?: string | null) => {
    const name = await promptDialog({
      title: t('New Branch in {0}', repo.meta.name),
      message: t('Enter new branch name:'),
      inputLabel: t('Branch Name'),
    });
    if (!name) return;
    const sanitized = sanitizeBranchName(name);
    if (!sanitized) return;

    let baseFrom = defaultBase;
    if (baseFrom === undefined) {
      const repoBranches = branchesByRepo[repo.meta.id] ?? [];
      const localBranches = repoBranches.filter((b) => !b.remote);
      const currentBranch = localBranches.find((b) => b.current);
      const choices = [
        { id: '__current__', label: currentBranch?.name ?? 'HEAD', description: t('Current HEAD'), icon: 'git-branch' },
        ...localBranches
          .filter((b) => b.name !== currentBranch?.name)
          .map((b) => ({ id: b.name, label: b.name, icon: 'git-branch' })),
      ];
      const basePick = await choiceDialog({
        title: t('New Branch in {0} — Base', repo.meta.name),
        message: t('Select the base branch:'),
        choices,
      });
      if (!basePick) return;
      baseFrom = basePick === '__current__' ? null : basePick;
    }

    const checkoutChoice = await choiceDialog({
      title: t('New Branch in {0} — Checkout?', repo.meta.name),
      message: t('Do you want to switch to the new branch immediately?'),
      choices: [
        { id: 'yes', label: t('Yes, checkout immediately'), icon: 'check' },
        { id: 'no', label: t('No, just create the branch'), icon: 'close' },
      ],
    });
    if (!checkoutChoice) return;
    const shouldCheckout = checkoutChoice === 'yes';

    const res = await branchOperation(
      { type: 'create', name: sanitized, from: baseFrom, checkout: shouldCheckout },
      repo.meta.id
    );
    if (shouldCheckout && res?.completed) {
      markRecentBranch(repo.meta.id, sanitized);
    }
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
  const activeSubmoduleTarget = resolveSubmoduleOperationTarget(repositories, activeSubmenuRepoId);
  const activeSubmoduleParent = activeSubmoduleTarget?.parent;
  const activeSubmodulePath = activeSubmoduleTarget?.path;
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
  const gitCurrentBranches = useMemo(() => {
    return gitRepos.map((r) => {
      const list = branchesByRepo[r.meta.id] ?? [];
      return list.find((b) => b.current);
    });
  }, [branchesByRepo, gitRepos]);
  const hasNoUpstream = useMemo(() => {
    return gitCurrentBranches.some((b) => Boolean(b && !b.upstream));
  }, [gitCurrentBranches]);
  const hasUnpushed = totalAhead > 0 || hasNoUpstream;
  const isMixedWorkspace = useMemo(() => isMixedRepoWorkspace(repositories), [repositories]);

  return (
    <>
      {/* ──────────────── 1. 一级主菜单面板 ──────────────── */}
      {!repoOnly && (
        <div
          ref={popoverRef}
          className="statusbar-popover branch-menu-popover"
          style={{
            ...popoverStyle,
            ...(ignoreManagerRepoId ? { display: 'none' } : {}),
          }}
        >
        <div className="statusbar-popover-content">
          {/* 冲突处理 */}
          {(conflictRepos.length > 0 || operationRepos.length > 0) && (
            <div className="statusbar-menu-section warning-section">
              {conflictRepos.length > 0 && <button
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
                </button>}
              {operationRepos.map((repo) => {
                const op = repo.operation ?? 'merge';
                const { title, description, confirmMessage } = getAbortOperationLabels(op, repo.meta.name, t);
                return (
                  <button
                    key={repo.meta.id}
                    type="button"
                    className="statusbar-menu-item danger-sub"
                    onClick={async () => {
                      onClose();
                      const confirmed = await confirmDialog({
                        title,
                        message: confirmMessage,
                        danger: true,
                      });
                      if (confirmed) {
                        await abortRepositoryOperation(repo.meta.id, op);
                        await refresh(true);
                      }
                    }}
                  >
                    <Codicon name="error" />
                    <div className="statusbar-menu-item-text">
                      <span className="statusbar-menu-item-title">{title} ({repo.meta.name})</span>
                      {description && <span className="statusbar-menu-item-desc">{description}</span>}
                    </div>
                  </button>
                );
              })}
              <div className="statusbar-menu-divider" />
            </div>
          )}

          {/* 分支分歧警告（对齐原版 Branches have diverged） */}
          {showDivergedWarning && (
            <div className="statusbar-menu-section warning-section">
              <div className="statusbar-menu-item warning non-clickable" role="status">
                <Codicon name="warning" />
                <div className="statusbar-menu-item-text">
                  <span className="statusbar-menu-item-title">{t('Branches have diverged')}</span>
                  <span className="statusbar-menu-item-desc">{t('Repositories are not on the same branch')}</span>
                </div>
              </div>
              <div className="statusbar-menu-divider" />
            </div>
          )}

          {/* 空仓库引导 */}
          {repositories.length === 0 && (
            <div className="statusbar-menu-section">
              {initializeAvailable && (
                <button
                  type="button"
                  className="statusbar-menu-item"
                  onClick={async () => {
                    onClose();
                    if (!snapshot) return;
                    const paths = snapshot.workspace.paths ?? [];
                    const target = paths.length === 1
                      ? paths[0]
                      : await choiceDialog({
                          title: t('Initialize Git Repository…'),
                          message: t('Select the workspace root to initialize.'),
                          choices: paths.map((path) => ({ id: path, label: path, icon: 'folder' })),
                        });
                    if (target) {
                      await initializeRepository(target);
                    }
                  }}
                >
                  <Codicon name="repo-create" />
                  <div className="statusbar-menu-item-text">
                    <span className="statusbar-menu-item-title">{t('Initialize Git Repository…')}</span>
                    <span className="statusbar-menu-item-desc">{t('Initialize a new Git repository in the current workspace')}</span>
                  </div>
                </button>
              )}
              <button
                type="button"
                className="statusbar-menu-item"
                onClick={() => {
                  onClose();
                  void refresh(true);
                }}
              >
                <Codicon name="refresh" />
                <div className="statusbar-menu-item-text">
                  <span className="statusbar-menu-item-title">{t('Reload Repositories')}</span>
                  <span className="statusbar-menu-item-desc">{t('Re-scan workspace folders for Git and SVN repositories')}</span>
                </div>
              </button>
            </div>
          )}

          {/* 全局动作 */}
          {repositories.length > 0 && (
            <div className="statusbar-menu-section">
              {gitRepos.length > 0 && (
                <button type="button" className="statusbar-menu-item" onClick={handleFetchAll}>
                  <Codicon name="sync" />
                  <div className="statusbar-menu-item-text">
                    <span className="statusbar-menu-item-title">{t('Fetch All')}</span>
                    <span className="statusbar-menu-item-desc">{t('Fetch all branches and tags from remote repositories')}</span>
                  </div>
                </button>
              )}

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
                <button type="button" className="statusbar-menu-item" onClick={handlePushMenu}>
                  <Codicon name={hasUnpushed ? 'arrow-up' : 'cloud-upload'} />
                  <div className="statusbar-menu-item-text">
                    <span className="statusbar-menu-item-title">{t('Push…')}</span>
                    <span className="statusbar-menu-item-desc">
                      {hasUnpushed
                        ? totalAhead > 0
                          ? t('Push commits to remote ({0} to push)', totalAhead)
                          : t('Push commits to remote (branch not on remote)')
                        : hasNoUpstream
                          ? t('Some branches have no upstream set')
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
        )}

          <div className="statusbar-menu-divider" />

          {/* PROJECTS 项目列表 */}
          {repositories.length > 0 && (
            <div className="statusbar-menu-section">
              <div className="statusbar-menu-group-header">{t('PROJECTS')}</div>
              {repositories.map((repo) => {
                const isSelected = repo.meta.id === activeSubmenuRepoId;
                const ahead = repo.ahead ?? 0;
                const behind = repo.behind ?? 0;
                const effectiveRef = getRepoEffectiveRef(repo, branchesByRepo);
                const refIcon = getRepoRefIcon(repo, branchesByRepo);
                const opLabel = formatRepoOperationLabel(repo.operation, t);
                const repoDisplayName = formatRepoDisplayName(repo.meta.name, repo.meta.kind, isMixedWorkspace);
                const isActive = repositories.length > 1 && repo.meta.id === selectedRepoId;

                return (
                  <button
                    key={repo.meta.id}
                    type="button"
                    className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''}`}
                    onClick={(e) => handleOpenRepoSubmenu(repo, e)}
                  >
                    <Codicon name={repo.meta.isSubmodule ? 'package' : 'root-folder'} />
                    <div className="statusbar-menu-item-text">
                      <span className="statusbar-menu-item-title">{repoDisplayName}</span>
                      <span className="statusbar-menu-item-desc">
                        <Codicon name={refIcon} /> <span>{effectiveRef}</span>
                        {opLabel && <em className="statusbar-repo-op-label">{opLabel}</em>}
                        {ahead > 0 && <span className="statusbar-push-label"> ↑{ahead}</span>}
                        {behind > 0 && <span className="statusbar-pull-label"> ↓{behind}</span>}
                        {isActive && (
                          <span className="statusbar-active-repo-badge">
                            <Codicon name="edit" /> {t('active')}
                          </span>
                        )}
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
              <div className="statusbar-menu-group-header">
                {gitRepos.length === 1 ? t('LOCAL BRANCHES') : t('COMMON LOCAL BRANCHES')}
              </div>
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
              <div className="statusbar-menu-group-header">
                {gitRepos.length === 1 ? t('REMOTE BRANCHES') : t('COMMON REMOTE BRANCHES')}
              </div>
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
              <div className="statusbar-menu-group-header">
                {gitRepos.length === 1 ? t('TAGS') : t('COMMON TAGS')}
              </div>
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
      )}

      {/* ──────────────── 2. 二级菜单面板（仓库分支列表 / 公共分支动作 / 公共标签动作） ──────────────── */}
      {submenuPos && !ignoreManagerRepoId && (activeSubmenuRepo || activeCommonBranch || activeCommonTag) && (
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
                  {activeSubmenuRepo.meta.kind === 'git' && (() => {
                    const repoBranches = branchesByRepo[activeSubmenuRepo.meta.id] ?? [];
                    const currentBranch = repoBranches.find((b) => b.current);
                    const isDetached = Boolean(
                      currentBranch?.detachedTag ||
                      currentBranch?.detachedHash ||
                      activeSubmenuRepo.branch === 'HEAD' ||
                      activeSubmenuRepo.branch?.startsWith('HEAD (')
                    );
                    const effectiveRef = getRepoEffectiveRef(activeSubmenuRepo, branchesByRepo);

                    return (
                      <>
                        {isDetached && (
                          <>
                            <button
                              type="button"
                              className="statusbar-menu-item"
                              onClick={async () => {
                                onClose();
                                await handleNewBranchInSingleRepo(activeSubmenuRepo, null);
                              }}
                            >
                              <Codicon name="plus" />
                              <div className="statusbar-menu-item-text">
                                <span className="statusbar-menu-item-title">
                                  {t('Create Branch from HEAD ({0})…', effectiveRef)}
                                </span>
                                <span className="statusbar-menu-item-desc">
                                  {t('Fix detached HEAD — create a branch to safely commit changes')}
                                </span>
                              </div>
                            </button>
                            <div className="statusbar-menu-divider" />
                          </>
                        )}

                        <button
                          type="button"
                          className="statusbar-menu-item"
                          onClick={async () => {
                            onClose();
                            await handleNewBranchInSingleRepo(activeSubmenuRepo);
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

                      {isAbortableVcsOperation(activeSubmenuRepo.operation) && (() => {
                        const op = activeSubmenuRepo.operation;
                        const { title, description, confirmMessage } = getAbortOperationLabels(
                          op,
                          activeSubmenuRepo.meta.name,
                          t
                        );
                        return (
                          <button
                            type="button"
                            className="statusbar-menu-item danger"
                            onClick={async () => {
                              onClose();
                              const confirmed = await confirmDialog({
                                title,
                                message: confirmMessage,
                                danger: true,
                              });
                              if (confirmed) {
                                await abortRepositoryOperation(activeSubmenuRepo.meta.id, op);
                                await refresh(true);
                              }
                            }}
                          >
                            <Codicon name="error" />
                            <div className="statusbar-menu-item-text">
                              <span className="statusbar-menu-item-title">{title}</span>
                              {description && <span className="statusbar-menu-item-desc">{description}</span>}
                            </div>
                          </button>
                        );
                      })()}
                      </>
                    );
                  })()}

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

                      {(activeSubmenuRepo.conflicts > 0 || (activeSubmenuRepo.files ?? []).some((f) => f.status === 'conflicted')) && (
                        <>
                          <button
                            type="button"
                            className="statusbar-menu-item"
                            onClick={() => {
                              onClose();
                              setActiveTab('changes');
                            }}
                          >
                            <Codicon name="git-merge" />
                            <span>{t('Resolve Conflicts')}</span>
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

                          <button
                            type="button"
                            className="statusbar-menu-item"
                            onClick={async () => {
                              onClose();
                              const conflictedFiles = (activeSubmenuRepo.files ?? []).filter(
                                (f) => f.status === 'conflicted'
                              );
                              let targetPath: string | null = null;
                              if (conflictedFiles.length === 1) {
                                targetPath = conflictedFiles[0].path;
                              } else if (conflictedFiles.length > 1) {
                                const picked = await choiceDialog({
                                  title: t('Mark Resolved (Working)…'),
                                  message: t('Select a conflicted file:'),
                                  choices: conflictedFiles.map((f) => ({
                                    id: f.path,
                                    label: f.path,
                                    icon: 'file',
                                  })),
                                });
                                targetPath = picked ?? null;
                              } else {
                                targetPath = await promptDialog({
                                  title: t('Mark Resolved (Working)…'),
                                  message: t('Enter file path relative to repository root:'),
                                  inputLabel: t('File Path'),
                                });
                              }
                              if (targetPath?.trim()) {
                                await svnOperation(activeSubmenuRepo.meta.id, {
                                  type: 'resolveWorking',
                                  paths: [targetPath.trim()],
                                });
                                await refresh(true);
                              }
                            }}
                          >
                            <Codicon name="check" />
                            <span>{t('Mark Resolved (Working)…')}</span>
                          </button>
                        </>
                      )}

                      <div className="statusbar-menu-divider" />

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
                            include_externals: true,
                          });
                          await refresh(true);
                        }}
                      >
                        <Codicon name="tools" />
                        <span>{t('SVN Cleanup')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          const filePath = await promptDialog({
                            title: t('SVN Lock'),
                            message: t('Enter file path relative to repository root:'),
                            inputLabel: t('File Path'),
                          });
                          if (!filePath?.trim()) return;
                          const message = await promptDialog({
                            title: t('SVN Lock'),
                            message: filePath.trim(),
                            inputLabel: t('Lock message'),
                            initialValue: t('Locked from VersionDock'),
                          });
                          if (message !== null) {
                            await svnOperation(activeSubmenuRepo.meta.id, {
                              type: 'lock',
                              paths: [filePath.trim()],
                              message: message.trim() || null,
                              force: false,
                            });
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="lock" />
                        <span>{t('SVN Lock')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          const filePath = await promptDialog({
                            title: t('SVN Unlock'),
                            message: t('Enter file path relative to repository root:'),
                            inputLabel: t('File Path'),
                          });
                          if (filePath?.trim()) {
                            await svnOperation(activeSubmenuRepo.meta.id, {
                              type: 'unlock',
                              paths: [filePath.trim()],
                              force: false,
                            });
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="unlock" />
                        <span>{t('SVN Unlock')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          const directory = await promptDialog({
                            title: t('Manage SVN Ignore...'),
                            message: t('Enter directory path relative to repository root (leave empty for root):'),
                            inputLabel: t('Directory Path'),
                            initialValue: '',
                          });
                          if (directory === null) return;
                          const cleanDir = directory.trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
                          if (onManageIgnore) {
                            onManageIgnore(activeSubmenuRepo.meta.id, cleanDir);
                          } else {
                            setIgnoreManagerTarget({ repoId: activeSubmenuRepo.meta.id, directory: cleanDir });
                          }
                        }}
                      >
                        <Codicon name="exclude" />
                        <span>{t('Manage SVN Ignore...')}</span>
                      </button>

                      <div className="statusbar-menu-divider" />

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          const fromUrl = await promptDialog({
                            title: t('SVN Relocate'),
                            message: t('Old repository root URL:'),
                            inputLabel: t('From URL'),
                            initialValue: '',
                          });
                          if (!fromUrl?.trim()) return;
                          const toUrl = await promptDialog({
                            title: t('SVN Relocate'),
                            message: t('New repository root URL:'),
                            inputLabel: t('To URL'),
                            initialValue: fromUrl.trim(),
                          });
                          if (toUrl?.trim()) {
                            await svnOperation(activeSubmenuRepo.meta.id, {
                              type: 'relocate',
                              from_url: fromUrl.trim(),
                              to_url: toUrl.trim(),
                            });
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="link" />
                        <span>{t('SVN Relocate…')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          const url = await promptDialog({
                            title: t('SVN Switch'),
                            message: t('Working copy target URL, for example ^/branches/release:'),
                            inputLabel: t('URL'),
                            initialValue: '^/trunk',
                          });
                          if (url?.trim()) {
                            await svnOperation(activeSubmenuRepo.meta.id, {
                              type: 'switch',
                              url: url.trim(),
                              revision: null,
                              ignore_ancestry: false,
                            });
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="git-branch" />
                        <span>{t('SVN Switch…')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          const sourceUrl = await promptDialog({
                            title: t('Create SVN Branch'),
                            message: t('Source repository URL:'),
                            inputLabel: t('Source URL'),
                            initialValue: '^/trunk',
                          });
                          if (!sourceUrl?.trim()) return;
                          const destinationUrl = await promptDialog({
                            title: t('Create SVN Branch'),
                            message: t('Destination repository URL:'),
                            inputLabel: t('Destination URL'),
                            initialValue: '^/branches/',
                          });
                          if (!destinationUrl?.trim()) return;
                          const copyMessage = await promptDialog({
                            title: t('SVN Copy Commit'),
                            message: `${sourceUrl.trim()}\n→ ${destinationUrl.trim()}`,
                            inputLabel: t('Commit message'),
                            initialValue: t('Create branch'),
                          });
                          if (copyMessage?.trim()) {
                            await svnOperation(activeSubmenuRepo.meta.id, {
                              type: 'copy',
                              source_url: sourceUrl.trim(),
                              destination_url: destinationUrl.trim(),
                              revision: null,
                              message: copyMessage.trim(),
                            });
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="git-branch" />
                        <span>{t('SVN Create Branch…')}</span>
                      </button>

                      <button
                        type="button"
                        className="statusbar-menu-item"
                        onClick={async () => {
                          onClose();
                          const sourceUrl = await promptDialog({
                            title: t('Create SVN Tag'),
                            message: t('Source repository URL:'),
                            inputLabel: t('Source URL'),
                            initialValue: '^/trunk',
                          });
                          if (!sourceUrl?.trim()) return;
                          const destinationUrl = await promptDialog({
                            title: t('Create SVN Tag'),
                            message: t('Destination repository URL:'),
                            inputLabel: t('Destination URL'),
                            initialValue: '^/tags/',
                          });
                          if (!destinationUrl?.trim()) return;
                          const copyMessage = await promptDialog({
                            title: t('SVN Copy Commit'),
                            message: `${sourceUrl.trim()}\n→ ${destinationUrl.trim()}`,
                            inputLabel: t('Commit message'),
                            initialValue: t('Create tag'),
                          });
                          if (copyMessage?.trim()) {
                            await svnOperation(activeSubmenuRepo.meta.id, {
                              type: 'copy',
                              source_url: sourceUrl.trim(),
                              destination_url: destinationUrl.trim(),
                              revision: null,
                              message: copyMessage.trim(),
                            });
                            await refresh(true);
                          }
                        }}
                      >
                        <Codicon name="tag" />
                        <span>{t('SVN Create Tag…')}</span>
                      </button>
                    </>
                  )}
                </div>

                <div className="statusbar-menu-divider" />

                {/* 近期分支列表 RECENT */}
                {(() => {
                  const recentNames = getRecentBranches(activeSubmenuRepo.meta.id);
                  const localBranches = activeRepoBranches.filter((b) => !b.remote);
                  const validRecentBranches = recentNames
                    .map((name) => localBranches.find((b) => b.name === name))
                    .filter((b): b is NonNullable<typeof b> => Boolean(b && !b.current && b.name !== activeSubmenuRepo.branch));

                  if (validRecentBranches.length === 0) return null;

                  return (
                    <div className="statusbar-menu-section">
                      <div className="statusbar-menu-group-header">{t('RECENT')}</div>
                      {validRecentBranches.map((b) => {
                        const isSelected =
                          activeBranchAction?.repoId === activeSubmenuRepo.meta.id &&
                          activeBranchAction?.branchName === b.name;
                        const ahead = b.ahead ?? 0;
                        const behind = b.behind ?? 0;
                        const commitDetail = b.lastCommitMessage
                          ? `${b.lastCommitMessage}${b.lastCommitDate ? ` · ${b.lastCommitDate}` : ''}`
                          : undefined;

                        return (
                          <button
                            key={`recent-${b.name}`}
                            type="button"
                            className={`statusbar-menu-item has-submenu ${isSelected ? 'selected' : ''}`}
                            onClick={(e) =>
                              handleOpenBranchActionMenu(
                                activeSubmenuRepo.meta.id,
                                b.name,
                                false,
                                false,
                                e
                              )
                            }
                          >
                            <Codicon name="history" />
                            <div className="statusbar-menu-item-text">
                              <span className="statusbar-menu-item-title">{b.name}</span>
                              {(ahead > 0 || behind > 0) && (
                                <span className="statusbar-menu-item-desc">
                                  {ahead > 0 && <span className="statusbar-push-label"> ↑{ahead}</span>}
                                  {behind > 0 && <span className="statusbar-pull-label"> ↓{behind}</span>}
                                </span>
                              )}
                              {commitDetail && (
                                <div className="statusbar-menu-item-detail">
                                  <Codicon name="git-commit" />
                                  <span>{commitDetail}</span>
                                </div>
                              )}
                            </div>
                            <Codicon name="chevron-right" className="submenu-arrow" />
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}

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
                        const commitDetail = b.lastCommitMessage
                          ? `${b.lastCommitMessage}${b.lastCommitDate ? ` · ${b.lastCommitDate}` : ''}`
                          : undefined;

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
                              {commitDetail && (
                                <div className="statusbar-menu-item-detail">
                                  <Codicon name="git-commit" />
                                  <span>{commitDetail}</span>
                                </div>
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
                        const commitDetail = b.lastCommitMessage
                          ? `${b.lastCommitMessage}${b.lastCommitDate ? ` · ${b.lastCommitDate}` : ''}`
                          : undefined;
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
                              {commitDetail && (
                                <div className="statusbar-menu-item-detail">
                                  <Codicon name="git-commit" />
                                  <span>{commitDetail}</span>
                                </div>
                              )}
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
                      const activeCurrentBranch = activeRepoBranches.find((b) => b.current);
                      const isCurrentTag =
                        activeCurrentBranch?.detachedTag === tag.name ||
                        activeSubmenuRepo.branch === tag.name;
                      return (
                        <button
                          key={tag.name}
                          type="button"
                          className={`statusbar-menu-item has-submenu ${isCurrentTag ? 'active-ref' : ''} ${isSelected ? 'selected' : ''}`}
                          onClick={(e) =>
                            handleOpenTagActionMenu(activeSubmenuRepo.meta.id, tag.name, isCurrentTag, e)
                          }
                        >
                          <Codicon name={isCurrentTag ? 'check' : 'tag'} />
                          <div className="statusbar-menu-item-text">
                            <span className="statusbar-menu-item-title">{tag.name}</span>
                            {isCurrentTag && <span className="statusbar-menu-item-desc">{t('current')}</span>}
                          </div>
                          <Codicon name="chevron-right" className="submenu-arrow" />
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Submodule 分组（对齐原版 showRepoBranchMenu） */}
                {activeSubmenuRepo.meta.isSubmodule && activeSubmoduleParent && activeSubmodulePath && (
                  <div className="statusbar-menu-section">
                    <div className="statusbar-menu-group-header">{t('SUBMODULE')}</div>
                    <button
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await submoduleOperation(activeSubmoduleParent.meta.id, {
                          type: 'update',
                          path: activeSubmodulePath,
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
                        await submoduleOperation(activeSubmoduleParent.meta.id, {
                          type: 'update',
                          path: activeSubmodulePath,
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
                        await submoduleOperation(activeSubmoduleParent.meta.id, {
                          type: 'init',
                          path: activeSubmodulePath,
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
                          await submoduleOperation(activeSubmoduleParent.meta.id, {
                            type: 'deinit',
                            path: activeSubmodulePath,
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
                        await bridge.openInNewWindow([activeSubmenuRepo.meta.rootPath]);
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
                    const targetBranch = activeCommonBranch.name;
                    const settled = await Promise.allSettled(
                      gitRepos.map((r) => branchOperation({ type: 'checkout', name: targetBranch }, r.meta.id))
                    );
                    settled.forEach((res, idx) => {
                      if (res.status === 'fulfilled' && res.value?.completed) {
                        markRecentBranch(gitRepos[idx].meta.id, targetBranch);
                      }
                    });
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
                    if (!newName) return;
                    const sanitized = sanitizeBranchName(newName);
                    if (!sanitized) return;

                    const checkoutChoice = await choiceDialog({
                      title: t('New Branch — Checkout?'),
                      message: t('Do you want to switch to the new branch immediately?'),
                      choices: [
                        { id: 'yes', label: t('Yes, checkout immediately'), icon: 'check' },
                        { id: 'no', label: t('No, just create the branch'), icon: 'close' },
                      ],
                    });
                    if (!checkoutChoice) return;
                    const shouldCheckout = checkoutChoice === 'yes';

                    const results = await Promise.allSettled(
                      gitRepos.map((r) =>
                        branchOperation(
                          { type: 'create', name: sanitized, from: activeCommonBranch.name, checkout: shouldCheckout },
                          r.meta.id
                        )
                      )
                    );
                    if (shouldCheckout) {
                      results.forEach((res, i) => {
                        if (res.status === 'fulfilled' && res.value?.completed) {
                          markRecentBranch(gitRepos[i].meta.id, sanitized);
                        }
                      });
                    }
                    await refresh(true);
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
                        const hasCurrentGit = gitRepos.some((r) =>
                          (branchesByRepo[r.meta.id] ?? []).some((b) => b.name === activeCommonBranch.name && b.current)
                        );
                        const currentAction = await resolvePullAction(hasCurrentGit);
                        if (!currentAction) return;
                        await Promise.allSettled(
                          gitRepos.map((r) => {
                            const isRepoCurrent = (branchesByRepo[r.meta.id] ?? []).some(
                              (b) => b.name === activeCommonBranch.name && b.current
                            );
                            return sync(r.meta.id, isRepoCurrent ? currentAction : 'pull', true, {
                              branch: activeCommonBranch.name,
                            });
                          })
                        );
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
                      onClick={async () => {
                        onClose();
                        if (gitRepos.length === 0) return;
                        const candidateRepos = gitRepos.filter((r) => {
                          const list = branchesByRepo[r.meta.id] ?? [];
                          return list.some((b) => b.name === activeCommonBranch.name);
                        });
                        const targetPool = candidateRepos.length > 0 ? candidateRepos : gitRepos;
                        const wid = snapshot?.workspace.id ?? '';
                        // 对齐插件版 compareBranchAllRepos：对公共分支所在的所有仓库逐个执行比较，并收集各仓库比较结果及失败信息
                        const settled = await Promise.all(
                          targetPool.map(async (r) => {
                            try {
                              const result = await bridge.request<BranchCompareResult>({
                                type: 'branchCompare',
                                payload: {
                                  workspace_id: wid,
                                  repo_id: r.meta.id,
                                  base: getRepoCompareBase(r, branchesByRepo),
                                  target: activeCommonBranch.name,
                                },
                              });
                              return { repo: r, result, error: null };
                            } catch (err: unknown) {
                              const message = err instanceof Error ? err.message : String(err);
                              return { repo: r, result: null, error: message };
                            }
                          })
                        );

                        // 跨工作区异步竞态防御：若等待期间用户切换了工作区，立即终止，避免状态污染
                        if (useAppStore.getState().snapshot?.workspace.id !== wid) return;

                        const failed = settled.filter((item) => item.error);
                        const succeeded = settled.filter((item) => item.result);

                        // 构造多仓库比较摘要：展示各仓库差异文件数、提交数与失败信息
                        const summaryLines = settled.map(({ repo, result, error }) => {
                          if (error) {
                            return `${repo.meta.name}: ${error}`;
                          }
                          const fileCount = result?.files.length ?? 0;
                          const ahead = result?.baseCommits.length ?? 0;
                          const behind = result?.targetCommits.length ?? 0;
                          if (fileCount === 0 && ahead === 0 && behind === 0) {
                            return `${repo.meta.name}: ${t('identical')}`;
                          }
                          return `${repo.meta.name}: ${fileCount} ${t('files changed')} (+${ahead} / -${behind})`;
                        });

                        // 若为多仓库或存在失败，将比较结果和错误详情完整呈现，并提供各仓库比较的快捷切换动作
                        if (targetPool.length > 1 || failed.length > 0) {
                          const comparisonActions: AppNotificationAction[] = succeeded.map(({ repo }) => ({
                            type: 'openBranchComparison',
                            label: repo.meta.name,
                            repoId: repo.meta.id,
                            target: activeCommonBranch.name,
                          }));
                          addNotification({
                            type: failed.length > 0 ? (succeeded.length > 0 ? 'warning' : 'error') : 'info',
                            title: t("Compare '{0}' with '{1}'", currentCommonBranchName, activeCommonBranch.name),
                            message: { raw: summaryLines.join(' · ') },
                            details: summaryLines.join('\n'),
                            workspaceId: wid,
                            urgent: failed.length > 0,
                            actions: comparisonActions,
                          });
                        }

                        // 主界面联动呈现主仓库的分支比较视图（仅当存在成功仓库时打开，避免打开失败仓库重复报错）
                        const primaryRepo = (succeeded.find((item) => item.repo.meta.id === selectedRepoId) ?? succeeded[0])?.repo;
                        if (primaryRepo) {
                          if (primaryRepo.meta.id !== selectedRepoId) {
                            await selectRepo(primaryRepo.meta.id, false);
                          }
                          // 跨工作区异步竞态防御：防止 selectRepo 等待期间切换工作区导致的状态污染
                          if (useAppStore.getState().snapshot?.workspace.id !== wid) return;
                          openBranchComparison(primaryRepo.meta.id, activeCommonBranch.name);
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
                          gitRepos.map((r) => branchOperation({ type: 'rebase', name: activeCommonBranch.name }, r.meta.id))
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
                          gitRepos.map((r) => branchOperation({ type: 'merge', name: activeCommonBranch.name }, r.meta.id))
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
                          if (isBranchProtected(activeCommonBranch.name)) {
                            await confirmDialog({
                              title: t('Protected branch'),
                              message: t('VersionDock: Protected branch "{0}" cannot be deleted.', activeCommonBranch.name),
                              confirmLabel: t('OK'),
                            });
                            return;
                          }
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
                          gitRepos.map((r) => {
                            const branch = (branchesByRepo[r.meta.id] ?? []).find((item) => item.remote && item.name === activeCommonBranch.name);
                            return sync(r.meta.id, 'pullRebase', true, { remote: branch?.remoteName ?? activeCommonBranch.name.split('/')[0], branch: activeCommonBranch.name });
                          })
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
                          gitRepos.map((r) => {
                            const branch = (branchesByRepo[r.meta.id] ?? []).find((item) => item.remote && item.name === activeCommonBranch.name);
                            return sync(r.meta.id, 'pull', true, { remote: branch?.remoteName ?? activeCommonBranch.name.split('/')[0], branch: activeCommonBranch.name });
                          })
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

                {(() => {
                  const commonRemotes = Array.from(
                    new Set(gitRepos.flatMap((r) => (remotes[r.meta.id] ?? []).map((rm) => rm.name)))
                  );
                  if (commonRemotes.length === 0) return null;
                  return commonRemotes.map((remoteName) => (
                    <button
                      key={remoteName}
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        const targetRepos = gitRepos.filter((r) =>
                          (remotes[r.meta.id] ?? []).some((rm) => rm.name === remoteName)
                        );
                        await Promise.allSettled(
                          targetRepos.map((r) =>
                            tagOperation({ type: 'push', name: activeCommonTag, remote: remoteName }, r.meta.id)
                          )
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="cloud-upload" />
                      <span>{t('Push tag to "{0}"', remoteName)}</span>
                    </button>
                  ));
                })()}

                <button
                  type="button"
                  className="statusbar-menu-item danger"
                  onClick={async () => {
                    onClose();
                    const choice = await choiceDialog({
                      title: t("Delete tag '{0}'?", activeCommonTag),
                      message: gitRepos.length === 1
                        ? t('VersionDock [{0}]: Delete tag "{1}"?', gitRepos[0].meta.name, activeCommonTag)
                        : t('VersionDock: Delete tag "{0}" in {1} repositories?', activeCommonTag, gitRepos.length),
                      danger: true,
                      choices: [
                        { id: 'local', label: t('Delete Local'), icon: 'trash', danger: true },
                        { id: 'remote', label: t('Delete on Remote'), icon: 'cloud', danger: true },
                        { id: 'both', label: t('Delete Local and Remote'), icon: 'warning', danger: true },
                        { id: 'cancel', label: t('Cancel'), icon: 'close' },
                      ],
                    });
                    if (!choice || choice === 'cancel') return;
                    const deleteLocal = choice === 'local' || choice === 'both';
                    const deleteRemote = choice === 'remote' || choice === 'both';

                    await Promise.allSettled(
                      gitRepos.map(async (r) => {
                        if (deleteLocal) {
                          await tagOperation({ type: 'delete', name: activeCommonTag }, r.meta.id).catch(() => {});
                        }
                        if (deleteRemote) {
                          await loadRemotes(r.meta.id).catch(() => {});
                          const repoRemotes = useAppStore.getState().remotes[r.meta.id] ?? [];
                          for (const rem of repoRemotes) {
                            await tagOperation({ type: 'delete', name: activeCommonTag, remote: rem.name }, r.meta.id).catch(() => {});
                          }
                        }
                      })
                    );
                    await refresh(true);
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
      {actionMenuPos && !ignoreManagerRepoId && (activeBranchAction || activeTagAction) && (
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
                    const targetName = activeBranchAction.branchName;
                    const result = await branchOperation({ type: 'checkout', name: targetName }, activeBranchAction.repoId);
                    if (result?.completed) {
                      markRecentBranch(activeBranchAction.repoId, targetName);
                    }
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
                    if (!newBranch) return;
                    const sanitized = sanitizeBranchName(newBranch);
                    if (!sanitized) return;

                    const targetRepo = repositories.find((r) => r.meta.id === activeBranchAction.repoId);
                    const repoName = targetRepo?.meta.name ?? activeBranchAction.repoId;
                    const checkoutChoice = await choiceDialog({
                      title: t('New Branch in {0} — Checkout?', repoName),
                      message: t('Do you want to switch to the new branch immediately?'),
                      choices: [
                        { id: 'yes', label: t('Yes, checkout immediately'), icon: 'check' },
                        { id: 'no', label: t('No, just create the branch'), icon: 'close' },
                      ],
                    });
                    if (!checkoutChoice) return;
                    const shouldCheckout = checkoutChoice === 'yes';

                    const res = await branchOperation(
                      { type: 'create', name: sanitized, from: activeBranchAction.branchName, checkout: shouldCheckout },
                      activeBranchAction.repoId
                    );
                    if (shouldCheckout && res?.completed) {
                      markRecentBranch(activeBranchAction.repoId, sanitized);
                    }
                    await refresh(true);
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
                        const isCurrent = Boolean(
                          activeBranchAction.isCurrent ||
                          (branchesByRepo[activeBranchAction.repoId] ?? []).some(
                            (b) => b.name === activeBranchAction.branchName && b.current
                          )
                        );
                        const action = await resolvePullAction(isCurrent);
                        if (!action) return;
                        await sync(activeBranchAction.repoId, action, true, { branch: activeBranchAction.branchName });
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
                          const sanitized = sanitizeBranchName(newName);
                          if (sanitized) {
                            await branchOperation(
                              { type: 'rename', old_name: activeBranchAction.branchName, new_name: sanitized },
                              activeBranchAction.repoId
                            );
                            await refresh(true);
                          }
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
                      onClick={async () => {
                        onClose();
                        const wid = snapshot?.workspace.id ?? '';
                        if (selectedRepoId !== activeBranchAction.repoId) {
                          await selectRepo(activeBranchAction.repoId, false);
                        }
                        if (wid && useAppStore.getState().snapshot?.workspace.id !== wid) return;
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
                          if (isBranchProtected(activeBranchAction.branchName)) {
                            await confirmDialog({
                              title: t('Protected branch'),
                              message: t('VersionDock: Protected branch "{0}" cannot be deleted.', activeBranchAction.branchName),
                              confirmLabel: t('OK'),
                            });
                            return;
                          }
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
                        const branch = (branchesByRepo[activeBranchAction.repoId] ?? []).find((item) => item.remote && item.name === activeBranchAction.branchName);
                        await sync(activeBranchAction.repoId, 'pullRebase', true, { remote: branch?.remoteName ?? activeBranchAction.branchName.split('/')[0], branch: activeBranchAction.branchName });
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
                        const branch = (branchesByRepo[activeBranchAction.repoId] ?? []).find((item) => item.remote && item.name === activeBranchAction.branchName);
                        await sync(activeBranchAction.repoId, 'pull', true, { remote: branch?.remoteName ?? activeBranchAction.branchName.split('/')[0], branch: activeBranchAction.branchName });
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

                {(() => {
                  const repoBranches = branchesByRepo[activeTagAction.repoId] ?? [];
                  const currentBranch = repoBranches.find((b) => b.current);
                  const repo = repositories.find((r) => r.meta.id === activeTagAction.repoId);
                  const isDetached = Boolean(
                    activeTagAction.isCurrent ||
                    currentBranch?.detachedTag ||
                    currentBranch?.detachedHash ||
                    currentBranch?.name === 'HEAD' ||
                    repo?.branch.startsWith('HEAD')
                  );
                  if (isDetached) return null;
                  return (
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
                  );
                })()}

                {(() => {
                  const repoRemotes = (remotes[activeTagAction.repoId] ?? []).map((rm) => rm.name);
                  if (repoRemotes.length === 0) return null;
                  return repoRemotes.map((remoteName) => (
                    <button
                      key={remoteName}
                      type="button"
                      className="statusbar-menu-item"
                      onClick={async () => {
                        onClose();
                        await tagOperation(
                          { type: 'push', name: activeTagAction.tagName, remote: remoteName },
                          activeTagAction.repoId
                        );
                        await refresh(true);
                      }}
                    >
                      <Codicon name="cloud-upload" />
                      <span>{t('Push tag to "{0}"', remoteName)}</span>
                    </button>
                  ));
                })()}

                <button
                  type="button"
                  className="statusbar-menu-item danger"
                  onClick={async () => {
                    onClose();
                    const targetRepo = repositories.find((r) => r.meta.id === activeTagAction.repoId);
                    const repoName = targetRepo?.meta.name ?? activeTagAction.repoId;
                    const choice = await choiceDialog({
                      title: t("Delete tag '{0}'?", activeTagAction.tagName),
                      message: t('VersionDock [{0}]: Delete tag "{1}"?', repoName, activeTagAction.tagName),
                      danger: true,
                      choices: [
                        { id: 'local', label: t('Delete Local'), icon: 'trash', danger: true },
                        { id: 'remote', label: t('Delete on Remote'), icon: 'cloud', danger: true },
                        { id: 'both', label: t('Delete Local and Remote'), icon: 'warning', danger: true },
                        { id: 'cancel', label: t('Cancel'), icon: 'close' },
                      ],
                    });
                    if (!choice || choice === 'cancel') return;
                    const deleteLocal = choice === 'local' || choice === 'both';
                    const deleteRemote = choice === 'remote' || choice === 'both';

                    if (deleteRemote) {
                      const remote = await pickRemote(activeTagAction.repoId, t('Delete "{0}" from remote', activeTagAction.tagName));
                      if (remote) {
                        await tagOperation({ type: 'delete', name: activeTagAction.tagName, remote }, activeTagAction.repoId);
                      }
                    }
                    if (deleteLocal) {
                      await tagOperation({ type: 'delete', name: activeTagAction.tagName, remote: null }, activeTagAction.repoId);
                    }
                    await refresh(true);
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

      {ignoreManagerRepoId && (
        <div ref={ignorePanelRef}>
          <IgnoreRulesPanel
            key={`${ignoreManagerTarget?.repoId ?? ''}:${ignoreManagerTarget?.directory ?? ''}`}
            repoId={ignoreManagerTarget?.repoId ?? ''}
            directory={ignoreManagerTarget?.directory ?? ''}
            close={() => {
              setIgnoreManagerTarget(null);
              onClose();
            }}
          />
        </div>
      )}
    </>
  );
}
