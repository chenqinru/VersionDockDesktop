import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemePreviewSelector, FileIconThemePreviewSelector } from './AppearanceSelectors';

afterEach(cleanup);
it('provides one tab stop and keyboard navigation with wrapping, Home and End', () => {
  const change = vi.fn(); const { rerender } = render(<ThemePreviewSelector value="dark2026" onChange={change} />);
  const radios = screen.getAllByRole('radio');
  expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('radio', { name: '2026 Dark' }), { key: 'ArrowRight' });
  expect(change).toHaveBeenLastCalledWith('light2026');
  expect(screen.getByRole('radio', { name: '2026 Light' })).toHaveFocus();
  rerender(<ThemePreviewSelector value="light2026" onChange={change} />);
  fireEvent.keyDown(document.activeElement!, { key: 'End' }); expect(change).toHaveBeenLastCalledWith('light');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); expect(change).toHaveBeenLastCalledWith('system');
  fireEvent.keyDown(document.activeElement!, { key: 'Home' }); expect(change).toHaveBeenLastCalledWith('system');
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('shows real file examples and avoids saving when clicking the current icon theme', () => {
  const change = vi.fn(); render(<FileIconThemePreviewSelector value="codicon" onChange={change} />);
  expect(screen.getAllByText('photo.png')).toHaveLength(4);
  fireEvent.click(screen.getByRole('radio', { name: 'Codicon (Classic Outline)' })); expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Codicon (Classic Outline)' }), { key: 'ArrowLeft' }); expect(change).toHaveBeenCalledWith('seti');
});
