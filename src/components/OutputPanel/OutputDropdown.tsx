import { Select } from '../Select';
import { useI18n } from '../../i18n';

export function OutputDropdown<T extends string>({ value, options, onChange, ariaLabel, className = '' }: {
  value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void; ariaLabel: string; className?: string;
}) {
  const { t } = useI18n();
  return <Select containerClassName={`output-dropdown-container ${className}`.trim()} controlSize="xs"
    value={value} options={options.map(option => ({ value: option.id, label: t(option.label) }))}
    aria-label={ariaLabel} onChange={next => { const option = options.find(option => option.id === next); if (option) onChange(option.id); }} />;
}
