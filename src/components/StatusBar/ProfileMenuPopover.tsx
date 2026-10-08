import { scrollbarContains } from '../../scrollbars/ownership';
import { StatusBarPopoverPortal } from './StatusBarPopoverPortal';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { GitProfile, GitProfileOperation, RemoteProviderKind, RepositoryStatus, SvnAccountOperation } from '../../bindings/generated';
import { useAppStore } from '../../store/appStore';
import { useBridge } from '../../platform/context';
import { useI18n } from '../../i18n';
import { Codicon } from '../Codicon';
import { hasMixedRepositoryKinds, repositoryLabel } from '../repoLabel';
import { ProviderPanel } from '../ProviderPanel';
import { choiceDialog, confirmDialog, currentDialog, multiChoiceDialog, promptDialog } from '../dialogService';
import { StatusBarQuickMenu } from './StatusBarQuickMenu';
import { positionBranchSubmenu, type BranchMenuPosition } from './branchMenuPosition';
import { announceIdentityChange, GLOBAL_PROFILE_ID, LOCAL_PROFILE_ID, profileStatusName, providerLabel, repositoryPlatforms, svnAccountName } from './profileStatus';
import type { useProfileStatus } from './useProfileStatus';

function ProfileMenuItem({ label, icon, onClick, description, detail, active = false, disabled = false, busy }: { label: string; icon: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void; description?: string; detail?: string; active?: boolean; disabled?: boolean; busy: boolean }) {
  const { t } = useI18n();
  return <button type="button" className={`statusbar-menu-item ${active ? 'active-ref' : ''}`} disabled={busy || disabled} aria-label={[label, active ? t('active') : '', description, detail].filter(Boolean).join(' ')} onClick={onClick}>
    <Codicon name={active ? 'check' : icon} /><div className="statusbar-menu-item-text"><span className="statusbar-menu-item-title">{label}{active && <span className="statusbar-badge"> · {t('active')}</span>}</span>{description && <span className="statusbar-menu-item-desc">{description}</span>}{detail && <span className="statusbar-menu-item-detail">{detail}</span>}</div></button>;
}

interface Props {
  anchorRect: DOMRect | null; anchorRef: RefObject<HTMLButtonElement>; onClose: (restoreFocus?: boolean) => void;
  data: ReturnType<typeof useProfileStatus>; repositories: RepositoryStatus[]; currentRepoId?: string;
  onRepositoryChange: (repoId: string) => void;
}

