import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { useResizable } from '../hooks/useResizable';
import { BranchSidebar } from './BranchSidebar';
import { BranchComparePanel } from './BranchComparePanel';
import { CommitGraph } from './CommitGraph';
import { CommitDetailPanel } from './CommitDetailPanel';
import { buildHistoryRefOptions } from './HistoryWorkspace.helpers';
import { assignLanes, COMMIT_ROW_HEIGHT, layoutVisibleCommits, type GraphCommit } from './commitGraphLayout';
import { commitKey } from '../history/commitDetails';
import { formatRefLabel, groupRefs, mergeLocalRemote, type RefGroup } from '../history/refs';
import { branchColor, headColor, isPrimaryBranch, primaryBranchColor, tagColor } from './branchColor';
import type { CommitDetail, CommitNode, GraphCommitNode } from '../bindings/generated';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { choiceDialog, confirmDialog, promptDialog } from './dialogService';
import { CommitSearch, DatePopover, FilterPopover, ToggleFilter } from './HistoryFilterControls';

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

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || '?').toUpperCase();
}

function avatarColor(value: string): string {
  return branchColor(value || 'author');
}

function MoreMenu({ open, onToggle, onFetch, expanded, onToggleExpanded }: { open: boolean; onToggle: () => void; onFetch: () => void; expanded: boolean; onToggleExpanded: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onToggle(); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onToggle, open]);
  return <div ref={ref} className="history-more"><button className={`more-button ${open ? 'selected' : ''}`} title={t('More actions')} aria-label={t('More actions')} onClick={onToggle}><Codicon name="three-bars" /></button>{open && <div className="more-menu">
    <button onClick={() => { onFetch(); onToggle(); }}><Codicon name="sync" />{t('Fetch and Refresh')}</button>
    <button onClick={() => { onToggleExpanded(); onToggle(); }}><Codicon name={expanded ? 'collapse-all' : 'expand-all'} />{t(expanded ? 'Collapse project names' : 'Expand project names')}</button>
  </div>}</div>;
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  if (group.isSvnRevision) return <Codicon name="versions" />;
  if (group.isTag) return <Codicon name="tag" />;
  if (group.isRemote) return <Codicon name="cloud" />;
  if (group.isHead || group.isDetached) return <Codicon name="arrow-right" />;
  return <Codicon name="git-branch" />;
}

function badgeColor(group: RefGroup): string {
  if (group.isTag || group.isSvnRevision) return tagColor();
  if (group.isHead || group.isDetached) return headColor();
  if (isPrimaryBranch(group.label)) return primaryBranchColor();
  return branchColor(group.label);
}

function RefBadges({
  refs,
  repoKind = 'git',
  remoteNames = [],
  isSelected = false,
}: {
  refs: string[];
  repoKind?: 'git' | 'svn';
  remoteNames?: readonly string[];
  isSelected?: boolean;
}) {
  const { t } = useI18n();
  const allGroups = useMemo(
    () => mergeLocalRemote(groupRefs(refs, repoKind, remoteNames)),
    [refs, repoKind, remoteNames],
  );
  if (allGroups.length === 0) return null;

  const headGroup = allGroups.find((g) => g.isHead && !g.isDetached && !g.isSvnRevision);
  const remoteHeadGroups = allGroups.filter((g) => g.isRemoteHead);
  const remoteHeadGroup = remoteHeadGroups.length === 1 ? remoteHeadGroups[0] : undefined;
  const headAndRemoteHead = headGroup && remoteHeadGroup;
  const otherGroups = allGroups.filter((g) => !(headAndRemoteHead && g.key === remoteHeadGroup.key));

  const visible = otherGroups.slice(0, 2);
  const overflow = otherGroups.slice(2);
  const hc = headColor();

  return (
    <span className="commit-refs">
      {visible.map((group) => {
        const color = badgeColor(group);
        return (
          <em
            key={group.key}
            className={`${group.isTag ? 'tag' : group.isRemote ? 'remote' : group.isHead ? 'head' : group.isSvnRevision ? 'svn' : 'branch'} ${isSelected ? 'selected' : ''}`}
            style={{ '--ref-color': color } as React.CSSProperties}
            title={group.label}
          >
            <RefBadgeIcon group={group} />
            <span className="ref-label">{formatRefLabel(group, t('Remote'))}</span>
          </em>
        );
      })}
      {headGroup && (
        <em
          className={`head ${isSelected ? 'selected' : ''}`}
          style={{ '--ref-color': hc } as React.CSSProperties}
          title="HEAD"
        >
          {headAndRemoteHead ? <Codicon name="milestone" /> : <Codicon name="arrow-right" />}
          <span className="ref-label">{headAndRemoteHead ? `${remoteHeadGroup!.remoteName}/HEAD & HEAD` : 'HEAD'}</span>
        </em>
      )}
      {overflow.length > 0 && (
        <em className={`ref-overflow ${isSelected ? 'selected' : ''}`} title={overflow.map((g) => g.label).join('\n')}>
          +{overflow.length}
        </em>
      )}
    </span>
  );
}

