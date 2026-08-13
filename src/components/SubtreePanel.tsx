import { useEffect } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { RepositoryStatus, SubtreeEntry } from '../bindings/generated';

export function SubtreePanel({ repos }: { repos: RepositoryStatus[] }) {
  const entries = useAppStore((state) => state.subtrees);
  const remotes = useAppStore((state) => state.remotes);
  const load = useAppStore((state) => state.loadSubtrees);
  const loadRemotes = useAppStore((state) => state.loadRemotes);
  const operate = useAppStore((state) => state.subtreeOperation);
  const busy = useAppStore((state) => state.busy);
  const { t } = useI18n();

  useEffect(() => { for (const repo of repos) void load(repo.meta.id); }, [load, repos]);

  const register = async (repo: RepositoryStatus) => {
    const prefix = prompt(t('Subtree prefix'));
    if (!prefix?.trim()) return;
    if (!remotes[repo.meta.id]) await loadRemotes(repo.meta.id);
    const remoteNames = (useAppStore.getState().remotes[repo.meta.id] ?? []).map((remote) => remote.name);
    const remote = prompt(remoteNames.length ? `${t('Subtree remote')} (${remoteNames.join(', ')})` : t('Subtree remote'), remoteNames[0] ?? 'origin');
    if (!remote?.trim()) return;
    const branch = prompt(t('Subtree branch'), 'main');
    if (!branch?.trim()) return;
    const squash = confirm(t('Squash subtree history'));
    await operate(repo.meta.id, { type: 'add', prefix: prefix.trim(), remote: remote.trim(), branch: branch.trim(), squash });
  };

  const unregister = (repoId: string, entry: SubtreeEntry) => {
    if (confirm(t('Unregister subtree {0}? Files and history will not be removed.', entry.prefix))) {
      void operate(repoId, { type: 'remove', subtree_id: entry.id });
    }
  };

  return <div className="stash-panel subtree-panel"><div className="stash-list">
    {repos.map((repo) => {
      const repoEntries = entries[repo.meta.id] ?? [];
      return <section key={repo.meta.id} className="stash-repo subtree-repo">
        <header style={{ background: `color-mix(in srgb, ${repo.meta.color} 18%, var(--versiondock-surface))` }}>
          <i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><span className="panel-count">{repoEntries.length}</span>
          <button disabled={busy} onClick={() => void register(repo)} title={t('Register subtree')}><Codicon name="add" /></button>
          <Codicon name="list-unordered" className="subtree-list-glyph" />
        </header>
        {repoEntries.length === 0 ? <div className="stash-empty"><Codicon name="repo-clone" />{t('No registered subtrees')}</div> : repoEntries.map((rawEntry) => {
          const entry = rawEntry;
          const pending = entry.state === 'pending';
          return <article key={entry.id} className={`stash-row subtree-row${pending ? ' pending' : ''}`}>
            <Codicon name={pending ? 'warning' : 'repo-clone'} /><span><strong>{entry.prefix}{pending && <em>{t('Pending')}</em>}</strong><small>{entry.remote} · {entry.branch} · {entry.squash ? t('Squash') : t('Full history')}</small></span>
            {pending ? <>
              <button disabled={busy} className="danger" onClick={() => unregister(repo.meta.id, entry)}>{t('Unregister')}</button>
            </> : <>
              <button disabled={busy} onClick={() => void operate(repo.meta.id, { type: 'pull', subtree_id: entry.id })}>{t('Pull')}</button>
              <button disabled={busy} onClick={() => void operate(repo.meta.id, { type: 'push', subtree_id: entry.id })}>{t('Push')}</button>
              <button disabled={busy} className="danger" onClick={() => unregister(repo.meta.id, entry)}>{t('Unregister')}</button>
            </>}
          </article>;
        })}
      </section>;
    })}
  </div></div>;
}
