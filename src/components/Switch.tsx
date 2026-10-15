import { forwardRef, type InputHTMLAttributes } from 'react';
import { useFieldAttributes } from './formFieldContext';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  controlSize?: 'sm' | 'md';
  containerClassName?: string;
}

/** Native checkbox semantics retain label activation, form behavior and fieldset disabling. */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { controlSize = 'md', containerClassName = '', ...props }, ref,
) {
  const field = useFieldAttributes(props);
  return <span className={`vd-switch ${containerClassName}`.trim()} data-control-size={controlSize}>
    <input {...props} {...field} ref={ref} type="checkbox" />
    <span className="vd-switch-track" aria-hidden="true"><span className="vd-switch-thumb" /></span>
  </span>;
});
