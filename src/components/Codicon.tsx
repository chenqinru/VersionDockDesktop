import type { CSSProperties } from 'react';

interface Props { name: string; className?: string; style?: CSSProperties; title?: string }
export function Codicon({ name, className = '', style, title }: Props) {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} style={style} title={title} />;
}
