import { useEffect } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { RepositoryStatus } from '../bindings/generated';

export function WorktreePanel({ repos }: { repos: RepositoryStatus[] }) {
  const values = useAppStore((state) => state.worktrees);
  const load = useAppStore((state) => state.loadWorktrees);
  const operate = useAppStore((state) => state.worktreeOperation);
  const busy = useAppStore((state) => state.busy);
  const { t } = useI18n();
  const create = (repo: RepositoryStatus) => {
    const branch = prompt(t('Branch name'));
    if (!branch?.trim()) return;
    const newBranch = confirm(t('Create new branch'));
    void operate(repo.meta.id, { type: 'create', branch: branch.trim(), new_branch: newBranch });
  };
  useEffect(() => { for (const repo of repos) void load(repo.meta.id); }, [load, repos]);
  return <div className="stash-panel"><div className="stash-list">{repos.map((repo) => <section key={repo.meta.id} className="stash-repo"><header style={{ background: `color-mix(in srgb, ${repo.meta.color} 18%, var(--versiondock-surface))` }}><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><span className="panel-count">{(values[repo.meta.id] ?? []).length}</span><button onClick={() => void operate(repo.meta.id, { type: 'prune' })} title={t('Prune')}><Codicon name="refresh" /></button><button disabled={busy} onClick={() => create(repo)} title={t('Add worktree')}><Codicon name="add" /></button></header>{(values[repo.meta.id] ?? []).map((entry) => <article className="stash-row worktree-row" key={entry.path}><Codicon name={entry.main ? 'home' : 'repo-clone'} /><span><strong>{entry.branch || entry.head.slice(0, 8)}{entry.main && <em>{t('Main worktree')}</em>}</strong><small>{entry.path}</small></span>{!entry.main && <><button onClick={() => void operate(repo.meta.id, entry.locked ? { type: 'unlock', path: entry.path } : { type: 'lock', path: entry.path })} title={entry.locked ? t('Unlock') : t('Lock')}><Codicon name={entry.locked ? 'unlock' : 'lock'} /></button><button className="danger" onClick={(event) => { const force = event.shiftKey; if (confirm(force ? t('Force remove worktree {0}?', entry.branch || entry.path) : t('Remove worktree {0}?', entry.branch || entry.path))) void operate(repo.meta.id, { type: 'remove', path: entry.path, force }); }} title={t('Delete')}><Codicon name="trash" /></button></>}</article>)}</section>)}</div></div>;
}
