import { useEffect, useMemo, useState } from 'react';
import type { CommitDetail, IncomingCommit, RepositoryStatus, RevisionChanges } from '../bindings/generated';
import { useI18n } from '../i18n';
import { capabilityAvailable, isOperationActive, useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { PushFileList, PushPanel, type PushFileViewMode } from './PushPanel';
import { choiceDialog, confirmDialog, promptDialog } from './dialogService';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';

type Direction = 'all' | 'outgoing' | 'incoming';

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function IncomingRow({ repoId, commit }: { repoId: string; commit: IncomingCommit }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<CommitDetail>();
  const bridge = useAppStore((state) => state.bridge);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const openDiff = useAppStore((state) => state.openDiff);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const branchOperation = useAppStore((state) => state.branchOperation);
  const { t } = useI18n();

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || detail || loading || !bridge || !workspaceId) return;
    setLoading(true);
    try {
      setDetail(await bridge.request<CommitDetail>({
        type: 'commitDetail',
        payload: { workspace_id: workspaceId, repo_id: repoId, revision: commit.hash },
      }));
    } finally {
      setLoading(false);
    }
  };

  const cherryPick = async () => {
    if (commit.parents.length > 1) return;
    if (!await confirmDialog({ title: t('Cherry-pick incoming commit?'), message: `${commit.shortHash} ${commit.message}` })) return;
    await historyOperation(repoId, { type: 'cherryPick', revision: commit.hash });
  };

  const createBranch = async () => {
    const name = await promptDialog({ title: t('Create Branch from Commit'), message: `${commit.shortHash} ${commit.message}`, inputLabel: t('Branch name') });
    if (name) await branchOperation({ type: 'create', name, from: commit.hash }, repoId);
  };

  return <div className="sync-commit-card">
    <button className="sync-commit-row" onClick={() => void toggle()}>
      <code>{commit.shortHash}</code>
      <span className="sync-commit-message">{commit.message}</span>
      <small>{commit.author} · {formatDate(commit.date)}</small>
      <span className="sync-commit-stats">
        {commit.filesChanged > 0 && <>{commit.filesChanged} {t('files')}</>}
        {commit.additions > 0 && <b>+{commit.additions}</b>}
        {commit.deletions > 0 && <i>-{commit.deletions}</i>}
      </span>
      <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
    </button>
    {expanded && <div className="sync-incoming-detail">
      {commit.body && <pre className="sync-commit-body">{commit.body}</pre>}
      <div className="sync-incoming-actions">
        <button disabled={commit.parents.length > 1} title={commit.parents.length > 1 ? t('Merge commits require selecting a mainline parent and cannot be cherry-picked here.') : undefined} onClick={() => void cherryPick()}><Codicon name="git-pull-request-go-to-changes" />{t('Cherry-pick')}</button>
        <button onClick={() => void createBranch()}><Codicon name="git-branch" />{t('Create Branch')}</button>
      </div>
      {loading ? <div className="sync-empty"><Codicon name="loading~spin" />{t('Loading files...')}</div>
        : detail?.files.map((file) => <button className="sync-file-row" key={`${file.status}:${file.path}`} onClick={() => void openDiff(repoId, file.path, false, commit.hash)}>
          <FileIcon name={file.path.split('/').at(-1) ?? file.path} />
          <span>{file.path}</span>
          {file.added != null && file.added > 0 && <b>+{file.added}</b>}
          {file.removed != null && file.removed > 0 && <i>-{file.removed}</i>}
          <code>{file.status.slice(0, 1).toUpperCase()}</code>
        </button>)}
    </div>}
  </div>;
}

