import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';

export function LoadingState({ children, compact = true, className = '', active = true, delayMs = 0, resetKey }: { children?: ReactNode; compact?: boolean; className?: string; active?: boolean; delayMs?: number; resetKey?: unknown }) {
  const { t } = useI18n();
  const request = useMemo(() => ({ active, delayMs, resetKey }), [active, delayMs, resetKey]);
  const [visibleRequest, setVisibleRequest] = useState<typeof request>();
  useEffect(() => {
    if (!active || delayMs <= 0) return;
    const timer = window.setTimeout(() => setVisibleRequest(request), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs, request]);
  if (!active || delayMs > 0 && visibleRequest !== request) return null;
  return <div className={`vd-loading-state ${className}`.trim()} data-compact={compact || undefined} role="status" aria-live="polite">
    <Codicon name="loading codicon-modifier-spin" /><span>{children ?? t('Loading…')}</span>
  </div>;
}
