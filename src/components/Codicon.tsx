import type { CSSProperties } from 'react';

interface Props { name: string; className?: string; style?: CSSProperties }
export function Codicon({ name, className = '', style }: Props) {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} style={style} />;
}
