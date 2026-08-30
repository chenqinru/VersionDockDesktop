import { useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { confirmDialog, promptDialog } from './dialogService';
import { ContextMenu } from './ContextMenu';
import type { ChangelistEntry } from '../bindings/generated';

export function ChangelistManager({ repoId, close }: { repoId: string; close: () => void }) {
  const entries = useAppStore((state) => state.changelists[repoId] ?? []);
  const operate = useAppStore((state) => state.changelistOperation);
  const [name, setName] = useState('');
  const [context, setContext] = useState<{ x: number; y: number; entry: ChangelistEntry }>();
  const popover = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
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
  const create = async () => { if (!name.trim()) return; await operate(repoId, { type: 'create', name: name.trim() }); setName(''); };
  return <div ref={popover} className="changelist-popover" onClick={(event) => event.stopPropagation()}>
    <header><strong>{t('Changelists')}</strong><button onClick={close}><Codicon name="close" /></button></header>
    <div className="changelist-create"><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create(); }} placeholder={t('Changelist name')} /><button disabled={!name.trim()} onClick={() => void create()}><Codicon name="add" /></button></div>
    {entries.map((entry) => (
      <div className="changelist-manage-row" key={entry.id} onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, entry }); }}>
        <Codicon name="list-unordered" />
        <span>
          <strong>{entry.name}</strong>
          <small style={{ marginLeft: 6 }}>{entry.files.length} {t('file')}</small>
        </span>
        <button title={t('Rename')} onClick={() => void promptDialog({ title: t('Rename'), message: entry.name, inputLabel: t('Changelist name'), initialValue: entry.name }).then((value) => { if (value && value !== entry.name) return operate(repoId, { type: 'rename', changelist_id: entry.id, name: value }); })}>
          <Codicon name="edit" />
        </button>
        <button title={t('Delete')} onClick={() => void confirmDialog({ title: t('Delete'), message: `${t('Delete changelist {0}?', entry.name)}\n${entry.files.length} ${t('file')}`, danger: true }).then((confirmed) => { if (confirmed) return operate(repoId, { type: 'delete', changelist_id: entry.id }); })}>
          <Codicon name="trash" />
        </button>
      </div>
    ))}
    {context && (
      <ContextMenu
        x={context.x}
        y={context.y}
        items={[
          { id: 'rename', label: t('Rename'), icon: 'edit' },
          { id: 'delete', label: t('Delete'), icon: 'trash', danger: true },
        ]}
        onSelect={(id) => {
          const entry = context.entry;
          if (id === 'rename') {
            void promptDialog({ title: t('Rename'), message: entry.name, inputLabel: t('Changelist name'), initialValue: entry.name }).then((value) => {
              if (value && value !== entry.name) return operate(repoId, { type: 'rename', changelist_id: entry.id, name: value });
            });
          } else {
            void confirmDialog({ title: t('Delete'), message: `${t('Delete changelist {0}?', entry.name)}\n${entry.files.length} ${t('file')}`, danger: true }).then((confirmed) => {
              if (confirmed) return operate(repoId, { type: 'delete', changelist_id: entry.id });
            });
          }
          setContext(undefined);
        }}
        onClose={() => setContext(undefined)}
      />
    )}
  </div>;
}
