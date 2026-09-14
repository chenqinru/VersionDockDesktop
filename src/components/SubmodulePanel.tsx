import { useEffect, useMemo, useState } from 'react';
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

type Translate = (key: string, ...args: Array<string | number>) => string;

function statusLabel(entry: SubmoduleEntry, t: Translate): string {
  if (entry.syncStatus === 'conflict') return t('Conflict');
  if (entry.syncStatus === 'uninitialized') return t('Uninitialized');
  if (entry.syncStatus === 'outOfSync') return t('Out of sync');
  return t('Synced');
}

function SubmoduleRow({ repo, entry, busy }: { repo: RepositoryStatus; entry: SubmoduleEntry; busy: boolean }) {
  const operate = useAppStore((state) => state.submoduleOperation);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const bridge = useAppStore((state) => state.bridge);
  const conflicts = useAppStore((state) => state.conflicts);
  const openMerge = useAppStore((state) => state.openMerge);
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number }>();

  const remove = async () => {
    if (!await confirmDialog({
      title: t('Remove Submodule'),
      message: t('Remove submodule "{0}" from the repository and stage the .gitmodules change?', entry.path),
      confirmLabel: t('Remove'),
      danger: true,
    })) return;
    try {
      await operate(repo.meta.id, { type: 'remove', path: entry.path, force: false });
    } catch (error) {
      if (!String(error).includes('SUBMODULE_DIRTY')) throw error;
      if (await confirmDialog({ title: t('Force Remove Submodule'), message: t('The submodule has local changes. Force removal can discard them.'), confirmLabel: t('Force Remove'), danger: true })) {
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
  const run = (type: string) => {
    if (type === 'init') void operate(repo.meta.id, { type: 'init', path: entry.path, recursive: true });
    else if (type === 'update') void operate(repo.meta.id, { type: 'update', path: entry.path, init: true, recursive: true, remote: false });
    else if (type === 'updateRemote') void operate(repo.meta.id, { type: 'update', path: entry.path, init: true, recursive: true, remote: true });
    else if (type === 'sync') void operate(repo.meta.id, { type: 'sync', path: entry.path, recursive: true });
    else if (type === 'deinit') void operate(repo.meta.id, { type: 'deinit', path: entry.path, force: false });
    else if (type === 'push') void operate(repo.meta.id, { type: 'push', path: entry.path });
    else if (type === 'pull') void operate(repo.meta.id, { type: 'pull', path: entry.path, rebase: false });
    else if (type === 'ours') void operate(repo.meta.id, { type: 'resolveConflict', path: entry.path, choice: 'mine' });
    else if (type === 'theirs') void operate(repo.meta.id, { type: 'resolveConflict', path: entry.path, choice: 'theirs' });
    else if (type === 'remove') void remove();
    else if (type === 'reveal') reveal();
    else if (type === 'fileManager') openInFileManager();
    else if (type === 'newWindow') openInNewWindow();
    else if (type === 'diff') setDetailsOpen((value) => !value);
  };

  const contextItems: ContextMenuEntry[] = [
    ...(entry.syncStatus === 'conflict'
      ? entry.typeChange
        ? [{ id: 'merge', label: t('Resolve in Merge Editor'), icon: 'git-merge' } as ContextMenuEntry, { separator: true } as ContextMenuEntry]
        : [
            { id: 'ours', label: entry.conflictStages?.ours ? t('Use Ours') : t('Accept Ours Deletion'), icon: entry.conflictStages?.ours ? 'check' : 'trash' } as ContextMenuEntry,
            { id: 'theirs', label: entry.conflictStages?.theirs ? t('Use Theirs') : t('Accept Theirs Deletion'), icon: entry.conflictStages?.theirs ? 'fold-down' : 'trash' } as ContextMenuEntry,
            { separator: true } as ContextMenuEntry,
          ]
      : []),
    ...(!entry.initialized
      ? [{ id: 'init', label: t('Initialize'), icon: 'cloud-download' } as ContextMenuEntry]
      : [
          { id: 'update', label: t('Update'), icon: 'sync' } as ContextMenuEntry,
          { id: 'updateRemote', label: t('Update from Remote'), icon: 'cloud-download' } as ContextMenuEntry,
          { id: 'pull', label: t('Pull'), icon: 'cloud-download' } as ContextMenuEntry,
          { id: 'push', label: t('Push'), icon: 'cloud-upload', disabled: entry.detached } as ContextMenuEntry,
        ]),
    { separator: true },
    { id: 'reveal', label: t('Reveal'), icon: 'folder-opened' },
    { id: 'newWindow', label: t('Open in New Window'), icon: 'link-external' },
    { id: 'fileManager', label: t('Open in File Manager'), icon: 'folder' },
    ...(entry.diffSummary ? [{ id: 'diff', label: t('Show Diff Summary'), icon: 'diff' } as ContextMenuEntry] : []),
    ...(entry.initialized ? [{ separator: true } as ContextMenuEntry, { id: 'sync', label: t('Sync URL'), icon: 'refresh' } as ContextMenuEntry, { id: 'deinit', label: t('Deinitialize'), icon: 'clear-all', danger: true } as ContextMenuEntry] : []),
    { id: 'remove', label: t('Remove'), icon: 'trash', danger: true },
  ];

  const primaryAction = entry.syncStatus === 'conflict'
    ? entry.typeChange
      ? { id: 'merge', icon: 'git-merge', label: t('Resolve in Merge Editor') }
      : { id: 'ours', icon: entry.conflictStages?.ours ? 'check' : 'trash', label: entry.conflictStages?.ours ? t('Use Ours') : t('Accept Ours Deletion') }
    : entry.syncStatus === 'outOfSync'
      ? { id: 'update', icon: 'arrow-swap', label: t('Update') }
      : !entry.initialized
        ? { id: 'init', icon: 'cloud-download', label: t('Initialize') }
        : undefined;

  return <div className="submodule-row" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }); }}>
    <div className="submodule-row-main">
      <Codicon name={entry.initialized ? 'repo' : 'repo-clone'} />
      <div className="submodule-info">
        <div className="submodule-title-line">
          <strong title={entry.path}>{entry.path}</strong>
          {entry.name !== entry.path && <small>({entry.name})</small>}
          <span className={`submodule-status ${entry.syncStatus}`}>{statusLabel(entry, t)}</span>
          {entry.typeChange && <span className="submodule-status conflict">{t('Type-change conflict')}</span>}
          {entry.dirty && <span className="submodule-status dirty">{t('Dirty')}</span>}
          {entry.unpushedCount > 0 && <span className="submodule-status unpushed">{t('{0} unpushed', entry.unpushedCount)}</span>}
        </div>
        <div className="submodule-meta-line">
          {entry.currentBranch && <BranchRefBadge label={entry.currentBranch} />}
          {entry.detached && entry.revision && <BranchRefBadge label={entry.revision.slice(0, 8)} kind="head" />}
          <span title={entry.url}>{entry.url}</span>
        </div>
      </div>
      <div className={`submodule-row-actions ${hovered ? 'visible' : ''}`}>
        {busy ? <Codicon name="loading~spin" /> : <>
          {primaryAction && <button className="primary" title={primaryAction.label} onClick={() => primaryAction.id === 'merge' ? openConflict() : run(primaryAction.id)}><Codicon name={primaryAction.icon} /><span>{primaryAction.label}</span></button>}
          {entry.initialized && <button title={t('Update from Remote')} onClick={() => run('updateRemote')}><Codicon name="cloud-download" /></button>}
          <button title={t('Reveal')} onClick={reveal}><Codicon name="folder-opened" /></button>
          <button title={t('Open in New Window')} onClick={openInNewWindow}><Codicon name="link-external" /></button>
        </>}
      </div>
    </div>
    {detailsOpen && entry.diffSummary && <pre className="submodule-diff-summary">{entry.diffSummary}</pre>}
    {context && <ContextMenu x={context.x} y={context.y} items={contextItems} onSelect={(id) => id === 'merge' ? openConflict() : run(id)} onClose={() => setContext(undefined)} />}
  </div>;
}

