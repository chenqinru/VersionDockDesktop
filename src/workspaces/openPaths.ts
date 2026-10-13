import type { WorkspaceDescriptor } from '../bindings/generated';

export function workspaceOpenPaths(workspace: WorkspaceDescriptor): string[] {
  return workspace.workspaceFile ? [workspace.workspaceFile] : workspace.paths;
}
