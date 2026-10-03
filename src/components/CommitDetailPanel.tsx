import { AiExplanation } from './AiExplanation';
import { useAiStore } from '../ai/aiStore';
import { AiCommitComposerIcon } from './AiCommitComposerIcon';
import { IconButton } from './IconButton';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { useAppStore, type AppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { buildCommitFileTargets, commitKey, type DetailFileTarget } from '../history/commitDetails';
import type { CommitDetail, CommitNode, CommitPathOperationEntry, MergeParentChange, RepositoryStatus } from '../bindings/generated';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { confirmDialog } from './dialogService';
import { AuthorAvatar } from './AuthorAvatar';
import { branchColor, headColor, isPrimaryBranch, tagColor } from './branchColor';
import { BranchRefBadge } from './BranchRefBadge';
import { useFileSearch } from '../hooks/useFileSearch';
import { useResizable } from '../hooks/useResizable';
import { FileSearchWidget } from './FileSearchWidget';

type DetailTreeNode = { name: string; path: string; key: string; children: DetailTreeNode[]; file?: DetailFileTarget; fileCount: number };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusClass(status: string): string {
  const value = status.replace(/\d+$/, '').slice(0, 1).toUpperCase();
  return value === 'A' || value === 'C' ? 'added' : value === 'D' ? 'deleted' : value === 'R' ? 'renamed' : 'modified';
}

function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query || !query.trim()) return <>{text}</>;
  const trimmed = query.trim();
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index === -1) return <>{text}</>;
  const before = text.slice(0, index);
  const match = text.slice(index, index + trimmed.length);
  const after = text.slice(index + trimmed.length);
  return (
    <>
      {before}
      <mark className="search-match-highlight" style={{ background: 'var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.35))', color: 'inherit', borderRadius: 2 }}>{match}</mark>
      {after}
    </>
  );
}

function refLabel(ref: string): string {
  return ref
    .replace('HEAD -> ', '')
    .replace('tag: ', '')
    .replace('refs/heads/', '')
    .replace('refs/remotes/', '')
    .replace('refs/tags/', '');
}

type DetailRef = {
  value: string;
  label: string;
  kind: 'branch' | 'remote' | 'tag' | 'head' | 'revision';
  source: 'commit' | 'containing';
  isSvnRevision?: boolean;
};

function refsFor(detail: CommitDetail, repoKind?: 'git' | 'svn'): DetailRef[] {
  const local = new Set(detail.branches.local);
  const remote = new Set(detail.branches.remote.filter((branch) => !branch.endsWith('/HEAD')));
  const tags = new Set(detail.branches.tags);
  const isSvn = repoKind === 'svn';
  const values: Array<{ value: string; source: DetailRef['source'] }> = [
    ...(detail.branches.isHead ? [{ value: 'HEAD', source: 'commit' as const }] : []),
    ...detail.commit.refs.map((value) => ({ value, source: 'commit' as const })),
    ...detail.branches.local.map((branch) => ({ value: `refs/heads/${branch}`, source: 'containing' as const })),
    ...[...remote].map((branch) => ({ value: `refs/remotes/${branch}`, source: 'containing' as const })),
    ...detail.branches.tags.map((tag) => ({ value: `refs/tags/${tag}`, source: 'containing' as const })),
  ];
  const refs = values.flatMap(({ value, source }): DetailRef[] => {
    const label = refLabel(value);
    if (isSvn && (value === 'HEAD' || value === 'BASE' || label === 'HEAD' || label === 'BASE')) {
      return [{ value, label, kind: 'revision', source, isSvnRevision: true }];
    }
    if (value.startsWith('refs/remotes/') && label.endsWith('/HEAD')) return [];
    if (!value.startsWith('refs/') && label.endsWith('/HEAD') && !local.has(label)) return [];
    if (value === 'HEAD' || value.startsWith('HEAD -> ')) return [{ value, label: 'HEAD', kind: 'head', source }];
    if (value.startsWith('tag: ') || value.startsWith('refs/tags/') || tags.has(label)) return [{ value, label, kind: 'tag', source }];
    if (value.startsWith('refs/remotes/') || remote.has(label)) return [{ value, label, kind: 'remote', source }];
    return [{ value, label, kind: 'branch', source }];
  });
  const unique = [...new Map(refs.map((ref) => [`${ref.kind}:${ref.label}`, ref])).values()];
  const rank = (ref: DetailRef): number => {
    if (ref.kind === 'revision') return 0;
    if (ref.kind === 'head') return 1;
    if (ref.kind === 'tag' && ref.source === 'commit') return 2;
    if (ref.kind === 'branch') return isPrimaryBranch(ref.label) ? 3 : 4;
    if (ref.kind === 'remote') {
      const primary = ['main', 'master', 'trunk', 'develop', 'dev', 'release']
        .some((name) => ref.label.toLowerCase() === name || ref.label.toLowerCase().endsWith(`/${name}`));
      return primary ? 5 : 6;
    }
    return 7;
  };
  return unique.sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label));
}

function sortTreeNodes(nodes: DetailTreeNode[]): DetailTreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortTreeNodes(node.children),
    }))
    .sort((left, right) => {
      if (!left.file && right.file) return -1;
      if (left.file && !right.file) return 1;
      return left.name.localeCompare(right.name);
    });
}

function buildTree(files: DetailFileTarget[], keyPrefix?: string): DetailTreeNode[] {
  const root: DetailTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let nodes = root;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let node = nodes.find((item) => item.name === name);
      if (!node) {
        const key = keyPrefix ? `${keyPrefix}:${path}` : path;
        node = { name, path, key, children: [], fileCount: 0 };
        nodes.push(node);
      }
      if (index === parts.length - 1) node.file = file;
      nodes = node.children;
    });
  }
  const count = (node: DetailTreeNode): number => node.file ? 1 : node.children.reduce((total, child) => total + count(child), 0);
  const visit = (nodes: DetailTreeNode[]) => nodes.forEach((node) => { node.fileCount = count(node); visit(node.children); });
  visit(root);
  return sortTreeNodes(root);
}

function collapseTree(node: DetailTreeNode): DetailTreeNode {
  if (node.file) return node;
  let current = { ...node, children: node.children.map(collapseTree) };
  while (!current.file && current.children.length === 1 && !current.children[0].file) {
    const child = current.children[0];
    current = { ...child, name: `${current.name}/${child.name}`, path: child.path, key: child.key };
  }
  return current;
}

function descendantFiles(node: DetailTreeNode): DetailFileTarget[] {
  if (node.file) return [node.file];
  return node.children.flatMap(descendantFiles);
}

function commitPathEntries(
  files: DetailFileTarget[],
  selectedCommits: CommitNode[],
  selectedDetails: Record<string, CommitDetail>,
  direction: 'apply' | 'revert',
): CommitPathOperationEntry[] {
  const paths = new Set(files.map((file) => `${file.repoId}\0${file.path}`));
  const commits = direction === 'apply' ? [...selectedCommits].reverse() : selectedCommits;
  const entries = commits.flatMap((commit) => {
    const detail = selectedDetails[commitKey(commit.repoId, commit.hash)];
    return (detail?.files ?? [])
      .filter((file) => paths.has(`${commit.repoId}\0${file.path}`))
      .map((file) => ({ revision: commit.hash, path: file.path, status: file.status }));
  });
  if (entries.length > 0) {
    return [...new Map(entries.map((entry) => [`${entry.revision}\0${entry.path}`, entry])).values()];
  }
  return [...new Map(files.map((file) => [`${file.commitHash}\0${file.path}`, {
    revision: file.commitHash,
    path: file.path,
    status: file.status,
  }])).values()];
}

function openTarget(target: DetailFileTarget, openDiff: AppStore['openDiff'], onOpening?: (path: string) => void): void {
  onOpening?.(target.path);
  const range = target.fromRevision && target.toRevision ? { fromRevision: target.fromRevision, toRevision: target.toRevision } : undefined;
  void openDiff(target.repoId, target.path, false, range ? undefined : target.commitHash, range);
}

