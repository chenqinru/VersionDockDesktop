import { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { RepositoryStatus } from '../bindings/generated';

export function WorktreePanel({ repos }: { repos: RepositoryStatus[] }) {
  const values = useAppStore((state) => state.worktrees);
  const load = useAppStore((state) => state.loadWorktrees);
  const operate = useAppStore((state) => state.worktreeOperation);
  const busy = useAppStore((state) => state.busy);
  const [branch, setBranch] = useState('');
  const [newBranch, setNewBranch] = useState(true);
  const { t } = useI18n();
  useEffect(() => { for (const repo of repos) void load(repo.meta.id); }, [load, repos]);
  return <div className="stash-panel"><div className="stash-create"><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={t('Branch name')} /><label><input type="checkbox" checked={newBranch} onChange={(event) => setNewBranch(event.target.checked)} />{t('Create new branch')}</label></div><div className="stash-list">{repos.map((repo) => <section key={repo.meta.id} className="stash-repo"><header><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><button onClick={() => void operate(repo.meta.id, { type: 'prune' })}>{t('Prune')}</button><button disabled={busy || !branch.trim()} onClick={() => { void operate(repo.meta.id, { type: 'create', branch: branch.trim(), new_branch: newBranch }); setBranch(''); }}><Codicon name="add" />{t('Add worktree')}</button></header>{(values[repo.meta.id] ?? []).map((entry) => <article className="stash-row" key={entry.path}><Codicon name={entry.main ? 'home' : 'repo-clone'} /><span><strong>{entry.branch || entry.head.slice(0, 8)}</strong><small>{entry.main ? t('Main worktree') : entry.path}</small></span>{!entry.main && <><button onClick={() => void operate(repo.meta.id, entry.locked ? { type: 'unlock', path: entry.path } : { type: 'lock', path: entry.path })}>{entry.locked ? t('Unlock') : t('Lock')}</button><button className="danger" onClick={(event) => { const force = event.shiftKey; if (confirm(force ? t('Force remove worktree {0}?', entry.branch || entry.path) : t('Remove worktree {0}?', entry.branch || entry.path))) void operate(repo.meta.id, { type: 'remove', path: entry.path, force }); }}>{t('Delete')}</button></>}</article>)}</section>)}</div></div>;
}
