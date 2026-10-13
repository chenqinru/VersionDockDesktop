import { useContext, useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { branchColor } from './branchColor';
import { BridgeContext } from '../platform/context';

import { authorAvatarEpoch, authorAvatarKey, authorAvatarRemoteScope, peekAuthorAvatar, requestAuthorAvatar, subscribeAuthorAvatars, invalidateAuthorAvatar } from '../avatars/authorAvatarResolver';

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
  const [resolved, setResolved] = useState<{ key: string; url: string | null; epoch: number }>();
  const [cacheVersion, setCacheVersion] = useState(0);
  const context = { bridge, workspaceId, repoId, remoteScope: authorAvatarRemoteScope(branch, upstream, remotes), gravatar, crossPlatformFallback };
  const key = authorAvatarKey(context, email, name);
  const epoch = authorAvatarEpoch();
  const url = online ? (resolved?.key === key && resolved.epoch === epoch ? resolved.url : peekAuthorAvatar(key)) : null;
  useEffect(() => {
    const refresh = () => setCacheVersion((value) => value + 1);
    window.addEventListener('versiondock-avatar-cache-clear', refresh);
    return () => window.removeEventListener('versiondock-avatar-cache-clear', refresh);
  }, []);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeAuthorAvatars(values => {
      const url = values.get(key);
      if (online && url) setResolved({ key, url, epoch });
    });
    if (online && (email.trim() || name.trim())) {
      const context = { bridge, workspaceId, repoId, remoteScope: authorAvatarRemoteScope(branch, upstream, remotes), gravatar, crossPlatformFallback };
      void requestAuthorAvatar(context, email, name, size).then(url => { if (active) setResolved({ key, url: peekAuthorAvatar(key) ?? url, epoch }); });
    }
    return () => { active = false; unsubscribe(); };
  }, [bridge, cacheVersion, crossPlatformFallback, email, epoch, gravatar, key, name, online, repoId, size, workspaceId, branch, upstream, remotes]);
  const style = { width: size, height: size, flex: `0 0 ${size}px`, borderRadius: '50%', overflow: 'hidden', display: 'grid', placeItems: 'center', background: branchColor(email || name), color: '#fff', fontSize: size * .4 } as const;
  return url ? <img className={className} src={url} alt="" title={`${name}${email ? ` <${email}>` : ''}`} style={{ ...style, objectFit: 'cover' }} onError={() => { invalidateAuthorAvatar(key); setResolved({ key, url: null, epoch }); }} /> : <span className={className} title={`${name}${email ? ` <${email}>` : ''}`} style={style}>{initials(name)}</span>;
}
