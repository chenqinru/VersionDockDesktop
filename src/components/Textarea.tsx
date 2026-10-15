import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { useFieldAttributes } from './formFieldContext';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  controlSize?: 'xs' | 'sm' | 'md';
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { controlSize = 'sm', invalid, className = '', ...props }, ref,
) {
  const field = useFieldAttributes({ ...props, 'aria-invalid': invalid ?? props['aria-invalid'] });
  return <textarea {...props} {...field} ref={ref} className={`vd-input vd-textarea ${className}`.trim()} data-control-size={controlSize} />;
});
