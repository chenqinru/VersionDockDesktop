import { useState } from 'react';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { IconButton } from './IconButton';
import { ProviderPanel } from './ProviderPanel';
import { RepositoryCheckoutDialog } from './RepositoryCheckoutDialog';
import { SettingsPanel } from './SettingsPanel';

export function TitleBarActions({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const busy = useAppStore(state => isOperationActive(state.operations, { workspaceId, domain: 'workspace' }));
  const cloneAvailable = useAppStore(state => state.bootstrap?.capabilities?.availability?.cloneRepository?.available ?? state.bootstrap?.tools?.git ?? false);
  const [dialog, setDialog] = useState<'clone' | 'providers' | 'settings'>();
  const close = () => setDialog(undefined);

  return <>
    <div className="titlebar-actions" role="toolbar" aria-label={t('Workspace')}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <IconButton title={t('Clone Git Repository')} disabled={busy || !cloneAvailable} aria-haspopup="dialog" aria-expanded={dialog === 'clone'} onClick={() => setDialog('clone')}><Codicon name="repo-clone" /></IconButton>
      <IconButton title={t('Manage Remote Accounts (GitHub / GitLab / Gitee)')} aria-haspopup="dialog" aria-expanded={dialog === 'providers'} onClick={() => setDialog('providers')}><Codicon name="account" /></IconButton>
      <IconButton title={t('Settings')} aria-haspopup="dialog" aria-expanded={dialog === 'settings'} onClick={() => setDialog('settings')}><Codicon name="settings-gear" /></IconButton>
    </div>
    {dialog === 'clone' && <RepositoryCheckoutDialog kind="git" close={close} />}
    {dialog === 'providers' && <ProviderPanel mode="manage" close={close} />}
    {dialog === 'settings' && <SettingsPanel onClose={close} />}
  </>;
}
