import { scrollbarContains } from '../../scrollbars/ownership';
import { StatusBarPopoverPortal } from './StatusBarPopoverPortal';
import { IconButton } from '../IconButton';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Codicon } from '../Codicon';
import { resolveNotificationText, useAppStore, type AppNotification } from '../../store/appStore';
import { useI18n } from '../../i18n';

interface NotificationCenterPopoverProps {
  anchorRect: DOMRect | null;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

function formatRelativeTime(timestamp: number, t: (key: string, ...args: Array<string | number>) => string, language: 'en' | 'zh-CN'): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 10) return t('Just now');
  if (diffSec < 60) return t('{0}s ago', diffSec);
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('{0}m ago', diffMin);
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('{0}h ago', diffHour);
  return new Date(timestamp).toLocaleDateString(language);
}

export function NotificationCenterPopover({ anchorRect, anchorRef, onClose }: NotificationCenterPopoverProps) {
  const { t, language } = useI18n();
  const notifications = useAppStore((state) => state.notifications);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const markNotificationAsRead = useAppStore((state) => state.markNotificationAsRead);
  const markAllNotificationsAsRead = useAppStore((state) => state.markAllNotificationsAsRead);
  const removeNotification = useAppStore((state) => state.removeNotification);
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const performNotificationAction = useAppStore((state) => state.performNotificationAction);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<'current' | 'all'>('current');

  const snapshotWorkspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const currentWorkspaceId = activeTabId ?? snapshotWorkspaceId ?? null;

  const hasMultipleTabs = tabs.length > 1;
  const currentWorkspaceNotifications = notifications.filter(
    (n) => !n.workspaceId || !currentWorkspaceId || n.workspaceId === currentWorkspaceId
  );
  const currentUnreadCount = currentWorkspaceNotifications.filter((n) => !n.read).length;
  const totalUnreadCount = notifications.filter((n) => !n.read).length;

  const displayNotifications = (hasMultipleTabs && scope === 'current')
    ? currentWorkspaceNotifications
    : notifications;
  const displayUnreadCount = (hasMultipleTabs && scope === 'current')
    ? currentUnreadCount
    : totalUnreadCount;

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (scrollbarContains(popoverRef.current, target) || scrollbarContains(anchorRef.current, target)) return;
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, onClose]);

  const handleAction = async (item: AppNotification, actionIndex: number) => {
    onClose();
    await performNotificationAction(item.id, actionIndex);
  };

  const getNotificationIcon = (type: AppNotification['type']) => {
    switch (type) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      case 'success':
        return 'info';
      case 'info':
      default:
        return 'info';
    }
  };

  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 28,
    right: anchorRect ? Math.max(8, window.innerWidth - anchorRect.right) : 8,
    width: 'min(450px, calc(100vw - 16px))',
    maxHeight: 'calc(100vh - 60px)',
    zIndex: 1000,
  };

  return (
    <StatusBarPopoverPortal>
    <div
      ref={popoverRef}
      className="statusbar-popover notification-center-popover"
      role="dialog"
      aria-label={t('Notifications')}
      style={popoverStyle}
    >
      <div className="statusbar-popover-header notification-header">
        <div className="notification-header-title">
          <Codicon name="bell" />
          <span>{t('Notifications')}</span>
          {displayUnreadCount > 0 && <span className="notification-badge">{displayUnreadCount}</span>}
        </div>
        <div className="notification-header-actions">
          <IconButton type="button" className="notification-action-btn" title={t('Close')} aria-label={t('Close')} onClick={onClose}>
            <Codicon name="chevron-down" />
          </IconButton>
          {displayUnreadCount > 0 && (
            <IconButton
              type="button"
              className="notification-action-btn"
              title={scope === 'current' && hasMultipleTabs ? t('Mark current as read') : t('Mark all as read')}
              onClick={() => markAllNotificationsAsRead(scope === 'current' && hasMultipleTabs ? (currentWorkspaceId ?? undefined) : undefined)}
            >
              <Codicon name="check-all" />
            </IconButton>
          )}
          {displayNotifications.length > 0 && (
            <IconButton
              type="button"
              className="notification-action-btn"
              title={scope === 'current' && hasMultipleTabs ? t('Clear current') : t('Clear all')}
              onClick={() => clearNotifications(scope === 'current' && hasMultipleTabs ? (currentWorkspaceId ?? undefined) : undefined)}
            >
              <Codicon name="clear-all" />
            </IconButton>
          )}
        </div>
      </div>

      {hasMultipleTabs && (
        <div className="notification-scope-nav" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'current'}
            className={`notification-scope-tab ${scope === 'current' ? 'active' : ''}`}
            onClick={() => setScope('current')}
          >
            <span>{t('Current Project')}</span>
            {currentUnreadCount > 0 && <span className="notification-scope-badge">{currentUnreadCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'all'}
            className={`notification-scope-tab ${scope === 'all' ? 'active' : ''}`}
            onClick={() => setScope('all')}
          >
            <span>{t('All Projects')}</span>
            {totalUnreadCount > 0 && <span className="notification-scope-badge">{totalUnreadCount}</span>}
          </button>
        </div>
      )}

      <div className="statusbar-popover-content notification-list">
        {displayNotifications.length === 0 ? (
          <div className="notification-empty">
            <Codicon name="bell-dot" />
            <span>{t('No notifications')}</span>
          </div>
        ) : (
          displayNotifications.map((item) => {
            const workspaceName = tabs.find((t) => t.id === item.workspaceId)?.name;
            return (
              <article
                key={item.id}
                className={`notification-item ${item.type} ${item.read ? 'read' : 'unread'}`}
                onClick={() => markNotificationAsRead(item.id)}
              >
                <div className={`notification-severity-icon ${item.type}`}>
                  <Codicon name={getNotificationIcon(item.type)} />
                </div>
                <div className="notification-item-body">
                  <div className="notification-item-row">
                    <div className="notification-item-heading">
                      <strong className="notification-item-title">{resolveNotificationText(item.title, t)}</strong>
                      {workspaceName && (scope === 'all' || !activeTabId) && (
                        <span className="notification-workspace-tag" title={workspaceName}>{workspaceName}</span>
                      )}
                    </div>
                    <span className="notification-item-time">
                      {formatRelativeTime(item.timestamp, t, language)}
                    </span>
                  </div>
                  <p className="notification-item-msg">{resolveNotificationText(item.message, t)}</p>
                  {item.details && <details className="toast-details"><summary>{t('Technical details')}</summary><pre>{item.details}</pre></details>}
                  {item.progress && <progress className="notification-center-progress" aria-label={resolveNotificationText(item.title, t)} max={100} value={item.progressValue} />}

                </div>
                {!item.progress && <IconButton
                  type="button"
                  className="notification-item-dismiss"
                  title={t('Dismiss')}
                  aria-label={t('Dismiss')}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeNotification(item.id);
                  }}
                >
                  <Codicon name="close" />
                </IconButton>}
                {item.actions.length > 0 && <div className="notification-item-actions">
                    {item.actions.map((action, actionIndex) => (
                      <button
                        type="button"
                        className={`notification-item-action-btn${actionIndex > 0 ? ' secondary' : ''}`}
                        disabled={item.actionState?.[actionIndex] === 'done' || Object.values(item.actionState ?? {}).includes('running')}
                        key={`${action.type}-${actionIndex}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleAction(item, actionIndex);
                        }}
                      >
                        <span>{resolveNotificationText(action.label, t)}</span>
                      </button>
                    ))}
                </div>}
              </article>
            );
          })
        )}
      </div>
    </div>
    </StatusBarPopoverPortal>
  );
}