export function SubmodulePanel({ repos }: { repos: RepositoryStatus[] }) {
  const entries = useAppStore((state) => state.submodules);
  const load = useAppStore((state) => state.loadSubmodules);
  const operate = useAppStore((state) => state.submoduleOperation);
  const operations = useAppStore((state) => state.operations);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const { t } = useI18n();
  const speedSearch = useSpeedSearch('submodules');
  const [collapsedRepoIds, setCollapsedRepoIds] = useState<Set<string>>(new Set());
  const total = useMemo(() => repos.reduce((sum, repo) => sum + (entries[repo.meta.id]?.length ?? 0), 0), [entries, repos]);

  useEffect(() => { void load(); }, [load]);

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
        return <section className="submodule-repo" key={repo.meta.id}>
          <header className="repository-group-header" style={{ '--repo-color': color } as React.CSSProperties}>
            <button className="repository-group-main" title={repo.meta.name} onClick={() => setCollapsedRepoIds((current) => { const next = new Set(current); if (next.has(repo.meta.id)) next.delete(repo.meta.id); else next.add(repo.meta.id); return next; })}>
              <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} />
              <i style={{ background: color }} />
              <strong>{repo.meta.name}</strong>
              {allItems.length > 0 && <span className="repository-count">{allItems.length}</span>}
              {uninitialized > 0 && <span className="submodule-status uninitialized">{uninitialized} {t('Uninitialized')}</span>}
              {outOfSync > 0 && <span className="submodule-status outOfSync">{outOfSync} {t('Out of sync')}</span>}
            </button>
            {allItems.length > 0 && <button data-action-btn="" disabled={busy} title={t('Update All')} onClick={() => void operate(repo.meta.id, { type: 'updateAll', init: true, recursive: true, remote: false })}><Codicon name={busy ? 'loading~spin' : 'arrow-swap'} /></button>}
            <button data-action-btn="" disabled={busy} title={t('Add Submodule')} onClick={() => void add(repo)}><Codicon name="add" /></button>
          </header>
          {!collapsed && <div className="submodule-repo-body">
            {items.length ? items.map((entry) => <SubmoduleRow key={entry.path} repo={repo} entry={entry} busy={busy} />) : <div className="sync-empty">{needle && total > 0 ? t('No commits found') : t('No submodules')}</div>}
          </div>}
        </section>;
      })}
      {!repos.length && <div className="sync-empty">{t('No Git repositories')}</div>}
    </div>
  </div>;
}
