import { useI18n } from '../i18n';

export function SpeedSearchIndicator({ query, onClear }: { query: string; onClear: () => void }) {
  const { t } = useI18n();
  if (!query) return null;
  return <div className="speed-search-indicator" role="search" aria-label={t('Speed Search')}>
    <span className="codicon codicon-search" />
    <span>{query}</span>
    <button aria-label={t('Clear Speed Search')} onClick={onClear}><span className="codicon codicon-close" /></button>
  </div>;
}
