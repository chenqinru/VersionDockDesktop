import type { RemoteInfo } from '../bindings/generated';
import type { VersionDockBridge } from '../platform/bridge';

type Entry = { value: string | null; expires: number };
export interface AuthorAvatarContext {
  bridge: VersionDockBridge | null;
  workspaceId?: string;
  repoId?: string;
  remoteScope: string;
  gravatar: boolean;
  crossPlatformFallback: boolean;
}
const STORAGE = 'versiondock.author-avatars.v1';
const POSITIVE_TTL = 24 * 60 * 60_000, NEGATIVE_TTL = 10 * 60_000;
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string | null>>();
const listeners = new Set<(values: Map<string, string>) => void>();
let epoch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
interface Item { key: string; email: string; names: Set<string>; size: number; finish: Array<(value: string | null) => void> }
interface Batch { context: AuthorAvatarContext; epoch: number; items: Map<string, Item> }
const batches = new Map<string, Batch>();

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Record<string, Entry>;
  for (const [key, entry] of Object.entries(saved)) {
    if (entry && typeof entry.expires === 'number' && entry.expires > Date.now() && typeof entry.value === 'string' && /^https?:\/\//.test(entry.value)) cache.set(key, entry);
  }
} catch { /* Storage is optional. */ }

export function avatarIdentity(email: string, name: string) {
  return email.trim() ? `email:${email.trim().toLowerCase()}` : `name:${name.trim().toLowerCase()}`;
}
export function authorAvatarRemoteScope(branch?: string | null, upstream?: string | null, remotes?: RemoteInfo[]) {
  return JSON.stringify([branch, upstream, remotes?.map(remote => [remote.name, remote.fetchUrl, remote.pushUrl])]);
}
export function authorAvatarScope(context: AuthorAvatarContext) {
  return JSON.stringify([context.workspaceId, context.repoId, context.remoteScope, context.gravatar, context.crossPlatformFallback]);
}
export function authorAvatarKey(context: AuthorAvatarContext, email: string, name: string) {
  return `${authorAvatarScope(context)}\0${avatarIdentity(email, name)}`;
}
export const authorAvatarEpoch = () => epoch;
export function peekAuthorAvatar(key: string) {
  const entry = cache.get(key);
  return entry?.value && entry.expires > Date.now() ? entry.value : null;
}
export function subscribeAuthorAvatars(listener: (values: Map<string, string>) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function persist() {
  while (cache.size > 1000) cache.delete(cache.keys().next().value!);
  try {
    localStorage.setItem(STORAGE, JSON.stringify(Object.fromEntries([...cache].filter(([, entry]) => entry.expires > Date.now() && entry.value && /^https?:\/\//.test(entry.value)))));
  } catch { /* Private data URLs stay in memory/native disk cache. */ }
}
export function primeAuthorAvatars(context: AuthorAvatarContext, avatars: Record<string, string> = {}) {
  const values = new Map<string, string>();
  for (const [identity, value] of Object.entries(avatars)) {
    const key = `${authorAvatarScope(context)}\0${identity}`;
    if (typeof value !== 'string') continue;
    cache.set(key, { value, expires: Date.now() + POSITIVE_TTL });
    values.set(key, value);
  }
  persist();
  if (values.size) listeners.forEach(listener => listener(values));
}
function reset() {
  epoch++;
  cache.clear();
  inFlight.clear();
  if (timer) clearTimeout(timer);
  timer = undefined;
  for (const batch of batches.values()) for (const item of batch.items.values()) item.finish.forEach(resolve => resolve(null));
  batches.clear();
  try { localStorage.removeItem(STORAGE); } catch { /* Optional storage. */ }
}
if (typeof window !== 'undefined') window.addEventListener('versiondock-avatar-cache-clear', reset);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('versiondock-avatar-cache-clear', reset));
export async function clearAuthorAvatarCache(bridge: VersionDockBridge) {
  const before = epoch;
  await bridge.request({ type: 'clearAuthorAvatarCache' }, { showProgress: false });
  if (epoch === before) window.dispatchEvent(new Event('versiondock-avatar-cache-clear'));
}
function validateImage(url: string): Promise<string | null> {
  return new Promise(resolve => {
    const image = new Image();
    const finish = (value: string | null) => { clearTimeout(timeout); image.onload = null; image.onerror = null; resolve(value); };
    const timeout = setTimeout(() => finish(null), 8000);
    image.onload = () => finish(url); image.onerror = () => finish(null); image.src = url;
  });
}
async function fallback(context: AuthorAvatarContext, email: string, size: number) {
  if (!context.repoId && email.toLowerCase().endsWith('@users.noreply.github.com')) {
    const username = email.split('@')[0].split('+').at(-1);
    if (username) { const image = await validateImage(`https://avatars.githubusercontent.com/${encodeURIComponent(username)}?size=${Math.max(size, 40) * 2}`); if (image) return image; }
  }
  if (!context.gravatar || !email.trim()) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  const hash = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  return validateImage(`https://www.gravatar.com/avatar/${hash}?s=${Math.max(size, 40) * 2}&d=404`);
}
async function flush(batch: Batch) {
  const items = [...batch.items.values()];
  const { context } = batch;
  let results: Record<string, string | null> = {};
  if (context.bridge && context.workspaceId && context.repoId) {
    results = await context.bridge.request<Record<string, string | null>>({ type: 'resolveAuthorAvatars', payload: { workspace_id: context.workspaceId, repo_id: context.repoId, authors: items.flatMap(item => [...item.names].map(name => ({ email: item.email, name }))) } }, { showProgress: false }).catch(() => ({})) ?? {};
  }
  // Preload every image before publishing any result from this repository batch.
  const settled = await Promise.all(items.map(async item => {
    const remote = results[avatarIdentity(item.email, [...item.names][0])];
    const shared = peekAuthorAvatar(item.key);
    const value = shared || (remote ? await validateImage(remote) : null) || await fallback(context, item.email, item.size).catch(() => null);
    return { item, value };
  }));
  const values = new Map<string, string>();
  if (batch.epoch === epoch) {
    for (const { item, value } of settled) {
      if (value) { cache.set(item.key, { value, expires: Date.now() + POSITIVE_TTL }); values.set(item.key, value); }
      else for (const name of item.names) cache.set(`${item.key}\0${name.trim().toLowerCase()}`, { value: null, expires: Date.now() + NEGATIVE_TTL });
    }
    persist();
    if (values.size) listeners.forEach(listener => listener(values));
  }
  for (const { item, value } of settled) item.finish.forEach(resolve => resolve(batch.epoch === epoch ? peekAuthorAvatar(item.key) ?? value : null));
}
export function requestAuthorAvatar(context: AuthorAvatarContext, email: string, name: string, size: number): Promise<string | null> {
  const key = authorAvatarKey(context, email, name);
  const shared = peekAuthorAvatar(key); if (shared) return Promise.resolve(shared);
  const attemptKey = `${key}\0${name.trim().toLowerCase()}`;
  const miss = cache.get(attemptKey); if (miss && miss.expires > Date.now()) return Promise.resolve(null);
  const existing = inFlight.get(attemptKey); if (existing) return existing;
  let batch = batches.get(authorAvatarScope(context));
  if (!batch) { batch = { context, epoch, items: new Map() }; batches.set(authorAvatarScope(context), batch); }
  let item = batch.items.get(key);
  if (!item) { item = { key, email, names: new Set(), size, finish: [] }; batch.items.set(key, item); }
  item.names.add(name); item.size = Math.max(item.size, size);
  const request = new Promise<string | null>(resolve => item!.finish.push(resolve));
  inFlight.set(attemptKey, request);
  void request.finally(() => { if (inFlight.get(attemptKey) === request) inFlight.delete(attemptKey); });
  if (!timer) timer = setTimeout(() => {
    timer = undefined;
    const pending = [...batches.values()]; batches.clear();
    pending.forEach(batch => { void flush(batch); });
  }, 60);
  return request;
}

export function invalidateAuthorAvatar(key: string) { cache.delete(key); persist(); }
