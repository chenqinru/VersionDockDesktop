import type { ReactNode } from 'react';
import { Codicon } from './Codicon';

export function WorkspaceHeader({
  children,
  actions,
  backLabel,
  onBack,
  backDisabled = false,
  className = '',
}: {
  children: ReactNode;
  actions?: ReactNode;
  backLabel: string;
  onBack: () => void;
  backDisabled?: boolean;
  className?: string;
}) {
  return (
    <header className={`workspace-page-header ${className}`}>
      <button type="button" className="workspace-back-button" disabled={backDisabled} onClick={onBack}>
        <Codicon name="arrow-left" /><span>{backLabel}</span>
      </button>
      {children}
      {actions}
    </header>
  );
}
