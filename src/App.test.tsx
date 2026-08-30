import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationToast } from './App';
import { createTranslator, I18nContext } from './i18n';
import { useAppStore } from './store/appStore';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAppStore.setState({ notifications: [], toastNotificationIds: [] });
});

describe('NotificationToast', () => {
  it('shows every notification in order and automatically advances ordinary messages', () => {
    vi.useFakeTimers();
    const first = useAppStore.getState().addNotification({ type: 'info', title: 'First', message: 'First message' });
    const second = useAppStore.getState().addNotification({ type: 'success', title: 'Second', message: 'Second message' });
    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);

    expect(screen.getByRole('alert')).toHaveTextContent('First message');
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Second message');
    expect(useAppStore.getState().toastNotificationIds).toEqual([second]);
    expect(useAppStore.getState().notifications.map((item) => item.id)).toEqual([second, first]);
  });

  it('keeps warnings visible until the user closes them', () => {
    vi.useFakeTimers();
    useAppStore.getState().addNotification({ type: 'warning', title: 'Warning', message: 'Needs attention' });
    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Needs attention');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
