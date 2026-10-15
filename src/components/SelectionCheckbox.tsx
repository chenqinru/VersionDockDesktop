import { Checkbox } from './Checkbox';

/** Repository/file selection keeps click isolation; Checkbox owns visuals and native semantics. */
export function SelectionCheckbox({ label, checked, indeterminate = false, disabled = false, onChange }: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return <Checkbox containerClassName="selection-checkbox" aria-label={label} checked={checked} indeterminate={indeterminate} disabled={disabled} onChange={onChange} stopClickPropagation />;
}
