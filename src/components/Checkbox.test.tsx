import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';
import { Switch } from './Switch';
import { SelectionCheckbox } from './SelectionCheckbox';

afterEach(cleanup);

it('forwards the native checkbox ref, indeterminate state and input events', () => {
  const ref = createRef<HTMLInputElement>();
  const change = vi.fn();
  const { rerender } = render(<label>Files<Checkbox ref={ref} indeterminate checked={false} onChange={change} /></label>);
  const input = screen.getByRole('checkbox', { name: 'Files' });
  expect(input).toBe(ref.current);
  expect(input).toBePartiallyChecked();
  fireEvent.click(input);
  expect(change).toHaveBeenCalledOnce();
  rerender(<label>Files<Checkbox ref={ref} indeterminate={false} checked onChange={change} /></label>);
  expect(input).not.toBePartiallyChecked();
  expect(input).toBeChecked();
});

it('preserves label activation, uncontrolled form values and fieldset disabled behavior', () => {
  const change = vi.fn();
  render(<form aria-label="Settings"><label>Enable<Switch name="enabled" defaultChecked onChange={change} /></label><fieldset disabled><Checkbox aria-label="Locked checkbox" /><Switch aria-label="Locked switch" /></fieldset></form>);
  const input = screen.getByRole('checkbox', { name: 'Enable' });
  expect(input).toBeChecked();
  fireEvent.click(input);
  expect(input).not.toBeChecked();
  expect(change).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Locked checkbox')).toBeDisabled();
  expect(screen.getByLabelText('Locked switch')).toBeDisabled();
});

it('keeps repository selection clicks from activating the containing row', () => {
  const row = vi.fn(), change = vi.fn();
  render(<div onClick={row}><SelectionCheckbox label="Include file" checked={false} onChange={change} /></div>);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include file' }));
  expect(change).toHaveBeenCalledOnce();
  expect(row).not.toHaveBeenCalled();
});
