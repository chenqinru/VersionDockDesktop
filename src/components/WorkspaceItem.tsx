import { useId, type MouseEventHandler, type ReactNode } from 'react';
import type { WorkspaceDescriptor } from '../bindings/generated';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { ProjectIcon } from './ProjectIcon';

interface WorkspaceItemProps {
  workspace: WorkspaceDescriptor;
  size: 'welcome' | 'menu';
  opened?: boolean;
  current?: boolean;
  disabled?: boolean;
  onOpen: MouseEventHandler<HTMLButtonElement>;
  actions?: ReactNode;
}

/** Shared workspace identity and row feedback; the caller owns opening and actions. */
export function WorkspaceItem({ workspace, size, opened = false, current = false, disabled = false, onOpen, actions }: WorkspaceItemProps) {
  const { t } = useI18n();
  const hintId = useId();
  const unavailable = !workspace.available;
  const menu = size === 'menu';
  return <div
    className={`vd-row workspace-item ${menu ? 'workspace-menu-item-row-wrap' : 'recent-card'}`}
    data-size={size}
    data-row-selected={current || undefined}
    aria-disabled={disabled || undefined}
  >
    <button
      type="button"
      role={menu ? 'menuitem' : undefined}
      className={`workspace-item-main ${menu ? 'workspace-menu-item' : 'recent-card-btn'}`}
      disabled={disabled}
      aria-current={current ? 'page' : undefined}
      aria-describedby={unavailable ? hintId : undefined}
      onClick={onOpen}
    >
      <ProjectIcon name={workspace.name} seed={workspace.paths[0] || workspace.id || workspace.name}
        size={menu ? 'medium' : 'large'} available={workspace.available} className="workspace-item-icon" />
      <span className="workspace-item-info">
        <span className="workspace-item-heading">
          <span className="workspace-item-name" title={workspace.name}>{workspace.name}</span>
          {opened && <span className="workspace-item-opened">{t('Already open')}</span>}
        </span>
        <span className="workspace-item-path" title={workspace.paths.join(' · ')}>{workspace.paths.join(' · ')}</span>
        {unavailable && <span id={hintId} className="workspace-item-unavailable"><Codicon name="warning" />{t('Path was unavailable — click to retry')}</span>}
      </span>
      {current && <Codicon name="check" className="workspace-item-check" />}
    </button>
    {actions && <div className="workspace-item-actions">{actions}</div>}
  </div>;
}
