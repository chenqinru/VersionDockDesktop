import { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { RepositoryStatus } from '../bindings/generated';

export function ShelfPanel({ repos, selectedPaths }: { repos: RepositoryStatus[]; selectedPaths: Map<string, string[]> }) {
  const shelves = useAppStore((state) => state.shelves);
  const loadShelves = useAppStore((state) => state.loadShelves);
  const shelfOperation = useAppStore((state) => state.shelfOperation);
  const busy = useAppStore((state) => state.busy);
  const [name, setName] = useState('');
  const { t } = useI18n();

  useEffect(() => { for (const repo of repos) void loadShelves(repo.meta.id); }, [loadShelves, repos]);

  const create = async (repo: RepositoryStatus) => {
    await shelfOperation(repo.meta.id, { type: 'create', name: name.trim() || t('WIP shelf'), paths: selectedPaths.get(repo.meta.id) ?? [] });
    setName('');
  };

  return <div className="stash-panel">
    <div className="stash-create"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('Shelf name')} /></div>
    <div className="stash-list">
      {repos.map((repo) => <section key={repo.meta.id} className="stash-repo">
        <header><i style={{ background: repo.meta.color }} /><strong>{repo.meta.name}</strong><button disabled={busy || !repo.files.length} onClick={() => void create(repo)}><Codicon name="archive" />{t('Shelve changes')}</button></header>
        {(shelves[repo.meta.id] ?? []).length === 0 ? <div className="stash-empty">{t('No shelves')}</div> : (shelves[repo.meta.id] ?? []).map((entry) => <article key={entry.id} className="stash-row">
          <Codicon name="archive" /><span><strong>{entry.name}</strong><small>{entry.files.length} {t('file')} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.createdAt))}</small></span>
          <button disabled={busy} onClick={() => void shelfOperation(repo.meta.id, { type: 'apply', shelf_id: entry.id })}>{t('Apply')}</button>
          <button disabled={busy} className="danger" onClick={() => { if (confirm(t('Drop shelf {0}?', entry.name))) void shelfOperation(repo.meta.id, { type: 'drop', shelf_id: entry.id }); }}>{t('Drop')}</button>
        </article>)}
      </section>)}
    </div>
  </div>;
}
