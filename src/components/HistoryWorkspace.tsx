import { buildHistoryAuthorOptions } from '../history/authors';
import { IconButton } from './IconButton';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Codicon } from './Codicon';
import { capabilityAvailable, capabilityReason, resolveNotificationText, useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useResizable } from '../hooks/useResizable';
import { BranchSidebar } from './BranchSidebar';
import { BranchMenuPopover } from './StatusBar/BranchMenuPopover';
import { BranchComparePanel } from './BranchComparePanel';
import { CommitGraph } from './CommitGraph';
import { CommitDetailPanel } from './CommitDetailPanel';
import { buildHistoryRefOptions } from './HistoryWorkspace.helpers';
import { assignLanes, COMMIT_ROW_HEIGHT, layoutVisibleCommits, type GraphCommit } from './commitGraphLayout';
import { commitKey } from '../history/commitDetails';
import { formatRefLabel, groupRefs, mergeLocalRemote, type RefGroup } from '../history/refs';
import { branchColor, headColor, tagColor } from './branchColor';
import type { CommitDetail, CommitNode, GraphCommitNode } from '../bindings/generated';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { choiceDialog, confirmDialog, editorDialog, promptDialog } from './dialogService';
import { CommitSearch, DateFilter, DatePopover, FilterPopover, ToggleFilter } from './HistoryFilterControls';
import { AuthorAvatar } from './AuthorAvatar';
import { hasMixedRepositoryKinds, repositoryLabel } from './repoLabel';
import { BranchRefBadge, type BranchRefKind } from './BranchRefBadge';

type FilterMenu = 'authors' | 'repos' | 'refs' | 'dates' | null;
type ViewFilters = { author: string; repoId: string; ref: string; from: string; to: string };

const EMPTY_FILTERS: ViewFilters = { author: '', repoId: '', ref: '', from: '', to: '' };
const BLOCK_GAP = 4;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (item: number) => String(item).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatAuthorName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function MoreMenu({ open, onToggle, onFetch, expanded, onToggleExpanded, showRepoNames }: { open: boolean; onToggle: () => void; onFetch: () => void; expanded: boolean; onToggleExpanded: () => void; showRepoNames: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onToggle(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onToggle(); };
    const blur = () => onToggle();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); window.removeEventListener('blur', blur); };
  }, [onToggle, open]);
  return <div ref={ref} className="history-more"><IconButton type="button" className={`more-button ${open ? 'selected' : ''}`} title={t('More actions')} aria-label={t('More actions')} onClick={onToggle}><Codicon name="three-bars" style={{ fontSize: '14px' }} /></IconButton>{open && <div className="more-menu">
    <button onClick={() => { onFetch(); onToggle(); }}><Codicon name="sync" />{t('Fetch and Refresh')}</button>
    {showRepoNames && <button onClick={() => { onToggleExpanded(); onToggle(); }}><Codicon name={expanded ? 'collapse-all' : 'expand-all'} />{t(expanded ? 'Collapse project names' : 'Expand project names')}</button>}
  </div>}</div>;
}

function badgeIcons(group: RefGroup): string[] {
  if (group.isSvnRevision) return ['versions'];
  if (group.isRemoteHead) return ['milestone'];
  if (group.isDetached && group.isHead) return ['warning'];
  if (group.isTag) return ['tag'];
  if (group.isLocal && group.isRemote) return ['git-branch', 'cloud'];
  if (group.isRemote) return ['cloud'];
  return ['git-branch'];
}

function badgeKind(group: RefGroup): BranchRefKind {
  if (group.isSvnRevision) return 'revision';
  if (group.isTag) return 'tag';
  if (group.isRemote) return 'remote';
  if (group.isHead || group.isDetached) return 'head';
  return 'branch';
}

function badgeColor(group: RefGroup): string {
  if (group.isSvnRevision && group.label === 'HEAD') return headColor();
  if (group.isRemoteHead || (group.isHead && group.isDetached)) return headColor();
  if (group.isTag) return tagColor();
  return branchColor(group.label, false);
}

function RefBadges({
  refs,
  repoKind = 'git',
  remoteNames = [],
  isSelected = false,
  maxVisible = 2,
}: {
  refs: string[];
  repoKind?: 'git' | 'svn';
  remoteNames?: readonly string[];
  isSelected?: boolean;
  maxVisible?: number;
}) {
  const { t } = useI18n();
  const allGroups = useMemo(
    () => mergeLocalRemote(groupRefs(refs, repoKind, remoteNames)),
    [refs, repoKind, remoteNames],
  );
  if (allGroups.length === 0) return null;

  const displayGroups = allGroups.filter((group) => !group.isRemoteHead);
  const visible = displayGroups.slice(0, maxVisible);
  const overflow = displayGroups.slice(maxVisible);

  return (
    <span className="commit-refs">
      {visible.map((group) => {
        const color = badgeColor(group);
        return <BranchRefBadge key={group.key} label={formatRefLabel(group, t('Remote'))} kind={badgeKind(group)} color={color} variant="ref" selected={isSelected} icons={badgeIcons(group)} className={group.isTag ? 'tag' : group.isRemote ? 'remote' : group.isHead ? 'head' : group.isSvnRevision ? 'svn' : 'branch'} title={group.label} />;
      })}
      {overflow.length > 0 && <BranchRefBadge label={visible.length === 0 ? String(overflow.length) : `+${overflow.length}`} kind={badgeKind(overflow[0])} color={badgeColor(overflow[0])} variant="ref" selected={isSelected} icons={[]} className="ref-overflow" title={overflow.map((group) => group.label).join('\n')} />}
    </span>
  );
}

type CommitWithIndicators = CommitNode & { incoming?: boolean; unpushed?: boolean };
type CommitPopoverAnchor = { rowTop: number; listTop: number; listBottom: number; listLeft: number; listRight: number; mouseX: number };

function CommitPopover({ detail, anchor, repoKind, remoteNames, onClose, onEnter, onLeave }: { detail: CommitDetail; anchor: CommitPopoverAnchor; repoKind: 'git' | 'svn'; remoteNames: readonly string[]; onClose: () => void; onEnter: () => void; onLeave: () => void }) {
  const { t } = useI18n();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const added = detail.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = detail.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  useLayoutEffect(() => {
    const element = popoverRef.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(anchor.listLeft, Math.min(anchor.listRight - width, anchor.mouseX - width / 2));
    const preferredTop = anchor.rowTop - height - 6;
    const top = preferredTop >= anchor.listTop ? preferredTop : anchor.rowTop + COMMIT_ROW_HEIGHT + 6;
    setPosition({ top, left });
  }, [anchor]);
  useEffect(() => {
    window.addEventListener('blur', onClose);
    return () => window.removeEventListener('blur', onClose);
  }, [onClose]);
  return createPortal(<div ref={popoverRef} className="commit-popover" style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden', pointerEvents: position ? 'auto' : 'none' }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <div className="popover-line"><Codicon name="git-commit" /><code>{detail.commit.shortHash}</code></div>
    <div className="popover-line"><AuthorAvatar className="mini-avatar" name={detail.commit.author} email={detail.commit.email} repoId={detail.commit.repoId} size={16} /><span className="popover-author">{detail.commit.author}</span><i>·</i><time>{formatDate(detail.commit.authorDate)}</time></div>
    <div className="popover-line"><Codicon name="diff" /><span>{detail.files.length} {detail.files.length === 1 ? t('file changed') : t('files changed')}</span>{added > 0 && <b className="added">+{added}</b>}{removed > 0 && <b className="removed">-{removed}</b>}</div>
    <RefBadges refs={detail.commit.refs} repoKind={repoKind} remoteNames={remoteNames} maxVisible={Number.MAX_SAFE_INTEGER} />
    <small>{t('Click to view more details')}</small>
  </div>, document.body);
}

