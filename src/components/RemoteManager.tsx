import { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';

export function RemoteManager({ repoId, close }: { repoId: string; close: () => void }) {
  const values = useAppStore((state) => state.remotes[repoId] ?? []);
  const load = useAppStore((state) => state.loadRemotes);
  const operate = useAppStore((state) => state.remoteOperation);
  const busy = useAppStore((state) => state.busy);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const { t } = useI18n();
  useEffect(() => { void load(repoId); }, [load, repoId]);
  const add = () => {
    if (!name.trim() || !url.trim()) return;
    void operate(repoId, { type: 'add', name: name.trim(), url: url.trim() });
    setName(''); setUrl('');
  };
  return <section className="remote-popover" role="dialog" aria-label={t('Remotes')}>
    <header><Codicon name="remote" /><strong>{t('Remotes')}</strong><button title={t('Close')} onClick={close}><Codicon name="close" /></button></header>
    <div className="remote-add"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('Remote name')} /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t('Remote URL')} onKeyDown={(event) => { if (event.key === 'Enter') add(); }} /><button disabled={busy || !name.trim() || !url.trim()} onClick={add}><Codicon name="add" />{t('Add')}</button></div>
    <div className="remote-list">{values.length === 0 && <div className="compare-empty">{t('No remotes')}</div>}{values.map((remote) => <article key={remote.name}>
      <Codicon name="cloud" /><span><strong>{remote.name}</strong><small title={remote.fetchUrl}>{t('Fetch URL')}: {remote.fetchUrl}</small><small title={remote.pushUrl}>{t('Push URL')}: {remote.pushUrl}</small></span>
      <button title={t('Rename')} onClick={() => { const next = prompt(`${t('Remote name')}:`, remote.name); if (next && next !== remote.name) void operate(repoId, { type: 'rename', old_name: remote.name, new_name: next }); }}><Codicon name="edit" /></button>
      <button title={t('Set fetch URL')} onClick={() => { const next = prompt(`${t('Fetch URL')}:`); if (next) void operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: false }); }}><Codicon name="link" /></button>
      <button title={t('Set push URL')} onClick={() => { const next = prompt(`${t('Push URL')}:`); if (next) void operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: true }); }}><Codicon name="cloud-upload" /></button>
      <button title={t('Prune')} onClick={() => void operate(repoId, { type: 'prune', name: remote.name })}><Codicon name="refresh" /></button>
      <button className="danger" title={t('Delete')} onClick={() => { if (confirm(t('Remove remote {0}?', remote.name))) void operate(repoId, { type: 'remove', name: remote.name }); }}><Codicon name="trash" /></button>
    </article>)}</div>
  </section>;
}
