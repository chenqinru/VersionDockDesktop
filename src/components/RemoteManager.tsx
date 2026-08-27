import { useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { confirmDialog, promptDialog } from './dialogService';
import { ContextMenu } from './ContextMenu';
import type { RemoteInfo } from '../bindings/generated';

export function RemoteManager({ repoId, close }: { repoId: string; close: () => void }) {
  const values = useAppStore((state) => state.remotes[repoId] ?? []);
  const load = useAppStore((state) => state.loadRemotes);
  const operate = useAppStore((state) => state.remoteOperation);
  const busy = useAppStore((state) => state.busy);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [context, setContext] = useState<{ x: number; y: number; remote: RemoteInfo }>();
  const popover = useRef<HTMLElement>(null);
  const { t } = useI18n();
  useEffect(() => { void load(repoId); }, [load, repoId]);
  useEffect(() => {
    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && popover.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('pointerdown', handleOutsideInteraction, true);
    document.addEventListener('focusin', handleOutsideInteraction, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideInteraction, true);
      document.removeEventListener('focusin', handleOutsideInteraction, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [close]);
  const add = () => {
    if (!name.trim() || !url.trim()) return;
    void operate(repoId, { type: 'add', name: name.trim(), url: url.trim() });
    setName(''); setUrl('');
  };
  const runContext = async (id: string) => {
    const remote = context?.remote;
    if (!remote) return;
    if (id === 'copy-fetch') await navigator.clipboard?.writeText(remote.fetchUrl).catch(() => undefined);
    if (id === 'copy-push') await navigator.clipboard?.writeText(remote.pushUrl).catch(() => undefined);
    if (id === 'rename') { const next = await promptDialog({ title: t('Rename'), message: remote.name, inputLabel: t('Remote name'), initialValue: remote.name }); if (next && next !== remote.name) await operate(repoId, { type: 'rename', old_name: remote.name, new_name: next }); }
    if (id === 'fetch-url') { const next = await promptDialog({ title: t('Set fetch URL'), message: remote.name, inputLabel: t('Fetch URL'), initialValue: remote.fetchUrl }); if (next) await operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: false }); }
    if (id === 'push-url') { const next = await promptDialog({ title: t('Set push URL'), message: remote.name, inputLabel: t('Push URL'), initialValue: remote.pushUrl }); if (next) await operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: true }); }
    if (id === 'prune') await operate(repoId, { type: 'prune', name: remote.name });
    if (id === 'delete' && await confirmDialog({ title: t('Delete'), message: `${t('Remove remote {0}?', remote.name)}\n${remote.fetchUrl}`, danger: true })) await operate(repoId, { type: 'remove', name: remote.name });
    setContext(undefined);
  };
  return <section ref={popover} className="remote-popover" role="dialog" aria-label={t('Remotes')}>
    <header><Codicon name="remote" /><strong>{t('Remotes')}</strong><button title={t('Close')} onClick={close}><Codicon name="close" /></button></header>
    <div className="remote-add"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('Remote name')} /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t('Remote URL')} onKeyDown={(event) => { if (event.key === 'Enter') add(); }} /><button disabled={busy || !name.trim() || !url.trim()} onClick={add}><Codicon name="add" />{t('Add')}</button></div>
    <div className="remote-list">{values.length === 0 && <div className="compare-empty">{t('No remotes')}</div>}{values.map((remote) => <article key={remote.name} onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, remote }); }}>
      <Codicon name="cloud" /><span><strong>{remote.name}</strong><small title={remote.fetchUrl}>{t('Fetch URL')}: {remote.fetchUrl}</small><small title={remote.pushUrl}>{t('Push URL')}: {remote.pushUrl}</small></span>
      <button title={t('Rename')} onClick={() => void promptDialog({ title: t('Rename'), message: remote.name, inputLabel: t('Remote name'), initialValue: remote.name }).then((next) => { if (next && next !== remote.name) return operate(repoId, { type: 'rename', old_name: remote.name, new_name: next }); })}><Codicon name="edit" /></button>
      <button title={t('Set fetch URL')} onClick={() => void promptDialog({ title: t('Set fetch URL'), message: remote.name, inputLabel: t('Fetch URL'), initialValue: remote.fetchUrl }).then((next) => { if (next) return operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: false }); })}><Codicon name="link" /></button>
      <button title={t('Set push URL')} onClick={() => void promptDialog({ title: t('Set push URL'), message: remote.name, inputLabel: t('Push URL'), initialValue: remote.pushUrl }).then((next) => { if (next) return operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: true }); })}><Codicon name="cloud-upload" /></button>
      <button title={t('Prune')} onClick={() => void operate(repoId, { type: 'prune', name: remote.name })}><Codicon name="refresh" /></button>
      <button className="danger" title={t('Delete')} onClick={() => void confirmDialog({ title: t('Delete'), message: `${t('Remove remote {0}?', remote.name)}\n${remote.fetchUrl}`, danger: true }).then((confirmed) => { if (confirmed) return operate(repoId, { type: 'remove', name: remote.name }); })}><Codicon name="trash" /></button>
    </article>)}</div>
    {context && <ContextMenu x={context.x} y={context.y} items={[{ id: 'rename', label: t('Rename'), icon: 'edit' }, { id: 'fetch-url', label: t('Set fetch URL'), icon: 'link' }, { id: 'push-url', label: t('Set push URL'), icon: 'cloud-upload' }, { id: 'copy-fetch', label: t('Copy Fetch URL'), icon: 'copy' }, { id: 'copy-push', label: t('Copy Push URL'), icon: 'copy' }, { separator: true }, { id: 'prune', label: t('Prune'), icon: 'refresh' }, { id: 'delete', label: t('Delete'), icon: 'trash', danger: true }]} onSelect={(id) => void runContext(id)} onClose={() => setContext(undefined)} />}
  </section>;
}
