import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { useAppStore } from '../store/appStore';
import { TitleBarActions } from './TitleBarActions';

const original = useAppStore.getState();
beforeEach(() => useAppStore.setState({
  operations: {},
  bootstrap: { state: { settings: DEFAULT_SETTINGS, recentWorkspaces: [] }, tools: { git: true }, capabilities: { availability: {} } } as any,
}));
afterEach(() => { cleanup(); useAppStore.setState(original, true); });

describe('TitleBarActions', () => {
  it.each([
    ['Clone Git Repository', 'Clone Git Repository'],
    ['Manage Remote Accounts (GitHub / GitLab / Gitee)', 'Remote Providers'],
    ['Settings', 'Settings'],
  ])('opens and closes the existing dialog from %s', (action, dialogName) => {
    render(<BridgeContext.Provider value={new MockBridge(() => [])}><TitleBarActions workspaceId="ws" /></BridgeContext.Provider>);
    const button = screen.getByRole('button', { name: action });
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: dialogName });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('honors clone availability and does not bubble pointer events into the drag region', () => {
    useAppStore.setState({ bootstrap: { state: {}, tools: { git: false } } as any });
    const pointerDown = vi.fn();
    render(<BridgeContext.Provider value={new MockBridge(() => [])}><div onPointerDown={pointerDown}><TitleBarActions workspaceId="ws" /></div></BridgeContext.Provider>);
    const clone = screen.getByRole('button', { name: 'Clone Git Repository' });
    expect(clone).toBeDisabled();
    fireEvent.click(clone);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Settings' }));
    expect(pointerDown).not.toHaveBeenCalled();
  });
});
