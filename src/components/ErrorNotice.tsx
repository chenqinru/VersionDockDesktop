import type { ReactNode, MouseEventHandler } from 'react';
import { Button } from './Button';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';

export function ErrorNotice({ children, onRetry, retrying = false, actions, className = '' }: { children: ReactNode; onRetry?: MouseEventHandler<HTMLButtonElement>; retrying?: boolean; actions?: ReactNode; className?: string }) {
  const { t } = useI18n();
  return <div className={`vd-error-notice ${className}`.trim()} role="alert">
    <Codicon name="error" /><div className="vd-state-content">{children}</div>
    {(onRetry || actions) && <div className="vd-state-actions">{onRetry && <Button size="xs" variant="ghost" loading={retrying} onClick={onRetry}>{t('Retry')}</Button>}{actions}</div>}
  </div>;
}