function CommitList({
  history,
  loading,
  expandedRepoIds,
  onToggleRepoName,
  repoKindById,
  remoteNamesByRepo,
  topologyCommits,
  isFiltered,
  hasRevisionFilter,
  repoSortKeyById,
  hasMoreOverride,
  onLoadMore,
  singleRepository = false,
}: {
  history: CommitNode[];
  loading: boolean;
  expandedRepoIds: Set<string>;
  onToggleRepoName: (repoId: string) => void;
  repoKindById: Record<string, 'git' | 'svn'>;
  remoteNamesByRepo: Record<string, string[]>;
  topologyCommits?: GraphCommitNode[];
  isFiltered?: boolean;
  hasRevisionFilter?: boolean;
  repoSortKeyById: Record<string, string>;
  hasMoreOverride?: boolean;
  onLoadMore?: () => void;
  singleRepository?: boolean;
}) {
  const { t } = useI18n();
  const parent = useRef<HTMLDivElement>(null);
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const historyRepoErrors = useAppStore((state) => state.historyRepoErrors);
  const storeHasMore = useAppStore((state) => state.historyHasMore);
  const hasMore = hasMoreOverride ?? storeHasMore;
  const selected = useAppStore((state) => new Set(state.selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash))));
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectCommit = useAppStore((state) => state.selectCommit);
  const loadCommitDetail = useAppStore((state) => state.loadCommitDetail);
  const openCommitDetail = useAppStore((state) => state.openCommitDetail);
  const openChanges = useAppStore((state) => state.openCommitChanges);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const revealTarget = useAppStore((state) => state.historyRevealTarget);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const unpushedOperation = useAppStore((state) => state.unpushedOperation);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const createPatch = useAppStore((state) => state.createPatch);
  const savePatch = useAppStore((state) => state.savePatch);
  const commits = useMemo(() => {
    if (isFiltered) return assignLanes(history, true, repoKindById, remoteNamesByRepo, undefined, repoSortKeyById);
    if (hasRevisionFilter) return assignLanes(history, false, repoKindById, remoteNamesByRepo, topologyCommits, repoSortKeyById);
    return topologyCommits?.length
      ? layoutVisibleCommits(history, topologyCommits, repoKindById, remoteNamesByRepo, repoSortKeyById)
      : assignLanes(history, false, repoKindById, remoteNamesByRepo, undefined, repoSortKeyById);
  }, [hasRevisionFilter, history, isFiltered, repoKindById, remoteNamesByRepo, repoSortKeyById, topologyCommits]);
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.meta.id, repo])), [repos]);
  const repoBlocks = useMemo(() => {
    const blocks: Array<{ repoId: string; name: string; color: string; start: number; count: number }> = [];
    for (let index = 0; index < commits.length; index += 1) {
      const commit = commits[index];
      const previous = blocks[blocks.length - 1];
      if (previous?.repoId === commit.repoId) previous.count += 1;
      else blocks.push({ repoId: commit.repoId, name: repoMap.get(commit.repoId)?.meta.name ?? commit.repoId, color: repoMap.get(commit.repoId)?.meta.color ?? 'var(--versiondock-muted)', start: index, count: 1 });
    }
    return blocks;
  }, [commits, repoMap]);
  const multiRepo = !singleRepository && repos.length > 1;
  const anyExpanded = expandedRepoIds.size > 0;
  const labelColWidth = multiRepo ? (anyExpanded ? 110 : 8) : 0;

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parent.current,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    overscan: 14,
  });
  useEffect(() => {
    if (!revealTarget || revealTarget.workspaceId !== workspaceId) return;
    const index = commits.findIndex((commit) => commit.repoId === revealTarget.repoId && commit.hash === revealTarget.hash);
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'center' });
      useAppStore.setState({ historyRevealTarget: undefined });
      void selectCommit(commits[index]);
    } else if (hasMore && !loading) {
      void loadHistory().catch(() => {
        if (useAppStore.getState().historyRevealTarget === revealTarget) useAppStore.setState({ historyRevealTarget: undefined });
      });
    } else if (!hasMore && !loading) {
      useAppStore.setState({ historyRevealTarget: undefined });
    }
  }, [commits, hasMore, loadHistory, loading, revealTarget, selectCommit, virtualizer, workspaceId]);
  const [hoveredKey, setHoveredKey] = useState<string>();
  const [containerWidth, setContainerWidth] = useState(0);
  const [context, setContext] = useState<{ x: number; y: number; commit: CommitNode }>();
  const [branchOptions, setBranchOptions] = useState<{ anchorRect: DOMRect; repoId: string; branchName: string; isCurrent: boolean; svn: boolean }>();
  const [popover, setPopover] = useState<{ detail: CommitDetail; anchor: CommitPopoverAnchor }>();
  const hoveredKeyRef = useRef<string>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const popoverActive = useRef(false);

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useLayoutEffect(() => {
    const element = parent.current;
    if (!element) return;
    const update = () => setContainerWidth(element.clientWidth);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const schedulePopover = (event: React.MouseEvent<HTMLDivElement>, commit: CommitNode) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const key = commitKey(commit.repoId, commit.hash);
    setHoveredKey(key);
    hoveredKeyRef.current = key;
    if (popover?.detail.commit.repoId === commit.repoId && popover.detail.commit.hash === commit.hash) return;
    setPopover(undefined);
    const row = event.currentTarget;
    const mouseX = event.clientX;
    hoverTimer.current = setTimeout(() => {
      void loadCommitDetail(commit).then((detail) => {
        if (hoveredKeyRef.current === key) {
          const rect = row.getBoundingClientRect();
          const listRect = parent.current?.getBoundingClientRect();
          if (!listRect) return;
          setPopover({ detail, anchor: { rowTop: rect.top, listTop: listRect.top, listBottom: listRect.bottom, listLeft: listRect.left, listRight: listRect.right, mouseX } });
        }
      }).catch(() => undefined);
    }, 1000);
  };
  const closePopoverSoon = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoveredKey(undefined);
    hoveredKeyRef.current = undefined;
    closeTimer.current = setTimeout(() => { if (!popoverActive.current) setPopover(undefined); }, 120);
  };
  const allExpanded = repoBlocks.length > 0 && repoBlocks.every((block) => expandedRepoIds.has(block.repoId));
  const refsSpace = containerWidth - labelColWidth - 340;
  const maxVisibleRefs = refsSpace < 80 ? 0 : refsSpace < 170 ? 1 : 2;
  const virtualItems = virtualizer.getVirtualItems();
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const renderedItems = virtualItems.length > 0 ? virtualItems : commits.map((_, index) => ({ index, start: index * COMMIT_ROW_HEIGHT }));
  const contextSelection = (commit: CommitNode): CommitNode[] => selected.has(commitKey(commit.repoId, commit.hash)) && selectedCommits.length > 1 && selectedCommits.every((item) => item.repoId === commit.repoId) ? selectedCommits : [commit];
  const commitMenuRefs = (commit: CommitNode) => {
    const svn = repoKindById[commit.repoId] === 'svn';
    const groups = groupRefs(commit.refs, svn ? 'svn' : 'git', remoteNamesByRepo[commit.repoId] ?? []);
    const local = groups.filter((group) => group.isLocal && !group.isTag && !group.isDetached);
    const remote = groups.filter((group) => group.isRemote && !group.isRemoteHead && !group.isTag);
    const primaryLocal = local.find((group) => group.isHead) ?? local[0];
    const primaryRemote = remote[0];
    const svnBranch = repos.find((repo) => repo.meta.id === commit.repoId)?.branch;
    return {
      hasTags: groups.some((group) => group.isTag),
      checkoutTarget: svn ? (commit.refs.includes('HEAD') ? svnBranch : undefined) : primaryLocal?.label ?? (primaryRemote ? `${primaryRemote.remoteName}/${primaryRemote.label}` : undefined),
      branchOptionsTarget: svn ? (commit.refs.includes('HEAD') ? svnBranch : undefined) : primaryLocal?.label,
    };
  };
  const contextItems = (commit: CommitNode): ContextMenuEntry[] => {
    const git = repoKindById[commit.repoId] !== 'svn';
    const repository = repoMap.get(commit.repoId);
    const rewriteAvailable = capabilityAvailable(repository?.capabilities, 'historyRewrite', true);
    const rewriteReason = capabilityReason(repository?.capabilities, 'historyRewrite');
    const selection = contextSelection(commit);
    if (selection.length > 1) {
      const allUnpushed = selection.every((item) => item.unpushed);
      const containsMerge = selection.some((item) => item.parents.length > 1);
      return [
        { id: 'patch-multi', label: t('Create Patch...'), icon: 'diff' },
        ...(git ? [{ id: 'cherry-pick-multi', label: t('Cherry-Pick All'), icon: 'git-commit', disabled: containsMerge, disabledReason: containsMerge ? t('Merge commits require selecting a mainline parent and cannot be cherry-picked here.') : undefined } as ContextMenuEntry, { separator: true } as ContextMenuEntry, { id: 'reset-multi', label: t('Reset Current Branch to Here'), icon: 'history', disabled: true } as ContextMenuEntry, { id: 'revert-multi', label: t('Revert Commits'), icon: 'discard' } as ContextMenuEntry] : []),
        ...(allUnpushed ? [{ separator: true } as ContextMenuEntry, { id: 'drop-multi', label: t('Drop Commits'), icon: 'trash', danger: true, disabled: !rewriteAvailable, disabledReason: rewriteReason } as ContextMenuEntry, { id: 'squash-multi', label: t('Squash {0} Commits...', selection.length), icon: 'fold-down', disabled: !rewriteAvailable, disabledReason: rewriteReason } as ContextMenuEntry] : []),
      ];
    }
    const { hasTags, checkoutTarget, branchOptionsTarget } = commitMenuRefs(commit);
    const items: ContextMenuEntry[] = [
      { id: 'copy', label: t('Copy Revision Number'), icon: 'copy' },
      { separator: true },
      { id: 'branch', label: t('New Branch...'), icon: 'git-branch' },
      { id: hasTags ? 'manage-tags' : 'tag', label: t(hasTags ? 'Manage Tags...' : 'New Tag...'), icon: 'tag' },
      { separator: true },
      { id: 'checkout', label: t(checkoutTarget ? 'Checkout...' : git ? 'Checkout Revision' : 'Update to Revision'), icon: 'arrow-right' },
      ...(branchOptionsTarget ? [{ id: 'branch-options', label: t('Branch options...'), icon: 'git-branch' } as ContextMenuEntry] : []),
      { separator: true },
      { id: 'patch', label: t('Create Patch...'), icon: 'diff' },
    ];
    if (!git) return items;
    items.push(
      { id: 'cherry-pick', label: t('Cherry-Pick'), icon: 'git-commit', disabled: commit.parents.length > 1, disabledReason: commit.parents.length > 1 ? t('Merge commits require selecting a mainline parent and cannot be cherry-picked here.') : undefined },
      { separator: true },
      { id: 'reset', label: t('Reset Current Branch to Here...'), icon: 'history', disabled: !rewriteAvailable, disabledReason: rewriteReason },
      { id: 'revert', label: t('Revert Commit'), icon: 'discard' },
    );
    const currentBranch = branchesByRepo[commit.repoId]?.find((b) => b.current);
    const isHead = commit.refs.some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> '))
      || Boolean(currentBranch?.detachedHash && (commit.hash === currentBranch.detachedHash || commit.shortHash === currentBranch.detachedHash))
      || (Boolean(repository?.revision) && (commit.hash === repository?.revision || commit.shortHash === repository?.revision || commit.hash.startsWith(repository?.revision ?? '')));
    if (commit.unpushed) items.push(
      { separator: true },
      ...(isHead ? [{ id: 'edit', label: t('Edit Commit Message'), icon: 'edit', disabled: !rewriteAvailable, disabledReason: rewriteReason } as ContextMenuEntry, { id: 'undo', label: t('Undo Commit'), icon: 'arrow-left', disabled: !rewriteAvailable, disabledReason: rewriteReason } as ContextMenuEntry] : []),
      ...(isHead ? [{ separator: true } as ContextMenuEntry] : []),
      { id: 'drop', label: t('Drop Commit'), icon: 'trash', danger: true, disabled: !rewriteAvailable, disabledReason: rewriteReason },
    );
    return items;
  };
  const runContext = async (id: string, targetCommit?: CommitNode, anchorRect?: DOMRect) => {
    const commit = targetCommit ?? context?.commit;
    if (!commit) return;
    const { checkoutTarget, branchOptionsTarget } = commitMenuRefs(commit);
    if (id === 'branch-options' && branchOptionsTarget && anchorRect) {
      const currentBranch = branchesByRepo[commit.repoId]?.find((branch) => branch.current)?.name ?? repoMap.get(commit.repoId)?.branch;
      setBranchOptions({ anchorRect, repoId: commit.repoId, branchName: branchOptionsTarget, isCurrent: currentBranch === branchOptionsTarget, svn: repoKindById[commit.repoId] === 'svn' });
      return;
    }
    const selection = contextSelection(commit);
    const index = new Map(commits.map((item, position) => [commitKey(item.repoId, item.hash), position]));
    const oldestFirst = [...selection].sort((left, right) => (index.get(commitKey(right.repoId, right.hash)) ?? 0) - (index.get(commitKey(left.repoId, left.hash)) ?? 0));
    const newestFirst = [...selection].sort((left, right) => (index.get(commitKey(left.repoId, left.hash)) ?? 0) - (index.get(commitKey(right.repoId, right.hash)) ?? 0));
    const repoName = repoMap.get(commit.repoId)?.meta.name ?? commit.repoId;
    if (id === 'copy') {
      await navigator.clipboard?.writeText(commit.hash).catch(() => undefined);
      useAppStore.getState().addNotification({
        type: 'info',
        title: t('Revision copied'),
        message: { key: 'VersionDock [{0}]: revision {1} copied to clipboard.', args: [repoName, commit.shortHash || commit.hash.slice(0, 7)] },
        workspaceId: useAppStore.getState().snapshot?.workspace.id,
      });
    }
    if (id === 'patch' || id === 'patch-multi') {
      const hashes = selection.map((item) => item.hash);
      const defaultName = selection.length === 1 ? `${selection[0].shortHash || selection[0].hash.slice(0, 7)}.patch` : `versiondock-${selection.length}-commits.patch`;
      const b = useAppStore.getState().bridge;
      let savePath: string | null = null;
      try {
        if (b) {
          savePath = await b.saveFileDialog({
            title: t('Save Patch'),
            defaultPath: defaultName,
            filters: [{ name: 'Patch files', extensions: ['patch', 'diff'] }, { name: 'All files', extensions: ['*'] }],
          });
        }
      } catch {
        savePath = null;
      }
      if (savePath) {
        try {
          await savePatch(commit.repoId, hashes, savePath);
          useAppStore.getState().addNotification({
            type: 'success',
            title: t('Patch created'),
            message: { key: 'VersionDock [{0}]: Patch saved to {1}', args: [repoName, savePath] },
            workspaceId: useAppStore.getState().snapshot?.workspace.id,
          });
        } catch (error) {
          useAppStore.getState().addNotification({
            type: 'error',
            title: t('Create patch failed'),
            message: { raw: error instanceof Error ? error.message : String(error) },
            workspaceId: useAppStore.getState().snapshot?.workspace.id,
          });
        }
      } else if (savePath === null && b && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        // Cancelled by user in native save dialog
      } else {
        const patch = await createPatch(commit.repoId, hashes);
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
          const url = URL.createObjectURL(new Blob([patch.content], { type: 'text/x-patch;charset=utf-8' }));
          const link = document.createElement('a'); link.href = url; link.download = patch.fileName; link.click(); URL.revokeObjectURL(url);
        }
      }
    }
    if (id === 'branch') { const name = await promptDialog({ title: t('New Branch'), message: commit.shortHash, inputLabel: t('Branch name') }); if (name) await branchOperation({ type: 'create', name, from: commit.hash }, commit.repoId); }
    if (id === 'tag') { const name = await promptDialog({ title: t('New Tag'), message: commit.shortHash, inputLabel: t('Tag name') }); if (name) await tagOperation({ type: 'create', name, revision: commit.hash }, commit.repoId); }
    if (id === 'manage-tags') {
      const tags = commit.refs.flatMap((ref) => ref.startsWith('refs/tags/') ? [ref.slice('refs/tags/'.length)] : ref.startsWith('tag: ') ? [ref.slice('tag: '.length).replace(/^refs\/tags\//, '')] : []);
      const action = await choiceDialog({ title: t('Manage Tags...'), message: commit.shortHash, choices: [{ id: 'create', label: t('New Tag...'), icon: 'add' }, ...tags.map((name) => ({ id: `delete:${name}`, label: t('Delete tag "{0}"', name), icon: 'trash', danger: true }))] });
      if (action === 'create') { const name = await promptDialog({ title: t('New Tag'), message: commit.shortHash, inputLabel: t('Tag name') }); if (name) await tagOperation({ type: 'create', name, revision: commit.hash }, commit.repoId); }
      if (action?.startsWith('delete:')) await tagOperation({ type: 'delete', name: action.slice('delete:'.length) }, commit.repoId);
    }
    if (id === 'checkout') {
      if (checkoutTarget) {
        const svn = repoKindById[commit.repoId] === 'svn';
        const choice = await choiceDialog({
          title: t(svn ? 'SVN Switch / Update' : 'Checkout'),
          message: commit.shortHash,
          choices: [
            {
              id: 'branch',
              label: t(svn ? "Switch to '{0}'" : "Checkout branch '{0}'", checkoutTarget),
              icon: 'git-branch',
            },
            {
              id: 'revision',
              label: t(svn ? 'Update to Revision' : 'Checkout revision (detached HEAD)'),
              icon: 'git-commit',
            },
          ],
        });
        if (!choice) return;
        if (choice === 'branch') {
          await branchOperation({ type: 'checkout', name: checkoutTarget }, commit.repoId);
          return;
        }
      }
      await historyOperation(commit.repoId, repoKindById[commit.repoId] === 'svn' ? { type: 'svnUpdateTo', revision: commit.hash } : { type: 'checkout', revision: commit.hash });
    }
    if (id === 'cherry-pick' && commit.parents.length <= 1) await historyOperation(commit.repoId, { type: 'cherryPick', revision: commit.hash });
    if (id === 'cherry-pick-multi' && oldestFirst.every((item) => item.parents.length <= 1)) {
      for (const item of oldestFirst) {
        if (!await historyOperation(commit.repoId, { type: 'cherryPick', revision: item.hash })) break;
      }
    }
    if (id === 'revert' && await confirmDialog({ title: t('Revert commit?'), message: `${commit.shortHash} ${commit.message}\n\n${t('A new inverse commit will be created.')}`, danger: true })) await historyOperation(commit.repoId, { type: 'revert', revisions: [commit.hash] });
    if (id === 'revert-multi' && await confirmDialog({ title: t('Revert Commits'), message: newestFirst.map((item) => `${item.shortHash} ${item.message}`).join('\n'), danger: true })) await historyOperation(commit.repoId, { type: 'revert', revisions: newestFirst.map((item) => item.hash) });
    if (id === 'reset') {
      const mode = await choiceDialog({ title: t('Reset Current Branch to Here...'), message: `${commit.shortHash} ${commit.message}`, danger: true, choices: [{ id: 'soft', label: t('Soft'), description: t('Keep staged and unstaged changes'), icon: 'arrow-down' }, { id: 'mixed', label: t('Mixed'), description: t('Keep unstaged changes, unstage staged changes'), icon: 'discard' }, { id: 'hard', label: t('Hard'), description: t('Discard all changes'), icon: 'warning', danger: true }] });
      const currentBranch = branchesByRepo[commit.repoId]?.find((b) => b.current);
      const snapshotRepo = useAppStore.getState().snapshot?.repositories.find((r) => r.meta.id === commit.repoId);
      const expectedBranch = currentBranch?.name || snapshotRepo?.branch || undefined;
      const expectedHead = currentBranch?.detachedHash || snapshotRepo?.revision || undefined;
      if (mode && await confirmDialog({ title: t('Reset {0}?', mode), message: `${commit.shortHash} ${commit.message}\n\n${t(mode === 'hard' ? 'All working tree and index changes will be discarded.' : 'Commits after this revision will be removed from the current branch.')}`, danger: true })) {
        await historyOperation(commit.repoId, { type: 'reset', revision: commit.hash, mode, expectedBranch, expectedHead });
      }
    }
    if (id === 'edit') {
      const detail = await useAppStore.getState().loadCommitDetail(commit);
      const name = useAppStore.getState().snapshot?.repositories.find((repo) => repo.meta.id === commit.repoId)?.meta.name ?? commit.repoId;
      await editorDialog({ title: t('Edit Commit Message'), message: `${name} · ${commit.shortHash}`, inputLabel: t('Commit message'), initialValue: detail.fullMessage, confirmLabel: t('Save'), submit: async (message) => {
        const ok = await unpushedOperation(commit.repoId, { type: 'editMessage', hash: commit.hash, message });
        if (!ok) { const latest = useAppStore.getState().notifications.find((item) => item.type === 'error'); throw new Error(latest ? resolveNotificationText(latest.message, t) : t('Operation failed')); }
        return true;
      } });
    }
    if (id === 'undo' && await confirmDialog({ title: t('Undo Commit?'), message: `${commit.shortHash} ${commit.message}\n\n${t('Changes remain staged.')}`, danger: true })) await unpushedOperation(commit.repoId, { type: 'undoHead', expectedHash: commit.hash });
    if (id === 'drop' && await confirmDialog({ title: t('Drop Commit?'), message: `${commit.shortHash} ${commit.message}\n\n${t('This rewrites local history and may require force push.')}`, danger: true })) await unpushedOperation(commit.repoId, { type: 'drop', hashes: [commit.hash] });
    if (id === 'drop-multi' && await confirmDialog({ title: t('Drop Commits'), message: newestFirst.map((item) => `${item.shortHash} ${item.message}`).join('\n'), danger: true })) await unpushedOperation(commit.repoId, { type: 'drop', hashes: newestFirst.map((item) => item.hash) });
    if (id === 'squash-multi') {
      await editorDialog({ title: t('Squash {0} Commits...', selection.length), message: t('The selection must be contiguous and include HEAD.'), inputLabel: t('Combined commit message'), initialValue: oldestFirst.map((item) => item.message).join('\n\n'), items: oldestFirst.map((item) => ({ id: item.shortHash, label: item.message, description: item.author })), confirmLabel: t('Squash'), submit: async (message) => {
        const ok = await unpushedOperation(commit.repoId, { type: 'squash', hashes: newestFirst.map((item) => item.hash), message });
        if (!ok) { const latest = useAppStore.getState().notifications.find((item) => item.type === 'error'); throw new Error(latest ? resolveNotificationText(latest.message, t) : t('Operation failed')); }
        return true;
      } });
    }
    setContext(undefined);
  };

  return <div className="commit-list-frame"><div className="commit-list" ref={parent} onClick={() => { setContext(undefined); setPopover(undefined); }} onScroll={(event) => { const element = event.currentTarget; if (hasMore && !loading && element.scrollHeight - element.scrollTop - element.clientHeight < 300) { if (onLoadMore) onLoadMore(); else void loadHistory(false); } }}>
    <div className="commit-list-content" style={{ height: virtualizer.getTotalSize() }}>
      {multiRepo && repoBlocks.map((block) => {
        const blockTopPx = block.start * COMMIT_ROW_HEIGHT;
        const blockHeightPx = block.count * COMMIT_ROW_HEIGHT;
        const leadingGap = block.start > 0 ? BLOCK_GAP : 0;
        const top = blockTopPx + leadingGap;
        const height = Math.max(0, blockHeightPx - leadingGap);
        const expanded = expandedRepoIds.has(block.repoId);
        const nameOffset = Math.min(Math.max(scrollTop - top, 0), Math.max(0, height - COMMIT_ROW_HEIGHT));
        return <button key={`${block.repoId}:${block.start}`} className={`repo-strip ${expanded ? 'expanded' : ''}`} style={{ top, height, '--repo-color': block.color, '--repo-name-offset': `${nameOffset}px` } as React.CSSProperties} onClick={() => onToggleRepoName(block.repoId)} title={block.name}><span className="repo-strip-bar" />{expanded && <strong>{block.name}</strong>}</button>;
      })}
      {renderedItems.map((item) => {
        const commit = commits[item.index] as GraphCommit & CommitWithIndicators;
        if (!commit) return null;
        const key = commitKey(commit.repoId, commit.hash);
        const isSelected = selected.has(key);
        const isMergeCommit = commit.parents.length > 1;
        return <div key={key} className={`commit-row ${isSelected ? 'selected' : ''}`} style={{ transform: `translateY(${item.start}px)` }} role="button" tabIndex={0} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); window.getSelection()?.removeAllRanges(); if (hoverTimer.current) clearTimeout(hoverTimer.current); setPopover(undefined); setContext({ x: event.clientX, y: event.clientY, commit }); }} onMouseEnter={(event) => schedulePopover(event, commit)} onMouseLeave={closePopoverSoon} onClick={(event) => void selectCommit(commit, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single', commits)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void selectCommit(commit, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single', commits); } }}>
          {labelColWidth > 0 && <div style={{ width: labelColWidth, flexShrink: 0 }} />}
          <CommitGraph commit={commit} selected={isSelected} />
          <RefBadges refs={commit.refs} repoKind={repoKindById[commit.repoId] ?? 'git'} remoteNames={remoteNamesByRepo[commit.repoId] ?? []} isSelected={isSelected} maxVisible={maxVisibleRefs} />
          <span className={`commit-subject-text ${isMergeCommit ? 'merge-commit' : ''}`}>{commit.message}</span>
          {hoveredKey === key && <span className="commit-row-actions"><IconButton title={t('Open Commit Detail')} onClick={(event) => { event.stopPropagation(); void selectCommit(commit).then(openCommitDetail); }}><Codicon name="open-preview" /></IconButton><IconButton title={t('Open Changes')} onClick={(event) => { event.stopPropagation(); void selectCommit(commit).then(openChanges); }}><Codicon name="diff-multiple" /></IconButton></span>}
          {commit.incoming && <span className="commit-flow-indicator" title={t('Not pulled')}><Codicon name="arrow-down" className="commit-flow-icon incoming" /></span>}
          {commit.unpushed && <span className="commit-flow-indicator" title={t('Not pushed')}><Codicon name="arrow-up" className="commit-flow-icon unpushed" /></span>}
          <span className="commit-author">
            <AuthorAvatar className="mini-avatar" name={commit.author} email={commit.email} repoId={commit.repoId} size={18} /><span className="commit-author-name" title={commit.author}>{formatAuthorName(commit.author)}</span>
          </span>
          <time title={commit.authorDate || commit.committerDate}>{formatDate(commit.authorDate || commit.committerDate)}</time>
        </div>;
      })}
    </div>
    {popover && <CommitPopover detail={popover.detail} anchor={popover.anchor} repoKind={repoKindById[popover.detail.commit.repoId] ?? 'git'} remoteNames={remoteNamesByRepo[popover.detail.commit.repoId] ?? []} onClose={() => setPopover(undefined)} onEnter={() => { popoverActive.current = true; if (closeTimer.current) clearTimeout(closeTimer.current); }} onLeave={() => { popoverActive.current = false; setPopover(undefined); }} />}
    {context && <ContextMenu x={context.x} y={context.y} variant="gitLog" header={contextSelection(context.commit).length > 1 ? t('{0} commits selected', contextSelection(context.commit).length) : undefined} items={contextItems(context.commit)} onSelect={(id, rect) => void runContext(id, context.commit, rect)} onClose={() => setContext(undefined)} />}
    {branchOptions && createPortal(<BranchMenuPopover anchorRect={branchOptions.anchorRect} initialRepoId={branchOptions.repoId} repoOnly directBranch={branchOptions.svn ? undefined : { repoId: branchOptions.repoId, branchName: branchOptions.branchName, isCurrent: branchOptions.isCurrent }} onClose={() => setBranchOptions(undefined)} />, document.body, `${branchOptions.repoId}:${branchOptions.branchName}`)}
    {!loading && !commits.length && <div className="empty-state"><Codicon name="history" /><span>{t('No history')}</span></div>}
    </div>
    {loading && <>
      <div className="history-loading" role="status" aria-live="polite" aria-label={t('Loading commits…')}><Codicon name="loading codicon-modifier-spin" /><span>{t('Loading commits…')}</span></div>
      {commits.length > 0 && <div className="history-loading-progress" aria-hidden="true"><i /></div>}
    </>}
    {commits.length > 0 && allExpanded && <span className="sr-only">{t('Collapse project names')}</span>}
    {historyRepoErrors && Object.keys(historyRepoErrors).length > 0 && !loading && (() => {
      const errorEntries = Object.entries(historyRepoErrors);
      const errorDetailTooltip = errorEntries
        .map(([id, error]) => `${repoMap.get(id)?.meta.name || id}: ${error}`)
        .join('\n');
      const [firstRepoId, firstError] = errorEntries[0];
      const firstRepoName = repoMap.get(firstRepoId)?.meta.name || firstRepoId;
      const firstCleanError = firstError.replace(/^error:\s*/i, '').trim().split('\n')[0] || '';
      const summaryText = errorEntries.length === 1
        ? t('Failed to load {0}: {1}', firstRepoName, firstCleanError)
        : t('Failed to load logs for {0} repo(s) ({1}…): {2}', String(errorEntries.length), firstRepoName, firstCleanError);

      return (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 22,
            maxWidth: '90%',
            padding: '4px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            border: '1px solid var(--vscode-inputValidation-errorBorder, #f14c4c)',
            borderRadius: '4px',
            background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)',
            color: 'var(--vscode-inputValidation-errorForeground, #ffffff)',
            fontSize: '11px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
          }}
          title={errorDetailTooltip}
        >
          <Codicon name="error" style={{ color: 'var(--vscode-errorForeground, #f14c4c)', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summaryText}
          </span>
          <button
            style={{
              padding: '2px 8px',
              background: 'var(--vscode-button-background, #007acc)',
              color: 'var(--vscode-button-foreground, #ffffff)',
              border: 'none',
              borderRadius: '2px',
              cursor: 'pointer',
              fontSize: '11px',
              flexShrink: 0,
            }}
            onClick={() => void loadHistory(true)}
          >
            {t('Retry')}
          </button>
        </div>
      );
    })()}
  </div>;
}

