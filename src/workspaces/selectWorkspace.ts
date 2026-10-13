import { choiceDialog, currentDialog } from '../components/dialogService';
import type { VersionDockBridge } from '../platform/bridge';

/** Native dialogs select either folders or files, so share the type choice across entry points. */
export async function selectWorkspacePaths(
  bridge: Pick<VersionDockBridge, 'selectWorkspaceFolders' | 'selectWorkspaceFile'>,
  t: (message: string) => string,
): Promise<string[]> {
  if (currentDialog()) return [];
  const kind = await choiceDialog({
    title: t('Open Workspace'),
    message: t('Open local folders or a .code-workspace file.'),
    choices: [
      { id: 'folders', label: t('Open Local Folder'), description: t('Open a folder to discover Git and SVN repositories.'), icon: 'folder-opened' },
      { id: 'file', label: t('Open VS Code Workspace'), description: t('Open a .code-workspace file and its local folders.'), icon: 'file-code' },
    ],
  });
  if (kind === 'folders') return bridge.selectWorkspaceFolders(t('Open Workspace'));
  if (kind === 'file') {
    const path = await bridge.selectWorkspaceFile(t('Open Workspace'));
    return path ? [path] : [];
  }
  return [];
}
