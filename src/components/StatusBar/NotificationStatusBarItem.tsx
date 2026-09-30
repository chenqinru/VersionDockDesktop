import { useEffect, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { NotificationCenterPopover } from './NotificationCenterPopover';

export function NotificationStatusBarItem() {
  const { t } = useI18n();
  const open = useAppStore((state) => state.notificationCenterOpen);
  const setOpen = useAppStore((state) => state.setNotificationCenterOpen);
  useEffect(() => () => setOpen(false), [setOpen]);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const notifications = useAppStore((state) => state.notifications);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const snapshotWorkspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const currentWorkspaceId = activeTabId ?? snapshotWorkspaceId ?? null;

  const currentWorkspaceNotifications = notifications.filter(
    (n) => !n.workspaceId || !currentWorkspaceId || n.workspaceId === currentWorkspaceId
  );
  const unreadCount = currentWorkspaceNotifications.filter((n) => !n.read).length;
  const otherUnreadCount = currentWorkspaceId
    ? notifications.filter((n) => !n.read && n.workspaceId && n.workspaceId !== currentWorkspaceId).length
    : 0;

  const handleClick = () => {
    if (!open && anchorRef.current) {
      setAnchorRect(anchorRef.current.getBoundingClientRect());
    }
    setOpen(!open);
  };

  let tooltip = t('Notifications');
  if (unreadCount > 0 && otherUnreadCount > 0) {
    tooltip = `${t('Notifications')} (${unreadCount}) · ${t('{0} in other projects', otherUnreadCount)}`;
  } else if (unreadCount > 0) {
    tooltip = `${t('Notifications')} (${unreadCount})`;
  } else if (otherUnreadCount > 0) {
    tooltip = `${t('Notifications')} · ${t('{0} in other projects', otherUnreadCount)}`;
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`statusbar-item notification-status-item ${open ? 'active' : ''} ${unreadCount > 0 ? 'has-unread' : ''}`}
        title={tooltip}
        aria-label={t('Notifications')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={handleClick}
      >
        <div className="notification-icon-wrap">
          <Codicon name={unreadCount > 0 ? 'bell-dot' : 'bell'} />
          {unreadCount > 0 && <span className="notification-status-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </div>
      </button>

      {open && (
        <NotificationCenterPopover
          anchorRect={anchorRect}
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
