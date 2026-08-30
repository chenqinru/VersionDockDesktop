import { useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { NotificationCenterPopover } from './NotificationCenterPopover';

export function NotificationStatusBarItem() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const notifications = useAppStore((state) => state.notifications);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleClick = () => {
    if (!open && anchorRef.current) {
      setAnchorRect(anchorRef.current.getBoundingClientRect());
    }
    setOpen((prev) => !prev);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`statusbar-item notification-status-item ${open ? 'active' : ''} ${unreadCount > 0 ? 'has-unread' : ''}`}
        title={unreadCount > 0 ? `${t('Notifications')} (${unreadCount})` : t('Notifications')}
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
