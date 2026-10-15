import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Codicon } from './Codicon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'link' | 'ai';
  size?: 'xs' | 'sm' | 'md';
  danger?: boolean;
  loading?: boolean;
}

/** Common action buttons; rows, tabs and custom status controls keep their own surfaces. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', danger = false, loading = false, disabled, type = 'button', className = '', children, ...props },
  ref,
) {
  return <button {...props} ref={ref} type={type} disabled={disabled || loading}
    className={`vd-button ${className}`.trim()} data-variant={variant} data-size={size}
    data-danger={danger || undefined} aria-busy={loading || props['aria-busy']}>
    {loading ? <>
      <span className="vd-button-loading-label">{children}</span>
      <Codicon name="loading codicon-modifier-spin" className="vd-button-loader" />
    </> : children}
  </button>;
});
