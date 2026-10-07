import type { BranchInfo, GitIdentityState, RemoteInfo, RemoteProviderAccount, RemoteProviderKind, SvnAccountState } from '../../bindings/generated';

export const LOCAL_PROFILE_ID = '__local__';
export const GLOBAL_PROFILE_ID = '__global__';
export const IDENTITY_CHANGED = 'versiondock-identity-changed';
export const PROVIDER_ACCOUNTS_CHANGED = 'versiondock-provider-accounts-changed';
export const providerLabel = (provider: RemoteProviderKind) => provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : 'Gitee';

function hostname(value: string): string | undefined {
  try {
    const ssh = /^(?:[^@/]+@)?([^/:]+):[^/]/.exec(value);
    return new URL(value.includes('://') ? value : ssh ? `https://${ssh[1]}` : `https://${value}`).hostname.toLowerCase();
  } catch { return undefined; }
}

export function repositoryPlatforms(remotes: RemoteInfo[], branches: BranchInfo[], accounts: RemoteProviderAccount[]) {
  const upstream = branches.find((branch) => branch.current)?.upstream?.split('/')[0];
  const primary = remotes.find((remote) => remote.name === upstream) ?? remotes.find((remote) => remote.name.toLowerCase() === 'origin') ?? remotes[0];
  return remotes.map((remote) => {
    const host = hostname(remote.fetchUrl || remote.pushUrl || '');
    const account = accounts.find((account) => {
      const accountHost = hostname(account.host);
      return host && accountHost && (host === accountHost || host.endsWith(`.${accountHost}`));
    });
    const provider = account?.provider ?? (['github', 'gitlab', 'gitee'] as const).find((provider) => host === `${provider}.com` || host?.endsWith(`.${provider}.com`));
    return { remote, provider, account, primary: remote === primary };
  });
}

export function svnAccountName(account: SvnAccountState | undefined, t: (key: string) => string) {
  return account?.username || (account && (account.passwordStored || (account.source && account.source !== 'none')) ? t('Authenticated') : t('No account detected'));
}

export function gitAccountName(identity: GitIdentityState | undefined, t: (key: string) => string) {
  return identity?.effective.userName.trim() || (identity?.effective.source === 'custom' ? identity.profiles.find((profile) => profile.id === identity.effective.profileId)?.label : undefined)
    || (identity?.effective.source === 'local' ? t('Local') : identity?.effective.source === 'global' ? t('Global') : t('No profile'));
}

export function announceIdentityChange() { window.dispatchEvent(new Event(IDENTITY_CHANGED)); }
