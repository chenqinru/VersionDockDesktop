import type { ButtonHTMLAttributes } from 'react';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> { size: 'welcome' | 'menu' }

/** The welcome card and switcher menu share one action with different spacing. */
export function OpenWorkspaceAction({ size, className = '', ...props }: Props) {
  const { t } = useI18n();
  return <button {...props} type="button" className={`workspace-open-action ${size === 'welcome' ? 'welcome-action-btn' : 'workspace-menu-primary-btn'} ${className}`.trim()} data-size={size}>
    <span className="workspace-open-action-icon"><Codicon name="folder-opened" /></span>
    <span className="workspace-open-action-content">
      <span className="workspace-open-action-title">{t('Open Workspace')}</span>
      <span className="workspace-open-action-description">{t('Open local folders or a .code-workspace file.')}</span>
    </span>
    {size === 'menu' && <Codicon name="chevron-right" className="workspace-open-action-arrow" />}
  </button>;
}