export function HistoryWorkspace() {
  const snapshotWorkspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const { t } = useI18n();
  const [menu, setMenu] = useState<FilterMenu>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchReset, setSearchReset] = useState(0);
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [expandedRepoIds, setExpandedRepoIds] = useState(new Set<string>());
  const activeFilter = useRef<HTMLDivElement>(null);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const allHistory = useAppStore((state) => state.history);
  const historyTopology = useAppStore((state) => state.historyTopology);
  const historyLoading = useAppStore((state) => state.historyLoading);
  const allSnapshotRepos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const snapshotRepos = useMemo(() => allSnapshotRepos.filter((repo) => !repo.meta.isWorktree), [allSnapshotRepos]);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const historySearch = useAppStore((state) => state.historyFilter);
  const historyQuery = useAppStore((state) => state.historyQuery);
  const setHistorySearch = useAppStore((state) => state.setHistoryFilter);
  const setHistoryQuery = useAppStore((state) => state.setHistoryQuery);
  const setHistoryScope = useAppStore((state) => state.setHistoryScope);
  const historyScope = useAppStore((state) => state.historyScope);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const refresh = useAppStore((state) => state.refresh);
  const storedBranchWidth = useAppStore((state) => state.bootstrap?.state.layout?.panelSizes.branches ?? state.bootstrap?.state.panelSizes?.branches ?? 220);
  const storedDetailWidth = useAppStore((state) => state.bootstrap?.state.layout?.panelSizes.detail ?? state.bootstrap?.state.panelSizes?.detail ?? 380);
  const branchWidth = Math.min(400, Math.max(120, storedBranchWidth));
  const detailWidth = Math.min(680, Math.max(220, storedDetailWidth));
  const setPanelSize = useAppStore((state) => state.setPanelSize);
  const branchSidebarCollapsed = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsed ?? state.bootstrap?.state.branchSidebarCollapsed ?? false);
  const collapsedSections = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsedSections ?? state.bootstrap?.state.branchSidebarCollapsedSections ?? []);
  const setBranchSidebarState = useAppStore((state) => state.setBranchSidebarState);
  const [detailSidebarCollapsed, setDetailSidebarCollapsed] = useState(false);
  const compareTarget = useAppStore((state) => state.comparisonTarget);
  const openBranchComparison = useAppStore((state) => state.openBranchComparison);
  const closeBranchComparison = useAppStore((state) => state.closeBranchComparison);
  const resizeBranches = useResizable(branchWidth, 120, 400, (value) => setPanelSize('branches', value));
  const resizeDetail = useResizable(detailWidth, 220, 680, (value) => setPanelSize('detail', value), -1);

  const repoKindById = useMemo(() => {
    const map: Record<string, 'git' | 'svn'> = {};
    snapshotRepos.forEach((repo) => {
      map[repo.meta.id] = (repo.meta.kind as 'git' | 'svn') ?? 'git';
    });
    return map;
  }, [snapshotRepos]);
  const repoSortKeyById = useMemo(() => Object.fromEntries(snapshotRepos.map((repo) => [
    repo.meta.id,
    `${repo.meta.rootPath}::${repo.meta.kind}`,
  ])), [snapshotRepos]);
  const remoteNamesByRepo = useMemo(() => {
    const map: Record<string, string[]> = {};
    snapshotRepos.forEach((repo) => {
      map[repo.meta.id] = [...new Set((branchesByRepo[repo.meta.id] ?? [])
        .filter((branch) => branch.remote && branch.remoteName)
        .map((branch) => branch.remoteName!))]
        .sort((left, right) => right.length - left.length);
    });
    return map;
  }, [branchesByRepo, snapshotRepos]);

  const hasTopologyBreakingFilter = !!(historyQuery.text || historyQuery.author || historyQuery.fromDate || historyQuery.toDate || historyQuery.path || historyQuery.lineRange);
  const hasBranchFilter = !!filters.ref;
  const topologyCommits = !hasTopologyBreakingFilter
    ? (historyTopology.length > 0 ? historyTopology : hasBranchFilter ? allHistory : undefined)
    : undefined;

  const authorOptions = useMemo(() => buildHistoryAuthorOptions(allHistory), [allHistory]);
  const selectedAuthor = authorOptions.find((option) => option.id === filters.author || option.label === filters.author || option.sublabel === filters.author);
  const mixedKinds = hasMixedRepositoryKinds(snapshotRepos);
  const repoOptions = snapshotRepos.map((repo) => ({ id: repo.meta.id, label: repositoryLabel(repo, mixedKinds).toUpperCase(), color: repo.meta.color, detail: repo.meta.kind.toUpperCase() }));
  const allRefOptions = useMemo(
    () => buildHistoryRefOptions(snapshotRepos, branchesByRepo, tagsByRepo, true),
    [branchesByRepo, snapshotRepos, tagsByRepo],
  );
  const refOptions = useMemo(
    () => allRefOptions.filter((option) => option.group !== 'Remote' && (!filters.repoId || option.repoIds.includes(filters.repoId))),
    [allRefOptions, filters.repoId],
  );
  const selectedRepo = repoOptions.find((option) => option.id === filters.repoId);
  const selectedRepoLabel = selectedRepo?.label ?? t('Repository…');
  const selectedRef = allRefOptions.find((option) => option.id === filters.ref);
  const selectedRefLabel = selectedRef?.label ?? (filters.ref || t('Branch / Tag…'));
  const filterActive = !!(historySearch || historyQuery.path || filters.author || filters.repoId || filters.ref || filters.from || filters.to);
  const visibleHistory = allHistory;
  const updateFilters = (next: Partial<ViewFilters>) => {
    const updated = { ...filters, ...next };
    const currentRefOption = allRefOptions.find((option) => option.id === updated.ref);
    if (Object.hasOwn(next, 'ref') && updated.ref && updated.repoId) {
      if (currentRefOption && !currentRefOption.repoIds.includes(updated.repoId)) {
        updated.repoId = '';
      }
    }
    if (Object.hasOwn(next, 'repoId') && updated.repoId && updated.ref) {
      if (currentRefOption && !currentRefOption.repoIds.includes(updated.repoId)) {
        updated.ref = '';
      }
    }
    setFilters(updated);
    setHistoryQuery({ ...historyQuery, author: updated.author || null, fromDate: updated.from || null, toDate: updated.to || null });
    if (!Object.hasOwn(next, 'repoId') && !Object.hasOwn(next, 'ref')) {
      queueMicrotask(() => void loadHistory(true).catch(() => undefined));
      return;
    }
    const selectedRef = allRefOptions.find((option) => option.id === updated.ref);
    const repoIds = snapshotRepos
      .map((repo) => repo.meta.id)
      .filter((repoId) => (!updated.repoId || repoId === updated.repoId) && (!selectedRef || selectedRef.repoIds.includes(repoId)));
    const revisionsByRepo = selectedRef
      ? Object.fromEntries(repoIds.flatMap((repoId) => selectedRef.revisionsByRepo[repoId] ? [[repoId, selectedRef.revisionsByRepo[repoId]]] : []))
      : {};
    setHistoryScope({ repoIds: updated.repoId || selectedRef ? repoIds : null, revisionsByRepo });
    queueMicrotask(() => void loadHistory(true).catch(() => undefined));
  };
  useEffect(() => {
    const activeEntries = Object.entries(historyScope.revisionsByRepo);
    const repoId = activeEntries.length === 0 && historyScope.repoIds?.length === 1 ? historyScope.repoIds[0] : '';
    const ref = activeEntries.length === 0
      ? ''
      : (allRefOptions.find((option) => JSON.stringify(option.revisionsByRepo) === JSON.stringify(historyScope.revisionsByRepo))?.id ??
        allRefOptions.find((option) => activeEntries.every(([scopeRepoId, rev]) => option.revisionsByRepo[scopeRepoId] === rev))?.id ??
        '');
    queueMicrotask(() => setFilters((current) => ({ author: historyQuery.author ?? '', repoId: activeEntries.length > 0 && historyScope.repoIds?.includes(current.repoId) ? current.repoId : repoId, ref, from: historyQuery.fromDate ?? '', to: historyQuery.toDate ?? '' })));
  }, [allRefOptions, historyQuery.author, historyQuery.fromDate, historyQuery.toDate, historyScope]);
  const selectSidebarRef = (ref: string, repoIds: string[]) => {
    setFilters((current) => ({ ...current, ref, repoId: '' }));
    setHistoryScope({ repoIds, revisionsByRepo: Object.fromEntries(repoIds.map((repoId) => [repoId, ref])) });
    queueMicrotask(() => void loadHistory(true).catch(() => undefined));
  };
  const clearFilters = () => {
    setSearchReset((version) => version + 1);
    setHistorySearch('');
    setFilters(EMPTY_FILTERS);
    setHistoryScope({ repoIds: null, revisionsByRepo: {} });
    setHistoryQuery({ text: null, author: null, fromDate: null, toDate: null, path: null, revision: null, lineRange: null });
    setMenu(null);
    queueMicrotask(() => void loadHistory(true).catch(() => undefined));
  };
  const fetchAndRefresh = async () => {
    await useAppStore.getState().fetchRepositories(snapshotRepos.filter((repo) => repo.meta.kind === 'git').map((repo) => repo.meta.id));
    await refresh();
  };
  const toggleRepoNames = () => {
    const repoIds = [...new Set(allHistory.map((commit) => commit.repoId))];
    setExpandedRepoIds((current) => current.size === repoIds.length ? new Set() : new Set(repoIds));
  };

  useEffect(() => {
    if (!menu) return;
    const handleOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !activeFilter.current?.contains(target)) setMenu(null);
    };
    const closeMenu = () => setMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('blur', closeMenu);
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('blur', closeMenu); document.removeEventListener('pointerdown', handleOutside, true); document.removeEventListener('keydown', escape); };
  }, [menu]);

  if (!selectedRepoId) return <div className="workspace-empty"><Codicon name="repo" />{t('Select a repository')}</div>;
  return <section className="history-workspace">
    {!compareTarget && <div className="history-filters" onClick={(event) => event.stopPropagation()}>
      <CommitSearch key={`${snapshotWorkspaceId}:${searchReset}`} value={historySearch} onChange={(value) => { setHistorySearch(value); void loadHistory(true).catch(() => undefined); }} />
      <div ref={menu === 'authors' ? activeFilter : undefined} className="filter-anchor author-filter-anchor">
        <ToggleFilter icon="person" leading={selectedAuthor ? <AuthorAvatar name={selectedAuthor.avatarName} email={selectedAuthor.avatarEmail} repoId={selectedAuthor.avatarRepoId} size={14} /> : undefined} title={selectedAuthor ? `${selectedAuthor.label}${selectedAuthor.sublabel ? ` <${selectedAuthor.sublabel}>` : ''}` : t('Filter by author')} label={selectedAuthor?.label || filters.author || t('Author…')} active={!!filters.author} open={menu === 'authors'} onClick={() => setMenu(menu === 'authors' ? null : 'authors')} />
        {menu === 'authors' && <FilterPopover allLabel={t('All authors')} kind="author" values={authorOptions} selected={filters.author} onSelect={(author) => { updateFilters({ author }); setMenu(null); }} />}
      </div>
      {snapshotRepos.length > 1 && <div ref={menu === 'repos' ? activeFilter : undefined} className="filter-anchor repo-filter-anchor">
        <ToggleFilter icon={selectedRepo ? undefined : 'repo'} leading={selectedRepo ? <span className="filter-repo-dot" style={{ background: selectedRepo.color }} /> : undefined} title={selectedRepo?.label || t('Filter by repository')} label={selectedRepoLabel} active={!!filters.repoId} open={menu === 'repos'} onClick={() => setMenu(menu === 'repos' ? null : 'repos')} />
        {menu === 'repos' && <FilterPopover allLabel={t('All repositories')} kind="repo" values={repoOptions} selected={filters.repoId} onSelect={(repoId) => { updateFilters({ repoId }); setMenu(null); }} />}
      </div>}
      <div ref={menu === 'refs' ? activeFilter : undefined} className="filter-anchor branch-filter-anchor">
        <ToggleFilter icon={selectedRef?.icon || (filters.ref.startsWith('refs/tags/') ? 'tag' : 'git-branch')} title={filters.ref ? selectedRefLabel : t('Filter by branch or tag')} label={selectedRefLabel} active={!!filters.ref} open={menu === 'refs'} onClick={() => setMenu(menu === 'refs' ? null : 'refs')} />
        {menu === 'refs' && <FilterPopover allLabel={t('All branches & tags')} kind="ref" values={refOptions} selected={filters.ref} onSelect={(ref) => { updateFilters({ ref }); setMenu(null); }} />}
      </div>
      <div ref={menu === 'dates' ? activeFilter : undefined} className="filter-anchor date-filter-anchor">
        <DateFilter from={filters.from} to={filters.to} open={menu === 'dates'} onClick={() => setMenu(menu === 'dates' ? null : 'dates')} onClear={() => updateFilters({ from: '', to: '' })} />
        {menu === 'dates' && <DatePopover key={`${filters.from}:${filters.to}`} from={filters.from} to={filters.to} onChange={(from, to) => updateFilters({ from, to })} onClose={() => setMenu(null)} />}
      </div>
      {historyQuery.path && (
        <div
          className="history-path-chip"
          title={historyQuery.lineRange ? `${historyQuery.path} (${historyQuery.lineRange.start}-${historyQuery.lineRange.end})` : historyQuery.path}
        >
          <Codicon name="history" />
          <span>{t('History:')}</span>
          <strong>
            {historyQuery.lineRange
              ? t('{0}:lines {1}-{2}', historyQuery.path.split('/').pop() || historyQuery.path, historyQuery.lineRange.start, historyQuery.lineRange.end)
              : (historyQuery.path.split('/').pop() || historyQuery.path)}
          </strong>
          <IconButton
            type="button"
            className="history-path-clear"
            title={t('Clear history filter')}
            aria-label={t('Clear history filter')}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              void useAppStore.getState().clearHistoryPath();
            }}
          >
            <Codicon name="close" />
          </IconButton>
        </div>
      )}
      <div className="history-filter-actions">
        {filterActive && <IconButton type="button" className="history-clear-filters" title={t('Clear all filters')} aria-label={t('Clear all filters')} onClick={clearFilters}><Codicon name="clear-all" style={{ fontSize: '15px' }} /></IconButton>}
        <MoreMenu open={moreOpen} onToggle={() => setMoreOpen((value) => !value)} onFetch={() => void fetchAndRefresh()} expanded={expandedRepoIds.size > 0 && expandedRepoIds.size === new Set(allHistory.map((commit) => commit.repoId)).size} onToggleExpanded={toggleRepoNames} showRepoNames={snapshotRepos.length > 1} />
      </div>
    </div>}
    <div className="history-columns">
      <div className={`branch-slot ${branchSidebarCollapsed ? 'branch-slot-collapsed' : ''}`} style={{ width: branchSidebarCollapsed ? 28 : branchWidth }}>{branchSidebarCollapsed ? <IconButton className="branch-sidebar-expand" title={t('Show branches')} aria-label={t('Show branches')} onClick={() => setBranchSidebarState(false, collapsedSections)}><Codicon name="layout-sidebar-left-off" /></IconButton> : <BranchSidebar repoFilter={filters.repoId ? new Set([filters.repoId]) : new Set()} refFilter={filters.ref ? new Set([filters.ref]) : new Set()} onRepoFilter={(repoId) => updateFilters({ repoId })} refRepoIds={historyScope.repoIds} onRefFilter={selectSidebarRef} onCompare={openBranchComparison} onCollapse={() => setBranchSidebarState(true, collapsedSections)} />}</div>
      {!branchSidebarCollapsed && <div className="inner-resize-handle" role="separator" tabIndex={0} aria-label={t('Resize branch sidebar')} aria-orientation="vertical" aria-valuemin={120} aria-valuemax={400} aria-valuenow={branchWidth} onPointerDown={resizeBranches} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPanelSize('branches', Math.min(400, Math.max(120, branchWidth + (event.key === 'ArrowRight' ? 10 : -10)))); } }} />}
      <div className="log-pane">{compareTarget ? <BranchComparePanel
        key={`${compareTarget.repoId}:${compareTarget.target}`}
        repoId={compareTarget.repoId}
        initialTarget={compareTarget.target}
        close={closeBranchComparison}
        renderCommits={(commits) => <CommitList history={commits} loading={false} expandedRepoIds={new Set()} onToggleRepoName={() => undefined} repoKindById={repoKindById} remoteNamesByRepo={remoteNamesByRepo} isFiltered repoSortKeyById={repoSortKeyById} hasMoreOverride={false} singleRepository />}
      /> : <CommitList history={visibleHistory} loading={historyLoading} expandedRepoIds={expandedRepoIds} onToggleRepoName={(repoId) => setExpandedRepoIds((current) => { const next = new Set(current); if (next.has(repoId)) next.delete(repoId); else next.add(repoId); return next; })} repoKindById={repoKindById} remoteNamesByRepo={remoteNamesByRepo} topologyCommits={topologyCommits} isFiltered={hasTopologyBreakingFilter} hasRevisionFilter={hasBranchFilter} repoSortKeyById={repoSortKeyById} />}</div>
      {!detailSidebarCollapsed && <div className="inner-resize-handle" role="separator" tabIndex={0} aria-label={t('Resize detail sidebar')} aria-orientation="vertical" aria-valuemin={220} aria-valuemax={680} aria-valuenow={detailWidth} onPointerDown={resizeDetail} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPanelSize('detail', Math.min(680, Math.max(220, detailWidth + (event.key === 'ArrowLeft' ? 10 : -10)))); } }} />}
      <div className={`detail-slot ${detailSidebarCollapsed ? 'detail-slot-collapsed' : ''}`} style={{ width: detailSidebarCollapsed ? 28 : detailWidth }}>{detailSidebarCollapsed ? <IconButton className="detail-sidebar-expand" title={t('Show commit detail')} aria-label={t('Show commit detail')} onClick={() => setDetailSidebarCollapsed(false)}><Codicon name="layout-sidebar-right-off" /></IconButton> : <CommitDetailPanel key={snapshotWorkspaceId} onCollapse={() => setDetailSidebarCollapsed(true)} />}</div>
    </div>
  </section>;
}
