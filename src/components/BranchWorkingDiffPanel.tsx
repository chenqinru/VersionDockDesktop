import { useMemo, useState } from 'react';
import type { CommitFile } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { ContextMenu } from './ContextMenu';
import { FileIcon } from './FileIcon';

type TreeDirectory = {
  kind: 'directory';
  name: string;
  path: string;
  fileCount: number;
  children: TreeNode[];
};

type TreeFile = {
  kind: 'file';
  name: string;
  file: CommitFile;
};

type TreeNode = TreeDirectory | TreeFile;

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return [...nodes]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => node.kind === 'directory' ? { ...node, children: sortTree(node.children) } : node);
}

function collapseSingleChildDirectories(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirectories(node.children);
    if (children.length === 1 && children[0].kind === 'directory') {
      const child = children[0];
      return {
        kind: 'directory' as const,
        name: `${node.name}/${child.name}`,
        path: child.path,
        fileCount: child.fileCount,
        children: child.children,
      };
    }
    return { ...node, children };
  });
}

function buildTree(files: CommitFile[]): TreeNode[] {
  const root: TreeDirectory = { kind: 'directory', name: '', path: '', fileCount: 0, children: [] };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let parent = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const path = parts.slice(0, index + 1).join('/');
      let directory = parent.children.find((node): node is TreeDirectory => node.kind === 'directory' && node.path === path);
      if (!directory) {
        directory = { kind: 'directory', name: parts[index], path, fileCount: 0, children: [] };
        parent.children.push(directory);
      }
      directory.fileCount += 1;
      parent = directory;
    }
    parent.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  return collapseSingleChildDirectories(sortTree(root.children));
}

function collectDirectories(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === 'directory' ? [node.path, ...collectDirectories(node.children)] : []);
}

function statusClass(status: string): string {
  const value = status.replace(/\d+$/, '').slice(0, 1).toUpperCase();
  if (value === 'A' || value === 'C') return 'added';
  if (value === 'D') return 'deleted';
  if (value === 'R') return 'renamed';
  return 'modified';
}

function statusLetter(status: string): string {
  return status.replace(/\d+$/, '').slice(0, 1).toUpperCase() || 'M';
}

function BranchWorkingFileRow({ file, depth, selected, select, openContext }: {
  file: CommitFile;
  depth: number;
  selected: boolean;
  select: (file: CommitFile) => void;
  openContext: (event: React.MouseEvent, file: CommitFile) => void;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  const directory = depth === 0 && file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  return <button
    type="button"
    className={`branch-working-file-row status-${statusClass(file.status)} ${selected ? 'selected' : ''}`}
    style={{ paddingLeft: 10 + depth * 18 }}
    title={file.path}
    onClick={() => select(file)}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openContext(event, file); }}
  >
    <span className="branch-working-file-spacer" />
    <FileIcon name={name} />
    <span className="branch-working-file-name">{name}</span>
    {directory && <small>{directory}</small>}
    <span className="branch-working-file-meta">
      {(file.added !== null || file.removed !== null) && <span className="branch-working-line-stats">
        {file.added !== null && <b className="added">+{file.added}</b>}
        {file.removed !== null && <b className="removed">-{file.removed}</b>}
      </span>}
      <em>{statusLetter(file.status)}</em>
    </span>
  </button>;
}

function BranchWorkingTreeNode({ node, depth, collapsed, selectedPath, toggle, select, openContext }: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  selectedPath?: string;
  toggle: (path: string) => void;
  select: (file: CommitFile) => void;
  openContext: (event: React.MouseEvent, file: CommitFile) => void;
}) {
  if (node.kind === 'file') return <BranchWorkingFileRow file={node.file} depth={depth} selected={selectedPath === node.file.path} select={select} openContext={openContext} />;
  const folded = collapsed.has(node.path);
  return <div className="branch-working-directory">
    <button type="button" className="branch-working-directory-row" style={{ paddingLeft: 10 + depth * 18 }} title={node.path} onClick={() => toggle(node.path)}>
      <Codicon name={folded ? 'chevron-right' : 'chevron-down'} />
      <FileIcon name={node.name.split('/').pop() ?? node.name} folder open={!folded} />
      <span>{node.name}</span>
      <b>{node.fileCount}</b>
    </button>
    {!folded && node.children.map((child) => <BranchWorkingTreeNode
      key={child.kind === 'directory' ? child.path : child.file.path}
      node={child}
      depth={depth + 1}
      collapsed={collapsed}
      selectedPath={selectedPath}
      toggle={toggle}
      select={select}
      openContext={openContext}
    />)}
  </div>;
}

