import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type InputHTMLAttributes } from 'react';
import { Codicon } from './Codicon';
import { useFieldAttributes } from './formFieldContext';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  indeterminate?: boolean;
  containerClassName?: string;
  stopClickPropagation?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { indeterminate = false, containerClassName = '', className = '', stopClickPropagation = false, onClick, ...props }, ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const field = useFieldAttributes(props);
  useImperativeHandle(ref, () => input.current!, []);
  useLayoutEffect(() => { if (input.current) input.current.indeterminate = indeterminate; });
  return <span className={`vd-checkbox ${containerClassName}`.trim()}>
    <input {...props} {...field} type="checkbox" ref={input} className={className || undefined} onClick={event => { if (stopClickPropagation) event.stopPropagation(); onClick?.(event); }} />
    <span className="vd-checkbox-indicator" aria-hidden="true"><Codicon name={indeterminate ? 'remove' : 'check'} /></span>
  </span>;
});
