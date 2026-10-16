import type { LogEntry } from '../bindings/generated';

/** undefined means all, null means application, and a string selects one workspace. */
export function matchesNotificationScope(item: { workspaceId?: string | null }, workspaceId?: string | null): boolean {
  return workspaceId === undefined || (workspaceId === null ? !item.workspaceId : item.workspaceId === workspaceId);
}

export function isApplicationLog(entry: LogEntry): boolean {
  return !entry.context?.workspaceId && !entry.cwd;
}
