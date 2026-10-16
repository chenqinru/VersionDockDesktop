import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, createTranslator } from '../i18n';
import { WorkspaceItem } from './WorkspaceItem';
import { IconButton } from './IconButton';

const workspace = { id: 'team', name: 'Team workspace', paths: ['/tmp/team/a', '/tmp/team/b'], available: false, lastOpenedAt: '' };
afterEach(cleanup);
describe('shared workspace row', () => {
  it.each(['welcome', 'menu'] as const)('keeps unavailable paths retryable in the %s surface and keeps actions separate', size => {
    const open = vi.fn(); const newWindow = vi.fn();
    render(<WorkspaceItem workspace={workspace} size={size} onOpen={open} actions={<IconButton title="Open in New Window" onClick={newWindow} />} />);
    const main = screen.getByRole(size === 'menu' ? 'menuitem' : 'button', { name: /Team workspace/ });
    expect(main).toBeEnabled();
    expect(main).toHaveAccessibleDescription('Path was unavailable — click to retry');
    expect(screen.getByText('/tmp/team/a · /tmp/team/b')).toHaveAttribute('title', '/tmp/team/a · /tmp/team/b');
    fireEvent.click(screen.getByRole('button', { name: 'Open in New Window' }));
    expect(newWindow).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
    fireEvent.click(main); expect(open).toHaveBeenCalledOnce();
    expect(main.querySelector('button')).toBeNull();
  });
  it.each(['en', 'zh-CN'] as const)('distinguishes an opened workspace from the current workspace in %s', language => {
    const t = createTranslator(language);
    const view = render(<I18nContext.Provider value={{ language, preference: 'system', t }}><WorkspaceItem workspace={workspace} size="menu" opened onOpen={vi.fn()} /></I18nContext.Provider>);
    const item = screen.getByRole('menuitem');
    expect(screen.getByText(t('Already open'))).toBeInTheDocument();
    expect(item).not.toHaveAttribute('aria-current');
    view.rerender(<I18nContext.Provider value={{ language, preference: 'system', t }}><WorkspaceItem workspace={workspace} size="menu" opened current disabled onOpen={vi.fn()} /></I18nContext.Provider>);
    expect(item).toHaveAttribute('aria-current', 'page');
    expect(item).toBeDisabled();
    expect(item.parentElement).toHaveAttribute('data-row-selected', 'true');
  });
});
