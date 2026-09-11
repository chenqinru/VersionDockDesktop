import { useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { isOperationActive, useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { BranchMenuPopover } from './BranchMenuPopover';

export function BranchStatusBarItem() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const snapshot = useAppStore((state) => state.snapshot);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const busy = useAppStore((state) => selectedRepoId ? isOperationActive(state.operations, {
    workspaceId: state.snapshot?.workspace.id,
    repositoryId: selectedRepoId,
    domain: ['branch', 'sync'],
  }) : false);

  const repositories = useMemo(() => snapshot?.repositories ?? [], [snapshot?.repositories]);
  const gitRepos = useMemo(() => repositories.filter((r) => r.meta.kind === 'git'), [repositories]);
  const suppressDivergedWarning = bootstrap?.state.settings?.suppressDivergedWarning ?? false;

  const {
    headLabel,
    hasUncommitted,
    hasConflicts,
    totalConflicts,
    totalBehind,
    totalAhead,
    branchesDiverged,
  } = useMemo(() => {
    if (repositories.length === 0) {
      return {
        headLabel: t('No repo'),
        hasUncommitted: false,
        hasConflicts: false,
        totalConflicts: 0,
        totalBehind: 0,
        totalAhead: 0,
        branchesDiverged: false,
      };
    }

    const branches = repositories.map((r) => r.branch ?? 'HEAD');
    const uniqueBranches = Array.from(new Set(branches));
    const isDiverged = gitRepos.length > 1 && new Set(gitRepos.map((r) => r.branch ?? 'HEAD')).size > 1;

    const label = uniqueBranches.length === 1
      ? uniqueBranches[0]
      : `${uniqueBranches[0]} +${uniqueBranches.length - 1}`;

    const uncommitted = repositories.some(
      (r) => (r.files?.length ?? 0) > 0
    );

    const conflictsCount = repositories.reduce((sum, r) => sum + (r.conflicts ?? 0), 0);
    const behindCount = repositories.reduce((sum, r) => sum + (r.behind ?? 0), 0);
    const aheadCount = gitRepos.reduce((sum, r) => sum + (r.ahead ?? 0), 0);

    return {
      headLabel: label,
      hasUncommitted: uncommitted,
      hasConflicts: conflictsCount > 0,
      totalConflicts: conflictsCount,
      totalBehind: behindCount,
      totalAhead: aheadCount,
      branchesDiverged: isDiverged,
    };
  }, [repositories, gitRepos, t]);

  const showDiverged = branchesDiverged && !suppressDivergedWarning;
  const isWarningBg = hasConflicts || showDiverged;

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
    const parts: string[] = [];
    if (hasConflicts) parts.push(t('Merge conflicts in workspace ({0} files)', totalConflicts));
    if (showDiverged) parts.push(t('Branches have diverged across repositories'));
    if (hasUncommitted) parts.push(t('Uncommitted changes present'));
    if (totalAhead > 0) parts.push(t('{0} unpushed commits', totalAhead));
    if (totalBehind > 0) parts.push(t('{0} incoming commits', totalBehind));
    return parts.length > 0 ? parts.join(' · ') : t('VersionDock: Git/SVN Menu');
  };

  const handleClick = () => {
    if (!open && anchorRef.current) {
      setAnchorRect(anchorRef.current.getBoundingClientRect());
    }
    setOpen((prev) => !prev);
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
        <Codicon name={busy ? 'loading codicon-modifier-spin' : 'git-branch'} />
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
        />
      )}
    </>
  );
}