function IncomingPanel({ repos, query }: { repos: RepositoryStatus[]; query: string }) {
  const incoming = useAppStore((state) => state.incomingCommits);
  const loadIncoming = useAppStore((state) => state.loadIncomingCommits);
  const sync = useAppStore((state) => state.sync);
  const operations = useAppStore((state) => state.operations);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const bridge = useAppStore((state) => state.bridge);
  const openDiff = useAppStore((state) => state.openDiff);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const { t } = useI18n();
  const [expandedChangesRepoId, setExpandedChangesRepoId] = useState<string>();
  const [changesByRepo, setChangesByRepo] = useState<Record<string, RevisionChanges>>({});
  const [changesErrors, setChangesErrors] = useState<Record<string, string>>({});
  const [changesLoadingRepoId, setChangesLoadingRepoId] = useState<string>();
  const [fileViewMode, setFileViewMode] = useState<PushFileViewMode>('tree');

  useEffect(() => { void loadIncoming(); }, [loadIncoming]);

  const pull = async (repo: RepositoryStatus) => {
    const choice = await choiceDialog({
      title: t('Pull incoming changes'),
      message: t('Choose how incoming Git changes are integrated.'),
      choices: [
        { id: 'default', label: t('Use configured strategy'), icon: 'settings-gear' },
        { id: 'rebase', label: t('Rebase'), icon: 'repo-forked' },
        { id: 'merge', label: t('Merge'), icon: 'git-merge' },
        { id: 'ff-only', label: t('Fast-forward only'), icon: 'arrow-right' },
      ],
    });
    if (!choice) return;
    const configured = useAppStore.getState().bootstrap?.state.settings?.updateProjectMethod;
    const action = choice === 'rebase' || (choice === 'default' && configured === 'rebase')
      ? 'pullRebase'
      : choice === 'ff-only'
        ? 'pullFfOnly'
        : 'pull';
    await sync(repo.meta.id, action);
  };
  const fetchRepo = async (repo: RepositoryStatus) => {
    await sync(repo.meta.id, 'fetch', false);
    await loadIncoming(repo.meta.id);
  };
  const showIncomingChanges = async (repo: RepositoryStatus) => {
    if (expandedChangesRepoId === repo.meta.id) {
      setExpandedChangesRepoId(undefined);
      return;
    }
    setExpandedChangesRepoId(repo.meta.id);
    if (changesByRepo[repo.meta.id] || !bridge || !workspaceId) return;
    setChangesLoadingRepoId(repo.meta.id);
    setChangesErrors((current) => ({ ...current, [repo.meta.id]: '' }));
    try {
      const changes = await bridge.request<RevisionChanges>({
        type: 'incomingChanges',
        payload: { workspace_id: workspaceId, repo_id: repo.meta.id },
      });
      setChangesByRepo((current) => ({ ...current, [repo.meta.id]: changes }));
    } catch (error: unknown) {
      setChangesErrors((current) => ({ ...current, [repo.meta.id]: String(error) }));
    } finally {
      setChangesLoadingRepoId((current) => current === repo.meta.id ? undefined : current);
    }
  };
  const cherryPickAll = async (repo: RepositoryStatus, commits: IncomingCommit[]) => {
    const pickable = [...commits].reverse().filter((commit) => commit.parents.length <= 1);
    if (!pickable.length || !await confirmDialog({ title: t('Cherry-Pick All'), message: pickable.map((commit) => `${commit.shortHash} ${commit.message}`).join('\n') })) return;
    for (const commit of pickable) await historyOperation(repo.meta.id, { type: 'cherryPick', revision: commit.hash });
  };
  const syncRepo = async (repo: RepositoryStatus) => {
    const configured = useAppStore.getState().bootstrap?.state.settings?.updateProjectMethod;
    await sync(repo.meta.id, configured === 'rebase' ? 'pullRebase' : 'pull');
    await sync(repo.meta.id, 'push');
  };

  return <div className="sync-incoming-list">
    {repos.map((repo) => {
      const needle = query.trim().toLocaleLowerCase();
      const commits = (incoming[repo.meta.id] ?? []).filter((commit) => !needle || `${commit.hash} ${commit.message} ${commit.author}`.toLocaleLowerCase().includes(needle));
      const potentialConflicts = [...new Set(commits.flatMap((commit) => commit.potentialConflictPaths))];
      const busy = isOperationActive(operations, { workspaceId, repositoryId: repo.meta.id, domain: 'sync' });
      return <section className="sync-incoming-repo" key={repo.meta.id}>
        <header style={{ borderLeftColor: repo.meta.color }}>
          <strong>{repo.meta.name}</strong><span>{repo.branch}</span>
          <em><Codicon name="arrow-down" />{repo.behind || commits.length}</em>
          {potentialConflicts.length > 0 && <span className="sync-conflict-warning" title={potentialConflicts.join('\n')}><Codicon name="warning" />{t('{0} potential conflicts', potentialConflicts.length)}</span>}
          {commits.length > 0 && <button title={t('View Incoming Changes')} onClick={() => void showIncomingChanges(repo)}><Codicon name="diff-multiple" />{t('Changes')}</button>}
          {commits.some((commit) => commit.parents.length <= 1) && <button title={t('Cherry-Pick All')} onClick={() => void cherryPickAll(repo, commits)}><Codicon name="git-commit" />{t('Cherry-Pick All')}</button>}
          <button disabled={busy || !capabilityAvailable(repo.capabilities, 'syncFetch', true)} title={t('Fetch remote changes')} onClick={() => void fetchRepo(repo)}><Codicon name="cloud-download" />{t('Fetch')}</button>
          {repo.ahead > 0 && (repo.behind > 0 || commits.length > 0)
            ? <button disabled={busy || !capabilityAvailable(repo.capabilities, 'syncPull', true) || !capabilityAvailable(repo.capabilities, 'syncPush', true)} onClick={() => void syncRepo(repo)}><Codicon name={busy ? 'loading~spin' : 'sync'} />{t('Sync')} ↓{repo.behind || commits.length} ↑{repo.ahead}</button>
            : <button disabled={busy || !capabilityAvailable(repo.capabilities, 'syncPull', true)} onClick={() => void pull(repo)}><Codicon name={busy ? 'loading~spin' : 'cloud-download'} />{t('Pull')}</button>}
        </header>
        {expandedChangesRepoId === repo.meta.id && changesErrors[repo.meta.id]
          ? <div className="sync-empty"><Codicon name="warning" />{changesErrors[repo.meta.id]}</div>
          : expandedChangesRepoId === repo.meta.id && <PushFileList
          files={changesByRepo[repo.meta.id]?.files ?? []}
          loading={changesLoadingRepoId === repo.meta.id}
          viewMode={fileViewMode}
          description={t('Aggregated incoming changes from remote')}
          onViewModeChange={setFileViewMode}
          query={query}
          onOpenFile={(file) => {
            const changes = changesByRepo[repo.meta.id];
            if (changes) void openDiff(repo.meta.id, file.path, false, undefined, { fromRevision: changes.fromRevision, toRevision: changes.toRevision });
          }}
        />}
        {commits.length ? commits.map((commit) => <IncomingRow key={commit.hash} repoId={repo.meta.id} commit={commit} />) : <div className="sync-empty">{repo.behind > 0 ? t('Fetch to load incoming commit details.') : t('No incoming commits')}</div>}
      </section>;
    })}
  </div>;
}

