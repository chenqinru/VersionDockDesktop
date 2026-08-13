import { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { RepositoryStatus } from '../bindings/generated';

export function StashPanel({ repos, selectedPaths }: { repos: RepositoryStatus[]; selectedPaths: Map<string, string[]> }) {
  const stashes = useAppStore((state) => state.stashes);
  const loadStashes = useAppStore((state) => state.loadStashes);
  const stashOperation = useAppStore((state) => state.stashOperation);
  const busy = useAppStore((state) => state.busy);
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const { t } = useI18n();

  useEffect(() => { for (const repo of repos) void loadStashes(repo.meta.id); }, [loadStashes, repos]);

  const create = async (repo: RepositoryStatus) => {
    const message = prompt(t('Stash message'), t('WIP stash'));
    if (message === null) return;
    await stashOperation(repo.meta.id, { type: 'create', message: message.trim() || t('WIP stash'), paths: selectedPaths.get(repo.meta.id) ?? [], include_untracked: includeUntracked });
  };

  return <div className="stash-panel"><div className="stash-list">
      {repos.map((repo) => <section key={repo.meta.id} className="stash-repo">
        <header style={{ background: `color-mix(in srgb, ${repo.meta.color} 18%, var(--versiondock-surface))` }}><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><label className="header-check" title={t('Include untracked files')}><input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} /></label><span className="panel-count">{(stashes[repo.meta.id] ?? []).length}</span><button disabled={busy || !repo.files.length} onClick={() => void create(repo)} title={t('Stash changes')}><Codicon name="add" /></button></header>
        {(stashes[repo.meta.id] ?? []).length === 0 ? <div className="stash-empty"><Codicon name="archive" />{t('No stashes')}</div> : (stashes[repo.meta.id] ?? []).map((entry) => <article key={entry.reference} className="stash-row">
          <Codicon name="archive" /><span><strong>{entry.message}</strong><small>{entry.reference}{entry.branch ? ` · ${entry.branch}` : ''}</small></span>
          <button disabled={busy} onClick={() => void stashOperation(repo.meta.id, { type: 'apply', reference: entry.reference })}>{t('Apply')}</button>
          <button disabled={busy} onClick={() => void stashOperation(repo.meta.id, { type: 'pop', reference: entry.reference })}>{t('Pop')}</button>
          <button disabled={busy} className="danger" onClick={() => { if (confirm(t('Drop stash {0}?', entry.reference))) void stashOperation(repo.meta.id, { type: 'drop', reference: entry.reference }); }}>{t('Drop')}</button>
        </article>)}
      </section>)}
    </div></div>;
}
