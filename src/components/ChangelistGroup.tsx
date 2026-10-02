import { IconButton } from './IconButton';
import { RepositoryBranchBadge } from './RepositoryBranchBadge';
import { ChangeRowActions, ChangeFolderActions } from './ChangeRowActions';
import { ChangeRowHighlightContext, useChangeRowHighlight } from './changeRowHighlight';
import { useContext, useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { BranchMenuPopover } from './StatusBar/BranchMenuPopover';
import { useI18n } from '../i18n';
import { buildFileTree, type FileTreeNode } from './fileTree';
import type { FileChange, RepositoryStatus } from '../bindings/generated';
import { SelectionCheckbox } from './SelectionCheckbox';
import { useAppStore } from '../store/appStore';
import { hasMixedRepositoryKinds } from './repoLabel';

export type ExpansionCommand = { sequence: number; expanded: boolean };

export function StatusMark({ file }: { file: FileChange }) {
  const value = file.conflicted ? 'C' : file.status === 'untracked' ? 'U' : file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M';
  return <span className={`status-mark status-${file.status}`}>{value}</span>;
}

export function TreeNode({
  node,
  depth,
  basePad = 20,
  repo,
  selected,
  setFiles,
  onFile,
  onContext,
  onFolderContext,
  expansion,
}: {
  node: FileTreeNode;
  depth: number;
  basePad?: number;
  repo: RepositoryStatus;
  selected: Set<string>;
  setFiles: (repoId: string, paths: string[], value: boolean) => void;
  onFile: (file: FileChange) => void;
  onContext: (event: React.MouseEvent, file: FileChange) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[]) => void;
  expansion: ExpansionCommand;
}) {
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  const currentPad = basePad + depth * 20;
  const highlight = useChangeRowHighlight(repo.meta.id, node.path);

  if (!node.file) {
    const selectable = node.files.filter((file) => !file.isTruncated);
    const selectedCount = selectable.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
    const allSelected = selectable.length > 0 && selectedCount === selectable.length;
    return (
      <div className="tree-directory">
        <div
          className={`directory-row ${highlight}`}
          style={{ paddingLeft: currentPad }}
          onClick={() => setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded })}
          onContextMenu={(event) => onFolderContext(event, node.path, node.files)}
        >
          <SelectionCheckbox
            label={node.path}
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            disabled={!selectable.length}
            onChange={() => setFiles(repo.meta.id, selectable.map((file) => file.path), !allSelected)}
          />
          <button title={node.path} onClick={(event) => { event.stopPropagation(); setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded }); }}>
            <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
            <FileIcon name={node.name} folder open={expanded} />
            <span>{node.name}</span>
          </button>
          <ChangeFolderActions repo={repo} files={node.files} />
          <b>{node.files.length}</b>
        </div>
        {expanded &&
          node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              basePad={basePad}
              repo={repo}
              selected={selected}
              setFiles={setFiles}
              onFile={onFile}
              onContext={onContext}
              onFolderContext={onFolderContext}
              expansion={expansion}
            />
          ))}
      </div>
    );
  }

  const key = `${repo.meta.id}\0${node.file.path}`;
  return (
    <div
      className={`file-row status-${node.file.status} ${node.file.conflicted ? 'conflicted' : ''} ${highlight}`}
      style={{ paddingLeft: currentPad }}
      onClick={() => onFile(node.file!)}
      onContextMenu={(event) => onContext(event, node.file!)}
    >
      <SelectionCheckbox
        label={node.file.path}
        checked={selected.has(key)}
        disabled={node.file.isTruncated}
        onChange={() => setFiles(repo.meta.id, [node.file!.path], !selected.has(key))}
      />
      <button title={node.file.path} onClick={() => onFile(node.file!)}>
        <FileIcon name={node.name} />
        <span className="file-name-group">
          <span className="file-name">{node.name}</span>
        </span>
      </button>
      <ChangeRowActions repo={repo} file={node.file} />
      {node.file.staged && <span className="staged-dot" />}
      <StatusMark file={node.file} />
    </div>
  );
}

