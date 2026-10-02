import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RepositoryStatus } from '../../bindings/generated';
import { useI18n } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { AuthorAvatar } from '../AuthorAvatar';
import { Codicon } from '../Codicon';
import { gitAccountName, providerLabel, repositoryPlatforms, svnAccountName } from './profileStatus';
import type { useProfileStatus } from './useProfileStatus';

export function ProfileStatusTooltip({ data, repo, repositories, anchor, onManage, onLeave }: { data: ReturnType<typeof useProfileStatus>; repo?: RepositoryStatus; repositories: RepositoryStatus[]; anchor: DOMRect; onManage: () => void; onLeave: () => void }) {
  const { t } = useI18n();
  const branches = useAppStore((state) => state.branchesByRepo);
  const online = useAppStore((state) => state.bootstrap?.state.settings?.onlineAvatarsEnabled);
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.left);
  const identity = data.git[repo?.meta.id ?? ''];
  const account = repo && data.svn[repo.meta.id];
  const platforms = repositoryPlatforms(repo ? data.remotes[repo.meta.id] ?? [] : [], repo ? branches[repo.meta.id] ?? [] : [], data.accounts);
  const primary = platforms.find((item) => item.primary);
  const providers = (['gitee', 'github', 'gitlab'] as const).map((provider) => ({ provider, match: platforms.find((item) => item.provider === provider && item.primary) ?? platforms.find((item) => item.provider === provider) }))
    .sort((a, b) => Number(b.match?.primary ?? false) * 2 + Number(Boolean(b.match)) - Number(a.match?.primary ?? false) * 2 - Number(Boolean(a.match)));
  useLayoutEffect(() => { if (ref.current) setLeft(Math.max(8, Math.min(anchor.left, window.innerWidth - ref.current.offsetWidth - 8))); }, [anchor]);
  return createPortal(<div ref={ref} onMouseLeave={onLeave} role="tooltip" id="profile-status-tooltip" className="branch-status-tooltip profile-status-tooltip" style={{ left, bottom: window.innerHeight - anchor.top + 6 }}>
    <div className="profile-tooltip-heading">
      {online && identity ? <AuthorAvatar name={identity.effective.userName} email={identity.effective.email} repoId={repo?.meta.id} size={32} /> : <Codicon name="account" />}
      <div><strong>{repo?.meta.kind === 'svn' ? `SVN: ${svnAccountName(account || undefined, t)}` : gitAccountName(identity, t)}</strong>
        {identity && identity.selectedProfileId !== `__${identity.effective.source}__` && ['local', 'global'].includes(identity.effective.source) && <span> ({t(identity.effective.source)})</span>}
        {primary?.provider && <span> · {t('{0} Repository ({1})', providerLabel(primary.provider), primary.remote.name)}</span>}
        {identity?.effective.email && <p><code>{identity.effective.email}</code></p>}
        {account && <p>{account.nativeCredentials?.[0]?.realm ?? account.repositoryRoot}</p>}
        {identity?.effective.source === 'missing' && <p>{t('VersionDock: No Git identity configured — click to set one')}</p>}
      </div>
    </div>
    <div className="profile-tooltip-accounts"><strong>{t('Remote Accounts')}</strong>{providers.map(({ provider, match }) => {
      const accounts = data.accounts.filter((account) => account.provider === provider);
      return <div key={provider}><Codicon name={provider === 'github' ? 'github' : 'repo'} /><span>{providerLabel(provider)}: <strong>{accounts.length > 1 ? t('{0} account(s) connected', accounts.length) : accounts[0] ? `@${accounts[0].login}` : t('Not connected')}</strong></span>
        {match && <em> ({t(match.primary ? 'Current Project ({0})' : 'Linked Remote ({0})', match.remote.name)})</em>}{accounts.length > 0 && <Codicon name="check" />}</div>;
    })}</div>
    {repositories.length > 1 && <p>{t('Multi-repository workspace ({0} repos) · Current: {1}', repositories.length, repo?.meta.name ?? '')}</p>}
    <button type="button" className="profile-tooltip-manage" onClick={onManage}><Codicon name="settings-gear" />{t('Click to manage accounts and identities')}</button>
  </div>, document.body);
}
