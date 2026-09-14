import { useEffect, useRef } from 'react';
import { Codicon } from './Codicon';

export function SelectionCheckbox({ label, checked, indeterminate = false, disabled = false, onChange }: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <span className={`selection-checkbox ${checked || indeterminate ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}>
    <input ref={ref} aria-label={label} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} onClick={(event) => event.stopPropagation()} />
    {(checked || indeterminate) && <Codicon name={indeterminate ? 'remove' : 'check'} />}
  </span>;
}