export interface ChangelistRepoGroup {
  repo: RepositoryStatus;
  files: FileChange[];
}

export interface ChangelistGroupProps {
  id: string;
  name: string;
  isDefault?: boolean;
  isUnversioned?: boolean;
  repoGroups: ChangelistRepoGroup[];
  multiRepo: boolean;
  singleRepo: boolean;
  selected: Set<string>;
  setFiles: (repoId: string, paths: string[], value: boolean) => void;
  onFile: (repoId: string, file: FileChange) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus) => void;
  onRepoContext: (event: React.MouseEvent, repo: RepositoryStatus, changelistId?: string) => void;
  onHeaderContextMenu: (event: React.MouseEvent, changelistId: string) => void;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  openWorkingChanges: (repoId: string) => void;
}

export function ChangelistGroup({
  id,
  name,
  isDefault = false,
  isUnversioned = false,
  repoGroups,
  multiRepo,
  singleRepo,
  selected,
  setFiles,
  onFile,
  onContext,
  onFolderContext,
  onRepoContext,
  onHeaderContextMenu,
  viewMode,
  expansion,
  openWorkingChanges,
}: ChangelistGroupProps) {
  const { t } = useI18n();
  const allFilesWithRepo = useMemo(
    () => repoGroups.flatMap((g) => g.files.filter((f) => !f.isTruncated).map((f) => ({ repoId: g.repo.meta.id, path: f.path }))),
    [repoGroups],
  );
  const totalFiles = allFilesWithRepo.length;
  const selectedCount = allFilesWithRepo.filter((f) => selected.has(`${f.repoId}\0${f.path}`)).length;
  const allSelected = totalFiles > 0 && selectedCount === totalFiles;

  const [localExpanded, setLocalExpanded] = useState<ExpansionCommand>(() => ({
    sequence: 0,
    expanded: totalFiles > 0 || isDefault,
  }));
  const expanded = localExpanded.sequence === expansion.sequence ? localExpanded.expanded : expansion.expanded;

  const toggleAll = () => {
    const nextVal = !allSelected;
    for (const group of repoGroups) {
      const selectable = group.files.filter((file) => !file.isTruncated);
      if (selectable.length > 0) {
        setFiles(group.repo.meta.id, selectable.map((f) => f.path), nextVal);
      }
    }
  };

  const headerIcon = isUnversioned ? 'question' : isDefault ? 'source-control' : 'list-unordered';

  return (
    <section className="repo-change-group changelist-group">
      <div
        className="repo-heading changelist-heading"
        onClick={(event) => { if (!(event.target as HTMLElement).closest('button, input, label')) setLocalExpanded({ sequence: expansion.sequence, expanded: !expanded }); }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onHeaderContextMenu(e, id);
        }}
      >
        <SelectionCheckbox
          label={name}
          checked={allSelected}
          indeterminate={selectedCount > 0 && !allSelected}
          disabled={totalFiles === 0}
          onChange={toggleAll}
        />
        <button
          title={name}
          aria-expanded={expanded}
          onClick={() => setLocalExpanded({ sequence: expansion.sequence, expanded: !expanded })}
        >
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
          <Codicon
            name={headerIcon}
            style={{
              color: isUnversioned
                ? 'var(--vscode-descriptionForeground, #888)'
                : 'inherit',
            }}
          />
          <strong>{name}</strong>
        </button>
        {totalFiles > 0 && (
          <span className={`count-badge ${selectedCount > 0 ? 'selected' : ''}`}>
            {selectedCount}/{totalFiles}
          </span>
        )}
      </div>

      {expanded && totalFiles === 0 && (
        <div className="repo-no-changes">{t('No files in this changelist')}</div>
      )}

      {expanded && singleRepo && repoGroups.length > 0 && (
        <SingleRepoFileList
          repo={repoGroups[0].repo}
          files={repoGroups[0].files}
          basePad={20}
          selected={selected}
          setFiles={setFiles}
          onFile={onFile}
          onContext={onContext}
          onFolderContext={onFolderContext}
          viewMode={viewMode}
          expansion={expansion}
        />
      )}

      {expanded && multiRepo && (
        <div className="changelist-repo-subgroups">
          {repoGroups.map((group) => (
            <RepoSubGroup
              key={group.repo.meta.id}
              repo={group.repo}
              files={group.files}
              changelistId={id}
              selected={selected}
              setFiles={setFiles}
              onFile={onFile}
              onContext={onContext}
              onFolderContext={onFolderContext}
              onRepoContext={onRepoContext}
              viewMode={viewMode}
              expansion={expansion}
              openWorkingChanges={openWorkingChanges}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SingleRepoFileList({
  repo,
  files,
  basePad = 20,
  selected,
  setFiles,
  onFile,
  onContext,
  onFolderContext,
  viewMode,
  expansion,
}: {
  repo: RepositoryStatus;
  files: FileChange[];
  basePad?: number;
  selected: Set<string>;
  setFiles: (repoId: string, paths: string[], value: boolean) => void;
  onFile: (repoId: string, file: FileChange) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus) => void;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const highlight = useContext(ChangeRowHighlightContext);

  if (viewMode === 'tree') {
    return (
      <>
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            basePad={basePad}
            repo={repo}
            selected={selected}
            setFiles={setFiles}
            onFile={(f) => onFile(repo.meta.id, f)}
            onContext={(e, f) => onContext(e, f, repo)}
            onFolderContext={(e, p, fs) => onFolderContext(e, p, fs, repo)}
            expansion={expansion}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {files.map((file) => {
        const key = `${repo.meta.id}\0${file.path}`;
        const parts = file.path.split('/');
        const fileName = parts.pop();
        return (
          <div
            className={`file-row status-${file.status} ${file.conflicted ? 'conflicted' : ''} ${highlight.selected?.repoId === repo.meta.id && highlight.selected.path === file.path ? 'selected' : highlight.context?.repoId === repo.meta.id && highlight.context.path === file.path ? 'context-active' : ''}`}
            style={{ paddingLeft: basePad }}
            key={key}
            onClick={() => onFile(repo.meta.id, file)}
            onContextMenu={(event) => onContext(event, file, repo)}
          >
            <SelectionCheckbox
              label={file.path}
              checked={selected.has(key)}
              disabled={file.isTruncated}
              onChange={() => setFiles(repo.meta.id, [file.path], !selected.has(key))}
            />
            <button title={file.path} onClick={() => onFile(repo.meta.id, file)}>
              <FileIcon name={fileName ?? file.path} />
              <span className="file-name-group">
                <span className="file-name">{fileName}</span>
                <small>{parts.join('/')}</small>
              </span>
            </button>
            <ChangeRowActions repo={repo} file={file} />
            {file.staged && <span className="staged-dot" />}
            <StatusMark file={file} />
          </div>
        );
      })}
    </>
  );
}

function RepoSubGroup({
  repo,
  files,
  changelistId,
  selected,
  setFiles,
  onFile,
  onContext,
  onFolderContext,
  onRepoContext,
  viewMode,
  expansion,
  openWorkingChanges,
}: {
  repo: RepositoryStatus;
  files: FileChange[];
  changelistId: string;
  selected: Set<string>;
  setFiles: (repoId: string, paths: string[], value: boolean) => void;
  onFile: (repoId: string, file: FileChange) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus) => void;
  onRepoContext: (event: React.MouseEvent, repo: RepositoryStatus, changelistId?: string) => void;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  openWorkingChanges: (repoId: string) => void;
}) {
  const { t } = useI18n();
  const [localExpanded, setLocalExpanded] = useState<ExpansionCommand>(() => ({
    sequence: 0,
    expanded: files.length > 0,
  }));
  const expanded = localExpanded.sequence === expansion.sequence ? localExpanded.expanded : expansion.expanded;

  const totalFiles = files.length;
  const selectableFiles = files.filter((file) => !file.isTruncated);
  const selectedCount = selectableFiles.filter((file) => selected.has(`${repo.meta.id}\0${file.path}`)).length;
  const allSelected = selectableFiles.length > 0 && selectedCount === selectableFiles.length;
  const [hovered, setHovered] = useState(false);
  const [branchMenuAnchor, setBranchMenuAnchor] = useState<DOMRect | undefined>(undefined);
  const mixedKinds = useAppStore((state) => hasMixedRepositoryKinds(state.snapshot?.repositories ?? []));

  return (
    <div className="repo-sub-group" style={{ margin: 0 }}>
      <div
        className="repo-heading"
        style={{
          '--repo-color': repo.meta.color,
          paddingLeft: 18,
        } as React.CSSProperties}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(event) => { if (!(event.target as HTMLElement).closest('button, input, label')) setLocalExpanded({ sequence: expansion.sequence, expanded: !expanded }); }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRepoContext(e, repo, changelistId);
        }}
      >
        <SelectionCheckbox
          label={repo.meta.name}
          checked={allSelected}
          indeterminate={selectedCount > 0 && !allSelected}
          disabled={selectableFiles.length === 0}
          onChange={() => setFiles(repo.meta.id, selectableFiles.map((f) => f.path), !allSelected)}
        />
        <div className="repo-heading-main">
          <button
            type="button"
            className="repo-heading-toggle"
            title={repo.meta.name}
            aria-expanded={expanded}
            onClick={() => setLocalExpanded({ sequence: expansion.sequence, expanded: !expanded })}
          >
            <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
            <i style={{ background: repo.meta.color }} />
            <strong>{repo.meta.name}</strong>
          </button>
          {repo.meta.isSubmodule && (
            <span className="submodule-badge" title={t('Submodule')}>
              {t('SUB')}
            </span>
          )}
          {mixedKinds && (
            <span
              className={`vcs-badge ${repo.meta.kind === 'svn' ? 'svn' : 'git'}`}
              title={repo.meta.kind === 'svn' ? t('SVN working copy') : 'Git'}
            >
              {repo.meta.kind === 'svn' ? 'SVN' : 'GIT'}
            </span>
          )}
          <button
            type="button"
            className="repo-branch-trigger"
            data-branch-switch-badge=""
            title={t('Switch branch')}
            aria-haspopup="menu"
            aria-expanded={Boolean(branchMenuAnchor)}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setBranchMenuAnchor((cur) => (cur ? undefined : rect));
            }}
          >
            <RepositoryBranchBadge repo={repo} className="branch-chip" />
          </button>
        </div>
        {branchMenuAnchor && (
          <BranchMenuPopover
            anchorRect={branchMenuAnchor}
            initialRepoId={repo.meta.id}
            repoOnly
            onClose={() => setBranchMenuAnchor(undefined)}
          />
        )}
        <div className="repo-actions">
          {files.length > 0 && (
            <IconButton
              className="repo-open-changes"
              style={{
                opacity: hovered ? 1 : 0,
                pointerEvents: hovered ? 'auto' : 'none',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                color: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
              }}
              title={t('Open all changes')}
              onClick={(e) => {
                e.stopPropagation();
                openWorkingChanges(repo.meta.id);
              }}
            >
              <Codicon name="diff-multiple" />
            </IconButton>
          )}
          {totalFiles > 0 && (
            <span className={`count-badge ${selectedCount > 0 ? 'selected' : ''}`}>
              {selectedCount}/{totalFiles}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <SingleRepoFileList
          repo={repo}
          files={files}
          basePad={36}
          selected={selected}
          setFiles={setFiles}
          onFile={onFile}
          onContext={onContext}
          onFolderContext={onFolderContext}
          viewMode={viewMode}
          expansion={expansion}
        />
      )}
    </div>
  );
}
