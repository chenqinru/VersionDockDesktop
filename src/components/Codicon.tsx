import type { CSSProperties } from 'react';

interface Props { name: string; className?: string; style?: CSSProperties; title?: string }
export function Codicon({ name, className = '', style, title }: Props) {
  if (name === 'checkpoint') return <svg aria-hidden="true" focusable="false" className={`codicon codicon-checkpoint ${className}`} style={style} viewBox="0 0 16 16" width="1em" height="1em" fill="none">
    {title && <title>{title}</title>}
    <circle cx="8" cy="8" r="6.8" stroke="currentColor" strokeWidth="1.1" />
    <path d="M5.2 3.6 7.4 12.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    <path d="M6.3 3.9c1.8-.2 3.2 1 5.3.1l-1 1.9 1.3 1.5c-2.1 1-3.4-.2-4.7 0Z" fill="currentColor" />
  </svg>;
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} style={style} title={title} />;
}
