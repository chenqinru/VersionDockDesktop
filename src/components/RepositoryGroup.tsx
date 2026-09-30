import { useState, type CSSProperties, type ReactNode } from 'react';
import { Codicon } from './Codicon';

export function RepositoryGroup({ name, color, extras, actions, children, onToggle, expansion }: {
  name: string;
  color: string;
  extras?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  onToggle?: () => void;
  expansion?: { sequence: number; expanded: boolean };
}) {
  const [localExpansion, setLocalExpansion] = useState({ sequence: expansion?.sequence ?? 0, expanded: true });
  const expanded = !expansion || localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  const toggle = () => {
    setLocalExpansion({ sequence: expansion?.sequence ?? 0, expanded: !expanded });
    onToggle?.();
  };
  return <>
    <div className="repository-group-header" style={{ '--repo-color': color } as CSSProperties} onClick={(event) => {
      if (!(event.target as HTMLElement).closest('button, input, label, a')) toggle();
    }}>
      <button type="button" className="repository-group-main" title={name} aria-expanded={expanded} onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}>
        <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
        <i style={{ background: color }} />
        <strong>{name}</strong>
      </button>
      {extras}
      {actions && <div className="repository-group-actions">{actions}</div>}
    </div>
    <div hidden={!expanded} style={expanded ? undefined : { display: 'none' }}>{children}</div>
  </>;
}
