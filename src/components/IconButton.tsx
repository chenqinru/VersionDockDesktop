import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'bare' };

// Keep caller layout and colors; CSS owns shared interaction feedback.
// CSS callers can set --versiondock-icon-foreground; inline colors use it too.
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className = '', type = 'button', title, 'aria-label': label, style, variant = 'default', ...props },
  ref,
) {
  return <button
    {...props}
    ref={ref}
    type={type}
    title={title}
    aria-label={label ?? title}
    style={style?.color ? {
      ...style,
      '--versiondock-icon-foreground': style.color === 'inherit' || style.color === 'unset' ? 'currentColor' : style.color,
    } as CSSProperties : style}
    className={`icon-button ${className}`.trim()}
    data-icon-button=""
    data-icon-variant={variant}
  />;
});
