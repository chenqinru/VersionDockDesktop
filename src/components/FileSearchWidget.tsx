import { IconButton } from './IconButton';
import { useI18n } from '../i18n';
import type { RefObject } from 'react';
import { Codicon } from './Codicon';

export function FileSearchWidget({ query, isOpen, inputRef, onChange, onClose, count, onNavigate, placeholder, variant = 'files' }: {
  query: string;
  isOpen: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onChange: (query: string) => void;
  onClose: () => void;
  count: { current: number; total: number };
  onNavigate: (direction: -1 | 1) => void;
  placeholder?: string;
  variant?: 'files' | 'speed';
}) {
  const { t } = useI18n();
  if (!isOpen) return null;
  return <div className={`detail-file-search ${variant === 'speed' ? 'file-speed-search' : ''}`} onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} role="search" aria-label={t('Speed Search')}>
    <div className="file-search-input">
    {variant === 'speed' && <Codicon name="search" />}
    <input spellCheck={false} autoComplete="off" ref={inputRef} aria-label={placeholder ?? t('Search files...')} placeholder={placeholder ?? t('Search files...')} value={query} onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.select();
      }
    }} onChange={(event) => onChange(event.target.value)} />
    {variant === 'speed' && query.trim() && <span className={`speed-search-count ${count.total === 0 ? 'no-matches' : ''}`}>{count.total ? `${count.current} / ${count.total}` : t('No matches')}</span>}
    </div>
    {variant === 'files' && <span className="speed-search-count">{count.current}/{count.total}</span>}
    <IconButton type="button" title={t('Previous match')} aria-label={t('Previous match')} disabled={count.total === 0} onClick={() => onNavigate(-1)}><Codicon name="arrow-up" /></IconButton>
    <IconButton type="button" title={t('Next match')} aria-label={t('Next match')} disabled={count.total === 0} onClick={() => onNavigate(1)}><Codicon name="arrow-down" /></IconButton>
    <IconButton type="button" title={t('Clear Speed Search')} aria-label={t('Clear Speed Search')} onClick={onClose}><Codicon name="close" /></IconButton>
  </div>;
}
