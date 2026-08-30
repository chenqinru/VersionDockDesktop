import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { branchColor } from './branchColor';

type Cached = { value: string | null; expires: number };
const cache = new Map<string, Cached>();
const queue: Array<() => void> = [];
let active = 0;
const MAX_ACTIVE = 4, MAX_CACHE = 256;

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
async function resolve(email: string, size: number, gravatar: boolean) { const github = githubUrl(email, size); if (github) return validateImage(github); return gravatar ? validateImage(await gravatarUrl(email, size)) : null; }
async function cached(email: string, size: number, gravatar: boolean) {
  const key = `${email.trim().toLowerCase()}\0${size}\0${gravatar}`; const found = cache.get(key); if (found && found.expires > Date.now()) return found.value;
  const value = await schedule(() => resolve(email, size, gravatar).catch(() => null)); cache.delete(key); cache.set(key, { value, expires: Date.now() + (value ? 86_400_000 : 3_600_000) }); while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!); return value;
}
function initials(name: string) { const values = name.trim().split(/\s+/).filter(Boolean); return (values.length > 1 ? `${values[0][0]}${values.at(-1)![0]}` : values[0]?.slice(0, 2) || '?').toUpperCase(); }

export function AuthorAvatar({ name, email, size = 20, className = 'avatar' }: { name: string; email: string; size?: number; className?: string }) {
  const online = useAppStore((state) => state.bootstrap?.state.settings?.onlineAvatarsEnabled ?? false);
  const gravatar = useAppStore((state) => state.bootstrap?.state.settings?.gravatarEnabled ?? false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) setUrl(null); }); if (online && email.trim()) void cached(email, size, gravatar).then((value) => { if (active) setUrl(value); }); return () => { active = false; }; }, [email, gravatar, online, size]);
  const style = { width: size, height: size, flex: `0 0 ${size}px`, borderRadius: '50%', overflow: 'hidden', display: 'grid', placeItems: 'center', background: branchColor(email || name), color: '#fff', fontSize: size * .4 } as const;
  return url ? <img className={className} src={url} alt="" title={`${name}${email ? ` <${email}>` : ''}`} style={{ ...style, objectFit: 'cover' }} onError={() => setUrl(null)} /> : <span className={className} title={`${name}${email ? ` <${email}>` : ''}`} style={style}>{initials(name)}</span>;
}
