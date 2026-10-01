import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchInfo, CommitDetail, IncomingCommit, RepositoryStatus, RevisionChanges, UnpushedCommit, UnpushedOperation } from '../bindings/generated';
import { useI18n } from '../i18n';
import { capabilityAvailable, isOperationActive, isOperationActiveForRepositories, resolveNotificationText, useAppStore } from '../store/appStore';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { branchColor, readableAccentColor } from './branchColor';
import { BranchRefBadge } from './BranchRefBadge';
import { Codicon } from './Codicon';
import { AuthorAvatar } from './AuthorAvatar';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { choiceDialog, confirmDialog, editorDialog, promptDialog } from './dialogService';
import { SyncFileList, type SyncFileViewMode } from './SyncFileList';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';
import { SelectionCheckbox } from './SelectionCheckbox';
import { BranchMenuPopover } from './StatusBar/BranchMenuPopover';
import { isAbortError } from '../platform/bridge';

async function resolvePullStrategy(
  t: (key: string, ...args: Array<string | number>) => string,
  explicitStrategy?: 'merge' | 'rebase' | 'ff-only',
): Promise<'merge' | 'rebase' | 'ff-only' | undefined> {
  if (explicitStrategy) return explicitStrategy;
  const configured = useAppStore.getState().bootstrap?.state.settings?.updateProjectMethod ?? 'rebase';
  if (configured === 'prompt') {
    const choice = await choiceDialog({
      title: t('Update Project — Strategy'),
      message: t('Choose how to integrate incoming changes'),
      choices: [
        {
          id: 'rebase',
          label: t('Rebase the current branch on top of incoming changes'),
          icon: 'repo-forked',
        },
        {
          id: 'merge',
          label: t('Merge incoming changes into the current branch'),
          icon: 'git-merge',
        },
      ],
    });
    if (!choice) return undefined;
    return choice as 'rebase' | 'merge';
  }
  return configured === 'rebase' ? 'rebase' : 'merge';
}

function isWorkspaceOpen(store: ReturnType<typeof useAppStore.getState>, wid: string): boolean {
  return store.tabs.some((tab) => tab.id === wid)
    || Boolean(store.sessions[wid])
    || store.snapshot?.workspace.id === wid;
}

type DirectionFilter = 'all' | 'outgoing' | 'incoming' | 'none';
type TimelineCommit =
  | { kind: 'outgoing'; commit: UnpushedCommit; isHead: boolean }
  | { kind: 'incoming'; commit: IncomingCommit; isHead: false };

function relativeDate(value: string, t: (key: string, ...args: Array<string | number>) => string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{0}m ago', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('{0}h ago', hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return t('{0}d ago', days);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 365 ? 'numeric' : undefined });
}

