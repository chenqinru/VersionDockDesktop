import { useI18n } from '../i18n';

export function SpeedSearchIndicator({
  query,
  onClear,
  count,
  onPrev,
  onNext,
}: {
  query: string;
  onClear: () => void;
  count?: { current: number; total: number };
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const { t } = useI18n();
  if (!query) return null;
  return <div className="speed-search-indicator" role="search" aria-label={t('Speed Search')}>
    <span className="codicon codicon-search" />
    <span>{query}</span>
    {count !== undefined && <span className="speed-search-count">{count.total > 0 ? `${count.current}/${count.total}` : '0/0'}</span>}
    {onPrev && <button aria-label={t('Previous match')} title={t('Previous match')} onClick={onPrev}><span className="codicon codicon-arrow-up" /></button>}
    {onNext && <button aria-label={t('Next match')} title={t('Next match')} onClick={onNext}><span className="codicon codicon-arrow-down" /></button>}
    <button aria-label={t('Clear Speed Search')} title={t('Clear Speed Search')} onClick={onClear}><span className="codicon codicon-close" /></button>
  </div>;
}