export function ProfileMenuPopover({ anchorRect, anchorRef, onClose, data, repositories, currentRepoId, onRepositoryChange }: Props) {
  const bridge = useBridge();
  const { t } = useI18n();
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const addNotification = useAppStore((state) => state.addNotification);
  const [page, setPage] = useState<'identity' | 'repositories'>('identity');
  const [profileId, setProfileId] = useState<string>();
  const [submenuPos, setSubmenuPos] = useState<BranchMenuPosition>();
  const [provider, setProvider] = useState<RemoteProviderKind>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const repo = repositories.find((repo) => repo.meta.id === currentRepoId) ?? repositories[0];
  const repoId = repo?.meta.id ?? '';
  const identity = data.git[repoId];
  const account = data.svn[repoId];
  const customProfile = identity?.profiles.find((profile) => profile.id === profileId);
  const platforms = repositoryPlatforms(data.remotes[repoId] ?? [], branchesByRepo[repoId] ?? [], data.accounts);
  const back = () => { setProfileId(undefined); setSubmenuPos(undefined); };
  const validContext = () => mounted.current && useAppStore.getState().snapshot?.workspace.id === workspaceId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (pending.current || provider || currentDialog()) return;
      const target = event.target as Node;
      if (scrollbarContains(popoverRef.current, target) || scrollbarContains(submenuRef.current, target) || scrollbarContains(anchorRef.current, target)) return;
      onClose(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || pending.current || provider || currentDialog()) return;
      event.preventDefault();
      if (profileId) back(); else if (page === 'repositories') setPage('identity'); else onClose();
    };
    const blur = () => { if (!pending.current && !provider && !currentDialog()) onClose(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); window.addEventListener('blur', blur); window.addEventListener('resize', blur);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('blur', blur); window.removeEventListener('resize', blur); };
  }, [anchorRef, onClose, page, profileId, provider]);
  useLayoutEffect(() => {
    if (!submenuPos || !submenuRef.current) return;
    const h = submenuRef.current.offsetHeight;
    const top = Math.max(10, Math.min(submenuPos.centerY - h / 2, window.innerHeight - 30 - h));
    if (Math.abs(top - submenuPos.top) > 1) setSubmenuPos({ ...submenuPos, top });
  }, [submenuPos, profileId, customProfile, busy]);

  const notify = (message: string, type: 'success' | 'error' = 'success') => addNotification({ type, title: type === 'success' ? 'Identity operation completed' : 'Identity operation failed', message: { raw: message }, workspaceId });
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (reason) { if (validContext()) { setError(String(reason)); notify(String(reason), 'error'); } }
    finally { pending.current = false; if (validContext()) setBusy(false); }
  };
  const gitOperation = async (operation: GitProfileOperation) => {
    if (!workspaceId || !validContext()) return;
    await bridge.request({ type: 'gitProfileOperation', payload: { workspace_id: workspaceId, repo_id: repoId, operation } });
    announceIdentityChange();
  };
  const svnOperation = async (operation: SvnAccountOperation) => {
    if (!workspaceId || !validContext()) return;
    await bridge.request({ type: 'svnAccountOperation', payload: { workspace_id: workspaceId, repo_id: repoId, operation } });
    announceIdentityChange();
    if (operation.type === 'switch' && validContext() && useAppStore.getState().historyRepoErrors?.[repoId]) {
      await useAppStore.getState().loadHistory(true);
    }
  };
  const selectProfile = (id: string) => run(async () => {
    await gitOperation({ type: 'select', profile_id: id });
    if (!validContext()) return;
    notify(t('VersionDock: {0} set as active profile for this workspace.', id === LOCAL_PROFILE_ID ? t('Local') : id === GLOBAL_PROFILE_ID ? t('Global') : customProfile?.label ?? id));
    back(); onClose();
  });
  const editProfile = (profile?: GitProfile) => run(async () => {
    const label = await promptDialog({ title: t(profile ? 'Edit Profile — Display Name' : 'New Git Profile — Display Name'), message: t('A label for this profile (e.g. Work, Personal)'), initialValue: profile?.label ?? '', validateInput: (value) => !value.trim() ? t('Name cannot be empty') : ['local', 'global'].includes(value.trim().toLowerCase()) ? t('"{0}" is a reserved name', value.trim()) : undefined });
    if (label === null || !validContext()) return;
    const userName = await promptDialog({ title: t(profile ? 'Edit Profile — Git Name' : 'New Git Profile — Git Name'), message: t('Value for git user.name'), initialValue: profile?.userName ?? '', allowEmpty: true });
    if (userName === null || !validContext()) return;
    const email = await promptDialog({ title: t(profile ? 'Edit Profile — Git Email' : 'New Git Profile — Git Email'), message: t('Value for git user.email'), initialValue: profile?.email ?? '' });
    if (email === null || !validContext()) return;
    const id = profile?.id ?? crypto.randomUUID();
    await gitOperation({ type: 'save', profile: { id, label, userName, email } });
    if (!validContext()) return;
    notify(t(profile ? 'VersionDock: Profile "{0}" updated.' : 'Profile "{0}" created', label));
    if (!profile) {
      const choice = await choiceDialog({ title: t('Profile "{0}" created — activate for this workspace?', label), message: '', choices: [{ id: 'yes', label: t('Yes, use it now'), icon: 'check' }, { id: 'no', label: t('No, just save it'), icon: 'close' }] });
      if (choice === 'yes' && validContext()) { await gitOperation({ type: 'select', profile_id: id }); notify(t('VersionDock: {0} set as active profile for this workspace.', label)); }
    }
    if (validContext()) { back(); data.reload(); }
  });
  const deleteProfile = () => run(async () => {
    if (!customProfile) return;
    const yes = await confirmDialog({ title: t('Delete profile "{0}"?', customProfile.label), message: t('Remove "{0}"', customProfile.label), confirmLabel: t('Delete'), danger: true });
    if (!yes || !validContext()) return;
    await gitOperation({ type: 'delete', profile_id: customProfile.id });
    if (validContext()) { notify(t('VersionDock: Profile "{0}" deleted.', customProfile.label)); back(); }
  });
  const switchSvn = (reauthenticate = false) => run(async () => {
    if (reauthenticate) { await svnOperation({ type: 'delete' }); if (!validContext()) return; }
    const username = await promptDialog({ title: t('Switch SVN Account'), message: t('SVN username for {0}', account?.nativeCredentials?.[0]?.realm ?? account?.repositoryRoot ?? repo?.meta.rootPath ?? ''), initialValue: account?.username ?? '' });
    if (username === null || !validContext()) return;
    const password = await promptDialog({ title: t('Switch SVN Account'), message: t('Password for SVN account {0}', username), inputType: 'password' });
    if (password === null || !validContext()) return;
    const choice = await choiceDialog({ title: t('Save SVN credentials?'), message: '', choices: [{ id: 'remember', label: t('Remember in SVN authentication cache'), description: t('Other SVN clients can reuse this account'), icon: 'lock' }, { id: 'session', label: t('Use for this VersionDock session only'), description: t('Do not write the password to the system SVN cache'), icon: 'clock' }] });
    if (!choice || !validContext()) return;
    await svnOperation({ type: 'switch', username, password, remember: choice === 'remember' });
    if (validContext()) { notify(t('VersionDock: SVN account switched to {0}.', username)); onClose(); }
  });
  const clearSvnCache = () => run(async () => {
    const credentials = account?.nativeCredentials ?? [];
    if (!credentials.length) { notify(t('No cached SVN credentials detected')); return; }
    const ids = credentials.length === 1 ? [credentials[0].id] : await multiChoiceDialog({ title: t('Clear Cached SVN Credentials…'), message: t('Remove matching credentials from the system SVN authentication cache'), initialSelected: [], choices: credentials.map((item) => ({ id: item.id, label: item.realm, description: item.username ?? '' })) });
    if (!ids?.length || !validContext()) return;
    const yes = await confirmDialog({ title: t('Clear Cached SVN Credentials…'), message: t('This can affect other SVN clients using the same authentication realm.'), confirmLabel: t('Clear Cached Credentials'), danger: true });
    if (!yes || !validContext()) return;
    for (const id of ids) { if (!validContext()) return; await svnOperation({ type: 'clearNative', credential_id: id }); }
    if (validContext()) notify(t('VersionDock: Cached SVN credentials cleared for {0}.', account?.repositoryRoot ?? ''));
  });

  const section = (title: string, children: ReactNode) => <div className="statusbar-menu-section"><div className="statusbar-menu-group-header">{title}</div>{children}</div>;
  const openProfile = (id: string, event: MouseEvent<HTMLButtonElement>) => { setProfileId(id); setSubmenuPos(positionBranchSubmenu(event.currentTarget.getBoundingClientRect(), popoverRef.current?.getBoundingClientRect() ?? null, window.innerWidth, window.innerHeight, false)); };
  const remoteItems = section(t('REMOTE ACCOUNTS'), <>{(['github', 'gitlab', 'gitee'] as const).map((provider) => {
    const accounts = data.accounts.filter((account) => account.provider === provider);
    const match = platforms.find((item) => item.provider === provider && item.primary) ?? platforms.find((item) => item.provider === provider);
    const tag = match ? ` · ${t(match.primary ? 'Current Project ({0})' : 'Linked Remote ({0})', match.remote.name)}` : '';
    return { provider, accounts, match, tag };
  }).sort((a, b) => Number(Boolean(b.match)) + Number(b.match?.primary ?? false) - Number(Boolean(a.match)) - Number(a.match?.primary ?? false)).map(({ provider, accounts, tag }) => <ProfileMenuItem key={provider} busy={busy} label={providerLabel(provider)} icon={provider === 'github' ? 'github' : 'repo'} onClick={() => setProvider(provider)} description={(accounts.length > 1 ? t('{0} account(s) connected', accounts.length) : accounts.length ? t('Connected') : t('Not connected')) + tag} detail={accounts.length ? accounts.map((account) => `${account.displayName || account.login} (@${account.login}) · ${account.host}`).join(' • ') : t(provider === 'github' ? 'Connect using GitHub authentication or a Personal Access Token' : provider === 'gitlab' ? 'Add, re-authenticate, or remove GitLab Personal Access Tokens' : 'Connect using a Gitee Personal Access Token')} />)}
    <ProfileMenuItem busy={busy} label={t('Clear Avatar Cache')} icon="trash" onClick={() => { window.dispatchEvent(new Event('versiondock-avatar-cache-clear')); notify(t('VersionDock: Avatar cache cleared.')); }} description={t('Cache')} detail={t('Purge cached avatars and force reload')} /></>);
  const gitItems = <>
    {section(t('PROFILES'), <>{identity?.profiles.map((profile) => <ProfileMenuItem key={profile.id} busy={busy} label={profile.label} icon="account" onClick={(event) => openProfile(profile.id, event)} description={`${profile.userName} <${profile.email}>`} active={identity.selectedProfileId === profile.id} />)}
      <ProfileMenuItem busy={busy} label={t('Local')} icon="home" onClick={(event) => openProfile(LOCAL_PROFILE_ID, event)} description={identity?.local ? `${identity.local.userName} <${identity.local.email}> · ${t('from .git/config')}` : t(repo ? 'No local git identity in this repo' : 'No repo open')} active={identity?.selectedProfileId === LOCAL_PROFILE_ID} />
      <ProfileMenuItem busy={busy} label={t('Global')} icon="globe" onClick={(event) => openProfile(GLOBAL_PROFILE_ID, event)} description={identity?.global ? `${identity.global.userName} <${identity.global.email}> · ${t('from ~/.gitconfig')}` : t('No global git identity configured')} active={identity?.selectedProfileId === GLOBAL_PROFILE_ID} /></>)}
    <div className="statusbar-menu-section"><ProfileMenuItem busy={busy} label={t('New Profile…')} icon="add" onClick={() => { void editProfile(); }} description={t('Create a new Git identity profile')} /></div>
  </>;
  const svnItems = <>
    {section(t('CURRENT SVN ACCOUNT'), <><ProfileMenuItem busy={busy} label={svnAccountName(account, t)} icon="account" onClick={() => { void switchSvn(); }} description={t(account?.source === 'session' ? 'VersionDock session credentials' : account?.source === 'nativeCache' ? 'System SVN authentication cache' : account?.source === 'versionDockSecureStore' ? 'system secure storage' : 'No cached SVN credentials detected')} detail={account?.nativeCredentials?.[0]?.realm ?? account?.repositoryRoot} />
      {account?.repositoryUrl && <ProfileMenuItem busy={busy} label={t('Repository URL')} icon="link" onClick={() => { void run(async () => { await navigator.clipboard.writeText(account.repositoryUrl); notify(t('VersionDock [{0}]: SVN repository URL copied.', repo?.meta.name ?? '')); }); }} description={account.repositoryUrl} detail={account.repositoryRoot} />}</>)}
    {section(t('ACTIONS'), <>
      <ProfileMenuItem busy={busy} label={t('Switch SVN Account…')} icon="account" onClick={() => { void switchSvn(); }} description={t('Enter another username and password for this authentication realm')} disabled={!account?.passwordStdinSupported} />
      <ProfileMenuItem busy={busy} label={t('Re-authenticate…')} icon="refresh" onClick={() => { void switchSvn(true); }} description={t('Forget the current session account and enter credentials again')} disabled={!account?.passwordStdinSupported} />
      <ProfileMenuItem busy={busy} label={t('Forget Session Credentials')} icon="debug-disconnect" onClick={() => { void run(async () => { await svnOperation({ type: 'delete' }); if (validContext()) notify(t('VersionDock: SVN session credentials forgotten.')); }); }} description={t('Keep the system SVN cache, but forget credentials held by VersionDock')} />
      <ProfileMenuItem busy={busy} label={t('Clear Cached SVN Credentials…')} icon="trash" onClick={() => { void clearSvnCache(); }} description={t('Remove matching credentials from the system SVN authentication cache')} />
      <ProfileMenuItem busy={busy} label={t('Test SVN Connection')} icon="plug" onClick={() => { void run(async () => { await svnOperation({ type: 'test' }); if (validContext()) notify(t('VersionDock: SVN connection succeeded for {0}: {1}', repo?.meta.name ?? '', account?.repositoryUrl ?? '')); }); }} description={t('Run svn info using the current account')} />
    </>)}
  </>;
  const repositoryDescription = (target: RepositoryStatus) => {
    if (data.loading || data.errors[target.meta.id]) return profileStatusName(target.meta.kind, target.meta.id, data, t);
    if (target.meta.kind === 'svn') return svnAccountName(data.svn[target.meta.id], t);
    const identity = data.git[target.meta.id];
    const platform = repositoryPlatforms(data.remotes[target.meta.id] ?? [], branchesByRepo[target.meta.id] ?? [], data.accounts).find((item) => item.primary);
    return (identity ? `${identity.effective.userName} <${identity.effective.email}>` : t('No profile'))
      + (platform?.provider ? ` [${providerLabel(platform.provider)} · ${platform.remote.name}]` : '');
  };
  const repositoryItems = (() => {
    const groups = new Map<string, RepositoryStatus[]>();
    for (const repo of repositories) { const group = repo.meta.kind === 'git' ? t('Git identities') : data.svn[repo.meta.id]?.nativeCredentials?.[0]?.realm ?? data.svn[repo.meta.id]?.repositoryRoot ?? t('SVN Accounts'); groups.set(group, [...groups.get(group) ?? [], repo]); }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, repos]) => <div key={group}>{section(group, repos.sort((a, b) => a.meta.name.localeCompare(b.meta.name)).map((target) => <ProfileMenuItem key={target.meta.id} busy={busy} label={repositoryLabel(target, hasMixedRepositoryKinds(repositories))} icon={'repo'} onClick={() => { onRepositoryChange(target.meta.id); setPage('identity'); setError(''); back(); }} description={repositoryDescription(target)} detail={target.meta.rootPath} active={repoId === target.meta.id} />))}</div>);
  })();
  const rootTitle = page === 'repositories' ? t('VersionDock — Version Control Accounts') : repo?.meta.kind === 'svn' ? t('VersionDock — SVN Account: {0}', repo.meta.name) : repo ? repositories.length > 1 ? t('VersionDock — Accounts & Identities: {0} ({1}/{2})', repo.meta.name, repositories.findIndex((item) => item.meta.id === repoId) + 1, repositories.length) : t('VersionDock — Accounts & Identities: {0}', repo.meta.name) : t('VersionDock — Accounts & Identities');
  const width = Math.min(360, window.innerWidth - 16);
  const mainStyle = { position: 'fixed' as const, bottom: 28, left: Math.max(8, Math.min(anchorRect?.left ?? 120, window.innerWidth - width - 8)), maxHeight: Math.min(440, window.innerHeight - 40), zIndex: 1000 };
  const activeLabel = customProfile?.label ?? t(profileId === LOCAL_PROFILE_ID ? 'Local' : 'Global');
  return <StatusBarPopoverPortal>
    <StatusBarQuickMenu key={`${repoId}:${page}`} ref={popoverRef} title={rootTitle} active={!profileId && !provider && !busy} className="profile-menu-popover" style={mainStyle} onSearch={back} onBack={page === 'repositories' ? () => setPage('identity') : undefined}>
      {data.loading ? <div className="statusbar-popover-loading"><Codicon name="loading codicon-modifier-spin" />{t('Loading…')}</div> : page === 'repositories' ? repositoryItems : <>
        {!data.errors[repoId] && (repo?.meta.kind === 'svn' ? svnItems : gitItems)}
        {repositories.length > 1 && <div className="statusbar-menu-section"><ProfileMenuItem busy={busy} label={t('Switch to another repository…')} icon="arrow-swap" onClick={() => { back(); setPage('repositories'); }} description={t('Current: {0}  ·  {1} repositories in workspace', repo?.meta.name ?? '', repositories.length)} /></div>}
        {remoteItems}
      </>}
      {(error || data.errors[repoId]) && <div className="error-row" role="alert">{error || data.errors[repoId]}<ProfileMenuItem busy={busy} label={t('Retry')} icon="refresh" onClick={data.reload} /></div>}
      {busy && <div className="statusbar-popover-loading" role="status"><Codicon name="loading codicon-modifier-spin" />{t('Processing…')}</div>}
    </StatusBarQuickMenu>
    {profileId && submenuPos && <StatusBarQuickMenu key={profileId} ref={submenuRef} title={customProfile ? t('Profile: {0}', customProfile.label) : activeLabel} active={!busy && !provider} style={{ position: 'fixed', left: submenuPos.left, top: submenuPos.top, maxHeight: submenuPos.maxHeight, zIndex: 1001 }} onBack={back}>
      <ProfileMenuItem busy={busy} label={t(identity?.selectedProfileId === profileId ? 'Active (in use)' : customProfile ? 'Use for this project/workspace' : 'Use for this workspace')} icon="check" onClick={() => { if (identity?.selectedProfileId === profileId) back(); else void selectProfile(profileId); }} description={t(identity?.selectedProfileId === profileId ? 'This profile is active for this workspace' : 'Use "{0}" for commits made by VersionDock in this workspace', activeLabel)} />
      {customProfile && <div className="statusbar-menu-section"><ProfileMenuItem busy={busy} label={t('Edit…')} icon="edit" onClick={() => { void editProfile(customProfile); }} /><ProfileMenuItem busy={busy} label={t('Delete')} icon="trash" onClick={() => { void deleteProfile(); }} description={t('Remove "{0}"', customProfile.label)} /></div>}
    </StatusBarQuickMenu>}
    {provider && <ProviderPanel mode="manage" initialProvider={provider} close={() => { setProvider(undefined); data.reload(); }} />}
  </StatusBarPopoverPortal>;
}
