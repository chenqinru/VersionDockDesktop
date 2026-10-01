import type { CSSProperties } from 'react';
import { Codicon } from './Codicon';
import { branchColor, headColor, tagColor } from './branchColor';

export type BranchRefKind = 'branch' | 'remote' | 'tag' | 'head' | 'revision' | 'worktree';

export function BranchRefBadge({
  label,
  kind = 'branch',
  color,
  variant = 'branch',
  selected = false,
  icons,
  className,
  title,
  style,
}: {
  label: string;
  kind?: BranchRefKind;
  color?: string;
  variant?: 'branch' | 'ref';
  selected?: boolean;
  icons?: string[];
  className?: string;
  title?: string;
  style?: CSSProperties;
}) {
  const resolvedColor = color ?? (kind === 'tag' ? tagColor() : kind === 'head' || (kind === 'revision' && label === 'HEAD') ? headColor() : branchColor(label));
  const resolvedIcons = icons ?? [kind === 'tag' ? 'tag' : kind === 'remote' ? 'cloud' : kind === 'head' ? 'git-commit' : kind === 'revision' ? 'versions' : kind === 'worktree' ? 'repo-clone' : 'git-branch'];
  const compact = variant === 'ref';
  const Element = compact ? 'em' : 'span';
  return <Element
    className={className}
    data-ref-badge={kind}
    title={title ?? label}
    style={{
      minWidth: 0,
      maxWidth: 160,
      height: compact ? 16 : undefined,
      flexShrink: compact ? 0 : 1,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      overflow: 'hidden',
      padding: compact ? '0 6px' : '1px 5px',
      color: selected ? 'var(--versiondock-selection-foreground)' : resolvedColor,
      background: selected ? 'var(--versiondock-selection-background)' : `${resolvedColor}33`,
      border: `1px solid ${selected ? 'var(--versiondock-selection-border)' : `${resolvedColor}88`}`,
      borderRadius: 3,
      boxSizing: 'border-box',
      fontSize: 10,
      fontStyle: 'normal',
      fontWeight: kind === 'head' ? 700 : compact ? 500 : 600,
      lineHeight: compact ? '16px' : undefined,
      whiteSpace: 'nowrap',
      ['--ref-color' as any]: resolvedColor,
      ...style,
    }}
  >
    {resolvedIcons.map((icon, index) => <Codicon key={`${icon}:${index}`} name={icon} style={{ flex: '0 0 auto', fontSize: 10 }} />)}
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
  </Element>;
}