function SyncCommitRow({ repo, item, selected, selectedItems, fileViewMode, onSelected, onClearSelection, onFileViewModeChange, defaultExpanded = false, prefetchedDetail, query, onDetailLoaded, searching = false }: {
  repo: RepositoryStatus;
  item: TimelineCommit;
  selected: boolean;
  selectedItems: TimelineCommit[];
  fileViewMode: SyncFileViewMode;
  onSelected: (key: string, additive: boolean) => void;
  onClearSelection: () => void;
  onFileViewModeChange: (mode: SyncFileViewMode) => void;
  defaultExpanded?: boolean;
  prefetchedDetail?: CommitDetail;
  query?: string;
  searching?: boolean;
  onDetailLoaded: (hash: string, detail: CommitDetail) => void;
}) {
  const bridge = useAppStore((state) => state.bridge);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const openDiff = useAppStore((state) => state.openDiff);
  const unpushedOperation = useAppStore((state) => state.unpushedOperation);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const revealHistoryCommit = useAppStore((state) => state.revealHistoryCommit);
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<CommitDetail>();
  const [detailError, setDetailError] = useState<string>();
  const [detailRetry, setDetailRetry] = useState(0);
  const [context, setContext] = useState<{ x: number; y: number }>();
  const currentDetail = prefetchedDetail ?? detail;

  useEffect(() => {
    if (defaultExpanded) queueMicrotask(() => setExpanded(true));
  }, [defaultExpanded]);

  useEffect(() => {
    if (!expanded || currentDetail || searching || !bridge || !workspaceId) return;
    let cancelled = false;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setDetailError(undefined);
      void bridge.request<CommitDetail>({
        type: 'commitDetail',
        payload: { workspace_id: workspaceId, repo_id: repo.meta.id, revision: item.commit.hash },
      }, { signal: controller.signal }).then((result) => {
        if (!cancelled) { setLoading(false); setDetail(result); onDetailLoaded(item.commit.hash, result); }
      }).catch((error: unknown) => {
        if (!cancelled && !isAbortError(error)) setDetailError(String(error));
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [expanded, currentDetail, detailRetry, bridge, workspaceId, repo.meta.id, item.commit.hash, onDetailLoaded, searching]);

  const commit = item.commit;
  const fullMessage = commit.fullMessage || (commit.body ? `${commit.message}\n\n${commit.body}` : commit.message);
  const isMerge = (commit.parents?.length ?? 0) >= 2;
  const key = `${item.kind}:${commit.hash}`;
  const toggle = () => setExpanded((current) => !current);
  const openLog = () => {
    revealHistoryCommit(repo.meta.id, commit.hash);
  };
  const sameKindSelection = selectedItems.filter((candidate) => candidate.kind === item.kind);
  const selectedHashes = sameKindSelection.length > 0 ? sameKindSelection.map((candidate) => candidate.commit.hash) : [commit.hash];
  const cherryPick = async () => {
    if (item.kind !== 'incoming') return;
    const commits = sameKindSelection.length > 0 ? sameKindSelection : [item];
    const incomingCommits = commits.filter((candidate): candidate is Extract<TimelineCommit, { kind: 'incoming' }> => candidate.kind === 'incoming');
    if (incomingCommits.some((candidate) => candidate.commit.parents.length > 1)) return;
    const hashes = new Set(incomingCommits.map((candidate) => candidate.commit.hash));
    const ordered = (useAppStore.getState().incomingCommits[repo.meta.id] ?? []).filter((candidate) => hashes.has(candidate.hash)).reverse();
    if (ordered.length && await confirmDialog({ title: ordered.length > 1 ? t('Cherry-Pick All') : t('Cherry-pick incoming commit?'), message: ordered.map((candidate) => `${candidate.shortHash} ${candidate.message}`).join('\n') })) {
      for (const candidate of ordered) {
        if (!await historyOperation(repo.meta.id, { type: 'cherryPick', revision: candidate.hash })) break;
      }
    }
  };
  const createBranch = async () => {
    const name = await promptDialog({ title: t('Create Branch from Commit'), message: `${commit.shortHash} ${commit.message}`, inputLabel: t('Branch name') });
    if (name) await branchOperation({ type: 'create', name, from: commit.hash }, repo.meta.id);
  };
  const submitRewrite = async (operation: UnpushedOperation) => {
    if (useAppStore.getState().snapshot?.workspace.id !== workspaceId) return false;
    const success = await unpushedOperation(repo.meta.id, operation);
    if (!success) {
      const latest = useAppStore.getState().notifications.find((notification) => notification.type === 'error');
      throw new Error(latest ? resolveNotificationText(latest.message, t) : t('Operation failed'));
    }
    return true;
  };
  const rewrite = async (action: 'revert' | 'drop' | 'squash' | 'undoHead' | 'editMessage') => {
    if (item.kind !== 'outgoing') return;
    if (action === 'editMessage') {
      await editorDialog({ title: t('Edit Commit Message…'), message: commit.shortHash, inputLabel: t('Commit message'), initialValue: fullMessage, confirmLabel: t('Save'), submit: (message) => submitRewrite({ type: 'editMessage', hash: commit.hash, message }) });
      return;
    }
    if (action === 'squash') {
      const outgoingCommits = sameKindSelection.filter((candidate): candidate is Extract<TimelineCommit, { kind: 'outgoing' }> => candidate.kind === 'outgoing');
      await editorDialog({ title: t('Squash {0} commits…', outgoingCommits.length), message: t('The selection must be contiguous and include HEAD.'), inputLabel: t('Combined commit message'), initialValue: outgoingCommits.map((candidate) => candidate.commit.fullMessage || candidate.commit.message).reverse().join('\n\n'), confirmLabel: t('Squash'), submit: (message) => submitRewrite({ type: 'squash', hashes: selectedHashes, message }) });
      return;
    }
    if (!await confirmDialog({ title: action === 'drop' ? t('Drop {0} commits', selectedHashes.length) : action === 'revert' ? t('Revert {0} commits', selectedHashes.length) : t('Undo Commit'), message: sameKindSelection.map((candidate) => `${candidate.commit.shortHash} ${candidate.commit.message}`).join('\n') || `${commit.shortHash} ${commit.message}`, danger: action !== 'revert' })) return;
    if (action === 'undoHead') await unpushedOperation(repo.meta.id, { type: 'undoHead', expectedHash: commit.hash });
    else await unpushedOperation(repo.meta.id, { type: action, hashes: selectedHashes });
  };

  const menuItems: ContextMenuEntry[] = item.kind === 'incoming'
    ? [
        { id: 'cherry', label: selectedHashes.length > 1 ? t('Cherry-pick {0} commits', selectedHashes.length) : t('Cherry-pick Commit'), icon: 'git-pull-request-go-to-changes', disabled: sameKindSelection.some((candidate) => candidate.kind === 'incoming' && candidate.commit.parents.length > 1), disabledReason: t('Merge commits require selecting a mainline parent and cannot be cherry-picked here.') },
        { id: 'branch', label: t('New Branch from Here…'), icon: 'git-branch', disabled: selectedHashes.length > 1 },
        { separator: true },
        { id: 'log', label: t('View in Git Log'), icon: 'go-to-file', disabled: selectedHashes.length > 1 },
      ]
    : selectedHashes.length > 1 ? [
        { id: 'squash', label: t('Squash {0} commits…', selectedHashes.length), icon: 'fold-down' },
        { id: 'revert', label: t('Revert {0} commits', selectedHashes.length), icon: 'discard' },
        { id: 'drop', label: t('Drop {0} commits', selectedHashes.length), icon: 'trash', danger: true },
      ] : [
        { id: 'log', label: t('View in Git Log'), icon: 'go-to-file' },
        ...(item.isHead ? [{ id: 'edit', label: t('Edit Commit Message…'), icon: 'edit' } as ContextMenuEntry] : []),
        { id: 'revert', label: t('Revert Commit'), icon: 'discard' },
        ...(item.isHead ? [{ id: 'undo', label: t('Undo Commit'), icon: 'arrow-left', danger: true } as ContextMenuEntry] : []),
        ...(item.isHead ? [{ id: 'drop', label: t('Drop Commit'), icon: 'trash', danger: true } as ContextMenuEntry] : []),
      ];

  const runMenu = (id: string) => {
    if (id === 'cherry') void cherryPick();
    else if (id === 'branch') void createBranch();
    else if (id === 'log') openLog();
    else if (id === 'edit') void rewrite('editMessage');
    else if (id === 'squash') void rewrite('squash');
    else if (id === 'revert') void rewrite('revert');
    else if (id === 'undo') void rewrite('undoHead');
    else if (id === 'drop') void rewrite('drop');
  };

  return <div className={`sync-timeline-card ${selected ? 'selected' : ''}`}>
    <div data-sync-commit-row="" className="sync-timeline-row" role="button" tabIndex={0} onClick={(event) => { if (event.ctrlKey || event.metaKey) onSelected(key, true); else { onClearSelection(); void toggle(); } }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClearSelection(); void toggle(); } }} onContextMenu={(event) => { event.preventDefault(); if (!selected) onSelected(key, false); setContext({ x: event.clientX, y: event.clientY }); }}>
      <div className="sync-commit-left">
        <span className={`sync-direction-icon ${item.kind}`} title={t(item.kind === 'incoming' ? 'Incoming' : 'Outgoing')}><Codicon name={item.kind === 'incoming' ? 'arrow-down' : 'arrow-up'} /></span>
        <code>{commit.shortHash}</code>
      </div>
      <div className="sync-commit-info">
        <span className="sync-commit-message" title={fullMessage}>{commit.message}</span>
        <span className="sync-commit-meta">
          <AuthorAvatar className="mini-avatar" name={commit.author} email={commit.authorEmail ?? ''} repoId={repo.meta.id} size={15} />
          <span className="sync-commit-meta-text">{commit.author} · {relativeDate(commit.date, t)}</span>
          <span className="sync-commit-stats">· {t(commit.filesChanged === 1 ? '{0} file' : '{0} files', commit.filesChanged)}{commit.additions > 0 && <b>+{commit.additions}</b>}{commit.deletions > 0 && <i>-{commit.deletions}</i>}</span>
        </span>
      </div>
      <span className="sync-row-actions">
        {item.kind === 'outgoing' && item.isHead && <button type="button" title={t('Undo Commit')} onClick={(event) => { event.stopPropagation(); void rewrite('undoHead'); }}><Codicon name="arrow-left" /></button>}
        <button type="button" title={t('Open in Log')} onClick={(event) => { event.stopPropagation(); openLog(); }}><Codicon name="go-to-file" /></button>
      </span>
    </div>
    {expanded && <div className="sync-commit-detail">
      {detailError && !currentDetail ? <div className="sync-detail-error" role="alert"><span>{detailError}</span><button type="button" onClick={() => setDetailRetry((current) => current + 1)}>{t('Retry')}</button></div>
        : isMerge && !loading && currentDetail && currentDetail.files.length === 0
        ? <div className="sync-merge-empty"><Codicon name="info" />{t('No changes relative to first parent')}</div>
        : <SyncFileList
            files={currentDetail?.files ?? []}
            loading={!currentDetail && (loading || searching)}
            query={query}
            potentialConflicts={item.kind === 'incoming' ? new Set(item.commit.potentialConflictPaths) : undefined}
            viewMode={fileViewMode}
            onViewModeChange={onFileViewModeChange}
            onOpenFile={(file) => void openDiff(repo.meta.id, file.path, false, commit.hash)}
            showToolbar={false}
          />}
    </div>}
    {context && <ContextMenu x={context.x} y={context.y} items={menuItems} onSelect={runMenu} onClose={() => { setContext(undefined); onClearSelection(); }} />}
  </div>;
}

function SyncRepoSection({ repo, branch, outgoing, incoming, checked, singleRepo, filter, query, expanded, fileViewMode, onToggleChecked, onToggleFilter, onToggleExpanded, onFileViewModeChange }: {
  repo: RepositoryStatus;
  branch?: BranchInfo;
  outgoing: UnpushedCommit[];
  incoming: IncomingCommit[];
  checked: boolean;
  singleRepo: boolean;
  filter: DirectionFilter;
  query: string;
  expanded: boolean;
  fileViewMode: SyncFileViewMode;
  onToggleChecked: () => void;
  onToggleFilter: (direction: 'outgoing' | 'incoming') => void;
  onToggleExpanded: () => void;
  onFileViewModeChange: (mode: SyncFileViewMode) => void;
}) {
  const sync = useAppStore((state) => state.sync);
  const loadIncoming = useAppStore((state) => state.loadIncomingCommits);
  const bridge = useAppStore((state) => state.bridge);
  const openDiff = useAppStore((state) => state.openDiff);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const operations = useAppStore((state) => state.operations);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const loadErrors = useAppStore((state) => state.loadErrors);
  const loadOutgoing = useAppStore((state) => state.loadUnpushedCommits);
  const { t } = useI18n();
  const [selectedCommits, setSelectedCommits] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState(false);
  const [displayMode, setDisplayMode] = useState<'commits' | 'changes'>('commits');
  const [changesCache, setChangesCache] = useState<Record<string, RevisionChanges>>({});
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<{ key: string; outgoing?: string; incoming?: string }>();
  const detailCache = useRef<Record<string, CommitDetail>>({});
  const [commitDetails, setCommitDetails] = useState<Record<string, CommitDetail>>({});
  const [searchError, setSearchError] = useState<string>();
  const [searchRetry, setSearchRetry] = useState(0);
  const cacheDetail = useCallback((hash: string, detail: CommitDetail) => {
    detailCache.current = { ...detailCache.current, [hash]: detail };
    setCommitDetails(detailCache.current);
  }, []);
  const lastChangesRequest = useRef<string>();
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number }>();
  const [branchMenuAnchor, setBranchMenuAnchor] = useState<DOMRect>();
  const busy = isOperationActive(operations, { workspaceId, repositoryId: repo.meta.id, domain: 'sync' });
  const color = readableAccentColor(repo.meta.color);
  const branchLabel = branch?.detachedTag ?? branch?.detachedHash ?? branch?.name ?? repo.branch;
  const branchClr = branchColor(branchLabel, Boolean(branch?.detachedHash), Boolean(branch?.detachedTag));
  const outgoingCount = Math.max(branch?.ahead ?? repo.ahead, outgoing.length);
  const incomingCount = Math.max(branch?.behind ?? repo.behind, incoming.length);
  const unpublished = Boolean(branch && !branch.upstream);
  const outgoingActive = filter === 'all' || filter === 'outgoing';
  const incomingActive = filter === 'all' || filter === 'incoming';
  const outgoingHashes = outgoingActive ? outgoing.map((commit) => commit.hash).join(',') : '';
  const incomingHashes = incomingActive ? incoming.map((commit) => commit.hash).join(',') : '';
  useEffect(() => {
    if (!query.trim() || displayMode !== 'commits' || !bridge || !workspaceId) return;
    const hashes = [...new Set(`${outgoingHashes},${incomingHashes}`.split(',').filter(Boolean))];
    const missing = hashes.filter((hash) => !detailCache.current[hash]);
    let active = true;
    const controller = new AbortController();
    queueMicrotask(() => { if (active) setSearchError(undefined); });
    let index = 0;
    const worker = async () => {
      while (active && index < missing.length) {
        const hash = missing[index++];
        try {
          const detail = await bridge.request<CommitDetail>({ type: 'commitDetail', payload: { workspace_id: workspaceId, repo_id: repo.meta.id, revision: hash } }, { signal: controller.signal, showProgress: false });
          if (active) cacheDetail(hash, detail);
        } catch (error) {
          if (active && !isAbortError(error)) setSearchError(String(error));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    return () => { active = false; controller.abort(); };
  }, [bridge, cacheDetail, displayMode, incomingHashes, outgoingHashes, query, repo.meta.id, searchRetry, workspaceId]);
  const changesKey = `${workspaceId ?? ''}\0${repo.meta.id}\0${outgoingHashes}\0${incomingHashes}`;
  const outgoingKey = `${workspaceId ?? ''}\0${repo.meta.id}\0outgoing\0${outgoingHashes}`;
  const incomingKey = `${workspaceId ?? ''}\0${repo.meta.id}\0incoming\0${incomingHashes}`;
  const currentChanges = { outgoing: changesCache[outgoingKey], incoming: changesCache[incomingKey] };
  const currentError = changesError?.key === changesKey ? changesError : undefined;
  const outgoingError = loadErrors[`unpushed:${repo.meta.id}`];
  const incomingError = loadErrors[`incoming:${repo.meta.id}`];
  const missingOutgoing = Boolean(outgoingHashes && !currentChanges.outgoing);
  const missingIncoming = Boolean(incomingHashes && !currentChanges.incoming);
  useEffect(() => {
    if (!expanded) {
      lastChangesRequest.current = undefined;
      return;
    }
    if (!bridge || !workspaceId || (!missingOutgoing && !missingIncoming) || lastChangesRequest.current === changesKey) return;
    lastChangesRequest.current = changesKey;
    let active = true;
    const controller = new AbortController();
    queueMicrotask(() => { if (active) { setChangesLoading(true); setChangesError(undefined); } });
    void Promise.allSettled([
      missingOutgoing
        ? bridge.request<RevisionChanges>({ type: 'unpushedChanges', payload: { workspace_id: workspaceId, repo_id: repo.meta.id, oldest_revision: outgoingHashes.split(',').at(-1) ?? null } }, { signal: controller.signal })
        : Promise.resolve(undefined),
      missingIncoming
        ? bridge.request<RevisionChanges>({ type: 'incomingChanges', payload: { workspace_id: workspaceId, repo_id: repo.meta.id } }, { signal: controller.signal })
        : Promise.resolve(undefined),
    ]).then(([outgoingResult, incomingResult]) => {
      if (!active) return;
      setChangesLoading(false);
      setChangesError({
        key: changesKey,
        outgoing: outgoingResult.status === 'rejected' ? String(outgoingResult.reason) : undefined,
        incoming: incomingResult.status === 'rejected' ? String(incomingResult.reason) : undefined,
      });
      setChangesCache((current) => {
        const next = { ...current };
        if (outgoingResult.status === 'fulfilled' && outgoingResult.value) next[outgoingKey] = outgoingResult.value;
        if (incomingResult.status === 'fulfilled' && incomingResult.value) next[incomingKey] = incomingResult.value;
        const keys = Object.keys(next);
        for (const key of keys.slice(0, Math.max(0, keys.length - 32))) delete next[key];
        return next;
      });
    });
    return () => { active = false; controller.abort(); };
  }, [bridge, changesKey, expanded, incomingKey, missingIncoming, missingOutgoing, outgoingHashes, outgoingKey, repo.meta.id, workspaceId]);
  const needle = query.trim().toLocaleLowerCase();
  const repoMatches = `${repo.meta.name} ${branchLabel}`.toLocaleLowerCase().includes(needle);
  const timeline: TimelineCommit[] = [];
  if (outgoingActive) outgoing.forEach((commit, index) => timeline.push({ kind: 'outgoing', commit, isHead: index === 0 }));
  if (incomingActive) incoming.forEach((commit) => timeline.push({ kind: 'incoming', commit, isHead: false }));
  timeline.sort((a, b) => new Date(b.commit.date).getTime() - new Date(a.commit.date).getTime());
  const fileMatches = (hash: string) => commitDetails[hash]?.files.some((file) => file.path.toLocaleLowerCase().includes(needle));
  const visibleTimeline = !needle || repoMatches ? timeline : timeline.filter(({ commit }) => `${commit.hash} ${commit.fullMessage ?? commit.message} ${commit.body ?? ''} ${commit.author}`.toLocaleLowerCase().includes(needle) || fileMatches(commit.hash));
  const selectedItems = visibleTimeline.filter((candidate) => selectedCommits.has(`${candidate.kind}:${candidate.commit.hash}`));
  const selectCommit = (key: string, additive: boolean) => setSelectedCommits((current) => {
    if (!additive) return new Set([key]);
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const fetchRepo = async () => {
    const wid = useAppStore.getState().snapshot?.workspace.id;
    await useAppStore.getState().fetchRepositories([repo.meta.id], true, wid);
    await loadIncoming(repo.meta.id, wid);
  };
  const toggleDisplayMode = () => {
    setDisplayMode((current) => current === 'changes' ? 'commits' : 'changes');
    if (!expanded) onToggleExpanded();
  };
  const cherryPickAll = async () => {
    const commits = [...incoming].reverse().filter((commit) => commit.parents.length <= 1);
    if (!commits.length || !await confirmDialog({ title: t('Cherry-Pick All'), message: commits.map((commit) => `${commit.shortHash} ${commit.message}`).join('\n') })) return;
    for (const commit of commits) {
      if (!await historyOperation(repo.meta.id, { type: 'cherryPick', revision: commit.hash })) break;
    }
  };
  const pullRepo = async (strategy?: 'merge' | 'rebase' | 'ff-only', targetWid?: string) => {
    const wid = targetWid ?? useAppStore.getState().snapshot?.workspace.id;
    if (!wid) return false;
    const effective = await resolvePullStrategy(t, strategy);
    if (!effective) return false;
    const store = useAppStore.getState();
    if (!isWorkspaceOpen(store, wid)) return false;
    const action = effective === 'rebase' ? 'pullRebase' : effective === 'ff-only' ? 'pullFfOnly' : 'pull';
    return sync(repo.meta.id, action, undefined, undefined, wid);
  };
  const syncRepo = async () => {
    const wid = useAppStore.getState().snapshot?.workspace.id;
    if (!wid) return;
    if (incomingCount > 0 && !await pullRepo(undefined, wid)) return;
    const store = useAppStore.getState();
    if (!isWorkspaceOpen(store, wid)) return;
    if (outgoingCount > 0) await sync(repo.meta.id, 'push', undefined, undefined, wid);
  };
  const headerItems: ContextMenuEntry[] = [
    { id: 'fetch', label: t('Fetch'), icon: 'cloud-download' },
    ...(outgoing.length + incoming.length > 0 ? [{ id: 'changes', label: displayMode === 'commits' ? t('Show aggregated changes') : t('Show commit list'), icon: displayMode === 'commits' ? 'diff-multiple' : 'list-unordered' } as ContextMenuEntry] : []),
    ...(incoming.length > 0 ? [{ id: 'cherryAll', label: t('Cherry-Pick All'), icon: 'git-commit' } as ContextMenuEntry] : []),
    { separator: true },
    ...(incomingCount > 0 && outgoingCount > 0 ? [{ id: 'sync', label: t('Sync'), icon: 'sync', disabled: busy || !capabilityAvailable(repo.capabilities, 'syncPull', true) || !capabilityAvailable(repo.capabilities, 'syncPush', true) } as ContextMenuEntry] : []),
    ...(incomingCount > 0 ? [{ id: 'pull', label: t('Update'), icon: 'cloud-download', disabled: busy || !capabilityAvailable(repo.capabilities, 'syncPull', true) } as ContextMenuEntry] : []),
    ...(outgoingCount > 0 ? [{ id: 'push', label: t('Push'), icon: 'cloud-upload', disabled: busy || !capabilityAvailable(repo.capabilities, 'syncPush', true) } as ContextMenuEntry] : []),
  ];
  const runHeaderAction = (id: string) => {
    const wid = useAppStore.getState().snapshot?.workspace.id;
    if (id === 'fetch') void fetchRepo();
    else if (id === 'changes') void toggleDisplayMode();
    else if (id === 'cherryAll') void cherryPickAll();
    else if (id === 'sync') void syncRepo();
    else if (id === 'pull') void pullRepo(undefined, wid);
    else if (id === 'push') void sync(repo.meta.id, 'push', undefined, undefined, wid);
  };

  const canCheck = outgoingCount + incomingCount > 0 || Boolean(branch && !branch.upstream);

  return <section className="repo-change-group sync-repo-section">
    <header className="repo-heading sync-repo-heading" style={{ '--repo-color': color } as React.CSSProperties} onClick={(event) => { if (!(event.target as HTMLElement).closest('button, input, label')) onToggleExpanded(); }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onContextMenu={(event) => { event.preventDefault(); setHeaderMenu({ x: event.clientX, y: event.clientY }); }}>
      {!singleRepo && <SelectionCheckbox label={repo.meta.name} checked={checked} disabled={!canCheck} onChange={onToggleChecked} />}
      <div className="sync-repo-main">
        <button className="sync-repo-toggle" title={repo.meta.name} aria-expanded={expanded} onClick={onToggleExpanded}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
          <i style={{ background: color }} />
          <strong>{repo.meta.name}</strong>
        </button>
        <button className="sync-branch-trigger" data-branch-switch-badge="" title={t('Switch branch')} aria-haspopup="menu" aria-expanded={Boolean(branchMenuAnchor)} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setBranchMenuAnchor((current) => current ? undefined : rect); }}>
          <BranchRefBadge label={branchLabel} kind={repo.meta.isWorktree ? 'worktree' : branch?.detachedTag ? 'tag' : branch?.detachedHash ? 'head' : 'branch'} color={branchClr} className="branch-chip" />
        </button>
      </div>
      <div className="sync-repo-actions">
      {busy && <span className="sync-header-busy"><Codicon name="loading~spin" /></span>}
      <button className={`sync-header-action ${hovered ? 'visible' : ''}`} title={t('Fetch remote changes')} onClick={(event) => { event.stopPropagation(); void fetchRepo(); }}><Codicon name="cloud-download" /></button>
      {outgoing.length + incoming.length > 0 && <button className={`sync-header-action ${hovered || displayMode === 'changes' ? 'visible' : ''}`} title={displayMode === 'commits' ? t('Show aggregated changes') : t('Show commit list')} onClick={() => void toggleDisplayMode()}><Codicon name={displayMode === 'commits' ? 'diff-multiple' : 'list-unordered'} /></button>}
      {outgoingCount > 0 && <button className={`sync-direction-pill outgoing ${outgoingActive ? 'active' : ''}`} onClick={() => onToggleFilter('outgoing')}><Codicon name="arrow-up" />{outgoingCount}</button>}
      {incomingCount > 0 && <button className={`sync-direction-pill incoming ${incomingActive ? 'active' : ''}`} onClick={() => onToggleFilter('incoming')}><Codicon name="arrow-down" />{incomingCount}</button>}
      {outgoingCount === 0 && incomingCount === 0 && unpublished && <span className="sync-publish-badge"><Codicon name="cloud-upload" />{t('Unpublished')}</span>}
      </div>
    </header>
    {expanded && <div className="sync-repo-body" onClick={(event) => { if (!(event.target as HTMLElement).closest('[data-sync-commit-row]')) setSelectedCommits(new Set()); }}>
      {needle && searchError && <div className="sync-detail-error" role="alert"><span>{searchError}</span><button type="button" onClick={() => setSearchRetry((current) => current + 1)}>{t('Retry')}</button></div>}
      {(outgoingError || incomingError) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1))', color: 'var(--vscode-errorForeground, #f48771)', fontSize: 12 }}>
          <Codicon name="error" />
          <span style={{ flex: 1 }}>{outgoingError || incomingError}</span>
          <button
            type="button"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textDecoration: 'underline' }}
            onClick={() => {
              if (outgoingError) void loadOutgoing(repo.meta.id);
              if (incomingError) void loadIncoming(repo.meta.id);
            }}
          >
            {t('Retry')}
          </button>
        </div>
      )}
      {!incomingActive && !outgoingActive ? <div className="sync-empty">{t('No commit type selected')}</div> : displayMode === 'changes' ? <>
        {incomingActive && incoming.length > 0 && <div className="sync-aggregate-section">
          {filter === 'all' && <div className="sync-aggregate-title incoming"><Codicon name="arrow-down" />{currentChanges.incoming ? t('Incoming Changes ({0})', currentChanges.incoming.files.length) : t('Incoming Changes')}</div>}
          {currentError?.incoming && <div className="sync-empty"><Codicon name="warning" />{currentError.incoming}</div>}
          {!currentError?.incoming &&
          <SyncFileList
            files={currentChanges?.incoming?.files ?? []}
            loading={!currentChanges.incoming && (changesLoading || !currentError)}
            viewMode={fileViewMode}
            query={query}
            onViewModeChange={onFileViewModeChange}
            onOpenFile={(file) => { const range = currentChanges?.incoming; if (range) void openDiff(repo.meta.id, file.path, false, undefined, { fromRevision: range.fromRevision, toRevision: range.toRevision }); }}
            showToolbar={false}
          />}
        </div>}
        {outgoingActive && outgoing.length > 0 && <div className="sync-aggregate-section">
          {filter === 'all' && <div className="sync-aggregate-title outgoing"><Codicon name="arrow-up" />{currentChanges.outgoing ? t('Outgoing Changes ({0})', currentChanges.outgoing.files.length) : t('Outgoing Changes')}</div>}
          {currentError?.outgoing && <div className="sync-empty"><Codicon name="warning" />{currentError.outgoing}</div>}
          {!currentError?.outgoing &&
          <SyncFileList
            files={currentChanges?.outgoing?.files ?? []}
            loading={!currentChanges.outgoing && (changesLoading || !currentError)}
            viewMode={fileViewMode}
            query={query}
            onViewModeChange={onFileViewModeChange}
            onOpenFile={(file) => { const range = currentChanges?.outgoing; if (range) void openDiff(repo.meta.id, file.path, false, undefined, { fromRevision: range.fromRevision, toRevision: range.toRevision }); }}
            showToolbar={false}
          />}
        </div>}
      </> : visibleTimeline.length ? visibleTimeline.map((item) => <SyncCommitRow key={`${item.kind}:${item.commit.hash}`} repo={repo} item={item} defaultExpanded={Boolean(needle && fileMatches(item.commit.hash))} prefetchedDetail={commitDetails[item.commit.hash]} onDetailLoaded={cacheDetail} searching={Boolean(needle)} query={needle && !repoMatches && fileMatches(item.commit.hash) ? query : undefined} selected={selectedCommits.has(`${item.kind}:${item.commit.hash}`)} selectedItems={selectedItems} fileViewMode={fileViewMode} onSelected={selectCommit} onClearSelection={() => setSelectedCommits(new Set())} onFileViewModeChange={onFileViewModeChange} />)
        : <div className="sync-empty">{needle && !searchError && timeline.some((item) => !commitDetails[item.commit.hash]) ? t('Loading files...') : query ? t('No commits found') : (outgoingError || incomingError) ? <span style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>{t('Failed to load commits')}</span> : outgoingCount + incomingCount === 0 ? <><Codicon name="check" />{t('Up to date')}</> : t('Fetch to load incoming commit details.')}</div>}
    </div>}
    {headerMenu && <ContextMenu x={headerMenu.x} y={headerMenu.y} items={headerItems.map((entry) => 'separator' in entry ? entry : { ...entry, disabled: entry.id === 'fetch' ? busy || !capabilityAvailable(repo.capabilities, 'syncFetch', true) : entry.disabled })} onSelect={runHeaderAction} onClose={() => setHeaderMenu(undefined)} />}
    {branchMenuAnchor && <BranchMenuPopover anchorRect={branchMenuAnchor} initialRepoId={repo.meta.id} repoOnly onClose={() => setBranchMenuAnchor(undefined)} />}
  </section>;
}

