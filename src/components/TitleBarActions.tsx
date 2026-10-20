import { useState } from 'react';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { IconButton } from './IconButton';
import { ProviderPanel } from './ProviderPanel';
import { RepositoryCheckoutDialog } from './RepositoryCheckoutDialog';
import { SettingsPanel } from './SettingsPanel';
import { CheckpointCenterHost } from './CheckpointCenter';
import { openCheckpointCenter, closeCheckpointCenter, useCheckpointCenter } from '../checkpoints/center';
import { GITHUB_REPO_URL, openExternalLink } from '../services/updater';

export function TitleBarActions({ workspaceId, showCheckpoints = true }: { workspaceId?: string; showCheckpoints?: boolean }) {
  const { t } = useI18n();
  const busy = useAppStore(state => isOperationActive(state.operations, { workspaceId, domain: 'workspace' }));
  const cloneAvailable = useAppStore(state => state.bootstrap?.capabilities?.availability?.cloneRepository?.available ?? state.bootstrap?.tools?.git ?? false);
  const openAbout = useAppStore(state => state.openAbout);
  const aboutOpen = useAppStore(state => state.aboutOpen);
  const checkpointsOpen = useCheckpointCenter(state => state.open);
  const [dialog, setDialog] = useState<'clone' | 'providers' | 'settings'>();
  const close = () => { setDialog(undefined); closeCheckpointCenter(); };
  const showDialog = (value: 'clone' | 'providers' | 'settings') => { closeCheckpointCenter(); setDialog(value); };

  return <>
    <div className="titlebar-actions" role="toolbar" aria-label={t('Workspace')}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      {workspaceId && <IconButton title={t(busy ? 'Workspace operation in progress…' : 'Clone Git Repository')} aria-label={t('Clone Git Repository')} disabled={busy || !cloneAvailable} aria-haspopup="dialog" aria-expanded={dialog === 'clone'} onClick={() => showDialog('clone')}><Codicon name="repo-clone" /></IconButton>}
      {workspaceId && showCheckpoints && <IconButton title={t('Tasks and checkpoints')} aria-haspopup="dialog" aria-expanded={checkpointsOpen} onClick={() => { setDialog(undefined); openCheckpointCenter(workspaceId); }}><Codicon name="checkpoint" /></IconButton>}
      <IconButton title={t('Manage Remote Accounts (GitHub / GitLab / Gitee)')} aria-haspopup="dialog" aria-expanded={dialog === 'providers'} onClick={() => showDialog('providers')}><Codicon name="account" /></IconButton>
      <IconButton title={t('GitHub Repository')} onClick={() => void openExternalLink(GITHUB_REPO_URL)}><Codicon name="github" /></IconButton>
      <IconButton title={t('About VersionDock & Check Updates')} aria-haspopup="dialog" aria-expanded={aboutOpen} onClick={() => { close(); openAbout('about'); }}><Codicon name="info" /></IconButton>
      <IconButton title={t('Settings')} aria-haspopup="dialog" aria-expanded={dialog === 'settings'} onClick={() => showDialog('settings')}><Codicon name="settings-gear" /></IconButton>
    </div>
    <CheckpointCenterHost />
    {dialog === 'clone' && <RepositoryCheckoutDialog kind="git" close={close} />}
    {dialog === 'providers' && <ProviderPanel mode="manage" close={close} />}
    {dialog === 'settings' && <SettingsPanel scope={workspaceId ? 'workspace' : 'application'} onClose={close} />}
  </>;
}
