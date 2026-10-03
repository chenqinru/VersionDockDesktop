import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingSelect } from './SettingSelect';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('opens options above the trigger when a scrollable settings pane clips the bottom', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('settings-custom-select')
      ? new DOMRect(20, 260, 140, 28) : new DOMRect(0, 40, 400, 260);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(70);
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = computedStyle(element);
    if (element.classList.contains('settings-content')) style.overflowY = 'auto';
    return style;
  });
  const change = vi.fn();
  render(<div className="settings-content"><SettingSelect label="Layout density" value="comfortable" options={[["comfortable", "Comfortable"], ["compact", "Compact"]]} onChange={change} /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'Layout density' }));
  expect(screen.getByRole('listbox')).toHaveAttribute('data-placement', 'above');
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Compact' }));
  expect(change).toHaveBeenCalledWith('compact');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Layout density' })).toHaveFocus();
});
