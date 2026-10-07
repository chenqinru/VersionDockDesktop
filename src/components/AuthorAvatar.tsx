import { useContext, useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { branchColor } from './branchColor';
import { BridgeContext } from '../platform/context';

type Cached = { value: string | null; expires: number };
const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<string | null>>();
const queue: Array<() => void> = [];
let active = 0;
let cacheEpoch = 0;
const MAX_ACTIVE = 4, MAX_CACHE = 256;
if (typeof window !== 'undefined') window.addEventListener('versiondock-avatar-cache-clear', () => { cacheEpoch += 1; cache.clear(); inFlight.clear(); });

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => { active += 1; void task().then(resolve, reject).finally(() => { active -= 1; queue.shift()?.(); }); };
    if (active < MAX_ACTIVE) run(); else queue.push(run);
  });
}
function githubUrl(email: string, size: number) {
  if (!email.toLowerCase().endsWith('@users.noreply.github.com')) return null;
  const local = email.split('@')[0] ?? ''; const username = local.includes('+') ? local.split('+').at(-1) : local;
  return username ? `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?size=${size * 2}` : null;
}
async function gravatarUrl(email: string, size: number) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  const hash = [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `https://www.gravatar.com/avatar/${hash}?s=${size * 2}&d=404`;
}
function validateImage(url: string): Promise<string | null> { return new Promise((resolve) => { const image = new Image(); const timeout = window.setTimeout(() => finish(null), 8_000); const finish = (value: string | null) => { window.clearTimeout(timeout); image.onload = null; image.onerror = null; resolve(value); }; image.onload = () => finish(url); image.onerror = () => finish(null); image.src = url; }); }
async function cached(key: string, resolver: () => Promise<string | null>) {
  const found = cache.get(key); if (found && found.expires > Date.now()) return found.value;
  const existing = inFlight.get(key); if (existing) return existing;
  const epoch = cacheEpoch;
  const task = schedule(() => resolver().catch(() => null)).then((value) => {
    if (epoch === cacheEpoch) {
      cache.delete(key);
      cache.set(key, { value, expires: Date.now() + (value ? 7 * 86_400_000 : 86_400_000) });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    }
    return value;
  });
  inFlight.set(key, task);
  void task.finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
  return task;
}
function initials(name: string) { const values = name.trim().split(/\s+/).filter(Boolean); return (values.length > 1 ? `${values[0][0]}${values.at(-1)![0]}` : values[0]?.slice(0, 2) || '?').toUpperCase(); }

export function AuthorAvatar({ name, email, repoId, size = 20, className = 'avatar' }: { name: string; email: string; repoId?: string; size?: number; className?: string }) {
  const bridge = useContext(BridgeContext);
  const online = useAppStore((state) => state.bootstrap?.state.settings?.onlineAvatarsEnabled ?? false);
  const gravatar = useAppStore((state) => state.bootstrap?.state.settings?.gravatarEnabled ?? false);
  const crossPlatformFallback = useAppStore((state) => state.bootstrap?.state.settings?.avatarCrossPlatformFallback ?? false);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const remotes = useAppStore((state) => state.remotes[repoId ?? '']);
  const branch = useAppStore((state) => state.allRepositories.find((repo) => repo.meta.id === repoId)?.branch);
  const upstream = useAppStore((state) => state.branchesByRepo[repoId ?? '']?.find((branch) => branch.current)?.upstream);
  const [resolved, setResolved] = useState<{ key: string; url: string | null }>();
  const [cacheVersion, setCacheVersion] = useState(0);
  const repositoryScope = `${workspaceId ?? ''}\0${repoId ?? ''}\0`;
  const remoteScope = JSON.stringify([branch, upstream, remotes?.map((remote) => [remote.name, remote.fetchUrl, remote.pushUrl])]);
  const key = `${repositoryScope}${remoteScope}\0${email.trim().toLowerCase()}\0${name.trim().toLowerCase()}\0${size}\0${gravatar}\0${crossPlatformFallback}\0${cacheVersion}`;
  const url = online && resolved?.key === key ? resolved.url : null;
  useEffect(() => {
    const refresh = () => setCacheVersion((value) => value + 1);
    window.addEventListener('versiondock-avatar-cache-clear', refresh);
    return () => window.removeEventListener('versiondock-avatar-cache-clear', refresh);
  }, []);
  useEffect(() => {
    let active = true;
    if (online && (email.trim() || name.trim())) {
      void cached(key, async () => {
        if (bridge && workspaceId && repoId) {
          const remote = await bridge.request<string | null>({ type: 'resolveAuthorAvatar', payload: { workspace_id: workspaceId, repo_id: repoId, email, author_name: name } }, { showProgress: false }).catch(() => null);
          if (remote) { const valid = await validateImage(remote); if (valid) return valid; }
        }
        const github = repoId ? null : githubUrl(email, size);
        if (github) { const valid = await validateImage(github); if (valid) return valid; }
        return gravatar && email.trim() ? validateImage(await gravatarUrl(email, size)) : null;
      }).then((value) => { if (active) setResolved({ key, url: value }); });
    }
    return () => { active = false; };
  }, [bridge, cacheVersion, crossPlatformFallback, email, gravatar, key, name, online, repoId, size, workspaceId]);
  const style = { width: size, height: size, flex: `0 0 ${size}px`, borderRadius: '50%', overflow: 'hidden', display: 'grid', placeItems: 'center', background: branchColor(email || name), color: '#fff', fontSize: size * .4 } as const;
  return url ? <img className={className} src={url} alt="" title={`${name}${email ? ` <${email}>` : ''}`} style={{ ...style, objectFit: 'cover' }} onError={() => setResolved({ key, url: null })} /> : <span className={className} title={`${name}${email ? ` <${email}>` : ''}`} style={style}>{initials(name)}</span>;
}
