import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GitIdentityState, RemoteInfo, RemoteProviderAccount, RepositoryStatus, SvnAccountState } from '../../bindings/generated';
import { useBridge } from '../../platform/context';
import { IDENTITY_CHANGED, PROVIDER_ACCOUNTS_CHANGED } from './profileStatus';

export function useProfileStatus(workspaceId: string | undefined, repositories: RepositoryStatus[]) {
  const bridge = useBridge();
  const repositoryKey = JSON.stringify(repositories.map((repo) => repo.meta));
  const targets = useMemo(() => JSON.parse(repositoryKey) as RepositoryStatus['meta'][], [repositoryKey]);
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{ git: Record<string, GitIdentityState>; svn: Record<string, SvnAccountState>; remotes: Record<string, RemoteInfo[]>; accounts: RemoteProviderAccount[]; errors: Record<string, string>; loading: boolean }>({ git: {}, svn: {}, remotes: {}, accounts: [], errors: {}, loading: true });
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener('focus', reload);
    window.addEventListener(IDENTITY_CHANGED, reload);
    window.addEventListener(PROVIDER_ACCOUNTS_CHANGED, reload);
    return () => { window.removeEventListener('focus', reload); window.removeEventListener(IDENTITY_CHANGED, reload); window.removeEventListener(PROVIDER_ACCOUNTS_CHANGED, reload); };
  }, [reload]);
  useEffect(() => bridge.subscribe((event) => {
    if ('status' in event && event.status === 'succeeded' && event.context.domain === 'remote' && event.context.visibility === 'foreground'
      && (!event.context.workspaceId || event.context.workspaceId === workspaceId)) reload();
    if ('source' in event && event.source === 'otherWindow' && event.workspaceId === workspaceId) reload();
  }), [bridge, workspaceId, reload]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const options = { showProgress: false, signal: controller.signal };
    if (!workspaceId) return;
    const next: typeof value = { git: {}, svn: {}, remotes: {}, accounts: [], errors: {}, loading: false };
    const jobs = (targets.length ? targets : [undefined]).map(async (repo) => {
      const repoId = repo?.id ?? '';
      try {
        if (!repo || repo.kind === 'git') {
          next.git[repoId] = await bridge.request<GitIdentityState>({ type: 'gitIdentity', payload: { workspace_id: workspaceId, repo_id: repoId } }, options);
          if (repo) next.remotes[repoId] = await bridge.request<RemoteInfo[]>({ type: 'remotes', payload: { workspace_id: workspaceId, repo_id: repoId } }, options).then((value) => Array.isArray(value) ? value : []).catch(() => []);
        } else next.svn[repoId] = await bridge.request<SvnAccountState>({ type: 'svnAccount', payload: { workspace_id: workspaceId, repo_id: repoId } }, options);
      } catch (error) { next.errors[repoId] = String(error); }
    });
    jobs.push(bridge.request<RemoteProviderAccount[]>({ type: 'providerAccounts' }, options).then((accounts) => { next.accounts = Array.isArray(accounts) ? accounts : []; }).catch(() => undefined));
    void Promise.all(jobs).then(() => { if (active) setValue(next); });
    return () => { active = false; controller.abort(); };
  }, [bridge, workspaceId, targets, revision]);
  return { ...value, reload };
}
