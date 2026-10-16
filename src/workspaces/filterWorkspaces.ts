import type { WorkspaceDescriptor } from '../bindings/generated';

/** Keep recent-workspace search consistent across the welcome page and switcher. */
export function filterWorkspaces(workspaces: WorkspaceDescriptor[], query: string): WorkspaceDescriptor[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return workspaces;
  return workspaces.filter(workspace => [workspace.name, workspace.workspaceFile, ...workspace.paths]
    .some(value => value?.toLocaleLowerCase().includes(needle)));
}
