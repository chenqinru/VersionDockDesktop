import { Codicon } from './Codicon';
import { useI18n } from '../i18n';

type DiffPlaceholderKind = 'binary' | 'truncated' | 'empty' | 'select';

const ICONS: Record<DiffPlaceholderKind, string> = {
  binary: 'file-binary',
  truncated: 'warning',
  empty: 'diff',
  select: 'diff-multiple',
};

export function DiffPlaceholder({ kind, path, lineCount }: { kind: DiffPlaceholderKind; path?: string; lineCount?: number }) {
  const { t } = useI18n();
  const message = kind === 'binary'
    ? t('Binary diff cannot be displayed')
    : kind === 'truncated'
      ? t('Diff is too large to display')
      : kind === 'select'
        ? t('Select a changed file to inspect its diff.')
        : t('No textual differences for this change.');

  return <div className={`diff-placeholder ${kind}`} role="status">
    <span className="diff-placeholder-icon"><Codicon name={ICONS[kind]} /></span>
    <strong>{message}</strong>
    {path && <code title={path}>{path}</code>}
    {lineCount !== undefined && lineCount > 0 && <small>{lineCount} {t('Lines')}</small>}
  </div>;
}