export function SyncPanel({ active = true, repos, expansionCommand, selectionCommand, fileViewMode = 'tree', onFileViewModeChange = () => undefined, onExpansionChange, onSelectionChange }: {
  active?: boolean;
  repos: RepositoryStatus[];
  expansionCommand?: { sequence: number; expanded: boolean };
  selectionCommand?: { sequence: number; action: 'selectAll' | 'invert' };
  fileViewMode?: SyncFileViewMode;
  onFileViewModeChange?: (mode: SyncFileViewMode) => void;
  onExpansionChange?: (expanded: boolean | null) => void;
  onSelectionChange?: (allSelected: boolean, hasSelectable: boolean) => void;
}) {
  const outgoing = useAppStore((state) => state.unpushedCommits);
  const incoming = useAppStore((state) => state.incomingCommits);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const loadOutgoing = useAppStore((state) => state.loadUnpushedCommits);
  const loadIncoming = useAppStore((state) => state.loadIncomingCommits);
  const sync = useAppStore((state) => state.sync);
  const { t } = useI18n();
  const operations = useAppStore((state) => state.operations);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const [performingAction, setPerformingAction] = useState(false);
  const actionRunningRef = useRef(false);
  const actionBusy = performingAction || isOperationActiveForRepositories(operations, repos.map((repo) => repo.meta.id), { workspaceId, domain: ['sync', 'history'] });
  const runAction = async (action: () => Promise<unknown>) => {
    if (actionRunningRef.current || actionBusy) return;
    actionRunningRef.current = true;
    setPerformingAction(true);
    try { await action(); } finally { actionRunningRef.current = false; setPerformingAction(false); }
  };
  const speedSearch = useSpeedSearch('sync', active);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<Record<string, DirectionFilter>>({});
  const [footerMenu, setFooterMenu] = useState<{ x: number; y: number }>();
  const [collapsedRepoIds, setCollapsedRepoIds] = useState<Set<string>>(() => new Set());
  const lastExpansionSequence = useRef(0);
  const lastSelectionSequence = useRef(0);
  const singleRepo = repos.length === 1;

  useEffect(() => {
    const state = useAppStore.getState();
    for (const repo of repos) {
      if (!state.unpushedCommits[repo.meta.id] && !state.loadErrors[`unpushed:${repo.meta.id}`]) void loadOutgoing(repo.meta.id);
      if (!state.incomingCommits[repo.meta.id] && !state.loadErrors[`incoming:${repo.meta.id}`]) void loadIncoming(repo.meta.id);
    }
  }, [loadIncoming, loadOutgoing, repos]);
  const selectableRepoIds = useMemo(() => repos.filter((repo) => {
    const branch = branchesByRepo[repo.meta.id]?.find((candidate) => candidate.current);
    return repo.ahead > 0 || repo.behind > 0 || (outgoing[repo.meta.id]?.length ?? 0) > 0 || (incoming[repo.meta.id]?.length ?? 0) > 0 || Boolean(branch && !branch.upstream);
  }).map((repo) => repo.meta.id), [branchesByRepo, incoming, outgoing, repos]);
  useEffect(() => {
    if (!expansionCommand || expansionCommand.sequence === lastExpansionSequence.current) return;
    lastExpansionSequence.current = expansionCommand.sequence;
    queueMicrotask(() => setCollapsedRepoIds(expansionCommand.expanded ? new Set() : new Set(repos.map((repo) => repo.meta.id))));
  }, [expansionCommand, repos]);
  useEffect(() => {
    if (!selectionCommand || selectionCommand.sequence === lastSelectionSequence.current) return;
    lastSelectionSequence.current = selectionCommand.sequence;
    queueMicrotask(() => setChecked((current) => selectionCommand.action === 'selectAll'
      ? new Set(selectableRepoIds)
      : new Set(selectableRepoIds.filter((repoId) => !current.has(repoId)))));
  }, [selectableRepoIds, selectionCommand]);
  const allSelectableSelected = !singleRepo && selectableRepoIds.length > 0 && selectableRepoIds.every((repoId) => checked.has(repoId));
  useEffect(() => { onSelectionChange?.(allSelectableSelected, !singleRepo && selectableRepoIds.length > 0); }, [allSelectableSelected, onSelectionChange, selectableRepoIds.length, singleRepo]);
  const selectedRepos = useMemo(() => singleRepo ? repos : repos.filter((repo) => checked.has(repo.meta.id)), [checked, repos, singleRepo]);
  const outgoingActive = (repoId: string) => {
    const filter = filters[repoId] ?? 'all';
    return filter === 'all' || filter === 'outgoing';
  };
  const incomingActive = (repoId: string) => {
    const filter = filters[repoId] ?? 'all';
    return filter === 'all' || filter === 'incoming';
  };
  const pushableRepos = selectedRepos.filter((repo) => outgoingActive(repo.meta.id) && (repo.ahead > 0 || (outgoing[repo.meta.id]?.length ?? 0) > 0 || Boolean(branchesByRepo[repo.meta.id]?.find((branch) => branch.current && !branch.upstream))));
  const pullableRepos = selectedRepos.filter((repo) => incomingActive(repo.meta.id) && (repo.behind > 0 || (incoming[repo.meta.id]?.length ?? 0) > 0));
  const totalAhead = pushableRepos.reduce((sum, repo) => sum + Math.max(repo.ahead, outgoing[repo.meta.id]?.length ?? 0), 0);
  const totalBehind = pullableRepos.reduce((sum, repo) => sum + Math.max(repo.behind, incoming[repo.meta.id]?.length ?? 0), 0);
  const publishCount = pushableRepos.filter((repo) => Boolean(branchesByRepo[repo.meta.id]?.find((branch) => branch.current && !branch.upstream))).length;
  const publishedPushCount = pushableRepos.length - publishCount;
  const pushLabel = publishCount > 0 && publishedPushCount > 0
    ? t(publishCount === 1 ? 'Push & Publish Branch' : 'Push & Publish Branches')
    : publishCount > 0
      ? t(pushableRepos.length === 1 ? 'Publish Branch' : 'Publish Branches')
      : t('Push');
  const countedPushLabel = pushableRepos.length > 1 ? `${pushLabel} (${pushableRepos.length})` : pushLabel;
  const fetchAll = async () => {
    const wid = useAppStore.getState().snapshot?.workspace.id;
    await useAppStore.getState().fetchRepositories(repos.map((repo) => repo.meta.id), true, wid);
    await Promise.all([loadIncoming(undefined, wid), loadOutgoing(undefined, wid)]);
  };
  const syncSelected = async (strategy?: 'merge' | 'rebase' | 'ff-only') => {
    const wid = useAppStore.getState().snapshot?.workspace.id;
    if (!wid) return;
    let effectiveStrategy = strategy;
    if (pullableRepos.length > 0) {
      effectiveStrategy = await resolvePullStrategy(t, strategy);
      if (!effectiveStrategy) return;
    }
    const store = useAppStore.getState();
    if (!isWorkspaceOpen(store, wid)) return;
    for (const repo of selectedRepos) {
      const canPull = pullableRepos.some((candidate) => candidate.meta.id === repo.meta.id);
      const canPush = pushableRepos.some((candidate) => candidate.meta.id === repo.meta.id);
      if (canPull) {
        const action = effectiveStrategy === 'rebase' ? 'pullRebase' : effectiveStrategy === 'ff-only' ? 'pullFfOnly' : 'pull';
        if (!await sync(repo.meta.id, action, undefined, undefined, wid)) continue;
      }
      if (canPush) await sync(repo.meta.id, 'push', undefined, undefined, wid);
    }
    await Promise.all([loadIncoming(undefined, wid), loadOutgoing(undefined, wid)]);
  };
  const pullSelected = async (strategy: 'merge' | 'rebase' | 'ff-only', targetWid?: string) => {
    const action = strategy === 'rebase' ? 'pullRebase' : strategy === 'ff-only' ? 'pullFfOnly' : 'pull';
    const wid = targetWid ?? useAppStore.getState().snapshot?.workspace.id;
    await Promise.allSettled(pullableRepos.map((repo) => sync(repo.meta.id, action, undefined, undefined, wid)));
    await Promise.all([loadIncoming(undefined, wid), loadOutgoing(undefined, wid)]);
  };
  const toggleChecked = (repoId: string) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
    return next;
  });
  const toggleFilter = (repoId: string, direction: 'outgoing' | 'incoming') => setFilters((current) => {
    const filter = current[repoId] ?? 'all';
    const out = filter === 'all' || filter === 'outgoing';
    const inc = filter === 'all' || filter === 'incoming';
    const nextOut = direction === 'outgoing' ? !out : out;
    const nextInc = direction === 'incoming' ? !inc : inc;
    return { ...current, [repoId]: nextOut && nextInc ? 'all' : nextOut ? 'outgoing' : nextInc ? 'incoming' : 'none' };
  });
  const runFooterMenu = async (id: string) => {
    const wid = useAppStore.getState().snapshot?.workspace.id;
    if (!wid) return;
    if (id === 'fetch') await fetchAll();
    else if (id === 'tags') {
      if (await confirmDialog({ title: t('Push Tags'), message: t('Push all local tags for selected Git repositories?') })) {
        const store = useAppStore.getState();
        if (!isWorkspaceOpen(store, wid)) return;
        await Promise.allSettled(selectedRepos.map((repo) => sync(repo.meta.id, 'pushTags', undefined, undefined, wid)));
      }
    } else if (id === 'force') {
      if (await confirmDialog({ title: t('Safe Force Push...'), message: t('Force push selected repositories using force-with-lease?'), danger: true })) {
        const store = useAppStore.getState();
        if (!isWorkspaceOpen(store, wid)) return;
        await Promise.allSettled(pushableRepos.map((repo) => sync(repo.meta.id, 'push', true, { force: true }, wid)));
      }
    } else if (id === 'rebase' || id === 'merge' || id === 'ff') {
      await pullSelected(id === 'rebase' ? 'rebase' : id === 'ff' ? 'ff-only' : 'merge', wid);
    }
  };
  const footerItems: ContextMenuEntry[] = pullableRepos.length > 0 ? [
    { id: 'rebase', label: t('Update Strategy: Rebase'), icon: 'git-merge' },
    { id: 'merge', label: t('Update Strategy: Merge'), icon: 'git-merge' },
    { id: 'ff', label: t('Update Strategy: Fast-Forward Only'), icon: 'arrow-right' },
    ...(pushableRepos.length > 0 ? [{ separator: true } as ContextMenuEntry, { id: 'force', label: t('Safe Force Push...'), icon: 'warning', danger: true } as ContextMenuEntry] : []),
    { id: 'tags', label: t('Push All Tags'), icon: 'tag' },
    { separator: true },
    { id: 'fetch', label: t('Fetch All'), icon: 'cloud-download' },
  ] : pushableRepos.length > 0 ? [
    { id: 'force', label: t('Safe Force Push...'), icon: 'warning', danger: true },
    { id: 'tags', label: t('Push All Tags'), icon: 'tag' },
    { separator: true },
    { id: 'fetch', label: t('Fetch All'), icon: 'cloud-download' },
  ] : [];
  const mainAction = pullableRepos.length > 0 && pushableRepos.length > 0
    ? { icon: 'sync', label: `${t('Sync')} ↓${totalBehind} ↑${totalAhead}`, tone: 'sync' }
    : pullableRepos.length > 0
      ? { icon: 'cloud-download', label: pullableRepos.length > 1 ? `${t('Update')} (${pullableRepos.length})` : t('Update'), tone: 'pull' }
      : pushableRepos.length > 0
        ? { icon: 'cloud-upload', label: countedPushLabel, tone: 'push' }
        : { icon: 'cloud-download', label: t('Fetch All'), tone: 'fetch' };

  return <div className="sync-panel">
    <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />
    <div className="sync-repository-list">
      {repos.map((repo) => <SyncRepoSection
        key={repo.meta.id}
        repo={repo}
        branch={branchesByRepo[repo.meta.id]?.find((branch) => branch.current)}
        outgoing={outgoing[repo.meta.id] ?? []}
        incoming={incoming[repo.meta.id] ?? []}
        checked={checked.has(repo.meta.id)}
        singleRepo={singleRepo}
        filter={filters[repo.meta.id] ?? 'all'}
        query={speedSearch.query}
        expanded={!collapsedRepoIds.has(repo.meta.id)}
        fileViewMode={fileViewMode}
        onToggleChecked={() => toggleChecked(repo.meta.id)}
        onToggleFilter={(direction) => toggleFilter(repo.meta.id, direction)}
        onToggleExpanded={() => setCollapsedRepoIds((current) => {
          const next = new Set(current);
          if (next.has(repo.meta.id)) next.delete(repo.meta.id); else next.add(repo.meta.id);
          onExpansionChange?.(next.size === 0 ? true : next.size === repos.length ? false : null);
          return next;
        })}
        onFileViewModeChange={onFileViewModeChange}
      />)}
      {!repos.length && <div className="sync-empty">{t('No Git repositories')}</div>}
    </div>
    <footer className="sync-footer">
      {!singleRepo && selectedRepos.length > 0 && <div className="sync-selected-repositories">
        {selectedRepos.map((repo) => {
          const color = readableAccentColor(repo.meta.color);
          const ahead = Math.max(repo.ahead, outgoing[repo.meta.id]?.length ?? 0);
          const behind = Math.max(repo.behind, incoming[repo.meta.id]?.length ?? 0);
          return <span className="sync-selected-pill" style={{ color, borderColor: `${color}60`, background: `${color}28` }} key={repo.meta.id}>
            <button title={t('Remove {0}', repo.meta.name)} onClick={() => toggleChecked(repo.meta.id)}><Codicon name="close" /></button>
            <span>{repo.meta.name.toLocaleLowerCase()}</span>
            {outgoingActive(repo.meta.id) && ahead > 0 && <small><Codicon name="arrow-up" />{ahead}</small>}
            {incomingActive(repo.meta.id) && behind > 0 && <small className="incoming"><Codicon name="arrow-down" />{behind}</small>}
          </span>;
        })}
      </div>}
      <div className="sync-primary-split">
        <button className={`sync-primary-action ${mainAction.tone}`} disabled={actionBusy || (repos.length > 1 && selectedRepos.length === 0)} onClick={() => void runAction(() => pullableRepos.length || pushableRepos.length ? syncSelected() : fetchAll())}><Codicon name={mainAction.icon} />{mainAction.label}</button>
        {footerItems.length > 0 && <button className={`sync-primary-more ${mainAction.tone}`} disabled={actionBusy || (repos.length > 1 && selectedRepos.length === 0)} title={t('More Actions')} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFooterMenu({ x: Math.max(6, rect.right - 190), y: rect.top }); }}><Codicon name="chevron-down" /></button>}
      </div>
      {footerMenu && <ContextMenu x={footerMenu.x} y={footerMenu.y} items={footerItems} onSelect={(id) => void runAction(() => runFooterMenu(id))} onClose={() => setFooterMenu(undefined)} />}
    </footer>
  </div>;
}
