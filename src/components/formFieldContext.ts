import { createContext, useContext } from 'react';

export interface FieldAttributes {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  required?: boolean;
}

export const FormFieldContext = createContext<FieldAttributes>({});

export function useFieldAttributes(props: FieldAttributes): FieldAttributes {
  const field = useContext(FormFieldContext);
  return {
    id: props.id ?? field.id,
    'aria-describedby': [...new Set(`${props['aria-describedby'] ?? ''} ${field['aria-describedby'] ?? ''}`.trim().split(/\s+/).filter(Boolean))].join(' ') || undefined,
    'aria-invalid': props['aria-invalid'] ?? field['aria-invalid'],
    required: props.required ?? field.required,
  };
}