type CommitWithIndicators = CommitNode & { incoming?: boolean; unpushed?: boolean };
type CommitPopoverAnchor = { rowTop: number; listTop: number; listBottom: number; listLeft: number; listRight: number; mouseX: number };

function CommitPopover({ detail, anchor, onEnter, onLeave }: { detail: CommitDetail; anchor: CommitPopoverAnchor; onEnter: () => void; onLeave: () => void }) {
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
    const belowTop = anchor.rowTop + COMMIT_ROW_HEIGHT + 6;
    const top = preferredTop >= anchor.listTop
      ? preferredTop
      : Math.max(anchor.listTop, Math.min(belowTop, anchor.listBottom - height));
    setPosition({ top, left });
  }, [anchor]);
  return <div ref={popoverRef} className="commit-popover" style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden', pointerEvents: position ? 'auto' : 'none' }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <div className="popover-line"><Codicon name="git-commit" /><code>{detail.commit.shortHash}</code></div>
    <div className="popover-line"><span className="mini-avatar" style={{ background: avatarColor(detail.commit.email || detail.commit.author) }}>{initials(detail.commit.author)}</span><span>{detail.commit.author}</span><i>·</i><time>{formatDate(detail.commit.authorDate)}</time></div>
    <div className="popover-line"><Codicon name="diff" /><span>{detail.files.length} {detail.files.length === 1 ? t('file changed') : t('files changed')}</span>{added > 0 && <b className="added">+{added}</b>}{removed > 0 && <b className="removed">-{removed}</b>}</div>
    <RefBadges refs={detail.commit.refs} />
    <small>{t('Click to view more details')}</small>
  </div>;
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
  const storeHasMore = useAppStore((state) => state.historyHasMore);
  const hasMore = hasMoreOverride ?? storeHasMore;
  const selected = useAppStore((state) => new Set(state.selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash))));
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectCommit = useAppStore((state) => state.selectCommit);
  const loadCommitDetail = useAppStore((state) => state.loadCommitDetail);
  const openCommitDetail = useAppStore((state) => state.openCommitDetail);
  const openChanges = useAppStore((state) => state.openCommitChanges);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const unpushedOperation = useAppStore((state) => state.unpushedOperation);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const createPatch = useAppStore((state) => state.createPatch);
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
  const [hoveredKey, setHoveredKey] = useState<string>();
  const [context, setContext] = useState<{ x: number; y: number; commit: CommitNode }>();
  const [popover, setPopover] = useState<{ detail: CommitDetail; anchor: CommitPopoverAnchor }>();
  const hoveredKeyRef = useRef<string>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const popoverActive = useRef(false);

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const schedulePopover = (event: React.MouseEvent<HTMLDivElement>, commit: CommitNode) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const key = commitKey(commit.repoId, commit.hash);
    setHoveredKey(key);
    hoveredKeyRef.current = key;
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
    }, 650);
  };
  const closePopoverSoon = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoveredKey(undefined);
    hoveredKeyRef.current = undefined;
    closeTimer.current = setTimeout(() => { if (!popoverActive.current) setPopover(undefined); }, 140);
  };
  const allExpanded = repoBlocks.length > 0 && repoBlocks.every((block) => expandedRepoIds.has(block.repoId));
  const virtualItems = virtualizer.getVirtualItems();
  const renderedItems = virtualItems.length > 0 ? virtualItems : commits.map((_, index) => ({ index, start: index * COMMIT_ROW_HEIGHT }));
  const contextItems = (commit: CommitNode): ContextMenuEntry[] => {
    const git = repoKindById[commit.repoId] !== 'svn';
    const selection = selected.has(commitKey(commit.repoId, commit.hash)) && selectedCommits.length > 1 && selectedCommits.every((item) => item.repoId === commit.repoId) ? selectedCommits : [commit];
    if (selection.length > 1) {
      const allUnpushed = selection.every((item) => item.unpushed);
      return [
        { id: 'patch-multi', label: t('Create Patch...'), icon: 'diff' },
        ...(git ? [{ id: 'cherry-pick-multi', label: t('Cherry-Pick All'), icon: 'git-commit' } as ContextMenuEntry, { separator: true } as ContextMenuEntry, { id: 'revert-multi', label: t('Revert Commits'), icon: 'discard' } as ContextMenuEntry] : []),
        ...(allUnpushed ? [{ separator: true } as ContextMenuEntry, { id: 'drop-multi', label: t('Drop Commits'), icon: 'trash', danger: true } as ContextMenuEntry, { id: 'squash-multi', label: t('Squash {0} Commits...', selection.length), icon: 'fold-down' } as ContextMenuEntry] : []),
      ];
    }
    const hasTags = commit.refs.some((ref) => ref.startsWith('refs/tags/') || ref.startsWith('tag: '));
    const items: ContextMenuEntry[] = [
      { id: 'copy', label: t('Copy Revision Number'), icon: 'copy' },
      { separator: true },
      { id: 'branch', label: t('New Branch...'), icon: 'git-branch' },
      { id: hasTags ? 'manage-tags' : 'tag', label: t(hasTags ? 'Manage Tags...' : 'New Tag...'), icon: 'tag' },
      { separator: true },
      { id: git ? 'checkout' : 'svn-update', label: t(git ? 'Checkout Revision' : 'Update to Revision'), icon: 'arrow-right' },
      { separator: true },
      { id: 'patch', label: t('Create Patch...'), icon: 'diff' },
    ];
    if (!git) return items;
    items.push(
      { id: 'cherry-pick', label: t('Cherry-Pick'), icon: 'git-commit' },
      { separator: true },
      { id: 'reset', label: t('Reset Current Branch to Here...'), icon: 'history', danger: true },
      { id: 'revert', label: t('Revert Commit'), icon: 'discard' },
    );
    if (commit.unpushed) items.push(
      { separator: true },
      ...(commits[0]?.hash === commit.hash ? [{ id: 'edit', label: t('Edit Commit Message…'), icon: 'edit' } as ContextMenuEntry, { id: 'undo', label: t('Undo Commit'), icon: 'arrow-left', danger: true } as ContextMenuEntry] : []),
      { id: 'drop', label: t('Drop Commit'), icon: 'trash', danger: true },
    );
    return items;
  };
  const runContext = async (id: string) => {
    const commit = context?.commit;
    if (!commit) return;
    const selection = selected.has(commitKey(commit.repoId, commit.hash)) && selectedCommits.length > 1 && selectedCommits.every((item) => item.repoId === commit.repoId) ? selectedCommits : [commit];
    const index = new Map(commits.map((item, position) => [commitKey(item.repoId, item.hash), position]));
    const oldestFirst = [...selection].sort((left, right) => (index.get(commitKey(right.repoId, right.hash)) ?? 0) - (index.get(commitKey(left.repoId, left.hash)) ?? 0));
    const newestFirst = [...selection].sort((left, right) => (index.get(commitKey(left.repoId, left.hash)) ?? 0) - (index.get(commitKey(right.repoId, right.hash)) ?? 0));
    if (id === 'copy') await navigator.clipboard?.writeText(commit.hash).catch(() => undefined);
    if (id === 'patch' || id === 'patch-multi') {
      const patch = await createPatch(commit.repoId, selection.map((item) => item.hash));
      const url = URL.createObjectURL(new Blob([patch.content], { type: 'text/x-patch;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = patch.fileName; link.click(); URL.revokeObjectURL(url);
    }
    if (id === 'branch') { const name = await promptDialog({ title: t('New Branch'), message: commit.shortHash, inputLabel: t('Branch name') }); if (name) await branchOperation({ type: 'create', name, from: commit.hash }, commit.repoId); }
    if (id === 'tag') { const name = await promptDialog({ title: t('New Tag'), message: commit.shortHash, inputLabel: t('Tag name') }); if (name) await tagOperation({ type: 'create', name, revision: commit.hash }, commit.repoId); }
    if (id === 'manage-tags') {
      const tags = commit.refs.flatMap((ref) => ref.startsWith('refs/tags/') ? [ref.slice('refs/tags/'.length)] : ref.startsWith('tag: ') ? [ref.slice('tag: '.length).replace(/^refs\/tags\//, '')] : []);
      const action = await choiceDialog({ title: t('Manage Tags...'), message: commit.shortHash, choices: [{ id: 'create', label: t('New Tag...'), icon: 'add' }, ...tags.map((name) => ({ id: `delete:${name}`, label: t('Delete tag "{0}"', name), icon: 'trash', danger: true }))] });
      if (action === 'create') { const name = await promptDialog({ title: t('New Tag'), message: commit.shortHash, inputLabel: t('Tag name') }); if (name) await tagOperation({ type: 'create', name, revision: commit.hash }, commit.repoId); }
      if (action?.startsWith('delete:')) await tagOperation({ type: 'delete', name: action.slice('delete:'.length) }, commit.repoId);
    }
    if (id === 'checkout' && await confirmDialog({ title: t('Checkout revision?'), message: `${commit.shortHash} ${commit.message}\n\n${t('The repository will enter detached HEAD state.')}` })) await historyOperation(commit.repoId, { type: 'checkout', revision: commit.hash });
    if (id === 'svn-update' && await confirmDialog({ title: t('Update to SVN revision?'), message: `r${commit.hash}` })) await historyOperation(commit.repoId, { type: 'svnUpdateTo', revision: commit.hash });
    if (id === 'cherry-pick' && await confirmDialog({ title: t('Cherry-pick commit?'), message: `${commit.shortHash} ${commit.message}` })) await historyOperation(commit.repoId, { type: 'cherryPick', revision: commit.hash });
    if (id === 'cherry-pick-multi' && await confirmDialog({ title: t('Cherry-Pick All'), message: oldestFirst.map((item) => `${item.shortHash} ${item.message}`).join('\n') })) for (const item of oldestFirst) await historyOperation(commit.repoId, { type: 'cherryPick', revision: item.hash });
    if (id === 'revert' && await confirmDialog({ title: t('Revert commit?'), message: `${commit.shortHash} ${commit.message}\n\n${t('A new inverse commit will be created.')}`, danger: true })) await historyOperation(commit.repoId, { type: 'revert', revisions: [commit.hash] });
    if (id === 'revert-multi' && await confirmDialog({ title: t('Revert Commits'), message: newestFirst.map((item) => `${item.shortHash} ${item.message}`).join('\n'), danger: true })) await historyOperation(commit.repoId, { type: 'revert', revisions: newestFirst.map((item) => item.hash) });
    if (id === 'reset') {
      const mode = await choiceDialog({ title: t('Reset Current Branch to Here...'), message: `${commit.shortHash} ${commit.message}`, danger: true, choices: [{ id: 'soft', label: t('Soft'), description: t('Keep staged and unstaged changes'), icon: 'arrow-down' }, { id: 'mixed', label: t('Mixed'), description: t('Keep unstaged changes, unstage staged changes'), icon: 'discard' }, { id: 'hard', label: t('Hard'), description: t('Discard all changes'), icon: 'warning', danger: true }] });
      if (mode && await confirmDialog({ title: t('Reset {0}?', mode), message: `${commit.shortHash} ${commit.message}\n\n${t(mode === 'hard' ? 'All working tree and index changes will be discarded.' : 'Commits after this revision will be removed from the current branch.')}`, danger: true })) await historyOperation(commit.repoId, { type: 'reset', revision: commit.hash, mode });
    }
    if (id === 'edit') { const message = await promptDialog({ title: t('Edit Commit Message'), message: commit.shortHash, inputLabel: t('Commit message'), initialValue: commit.message }); if (message) await unpushedOperation(commit.repoId, { type: 'editMessage', hash: commit.hash, message }); }
    if (id === 'undo' && await confirmDialog({ title: t('Undo Commit?'), message: `${commit.shortHash} ${commit.message}\n\n${t('Changes remain staged.')}`, danger: true })) await unpushedOperation(commit.repoId, { type: 'undoHead' });
    if (id === 'drop' && await confirmDialog({ title: t('Drop Commit?'), message: `${commit.shortHash} ${commit.message}\n\n${t('This rewrites local history and may require force push.')}`, danger: true })) await unpushedOperation(commit.repoId, { type: 'drop', hashes: [commit.hash] });
    if (id === 'drop-multi' && await confirmDialog({ title: t('Drop Commits'), message: newestFirst.map((item) => `${item.shortHash} ${item.message}`).join('\n'), danger: true })) await unpushedOperation(commit.repoId, { type: 'drop', hashes: newestFirst.map((item) => item.hash) });
    if (id === 'squash-multi') { const message = await promptDialog({ title: t('Squash {0} Commits...', selection.length), message: t('The selection must be contiguous and include HEAD.'), inputLabel: t('Combined commit message'), initialValue: oldestFirst.map((item) => item.message).join('\n\n') }); if (message) await unpushedOperation(commit.repoId, { type: 'squash', hashes: newestFirst.map((item) => item.hash), message }); }
    setContext(undefined);
  };

  return <div className="commit-list" ref={parent} onScroll={(event) => { const element = event.currentTarget; if (hasMore && !loading && element.scrollHeight - element.scrollTop - element.clientHeight < 300) { if (onLoadMore) onLoadMore(); else void loadHistory(false); } }}>
    <div className="commit-list-content" style={{ height: virtualizer.getTotalSize() }}>
      {multiRepo && repoBlocks.map((block) => {
        const blockTopPx = block.start * COMMIT_ROW_HEIGHT;
        const blockHeightPx = block.count * COMMIT_ROW_HEIGHT;
        const leadingGap = block.start > 0 ? BLOCK_GAP : 0;
        const top = blockTopPx + leadingGap;
        const height = Math.max(0, blockHeightPx - leadingGap);
        const expanded = expandedRepoIds.has(block.repoId);
        return <button key={`${block.repoId}:${block.start}`} className={`repo-strip ${expanded ? 'expanded' : ''}`} style={{ top, height, '--repo-color': block.color } as React.CSSProperties} onClick={() => onToggleRepoName(block.repoId)} title={block.name}><span className="repo-strip-bar" />{expanded && <strong>{block.name}</strong>}</button>;
      })}
      {renderedItems.map((item) => {
        const commit = commits[item.index] as GraphCommit & CommitWithIndicators;
        if (!commit) return null;
        const key = commitKey(commit.repoId, commit.hash);
        const isSelected = selected.has(key);
        const isMergeCommit = commit.parents.length > 1;
        return <div key={key} className={`commit-row ${isSelected ? 'selected' : ''}`} style={{ transform: `translateY(${item.start}px)` }} role="button" tabIndex={0} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, commit }); if (!isSelected) void selectCommit(commit, 'single', commits); }} onMouseEnter={(event) => schedulePopover(event, commit)} onMouseLeave={closePopoverSoon} onClick={(event) => void selectCommit(commit, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single', commits)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') void selectCommit(commit, 'single', commits); }} title={`${commit.hash}\n${commit.author}\n${formatDate(commit.authorDate)}`}>
          {labelColWidth > 0 && <div style={{ width: labelColWidth, flexShrink: 0 }} />}
          <CommitGraph commit={commit} selected={isSelected} />
          <RefBadges refs={commit.refs} repoKind={repoKindById[commit.repoId] ?? 'git'} remoteNames={remoteNamesByRepo[commit.repoId] ?? []} isSelected={isSelected} />
          <span className={`commit-subject-text ${isMergeCommit ? 'merge-commit' : ''}`}>{commit.message}</span>
          <span className="commit-author">
            {hoveredKey === key && <span className="commit-row-actions"><button title={t('Open Commit Detail')} onClick={(event) => { event.stopPropagation(); void selectCommit(commit).then(openCommitDetail); }}><Codicon name="open-preview" /></button><button title={t('Open Changes')} onClick={(event) => { event.stopPropagation(); void selectCommit(commit).then(openChanges); }}><Codicon name="diff-multiple" /></button></span>}
            <span className={`commit-flow-indicators ${commit.incoming || commit.unpushed ? 'has-flow' : ''} ${commit.incoming && commit.unpushed ? 'has-both' : ''}`}>
              {commit.incoming && <span title={t('Not pulled')}><Codicon name="arrow-down" className="commit-flow-icon incoming" /></span>}
              {commit.unpushed && <span title={t('Not pushed')}><Codicon name="arrow-up" className="commit-flow-icon unpushed" /></span>}
            </span>
            <span className="mini-avatar" style={{ background: avatarColor(commit.email || commit.author) }}>{initials(commit.author)}</span><span className="commit-author-name">{commit.author}</span>
          </span>
          <time>{formatDate(commit.committerDate)}</time>
        </div>;
      })}
    </div>
    {popover && <CommitPopover detail={popover.detail} anchor={popover.anchor} onEnter={() => { popoverActive.current = true; if (closeTimer.current) clearTimeout(closeTimer.current); }} onLeave={() => { popoverActive.current = false; setPopover(undefined); }} />}
    {context && <ContextMenu x={context.x} y={context.y} items={contextItems(context.commit)} onSelect={(id) => void runContext(id)} onClose={() => setContext(undefined)} />}
    {loading && <div className="history-loading" role="status" aria-live="polite"><Codicon name="loading codicon-modifier-spin" /><span>{t('Loading commits…')}</span></div>}
    {!loading && !commits.length && <div className="empty-state"><Codicon name="history" /><span>{t('No history')}</span></div>}
    {commits.length > 0 && allExpanded && <span className="sr-only">{t('Collapse project names')}</span>}
  </div>;
}

