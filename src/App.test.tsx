import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationToast } from './App';
import { createTranslator, I18nContext } from './i18n';
import { useAppStore } from './store/appStore';
import type { WorkspaceSnapshot } from './bindings/generated';
import { NotificationStatusBarItem } from './components/StatusBar/NotificationStatusBarItem';

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  useAppStore.setState({ notificationCenterOpen: false, snapshot: { workspace: { id: 'workspace-test', name: 'Test', paths: [], lastOpenedAt: '', available: true }, repositories: [], generation: 1, tools: { git: true, svn: true, svnadmin: true } }, activeTabId: 'workspace-test' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAppStore.setState({ notifications: [], toastNotificationIds: [], notificationCenterOpen: false, snapshot: undefined, activeTabId: null });
});

describe('NotificationToast', () => {
  it('uses a separate footer for translated action buttons and places progress at the bottom', () => {
    useAppStore.getState().addNotification({
      type: 'info', title: 'VersionDock', message: 'Reading repository data', progress: true,
      actions: [{ type: 'cancelOperation', label: 'Cancel', operationId: 'read-repository' }],
    });
    const { rerender } = render(<I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t: createTranslator('zh-CN') }}><NotificationToast /></I18nContext.Provider>);
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('正在读取仓库数据');
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(toast.querySelector('.toast-main-row')).not.toContainElement(screen.getByRole('button', { name: '取消' }));
    expect(toast.querySelector('.toast-details-row')).toContainElement(screen.getByRole('button', { name: '取消' }));
    expect(toast.lastElementChild).toHaveAttribute('role', 'progressbar');
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();

    rerender(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);
    expect(toast).toHaveTextContent('Reading repository data');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(toast).not.toHaveTextContent('正在读取仓库数据');
  });

  it('uses a primary first action and secondary follow-up actions in plugin order', () => {
    useAppStore.getState().addNotification({ type: 'info', title: 'Incoming Commits', message: 'Incoming', actions: [
      { type: 'updateProject', label: 'Update' }, { type: 'dismiss', label: 'Dismiss' }, { type: 'disableIncoming', label: "Don't show again" },
    ] });
    render(<I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t: createTranslator('zh-CN') }}><NotificationToast /></I18nContext.Provider>);
    expect(screen.getByRole('button', { name: '更新' })).not.toHaveClass('secondary');
    expect(screen.getAllByRole('button', { name: '关闭' }).find((button) => button.classList.contains('notification-item-action-btn'))).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: '不再提示' })).toHaveClass('secondary');
  });

  it('retires workspace popups on welcome and keeps late background messages in the center', () => {
    const current = useAppStore.getState().snapshot as WorkspaceSnapshot;
    const id = useAppStore.getState().addNotification({ type: 'info', title: 'Prune Branches', message: 'Old workspace message', actions: [{ type: 'dismiss', label: 'Dismiss' }] });
    render(<NotificationToast />);
    expect(screen.getByRole('alert')).toHaveTextContent('Old workspace message');
    act(() => useAppStore.setState({ snapshot: undefined, activeTabId: null }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useAppStore.getState().toastNotificationIds).not.toContain(id);
    act(() => {
      useAppStore.getState().addNotification({ type: 'info', title: 'Prune Branches', message: 'Late workspace message', workspaceId: current.workspace.id });
      useAppStore.getState().addNotification({ type: 'info', title: 'Reading repository data', message: 'Background progress', progress: true });
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useAppStore.getState().notifications).toHaveLength(3);
    act(() => useAppStore.setState({ snapshot: current, activeTabId: current.workspace.id }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps another workspace notification out of the active project popups', () => {
    const current = useAppStore.getState().snapshot as WorkspaceSnapshot;
    useAppStore.getState().addNotification({ type: 'info', title: 'Other', message: 'Other project', workspaceId: 'workspace-other' });
    useAppStore.getState().addNotification({ type: 'warning', title: 'Current', message: 'Current project' });
    render(<NotificationToast />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Current project');
    act(() => useAppStore.setState({ snapshot: { ...current, workspace: { ...current.workspace, id: 'workspace-other' } }, activeTabId: 'workspace-other' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useAppStore.getState().notifications).toHaveLength(2);
  });

  it('displays stacked notifications and automatically dismisses ordinary messages independently', () => {
    vi.useFakeTimers();
    const first = useAppStore.getState().addNotification({ type: 'info', title: 'First', message: 'First message' });
    const second = useAppStore.getState().addNotification({ type: 'success', title: 'Second', message: 'Second message' });
    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('First message');
    expect(alerts[1]).toHaveTextContent('Second message');

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(useAppStore.getState().toastNotificationIds).toEqual([]);
    expect(useAppStore.getState().notifications.map((item) => item.id)).toEqual([second, first]);
  });

  it('keeps warnings visible without blocking subsequent notifications', () => {
    vi.useFakeTimers();
    useAppStore.getState().addNotification({ type: 'warning', urgent: true, title: 'Warning', message: 'Needs attention' });
    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);

    expect(screen.getByRole('alert')).toHaveTextContent('Needs attention');

    // Add subsequent info notification while warning is still on screen
    act(() => {
      useAppStore.getState().addNotification({ type: 'info', title: 'Info', message: 'Subsequent update' });
    });

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Needs attention');
    expect(alerts[1]).toHaveTextContent('Subsequent update');

    // After 10s, info auto-dismisses while warning remains
    act(() => vi.advanceTimersByTime(10_000));
    const remainingAlerts = screen.getAllByRole('alert');
    expect(remainingAlerts).toHaveLength(1);
    expect(remainingAlerts[0]).toHaveTextContent('Needs attention');

    // User closes the warning
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useAppStore.getState().toastNotificationIds).toEqual([]);
  });

  it('shows latest notifications when 3 unclosed warnings fill the toast slots', () => {
    vi.useFakeTimers();
    useAppStore.getState().addNotification({ type: 'warning', urgent: true, title: 'W1', message: 'Warning 1' });
    useAppStore.getState().addNotification({ type: 'warning', urgent: true, title: 'W2', message: 'Warning 2' });
    useAppStore.getState().addNotification({ type: 'warning', urgent: true, title: 'W3', message: 'Warning 3' });

    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);

    let alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent('Warning 1');
    expect(alerts[1]).toHaveTextContent('Warning 2');
    expect(alerts[2]).toHaveTextContent('Warning 3');

    // Add 4th notification (info)
    act(() => {
      useAppStore.getState().addNotification({ type: 'info', title: 'Info 4', message: 'New Info 4' });
    });

    alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent('Warning 2');
    expect(alerts[1]).toHaveTextContent('Warning 3');
    expect(alerts[2]).toHaveTextContent('New Info 4');

    // After 10s, info dismisses and Warning 1 becomes visible again
    act(() => vi.advanceTimersByTime(10_000));
    alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent('Warning 1');
    expect(alerts[1]).toHaveTextContent('Warning 2');
    expect(alerts[2]).toHaveTextContent('Warning 3');
  });

  it('does not reset existing toast timer when new notification is added', () => {
    vi.useFakeTimers();
    useAppStore.getState().addNotification({ type: 'info', title: 'First', message: 'First message' });
    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);

    // Advance 4s
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // Add second notification at 4s (causes re-render of parent with new onDismiss callback)
    act(() => {
      useAppStore.getState().addNotification({ type: 'info', title: 'Second', message: 'Second message' });
    });
    expect(screen.getAllByRole('alert')).toHaveLength(2);

    // Advance 6s more (total 10s since First was added, but only 6s since Second was added)
    // First message MUST dismiss at its original 10s deadline!
    act(() => vi.advanceTimersByTime(6_000));
    const alertsAt10s = screen.getAllByRole('alert');
    expect(alertsAt10s).toHaveLength(1);
    expect(alertsAt10s[0]).toHaveTextContent('Second message');

    // Advance 4s more (total 10s for Second message)
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('keeps progress notifications visible beyond 10s until explicitly dismissed', () => {
    vi.useFakeTimers();
    const progressId = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Updating Project',
      message: 'Updating repositories (1/3)...',
      progress: true,
    });
    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationToast /></I18nContext.Provider>);

    expect(screen.getByRole('alert')).toHaveTextContent('Updating repositories (1/3)...');

    // 5秒后普通消息会自动收起，但 progress 通知绝不自动超时收起
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Updating repositories (1/3)...');

    // 30秒后仍保持显示，对齐插件通知区进度持续到操作结束
    act(() => vi.advanceTimersByTime(210_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Updating repositories (1/3)...');

    // 操作完成后外部显式关闭
    act(() => {
      useAppStore.getState().dismissToast(progressId);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the VS Code warning timeout while preserving actionable errors', () => {
    vi.useFakeTimers();
    useAppStore.getState().addNotification({ type: 'warning', title: 'Warning', message: 'Ordinary warning' });
    const error = useAppStore.getState().addNotification({ type: 'error', title: 'Failed', message: 'Retry needed' });
    render(<NotificationToast />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Retry needed');
    act(() => vi.advanceTimersByTime(60_000));
    expect(useAppStore.getState().toastNotificationIds).toEqual([error]);
  });

  it('defers expiry while hovered, focused, or the app is unfocused', () => {
    vi.useFakeTimers();
    useAppStore.getState().addNotification({ type: 'info', title: 'Info', message: 'Read this', actions: [{ type: 'dismiss', label: 'Dismiss' }] });
    render(<NotificationToast />);
    const toast = screen.getByRole('alert');
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    (document.activeElement as HTMLElement).blur();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useAppStore.getState().notifications).toHaveLength(1);
  });

  it('removes manually closed messages and suppresses toasts while the center is open', () => {
    useAppStore.getState().addNotification({ type: 'info', title: 'Info', message: 'Close me' });
    render(<><NotificationToast /><NotificationStatusBarItem /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useAppStore.getState().notifications).toHaveLength(0);
    act(() => { useAppStore.getState().addNotification({ type: 'info', title: 'Saved', message: 'Keep in center' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toHaveTextContent('Keep in center');
    act(() => { useAppStore.getState().addNotification({ type: 'info', title: 'New', message: 'Arrived while open' }); });
    expect(screen.getByRole('dialog')).toHaveTextContent('Arrived while open');
    expect(useAppStore.getState().toastNotificationIds).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useAppStore.getState().notifications).toHaveLength(2);
  });

  it('renders determinate progress bar when progressValue is provided and indeterminate otherwise', () => {
    const determinateId = useAppStore.getState().addNotification({
      type: 'info',
      title: 'Updating Project',
      message: 'Updating...',
      progress: true,
      progressValue: 60,
    });
    const { container, rerender } = render(
      <I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}>
        <NotificationToast />
      </I18nContext.Provider>
    );

    const determinateBar = container.querySelector('.toast-progress-bar-determinate') as HTMLElement | null;
    expect(determinateBar).not.toBeNull();
    expect(determinateBar?.style.width).toBe('60%');
    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '60');

    // 清理并测试无 progressValue 的情况
    act(() => {
      useAppStore.getState().dismissToast(determinateId);
      useAppStore.getState().addNotification({
        type: 'info',
        title: 'Updating Project',
        message: 'Indeterminate progress...',
        progress: true,
      });
    });

    rerender(
      <I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}>
        <NotificationToast />
      </I18nContext.Provider>
    );

    expect(container.querySelector('.toast-progress-bar-determinate')).toBeNull();
    expect(container.querySelector('.toast-progress-bar-indeterminate')).not.toBeNull();
  });

  it('protects active progress toast from being pushed out when more than 3 new notifications arrive', () => {
    vi.useFakeTimers();
    useAppStore.getState().addNotification({
      type: 'info',
      title: 'Updating Project',
      message: 'Ongoing project update',
      progress: true,
      progressValue: 25,
    });

    // 陆续加入 4 条新的普通通知
    act(() => {
      useAppStore.getState().addNotification({ type: 'info', title: 'N1', message: 'Message 1' });
      useAppStore.getState().addNotification({ type: 'info', title: 'N2', message: 'Message 2' });
      useAppStore.getState().addNotification({ type: 'info', title: 'N3', message: 'Message 3' });
      useAppStore.getState().addNotification({ type: 'info', title: 'N4', message: 'Message 4' });
    });

    render(
      <I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}>
        <NotificationToast />
      </I18nContext.Provider>
    );

    const alerts = screen.getAllByRole('alert');
    // 最大显示 3 条
    expect(alerts).toHaveLength(3);
    // progress 通知必须始终保留在可见列表中，不能被新消息全部挤掉
    const texts = alerts.map((a) => a.textContent);
    expect(texts.some((t) => t?.includes('Ongoing project update'))).toBe(true);
    // 其余两个槽位显示最新的两条普通通知（Message 3 和 Message 4）
    expect(texts.some((t) => t?.includes('Message 3'))).toBe(true);
    expect(texts.some((t) => t?.includes('Message 4'))).toBe(true);
  });
});