export function SyncPanel({ repos }: { repos: RepositoryStatus[] }) {
  const [direction, setDirection] = useState<Direction>('all');
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(() => new Set(repos.map((repo) => repo.meta.id)));
  const sync = useAppStore((state) => state.sync);
  const loadIncoming = useAppStore((state) => state.loadIncomingCommits);
  const incoming = useAppStore((state) => state.incomingCommits);
  const { t } = useI18n();
  const speedSearch = useSpeedSearch(direction);
  const visibleRepos = repos;
  const selectedRepos = useMemo(() => repos.filter((repo) => selectedRepoIds.has(repo.meta.id)), [selectedRepoIds, repos]);
  const outgoingCount = useMemo(() => repos.reduce((sum, repo) => sum + repo.ahead, 0), [repos]);
  const incomingCount = useMemo(() => repos.reduce((sum, repo) => sum + Math.max(repo.behind, incoming[repo.meta.id]?.length ?? 0), 0), [incoming, repos]);

  const fetchAll = async () => {
    await Promise.allSettled(repos.map((repo) => sync(repo.meta.id, 'fetch', false)));
    await loadIncoming();
  };
  const pushTags = async () => {
    if (!await confirmDialog({ title: t('Push Tags'), message: t('Push all local tags for selected Git repositories?') })) return;
    await Promise.allSettled(selectedRepos.map((repo) => sync(repo.meta.id, 'pushTags')));
  };
  const syncAll = async () => {
    const configured = useAppStore.getState().bootstrap?.state.settings?.updateProjectMethod;
    const pullAction = configured === 'rebase' ? 'pullRebase' : 'pull';
    for (const repo of selectedRepos) {
      const hasIncoming = repo.behind > 0 || (incoming[repo.meta.id]?.length ?? 0) > 0;
      if (hasIncoming) await sync(repo.meta.id, pullAction);
      if (repo.ahead > 0) await sync(repo.meta.id, 'push');
    }
  };
  const toggleRepo = (repoId: string) => {
    setSelectedRepoIds((current) => {
      const next = new Set(current);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  return <div className="sync-panel">
    <div className="sync-toolbar">
      <div className="sync-direction-tabs">
        <button className={direction === 'all' ? 'active' : ''} onClick={() => setDirection('all')}><Codicon name="sync" />{t('All')}<b>{incomingCount + outgoingCount}</b></button>
        <button className={direction === 'outgoing' ? 'active' : ''} onClick={() => setDirection('outgoing')}><Codicon name="arrow-up" />{t('Outgoing')}<b>{outgoingCount}</b></button>
        <button className={direction === 'incoming' ? 'active' : ''} onClick={() => setDirection('incoming')}><Codicon name="arrow-down" />{t('Incoming')}<b>{incomingCount}</b></button>
      </div>
      <div className="sync-repo-picker">
        {repos.map((repo) => <label key={repo.meta.id} title={repo.meta.rootPath}><input type="checkbox" checked={selectedRepoIds.has(repo.meta.id)} onChange={() => toggleRepo(repo.meta.id)} /><i style={{ background: repo.meta.color }} />{repo.meta.name}</label>)}
      </div>
      <button title={t('Fetch all repositories')} onClick={() => void fetchAll()}><Codicon name="refresh" />{t('Fetch All')}</button>
      <button title={t('Pull incoming changes, then push outgoing commits')} disabled={selectedRepos.length === 0 || incomingCount + outgoingCount === 0} onClick={() => void syncAll()}><Codicon name="sync" />{t('Sync Selected')}</button>
      <button title={t('Push all tags')} disabled={selectedRepos.length === 0} onClick={() => void pushTags()}><Codicon name="tag" />{t('Push Tags')}</button>
    </div>
    <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />
    <div className={`sync-direction-content ${direction === 'all' ? 'combined' : ''}`}>{direction === 'outgoing' ? <PushPanel repos={visibleRepos} selectedRepoIds={selectedRepoIds} onToggleRepo={toggleRepo} query={speedSearch.query} /> : direction === 'incoming' ? <IncomingPanel repos={visibleRepos} query={speedSearch.query} /> : <><div className="sync-combined-pane"><h3><Codicon name="arrow-up" />{t('Outgoing')}</h3><PushPanel repos={visibleRepos} selectedRepoIds={selectedRepoIds} onToggleRepo={toggleRepo} query={speedSearch.query} /></div><div className="sync-combined-pane"><h3><Codicon name="arrow-down" />{t('Incoming')}</h3><IncomingPanel repos={visibleRepos} query={speedSearch.query} /></div></>}</div>
  </div>;
}