function DetailFileContextMenu({ position, file, close, openDiff, workspaceView }: { workspaceView: boolean; position: { x: number; y: number }; file: DetailFileTarget; close: () => void; openDiff: AppStore['openDiff'] }) {
  const { t } = useI18n();
  const systemOpen = useAppStore((state) => state.systemOpen);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectedDetails = useAppStore((state) => state.selectedCommitDetails);
  const repoKind = useAppStore((state) => state.snapshot?.repositories.find((repo) => repo.meta.id === file.repoId)?.meta.kind);
  const isMergeParent = Boolean(file.isMergeParentDiff || file.comparisonBaseHash);
  const selectionWorkspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const canRevert = repoKind === 'git' && !isMergeParent && (!workspaceView || selectedCommits.length === 1);
  const canCherryPick = canRevert && !workspaceView;
  const items: ContextMenuEntry[] = [
    { id: 'diff', label: t('Show Diff'), icon: 'diff' },
    { id: 'open', label: t('Open file'), icon: 'go-to-file' },
    ...(!workspaceView ? [{ id: 'reveal', label: t('Reveal in File Manager'), icon: 'folder-opened' } as ContextMenuEntry] : []),
    ...(canRevert ? [
      { separator: true } as ContextMenuEntry,
      { id: 'revert-file', label: t('Revert Selected Changes'), icon: 'discard', danger: true } as ContextMenuEntry,
    ] : []),
    ...(canCherryPick ? [{ id: 'checkout-file', label: t('Cherry-Pick Selected Changes'), icon: 'git-commit' } as ContextMenuEntry] : []),
    ...(workspaceView ? [
      { separator: true } as ContextMenuEntry,
      { id: 'reveal', label: t('Reveal in File Manager'), icon: 'folder-opened' } as ContextMenuEntry,
    ] : []),
  ];
  return <ContextMenu x={position.x} y={position.y} items={items} onSelect={(id) => {
    if (id === 'diff') openTarget(file, openDiff);
    if (id === 'open') void systemOpen(file.repoId, file.path, false);
    if (id === 'reveal') void systemOpen(file.repoId, file.path, true);
    if (id === 'checkout-file') void confirmDialog({ title: t('Get file from revision?'), message: `${file.path}\n${file.commitHash}`, danger: true }).then((yes) => { if (yes && useAppStore.getState().snapshot?.workspace.id === selectionWorkspaceId) return historyOperation(file.repoId, { type: 'applyPaths', entries: commitPathEntries([file], selectedCommits, selectedDetails, 'apply') }); });
    if (id === 'revert-file') void confirmDialog({ title: t('Revert file to parent revision?'), message: `${file.path}\n\n${t('Current working-copy content will be replaced.')}`, danger: true }).then((yes) => { if (yes && useAppStore.getState().snapshot?.workspace.id === selectionWorkspaceId) return historyOperation(file.repoId, { type: 'revertPaths', entries: commitPathEntries([file], selectedCommits, selectedDetails, 'revert') }); });
    close();
  }} onClose={close} />;
}

function DetailDirectoryContextMenu({ position, files, close }: { position: { x: number; y: number }; files: DetailFileTarget[]; close: () => void }) {
  const { t } = useI18n();
  const selectionWorkspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectedDetails = useAppStore((state) => state.selectedCommitDetails);
  const repoIds = new Set(files.map((file) => file.repoId));
  const repoId = files[0]?.repoId;
  const repoKind = repositories.find((repo) => repo.meta.id === repoId)?.meta.kind;
  const eligible = files.length > 0
    && repoIds.size === 1
    && repoKind === 'git'
    && files.every((file) => !file.isMergeParentDiff && !file.comparisonBaseHash);
  if (!eligible || !repoId) return null;
  const uniquePaths = [...new Set(files.map((file) => file.path))];
  const visiblePaths = uniquePaths.slice(0, 8);
  const remaining = uniquePaths.length - visiblePaths.length;
  const affected = `${t('{0} files', uniquePaths.length)}\n${visiblePaths.join('\n')}${remaining > 0 ? `\n${t('+{0} more', remaining)}` : ''}`;
  const items: ContextMenuEntry[] = [
    { id: 'revert-paths', label: t('Revert Selected Changes'), icon: 'discard' },
    { id: 'apply-paths', label: t('Cherry-Pick Selected Changes'), icon: 'git-commit' },
  ];
  return <ContextMenu x={position.x} y={position.y} items={items} onSelect={(id) => {
    const reverting = id === 'revert-paths';
    const entries = commitPathEntries(files, selectedCommits, selectedDetails, reverting ? 'revert' : 'apply');
    void confirmDialog({
      title: t(reverting ? 'Revert selected changes?' : 'Cherry-pick selected changes?'),
      message: `${affected}\n\n${t(reverting ? 'The selected commit changes will be reversed in the working copy.' : 'The selected commit versions will replace the working-copy files.')}`,
      danger: true,
    }).then((yes) => {
      if (!yes || useAppStore.getState().snapshot?.workspace.id !== selectionWorkspaceId) return;
      return historyOperation(repoId, { type: reverting ? 'revertPaths' : 'applyPaths', entries });
    });
    close();
  }} onClose={close} />;
}

function isFileSelected(file: DetailFileTarget, selectedFile: AppStore['selectedFile']): boolean {
  if (!selectedFile) return false;
  return selectedFile.repoId === file.repoId
    && selectedFile.path === file.path
    && (selectedFile.fromRevision ?? null) === (file.fromRevision ?? null)
    && (selectedFile.toRevision ?? null) === (file.toRevision ?? null);
}

function DetailTreeNodeView({
  node,
  depth,
  openDiff,
  selectedFile,
  isDirOpen,
  toggleDir,
  openingDiffPath,
  onOpeningDiff,
  searchQuery,
  activeMatchRepoId,
  activeMatchPath,
  activeMatchFromRevision,
  onFileContextMenu,
  onDirectoryContextMenu,
}: {
  node: DetailTreeNode;
  depth: number;
  openDiff: AppStore['openDiff'];
  selectedFile?: AppStore['selectedFile'];
  isDirOpen: (key: string) => boolean;
  toggleDir: (key: string) => void;
  openingDiffPath?: string | null;
  onOpeningDiff?: (path: string) => void;
  searchQuery?: string;
  activeMatchRepoId?: string;
  activeMatchPath?: string;
  activeMatchFromRevision?: string;
  onFileContextMenu?: (event: React.MouseEvent, file: DetailFileTarget) => void;
  onDirectoryContextMenu?: (event: React.MouseEvent, files: DetailFileTarget[]) => void;
}) {
  const { t } = useI18n();
  if (node.file) {
    const file = node.file;
    const isSelected = isFileSelected(file, selectedFile);
    const isActiveMatch = activeMatchRepoId === file.repoId
      && activeMatchPath === file.path
      && (activeMatchFromRevision ?? '') === (file.fromRevision ?? '');
    return (
      <button
        type="button"
        data-detail-repo-id={file.repoId}
        data-detail-path={file.path}
        data-detail-from-revision={file.fromRevision ?? ''}
        className={`detail-file-row status-${statusClass(file.status)} ${isSelected ? 'selected' : ''} ${isActiveMatch ? 'is-active-match' : ''}`}
        style={{ paddingLeft: 18 + depth * 14 }}
        title={`${file.path}\n${t('Click to open diff')}`}
        onClick={() => openTarget(file, openDiff, onOpeningDiff)}
        onContextMenu={(event) => onFileContextMenu?.(event, file)}
      >
        <FileIcon name={node.name} />
        <span className="detail-file-name"><HighlightText text={node.name} query={searchQuery} /></span>
        {openingDiffPath === file.path && (
          <Codicon name="loading~spin" style={{ fontSize: '12px', marginLeft: '6px' }} />
        )}
        {(file.added !== null || file.removed !== null) && (
          <span className="detail-line-stats">
            {file.added !== null && <b className="added">+{file.added}</b>}
            {file.removed !== null && <b className="removed">-{file.removed}</b>}
          </span>
        )}
        <em>{file.status.replace(/\d+$/, '').slice(0, 1).toUpperCase()}</em>
      </button>
    );
  }
  const isExpanded = isDirOpen(node.key);
  const files = descendantFiles(node);
  return (
    <div className="detail-tree-dir">
      <button
        type="button"
        style={{ paddingLeft: depth * 14 }}
        title={node.path}
        onClick={() => toggleDir(node.key)}
        onContextMenu={(event) => onDirectoryContextMenu?.(event, files)}
      >
        <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
        <FileIcon name={node.name.split('/').pop() ?? node.name} folder open={isExpanded} />
        <span className="detail-node-label"><HighlightText text={node.name} query={searchQuery} /></span>
        <b className="detail-directory-count">{node.fileCount}</b>
      </button>
      {isExpanded && node.children.map((child) => (
        <DetailTreeNodeView
          key={child.key}
          node={child}
          depth={depth + 1}
          openDiff={openDiff}
          selectedFile={selectedFile}
          isDirOpen={isDirOpen}
          toggleDir={toggleDir}
          openingDiffPath={openingDiffPath}
          onOpeningDiff={onOpeningDiff}
          searchQuery={searchQuery}
          activeMatchRepoId={activeMatchRepoId}
          activeMatchPath={activeMatchPath}
          activeMatchFromRevision={activeMatchFromRevision}
          onFileContextMenu={onFileContextMenu}
          onDirectoryContextMenu={onDirectoryContextMenu}
        />
      ))}
    </div>
  );
}

