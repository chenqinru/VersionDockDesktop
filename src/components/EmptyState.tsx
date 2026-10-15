import type { ReactNode } from 'react';
import { Codicon } from './Codicon';

export interface EmptyStateProps { children: ReactNode; icon?: string; description?: ReactNode; actions?: ReactNode; compact?: boolean; className?: string }
export function EmptyState({ children, icon, description, actions, compact = false, className = '' }: EmptyStateProps) {
  return <div className={`vd-empty-state ${className}`.trim()} data-compact={compact || undefined} role="status">
    {icon && <Codicon name={icon} />}<div className="vd-state-content"><div>{children}</div>{description && <small>{description}</small>}</div>{actions && <div className="vd-state-actions">{actions}</div>}
  </div>;
}
