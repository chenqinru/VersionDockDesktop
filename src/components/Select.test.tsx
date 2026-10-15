import { createRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from './Select';
import { FormField } from './FormField';
import { DialogSurface } from './DialogSurface';

const options: SelectOption[] = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', disabled: true }, { value: 'c', label: 'Charlie' }];
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Select keyboard and selection behavior', () => {
  it('selects enabled options, restores focus and exposes one accessible control', () => {
    const ref = createRef<HTMLButtonElement>();
    function Example() { const [value, setValue] = useState('a'); return <FormField label="Choice" description="Choose an item"><Select ref={ref} value={value} options={options} onChange={setValue} /></FormField>; }
    render(<Example />);
    const control = screen.getByRole('combobox', { name: 'Choice' });
    expect(control).toBe(ref.current);
    expect(control).toHaveAccessibleDescription('Choose an item');
    fireEvent.click(control);
    expect(screen.getByRole('option', { name: 'Beta' })).toBeDisabled();
    fireEvent.click(screen.getByRole('option', { name: 'Charlie' }));
    expect(control).toHaveValue('c');
    expect(control).toHaveTextContent('Charlie');
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('skips disabled options, supports Home/End/typeahead and cancels without changing selection', () => {
    const change = vi.fn();
    render(<Select aria-label="Choice" value="a" options={options} onChange={change} />);
    const control = screen.getByRole('combobox');
    fireEvent.keyDown(control, { key: 'ArrowDown' });
    const alpha = screen.getByRole('option', { name: 'Alpha' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    const charlie = screen.getByRole('option', { name: 'Charlie' });
    expect(charlie).toHaveFocus();
    fireEvent.keyDown(charlie, { key: 'Home' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(charlie).toHaveFocus();
    fireEvent.keyDown(charlie, { key: 'a' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'Escape' });
    expect(control).toHaveFocus();
    expect(change).not.toHaveBeenCalled();
  });

  it('handles empty, missing and changing options without choosing a different value', () => {
    const change = vi.fn();
    const { rerender } = render(<Select aria-label="Choice" value="missing" options={options} onChange={change} />);
    const control = screen.getByRole('combobox');
    expect(control).toHaveTextContent('missing');
    fireEvent.click(control);
    rerender(<Select aria-label="Choice" value="missing" options={[]} onChange={change} />);
    expect(control).toBeDisabled();
    expect(screen.queryByRole('listbox')).toBeNull();
    rerender(<Select aria-label="Choice" value="missing" options={options} onChange={change} />);
    expect(control).toHaveAttribute('aria-expanded', 'false');
    expect(change).not.toHaveBeenCalled();
  });

  it('inherits fieldset disabling and closes on outside interaction without stealing focus', () => {
    const change = vi.fn();
    const { rerender } = render(<><Select aria-label="Choice" value="a" options={options} onChange={change} /><button>Outside</button></>);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.mouseDown(screen.getByText('Outside'));
    screen.getByText('Outside').focus();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Outside')).toHaveFocus();
    rerender(<fieldset disabled><Select aria-label="Choice" value="a" options={options} onChange={change} /></fieldset>);
    expect(screen.getByRole('combobox')).toBeDisabled();
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });

  it('uses the first Escape to close the list and the next to dismiss the dialog', async () => {
    const close = vi.fn();
    render(<DialogSurface aria-label="Form" onClose={close}><Select aria-label="Choice" value="a" options={options} onChange={vi.fn()} /><button>After</button></DialogSurface>);
    const control = screen.getByRole('combobox');
    await waitFor(() => expect(control).toHaveFocus());
    fireEvent.click(control);
    fireEvent.keyDown(screen.getByRole('option', { name: 'Alpha' }), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(control).toHaveFocus();
    fireEvent.keyDown(control, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps Tab wrapping inside dialogs when the open select is the first or last control', async () => {
    render(<DialogSurface aria-label="Form" onClose={vi.fn()}><button>Before</button><Select aria-label="Choice" value="a" options={options} onChange={vi.fn()} /></DialogSurface>);
    await waitFor(() => expect(screen.getByText('Before')).toHaveFocus());
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.keyDown(screen.getByRole('option', { name: 'Alpha' }), { key: 'Tab' });
    expect(screen.getByText('Before')).toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('dismisses an open list if its ancestor fieldset becomes disabled', async () => {
    const view = (disabled: boolean) => <fieldset disabled={disabled}><Select aria-label="Choice" value="a" options={options} onChange={vi.fn()} /></fieldset>;
    const { rerender } = render(view(false));
    fireEvent.click(screen.getByRole('combobox'));
    rerender(view(true));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    rerender(view(false));
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
  });

});
