import { useI18n } from '../../i18n';

export function TaskProgressBar({ completed, total, active }: { completed: number | null; total: number | null; active: boolean }) {
  const { t } = useI18n();
  const known = total !== null && total > 0;
  const value = known ? Math.max(0, Math.min(total, completed ?? 0)) : undefined;
  return <span className={`task-progress-track${known ? ' determinate' : active ? ' indeterminate' : ''}`} role="progressbar"
    aria-label={t('Task progress')} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? total : undefined}
    aria-valuenow={value} aria-valuetext={!known ? t(active ? 'Processing' : 'Finished') : undefined}>
    <span className="task-progress-fill" style={known ? { width: `${value! / total * 100}%` } : undefined} />
    {!known && active && <span className="task-progress-static" aria-hidden="true">{t('Processing')}</span>}
  </span>;
}
