import { useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { IconButton } from './IconButton';
import { SearchInput } from './SearchInput';
import { Checkbox } from './Checkbox';
import { Codicon } from './Codicon';
import { ContextMenu } from './ContextMenu';

interface Props {
  count: string;
  query: string;
  onQueryChange: (query: string) => void;
  repository: string;
  repositories: { value: string; label: string }[];
  onRepositoryChange: (repository: string) => void;
  onlyChanges: boolean;
  onOnlyChangesChange: (value: boolean) => void;
  disabled: boolean;
}

export function CheckpointHistoryToolbar({ count, query, onQueryChange, repository, repositories, onRepositoryChange, onlyChanges, onOnlyChangesChange, disabled }: Props) {
  const { t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect>();
  const input = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const expanded = searchOpen || Boolean(query);
  const selectedRepository = repositories.find(item => item.value === repository)?.label;
  return <div className="detail-files-title checkpoint-history-heading checkpoint-history-toolbar" data-search-expanded={expanded || undefined}>
    <h4>{t('Checkpoint history')}</h4><span>{count}</span>
    <div className="checkpoint-history-controls">
      {expanded && <div className="checkpoint-history-query" role="search" aria-label={t('Search checkpoints')}><SearchInput ref={input} id={inputId} autoFocus showIcon={false} controlSize="xs" aria-label={t('Search checkpoints')} placeholder={t('Search names and messages')} value={query}
        onChange={event => onQueryChange(event.target.value)} onClear={() => { setSearchOpen(true); onQueryChange(''); }}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
          event.preventDefault(); event.stopPropagation();
          if (query) { onQueryChange(''); setSearchOpen(true); }
          else { setSearchOpen(false); searchButton.current?.focus({ preventScroll: true }); }
        }} /></div>}
      <IconButton ref={searchButton} title={t('Search checkpoints')} aria-expanded={expanded} aria-controls={expanded ? inputId : undefined} onClick={() => {
        if (query) input.current?.focus({ preventScroll: true });
        else setSearchOpen(value => !value);
      }}><Codicon name="search" /></IconButton>
      <IconButton className="checkpoint-history-repository" aria-label={t('Filter checkpoint repository')} title={selectedRepository ? t('Filtered repository: {0}', selectedRepository) : t('All repositories')}
        aria-pressed={Boolean(repository)} aria-haspopup="menu" aria-expanded={Boolean(anchor)} disabled={disabled} onClick={event => setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect())}><Codicon name="filter" /></IconButton>
      <label className="checkpoint-history-filter"><Checkbox checked={onlyChanges} onChange={event => onOnlyChangesChange(event.target.checked)} />{t('Only with changes')}</label>
    </div>
    {anchor && !disabled && <ContextMenu x={anchor.right} y={anchor.bottom} anchorRect={anchor} header={t('Filter checkpoint repository')}
      items={[{ id: '', label: t('All repositories'), icon: repository ? 'repo' : 'check' }, ...repositories.map(item => ({ id: item.value, label: item.label, icon: item.value === repository ? 'check' : 'repo' }))]}
      onSelect={value => { setAnchor(undefined); onRepositoryChange(value); }} onClose={() => setAnchor(undefined)} />}
  </div>;
}
