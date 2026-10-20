import type { HookConnection, TaskWorkspace } from '../bindings/generated';

export function taskConnection(task: TaskWorkspace | undefined, connections?: Record<string, HookConnection> | null): HookConnection {
  if (!task) return { status: 'notConfigured', verifiedAt: null, error: null };
  if (task.mode === 'manual') return { status: 'manual', verifiedAt: null, error: null };
  return connections?.[task.id] ?? { status: task.hookError ? 'error' : 'unverified', verifiedAt: null, error: task.hookError };
}
export const connectionLabel = (status: string) => ({ notConfigured: 'Not configured', manual: 'Manual recording', notInstalled: 'Hooks not installed', invalid: 'Hook configuration invalid', verified: 'Hooks verified', unverified: 'Unverified', error: 'Hook error' })[status] ?? 'Unverified';

export const compactConnectionLabel = (status: string) => ({ notConfigured: 'Not configured', manual: 'Hook state: manual', notInstalled: 'Hook state: not installed', invalid: 'Hook state: error', verified: 'Hook state: verified', unverified: 'Unverified', error: 'Hook state: error' })[status] ?? 'Unverified';
