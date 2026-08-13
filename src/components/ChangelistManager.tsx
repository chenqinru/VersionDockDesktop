import { useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';

export function ChangelistManager({ repoId, close }: { repoId: string; close: () => void }) {
  const entries = useAppStore((state) => state.changelists[repoId] ?? []);
  const operate = useAppStore((state) => state.changelistOperation);
  const [name, setName] = useState('');
  const { t } = useI18n();
  const create = async () => { if (!name.trim()) return; await operate(repoId, { type: 'create', name: name.trim() }); setName(''); };
  return <div className="changelist-popover" onClick={(event) => event.stopPropagation()}>
    <header><strong>{t('Changelists')}</strong><button onClick={close}><Codicon name="close" /></button></header>
    <div className="changelist-create"><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create(); }} placeholder={t('Changelist name')} /><button disabled={!name.trim()} onClick={() => void create()}><Codicon name="add" /></button></div>
    {entries.map((entry) => <div className="changelist-manage-row" key={entry.id}><Codicon name="list-unordered" /><span><strong>{entry.name}</strong><small>{entry.files.length} {t('file')}</small></span><button title={t('Rename')} onClick={() => { const value = prompt(`${t('Changelist name')}:`, entry.name); if (value && value !== entry.name) void operate(repoId, { type: 'rename', changelist_id: entry.id, name: value }); }}><Codicon name="edit" /></button><button title={t('Delete')} onClick={() => { if (confirm(t('Delete changelist {0}?', entry.name))) void operate(repoId, { type: 'delete', changelist_id: entry.id }); }}><Codicon name="trash" /></button></div>)}
  </div>;
}
