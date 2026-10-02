import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

// Keep the native button and caller layout; all icon action feedback lives in CSS.
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className = '', type = 'button', title, 'aria-label': label, ...props },
  ref,
) {
  return <button
    {...props}
    ref={ref}
    type={type}
    title={title}
    aria-label={label ?? title}
    className={`icon-button ${className}`.trim()}
    data-icon-button=""
  />;
});
