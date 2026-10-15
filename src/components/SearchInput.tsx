import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { Input, type InputProps } from './Input';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useFieldAttributes } from './formFieldContext';

export interface SearchInputProps extends InputProps {
  containerClassName?: string;
  onClear?: () => void;
  clearLabel?: string;
  showIcon?: boolean;
  trailing?: ReactNode;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { containerClassName = '', onClear, clearLabel, showIcon = true, trailing, controlSize = 'sm', ...props }, ref,
) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const field = useFieldAttributes({ ...props, 'aria-invalid': props.invalid ?? props['aria-invalid'] });
  useImperativeHandle(ref, () => input.current!, []);
  return <div className={`vd-search-input ${containerClassName}`.trim()} data-control-size={controlSize} data-disabled={props.disabled || undefined} data-readonly={props.readOnly || undefined} data-invalid={field['aria-invalid']}>
    {showIcon && <Codicon name="search" />}
    <Input {...props} controlSize={controlSize} ref={input} data-embedded="" />
    {trailing}
    {onClear && !props.readOnly && String(props.value ?? '').length > 0 && <IconButton title={clearLabel ?? t('Clear search')} disabled={props.disabled} onMouseDown={event => event.preventDefault()} onClick={() => { onClear(); input.current?.focus(); }}><Codicon name="close" /></IconButton>}
  </div>;
});
