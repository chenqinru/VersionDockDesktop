import { useEffect, useState } from 'react';
import type { RemoteProviderAccount } from '../bindings/generated';
import { useBridge } from '../platform/context';
import type { VersionDockBridge } from '../platform/bridge';
import { Codicon } from './Codicon';

type CachedAvatar = { url: string | null; expires: number };
type AvatarCacheState = { cache: Map<string, CachedAvatar>; inFlight: Map<string, Promise<string | null>>; epoch: number };
const state: AvatarCacheState = import.meta.hot?.data?.avatarCacheState ?? { cache: new Map(), inFlight: new Map(), epoch: 0 };
const { cache, inFlight } = state;
const clearCache = () => { cache.clear(); inFlight.clear(); state.epoch++; };
if (typeof window !== 'undefined') window.addEventListener('versiondock-avatar-cache-clear', clearCache);
if (import.meta.hot) import.meta.hot.dispose(() => {
  // Preserve cache and request generations across frontend-only hot updates.
  import.meta.hot!.data.avatarCacheState = state;
  window.removeEventListener('versiondock-avatar-cache-clear', clearCache);
});

function accountAvatar(bridge: VersionDockBridge, key: string, accountId: string) {
  const found = cache.get(key);
  if (found && found.expires > Date.now()) return Promise.resolve(found.url);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const version = state.epoch;
  // Shared requests survive individual component disposal and StrictMode remounts.
  const request = bridge.request<string | null>({ type: 'providerAccountAvatar', payload: { account_id: accountId } }, { showProgress: false })
    .catch(() => null).then((value) => {
      const url = typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(value) ? value : null;
      if (version === state.epoch) {
        cache.set(key, { url, expires: Date.now() + (url ? 10 * 60_000 : 60_000) });
        while (cache.size > 32 || [...cache.values()].reduce((sum, item) => sum + (item.url?.length ?? 0) * 2, 0) > 4 * 1024 * 1024) cache.delete(cache.keys().next().value!);
      }
      return url;
    });
  inFlight.set(key, request);
  void request.finally(() => { if (inFlight.get(key) === request) inFlight.delete(key); });
  return request;
}

export function ProviderAccountAvatar({ account, size = 48 }: { account: RemoteProviderAccount; size?: number }) {
  const bridge = useBridge();
  const key = JSON.stringify([account.id, account.provider, account.host, account.login]);
  const [version, setVersion] = useState(state.epoch);
  const [image, setImage] = useState<{ key: string; version: number; url: string } | undefined>(() => {
    const found = cache.get(key);
    return found?.url && found.expires > Date.now() ? { key, version: state.epoch, url: found.url } : undefined;
  });
  const [failed, setFailed] = useState<string>();
  const url = image?.key === key && image.version === version ? image.url : undefined;
  const imageKey = `${key}:${version}`;

  useEffect(() => {
    const refresh = () => setVersion(state.epoch);
    window.addEventListener('versiondock-avatar-cache-clear', refresh);
    return () => window.removeEventListener('versiondock-avatar-cache-clear', refresh);
  }, []);

  useEffect(() => {
    let active = true;
    void accountAvatar(bridge, key, account.id).then((value) => {
      if (!active || version !== state.epoch || !value) return;
      setImage({ key, version, url: value });
      setFailed(undefined);
    });
    return () => { active = false; };
  }, [account.id, bridge, key, version]);

  return <div className="provider-avatar-box" style={{ width: size, height: size, fontSize: size / 2 }}>
    {url && failed !== imageKey
      ? <img key={imageKey} src={url} alt={account.login} className="provider-avatar-img" onError={() => { cache.delete(key); setFailed(imageKey); }} />
      : <Codicon name="account" />}
  </div>;
}
