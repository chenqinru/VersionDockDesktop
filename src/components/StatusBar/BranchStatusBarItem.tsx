import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { isOperationActive, useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { BranchMenuPopover } from './BranchMenuPopover';
import { getRepoEffectiveRef } from './branchRef';
import { choiceDialog } from '../dialogService';
import { BRANCH_STATUS_DOMAINS, deriveBranchStatus } from './branchStatus';
import { BranchStatusTooltip } from './BranchStatusTooltip';
import { useStatusTooltip } from './useStatusTooltip';
import { usePopoverToggleState } from './usePopoverToggleState';

export function BranchStatusBarItem() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const tooltip = useStatusTooltip(open);
  const toggleState = usePopoverToggleState(open);
  const mounted = useRef(true);
  const waiting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const snapshot = useAppStore((state) => state.snapshot);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const busy = useAppStore((state) => isOperationActive(
    Object.fromEntries(Object.entries(state.operations).filter(([, op]) => op.context.visibility === 'foreground')),
    { workspaceId: state.snapshot?.workspace.id, domain: BRANCH_STATUS_DOMAINS },
  ));

  const repositories = useMemo(() => snapshot?.repositories ?? [], [snapshot?.repositories]);
  const suppressDivergedWarning = bootstrap?.state.settings?.suppressDivergedWarning ?? false;

  const status = useMemo(() => deriveBranchStatus(repositories, branchesByRepo, selectedRepoId, t), [repositories, branchesByRepo, selectedRepoId, t]);
  const { headLabel, headIconName, hasUncommitted, hasConflicts, hasOngoingOperation, opLabel, totalConflicts, totalBehind, totalAhead, branchesDiverged } = status;

  const showDiverged = branchesDiverged && !suppressDivergedWarning;
  const isWarningBg = !busy && (hasConflicts || hasOngoingOperation || showDiverged);

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

  const getStatusMessages = () => {
    const lines: string[] = [];
    if (busy) lines.push(t('Version control operation in progress…'));
    if (hasOngoingOperation) lines.push(t('Operation in progress: {0}', opLabel));
    if (hasConflicts) lines.push(t('Merge conflicts in workspace ({0} files)', totalConflicts));
    if (showDiverged) lines.push(t('Branches have diverged across repositories'));
    if (hasUncommitted) lines.push(t('Uncommitted changes present'));
    if (totalAhead > 0) lines.push(t('{0} unpushed commits', totalAhead));
    if (totalBehind > 0) lines.push(t('{0} incoming commits', totalBehind));

    return lines;
  };

  const getTooltip = () => {
    const lines = getStatusMessages();
    if (repositories.length > 0) {
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
        const branch = branchesByRepo[repo.meta.id]?.find((b) => b.current);
        if (repo.meta.kind === 'git' && branch && !branch.upstream) parts.push(t('no upstream'));
        const statusDetail = parts.length > 0 ? ` (${parts.join(', ')})` : ` (${t('Clean')})`;
        const branchDisplay = getRepoEffectiveRef(repo, branchesByRepo);
        lines.push(`${repo.meta.name}: ${branchDisplay}${statusDetail}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : t('VersionDock: Git/SVN Menu');
  };

  const isSingleSvn = repositories.length === 1 && repositories[0].meta.kind === 'svn';

  const handleClick = async () => {
    tooltip.dismiss();
    if (toggleState.consume()) {
      setOpen(false);
      return;
    }

    if (waiting.current) return;
    const workspaceId = snapshot?.workspace.id;
    const isOperating = () => {
      const s = useAppStore.getState();
      const wid = s.snapshot?.workspace.id;
      if (!wid) return false;
      return isOperationActive(Object.fromEntries(Object.entries(s.operations).filter(([, op]) => op.context.visibility === 'foreground')), { workspaceId: wid, domain: BRANCH_STATUS_DOMAINS });
    };

    waiting.current = true;
    try {
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
        while (mounted.current && useAppStore.getState().snapshot?.workspace.id === workspaceId && isOperating() && waited < 30000) {
          await new Promise((r) => setTimeout(r, 200));
          waited += 200;
        }
      }

      if (!mounted.current || useAppStore.getState().snapshot?.workspace.id !== workspaceId) return;
      if (anchorRef.current) {
        setAnchorRect(anchorRef.current.getBoundingClientRect());
      }
      setOpen(true);
    } finally { waiting.current = false; }
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={getStatusItemClasses()}
        aria-label={getTooltip()}
        aria-describedby={tooltip.visible ? "branch-status-tooltip" : undefined}
        onMouseEnter={() => { if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect()); tooltip.onMouseEnter(); }}
        onMouseLeave={tooltip.onLeave}
        onPointerDownCapture={toggleState.onPointerDown}
        onPointerCancel={toggleState.onPointerCancel}
        onKeyDownCapture={toggleState.onKeyDown}
        onPointerDown={tooltip.onPointerDown}
        onFocus={() => { if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect()); tooltip.onFocus(); }}
        onBlur={tooltip.onBlur}
        onKeyDown={tooltip.onKeyDown}
        aria-haspopup="dialog"
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

      {tooltip.visible && anchorRect && <BranchStatusTooltip repositories={status.targets} worktrees={status.worktrees} branches={branchesByRepo} selectedRepoId={selectedRepoId} anchor={anchorRect} messages={getStatusMessages()} />}

      {open && (
        <BranchMenuPopover
          anchorRect={anchorRect}
          anchorRef={anchorRef}
          placement="bottomLeft"
          onClose={() => { tooltip.dismiss(); setOpen(false); }}
          initialRepoId={isSingleSvn ? repositories[0].meta.id : undefined}
          repoOnly={isSingleSvn}

        />
      )}

    </>
  );
}
