import type { ReactNode } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';

export function LoadingState({ children, compact = true, className = '' }: { children?: ReactNode; compact?: boolean; className?: string }) {
  const { t } = useI18n();
  return <div className={`vd-loading-state ${className}`.trim()} data-compact={compact || undefined} role="status" aria-live="polite">
    <Codicon name="loading codicon-modifier-spin" /><span>{children ?? t('Loading…')}</span>
  </div>;
}
