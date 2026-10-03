import type { ButtonHTMLAttributes } from 'react';
import { Codicon } from './Codicon';
import { IconButton } from './IconButton';

// A split action shares its surface and state with the main button.
export function SplitButtonMore({ className = '', title, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <IconButton {...props} className={`split-button-more ${className}`.trim()} title={title} aria-label={props['aria-label'] ?? title} aria-haspopup="menu">
      <Codicon name="chevron-down" />
    </IconButton>
  );
}