export function BranchWorkingDiffPanel() {
  const value = useAppStore((state) => state.worktreeDiff?.source === 'repository' ? state.worktreeDiff : undefined);
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const closeWorktreeDiff = useAppStore((state) => state.closeWorktreeDiff);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const openDiff = useAppStore((state) => state.openBranchWorkingFileDiff);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selectedPath, setSelectedPath] = useState<string>();
  const [context, setContext] = useState<{ x: number; y: number; file: CommitFile }>();
  const files = useMemo(() => value?.files ?? [], [value?.files]);
  const tree = useMemo(() => buildTree(files), [files]);
  if (!value) return null;
  const repo = repositories.find((item) => item.meta.id === value.repoId);
  const repoName = repo?.meta.name ?? value.repoId;
  const repoColor = repo?.meta.color ?? 'var(--versiondock-accent)';
  const select = (file: CommitFile) => {
    setSelectedPath(file.path);
    void openDiff(value.repoId, value.baseRef, file.path);
  };
  const close = () => {
    closeWorktreeDiff();
    setActiveTab('changes');
  };

  return <aside className="branch-working-diff-panel">
    <header>
      <div className="branch-working-title">
        <div><i style={{ background: repoColor }} /><strong>{repoName}</strong><span>{t('{0} vs Working Tree', value.baseRef)}</span></div>
        <small>{t('{0} compared with {1}', value.baseRef, value.currentRef)}</small>
      </div>
      <button type="button" title={t('Back to Changes')} aria-label={t('Back to Changes')} onClick={close}><Codicon name="arrow-left" /></button>
    </header>
    <div className="branch-working-toolbar">
      <span>{files.length === 1 ? t('{0} file', files.length) : t('{0} files', files.length)}</span>
      <i />
      {viewMode === 'tree' && <>
        <button type="button" title={t('Expand all')} onClick={() => setCollapsed(new Set())}><Codicon name="expand-all" /></button>
        <button type="button" title={t('Collapse all')} onClick={() => setCollapsed(new Set(collectDirectories(tree)))}><Codicon name="collapse-all" /></button>
      </>}
      <button type="button" className={viewMode === 'tree' ? 'selected' : ''} title={t('Tree view')} onClick={() => setViewMode('tree')}><Codicon name="list-tree" /></button>
      <button type="button" className={viewMode === 'list' ? 'selected' : ''} title={t('List view')} onClick={() => setViewMode('list')}><Codicon name="list-flat" /></button>
    </div>
    <div className="branch-working-files">
      {files.length === 0 ? <div className="empty-state">{t('No file differences between {0} and the working tree', value.baseRef)}</div> : viewMode === 'tree'
        ? tree.map((node) => <BranchWorkingTreeNode key={node.kind === 'directory' ? node.path : node.file.path} node={node} depth={0} collapsed={collapsed} selectedPath={selectedPath} toggle={(path) => setCollapsed((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })} select={select} openContext={(event, file) => setContext({ x: event.clientX, y: event.clientY, file })} />)
        : files.map((file) => <BranchWorkingFileRow key={`${file.status}:${file.path}`} file={file} depth={0} selected={selectedPath === file.path} select={select} openContext={(event, target) => setContext({ x: event.clientX, y: event.clientY, file: target })} />)}
    </div>
    {context && <ContextMenu
      x={context.x}
      y={context.y}
      items={[{ id: 'diff', label: t('Show Diff'), icon: 'diff' }, { id: 'open', label: t('Open file'), icon: 'go-to-file' }]}
      onSelect={(id) => {
        if (id === 'diff') select(context.file);
        if (id === 'open') void systemOpen(value.repoId, context.file.path, false);
        setContext(undefined);
      }}
      onClose={() => setContext(undefined)}
    />}
  </aside>;
}