export function HistoryWorkspace() {
  const { t } = useI18n();
  const [menu, setMenu] = useState<FilterMenu>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [authorQuery, setAuthorQuery] = useState('');
  const [refQuery, setRefQuery] = useState('');
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
  const setHistorySearch = useAppStore((state) => state.setHistoryFilter);
  const setHistoryScope = useAppStore((state) => state.setHistoryScope);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const refresh = useAppStore((state) => state.refresh);
  const sync = useAppStore((state) => state.sync);
  const branchWidth = useAppStore((state) => state.bootstrap?.state.layout?.panelSizes.branches ?? state.bootstrap?.state.panelSizes?.branches ?? 220);
  const detailWidth = useAppStore((state) => state.bootstrap?.state.layout?.panelSizes.detail ?? state.bootstrap?.state.panelSizes?.detail ?? 380);
  const setPanelSize = useAppStore((state) => state.setPanelSize);
  const branchSidebarCollapsed = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsed ?? state.bootstrap?.state.branchSidebarCollapsed ?? false);
  const collapsedSections = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsedSections ?? state.bootstrap?.state.branchSidebarCollapsedSections ?? []);
  const setBranchSidebarState = useAppStore((state) => state.setBranchSidebarState);
  const [detailSidebarCollapsed, setDetailSidebarCollapsed] = useState(false);
  const compareTarget = useAppStore((state) => state.comparisonTarget);
  const openBranchComparison = useAppStore((state) => state.openBranchComparison);
  const closeBranchComparison = useAppStore((state) => state.closeBranchComparison);
  const resizeBranches = useResizable(branchWidth, 190, 420, (value) => setPanelSize('branches', value));
  const resizeDetail = useResizable(detailWidth, 300, 620, (value) => setPanelSize('detail', value), -1);

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

  const hasTopologyBreakingFilter = !!(historySearch.trim() || filters.author || filters.from || filters.to);
  const hasBranchFilter = !!filters.ref;
  const topologyCommits = !hasTopologyBreakingFilter
    ? (historyTopology.length > 0 ? historyTopology : hasBranchFilter ? allHistory : undefined)
    : undefined;

  const authorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    allHistory.forEach((commit) => counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1));
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([author, count]) => ({ id: author, label: author, detail: String(count), icon: 'person' }));
  }, [allHistory]);
  const repoOptions = snapshotRepos.map((repo) => ({ id: repo.meta.id, label: repo.meta.name, color: repo.meta.color, detail: repo.meta.kind.toUpperCase() }));
  const refOptions = useMemo(
    () => buildHistoryRefOptions(snapshotRepos, branchesByRepo, tagsByRepo),
    [branchesByRepo, snapshotRepos, tagsByRepo],
  );
  const selectedRepo = repoOptions.find((option) => option.id === filters.repoId);
  const selectedRepoLabel = selectedRepo?.label ?? t('Repository');
  const selectedRefLabel = refOptions.find((option) => option.id === filters.ref)?.label ?? t('Branch / Tags');
  const filterActive = !!(filters.author || filters.repoId || filters.ref || filters.from || filters.to);
  const visibleHistory = useMemo(() => allHistory.filter((commit) => {
    const search = historySearch.trim().toLowerCase();
    if (search && !`${commit.message} ${commit.hash} ${commit.author}`.toLowerCase().includes(search)) return false;
    if (filters.author && commit.author !== filters.author) return false;
    if (filters.repoId && commit.repoId !== filters.repoId) return false;
    const date = Date.parse(commit.committerDate);
    if (filters.from && date < Date.parse(`${filters.from}T00:00:00`)) return false;
    if (filters.to && date > Date.parse(`${filters.to}T23:59:59`)) return false;
    return true;
  }), [allHistory, filters, historySearch]);
  const updateFilters = (next: Partial<ViewFilters>) => {
    const updated = { ...filters, ...next };
    setFilters(updated);
    if (!Object.hasOwn(next, 'repoId') && !Object.hasOwn(next, 'ref')) return;
    const selectedRef = refOptions.find((option) => option.id === updated.ref);
    const repoIds = snapshotRepos
      .map((repo) => repo.meta.id)
      .filter((repoId) => (!updated.repoId || repoId === updated.repoId) && (!selectedRef || selectedRef.repoIds.includes(repoId)));
    const revisionsByRepo = selectedRef
      ? Object.fromEntries(repoIds.flatMap((repoId) => selectedRef.revisionsByRepo[repoId] ? [[repoId, selectedRef.revisionsByRepo[repoId]]] : []))
      : {};
    setHistoryScope({ repoIds: updated.repoId || selectedRef ? repoIds : null, revisionsByRepo });
    queueMicrotask(() => void loadHistory(true).catch(() => undefined));
  };
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setHistoryScope({ repoIds: null, revisionsByRepo: {} });
    queueMicrotask(() => void loadHistory(true).catch(() => undefined));
  };
  const fetchAndRefresh = async () => {
    await Promise.all(snapshotRepos.filter((repo) => repo.meta.kind === 'git').map((repo) => sync(repo.meta.id, 'fetch')));
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
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', handleOutside, true); document.removeEventListener('keydown', escape); };
  }, [menu]);

  if (!selectedRepoId) return <div className="workspace-empty"><Codicon name="repo" />{t('Select a repository')}</div>;
  return <section className="history-workspace">
    {!compareTarget && <div className="history-filters" onClick={(event) => event.stopPropagation()}>
      <CommitSearch value={historySearch} onChange={setHistorySearch} onSubmit={() => void loadHistory(true).catch(() => undefined)} onClear={() => queueMicrotask(() => void loadHistory(true).catch(() => undefined))} />
      <div ref={menu === 'authors' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon="person" label={filters.author ? filters.author : t('Author…')} active={!!filters.author} open={menu === 'authors'} onClick={() => setMenu(menu === 'authors' ? null : 'authors')} />{menu === 'authors' && <FilterPopover title={t('Author')} values={authorOptions} selected={filters.author} onSelect={(author) => { updateFilters({ author }); setMenu(null); }} onClear={() => updateFilters({ author: '' })} query={authorQuery} onQuery={setAuthorQuery} />}</div>
      <div ref={menu === 'repos' ? activeFilter : undefined} className="filter-anchor"><ToggleFilter icon={selectedRepo ? undefined : 'repo'} leading={selectedRepo ? <span className="filter-repo-dot" style={{ background: selectedRepo.color }} /> : undefined} label={selectedRepoLabel} active={!!filters.repoId} open={menu === 'repos'} onClick={() => setMenu(menu === 'repos' ? null : 'repos')} />{menu === 'repos' && <FilterPopover title={t('Repository')} values={repoOptions} selected={filters.repoId} onSelect={(repoId) => { updateFilters({ repoId }); setMenu(null); }} onClear={() => updateFilters({ repoId: '' })} />}</div>
      <div ref={menu === 'refs' ? activeFilter : undefined} className="filter-anchor branch-filter-anchor"><ToggleFilter icon="git-branch" label={selectedRefLabel} active={!!filters.ref} open={menu === 'refs'} onClick={() => setMenu(menu === 'refs' ? null : 'refs')} />{menu === 'refs' && <FilterPopover title={t('Branch / Tags')} values={refOptions} selected={filters.ref} onSelect={(ref) => { updateFilters({ ref }); setMenu(null); }} onClear={() => updateFilters({ ref: '' })} query={refQuery} onQuery={setRefQuery} />}</div>
      <div ref={menu === 'dates' ? activeFilter : undefined} className="filter-anchor date-filter-anchor"><ToggleFilter icon="calendar" label={filters.from || filters.to ? `${filters.from || '…'} → ${filters.to || '…'}` : t('From → To')} active={!!filters.from || !!filters.to} open={menu === 'dates'} onClick={() => setMenu(menu === 'dates' ? null : 'dates')} />{menu === 'dates' && <DatePopover from={filters.from} to={filters.to} onChange={(from, to) => updateFilters({ from, to })} onClear={() => updateFilters({ from: '', to: '' })} />}</div>
      <span className="history-filter-spacer" />
      {filterActive && <button className="history-clear-filters" title={t('Clear all filters')} onClick={clearFilters}><Codicon name="clear-all" /></button>}
      <MoreMenu open={moreOpen} onToggle={() => setMoreOpen((value) => !value)} onFetch={() => void fetchAndRefresh()} expanded={expandedRepoIds.size > 0 && expandedRepoIds.size === new Set(allHistory.map((commit) => commit.repoId)).size} onToggleExpanded={toggleRepoNames} />
    </div>}
    <div className="history-columns">
      <div className={`branch-slot ${branchSidebarCollapsed ? 'branch-slot-collapsed' : ''}`} style={{ width: branchSidebarCollapsed ? 28 : branchWidth }}>{branchSidebarCollapsed ? <button className="branch-sidebar-expand" title={t('Show branches')} aria-label={t('Show branches')} onClick={() => setBranchSidebarState(false, collapsedSections)}><Codicon name="layout-sidebar-left-off" /></button> : <BranchSidebar repoFilter={filters.repoId ? new Set([filters.repoId]) : new Set()} refFilter={filters.ref ? new Set([filters.ref]) : new Set()} onRepoFilter={(repoId) => updateFilters({ repoId })} onRefFilter={(ref) => updateFilters({ ref })} onCompare={openBranchComparison} onCollapse={() => setBranchSidebarState(true, collapsedSections)} />}</div>
      {!branchSidebarCollapsed && <div className="inner-resize-handle" role="separator" tabIndex={0} aria-label={t('Resize branch sidebar')} aria-orientation="vertical" aria-valuemin={190} aria-valuemax={420} aria-valuenow={branchWidth} onPointerDown={resizeBranches} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPanelSize('branches', Math.min(420, Math.max(190, branchWidth + (event.key === 'ArrowRight' ? 10 : -10)))); } }} />}
      <div className="log-pane">{compareTarget ? <BranchComparePanel
        key={`${compareTarget.repoId}:${compareTarget.target}`}
        repoId={compareTarget.repoId}
        initialTarget={compareTarget.target}
        close={closeBranchComparison}
        renderCommits={(commits) => <CommitList history={commits} loading={false} expandedRepoIds={new Set()} onToggleRepoName={() => undefined} repoKindById={repoKindById} remoteNamesByRepo={remoteNamesByRepo} isFiltered repoSortKeyById={repoSortKeyById} hasMoreOverride={false} singleRepository />}
      /> : <CommitList history={visibleHistory} loading={historyLoading} expandedRepoIds={expandedRepoIds} onToggleRepoName={(repoId) => setExpandedRepoIds((current) => { const next = new Set(current); if (next.has(repoId)) next.delete(repoId); else next.add(repoId); return next; })} repoKindById={repoKindById} remoteNamesByRepo={remoteNamesByRepo} topologyCommits={topologyCommits} isFiltered={hasTopologyBreakingFilter} hasRevisionFilter={hasBranchFilter} repoSortKeyById={repoSortKeyById} />}</div>
      {!detailSidebarCollapsed && <div className="inner-resize-handle" role="separator" tabIndex={0} aria-label={t('Resize detail sidebar')} aria-orientation="vertical" aria-valuemin={300} aria-valuemax={620} aria-valuenow={detailWidth} onPointerDown={resizeDetail} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPanelSize('detail', Math.min(620, Math.max(300, detailWidth + (event.key === 'ArrowLeft' ? 10 : -10)))); } }} />}
      <div className={`detail-slot ${detailSidebarCollapsed ? 'detail-slot-collapsed' : ''}`} style={{ width: detailSidebarCollapsed ? 28 : detailWidth }}>{detailSidebarCollapsed ? <button className="detail-sidebar-expand" title={t('Show commit detail')} aria-label={t('Show commit detail')} onClick={() => setDetailSidebarCollapsed(false)}><Codicon name="layout-sidebar-right-off" /></button> : <CommitDetailPanel onCollapse={() => setDetailSidebarCollapsed(true)} />}</div>
    </div>
  </section>;
}
