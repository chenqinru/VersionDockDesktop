import { useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { isOperationActive, useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { BranchMenuPopover } from './BranchMenuPopover';
import { getRepoEffectiveRef } from './branchRef';
import { choiceDialog } from '../dialogService';
import { IgnoreRulesPanel } from '../IgnoreRulesPanel';

export function BranchStatusBarItem() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [ignoreTarget, setIgnoreTarget] = useState<{ repoId: string; directory: string } | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const snapshot = useAppStore((state) => state.snapshot);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const busy = useAppStore((state) => selectedRepoId ? isOperationActive(state.operations, {
    workspaceId: state.snapshot?.workspace.id,
    repositoryId: selectedRepoId,
    domain: ['branch', 'sync'],
  }) : false);

  const repositories = useMemo(() => snapshot?.repositories ?? [], [snapshot?.repositories]);
  const suppressDivergedWarning = bootstrap?.state.settings?.suppressDivergedWarning ?? false;

  const {
    headLabel,
    headIconName,
    hasUncommitted,
    hasConflicts,
    hasOngoingOperation,
    opLabel,
    totalConflicts,
    totalBehind,
    totalAhead,
    branchesDiverged,
  } = useMemo(() => {
    if (repositories.length === 0) {
      return {
        headLabel: t('No repo'),
        headIconName: 'git-branch',
        hasUncommitted: false,
        hasConflicts: false,
        hasOngoingOperation: false,
        opLabel: '',
        totalConflicts: 0,
        totalBehind: 0,
        totalAhead: 0,
        branchesDiverged: false,
      };
    }

    const nonWorktreeRepos = repositories.filter((r) => !r.meta.isWorktree);
    const targetRepos = nonWorktreeRepos.length > 0 ? nonWorktreeRepos : repositories;
    const targetGitRepos = targetRepos.filter((r) => r.meta.kind === 'git');

    // 只有顶层Git仓库（排除submodule和worktree）才用于判断分支是否分歧
    const topLevelGitRepos = targetGitRepos.filter((r) => !r.meta.isSubmodule);
    const topLevelEffectiveNames = Array.from(new Set(topLevelGitRepos.map((r) => getRepoEffectiveRef(r, branchesByRepo))));
    const isDiverged = topLevelGitRepos.length > 1 && topLevelEffectiveNames.length > 1;

    const ongoingOperations = targetGitRepos
      .map((r) => r.operation)
      .filter((op): op is NonNullable<(typeof targetGitRepos)[number]['operation']> => Boolean(op));
    const hasOngoingOperation = ongoingOperations.length > 0;
    const uniqueOngoingOps = Array.from(new Set(ongoingOperations));
    const opLabel = uniqueOngoingOps.length === 1
      ? uniqueOngoingOps[0] === 'merge'
        ? t('merging')
        : uniqueOngoingOps[0] === 'rebase'
        ? t('rebasing')
        : uniqueOngoingOps[0] === 'cherry-pick'
        ? t('cherry-picking')
        : t('reverting')
      : uniqueOngoingOps.join('/');
    const opSuffix = hasOngoingOperation ? ` (${opLabel})` : '';

    // 当前激活仓库排在首位
    const activeRepo = targetRepos.find((r) => r.meta.id === selectedRepoId);
    const activeRefName = activeRepo ? getRepoEffectiveRef(activeRepo, branchesByRepo) : undefined;
    let orderedNames = Array.from(new Set(targetRepos.map((r) => getRepoEffectiveRef(r, branchesByRepo))));
    if (activeRefName && orderedNames.includes(activeRefName)) {
      orderedNames = [activeRefName, ...orderedNames.filter((n) => n !== activeRefName)];
    }

    const worktreeRepos = nonWorktreeRepos.length > 0 ? repositories.filter((r) => r.meta.isWorktree) : [];
    const worktreeBranches = Array.from(new Set(worktreeRepos.map((r) => getRepoEffectiveRef(r, branchesByRepo))));
    let worktreeSuffix = '';
    if (worktreeBranches.length === 1) {
      worktreeSuffix = `  |  ${worktreeBranches[0]}`;
    } else if (worktreeBranches.length > 1) {
      worktreeSuffix = `  |  +${worktreeBranches.length} ${t('worktrees')}`;
    }

    const primaryName = orderedNames[0] ?? 'HEAD';
    const label = (orderedNames.length === 1
      ? primaryName
      : `${primaryName} +${orderedNames.length - 1}`) + worktreeSuffix + opSuffix;

    // 图标规则：在命名分支上用 git-branch，在 detached Tag 上用 tag，在 detached Hash 上用 git-commit
    const currentBranches = targetRepos.map((r) => (branchesByRepo[r.meta.id] ?? []).find((b) => b.current));
    const anyOnNamedBranch = targetRepos.some((r, idx) => {
      const b = currentBranches[idx];
      return (!b?.detachedTag && !b?.detachedHash && b?.name !== 'HEAD') && (r.branch && !r.branch.startsWith('HEAD'));
    });
    const anyOnTag = !anyOnNamedBranch && currentBranches.some((b) => Boolean(b?.detachedTag));
    const headIconName = anyOnNamedBranch ? 'git-branch' : anyOnTag ? 'tag' : 'git-commit';

    const uncommitted = repositories.some(
      (r) => (r.files?.length ?? 0) > 0
    );

    const conflictsCount = targetRepos.reduce((sum, r) => sum + (r.conflicts ?? 0), 0);
    const behindCount = targetRepos.reduce((sum, r) => sum + (r.behind ?? 0), 0);
    const aheadCount = targetGitRepos.reduce((sum, r) => sum + (r.ahead ?? 0), 0);

    return {
      headLabel: label,
      headIconName,
      hasUncommitted: uncommitted,
      hasConflicts: conflictsCount > 0,
      hasOngoingOperation,
      opLabel,
      totalConflicts: conflictsCount,
      totalBehind: behindCount,
      totalAhead: aheadCount,
      branchesDiverged: isDiverged,
    };
  }, [branchesByRepo, repositories, selectedRepoId, t]);

  const showDiverged = branchesDiverged && !suppressDivergedWarning;
  const isWarningBg = hasConflicts || hasOngoingOperation || showDiverged;

  const getStatusItemClasses = () => {
    const classes = ['statusbar-item', 'branch-status-item'];
    if (open) classes.push('active');
    if (isWarningBg) classes.push('warning-bg');
    else if (totalBehind > 0 && totalAhead > 0) classes.push('needs-sync');
    else if (totalBehind > 0) classes.push('has-behind');
    else if (totalAhead > 0) classes.push('has-ahead');
    else if (hasUncommitted) classes.push('has-dirty');
    return classes.join(' ');
  };

  const getTooltip = () => {
    const lines: string[] = [];
    if (hasOngoingOperation) lines.push(t('Operation in progress: {0}', opLabel));
    if (hasConflicts) lines.push(t('Merge conflicts in workspace ({0} files)', totalConflicts));
    if (showDiverged) lines.push(t('Branches have diverged across repositories'));
    if (hasUncommitted) lines.push(t('Uncommitted changes present'));
    if (totalAhead > 0) lines.push(t('{0} unpushed commits', totalAhead));
    if (totalBehind > 0) lines.push(t('{0} incoming commits', totalBehind));

    if (repositories.length > 1) {
      if (lines.length > 0) lines.push('──────────');
      for (const repo of repositories) {
        const parts: string[] = [];
        const ahead = repo.ahead ?? 0;
        const behind = repo.behind ?? 0;
        const conflicts = repo.conflicts ?? 0;
        const files = repo.files?.length ?? 0;
        if (behind > 0) parts.push(`↓${behind}`);
        if (ahead > 0) parts.push(`↑${ahead}`);
        if (conflicts > 0) parts.push(`${conflicts} ${t('conflicts')}`);
        if (files > 0) parts.push(`${files} ${t('changes')}`);
        const statusDetail = parts.length > 0 ? ` (${parts.join(', ')})` : ` (${t('Clean')})`;
        const branchDisplay = getRepoEffectiveRef(repo, branchesByRepo);
        lines.push(`${repo.meta.name}: ${branchDisplay}${statusDetail}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : t('VersionDock: Git/SVN Menu');
  };

  const isSingleSvn = repositories.length === 1 && repositories[0].meta.kind === 'svn';

  const handleClick = async () => {
    if (open) {
      setOpen(false);
      return;
    }

    const isOperating = () => {
      const s = useAppStore.getState();
      const wid = s.snapshot?.workspace.id;
      if (!wid) return false;
      return isOperationActive(s.operations, { workspaceId: wid });
    };

    if (isOperating()) {
      const choice = await choiceDialog({
        title: t('VersionDock'),
        message: t('VersionDock: A Git/VCS operation is currently in progress. Please wait for it to complete.'),
        choices: [
          { id: 'wait', label: t('Wait and Open Menu'), icon: 'loading' },
        ],
      });
      if (choice !== 'wait') {
        return;
      }

      let waited = 0;
      while (isOperating() && waited < 30000) {
        await new Promise((r) => setTimeout(r, 200));
        waited += 200;
      }
    }

    if (anchorRef.current) {
      setAnchorRect(anchorRef.current.getBoundingClientRect());
    }
    setOpen(true);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={getStatusItemClasses()}
        title={getTooltip()}
        aria-label={getTooltip()}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={handleClick}
      >
        {isWarningBg && <Codicon name="warning" className="statusbar-icon-warn" />}
        <Codicon name={busy ? 'loading codicon-modifier-spin' : headIconName} />
        <span className="statusbar-label">{headLabel}</span>
        {hasUncommitted && <span className="statusbar-dirty-dot" title={t('Uncommitted changes')}>●</span>}
        {totalConflicts > 0 && (
          <span className="statusbar-counter conflict">
            <Codicon name="git-merge" />
            {totalConflicts}
          </span>
        )}
        {totalBehind > 0 && (
          <span className="statusbar-counter pull">
            <Codicon name="arrow-down" />
            {totalBehind}
          </span>
        )}
        {totalAhead > 0 && (
          <span className="statusbar-counter push">
            <Codicon name="arrow-up" />
            {totalAhead}
          </span>
        )}
      </button>

      {open && (
        <BranchMenuPopover
          anchorRect={anchorRect}
          onClose={() => setOpen(false)}
          initialRepoId={isSingleSvn ? repositories[0].meta.id : undefined}
          repoOnly={isSingleSvn}
          onManageIgnore={(repoId, directory = '') => {
            setOpen(false);
            setIgnoreTarget({ repoId, directory });
          }}
        />
      )}

      {ignoreTarget && (
        <IgnoreRulesPanel
          key={`${ignoreTarget.repoId}:${ignoreTarget.directory}`}
          repoId={ignoreTarget.repoId}
          directory={ignoreTarget.directory}
          close={() => setIgnoreTarget(null)}
        />
      )}
    </>
  );
}
