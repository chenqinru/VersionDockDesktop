import { forwardRef, type InputHTMLAttributes } from 'react';
import { useFieldAttributes } from './formFieldContext';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  controlSize?: 'xs' | 'sm' | 'md';
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { controlSize = 'sm', invalid, className = '', ...props }, ref,
) {
  const field = useFieldAttributes({ ...props, 'aria-invalid': invalid ?? props['aria-invalid'] });
  return <input {...props} {...field} ref={ref} className={`vd-input ${className}`.trim()} data-control-size={controlSize} />;
});
