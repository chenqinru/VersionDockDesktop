import { useCallback, useEffect, useRef, useState } from 'react';
import type { RevisionChanges } from '../bindings/generated';
import type { VersionDockBridge } from '../platform/bridge';

type LoadState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'success'; data: RevisionChanges }
  | { key: string; status: 'error'; error: string };

/** Each sync direction owns its request, cancellation and bounded result cache. */
export function useSyncRevisionChanges({ bridge, workspaceId, repoId, revision, hashes, direction, enabled }: {
  bridge?: VersionDockBridge;
  workspaceId?: string;
  repoId: string;
  revision: string;
  hashes: string;
  direction: 'outgoing' | 'incoming';
  enabled: boolean;
}) {
  const key = `${workspaceId ?? ''}\0${repoId}\0${revision}\0${direction}\0${hashes}`;
  const cache = useRef(new Map<string, RevisionChanges>());
  const [state, setState] = useState<LoadState>();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(current => current + 1), []);

  useEffect(() => {
    if (!enabled || !hashes || !bridge || !workspaceId) return;
    let active = true;
    const controller = new AbortController();
    // Queue the start so effect replay can cancel without creating a native request.
    queueMicrotask(() => {
      if (!active) return;
      const cached = cache.current.get(key);
      if (cached) { setState({ key, status: 'success', data: cached }); return; }
      setState({ key, status: 'loading' });
      void bridge.request<RevisionChanges>(direction === 'outgoing'
        ? { type: 'unpushedChanges', payload: { workspace_id: workspaceId, repo_id: repoId, oldest_revision: hashes.split(',').at(-1) ?? null } }
        : { type: 'incomingChanges', payload: { workspace_id: workspaceId, repo_id: repoId } }, { signal: controller.signal })
        .then(data => {
          if (!active) return;
          cache.current.set(key, data);
          if (cache.current.size > 16) cache.current.delete(cache.current.keys().next().value!);
          setState({ key, status: 'success', data });
        })
        .catch((error: unknown) => {
          // Local cleanup suppresses obsolete results; external cancellation and
          // native timeouts remain visible failures with an explicit retry.
          if (active) setState({ key, status: 'error', error: String(error) });
        });
    });
    return () => { active = false; controller.abort(); };
  }, [attempt, bridge, direction, enabled, hashes, key, repoId, workspaceId]);

  const current = state?.key === key ? state : undefined;
  const data = current?.status === 'success' ? current.data : undefined;
  return {
    data,
    loading: enabled && Boolean(hashes && bridge && workspaceId) && !data && current?.status !== 'error',
    error: current?.status === 'error' ? current.error : undefined,
    retry,
  };
}
