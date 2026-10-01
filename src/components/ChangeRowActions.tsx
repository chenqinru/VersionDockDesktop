import type { FileChange, RepositoryStatus } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { confirmDialog } from './dialogService';

export function ChangeRowActions({ repo, file, onOpenFile, onRollback, onResolve, onStage }: {
  repo: RepositoryStatus;
  file: FileChange;
  onOpenFile?: () => void;
  onRollback?: () => void;
  onResolve?: () => void;
  onStage?: () => void;
}) {
  const { t } = useI18n();
  if (file.submodule) return null;
  const rollback = async () => {
    if (onRollback) { onRollback(); return; }
    const workspaceId = useAppStore.getState().snapshot?.workspace.id;
    if (await confirmDialog({ title: t('Rollback'), message: t('Discard changes to {0} files? This cannot be undone.', 1) + `\n\n${repo.meta.name}: ${file.path}`, danger: true }) && useAppStore.getState().snapshot?.workspace.id === workspaceId) {
      await useAppStore.getState().discard(repo.meta.id, [file.path]);
      useAppStore.getState().setCommitSelection(repo.meta.id, [file.path], false);
    }
  };
  const resolve = () => {
    if (onResolve) { onResolve(); return; }
    const store = useAppStore.getState();
    const conflict = store.conflicts.find((entry) => entry.repoId === repo.meta.id && entry.path === file.path);
    if (conflict) void store.openMerge(conflict);
  };
  return <span className="change-row-actions" onClick={(event) => event.stopPropagation()}>
    {file.conflicted && <button type="button" className="conflict-resolve-action" title={t('Resolve Conflicts')} aria-label={`${t('Resolve Conflicts')}: ${file.path}`} onClick={resolve}><Codicon name="git-merge" /></button>}
    <button type="button" title={t('Jump to Source')} onClick={() => onOpenFile ? onOpenFile() : void useAppStore.getState().systemOpen(repo.meta.id, file.path, false)}><Codicon name="go-to-file" /></button>
    {!file.isTruncated && <button type="button" title={t('Rollback')} onClick={() => void rollback()}><Codicon name="discard" /></button>}
    {repo.meta.kind === 'svn' && file.status === 'untracked' && !file.staged && <button type="button" title={t(file.isTruncated ? 'Add directory recursively to SVN' : 'Add to SVN')} onClick={() => onStage ? onStage() : void useAppStore.getState().stage(repo.meta.id, [file.path], Boolean(file.isTruncated))}><Codicon name="add" /></button>}
  </span>;
}

export function ChangeFolderActions({ repo, files }: { repo: RepositoryStatus; files: FileChange[] }) {
  const { t } = useI18n();
  const rollback = async () => {
    const selectable = files.filter((file) => !file.isTruncated);
    if (!selectable.length) return;
    const workspaceId = useAppStore.getState().snapshot?.workspace.id;
    const confirmed = await confirmDialog({ title: t('Rollback'), message: t('Discard changes to {0} files? This cannot be undone.', selectable.length) + '\n\n' + selectable.map((file) => `${repo.meta.name}: ${file.path}`).join('\n'), danger: true });
    if (!confirmed || useAppStore.getState().snapshot?.workspace.id !== workspaceId) return;
    const paths = selectable.map((file) => file.path);
    await useAppStore.getState().discard(repo.meta.id, paths);
    useAppStore.getState().setCommitSelection(repo.meta.id, paths, false);
  };
  return <span className="change-row-actions" onClick={(event) => event.stopPropagation()}><button type="button" title={t('Rollback all files in folder')} onClick={() => void rollback()}><Codicon name="discard" /></button></span>;
}
