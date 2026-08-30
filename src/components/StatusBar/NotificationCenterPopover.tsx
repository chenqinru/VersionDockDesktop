import { useEffect, useRef, type RefObject } from 'react';
import { Codicon } from '../Codicon';
import { resolveNotificationText, useAppStore, type AppNotification } from '../../store/appStore';
import { useI18n } from '../../i18n';

interface NotificationCenterPopoverProps {
  anchorRect: DOMRect | null;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

function formatRelativeTime(timestamp: number, t: (key: string, ...args: Array<string | number>) => string): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 10) return t('Just now');
  if (diffSec < 60) return t('{0}s ago', diffSec);
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('{0}m ago', diffMin);
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('{0}h ago', diffHour);
  return new Date(timestamp).toLocaleDateString();
}

export function NotificationCenterPopover({ anchorRect, anchorRef, onClose }: NotificationCenterPopoverProps) {
  const { t } = useI18n();
  const notifications = useAppStore((state) => state.notifications);
  const markNotificationAsRead = useAppStore((state) => state.markNotificationAsRead);
  const markAllNotificationsAsRead = useAppStore((state) => state.markAllNotificationsAsRead);
  const removeNotification = useAppStore((state) => state.removeNotification);
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const performNotificationAction = useAppStore((state) => state.performNotificationAction);
  const popoverRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
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
        return 'pass';
      case 'info':
      default:
        return 'info';
    }
  };

  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 28,
    right: anchorRect ? Math.max(8, window.innerWidth - anchorRect.right) : 8,
    width: 380,
    maxHeight: 'calc(100vh - 60px)',
    zIndex: 1000,
  };

  return (
    <div
      ref={popoverRef}
      className="statusbar-popover notification-center-popover"
      style={popoverStyle}
    >
      <div className="statusbar-popover-header notification-header">
        <div className="notification-header-title">
          <Codicon name="bell" />
          <span>{t('Notifications')}</span>
          {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
        </div>
        <div className="notification-header-actions">
          {unreadCount > 0 && (
            <button
              type="button"
              className="notification-action-btn"
              title={t('Mark all as read')}
              onClick={() => markAllNotificationsAsRead()}
            >
              <Codicon name="check-all" />
            </button>
          )}
          {notifications.length > 0 && (
            <button
              type="button"
              className="notification-action-btn"
              title={t('Clear all')}
              onClick={() => clearNotifications()}
            >
              <Codicon name="clear-all" />
            </button>
          )}
        </div>
      </div>

      <div className="statusbar-popover-content notification-list">
        {notifications.length === 0 ? (
          <div className="notification-empty">
            <Codicon name="bell-dot" />
            <span>{t('No notifications')}</span>
          </div>
        ) : (
          notifications.map((item) => (
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
                  <strong className="notification-item-title">{resolveNotificationText(item.title, t)}</strong>
                  <span className="notification-item-time">
                    {formatRelativeTime(item.timestamp, t)}
                  </span>
                </div>
                <p className="notification-item-msg">{resolveNotificationText(item.message, t)}</p>
                {item.details && <pre className="notification-item-details">{item.details}</pre>}
                {item.actions.length > 0 && <div className="notification-item-actions">
                  {item.actions.map((action, actionIndex) => (
                    <button
                      type="button"
                      className="notification-item-action-btn"
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
              </div>
              <button
                type="button"
                className="notification-item-dismiss"
                title={t('Dismiss')}
                onClick={(e) => {
                  e.stopPropagation();
                  removeNotification(item.id);
                }}
              >
                <Codicon name="close" />
              </button>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
