import { useCallback, useEffect, useState } from 'react';
import type { GitIdentityState, SvnAccountState } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { confirmDialog } from './dialogService';

export function IdentityPanel({ repoId, close }: { repoId: string; close: () => void }) {
  const bridge = useBridge();
  const snapshot = useAppStore((state) => state.snapshot);
  const repo = snapshot?.repositories.find((item) => item.meta.id === repoId);
  const { t } = useI18n();
  if (!snapshot || !repo) return null;
  return <div className="identity-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="identity-panel" role="dialog" aria-modal="true" aria-label={repo.meta.kind === 'git' ? 'Git Identity' : 'SVN Account'}>
      <header><Codicon name="account" /><strong>{repo.meta.kind === 'git' ? 'Git Identity' : 'SVN Account'}</strong><span>{repo.meta.name}</span><button onClick={close}><Codicon name="close" /></button></header>
      {repo.meta.kind === 'git' ? <GitIdentity bridge={bridge} workspaceId={snapshot.workspace.id} repoId={repoId} t={t} /> : <SvnAccount bridge={bridge} workspaceId={snapshot.workspace.id} repoId={repoId} t={t} />}
    </section>
  </div>;
}

type Bridge = ReturnType<typeof useBridge>;
type Translate = ReturnType<typeof useI18n>['t'];

function GitIdentity({ bridge, workspaceId, repoId, t }: { bridge: Bridge; workspaceId: string; repoId: string; t: Translate }) {
  const [value, setValue] = useState<GitIdentityState>();
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const load = useCallback(() => bridge.request<GitIdentityState>({ type: 'gitIdentity', payload: { workspace_id: workspaceId, repo_id: repoId } }).then(setValue).catch((reason) => setError(String(reason))), [bridge, repoId, workspaceId]);
  useEffect(() => { void load(); }, [load]);
  const operate = async (operation: Parameters<Bridge['request']>[0] extends never ? never : { type: 'gitProfileOperation'; payload: { workspace_id: string; repo_id: string; operation: { type: 'save'; profile: { id: string; label: string; userName: string; email: string } } | { type: 'delete'; profile_id: string } | { type: 'select'; profile_id: string | null } } }) => {
    try { setError(undefined); setValue(await bridge.request<GitIdentityState>(operation)); } catch (reason) { setError(String(reason)); }
  };
  if (!value) return <div className="detail-loading">{error ?? t('Loading files...')}</div>;
  return <div className="identity-content">
    <div className={`identity-effective ${value.effective.valid ? '' : 'invalid'}`}><small>Effective identity · {value.effective.source}</small><strong>{value.effective.valid ? `${value.effective.userName} <${value.effective.email}>` : 'No valid Git identity'}</strong></div>
    <label><span>Profile</span><select value={value.selectedProfileId ?? ''} onChange={(event) => void operate({ type: 'gitProfileOperation', payload: { workspace_id: workspaceId, repo_id: repoId, operation: { type: 'select', profile_id: event.target.value || null } } })}><option value="">Auto · local → global</option>{value.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
    <div className="identity-sources">{value.local && <span>Local: {value.local.userName} &lt;{value.local.email}&gt;</span>}{value.global && <span>Global: {value.global.userName} &lt;{value.global.email}&gt;</span>}</div>
    <form onSubmit={(event) => { event.preventDefault(); const id = crypto.randomUUID(); void operate({ type: 'gitProfileOperation', payload: { workspace_id: workspaceId, repo_id: repoId, operation: { type: 'save', profile: { id, label, userName: name, email } } } }).then(() => { setLabel(''); setName(''); setEmail(''); }); }}>
      <strong>New custom profile</strong><input aria-label="Profile label" placeholder="Profile label" value={label} onChange={(event) => setLabel(event.target.value)} /><input aria-label="user.name" placeholder="user.name" value={name} onChange={(event) => setName(event.target.value)} /><input aria-label="user.email" placeholder="user.email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /><button className="primary" disabled={!label.trim() || !name.trim() || !email.includes('@')} type="submit">{t('Save')}</button>
    </form>
    <div className="identity-profiles">{value.profiles.map((profile) => <article key={profile.id}><span><strong>{profile.label}</strong><small>{profile.userName} &lt;{profile.email}&gt;</small></span><button className="danger" onClick={() => void confirmDialog({ title: t('Delete'), message: profile.label, danger: true }).then((yes) => { if (yes) return operate({ type: 'gitProfileOperation', payload: { workspace_id: workspaceId, repo_id: repoId, operation: { type: 'delete', profile_id: profile.id } } }); })}><Codicon name="trash" /></button></article>)}</div>
    {error && <div className="error-row">{error}</div>}
  </div>;
}

function SvnAccount({ bridge, workspaceId, repoId, t }: { bridge: Bridge; workspaceId: string; repoId: string; t: Translate }) {
  const [value, setValue] = useState<SvnAccountState>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const load = useCallback(() => bridge.request<SvnAccountState>({ type: 'svnAccount', payload: { workspace_id: workspaceId, repo_id: repoId } }).then((next) => { setValue(next); setUsername(next.username ?? ''); }).catch((reason) => setError(String(reason))), [bridge, repoId, workspaceId]);
  useEffect(() => { void load(); }, [load]);
  const operate = async (operation: { type: 'save'; username: string; password: string | null } | { type: 'delete' } | { type: 'test' }) => {
    try { setError(undefined); const next = await bridge.request<SvnAccountState>({ type: 'svnAccountOperation', payload: { workspace_id: workspaceId, repo_id: repoId, operation } }); setValue(next); setPassword(''); } catch (reason) { setError(String(reason)); }
  };
  if (!value) return <div className="detail-loading">{error ?? t('Loading files...')}</div>;
  const passwordEnabled = value.passwordStdinSupported && value.secureStorageAvailable;
  return <div className="identity-content"><div className="identity-effective"><small>Repository root</small><strong>{value.repositoryRoot}</strong></div><label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} /></label><label><span>Password {passwordEnabled ? '· system secure storage' : '· use SVN credential cache'}</span><input type="password" disabled={!passwordEnabled} value={password} onChange={(event) => setPassword(event.target.value)} /></label><div className="identity-actions"><button className="primary" disabled={!username.trim()} onClick={() => void operate({ type: 'save', username, password: password || null })}>{t('Save')}</button><button onClick={() => void operate({ type: 'test' })}>Test connection</button>{value.username && <button className="danger" onClick={() => void operate({ type: 'delete' })}>{t('Delete')}</button>}</div>{value.connectionOk !== null && <div className={value.connectionOk ? 'success-row' : 'error-row'}>{value.connectionOk ? 'Connection successful' : 'Connection failed'}</div>}{error && <div className="error-row">{error}</div>}</div>;
}
