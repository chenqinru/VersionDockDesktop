import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepositoryStatus, SubmoduleEntry } from '../bindings/generated';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { readableAccentColor } from './branchColor';
import { BranchRefBadge } from './BranchRefBadge';
import { Codicon } from './Codicon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { confirmDialog, promptDialog } from './dialogService';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';

function SubmoduleRow({ repo, entry, busy, highlighted }: { repo: RepositoryStatus; entry: SubmoduleEntry; busy: boolean; highlighted: boolean }) {
  const operate = useAppStore((state) => state.submoduleOperation);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const bridge = useAppStore((state) => state.bridge);
  const conflicts = useAppStore((state) => state.conflicts);
  const openMerge = useAppStore((state) => state.openMerge);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (highlighted) rowRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [highlighted]);
  const [context, setContext] = useState<{ x: number; y: number }>();

  const remove = async () => {
    const risks: string[] = [];
    if (entry.dirty) risks.push(t('uncommitted local changes'));
    if ((entry.unpushedCount ?? 0) > 0) risks.push(t('{0} unpushed commits', entry.unpushedCount));
    const riskWarning = risks.length > 0 ? ' ' + t('WARNING: Submodule has {0}. Removing will permanently delete these modifications!', risks.join(' & ')) : '';

    if (!await confirmDialog({
      title: t('Remove Submodule'),
      message: t('VersionDock [{0}]: Remove submodule "{1}"? This will deinitialize, unregister from .gitmodules, and delete its files.{2}', repo.meta.name, entry.path, riskWarning),
      confirmLabel: t('Remove'),
      danger: true,
    }) || useAppStore.getState().snapshot?.workspace.id !== workspaceId) return;
    try {
      await operate(repo.meta.id, { type: 'remove', path: entry.path, force: false }, { rethrow: true });
    } catch (error) {
      const errorCode = (error as { code?: string })?.code;
      if (errorCode !== 'SUBMODULE_DIRTY' && !String(error).includes('SUBMODULE_DIRTY')) return;
      if (await confirmDialog({ title: t('Force Remove Submodule'), message: t('The submodule has local changes. Force removal can discard them.'), confirmLabel: t('Force Remove'), danger: true }) && useAppStore.getState().snapshot?.workspace.id === workspaceId) {
        await operate(repo.meta.id, { type: 'remove', path: entry.path, force: true });
      }
    }
  };

  const openConflict = () => {
    const conflict = conflicts.find((item) => item.repoId === repo.meta.id && (item.path === entry.path || item.path === entry.companionPath));
    if (conflict) void openMerge(conflict);
  };

  const absolutePath = `${repo.meta.rootPath.replace(/[\\/]+$/, '')}/${entry.path}`;
  const reveal = () => void systemOpen(repo.meta.id, entry.path, true);
  const openInFileManager = () => void systemOpen(repo.meta.id, entry.path, false);
  const openInNewWindow = () => void bridge?.openInNewWindow([absolutePath]);
  const deinitialize = async () => {
    if (!await confirmDialog({
      title: t('Deinitialize Submodule'),
      message: t('VersionDock [{0}]: Deinit submodule "{1}"? The working directory will be cleared.', repo.meta.name, entry.path),
      confirmLabel: t('Deinitialize'),
      danger: true,
    }) || useAppStore.getState().snapshot?.workspace.id !== workspaceId) return;
    try {
      await operate(repo.meta.id, { type: 'deinit', path: entry.path, force: false }, { rethrow: true });
    } catch (error) {
      if (!/local modifications|--force|\s-f\b/i.test(String(error))) return;
      if (await confirmDialog({
        title: t('Force Deinitialize Submodule'),
        message: t('VersionDock [{0}]: Submodule "{1}" has uncommitted changes or detached HEAD. Discard changes and force deinitialize?', repo.meta.name, entry.path),
        confirmLabel: t('Force Deinitialize Submodule'),
        danger: true,
      }) && useAppStore.getState().snapshot?.workspace.id === workspaceId) await operate(repo.meta.id, { type: 'deinit', path: entry.path, force: true });
    }
  };
  const run = (type: string) => {
    if (busy || useAppStore.getState().snapshot?.workspace.id !== workspaceId) return;
    if (type === 'init') void operate(repo.meta.id, { type: 'init', path: entry.path, recursive: true });
    else if (type === 'update') void operate(repo.meta.id, { type: 'update', path: entry.path, init: true, recursive: false, remote: false });
    else if (type === 'updateRemote') void operate(repo.meta.id, { type: 'update', path: entry.path, init: true, recursive: true, remote: true });
    else if (type === 'sync') void operate(repo.meta.id, { type: 'sync', path: entry.path, recursive: false });
    else if (type === 'deinit') void deinitialize();
    else if (type === 'ours') void operate(repo.meta.id, { type: 'resolveConflict', path: entry.path, choice: 'mine' });
    else if (type === 'theirs') void operate(repo.meta.id, { type: 'resolveConflict', path: entry.path, choice: 'theirs' });
    else if (type === 'remove') void remove();
    else if (type === 'reveal') reveal();
    else if (type === 'fileManager') openInFileManager();
    else if (type === 'newWindow') openInNewWindow();
  };

  const contextItems: ContextMenuEntry[] = ([
    ...(entry.syncStatus === 'conflict'
      ? entry.typeChange
        ? [{ id: 'merge', label: t('Resolve in Merge Editor'), icon: 'git-merge' } as ContextMenuEntry, { separator: true } as ContextMenuEntry]
        : [
            { id: 'ours', label: !entry.conflictStages || entry.conflictStages.ours ? t('Resolve Conflict: Use Current (Ours)') : t('Resolve Conflict: Accept Deletion (Ours)'), icon: !entry.conflictStages || entry.conflictStages.ours ? 'check' : 'trash' } as ContextMenuEntry,
            { id: 'theirs', label: !entry.conflictStages || entry.conflictStages.theirs ? t('Resolve Conflict: Use Incoming (Theirs)') : t('Resolve Conflict: Accept Deletion (Theirs)'), icon: !entry.conflictStages || entry.conflictStages.theirs ? 'fold-down' : 'trash' } as ContextMenuEntry,
            { separator: true } as ContextMenuEntry,
          ]
      : []),
    ...(!entry.initialized
      ? [{ id: 'init', label: t('Initialize Submodule'), icon: 'cloud-download' } as ContextMenuEntry]
      : [
          { id: 'update', label: t('Update Submodule'), icon: 'sync' } as ContextMenuEntry,
          { id: 'updateRemote', label: t('Update from Remote'), icon: 'cloud-download' } as ContextMenuEntry,
        ]),
    { separator: true },
    { id: 'reveal', label: t('Reveal in Explorer'), icon: 'folder-opened' },
    { id: 'newWindow', label: t('Open in New Window'), icon: 'link-external' },
    { id: 'fileManager', label: t(/Mac/i.test(navigator.platform) ? 'Reveal in Finder' : /Win/i.test(navigator.platform) ? 'Show in Explorer' : 'Show in File Manager'), icon: 'folder' },
    ...(entry.initialized ? [{ separator: true } as ContextMenuEntry, { id: 'sync', label: t('Sync URL to Git Config'), icon: 'refresh' } as ContextMenuEntry, { id: 'deinit', label: t('Deinitialize Submodule'), icon: 'clear-all', danger: true } as ContextMenuEntry] : []),
    { id: 'remove', label: t('Remove Submodule'), icon: 'trash', danger: true },
  ] satisfies ContextMenuEntry[]).map((item) => 'separator' in item ? item : { ...item, disabled: busy || ('disabled' in item && item.disabled) });

  const hasOurs = !entry.conflictStages || Boolean(entry.conflictStages.ours);
  const primaryAction = !entry.initialized
    ? { id: 'init', icon: 'cloud-download', label: t('Initialize'), title: t('Initialize this submodule (git submodule init && update)') }
    : entry.syncStatus === 'conflict'
      ? entry.typeChange
        ? { id: 'merge', icon: 'git-merge', label: t('Resolve in Merge Editor'), title: t('Resolve in Merge Editor') }
        : { id: 'ours', icon: hasOurs ? 'check' : 'trash', label: hasOurs ? t('Use Ours') : t('Delete (Ours)'), title: hasOurs ? t('Resolve Conflict: Use Current Pointer (Ours)') : t('Resolve Conflict: Accept Deletion (Ours)') }
      : entry.syncStatus === 'outOfSync'
        ? { id: 'update', icon: 'arrow-swap', label: t('Align'), title: t('Align submodule with recorded parent commit') }
        : undefined;

  return <div ref={rowRef} className={`submodule-row ${highlighted ? 'selected' : context ? 'context-active' : ''}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }); }}>
    <div className="submodule-row-main">
      <Codicon name={entry.initialized ? 'repo' : 'repo-clone'} />
      <div className="submodule-info">
        <div className="submodule-title-line">
          <strong title={entry.path}>{entry.path}</strong>
          {entry.name !== entry.path && <small>({entry.name})</small>}
          <span className={`submodule-status ${entry.initialized ? 'synced' : 'uninitialized'}`}>{t(entry.initialized ? 'Initialized' : 'Uninitialized')}</span>
          {entry.syncStatus === 'conflict' && <span className="submodule-status conflict">{t(entry.typeChange ? 'Type-Change Conflict' : 'Conflict')}</span>}
          {entry.dirty && <span className="submodule-status dirty">{t('Dirty')}</span>}
          {entry.unpushedCount > 0 && <span className="submodule-status unpushed">{t('{0} unpushed', entry.unpushedCount)}</span>}
        </div>
        <div className="submodule-meta-line">
          {entry.syncStatus === 'outOfSync' && <span className="submodule-status" title={`${t('Recorded in Parent:')} ${entry.recordedCommit ?? ''}\n${t('Current HEAD:')} ${entry.revision ?? ''}`}>
            {entry.recordedCommit ? t('Parent: {0}', entry.recordedCommit.slice(0, 8)) : t('Out of sync')}
          </span>}
          {(entry.currentBranch || entry.revision) && <BranchRefBadge label={entry.currentBranch ?? entry.revision!.slice(0, 8)} kind={entry.detached || !entry.currentBranch ? 'head' : 'branch'} />}
          {entry.branch && <span className="submodule-tracking-branch" title={t('Tracked branch: {0}', entry.branch)}><Codicon name="link" />{entry.branch}</span>}
          <span title={entry.url}>{entry.url}</span>
        </div>
      </div>
      <div className="submodule-row-actions">
        {busy ? <Codicon name="loading~spin" /> : <>
          {primaryAction && <button className={`primary ${entry.syncStatus === 'conflict' ? 'conflict' : ''}`} title={primaryAction.title} onClick={() => primaryAction.id === 'merge' ? openConflict() : run(primaryAction.id)}><Codicon name={primaryAction.icon} /><span>{primaryAction.label}</span></button>}
          {entry.initialized && hovered && <span className="submodule-hover-actions"><button title={t('Reveal in Explorer')} onClick={reveal}><Codicon name="folder-opened" /></button><button title={t('Update from Remote')} onClick={() => run('updateRemote')}><Codicon name="cloud-download" /></button>
          <button title={t('Open in New Window')} onClick={openInNewWindow}><Codicon name="link-external" /></button></span>}
        </>}
      </div>
    </div>
    {context && <ContextMenu x={context.x} y={context.y} items={contextItems} onSelect={(id) => id === 'merge' ? openConflict() : run(id)} onClose={() => setContext(undefined)} />}
  </div>;
}

export function SubmodulePanel({ repos, highlight, active = true }: { repos: RepositoryStatus[]; active?: boolean; highlight?: { repoId: string; path: string } }) {
  const entries = useAppStore((state) => state.submodules);
  const loadErrors = useAppStore((state) => state.loadErrors);
  const load = useAppStore((state) => state.loadSubmodules);
  const operate = useAppStore((state) => state.submoduleOperation);
  const operations = useAppStore((state) => state.operations);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const { t } = useI18n();
  const speedSearch = useSpeedSearch('submodules', active);
  const [collapsedRepoIds, setCollapsedRepoIds] = useState<Set<string>>(new Set());
  useEffect(() => { if (highlight) queueMicrotask(() => setCollapsedRepoIds((current) => { const next = new Set(current); next.delete(highlight.repoId); return next; })); }, [highlight]);
  const total = useMemo(() => repos.reduce((sum, repo) => sum + (entries[repo.meta.id]?.length ?? 0), 0), [entries, repos]);

  useEffect(() => {
    if (repos.some((repo) => !repo.meta.isSubmodule && !entries[repo.meta.id] && !loadErrors[`submodules:${repo.meta.id}`])) {
      void load();
    }
  }, [entries, load, loadErrors, repos]);

  const add = async (repo: RepositoryStatus) => {
    const url = await promptDialog({ title: t('Add Submodule'), message: repo.meta.name, inputLabel: t('Repository URL') });
    if (!url) return;
    const path = await promptDialog({ title: t('Add Submodule'), message: url, inputLabel: t('Submodule path') });
    if (!path) return;
    const localPath = url.startsWith('file://') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../');
    const allowFileProtocol = localPath && await confirmDialog({ title: t('Allow Local Submodule'), message: t('This submodule uses a local path. Allow the Git file protocol for this operation?'), confirmLabel: t('Allow') });
    if (localPath && !allowFileProtocol) return;
    await operate(repo.meta.id, { type: 'add', url, path, branch: null, allow_file_protocol: allowFileProtocol });
  };

  return <div className="submodule-panel">
    <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />
    <div className="submodule-repo-list">
      {repos.map((repo) => {
        const needle = speedSearch.query.trim().toLocaleLowerCase();
        const allItems = entries[repo.meta.id] ?? [];
        const items = allItems.filter((entry) => !needle || `${entry.name} ${entry.path} ${entry.url} ${entry.currentBranch ?? ''}`.toLocaleLowerCase().includes(needle));
        const busy = isOperationActive(operations, { workspaceId, repositoryId: repo.meta.id, domain: 'submodule' });
        const collapsed = collapsedRepoIds.has(repo.meta.id);
        const color = readableAccentColor(repo.meta.color);
        const uninitialized = allItems.filter((entry) => !entry.initialized).length;
        const outOfSync = allItems.filter((entry) => entry.syncStatus === 'outOfSync').length;
        const error = loadErrors[`submodules:${repo.meta.id}`];
        return <section className="submodule-repo" key={repo.meta.id}>
          <header className="repository-group-header" style={{ '--repo-color': color } as React.CSSProperties} onClick={(event) => { if (!(event.target as HTMLElement).closest('button, input, label')) setCollapsedRepoIds((current) => { const next = new Set(current); if (next.has(repo.meta.id)) next.delete(repo.meta.id); else next.add(repo.meta.id); return next; }); }}>
            <button className="repository-group-main" title={repo.meta.name} aria-expanded={!collapsed} onClick={() => setCollapsedRepoIds((current) => { const next = new Set(current); if (next.has(repo.meta.id)) next.delete(repo.meta.id); else next.add(repo.meta.id); return next; })}>
              <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} />
              <i style={{ background: color }} />
              <strong>{repo.meta.name}</strong>
              {allItems.length > 0 && <span className="repository-count">{allItems.length}</span>}
              {uninitialized > 0 && <span className="submodule-status uninitialized">{t('{0} uninit', uninitialized)}</span>}
            </button>
            {outOfSync > 0 && <button className="submodule-status outOfSync" disabled={busy} title={t('Align all submodules with parent commits (git submodule update --recursive)')} onClick={() => void operate(repo.meta.id, { type: 'updateAll', init: true, recursive: true, remote: false })}>{t('{0} out of sync', outOfSync)}</button>}
            {allItems.length > 0 && <button data-action-btn="" disabled={busy} title={t('Align all submodules with parent commits (git submodule update --init --recursive)')} onClick={() => void operate(repo.meta.id, { type: 'updateAll', init: true, recursive: true, remote: false })}><Codicon name={busy ? 'loading~spin' : 'arrow-swap'} /></button>}
            <button data-action-btn="" disabled={busy} title={t('Add Submodule to {0}', repo.meta.name)} onClick={() => void add(repo)}><Codicon name="add" /></button>
          </header>
          {!collapsed && <div className="submodule-repo-body">
            {error && <div className="sync-empty" style={{ color: 'var(--vscode-errorForeground, #f48771)', justifyContent: 'flex-start', padding: '6px 12px' }}><Codicon name="error" /> {error}</div>}
            {items.length ? items.map((entry) => <SubmoduleRow key={entry.path} repo={repo} entry={entry} busy={busy} highlighted={highlight?.repoId === repo.meta.id && highlight.path === entry.path} />) : !error && <div className="sync-empty">{needle && total > 0 ? t('No commits found') : t('No submodules')}</div>}
          </div>}
        </section>;
      })}
      {!repos.length && <div className="sync-empty">{t('No Git repositories')}</div>}
    </div>
  </div>;
}
