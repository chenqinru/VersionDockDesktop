import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { CommitSearch, DateFilter, DatePopover, FilterPopover } from './HistoryFilterControls';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('CommitSearch', () => {
  it('debounces once and submits Enter and clearing immediately without a delayed duplicate', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<CommitSearch value="" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Search commits…' });
    fireEvent.change(input, { target: { value: 'search' } });
    act(() => vi.advanceTimersByTime(249));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('search');
    fireEvent.change(input, { target: { value: 'second' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('second');
    act(() => vi.advanceTimersByTime(250));
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(input).toHaveValue('');
  });

  it('cancels a pending query when its external value changes or its workspace unmounts', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const view = render(<CommitSearch value="original" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pending' } });
    view.rerender(<CommitSearch value="" onChange={onChange} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
    act(() => vi.advanceTimersByTime(250));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'other workspace' } });
    view.unmount();
    act(() => vi.advanceTimersByTime(250));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('waits for Chinese composition to finish and Escape clears and blurs', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<CommitSearch value="" onChange={onChange} />);
    const input = screen.getByRole('textbox');
    input.focus();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '搜' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    act(() => vi.advanceTimersByTime(500));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '搜索' } });
    fireEvent.compositionEnd(input);
    act(() => vi.advanceTimersByTime(250));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('搜索');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(input).not.toHaveFocus();
  });
});

describe('Filter pickers', () => {
  it('keeps date clearing independent from opening the picker and preserves its disclosure arrow', () => {
    const onClick = vi.fn();
    const onClear = vi.fn();
    render(<DateFilter from="2026-10-13" to="" open onClick={onClick} onClear={onClear} />);
    const trigger = screen.getByRole('button', { name: '2026-10-13 → ...' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.querySelector('.codicon-chevron-up')).toBeInTheDocument();
    expect(trigger).not.toContainElement(screen.getByRole('button', { name: 'Clear date range' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear date range' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('opens both months on the selected start month when it is also the current month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00'));
    render(<DatePopover from="2026-10-13" to="" onChange={() => undefined} onClose={() => undefined} />);
    const months = document.querySelectorAll('.calendar-nav strong');
    expect(months).toHaveLength(2);
    expect(months[0].textContent).toBe(months[1].textContent);
    expect(screen.getAllByRole('button', { name: '13' })).toHaveLength(2);
    for (const day of screen.getAllByRole('button', { name: '13' })) expect(day).toHaveClass('edge');
    for (const day of screen.getAllByRole('button', { name: '14' })) expect(day).not.toHaveClass('edge');
  });

  it('keeps remote refs out of the local branch/tag picker after a sidebar remote selection', () => {
    render(<FilterPopover kind="ref" values={[{ id: 'refs/heads/main', label: 'main', group: 'Branches' }]} selected="refs/remotes/origin/main" onSelect={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'main' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'refs/remotes/origin/main' })).not.toBeInTheDocument();
  });

  it('filters author names and emails, submits an existing identity only and closes even on All', () => {
    const onSelect = vi.fn();
    render(<FilterPopover kind="author" values={[{ id: 'ada@example.test', label: 'Ada', sublabel: 'ada@example.test' }]} selected="" onSelect={onSelect} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'EXAMPLE' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('ada@example.test');
    fireEvent.change(input, { target: { value: 'unknown' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No authors match')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'All authors' }));
    expect(onSelect).toHaveBeenLastCalledWith('');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('keeps radio groups independent when both compare panes have author menus', () => {
    const values = [{ id: 'a', label: 'Ada' }];
    render(<><FilterPopover kind="author" values={values} selected="a" onSelect={() => undefined} /><FilterPopover kind="author" values={values} selected="a" onSelect={() => undefined} /></>);
    const radios = screen.getAllByRole('radio', { name: 'Ada' });
    expect(radios[0]).toBeChecked();
    expect(radios[1]).toBeChecked();
    expect(radios[0].getAttribute('name')).not.toBe(radios[1].getAttribute('name'));
  });

  it('orders reverse date selection and closes only when the range is complete', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    function Picker() {
      const [range, setRange] = useState({ from: '2026-01-20', to: '' });
      return <DatePopover {...range} onChange={(from, to) => { setRange({ from, to }); onChange(from, to); }} onClose={onClose} />;
    }
    render(<Picker />);
    fireEvent.click(screen.getAllByRole('button', { name: '10' })[0]);
    expect(onChange).toHaveBeenLastCalledWith('2026-01-10', '2026-01-20');
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: '15' })[0]);
    expect(onChange).toHaveBeenLastCalledWith('2026-01-15', '');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