function DetailFlatFileRow({
  file,
  repoName,
  showRepo,
  selectedFile,
  openDiff,
  openingDiffPath,
  onOpeningDiff,
  searchQuery,
  activeMatchRepoId,
  activeMatchPath,
  activeMatchFromRevision,
  onFileContextMenu,
}: {
  file: DetailFileTarget;
  repoName?: string;
  showRepo?: boolean;
  selectedFile?: AppStore['selectedFile'];
  openDiff: AppStore['openDiff'];
  openingDiffPath?: string | null;
  onOpeningDiff?: (path: string) => void;
  searchQuery?: string;
  activeMatchRepoId?: string;
  activeMatchPath?: string;
  activeMatchFromRevision?: string;
  onFileContextMenu?: (event: React.MouseEvent, file: DetailFileTarget) => void;
}) {
  const { t } = useI18n();
  const fileName = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const isSelected = isFileSelected(file, selectedFile);
  const isActiveMatch = activeMatchRepoId === file.repoId
    && activeMatchPath === file.path
    && (activeMatchFromRevision ?? '') === (file.fromRevision ?? '');
  return (
    <button
      type="button"
      data-detail-repo-id={file.repoId}
      data-detail-path={file.path}
      data-detail-from-revision={file.fromRevision ?? ''}
      key={`${file.repoId}:${file.fromRevision ?? ''}:${file.path}`}
      className={`detail-file-row detail-list-row status-${statusClass(file.status)} ${isSelected ? 'selected' : ''} ${isActiveMatch ? 'is-active-match' : ''}`}
      title={`${file.path}\n${t('Click to open diff')}`}
      onClick={() => openTarget(file, openDiff, onOpeningDiff)}
      onContextMenu={(event) => onFileContextMenu?.(event, file)}
    >
      <FileIcon name={fileName} />
      <span className="detail-file-name"><HighlightText text={fileName} query={searchQuery} /></span>
      {openingDiffPath === file.path && (
        <Codicon name="loading~spin" style={{ fontSize: '12px', marginLeft: '6px' }} />
      )}
      {dir && <span className="detail-dir-path"><HighlightText text={dir} query={searchQuery} /></span>}
      {showRepo && repoName && <small className="detail-repo-pill">{repoName}</small>}
      {(file.added !== null || file.removed !== null) && (
        <span className="detail-line-stats">
          {file.added !== null && <b className="added">+{file.added}</b>}
          {file.removed !== null && <b className="removed">-{file.removed}</b>}
        </span>
      )}
      <em>{file.status.replace(/\d+$/, '').slice(0, 1).toUpperCase()}</em>
    </button>
  );
}

function DetailRepoGroup({
  files,
  showRepo,
  repoName,
  repoColor,
  openDiff,
  selectedFile,
  isDirOpen,
  toggleDir,
  openingDiffPath,
  onOpeningDiff,
  searchQuery,
  activeMatchRepoId,
  activeMatchPath,
  activeMatchFromRevision,
  onFileContextMenu,
  onDirectoryContextMenu,
}: {
  files: DetailFileTarget[];
  showRepo: boolean;
  repoName: string;
  repoColor?: string;
  openDiff: AppStore['openDiff'];
  selectedFile?: AppStore['selectedFile'];
  isDirOpen: (key: string) => boolean;
  toggleDir: (key: string) => void;
  openingDiffPath?: string | null;
  onOpeningDiff?: (path: string) => void;
  searchQuery?: string;
  activeMatchRepoId?: string;
  activeMatchPath?: string;
  activeMatchFromRevision?: string;
  onFileContextMenu?: (event: React.MouseEvent, file: DetailFileTarget) => void;
  onDirectoryContextMenu?: (event: React.MouseEvent, files: DetailFileTarget[]) => void;
}) {
  const repoId = files[0]?.repoId ?? repoName;
  const isExpanded = !showRepo || isDirOpen(`repo:${repoId}`);
  return (
    <div className="detail-repo-group">
      {showRepo && <button
        type="button"
        className="detail-root-label"
        title={repoName}
        onClick={() => toggleDir(`repo:${repoId}`)}
        onContextMenu={(event) => onDirectoryContextMenu?.(event, files)}
      >
        <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
        <i style={{ background: repoColor ?? 'var(--versiondock-accent)' }} />
        <strong><HighlightText text={repoName} query={searchQuery} /></strong>
        <b>{files.length}</b>
      </button>}
      {isExpanded && buildTree(files, `dir:${repoId}`).map((node) => (
        <DetailTreeNodeView
          key={node.key}
          node={collapseTree(node)}
          depth={showRepo ? 1 : 0}
          openDiff={openDiff}
          selectedFile={selectedFile}
          isDirOpen={isDirOpen}
          toggleDir={toggleDir}
          openingDiffPath={openingDiffPath}
          onOpeningDiff={onOpeningDiff}
          searchQuery={searchQuery}
          activeMatchRepoId={activeMatchRepoId}
          activeMatchPath={activeMatchPath}
          activeMatchFromRevision={activeMatchFromRevision}
          onFileContextMenu={onFileContextMenu}
          onDirectoryContextMenu={onDirectoryContextMenu}
        />
      ))}
    </div>
  );
}

type FlatItem =
  | { kind: 'repo'; repoId: string; repoName: string; repoColor?: string; fileCount: number; files: DetailFileTarget[]; key: string }
  | { kind: 'dir'; node: DetailTreeNode; depth: number; open: boolean; key: string }
  | { kind: 'file'; file: DetailFileTarget; node: DetailTreeNode; depth: number; key: string };

function flattenVisibleTreeNodes(
  nodes: DetailTreeNode[],
  isDirOpen: (key: string) => boolean,
  depth = 1,
): FlatItem[] {
  const result: FlatItem[] = [];
  for (const node of nodes) {
    if (node.file) {
      result.push({ kind: 'file', file: node.file, node, depth, key: `${node.file.repoId}:${node.path}` });
    } else {
      const open = isDirOpen(node.key);
      result.push({ kind: 'dir', node, depth, open, key: node.key });
      if (open && node.children.length > 0) {
        result.push(...flattenVisibleTreeNodes(node.children, isDirOpen, depth + 1));
      }
    }
  }
  return result;
}

