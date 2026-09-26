import { Codicon } from './Codicon';
import { useI18n } from '../i18n';

type DiffPlaceholderKind = 'binary' | 'truncated' | 'empty' | 'select' | 'loading' | 'error';

const ICONS: Record<DiffPlaceholderKind, string> = {
  binary: 'file-binary',
  truncated: 'warning',
  empty: 'diff',
  select: 'diff-multiple',
  loading: 'loading',
  error: 'error',
};

export function DiffPlaceholder({
  kind,
  path,
  lineCount,
  error,
  onRetry,
}: {
  kind: DiffPlaceholderKind;
  path?: string;
  lineCount?: number;
  error?: string;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const message = kind === 'binary'
    ? t('Binary diff cannot be displayed')
    : kind === 'truncated'
      ? t('Diff is too large to display')
      : kind === 'select'
        ? t('Select a changed file to inspect its diff.')
        : kind === 'loading'
          ? t('Loading diff...')
          : kind === 'error'
            ? (error || t('Failed to load diff'))
            : t('No textual differences for this change.');

  return <div className={`diff-placeholder ${kind}`} role="status">
    <span className={`diff-placeholder-icon ${kind === 'loading' ? 'codicon-modifier-spin' : ''}`}><Codicon name={ICONS[kind]} /></span>
    <strong>{message}</strong>
    {path && <code title={path}>{path}</code>}
    {lineCount !== undefined && lineCount > 0 && <small>{lineCount} {t('Lines')}</small>}
    {kind === 'error' && onRetry && (
      <button type="button" className="detail-retry-button" onClick={onRetry}>
        <Codicon name="refresh" />
        <span>{t('Retry')}</span>
      </button>
    )}
  </div>;
}
