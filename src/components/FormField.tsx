import { useId, type ReactNode } from 'react';
import { FormFieldContext } from './formFieldContext';

interface FormFieldProps {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** The field owns the control id; children retain their native input behavior. */
export function FormField({ id, label, description, error, required, className = '', children }: FormFieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = description ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  return <div className={`vd-form-field ${className}`.trim()}>
    <label htmlFor={controlId} className="vd-field-label">{label}{required && <span aria-hidden="true" className="vd-field-required">*</span>}</label>
    <FormFieldContext.Provider value={{ id: controlId, 'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined, 'aria-invalid': error ? true : undefined, required }}>
      <div className="vd-field-control">{children}</div>
    </FormFieldContext.Provider>
    {description && <small id={hintId} className="vd-field-description">{description}</small>}
    {error && <small id={errorId} className="vd-field-error" role="alert">{error}</small>}
  </div>;
}
