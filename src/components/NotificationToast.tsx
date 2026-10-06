import { IconButton } from './IconButton';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { resolveNotificationText, useAppStore, type AppNotification } from '../store/appStore';
import { useI18n } from '../i18n';

function ToastItem({
  notification,
  onDismiss,
  onClose,
  onAction,
}: {
  notification: AppNotification;
  onDismiss: () => void;
  onClose: () => void;
  onAction: (index: number) => void;
}) {
  const { t } = useI18n();
  const itemRef = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    // VS Code: progress and actionable errors stay visible; ordinary warnings expire.
    if (notification.progress || notification.urgent || expanded || (notification.type === 'error' && notification.actions.length > 0)) return;
    const delay = notification.type === 'error' ? 15_000 : notification.type === 'warning' ? 12_000 : 10_000;
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (!document.hasFocus() || document.hidden || hovered.current || itemRef.current?.contains(document.activeElement)) {
          schedule();
        } else {
          onDismissRef.current();
        }
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [notification.id, notification.type, notification.progress, notification.urgent, notification.actions.length, expanded]);

  return (
    <div ref={itemRef} className={`toast ${notification.type}${notification.progress ? ' progress' : ''}`} role="alert"
      onMouseEnter={() => { hovered.current = true; }} onMouseLeave={() => { hovered.current = false; }}>
      <div className="toast-main-row">
        <div className={`notification-severity-icon ${notification.type}`}>
          <Codicon name={notification.type === 'error' ? 'error' : notification.type === 'warning' ? 'warning' : 'info'} />
        </div>
        <div className="toast-message" title={resolveNotificationText(notification.title, t, notification.repositoryCount)}>{resolveNotificationText(notification.message, t, notification.repositoryCount)}{notification.progressMessage && <> {resolveNotificationText(notification.progressMessage, t, notification.repositoryCount)}</>}</div>
        {!notification.progress && <IconButton
          type="button"
          className="toast-close"
          aria-label={t('Close')}
          title={t('Close')}
          onClick={onClose}
        ><Codicon name="close" /></IconButton>}
      </div>
      {notification.actions.length > 0 && (
        <div className="toast-details-row">
          <span className="toast-source">{t('Source: {0}', 'VersionDock')}</span>
          <div className="notification-item-actions toast-actions">
            {notification.actions.map((action, index) => (
              <button
                type="button"
                className={`notification-item-action-btn${index > 0 ? ' secondary' : ''}`}
                disabled={notification.actionState?.[index] === 'done' || Object.values(notification.actionState ?? {}).includes('running')}
                key={`${action.type}-${index}`}
                onClick={() => onAction(index)}
              >{resolveNotificationText(action.label, t, notification.repositoryCount)}</button>
            ))}
          </div>
        </div>
      )}
      {notification.details && (
        <details className="toast-details" onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>{t('Technical details')}</summary>
          <pre>{notification.details}</pre>
        </details>
      )}
      {notification.progress && (
        <div className="toast-progress-track" role="progressbar"
          aria-label={resolveNotificationText(notification.message, t, notification.repositoryCount)}
          aria-valuenow={notification.progressValue} aria-valuemin={0} aria-valuemax={100}>
          {notification.progressValue !== undefined ? (
            <div className="toast-progress-bar-determinate" style={{ width: `${Math.min(100, Math.max(0, notification.progressValue))}%` }} />
          ) : <div className="toast-progress-bar-indeterminate" />}
        </div>
      )}
    </div>
  );
}

export function NotificationToast() {
  const { t } = useI18n();
  const notifications = useAppStore((state) => state.notifications);
  const toastNotificationIds = useAppStore((state) => state.toastNotificationIds ?? []);
  const dismissToast = useAppStore((state) => state.dismissToast);
  const removeNotification = useAppStore((state) => state.removeNotification);
  const centerOpen = useAppStore((state) => state.notificationCenterOpen);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const performNotificationAction = useAppStore((state) => state.performNotificationAction);

  const eligibleIds = useMemo(() => toastNotificationIds.filter((id) => {
    const item = notifications.find((notification) => notification.id === id);
    if (!item) return false;
    if (item.workspaceId) return item.workspaceId === workspaceId;
    return Boolean(workspaceId) || !item.progress;
  }), [toastNotificationIds, notifications, workspaceId]);

  useEffect(() => {
    // Retain history, but never replay a background workspace's popup on return.
    const eligible = new Set(eligibleIds);
    toastNotificationIds.filter((id) => !eligible.has(id)).forEach((id) => dismissToast(id));
  }, [eligibleIds, toastNotificationIds, dismissToast]);

  const activeIds = useMemo(() => {
    const progressIds = eligibleIds.filter((id) => {
      const item = notifications.find((n) => n.id === id);
      return Boolean(item?.progress);
    });
    if (progressIds.length >= 3) {
      return progressIds.slice(-3);
    }
    const nonProgressIds = eligibleIds.filter((id) => !progressIds.includes(id));
    const recentNonProgress = nonProgressIds.slice(-(3 - progressIds.length));
    const visibleSet = new Set([...progressIds, ...recentNonProgress]);
    return eligibleIds.filter((id) => visibleSet.has(id));
  }, [eligibleIds, notifications]);
  if (centerOpen || activeIds.length === 0) return null;

  return (
    <div className="toast-container" role="region" aria-label={t('Notifications')}>
      {activeIds.map((id) => {
        const item = notifications.find((n) => n.id === id);
        if (!item) return null;
        return (
          <ToastItem
            key={id}
            notification={item}
            onDismiss={() => dismissToast(id)}
            onClose={() => removeNotification(id)}
            onAction={(index) => void performNotificationAction(id, index)}
          />
        );
      })}
    </div>
  );
}
