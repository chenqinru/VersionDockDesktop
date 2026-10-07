import { useEffect, useState } from 'react';
import type { RemoteProviderAccount } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { Codicon } from './Codicon';

type CachedAvatar = { url: string; expires: number };
const cache = new Map<string, CachedAvatar>();
let epoch = 0;
if (typeof window !== 'undefined') window.addEventListener('versiondock-avatar-cache-clear', () => { cache.clear(); epoch++; });

export function ProviderAccountAvatar({ account, size = 48 }: { account: RemoteProviderAccount; size?: number }) {
  const bridge = useBridge();
  const key = JSON.stringify([account.id, account.provider, account.host, account.login]);
  const [version, setVersion] = useState(epoch);
  const [image, setImage] = useState<{ key: string; version: number; url: string } | undefined>(() => {
    const found = cache.get(key);
    return found && found.expires > Date.now() ? { key, version: epoch, url: found.url } : undefined;
  });
  const [failed, setFailed] = useState<string>();
  const url = image?.key === key && image.version === version ? image.url : undefined;
  const imageKey = `${key}:${version}`;

  useEffect(() => {
    const refresh = () => setVersion(epoch);
    window.addEventListener('versiondock-avatar-cache-clear', refresh);
    return () => window.removeEventListener('versiondock-avatar-cache-clear', refresh);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const found = cache.get(key);
    const cached = found && found.expires > Date.now();
    const request = cached ? Promise.resolve(found.url) : bridge.request<string | null>({ type: 'providerAccountAvatar', payload: { account_id: account.id } }, { signal: controller.signal, showProgress: false });
    void request.then((value) => {
      if (controller.signal.aborted || version !== epoch || typeof value !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(value)) return;
      if (!cached) {
        cache.set(key, { url: value, expires: Date.now() + 10 * 60_000 });
        while (cache.size > 32 || [...cache.values()].reduce((sum, item) => sum + item.url.length * 2, 0) > 4 * 1024 * 1024) cache.delete(cache.keys().next().value!);
      }
      setImage({ key, version, url: value });
      setFailed(undefined);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [account.id, bridge, key, version]);

  return <div className="provider-avatar-box" style={{ width: size, height: size, fontSize: size / 2 }}>
    {url && failed !== imageKey
      ? <img key={imageKey} src={url} alt={account.login} className="provider-avatar-img" onError={() => { cache.delete(key); setFailed(imageKey); }} />
      : <Codicon name="account" />}
  </div>;
}