function MergeParentChangeGroup({
  change,
  commitHash,
  repoId,
  viewMode,
  selectedFile,
  openDiff,
  isDirOpen,
  toggleDir,
  searchQuery,
  activeMatchRepoId,
  activeMatchPath,
  activeMatchFromRevision,
  isExpanded,
  onToggle,
  onFileContextMenu,
  onDirectoryContextMenu,
}: {
  change: MergeParentChange;
  commitHash: string;
  repoId: string;
  viewMode: 'tree' | 'list';
  selectedFile?: AppStore['selectedFile'];
  openDiff: AppStore['openDiff'];
  isDirOpen: (key: string) => boolean;
  toggleDir: (key: string) => void;
  searchQuery?: string;
  activeMatchRepoId?: string;
  activeMatchPath?: string;
  activeMatchFromRevision?: string;
  isExpanded: boolean;
  onToggle: () => void;
  onFileContextMenu?: (event: React.MouseEvent, file: DetailFileTarget) => void;
  onDirectoryContextMenu?: (event: React.MouseEvent, files: DetailFileTarget[]) => void;
}) {
  const { t } = useI18n();
  const loadParentFiles = useAppStore((state) => state.loadMergeParentFiles);
  const cacheKey = `${repoId}\0${commitHash}\0${change.hash}`;
  const files = useAppStore((state) => state.mergeParentFiles[cacheKey]);
  const loading = useAppStore((state) => Boolean(state.mergeParentFilesLoading[cacheKey]));
  const error = useAppStore((state) => state.mergeParentFilesError[cacheKey]);

  const parentTargets: DetailFileTarget[] = useMemo(() => {
    if (!files) return [];
    return files.map((file) => ({
      repoId,
      commitHash,
      path: file.path,
      status: file.status,
      added: file.added,
      removed: file.removed,
      fromRevision: change.hash,
      toRevision: commitHash,
      comparisonBaseHash: change.hash,
      isMergeParentDiff: true,
    }));
  }, [files, repoId, commitHash, change.hash]);

  const toggle = () => {
    onToggle();
    if (!isExpanded && !files && !loading) {
      void loadParentFiles(repoId, commitHash, change.hash).catch(() => {});
    }
  };

  const retry = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!loading) {
      void loadParentFiles(repoId, commitHash, change.hash).catch(() => {});
    }
  };

  useEffect(() => {
    if (isExpanded && !files && !loading && !error) {
      void loadParentFiles(repoId, commitHash, change.hash).catch(() => {});
    }
  }, [isExpanded, files, loading, error, loadParentFiles, repoId, commitHash, change.hash]);

  return (
    <div className="merge-parent-group">
      <button
        type="button"
        className="merge-parent-row"
        data-selected={isExpanded}
        title={`${change.hash}\n${change.message}`}
        onClick={toggle}
      >
        <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} className="merge-chevron" />
        <Codicon name="git-commit" className="merge-commit-icon" />
        <span className="merge-parent-title">{t('Changes from {0}', change.shortHash)}</span>
        {change.message && <span className="merge-parent-message" title={change.message}>{change.message}</span>}
        <span className="merge-parent-count">
          {change.fileCount === 1 ? t('{0} file', change.fileCount) : t('{0} files', change.fileCount)}
        </span>
      </button>
      {isExpanded && (
        <div className="merge-parent-files">
          {loading && <div className="detail-loading">{t('Loading files...')}</div>}
          {!loading && error && (
            <div className="detail-loading detail-error">
              <span>{t('Failed to load files')}</span>
              <button type="button" className="detail-retry-button" onClick={retry}>
                {t('Retry')}
              </button>
            </div>
          )}
          {!loading && !error && files && files.length === 0 && <div className="detail-loading">{t('No changed files')}</div>}
          {!loading && !error && files && files.length > 0 && (
            viewMode === 'tree' ? (
              buildTree(parentTargets, `merge-dir:${change.hash}`).map((node) => (
                <DetailTreeNodeView
                  key={node.key}
                  node={collapseTree(node)}
                  depth={0}
                  openDiff={openDiff}
                  selectedFile={selectedFile}
                  isDirOpen={isDirOpen}
                  toggleDir={toggleDir}
                  searchQuery={searchQuery}
                  activeMatchRepoId={activeMatchRepoId}
                  activeMatchPath={activeMatchPath}
                  activeMatchFromRevision={activeMatchFromRevision}
                  onFileContextMenu={onFileContextMenu}
                  onDirectoryContextMenu={onDirectoryContextMenu}
                />
              ))
            ) : (
              parentTargets.map((file) => (
                <DetailFlatFileRow
                  key={`${file.repoId}:${file.fromRevision ?? ''}:${file.path}`}
                  file={file}
                  selectedFile={selectedFile}
                  openDiff={openDiff}
                  searchQuery={searchQuery}
                  activeMatchRepoId={activeMatchRepoId}
                  activeMatchPath={activeMatchPath}
                  activeMatchFromRevision={activeMatchFromRevision}
                  onFileContextMenu={onFileContextMenu}
                />
              ))
            )
          )}
        </div>
      )}
    </div>
  );
}

