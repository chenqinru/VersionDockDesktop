import { useEffect, useMemo, useState } from 'react';
import type { RepositoryStatus, SubmoduleEntry } from '../bindings/generated';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { BranchRefBadge } from './BranchRefBadge';
import { confirmDialog, promptDialog } from './dialogService';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';

function statusLabel(entry: SubmoduleEntry, t: (key: string, ...args: Array<string | number>) => string): string {
  if (entry.syncStatus === 'conflict') return t('Conflict');
  if (entry.syncStatus === 'uninitialized') return t('Uninitialized');
  if (entry.syncStatus === 'outOfSync') return t('Out of sync');
  return t('Synced');
}

function SubmoduleRow({ repo, entry }: { repo: RepositoryStatus; entry: SubmoduleEntry }) {
  const operate = useAppStore((state) => state.submoduleOperation);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const bridge = useAppStore((state) => state.bridge);
  const conflicts = useAppStore((state) => state.conflicts);
  const openMerge = useAppStore((state) => state.openMerge);
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: t('Remove Submodule'),
      message: t('Remove submodule "{0}" from the repository and stage the .gitmodules change?', entry.path),
      confirmLabel: t('Remove'),
      danger: true,
    });
    if (!confirmed) return;
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

  return <div className="submodule-row">
    <div className="submodule-row-main">
      <Codicon name={entry.initialized ? 'repo' : 'repo-clone'} />
      <div className="submodule-info">
        <div><strong>{entry.path}</strong>{entry.name !== entry.path && <small>({entry.name})</small>}<span className={`submodule-status ${entry.syncStatus}`}>{statusLabel(entry, t)}</span>{entry.typeChange && <span className="submodule-status conflict">{t('Type-change conflict')}</span>}{entry.dirty && <span className="submodule-status dirty">{t('Dirty')}</span>}{entry.unpushedCount > 0 && <span className="submodule-status unpushed">{t('{0} unpushed', entry.unpushedCount)}</span>}</div>
        <div>{entry.currentBranch && <BranchRefBadge label={entry.currentBranch} />}{entry.detached && entry.revision && <BranchRefBadge label={entry.revision.slice(0, 8)} kind="head" />}<span title={entry.url}>{entry.url}</span></div>
      </div>
    </div>
    <div className="submodule-actions">
      {entry.syncStatus === 'conflict' && (entry.typeChange ? <button onClick={openConflict}><Codicon name="git-merge" />{t('Resolve in Merge Editor')}</button> : <><button onClick={() => void operate(repo.meta.id, { type: 'resolveConflict', path: entry.path, choice: 'mine' })}>{entry.conflictStages?.ours ? t('Use Ours') : t('Accept Ours Deletion')}</button><button onClick={() => void operate(repo.meta.id, { type: 'resolveConflict', path: entry.path, choice: 'theirs' })}>{entry.conflictStages?.theirs ? t('Use Theirs') : t('Accept Theirs Deletion')}</button></>)}
      {!entry.initialized ? <button onClick={() => void operate(repo.meta.id, { type: 'init', path: entry.path, recursive: true })}><Codicon name="cloud-download" />{t('Initialize')}</button>
        : <><button onClick={() => void operate(repo.meta.id, { type: 'update', path: entry.path, init: true, recursive: true, remote: false })}><Codicon name="sync" />{t('Update')}</button><button onClick={() => void operate(repo.meta.id, { type: 'update', path: entry.path, init: true, recursive: true, remote: true })}><Codicon name="cloud-download" />{t('Update from Remote')}</button><button onClick={() => void operate(repo.meta.id, { type: 'sync', path: entry.path, recursive: true })}>{t('Sync URL')}</button><button onClick={() => void operate(repo.meta.id, { type: 'deinit', path: entry.path, force: false })}>{t('Deinitialize')}</button></>}
      <button onClick={() => void systemOpen(repo.meta.id, entry.path, true)}><Codicon name="folder-opened" />{t('Reveal')}</button>
      <button onClick={() => void systemOpen(repo.meta.id, entry.path, false)}><Codicon name="folder" />{t('Open in File Manager')}</button>
      <button onClick={() => void bridge?.openInNewWindow([absolutePath])}><Codicon name="link-external" />{t('Open in New Window')}</button>
      {entry.initialized && <><button disabled={entry.detached} onClick={() => void operate(repo.meta.id, { type: 'push', path: entry.path })}><Codicon name="cloud-upload" />{t('Push')}</button><button onClick={() => void operate(repo.meta.id, { type: 'pull', path: entry.path, rebase: false })}><Codicon name="cloud-download" />{t('Pull')}</button></>}
      {entry.diffSummary && <button onClick={() => setDetailsOpen((value) => !value)}><Codicon name="diff" />{t('Show Diff Summary')}</button>}
      <button className="danger" onClick={() => void remove()}><Codicon name="trash" />{t('Remove')}</button>
    </div>
    {detailsOpen && entry.diffSummary && <pre className="submodule-diff-summary">{entry.diffSummary}</pre>}
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
    <div className="submodule-toolbar"><span>{t('{0} submodules', total)}</span><button onClick={() => void load()}><Codicon name="refresh" />{t('Refresh')}</button></div>
    <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />
    {repos.map((repo) => {
      const needle = speedSearch.query.trim().toLocaleLowerCase();
      const items = (entries[repo.meta.id] ?? []).filter((entry) => !needle || `${entry.name} ${entry.path} ${entry.url} ${entry.currentBranch ?? ''}`.toLocaleLowerCase().includes(needle));
      const busy = isOperationActive(operations, { workspaceId, repositoryId: repo.meta.id, domain: 'submodule' });
      return <section className="submodule-repo" key={repo.meta.id}>
        <header style={{ borderLeftColor: repo.meta.color }}><strong>{repo.meta.name}</strong><span>{items.length}</span><button disabled={busy} onClick={() => void operate(repo.meta.id, { type: 'updateAll', init: true, recursive: true, remote: false })}><Codicon name={busy ? 'loading~spin' : 'sync'} />{t('Update All')}</button><button disabled={busy} onClick={() => void add(repo)}><Codicon name="add" />{t('Add')}</button></header>
        {items.length ? items.map((entry) => <SubmoduleRow key={entry.path} repo={repo} entry={entry} />) : <div className="sync-empty">{t('No submodules')}</div>}
      </section>;
    })}
  </div>;
}