function RefBadges({ detail, repoKind, collapsible = false }: { detail: CommitDetail; repoKind?: 'git' | 'svn'; collapsible?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const refs = refsFor(detail, repoKind);
  const visible = collapsible && !expanded ? refs.slice(0, 5) : refs;
  const overflow = refs.slice(5);
  return (
    <div className="detail-refs">
      {visible.map((ref) => {
        const remoteBranch = ref.kind === 'remote' && ref.label.includes('/')
          ? ref.label.slice(ref.label.indexOf('/') + 1)
          : ref.label;
        const color = ref.isSvnRevision
          ? ref.label === 'HEAD' ? headColor() : branchColor(ref.label)
          : ref.kind === 'head'
            ? headColor()
            : ref.kind === 'tag'
              ? tagColor()
              : branchColor(remoteBranch);
        const title = ref.isSvnRevision
          ? (ref.label === 'HEAD' ? t('SVN repository HEAD revision') : t('SVN working copy BASE revision'))
          : undefined;
        const icons = ref.isSvnRevision
          ? ['versions']
          : [ref.kind === 'head' ? 'arrow-right' : ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : 'git-branch'];
        return (
          <BranchRefBadge
            key={`${ref.kind}:${ref.value}`}
            label={ref.label}
            kind={ref.kind}
            color={color}
            variant="ref"
            title={title}
            icons={icons}
            className={ref.kind}
          />
        );
      })}
      {collapsible && !expanded && overflow.length > 0 && <button type="button" className="detail-ref-overflow" title={t('Show {0} more', overflow.length)} onClick={() => setExpanded(true)}>{t('+{0} more', overflow.length)}</button>}
      {collapsible && expanded && refs.length > 5 && <button type="button" className="detail-ref-overflow expanded" onClick={() => setExpanded(false)}>{t('Show less')}</button>}
    </div>
  );
}

function splitCommitMessage(detail: CommitDetail): { subject: string; body: string } {
  const messageLines = detail.fullMessage.replace(/\r\n/g, '\n').split('\n');
  const subject = messageLines[0]?.trim() || detail.commit.message.trim();
  const body = messageLines[0]?.trim() === detail.commit.message.trim()
    ? messageLines.slice(1).join('\n').replace(/^\s*\n/, '').trimEnd()
    : detail.fullMessage.trim();
  return { subject, body };
}

function CommitMessage({
  detail,
  expanded,
  toggle,
}: {
  detail: CommitDetail;
  expanded: boolean;
  toggle: () => void;
}) {
  const { t } = useI18n();
  const { subject, body } = splitCommitMessage(detail);
  const hasBody = body.length > 0;
  const canExpand = hasBody || subject.length > 25;
  const fullMessageTooltip = detail.fullMessage.trim() || detail.commit.message || subject;

  const handleTitleClick = () => {
    if (!canExpand) return;
    if ((window.getSelection()?.toString() || '').length === 0) {
      toggle();
    }
  };

  return (
    <div className="detail-message-card" title={fullMessageTooltip}>
      <div
        className="detail-message-title"
        style={{ cursor: canExpand ? 'pointer' : 'default' }}
        onClick={handleTitleClick}
      >
        <strong className={expanded ? 'expanded' : ''} title={fullMessageTooltip}>
          {subject}
        </strong>
        {canExpand ? (
          <IconButton
            type="button"
            title={expanded ? t('Click to collapse') : t('Click to expand')}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
          </IconButton>
        ) : (
          <span className="detail-message-expand-placeholder" aria-hidden="true" />
        )}
      </div>
      {expanded && hasBody && <pre>{body}</pre>}
    </div>
  );
}

function ExtendedCommitSummary({
  explanation,
  detail,
  selectedCommits,
  selectedDetails,
  loading,
  repoMap,
}: {
  explanation?: React.ReactNode;
  detail?: CommitDetail;
  selectedCommits: CommitNode[];
  selectedDetails: Record<string, CommitDetail>;
  loading: boolean;
  repoMap: Map<string, RepositoryStatus>;
}) {
  const { t } = useI18n();
  const selectedCommitError = useAppStore((state) => state.selectedCommitError);
  const selectedCommitLoading = useAppStore((state) => state.selectedCommitLoading);
  const reloadSelectedCommits = useAppStore((state) => state.reloadSelectedCommits);
  const multiple = selectedCommits.length > 1;

  if (multiple) {
    const oldest = selectedCommits[selectedCommits.length - 1];
    const newest = selectedCommits[0];
    return (
      <section className="extended-commit-summary" aria-label={t('Aggregated commit selection')}>
        {explanation}
        <div className="extended-detail-block">
          <h3>{t('Details')}</h3>
          <dl className="extended-detail-grid">
            <dt>{t('Aggregated commit selection')}</dt>
            <dd>{t('{0} commits selected', selectedCommits.length)}</dd>
            <dt>{t('Repository')}</dt>
            <dd>{t('{0} repositories involved', new Set(selectedCommits.map((commit) => commit.repoId)).size)}</dd>
            <dt>{t('Selected time range')}</dt>
            <dd>{formatDate(oldest?.authorDate ?? '')} - {formatDate(newest?.authorDate ?? '')}</dd>
          </dl>
        </div>
        <div className="extended-detail-block">
          <h3>{t('Aggregated commit selection')}</h3>
          <div className="extended-commit-list">
            {selectedCommits.map((commit) => {
              const key = commitKey(commit.repoId, commit.hash);
              const current = selectedDetails[key];
              const repo = repoMap.get(commit.repoId);
              const isItemLoading = Boolean(selectedCommitLoading[key]);
              const itemError = selectedCommitError[key];

              if (isItemLoading) {
                return (
                  <article className="extended-commit-item" key={key}>
                    <div className="detail-loading">{t('Loading...')}</div>
                  </article>
                );
              }

              if (!current) {
                return (
                  <article className="extended-commit-item" key={key}>
                    <div className="extended-commit-repo" style={{ color: repo?.meta.color }}>
                      <Codicon name="repo" />{repo?.meta.name ?? commit.repoId}
                    </div>
                    <div className="detail-loading detail-error">
                      <span>{itemError || t('Failed to load commit details')}</span>
                      <button type="button" className="detail-retry-button" onClick={() => void reloadSelectedCommits()}>
                        {t('Retry')}
                      </button>
                    </div>
                  </article>
                );
              }

              const message = splitCommitMessage(current);
              return (
                <article className="extended-commit-item" key={key}>
                  <div className="extended-commit-repo" style={{ color: repo?.meta.color }}><Codicon name="repo" />{repo?.meta.name ?? commit.repoId}</div>
                  <div className="extended-message-card">
                    <strong>{message.subject}</strong>
                    {message.body && <pre>{message.body}</pre>}
                  </div>
                  <AuthorMeta commit={commit} />
                  <RefBadges detail={current} repoKind={repo?.meta.kind} />
                </article>
              );
            })}
          </div>
        </div>
        {loading && <div className="detail-loading">{t('Loading...')}</div>}
      </section>
    );
  }

  if (!detail) return <section className="extended-commit-summary"><div className="detail-loading">{t('Loading...')}</div></section>;
  const commit = detail.commit;
  const repo = repoMap.get(commit.repoId);
  return (
    <section className="extended-commit-summary" aria-label={t('Open Commit Detail')}>
      {explanation}
      <div className="extended-detail-block">
        <h3>{t('Author')}</h3>
        <div className="extended-author">
          <AuthorAvatar name={commit.author} email={commit.email} repoId={commit.repoId} size={36} />
          <span><strong>{commit.author}</strong><small>{commit.email}</small></span>
        </div>
      </div>
      <div className="extended-detail-block">
        <h3>{t('Details')}</h3>
        <dl className="extended-detail-grid">
          <dt>{t('Hash')}</dt><dd><code title={commit.hash}>{commit.hash}</code></dd>
          <dt>{t('Author date')}</dt><dd>{formatDate(commit.authorDate)}</dd>
          <dt>{t('Commit date')}</dt><dd>{formatDate(commit.committerDate)}</dd>
          <dt>{t('Repository')}</dt><dd style={{ color: repo?.meta.color }}>{repo?.meta.name ?? commit.repoId}</dd>
        </dl>
      </div>
      {refsFor(detail, repo?.meta.kind).length > 0 && <div className="extended-detail-block"><h3>{t('Branches & tags')}</h3><RefBadges detail={detail} repoKind={repo?.meta.kind} /></div>}
      <div className="extended-detail-block">
        <h3>{t('Commit message')}</h3>
        <pre className="extended-full-message">{detail.fullMessage.trim() || commit.message}</pre>
      </div>
    </section>
  );
}

function AuthorMeta({ commit }: { commit: CommitNode }) {
  return (
    <div className="detail-author-meta">
      <AuthorAvatar name={commit.author} email={commit.email} repoId={commit.repoId} size={20} />
      <span className="detail-author-line">
        <strong>{commit.author}</strong>
        <i>·</i>
        <time>{formatDate(commit.authorDate || commit.committerDate)}</time>
        <i>·</i>
        <code title={commit.hash}><Codicon name="git-commit" />{commit.shortHash}</code>
      </span>
    </div>
  );
}

export function CommitDetailPanel({ onCollapse, variant = 'sidebar', aiToolbar }: { onCollapse: () => void; variant?: 'sidebar' | 'workspace'; aiToolbar?: HTMLElement | null }) {
  const detail = useAppStore((state) => state.selectedCommit);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectedDetails = useAppStore((state) => state.selectedCommitDetails);
  const selectedCommitError = useAppStore((state) => state.selectedCommitError);
  const selectedCommitLoading = useAppStore((state) => state.selectedCommitLoading);
  const reloadSelectedCommits = useAppStore((state) => state.reloadSelectedCommits);
  const selectedFile = useAppStore((state) => state.selectedFile);
  const loading = useAppStore((state) => state.selectedCommits.some((commit) =>
    state.selectedCommitLoading[commitKey(commit.repoId, commit.hash)] === true
  ));
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const openDiff = useAppStore((state) => state.openDiff);
  const openCommitDetail = useAppStore((state) => state.openCommitDetail);
  const openChanges = useAppStore((state) => state.openCommitChanges);
  const diff = useAppStore((state) => state.diff);
  const { t } = useI18n();
  const canOpenChanges = selectedCommits.length > 0
    && !loading
    && selectedCommits.every((c) => {
      const k = commitKey(c.repoId, c.hash);
      return Boolean(selectedDetails[k]) && !selectedCommitError[k];
    });
  const [openingDiffPath, setOpeningDiffPath] = useState<string | null>(null);
  const openingDiffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openingDiffFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailViewKey = `versiondock:detailView:${workspaceId ?? ''}:${variant}:${variant === 'workspace' ? selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash)).join('|') : ''}`;
  const [fileMode, setFileMode] = useState<'tree' | 'list'>(() => {
    try { return localStorage.getItem(detailViewKey) === 'list' ? 'list' : 'tree'; } catch { return 'tree'; }
  });
  useEffect(() => {
    try { localStorage.setItem(detailViewKey, fileMode); } catch { /* Keep the view functional without storage. */ }
  }, [detailViewKey, fileMode]);
  const [allTreeExpanded, setAllTreeExpanded] = useState<boolean | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [messagesExpandedByDefault, setMessagesExpandedByDefault] = useState(() => {
    try { return localStorage.getItem('versiondock:commitMessagesExpandedByDefault') === 'true'; } catch { return false; }
  });
  const [infoHeight, setInfoHeight] = useState<number>();
  const [containerHeight, setContainerHeight] = useState(0);
  const containerRef = useRef<HTMLElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [fileContextMenu, setFileContextMenu] = useState<{ position: { x: number; y: number }; file: DetailFileTarget }>();
  const [dirContextMenu, setDirContextMenu] = useState<{ position: { x: number; y: number }; files: DetailFileTarget[] }>();

  const handleFileContextMenu = useCallback((event: React.MouseEvent, file: DetailFileTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setDirContextMenu(undefined);
    setFileContextMenu({ position: { x: event.clientX, y: event.clientY }, file });
  }, []);

  const handleDirectoryContextMenu = useCallback((event: React.MouseEvent, files: DetailFileTarget[]) => {
    event.preventDefault();
    event.stopPropagation();
    setFileContextMenu(undefined);
    setDirContextMenu({ position: { x: event.clientX, y: event.clientY }, files });
  }, []);

  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const matchedTargetsRef = useRef<DetailFileTarget[]>([]);

  const handleNavigateMatch = useCallback((direction: -1 | 1) => {
    const list = matchedTargetsRef.current;
    if (list.length === 0) return;
    setActiveMatchIndex((prev) => (prev + direction + list.length) % list.length);
  }, []);

  const speedSearch = useFileSearch('.commit-detail', handleNavigateMatch);
  const queryLower = speedSearch.query.trim().toLowerCase();

  useEffect(() => {
    if (openingDiffTimerRef.current) clearTimeout(openingDiffTimerRef.current);
    if (openingDiffFallbackRef.current) clearTimeout(openingDiffFallbackRef.current);
    const frame = requestAnimationFrame(() => setOpeningDiffPath(null));
    return () => cancelAnimationFrame(frame);
  }, [diff, selectedCommits]);

  useEffect(() => () => {
    if (openingDiffTimerRef.current) clearTimeout(openingDiffTimerRef.current);
    if (openingDiffFallbackRef.current) clearTimeout(openingDiffFallbackRef.current);
  }, []);

  const handleOpeningDiff = useCallback((path: string) => {
    if (openingDiffTimerRef.current) clearTimeout(openingDiffTimerRef.current);
    if (openingDiffFallbackRef.current) clearTimeout(openingDiffFallbackRef.current);
    openingDiffTimerRef.current = setTimeout(() => {
      setOpeningDiffPath(path);
    }, 120);
    openingDiffFallbackRef.current = setTimeout(() => {
      setOpeningDiffPath((current) => (current === path ? null : current));
    }, 6000);
  }, []);

  const repoMap = useMemo(() => new Map(repositories.map((repo) => [repo.meta.id, repo])), [repositories]);
  const historyPath = useAppStore((state) => state.historyQuery.path);
  const targets = useMemo(
    () => buildCommitFileTargets(selectedCommits, selectedDetails, repositories, variant === 'sidebar' ? historyPath : undefined),
    [selectedCommits, selectedDetails, repositories, historyPath, variant],
  );

  const isMultiSelection = selectedCommits.length > 1;
  const singleCommit = !isMultiSelection ? selectedCommits[0] : undefined;
  const selectedPrimary = detail?.commit ?? singleCommit;
  const singleKey = selectedPrimary ? commitKey(selectedPrimary.repoId, selectedPrimary.hash) : '';
  const isMergeCommit = !isMultiSelection && Boolean(detail && detail.commit.parents.length >= 2);
  const mergeParentChanges = useMemo(
    () => ((isMergeCommit && detail?.mergeParentChanges) ? detail.mergeParentChanges : []),
    [isMergeCommit, detail?.mergeParentChanges],
  );

  const [expandedParentHashes, setExpandedParentHashes] = useState<Set<string>>(new Set());
  const toggleParentGroup = useCallback((parentHash: string) => {
    setExpandedParentHashes((prev) => {
      const next = new Set(prev);
      if (next.has(parentHash)) {
        next.delete(parentHash);
      } else {
        next.add(parentHash);
      }
      return next;
    });
  }, []);

  const mergeParentFiles = useAppStore((state) => state.mergeParentFiles);
  const mergeParentFilesLoading = useAppStore((state) => state.mergeParentFilesLoading);
  const mergeParentFilesError = useAppStore((state) => state.mergeParentFilesError);
  const loadMergeParentFiles = useAppStore((state) => state.loadMergeParentFiles);
  const inFlightParentRequestsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    inFlightParentRequestsRef.current.clear();
  }, [singleKey]);

  // 当开启搜索且当前选中合并提交时，自动预取尚未加载文件列表的 parent
  useEffect(() => {
    if (!speedSearch.isOpen || !isMergeCommit || !detail || mergeParentChanges.length === 0) return;
    for (const parentChange of mergeParentChanges) {
      const cacheKey = `${detail.commit.repoId}\0${detail.commit.hash}\0${parentChange.hash}`;
      const hasFiles = Boolean(mergeParentFiles[cacheKey]);
      const isLoading = Boolean(mergeParentFilesLoading[cacheKey]);
      const hasError = Boolean(mergeParentFilesError[cacheKey]);
      const isInFlight = inFlightParentRequestsRef.current.has(cacheKey);

      if (!hasFiles && !isLoading && !hasError && !isInFlight) {
        inFlightParentRequestsRef.current.add(cacheKey);
        loadMergeParentFiles(detail.commit.repoId, detail.commit.hash, parentChange.hash)
          .catch(() => {})
          .finally(() => {
            inFlightParentRequestsRef.current.delete(cacheKey);
          });
      }
    }
  }, [
    speedSearch.isOpen,
    isMergeCommit,
    detail,
    mergeParentChanges,
    mergeParentFiles,
    mergeParentFilesLoading,
    mergeParentFilesError,
    loadMergeParentFiles,
  ]);
  const cachedParentTargets = useMemo<DetailFileTarget[]>(() => {
    if (!isMergeCommit || !detail) return [];
    const results: DetailFileTarget[] = [];
    for (const parentChange of mergeParentChanges) {
      const cacheKey = `${detail.commit.repoId}\0${detail.commit.hash}\0${parentChange.hash}`;
      const files = mergeParentFiles[cacheKey];
      if (!files) continue;
      for (const file of files) {
        results.push({
          repoId: detail.commit.repoId,
          commitHash: detail.commit.hash,
          path: file.path,
          status: file.status,
          added: file.added,
          removed: file.removed,
          fromRevision: parentChange.hash,
          toRevision: detail.commit.hash,
          comparisonBaseHash: parentChange.hash,
          isMergeParentDiff: true,
        });
      }
    }
    return results;
  }, [isMergeCommit, detail, mergeParentChanges, mergeParentFiles]);

  const allSearchableTargets = useMemo(() => {
    return [...targets, ...cachedParentTargets];
  }, [targets, cachedParentTargets]);

  const matchedTargets = useMemo(() => {
    if (!queryLower) return [];
    return allSearchableTargets.filter((target) => target.path.toLowerCase().includes(queryLower));
  }, [allSearchableTargets, queryLower]);
  matchedTargetsRef.current = matchedTargets;

  const autoExpandedParentHashes = useMemo(() => {
    if (!queryLower) return new Set<string>();
    const set = new Set<string>();
    for (const target of matchedTargets) {
      if (target.isMergeParentDiff && target.fromRevision) {
        set.add(target.fromRevision);
      }
    }
    return set;
  }, [queryLower, matchedTargets]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [queryLower]);

  useEffect(() => {
    if (activeMatchIndex >= matchedTargets.length && matchedTargets.length > 0) {
      setActiveMatchIndex(0);
    }
  }, [matchedTargets.length, activeMatchIndex]);

  const activeMatch = matchedTargets[activeMatchIndex];
  const targetsByRepo = useMemo(() => {
    const groups = new Map<string, DetailFileTarget[]>();
    for (const target of targets) groups.set(target.repoId, [...(groups.get(target.repoId) ?? []), target]);
    return groups;
  }, [targets]);

  const autoExpandedKeys = useMemo(() => {
    if (!queryLower) return new Set<string>();
    const set = new Set<string>();
    for (const file of allSearchableTargets) {
      if (file.path.toLowerCase().includes(queryLower)) {
        if (file.isMergeParentDiff && file.fromRevision) {
          const parts = file.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            set.add(`merge-dir:${file.fromRevision}:${parts.slice(0, i).join('/')}`);
          }
        } else {
          set.add(`repo:${file.repoId}`);
          const parts = file.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            set.add(`dir:${file.repoId}:${parts.slice(0, i).join('/')}`);
          }
        }
      }
    }
    return set;
  }, [queryLower, allSearchableTargets]);

  const isDirOpen = useCallback((key: string) => {
    if (queryLower && autoExpandedKeys.has(key)) return true;
    if (collapsedDirs[key] !== undefined) return !collapsedDirs[key];
    return allTreeExpanded !== false;
  }, [allTreeExpanded, autoExpandedKeys, collapsedDirs, queryLower]);

  const toggleDir = useCallback((key: string) => {
    setCollapsedDirs((prev) => {
      const currentOpen = isDirOpen(key);
      return { ...prev, [key]: currentOpen };
    });
  }, [isDirOpen]);

  useEffect(() => {
    setAllTreeExpanded(null);
    setCollapsedDirs({});
    setExpandedParentHashes(new Set());
  }, [selectedCommits]);

  const minInfoHeight = Math.min(160, Math.max(96, Math.floor((containerHeight - 4) / 4)));
  const maxInfoHeight = Math.max(minInfoHeight, containerHeight - 4 - minInfoHeight);
  const clampInfoHeight = useCallback((height: number) => Math.min(maxInfoHeight, Math.max(minInfoHeight, height)), [maxInfoHeight, minInfoHeight]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || variant === 'workspace') return;
    const update = () => {
      const height = container.getBoundingClientRect().height;
      if (height <= 4) return;
      const minimum = Math.min(160, Math.max(96, Math.floor((height - 4) / 4)));
      const maximum = Math.max(minimum, height - 4 - minimum);
      setContainerHeight(height);
      setInfoHeight((current) => Math.min(maximum, Math.max(minimum, current ?? summaryRef.current?.getBoundingClientRect().height ?? 220)));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [detail, selectedCommits.length, variant]);
  const resizeInfo = useResizable(infoHeight ?? 220, minInfoHeight, maxInfoHeight, setInfoHeight, -1, 'y');

  useEffect(() => {
    setExpandedMessages(new Set(messagesExpandedByDefault ? selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash)) : []));
  }, [messagesExpandedByDefault, selectedCommits]);
  const toggleAllMessages = () => {
    const next = !messagesExpandedByDefault;
    setMessagesExpandedByDefault(next);
    try { localStorage.setItem('versiondock:commitMessagesExpandedByDefault', String(next)); } catch { /* Preferences remain usable without storage. */ }
  };

  const groupedTargets = useMemo(() => {
    const ids = [...targetsByRepo.keys()];
    return ids.length > 1
      ? [...targetsByRepo.entries()]
      : [[ids[0] ?? selectedPrimary?.repoId ?? '', targets]] as Array<[string, DetailFileTarget[]]>;
  }, [targetsByRepo, selectedPrimary?.repoId, targets]);
  const showRepoGrouping = repositories.length > 1 || groupedTargets.length > 1;
  const highlightedFile = fileContextMenu ? { ...fileContextMenu.file, staged: false } : selectedFile;
  const workspaceView = variant === 'workspace';

  const flatItems = useMemo<FlatItem[]>(() => {
    if (fileMode !== 'tree') return [];
    const items: FlatItem[] = [];
    for (const [repoId, files] of groupedTargets) {
      const repoKey = `repo:${repoId}`;
      const repoOpen = isDirOpen(repoKey);
      const repoName = repoMap.get(repoId)?.meta.name ?? repoId;
      const repoColor = repoMap.get(repoId)?.meta.color;
      if (showRepoGrouping) items.push({ kind: 'repo', repoId, repoName, repoColor, fileCount: files.length, files, key: repoKey });
      if (!showRepoGrouping || repoOpen) {
        const tree = buildTree(files, `dir:${repoId}`).map(collapseTree);
        items.push(...flattenVisibleTreeNodes(tree, isDirOpen, showRepoGrouping ? 1 : 0));
      }
    }
    return items;
  }, [fileMode, groupedTargets, isDirOpen, repoMap, showRepoGrouping]);

  const itemCount = fileMode === 'tree' ? flatItems.length : targets.length;
  const shouldVirtualize = itemCount > 40;
  const fileListRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? itemCount : 0,
    getScrollElement: () => fileListRef.current,
    estimateSize: () => 22,
    overscan: 10,
    enabled: shouldVirtualize,
    initialRect: { width: 400, height: 800 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (!el) return;
      const update = () => {
        const width = el.offsetWidth || 400;
        const height = el.offsetHeight || 800;
        cb({ width, height });
      };
      update();
      if (!window.ResizeObserver) return;
      const observer = new ResizeObserver(update);
      observer.observe(el);
      return () => observer.disconnect();
    },
  });

  useEffect(() => {
    if (!activeMatch || !queryLower) return;

    if (shouldVirtualize && !activeMatch.isMergeParentDiff) {
      const targetIndex = fileMode === 'tree'
        ? flatItems.findIndex((item) => item.kind === 'file' && item.file.repoId === activeMatch.repoId && item.file.path === activeMatch.path)
        : targets.findIndex((file) => file.repoId === activeMatch.repoId && file.path === activeMatch.path);
      if (targetIndex >= 0) {
        virtualizer.scrollToIndex(targetIndex, { align: 'auto' });
      }
    }

    const revisionVal = activeMatch.fromRevision ?? '';
    const selector = `.commit-detail [data-detail-repo-id="${CSS.escape(activeMatch.repoId)}"][data-detail-path="${CSS.escape(activeMatch.path)}"][data-detail-from-revision="${CSS.escape(revisionVal)}"]`;
    const element = document.querySelector(selector);
    if (typeof element?.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [activeMatch, queryLower, shouldVirtualize, fileMode, flatItems, targets, virtualizer]);

  if (!selectedCommits.length) {
    return (
      <aside className="commit-detail empty-detail">
        <Codicon name="git-commit" />
        <span>{t('Select a commit')}</span>
      </aside>
    );
  }

  const hasAnyDetail = Boolean(detail) || selectedCommits.some((c) => Boolean(selectedDetails[commitKey(c.repoId, c.hash)]));

  if (!hasAnyDetail && !loading) {
    const errorMsg = (!isMultiSelection && singleKey ? selectedCommitError[singleKey] : '') || t('Failed to load commit details');
    return (
      <aside className="commit-detail empty-detail">
        <Codicon name="error" />
        <span>{errorMsg}</span>
        <button type="button" className="detail-retry-button" onClick={() => void reloadSelectedCommits()}>
          <Codicon name="refresh" />
          <span>{t('Retry')}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside ref={containerRef} className={`commit-detail ${workspaceView ? 'commit-detail-expanded' : ''}`}>
      <section className="detail-file-section">
        <div className="detail-files-title">
          <strong>{t(targets.length === 1 ? '{0} file' : '{0} files', targets.length)}</strong>
          <span className="detail-files-spacer" />
          {selectedCommits.length > 0 && selectedCommits.every((c) => c.repoId === selectedCommits[0].repoId && c.unpushed) && repoMap.get(selectedCommits[0].repoId)?.meta.kind === 'git' && <IconButton title={t('AI Reorganize Commits')} onClick={() => useAiStore.getState().openComposer({ repoId: selectedCommits[0].repoId, paths: [], stagedOnly: false, hashes: selectedCommits.map((c) => c.hash) })}><AiCommitComposerIcon /></IconButton>}
          {fileMode === 'tree' && (
            <>
              <IconButton type="button" title={t('Expand all')} onClick={() => { setAllTreeExpanded(true); setCollapsedDirs({}); }}><Codicon name="expand-all" /></IconButton>
              <IconButton type="button" title={t('Collapse all')} onClick={() => { setAllTreeExpanded(false); setCollapsedDirs({}); }}><Codicon name="collapse-all" /></IconButton>
              <i className="detail-view-divider" />
            </>
          )}
          <IconButton type="button" className={fileMode === 'tree' ? 'selected' : ''} title={t('Tree view')} onClick={() => { setFileMode('tree'); setAllTreeExpanded(null); setCollapsedDirs({}); }}><Codicon name="list-tree" /></IconButton>
          <IconButton type="button" className={fileMode === 'list' ? 'selected' : ''} title={t('Flat list')} onClick={() => { setFileMode('list'); setAllTreeExpanded(null); setCollapsedDirs({}); }}><Codicon name="list-flat" /></IconButton>
        </div>
        <FileSearchWidget query={speedSearch.query} isOpen={speedSearch.isOpen} inputRef={speedSearch.inputRef} onChange={speedSearch.setQuery} onClose={speedSearch.clear} count={{ current: matchedTargets.length > 0 ? activeMatchIndex + 1 : 0, total: matchedTargets.length }} onNavigate={handleNavigateMatch} />
        <div className="detail-files" ref={fileListRef}>
          {loading && !targets.length && <div className="detail-loading">{t('Loading files...')}</div>}
          {!loading && isMergeCommit && targets.length === 0 && (
            <div className="no-merge-conflicts">{t('No merge conflicts')}</div>
          )}
          {!loading && !isMergeCommit && targets.length === 0 && (
            <div className="detail-loading">{t('No changed files')}</div>
          )}
          {!loading && targets.length > 0 && (
            shouldVirtualize ? (
              <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const rowStyle: React.CSSProperties = {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  };
                  if (fileMode === 'tree') {
                    const item = flatItems[virtualRow.index];
                    if (!item) return null;
                    if (item.kind === 'repo') {
                      const repoOpen = isDirOpen(item.key);
                      return (
                        <div key={item.key} style={rowStyle} className="detail-repo-group">
                          <button
                            type="button"
                            className="detail-root-label"
                            title={item.repoName}
                            onClick={() => toggleDir(item.key)}
                            onContextMenu={(event) => handleDirectoryContextMenu(event, item.files)}
                          >
                            <Codicon name={repoOpen ? 'chevron-down' : 'chevron-right'} />
                            <i style={{ background: item.repoColor ?? 'var(--versiondock-accent)' }} />
                            <strong><HighlightText text={item.repoName} query={speedSearch.query} /></strong>
                            <b>{item.fileCount}</b>
                          </button>
                        </div>
                      );
                    }
                    if (item.kind === 'dir') {
                      return (
                        <div key={item.key} style={rowStyle} className="detail-tree-dir">
                          <button
                            type="button"
                            style={{ paddingLeft: item.depth * 14 }}
                            title={item.node.path}
                            onClick={() => toggleDir(item.node.key)}
                            onContextMenu={(event) => handleDirectoryContextMenu(event, descendantFiles(item.node))}
                          >
                            <Codicon name={item.open ? 'chevron-down' : 'chevron-right'} />
                            <FileIcon name={item.node.name.split('/').pop() ?? item.node.name} folder open={item.open} />
                            <span className="detail-node-label"><HighlightText text={item.node.name} query={speedSearch.query} /></span>
                            <b className="detail-directory-count">{item.node.fileCount}</b>
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div key={item.key} style={rowStyle}>
                        <DetailTreeNodeView
                          node={item.node}
                          depth={item.depth}
                          openDiff={openDiff}
                          selectedFile={highlightedFile}
                          isDirOpen={isDirOpen}
                          toggleDir={toggleDir}
                          openingDiffPath={openingDiffPath}
                          onOpeningDiff={handleOpeningDiff}
                          searchQuery={speedSearch.query}
                          activeMatchRepoId={activeMatch?.repoId}
                          activeMatchPath={activeMatch?.path}
                          activeMatchFromRevision={activeMatch?.fromRevision}
                          onFileContextMenu={handleFileContextMenu}
                          onDirectoryContextMenu={handleDirectoryContextMenu}
                        />
                      </div>
                    );
                  }
                  const file = targets[virtualRow.index];
                  if (!file) return null;
                  return (
                    <div key={`${file.repoId}:${file.fromRevision ?? ''}:${file.path}`} style={rowStyle}>
                      <DetailFlatFileRow
                        file={file}
                        repoName={repoMap.get(file.repoId)?.meta.name ?? file.repoId}
                        showRepo={showRepoGrouping}
                        selectedFile={highlightedFile}
                        openDiff={openDiff}
                        openingDiffPath={openingDiffPath}
                        onOpeningDiff={handleOpeningDiff}
                        searchQuery={speedSearch.query}
                        activeMatchRepoId={activeMatch?.repoId}
                        activeMatchPath={activeMatch?.path}
                        activeMatchFromRevision={activeMatch?.fromRevision}
                        onFileContextMenu={handleFileContextMenu}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              fileMode === 'tree' ? (
                groupedTargets.map(([repoId, files]) => (
                  <DetailRepoGroup
                    key={repoId}
                    files={files}
                    showRepo={showRepoGrouping}
                    repoName={repoMap.get(repoId)?.meta.name ?? repoId}
                    repoColor={repoMap.get(repoId)?.meta.color}
                    openDiff={openDiff}
                    selectedFile={highlightedFile}
                    isDirOpen={isDirOpen}
                    toggleDir={toggleDir}
                    openingDiffPath={openingDiffPath}
                    onOpeningDiff={handleOpeningDiff}
                    searchQuery={speedSearch.query}
                    activeMatchRepoId={activeMatch?.repoId}
                    activeMatchPath={activeMatch?.path}
                    activeMatchFromRevision={activeMatch?.fromRevision}
                    onFileContextMenu={handleFileContextMenu}
                    onDirectoryContextMenu={handleDirectoryContextMenu}
                  />
                ))
              ) : (
                targets.map((file) => (
                  <DetailFlatFileRow
                    key={`${file.repoId}:${file.fromRevision ?? ''}:${file.path}`}
                    file={file}
                    repoName={repoMap.get(file.repoId)?.meta.name ?? file.repoId}
                    showRepo={showRepoGrouping}
                    selectedFile={highlightedFile}
                    openDiff={openDiff}
                    openingDiffPath={openingDiffPath}
                    onOpeningDiff={handleOpeningDiff}
                    searchQuery={speedSearch.query}
                    activeMatchRepoId={activeMatch?.repoId}
                    activeMatchPath={activeMatch?.path}
                    activeMatchFromRevision={activeMatch?.fromRevision}
                    onFileContextMenu={handleFileContextMenu}
                  />
                ))
              )
            )
          )}
          {!loading && isMergeCommit && mergeParentChanges.map((parentChange) => {
            const isGroupExpanded = (Boolean(queryLower) && autoExpandedParentHashes.has(parentChange.hash)) || expandedParentHashes.has(parentChange.hash);
            return (
              <MergeParentChangeGroup
                key={`${detail!.commit.repoId}:${detail!.commit.hash}:${parentChange.hash}`}
                change={parentChange}
                commitHash={detail!.commit.hash}
                repoId={detail!.commit.repoId}
                viewMode={fileMode}
                selectedFile={highlightedFile}
                openDiff={openDiff}
                isDirOpen={isDirOpen}
                toggleDir={toggleDir}
                searchQuery={speedSearch.query}
                activeMatchRepoId={activeMatch?.repoId}
                activeMatchPath={activeMatch?.path}
                activeMatchFromRevision={activeMatch?.fromRevision}
                isExpanded={isGroupExpanded}
                onToggle={() => toggleParentGroup(parentChange.hash)}
                onFileContextMenu={handleFileContextMenu}
                onDirectoryContextMenu={handleDirectoryContextMenu}
              />
            );
          })}
        </div>
      </section>

      {!workspaceView && <div className="detail-info-resize" role="separator" tabIndex={0} aria-label={t('Resize commit detail')} aria-orientation="horizontal" aria-valuemin={minInfoHeight} aria-valuemax={maxInfoHeight} aria-valuenow={Math.round(infoHeight ?? 220)} onPointerDown={resizeInfo} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setInfoHeight((value) => clampInfoHeight((value ?? 220) + (event.key === 'ArrowUp' ? 10 : -10))); } }}><i /></div>}
      {workspaceView ? <ExtendedCommitSummary explanation={!loading && selectedCommits.length > 0 ? <AiExplanation commits={selectedCommits.map(c => ({ repoId: c.repoId, hash: c.hash }))} toolbar={aiToolbar} /> : undefined} detail={detail} selectedCommits={selectedCommits} selectedDetails={selectedDetails} loading={loading} repoMap={repoMap} /> : <section ref={summaryRef} className="detail-summary" style={infoHeight !== undefined ? { flex: `0 0 ${infoHeight}px`, minHeight: 0, maxHeight: 'none' } : undefined}>
        <header className="detail-toolbar">
          <span className="detail-toolbar-label" style={selectedCommits.length === 1 ? { color: repoMap.get(selectedPrimary?.repoId ?? '')?.meta.color } : undefined}>
            <Codicon name={selectedCommits.length > 1 ? 'git-commit' : 'repo'} />
            {selectedCommits.length > 1 ? t('Aggregated commit selection') : repoMap.get(selectedPrimary?.repoId ?? '')?.meta.name}
          </span>
          <div className="detail-actions">
            <IconButton type="button" title={t('Open Commit Detail')} onClick={openCommitDetail}><Codicon name="open-preview" /></IconButton>
            <IconButton type="button" title={t('Open Changes')} disabled={!canOpenChanges} onClick={openChanges}><Codicon name="diff-multiple" /></IconButton>
            <IconButton type="button" title={messagesExpandedByDefault ? t('Collapse commit messages by default') : t('Expand commit messages by default')} aria-pressed={messagesExpandedByDefault} onClick={toggleAllMessages}><Codicon name={messagesExpandedByDefault ? 'collapse-all' : 'expand-all'} /></IconButton>
            <IconButton type="button" title={t('Collapse commit detail')} onClick={onCollapse}><Codicon name="layout-sidebar-right" /></IconButton>
          </div>
        </header>
        {selectedCommits.length > 1 ? (
          <div className="detail-aggregate">
            <div className="detail-aggregate-meta">
              <div className="detail-aggregate-meta-row">
                <span>{t('{0} commits selected', selectedCommits.length)}</span>
                <span>{t('{0} repositories involved', new Set(selectedCommits.map((commit) => commit.repoId)).size)}</span>
              </div>
              <div className="detail-aggregate-meta-row">
                <span>{t('Selected time range')}</span>
                <span>{formatDate(selectedCommits[selectedCommits.length - 1]?.authorDate ?? '')} - {formatDate(selectedCommits[0]?.authorDate ?? '')}</span>
              </div>
            </div>
            {selectedCommits.map((commit) => {
              const value = selectedDetails[commitKey(commit.repoId, commit.hash)];
              const key = commitKey(commit.repoId, commit.hash);
              const repo = repoMap.get(commit.repoId);
              const isItemLoading = Boolean(selectedCommitLoading[key]);
              const itemError = selectedCommitError[key];
              return (
                <article className="aggregate-item" key={key}>
                  <div className="aggregate-repo"><Codicon name="repo" /><span style={{ color: repo?.meta.color }}>{repo?.meta.name ?? commit.repoId}</span></div>
                  {value ? (
                    <>
                      <CommitMessage
                        detail={value}
                        expanded={expandedMessages.has(key)}
                        toggle={() => setExpandedMessages((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                      />
                      <AuthorMeta commit={commit} />
                      <RefBadges detail={value} repoKind={repo?.meta.kind} />
                    </>
                  ) : isItemLoading ? (
                    <div className="detail-loading">{t('Loading...')}</div>
                  ) : (
                    <div className="detail-loading detail-error">
                      <span>{itemError || t('Failed to load commit details')}</span>
                      <button type="button" className="detail-retry-button" onClick={() => void reloadSelectedCommits()}>
                        {t('Retry')}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : detail && (
          <div className="detail-single">
            <CommitMessage
              detail={detail}
              expanded={expandedMessages.has(singleKey)}
              toggle={() => setExpandedMessages((current) => {
                const next = new Set(current);
                if (next.has(singleKey)) next.delete(singleKey);
                else next.add(singleKey);
                return next;
              })}
            />
            <AuthorMeta commit={detail.commit} />
            <RefBadges detail={detail} repoKind={repoMap.get(detail.commit.repoId)?.meta.kind} collapsible />
          </div>
        )}
      </section>}
      {fileContextMenu && (
        <DetailFileContextMenu
          position={fileContextMenu.position}
          file={fileContextMenu.file}
          openDiff={openDiff}
          workspaceView={workspaceView}
          close={() => setFileContextMenu(undefined)}
        />
      )}
      {dirContextMenu && !workspaceView && (
        <DetailDirectoryContextMenu
          position={dirContextMenu.position}
          files={dirContextMenu.files}
          close={() => setDirContextMenu(undefined)}
        />
      )}
    </aside>
  );
}
